const axios = require('axios');
const { Token, BotSettings } = require('../database');

// --- Setting Helpers (Pure MongoDB Storage) ---
const getSetting = async (key, defaultValue = null) => {
    try {
        const record = await BotSettings.findOne({ key });
        return record ? record.value : defaultValue;
    } catch (_) {
        return defaultValue;
    }
};

const setSetting = async (key, value) => {
    if (key === 'shortlinkApiKey') process.env.SHORTLINK_API_KEY = value;
    if (key === 'shortlinkBaseUrl') process.env.SHORTLINK_BASE_URL = value;
    try {
        await BotSettings.findOneAndUpdate(
            { key },
            { value },
            { upsert: true, returnDocument: 'after' }
        );
    } catch (e) {
        console.error('Error saving setting to DB:', e.message);
    }
};

// --- Shortlink API Wrapper (Direct Provider Call on Every Request) ---
// Compatible with arolinks, vplinks, gplinks (they all use the same query format)
const wrapShortlink = async (targetUrl) => {
    const apiKey = await getSetting('shortlinkApiKey', process.env.SHORTLINK_API_KEY);
    const baseUrl = await getSetting('shortlinkBaseUrl', process.env.SHORTLINK_BASE_URL);

    if (!apiKey || !baseUrl) {
        // If shortlink is not configured, return the URL as-is (for testing)
        console.warn('[Monetization] SHORTLINK_API_KEY or SHORTLINK_BASE_URL not set. Returning raw URL.');
        return targetUrl;
    }

    try {
        const response = await axios.get(baseUrl.trim(), {
            params: { api: apiKey.trim(), url: targetUrl },
            timeout: 8000
        });

        if (response.data && response.data.status === 'success') {
            return response.data.shortenedUrl || response.data.shortened_url || response.data.url || response.data.link;
        }

        if (response.data && response.data.status === 'error') {
            console.error('[Monetization] Shortlink API Error:', response.data.message || 'Unknown error');
            return targetUrl;
        }

        // Fallback for APIs that return plain string without JSON status
        if (typeof response.data === 'string' && response.data.trim().startsWith('http')) {
            return response.data.trim();
        }

        if (typeof response.data === 'string' && response.data.includes('<html')) {
            console.error('[Monetization] Shortlink API returned HTML instead of JSON. Check your SHORTLINK_BASE_URL. It should usually end in /api');
            return targetUrl;
        }

        if (response.data && response.data.url && typeof response.data.url === 'string') {
            return response.data.url;
        }

        console.error('[Monetization] Shortlink API unexpected response:', response.data);
        return targetUrl; // fallback
    } catch (err) {
        console.error('[Monetization] Shortlink API error:', err.message);
        return targetUrl; // fallback
    }
};

// --- Token Validation ---
const hasValidToken = async (userId) => {
    const token = await Token.findOne({ userId: userId.toString() });
    if (!token) return false;
    return token.expiresAt > new Date(); // Check if not expired
};

// Create/refresh a token for a user (configurable duration, default 24h)
const grantToken = async (userId, customHours = null) => {
    const hours = customHours || Number(await getSetting('tokenDurationHours', 24)) || 24;
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    await Token.findOneAndUpdate(
        { userId: userId.toString() },
        { expiresAt },
        { upsert: true, returnDocument: 'after' }
    );
    return expiresAt;
};

// Get token expiry readable time
const getTokenExpiry = async (userId) => {
    const token = await Token.findOne({ userId: userId.toString() });
    if (!token || token.expiresAt < new Date()) return null;
    const diff = token.expiresAt - new Date();
    const hrs = Math.floor(diff / 1000 / 3600);
    const mins = Math.floor((diff / 1000 / 60) % 60);
    return `${hrs}h ${mins}m`;
};

module.exports = {
    getSetting,
    setSetting,
    wrapShortlink,
    hasValidToken,
    grantToken,
    getTokenExpiry
};
