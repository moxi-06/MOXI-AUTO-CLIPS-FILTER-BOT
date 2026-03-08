const { Movie, Room, User, Token, BotSettings } = require('../database');
const { cleanMovieName, sleep, sendToLogChannel } = require('../utils/helpers');
const { getSetting, setSetting } = require('../utils/monetization');
const { InlineKeyboard } = require('grammy');

global.MAINTENANCE = false;
global.LOGS = [];
global.broadcastStats = { total: 0, blocked: 0, failed: 0 };

const logError = (err) => {
    const errorMsg = err.message || err.toString();
    global.LOGS.push(`[${new Date().toISOString()}] ${errorMsg}`);
    if (global.LOGS.length > 20) global.LOGS.shift(); // keep last 20
};

const isAdmin = (ctx) => {
    const adminId = process.env.ADMIN_ID;
    return adminId && ctx.from && ctx.from.id.toString() === adminId;
};

// List of admin-only commands to hide from normal users
const adminCommands = [
    'addmovie', 'deletemovie', 'addcategory', 'stats', 'top',
    'addroom', 'rooms', 'cleanroom', 'broadcast', 'maintenance',
    'logs', 'restartrooms', 'settings', 'setmode', 'setshortlink',
    'setapikey', 'setforcesub', 'unsetforcesub', 'resetbot'
];

