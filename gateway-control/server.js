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
  CREATE TABLE IF NOT EXISTS gateways (
    origin TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1
  );
`);

// ── Current-domain management (prepared statements + helpers) ──
// Defined early because the startup migrations below call getCurrentDomain().
// The "current" domain is the single destination all landing pages redirect to.
// Stored in meta (key/value) as current_domain_url. When blocked, promoteNextDomain()
// picks the oldest active backup.
const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
const metaSet = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

function getCurrentDomain() {
  const row = metaGet.get('current_domain_url');
  if (!row || !row.value) return null;
  const domain = db.prepare('SELECT * FROM domains WHERE url = ?').get(row.value);
  return domain || null;
}

function setCurrentDomain(url) {
  metaSet.run('current_domain_url', url);
}

// Pick the oldest active non-monitor-only domain that isn't the blocked one.
function promoteNextDomain(excludeUrl) {
  const candidate = db.prepare(`
    SELECT * FROM domains
    WHERE status = 'active' AND monitor_only = 0 AND url != ?
    ORDER BY added_at ASC LIMIT 1
  `).get(excludeUrl);
  if (candidate) {
    setCurrentDomain(candidate.url);
  }
  return candidate || null;
}

// Migration: add monitor_only column for databases created before this feature
const _domainCols = db.prepare("PRAGMA table_info(domains)").all();
if (!_domainCols.some(c => c.name === 'monitor_only')) {
  db.exec("ALTER TABLE domains ADD COLUMN monitor_only INTEGER NOT NULL DEFAULT 0");
  console.log("Migration: added 'monitor_only' column to domains table.");
}

// Bootstrap current domain: if none is set, pick the oldest active
// non-monitor-only domain. Runs once on first boot after this feature ships.
if (!getCurrentDomain()) {
  const oldest = db.prepare(`
    SELECT * FROM domains
    WHERE status = 'active' AND monitor_only = 0
    ORDER BY added_at ASC LIMIT 1
  `).get();
  if (oldest) {
    setCurrentDomain(oldest.url);
    console.log(`Bootstrap: set current domain to ${oldest.url}`);
  } else {
    console.log('Bootstrap: no active domain to set as current yet. Will set on first add.');
  }
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

// ── Gateway tracking ───────────────────────────────────────────
// Records which landing-page origins call /api/status. Alerts on first sighting.
const gwInsert = db.prepare(`
  INSERT INTO gateways (origin, first_seen, last_seen, request_count)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(origin) DO UPDATE SET
    last_seen = excluded.last_seen,
    request_count = request_count + 1
