require('dotenv').config();
const { Bot, webhookCallback } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const express = require('express');
const axios = require('axios');
const { Movie } = require('./src/database');

const { connectDB, Room, Movie: MovieModel, BotSettings } = require('./src/database');

const adminHandler = require('./src/handlers/adminHandler');
const indexHandler = require('./src/handlers/indexHandler');
const chatGuardHandler = require('./src/handlers/chatGuardHandler');
const searchHandler = require('./src/handlers/searchHandler');
const deliveryHandler = require('./src/handlers/deliveryHandler');
const { safeDeleteRoomMessages, safeKickRoomUser } = require('./src/utils/helpers');
const { initAutoDeleteManager } = require('./src/utils/autoDeleteManager');

// Global stats for live tracking
global.todayStats = {
    deliveries: 0,
    searches: 0,
    date: new Date().toDateString()
};
global.botStartedAt = Date.now();

// Rate limiting helper
const rateLimiter = {
    lastRequest: 0,
    minInterval: 1000, // 1 second between requests

    async wait() {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequest;
        if (timeSinceLast < this.minInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLast));
        }
        this.lastRequest = Date.now();
    }
};

// Graceful shutdown handler
process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Reset daily stats at midnight
setInterval(() => {
    try {
        const today = new Date().toDateString();
        if (global.todayStats.date !== today) {
            global.todayStats = { deliveries: 0, searches: 0, date: today };
            console.log('📊 Daily stats reset');
        }
    } catch (e) {
        console.error('Stats reset error:', e.message);
    }
}, 60 * 60 * 1000); // Check every hour

// Load persisted settings from DB into process.env on startup
async function loadPersistedSettings() {
    try {
        const apiKey = await BotSettings.findOne({ key: 'shortlinkApiKey' });
        const baseUrl = await BotSettings.findOne({ $or: [{ key: 'shortlinkBaseUrl' }, { key: 'shortlinkBase' }] });
        if (apiKey && apiKey.value) process.env.SHORTLINK_API_KEY = apiKey.value;
        if (baseUrl && baseUrl.value) process.env.SHORTLINK_BASE_URL = baseUrl.value;
        console.log('✅ Persisted settings loaded from DB.');
    } catch (e) {
        console.warn('⚠️ Could not load persisted settings:', e.message);
    }
}

