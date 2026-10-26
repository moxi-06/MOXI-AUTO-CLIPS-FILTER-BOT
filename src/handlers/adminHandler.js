const { Movie, Room, User, Token, BotSettings } = require('../database');
const { cleanMovieName, sleep, sendToLogChannel, safeDeleteRoomMessages, safeKickRoomUser } = require('../utils/helpers');
const { getSetting, setSetting } = require('../utils/monetization');
const { InlineKeyboard } = require('grammy');

global.MAINTENANCE = false;
global.LOGS = [];
global.broadcastStats = { total: 0, blocked: 0, failed: 0 };
global.adminState = {}; // { [adminId]: { action: 'awaiting_tutorial' | 'awaiting_forcesub' | 'awaiting_room' } }
global.pendingBroadcast = {};

const logError = (err) => {
    const errorMsg = err.message || err.toString();
    global.LOGS.push(`[${new Date().toISOString()}] ${errorMsg}`);
    if (global.LOGS.length > 20) global.LOGS.shift();
};

const isAdmin = (ctx) => {
    const adminId = process.env.ADMIN_ID;
    return Boolean(adminId && ctx.from && ctx.from.id.toString() === adminId);
};

// List of admin-only commands to hide from normal users
const adminCommands = [
    'admin', 'addmovie', 'deletemovie', 'addcategory', 'stats', 'top',
    'addroom', 'rooms', 'cleanroom', 'broadcast', 'maintenance',
    'logs', 'restartrooms', 'settings', 'setmode', 'setshortlink',
    'setapikey', 'setforcesub', 'unsetforcesub', 'resetbot', 'unlock', 'resetstats'
];

