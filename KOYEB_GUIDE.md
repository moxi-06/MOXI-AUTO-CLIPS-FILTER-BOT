# 🚀 Koyeb Deployment Guide

If your bot is starting (posting promo messages) but not responding to commands, it's usually because the **Webhook** is not correctly configured.

## 1. Choose Service Type
- Select **Web Service** (NOT Worker) so the bot can receive messages via Webhook.

## 2. Environment Variables
Make sure these are accurately set in your Koyeb App settings:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `BOT_TOKEN` | Your BotFather token | `12345:ABCDE...` |
| `MONGODB_URI` | Your MongoDB Cluster URL | `mongodb+srv://...` |
| `ADMIN_ID` | Your Telegram ID | `123456789` |
| `DB_CHANNEL_ID` | Your Database Channel ID | `-100...` |
| `LOG_CHANNEL_ID` | Your Log Channel ID | `-100...` |
| `GROUP_ID` | Your Group ID | `-100...` |
| `WEBHOOK_URL` | **Crucial!** Your Koyeb App URL | `https://my-app-name.koyeb.app` |
| `PORT` | Set this to `3000` | `3000` |

> [!IMPORTANT]
> **WEBHOOK_URL** must:
> 1. Start with `https://`
> 2. Be the exact URL shown on your Koyeb Dashboard.
> 3. **NOT** include the bot token at the end (the bot adds it automatically).

## 3. Port Mapping
- Ensure Koyeb is mapping **Public Port 80/443** to **Instance Port 3000**.
- The bot listens on port `3000` by default (controlled by the `PORT` variable).

## 4. How to Debug
If it's still not working:
1. Check your **Koyeb Runtime Logs**.
2. Look for the line: `📡 Setting webhook to: https://.../<TOKEN_HIDDEN>`
3. If you see `❌ Failed to set webhook`, your `WEBHOOK_URL` is likely wrong or invalid.
4. If you see `✅ Webhook registration successful!` but no response, ensure you haven't blocked the bot or that the bot is an Admin in the group/channel.

---
**Need help?** Paste your Koyeb logs here and I'll analyze them for you! 🍿🚀
