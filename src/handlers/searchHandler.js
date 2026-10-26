const { Movie, User, PaginationSession } = require('../database');
const { cleanMovieName, encodeMovieLink, sendToLogChannel, escapeHtml, extractMovieDetails } = require('../utils/helpers');
const { InlineKeyboard } = require('grammy');

const safeAnswer = async (ctx, options = {}) => {
    try {
        await ctx.answerCallbackQuery(options);
    } catch (e) {
        if (!e.message.includes('query is too old') && !e.message.includes('response timeout')) {
            throw e;
        }
    }
};

const ITEMS_PER_PAGE = 10;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const deleteTriggerMessage = async (ctx, ms = 30 * 60 * 1000) => {
    await sleep(ms);
    try {
        if (ctx.message) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (_) { }
};

function getUserMention(ctx) {
    const user = ctx.from;
    if (user.username) {
        return `[@${user.username}](tg://user?id=${user.id})`;
    }
    return `[${user.first_name || 'User'}](tg://user?id=${user.id})`;
}

function getUserNameForLog(ctx) {
    const user = ctx.from;
    if (user.username) return `@${user.username}`;
    if (user.first_name) return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
    return `User ${user.id}`;
}

// Spaceless matching - ignores spaces in query vs title
function matchesSpaceless(query, title) {
    const q = query.toLowerCase().replace(/\s+/g, '');
    const t = title.toLowerCase().replace(/\s+/g, '');
    if (q.length < 3) return false;
    if (t.includes(q) || q.includes(t)) return true;
    return false;
}

// Token matching - all query words must exist in title
function matchesTokens(query, title) {
    const qTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const tLower = title.toLowerCase();
    return qTokens.length > 0 && qTokens.every(token => tLower.includes(token));
}

// Keyboard proximity - detects typos from nearby keys
function keyboardProximity(a, b) {
    const row1 = 'qwertyuiop';
    const row2 = 'asdfghjkl';
    const row3 = 'zxcvbnm';
    const getRow = (c) => {
        if (row1.includes(c)) return 1;
        if (row2.includes(c)) return 2;
        if (row3.includes(c)) return 3;
        return 0;
    };

    if (Math.abs(a.length - b.length) > 2) return 100;

    let score = 0;
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
        if (a[i] !== b[i]) {
            const rowA = getRow(a[i]);
            const rowB = getRow(b[i]);
            if (rowA === rowB) score += 0.5;
            else if (Math.abs(rowA - rowB) === 1) score += 1;
            else score += 2;
        }
    }
    score += Math.abs(a.length - b.length);
    return score;
}

// Soundex - phonetic matching
function soundex(s) {
    if (!s || s.length < 2) return '0000';
    const a = s.toLowerCase().split('');
    const firstLetter = a[0];
    const codes = {
        a: 0, e: 0, i: 0, o: 0, u: 0, h: 0, w: 0, y: 0,
        b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
        d: 3, t: 3, l: 4, m: 5, n: 5, r: 6
    };
    let result = firstLetter.toUpperCase();
    let prev = codes[a[0]] || 0;
    for (let i = 1; i < a.length && result.length < 4; i++) {
        const code = codes[a[i]];
        if (code !== undefined && code !== 0 && code !== prev) {
            result += code;
            prev = code;
        }
    }
    return (result + '000').slice(0, 4);
}

// Levenshtein distance for smart typo detection
function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

