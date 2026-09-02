# clever-tesla — Anti-Block Domain Rotator + URL Shortener

An anti-block gateway system for iGaming properties targeting Indonesia. Indonesian ISPs enforce the **TrustPositif** blocklist (DNS-level domain blocking). This system keeps a set of **shortener URLs** that always redirect to the **current working destination domain**; when a destination gets blocked, the system detects it, auto-promotes a backup, and alerts via Telegram — the shared links never change.

> **Onboarding note (for AI agents/humans new to this repo):** read `CREDENTIALS.md`
> (gitignored, transported separately) for every password/token/key. This README
> contains **no secrets** — the GitHub repo is **public**.

---

## 🏗️ Architecture

```
THE shared links (never change):
   https://go.tambangemas.org/register?ref=suigom     ← primary shortener
   https://gs1|gs2|gs3.tambangemas.org/...            ← spares
   https://srv1755625.hstgr.cloud/go/...              ← legacy path form
        │  302 redirect (path + query PRESERVED)
        ▼
   current destination domain  (e.g. https://gudangspin.my.id)
        │  Cloudflare DNS, proxied (orange) — edge TLS, hides origin IP
        ▼
   TARGET_IP 109.110.188.81  (the destination app server)

Control plane (Docker on VPS 72.61.209.216, behind Traefik + Let's Encrypt):
   • checks destinations against TrustPositif (cron: current every 30 min,
     full pool every 6 h) — blocked domains are DEAD and never re-checked
   • auto-promotes oldest active backup when current is blocked
   • Telegram alerts: heartbeat every check, 🚨 "NOW USING <domain>" on failover
   • drives Cloudflare API: lists your zones, provisions DNS on add,
     strips DNS of newly blocked domains
```

### The mental model
- **Control plane** (this repo, `gateway-control/`) = the brain + shortener host + monitor. Cloudflare is a *tool* it drives, not a replacement.
- **Cloudflare** = DNS/TLS infrastructure for destination domains (primary source of the domain list).
- **Cold-standby model**: backup domains carry **no DNS at all** until the moment they're promoted to current. A backup with live DNS is a live gambling link that crawlers can find and block while it's still spare — cold backups stay invisible. `ensureCurrentDns()` provisions DNS at promotion time (auto-promote on block, manual `set-current`, or first add); `cfCleanupZoneDNS` strips it when a domain dies.
- **Landing pages** (`landing/`) = **DEPRECATED** (never got Google-indexed). `/go` replaced them. Files kept for reference only.

---

## 🔗 Live URLs & endpoints

| URL | Auth | What |
|---|---|---|
| `https://go.tambangemas.org` (+`/gs1|gs2|gs3`) | public | **The shortener.** Any path+query forwards to the current destination. Pure redirector — no dashboard/API served on these hosts. |
| `https://srv1755625.hstgr.cloud/go[/path]?q=1` | public | Legacy shortener path form (path after `/go` is forwarded) |
| `https://srv1755625.hstgr.cloud/api/status` | public | `{current, active[], count, lastChecked}` |
| `https://srv1755625.hstgr.cloud/` | API key | Admin dashboard (unified Domains table, CF Settings, Gateways) |
| `POST /api/manage` | `X-API-Key` | Actions: `list`, `add`, `remove`, `toggle-monitor`, `set-current`, `check-now`, `cf-settings`, `cf-add` |
| `GET /api/domains` | `X-API-Key` | Unified list: all CF zones (primary, `source:"cloudflare"`) + non-CF pool entries (`source:"manual"`); `cfConfigured` flag |
| `GET /api/cf/settings` · `GET /api/cf/zones` | `X-API-Key` | CF settings (token masked) · raw zone list |
| `GET /api/gateways` | `X-API-Key` | Landing-page origins seen via `Origin` header (legacy feature) |
| `GET /health` | public | Health probe |

Shortener hostnames are defined in `SHORTENER_HOSTS` in `server.js` (currently `go/gs1/gs2/gs3.tambangemas.org`) and mirrored in the Traefik `Host()` rule in `docker-compose.yml` — **update both together** when adding more.

