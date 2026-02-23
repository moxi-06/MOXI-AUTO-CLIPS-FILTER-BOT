const { Movie, Room, User, Token } = require('../database');
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
    'addmovie', 'deletemovie', 'addcategory', 'stats', 'filters', 'top',
    'addroom', 'rooms', 'cleanroom', 'broadcast', 'maintenance',
    'logs', 'restartrooms', 'settings', 'setmode', 'setshortlink',
    'setapikey', 'setforcesub', 'unsetforcesub'
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
        if (ctx.chat.type === 'private') {
            await ctx.reply(
                `📖 <b>BOT HELP GUIDE</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🎬 <b>HOW TO GET MOVIES:</b>\n\n` +
                `1️⃣ Join our group\n` +
                `2️⃣ Type movie name\n` +
                `3️⃣ Click button I send\n` +
                `4️⃣ Get clips in your PM! 📬\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `💡 <b>USEFUL COMMANDS:</b>\n\n` +
                `• <code>/start</code> - Start the bot\n` +
                `• <code>/help</code> - Show this help\n` +
                `• <code>/filters</code> - See all movies (in group)\n` +
                `• <code>/myprofile</code> - Your stats & badges\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `❓ <b>NEED HELP?</b>\n` +
                `Contact admin if you face any problem!`,
                { parse_mode: 'HTML' }
            );
        } else {
            await ctx.reply(
                `📖 <b>GROUP HELP</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🎬 <b>HOW TO USE:</b>\n\n` +
                `✅ Just type any movie name!\n` +
                `Example: <code>Leo</code> or <code>Jawan</code>\n\n` +
                `💡 <b>OTHER COMMANDS:</b>\n\n` +
                `• <code>filters</code> or <code>/filters</code> - See all movies\n` +
                `• <code>list</code> - See movies list\n` +
                `• <code>clips</code> - See all clips\n\n` +
                `👆 Tap any movie from list to get clips!`,
                { parse_mode: 'HTML' }
            );
        }
    });

    // User profile with badges
    bot.command('myprofile', async (ctx) => {
        try {
            const user = await User.findOne({ userId: ctx.from.id });
            
            if (!user) {
                return ctx.reply(
                    `👤 <b>Your Profile</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `🔍 Searches: 0\n` +
                    `📥 Downloads: 0\n\n` +
                    `🎖️ Badges: None yet!\n\n` +
                    `💡 Start searching movies to earn badges!`,
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

            ctx.reply(
                `👤 <b>Your Profile</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🔍 <b>Searches:</b> ${user.searchCount || 0}\n` +
                `📥 <b>Downloads:</b> ${user.downloadCount || 0}\n\n` +
                `🎖️ <b>Your Badges:</b>\n${badges}\n${progress}`,
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
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
        
        // Growth Analytics
        const now = new Date();
        const last24h = new Date(now - 24 * 60 * 60 * 1000);
        const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
        
        const usersLast24h = await User.countDocuments({ joinedAt: { $gte: last24h } });
        const usersLast7d = await User.countDocuments({ joinedAt: { $gte: last7d } });
        
        const churnRate = global.broadcastStats.total > 0 
            ? Math.round((global.broadcastStats.blocked / global.broadcastStats.total) * 100) 
            : 0;
        
        const keyboard = new InlineKeyboard().text('🔄 Refresh', 'stats_refresh');

        ctx.reply(
            `📊 <b>SYSTEM STATISTICS</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🎬 <b>Total Movies:</b> ${totalMovies}\n` +
            `👤 <b>Total Users:</b> ${totalUsers}\n\n` +
            `📈 <b>Growth Analytics</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🕐 <b>New Users (24h):</b> ${usersLast24h}\n` +
            `📅 <b>New Users (7d):</b> ${usersLast7d}\n` +
            `📉 <b>Churn Rate:</b> ${churnRate}%\n\n` +
            `📂 <i>Type /filters to see all movies.</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });

    bot.command('filters', async (ctx) => {
        const movies = await Movie.find().sort({ title: 1 });
        if (movies.length === 0) return ctx.reply('📭 No movie filters found.');

        let text = '📂 <b>DATABASE FILTERS</b>\n━━━━━━━━━━━━━━━━━━━━\n';
        movies.forEach((m, i) => {
            const count = m.files?.length || m.messageIds.length;
            text += `🔹 ${i + 1}. <b>${m.title}</b> (<code>${count} clips</code>)\n`;
        });

        const footer = `\n━━━━━━━━━━━━━━━━━━━━\n✨ Total Filters: <b>${movies.length}</b>`;
        text += footer;

        if (text.length > 4000) {
            const chunks = text.match(/[\s\S]{1,4000}/g);
            for (const chunk of chunks) {
                await ctx.reply(chunk, { parse_mode: 'HTML' });
            }
        } else {
            ctx.reply(text, { parse_mode: 'HTML' });
        }
    });

    bot.command('top', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const topMovies = await Movie.find().sort({ requests: -1 }).limit(10);
        
        if (topMovies.length === 0) {
            return ctx.reply('📭 No movies yet!');
        }

        const keyboard = new InlineKeyboard();
        topMovies.forEach((m, i) => {
            const icon = i === 0 ? '👑' : '🎬';
            keyboard.text(`${icon} ${m.title}`, `top_${m.title}`).row();
        });

        let text = '🔥 <b>TOP 10 TRENDING MOVIES</b>\n━━━━━━━━━━━━━━━━━━━━\n';
        topMovies.forEach((m, i) => text += `${i === 0 ? '👑' : '🔸'} ${i + 1}. <b>${m.title}</b> — <code>${m.requests} searches</code>\n`);
        text += '\n👆 Tap any movie to get clips!';

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
                await ctx.api.banChatMember(roomId, room.currentUserId);
                await sleep(500);
                await ctx.api.unbanChatMember(roomId, room.currentUserId);
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
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
            `━━━━━━━━━━━━━━━━━━━━\n` +
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
            `━━━━━━━━━━━━━━━━━━━━\n` +
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

    // --- Monetization Settings ---
    bot.command('settings', async (ctx) => {
        if (!isAdmin(ctx)) return;
        const mode = await getSetting('mode', 'off');
        const shortlinkBase = await getSetting('shortlinkBase', 'Not Set');
        const forceSubChannel = await getSetting('forceSubChannel', 'Not Set');
        const modeIcon = { off: '🟢 Free', shortlink: '🔗 Shortlink', token: '🎫 Token' };

        ctx.reply(
            `⚙️ <b>ADMIN SETTINGS PANEL</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📂 <b>Mode:</b> ${modeIcon[mode] || mode}\n` +
            `🔗 <b>API URL:</b> <code>${shortlinkBase}</code>\n` +
            `📢 <b>Force Sub:</b> <code>${forceSubChannel}</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
        const labels = { off: '🟢 Free Access', shortlink: '🔗 Shortlink Mode', token: '🎫 Token Mode' };
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
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
        
        const now = new Date();
        const last24h = new Date(now - 24 * 60 * 60 * 1000);
        const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
        
        const usersLast24h = await User.countDocuments({ joinedAt: { $gte: last24h } });
        const usersLast7d = await User.countDocuments({ joinedAt: { $gte: last7d } });
        
        const churnRate = global.broadcastStats.total > 0 
            ? Math.round((global.broadcastStats.blocked / global.broadcastStats.total) * 100) 
            : 0;
        
        const keyboard = new InlineKeyboard().text('🔄 Refresh', 'stats_refresh');

        await ctx.editMessageText(
            `📊 <b>SYSTEM STATISTICS</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🎬 <b>Total Movies:</b> ${totalMovies}\n` +
            `👤 <b>Total Users:</b> ${totalUsers}\n\n` +
            `📈 <b>Growth Analytics</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🕐 <b>New Users (24h):</b> ${usersLast24h}\n` +
            `📅 <b>New Users (7d):</b> ${usersLast7d}\n` +
            `📉 <b>Churn Rate:</b> ${churnRate}%\n\n` +
            `📂 <i>Type /filters to see all movies.</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    });
};
