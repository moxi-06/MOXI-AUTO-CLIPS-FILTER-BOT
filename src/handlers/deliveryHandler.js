const { Movie, Room, User } = require('../database');
const { decodeMovieLink, sleep, sendToLogChannel, encodeMovieLink } = require('../utils/helpers');
const { getSetting, wrapShortlink, hasValidToken, grantToken, getTokenExpiry } = require('../utils/monetization');

function getUserNameForLog(user) {
    if (user.username) return `@${user.username}`;
    if (user.first_name) return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
    return `User ${user.id}`;
}

// Auto-delete a bot message after N milliseconds
const autoDelete = async (api, chatId, messageId, ms = 10 * 60 * 1000) => {
    await sleep(ms);
    try { await api.deleteMessage(chatId, messageId); } catch (_) { }
};

// ────────────────────────────────────────────────────────────────────
// Force Subscribe Check
// ────────────────────────────────────────────────────────────────────
async function checkForceSub(ctx) {
    const forceSubChannel = await getSetting('forceSubChannel', null);
    if (!forceSubChannel) return true; // Not configured → pass

    try {
        const member = await ctx.api.getChatMember(forceSubChannel, ctx.from.id);
        const allowed = ['member', 'administrator', 'creator'].includes(member.status);
        return allowed;
    } catch (e) {
        console.error('[ForceSub] Could not check membership:', e.message);
        return true; // Fail open if check errors
    }
}