---

## 📁 Repo structure

```
clever-tesla/
├── gateway-control/          ← THE app (control plane + shortener)
│   ├── server.js             ← everything: API, checker, shortener, CF client
│   ├── index.html            ← admin dashboard (single file, inline CSS/JS)
│   ├── Dockerfile            ← node:20-alpine, better-sqlite3 (needs python3/make/g++)
│   ├── docker-compose.yml    ← Traefik labels (all hostnames), env, healthcheck
│   ├── .env.example          ← ADMIN_API_KEY, TELEGRAM_*, TP_API_KEY, NOTIFY_HEARTBEAT, FALLBACK_URL
│   ├── data/domains.db       ← SQLite (ON SERVER ONLY, gitignored) — pool + meta + gateways
│   └── netlify/functions/    ← dead legacy alternate impl (unused)
├── landing/                  ← DEPRECATED landing page variants (reference only)
├── CREDENTIALS.md            ← ALL credentials (GITIGNORED — transport manually)
├── netlify.toml / vercel.json← legacy landing deploy configs (unused now)
└── README.md
```

### Key internals (`server.js`)
- **DB tables:** `domains` (url, status, monitor_only, …), `meta` (KV: `current_domain_url`, `cf_api_token`, `cf_target_ip`, `cf_proxied`, `last_run`), `gateways` (origin tracking).
- **Single-current model:** one domain is `current_domain_url`; `/go` + shortener hosts redirect to it; on block → `promoteNextDomain()` picks oldest active non-monitor backup → Telegram `🚨 NOW USING`.
- **Checker:** `checkDomainsHealth({scope})` — `'current'` (30-min cron) / `'all'` (6-h cron). **Blocked = dead, never re-checked** (quota saver; re-add to retry).
- **CF client:** `cfListZones/cfListDNS/cfCreateDNS/cfDeleteDNS`, `cfProvisionZoneDNS` (cleans `@`/`www`, creates A → target IP, proxied per setting), `cfCleanupZoneDNS` (strips DNS of newly blocked domains, best-effort).
- **CF settings live in the DB** (editable via dashboard, no restart): token, target IP, proxied flag.

---

## 🛠️ How to work on this project

### Workflow (edit → check → commit → push → deploy)
```bash
# 1. Edit files locally (Windows dev machine, Git Bash)
node --check gateway-control/server.js          # ALWAYS syntax-check JS first

# 2. Commit + push
git add -A && git commit -m "..." && git push origin master

# 3. Deploy on the VPS (SSH as root — see CREDENTIALS.md)
cd /root/docker/clever-tesla && git pull
cd gateway-control && docker compose up -d --build

# 4. Verify
docker compose ps                                   # must show (healthy)
curl -s https://srv1755625.hstgr.cloud/health       # {"status":"healthy"}
curl -sI https://go.tambangemas.org | grep -i location   # 302 → current domain
docker compose logs --tail=30 gateway-control       # startup banner + checks
```

### ⚠️ Deployment gotchas (learned the hard way)
1. **Use `docker compose` (v2, space) — NEVER `docker-compose` (v1).** The legacy v1 binary on this VPS crashes with `KeyError: 'ContainerConfig'` on modern Docker Engine images.
2. **Traefik must see the container.** If HTTPS routing suddenly dies for everything, Traefik lost the Docker socket — fix: `docker restart traefik-traefik-1`.
3. **Code changes require rebuild** (`--build`) — the app is COPY'd into the image. Compose/label changes require recreate (plain `up -d` suffices).
4. **Data persists** at `./data/domains.db` (bind mount) — safe across rebuilds. Do NOT delete `gateway-control/.env` on the server (holds ADMIN_API_KEY + Telegram creds).
5. Healthcheck uses **native `fetch()`** (Node 18+). Do not switch back to `node-fetch` v2 syntax (`.default`).

---

## 📋 Operations runbook

All admin calls: `POST https://srv1755625.hstgr.cloud/api/manage` with headers
`Content-Type: application/json` + `X-API-Key: <key from CREDENTIALS.md>`.

