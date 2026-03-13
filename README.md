# a11y-checker

A real-time WCAG 2.1 AA accessibility auditor. Point it at any website and get a live dashboard showing violations as they're found.

Uses [Playwright](https://playwright.dev/) to crawl pages and [axe-core](https://github.com/dequelabs/axe-core) to run audits. Results stream to your browser via Server-Sent Events.

## Quick start

```bash
npm install
node server.js https://example.com
```

Then open [http://localhost:3000](http://localhost:3000) to watch the audit in real time.

You can also run `npm start` and enter the URL when prompted.

## What it does

- Crawls up to 50 pages starting from the URL you provide
- Tests every page at both desktop (1280×800) and mobile (375×812) viewports
- Checks against WCAG 2.1 Level AA criteria plus best practices
- Streams violations to a browser dashboard as they're found
- Exports a full JSON report when the audit completes (`/report.json`)

## Dashboard

The dashboard shows violations in real time with severity filtering (critical, serious, moderate, minor) and viewport filtering (desktop, mobile). Each violation links to the relevant axe-core documentation.

## Requirements

- Node.js 18+
- Chromium (installed automatically via Playwright on first run)

## License

MIT
