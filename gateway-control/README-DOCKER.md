# 🐳 Docker Deployment Guide

> 🔑 **Admin API Key: `8836591554`** — used to log into the dashboard (`/`) and authenticate `/api/manage`.

## Quick Start

1. **Create `.env` file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` and set your values:**
   ```bash
   # Required
   ADMIN_API_KEY=8836591554

   # Optional (for alerts)
   TELEGRAM_BOT_TOKEN=your-bot-token
   TELEGRAM_CHAT_ID=your-chat-id
   ```

3. **Build and run:**
   ```bash
   docker-compose up -d
   ```

4. **Access the dashboard:**
   - Open `http://localhost:34567` (or your configured port)
   - Enter your `ADMIN_API_KEY`

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `http://localhost:34567` | Admin Dashboard |
| `http://localhost:34567/api/status` | Public API (CORS-enabled) |
| `http://localhost:34567/api/manage` | Admin API (POST with `X-API-Key`) |
| `http://localhost:34567/health` | Health check |

## Persistence

The SQLite database is stored in `./data/domains.db` and persists across container restarts.

## Landing Page Integration

Update your landing page config:
```js
const CONFIG = {
  centralApiUrl: "http://your-server-ip:34567",
  // ...
};
```
