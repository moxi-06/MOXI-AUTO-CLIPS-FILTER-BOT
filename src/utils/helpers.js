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

const encodeMovieLink = (movieName) => {
    // encode for start payload (max 64 chars, a-zA-Z0-9_- allowed)
    // Telegram restricts start payloads heavily.
    // Instead of full text, we can use base64 encoding, but base64 might have invalid chars (+, =)
    return Buffer.from(movieName).toString('base64url');
};

const decodeMovieLink = (encodedName) => {
    try {
        return Buffer.from(encodedName, 'base64url').toString('utf-8');
    } catch {
        return null;
    }
};

const sendToLogChannel = async (bot, message) => {
    const logChannelId = process.env.LOG_CHANNEL_ID;
    if (!logChannelId || !bot) return;
    try {
        await bot.api.sendMessage(logChannelId, message, { parse_mode: 'HTML' });
    } catch (e) {
        console.error('Failed to send to log channel:', e.message);
    }
};

module.exports = {
    sleep,
    cleanMovieName,
    encodeMovieLink,
    decodeMovieLink,
    sendToLogChannel
};
