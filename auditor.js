const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const { URL } = require("url");

const MAX_PAGES = 50;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 375, height: 812 },
];

const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "best-practice",
];

class Auditor {
  constructor(emit, { baseUrl, seedPaths = ["/"] } = {}) {
    this.emit = emit;
    this.baseUrl = baseUrl;
    this.seedPaths = seedPaths;
    this.visited = new Set();
    this.queue = [];
    this.allViolations = [];
  }

  async run() {
    this.emit("status", { message: `Launching browser for ${this.baseUrl}...` });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    // Seed the queue
    for (const p of this.seedPaths) {
      const url = new URL(p, this.baseUrl).href;
      if (!this.visited.has(url)) {
        this.queue.push(url);
        this.visited.add(url);
      }
    }

    let pageIndex = 0;

    while (this.queue.length > 0 && pageIndex < MAX_PAGES) {
      const url = this.queue.shift();
      pageIndex++;

      this.emit("page-start", {
        url,
        pageIndex,
        totalQueued: this.queue.length + pageIndex,
      });

      for (const vp of VIEWPORTS) {
        try {
          await this.auditPage(context, url, vp, pageIndex);
        } catch (err) {
          this.emit("page-error", {
            url,
            viewport: vp.name,
            error: err.message,
          });
        }
      }

      // Discover links from the page (desktop viewport only)
      if (this.visited.size < MAX_PAGES) {
        try {
          await this.discoverLinks(context, url);
        } catch (_) {
          // ignore discovery errors
        }
      }

      this.emit("page-done", { url, pageIndex });
    }

    await browser.close();

    this.emit("complete", {
      totalPages: pageIndex,
      totalViolations: this.allViolations.length,
      violations: this.allViolations,
    });
  }

  async auditPage(context, url, viewport, pageIndex) {
    const page = await context.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Wait a bit for JS rendering
      await page.waitForTimeout(1500);

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();

      for (const v of results.violations) {
        for (const node of v.nodes) {
          const violation = {
            url,
            viewport: viewport.name,
            pageIndex,
            ruleId: v.id,
            impact: v.impact,
            description: v.description,
            help: v.help,
            helpUrl: v.helpUrl,
            wcagTags: v.tags.filter((t) => t.startsWith("wcag") || t === "best-practice"),
            target: node.target.join(", "),
            html: (node.html || "").slice(0, 200),
          };
          this.allViolations.push(violation);
          this.emit("violation", violation);
        }
      }

      this.emit("page-audit", {
        url,
        viewport: viewport.name,
        violationCount: results.violations.reduce((s, v) => s + v.nodes.length, 0),
        passCount: results.passes.length,
      });
    } finally {
      await page.close();
    }
  }

  async discoverLinks(context, url) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const hrefs = await page.$$eval("a[href]", (anchors) =>
        anchors.map((a) => a.href)
      );

      const baseHost = new URL(this.baseUrl).host;
      for (const href of hrefs) {
        try {
          const parsed = new URL(href);
          // Same domain, no fragments/query, http(s) only
          if (
            parsed.host === baseHost &&
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            !parsed.hash
          ) {
            const clean = parsed.origin + parsed.pathname.replace(/\/$/, "") + "/";
            if (!this.visited.has(clean) && this.visited.size < MAX_PAGES) {
              this.visited.add(clean);
              this.queue.push(clean);
            }
          }
        } catch (_) {}
      }
    } finally {
      await page.close();
    }
  }
}

module.exports = { Auditor };
