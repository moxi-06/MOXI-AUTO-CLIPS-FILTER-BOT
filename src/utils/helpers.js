const escapeHtml = (str) => {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
};

const safeAnswerCallbackQuery = async (ctx, options = {}) => {
    try {
        await ctx.answerCallbackQuery(options);
    } catch (e) {
        if (!e.message.includes('query is too old') && !e.message.includes('response timeout')) {
            throw e;
        }
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const cleanMovieName = (title) => {
    if (!title) return '';

    // 1. Standard trim and delimiter cleanup
    let raw = title.trim().replace(/[|\-]/g, ' ');

    let namePart = raw;
    let handlePart = '';

    // 2. Separate handle if exists (Shield it from noise filters)
    if (raw.includes('@')) {
        const parts = raw.split('@');
        namePart = parts[0].trim();
        handlePart = parts.slice(1).join('@').trim();
    }

    // 3. Remove common search noise from namePart ONLY
    const noisePatterns = [
        /download/gi, /full\s*movie/gi, /watch\s*online/gi, /tamil\s*dubbed/gi,
        /hindi\s*dubbed/gi, /web-dl/gi, /hdtv/gi, /720p/gi, /1080p/gi, /4k/gi,
        /clips/gi, /movierulz/gi, /isaimini/gi, /tamilyogi/gi, /kuttymovies/gi
    ];

    noisePatterns.forEach(pattern => {
        namePart = namePart.replace(pattern, '');
    });

    // 4. Reconstruct and Final normalization
    let finalTitle = namePart.trim();
    if (handlePart) {
        finalTitle = finalTitle ? `${finalTitle} - @${handlePart}` : `@${handlePart}`;
    }

    return finalTitle.replace(/\s+/g, ' ').trim().toLowerCase();
};

const extractMovieDetails = (title) => {
    let name = title;
    let credits = null;

    if (title && title.includes('@')) {
        const parts = title.split('@');
        name = parts[0].replace(/[\s\-]+$/, '').trim();
        credits = '@' + parts.slice(1).join('@').trim();
    }

    return { name, credits };
};

const encodeMovieLink = (movie) => {
    if (!movie) return '';
    // If movie object with _id or 24-char hex string, use compact m_<id>
    if (typeof movie === 'object' && movie._id) {
        return `m_${movie._id}`;
    }
    if (typeof movie === 'string' && /^[0-9a-fA-F]{24}$/.test(movie)) {
        return `m_${movie}`;
    }
    // Telegram restricts start payloads heavily (max 64 chars)
    return Buffer.from(String(movie)).toString('base64url');
};

const decodeMovieLink = (encodedName) => {
    if (!encodedName) return null;
    try {
        if (encodedName.startsWith('m_')) {
            return encodedName.substring(2);
        }
        return Buffer.from(encodedName, 'base64url').toString('utf-8');
    } catch {
        return null;
    }
};

const safeDeleteRoomMessages = async (api, roomId, messageIds) => {
    if (!messageIds || messageIds.length === 0 || !api || !roomId) return;
    for (let i = 0; i < messageIds.length; i += 100) {
        const batch = messageIds.slice(i, i + 100);
        try {
            await api.deleteMessages(roomId, batch);
        } catch (err) {
            // Batch delete fails if ANY message ID is invalid or already deleted.
            // Fall back to deleting individually to guarantee all clips are wiped!
            for (const mid of batch) {
                try {
                    await api.deleteMessage(roomId, mid);
                } catch (_) { }
            }
        }
        await sleep(250);
    }
};

const safeKickRoomUser = async (api, roomId, userId) => {
    if (!api || !roomId || !userId) return;
    try {
        await api.banChatMember(roomId, Number(userId));
        await sleep(350);
        await api.unbanChatMember(roomId, Number(userId));
    } catch (_) { }
};

const sendToLogChannel = async (botOrApi, message) => {
    const logChannelId = process.env.LOG_CHANNEL_ID;
    if (!logChannelId || !botOrApi || !message) return;
    try {
        const api = botOrApi.api || botOrApi;
        if (typeof api.sendMessage === 'function') {
            await api.sendMessage(logChannelId, message, { parse_mode: 'HTML' });
        }
    } catch (e) {
        // Silently catch so log channel errors never crash core bot operations
    }
};

module.exports = {
    escapeHtml,
    safeAnswerCallbackQuery,
    sleep,
    cleanMovieName,
    extractMovieDetails,
    encodeMovieLink,
    decodeMovieLink,
    sendToLogChannel,
    safeDeleteRoomMessages,
    safeKickRoomUser
};