// ────────────────────────────────────────────────────────────────────
// Main Handler
// ────────────────────────────────────────────────────────────────────
module.exports = (bot) => {
    bot.command('start', async (ctx, next) => {
        if (ctx.chat.type !== 'private') return next();

        // Save user to DB
        await User.findOneAndUpdate(
            { userId: ctx.from.id },
            { $setOnInsert: { userId: ctx.from.id, joinedAt: new Date() } },
            { upsert: true, returnDocument: 'after' }
        );

        const payload = ctx.match;
        let isVerified = false;
        let moviePayload = payload;

        if (payload && payload.startsWith('v_')) {
            isVerified = true;
            moviePayload = payload.substring(2);
        }

        // ─── No Payload → Welcome ───────────────────────────────────
        if (!moviePayload) {
            const welcome = await ctx.reply(
                `👋 <b>WELCOME TO MOXI FILTERS!</b>\n\n` +
                `I am your <b>Clips Assistant Bot</b> 🤖\n\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `🎬 <b>HOW TO GET CLIPS:</b>\n\n` +
                `1️⃣ <b>Join our Group</b>\n` +
                `   👉 ${process.env.GROUP_LINK ? `<a href="${process.env.GROUP_LINK}">Join Now! 🌟</a>` : '<b>Search in our group</b>'}\n\n` +
                `2️⃣ <b>Type Movie Name</b>\n` +
                `   <i>Example: Leo or Jawan</i>\n\n` +
                `3️⃣ <b>Get Your Files</b>\n` +
                `   I will deliver everything to your PM! 📬\n\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `💡 <b>QUICK TIPS:</b>\n` +
                `• Type <code>/filters</code> to see all movies\n` +
                `• Spelling doesn't matter, I'll fix it! ✨\n` +
                `• Ask admin if clips are missing!\n\n` +
                `🎉 <b>Enjoy Editing!</b> 🍿`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
            autoDelete(ctx.api, ctx.chat.id, welcome.message_id);
            return;
        }

        // ─── Atomize Lock Check & Set ──────────────────────────────
        const lockoutResult = await User.findOneAndUpdate(
            {
                userId: ctx.from.id,
                $or: [
                    { isDelivering: { $ne: true } }, // Match false or missing field
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
            // Already delivering (lock active)
            return ctx.reply('⏳ <b>Please wait!</b>\n\nI am still preparing your previous request. Please wait a minute before starting a new one! ⏱️', { parse_mode: 'HTML' });
        }

        // ─── Token Claim: /start token_USERID ───────────────────────
        if (moviePayload.startsWith('token_')) {
            const userId = moviePayload.replace('token_', '');
            if (ctx.from.id.toString() !== userId) {
                const e = await ctx.reply('❌ This token link belongs to another user.');
                autoDelete(ctx.api, ctx.chat.id, e.message_id);
                await releaseLock();
                return;
            }
            const expiresAt = await grantToken(userId);
            const expireStr = expiresAt.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
            const msg = await ctx.reply(
                `🎫 <b>24-HOUR PASS ACTIVATED</b> 🎫\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `✅ <b>Status:</b> You're in!\n` +
                `⏰ <b>Valid until:</b> Today at ${expireStr}\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `<i>You can now get clips from the group. Enjoy! 🎬</i>`,
                { parse_mode: 'HTML' }
            );
            autoDelete(ctx.api, ctx.chat.id, msg.message_id);
            await releaseLock();
            await sendToLogChannel(bot, `🎫 *Token Granted*\nUser: ${getUserNameForLog(ctx.from)} (\`${ctx.from.id}\`)`);
            return;
        }

        // ─── Movie Delivery: /start ENCODED_MOVIE ───────────────────
        const movieName = decodeMovieLink(moviePayload);
        if (!movieName) {
            const e = await ctx.reply('❌ <b>Link Expired!</b>\n\nThis link is old. Please search again in our group! 👆');
            autoDelete(ctx.api, ctx.chat.id, e.message_id);
            await releaseLock();
            return;
        }

        const movie = await Movie.findOne({ title: movieName });
        if (!movie || (!movie.messageIds?.length && !movie.files?.length)) {
            const e = await ctx.reply('❌ <b>Clips Not Available!</b>\n\nThis content is removed. Please ask admin to add it! 😢');
            autoDelete(ctx.api, ctx.chat.id, e.message_id);
            await releaseLock();
            return;
        }

        // ─── Check Monetization Mode ─────────────────────────────────
        const mode = await getSetting('mode', 'off');

        if (mode === 'token') {
            const validToken = await hasValidToken(ctx.from.id);
            if (!validToken) {
                const botUsername = process.env.BOT_USERNAME || ctx.me?.username || '';
                const tokenStartUrl = `https://t.me/${botUsername}?start=token_${ctx.from.id}`;
                const wrappedUrl = await wrapShortlink(tokenStartUrl);
                const msg = await ctx.reply(
                    `🎫 <b>GET ACCESS PASS</b>\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                    `You need a <b>24-Hour Pass</b> to edit clips! 🎫\n\n` +
                    `📝 <b>Easy Steps:</b>\n` +
                    `1️⃣ Click the button below\n` +
                    `2️⃣ Get your pass (it's free!)\n` +
                    `3️⃣ Come back here to edit!\n\n` +
                    `⏱️ <b>Time:</b> Only 30 seconds!\n\n` +
                    `❤️ <i>Your support keeps us alive!</i>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: '🎫 Get Pass & Edit Clips', url: wrappedUrl }]] }
                    }
                );
                autoDelete(ctx.api, ctx.chat.id, msg.message_id);
                await releaseLock();
                await sendToLogChannel(bot, `🔒 *Token Required*\nUser: ${getUserNameForLog(ctx.from)} (\`${ctx.from.id}\`)\nMovie: _${movie.title}_`);
                return;
            }
            const timeLeft = await getTokenExpiry(ctx.from.id);
            const waitMsg = await ctx.reply(
                `🎫 <b>Pass Active</b> — ${timeLeft} left\n\n⏳ Getting your clips...`,
                { parse_mode: 'HTML' }
            );
            autoDelete(ctx.api, ctx.chat.id, waitMsg.message_id);
            deliverMovie(ctx, bot, movie, waitMsg.message_id).catch(e => console.error('Delivery Error:', e));

        } else if (mode === 'shortlink' && !isVerified) {
            const botUsername = process.env.BOT_USERNAME || ctx.me?.username || '';
            const verifiedStart = `https://t.me/${botUsername}?start=v_${moviePayload}`;
            const wrapMsg = await ctx.reply(
                `🔗 <b>Preparing your link...</b>\n\n📽️ Movie: <b>${movie.title}</b>\n🎬 Clips: ${movie.files?.length || movie.messageIds.length}`,
                { parse_mode: 'HTML' }
            );
            const wrappedUrl = await wrapShortlink(verifiedStart);
            await ctx.api.editMessageText(
                ctx.chat.id, wrapMsg.message_id,
                `🎬 <b>${movie.title}</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `📂 <b>${movie.files?.length || movie.messageIds.length} Clips</b> are ready for you!\n\n` +
                `🚀 <b>TAP THE BUTTON BELOW</b> to start!\n\n` +
                `🔗 <i>Link opens your private movie room</i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '▶️ Get My Clips Now', url: wrappedUrl }]] }
                }
            );
            autoDelete(ctx.api, ctx.chat.id, wrapMsg.message_id);
            await releaseLock();
            await sendToLogChannel(bot, `🔗 <b>Shortlink Sent</b>\nUser: ${getUserNameForLog(ctx.from)} (<code>${ctx.from.id}</code>)\nMovie: <i>${movie.title}</i>\n\n#shortlink 📎`);
            return;
        } else {
            const waitMsg = await ctx.reply(
                `⏳ <b>Preparing your movies...</b>\n\n📽️ <b>${movie.title}</b>\n📂 ${movie.messageIds.length} clips\n\nPlease wait... ⏱️`,
                { parse_mode: 'HTML' }
            );
            autoDelete(ctx.api, ctx.chat.id, waitMsg.message_id);
            deliverMovie(ctx, bot, movie, waitMsg.message_id).catch(e => console.error('Delivery Error:', e));
        }
    });
};

// ────────────────────────────────────────────────────────────────────
// Core Delivery — Force Sub check happens HERE (after monetization)
// ────────────────────────────────────────────────────────────────────
async function deliverMovie(ctx, bot, movie, waitMsgId) {
    const { Room } = require('../database');
    const { sendToLogChannel } = require('../utils/helpers');
    const { getSetting } = require('../utils/monetization');

    try {
        // ── Force Subscribe Check ────────────────────────────────────
        const isMember = await checkForceSub(ctx);
        if (!isMember) {
            const forceSubChannel = await getSetting('forceSubChannel', null);
            let joinUrl = forceSubChannel;
            // If it's a username, make an invite link
            if (forceSubChannel && !forceSubChannel.startsWith('http')) {
                try {
                    const chatInfo = await ctx.api.getChat(forceSubChannel);
                    joinUrl = chatInfo.invite_link || `https://t.me/${forceSubChannel.replace('@', '')}`;
                } catch (_) {
                    joinUrl = `https://t.me/${forceSubChannel.replace('@', '')}`;
                }
            }

            await ctx.api.editMessageText(
                ctx.chat.id, waitMsgId,
                `📢 <b>One Last Step!</b>\n\n` +
                `To receive your clips, you need to be a member of our main channel.\n\n` +
                `<b>Why?</b> It keeps our community together and helps us keep this service free! 🙏\n\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `1️⃣ Join the channel below\n` +
                `2️⃣ Come back and search again — clips will be delivered instantly!`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '📢 Join Channel  →', url: joinUrl }]]
                    }
                }
            );
            await sendToLogChannel(bot, `📢 *Force Sub Triggered*\nUser: ${getUserNameForLog(ctx.from)} (\`${ctx.from.id}\`)\nMovie: _${movie.title}_`);
            return;
        }

        // ── Assign Room ──────────────────────────────────────────────
        let room = await Room.findOneAndUpdate(
            { isBusy: false },
            { isBusy: true },
            { returnDocument: 'after' }
        );

        if (!room) {
            room = await Room.findOneAndUpdate(
                {},
                { isBusy: true },
                { sort: { lastUsed: 1 }, returnDocument: 'after' }
            );
        }

        if (!room) {
            const totalRooms = await Room.countDocuments();
            const msg = totalRooms === 0
                ? '❌ The delivery system is not ready yet. Please notify the admin.'
                : '❌ All delivery rooms are busy right now. Please try again in a moment.';
            if (totalRooms === 0) {
                await sendToLogChannel(bot, `🔴 *System Uninitialized* — User \`${ctx.from.id}\` tried delivery but 0 rooms exist.`);
            } else {
                await sendToLogChannel(bot, `🔴 *Room Exhaustion* — User \`${ctx.from.id}\` requested _${movie.title}_.`);
            }
            return ctx.api.editMessageText(ctx.chat.id, waitMsgId, msg);
        }

        // ── Clean Room ──
        if (room.currentUserId) {
            try {
                await ctx.api.banChatMember(room.roomId, room.currentUserId);
                await sleep(500);
                await ctx.api.unbanChatMember(room.roomId, room.currentUserId);
                await sleep(300);
            } catch (e) {
                if (!e.message.includes('can\'t remove chat owner') && !e.message.includes('not enough rights')) {
                    console.error(`Kick failed for ${room.currentUserId}:`, e.message);
                }
            }
        }

        if (room.lastMessageIds?.length > 0) {
            for (let i = 0; i < room.lastMessageIds.length; i += 100) {
                try {
                    await ctx.api.deleteMessages(room.roomId, room.lastMessageIds.slice(i, i + 100));
                    await sleep(300);
                } catch (_) { }
            }
        }

        // ── Send Clips as Albums (batches of 10) ──────────────────────
        let newMessageIds = [];

        await ctx.api.editMessageText(
            ctx.chat.id, waitMsgId,
            `📤 <b>Delivering clips...</b>\n\n🎬 <i>${movie.title}</i>\n📂 ${movie.files?.length || movie.messageIds.length} clips\n\n<i>Please don't close this chat.</i>`,
            { parse_mode: 'HTML' }
        );

        const files = movie.files && movie.files.length > 0 ? movie.files : null;

        if (files) {
            // ── New path: group by strict type to avoid Telegram errors ──
            const groups = {};
            files.forEach(f => {
                let g = f.fileType;
                // Photos, Videos, and Animations can coexist in a visual album
                if (g === 'photo' || g === 'video' || g === 'animation') g = 'visual';
                if (!groups[g]) groups[g] = [];
                groups[g].push(f);
            });

            const sendBatch = async (items) => {
                for (let i = 0; i < items.length; i += 10) {
                    const chunk = items.slice(i, i + 10);
                    const mediaGroup = chunk.map((f, idx) => {
                        // In albums, 'animation' must be sent as 'video'
                        let type = f.fileType;
                        if (type === 'animation') type = 'video';

                        const base = { type: type, media: f.fileId };
                        if (idx === 0 && f.caption) base.caption = f.caption;
                        return base;
                    });
                    try {
                        const sent = await ctx.api.sendMediaGroup(room.roomId, mediaGroup);
                        if (Array.isArray(sent)) newMessageIds.push(...sent.map(m => m.message_id));
                        await sleep(1500);
                    } catch (e) {
                        console.error(`[mediaBatch] sendMediaGroup failed:`, e.message);
                        for (const f of chunk) {
                            try {
                                let m;
                                if (f.fileType === 'video') m = await ctx.api.sendVideo(room.roomId, f.fileId, { caption: f.caption || undefined });
                                else if (f.fileType === 'photo') m = await ctx.api.sendPhoto(room.roomId, f.fileId, { caption: f.caption || undefined });
                                else if (f.fileType === 'document') m = await ctx.api.sendDocument(room.roomId, f.fileId, { caption: f.caption || undefined });
                                else if (f.fileType === 'audio') m = await ctx.api.sendAudio(room.roomId, f.fileId, { caption: f.caption || undefined });
                                else if (f.fileType === 'animation') m = await ctx.api.sendAnimation(room.roomId, f.fileId, { caption: f.caption || undefined });
                                if (m) newMessageIds.push(m.message_id);
                                await sleep(500);
                            } catch (_) { }
                        }
                    }
                }
            };

            for (const type of Object.keys(groups)) {
                await sendBatch(groups[type]);
            }
        } else {
            // ── Legacy path: copyMessages using stored messageIds ──
            const dbChannel = process.env.DB_CHANNEL_ID;
            for (let i = 0; i < movie.messageIds.length; i += 10) {
                const chunk = movie.messageIds.slice(i, i + 10);
                try {
                    const copied = await ctx.api.copyMessages(room.roomId, dbChannel, chunk);
                    if (Array.isArray(copied)) newMessageIds.push(...copied.map(c => c.message_id));
                    await sleep(1200);
                } catch (e) {
                    for (const msgId of chunk) {
                        try {
                            const c = await ctx.api.copyMessage(room.roomId, dbChannel, msgId);
                            newMessageIds.push(c.message_id);
                            await sleep(400);
                        } catch (_) { }
                    }
                }
            }
        }

        // ── Create Invite Link (2hr, 1 member) ──────────────────────
        const expireDate = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
        const invite = await ctx.api.createChatInviteLink(room.roomId, {
            member_limit: 1,
            expire_date: expireDate,
            name: `Delivery: ${movie.title.substring(0, 20)}`
        });

        // ── Save Room State ──────────────────────────────────────────
        room.currentUserId = ctx.from.id.toString();
        room.lastMessageIds = newMessageIds;
        room.lastUsed = new Date();
        room.isBusy = false;
        await room.save();

        // ── Send Delivery Card ───────────────────────────────────────
        await ctx.api.editMessageText(
            ctx.chat.id, waitMsgId,
            `✅ <b>COMPLETELY READY!</b>\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `🎬 <b>Movie:</b> <code>${movie.title}</code>\n` +
            `📂 <b>Clips:</b> ${movie.messageIds.length} Files\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `⚠️ <b>Note:</b>\n` +
            `• Access expires in <b>2 hours</b>\n` +
            `• One-time entry only\n\n` +
            `🚀 <i>Tap below to enter your room!</i>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '🚪 Get My Clips  →', url: invite.invite_link }]]
                }
            }
        );

        // Auto-delete delivery message after 10 minutes (keeps PM clean)
        setTimeout(async () => {
            try { await ctx.api.deleteMessage(ctx.chat.id, waitMsgId); } catch (_) { }
        }, 10 * 60 * 1000);

        // Track delivery stats
        global.todayStats.deliveries++;

        // Update user download count and check badge
        try {
            const user = await User.findOneAndUpdate(
                { userId: ctx.from.id },
                { $inc: { downloadCount: 1 }, $set: { lastActive: new Date() } },
                { upsert: true, returnDocument: 'after' }
            );

            // Check if user earned a new badge (video editing themed)
            let newBadge = null;
            if (user.downloadCount >= 3 && !user.badges.includes('✂️ Pro Cutter')) {
                newBadge = '✂️ Pro Cutter';
                user.badges.push(newBadge);
                await user.save();
            } else if (user.downloadCount >= 10 && !user.badges.includes('💎 Diamond Editor')) {
                newBadge = '💎 Diamond Editor';
                user.badges.push(newBadge);
                await user.save();
            } else if (user.downloadCount >= 20 && !user.badges.includes('👑 Editor King 👑')) {
                newBadge = '👑 Editor King 👑';
                user.badges.push(newBadge);
                await user.save();
            }

            // Notify user of new badge
            if (newBadge) {
                try {
                    await ctx.api.sendMessage(
                        ctx.from.id,
                        `🎉 <b>Congratulations!</b>\n\nYou earned a new badge: <b>${newBadge}</b>\n\nKeep using the bot to unlock more!`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) { }
            }
        } catch (e) {
            console.error('User badge error:', e);
        }

        await sendToLogChannel(bot, `✅ <b>DELIVERY SUCCESS</b>\nUser: ${getUserNameForLog(ctx.from)} (<code>${ctx.from.id}</code>)\nMovie: <i>${movie.title}</i>\nRoom: <code>${room.roomId}</code>\nClips: ${newMessageIds.length}\n\n#delivery 🚪`);

    } catch (error) {
        console.error('deliverMovie Error:', error);
        await sendToLogChannel(bot, `❌ *Delivery Error*\nUser: ${ctx.from ? getUserNameForLog(ctx.from) : 'Unknown'} (\`${ctx.from?.id || 'N/A'}\`)\nError: _${error.message}_`);
        try {
            await ctx.api.editMessageText(ctx.chat.id, waitMsgId,
                '❌ Something went wrong during delivery.\n\nPlease try again in a moment.'
            );
        } catch (_) { }
    } finally {
        await User.findOneAndUpdate({ userId: ctx.from.id }, { isDelivering: false });
    }
}
