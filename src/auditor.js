const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const { URL } = require("url");

const MAX_PAGES = parseInt(process.env.MAX_PAGES, 10) || 50;
const PAGE_TIMEOUT_MS = parseInt(process.env.PAGE_TIMEOUT_MS, 10) || 30000;
const DISCOVERY_TIMEOUT_MS = parseInt(process.env.DISCOVERY_TIMEOUT_MS, 10) || 20000;
const SITEMAP_TIMEOUT_MS = parseInt(process.env.SITEMAP_TIMEOUT_MS, 10) || 10000;
const RENDER_WAIT_MS = parseInt(process.env.RENDER_WAIT_MS, 10) || 1500;

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 375, height: 812 },
];

const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
  "best-practice",
];

// Map axe-core SC tags (e.g. "wcag258") to W3C Understanding doc slugs
const WCAG_SC_SLUGS = {
  // WCAG 2.0
  wcag111: "non-text-content", wcag121: "audio-only-and-video-only-prerecorded",
  wcag122: "captions-prerecorded", wcag123: "audio-description-or-media-alternative-prerecorded",
  wcag124: "captions-live", wcag125: "audio-description-prerecorded",
  wcag131: "info-and-relationships", wcag132: "meaningful-sequence", wcag133: "sensory-characteristics",
  wcag141: "use-of-color", wcag142: "audio-control", wcag143: "contrast-minimum",
  wcag144: "resize-text", wcag145: "images-of-text",
  wcag211: "keyboard", wcag212: "no-keyboard-trap",
  wcag221: "timing-adjustable", wcag222: "pause-stop-hide", wcag223: "no-three-flashes-or-below-threshold",
  wcag241: "bypass-blocks", wcag242: "page-titled", wcag243: "focus-order", wcag244: "link-purpose-in-context",
  wcag246: "headings-and-labels", wcag247: "focus-visible",
  wcag251: "pointer-gestures", wcag252: "pointer-cancellation", wcag253: "label-in-name",
  wcag254: "motion-actuation",
  wcag311: "language-of-page", wcag312: "language-of-parts",
  wcag321: "on-focus", wcag322: "on-input",
  wcag331: "error-identification", wcag332: "labels-or-instructions",
  wcag333: "error-suggestion", wcag334: "error-prevention-legal-financial-data",
  wcag412: "name-role-value",
  // WCAG 2.1
  wcag1310: "identify-input-purpose",
  wcag1311: "identify-purpose",
  wcag1312: "identify-purpose",
  wcag1313: "identify-purpose",
  wcag2411: "character-key-shortcuts",
  // WCAG 2.2
  wcag2411: "focus-not-obscured-minimum",
  wcag2412: "focus-not-obscured-enhanced",
  wcag2413: "focus-appearance",
  wcag257: "dragging-movements",
  wcag258: "target-size-minimum",
  wcag326: "consistent-help",
  wcag337: "redundant-entry",
  wcag338: "accessible-authentication-minimum",
  wcag339: "accessible-authentication-enhanced",
};

function wcagUnderstandingUrl(scTag) {
  const slug = WCAG_SC_SLUGS[scTag];
  if (slug) return `https://www.w3.org/WAI/WCAG22/Understanding/${slug}`;
  return null;
}

const NON_HTML_EXT_RE = /\.(?:pdf|jpe?g|png|gif|svg|webp|ico|css|js|mjs|map|json|xml|txt|zip|gz|mp[34]|mov|avi|webm|woff2?|ttf|eot)$/i;
const LOW_VALUE_PATH_RE = /\/(?:tag|tags|category|categories|author|authors|archive|archives|feed|rss|amp|print|share)(?:\/|$)/i;
const PAGINATION_PATH_RE = /\/page\/\d+(?:\/|$)/i;
const HIGH_VALUE_TEXT_RE = /\b(?:about|accessibility|book|contact|demo|docs|faq|features|get started|help|locations|pricing|product|products|request demo|schedule|service|services|solution|solutions|support|team)\b/i;