// Helper to build the main Admin Control Console
async function renderAdminPanel(ctx, isEdit = false) {
    const mode = await getSetting('mode', 'off');
    const modeLabels = { off: '🟢 Free', shortlink: '🔗 Shortlink', token: '🎫 24h Pass' };
    const forceSubChannel = await getSetting('forceSubChannel', null);
    const tutStr = await getSetting('tutorial', null);

    let tutorialDisplay = 'None ❌';
    if (tutStr) {
        try {
            const parsed = JSON.parse(tutStr);
            tutorialDisplay = parsed.type === 'link' ? 'Web Link 🔗' : `${parsed.type.toUpperCase()} 🎥`;
        } catch (_) { tutorialDisplay = 'Active ✅'; }
    }

    const rooms = await Room.find();
    const freeRooms = rooms.filter(r => !r.isBusy).length;
    const busyRooms = rooms.filter(r => r.isBusy).length;
    const maintenance = Boolean(global.MAINTENANCE);

    const text = `⚙️ <b>ADMIN CONTROL CONSOLE</b>\n` +
        `• <b>Mode:</b> ${modeLabels[mode] || mode}\n` +
        `• <b>Force Sub:</b> <code>${forceSubChannel || 'Disabled'}</code>\n` +
        `• <b>Tutorial Video:</b> <code>${tutorialDisplay}</code>\n` +
        `• <b>Rooms:</b> <code>${freeRooms} Free / ${busyRooms} Busy (${rooms.length} Total)</code>\n` +
        `• <b>Maintenance:</b> ${maintenance ? '<b>ON ⚠️</b>' : '<b>OFF ✅</b>'}\n\n` +
        `<i>Tap any module below to configure:</i>`;

    const keyboard = new InlineKeyboard()
        .text('⚙️ Mode Switcher', 'admin_mode_menu')
        .text('🎥 Tutorial Video', 'admin_tut_menu').row()
        .text('📢 Force Sub', 'admin_forcesub_menu')
        .text('🏠 Room Manager', 'admin_rooms_menu').row()
        .text('📊 Live Analytics', 'admin_stats_view')
        .text('📡 Broadcast', 'admin_bc_prompt').row()
        .text(`🔒 Maintenance: ${maintenance ? 'ON' : 'OFF'}`, 'admin_maint_toggle')
        .text('🔄 Refresh Panel', 'admin_panel');

    if (isEdit) {
        try {
            return await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) { }
    }
    return await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

module.exports = (bot) => {
    // Hide admin commands from non-admin users
    bot.use(async (ctx, next) => {
        const cmd = ctx.message?.text?.split(' ')[0]?.replace('/', '').toLowerCase();
        if (cmd && adminCommands.includes(cmd) && !isAdmin(ctx)) {
            return;
        }
        await next();
    });

    // Top-level middleware to catch maintenance mode
    bot.use(async (ctx, next) => {
        try {
            if (global.MAINTENANCE && !isAdmin(ctx) && ctx.chat?.type === 'private') {
                return ctx.reply('⚠️ <b>Bot is under maintenance.</b> Please try again shortly.', { parse_mode: 'HTML' });
            }
            await next();
        } catch (error) {
            logError(error);
            console.error('Bot Pipeline Error:', error);
        }
    });
    // ────────────────────────────────────────────────────────────────
    // Interactive Admin Input Listener (Tutorial, ForceSub, Room ID)
    // ────────────────────────────────────────────────────────────────
    bot.on(['message:text', 'message:video', 'message:document'], async (ctx, next) => {
        if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return next();

        const state = global.adminState[ctx.from.id];
        if (!state) return next();

        // 1. Awaiting Tutorial Video/File/Link
        if (state.action === 'awaiting_tutorial') {
            let tutorialData = null;
            if (ctx.message.video) {
                tutorialData = { type: 'video', fileId: ctx.message.video.file_id };
            } else if (ctx.message.document) {
                tutorialData = { type: 'document', fileId: ctx.message.document.file_id };
            } else if (ctx.message.text) {
                if (ctx.message.text === '/cancel' || ctx.message.text.toLowerCase() === 'cancel') {
                    delete global.adminState[ctx.from.id];
                    return ctx.reply('❌ Tutorial update cancelled.', {
                        reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                    });
                }
                tutorialData = { type: 'link', text: ctx.message.text.trim() };
            }

            if (tutorialData) {
                delete global.adminState[ctx.from.id];
                await setSetting('tutorial', JSON.stringify(tutorialData));
                return ctx.reply('✅ <b>Tutorial Video Updated Successfully!</b>', {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('⚙️ Return to Admin Console', 'admin_panel')
                });
            }
        }

        // 2. Awaiting Force Sub Channel ID or @username
        if (state.action === 'awaiting_forcesub') {
            const input = ctx.message.text?.trim();
            if (input === '/cancel' || input?.toLowerCase() === 'cancel') {
                delete global.adminState[ctx.from.id];
                return ctx.reply('❌ Force sub update cancelled.', {
                    reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                });
            }
            delete global.adminState[ctx.from.id];
            await setSetting('forceSubChannel', input);
            return ctx.reply(`✅ <b>Force Subscribe channel set to:</b> <code>${input}</code>`, {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('⚙️ Return to Admin Console', 'admin_panel')
            });
        }

        // 3. Awaiting Room ID to add
        if (state.action === 'awaiting_room') {
            const input = ctx.message.text?.trim();
            if (input === '/cancel' || input?.toLowerCase() === 'cancel') {
                delete global.adminState[ctx.from.id];
                return ctx.reply('❌ Room registration cancelled.', {
                    reply_markup: new InlineKeyboard().text('🏠 Rooms Menu', 'admin_rooms_menu')
                });
            }
            delete global.adminState[ctx.from.id];
            await Room.findOneAndUpdate({ roomId: input }, { isBusy: false, lastUsed: new Date() }, { upsert: true });
            return ctx.reply(`✅ <b>Room <code>${input}</code> registered in pool!</b>`, {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('🏠 Room Manager', 'admin_rooms_menu').text('⚙️ Console', 'admin_panel')
            });
        }

        await next();
    });

    // ────────────────────────────────────────────────────────────────
    // Interactive Admin Control Panel Commands & Callbacks
    // ────────────────────────────────────────────────────────────────

    // /admin Command
    bot.command('admin', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await renderAdminPanel(ctx, false);
    });

    // Main Console Callback
    bot.callbackQuery('admin_panel', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
        await ctx.answerCallbackQuery();
        await renderAdminPanel(ctx, true);
    });

    // ── Mode Switcher Menu ──────────────────────────────────────────
    bot.callbackQuery('admin_mode_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        const current = await getSetting('mode', 'off');

        const keyboard = new InlineKeyboard()
            .text(`${current === 'off' ? '🟢 Free (Active)' : 'Free Mode'}`, 'setmode_off').row()
            .text(`${current === 'shortlink' ? '🔗 Shortlink (Active)' : 'Shortlink Mode'}`, 'setmode_shortlink').row()
            .text(`${current === 'token' ? '🎫 24h Pass (Active)' : '24h Token Pass Mode'}`, 'setmode_token').row()
            .text('🔙 Back to Console', 'admin_panel');

        await ctx.editMessageText(
            `⚙️ <b>Select Monetization Mode:</b>\n\n` +
            `• <b>Free:</b> Instant rooms with no ads.\n` +
            `• <b>Shortlink:</b> Shortens direct verify link per request.\n` +
            `• <b>24h Token Pass:</b> Users solve 1 link for 24h access.`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery(/^setmode_(off|shortlink|token)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const newMode = ctx.match[1];
        await setSetting('mode', newMode);
        await ctx.answerCallbackQuery({ text: `✅ Switched to ${newMode.toUpperCase()}!` });
        await renderAdminPanel(ctx, true);
    });

    // ── Tutorial Video Menu ─────────────────────────────────────────
    bot.callbackQuery('admin_tut_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        const tutStr = await getSetting('tutorial', null);

        let statusText = '❌ No tutorial active.';
        if (tutStr) {
            try {
                const parsed = JSON.parse(tutStr);
                statusText = parsed.type === 'link' ? `🔗 Link: ${parsed.text}` : `🎥 Attached ${parsed.type.toUpperCase()}`;
            } catch (_) { statusText = 'Active ✅'; }
        }

        const keyboard = new InlineKeyboard()
            .text('✏️ Change Video / Link', 'admin_tut_change').row()
            .text('❌ Disable Tutorial', 'admin_tut_off').row()
            .text('🔙 Back to Console', 'admin_panel');

        await ctx.editMessageText(
            `🎥 <b>Tutorial Video Manager</b>\n\n` +
            `<b>Status:</b> ${statusText}\n\n` +
            `<i>Users will see a "Watch Tutorial" button in shortlink mode.</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('admin_tut_change', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        global.adminState[ctx.from.id] = { action: 'awaiting_tutorial' };

        const keyboard = new InlineKeyboard().text('❌ Cancel', 'admin_cancel_input');
        await ctx.editMessageText(
            `🎥 <b>SEND TUTORIAL VIDEO NOW:</b>\n\n` +
            `• Forward or upload any video or document\n` +
            `• Or paste a YouTube / Web video link\n\n` +
            `<i>Send it below:</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('admin_tut_off', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await setSetting('tutorial', null);
        await ctx.answerCallbackQuery({ text: '✅ Tutorial disabled.' });
        await renderAdminPanel(ctx, true);
    });

    // ── Force Sub Menu ──────────────────────────────────────────────
    bot.callbackQuery('admin_forcesub_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        const current = await getSetting('forceSubChannel', null);

        const keyboard = new InlineKeyboard()
            .text('✏️ Set / Change Channel', 'admin_forcesub_change').row()
            .text('❌ Turn Off Force Sub', 'admin_forcesub_off').row()
            .text('🔙 Back to Console', 'admin_panel');

        await ctx.editMessageText(
            `📢 <b>Force Subscribe Channel</b>\n\n` +
            `<b>Current:</b> <code>${current || 'Disabled'}</code>\n\n` +
            `<i>When active, users must join this channel before receiving clips.</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('admin_forcesub_change', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        global.adminState[ctx.from.id] = { action: 'awaiting_forcesub' };

        const keyboard = new InlineKeyboard().text('❌ Cancel', 'admin_cancel_input');
        await ctx.editMessageText(
            `📢 <b>Send Channel ID or Username:</b>\n\n` +
            `• Public Channel: <code>@channelname</code>\n` +
            `• Private Channel: <code>-100XXXXXXXXXX</code>\n\n` +
            `<i>Make sure the bot is an admin in that channel!</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('admin_forcesub_off', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await setSetting('forceSubChannel', null);
        await ctx.answerCallbackQuery({ text: '✅ Force Sub turned off.' });
        await renderAdminPanel(ctx, true);
    });

    // ── Room Pool Manager Menu ──────────────────────────────────────
    bot.callbackQuery('admin_rooms_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        const rooms = await Room.find();

        let roomList = '';
        rooms.forEach((r, idx) => {
            roomList += `${idx + 1}. <code>${r.roomId}</code> • ${r.isBusy ? '🔴 Busy' : '🟢 Free'}\n`;
        });
        if (!roomList) roomList = 'No rooms registered yet.\n';

        const keyboard = new InlineKeyboard()
            .text('🧹 Clean & Free All Rooms Now', 'admin_clean_all_rooms').row()
            .text('➕ Add New Room', 'admin_add_room').row()
            .text('🔙 Back to Console', 'admin_panel');

        await ctx.editMessageText(
            `🏠 <b>Room Pool Manager (${rooms.length} Total)</b>\n\n${roomList}\n` +
            `<i>Clean all rooms will kick occupants and delete leftover clips.</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Clean & Free All Rooms Action (Permanent bug fix for room cleanup)
    bot.callbackQuery('admin_clean_all_rooms', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery({ text: '🧹 Cleaning all rooms...' });

        const rooms = await Room.find();
        let cleanedCount = 0;

        for (const room of rooms) {
            if (room.currentUserId) {
                await safeKickRoomUser(ctx.api, room.roomId, room.currentUserId);
            }
            if (room.lastMessageIds && room.lastMessageIds.length > 0) {
                await safeDeleteRoomMessages(ctx.api, room.roomId, room.lastMessageIds);
            }
            room.isBusy = false;
            room.currentUserId = null;
            room.lastMessageIds = [];
            await room.save();
            cleanedCount++;
        }

        await ctx.answerCallbackQuery({ text: `✅ Cleaned and freed ${cleanedCount} rooms!`, show_alert: true });
        await renderAdminPanel(ctx, true);
    });

    bot.callbackQuery('admin_add_room', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        global.adminState[ctx.from.id] = { action: 'awaiting_room' };

        const keyboard = new InlineKeyboard().text('❌ Cancel', 'admin_cancel_input');
        await ctx.editMessageText(
            `🏠 <b>Add Room Channel:</b>\n\n` +
            `Send the Telegram Channel ID (e.g. <code>-1002357848749</code>).\n\n` +
            `<i>Make sure the bot is an admin with Invite & Delete rights!</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Cancel Active Input
    bot.callbackQuery('admin_cancel_input', async (ctx) => {
        if (!isAdmin(ctx)) return;
        delete global.adminState[ctx.from.id];
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        await renderAdminPanel(ctx, true);
    });

    // ── Maintenance Mode Toggle ─────────────────────────────────────
    bot.callbackQuery('admin_maint_toggle', async (ctx) => {
        if (!isAdmin(ctx)) return;
        global.MAINTENANCE = !global.MAINTENANCE;
        await ctx.answerCallbackQuery({ text: `Maintenance: ${global.MAINTENANCE ? 'ENABLED ⚠️' : 'DISABLED ✅'}` });
        await renderAdminPanel(ctx, true);
    });

    // ── Live Analytics View ─────────────────────────────────────────
    bot.callbackQuery('admin_stats_view', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();

        const totalMovies = await Movie.countDocuments();
        const totalUsers = await User.countDocuments();
        const moviesWithClips = await Movie.find({}, { messageIds: 1, files: 1 });
        const totalClips = moviesWithClips.reduce((sum, m) => sum + (m.files?.length || m.messageIds?.length || 0), 0);

        const todaySearches = global.todayStats?.searches || 0;
        const todayDeliveries = global.todayStats?.deliveries || 0;

        const keyboard = new InlineKeyboard()
            .text('🔄 Refresh', 'admin_stats_view')
            .text('🔙 Back', 'admin_panel');

        const text = `📊 <b>LIVE METRICS</b>\n\n` +
            `• Movies: <b>${totalMovies}</b>\n` +
            `• Total Clips: <b>${totalClips}</b>\n` +
            `• Registered Users: <b>${totalUsers}</b>\n\n` +
            `📅 <b>Today's Activity:</b>\n` +
            `• Searches: <b>${todaySearches}</b>\n` +
            `• Deliveries: <b>${todayDeliveries}</b>`;

        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (_) { }
    });

    // ── Broadcast Manager Prompt ────────────────────────────────────
    bot.callbackQuery('admin_bc_prompt', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        const keyboard = new InlineKeyboard().text('🔙 Back to Console', 'admin_panel');
        await ctx.editMessageText(
            `📡 <b>Broadcast to All Users</b>\n\n` +
            `To send a broadcast:\n` +
            `1. Reply to any message/media with <code>/broadcast</code>\n` +
            `2. Or type: <code>/broadcast your text here</code>\n\n` +
            `<i>A confirmation preview will show before sending!</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });


    // Broadcast Command
    bot.command('broadcast', async (ctx) => {
        if (!isAdmin(ctx)) return;

        let msgToBroadcast = null;
        if (ctx.message.reply_to_message) {
            msgToBroadcast = {
                type: 'copy',
                fromChatId: ctx.chat.id,
                messageId: ctx.message.reply_to_message.message_id
            };
        } else if (ctx.match) {
            msgToBroadcast = { type: 'text', text: ctx.match };
        } else {
            return ctx.reply('❌ Usage: <code>/broadcast [text]</code> or reply to a message with <code>/broadcast</code>', { parse_mode: 'HTML' });
        }

        const users = await User.find();
        const keyboard = new InlineKeyboard()
            .text('✅ Send Now', `bc_yes_${ctx.from.id}`)
            .text('❌ Cancel', `bc_no_${ctx.from.id}`);

        await ctx.reply(
            `📡 <b>BROADCAST PREVIEW</b>\n` +
            `• Target: <b>${users.length} users</b>\n` +
            `• Type: <b>${msgToBroadcast.type === 'copy' ? 'Media / Forward' : 'Text Message'}</b>\n\n` +
            `<i>Are you sure you want to send this to all users?</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );

        global.pendingBroadcast[ctx.from.id] = { msgData: msgToBroadcast, users: users.length };
    });

    bot.callbackQuery(/^bc_yes_(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const adminId = ctx.match[1];
        if (ctx.from.id.toString() !== adminId) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });

        const pending = global.pendingBroadcast[adminId];
        if (!pending) return ctx.answerCallbackQuery({ text: 'No pending broadcast', show_alert: true });

        await ctx.answerCallbackQuery({ text: '📡 Dispatching broadcast...' });
        await ctx.editMessageText(`📡 <b>Broadcast in progress to ${pending.users} users...</b>`, { parse_mode: 'HTML' });

        const users = await User.find();
        let successCount = 0;
        let blockedCount = 0;

        for (const user of users) {
            try {
                if (pending.msgData.type === 'text') {
                    await ctx.api.sendMessage(user.userId, pending.msgData.text, { parse_mode: 'HTML' });
                } else if (pending.msgData.type === 'copy') {
                    await ctx.api.copyMessage(user.userId, pending.msgData.fromChatId, pending.msgData.messageId);
                }
                successCount++;
                await sleep(150);
            } catch (e) {
                if (e.message.includes('bot was blocked') || e.message.includes('user is deactivated')) {
                    blockedCount++;
                }
            }
        }

        delete global.pendingBroadcast[adminId];
        await ctx.editMessageText(
            `✅ <b>Broadcast Complete!</b>\n\n` +
            `• Sent: <b>${successCount}</b>\n` +
            `• Blocked: <b>${blockedCount}</b>\n` +
            `• Failed: <b>${users.length - successCount - blockedCount}</b>`,
            { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel') }
        );
    });

    bot.callbackQuery(/^bc_no_(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        delete global.pendingBroadcast[ctx.match[1]];
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        await ctx.editMessageText('❌ Broadcast cancelled.', {
            reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
        });
    });

    // Public /help command
    bot.command('help', async (ctx) => {
        const keyboard = new InlineKeyboard();
        const groupLink = process.env.GROUP_LINK;
        if (groupLink) keyboard.url('👥 Join Search Group »', groupLink).row();
        keyboard.text('🎬 Browse All Movies', 'user_browse_0');

        await ctx.reply(
            `📖 <b>HOW TO GET CLIPS:</b>\n\n` +
            `1️⃣ Type any movie name in our group\n` +
            `2️⃣ Tap the button sent by the bot\n` +
            `3️⃣ Download all clips instantly in your private room! 📬\n\n` +
            `<i>Need help? Contact our admin anytime with /contact.</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Command shortcuts
    bot.command('stats', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await renderAdminPanel(ctx, false);
    });

    bot.command('rooms', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const rooms = await Room.find();
        let text = `🏠 <b>Room Pool Status (${rooms.length} Total):</b>\n\n`;
        rooms.forEach((r, i) => text += `${i + 1}. <code>${r.roomId}</code> • ${r.isBusy ? '🔴 Busy' : '🟢 Free'}\n`);
        ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().text('🧹 Clean All Rooms', 'admin_clean_all_rooms')
        });
    });

    bot.command('cleanroom', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const roomId = ctx.match.trim();
        const room = await Room.findOne({ roomId });
        if (!room) return ctx.reply('❌ Room not found.');

        if (room.currentUserId) await safeKickRoomUser(ctx.api, roomId, room.currentUserId);
        if (room.lastMessageIds?.length > 0) await safeDeleteRoomMessages(ctx.api, roomId, room.lastMessageIds);

        room.isBusy = false;
        room.currentUserId = null;
        room.lastMessageIds = [];
        await room.save();
        ctx.reply(`✅ Room <code>${roomId}</code> cleaned and marked FREE.`, { parse_mode: 'HTML' });
    });

    bot.command('addroom', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const roomId = ctx.match.trim();
        if (!roomId) return ctx.reply('Usage: /addroom -100XXXXXXXXXX');
        await Room.findOneAndUpdate({ roomId }, { isBusy: false, lastUsed: new Date() }, { upsert: true });
        ctx.reply(`✅ Room <code>${roomId}</code> added to pool!`, { parse_mode: 'HTML' });
    });

    bot.command('unlock', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const targetId = ctx.match.trim();
        if (!targetId) return ctx.reply('Usage: /unlock USER_ID');
        await User.findOneAndUpdate({ userId: Number(targetId) }, { isDelivering: false });
        ctx.reply(`✅ Lock cleared for user <code>${targetId}</code>.`, { parse_mode: 'HTML' });
    });

    // Users management - clean blocked users and export JSON
    bot.command('users', async (ctx) => {
        if (!isAdmin(ctx)) return;

        const keyboard = new InlineKeyboard()
            .text('✅ Yes, Clean Blocked', 'users_clean_export')
            .text('❌ Cancel', 'users_cancel');

        await ctx.reply(
            `👥 <b>User Management</b>\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `This will:\n` +
            `1. Check all users for blocked status\n` +
            `2. Remove blocked users from database\n` +
            `3. Export clean user list as JSON\n\n` +
            `⚠️ This may take a few minutes depending on user count.`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Confirm clean and export users
    bot.callbackQuery('users_clean_export', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();

        try {
            await ctx.editMessageText(
                `⏳ <b>Checking users...</b>\n\nPlease wait while I check each user and clean blocked ones.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            if (!e.message.includes('message is not modified')) throw e;
        }

        try {
            const allUsers = await User.find();
            let cleanedCount = 0;
            const fs = require('fs');
            const path = require('path');

            for (const user of allUsers) {
                try {
                    await ctx.api.sendChatAction(user.userId, 'typing');
                } catch (e) {
                    if (e.message.includes('bot was blocked') || e.message.includes('user is deactivated')) {
                        cleanedCount++;
                        await User.deleteOne({ _id: user._id });
                    }
                }
                await sleep(100);
            }

            const remainingUsers = await User.find();
            const userData = remainingUsers.map(u => ({
                userId: u.userId,
                joinedAt: u.joinedAt,
                lastActive: u.lastActive,
                searchCount: u.searchCount || 0,
                downloadCount: u.downloadCount || 0,
                badges: u.badges || []
            }));

            const jsonContent = JSON.stringify(userData, null, 2);
            const buffer = Buffer.from(jsonContent, 'utf-8');
            const { InputFile } = require('grammy');

            try {
                await ctx.editMessageText(
                    `✅ <b>User Cleanup Complete</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `🗑️ Removed: ${cleanedCount} blocked users\n` +
                    `✅ Remaining: ${remainingUsers.length} users\n\n` +
                    `Sending JSON file...`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                if (!e.message.includes('message is not modified')) throw e;
            }

            await ctx.api.sendDocument(ctx.from.id, new InputFile(buffer, 'users_export.json'), {
                caption: `📄 User List - ${remainingUsers.length} users`
            });

        } catch (error) {
            console.error('User cleanup error:', error);
            try {
                await ctx.editMessageText(
                    `❌ Error: ${error.message}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                if (!e.message.includes('message is not modified')) throw e;
            }
        }
    });

    bot.callbackQuery('users_cancel', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`❌ <b>Cancelled</b>`, { parse_mode: 'HTML' });
    });
};
