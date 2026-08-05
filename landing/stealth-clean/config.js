/**
 * ═══════════════════════════════════════════════════════════════
 *  LANDING PAGE CONFIGURATION — stealth-clean variant
 *  Edit this file to customize this landing page.
 *
 *  ⚠️  WARNING: Do NOT put industry-specific keywords here.
 *      Keep everything brand-name only to avoid TrustPositif
 *      keyword-based blocking.
 * ═══════════════════════════════════════════════════════════════
 */

const CONFIG = {

  // ── Brand & SEO ──────────────────────────────────────────────
  // These appear in the page title, meta tags, and on the page.
  // Keep them GENERIC — brand name only, no industry keywords!

  brandName: "GUDANGSPIN",
  tagline: "BANDAR JUDI SLOT TERGACOR 2026",
  metaDescription: "GUDANGSPIN situs agen judi online terbaik di Indonesia dengan permainan slot terlengkap dan bonus terbesar. Daftar sekarang dan nikmati kemudahannya!",
  siteUrl: "https://clever-clean.suigom-kdt.workers.dev",

  // ── Visual ───────────────────────────────────────────────────

  heroImage: "./assets/hero.jpg",

  // ── Central API ──────────────────────────────────────────────
  // Point this to your Docker Control Plane server (see gateway-control/).
  // Must be HTTPS if the landing page is served over HTTPS (browsers block
  // mixed content — an HTTPS page fetching an HTTP endpoint).
  centralApiUrl: "https://srv1755625.hstgr.cloud",

  // ── Redirect Settings ────────────────────────────────────────

  redirectDelay: 5,  // seconds before auto-redirect

  // Fallback domain pool — used if centralApiUrl is empty or unreachable.
  domains: [
    "https://gudangspin.site",
    "https://domain-b.example.com",
    "https://domain-c.example.com",
  ],

  // "random" = pick a random domain each visit
  // "sequential" = cycle through domains in order (tracked via localStorage)
  rotationStrategy: "random",
};