// Enhanced find similar movies with multiple matching strategies
async function findSimilarByTypo(query) {
    // Skip fuzzy for very short queries to avoid junk
    if (query.length < 3) return [];

    // Limit fields and count to avoid filling memory on large DBs
    const movies = await Movie.find({}, { title: 1, categories: 1, files: 1, thumbnail: 1, messageIds: 1 }).limit(500).lean();
    const results = [];
    const q = query.toLowerCase();
    const qSoundex = soundex(q);

    // Dynamic threshold: stricter for shorter queries
    const threshold = q.length < 5 ? 1 : 2;

    for (const movie of movies) {
        const title = movie.title.toLowerCase();

        // 1. Exact title match (skip as handled before)
        if (title.includes(q)) continue;

        // 2. Spaceless match
        if (matchesSpaceless(query, movie.title)) {
            results.push({ movie, score: -2, reason: 'spaceless' });
            continue;
        }

        // 3. Token match
        if (matchesTokens(query, movie.title)) {
            results.push({ movie, score: -1, reason: 'tokens' });
            continue;
        }

        // 4. Category match (STRICTER: word match only)
        const qRegex = new RegExp(`\\b${q}\\b`, 'i');
        const exactCategoryMatch = movie.categories?.some(c => qRegex.test(c));
        if (exactCategoryMatch) {
            results.push({ movie, score: -0.5, reason: 'category_exact' });
            continue;
        }

        // 4b. Category Fuzzy match (Little strict: 1 char mistake, min length 4)
        if (q.length >= 4) {
            const hasFuzzyCategory = movie.categories?.some(cat => {
                const words = cat.toLowerCase().split(/\s+/);
                return words.some(word => word.length >= 4 && levenshteinDistance(q, word) <= 1);
            });
            if (hasFuzzyCategory) {
                results.push({ movie, score: 0.5, reason: 'category_fuzzy' });
                continue;
            }
        }

        // 5. Soundex match (phonetic)
        const titleSoundex = soundex(title);
        if (qSoundex === titleSoundex) {
            results.push({ movie, score: 1, reason: 'soundex' });
            continue;
        }

        // 6. Levenshtein distance
        const levDistance = levenshteinDistance(q, title);
        if (levDistance <= threshold) {
            results.push({ movie, score: levDistance + 2, reason: 'levenshtein' });
            continue;
        }

        // 7. Keyboard proximity (only for longer queries)
        if (q.length >= 5) {
            const kbScore = keyboardProximity(q, title);
            if (kbScore <= 2) { // Tightened from 3
                results.push({ movie, score: kbScore + 4, reason: 'keyboard' });
            }
        }
    }

    // Sort by score (lower is better)
    results.sort((a, b) => a.score - b.score);
    return results.slice(0, 5);
}

// Get user badge based on activity (Moxi community themed)
function getUserBadge(user) {
    if (user.downloadCount >= 50) return '🔥 MOXI LEGEND';
    if (user.downloadCount >= 30) return '⚡ MOXI STAR';
    if (user.downloadCount >= 15) return '💫 MOXI PRO';
    if (user.downloadCount >= 5) return '✨ MOXI MEMBER';
    if (user.searchCount >= 1) return '🌟 MOXI NEWBIE';
    return null;
}

// Get badge icon for display
function getBadgeIcon(downloadCount, searchCount) {
    if (downloadCount >= 50) return '🔥';
    if (downloadCount >= 30) return '⚡';
    if (downloadCount >= 15) return '💫';
    if (downloadCount >= 5) return '✨';
    if (searchCount >= 1) return '🌟';
    return '';
}

// Update user stats
async function updateUserStats(userId, type) {
    try {
        const user = await User.findOneAndUpdate(
            { userId },
            {
                $inc: type === 'search' ? { searchCount: 1 } : { downloadCount: 1 },
                $set: { lastActive: new Date() },
                $setOnInsert: { badges: ['🌟 MOXI NEWBIE'] } // Welcome badge for new users
            },
            { upsert: true, returnDocument: 'after' }
        );

        // Check for badge upgrade (only if not a new user)
        const isNewUser = user.searchCount === 1 && user.downloadCount === 0;
        if (!isNewUser) {
            const newBadge = getUserBadge(user);
            if (newBadge && !user.badges.includes(newBadge)) {
                user.badges.push(newBadge);
                await user.save();
                return newBadge;
            }
        }
        return null;
    } catch (e) {
        console.error('User stats error:', e);
    }
}

// Find similar movies based on categories
async function findSimilarMovies(movie, limit = 3) {
    if (!movie.categories || movie.categories.length === 0) return [];

    return await Movie.find({
        _id: { $ne: movie._id },
        categories: { $in: movie.categories }
    }).limit(limit);
}

