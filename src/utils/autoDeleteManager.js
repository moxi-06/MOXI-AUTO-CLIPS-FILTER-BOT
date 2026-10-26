// 100% Pure In-Memory Auto-Delete Engine (Zero MongoDB Usage)
// Default lifetime for user PM messages: 1 Hour (3,600,000 milliseconds)
const ONE_HOUR_MS = 60 * 60 * 1000;
const activeTimeouts = new Map(); // key: `${chatId}:${messageId}` -> timeoutHandle

/**
 * Schedule a message for auto-deletion purely in-memory
 */
function scheduleAutoDelete(api, chatId, messageId, delayMs = ONE_HOUR_MS) {
    if (!api || !chatId || !messageId) return;
    const chatIdStr = String(chatId);
    const msgIdNum = Number(messageId);
    if (isNaN(msgIdNum) || msgIdNum <= 0) return;

    const key = `${chatIdStr}:${msgIdNum}`;

    // Clear existing timer if rescheduled
    if (activeTimeouts.has(key)) {
        clearTimeout(activeTimeouts.get(key));
    }

    // Set lightweight in-memory timer
    const timer = setTimeout(async () => {
        activeTimeouts.delete(key);
        await deleteNow(api, chatIdStr, msgIdNum);
    }, delayMs);

    // Prevent timer from holding Node.js process alive on graceful shutdown
    if (timer.unref) {
        timer.unref();
    }

    activeTimeouts.set(key, timer);
}

/**
 * Delete message immediately from Telegram and clear in-memory timer
 */
async function deleteNow(api, chatId, messageId) {
    const chatIdStr = String(chatId);
    const msgIdNum = Number(messageId);
    const key = `${chatIdStr}:${msgIdNum}`;

    if (activeTimeouts.has(key)) {
        clearTimeout(activeTimeouts.get(key));
        activeTimeouts.delete(key);
    }

    try {
        await api.deleteMessage(chatIdStr, msgIdNum);
    } catch (_) {
        // Safe fail: message might have already been deleted or closed by user
    }
}

/**
 * Initialize pure in-memory auto-delete manager with the Grammy bot instance.
 * Attaches outgoing API transformer so EVERY message sent to private user chats
 * is automatically scheduled for 1-hour deletion without touching MongoDB.
 */
function initAutoDeleteManager(bot) {
    bot.api.config.use(async (prev, method, payload, signal) => {
        const data = await prev(method, payload, signal);

        try {
            if (data && data.ok && data.result && payload && payload.chat_id) {
                const chatIdStr = String(payload.chat_id);
                // Private user chats have positive chat IDs. Groups and channels start with '-'
                if (!chatIdStr.startsWith('-')) {
                    if (method === 'sendMediaGroup' && Array.isArray(data.result)) {
                        for (const m of data.result) {
                            if (m && m.message_id) {
                                scheduleAutoDelete(bot.api, chatIdStr, m.message_id, ONE_HOUR_MS);
                            }
                        }
                    } else if (data.result.message_id) {
                        scheduleAutoDelete(bot.api, chatIdStr, data.result.message_id, ONE_HOUR_MS);
                    }
                }
            }
        } catch (_) { }

        return data;
    });

    console.log('⚡ Pure in-memory auto-delete active (1-Hour auto-deletion, 0% MongoDB usage).');
}

module.exports = {
    scheduleAutoDelete,
    deleteNow,
    initAutoDeleteManager,
    ONE_HOUR_MS
};