class Auditor {
  constructor(emit, { baseUrl, seedPaths = [], maxPages } = {}) {
    const requestedUrl = new URL(baseUrl);
    requestedUrl.hash = "";

    this.emit = emit;
    this.baseUrl = requestedUrl.href;
    this.maxPages = maxPages || MAX_PAGES;
    this.baseHost = requestedUrl.host;
    this.entryPathSegments = requestedUrl.pathname.split("/").filter(Boolean);
    this.canonicalHost = null;
    this.allowedHosts = new Set(this.expandEquivalentHosts(this.baseHost));
    this.seedUrls = [];
    this.visited = new Set();
    this.queue = [];
    this.queueByUrl = new Map();
    this.sitemapSeeded = false;
    this.allViolations = [];

    this.addSeedUrl(this.baseUrl);
    for (const seedPath of seedPaths) {
      this.addSeedUrl(new URL(seedPath, this.baseUrl).href);
    }
  }

  async run() {
    this.emit("status", { message: `Launching browser for ${this.baseUrl}...` });

    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
    });

    for (const seedUrl of this.seedUrls) {
      this.enqueueUrl(seedUrl, { depth: 0, score: 1000, source: "landing" });
    }
    this.emit("status", { message: `Starting crawl from ${this.seedUrls[0]}` });

    let pageIndex = 0;

    while (pageIndex < this.maxPages) {
      if (this.queue.length === 0 && !this.sitemapSeeded) {
        await this.discoverFromSitemap(context);
      }

      const next = this.dequeueUrl();
      if (!next) {
        this.emit("status", {
          message: `Crawl frontier exhausted after ${pageIndex} pages`,
        });
        break;
      }

      let current = next;
      pageIndex++;
      this.visited.add(current.url);

      this.emit("page-start", {
        url: current.url,
        pageIndex,
        depth: current.depth,
        totalQueued: Math.min(this.maxPages, this.visited.size + this.queue.length),
      });

      for (const vp of VIEWPORTS) {
        try {
          const resolvedUrl = await this.auditPage(context, current.url, vp, pageIndex);
          current = this.promoteCanonicalUrl(current, resolvedUrl);
        } catch (err) {
          this.emit("page-error", {
            url: current.url,
            pageIndex,
            viewport: vp.name,
            error: err.message,
          });
        }
      }

      if (pageIndex < this.maxPages) {
        try {
          const resolvedUrl = await this.discoverLinks(context, current);
          current = this.promoteCanonicalUrl(current, resolvedUrl);
        } catch (_) {
          // ignore discovery errors
        }
      }

      this.emit("page-done", { url: current.url, pageIndex, depth: current.depth });
    }

    await browser.close();

    this.emit("complete", {
      totalPages: pageIndex,
      totalViolations: this.allViolations.length,
      violations: this.allViolations,
    });
  }

  addSeedUrl(url) {
    const normalized = this.normalizeUrl(url, { allowUnknownHost: true });
    if (normalized && !this.seedUrls.includes(normalized)) {
      this.seedUrls.push(normalized);
    }
  }

  enqueueUrl(url, { depth = 0, score = 0, source = "link" } = {}) {
    const normalized = this.normalizeUrl(url);
    if (!normalized || this.visited.has(normalized)) return false;

    const existing = this.queueByUrl.get(normalized);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      existing.score += score;
      existing.hits += 1;
      this.sortQueue();
      return false;
    }

    const entry = { url: normalized, depth, score, hits: 1, source };
    this.queue.push(entry);
    this.queueByUrl.set(normalized, entry);
    this.sortQueue();
    return true;
  }

  dequeueUrl() {
    const next = this.queue.shift();
    if (next) this.queueByUrl.delete(next.url);
    return next;
  }

  dropQueuedUrl(url) {
    const existing = this.queueByUrl.get(url);
    if (!existing) return;
    this.queueByUrl.delete(url);
    this.queue = this.queue.filter((entry) => entry.url !== url);
  }

  sortQueue() {
    this.queue.sort((a, b) =>
      a.depth - b.depth ||
      b.score - a.score ||
      a.url.localeCompare(b.url)
    );
  }

  promoteCanonicalUrl(entry, resolvedUrl) {
    if (!resolvedUrl || resolvedUrl === entry.url) return entry;
    this.visited.add(resolvedUrl);
    this.dropQueuedUrl(resolvedUrl);
    return { ...entry, url: resolvedUrl };
  }

  expandEquivalentHosts(host) {
    if (!host) return [];
    return host.startsWith("www.")
      ? [host, host.slice(4)]
      : [host, `www.${host}`];
  }

  isEquivalentHost(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const normalize = (host) => host.replace(/^www\./, "");
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return true;
    // treat subdomains of the base domain as equivalent
    return na.endsWith(`.${nb}`) || nb.endsWith(`.${na}`);
  }

  observeResolvedUrl(url) {
    try {
      const parsed = new URL(url);
      if (!this.isEquivalentHost(parsed.host, this.baseHost)) return null;

      if (!this.canonicalHost) {
        this.canonicalHost = parsed.host;
      }
      for (const host of this.expandEquivalentHosts(parsed.host)) {
        this.allowedHosts.add(host);
      }

      return this.normalizeUrl(parsed.href, { allowUnknownHost: true });
    } catch (_) {
      return null;
    }
  }

  isCrawlablePath(pathname) {
    return !NON_HTML_EXT_RE.test(pathname || "") &&
      !LOW_VALUE_PATH_RE.test(pathname || "") &&
      !PAGINATION_PATH_RE.test(pathname || "");
  }

  normalizeUrl(url, { allowUnknownHost = false } = {}) {
    try {
      const parsed = new URL(url, this.baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

      const hostMatchesBase =
        this.isEquivalentHost(parsed.host, this.baseHost) ||
        (this.canonicalHost && this.isEquivalentHost(parsed.host, this.canonicalHost));

      if (!allowUnknownHost && !hostMatchesBase && !this.allowedHosts.has(parsed.host)) {
        return null;
      }

      if (hostMatchesBase) {
        parsed.host = this.canonicalHost || this.baseHost;
      }

      parsed.hash = "";
      parsed.search = "";

      if (!this.isCrawlablePath(parsed.pathname)) return null;

      const pathname = (parsed.pathname || "/").replace(/\/+$/, "") || "/";
      return `${parsed.protocol}//${parsed.host}${pathname}`;
    } catch (_) {
      return null;
    }
  }

  scoreLink(url, link, depth) {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const text = (link.text || "").toLowerCase();

    let score = Math.max(0, 120 - depth * 18);
    if (link.section === "nav") score += 40;
    else if (link.section === "content") score += 24;
    else if (link.section === "page") score += 10;
    else if (link.section === "footer") score -= 8;

    if (segments.length === 0) score += 14;
    else if (segments.length === 1) score += 10;
    else if (segments.length === 2) score += 5;
    else score -= Math.min(18, (segments.length - 2) * 6);

    if (this.entryPathSegments[0] && segments[0] === this.entryPathSegments[0]) {
      score += 10;
    }

    if (HIGH_VALUE_TEXT_RE.test(parsed.pathname) || HIGH_VALUE_TEXT_RE.test(text)) score += 10;
    if (/\d{4}/.test(parsed.pathname)) score -= 18;
    if (segments.some((segment) => /\d{3,}/.test(segment))) score -= 10;
    if (LOW_VALUE_PATH_RE.test(parsed.pathname) || PAGINATION_PATH_RE.test(parsed.pathname)) score -= 25;

    return score;
  }

  async settlePage(page, networkIdleTimeout = 5000) {
    try {
      await page.waitForLoadState("networkidle", { timeout: networkIdleTimeout });
    } catch (_) {}

    if (RENDER_WAIT_MS > 0) {
      await page.waitForTimeout(RENDER_WAIT_MS);
    }
  }

  async auditPage(context, url, viewport, pageIndex) {
    const page = await context.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      await this.settlePage(page);

      const resolvedUrl = this.observeResolvedUrl(page.url()) || url;

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();

      for (const v of results.violations) {
        const wcagTags = v.tags.filter((t) => t.startsWith("wcag") || t === "best-practice");
        const wcagUrls = [];
        for (const tag of v.tags) {
          const url = wcagUnderstandingUrl(tag);
          if (url) wcagUrls.push(url);
        }
        for (const node of v.nodes) {
          const violation = {
            url: resolvedUrl,
            viewport: viewport.name,
            pageIndex,
            ruleId: v.id,
            impact: v.impact,
            description: v.description,
            help: v.help,
            helpUrl: v.helpUrl,
            wcagTags,
            wcagUrls,
            target: node.target.join(", "),
            html: (node.html || "").slice(0, 200),
          };
          this.allViolations.push(violation);
          this.emit("violation", violation);
        }
      }

      this.emit("page-audit", {
        url: resolvedUrl,
        pageIndex,
        viewport: viewport.name,
        violationCount: results.violations.reduce((s, v) => s + v.nodes.length, 0),
        passCount: results.passes.length,
      });

      return resolvedUrl;
    } finally {
      await page.close();
    }
  }

  async discoverLinks(context, entry) {
    const page = await context.newPage();
    try {
      await page.goto(entry.url, {
        waitUntil: "domcontentloaded",
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      await this.settlePage(page, 4000);

      const resolvedUrl = this.observeResolvedUrl(page.url()) || entry.url;
      const links = await page.$$eval("a[href]", (anchors) =>
        anchors.map((anchor) => ({
          href: anchor.href,
          text: (anchor.getAttribute("aria-label") || anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
          section:
            anchor.closest("nav, header, [role='navigation']") ? "nav" :
            anchor.closest("main, article, [role='main']") ? "content" :
            anchor.closest("footer") ? "footer" :
            "page",
        }))
      );

      let discovered = 0;
      for (const link of links) {
        const normalized = this.normalizeUrl(link.href);
        if (!normalized) continue;
        if (this.enqueueUrl(normalized, {
          depth: entry.depth + 1,
          score: this.scoreLink(normalized, link, entry.depth + 1),
          source: link.section,
        })) {
          discovered++;
        }
      }

      if (discovered > 0) {
        this.emit("status", {
          message: `Queued ${discovered} pages from ${resolvedUrl}`,
        });
      }

      return resolvedUrl;
    } finally {
      await page.close();
    }
  }

  async discoverFromSitemap(context) {
    const sitemapUrls = new Set();
    const base = new URL(this.baseUrl);
    const origins = new Set([base.origin]);

    if (this.canonicalHost) {
      origins.add(`${base.protocol}//${this.canonicalHost}`);
    }

    this.sitemapSeeded = true;

    for (const origin of origins) {
      try {
        const page = await context.newPage();
        try {
          await page.goto(`${origin}/robots.txt`, {
            waitUntil: "domcontentloaded",
            timeout: SITEMAP_TIMEOUT_MS,
          });
          const text = await page.textContent("body");
          const lines = text.split("\n");
          for (const line of lines) {
            const match = line.match(/^sitemap:\s*(.+)/i);
            if (match) sitemapUrls.add(match[1].trim());
          }
        } finally {
          await page.close();
        }
      } catch (_) {}

      sitemapUrls.add(`${origin}/sitemap.xml`);
    }

    let discovered = 0;
    for (const sitemapUrl of sitemapUrls) {
      try {
        const page = await context.newPage();
        try {
          await page.goto(sitemapUrl, {
            waitUntil: "domcontentloaded",
            timeout: SITEMAP_TIMEOUT_MS,
          });
          const locs = await page.$$eval("loc", (els) =>
            els.map((el) => el.textContent.trim())
          );

          for (const loc of locs) {
            const normalized = this.normalizeUrl(loc);
            if (!normalized) continue;
            if (this.enqueueUrl(normalized, {
              depth: 10,
              score: 1,
              source: "sitemap",
            })) {
              discovered++;
            }
          }
        } finally {
          await page.close();
        }
      } catch (_) {}
    }

    if (discovered > 0) {
      this.emit("status", {
        message: `Added ${discovered} sitemap pages after link discovery stalled`,
      });
    }
  }
}

module.exports = { Auditor };
