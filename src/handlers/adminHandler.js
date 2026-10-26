const { Movie, Room, User, Token, BotSettings } = require('../database');
const { cleanMovieName, sleep, sendToLogChannel, safeDeleteRoomMessages, safeKickRoomUser } = require('../utils/helpers');
const { getSetting, setSetting, wrapShortlink } = require('../utils/monetization');
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
    'setapikey', 'setforcesub', 'unsetforcesub', 'resetbot', 'unlock', 'resetstats',
    'delclip'
];

// Helper to remove a single mistaken clip/file from database and channel
async function removeSingleClip(movieQuery, clipIdentifier, ctxApi = null) {
    let movie = null;
    if (/^[0-9a-fA-F]{24}$/.test(movieQuery)) {
        movie = await Movie.findById(movieQuery);
    }
    if (!movie && movieQuery) {
        movie = await Movie.findOne({ title: cleanMovieName(movieQuery) });
    }
    if (!movie && movieQuery) {
        movie = await Movie.findOne({ title: movieQuery });
    }
    const numId = Number(clipIdentifier);
    if (!movie && !isNaN(numId)) {
        movie = await Movie.findOne({ messageIds: numId });
    }
    if (!movie && clipIdentifier) {
        movie = await Movie.findOne({ 'files.fileId': clipIdentifier });
    }

    if (!movie) {
        return { success: false, message: 'Could not find a movie matching that clip or title.' };
    }

    // Pull messageId
    if (!isNaN(numId)) {
        await Movie.updateOne({ _id: movie._id }, { $pull: { messageIds: numId } });
    }

    // Pull from files array
    if (clipIdentifier) {
        await Movie.updateOne({ _id: movie._id }, {
            $pull: {
                files: {
                    $or: [
                        { fileId: clipIdentifier },
                        { fileType: clipIdentifier }
                    ]
                }
            }
        });
    }

    const updated = await Movie.findById(movie._id);
    const remaining = updated.files?.length || updated.messageIds?.length || 0;

    // If thumbnail was this file, update thumbnail
    if (updated.thumbnail && (updated.thumbnail === clipIdentifier || !updated.files.some(f => f.fileId === updated.thumbnail))) {
        updated.thumbnail = updated.files[0]?.fileId || null;
        await updated.save();
    }

    // Delete message from DB channel if bot is admin
    const dbChannel = process.env.DB_CHANNEL_ID;
    if (dbChannel && ctxApi && !isNaN(numId)) {
        try {
            await ctxApi.deleteMessage(dbChannel, numId);
        } catch (_) { }
    }

    return {
        success: true,
        title: updated.title,
        remaining,
        movieId: updated._id
    };
}

