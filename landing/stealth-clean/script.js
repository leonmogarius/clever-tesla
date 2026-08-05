/**
 * ═══════════════════════════════════════════════════════════════════
 *  LANDING PAGE SCRIPT
 *  Handles: SEO injection, domain rotation, countdown, redirect.
 *
 *  Reads all settings from CONFIG (defined in config.js).
 *  No industry keywords are present in this file.
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
  "use strict";

  let activeDomainsList = [];

  /* ── Wait for DOM ─────────────────────────────────────────────── */
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    if (typeof CONFIG === "undefined") {
      console.error("[Gateway] config.js not loaded or CONFIG not defined.");
      return;
    }

    // Pre-populate with fallback domains from config
    activeDomainsList = CONFIG.domains || [];

    injectSEO();
    injectContent();
    // Await the control-plane lookup BEFORE starting the countdown/redirect.
    // Previously this fired-and-forgot in parallel with startCountdown(), so a
    // slow cross-origin fetch (>5s) lost the race and the fallback was always used.
    await fetchActiveDomains();
    startCountdown();
  }

  /* ── Inject Brand-Safe SEO into <head> ────────────────────────── */
  function injectSEO() {
    const { brandName, metaDescription, siteUrl } = CONFIG;

    // Page title
    document.title = brandName || "Gateway";

    // Meta description
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute("content", metaDescription || "");

    // Canonical
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute("href", siteUrl || "");

    // Open Graph
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute("content", brandName || "");

    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute("content", metaDescription || "");

    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute("content", siteUrl || "");
  }

  /* ── Inject visible content from config ───────────────────────── */
  function injectContent() {
    const { brandName, tagline, heroImage } = CONFIG;

    // Brand name
    const brandEl = document.getElementById("brand-name");
    if (brandEl) brandEl.textContent = brandName || "GATEWAY";

    // Tagline
    const taglineEl = document.getElementById("tagline");
    if (taglineEl) taglineEl.textContent = tagline || "";

    // Hero image
    const heroImg = document.getElementById("hero-img");
    if (heroImg && heroImage) {
      heroImg.src = heroImage;
    }
  }

  /* ── Fetch active domains from Control Plane ──────────────────── */
  async function fetchActiveDomains() {
    const { centralApiUrl } = CONFIG;
    if (
      !centralApiUrl ||
      centralApiUrl.includes("your-control-plane") ||
      centralApiUrl.includes("your-server-ip")
    ) {
      console.log("[Gateway] No central control plane configured. Using config.js fallback.");
      return;
    }

    try {
      console.log("[Gateway] Fetching domain list from control plane...");
      // Race the fetch against a timeout so a dead/slow control plane doesn't
      // stall the redirect indefinitely. Falls back to config.domains on timeout.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.controlPlaneTimeoutMs ?? 4000);
      const res = await fetch(`${centralApiUrl}/api/status`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        // Prefer the single "current" destination; fall back to first active for backward compat.
        if (data.success && data.current) {
          activeDomainsList = [data.current];
          console.log("[Gateway] Loaded current destination:", data.current);
        } else if (data.success && Array.isArray(data.active) && data.active.length > 0) {
          activeDomainsList = [data.active[0]];
          console.log("[Gateway] No current set; using first active domain:", data.active[0]);
        } else {
          console.warn("[Gateway] Control plane returned no current/active domain.");
        }
      } else {
        console.warn("[Gateway] Control plane status API returned non-OK status:", res.status);
      }
    } catch (e) {
      console.warn("[Gateway] Control plane API unreachable. Sticking to fallback domains. Error:", e);
    }
  }

  /* ── Domain Selection ─────────────────────────────────────────── */
  function pickDomain() {
    const { rotationStrategy } = CONFIG;

    if (!activeDomainsList || activeDomainsList.length === 0) {
      console.error("[Gateway] No active domains available.");
      return null;
    }

    if (activeDomainsList.length === 1) {
      return activeDomainsList[0];
    }

    if (rotationStrategy === "sequential") {
      return pickSequential(activeDomainsList);
    }

    // Default: random
    return activeDomainsList[Math.floor(Math.random() * activeDomainsList.length)];
  }

  function pickSequential(domains) {
    const key = "gw_domain_index";
    let index = 0;

    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        index = (parseInt(stored, 10) + 1) % domains.length;
      }
      localStorage.setItem(key, index.toString());
    } catch (e) {
      // localStorage unavailable — fall back to random
      index = Math.floor(Math.random() * domains.length);
    }

    return domains[index];
  }

  /* ── Redirect ─────────────────────────────────────────────────── */
  function redirect() {
    const target = pickDomain();
    if (target) {
      window.location.href = target;
    } else {
      console.error("[Gateway] Redirect failed. No active target found.");
    }
  }

  /* ── Countdown & CTA ──────────────────────────────────────────── */
  function startCountdown() {
    const delay = CONFIG.redirectDelay ?? 5;
    const ctaBtn = document.getElementById("cta-btn");
    const countdownEl = document.getElementById("countdown");
    const countdownNum = document.getElementById("countdown-number");

    // Instant redirect
    if (delay <= 0) {
      if (countdownEl) countdownEl.style.display = "none";
      redirect();
      return;
    }

    let remaining = delay;

    // Update display
    if (countdownNum) countdownNum.textContent = remaining;

    // CTA click — redirect immediately
    if (ctaBtn) {
      ctaBtn.addEventListener("click", function () {
        redirect();
      });
    }

    // Countdown timer
    const interval = setInterval(function () {
      remaining--;

      if (countdownNum) countdownNum.textContent = remaining;

      if (ctaBtn) {
        ctaBtn.textContent = remaining > 0
          ? "ENTER (" + remaining + ")"
          : "REDIRECTING...";
      }

      if (remaining <= 0) {
        clearInterval(interval);
        redirect();
      }
    }, 1000);

    // Initial button text
    if (ctaBtn) {
      ctaBtn.textContent = "ENTER (" + remaining + ")";
    }
  }

})();
