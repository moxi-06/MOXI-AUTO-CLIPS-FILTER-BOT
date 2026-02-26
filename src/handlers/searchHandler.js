const { Movie, User } = require('../database');
const { cleanMovieName, encodeMovieLink, sendToLogChannel } = require('../utils/helpers');
const { InlineKeyboard } = require('grammy');

const ITEMS_PER_PAGE = 10;
let filterListState = {};

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
async function findSimilarByTypo(query, threshold = 2) {
    const movies = await Movie.find();
    const results = [];
    const q = query.toLowerCase();
    const qSoundex = soundex(q);

    for (const movie of movies) {
        const title = movie.title.toLowerCase();

        // 1. Exact match (already handled before this function, but skip anyway)
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

        // 4. Category match
        const categoryMatch = movie.categories?.some(c =>
            c.toLowerCase().includes(q)
        );
        if (categoryMatch) {
            results.push({ movie, score: 0, reason: 'category' });
            continue;
        }

        // 5. Soundex match (phonetic)
        const titleSoundex = soundex(title);
        if (qSoundex === titleSoundex || qSoundex.charAt(0) === titleSoundex.charAt(0)) {
            results.push({ movie, score: 1, reason: 'soundex' });
            continue;
        }

        // 6. Levenshtein distance
        const levDistance = levenshteinDistance(q, title);
        if (levDistance <= threshold) {
            results.push({ movie, score: levDistance + 2, reason: 'levenshtein' });
            continue;
        }

        // 7. Keyboard proximity (for typo detection)
        const kbScore = keyboardProximity(q, title);
        if (kbScore <= 3) {
            results.push({ movie, score: kbScore + 4, reason: 'keyboard' });
        }
    }

    // Sort by score (lower is better, negative scores = higher priority)
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
    const start = page * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const pageMovies = movies.slice(start, end);

    pageMovies.forEach((m) => {
        const count = m.files?.length || m.messageIds.length;
        keyboard.text(`${m.title} (${count})`, `f_${m.title}`).row();
    });

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    const buttons = [];

    if (page > 0) {
        buttons.push({ text: '⬅️ Prev', callback_data: `fp_${page - 1}` });
    }
    if (page < totalPages - 1) {
        buttons.push({ text: 'Next ➡️', callback_data: `fp_${page + 1}` });
    }

    if (buttons.length > 0) {
        keyboard.row(...buttons);
    }

    return keyboard;
}

