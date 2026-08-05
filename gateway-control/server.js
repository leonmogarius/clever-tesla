const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || Math.floor(Math.random() * 10000) + 30000;

// Admin API Key
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_API_KEY) {
  console.error('FATAL: ADMIN_API_KEY environment variable is required');
  process.exit(1);
}

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// SQLite Database (use /app/data for persistence in Docker)
const DB_PATH = process.env.DB_PATH || '/app/data/domains.db';

// Ensure data directory exists
const fs = require('fs');
const path = require('path');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'unknown',
    last_checked TEXT,
    added_at TEXT,
    blocked_since TEXT,
    monitor_only INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: add monitor_only column for databases created before this feature
const _domainCols = db.prepare("PRAGMA table_info(domains)").all();
if (!_domainCols.some(c => c.name === 'monitor_only')) {
  db.exec("ALTER TABLE domains ADD COLUMN monitor_only INTEGER NOT NULL DEFAULT 0");
  console.log("Migration: added 'monitor_only' column to domains table.");
}

// Middleware
app.use(express.json());
app.use(express.static('.'));

// CORS Headers helper
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  next();
});

// Telegram notification
async function notifyTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram configuration missing. Message:', message);
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      console.error('Telegram API error:', await res.text());
    }
  } catch (e) {
    console.error('Error sending Telegram message:', e);
  }
}

// Auth middleware
function requireAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Invalid X-API-Key.' });
  }
  next();
}

// Get all domains from DB
function getAllDomains() {
  const stmt = db.prepare('SELECT * FROM domains ORDER BY id DESC');
  return stmt.all();
}

// TrustPositif health check
async function checkDomainsHealth() {
  console.log('Starting scheduled domain health check...');

  const allDomains = getAllDomains();

  // Filter: skip already blocked domains — but always re-check monitor-only domains
  // (they're tracked for status even when blocked, yet never served to landing pages)
  const domainsToCheck = allDomains.filter(d => d.monitor_only || d.status !== 'blocked');
  const domainsSkipped = allDomains.filter(d => !d.monitor_only && d.status === 'blocked');

  if (domainsToCheck.length === 0) {
    console.log('No domains require checking in this run.');
    return { checkedCount: 0, skippedCount: domainsSkipped.length, changes: 0 };
  }

  // Extract hostnames
  const hostnames = domainsToCheck.map(d => {
    try {
      return new URL(d.url).hostname;
    } catch {
      return d.url;
    }
  });

  const payload = { domains: hostnames.join('\n') };
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.TP_API_KEY) {
    headers['X-API-Key'] = process.env.TP_API_KEY;
  }

  console.log('Querying trustpositif.id API for:', hostnames);

  try {
    const tpRes = await fetch('https://trustpositif.id/api/v1/check', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!tpRes.ok) {
      const errText = await tpRes.text();
      console.error(`TrustPositif API returned status ${tpRes.status}: ${errText}`);
      return { error: `API Error: ${tpRes.status}` };
    }

    const resJson = await tpRes.json();
    if (!resJson.success || !Array.isArray(resJson.results)) {
      console.error('Invalid API response format', resJson);
      return { error: 'Invalid API response' };
    }

    // Map results
    const resultMap = {};
    resJson.results.forEach(r => {
      if (r.Domain && typeof r.Blocked === 'boolean') {
        resultMap[r.Domain.toLowerCase()] = r.Blocked;
      }
    });

    const now = new Date().toISOString();
    const changeLogged = [];

    const updateStmt = db.prepare(`
      UPDATE domains
      SET status = ?, last_checked = ?, blocked_since = ?
      WHERE id = ?
    `);

    for (const domain of domainsToCheck) {
      let hostname = '';
      try {
        hostname = new URL(domain.url).hostname.toLowerCase();
      } catch {
        hostname = domain.url.toLowerCase();
      }

      let isBlocked = resultMap[hostname];
      if (isBlocked === undefined && hostname.startsWith('www.')) {
        isBlocked = resultMap[hostname.replace('www.', '')];
      }
      if (isBlocked === undefined) {
        isBlocked = resultMap['www.' + hostname];
      }

      const actualBlocked = isBlocked ?? false;
      const newStatus = actualBlocked ? 'blocked' : 'active';
      const oldStatus = domain.status || 'unknown';

      if (oldStatus !== newStatus) {
        changeLogged.push({
          url: domain.url,
          from: oldStatus,
          to: newStatus,
        });
      }

      updateStmt.run(
        newStatus,
        now,
        newStatus === 'blocked' ? now : null,
        domain.id
      );
    }

    // Send notifications if status changed
    if (changeLogged.length > 0) {
      const messages = changeLogged.map(c => {
        if (c.to === 'blocked') {
          return `🚫 <b>DOMAIN BLOCKED</b>\n<code>${c.url}</code> is now blocked by TrustPositif.`;
        } else {
          return `✅ <b>DOMAIN RESTORED</b>\n<code>${c.url}</code> is now active.`;
        }
      });

      const activeCount = getAllDomains().filter(d => d.status === 'active').length;
      messages.push(`Total active domains remaining: <b>${activeCount}</b>`);
      await notifyTelegram(messages.join('\n\n'));
    }

    console.log(
      `Domain check complete. Checked: ${domainsToCheck.length}, Skipped: ${domainsSkipped.length}, Changes: ${changeLogged.length}`
    );

    return {
      checkedCount: domainsToCheck.length,
      skippedCount: domainsSkipped.length,
      changes: changeLogged.length,
    };
  } catch (error) {
    console.error('Domain check failed:', error);
    return { error: error.message };
  }
}

