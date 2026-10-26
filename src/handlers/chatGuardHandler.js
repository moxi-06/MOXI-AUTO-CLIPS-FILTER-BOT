const { sendToLogChannel } = require('../utils/helpers');
const { InlineKeyboard } = require('grammy');

function getUserNameForLog(user) {
    if (user.username) return `@${user.username}`;
    if (user.first_name) return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
    return `User ${user.id}`;
}

const getWelcomeKeyboard = () => new InlineKeyboard()
    .text('📖 Guide', 'welcome_guide')
    .text('🎬 All Movies', 'welcome_movies').row()
    .text('❓ Help', 'welcome_help');

module.exports = (bot) => {
    // Universal Close Message Handler (Instantly deletes message on tap)
    bot.callbackQuery(['close_msg', 'delete_msg', 'close'], async (ctx) => {
        try {
            await ctx.answerCallbackQuery();
            await ctx.deleteMessage();
        } catch (_) { }
    });

    const sendWelcome = async (ctx, user) => {
        if (!user || (ctx.me && user.id === ctx.me.id)) return;

        // Log new group member
        await sendToLogChannel(bot, `👥 <b>New Member:</b> ${getUserNameForLog(user)} (<code>${user.id}</code>)`);

        try {
            const welcomeKeyboard = getWelcomeKeyboard();

            await ctx.reply(
                `👋 <b>Welcome to the Movie Group!</b> 🍿\n\n` +
                `🎬 <b>How to get clips:</b>\n` +
                `• Type any movie title in this chat\n` +
                `• Tap the button on my reply to get clips in PM!\n\n` +
                `💡 <i>Example: <code>Leo</code> or <code>Jawan</code></i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: welcomeKeyboard
                }
            );
        } catch (e) {
            console.error('Welcome message error:', e.message);
        }
    };

    // Welcome new members when joining group
    bot.on('message:new_chat_members', async (ctx) => {
        const groupId = process.env.GROUP_ID;
        if (!groupId || ctx.chat.id.toString() !== groupId) return;
        if (ctx.message.date * 1000 < global.botStartedAt) return;

        for (const user of ctx.message.new_chat_members) {
            await sendWelcome(ctx, user);
        }
    });

    // Also handle chat_member status change if bot is group admin
    bot.on('chat_member', async (ctx) => {
        const groupId = process.env.GROUP_ID;
        if (!groupId || ctx.chat.id.toString() !== groupId) return;

        const oldStatus = ctx.chatMember.old_chat_member.status;
        const newStatus = ctx.chatMember.new_chat_member.status;

        if (['left', 'kicked'].includes(oldStatus) && ['member', 'administrator'].includes(newStatus)) {
            await sendWelcome(ctx, ctx.chatMember.new_chat_member.user);
        }
    });

    // Handle welcome button clicks
    bot.callbackQuery('welcome_guide', async (ctx) => {
        await ctx.answerCallbackQuery();
        const navKeyboard = new InlineKeyboard()
            .text('🔙 « Back', 'welcome_home');

        await ctx.editMessageText(
            `📖 <b>How to Get Clips:</b>\n\n` +
            `1️⃣ <b>Search:</b> Type any movie name in this chat\n` +
            `2️⃣ <b>Open:</b> Tap the button on my reply\n` +
            `3️⃣ <b>Enjoy:</b> Get all clips delivered directly in PM!\n\n` +
            `💡 <i>Tip: We auto-correct typos & spelling mistakes!</i>`,
            { parse_mode: 'HTML', reply_markup: navKeyboard }
        );
    });

    bot.callbackQuery('welcome_help', async (ctx) => {
        await ctx.answerCallbackQuery();
        const navKeyboard = new InlineKeyboard()
            .text('🔙 « Back', 'welcome_home');

        await ctx.editMessageText(
            `❓ <b>Quick Help & Commands:</b>\n\n` +
            `• <code>/filters</code> — Browse all indexed movies\n` +
            `• <code>/trending</code> — See top requested movies\n` +
            `• <code>/random</code> — Get a surprise movie pick\n` +
            `• <code>/myprofile</code> — Check your clips & token stats\n\n` +
            `💡 <i>Type any movie title directly in group to search!</i>`,
            { parse_mode: 'HTML', reply_markup: navKeyboard }
        );
    });

    bot.callbackQuery('welcome_movies', async (ctx) => {
        await ctx.answerCallbackQuery();
        const navKeyboard = new InlineKeyboard()
            .text('🔙 « Back', 'welcome_home');

        await ctx.editMessageText(
            `🎬 <b>All Movies:</b>\n\n` +
            `Send <code>/filters</code> to browse our complete collection!\n\n` +
            `💡 <i>Or simply type any movie title directly in this chat.</i>`,
            { parse_mode: 'HTML', reply_markup: navKeyboard }
        );
    });

    bot.callbackQuery('welcome_home', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `👋 <b>Welcome to the Movie Group!</b> 🍿\n\n` +
            `🎬 <b>How to get clips:</b>\n` +
            `• Type any movie title in this chat\n` +
            `• Tap the button on my reply to get clips in PM!\n\n` +
            `💡 <i>Example: <code>Leo</code> or <code>Jawan</code></i>`,
            { parse_mode: 'HTML', reply_markup: getWelcomeKeyboard() }
        );
    });

    bot.on('message', async (ctx, next) => {
        const groupId = process.env.GROUP_ID;
        if (!groupId || ctx.chat.id.toString() !== groupId) return next();

        // Skip old messages
        const messageDate = ctx.message.date * 1000;
        if (messageDate < global.botStartedAt) {
            return next();
        }

        try {
            // Skip channel posts (admin posting on behalf of channel)
            if (ctx.message.sender_chat && ctx.message.sender_chat.id !== ctx.chat.id) {
                return next();
            }

            const text = ctx.message.text || ctx.message.caption || '';
            const userId = ctx.from.id;

            // Check if admin FIRST - before anything else
            try {
                const chatMember = await ctx.getChatMember(userId);
                if (chatMember && ['administrator', 'creator'].includes(chatMember.status)) {
                    return next(); // Admin is allowed everything
                }
            } catch (e) {
                console.log('[ChatGuard] Could not check admin status:', e.message);
            }

            // Allow ALL bot commands (any command starting with /)
            if (text.startsWith('/')) {
                return next();
            }

            // Allow mentions of the bot itself
            const botUsername = process.env.BOT_USERNAME?.replace('@', '').toLowerCase();
            if (botUsername && text.toLowerCase().includes(botUsername)) {
                return next();
            }

            // 1. Link Detection (External URLs and Telegram Invites)
            const hasLink = /https?:\/\/[^\s]+/.test(text) || /t\.me\/(joinchat|\+)/.test(text);

            // 2. Blacklisted Keywords
            const blacklist = [
                'dm', 'msg me', 'buy', 'sell', 'adult', 'porn', 'sex', 'cheap',
                'promotion', 'subscribe', 'join my', 'referral', 'earn money'
            ];
            const hasBlacklist = blacklist.some(word => text.toLowerCase().includes(word));

            // 3. Other @mentions (not the bot)
            const hasForbiddenMention = /@\w+/.test(text) && (!botUsername || !text.toLowerCase().includes(botUsername));

            if (hasLink || hasBlacklist || hasForbiddenMention) {
                try {
                    await ctx.deleteMessage();
                    console.log(`[ChatGuard] Deleted message from ${userId} for spam rules.`);

                    // Log to channel
                    let reason = '';
                    if (hasLink) reason = 'External Link/Invite';
                    else if (hasBlacklist) reason = 'Blacklisted Keyword';
                    else if (hasForbiddenMention) reason = 'Unauthorized Mention';

                    await sendToLogChannel(bot,
                        `🚫 <b>Chat Guard: Message Deleted</b>\n` +
                        `👤 <b>User:</b> ${getUserNameForLog(ctx.from)} (<code>${userId}</code>)\n` +
                        `📝 <b>Content:</b> <code>${text.substring(0, 100)}...</code>\n` +
                        `⚖️ <b>Reason:</b> ${reason}`
                    );
                } catch (e) {
                    console.error('[ChatGuard] Failed to delete message:', e.message);
                }
                return; // Stop processing
            }

        } catch (error) {
            console.error('[ChatGuard] Error:', error);
        }

        return next();
    });
};
