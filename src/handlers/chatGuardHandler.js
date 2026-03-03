const { sendToLogChannel } = require('../utils/helpers');

function getUserNameForLog(user) {
    if (user.username) return `@${user.username}`;
    if (user.first_name) return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
    return `User ${user.id}`;
}

module.exports = (bot) => {
    // Welcome new members
    bot.on('my_chat_member', async (ctx) => {
        const groupId = process.env.GROUP_ID;
        if (!groupId || ctx.chat.id.toString() !== groupId) return;

        // Skip old events
        const eventDate = ctx.myChatMember.date * 1000;
        if (eventDate < global.botStartedAt) return;

        const status = ctx.myChatMember.new_chat_member.status;

        // User joined the group
        if (status === 'member' || status === 'administrator') {
            const user = ctx.myChatMember.new_chat_member.user;

            try {
                const welcomeKeyboard = new (require('grammy')).InlineKeyboard()
                    .text('📖 Step-by-Step Guide', 'welcome_guide')
                    .text('🎬 See All Movies', 'welcome_movies').row()
                    .text('❓ Help', 'welcome_help');

                await ctx.reply(
                    `👋 <b>WELCOME TO THE GROUP!</b>\n\n` +
                    `🎬 <b>Movie Clips Assistant</b> at your service!\n\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                    `🚀 <b>QUICK START:</b>\n` +
                    `1️⃣ Type any Movie Name here\n` +
                    `2️⃣ Tap the button I reply with\n` +
                    `3️⃣ Click the link in your PM\n` +
                    `4️⃣ All clips delivered instantly! 📬\n\n` +
                    `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                    `💡 <b>Example:</b> <code>Leo</code> • <code>Jawan</code>\n\n` +
                    `🎯 <b>Try it now!</b> Type a movie name below 👇`,
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
    bot.callbackQuery('welcome_guide', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `📖 <b>STEP-BY-STEP GUIDE</b>\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `🎬 <b>HOW TO GET CLIPS:</b>\n\n` +
            `1️⃣ <b>Search</b>\n` +
            `Type any movie name in this group\n` +
            `Example: <code>Leo</code> or <code>Oppenheimer</code>\n\n` +
            `2️⃣ <b>Get Button</b>\n` +
            `I'll reply with a button\n\n` +
            `3️⃣ <b>Click Button</b>\n` +
            `Tap the button I send\n\n` +
            `4️⃣ <b>Get Clips</b>\n` +
            `All clips open in your PM!\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `💡 <b>TIPS:</b>\n` +
            `• Type full movie name for best results\n` +
            `• Don't worry about spelling - I can fix typos!\n` +
            `• Use /filters to see all movies\n` +
            `• If not found, I'll suggest similar ones\n\n` +
            `❓ Need help? Type /help anytime!`,
            { parse_mode: 'HTML' }
        );
    });
    bot.callbackQuery('welcome_help', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `❓ <b>HELP & FAQ</b>\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `🎬 <b>How to get clips:</b>\n` +
            `1️⃣ Type movie name in group\n` +
            `2️⃣ Click the button I send\n` +
            `3️⃣ Get clips in your PM!\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `💡 <b>Commands:</b>\n` +
            `• <code>/filters</code> - See all movies\n` +
            `• <code>/help</code> - Show full help\n` +
            `• <code>/myprofile</code> - Your stats\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `❓ <b>FAQ:</b>\n\n` +
            `Q: Movie not found?\n` +
            `A: I'll suggest similar movies!\n\n` +
            `Q: Wrong spelling?\n` +
            `A: Don't worry! I fix typos automatically.\n\n` +
            `Q: Need help?\n` +
            `A: Contact admin anytime!`,
            { parse_mode: 'HTML' }
        );
    });

    bot.callbackQuery('welcome_movies', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `🎬 <b>ALL MOVIES LIST</b>\n\n` +
            `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
            `Type <code>/filters</code> to see everything we have!\n\n` +
            `💡 <b>PRO TIPS:</b>\n` +
            `• Use /filters to browse\n` +
            `• Or just type a movie name\n` +
            `• I fix your typos! ✨\n\n` +
            `🎯 <b>Happy searching!</b> 👆`,
            { parse_mode: 'HTML' }
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

            const userId = ctx.from.id;
            const text = ctx.message.text || ctx.message.caption || '';
            const isAdmin = ['administrator', 'creator'].includes((await ctx.getChatMember(userId)).status);

            if (isAdmin) return next();

            // Check if it's a bot command that mentions the bot itself (e.g., /filters@moxi_filters2_bot)
            const botUsername = process.env.BOT_USERNAME?.replace('@', '').toLowerCase();
            const isBotCommand = text.startsWith('/') && text.toLowerCase().includes(botUsername);

            if (isBotCommand) return next();

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
