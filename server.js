const http = require("http");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Auditor } = require("./auditor");

const PORT = process.env.PORT || 3000;
const clients = new Set();
let finalReport = null;
let targetUrl = null;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

function startServer(baseUrl) {
  targetUrl = baseUrl;

  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.url === "/target") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: targetUrl }));
      return;
    }

    if (req.url === "/report.json" && finalReport) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(finalReport, null, 2));
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(path.join(__dirname, "dashboard.html")));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`\nDashboard: http://localhost:${PORT}`);
    console.log(`Target:    ${baseUrl}`);
    console.log("Starting audit...\n");

    const auditor = new Auditor((event, data) => {
      broadcast(event, data);

      if (event === "page-start") {
        console.log(`[${data.pageIndex}] Auditing: ${data.url}`);
      } else if (event === "violation") {
        const icon =
          data.impact === "critical" ? "!!" :
          data.impact === "serious" ? "!" : "-";
        console.log(`  ${icon} ${data.impact}: ${data.ruleId} (${data.viewport})`);
      } else if (event === "page-error") {
        console.log(`  ERROR: ${data.error} (${data.viewport})`);
      } else if (event === "complete") {
        console.log(`\nDone. ${data.totalPages} pages, ${data.totalViolations} violations.`);
        finalReport = data;
      }
    }, { baseUrl });

    auditor.run().catch((err) => {
      console.error("Audit failed:", err);
      broadcast("error", { message: err.message });
    });
  });
}

// Accept URL as CLI argument or prompt for it
const arg = process.argv[2];
if (arg) {
  startServer(arg);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Enter website URL to audit (e.g. https://example.com): ", (answer) => {
    rl.close();
    const url = answer.trim();
    if (!url) {
      console.error("No URL provided. Usage: node server.js <url>");
      process.exit(1);
    }
    startServer(url);
  });
}