module.exports = (bot) => {
    // Hide admin commands from non-admin users
    bot.use(async (ctx, next) => {
        const cmd = ctx.message?.text?.split(' ')[0]?.replace('/', '').toLowerCase();
        if (cmd && adminCommands.includes(cmd) && !isAdmin(ctx)) {
            return; // Silently ignore admin commands from non-admins
        }
        await next();
    });

    // Top-level middleware to catch maintenance mode and errors
    bot.use(async (ctx, next) => {
        try {
            if (global.MAINTENANCE && !isAdmin(ctx) && ctx.chat?.type === 'private') {
                return ctx.reply('⚠️ <b>Bot is under maintenance.</b> Please try again later.', { parse_mode: 'HTML' });
            }
            await next();
        } catch (error) {
            logError(error);
            console.error('Bot Pipeline Error:', error);
        }
    });

    // Public /help command - for all users
    bot.command('help', async (ctx) => {
        const isGroup = ctx.chat.type !== 'private';
        const isAdminUser = isAdmin(ctx);

        let helpText = `📖 HELP GUIDE\n`;
        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n\n`;

        // WHAT IS THIS BOT
        helpText += `🎬 WHAT IS THIS BOT?\n`;
        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        helpText += `This bot helps you get movie clips!\n`;
        helpText += `Search in group → Get clips in your PM!\n`;
        helpText += `Simple as that! 😄\n\n`;

        // HOW TO USE
        helpText += `📝 HOW TO GET CLIPS\n`;
        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        helpText += `Step 1: Join our group\n`;
        helpText += `Step 2: Type a movie name\n`;
        helpText += `Step 3: Tap the button I send\n`;
        helpText += `Step 4: Get clips in your PM! 📬\n\n`;

        // EXAMPLE
        helpText += `💡 EXAMPLE\n`;
        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        helpText += `You type: "Leo"\n`;
        helpText += `Bot sends: Movie info + button\n`;
        helpText += `You tap button → Clips in PM!\n\n`;

        // USER COMMANDS
        helpText += `📌 USER COMMANDS\n`;
        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        helpText += `/start - Start the bot\n`;
        helpText += `/help - Show this guide\n`;
        helpText += `/filters - Browse all movies\n`;
        helpText += `/myprofile - Your stats & badges\n`;
        helpText += `/todaystats - Today's activity\n\n`;

        // TIPS
        helpText += `💡 TIPS\n`;
        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        helpText += `✓ Don't worry about spelling!\n`;
        helpText += `✓ I fix typos automatically\n`;
        helpText += `✓ Spaces don't matter\n`;
        helpText += `✓ Use /filters to browse movies\n\n`;

        // NEW TO TELEGRAM?
        helpText += `📱 NEW TO TELEGRAM?\n`;
        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        helpText += `No problem! Just:\n`;
        helpText += `1. Join the group\n`;
        helpText += `2. Type any movie name\n`;
        helpText += `3. I'll handle the rest!\n`;
        helpText += `The clips will come to your chat (PM)\n\n`;

        // ADMIN COMMANDS (if admin)
        if (isAdminUser) {
            helpText += `⚙️ ADMIN COMMANDS\n`;
            helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
            helpText += `/stats - Full dashboard\n`;
            helpText += `/addmovie - Add new movie\n`;
            helpText += `/delmovie - Delete movie\n`;
            helpText += `/thumb - Set thumbnail\n`;
            helpText += `/broadcast - Send to all users\n`;
            helpText += `/rooms - View room status\n`;
            helpText += `/settings - Bot settings\n`;
            helpText += `/maintenance - Toggle mode\n`;
            helpText += `/resetbot - Reset all data\n\n`;
        }

        helpText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        helpText += `Need help? Contact admin!`;

        await ctx.reply(helpText, { parse_mode: 'HTML' });
    });

    // Public /todaystats - shows today's activity in group
    bot.command('todaystats', async (ctx) => {
        const todaySearches = global.todayStats?.searches || 0;
        const todayDeliveries = global.todayStats?.deliveries || 0;
        const successRate = todaySearches > 0 ? Math.round((todayDeliveries / todaySearches) * 100) : 0;

        await ctx.reply(
            `📊 <b>TODAY'S ACTIVITY</b>\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `🔍 <b>Searches:</b> ${todaySearches}\n` +
            `📤 <b>Clips Delivered:</b> ${todayDeliveries}\n` +
            `✅ <b>Success Rate:</b> ${successRate}%\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `💡 <b>Tip:</b> <i>Type a movie name to get clips!</i>`,
            { parse_mode: 'HTML' }
        );
    });

    // User profile with badges
    bot.command('myprofile', async (ctx) => {
        try {
            const user = await User.findOne({ userId: ctx.from.id });

            if (!user) {
                return ctx.reply(
                    `👤 <b>YOUR PROFILE</b>\n\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                    `🔍 <b>Searches:</b> 0\n` +
                    `📥 <b>Downloads:</b> 0\n\n` +
                    `🎖️ <b>Badges:</b> None yet!\n\n` +
                    `💡 <i>Start searching movies to earn badges!</i>`,
                    { parse_mode: 'HTML' }
                );
            }

            const badges = user.badges.length > 0 ? user.badges.join('\n') : 'None yet!';

            // Calculate progress to next badge
            let progress = '';
            if (user.downloadCount < 3) {
                progress = `\n📈 Next badge at 3 downloads!`;
            } else if (user.downloadCount < 10) {
                progress = `\n📈 Next badge at 10 downloads!`;
            } else if (user.downloadCount < 20) {
                progress = `\n📈 Next badge at 20 downloads!`;
            } else {
                progress = `\n🎉 You have all badges!`;
            }

            await ctx.reply(
                `👤 <b>YOUR PROFILE</b>\n\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `🔍 <b>Searches:</b> ${user.searchCount || 0}\n` +
                `📥 <b>Downloads:</b> ${user.downloadCount || 0}\n\n` +
                `🎖️ <b>Your Badges:</b>\n${badges}\n\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
                `${progress}`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Profile error:', e);
            ctx.reply('❌ Error loading profile');
        }
    });

    // Reset all user badges (admin only)
    bot.command('resetbadges', async (ctx) => {
        if (!isAdmin(ctx)) return;

        const confirmKeyboard = new InlineKeyboard()
            .text('✅ Yes, Reset All', 'reset_badges_confirm')
            .text('❌ Cancel', 'reset_badges_cancel');

        await ctx.reply(
            `⚠️ <b>RESET ALL BADGES?</b>\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `This will remove ALL badges from ALL users.\n\n` +
            `This action cannot be undone!`,
            { parse_mode: 'HTML', reply_markup: confirmKeyboard }
        );
    });

    // Confirm reset badges
    bot.callbackQuery('reset_badges_confirm', async (ctx) => {
        if (!isAdmin(ctx)) return;

        try {
            const result = await User.updateMany(
                {},
                { $set: { badges: [], searchCount: 0, downloadCount: 0 } }
            );

            await ctx.answerCallbackQuery({ text: '✅ Badges reset!', show_alert: true });
            await ctx.editMessageText(
                `✅ <b>ALL BADGES RESET!</b>\n\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `👥 Users affected: ${result.modifiedCount}\n\n` +
                `All badges, searches, and downloads cleared!`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Reset badges error:', e);
            await ctx.answerCallbackQuery({ text: '❌ Error occurred', show_alert: true });
        }
    });

    bot.callbackQuery('reset_badges_cancel', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery({ text: 'Cancelled', show_alert: false });
        await ctx.editMessageText(`❌ <b>Reset Cancelled</b>`, { parse_mode: 'HTML' });
    });

    // Reset Bot - Delete all data
    bot.command('resetbot', async (ctx) => {
        if (!isAdmin(ctx)) return;

        const keyboard = new InlineKeyboard()
            .text('✅ Yes, Delete All', 'resetbot_confirm')
            .row()
            .text('❌ No, Cancel', 'resetbot_cancel');

        await ctx.reply(
            `⚠️ <b>RESET BOT</b>\n\n` +
            `This will delete ALL data:\n` +
            `• All movies & clips\n` +
            `• All users\n` +
            `• All settings\n` +
            `• All tokens\n` +
            `• All badges\n\n` +
            `This cannot be undone!\n\n` +
            `Are you sure?`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.callbackQuery('resetbot_confirm', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery();

        try {
            await Movie.deleteMany({});
            await User.deleteMany({});
            await Token.deleteMany({});
            await Room.deleteMany({});
            await BotSettings.deleteMany({});

            await ctx.editMessageText(
                `✅ <b>RESET COMPLETE</b>\n\n` +
                `All data has been deleted:\n` +
                `• Movies: Deleted\n` +
                `• Users: Deleted\n` +
                `• Settings: Deleted\n` +
                `• Tokens: Deleted\n\n` +
                `Bot is now fresh!`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            await ctx.editMessageText(`❌ Error: ${error.message}`, { parse_mode: 'HTML' });
        }
    });

    bot.callbackQuery('resetbot_cancel', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await ctx.answerCallbackQuery({ text: 'Cancelled', show_alert: false });
        await ctx.editMessageText(`❌ <b>Reset Cancelled</b>\n\nNo data was deleted.`, { parse_mode: 'HTML' });
    });

    // Group Admin Tools

    bot.command('deletemovie', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const title = cleanMovieName(ctx.match);
        const res = await Movie.deleteOne({ title });
        ctx.reply(res.deletedCount > 0 ? `🗑️ Deleted: ${title}` : `❌ Not found: ${title}`);
    });

    // Add/update categories for existing movie
    bot.command('addcategory', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const args = ctx.match.split('|');
        if (args.length < 2) {
            return ctx.reply(
                `❌ <b>Usage:</b>\n` +
                `/addcategory MovieName | hero,heroine,director\n\n` +
                `📝 <b>Example:</b>\n` +
                `/addcategory Leo | Rajinikanth,ManchuLakshmi,LokeshKanagaraj\n\n` +
                `💡 This adds categories to existing movie!`,
                { parse_mode: 'HTML' }
            );
        }

        const title = cleanMovieName(args[0]);
        const categories = args[1].split(',').map(c => c.trim()).filter(c => c.length > 0);

        const movie = await Movie.findOne({ title });
        if (!movie) {
            return ctx.reply(`❌ Movie not found: ${title}`);
        }

        movie.categories = [...new Set([...movie.categories, ...categories])];
        await movie.save();

        ctx.reply(
            `✅ <b>Categories Updated!</b>\n\n` +
            `🎬 <b>${movie.title}</b>\n` +
            `👤 Categories: ${movie.categories.join(', ')}`,
            { parse_mode: 'HTML' }
        );
    });

    bot.command('stats', async (ctx) => {
        if (!isAdmin(ctx)) return;

        const totalMovies = await Movie.countDocuments();
        const totalUsers = await User.countDocuments();

        // Calculate total clips
        const moviesWithClips = await Movie.find({}, { messageIds: 1, files: 1 });
        const totalClips = moviesWithClips.reduce((sum, m) => sum + (m.files?.length || m.messageIds?.length || 0), 0);

        // Movies with thumbnails
        const moviesWithThumb = await Movie.countDocuments({ thumbnail: { $ne: null } });

        // Growth Analytics
        const now = new Date();
        const last24h = new Date(now - 24 * 60 * 60 * 1000);
        const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const last30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

        const usersLast24h = await User.countDocuments({ joinedAt: { $gte: last24h } });
        const usersLast7d = await User.countDocuments({ joinedAt: { $gte: last7d } });
        const usersLast30d = await User.countDocuments({ joinedAt: { $gte: last30d } });

        // Calculate active users (users who searched or downloaded)
        const activeUsers = await User.countDocuments({
            $or: [{ searchCount: { $gt: 0 } }, { downloadCount: { $gt: 0 } }]
        });

        // Total searches & downloads
        const allUsers = await User.find({}, { searchCount: 1, downloadCount: 1 });
        const totalSearches = allUsers.reduce((sum, u) => sum + (u.searchCount || 0), 0);
        const totalDownloads = allUsers.reduce((sum, u) => sum + (u.downloadCount || 0), 0);

        // Top searched movies
        const topMovies = await Movie.find().sort({ requests: -1 }).limit(10);

        // Top downloaders
        const topUsers = await User.find().sort({ downloadCount: -1 }).limit(10);

        // Room status
        const rooms = await Room.find();
        const freeRooms = rooms.filter(r => !r.isBusy).length;
        const busyRooms = rooms.filter(r => r.isBusy).length;

        // Today's stats
        const todaySearches = global.todayStats?.searches || 0;
        const todayDeliveries = global.todayStats?.deliveries || 0;

        // Week stats
        const weekSearches = Math.round(todaySearches * 7); // Approximate
        const weekDeliveries = Math.round(todayDeliveries * 7);

        // Bot uptime
        const botUptime = process.uptime ? Math.floor(process.uptime() / 60) : 0;
        const uptimeHours = Math.floor(botUptime / 60);

        // Maintenance mode check
        const maintenanceMode = process.env.MAINTENANCE_MODE === 'true' || global.maintenanceMode;

        // Monetization status
        const mode = await getSetting('monetizationMode') || 'off';

        // Build the stats message
        let statsText = `📊 DASHBOARD\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n\n`;

        // OVERVIEW SECTION
        statsText += `📈 OVERVIEW\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `🎬 Movies: ${totalMovies} | 📹 Clips: ${totalClips}\n`;
        statsText += `👥 Users: ${totalUsers} | ✅ Active: ${activeUsers}\n`;
        statsText += `🖼️ Thumbnails: ${moviesWithThumb}/${totalMovies}\n\n`;

        // TODAY SECTION
        statsText += `📅 TODAY\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `🔍 Searches: ${todaySearches}\n`;
        statsText += `📤 Delivered: ${todayDeliveries}\n`;
        statsText += `📊 Success: ${todaySearches > 0 ? Math.round((todayDeliveries / todaySearches) * 100) : 0}%\n\n`;

        // WEEK SECTION
        statsText += `📆 THIS WEEK\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `👥 New Users: ${usersLast7d}\n`;
        statsText += `🔍 Searches: ~${weekSearches}\n`;
        statsText += `📤 Delivered: ~${weekDeliveries}\n\n`;

        // MONTH SECTION
        statsText += `🗓️ THIS MONTH\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `👥 New Users: ${usersLast30d}\n`;
        statsText += `🔍 Total Searches: ${totalSearches}\n`;
        statsText += `📤 Total Downloads: ${totalDownloads}\n\n`;

        // ROOMS SECTION
        statsText += `🏠 ROOMS\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `🟢 Free: ${freeRooms} | 🔴 Busy: ${busyRooms}\n`;
        statsText += `📊 Total: ${rooms.length}\n\n`;

        // SYSTEM SECTION
        statsText += `⚙️ <b>SYSTEM</b>\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `⏱️ <b>Uptime:</b> ${uptimeHours} Hours\n`;
        statsText += `🔧 <b>Mode:</b> ${mode.toUpperCase()}\n`;
        statsText += `🔒 <b>Maintenance:</b> ${maintenanceMode ? 'ACTIVE ⚠️' : 'CLEAN ✅'}\n`;

        if (topMovies.length > 0) {
            statsText += `\n🔥 TOP MOVIES\n`;
            statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
            topMovies.forEach((m, i) => {
                const clipCount = m.files?.length || m.messageIds?.length || 0;
                statsText += `${i + 1}. ${m.title} - ${m.requests} searches | ${clipCount} clips\n`;
            });
        }

        if (topUsers.length > 0) {
            statsText += `\n⭐ TOP DOWNLOADERS\n`;
            statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
            topUsers.forEach((u, i) => {
                statsText += `${i + 1}. User ${u.userId} - ${u.downloadCount} downloads\n`;
            });
        }

        statsText += `\n━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `Type /stats for this dashboard\n`;

        const keyboard = new InlineKeyboard()
            .text('🔄 Refresh', 'stats_refresh');

        ctx.reply(statsText, { parse_mode: 'HTML', reply_markup: keyboard });
    });


    bot.command('top', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const topMovies = await Movie.find().sort({ requests: -1 }).limit(10);

        if (topMovies.length === 0) {
            return ctx.reply('No movies yet!');
        }

        const keyboard = new InlineKeyboard();
        topMovies.forEach((m, i) => {
            const icon = i === 0 ? '👑' : '🎬';
            keyboard.text(`${icon} ${m.title}`, `top_${m.title}`).row();
        });

        let text = `🔥 TOP MOVIES\n`;
        text += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        topMovies.forEach((m, i) => {
            const icon = i === 0 ? '👑' : '🔸';
            text += `${icon} ${i + 1}. ${m.title} - ${m.requests} searches\n`;
        });

        text += `\n━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        text += `Tap a movie to get clips!`;

        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });

    // Channel Admin Tools
    bot.command('addroom', async (ctx) => {
        if (!isAdmin(ctx)) return;
        if (!ctx.match) return ctx.reply('Usage: /addroom -100XXXXXX (Use Channel ID)');
        const roomId = ctx.match.trim();
        await Room.findOneAndUpdate({ roomId }, { isBusy: false }, { upsert: true, returnDocument: 'after' });
        ctx.reply(`✅ Room ${roomId} mapped to your room pool!`);
    });

    bot.command('rooms', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const rooms = await Room.find();
        let text = `🏠 <b>Room Pool Status (${rooms.length} Total)</b>\n\n`;
        rooms.forEach((r, i) => text += `Room ${i + 1} [<code>${r.roomId}</code>]: ${r.isBusy ? '🔴 Busy' : '🟢 Free'}\n`);
        ctx.reply(text, { parse_mode: 'HTML' });
    });

    bot.command('cleanroom', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const roomId = ctx.match.trim();
        const room = await Room.findOne({ roomId });
        if (!room) return ctx.reply('❌ Room not found in pool. Use /rooms.');

        ctx.reply(`🧹 Cleaning room ${roomId}... manually...`);
        if (room.currentUserId) {
            try {
                await ctx.api.banChatMember(roomId, Number(room.currentUserId));
                await sleep(500);
                await ctx.api.unbanChatMember(roomId, Number(room.currentUserId));
            } catch (e) { logError(e); }
        }
        if (room.lastMessageIds && room.lastMessageIds.length > 0) {
            try {
                await ctx.api.deleteMessages(roomId, room.lastMessageIds);
            } catch (e) { logError(e); }
        }

        room.isBusy = false;
        room.currentUserId = null;
        room.lastMessageIds = [];
        await room.save();
        ctx.reply('✅ Cleaned successfully and marked as FREE.');
    });

    // Bot Admin Tools
    // Store pending broadcast messages
    global.pendingBroadcast = {};

    bot.command('broadcast', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const msgText = ctx.match;
        if (!msgText) return ctx.reply('❌ Usage: /broadcast [Your message here]');

        const users = await User.find();
        const keyboard = new InlineKeyboard()
            .text('✅ Yes, Send', `bc_yes_${ctx.from.id}`)
            .text('❌ Cancel', `bc_no_${ctx.from.id}`);

        const sent = await ctx.reply(
            `📡 <b>BROADCAST PREVIEW</b>\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `📝 <b>Message:</b>\n${msgText}\n\n` +
            `👥 <b>Target:</b> ${users.length} users\n\n` +
            `⚠️ This will send to all users!`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );

        // Store pending broadcast
        global.pendingBroadcast[ctx.from.id] = { text: msgText, users: users.length };
    });

    // Broadcast confirmation handlers
    bot.callbackQuery(/^bc_yes_(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const adminId = ctx.match[1];

        if (ctx.from.id.toString() !== adminId) {
            await ctx.answerCallbackQuery({ text: '❌ Not authorized', show_alert: true });
            return;
        }

        const pending = global.pendingBroadcast[adminId];
        if (!pending) {
            await ctx.answerCallbackQuery({ text: '⚠️ No pending broadcast', show_alert: true });
            return;
        }

        await ctx.answerCallbackQuery({ text: '📡 Starting broadcast...', show_alert: false });

        // Edit the message to show progress
        await ctx.editMessageText(
            `📡 <b>BROADCAST IN PROGRESS...</b>\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
            `👤 Target: <b>${pending.users}</b> users`,
            { parse_mode: 'HTML' }
        );

        const users = await User.find();
        let successCount = 0;
        let blockedCount = 0;
        global.broadcastStats = { total: users.length, blocked: 0, failed: 0 };

        for (const user of users) {
            try {
                await ctx.api.sendMessage(user.userId, pending.text, { parse_mode: 'HTML' });
                successCount++;
                await sleep(300);
            } catch (e) {
                if (e.message.includes('bot was blocked') || e.message.includes('user is deactivated')) {
                    blockedCount++;
                }
            }
        }

        global.broadcastStats = { total: users.length, blocked: blockedCount, failed: users.length - successCount - blockedCount };
        delete global.pendingBroadcast[adminId];

        await ctx.editMessageText(
            `✅ <b>BROADCAST COMPLETE</b>\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
            `🟢 <b>Success:</b> ${successCount}\n` +
            `🚫 <b>Blocked:</b> ${blockedCount}\n` +
            `❌ <b>Failed:</b> ${users.length - successCount - blockedCount}`,
            { parse_mode: 'HTML' }
        );
    });

    bot.callbackQuery(/^bc_no_(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return;
        const adminId = ctx.match[1];

        if (ctx.from.id.toString() !== adminId) {
            await ctx.answerCallbackQuery({ text: '❌ Not authorized', show_alert: true });
            return;
        }

        delete global.pendingBroadcast[adminId];
        await ctx.answerCallbackQuery({ text: '❌ Broadcast cancelled', show_alert: false });
        await ctx.editMessageText('❌ <b>BROADCAST CANCELLED</b>', { parse_mode: 'HTML' });
    });

    bot.command('maintenance', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const arg = ctx.match.trim().toLowerCase();
        if (arg === 'on') {
            global.MAINTENANCE = true;
            ctx.reply('⚠️ Maintenance Mode ENABLED. Only admins can use the bot.');
        }
        else if (arg === 'off') {
            global.MAINTENANCE = false;
            ctx.reply('✅ Maintenance Mode DISABLED. Bot is open to public.');
        }
        else ctx.reply('Usage: /maintenance on|off');
    });

    bot.command('logs', async (ctx) => {
        if (!isAdmin(ctx)) return;
        if (global.LOGS.length === 0) return ctx.reply('✨ No recent errors logged. System is healthy.');
        ctx.reply(`📜 <b>Recent System Errors</b>\n\n${global.LOGS.join('\n')}`, { parse_mode: 'HTML' });
    });

    bot.command('restartrooms', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await Room.updateMany({}, { isBusy: false });
        ctx.reply('🔄 Admin Override: All rooms have been forcefully marked as FREE in DB.');
    });

    bot.command('resetstats', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await Movie.updateMany({}, { requests: 0 });
        await User.updateMany({}, { searchCount: 0, downloadCount: 0, badges: [] });
        ctx.reply('✅ All stats have been reset!\n\n• Movie request counts: 0\n• User search counts: 0\n• User download counts: 0\n• All badges: cleared');
    });

    // --- Monetization Settings ---
    bot.command('settings', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const mode = await getSetting('mode', 'off');
        const shortlinkBase = await getSetting('shortlinkBase', 'Not Set');
        const forceSubChannel = await getSetting('forceSubChannel', 'Not Set');
        const modeIcon = { off: '🟢 Free', shortlink: '🔗 Shortlink', token: '🎫 Token' };

        ctx.reply(
            `⚙️ <b>ADMIN SETTINGS PANEL</b>\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n` +
            `📂 <b>Mode:</b> ${modeIcon[mode] || mode}\n` +
            `🔗 <b>API URL:</b> <code>${shortlinkBase}</code>\n` +
            `📢 <b>Force Sub:</b> <code>${forceSubChannel}</code>\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `📝 <b>Control Commands:</b>\n` +
            `▫️ <code>/setmode off|shortlink|token</code>\n` +
            `▫️ <code>/setshortlink [url]</code>\n` +
            `▫️ <code>/setapikey [key]</code>\n` +
            `▫️ <code>/setforcesub [@channel]</code>\n` +
            `▫️ <code>/unsetforcesub</code>`,
            { parse_mode: 'HTML' }
        );
    });

    bot.command('setmode', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const newMode = ctx.match.trim().toLowerCase();
        if (!['off', 'shortlink', 'token'].includes(newMode)) {
            return ctx.reply('❌ Invalid mode. Use: /setmode off | shortlink | token');
        }
        await setSetting('mode', newMode);
        const labels = { off: '🟢 Free', shortlink: '🔗 Shortlink', token: '🎫 Token' };
        ctx.reply(`✅ Monetization mode changed to: <b>${labels[newMode]}</b>`, { parse_mode: 'HTML' });
    });

    bot.command('setshortlink', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const url = ctx.match.trim();
        if (!url || !url.startsWith('http')) {
            return ctx.reply('❌ Usage: /setshortlink https://arolinks.com/api');
        }
        // Store in env-like settings
        process.env.SHORTLINK_BASE_URL = url;
        await setSetting('shortlinkBase', url);
        ctx.reply(`✅ Shortlink API URL set to:\n<code>${url}</code>`, { parse_mode: 'HTML' });
    });

    bot.command('setapikey', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const key = ctx.match.trim();
        if (!key) return ctx.reply('❌ Usage: /setapikey YOUR_API_KEY_HERE');
        process.env.SHORTLINK_API_KEY = key;
        await setSetting('shortlinkApiKey', key);
        ctx.reply(`✅ Shortlink API Key saved securely.`);
    });

    bot.command('setforcesub', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const channel = ctx.match.trim();
        if (!channel) return ctx.reply('❌ Usage: /setforcesub @yourchannel OR -100channelid');
        await setSetting('forceSubChannel', channel);
        ctx.reply(`✅ Force Subscribe set to: <code>${channel}</code>\n\nUsers must join this channel before receiving clips.`, { parse_mode: 'HTML' });
    });

    bot.command('unsetforcesub', async (ctx) => {
        if (!isAdmin(ctx)) return;
        await setSetting('forceSubChannel', null);
        ctx.reply('✅ Force Subscribe removed. Users can receive clips without joining any channel.');
    });

    // Handle top movies callback - send user to group to get clips
    bot.callbackQuery(/^top_(.+)$/, async (ctx) => {
        const movieTitle = ctx.match[1];
        try {
            const movie = await Movie.findOne({ title: movieTitle });
            if (!movie) {
                await ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });
                return;
            }

            const groupId = process.env.GROUP_ID;
            if (!groupId) {
                await ctx.answerCallbackQuery({ text: '⚠️ Group not configured', show_alert: true });
                return;
            }

            await ctx.answerCallbackQuery({ text: '📢 Redirecting to group...', show_alert: false });

            // Send instructions to user
            await ctx.editMessageText(
                `🎬 <b>${movie.title}</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `📂 <b>${movie.messageIds.length} clips</b> available!\n\n` +
                `👇 Go to group and search for clips:\n` +
                `<a href="https://t.me/${groupId.replace('-100', '')}">Click to Open Group</a>\n\n` +
                `Then type: <code>${movie.title}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            console.error('Top callback error:', error);
        }
    });

    // Handle stats refresh callback
    bot.callbackQuery('stats_refresh', async (ctx) => {
        if (!isAdmin(ctx)) return;

        await ctx.answerCallbackQuery({ text: '🔄 Refreshing...', show_alert: false });

        const totalMovies = await Movie.countDocuments();
        const totalUsers = await User.countDocuments();
        const moviesWithClips = await Movie.find({}, { messageIds: 1, files: 1 });
        const totalClips = moviesWithClips.reduce((sum, m) => sum + (m.files?.length || m.messageIds?.length || 0), 0);
        const moviesWithThumb = await Movie.countDocuments({ thumbnail: { $ne: null } });

        const now = new Date();
        const last24h = new Date(now - 24 * 60 * 60 * 1000);
        const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const last30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

        const usersLast24h = await User.countDocuments({ joinedAt: { $gte: last24h } });
        const usersLast7d = await User.countDocuments({ joinedAt: { $gte: last7d } });
        const usersLast30d = await User.countDocuments({ joinedAt: { $gte: last30d } });

        const activeUsers = await User.countDocuments({
            $or: [{ searchCount: { $gt: 0 } }, { downloadCount: { $gt: 0 } }]
        });

        const allUsers = await User.find({}, { searchCount: 1, downloadCount: 1 });
        const totalSearches = allUsers.reduce((sum, u) => sum + (u.searchCount || 0), 0);
        const totalDownloads = allUsers.reduce((sum, u) => sum + (u.downloadCount || 0), 0);

        const topMovies = await Movie.find().sort({ requests: -1 }).limit(10);
        const topUsers = await User.find().sort({ downloadCount: -1 }).limit(10);

        const rooms = await Room.find();
        const freeRooms = rooms.filter(r => !r.isBusy).length;
        const busyRooms = rooms.filter(r => r.isBusy).length;

        const todaySearches = global.todayStats?.searches || 0;
        const todayDeliveries = global.todayStats?.deliveries || 0;
        const weekSearches = Math.round(todaySearches * 7);
        const weekDeliveries = Math.round(todayDeliveries * 7);

        const botUptime = process.uptime ? Math.floor(process.uptime() / 60) : 0;
        const uptimeHours = Math.floor(botUptime / 60);

        const maintenanceMode = process.env.MAINTENANCE_MODE === 'true' || global.maintenanceMode;
        const mode = await getSetting('monetizationMode') || 'off';

        let statsText = `📊 DASHBOARD\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n\n`;

        statsText += `📈 OVERVIEW\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `🎬 Movies: ${totalMovies} | 📹 Clips: ${totalClips}\n`;
        statsText += `👥 Users: ${totalUsers} | ✅ Active: ${activeUsers}\n`;
        statsText += `🖼️ Thumbnails: ${moviesWithThumb}/${totalMovies}\n\n`;

        statsText += `📅 TODAY\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `🔍 Searches: ${todaySearches}\n`;
        statsText += `📤 Delivered: ${todayDeliveries}\n`;
        statsText += `📊 Success: ${todaySearches > 0 ? Math.round((todayDeliveries / todaySearches) * 100) : 0}%\n\n`;

        statsText += `📆 THIS WEEK\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `👥 New Users: ${usersLast7d}\n`;
        statsText += `🔍 Searches: ~${weekSearches}\n`;
        statsText += `📤 Delivered: ~${weekDeliveries}\n\n`;

        statsText += `🗓️ THIS MONTH\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `👥 New Users: ${usersLast30d}\n`;
        statsText += `🔍 Total Searches: ${totalSearches}\n`;
        statsText += `📤 Total Downloads: ${totalDownloads}\n\n`;

        statsText += `🏠 ROOMS\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `🟢 Free: ${freeRooms} | 🔴 Busy: ${busyRooms}\n`;
        statsText += `📊 Total: ${rooms.length}\n\n`;

        statsText += `⚙️ SYSTEM\n`;
        statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `⏱️ Uptime: ${uptimeHours} hours\n`;
        statsText += `🔧 Mode: ${mode}\n`;
        statsText += `🔒 Maintenance: ${maintenanceMode ? 'ON ⚠️' : 'OFF ✅'}\n`;

        if (topMovies.length > 0) {
            statsText += `\n🔥 TOP MOVIES\n`;
            statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
            topMovies.forEach((m, i) => {
                const clipCount = m.files?.length || m.messageIds?.length || 0;
                statsText += `${i + 1}. ${m.title} - ${m.requests} searches | ${clipCount} clips\n`;
            });
        }

        if (topUsers.length > 0) {
            statsText += `\n⭐ TOP DOWNLOADERS\n`;
            statsText += `━━━━━━━━━ ✦ ━━━━━━━━━\n`;
            topUsers.forEach((u, i) => {
                statsText += `${i + 1}. User ${u.userId} - ${u.downloadCount} downloads\n`;
            });
        }

        statsText += `\n━━━━━━━━━ ✦ ━━━━━━━━━\n`;
        statsText += `Type /stats for this dashboard\n`;

        const keyboard = new InlineKeyboard().text('🔄 Refresh', 'stats_refresh');

        try {
            await ctx.editMessageText(statsText, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (e) {
            if (!e.message.includes('message is not modified')) {
                throw e;
            }
        }
    });

    // Emergency Unlock Command
    bot.command('unlock', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const targetId = ctx.match;
        if (!targetId) return ctx.reply('❌ Usage: `/unlock {userId}`');

        try {
            await User.findOneAndUpdate({ userId: Number(targetId) }, { isDelivering: false });
            ctx.reply(`✅ Lock cleared for user \`${targetId}\`.`);
        } catch (e) {
            ctx.reply(`❌ Error: ${e.message}`);
        }
    });
};
