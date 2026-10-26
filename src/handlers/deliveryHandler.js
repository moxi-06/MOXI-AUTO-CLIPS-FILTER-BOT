const { Movie, Room, User, BotSettings } = require('../database');
const {
    decodeMovieLink,
    encodeMovieLink,
    escapeHtml,
    sleep,
    sendToLogChannel,
    safeDeleteRoomMessages,
    safeKickRoomUser,
    extractMovieDetails
} = require('../utils/helpers');
const { getSetting, wrapShortlink, hasValidToken, grantToken, getTokenExpiry } = require('../utils/monetization');
const { scheduleAutoDelete, ONE_HOUR_MS } = require('../utils/autoDeleteManager');
const { InlineKeyboard } = require('grammy');

function getUserNameForLog(user) {
    if (!user) return 'User';
    if (user.username) return `@${user.username}`;
    if (user.first_name) return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
    return `User ${user.id}`;
}

function extractRatio(title) {
    if (!title) return '16:9';
    const match = title.match(/\b(16:9|9:16|4:3|1:1|21:9)\b/i);
    return match ? match[1] : '16:9';
}

// Auto-delete a bot message after N milliseconds (Default: 1 Hour)
const autoDelete = async (api, chatId, messageId, ms = ONE_HOUR_MS) => {
    scheduleAutoDelete(api, chatId, messageId, ms);
};

// Delete command message that triggered the bot
const deleteTriggerMessage = async (ctx, ms = ONE_HOUR_MS) => {
    if (ctx.message?.message_id) {
        scheduleAutoDelete(ctx.api, ctx.chat.id, ctx.message.message_id, ms);
    }
};

// "Delete Old ➔ Send New" Notification Engine:
// Deletes previous message to prevent chat clutter, sends fresh message to trigger notification/vibration & scroll
const deleteOldAndSendNew = async (ctx, oldMsgId, text, options = {}) => {
    if (oldMsgId) {
        try { await ctx.api.deleteMessage(ctx.chat.id, oldMsgId); } catch (_) { }
    }
    const sendOpts = { parse_mode: 'HTML', disable_web_page_preview: true, ...options };
    return await ctx.reply(text, sendOpts);
};

