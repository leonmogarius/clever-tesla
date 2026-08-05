/**
 * ═══════════════════════════════════════════════════════════════
 *  LANDING PAGE CONFIGURATION — stealth-neon variant
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

  brandName: "NEON HUB",
  tagline: "Your link is ready",
  metaDescription: "Official gateway for NEON HUB",
  siteUrl: "https://yourlanding.netlify.app",

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
    "https://domain-a.example.com",
    "https://domain-b.example.com",
    "https://domain-c.example.com",
  ],

  // "random" = pick a random domain each visit
  // "sequential" = cycle through domains in order (tracked via localStorage)
  rotationStrategy: "random",
};