`);
const gwGetAll = db.prepare('SELECT * FROM gateways ORDER BY last_seen DESC');

function recordGateway(origin) {
  if (!origin) return;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT 1 FROM gateways WHERE origin = ?').get(origin);
  gwInsert.run(origin, now, now);
  // Alert only on first sighting of a new gateway
  if (!existing) {
    console.log(`New gateway connected: ${origin}`);
    notifyTelegram(
      `🔗 <b>NEW GATEWAY CONNECTED</b>\n<code>${origin}</code> is now redirecting via this control plane.`
    );
  }
}

// ── Cloudflare integration ─────────────────────────────────────
// Settings live in the meta table so they can be changed from the dashboard
// without editing .env or restarting the container.

const CF_API = 'https://api.cloudflare.com/client/v4';

function getCfSettings() {
  return {
    token: metaGet.get('cf_api_token')?.value || null,
    targetIp: metaGet.get('cf_target_ip')?.value || null,
    proxied: metaGet.get('cf_proxied')?.value === 'true',
  };
}

async function cfRequest(method, path, body) {
  const { token } = getCfSettings();
  if (!token) throw new Error('Cloudflare API token not configured');
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) {
    const msg = JSON.stringify(json.errors || json);
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  return json.result;
}

async function cfListZones() {
  const zones = [];
  let page = 1;
  // Page through zones (50/page) so accounts with many domains list fully.
  for (;;) {
    const batch = await cfRequest('GET', `/zones?per_page=50&page=${page}`);
    zones.push(...batch);
    if (batch.length < 50) break;
    page++;
  }
  return zones;
}

async function cfListDNS(zoneId) {
  return cfRequest('GET', `/zones/${zoneId}/dns_records?per_page=100`);
}

async function cfCreateDNS(zoneId, type, name, content, proxied) {
  return cfRequest('POST', `/zones/${zoneId}/dns_records`, { type, name, content, proxied: !!proxied });
}

async function cfDeleteDNS(zoneId, recordId) {
  return cfRequest('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
}

// Point a Cloudflare zone at the target IP: clean existing @/www records,
// then create a fresh A record. Returns nothing; throws on failure.
async function cfProvisionZoneDNS(zoneName) {
  const { targetIp, proxied } = getCfSettings();
  if (!targetIp) throw new Error('Target IP not configured — set it in Cloudflare settings first');
  const zones = await cfListZones();
  const zone = zones.find(z => z.name.toLowerCase() === zoneName.toLowerCase());
  if (!zone) throw new Error(`Zone ${zoneName} not found in Cloudflare account`);

  // Remove conflicting root/www records so the new one is unambiguous.
  const existing = await cfListDNS(zone.id);
  const rootNames = new Set([zone.name.toLowerCase(), '@', 'www', `www.${zone.name}`.toLowerCase()]);
  for (const rec of existing) {
    if (rootNames.has(rec.name.toLowerCase()) && ['A', 'CNAME'].includes(rec.type)) {
      await cfDeleteDNS(zone.id, rec.id);
    }
  }
  await cfCreateDNS(zone.id, 'A', '@', targetIp, proxied);
  // www as a CNAME to the root, so both forms work.
  await cfCreateDNS(zone.id, 'CNAME', 'www', zone.name, proxied);
}

// Best-effort cleanup: when a domain gets blocked, strip its root/www records
// so the zone is clean for future re-add. Never throws — failures are logged.
async function cfCleanupZoneDNS(domainUrl) {
  try {
    const { token } = getCfSettings();
    if (!token) return;
    const hostname = new URL(domainUrl).hostname.toLowerCase().replace(/^www\./, '');
    const zones = await cfListZones();
    const zone = zones.find(z => z.name.toLowerCase() === hostname);
    if (!zone) return; // not a CF zone we manage — nothing to do
    const existing = await cfListDNS(zone.id);
    const rootNames = new Set([zone.name.toLowerCase(), '@', 'www', `www.${zone.name}`.toLowerCase()]);
    for (const rec of existing) {
      if (rootNames.has(rec.name.toLowerCase()) && ['A', 'CNAME'].includes(rec.type)) {
        await cfDeleteDNS(zone.id, rec.id);
        console.log(`CF cleanup: removed ${rec.type} ${rec.name} from ${zone.name}`);
      }
    }
  } catch (e) {
    console.warn(`CF cleanup failed for ${domainUrl}: ${e.message}`);
  }
}

// TrustPositif health check
//   scope: 'current' → check only the current domain (fast failover, cheap)
//   scope: 'all'     → check all non-blocked + all monitor-only (full sweep)
async function checkDomainsHealth({ scope = 'all' } = {}) {
  console.log(`Starting domain health check (scope: ${scope})...`);

  const allDomains = getAllDomains();
  const current = getCurrentDomain();

  let domainsToCheck;
  if (scope === 'current') {
    // Only check the current domain (skip if it's already blocked — dead).
    domainsToCheck = current && current.status !== 'blocked' ? [current] : [];
  } else {
    // Blocked domains are dead — never re-checked. Saves TrustPositif quota;
    // re-add a domain manually if you ever want to retry it.
    domainsToCheck = allDomains.filter(d => d.status !== 'blocked');
  }
  const domainsSkipped = allDomains.filter(d => !domainsToCheck.includes(d));

  if (domainsToCheck.length === 0) {
    console.log('No domains require checking in this run.');
    return { checkedCount: 0, skippedCount: domainsSkipped.length, changes: 0 };
  }

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

    // Cloudflare cleanup: strip root/www DNS records of newly blocked domains
    // (best-effort — failures are logged inside, never break the check cycle).
    for (const c of changeLogged) {
      if (c.to === 'blocked') {
        await cfCleanupZoneDNS(c.url);
      }
    }

    // Auto-promote: if the current domain is now blocked, switch to next active backup.
    let switchedTo = null;
    const currentAfter = getCurrentDomain();
    if (currentAfter && currentAfter.status === 'blocked') {
      const promoted = promoteNextDomain(currentAfter.url);
      if (promoted) {
        switchedTo = promoted.url;
        console.log(`Current domain blocked. Promoted backup: ${promoted.url}`);
        await notifyTelegram(
          `🚨 <b>BLOCKED — NOW USING NEW DOMAIN</b>\n` +
          `❌ <code>${currentAfter.url}</code> got blocked by TrustPositif.\n\n` +
          `✅ <b>NOW USING:</b> <code>${promoted.url}</code>\n` +
          `All landing pages now redirect to the new domain.`
        );
      } else {
        console.log(`Current domain blocked but NO active backup available. Pool exhausted.`);
        await notifyTelegram(
          `⚠️ <b>POOL EXHAUSTED — URGENT</b>\n` +
          `Current <code>${currentAfter.url}</code> is blocked and there is NO active backup.\n` +
          `All landing pages are without a destination. Add a fresh domain immediately!`
        );
      }
    }

    // Heartbeat: send a status summary after EVERY scheduled check so you know it ran,
    // even when nothing changed. Disable via NOTIFY_HEARTBEAT=false in .env.
    if (process.env.NOTIFY_HEARTBEAT !== 'false') {
      const allNow = getAllDomains();
      const active = allNow.filter(d => d.status === 'active').length;
      const blocked = allNow.filter(d => d.status === 'blocked').length;
      const monitor = allNow.filter(d => d.monitor_only).length;
      const scopeLabel = scope === 'current' ? 'current domain' : 'full pool';
      const cur = getCurrentDomain();
      const curLabel = (cur && cur.status === 'active') ? cur.url : (switchedTo || '(none active)');
      const healthEmoji = (blocked > 0 && active === 0) ? '🔴' : '🟢';
      await notifyTelegram(
        `${healthEmoji} <b>SCHEDULED CHECK COMPLETE</b> (${scopeLabel})\n` +
        `🎯 Now using: <code>${curLabel}</code>\n` +
        `Pool: ${active} active · ${blocked} blocked · ${monitor} monitor-only\n` +
        `Checked ${domainsToCheck.length} domain(s) · ${changeLogged.length} status change(s)`
      );
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
    // Record which gateway (landing page) is calling us, via the Origin header.
    recordGateway(req.headers.origin);

    const domains = getAllDomains();
    const activeDomains = domains
      .filter(d => d.status !== 'blocked' && !d.monitor_only)
      .map(d => d.url);

    const currentDomain = getCurrentDomain();
    // Current must be active (not blocked) to be served; else fall back to first active.
    const currentUrl =
      currentDomain && currentDomain.status === 'active' && !currentDomain.monitor_only
        ? currentDomain.url
        : (activeDomains[0] || null);

    const lastRun = metaGet.get('last_run');

    res.json({
      success: true,
      current: currentUrl,
      active: activeDomains,
      count: activeDomains.length,
      lastChecked: lastRun ? lastRun.value : null,
    });
  } catch (error) {
    console.error('Status API error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /go - Shortener: the ONE stable link that always points at the current
// destination. 302 (temporary) on purpose — browsers/CDNs cache 301s, which
// would defeat instant repointing when a domain is rotated.
app.get('/go', (req, res) => {
  const current = getCurrentDomain();
  if (current && current.status === 'active' && !current.monitor_only) {
    return res.redirect(302, current.url);
  }
  // Fallback: first active serveable domain in the pool.
  const firstActive = db.prepare(
    "SELECT url FROM domains WHERE status = 'active' AND monitor_only = 0 ORDER BY added_at ASC LIMIT 1"
  ).get();
  if (firstActive) return res.redirect(302, firstActive.url);
  // Last resort: configured fallback URL.
  if (process.env.FALLBACK_URL) return res.redirect(302, process.env.FALLBACK_URL);
  return res.status(503).send('No active destination available');
});

// GET /api/domains - Admin: unified domain list.
// Cloudflare zones are the PRIMARY source (every zone in the CF account);
// pool entries whose hostname is not a CF zone appear as 'manual' (secondary).
// If Cloudflare isn't configured, only manual entries are returned.
app.get('/api/domains', requireAuth, async (req, res) => {
  try {
    const pool = getAllDomains();
    const current = getCurrentDomain();
    const { token } = getCfSettings();

    const poolByHost = new Map();
    for (const d of pool) {
      let host = d.url;
      try { host = new URL(d.url).hostname.toLowerCase(); } catch {}
      poolByHost.set(host, d);
    }

    const rows = [];
    const seenHosts = new Set();

    // Primary: Cloudflare zones.
    if (token) {
      try {
        const zones = await cfListZones();
        for (const z of zones) {
          const name = z.name.toLowerCase();
          seenHosts.add(name);
          const entry = poolByHost.get(name) || null;
          rows.push({
            name: z.name,
            source: 'cloudflare',
            cfStatus: z.status,
            inPool: !!entry,
            poolStatus: entry ? entry.status : null,
            monitorOnly: entry ? !!entry.monitor_only : null,
            isCurrent: !!(entry && current && entry.url === current.url),
          });
        }
      } catch (e) {
        return res.status(502).json({ success: false, error: `Cloudflare API failed: ${e.message}` });
      }
    }

    // Secondary: manual pool entries not covered by any CF zone.
    for (const [host, entry] of poolByHost) {
      if (seenHosts.has(host)) continue;
      rows.push({
        name: host,
        source: 'manual',
        cfStatus: null,
        inPool: true,
        poolStatus: entry.status,
        monitorOnly: !!entry.monitor_only,
        isCurrent: !!(current && entry.url === current.url),
      });
    }

    res.json({
      success: true,
      count: rows.length,
      cfConfigured: !!token,
      data: { domains: rows },
    });
  } catch (error) {
    console.error('Unified domains API error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /health - Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', port: PORT, timestamp: new Date().toISOString() });
});

// GET /api/gateways - Admin endpoint to list connected gateways
app.get('/api/gateways', requireAuth, (req, res) => {
  try {
    const gateways = gwGetAll.all().map(gw => ({
      origin: gw.origin,
      firstSeen: gw.first_seen,
      lastSeen: gw.last_seen,
      requestCount: gw.request_count,
    }));
    res.json({ success: true, count: gateways.length, data: { gateways } });
  } catch (error) {
    console.error('Gateways API error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/cf/settings - Admin: read Cloudflare settings (token masked)
app.get('/api/cf/settings', requireAuth, (req, res) => {
  const { token, targetIp, proxied } = getCfSettings();
  res.json({
    success: true,
    data: {
      tokenConfigured: !!token,
      tokenMasked: token ? `••••${token.slice(-4)}` : null,
      targetIp,
      proxied,
    },
  });
});

// GET /api/cf/zones - Admin: list all Cloudflare zones with pool membership
app.get('/api/cf/zones', requireAuth, async (req, res) => {
  try {
    const zones = await cfListZones();
    const pool = getAllDomains();
    const poolByHost = new Map(
      pool.map(d => {
        let host = d.url;
        try { host = new URL(d.url).hostname.toLowerCase(); } catch {}
        return [host, d];
      })
    );
    const result = zones.map(z => {
      const poolEntry = poolByHost.get(z.name.toLowerCase()) || null;
      return {
        id: z.id,
        name: z.name,
        cfStatus: z.status,
        inPool: !!poolEntry,
        poolStatus: poolEntry ? poolEntry.status : null,
        monitorOnly: poolEntry ? !!poolEntry.monitor_only : null,
        isCurrent: poolEntry ? poolEntry.url === getCurrentDomain()?.url : false,
      };
    });
    res.json({ success: true, count: result.length, data: { zones: result } });
  } catch (error) {
    console.error('CF zones API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
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

      // If no current domain is set and this one is serveable (not monitor-only),
      // make it the current destination.
      if (!monitorOnly && !getCurrentDomain()) {
        setCurrentDomain(domainUrl);
      }

      // Trigger immediate check
      await checkDomainsHealth({ scope: 'all' });

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
      const result = await checkDomainsHealth({ scope: 'all' });

      return res.json({
        success: true,
        message: 'Manual health check execution complete.',
        checkResult: result,
        data: { domains: getAllDomains() },
      });
    }

    if (action === 'set-current') {
      if (!domain) {
        return res.status(400).json({ error: 'Missing parameter: domain is required for set-current action.' });
      }

      let domainUrl = domain.trim();
      if (!domainUrl.startsWith('http://') && !domainUrl.startsWith('https://')) {
        domainUrl = 'https://' + domainUrl;
      }

      const target = db.prepare('SELECT * FROM domains WHERE url = ?').get(domainUrl);
      if (!target) {
        return res.status(404).json({ error: `Domain ${domainUrl} not found in the pool.` });
      }
      if (target.monitor_only) {
        return res.status(400).json({ error: `Cannot set a monitor-only domain as current.` });
      }

      setCurrentDomain(domainUrl);
      return res.json({
        success: true,
        message: `Set ${domainUrl} as the current destination.`,
        data: { domains: getAllDomains() },
      });
    }

    if (action === 'cf-settings') {
      const { token, targetIp, proxied } = req.body;

      // Validate a newly provided token against the CF API before saving it.
      if (token !== undefined && token !== '') {
        try {
          const test = await fetch(`${CF_API}/zones?per_page=1`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const testJson = await test.json();
          if (!testJson.success) {
            return res.status(400).json({
              error: `Token rejected by Cloudflare: ${JSON.stringify(testJson.errors || [])}`,
            });
          }
        } catch (e) {
          return res.status(502).json({ error: `Could not reach Cloudflare to validate token: ${e.message}` });
        }
        metaSet.run('cf_api_token', token);
      }

      if (targetIp !== undefined) metaSet.run('cf_target_ip', targetIp.trim());
      if (proxied !== undefined) metaSet.run('cf_proxied', proxied ? 'true' : 'false');

      return res.json({ success: true, message: 'Cloudflare settings saved.' });
    }

    if (action === 'cf-add') {
      if (!domain) {
        return res.status(400).json({ error: 'Missing parameter: domain is required for cf-add action.' });
      }

      // Accept a bare zone name or a full URL; we need the zone name.
      let zoneName = domain.trim().toLowerCase();
      try {
        const u = new URL(domain.includes('://') ? domain : `https://${domain}`);
        zoneName = u.hostname.toLowerCase().replace(/^www\./, '');
      } catch { /* keep raw */ }

      // Skip if already in the pool (by hostname).
      const poolHosts = new Set(getAllDomains().map(d => {
        try { return new URL(d.url).hostname.toLowerCase().replace(/^www\./, ''); }
        catch { return d.url.toLowerCase(); }
      }));
      if (poolHosts.has(zoneName)) {
        return res.status(400).json({ error: `${zoneName} is already in the pool.` });
      }

      const monitorOnly = req.body.monitorOnly ? 1 : 0;

      // Create the DNS records pointing at the target IP (when configured).
      let dnsMessage = '';
      const { token, targetIp } = getCfSettings();
      if (token && targetIp) {
        try {
          await cfProvisionZoneDNS(zoneName);
          dnsMessage = ` DNS pointed at ${targetIp}.`;
        } catch (e) {
          return res.status(400).json({ error: `Cloudflare provisioning failed: ${e.message}` });
        }
      } else {
        dnsMessage = ' No target IP configured — added to pool without DNS changes.';
      }

      const url = `https://${zoneName}`;
      try {
        const stmt = db.prepare('INSERT INTO domains (url, status, added_at, monitor_only) VALUES (?, ?, ?, ?)');
        stmt.run(url, 'unknown', new Date().toISOString(), monitorOnly);
      } catch (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: `${url} already exists in the pool.` });
        }
        throw err;
      }

      // Same bootstrapping as a regular add: first serveable domain becomes current.
      if (!monitorOnly && !getCurrentDomain()) {
        setCurrentDomain(url);
      }

      // Verify against TrustPositif immediately.
      await checkDomainsHealth({ scope: 'all' });

      return res.json({
        success: true,
        message: `Added ${zoneName} from Cloudflare.${dnsMessage} Triggered initial check.`,
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

// Fast failover: check the current domain every 30 minutes.
cron.schedule('*/30 * * * *', async () => {
  const result = await checkDomainsHealth({ scope: 'current' });
  metaSet.run('last_run', new Date().toISOString());
});

// Full sweep: check the whole pool every 6 hours (backups + monitor-only).
cron.schedule('0 */6 * * *', async () => {
  const result = await checkDomainsHealth({ scope: 'all' });
  metaSet.run('last_run', new Date().toISOString());
});

// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
  const current = getCurrentDomain();
  const currentDisplay = current ? current.url : '(none set)';
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚀 Gateway Control Plane                                  ║
║  ─────────────────────────────────────────────────────────  ║
║  Port: ${PORT}                                           ║
║  Current destination: ${currentDisplay}
║  Admin API: http://localhost:${PORT}/api/manage            ║
║  Public API: http://localhost:${PORT}/api/status            ║
║  Dashboard: http://localhost:${PORT}                         ║
║  Cron: current every 30min · full pool every 6h            ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Run initial health check on startup (after 10 seconds delay)
  setTimeout(async () => {
    console.log('Running initial health check (full sweep)...');
    await checkDomainsHealth({ scope: 'all' });
    metaSet.run('last_run', new Date().toISOString());
  }, 10000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  db.close();
  process.exit(0);
});
