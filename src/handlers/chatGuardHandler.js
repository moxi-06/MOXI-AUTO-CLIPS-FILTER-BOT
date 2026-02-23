const { sendToLogChannel } = require('../utils/helpers');

module.exports = (bot) => {
    // Welcome new members
    bot.on('my_chat_member', async (ctx) => {
        const groupId = process.env.GROUP_ID;
        if (!groupId || ctx.chat.id.toString() !== groupId) return;
        
        const status = ctx.myChatMember.new_chat_member.status;
        
        // User joined the group
        if (status === 'member' || status === 'administrator') {
            const user = ctx.myChatMember.new_chat_member.user;
            
            try {
                const welcomeKeyboard = new (require('grammy')).InlineKeyboard()
                    .text('📖 Help', 'welcome_help')
                    .text('🎬 Movies', 'welcome_movies');

                await ctx.reply(
                    `👋 <b>Welcome ${user.first_name}!</b>\n\n` +
                    `🎬 You're in our clips group!\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `💡 <b>How to use:</b>\n` +
                    `1️⃣ Type any movie name\n` +
                    `2️⃣ Click the button I send\n` +
                    `3️⃣ Get clips in your PM!\n\n` +
                    `Try now! Type <code>Leo</code> or <code>Jawan</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: welcomeKeyboard
                    }
                );
            } catch (e) {
                console.error('Welcome message error:', e);
            }
        }
    });

    // Handle welcome button clicks
    bot.callbackQuery('welcome_help', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `📖 <b>BOT HELP</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🎬 <b>How to get movies:</b>\n` +
            `1️⃣ Type movie name here\n` +
            `2️⃣ Click button I send\n` +
            `3️⃣ Get clips in PM!\n\n` +
            `💡 <b>Commands:</b>\n` +
            `• <code>/filters</code> - See all movies\n` +
            `• <code>/help</code> - Show help`,
            { parse_mode: 'HTML' }
        );
    });

    bot.callbackQuery('welcome_movies', async (ctx) => {
        await ctx.answerCallbackQuery();
        const groupId = process.env.GROUP_ID;
        await ctx.editMessageText(
            `🎬 <b>Ready to watch?</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Just type any movie name in the group!\n\n` +
            `Examples:\n` +
            `• <code>Leo</code>\n` +
            `• <code>Jawan</code>\n` +
            `• <code>Pathaan</code>\n\n` +
            `👇 <a href="https://t.me/${groupId?.replace('-100', '')}">Click to search</a>`,
            { parse_mode: 'HTML' }
        );
    });

    bot.on('message', async (ctx, next) => {
        const groupId = process.env.GROUP_ID;
        if (!groupId || ctx.chat.id.toString() !== groupId) return next();

        try {
            const userId = ctx.from.id;
            const text = ctx.message.text || ctx.message.caption || '';
            const isAdmin = ['administrator', 'creator'].includes((await ctx.getChatMember(userId)).status);

            if (isAdmin) return next();

            // 1. Link Detection (External URLs and Telegram Invites)
            const hasLink = /https?:\/\/[^\s]+/.test(text) || /t\.me\/(joinchat|\+)/.test(text);

            // 2. Blacklisted Keywords
            const blacklist = [
                'dm', 'msg me', 'buy', 'sell', 'adult', 'porn', 'sex', 'cheap',
                'promotion', 'subscribe', 'join my', 'referral', 'earn money',
                'botinvitelink', 'channelinvitelink', 'botusername'
            ];
            const hasBlacklist = blacklist.some(word => text.toLowerCase().includes(word));

            // 3. Bot/Channel Mentions (@usernames that are not the bot itself)
            const botUsername = process.env.BOT_USERNAME?.replace('@', '').toLowerCase();
            const hasForbiddenMention = /@\w+/.test(text) && !text.toLowerCase().includes(botUsername);

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
                        `👤 <b>User:</b> <code>${userId}</code> (@${ctx.from.username || 'N/A'})\n` +
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