function buildFilterKeyboard(movies, page, total) {
    const keyboard = new InlineKeyboard();

    movies.forEach((m) => {
        if (!m) return;
        const count = m.files?.length || m.messageIds.length;
        keyboard.text(`▫️ ${m.title.toUpperCase()} (${count})`, `f_${m._id}`).row();
    });

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    if (page > 0) {
        keyboard.text('◀ Prev', `fp_${page - 1}`);
    }
    if (page < totalPages - 1) {
        keyboard.text('🔵 Next ▶', `fp_${page + 1}`);
    }
    if (page > 0 || page < totalPages - 1) {
        keyboard.row();
    }
    keyboard.text('❌ Close', 'close_msg');

    return keyboard;
}

// Helper to send a consistent movie result
async function sendMovieResult(ctx, movie, bot, isAutoMatched = false, reqUser = null) {
    await Movie.updateOne({ _id: movie._id }, { $inc: { requests: 1 } });
    await updateUserStats(ctx.from.id, 'search');

    const reqSource = reqUser || ctx.from;
    const reqName = reqSource.first_name || reqSource.username || 'User';

    const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
    const encodedTitle = encodeMovieLink(movie);
    const privateStart = `https://t.me/${botUsername}?start=${encodedTitle}`;
    const clipCount = movie.files?.length || movie.messageIds?.length || 0;
    const photoFileId = movie.thumbnail || null;
    const keyboard = new InlineKeyboard()
        .url(`⚡ Get Clips (${clipCount}) »`, privateStart).row()
        .text('❌ Close', 'close_msg');

    const resultText = `🎬 <b>${movie.title}</b> • <code>${clipCount} clips</code>\n` +
        `👤 <i>For <a href="tg://user?id=${reqSource.id}">${reqName}</a></i>`;

    let sentMsg;
    if (photoFileId) {
        sentMsg = await ctx.replyWithPhoto(photoFileId, {
            caption: resultText,
            reply_parameters: { message_id: ctx.message?.message_id },
            reply_markup: keyboard,
            parse_mode: 'HTML'
        });
    } else {
        sentMsg = await ctx.reply(resultText, {
            reply_parameters: { message_id: ctx.message?.message_id },
            reply_markup: keyboard,
            parse_mode: 'HTML'
        });
    }

    // Auto-edit after 5 minutes to keep group chat clean
    setTimeout(async () => {
        try {
            const expireText = `⚠️ <b>Link Expired:</b> 🎬 <b>${movie.title}</b>\n<i>Please search again in group!</i>`;
            if (photoFileId) {
                await ctx.api.editMessageCaption(ctx.chat.id, sentMsg.message_id, {
                    caption: expireText,
                    parse_mode: 'HTML'
                });
            } else {
                await ctx.api.editMessageText(ctx.chat.id, sentMsg.message_id, expireText, {
                    parse_mode: 'HTML'
                });
            }
        } catch (_) { }
    }, 5 * 60 * 1000);

    await sendToLogChannel(bot, `🔍 ${getUserNameForLog(ctx)} | ${movie.title} (${clipCount} clips)`);
    return sentMsg;
}

