# 🚪 Landing Gateway — Anti-Block Domain Rotator

Static landing pages that serve as anti-block gateways. They redirect users to your main application hosted on rotating destination domains, bypassing DNS-level domain blocking (TrustPositif). A central **Control Plane** (Docker) tracks which destination domains are blocked and serves only the active ones.

## 🏗️ Architecture

```
┌──────────────────────────────┐        ┌─────────────────────────────────┐
│  Landing pages (static)       │ fetch  │  Control Plane (Docker, VPS)     │
│  Netlify / Vercel / CF Pages  │──────▶│  https://srv1755625.hstgr.cloud  │
│  landing/<variant>/           │        │  /api/status → current domain    │
└──────────────────────────────┘        └────────────┬────────────────────┘
        │ redirect (after countdown)                 │ hourly TrustPositif check
        ▼                                            ▼
   Current destination domain  ◀── auto-promotes on block + Telegram alert
```

- **Landing pages** are pure static files, deployable anywhere. They fetch the active destination from the Control Plane and redirect.
- **Control Plane** (in `gateway-control/`) is a Dockerized Node app that checks destination domains against the TrustPositif blocklist hourly, tracks status in SQLite, and auto-promotes a backup when the current destination is blocked.

## 📁 Repo Structure

```
clever-tesla/
├── gateway-control/              ← Control Plane (Docker) — the brain
│   ├── server.js                 ← API + TrustPositif checker + cron
│   ├── index.html                ← Admin dashboard
│   ├── Dockerfile
│   ├── docker-compose.yml        ← includes Traefik labels for HTTPS
│   └── ...
├── landing/                      ← Landing page variants (deploy these)
│   ├── stealth-tesla/            ← Variant 1: cyberpunk gold/purple
│   ├── stealth-neon/             ← Variant 2: dark blue/cyan glass
│   └── stealth-clean/            ← Variant 3: light minimal
├── netlify.toml                  ← Netlify deploy config (primary variant)
├── vercel.json                   ← Vercel deploy config (primary variant)
└── README.md
```

Each variant in `landing/` is **self-contained** — its own `index.html`, `config.js`, `script.js`, `style.css`, and `assets/`. They all fetch from the same Control Plane; only the branding/visual design differs.

## 🚀 Deploy a Landing Variant

Every variant deploys the same way: point a static host at the variant folder. No build step.

### Netlify
1. Netlify → **Add new site** → **Import from Git** → pick this repo
2. **Build command:** *(leave empty)*
3. **Publish directory:** `landing/stealth-tesla/` (or whichever variant)
4. Deploy. You get `https://<site>.netlify.app`.
5. **For more variants:** repeat, setting Publish directory to `landing/stealth-neon/`, etc. Each becomes its own Netlify site/URL.

### Vercel
1. Vercel → **Add New Project** → import this repo
2. **Framework Preset:** Other
3. **Root Directory:** set to `landing/stealth-tesla/` (or chosen variant)
4. **Build Command:** *(none)*  **Output Directory:** `.`
5. Deploy. `vercel.json` at repo root applies security headers automatically.
6. **For more variants:** create separate Vercel projects, each with a different Root Directory.

### Cloudflare Pages
1. Cloudflare Dashboard → **Pages** → **Create project** → connect Git
2. **Build output directory:** `landing/stealth-tesla/`
3. Deploy. Generous free tier + fast CDN.

### GitHub Pages
- Works but slower and less header control. Push variant contents to a `gh-pages` branch or use Actions.

## ⚙️ Configure a Variant

Edit `landing/<variant>/config.js`:

```js
const CONFIG = {
  brandName: "YOUR BRAND",          // shown on page + SEO
  tagline: "Welcome to the gateway",
  metaDescription: "Official gateway for YOUR BRAND",
  siteUrl: "https://yourlanding.netlify.app",
  heroImage: "./assets/hero.jpg",
  centralApiUrl: "https://srv1755625.hstgr.cloud",  // Control Plane (HTTPS!)
  redirectDelay: 5,                                  // seconds
  domains: ["https://fallback.example.com"],         // used if Control Plane down
  rotationStrategy: "random",                        // "random" | "sequential"
};
```

