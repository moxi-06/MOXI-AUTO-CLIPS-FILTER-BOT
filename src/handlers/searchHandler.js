const { Movie, User, PaginationSession } = require('../database');
const { cleanMovieName, encodeMovieLink, sendToLogChannel } = require('../utils/helpers');
const { InlineKeyboard } = require('grammy');

const ITEMS_PER_PAGE = 10;

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

    const movies = await Movie.find();
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

// Get user badge based on activity (video editing themed)
function getUserBadge(user) {
    if (user.downloadCount >= 20) return '👑 Editor King 👑';
    if (user.downloadCount >= 10) return '💎 Diamond Editor';
    if (user.downloadCount >= 3) return '✂️ Pro Cutter';
    if (user.searchCount >= 5) return '🎬 Clip Hunter';
    if (user.searchCount >= 1) return '🎞️ New Editor';
    return null;
}

// Get badge icon for display
function getBadgeIcon(downloadCount, searchCount) {
    if (downloadCount >= 20) return '👑';
    if (downloadCount >= 10) return '💎';
    if (downloadCount >= 3) return '✂️';
    if (searchCount >= 5) return '🎬';
    if (searchCount >= 1) return '🎞️';
    return '';
}

// Update user stats
async function updateUserStats(userId, type) {
    try {
        const user = await User.findOneAndUpdate(
            { userId },
            {
                $inc: type === 'search' ? { searchCount: 1 } : { downloadCount: 1 },
                $set: { lastActive: new Date() }
            },
            { upsert: true, returnDocument: 'after' }
        );

        // Check for badge upgrade
        const newBadge = getUserBadge(user);
        if (newBadge && !user.badges.includes(newBadge)) {
            user.badges.push(newBadge);
            await user.save();
            return newBadge;
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
        const count = m.files?.length || m.messageIds.length;
        // Premium Minimalist Style: ▸ TITLE (COUNT)
        // Braille space (U+2800) used for left-alignment feeling
        keyboard.text(`▸ ${m.title.toUpperCase()} (${count})⠀`, `f_${m.title}`).row();
    });

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    // Strictly vertical pagination
    if (page < totalPages - 1) {
        keyboard.text('NEXT PAGE ›', `fp_${page + 1}`).row();
    }
    if (page > 0) {
        keyboard.text('‹ PREVIOUS PAGE', `fp_${page - 1}`).row();
    }

    return keyboard;
}

// Helper to send a consistent movie result
async function sendMovieResult(ctx, movie, bot, isAutoMatched = false) {
    movie.requests += 1;
    await movie.save();
    await updateUserStats(ctx.from.id, 'search');

    const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
    const encodedTitle = encodeMovieLink(movie.title);
    const privateStart = `https://t.me/${botUsername}?start=${encodedTitle}`;
    const keyboard = new InlineKeyboard().url('📥 Get Clips in PM', privateStart);

    const clipCount = movie.files?.length || movie.messageIds.length;
    const photoFileId = movie.thumbnail || null;

    const resultText = (isAutoMatched ? `✨ SMART MATCH FOUND\n` : `✨ ${movie.title.toUpperCase()}\n`) +
        `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
        `${isAutoMatched ? `🎬 <b>Movie:</b> ${movie.title}\n` : ''}` +
        `📂 <b>Clips:</b> ${clipCount} Available\n` +
        `📥 <b>Delivery:</b> Direct PM\n` +
        `━━━━━━━━━ ✦ ━━━━━━━━━`;

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

    // Auto-edit after 5 minutes
    setTimeout(async () => {
        try {
            await ctx.api.editMessageText(
                ctx.chat.id, sentMsg.message_id,
                `⏰ <b>LINK EXPIRED</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `🎬 <b>Movie:</b> ${movie.title}\n\n` +
                `🔍 <i>Search again to get a fresh link!</i>`,
                { parse_mode: 'HTML' }
            );
        } catch (_) { }
    }, 5 * 60 * 1000);

    await sendToLogChannel(bot, `🔍 ${getUserNameForLog(ctx)} | ${movie.title} (${clipCount} clips)`);
    return sentMsg;
}