module.exports = (bot) => {
    // Random movie command
    bot.command('random', async (ctx) => {
        const groupId = process.env.GROUP_ID;
        const isGroup = groupId && ctx.chat.id.toString() === groupId;

        if (!isGroup) {
            const reply = await ctx.reply(
                `🎲 <b>Group Command:</b> Send <code>/random</code> in our group to get a surprise movie!`,
                { parse_mode: 'HTML' }
            );
            deleteTriggerMessage(ctx);
            return;
        }

        const movies = await Movie.find().lean();
        if (movies.length === 0) {
            const reply = await ctx.reply('📭 No movies available yet!');
            deleteTriggerMessage(ctx);
            return;
        }

        const randomMovie = movies[Math.floor(Math.random() * movies.length)];

        await updateUserStats(ctx.from.id, 'search');
        await Movie.updateOne({ _id: randomMovie._id }, { $inc: { requests: 1 } });

        const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
        const privateStart = `https://t.me/${botUsername}?start=${encodeMovieLink(randomMovie)}`;
        const clipCount = randomMovie.files?.length || randomMovie.messageIds?.length || 0;
        const photoFileId = randomMovie.thumbnail || null;
        const keyboard = new InlineKeyboard()
            .url(`⚡ Get Clips (${clipCount}) »`, privateStart).row()
            .text('❌ Close', 'close_msg');

        const resultText = `🎲 <b>Random Pick:</b>\n🎬 <b>${randomMovie.title}</b> • <code>${clipCount} clips</code>`;

        if (photoFileId) {
            await ctx.replyWithPhoto(photoFileId, {
                caption: resultText,
                reply_markup: keyboard,
                parse_mode: 'HTML',
                reply_parameters: { message_id: ctx.message.message_id }
            });
        } else {
            await ctx.reply(resultText, {
                reply_markup: keyboard,
                parse_mode: 'HTML',
                reply_parameters: { message_id: ctx.message.message_id }
            });
        }
    });

    // Trending movies command
    bot.command('trending', async (ctx) => {
        const groupId = process.env.GROUP_ID;
        const isGroup = groupId && ctx.chat.id.toString() === groupId;

        if (!isGroup) {
            const reply = await ctx.reply(
                `🔥 <b>Group Command:</b> Send <code>/trending</code> in our group to see popular titles!`,
                { parse_mode: 'HTML' }
            );
            deleteTriggerMessage(ctx);
            return;
        }

        const topMovies = await Movie.find().sort({ requests: -1 }).limit(5).lean();

        if (topMovies.length === 0) {
            const reply = await ctx.reply('📭 No movies available yet!', { reply_parameters: { message_id: ctx.message.message_id } });
            deleteTriggerMessage(ctx);
            return;
        }

        const keyboard = new InlineKeyboard();
        const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
        topMovies.forEach((m, idx) => {
            const clipCount = m.files?.length || m.messageIds?.length || 0;
            const startUrl = `https://t.me/${botUsername}?start=${encodeMovieLink(m)}`;
            keyboard.url(`🔥 #${idx + 1} ${m.title.toUpperCase()} (${clipCount})`, startUrl).row();
        });
        keyboard.text('❌ Close', 'close_msg');

        const trendingText = `🔥 <b>Trending Movies:</b>\n<i>Tap below to get clips in your PM:</i>`;

        await ctx.reply(trendingText, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            reply_parameters: { message_id: ctx.message.message_id }
        });
    });

    bot.on('message:text', async (ctx, next) => {
        let incomingText = (ctx.message.text || '').toLowerCase().trim();

        // Strip @bot_username from the end of the command if it exists
        if (ctx.me && ctx.me.username) {
            const botTag = `@${ctx.me.username.toLowerCase()}`;
            if (incomingText.endsWith(botTag)) {
                incomingText = incomingText.replace(botTag, '');
            }
        }

        if (!incomingText || incomingText.length < 2) return next();

        const keywords = ['/filters', '/filter', 'filters', 'filter', 'clips', 'tamil', 'movie', 'movies', 'list'];
        const isFiltersCommand = keywords.includes(incomingText) || incomingText === 'list filters';

        // If it's still a command (starts with /), let other command handlers process it
        if (incomingText.startsWith('/')) {
            // But we intercept /filter and /filters manually here to show the list
            if (!isFiltersCommand) {
                return next(); // Ignore all other commands (like /start, /random, etc.)
            }
        }

        const groupId = process.env.GROUP_ID;
        const isGroup = groupId && ctx.chat.id.toString() === groupId;

        // 1. Handle Filter List Command (Group Only)
        if (isFiltersCommand) {
            // If not in group, guide user to group
            if (!isGroup) {
                const groupLink = process.env.GROUP_LINK || '';
                const kb = new InlineKeyboard();
                if (groupLink) kb.url('👥 Open Group Chat »', groupLink).row();
                kb.text('❌ Close', 'close_msg');
                return ctx.reply(
                    `💬 <b>Search in Our Group!</b>\nSend any movie title in our group chat to get clips in PM.`,
                    { parse_mode: 'HTML', reply_markup: kb }
                );
            }

            const allMovies = await Movie.find().select('_id').lean();
            if (allMovies.length === 0) {
                const reply = await ctx.reply('📭 No movies in database yet!', { reply_parameters: { message_id: ctx.message.message_id } });
                deleteTriggerMessage(ctx);
                return;
            }

            // Singleton Clean-Up (Delete old list in same chat)
            const existingSession = await PaginationSession.findOne({ chatId: String(ctx.chat.id) });
            if (existingSession && existingSession.lastMessageId) {
                try {
                    await ctx.api.deleteMessage(ctx.chat.id, existingSession.lastMessageId);
                } catch (_) { }
            }

            const shuffledIds = allMovies.map(m => m._id).sort(() => Math.random() - 0.5);
            const pageMovies = await Movie.find({ _id: { $in: shuffledIds.slice(0, ITEMS_PER_PAGE) } }).lean();
            const orderedMovies = shuffledIds.slice(0, ITEMS_PER_PAGE).map(id => pageMovies.find(m => m._id.toString() === id.toString()));

            const keyboard = buildFilterKeyboard(orderedMovies, 0, shuffledIds.length);
            const helpText = `🎬 <b>Available Movies</b> (Page 1/${Math.ceil(shuffledIds.length / ITEMS_PER_PAGE)})\n` +
                `<i>Total: ${shuffledIds.length} titles • Tap below to get clips in PM:</i>`;

            const sent = await ctx.reply(helpText, {
                parse_mode: 'HTML',
                reply_markup: keyboard,
                reply_parameters: { message_id: ctx.message.message_id }
            });

            await PaginationSession.findOneAndUpdate(
                { chatId: String(ctx.chat.id) },
                {
                    movieIds: shuffledIds,
                    page: 0,
                    lastMessageId: sent.message_id
                },
                { upsert: true, setDefaultsOnInsert: true }
            );
            return;
        }

        // 2. Handle Movie Title Search (ONLY in Group)
        if (!isGroup) {
            const groupLink = process.env.GROUP_LINK || '';
            const kb = new InlineKeyboard();
            if (groupLink) kb.url('👥 Open Search Group »', groupLink).row();
            kb.text('❌ Close', 'close_msg');
            const reply = await ctx.reply(
                `💬 <b>Search in Our Group!</b>\nType any movie title in our group chat to get clips sent to PM!`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
            deleteTriggerMessage(ctx);
            return;
        }

        // Skip old messages in group to prevent flood on restart
        if (ctx.message.date * 1000 < global.botStartedAt) return;

        const query = cleanMovieName(ctx.message.text);
        if (query.length < 2) return;

        global.todayStats.searches++;

        try {
            // 1. Exact Match
            let movie = await Movie.findOne({ title: query });

            let allMoviesLean = null;

            // 2. Spaceless Match
            if (!movie) {
                allMoviesLean = await Movie.find({}, { title: 1, categories: 1, files: 1, thumbnail: 1, messageIds: 1 }).limit(500).lean();
                movie = allMoviesLean.find(m => matchesSpaceless(query, m.title));
            }

            // 3. Token Match
            if (!movie) {
                if (!allMoviesLean) allMoviesLean = await Movie.find({}, { title: 1, categories: 1, files: 1, thumbnail: 1, messageIds: 1 }).limit(500).lean();
                movie = allMoviesLean.find(m => matchesTokens(query, m.title));
            }

            // 4. Smart Matching (Typo/Category)
            if (!movie) {
                const similarResults = await findSimilarByTypo(query);
                if (similarResults.length === 1) {
                    // Auto-select if only one suggestion
                    movie = similarResults[0].movie;
                    return await sendMovieResult(ctx, movie, bot, true);
                } else if (similarResults.length > 1) {
                    // Redesigned "Did you mean" UI
                    const suggested = similarResults.slice(0, 3);
                    const keyboard = new InlineKeyboard();

                    suggested.forEach((item) => {
                        const count = item.movie.files?.length || item.movie.messageIds.length;
                        keyboard.text(`▫️ ${item.movie.title.toUpperCase()} (${count})`, `typo_${item.movie._id}`).row();
                    });
                    keyboard.text('❌ Close', 'close_msg');

                    await ctx.reply(
                        `🔍 <b>Did you mean:</b>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard,
                            reply_parameters: { message_id: ctx.message.message_id }
                        }
                    );
                    return;
                }
            }

            // 5. Final Regex Search (if still nothing)
            if (!movie) {
                const fuzzyMovies = await Movie.find({
                    $or: [
                        { title: { $regex: query, $options: 'i' } },
                        { categories: { $regex: `\\b${query}\\b`, $options: 'i' } } // Word boundary for categories
                    ]
                }).limit(10).lean();

                if (fuzzyMovies.length === 1) {
                    movie = fuzzyMovies[0];
                } else if (fuzzyMovies.length > 1) {
                    const keyboard = new InlineKeyboard();
                    // Strictly vertical buttons
                    fuzzyMovies.forEach(m => {
                        const count = m.files?.length || m.messageIds.length;
                        keyboard.text(`▸ ${m.title.toUpperCase()} (${count})⠀`, `search_${m._id}`).row();
                    });
                    keyboard.text('❌ Close', 'close_msg');

                    return await ctx.reply(
                        `🔍 <b>Matches for:</b> "<code>${query}</code>"\n<i>Tap below to get clips in PM:</i>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard,
                            reply_parameters: { message_id: ctx.message?.message_id }
                        }
                    );
                }
            }

            // Final delivery if movie was found
            if (movie) {
                const sentMsg = await sendMovieResult(ctx, movie, bot);

                // Also suggest related movies
                const similar = await findSimilarMovies(movie, 3);
                if (similar.length > 0) {
                    const suggestKeyboard = new InlineKeyboard();
                    similar.forEach(m => suggestKeyboard.text(`▸ ${m.title.toUpperCase()}⠀`, `search_${m._id}`).row());
                    suggestKeyboard.text('❌ Close', 'close_msg');

                    await ctx.reply(`💡 <b>You might also like:</b>`, {
                        reply_parameters: { message_id: sentMsg.message_id },
                        reply_markup: suggestKeyboard,
                        parse_mode: 'HTML'
                    });
                }
            } else {
                // Not found
                await ctx.reply(
                    `❌ <b>Not found:</b> "<code>${query}</code>"\n` +
                    `<i>Check spelling or ask admin to add it!</i>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: new InlineKeyboard().text('❌ Close', 'close_msg'),
                        reply_parameters: { message_id: ctx.message.message_id }
                    }
                );
                await sendToLogChannel(bot, `❌ Miss: ${getUserNameForLog(ctx)} | ${query}`);
            }
        } catch (error) {
            console.error('Search error:', error);
        }
    });

    // Helper for safe message editing across text vs photo
    const safeUpdateResult = async (ctx, resultText, keyboard, photoFileId) => {
        if (photoFileId) {
            if (ctx.callbackQuery?.message?.photo) {
                try {
                    return await ctx.editMessageCaption({ caption: resultText, reply_markup: keyboard, parse_mode: 'HTML' });
                } catch (_) { }
            }
            return await ctx.replyWithPhoto(photoFileId, { caption: resultText, reply_markup: keyboard, parse_mode: 'HTML' });
        } else {
            if (ctx.callbackQuery?.message?.photo) {
                try {
                    return await ctx.editMessageCaption({ caption: resultText, reply_markup: keyboard, parse_mode: 'HTML' });
                } catch (_) { }
                return await ctx.reply(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
            } else {
                try {
                    return await ctx.editMessageText(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
                } catch (e) {
                    if (!e.message?.includes('message is not modified')) {
                        return await ctx.reply(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
                    }
                }
            }
        }
    };

    // Helper to find movie by ObjectId or title
    const findMovieByIdOrTitle = async (param) => {
        if (!param) return null;
        if (/^[0-9a-fA-F]{24}$/.test(param)) {
            const byId = await Movie.findById(param);
            if (byId) return byId;
        }
        return await Movie.findOne({ title: param });
    };

    // Helper to send or update a movie result card for callbacks
    const respondWithMovieCard = async (ctx, movie) => {
        const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
        const clipCount = movie.files?.length || movie.messageIds?.length || 0;
        const privateStart = `https://t.me/${botUsername}?start=${encodeMovieLink(movie)}`;
        const keyboard = new InlineKeyboard()
            .url(`⚡ Get Clips (${clipCount}) »`, privateStart).row()
            .text('❌ Close', 'close_msg');

        const reqSource = ctx.from;
        const reqName = reqSource.first_name || reqSource.username || 'User';
        const resultText = `🎬 <b>${movie.title}</b> • <code>${clipCount} clips</code>\n` +
            `👤 <i>For <a href="tg://user?id=${reqSource.id}">${reqName}</a></i>`;

        if (movie.thumbnail) {
            await ctx.replyWithPhoto(movie.thumbnail, {
                caption: resultText,
                reply_markup: keyboard,
                parse_mode: 'HTML'
            });
        } else {
            try {
                await ctx.editMessageText(resultText, {
                    reply_markup: keyboard,
                    parse_mode: 'HTML'
                });
            } catch (_) {
                await ctx.reply(resultText, {
                    reply_markup: keyboard,
                    parse_mode: 'HTML'
                });
            }
        }
    };

    // Handle typo suggestion - Yes
    bot.callbackQuery(/^typo_(.+)$/, async (ctx) => {
        const movieParam = ctx.match[1];
        try {
            const movie = await findMovieByIdOrTitle(movieParam);
            if (!movie) return await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });
            movie.requests += 1;
            await movie.save();
            await updateUserStats(ctx.from.id, 'search');
            await ctx.answerCallbackQuery({ text: '⚡ Clips ready!' });
            await respondWithMovieCard(ctx, movie);
        } catch (error) {
            console.error('Typo callback error:', error.message);
        }
    });

    // Handle filter list movie selection
    bot.callbackQuery(/^f_(.+)$/, async (ctx) => {
        const movieParam = ctx.match[1];
        try {
            const movie = await findMovieByIdOrTitle(movieParam);
            if (!movie) return await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });
            movie.requests += 1;
            await movie.save();
            await updateUserStats(ctx.from.id, 'search');
            await ctx.answerCallbackQuery({ text: '⚡ Clips ready!' });
            await respondWithMovieCard(ctx, movie);
        } catch (error) {
            console.error('Filter callback error:', error);
        }
    });

    // Handle search results (search_)
    bot.callbackQuery(/^search_(.+)$/, async (ctx) => {
        const movieParam = ctx.match[1];
        try {
            const movie = await findMovieByIdOrTitle(movieParam);
            if (!movie) return await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });
            movie.requests += 1;
            await movie.save();
            await updateUserStats(ctx.from.id, 'search');
            await ctx.answerCallbackQuery({ text: '⚡ Clips ready!' });
            await respondWithMovieCard(ctx, movie);
        } catch (error) {
            console.error('Search callback error:', error);
        }
    });

    // Handle filter list pagination (with DB persistence)
    bot.callbackQuery(/^fp_(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1]);
        try {
            const chatIdStr = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);
            const session = await PaginationSession.findOne({ chatId: chatIdStr });
            if (!session) {
                return await ctx.answerCallbackQuery({
                    text: '📑 Filter list expired. Type /filters to start again!',
                    show_alert: true
                });
            }

            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const pageIds = session.movieIds.slice(start, end);

            const pageMovies = await Movie.find({ _id: { $in: pageIds } });
            const orderedMovies = pageIds.map(id => pageMovies.find(m => m._id.equals(id)));

            const keyboard = buildFilterKeyboard(orderedMovies, page, session.movieIds.length);

            const helpText = `🎬 <b>Available Movies</b> (Page ${page + 1}/${Math.ceil(session.movieIds.length / ITEMS_PER_PAGE)})\n` +
                `<i>Total: ${session.movieIds.length} titles • Tap below to get clips in PM:</i>`;

            await safeAnswer(ctx);
            try {
                await ctx.editMessageText(helpText, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            } catch (e) {
                if (!e.message.includes('message is not modified')) throw e;
            }

            session.page = page;
            await session.save();
        } catch (error) {
            console.error('Pagination error:', error);
            await ctx.answerCallbackQuery({ text: '❌ Navigation error', show_alert: true });
        }
    });
};