module.exports = (bot) => {
    bot.on('message:text', async (ctx, next) => {
        const groupId = process.env.GROUP_ID;
        if (!groupId || ctx.chat.id.toString() !== groupId) return next();

        // Skip old messages - only respond to messages after bot started
        const messageDate = ctx.message.date * 1000; // Convert to milliseconds
        if (messageDate < global.botStartedAt) {
            return; // Ignore old messages
        }

        // Check for common keywords to list filters
        const incomingText = (ctx.message.text || '').toLowerCase();

        // Skip if no text or too short
        if (!incomingText || incomingText.length < 2) return;

        const keywords = ['/filters', '/filter', 'filters', 'filter', 'clips', 'tamil', 'movie', 'movies', 'list'];

        if (keywords.includes(incomingText) || incomingText === 'list filters') {
            const movies = await Movie.find();
            if (movies.length === 0) return ctx.reply('📭 No movies in database yet!', { reply_parameters: { message_id: ctx.message.message_id } });

            // Delete previous filter list if exists
            if (filterListState[ctx.chat.id]) {
                try {
                    await ctx.api.deleteMessage(ctx.chat.id, filterListState[ctx.chat.id].messageId);
                } catch (_) { }
            }

            // Shuffle movies for random order
            const shuffled = movies.sort(() => Math.random() - 0.5);

            const page = 0;
            const keyboard = buildFilterKeyboard(shuffled, page, shuffled.length);

            const helpText = `📽️ <b>MOVIE EXPLORER</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `<b>Tap a movie below to get clips!</b>\n\n` +
                `🚀 <b>How it works:</b>\n` +
                `1️⃣ Tap a movie name\n` +
                `2️⃣ Click the link in PM\n` +
                `3️⃣ Get all clips instantly! 📬\n\n` +
                `📊 <b>Page:</b> ${page + 1} / ${Math.ceil(shuffled.length / ITEMS_PER_PAGE)}\n` +
                `🎬 <b>Total:</b> ${movies.length} movies`;

            const sent = await ctx.reply(helpText, {
                parse_mode: 'HTML',
                reply_markup: keyboard,
                reply_parameters: { message_id: ctx.message.message_id }
            });

            filterListState[ctx.chat.id] = {
                messageId: sent.message_id,
                movies: shuffled,
                page: 0
            };
            return;
        }

        const query = cleanMovieName(ctx.message.text);
        if (query.length < 2) return;

        // Track daily stats
        global.todayStats.searches++;

        // Get user info with badge
        const user = await User.findOne({ userId: ctx.from.id });
        const badgeIcon = getBadgeIcon(user?.downloadCount || 0, user?.searchCount || 0);
        const userName = ctx.from.first_name + (badgeIcon ? ` ${badgeIcon}` : '');

        try {
            let movie = await Movie.findOne({ title: query });

            // If not found, try spaceless match (runtime, no DB change)
            if (!movie) {
                const allMovies = await Movie.find();
                const spacelessMatch = allMovies.find(m => matchesSpaceless(query, m.title));
                if (spacelessMatch) {
                    movie = spacelessMatch;
                }
            }

            // If still not found, try token match
            if (!movie) {
                const allMovies = await Movie.find();
                const tokenMatch = allMovies.find(m => matchesTokens(query, m.title));
                if (tokenMatch) {
                    movie = tokenMatch;
                }
            }

            // If not found, try smart typo detection
            if (!movie) {
                const similarResults = await findSimilarByTypo(query);
                if (similarResults.length > 0) {
                    // Show up to 3 suggestions
                    const suggested = similarResults.slice(0, 3);
                    const keyboard = new InlineKeyboard();

                    suggested.forEach((item, index) => {
                        const num = index + 1;
                        keyboard.text(`${num}️⃣ ${item.movie.title}`, `typo_${item.movie.title}`);
                        if (index % 2 === 1 || index === suggested.length - 1) keyboard.row();
                    });
                    keyboard.text('❌ None', 'typo_no');

                    const suggestionText = suggested.length === 1
                        ? `🔍 <b>Did you mean:</b> <code>${suggested[0].movie.title}</code>?`
                        : `🔍 <b>Did you mean one of these?</b>\n\n${suggested.map((s, i) => `${i + 1}️⃣ ${s.movie.title}`).join('\n')}`;

                    await ctx.reply(
                        `${suggestionText}\n\n` +
                        `💡 <i>You searched: ${query}</i>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard,
                            reply_parameters: { message_id: ctx.message.message_id }
                        }
                    );
                    return;
                }
            }

            // Fuzzy search results (title/category match)
            if (movie) {
                movie.requests += 1;
                await movie.save();

                // Update user stats
                await updateUserStats(ctx.from.id, 'search');

                const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
                const encodedTitle = encodeMovieLink(movie.title);
                const privateStart = `https://t.me/${botUsername}?start=${encodedTitle}`;

                const keyboard = new InlineKeyboard().url('📥 Get Clips in PM', privateStart);

                const clipCount = movie.files?.length || movie.messageIds.length;

                // Get thumbnail from database
                let photoFileId = movie.thumbnail || null;

                const resultText = `✨ <b>${movie.title.toUpperCase()}</b>\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                    `📂 <b>Clips:</b> ${clipCount} Available\n` +
                    `📥 <b>Delivery:</b> Direct PM\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━`;

                let sentMsg;
                if (photoFileId) {
                    // Send with photo for single result
                    sentMsg = await ctx.replyWithPhoto(photoFileId, {
                        caption: resultText,
                        reply_parameters: { message_id: ctx.message.message_id },
                        reply_markup: keyboard,
                        parse_mode: 'HTML'
                    });
                } else {
                    // Send text only
                    sentMsg = await ctx.reply(
                        resultText,
                        {
                            reply_parameters: { message_id: ctx.message.message_id },
                            reply_markup: keyboard,
                            parse_mode: 'HTML'
                        }
                    );
                }

                // Find similar movies for suggestions
                const similar = await findSimilarMovies(movie, 3);
                if (similar.length > 0) {
                    const suggestKeyboard = new InlineKeyboard();
                    similar.forEach(m => {
                        suggestKeyboard.text(m.title, `search_${m.title}`).row();
                    });

                    await ctx.reply(
                        `💡 Related movies:`,
                        {
                            reply_parameters: { message_id: sentMsg.message_id },
                            reply_markup: suggestKeyboard,
                            parse_mode: 'HTML'
                        }
                    );
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

                await sendToLogChannel(bot, `🔍 ${getUserNameForLog(ctx)} | ${movie.title} (${movie.messageIds.length} clips)`);

            } else {
                // Search in title AND categories
                const fuzzyMovies = await Movie.find({
                    $or: [
                        { title: { $regex: query, $options: 'i' } },
                        { categories: { $regex: query, $options: 'i' } }
                    ]
                }).limit(5);

                if (fuzzyMovies.length === 1) {
                    const movie = fuzzyMovies[0];
                    movie.requests += 1;
                    await movie.save();
                    await updateUserStats(ctx.from.id, 'search');

                    const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
                    const encodedTitle = encodeMovieLink(movie.title);
                    const privateStart = `https://t.me/${botUsername}?start=${encodedTitle}`;

                    const keyboard = new InlineKeyboard().url('📥 Tap to Get Clips in PM', privateStart);

                    const clipCount = movie.files?.length || movie.messageIds.length;
                    let photoFileId = movie.thumbnail || null;

                    const resultText = `✨ <b>${movie.title.toUpperCase()}</b>\n` +
                        `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                        `📂 <b>Total Clips:</b> ${clipCount} Available\n` +
                        `📥 <b>Delivery:</b> Direct Private Message\n` +
                        `📊 <b>Today:</b> ${global.todayStats.deliveries} deliveries\n` +
                        `👤 ${userName}\n` +
                        `━━━━━━━━━ ✦ ━━━━━━━━━`;

                    let sentMsg;
                    if (photoFileId) {
                        sentMsg = await ctx.replyWithPhoto(photoFileId, {
                            caption: resultText,
                            reply_parameters: { message_id: ctx.message.message_id },
                            reply_markup: keyboard,
                            parse_mode: 'HTML'
                        });
                    } else {
                        sentMsg = await ctx.reply(
                            resultText,
                            {
                                reply_parameters: { message_id: ctx.message.message_id },
                                reply_markup: keyboard,
                                parse_mode: 'HTML'
                            }
                        );
                    }

                    const similar = await findSimilarMovies(movie, 3);
                    if (similar.length > 0) {
                        const suggestKeyboard = new InlineKeyboard();
                        similar.forEach(m => {
                            suggestKeyboard.text(`🎬 ${m.title}`, `search_${m.title}`).row();
                        });
                        await ctx.reply(
                            `💡 <b>You might also like:</b>`,
                            {
                                reply_parameters: { message_id: sentMsg.message_id },
                                reply_markup: suggestKeyboard,
                                parse_mode: 'HTML'
                            }
                        );
                    }

                    setTimeout(async () => {
                        try {
                            await ctx.api.editMessageText(
                                ctx.chat.id, sentMsg.message_id,
                                `⏰ Expired\n` +
                                `━ ━ ━ ━ ✦ ━ ━ ━ ━\n` +
                                `Movie: ${movie.title}\n\n` +
                                `Search again to get fresh link!`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (_) { }
                    }, 5 * 60 * 1000);

                    await sendToLogChannel(bot, `🔍 ${getUserNameForLog(ctx)} | ${movie.title} (${movie.messageIds.length} clips)`);
                } else if (fuzzyMovies.length > 1) {
                    const keyboard = new InlineKeyboard();
                    fuzzyMovies.forEach(m => {
                        keyboard.text(m.title, `search_${m.title}`).row();
                    });

                    await ctx.reply(
                        `🔍 <b>SEARCH RESULTS:</b> "<code>${query}</code>"\n` +
                        `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                        `🎬 <b>Multiple matches found!</b>\n` +
                        `👇 Tap a movie to get clips:`,
                        {
                            reply_parameters: { message_id: ctx.message.message_id },
                            reply_markup: keyboard,
                            parse_mode: 'HTML'
                        }
                    );
                } else {
                    // Try smart typo detection
                    const similarResults = await findSimilarByTypo(query);
                    if (similarResults.length > 0) {
                        const suggested = similarResults.slice(0, 3);
                        const keyboard = new InlineKeyboard();

                        suggested.forEach((item, index) => {
                            keyboard.text(item.movie.title, `typo_${item.movie.title}`);
                            if (index % 2 === 1 || index === suggested.length - 1) keyboard.row();
                        });
                        keyboard.text('❌ None', 'typo_no');

                        const suggestionText = suggested.length === 1
                            ? `❓ Did you mean: ${suggested[0].movie.title}?`
                            : `❓ Did you mean:\n${suggested.map((s, i) => `${i + 1}. ${s.movie.title}`).join('\n')}`;

                        await ctx.reply(
                            `${suggestionText}\n\n` +
                            `You searched: ${query}`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard,
                                reply_parameters: { message_id: ctx.message.message_id }
                            }
                        );
                    } else {
                        await ctx.reply(
                            `😕 <b>NO CLIPS FOUND</b>\n` +
                            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
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
                }
            }
        } catch (error) {
            console.error('Filter callback error:', error);
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

                // Get thumbnail from database
                let photoFileId = movie.thumbnail || null;

                const resultText = `✨ <b>${movie.title.toUpperCase()}</b>\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                    `📂 <b>Total Clips:</b> ${clipCount} Available\n` +
                    `📥 <b>Delivery:</b> Direct Private Message\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                    `👆 Tap below to get clips!`;

                if (photoFileId) {
                    await ctx.editMessageText(
                        resultText,
                        {
                            reply_markup: keyboard,
                            parse_mode: 'HTML'
                        }
                    );
                    await ctx.replyWithPhoto(photoFileId, {
                        caption: resultText,
                        reply_markup: keyboard,
                        parse_mode: 'HTML'
                    });
                } else {
                    await ctx.editMessageText(
                        resultText,
                        {
                            reply_markup: keyboard,
                            parse_mode: 'HTML'
                        }
                    );
                }
            } else {
                await ctx.answerCallbackQuery({ text: '❌ Clips not found', show_alert: true });
            }
        } catch (error) {
            console.error('❌ Group search error:', error.message);
            try {
                await sendToLogChannel(bot, `⚠️ <b>Search Error</b>\n<code>${error.message}</code>`);
            } catch (e) { }
        }
    });

    // Handle filter list movie selection
    bot.callbackQuery(/^f_(.+)$/, async (ctx) => {
        const movieTitle = ctx.match[1];

        try {
            const movie = await Movie.findOne({ title: movieTitle });
            if (!movie) {
                await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });
                return;
            }

            movie.requests += 1;
            await movie.save();

            await updateUserStats(ctx.from.id, 'search');
            await ctx.answerCallbackQuery({ text: '✅ Sending clips...', show_alert: false });

            const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
            const privateStart = `https://t.me/${botUsername}?start=${encodeMovieLink(movie.title)}`;
            const keyboard = new InlineKeyboard().url('📥 Tap to Get Clips in PM', privateStart);

            const clipCount = movie.files?.length || movie.messageIds.length;
            let photoFileId = movie.thumbnail || null;

            const resultText = `✨ <b>${movie.title.toUpperCase()}</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `📂 <b>Total Clips:</b> ${clipCount} Available\n` +
                `📥 <b>Delivery:</b> Direct Private Message\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `👆 Tap below to get clips!`;

            if (photoFileId) {
                await ctx.editMessageText(
                    resultText,
                    { reply_markup: keyboard, parse_mode: 'HTML' }
                );
                await ctx.replyWithPhoto(photoFileId, {
                    caption: resultText,
                    reply_markup: keyboard,
                    parse_mode: 'HTML'
                });
            } else {
                await ctx.editMessageText(
                    resultText,
                    { reply_markup: keyboard, parse_mode: 'HTML' }
                );
            }
        } catch (error) {
            console.error('Filter callback error:', error);
            await ctx.answerCallbackQuery({ text: '❌ Error occurred', show_alert: true });
        }
    });

    // Handle search results (search_) - used in fuzzy results and similar movies
    bot.callbackQuery(/^search_(.+)$/, async (ctx) => {
        const movieTitle = ctx.match[1];

        try {
            const movie = await Movie.findOne({ title: movieTitle });
            if (!movie) {
                await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });
                return;
            }

            movie.requests += 1;
            await movie.save();

            await updateUserStats(ctx.from.id, 'search');
            await ctx.answerCallbackQuery({ text: '✅ Sending clips...', show_alert: false });

            const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
            const privateStart = `https://t.me/${botUsername}?start=${encodeMovieLink(movie.title)}`;
            const keyboard = new InlineKeyboard().url('📥 Tap to Get Clips in PM', privateStart);

            const clipCount = movie.files?.length || movie.messageIds.length;
            let photoFileId = movie.thumbnail || null;

            const resultText = `✨ <b>${movie.title.toUpperCase()}</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `📂 <b>Total Clips:</b> ${clipCount} Available\n` +
                `📥 <b>Delivery:</b> Direct Private Message\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `👆 Tap below to get clips!`;

            if (photoFileId) {
                await ctx.editMessageText(
                    resultText,
                    { reply_markup: keyboard, parse_mode: 'HTML' }
                );
                await ctx.replyWithPhoto(photoFileId, {
                    caption: resultText,
                    reply_markup: keyboard,
                    parse_mode: 'HTML'
                });
            } else {
                await ctx.editMessageText(
                    resultText,
                    { reply_markup: keyboard, parse_mode: 'HTML' }
                );
            }
        } catch (error) {
            console.error('Search callback error:', error);
            await ctx.answerCallbackQuery({ text: '❌ Error occurred', show_alert: true });
        }
    });

    // Handle filter list pagination
    bot.callbackQuery(/^fp_(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1]);

        const state = filterListState[ctx.chat.id];
        if (!state) {
            await ctx.answerCallbackQuery({ text: 'Session expired', show_alert: true });
            return;
        }

        const keyboard = buildFilterKeyboard(state.movies, page, state.movies.length);

        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });

        filterListState[ctx.chat.id].page = page;
    });
};