> ⚠️ **Keep keywords OUT of `index.html`.** All visible/SEO content is injected by `script.js` from `config.js` at runtime. This is the anti-block design — raw HTML has no industry keywords for TrustPositif to flag.

## 🎛️ Control Plane (Docker)

The Control Plane runs on a VPS and manages the destination domain pool.

### Deploy
```bash
cd gateway-control
cp .env.example .env          # set ADMIN_API_KEY, TELEGRAM_*, (optional TP_API_KEY)
docker compose up -d --build
```

### Endpoints
- `GET /api/status` — **public.** Returns `{ current, active, count, lastChecked }`. Landing pages fetch this.
- `POST /api/manage` — **admin** (`X-API-Key` header). Actions: `list`, `add`, `remove`, `set-current`, `toggle-monitor`, `check-now`.
- `GET /health` — health check.
- `GET /` — admin dashboard (log in with API key).

### How the rotation works (Single Current Domain model)
- One domain is the **current destination** — all landing pages redirect there.
- The Control Plane checks the current domain every **30 min** and the full pool every **6 h** against TrustPositif.
- When the current domain is **blocked**, it auto-promotes the oldest active backup and sends a Telegram alert (`🔄 AUTO-SWITCHED DESTINATION`).
- **Monitor-only** domains are checked but never served/promoted (for observation).

See `gateway-control/README-DOCKER.md` for full Docker deploy details.

## 🛡️ Anti-Block Strategy Notes

- **TrustPositif** blocks at the **hostname/URL and IP level**, enforced via DNS poisoning + HTTP filtering by Indonesian ISPs.
- Landing pages use **brand-safe SEO** (no industry keywords in HTML) to avoid keyword-crawler flagging.
- `Referrer-Policy: no-referrer` (set in netlify.toml/vercel.json) prevents the target server from seeing the landing page URL.
- Destinations should be **distinct root domains on different IPs** for maximum resilience (a blocked root domain can pre-block its subdomains; a shared IP block kills all domains on it).

## 🔍 Google Indexing (Minimum Technical SEO)

Each variant includes brand-safe SEO in the raw HTML (title, description, canonical, Open Graph) so Google can index it without relying on JS rendering. Industry keywords stay JS-injected to avoid TrustPositif flagging.

### To submit a site to Google Search Console
For each deployed variant (repeat per URL):

1. Go to **[Google Search Console](https://search.google.com/search-console)** → Add property
2. Add the URL prefix (e.g. `https://latoto89.netlify.app/`)
3. **Verify ownership** — easiest is the **HTML tag** method:
   - GSC gives you a `<meta name="google-site-verification" content="...">` tag
   - Add it to the variant's `index.html` `<head>`, commit, push
   - Click "Verify" in GSC (wait for deploy to finish first)
4. Submit the sitemap: **Sitemaps** → enter `sitemap.xml` → Submit
5. Use **URL Inspection** → "Request indexing" for the homepage to speed up the initial crawl

> ⏱️ Indexing a brand-new domain typically takes **days to weeks**. No way to force it faster. GSC will show "Indexed" status when it happens.

### Verification meta tag (per variant)
When you add the Google verification tag, place it in the `<head>` of the specific variant's `index.html`:
- `landing/stealth-tesla/index.html` → for `clever-tesla.vercel.app`
- `landing/stealth-neon/index.html` → for `latoto89.netlify.app`
- `landing/stealth-clean/index.html` → for `clever-clean.suigom-kdt.workers.dev`

### What Google sees (pre-JS)
Each variant's raw HTML now contains brand-safe content Google can index immediately:
- **stealth-tesla**: `<title>HERMANTOTO - Link Resmi</title>`
- **stealth-neon**: `<title>LATOTO - Link Resmi</title>`
- **stealth-clean**: `<title>GUDANGSPIN - Link Resmi</title>`

### SEO expectations (honest)
- **Realistic**: these pages may get indexed (appear in Google's database) but will rank **low** for competitive terms. They're best used with **direct-link distribution** (Telegram, WhatsApp, affiliates) rather than relying on organic search.
- **Why**: these are "doorway pages" by design (thin content → redirect). Google's Helpful Content system eventually de-ranks doorway pages regardless of SEO. The brand-safe HTML gives you the *chance* to be indexed; direct links give you the *traffic*.

## 📝 License

MIT