// Helper to build the main Admin Control Console
async function renderAdminPanel(ctx, isEdit = false) {
    const mode = await getSetting('mode', 'off');
    const modeLabels = { off: '🟢 Free', shortlink: '🔗 Shortlink', token: '🎫 Token Pass' };
    const forceSubChannel = await getSetting('forceSubChannel', null);
    const tutStr = await getSetting('tutorial', null);
    const promoStr = await getSetting('roomPromo', null);
    const apiKey = await getSetting('shortlinkApiKey', process.env.SHORTLINK_API_KEY || '');
    const baseUrl = await getSetting('shortlinkBaseUrl', process.env.SHORTLINK_BASE_URL || '');

    let tutorialDisplay = 'None ❌';
    if (tutStr) {
        try {
            const parsed = JSON.parse(tutStr);
            tutorialDisplay = parsed.type === 'link' ? 'Web Link 🔗' : `${parsed.type.toUpperCase()} 🎥`;
        } catch (_) { tutorialDisplay = 'Active ✅'; }
    }

    let promoDisplay = 'Disabled ❌';
    if (promoStr) {
        try {
            const parsed = JSON.parse(promoStr);
            promoDisplay = `${parsed.type.toUpperCase()} ✅`;
        } catch (_) { promoDisplay = 'Active ✅'; }
    }

    const rooms = await Room.find();
    const freeRooms = rooms.filter(r => !r.isBusy).length;
    const busyRooms = rooms.filter(r => r.isBusy).length;
    const maintenance = Boolean(global.MAINTENANCE);

    const text = `⚙️ <b>ADMIN CONTROL CONSOLE</b>\n` +
        `• <b>Mode:</b> ${modeLabels[mode] || mode}\n` +
        `• <b>Shortlink API:</b> <code>${apiKey && baseUrl ? 'Configured ✅' : 'Not set ❌'}</code>\n` +
        `• <b>Force Sub:</b> <code>${forceSubChannel || 'Disabled'}</code>\n` +
        `• <b>Tutorial Video:</b> <code>${tutorialDisplay}</code>\n` +
        `• <b>Room Promo:</b> <code>${promoDisplay}</code>\n` +
        `• <b>Rooms:</b> <code>${freeRooms} Free / ${busyRooms} Busy (${rooms.length} Total)</code>\n` +
        `• <b>Maintenance:</b> ${maintenance ? '<b>ON ⚠️</b>' : '<b>OFF ✅</b>'}\n\n` +
        `<i>Tap any module below to configure:</i>`;

    const keyboard = new InlineKeyboard()
        .text('🟣 Mode & Shortlinks', 'admin_mode_menu')
        .text('🟣 Tutorial Video', 'admin_tut_menu').row()
        .text('🟣 Room Promo', 'admin_promo_menu')
        .text('🔴 Remove Clip', 'admin_delclip_menu').row()
        .text('🟣 Force Sub', 'admin_forcesub_menu')
        .text('🟣 Room Manager', 'admin_rooms_menu').row()
        .text('🟣 Live Analytics', 'admin_stats_view')
        .text('🟣 Broadcast', 'admin_bc_prompt').row()
        .text(`🔒 Maintenance: ${maintenance ? 'ON' : 'OFF'}`, 'admin_maint_toggle')
        .text('🔄 Refresh Panel', 'admin_panel').row()
        .text('❌ Close', 'close_msg');

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
    bot.on(['message:text', 'message:video', 'message:document', 'message:photo'], async (ctx, next) => {
        if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return next();

        const state = global.adminState[ctx.from.id];

        // 1. Awaiting Tutorial Video/File/Link
        if (state && state.action === 'awaiting_tutorial') {
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
        if (state && state.action === 'awaiting_forcesub') {
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
        if (state && state.action === 'awaiting_room') {
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

        // 4. Awaiting Room Promotional Signoff Message / Media
        if (state && state.action === 'awaiting_promo') {
            let promoData = null;
            if (ctx.message.photo) {
                promoData = {
                    type: 'photo',
                    fileId: ctx.message.photo[ctx.message.photo.length - 1].file_id,
                    caption: ctx.message.caption || ''
                };
            } else if (ctx.message.video) {
                promoData = {
                    type: 'video',
                    fileId: ctx.message.video.file_id,
                    caption: ctx.message.caption || ''
                };
            } else if (ctx.message.document) {
                promoData = {
                    type: 'document',
                    fileId: ctx.message.document.file_id,
                    caption: ctx.message.caption || ''
                };
            } else if (ctx.message.text) {
                if (ctx.message.text === '/cancel' || ctx.message.text.toLowerCase() === 'cancel') {
                    delete global.adminState[ctx.from.id];
                    return ctx.reply('❌ Promo message update cancelled.', {
                        reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                    });
                }
                promoData = { type: 'text', text: ctx.message.text };
            }

            if (promoData) {
                delete global.adminState[ctx.from.id];
                await setSetting('roomPromo', JSON.stringify(promoData));
                return ctx.reply(
                    `✅ <b>Room Promotional Signoff Message Saved!</b>\n\n` +
                    `This will be sent automatically to the private room right after all clips are delivered, serving as the "Full Stop" marker.\n\n` +
                    `<i>It will also auto-delete with the clips when the 30-min session ends!</i>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: new InlineKeyboard().text('⚙️ Return to Admin Console', 'admin_panel')
                    }
                );
            }
        }

        // 4.5. Awaiting Shortlink API Key
        if (state && state.action === 'awaiting_apikey') {
            const input = ctx.message.text?.trim();
            if (input === '/cancel' || input?.toLowerCase() === 'cancel') {
                delete global.adminState[ctx.from.id];
                return ctx.reply('❌ API key update cancelled.', {
                    reply_markup: new InlineKeyboard().text('⚙️ Monetization Menu', 'admin_mode_menu')
                });
            }
            delete global.adminState[ctx.from.id];
            await setSetting('shortlinkApiKey', input);
            return ctx.reply(`✅ <b>Shortlink API Key Saved!</b>\n\nKey: <code>${input.substring(0, 4)}••••${input.slice(-4)}</code>`, {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('⚙️ Monetization Menu', 'admin_mode_menu').text('⚙️ Console', 'admin_panel')
            });
        }

        // 4.6. Awaiting Shortlink Base URL / Endpoint
        if (state && state.action === 'awaiting_endpoint') {
            let input = ctx.message.text?.trim();
            if (input === '/cancel' || input?.toLowerCase() === 'cancel') {
                delete global.adminState[ctx.from.id];
                return ctx.reply('❌ Endpoint update cancelled.', {
                    reply_markup: new InlineKeyboard().text('⚙️ Monetization Menu', 'admin_mode_menu')
                });
            }
            delete global.adminState[ctx.from.id];
            if (!input.startsWith('http')) input = `https://${input}`;
            await setSetting('shortlinkBaseUrl', input);
            return ctx.reply(`✅ <b>Shortlink Base URL / Endpoint Saved!</b>\n\nEndpoint: <code>${input}</code>`, {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('⚙️ Monetization Menu', 'admin_mode_menu').text('⚙️ Console', 'admin_panel')
            });
        }

        // 5. Awaiting Manual Delete Clip Input
        if (state && state.action === 'awaiting_delclip') {
            const input = ctx.message.text?.trim();
            if (input === '/cancel' || input?.toLowerCase() === 'cancel') {
                delete global.adminState[ctx.from.id];
                return ctx.reply('❌ Delete clip operation cancelled.', {
                    reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                });
            }
            delete global.adminState[ctx.from.id];

            const parts = input.includes('|') ? input.split('|') : input.split(/\s+(?=\d+$)/);
            const movieTitle = parts[0]?.trim();
            const clipId = parts[1]?.trim();

            if (!movieTitle || !clipId) {
                return ctx.reply('❌ Format incorrect. Use: <code>Movie Title | Message ID</code>', {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                });
            }

            const result = await removeSingleClip(movieTitle, clipId, ctx.api);
            if (result.success) {
                return ctx.reply(
                    `✅ <b>Clip Removed Successfully!</b>\n\n` +
                    `• <b>Movie:</b> 🎬 <code>${result.title}</code>\n` +
                    `• <b>Removed ID:</b> <code>${clipId}</code>\n` +
                    `• <b>Remaining Clips:</b> <code>${result.remaining}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                    }
                );
            } else {
                return ctx.reply(`❌ ${result.message}`, {
                    reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                });
            }
        }

        // 6. Magic Forward Detection: Admin forwards a mistake clip from DB channel directly
        if (!state && (ctx.message.forward_origin || ctx.message.forward_from_chat || ctx.message.forward_from_message_id)) {
            const origin = ctx.message.forward_origin;
            const forwardedMsgId = origin?.message_id || ctx.message.forward_from_message_id;
            let fileId = null;
            if (ctx.message.video) fileId = ctx.message.video.file_id;
            else if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            else if (ctx.message.document) fileId = ctx.message.document.file_id;
            else if (ctx.message.animation) fileId = ctx.message.animation.file_id;

            const queryOr = [];
            if (forwardedMsgId) queryOr.push({ messageIds: forwardedMsgId });
            if (fileId) queryOr.push({ 'files.fileId': fileId });

            if (queryOr.length > 0) {
                const foundMovie = await Movie.findOne({ $or: queryOr });
                if (foundMovie) {
                    const totalClips = foundMovie.files?.length || foundMovie.messageIds?.length || 0;
                    const keyboard = new InlineKeyboard()
                        .text(`🗑️ Yes, Delete from "${foundMovie.title}"`, `delclip_yes_${foundMovie._id}_${forwardedMsgId || fileId}`).row()
                        .text('❌ Cancel', 'admin_cancel_input');

                    return ctx.reply(
                        `⚠️ <b>Mistaken Clip Found in Database!</b>\n\n` +
                        `• <b>Movie:</b> 🎬 <code>${foundMovie.title}</code>\n` +
                        `• <b>Channel Message ID:</b> <code>${forwardedMsgId || 'File ID match'}</code>\n` +
                        `• <b>Total Clips in Movie:</b> <code>${totalClips}</code>\n\n` +
                        `<i>Do you want to permanently delete this clip from the database?</i>`,
                        { parse_mode: 'HTML', reply_markup: keyboard }
                    );
                }
            }
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

    // Helper to render the complete Monetization & Shortlink / Token Settings Menu
    async function renderModeSettingsMenu(ctx, isEdit = true) {
        const currentMode = await getSetting('mode', 'off');
        const apiKey = await getSetting('shortlinkApiKey', process.env.SHORTLINK_API_KEY || '');
        const baseUrl = await getSetting('shortlinkBaseUrl', process.env.SHORTLINK_BASE_URL || '');
        const tokenHours = await getSetting('tokenDurationHours', 24);

        const maskedKey = apiKey ? `${apiKey.substring(0, 4)}••••${apiKey.slice(-4)}` : '❌ Not configured';
        const endpointDisplay = baseUrl ? baseUrl : '❌ Not configured';

        const keyboard = new InlineKeyboard()
            .text(`${currentMode === 'off' ? '🟢 Free (Active)' : 'Free Mode'}`, 'setmode_off').row()
            .text(`${currentMode === 'shortlink' ? '🔗 Shortlink (Active)' : 'Shortlink Mode'}`, 'setmode_shortlink')
            .text(`${currentMode === 'token' ? '🎫 Token Pass (Active)' : 'Token Pass Mode'}`, 'setmode_token').row()
            .text('🔑 Set API Key', 'admin_set_apikey')
            .text('🌐 Set Endpoint', 'admin_set_endpoint').row()
            .text(`⏱️ Pass: ${tokenHours}h`, 'admin_set_token_dur')
            .text('🧪 Test Link', 'admin_test_shortlink').row()
            .text('🔙 « Back', 'admin_panel')
            .text('❌ Close', 'close_msg');

        const text = `⚙️ <b>MONETIZATION & SHORTLINK SETTINGS</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `• <b>Current Mode:</b> <code>${currentMode.toUpperCase()}</code>\n` +
            `• <b>Shortlink API Key:</b> <code>${maskedKey}</code>\n` +
            `• <b>Shortlink Endpoint:</b> <code>${endpointDisplay}</code>\n` +
            `• <b>Token Pass Duration:</b> <code>${tokenHours} Hours</code>\n\n` +
            `<i>Tap any option below to change mode, configure API keys, or test:</i>`;

        if (isEdit) {
            try {
                return await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
            } catch (_) { }
        }
        return await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }

    // ── Mode Switcher & Shortlink Settings Menu ─────────────────────
    bot.callbackQuery('admin_mode_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        await renderModeSettingsMenu(ctx, true);
    });

    bot.callbackQuery(/^setmode_(off|shortlink|token)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const newMode = ctx.match[1];
        await setSetting('mode', newMode);
        await ctx.answerCallbackQuery({ text: `✅ Switched to ${newMode.toUpperCase()}!` });
        await renderModeSettingsMenu(ctx, true);
    });

    // Set API Key Prompt
    bot.callbackQuery('admin_set_apikey', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        global.adminState[ctx.from.id] = { action: 'awaiting_apikey' };

        const keyboard = new InlineKeyboard().text('🔴 Cancel', 'admin_cancel_input');

        await ctx.editMessageText(
            `🔑 <b>Set Shortlink API Key:</b>\n\n` +
            `Send your API token from your shortener provider (AroLinks, GPLinks, VPLinks, etc.) as a text message here:\n\n` +
            `<i>Example: <code>d9a4f78b12e3456789...</code></i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Set Endpoint Menu
    bot.callbackQuery('admin_set_endpoint', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();

        const keyboard = new InlineKeyboard()
            .text('🔗 AroLinks (arolinks.com/api)', 'preset_endpoint_arolinks').row()
            .text('🔗 GPLinks (gplinks.com/api)', 'preset_endpoint_gplinks').row()
            .text('🔗 VPLinks (vplinks.in/api)', 'preset_endpoint_vplinks').row()
            .text('✏️ Enter Custom URL', 'admin_custom_endpoint_prompt').row()
            .text('🔙 « Back', 'admin_mode_menu')
            .text('❌ Close', 'close_msg');

        await ctx.editMessageText(
            `🌐 <b>Set Shortlink API Base URL / Endpoint:</b>\n\n` +
            `Tap a 1-click preset below or enter a custom endpoint:`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Endpoint 1-click presets
    bot.callbackQuery(/^preset_endpoint_(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const preset = ctx.match[1];
        let url = '';
        if (preset === 'arolinks') url = 'https://arolinks.com/api';
        else if (preset === 'gplinks') url = 'https://gplinks.com/api';
        else if (preset === 'vplinks') url = 'https://vplinks.in/api';

        if (url) {
            await setSetting('shortlinkBaseUrl', url);
            await ctx.answerCallbackQuery({ text: `✅ Endpoint set to ${url}!` });
        }
        await renderModeSettingsMenu(ctx, true);
    });

    // Custom Endpoint Prompt
    bot.callbackQuery('admin_custom_endpoint_prompt', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        global.adminState[ctx.from.id] = { action: 'awaiting_endpoint' };

        const keyboard = new InlineKeyboard().text('🔴 Cancel', 'admin_cancel_input');
        await ctx.editMessageText(
            `🌐 <b>Enter Custom Shortlink API URL:</b>\n\n` +
            `Send the full endpoint URL as a text message here.\n` +
            `<i>Ensure it ends in <code>/api</code> (e.g. <code>https://myshortener.com/api</code>)</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Set Token Duration Menu
    bot.callbackQuery('admin_set_token_dur', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();

        const currentHours = await getSetting('tokenDurationHours', 24);
        const keyboard = new InlineKeyboard()
            .text(`${currentHours === 6 ? '✅ 6 Hours' : '6 Hours'}`, 'token_dur_6')
            .text(`${currentHours === 12 ? '✅ 12 Hours' : '12 Hours'}`, 'token_dur_12').row()
            .text(`${currentHours === 24 ? '✅ 24 Hours (Standard)' : '24 Hours'}`, 'token_dur_24').row()
            .text(`${currentHours === 48 ? '✅ 48 Hours' : '48 Hours'}`, 'token_dur_48')
            .text(`${currentHours === 72 ? '✅ 72 Hours' : '72 Hours'}`, 'token_dur_72').row()
            .text('🔙 « Back', 'admin_mode_menu')
            .text('❌ Close', 'close_msg');

        await ctx.editMessageText(
            `⏱️ <b>Set Token Pass Duration:</b>\n\n` +
            `How long should 1 completed shortlink unlock clips for the user?\n` +
            `<b>Current Duration:</b> <code>${currentHours} Hours</code>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    // Token Duration Selection
    bot.callbackQuery(/^token_dur_(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const hours = parseInt(ctx.match[1], 10);
        await setSetting('tokenDurationHours', hours);
        await ctx.answerCallbackQuery({ text: `✅ Pass duration set to ${hours} hours!` });
        await renderModeSettingsMenu(ctx, true);
    });

    // Test Shortlink
    bot.callbackQuery('admin_test_shortlink', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery({ text: '🧪 Testing shortlink...' });
        const testTarget = 'https://t.me/telegram';
        const apiKey = await getSetting('shortlinkApiKey', process.env.SHORTLINK_API_KEY || '');
        const baseUrl = await getSetting('shortlinkBaseUrl', process.env.SHORTLINK_BASE_URL || '');

        if (!apiKey || !baseUrl) {
            return ctx.reply(
                `❌ <b>Shortlink Not Configured:</b>\n` +
                `Please set both Shortlink API Key and Endpoint URL first!`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⚙️ Settings', 'admin_mode_menu').text('❌ Close', 'close_msg') }
            );
        }

        const res = await wrapShortlink(testTarget);
        if (res && res !== testTarget && res.startsWith('http')) {
            await ctx.reply(
                `✅ <b>Shortlink API Working Perfectly!</b>\n\n` +
                `🔗 <b>Generated Link:</b>\n<code>${res}</code>\n\n` +
                `• <b>Endpoint:</b> <code>${baseUrl}</code>`,
                {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: new InlineKeyboard().text('⚙️ Settings', 'admin_mode_menu').text('❌ Close', 'close_msg')
                }
            );
        } else {
            await ctx.reply(
                `❌ <b>Shortlink API Test Failed!</b>\n\n` +
                `The provider did not return a valid shortened link.\n` +
                `• Check that your API key is correct.\n` +
                `• Check that your endpoint ends in <code>/api</code> (e.g. <code>https://arolinks.com/api</code>).`,
                {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('⚙️ Settings', 'admin_mode_menu').text('❌ Close', 'close_msg')
                }
            );
        }
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
            .text('🔴 Disable Tutorial', 'admin_tut_off').row()
            .text('🔙 « Back', 'admin_panel')
            .text('❌ Close', 'close_msg');

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

    // ── Room Promotional Signoff Manager Menu ───────────────────────
    bot.callbackQuery('admin_promo_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        const promoStr = await getSetting('roomPromo', null);

        let promoInfo = 'Disabled ❌';
        if (promoStr) {
            try {
                const parsed = JSON.parse(promoStr);
                promoInfo = `Active ✅ (<b>${parsed.type.toUpperCase()}</b>)\n` +
                    `${parsed.caption ? `📝 <i>Caption: "${parsed.caption.substring(0, 50)}..."</i>\n` : ''}` +
                    `${parsed.text ? `📝 <i>Text: "${parsed.text.substring(0, 50)}..."</i>\n` : ''}`;
            } catch (_) { promoInfo = 'Active ✅'; }
        }

        const keyboard = new InlineKeyboard()
            .text('📹 Set / Change Promo Message', 'admin_set_promo').row()
            .text('🔴 Turn Off Room Promo', 'admin_promo_off').row()
            .text('🔙 « Back', 'admin_panel')
            .text('❌ Close', 'close_msg');

        await ctx.editMessageText(
            `📢 <b>ROOM PROMOTIONAL SIGNOFF MESSAGE</b>\n\n` +
            `• <b>Status:</b> ${promoInfo}\n\n` +
            `<i>This promotional photo/video/text is sent automatically to the private room right after all clips are delivered, serving as the "Full Stop" signoff message.</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('admin_set_promo', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        global.adminState[ctx.from.id] = { action: 'awaiting_promo' };

        const keyboard = new InlineKeyboard().text('❌ Cancel', 'admin_cancel_input');
        await ctx.editMessageText(
            `📢 <b>Set Room Promotional Message:</b>\n\n` +
            `Send or forward ANY of the following here:\n` +
            `• A <b>Photo</b> (with optional caption)\n` +
            `• A <b>Video</b> (with optional caption)\n` +
            `• A <b>Text Message</b>\n\n` +
            `<i>Tip: You can include links or your channel username in the caption/text!</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('admin_promo_off', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await setSetting('roomPromo', null);
        await ctx.answerCallbackQuery({ text: '✅ Room Promo turned off.' });
        await renderAdminPanel(ctx, true);
    });

    // ── Mistaken Clip Removal Menu ─────────────────────────────────
    bot.callbackQuery('admin_delclip_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();

        const keyboard = new InlineKeyboard()
            .text('✏️ Enter Movie Title & Message ID', 'admin_delclip_input').row()
            .text('🔙 « Back', 'admin_panel')
            .text('❌ Close', 'close_msg');

        await ctx.editMessageText(
            `🗑️ <b>REMOVE MISTAKEN CLIPS FROM DATABASE</b>\n\n` +
            `Did you mistakenly post the wrong file or message to the DB channel?\n\n` +
            `<b>Two easy ways to remove it:</b>\n` +
            `1️⃣ <b>Magic Method:</b> Simply <b>forward that mistake message</b> from your DB channel directly to this PM chat!\n` +
            `2️⃣ <b>Manual Method:</b> Tap the button below and send: <code>Movie Title | Message ID</code>\n` +
            `3️⃣ Or type command: <code>/delclip [Movie Title] [Message ID]</code>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('admin_delclip_input', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        global.adminState[ctx.from.id] = { action: 'awaiting_delclip' };

        const keyboard = new InlineKeyboard().text('❌ Cancel', 'admin_cancel_input');
        await ctx.editMessageText(
            `🗑️ <b>Send Movie Name and Message ID:</b>\n\n` +
            `Format: <code>Movie Title | Message ID</code>\n\n` +
            `<i>Example: <code>Leo | 452</code></i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery(/^delclip_yes_([^_]+)_(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const movieId = ctx.match[1];
        const clipId = ctx.match[2];

        await ctx.answerCallbackQuery({ text: '🗑️ Removing clip...' });
        const result = await removeSingleClip(movieId, clipId, ctx.api);

        if (result.success) {
            await ctx.editMessageText(
                `✅ <b>Clip Removed Successfully!</b>\n\n` +
                `• <b>Movie:</b> 🎬 <code>${result.title}</code>\n` +
                `• <b>Removed ID:</b> <code>${clipId}</code>\n` +
                `• <b>Remaining Clips:</b> <code>${result.remaining}</code>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                }
            );
        } else {
            await ctx.editMessageText(
                `❌ <b>Error:</b> ${result.message}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('⚙️ Admin Console', 'admin_panel')
                }
            );
        }
    });

    // /delclip Command
    bot.command('delclip', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const args = (ctx.match || '').trim();
        if (!args) {
            return ctx.reply(
                `🗑️ <b>Delete Mistaken Clip</b>\n\n` +
                `Usage: <code>/delclip Movie Title [Message ID]</code>\n` +
                `Example: <code>/delclip Leo 452</code>\n\n` +
                `<i>Tip: You can also just forward the clip from the DB channel to this chat!</i>`,
                { parse_mode: 'HTML' }
            );
        }

        const parts = args.includes('|') ? args.split('|') : args.split(/\s+(?=\d+$)/);
        const movieTitle = parts[0]?.trim();
        const msgId = parts[1]?.trim();

        if (!movieTitle || !msgId) {
            return ctx.reply('❌ Please specify both Movie Title and Message ID (e.g. <code>/delclip Leo 452</code>)', { parse_mode: 'HTML' });
        }

        const result = await removeSingleClip(movieTitle, msgId, ctx.api);
        if (result.success) {
            return ctx.reply(
                `✅ <b>Clip Removed Successfully!</b>\n\n` +
                `• <b>Movie:</b> 🎬 <code>${result.title}</code>\n` +
                `• <b>Removed ID:</b> <code>${msgId}</code>\n` +
                `• <b>Remaining Clips:</b> <code>${result.remaining}</code>`,
                { parse_mode: 'HTML' }
            );
        } else {
            return ctx.reply(`❌ ${result.message}`);
        }
    });

    // /setmode Command
    bot.command('setmode', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const arg = (ctx.match || '').trim().toLowerCase();
        if (!['off', 'shortlink', 'token'].includes(arg)) {
            return ctx.reply('⚙️ <b>Usage:</b> <code>/setmode off|shortlink|token</code>', { parse_mode: 'HTML' });
        }
        await setSetting('mode', arg);
        return ctx.reply(`✅ <b>Monetization mode set to:</b> <code>${arg.toUpperCase()}</code>`, { parse_mode: 'HTML' });
    });

    // /setshortlink Command (Endpoint)
    bot.command('setshortlink', async (ctx) => {
        if (!isAdmin(ctx)) return;
        let url = (ctx.match || '').trim();
        if (!url) {
            return ctx.reply('🌐 <b>Usage:</b> <code>/setshortlink https://arolinks.com/api</code>', { parse_mode: 'HTML' });
        }
        if (!url.startsWith('http')) url = `https://${url}`;
        await setSetting('shortlinkBaseUrl', url);
        return ctx.reply(`✅ <b>Shortlink Base URL saved:</b> <code>${url}</code>`, { parse_mode: 'HTML' });
    });

    // /setapikey Command
    bot.command('setapikey', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const key = (ctx.match || '').trim();
        if (!key) {
            return ctx.reply('🔑 <b>Usage:</b> <code>/setapikey YOUR_API_TOKEN</code>', { parse_mode: 'HTML' });
        }
        await setSetting('shortlinkApiKey', key);
        return ctx.reply(`✅ <b>Shortlink API key saved!</b> (<code>${key.substring(0, 4)}••••${key.slice(-4)}</code>)`, { parse_mode: 'HTML' });
    });

    // /settings Command
    bot.command('settings', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await renderModeSettingsMenu(ctx, false);
    });

    // ── Force Sub Menu ──────────────────────────────────────────────
    bot.callbackQuery('admin_forcesub_menu', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();
        const current = await getSetting('forceSubChannel', null);

        const keyboard = new InlineKeyboard()
            .text('✏️ Set / Change Channel', 'admin_forcesub_change').row()
            .text('🔴 Turn Off Force Sub', 'admin_forcesub_off').row()
            .text('🔙 « Back', 'admin_panel')
            .text('❌ Close', 'close_msg');

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
            .text('🔙 « Back', 'admin_panel')
            .text('❌ Close', 'close_msg');

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
            .text('🔙 « Back', 'admin_panel').row()
            .text('❌ Close', 'close_msg');

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
        const keyboard = new InlineKeyboard()
            .text('🔙 « Back', 'admin_panel')
            .text('❌ Close', 'close_msg');
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