| Task | Body |
|---|---|
| List pool | `{"action":"list"}` |
| Add CF zone to pool (serving standby — **cold: no DNS created**, TrustPositif-checked; DNS auto-provisions if/when it becomes current) | `{"action":"cf-add","domain":"example.com"}` |
| Add CF zone as monitor-only | `{"action":"cf-add","domain":"example.com","monitorOnly":true}` |
| Add manual (non-CF) domain | `{"action":"add","domain":"https://example.com"}` |
| Remove from pool | `{"action":"remove","domain":"https://example.com"}` |
| Toggle monitor-only ↔ serving | `{"action":"toggle-monitor","domain":"https://example.com"}` |
| Set current destination manually | `{"action":"set-current","domain":"https://example.com"}` |
| Force a full check now | `{"action":"check-now"}` |
| Save CF settings (token validated live) | `{"action":"cf-settings","token":"...","targetIp":"...","proxied":true}` |

Dashboard equivalents exist for all of these (unified Domains table: Use / Monitor / Set Current / Remove per row).

### Adding another shortener subdomain
1. CF API/dashboard: `A` record `<name>.tambangemas.org` → `72.61.209.216`, **DNS-only (grey)** for clean Let's Encrypt issuance.
2. Add hostname to `SHORTENER_HOSTS` (`server.js`) **and** the Traefik `Host()` rule (`docker-compose.yml`).
3. Deploy; first HTTPS hit triggers cert issuance.

---

## 📸 System state snapshot (2026-08-31)

- **Current destination:** `https://gudangspin.my.id` · active serveables: `gudangspin.my.id`, `groupgudang.my.id`, `zqdxb114.com`
- **DEAD (blocked, never re-checked):** gud4ng123.xyz, gudangspin.cloud/site/xyz, tambangemas.site, tambangemas.net
- **Monitor-only:** gud4ng123.shop, gudangspin.click, hm.tambangemas.org
- **CF zones available to add:** `gudangspin.id` (recommended backup), nusantaraatelier.com/.site/.space, tambangemas.org, ⚠️ nusantaragold.cloud (**Chatwoot — never add**)
- **CF settings:** token saved, target IP `109.110.188.81`, proxied=true
- `gud4ng123.xyz` zone is CF-status **pending** (nameservers not set at registrar)

## ⚠️ Gotchas & known issues
- **DNS-only (grey) destination records cause "unsafe" browser warnings** — the origin has no per-domain cert. Keep destination records **proxied (orange)**; the setting defaults to proxied now.
- The auto **DNS-strip on block** conflicts with SEO equity: a blocked domain that still ranks on Google should keep its DNS + get a manual 301 to a fresh domain instead (equity transfers in ~2–6 weeks). Don't let cleanup run on ranking domains — remove them from the pool first if you want to 301 them.
- TrustPositif blocks **hostnames** (ISP DNS poisoning). Changing a blocked domain's DNS/IP does nothing; the name is dead. New name + stable shortener link is the only pattern that works.
- Telegram heartbeat fires after **every** check (~48/day, both crons) — disable with `NOTIFY_HEARTBEAT=false` in server `.env`.

## 🗺️ Open items / roadmap
- **Google Search Console integration** (scoped, not built): service-account key → dashboard card; monitor index status + rankings per pool domain; auto-submit is ToS-risky (Indexing API is for JobPosting/BroadcastPage).
- **301-walk orchestration** for the #1-ranking blocked domain (user to pick donor/recipient).
- Add `gudangspin.id` as a serving backup so failover has headroom.

---

## 📜 Legacy / other services on the VPS (do not break)
Traefik (80/443, LE certs, routes everything) · Chatwoot (`chat.nusantaragold.cloud`) · Evolution API (WhatsApp `GS-Chatbot` → Chatwoot inbox 3, instance port changes on recreate — use the Traefik HTTPS URL) · togel-bot · n8n. AnyMHost shared hosting (`163.223.227.5`) hosts the old-project site (`gudangspin.click`); its cPanel addon-domain API is stripped — new domains go through Cloudflare, not cPanel.

*MIT license. Maintained by leonmogarius.*
