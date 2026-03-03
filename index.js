require('dotenv').config();
const { Bot, webhookCallback } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const express = require('express');
const axios = require('axios');
const { Movie } = require('./src/database');

const { connectDB, Room, Movie: MovieModel, BotSettings } = require('./src/database');

const adminHandler = require('./src/handlers/adminHandler');
const indexHandler = require('./src/handlers/indexHandler');
const searchHandler = require('./src/handlers/searchHandler');
const deliveryHandler = require('./src/handlers/deliveryHandler');
const chatGuardHandler = require('./src/handlers/chatGuardHandler');

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
        const baseUrl = await BotSettings.findOne({ key: 'shortlinkBase' });
        if (apiKey) process.env.SHORTLINK_API_KEY = apiKey.value;
        if (baseUrl) process.env.SHORTLINK_BASE_URL = baseUrl.value;
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

    // 3. Register route handlers
    chatGuardHandler(bot);   // Protections (must run early)
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

    // --- Bot Startup: Clean all rooms ---
    async function cleanupAllRoomsOnStartup() {
        try {
            console.log('🧹 Cleaning all rooms on startup...');
            const rooms = await Room.find({ isBusy: false });
            
            for (const room of rooms) {
                if (room.lastMessageIds && room.lastMessageIds.length > 0) {
                    try {
                        // Delete messages in batches
                        for (let i = 0; i < room.lastMessageIds.length; i += 100) {
                            try {
                                await bot.api.deleteMessages(room.roomId, room.lastMessageIds.slice(i, i + 100));
                            } catch (_) { }
                        }
                        console.log(`✅ Cleaned room ${room.roomId}`);
                    } catch (e) {
                        console.error(`❌ Failed to clean room ${room.roomId}:`, e.message);
                    }
                }
            }
            
            // Reset all rooms
            await Room.updateMany({}, { lastMessageIds: [], currentUserId: null, isBusy: false });
            console.log('✅ All rooms reset and cleaned on startup');
        } catch (error) {
            console.error('❌ Startup cleanup error:', error.message);
        }
    }
    cleanupAllRoomsOnStartup();

    // --- Automatic MongoDB Database Cleanup ---
    setInterval(async () => {
        try {
            console.log('🧹 Running background database cleanup for stuck rooms...');

            const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
            const freedRooms = await Room.updateMany(
                { isBusy: true, lastUsed: { $lte: sixHoursAgo } },
                { isBusy: false, currentUserId: null, lastMessageIds: [] }
            );

            console.log(`✅ Cleanup finished: Freed ${freedRooms.modifiedCount} stuck rooms.`);
        } catch (error) {
            console.error('❌ DB Cleanup Error:', error.message);
        }
    }, 24 * 60 * 60 * 1000);

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

                const topMovies = await MovieModel.find().sort({ requests: -1 }).limit(5);

                let topMoviesText = '';
                if (topMovies.length > 0) {
                    topMoviesText = '\n\n🔥 <b>Top 5 Trending:</b>\n';
                    topMovies.forEach((m, i) => {
                        topMoviesText += `${i + 1}. ${m.title} (${m.requests})\n`;
                    });
                }

                const promoMessages = [
                    `🎬 <b>Need clips?</b>\n\nJust type the movie name and I'll send clips to your PM! 🍿`,
                    `✨ <b>Looking for clips?</b>\n\nSearch in group and get clips! 🚀`,
                    `🎥 <b>Want latest clips?</b>\n\nType movie name and tap the link! 📲${topMoviesText}`,
                    `🔥 <b>Quick Tip:</b>\n\nType any movie name and I'll deliver to your PM! 🎬`
                ];

                const randomMsg = promoMessages[Math.floor(Math.random() * promoMessages.length)];

                const sent = await bot.api.sendMessage(GROUP_ID, randomMsg, { parse_mode: 'HTML' });

                // Auto-delete after 1 hour
                setTimeout(async () => {
                    try {
                        await bot.api.deleteMessage(GROUP_ID, sent.message_id);
                    } catch (_) { }
                }, 60 * 60 * 1000);

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
