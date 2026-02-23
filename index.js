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
    const PORT = process.env.PORT || 3000;
    const WEBHOOK_URL = process.env.WEBHOOK_URL;

    if (WEBHOOK_URL) {
        const app = express();
        app.use(express.json());

        // Simple healthcheck to keep cloud instance awake
        app.get('/', (req, res) => res.send('✅ Bot is running!'));

        // GramMY Express Webhook Adapter
        app.post(`/${bot.token}`, webhookCallback(bot, 'express'));

        app.listen(PORT, async () => {
            console.log(`🤖 Express server started on port ${PORT}`);
            try {
                await bot.api.setWebhook(`${WEBHOOK_URL}/${bot.token}`);
                console.log(`✅ Webhook set successfully to target ${WEBHOOK_URL}`);

                // Self-Pinging mechanism every 90 seconds to keep cloud server awake
                setInterval(async () => {
                    try {
                        await axios.get(WEBHOOK_URL, { timeout: 10000 });
                    } catch (err) {
                        console.warn('⚠️ Self-ping failed:', err.message);
                    }
                }, 90 * 1000); // 90 seconds

            } catch (err) {
                console.error('❌ Failed to set webhook:', err.message);
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
                    `✨ <b>Looking for clips?</b>\n\nSearch in group and get instant access! 🚀`,
                    `🎥 <b>Want latest clips?</b>\n\nType movie name and tap the link! 📲${topMoviesText}`,
                    `🔥 <b>Quick Tip:</b>\n\nType any movie name and I'll deliver to your PM! 🎬`
                ];

                const randomMsg = promoMessages[Math.floor(Math.random() * promoMessages.length)];
                
                const sent = await bot.api.sendMessage(GROUP_ID, randomMsg, { parse_mode: 'HTML' });
                
                // Auto-delete after 2 minutes
                setTimeout(async () => {
                    try {
                        await bot.api.deleteMessage(GROUP_ID, sent.message_id);
                    } catch (_) {}
                }, 2 * 60 * 1000);

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
