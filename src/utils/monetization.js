const axios = require('axios');
const { Token, BotSettings } = require('../database');

// --- Setting Helpers ---
const getSetting = async (key, defaultValue = null) => {
    const record = await BotSettings.findOne({ key });
    return record ? record.value : defaultValue;
};

const setSetting = async (key, value) => {
    await BotSettings.findOneAndUpdate(
        { key },
        { value },
        { upsert: true, returnDocument: 'after' }
    );
};

// --- Shortlink API Wrapper ---
// Compatible with arolinks, vplinks, gplinks (they all use the same query format)
const wrapShortlink = async (targetUrl) => {
    const apiKey = process.env.SHORTLINK_API_KEY;
    const baseUrl = process.env.SHORTLINK_BASE_URL; // e.g. https://arolinks.com/api

    if (!apiKey || !baseUrl) {
        // If shortlink is not configured, return the URL as-is (for testing)
        console.warn('[Monetization] SHORTLINK_API_KEY or SHORTLINK_BASE_URL not set. Returning raw URL.');
        return targetUrl;
    }

    try {
        const response = await axios.get(baseUrl, {
            params: { api: apiKey, url: targetUrl },
            timeout: 8000
        });

        if (response.data && response.data.status === 'success') {
            return response.data.shortenedUrl || response.data.shortened_url;
        }

        if (response.data && response.data.status === 'error') {
            console.error('[Monetization] Shortlink API Error:', response.data.message || 'Unknown error');
            return targetUrl;
        }

        // Fallback for APIs that return plain string without JSON status
        if (typeof response.data === 'string' && response.data.startsWith('http')) return response.data;

        if (typeof response.data === 'string' && response.data.includes('<html')) {
            console.error('[Monetization] Shortlink API returned HTML instead of JSON. Check your SHORTLINK_BASE_URL. It should usually end in /api');
            return targetUrl;
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

// Create/refresh a token for a user (24hr from now)
const grantToken = async (userId) => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
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