// ────────────────────────────────────────────────────────────────────
// Force Subscribe Check
// ────────────────────────────────────────────────────────────────────
async function checkForceSub(ctx) {
    const forceSubChannel = await getSetting('forceSubChannel', null);
    if (!forceSubChannel) return true; // Not configured → pass

    try {
        const member = await ctx.api.getChatMember(forceSubChannel, ctx.from.id);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (e) {
        console.error('[ForceSub] Could not check membership:', e.message);
        return true; // Fail open if check errors
    }
}

// Helper to build the PM Home Dashboard Keyboard
function buildUserDashboardKeyboard(isAdminUser = false) {
    const groupLink = process.env.GROUP_LINK || '';
    const keyboard = new InlineKeyboard();

    if (groupLink) {
        keyboard.url('👥 Open Search Group »', groupLink).row();
    }
    keyboard.text('🎬 All Movies', 'user_browse_0').text('🔥 Trending', 'user_trending').row();
    keyboard.text('🎲 Random Movie', 'user_random').text('👤 My Profile', 'user_profile').row();
    keyboard.text('💬 Contact Admin', 'user_contact');

    if (isAdminUser) {
        keyboard.row().text('🟣 Admin Console', 'admin_panel');
    }
    keyboard.row().text('❌ Close', 'close_msg');

    return keyboard;
}

// ────────────────────────────────────────────────────────────────────
// Main Handler
// ────────────────────────────────────────────────────────────────────
module.exports = (bot) => {
    // Admin contact command - allows users to message admin directly
    bot.command('contact', async (ctx) => {
        if (ctx.chat.type !== 'private') return;

        const adminId = process.env.ADMIN_ID;
        const user = ctx.from;
        const messageText = ctx.message.text.replace('/contact', '').trim();

        if (!messageText) {
            return ctx.reply(
                `💬 <b>Contact Admin:</b>\n` +
                `Type: <code>/contact your message</code>\n\n` +
                `<i>Example: /contact Please add Leo movie clips!</i>`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Close', 'close_msg') }
            );
        }

        try {
            await bot.api.sendMessage(
                adminId,
                `📩 <b>User Message:</b>\n` +
                `👤 From: ${getUserNameForLog(user)} (<code>${user.id}</code>)\n\n` +
                `💬 <i>"${escapeHtml(messageText)}"</i>\n\n` +
                `🔗 Reply to this message to reply back!`,
                { parse_mode: 'HTML' }
            );

            ctx.reply(
                `✅ <b>Message Sent!</b>\nYour message was forwarded to the admin.`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Close', 'close_msg') }
            );
        } catch (e) {
            ctx.reply(`❌ Could not send message to admin. Please try again later.`, {
                reply_markup: new InlineKeyboard().text('❌ Close', 'close_msg')
            });
        }
    });

    // Forward all PM messages (non-command) to log channel
    bot.on('message', async (ctx, next) => {
        if (ctx.chat.type !== 'private') return next();
        if (ctx.message.text && ctx.message.text.startsWith('/')) return next();

        const adminId = process.env.ADMIN_ID;
        const logChannelId = process.env.LOG_CHANNEL_ID;
        if (!logChannelId) return next();

        const user = ctx.from;
        const userName = user.username ? `@${user.username}` : `${user.first_name || 'User'} ${user.last_name || ''}`.trim();

        let logText = `📨 <b>New PM Message</b>\n\n👤 User: ${userName} (<code>${user.id}</code>)\n`;

        if (ctx.message.text) {
            logText += `📝 Message: ${escapeHtml(ctx.message.text)}\n`;
        } else if (ctx.message.photo) {
            const caption = ctx.message.caption || '(no caption)';
            logText += `📸 Photo: ${escapeHtml(caption)}\n`;
        } else if (ctx.message.video) {
            const caption = ctx.message.caption || '(no caption)';
            logText += `🎥 Video: ${escapeHtml(caption)}\n`;
        } else if (ctx.message.document) {
            const caption = ctx.message.caption || '(no caption)';
            logText += `📄 Document: ${escapeHtml(caption)}\n`;
        } else if (ctx.message.sticker) {
            logText += `🎭 Sticker: ${ctx.message.sticker.emoji || ''}\n`;
        } else if (ctx.message.animation) {
            logText += `🎞️ GIF/Animation\n`;
        } else if (ctx.message.audio) {
            const caption = ctx.message.caption || '(no caption)';
            logText += `🎵 Audio: ${escapeHtml(caption)}\n`;
        } else if (ctx.message.voice) {
            logText += `🎤 Voice Message\n`;
        } else if (ctx.message.video_note) {
            logText += `⭕ Video Note\n`;
        } else {
            logText += `📎 Other media type\n`;
        }

        try {
            await bot.api.sendMessage(logChannelId, logText, { parse_mode: 'HTML' });
        } catch (_) { }

        return next();
    });

    // Handle replies from admin to users
    bot.on('message:text', async (ctx, next) => {
        if (ctx.message.text.startsWith('/')) return next();
        if (ctx.chat.type !== 'private') return next();

        const adminId = process.env.ADMIN_ID;
        if (!adminId || ctx.from.id.toString() !== adminId.toString()) return next();
        if (!ctx.message.reply_to_message) return next();

        const replyText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
        const userIdMatch = replyText.match(/\[ID:\s*([0-9]+)\]/i) ||
            replyText.match(/\(code\)([0-9]+)\(\/code\)/i) ||
            replyText.match(/\b([0-9]{6,15})\b/);
        if (!userIdMatch) return next();

        const userId = parseInt(userIdMatch[1], 10);

        try {
            await bot.api.sendMessage(
                userId,
                `💬 <b>Admin Reply:</b>\n\n${ctx.message.text}`,
                { parse_mode: 'HTML' }
            );
            ctx.reply('✅ Reply sent to user!');
        } catch (e) {
            ctx.reply('❌ Could not send reply to user.');
        }
    });

    // ────────────────────────────────────────────────────────────────
    // Interactive User Dashboard Callback Handlers (Zero Delay)
    // ────────────────────────────────────────────────────────────────

    // 1. PM All Movies Browser (with dynamic items per page)
    bot.callbackQuery(/^user_browse_(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery({ text: '⚡ Loading movies...' });
        const page = parseInt(ctx.match[1], 10) || 0;
        const limit = parseInt(await getSetting('itemsPerPage', 10), 10) || 10;
        const total = await Movie.countDocuments();
        const movies = await Movie.find({}, { title: 1, files: 1, messageIds: 1 })
            .sort({ title: 1 })
            .skip(page * limit)
            .limit(limit)
            .lean();

        const keyboard = new InlineKeyboard();
        movies.forEach(m => {
            const count = m.files?.length || m.messageIds?.length || 0;
            const startUrl = `https://t.me/${ctx.me?.username}?start=${encodeMovieLink(m)}`;
            keyboard.url(`▫️ ${m.title.toUpperCase()} (${count})`, startUrl).row();
        });

        const totalPages = Math.ceil(total / limit);
        if (page > 0) keyboard.text('◀ Prev', `user_browse_${page - 1}`);
        if (page < totalPages - 1) keyboard.text('🔵 Next ▶', `user_browse_${page + 1}`);
        if (page > 0 || page < totalPages - 1) keyboard.row();

        keyboard.text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg');

        const text = `🎬 <b>Movie Archive</b> (Page ${page + 1}/${Math.max(totalPages, 1)})\n<i>Tap any movie below to get clips:</i>`;

        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    });

    // 2. PM Trending Movies
    bot.callbackQuery('user_trending', async (ctx) => {
        await ctx.answerCallbackQuery();
        const topMovies = await Movie.find().sort({ requests: -1 }).limit(5).lean();
        const keyboard = new InlineKeyboard();

        topMovies.forEach((m, idx) => {
            const count = m.files?.length || m.messageIds?.length || 0;
            const startUrl = `https://t.me/${ctx.me?.username}?start=${encodeMovieLink(m)}`;
            keyboard.url(`🔥 #${idx + 1} ${m.title.toUpperCase()} (${count})`, startUrl).row();
        });
        keyboard.text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg');

        const text = `🔥 <b>Trending Movies</b>\n<i>Most requested by editors right now:</i>`;
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    });

    // 3. PM Random Movie
    bot.callbackQuery('user_random', async (ctx) => {
        await ctx.answerCallbackQuery({ text: '🎲 Rolling...' });
        const count = await Movie.countDocuments();
        if (count === 0) {
            return ctx.answerCallbackQuery({ text: 'No movies found!', show_alert: true });
        }
        const randomIdx = Math.floor(Math.random() * count);
        const randomMovie = await Movie.findOne().skip(randomIdx);
        if (!randomMovie) return;

        const clipCount = randomMovie.files?.length || randomMovie.messageIds?.length || 0;
        const startUrl = `https://t.me/${ctx.me?.username}?start=${encodeMovieLink(randomMovie)}`;

        const details = extractMovieDetails(randomMovie.title);
        const creditsLine = details.credits ? `\n<b>Edited by:</b> ${details.credits}` : '';
        const ratio = extractRatio(randomMovie.title);
        const cleanName = details.name.replace(/\b(16:9|9:16|4:3|1:1|21:9)\b/ig, '').replace(/[\s\-_]+$/, '').trim() || details.name;

        const category = (randomMovie.categories && randomMovie.categories.length > 0)
            ? randomMovie.categories.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ')
            : 'Love 💗';

        const keyboard = new InlineKeyboard()
            .url(`⚡ Get Clips »`, startUrl).row()
            .text('🎲 Roll Another', 'user_random')
            .text('🔙 « Back', 'user_home').row()
            .text('❌ Close', 'close_msg');

        const text = `🎲 <b>RANDOM PICK FOR YOU!</b>\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
            `👤 <b>Requested by:</b> <a href="tg://user?id=${ctx.from.id}">${escapeHtml(ctx.from.first_name || 'User')}</a>\n\n` +
            `<b>Name:</b> ${cleanName}\n` +
            `<b>Type:</b> ${category}\n` +
            `<b>Ratio:</b> ${ratio}\n` +
            `<b>Clips:</b> ${clipCount} Available${creditsLine}\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `😍👇 Click below to get clips`;

        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    });

    // 4. PM User Profile
    bot.callbackQuery('user_profile', async (ctx) => {
        await ctx.answerCallbackQuery();
        const user = await User.findOne({ userId: ctx.from.id });
        const searches = user?.searchCount || 0;
        const downloads = user?.downloadCount || 0;
        const badge = user?.badges?.slice(-1)[0] || '🌟 MOXI NEWBIE';

        let nextBadge = '5 downloads for ✨ MOXI MEMBER';
        if (downloads >= 50) nextBadge = 'Max rank unlocked!';
        else if (downloads >= 30) nextBadge = `${50 - downloads} more for 🔥 MOXI LEGEND`;
        else if (downloads >= 15) nextBadge = `${30 - downloads} more for ⚡ MOXI STAR`;
        else if (downloads >= 5) nextBadge = `${15 - downloads} more for 💫 MOXI PRO`;

        const keyboard = new InlineKeyboard()
            .text('🔙 « Back', 'user_home')
            .text('❌ Close', 'close_msg');
        const text = `👤 <b>Your Profile:</b> ${getUserNameForLog(ctx.from)}\n\n` +
            `• Rank: <b>${badge}</b>\n` +
            `• Searches: <b>${searches}</b>\n` +
            `• Downloads: <b>${downloads} clips</b>\n\n` +
            `📈 <i>${nextBadge}</i>`;

        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    });

    // 5. PM Contact Prompt
    bot.callbackQuery('user_contact', async (ctx) => {
        await ctx.answerCallbackQuery();
        const keyboard = new InlineKeyboard()
            .text('🔙 « Back', 'user_home')
            .text('❌ Close', 'close_msg');
        const text = `💬 <b>Contact Admin</b>\n\n` +
            `Send your message anytime by typing:\n` +
            `<code>/contact your message here</code>\n\n` +
            `<i>Our admin will review and reply directly to your chat!</i>`;

        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    });

    // 6. Return to PM Home
    bot.callbackQuery('user_home', async (ctx) => {
        await ctx.answerCallbackQuery();
        const isAdminUser = Boolean(process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID);
        const keyboard = buildUserDashboardKeyboard(isAdminUser);
        const text = `👋 <b>Welcome to Moxi Clips!</b>\n<i>Search any movie in our group to get clips delivered here.</i>`;

        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    });

    // 7. Watch Tutorial
    bot.callbackQuery('user_tutorial', async (ctx) => {
        await ctx.answerCallbackQuery({ text: '💡 Sending tutorial...' });
        try {
            const tutStr = await getSetting('tutorial');
            if (!tutStr) {
                const sent = await ctx.reply('ℹ️ No tutorial video configured yet.', {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('❌ Close', 'close_msg')
                });
                autoDelete(ctx.api, ctx.chat.id, sent.message_id, ONE_HOUR_MS);
                return;
            }
            const tutData = JSON.parse(tutStr);
            const keyboard = new InlineKeyboard().text('❌ Close', 'close_msg');
            const captionOpts = { caption: '💡 <b>How to verify link:</b>', parse_mode: 'HTML', reply_markup: keyboard };
            if (tutData.type === 'video') {
                const sent = await ctx.replyWithVideo(tutData.fileId, captionOpts);
                autoDelete(ctx.api, ctx.chat.id, sent.message_id, ONE_HOUR_MS);
            } else if (tutData.type === 'document') {
                const sent = await ctx.replyWithDocument(tutData.fileId, captionOpts);
                autoDelete(ctx.api, ctx.chat.id, sent.message_id, ONE_HOUR_MS);
            } else if (tutData.type === 'link') {
                const sent = await ctx.reply(`💡 <b>How to verify link:</b>\n\n👉 <a href="${tutData.text}">Watch Tutorial Here</a>`, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: keyboard
                });
                autoDelete(ctx.api, ctx.chat.id, sent.message_id, ONE_HOUR_MS);
            }
        } catch (e) {
            console.error('Tutorial send error:', e.message);
        }
    });

    // ────────────────────────────────────────────────────────────────
    // Main /start Command (Payload delivery or Home menu)
    // ────────────────────────────────────────────────────────────────
    bot.command('start', async (ctx, next) => {
        if (ctx.chat.type !== 'private') return next();

        // Save user to DB and check if new
        const user = await User.findOneAndUpdate(
            { userId: ctx.from.id },
            { $setOnInsert: { userId: ctx.from.id, joinedAt: new Date() } },
            { upsert: true, returnDocument: 'after' }
        );

        if (user.joinedAt && Date.now() - new Date(user.joinedAt).getTime() < 5000) {
            await sendToLogChannel(bot, `👋 <b>New User Started Bot</b>\n\n👤 User: ${getUserNameForLog(ctx.from)} (<code>${ctx.from.id}</code>)`);
        }

        const payload = ctx.match;
        let isVerified = false;
        let moviePayload = payload;

        if (payload && payload.startsWith('v_')) {
            isVerified = true;
            moviePayload = payload.substring(2);
        }

        const isAdminUser = Boolean(process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID);

        // ─── No Payload → Clean Minimal Home Dashboard ──────────────
        if (!moviePayload) {
            const keyboard = buildUserDashboardKeyboard(isAdminUser);
            const welcome = await ctx.reply(
                `👋 <b>Welcome to Moxi Clips!</b>\n<i>Search any movie in our group to get clips delivered here.</i>`,
                { parse_mode: 'HTML', reply_markup: keyboard }
            );
            autoDelete(ctx.api, ctx.chat.id, welcome.message_id);
            deleteTriggerMessage(ctx);
            return;
        }

        // Delete trigger message (/start payload) to keep chat clean
        try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch (_) { }

        // ─── Concurrency Lock Check ─────────────────────────────────
        const lockoutResult = await User.findOneAndUpdate(
            {
                userId: ctx.from.id,
                $or: [
                    { isDelivering: { $ne: true } },
                    { lastDeliveryAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }
                ]
            },
            {
                $set: {
                    isDelivering: true,
                    lastDeliveryAt: new Date(),
                    lastActive: new Date()
                }
            },
            { returnDocument: 'after' }
        );

        const releaseLock = async () => await User.findOneAndUpdate({ userId: ctx.from.id }, { isDelivering: false });

        if (!lockoutResult) {
            return ctx.reply('⏳ <b>Please wait!</b>\nYour previous request is still processing. Try again in a minute.', {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('❌ Close', 'close_msg')
            });
        }

        // ─── Token Claim: /start token_USERID ───────────────────────
        if (moviePayload.startsWith('token_')) {
            const userId = moviePayload.replace('token_', '');
            if (ctx.from.id.toString() !== userId) {
                const e = await ctx.reply('❌ This pass link belongs to another user.', {
                    reply_markup: new InlineKeyboard().text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg')
                });
                autoDelete(ctx.api, ctx.chat.id, e.message_id);
                await releaseLock();
                return;
            }
            const expiresAt = await grantToken(userId);
            const expireStr = expiresAt.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
            const msg = await ctx.reply(
                `🎫 <b>24-Hour Pass Active!</b>\nValid until ${expireStr}.\nYou have unlimited clip downloads!`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg') }
            );
            autoDelete(ctx.api, ctx.chat.id, msg.message_id);
            await releaseLock();
            await sendToLogChannel(bot, `🎫 <b>Token Granted</b>\nUser: ${getUserNameForLog(ctx.from)} (<code>${ctx.from.id}</code>)`);
            return;
        }

        // ─── Movie Delivery: /start ENCODED_MOVIE ───────────────────
        const decoded = decodeMovieLink(moviePayload);
        let movie = null;
        if (decoded && /^[0-9a-fA-F]{24}$/.test(decoded)) {
            movie = await Movie.findById(decoded);
        }
        if (!movie && decoded) {
            movie = await Movie.findOne({ title: decoded });
        }

        if (!movie || (!movie.messageIds?.length && !movie.files?.length)) {
            const e = await ctx.reply('❌ <b>Clips not found!</b>\nThis movie has been removed or does not exist.', {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg')
            });
            autoDelete(ctx.api, ctx.chat.id, e.message_id);
            await releaseLock();
            return;
        }

        const clipCount = movie.files?.length || movie.messageIds.length;
        const mode = await getSetting('mode', 'off');
        const tutStr = await getSetting('tutorial', null);
        const hasTutorial = Boolean(tutStr);

        // ─── Mode: Token 24h Pass Required ──────────────────────────
        if (mode === 'token') {
            const validToken = await hasValidToken(ctx.from.id);
            if (!validToken) {
                const botUsername = process.env.BOT_USERNAME || ctx.me?.username || '';
                const tokenStartUrl = `https://t.me/${botUsername}?start=token_${ctx.from.id}`;
                const wrappedUrl = await wrapShortlink(tokenStartUrl);

                const keyboard = new InlineKeyboard().url('🟢 Unlock 24h Free Pass »', wrappedUrl).row();
                if (hasTutorial) keyboard.text('💡 Watch Tutorial', 'user_tutorial').row();
                keyboard.text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg');

                const msgContent =
                    `🎫 <b>24-Hour Pass Required</b>\n\n` +
                    `🎬 <b>${escapeHtml(movie.title)}</b> • <code>${clipCount} clips</code>\n\n` +
                    `<i>Get a free pass to download clips for 24 hours:</i>`;

                let msg;
                if (movie.thumbnail) {
                    try {
                        msg = await ctx.replyWithPhoto(movie.thumbnail, {
                            caption: msgContent,
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                    } catch (photoErr) {
                        console.warn('⚠️ Could not send photo with token prompt, falling back to text:', photoErr.message);
                        msg = await ctx.reply(msgContent, { parse_mode: 'HTML', reply_markup: keyboard });
                    }
                } else {
                    msg = await ctx.reply(msgContent, { parse_mode: 'HTML', reply_markup: keyboard });
                }

                autoDelete(ctx.api, ctx.chat.id, msg.message_id);
                await releaseLock();

                await sendToLogChannel(
                    bot,
                    `🎫 <b>24h Pass Shortlink Sent to DM</b>\n\n` +
                    `👤 <b>User:</b> ${escapeHtml(getUserNameForLog(ctx.from))} (<code>${ctx.from.id}</code>)\n` +
                    `🎬 <b>Movie:</b> <i>${escapeHtml(movie.title)}</i>\n` +
                    `🌐 <b>Shortlink:</b> ${wrappedUrl}\n` +
                    `🎯 <b>Target:</b> <code>${tokenStartUrl}</code>`
                );
                return;
            }

            const timeLeft = await getTokenExpiry(ctx.from.id);
            const waitMsg = await ctx.reply(
                `🎫 <b>Pass Active</b> (${timeLeft} left)\n⏳ Preparing your clips for <b>${movie.title}</b>...`,
                { parse_mode: 'HTML' }
            );
            deliverMovie(ctx, bot, movie, waitMsg.message_id).catch(e => console.error('Delivery Error:', e));

        // ─── Mode: Shortlink Ad Verification Required ───────────────
        } else if (mode === 'shortlink' && !isVerified) {
            const botUsername = process.env.BOT_USERNAME || ctx.me?.username || '';
            const verifiedStart = `https://t.me/${botUsername}?start=v_${encodeMovieLink(movie)}`;
            const wrappedUrl = await wrapShortlink(verifiedStart);

            const keyboard = new InlineKeyboard().url('🟢 Verify & Open Clips »', wrappedUrl).row();
            if (hasTutorial) keyboard.text('💡 Watch Tutorial', 'user_tutorial').row();
            keyboard.text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg');

            const msgContent =
                `🔗 <b>Unlock Clips:</b> <code>${escapeHtml(movie.title)}</code> (${clipCount} clips)\n\n` +
                `<i>Verify the link below to get your clips:</i>`;

            let msg;
            if (movie.thumbnail) {
                try {
                    msg = await ctx.replyWithPhoto(movie.thumbnail, {
                        caption: msgContent,
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                } catch (photoErr) {
                    console.warn('⚠️ Could not send photo with shortlink prompt, falling back to text:', photoErr.message);
                    msg = await ctx.reply(msgContent, { parse_mode: 'HTML', reply_markup: keyboard });
                }
            } else {
                msg = await ctx.reply(msgContent, { parse_mode: 'HTML', reply_markup: keyboard });
            }

            autoDelete(ctx.api, ctx.chat.id, msg.message_id);
            await releaseLock();

            await sendToLogChannel(
                bot,
                `🔗 <b>Shortlink Sent to DM</b>\n\n` +
                `👤 <b>User:</b> ${escapeHtml(getUserNameForLog(ctx.from))} (<code>${ctx.from.id}</code>)\n` +
                `🎬 <b>Movie:</b> <i>${escapeHtml(movie.title)}</i>\n` +
                `🌐 <b>Shortlink:</b> ${wrappedUrl}\n` +
                `🎯 <b>Target:</b> <code>${verifiedStart}</code>`
            );
            return;

        // ─── Mode: Free (Direct Dispatch) ───────────────────────────
        } else {
            const waitMsg = await ctx.reply(
                `⏳ <b>Preparing clips:</b> <code>${movie.title}</code> (${clipCount} files)\n<i>Setting up your private room...</i>`,
                { parse_mode: 'HTML' }
            );
            deliverMovie(ctx, bot, movie, waitMsg.message_id).catch(e => console.error('Delivery Error:', e));
        }
    });

    // ────────────────────────────────────────────────────────────────
    // Force Sub "I've Joined" Callback (Instant 0ms Feedback)
    // ────────────────────────────────────────────────────────────────
    bot.callbackQuery(/^fs_(.+)$/, async (ctx) => {
        await ctx.answerCallbackQuery({ text: '⚡ Checking membership...' });

        const encodedMovieParam = ctx.match[1];
        const decoded = decodeMovieLink(encodedMovieParam);
        let movie = null;
        if (decoded && /^[0-9a-fA-F]{24}$/.test(decoded)) {
            movie = await Movie.findById(decoded);
        }
        if (!movie && decoded) {
            movie = await Movie.findOne({ title: decoded });
        }

        if (!movie) {
            return await deleteOldAndSendNew(ctx, ctx.callbackQuery.message.message_id,
                '❌ Link expired. Please search for the movie again in the group.'
            );
        }

        // Verify membership
        const isMember = await checkForceSub(ctx);
        if (!isMember) {
            const forceSubChannel = await getSetting('forceSubChannel', null);
            let joinUrl = forceSubChannel;
            if (forceSubChannel && !forceSubChannel.startsWith('http')) {
                try {
                    const chatInfo = await ctx.api.getChat(forceSubChannel);
                    joinUrl = chatInfo.invite_link || `https://t.me/${forceSubChannel.replace('@', '')}`;
                } catch (_) {
                    joinUrl = `https://t.me/${forceSubChannel.replace('@', '')}`;
                }
            }

            const keyboard = new InlineKeyboard()
                .url('🟣 Join Channel »', joinUrl).row()
                .text('🟢 I\'ve Joined - Send Clips »', `fs_${encodeMovieLink(movie)}`).row()
                .text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg');

            return await deleteOldAndSendNew(ctx, ctx.callbackQuery.message.message_id,
                `📢 <b>You haven't joined yet!</b>\nJoin our channel first, then tap the button below:`,
                { reply_markup: keyboard }
            );
        }

        if (!movie.messageIds?.length && !movie.files?.length) {
            return await deleteOldAndSendNew(ctx, ctx.callbackQuery.message.message_id,
                '❌ Clips are no longer available for this movie.'
            );
        }

        await sendToLogChannel(bot, `✅ <b>Force Sub Verified</b>\nUser: ${getUserNameForLog(ctx.from)} (<code>${ctx.from.id}</code>)\nMovie: <i>${movie.title}</i>`);

        // Delete the force-sub card and send a clean wait message
        const waitMsg = await deleteOldAndSendNew(ctx, ctx.callbackQuery.message.message_id,
            `✅ <b>Verified!</b> Setting up your private room for <b>${movie.title}</b>...`
        );

        deliverMovie(ctx, bot, movie, waitMsg.message_id).catch(e => console.error('Delivery Error:', e));
    });
};

// ────────────────────────────────────────────────────────────────────
// Core Delivery with Automatic Room Sanitization & Single-Use Links
// ────────────────────────────────────────────────────────────────────
async function deliverMovie(ctx, bot, movie, waitMsgId) {
    try {
        // ── 1. Force Subscribe Check ─────────────────────────────────
        const isMember = await checkForceSub(ctx);
        if (!isMember) {
            const forceSubChannel = await getSetting('forceSubChannel', null);
            let joinUrl = forceSubChannel;
            if (forceSubChannel && !forceSubChannel.startsWith('http')) {
                try {
                    const chatInfo = await ctx.api.getChat(forceSubChannel);
                    joinUrl = chatInfo.invite_link || `https://t.me/${forceSubChannel.replace('@', '')}`;
                } catch (_) {
                    joinUrl = `https://t.me/${forceSubChannel.replace('@', '')}`;
                }
            }

            const keyboard = new InlineKeyboard()
                .url('🟣 Join Channel »', joinUrl).row()
                .text('🟢 I\'ve Joined - Send Clips »', `fs_${encodeMovieLink(movie)}`).row()
                .text('🔙 « Back', 'user_home').text('❌ Close', 'close_msg');

            await deleteOldAndSendNew(ctx, waitMsgId,
                `📢 <b>Join our channel to continue:</b>\n` +
                `Join our channel below, then tap the button to receive your clips:`,
                { reply_markup: keyboard }
            );
            await sendToLogChannel(
                bot,
                `📢 <b>Force Sub Triggered in DM</b>\n\n` +
                `👤 <b>User:</b> ${escapeHtml(getUserNameForLog(ctx.from))} (<code>${ctx.from.id}</code>)\n` +
                `🎬 <b>Movie:</b> <i>${escapeHtml(movie.title)}</i>\n` +
                `🔗 <b>Channel Link:</b> ${joinUrl}`
            );
            return;
        }

        // ── 2. Room Assignment from Pool ─────────────────────────────
        const freeRooms = await Room.find({ isBusy: false }).select('_id').lean();
        let room = null;

        if (freeRooms.length > 0) {
            const shuffled = freeRooms.sort(() => Math.random() - 0.5);
            for (const r of shuffled) {
                room = await Room.findOneAndUpdate(
                    { _id: r._id, isBusy: false },
                    { isBusy: true, lastUsed: new Date() },
                    { returnDocument: 'after' }
                );
                if (room) break;
            }
        }

        if (!room) {
            room = await Room.findOneAndUpdate(
                {},
                { isBusy: true, lastUsed: new Date() },
                { sort: { lastUsed: 1 }, returnDocument: 'after' }
            );
        }

        if (!room) {
            const totalRooms = await Room.countDocuments();
            const msg = totalRooms === 0
                ? '❌ The delivery system is not ready yet. Please notify the admin.'
                : '❌ All delivery rooms are currently busy. Please try again in 1 minute.';
            return await deleteOldAndSendNew(ctx, waitMsgId, msg);
        }

        // ── 3. Robust Room Sanitization (Kick user & wipe old messages) ──
        if (room.currentUserId) {
            await safeKickRoomUser(ctx.api, room.roomId, room.currentUserId);
        }
        if (room.lastMessageIds && room.lastMessageIds.length > 0) {
            await safeDeleteRoomMessages(ctx.api, room.roomId, room.lastMessageIds);
        }

        // ── 4. Generate Single-Use Invite Link ─────────────────────────
        const expireDate = Math.floor(Date.now() / 1000) + 2 * 60 * 60; // 2 hours
        const invite = await ctx.api.createChatInviteLink(room.roomId, {
            member_limit: 1,
            expire_date: expireDate,
            name: `Moxi: ${movie.title.substring(0, 20)}`
        });

        // ── 5. Upload/Copy Clips to Room in Media Albums ──────────────
        let newMessageIds = [];
        const files = movie.files && movie.files.length > 0 ? movie.files : null;

        if (files) {
            const visualItems = files.filter(f => ['photo', 'video', 'animation'].includes(f.fileType));
            const otherItems = files.filter(f => !['photo', 'video', 'animation'].includes(f.fileType));

            // Visual media groups (batches of 10)
            for (let i = 0; i < visualItems.length; i += 10) {
                const chunk = visualItems.slice(i, i + 10);
                const mediaGroup = chunk.map((f, idx) => ({
                    type: f.fileType === 'animation' ? 'video' : f.fileType,
                    media: f.fileId,
                    caption: (idx === 0 && f.caption) ? f.caption : undefined
                }));

                try {
                    const sent = await ctx.api.sendMediaGroup(room.roomId, mediaGroup);
                    if (Array.isArray(sent)) newMessageIds.push(...sent.map(m => m.message_id));
                    await sleep(1000);
                } catch (e) {
                    for (const f of chunk) {
                        try {
                            let m;
                            if (f.fileType === 'video') m = await ctx.api.sendVideo(room.roomId, f.fileId, { caption: f.caption || undefined });
                            else if (f.fileType === 'photo') m = await ctx.api.sendPhoto(room.roomId, f.fileId, { caption: f.caption || undefined });
                            else m = await ctx.api.sendAnimation(room.roomId, f.fileId, { caption: f.caption || undefined });
                            if (m) newMessageIds.push(m.message_id);
                            await sleep(350);
                        } catch (_) { }
                    }
                }
            }

            // Document & Audio items
            for (const f of otherItems) {
                try {
                    let m;
                    if (f.fileType === 'document') m = await ctx.api.sendDocument(room.roomId, f.fileId, { caption: f.caption || undefined });
                    else if (f.fileType === 'audio') m = await ctx.api.sendAudio(room.roomId, f.fileId, { caption: f.caption || undefined });
                    if (m) newMessageIds.push(m.message_id);
                    await sleep(350);
                } catch (_) { }
            }
        } else {
            // Legacy path: copy by messageIds
            const dbChannel = process.env.DB_CHANNEL_ID;
            for (let i = 0; i < movie.messageIds.length; i += 10) {
                const chunk = movie.messageIds.slice(i, i + 10);
                try {
                    const copied = await ctx.api.copyMessages(room.roomId, dbChannel, chunk);
                    if (Array.isArray(copied)) newMessageIds.push(...copied.map(c => c.message_id));
                    await sleep(1000);
                } catch (e) {
                    for (const msgId of chunk) {
                        try {
                            const c = await ctx.api.copyMessage(room.roomId, dbChannel, msgId);
                            newMessageIds.push(c.message_id);
                            await sleep(350);
                        } catch (_) { }
                    }
                }
            }
        }

        // ── 5.5. Send Room Promotional Message (Delivery End Signoff) ──
        try {
            const promoStr = await getSetting('roomPromo', null);
            if (promoStr) {
                const promo = JSON.parse(promoStr);
                let promoMsg = null;
                const parseModeOpts = { parse_mode: 'HTML' };

                if (promo.type === 'photo' && promo.fileId) {
                    promoMsg = await ctx.api.sendPhoto(room.roomId, promo.fileId, {
                        caption: promo.caption || undefined,
                        ...parseModeOpts
                    });
                } else if (promo.type === 'video' && promo.fileId) {
                    promoMsg = await ctx.api.sendVideo(room.roomId, promo.fileId, {
                        caption: promo.caption || undefined,
                        ...parseModeOpts
                    });
                } else if (promo.type === 'document' && promo.fileId) {
                    promoMsg = await ctx.api.sendDocument(room.roomId, promo.fileId, {
                        caption: promo.caption || undefined,
                        ...parseModeOpts
                    });
                } else if (promo.type === 'text' && promo.text) {
                    promoMsg = await ctx.api.sendMessage(room.roomId, promo.text, parseModeOpts);
                }

                if (promoMsg) {
                    newMessageIds.push(promoMsg.message_id);
                }
            }
        } catch (e) {
            console.error('Room promo send error:', e.message);
        }

        // ── 6. Save Room State with Message Tracking ─────────────────
        room.currentUserId = ctx.from.id.toString();
        room.lastMessageIds = newMessageIds;
        room.lastUsed = new Date();
        await room.save();

        // ── 7. Auto-Purge Room Immediately When Grace Period Ends ──────
        // Completely wipes messages and kicks occupant so the room is never left dirty!
        setTimeout(async () => {
            try {
                const currentRoom = await Room.findById(room._id);
                if (currentRoom) {
                    if (currentRoom.currentUserId) {
                        await safeKickRoomUser(ctx.api, currentRoom.roomId, currentRoom.currentUserId);
                    }
                    if (currentRoom.lastMessageIds && currentRoom.lastMessageIds.length > 0) {
                        await safeDeleteRoomMessages(ctx.api, currentRoom.roomId, currentRoom.lastMessageIds);
                    }
                    currentRoom.isBusy = false;
                    currentRoom.currentUserId = null;
                    currentRoom.lastMessageIds = [];
                    await currentRoom.save();
                    console.log(`🧹 Room ${currentRoom.roomId} auto-cleaned and reset after 30-min grace period.`);
                }
            } catch (e) {
                console.error('Error auto-cleaning room:', e.message);
            }
        }, 30 * 60 * 1000); // 30 minutes grace period

        // ── 8. "Delete Old ➔ Send New" Delivery Notification ──────────
        const keyboard = new InlineKeyboard()
            .url(`🟢 Open My Clips Room »`, invite.invite_link).row()
            .text('🔙 « Back to Menu', 'user_home').text('❌ Close', 'close_msg');
        const cardText = `📦 <b>${escapeHtml(movie.title)}: ${newMessageIds.length} clips ready!</b>\n` +
            `<i>Single-use download room is open for <b>30 minutes</b>:</i>`;

        const sentCard = await deleteOldAndSendNew(ctx, waitMsgId, cardText, { reply_markup: keyboard });
        autoDelete(ctx.api, ctx.chat.id, sentCard.message_id, ONE_HOUR_MS);

        // Stats tracking
        global.todayStats.deliveries++;
        try {
            await User.findOneAndUpdate(
                { userId: ctx.from.id },
                { $inc: { downloadCount: 1 }, $set: { lastActive: new Date() } }
            );
        } catch (_) { }

        // Log Room Link sent to DM
        await sendToLogChannel(
            bot,
            `📦 <b>Clips Room Link Sent to DM</b>\n\n` +
            `👤 <b>User:</b> ${escapeHtml(getUserNameForLog(ctx.from))} (<code>${ctx.from.id}</code>)\n` +
            `🎬 <b>Movie:</b> <i>${escapeHtml(movie.title)}</i> (${newMessageIds.length} clips)\n` +
            `🚪 <b>Room ID:</b> <code>${room.roomId}</code>\n` +
            `🔗 <b>Invite Link:</b> ${invite.invite_link}`
        );


    } catch (error) {
        console.error('deliverMovie Error:', error);
        await sendToLogChannel(bot, `❌ <b>Delivery Error</b>\nUser: ${getUserNameForLog(ctx.from)}\nError: <code>${error.message}</code>`);
        try {
            await deleteOldAndSendNew(ctx, waitMsgId, '❌ Something went wrong during delivery. Please try again in a moment.');
        } catch (_) { }
    } finally {
        await User.findOneAndUpdate({ userId: ctx.from.id }, { isDelivering: false });
    }
}