async function bootstrap() {
    // 1. Connect to MongoDB
    try {
        await connectDB();
        console.log('✅ MongoDB connected');
    } catch (err) {
        console.error('❌ MongoDB connection failed:', err.message);
        process.exit(1);
    }

    // 2. Load persisted shortlink settings from MongoDB into process.env
    await loadPersistedSettings();

    if (!process.env.BOT_TOKEN) {
        console.error('Error: BOT_TOKEN is missing in environment variables.');
        process.exit(1);
    }

    // 2. Initialize GramMY Bot instance
    const bot = new Bot(process.env.BOT_TOKEN);

    // Automatically handle 429 RetryAfter requests from Telegram
    bot.api.config.use(autoRetry({
        maxRetryAttempts: 5,
        maxDelaySeconds: 120
    }));

    // Initialize 1-Hour Auto-Delete Manager for all messages sent to users
    initAutoDeleteManager(bot);

    // 3. Register route handlers
    chatGuardHandler(bot);   // Handles group protection, anti-spam, and welcome
    adminHandler(bot);       // Handles group, channel, and global bot commands
    indexHandler(bot);       // Listens in DB channel to map messages to movies
    searchHandler(bot);      // Listens in groups for movie title queries
    deliveryHandler(bot);    // Handles /start payloads in PMs 

    // General error handler - never let bot crash
    bot.catch((err) => {
        const updateId = err.ctx?.update?.update_id || 'unknown';
        const errorMessage = err.error?.message || err.toString();

        console.error(`⚠️ Error on update ${updateId}:`, errorMessage);

        // Handle rate limit errors specifically
        if (errorMessage.includes('Too Many Requests') || errorMessage.includes('429')) {
            console.warn('⏳ Rate limited! Waiting and retrying...');
        }
    });

    // 4. Determine execution mode (Webhook for Koyeb vs Polling for Local)
    const rawPort = process.env.PORT || '3000';
    const PORT = parseInt(rawPort.toString().trim(), 10);
    const WEBHOOK_URL = process.env.WEBHOOK_URL;

    if (WEBHOOK_URL) {
        const app = express();
        app.use(express.json());

        // Simple healthcheck to keep cloud instance awake
        app.get('/', (req, res) => res.send('✅ Bot is running!'));

        // Clean WEBHOOK_URL (remove trailing slash)
        let cleanedWebhookUrl = WEBHOOK_URL.trim();
        if (cleanedWebhookUrl.endsWith('/')) {
            cleanedWebhookUrl = cleanedWebhookUrl.slice(0, -1);
        }

        // GramMY Express Webhook Adapter
        app.post(`/${bot.token}`, webhookCallback(bot, 'express'));

        app.listen(PORT, '0.0.0.0', async () => {
            console.log(`🤖 Express server listening on: 0.0.0.0:${PORT} (${process.env.PORT ? 'ENV' : 'DEFAULT'})`);
            if (PORT !== 3000 && PORT !== 80) {
                console.log(`💡 NOTE: If Koyeb health checks fail, ensure your dashboard "Internal Port" matches ${PORT}.`);
            }
            try {
                const finalWebhookPath = `${cleanedWebhookUrl}/${bot.token}`;
                console.log(`📡 Setting webhook to: ${cleanedWebhookUrl}/<TOKEN_HIDDEN>`);

                await bot.api.setWebhook(finalWebhookPath);
                console.log(`✅ Webhook registration successful!`);

                // Self-Pinging mechanism every 90 seconds to keep cloud server awake
                setInterval(async () => {
                    try {
                        await axios.get(cleanedWebhookUrl, { timeout: 10000 });
                    } catch (err) {
                        console.warn('⚠️ Self-ping failed:', err.message);
                    }
                }, 90 * 1000); // 90 seconds

            } catch (err) {
                console.error('❌ Failed to set webhook:', err.message);
                console.error('💡 TIP: Ensure your WEBHOOK_URL includes https:// and is your public Koyeb app URL.');
            }
        });
    } else {
        console.log('📡 No WEBHOOK_URL defined. Starting local long-polling...');

        bot.start({
            onStart: (botInfo) => {
                console.log(`✅ Bot @${botInfo.username} is now online in polling mode.`);
                if (!process.env.BOT_USERNAME) {
                    process.env.BOT_USERNAME = botInfo.username;
                }
            }
        });
    }

    // --- Bot Startup: Robust Cleanup & Reset of All Rooms ---
    async function cleanupAllRoomsOnStartup() {
        try {
            console.log('🧹 Cleaning and resetting all rooms on startup...');
            const rooms = await Room.find();

            for (const room of rooms) {
                if (room.currentUserId) {
                    await safeKickRoomUser(bot.api, room.roomId, room.currentUserId);
                }
                if (room.lastMessageIds && room.lastMessageIds.length > 0) {
                    await safeDeleteRoomMessages(bot.api, room.roomId, room.lastMessageIds);
                }
            }

            // Reset all rooms state
            await Room.updateMany({}, { lastMessageIds: [], currentUserId: null, isBusy: false });
            console.log('✅ All rooms fully sanitized and reset on startup');
        } catch (error) {
            console.error('❌ Startup cleanup error:', error.message);
        }
    }
    cleanupAllRoomsOnStartup();

    // --- Reusable Room Sanitization & Cleanup Function ---
    async function cleanupFreeRooms() {
        try {
            // Check for rooms idle past the 30-minute grace period (+5 min buffer) or marked free with leftover messages
            const thirtyFiveMinsAgo = new Date(Date.now() - 35 * 60 * 1000);
            const expiredRooms = await Room.find({
                $or: [
                    { isBusy: true, lastUsed: { $lte: thirtyFiveMinsAgo } },
                    { isBusy: false, lastMessageIds: { $exists: true, $not: { $size: 0 } } },
                    { lastMessageIds: { $exists: true, $not: { $size: 0 } }, lastUsed: { $lte: thirtyFiveMinsAgo } }
                ]
            });

            for (const room of expiredRooms) {
                if (room.currentUserId) {
                    await safeKickRoomUser(bot.api, room.roomId, room.currentUserId);
                }
                if (room.lastMessageIds && room.lastMessageIds.length > 0) {
                    await safeDeleteRoomMessages(bot.api, room.roomId, room.lastMessageIds);
                }
                room.isBusy = false;
                room.currentUserId = null;
                room.lastMessageIds = [];
                await room.save();
                console.log(`🧹 Sanitized and reset room ${room.roomId}`);
            }
        } catch (error) {
            console.error('❌ Room Cleanup Error:', error.message);
        }
    }

    // --- Automatic Background Room Sanitization Watchdog (Runs Every 30 Minutes) ---
    // Guarantees no room ever stays dirty or stuck with leftover files!
    setInterval(cleanupFreeRooms, 30 * 60 * 1000); // Check every 30 minutes

    // --- Group Auto-Promoter (Every 5 hours) with rate limiting ---
    const GROUP_ID = process.env.GROUP_ID;
    if (GROUP_ID) {
        const FIVE_HOURS = 5 * 60 * 60 * 1000;
        let promoInProgress = false;

        const postPromotionalMessage = async () => {
            if (promoInProgress) return;
            promoInProgress = true;

            try {
                await rateLimiter.wait(); // Rate limit protection

                const promoMessages = [
                    `🎬 <b>Need movie clips?</b> Type any title in this chat to get clips in PM! 🍿\n💡 <i>Try <code>/random</code> for a surprise pick!</i>`,
                    `✨ <b>Quick Search:</b> Send any movie name here and get clips delivered! 🚀\n🔥 <i>Use <code>/trending</code> to see top requested titles!</i>`,
                    `🎥 <b>Looking for clips?</b> Type a movie name and tap the button! 📲\n📚 <i>Type <code>/filters</code> to browse our collection!</i>`
                ];

                const randomMsg = promoMessages[Math.floor(Math.random() * promoMessages.length)];

                const sent = await bot.api.sendMessage(GROUP_ID, randomMsg, { parse_mode: 'HTML' });

                // Auto-delete after 1 hour
                setTimeout(async () => {
                    try {
                        await bot.api.deleteMessage(GROUP_ID, sent.message_id);
                    } catch (_) { }
                }, 60 * 60 * 1000);

                // Run room cleanup after promo message is sent
                await cleanupFreeRooms();

                console.log('📢 Promotional message posted in group');
            } catch (error) {
                console.error('❌ Auto-promoter error:', error.message);
            } finally {
                promoInProgress = false;
            }
        };

        // Post first promo after 5 minutes, then every 5 hours
        setTimeout(postPromotionalMessage, 5 * 60 * 1000);
        setInterval(postPromotionalMessage, FIVE_HOURS);
    }

}

bootstrap().catch(err => {
    console.error('🔥 Fatal application error:', err);
    // Don't exit immediately, try to recover
    setTimeout(() => process.exit(1), 5000);
});