// ==================== PUBLIC API ====================

// GET /api/status - Public API for landing pages
app.get('/api/status', async (req, res) => {
  try {
    const domains = getAllDomains();
    const activeDomains = domains
      .filter(d => d.status !== 'blocked' && !d.monitor_only)
      .map(d => d.url);

    const metaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
    const lastRun = metaStmt.get('last_run');

    res.json({
      success: true,
      active: activeDomains,
      count: activeDomains.length,
      lastChecked: lastRun ? lastRun.value : null,
    });
  } catch (error) {
    console.error('Status API error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /health - Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', port: PORT, timestamp: new Date().toISOString() });
});

// ==================== ADMIN API ====================

// POST /api/manage - Admin management API
app.post('/api/manage', requireAuth, async (req, res) => {
  try {
    const { action, domain } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Missing required parameter: action.' });
    }

    if (action === 'list') {
      const domains = getAllDomains();
      return res.json({ success: true, data: { domains } });
    }

    if (action === 'add') {
      if (!domain) {
        return res.status(400).json({ error: 'Missing parameter: domain is required for add action.' });
      }

      let domainUrl = domain.trim();
      if (!domainUrl.startsWith('http://') && !domainUrl.startsWith('https://')) {
        domainUrl = 'https://' + domainUrl;
      }

      const monitorOnly = req.body.monitorOnly ? 1 : 0;
      try {
        const stmt = db.prepare('INSERT INTO domains (url, status, added_at, monitor_only) VALUES (?, ?, ?, ?)');
        stmt.run(domainUrl, 'unknown', new Date().toISOString(), monitorOnly);
      } catch (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: `Domain ${domainUrl} already exists in the pool.` });
        }
        throw err;
      }

      // Trigger immediate check
      await checkDomainsHealth();

      return res.json({
        success: true,
        message: `Added ${domainUrl} successfully. Triggered initial check.`,
        data: { domains: getAllDomains() },
      });
    }

    if (action === 'remove') {
      if (!domain) {
        return res.status(400).json({ error: 'Missing parameter: domain is required for remove action.' });
      }

      let domainUrl = domain.trim();
      if (!domainUrl.startsWith('http://') && !domainUrl.startsWith('https://')) {
        domainUrl = 'https://' + domainUrl;
      }

      const stmt = db.prepare('DELETE FROM domains WHERE url = ?');
      const result = stmt.run(domainUrl);

      if (result.changes === 0) {
        return res.status(404).json({ error: `Domain ${domainUrl} not found in the pool.` });
      }

      return res.json({
        success: true,
        message: `Removed ${domainUrl} successfully.`,
        data: { domains: getAllDomains() },
      });
    }

    if (action === 'toggle-monitor') {
      if (!domain) {
        return res.status(400).json({ error: 'Missing parameter: domain is required for toggle-monitor action.' });
      }

      let domainUrl = domain.trim();
      if (!domainUrl.startsWith('http://') && !domainUrl.startsWith('https://')) {
        domainUrl = 'https://' + domainUrl;
      }

      const stmt = db.prepare('UPDATE domains SET monitor_only = CASE WHEN monitor_only = 1 THEN 0 ELSE 1 END WHERE url = ?');
      const result = stmt.run(domainUrl);

      if (result.changes === 0) {
        return res.status(404).json({ error: `Domain ${domainUrl} not found in the pool.` });
      }

      return res.json({
        success: true,
        message: `Toggled monitor-only for ${domainUrl}.`,
        data: { domains: getAllDomains() },
      });
    }

    if (action === 'check-now') {
      console.log('Triggering manual health check...');
      const result = await checkDomainsHealth();

      return res.json({
        success: true,
        message: 'Manual health check execution complete.',
        checkResult: result,
        data: { domains: getAllDomains() },
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (error) {
    console.error('Manage API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SCHEDULER ====================

// Run health check every hour
cron.schedule('0 * * * *', async () => {
  const result = await checkDomainsHealth();

  // Update last_run in meta
  const stmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  stmt.run('last_run', new Date().toISOString());
});

// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚀 Gateway Control Plane                                  ║
║  ─────────────────────────────────────────────────────────  ║
║  Port: ${PORT}                                           ║
║  Admin API: http://localhost:${PORT}/api/manage            ║
║  Public API: http://localhost:${PORT}/api/status            ║
║  Dashboard: http://localhost:${PORT}                         ║
║  Cron: Every hour at minute 0                               ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Run initial health check on startup (after 10 seconds delay)
  setTimeout(async () => {
    console.log('Running initial health check...');
    await checkDomainsHealth();
    const stmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    stmt.run('last_run', new Date().toISOString());
  }, 10000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  db.close();
  process.exit(0);
});
