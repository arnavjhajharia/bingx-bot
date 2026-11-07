const crypto = require("crypto");
const http = require("http");
const store = require("./store");
const { BingXClient, proxied } = require("./bingx");
const { rebalanceAccount, runDue, isRunning, closeBook, equityOf, bookPositions, ensureOneWay } = require("./rebalance");
const { loadPortfolio, quotes } = require("./portfolio");

const port = Number(process.env.PORT) || 3000;
/** Smallest account the bot accepts, in USDT. Below it, legs fall under BingX's order minimums. */
const MIN_EQUITY_USDT = Number(process.env.MIN_EQUITY_USDT) || 100;
const hits = new Map();

/** Only the Xade frontend's server calls this service, with the shared BOT_TOKEN. */
function authorized(req) {
  const expected = process.env.BOT_TOKEN || "";
  const header = req.headers.authorization || "";
  if (expected.length < 32 || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

/** Ten connect attempts per user (or IP) per hour. */
function limited(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((time) => now - time < 60 * 60 * 1000);
  const over = recent.length >= 10;
  if (!over) recent.push(now);
  hits.set(key, recent);
  return over;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  if (path === "/health") return sendJson(res, 200, { ok: true, service: "bingx-bot", host: process.env.BINGX_HOST || "open-api.bingx.com", proxied: proxied() });
  if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

  if (req.method === "GET" && path === "/prices") {
    return sendJson(res, 200, await quotes((url.searchParams.get("symbols") || "").split(",")));
  }

  if (req.method === "GET" && path === "/activity/summary") {
    return sendJson(res, 200, { summary: await store.activitySummary() });
  }

  if (req.method === "GET" && path === "/activity") {
    return sendJson(res, 200, {
      activity: await store.listActivity({
        book: url.searchParams.get("book") || "",
        accountId: url.searchParams.get("accountId") || "",
        kind: url.searchParams.get("kind") || "",
        limit: url.searchParams.get("limit"),
      }),
    });
  }

  // Find a user's account by the owner id the connect stored, so a new device or login restores it.
  if (req.method === "GET" && path === "/owner-account") {
    const ownerId = (url.searchParams.get("ownerId") || "").trim();
    if (!ownerId) return sendJson(res, 400, { error: "Missing owner" });
    const row = await store.accountByOwner(ownerId);
    if (!row) return sendJson(res, 404, { error: "No account for this owner" });
    return sendJson(res, 200, { accountId: row.id });
  }

  const accountMatch = path.match(/^\/accounts\/([0-9a-f-]{36})$/i);
  const portfolioMatch = path.match(/^\/accounts\/([0-9a-f-]{36})\/portfolio$/i);

  if (req.method === "POST" && path === "/accounts") {
    const body = await readBody(req);
    const ownerId = String(body.ownerId || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    const apiSecret = String(body.apiSecret || "").trim();
    if (!ownerId) return sendJson(res, 400, { error: "Missing the signed-in user." });
    if (limited(ownerId)) return sendJson(res, 429, { error: "Too many attempts. Try again later." });
    if (!/^[A-Za-z0-9]{16,256}$/.test(apiKey) || !/^[A-Za-z0-9]{16,256}$/.test(apiSecret)) {
      return sendJson(res, 400, { error: "Enter the API key and secret from BingX." });
    }
    const probe = new BingXClient(apiKey, apiSecret);
    let equity;
    try {
      equity = await equityOf(probe);
    } catch (error) {
      return sendJson(res, 400, { error: `BingX didn't accept this key: ${error.message}` });
    }
    if (equity < MIN_EQUITY_USDT) {
      return sendJson(res, 400, { error: `Fund your BingX perpetual futures account with at least ${MIN_EQUITY_USDT} USDT first. It has ${equity.toFixed(2)}.` });
    }
    const modeProblem = await ensureOneWay(probe).catch((error) => error.message);
    if (modeProblem) return sendJson(res, 400, { error: modeProblem });

    const accountId = await store.saveAccount({ ownerId, apiKey, apiSecret, equity, book: "flywheel" });
    await store.recordActivity({
      book: "flywheel",
      accountId,
      ownerId,
      kind: "connect",
      equity,
      ok: true,
      detail: apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "key",
    });
    rebalanceAccount(accountId).catch((error) => console.error(`first rebalance ${accountId.slice(0, 8)}: ${error.message}`));
    return sendJson(res, 200, { accountId, started: true });
  }

  if ((accountMatch || portfolioMatch) && req.method === "GET") {
    const row = await store.getAccount((accountMatch || portfolioMatch)[1]);
    if (!row) return sendJson(res, 404, { error: "Account not found" });
    if (portfolioMatch) return sendJson(res, 200, await loadPortfolio(row));
    const client = new BingXClient(row.api_key, await store.secretOf(row));
    const live = await bookPositions(client)
      .then((positions) => ({ positions: [...positions].filter(([, qty]) => qty !== 0).map(([coin, qty]) => ({ symbol: `${coin}-USDT`, side: qty < 0 ? "short" : "long", quantity: Math.abs(qty) })) }))
      .catch((error) => ({ error: error.message }));
    return sendJson(res, 200, {
      connected: true,
      ...store.publicAccount(row),
      running: isRunning(row.id),
      positions: live.positions || [],
      positionsError: live.error || null,
    });
  }

  if (accountMatch && req.method === "DELETE") {
    const row = await store.getAccount(accountMatch[1]);
    if (!row) return sendJson(res, 404, { error: "Account not found" });
    // Closing is a separate choice the user makes: ?close=true closes the bot's coins first.
    if (url.searchParams.get("close") === "true") {
      const client = new BingXClient(row.api_key, await store.secretOf(row));
      const errors = await closeBook(client, row.id, "exit");
      if (errors.length) {
        await store.recordActivity({ book: row.book || "flywheel", accountId: row.id, ownerId: row.owner_id, kind: "disconnect", ok: false, detail: errors.join("; ") });
        return sendJson(res, 502, { error: `Some positions did not close: ${errors.join("; ")}` });
      }
    }
    await store.recordActivity({ book: row.book || "flywheel", accountId: row.id, ownerId: row.owner_id, kind: "disconnect", ok: true });
    await store.deleteAccount(row.id);
    return sendJson(res, 200, { disconnected: true });
  }

  return sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("request", error.message);
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong" });
  });
});

if (require.main === module) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`BingX bot listening on ${port} against ${process.env.BINGX_HOST || "open-api.bingx.com"}`);
    store
      .migrate()
      .then(() => {
        console.log("database ready");
        const run = () => runDue().catch((error) => console.error("rebalance", error.message));
        setTimeout(run, 5000);
        setInterval(run, 15 * 60 * 1000);
      })
      .catch((error) => console.error("database", error.message));
  });
}

module.exports = { handle, authorized };
