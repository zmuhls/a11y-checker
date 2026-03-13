# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                # install deps (also runs `npx playwright install chromium` if first time)
npm start                  # or: node server.js <url> — starts audit + dashboard on :3000
```

No test suite or linter is configured.

## Architecture

Standalone Node.js app that crawls any website, runs axe-core WCAG 2.1 AA audits, and streams results to a browser dashboard via SSE.

### Data flow

```
server.js  →  prompts for URL (or accepts CLI arg), creates Auditor(emit, { baseUrl })
auditor.js →  Playwright crawls pages, injects axe-core, calls emit(event, data) per finding
server.js  →  broadcast() writes SSE to all connected /events clients
dashboard.html  →  EventSource("/events") renders violations in real-time log
```

### Key design decisions

- **Single shared browser context** — `auditor.js` reuses one Playwright `BrowserContext` across all pages (new `Page` per audit) for cookie/session sharing and lower overhead.
- **Emit callback pattern** — `Auditor` takes a single `emit(event, data)` function; `server.js` wires it to both SSE broadcast and console logging. To add new consumers (file logger, webhook), add another call in the emit callback.
- **Breadth-first crawl** — starts from `/`, then link discovery from each page. Capped at `MAX_PAGES` (50). Links are normalized (trailing slash, no fragments/query) to deduplicate.
- **Dual viewport** — every page audited at desktop (1280x800) and mobile (375x812). Each viewport is a separate axe run.
- **SSE events**: `status`, `page-start`, `page-audit`, `violation`, `page-done`, `page-error`, `complete`. The dashboard listens for all of these.
- **Final report** — stored in-memory as `finalReport`; served at `GET /report.json` after audit completes.

### Configuration constants (in `auditor.js`)

- `MAX_PAGES` — crawl cap
- `VIEWPORTS` — viewport dimensions array
- `WCAG_TAGS` — axe-core rule tags to include
