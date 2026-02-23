const { Movie, User } = require('../database');
const { cleanMovieName, encodeMovieLink, sendToLogChannel } = require('../utils/helpers');
const { InlineKeyboard } = require('grammy');

const ITEMS_PER_PAGE = 10;
let filterListState = {};

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

// Find similar movie names using Levenshtein distance
async function findSimilarByTypo(query, threshold = 2) {
    const movies = await Movie.find();
    const results = [];
    
    for (const movie of movies) {
        const title = movie.title.toLowerCase();
        const q = query.toLowerCase();
        
        // Exact match
        if (title.includes(q)) continue;
        
        // Check categories too
        const categoryMatch = movie.categories?.some(c => 
            c.toLowerCase().includes(q)
        );
        if (categoryMatch) {
            results.push({ movie, score: 0 });
            continue;
        }
        
        // Levenshtein distance
        const distance = levenshteinDistance(q, title);
        if (distance <= threshold) {
            results.push({ movie, score: distance });
        }
    }
    
    // Sort by score (lower is better)
    results.sort((a, b) => a.score - b.score);
    return results.slice(0, 3);
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
            { upsert: true, new: true }
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
        keyboard.text(`🎬 ${m.title}`, `f_${m.title}`).row();
    });
    
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    const buttons = [];
    
    if (page > 0) {
        buttons.push({ text: '⬅️ Previous', callback_data: `fp_${page - 1}` });
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

        // Check for common keywords to list filters
        const incomingText = ctx.message.text.toLowerCase();
        const keywords = ['/filters', 'filters', 'clips', 'tamil', 'movie', 'list'];

        if (keywords.includes(incomingText) || incomingText === 'list filters') {
            const movies = await Movie.find();
            if (movies.length === 0) return ctx.reply('📭 No movies in database yet!');

            // Delete previous filter list if exists
            if (filterListState[ctx.chat.id]) {
                try {
                    await ctx.api.deleteMessage(ctx.chat.id, filterListState[ctx.chat.id].messageId);
                } catch (_) {}
            }

            // Shuffle movies for random order
            const shuffled = movies.sort(() => Math.random() - 0.5);
            
            const page = 0;
            const keyboard = buildFilterKeyboard(shuffled, page, shuffled.length);

            const helpText = `📂 <b>ALL MOVIES LIST</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `👆 Tap any movie to get clips!\n\n` +
                `💡 <b>Simple Guide:</b>\n` +
                `1️⃣ Click movie name below\n` +
                `2️⃣ I will send button to your PM\n` +
                `3️⃣ Click that to get all clips!\n\n` +
                `📊 Page: <b>1</b> / <b>${Math.ceil(shuffled.length / ITEMS_PER_PAGE)}</b>\n` +
                `✨ Total: <b>${movies.length}</b> movies`;

            const sent = await ctx.reply(helpText, { 
                parse_mode: 'HTML',
                reply_markup: keyboard
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

            // If not found, try smart typo detection
            if (!movie) {
                const similarResults = await findSimilarByTypo(query);
                if (similarResults.length > 0) {
                    // Show typo suggestion
                    const suggested = similarResults[0].movie;
                    const keyboard = new InlineKeyboard()
                        .text(`🎬 Yes, ${suggested.title}`, `typo_${suggested.title}`)
                        .text('❌ No', 'typo_no');

                    await ctx.reply(
                        `🔍 Did you mean <b>${suggested.title}</b>?\n\n` +
                        `💡 You searched: <i>${query}</i>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                    return;
                }
            }

            if (movie) {
                movie.requests += 1;
                await movie.save();

                // Update user stats
                await updateUserStats(ctx.from.id, 'search');

                const botUsername = process.env.BOT_USERNAME || (ctx.me ? ctx.me.username : '');
                const encodedTitle = encodeMovieLink(movie.title);
                const privateStart = `https://t.me/${botUsername}?start=${encodedTitle}`;

                const keyboard = new InlineKeyboard().url('📥 Tap to Get Clips in PM', privateStart);

                const sentMsg = await ctx.reply(
                    `✨ <b>${movie.title.toUpperCase()}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📂 <b>Total Clips:</b> ${movie.messageIds.length} Available\n` +
                    `📥 <b>Delivery:</b> Direct Private Message\n` +
                    `📊 <b>Today:</b> ${global.todayStats.deliveries} deliveries\n` +
                    `👤 ${userName}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`,
                    {
                        reply_parameters: { message_id: ctx.message.message_id },
                        reply_markup: keyboard,
                        parse_mode: 'HTML'
                    }
                );

                // Find similar movies for suggestions
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

                // Auto-edit after 5 minutes
                setTimeout(async () => {
                    try {
                        await ctx.api.editMessageText(
                            ctx.chat.id, sentMsg.message_id,
                            `⚠️ <b>SEARCH EXPIRED</b>\n` +
                            `━━━━━━━━━━━━━━━━━━━━\n` +
                            `🎬 <b>Movie:</b> ${movie.title}\n\n` +
                            `💡 <i>This result link has expired. Please search for the movie again to get a fresh link!</i>`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (_) { }
                }, 5 * 60 * 1000);

                await sendToLogChannel(bot, `🔍 <b>Search Hit</b>\nUser: <code>${ctx.from.id}</code> (@${ctx.from.username || 'N/A'})\nMovie: <i>${movie.title}</i> (<b>${movie.messageIds.length}</b> clips)`);

            } else {
                // Search in title AND categories
                const fuzzyMovies = await Movie.find({
                    $or: [
                        { title: { $regex: query, $options: 'i' } },
                        { categories: { $regex: query, $options: 'i' } }
                    ]
                }).limit(5);

                if (fuzzyMovies.length > 0) {
                    const keyboard = new InlineKeyboard();
                    fuzzyMovies.forEach(m => {
                        const isCategoryMatch = m.categories.some(c => c.toLowerCase().includes(query.toLowerCase()));
                        const label = isCategoryMatch 
                            ? `🎬 ${m.title} (${m.messageIds.length} clips)` 
                            : `🎬 ${m.title}`;
                        keyboard.text(label, `search_${m.title}`).row();
                    });

                    await ctx.reply(
                        `🔍 <b>Search Results for "${query}"</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `👆 Tap a movie to get clips!`,
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
                        const suggested = similarResults[0].movie;
                        const keyboard = new InlineKeyboard()
                            .text(`🎬 Yes, ${suggested.title}`, `typo_${suggested.title}`)
                            .text('❌ No', 'typo_no');

                        await ctx.reply(
                            `🔍 Did you mean <b>${suggested.title}</b>?\n\n` +
                            `💡 You searched: <i>${query}</i>`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard
                            }
                        );
                    } else {
                        await ctx.reply(
                            `❌ <b>Clips not found for "${query}"</b>\n` +
                            `━━━━━━━━━━━━━━━━━━━━\n` +
                            `Try searching with correct spelling or ask admin to add the clips!`,
                            {
                                parse_mode: 'HTML'
                            }
                        );
                        await sendToLogChannel(bot, `❌ <b>Search Miss</b>\nUser: <code>${ctx.from.id}</code> (@${ctx.from.username || 'N/A'})\nQuery: <i>${query}</i>\n\n#request 🎬`);
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

                await ctx.editMessageText(
                    `✨ <b>${movie.title.toUpperCase()}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📂 <b>Total Clips:</b> ${movie.messageIds.length} Available\n` +
                    `📥 <b>Delivery:</b> Direct Private Message\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `👆 Tap below to get clips!`,
                    {
                        reply_markup: keyboard,
                        parse_mode: 'HTML'
                    }
                );
            } else {
                await ctx.answerCallbackQuery({ text: '❌ Clips not found', show_alert: true });
            }
        } catch (error) {
            console.error('❌ Group search error:', error.message);
            try {
                await sendToLogChannel(bot, `⚠️ <b>Search Error</b>\n<code>${error.message}</code>`);
            } catch (e) {}
        }
    });
};