module.exports = (bot) => {
    bot.on('message:text', async (ctx, next) => {
        const incomingText = (ctx.message.text || '').toLowerCase();
        if (!incomingText || incomingText.length < 2) return next();

        const keywords = ['/filters', '/filter', 'filters', 'filter', 'clips', 'tamil', 'movie', 'movies', 'list'];
        const isFiltersCommand = keywords.includes(incomingText) || incomingText === 'list filters';

        const groupId = process.env.GROUP_ID;
        const isGroup = groupId && ctx.chat.id.toString() === groupId;

        // 1. Handle Filter List Command (Works in Group + PM)
        if (isFiltersCommand) {
            const allMovies = await Movie.find().select('_id');
            if (allMovies.length === 0) return ctx.reply('📭 No movies in database yet!', { reply_parameters: { message_id: ctx.message.message_id } });

            // Singleton Clean-up (Delete old list in same chat)
            const existingSession = await PaginationSession.findOne({ chatId: String(ctx.chat.id) });
            if (existingSession && existingSession.lastMessageId) {
                try {
                    await ctx.api.deleteMessage(ctx.chat.id, existingSession.lastMessageId);
                } catch (_) { }
            }

            const shuffledIds = allMovies.map(m => m._id).sort(() => Math.random() - 0.5);
            const pageMovies = await Movie.find({ _id: { $in: shuffledIds.slice(0, ITEMS_PER_PAGE) } });
            const orderedMovies = shuffledIds.slice(0, ITEMS_PER_PAGE).map(id => pageMovies.find(m => m._id.equals(id)));

            const keyboard = buildFilterKeyboard(orderedMovies, 0, shuffledIds.length);
            const helpText = `💎 MOVIE FILTER LIST\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🚀 Select a movie to get clips:\n\n` +
                `📊 <b>Page:</b> 1 / ${Math.ceil(shuffledIds.length / ITEMS_PER_PAGE)}\n` +
                `🎬 <b>Catalog:</b> ${shuffledIds.length} Movies Available\n\n` +
                `💡 <i>Clips are delivered directly to your PM for quality!</i>`;

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
        if (!isGroup) return next();

        // Skip old messages in group to prevent flood on restart
        if (ctx.message.date * 1000 < global.botStartedAt) return;

        const query = cleanMovieName(ctx.message.text);
        if (query.length < 2) return;

        global.todayStats.searches++;

        try {
            // 1. Exact Match
            let movie = await Movie.findOne({ title: query });

            // 2. Spaceless Match
            if (!movie) {
                const allMovies = await Movie.find();
                movie = allMovies.find(m => matchesSpaceless(query, m.title));
            }

            // 3. Token Match
            if (!movie) {
                const allMovies = await Movie.find();
                movie = allMovies.find(m => matchesTokens(query, m.title));
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
                        keyboard.text(`▸ ${item.movie.title.toUpperCase()} (${count})⠀`, `typo_${item.movie.title}`).row();
                    });
                    keyboard.text('✕ NONE OF THESE', 'typo_no');

                    await ctx.reply(
                        `🔍 <b>DID YOU MEAN?</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `I couldn't find an exact match for "<code>${query}</code>", but I found these:\n\n` +
                        `${suggested.map((s, i) => `${i + 1}️⃣ <b>${s.movie.title}</b>`).join('\n')}\n\n` +
                        `<b>Quick Guide:</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `✨ <b>Tap a movie name</b> above if it's what you were looking for!\n` +
                        `🎥 I'll send the clips straight to your PM.`,
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
                }).limit(5);

                if (fuzzyMovies.length === 1) {
                    movie = fuzzyMovies[0];
                } else if (fuzzyMovies.length > 1) {
                    // Strictly vertical buttons
                    fuzzyMovies.forEach(m => {
                        const count = m.files?.length || m.messageIds.length;
                        keyboard.text(`▸ ${m.title.toUpperCase()} (${count})⠀`, `search_${m.title}`).row();
                    });

                    return await ctx.reply(
                        `🔍 <b>SEARCH RESULTS</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `Multiple matches found for "<code>${query}</code>":\n\n` +
                        `👇 <b>Tap a movie to get clips:</b>`,
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
                    similar.forEach(m => suggestKeyboard.text(`▸ ${m.title.toUpperCase()}⠀`, `search_${m.title}`).row());

                    await ctx.reply(`💡 <b>You might also like:</b>`, {
                        reply_parameters: { message_id: sentMsg.message_id },
                        reply_markup: suggestKeyboard,
                        parse_mode: 'HTML'
                    });
                }
            } else {
                // Truly not found
                await ctx.reply(
                    `😕 <b>NO CLIPS FOUND</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `❌ Could not find: "<code>${query}</code>"\n\n` +
                    `💡 <b>Tips:</b>\n` +
                    `• Check your spelling\n` +
                    `• Try a different keyword\n` +
                    `• Ask admin to add it!`,
                    {
                        parse_mode: 'HTML',
                        reply_parameters: { message_id: ctx.message.message_id }
                    }
                );
                await sendToLogChannel(bot, `❌ Miss: ${getUserNameForLog(ctx)} | ${query}`);
            }
        } catch (error) {
            console.error('Search error:', error);
        }
    });

    // Handle typo suggestion - Yes
    bot.callbackQuery(/^typo_(.+)$/, async (ctx) => {
        const movieTitle = ctx.match[1];

        if (movieTitle === 'no') {
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(
                `❌ <b>Clips not found</b>\n\n` +
                `Try searching with correct spelling or ask admin to add the movie!`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        try {
            const movie = await Movie.findOne({ title: movieTitle });
            if (movie) {
                movie.requests += 1;
                await movie.save();

                await updateUserStats(ctx.from.id, 'search');

                const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
                const privateStart = `https://t.me/${botUsername}?start=${encodeMovieLink(movie.title)}`;
                const keyboard = new InlineKeyboard().url('📥 Tap to Get Clips in PM', privateStart);

                await ctx.answerCallbackQuery({ text: '✅ Found it!', show_alert: false });

                const clipCount = movie.files?.length || movie.messageIds.length;
                const photoFileId = movie.thumbnail || null;

                const resultText = `✨ ${movie.title.toUpperCase()}\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                    `📂 <b>Total Clips:</b> ${clipCount} Available\n` +
                    `📥 <b>Delivery:</b> Direct PM\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                    `👆 Tap below to get clips!`;

                await ctx.answerCallbackQuery({ text: '✅ Found it!', show_alert: false });

                if (photoFileId) {
                    await ctx.editMessageText(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
                    await ctx.replyWithPhoto(photoFileId, { caption: resultText, reply_markup: keyboard, parse_mode: 'HTML' });
                } else {
                    await ctx.editMessageText(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
                }
            } else {
                await ctx.answerCallbackQuery({ text: '❌ Clips not found', show_alert: true });
            }
        } catch (error) {
            console.error('❌ Group search error:', error.message);
        }
    });

    // Handle filter list movie selection
    bot.callbackQuery(/^f_(.+)$/, async (ctx) => {
        const movieTitle = ctx.match[1];
        try {
            const movie = await Movie.findOne({ title: movieTitle });
            if (!movie) return await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });

            movie.requests += 1;
            await movie.save();
            await updateUserStats(ctx.from.id, 'search');
            await ctx.answerCallbackQuery({ text: '✅ Sending clips...', show_alert: false });

            const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
            const privateStart = `https://t.me/${botUsername}?start=${encodeMovieLink(movie.title)}`;
            const keyboard = new InlineKeyboard().url('📥 Tap to Get Clips in PM', privateStart);

            const clipCount = movie.files?.length || movie.messageIds.length;
            const photoFileId = movie.thumbnail || null;

            const resultText = `✨ ${movie.title.toUpperCase()}\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `📂 <b>Total Clips:</b> ${clipCount} Available\n` +
                `📥 <b>Delivery:</b> Direct PM\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `👆 Tap below to get clips!`;

            if (photoFileId) {
                await ctx.editMessageText(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
                await ctx.replyWithPhoto(photoFileId, { caption: resultText, reply_markup: keyboard, parse_mode: 'HTML' });
            } else {
                await ctx.editMessageText(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
            }
        } catch (error) {
            console.error('Filter callback error:', error);
        }
    });

    // Handle search results (search_)
    bot.callbackQuery(/^search_(.+)$/, async (ctx) => {
        const movieTitle = ctx.match[1];
        try {
            const movie = await Movie.findOne({ title: movieTitle });
            if (!movie) return await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });

            movie.requests += 1;
            await movie.save();
            await updateUserStats(ctx.from.id, 'search');
            await ctx.answerCallbackQuery({ text: '✅ Sending clips...', show_alert: false });

            const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
            const privateStart = `https://t.me/${botUsername}?start=${encodeMovieLink(movie.title)}`;
            const keyboard = new InlineKeyboard().url('📥 Tap to Get Clips in PM', privateStart);

            const clipCount = movie.files?.length || movie.messageIds.length;
            const photoFileId = movie.thumbnail || null;

            const resultText = `✨ ${movie.title.toUpperCase()}\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `📂 <b>Total Clips:</b> ${clipCount} Available\n` +
                `📥 <b>Delivery:</b> Direct PM\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `👆 Tap below to get clips!`;

            if (photoFileId) {
                await ctx.editMessageText(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
                await ctx.replyWithPhoto(photoFileId, { caption: resultText, reply_markup: keyboard, parse_mode: 'HTML' });
            } else {
                await ctx.editMessageText(resultText, { reply_markup: keyboard, parse_mode: 'HTML' });
            }
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
            // Preserve order
            const orderedMovies = pageIds.map(id => pageMovies.find(m => m._id.equals(id)));

            const keyboard = buildFilterKeyboard(orderedMovies, page, session.movieIds.length);

            const helpText = `💎 MOVIE FILTER LIST\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🚀 Select a movie to get clips:\n\n` +
                `📊 <b>Page:</b> ${page + 1} / ${Math.ceil(session.movieIds.length / ITEMS_PER_PAGE)}\n` +
                `🎬 <b>Catalog:</b> ${session.movieIds.length} Movies Available\n\n` +
                `💡 <i>Clips are delivered directly to your PM for quality!</i>`;

            await ctx.answerCallbackQuery();
            await ctx.editMessageText(helpText, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });

            session.page = page;
            await session.save();
        } catch (error) {
            console.error('Pagination error:', error);
            await ctx.answerCallbackQuery({ text: '❌ Navigation error', show_alert: true });
        }
    });
};
