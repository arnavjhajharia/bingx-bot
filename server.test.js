const { test, describe, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// Configure the environment before server.js (and bingx.js) are loaded. Fake values only.
const TOKEN = "t".repeat(40);
process.env.BOT_TOKEN = TOKEN;
delete process.env.DATABASE_URL;
delete process.env.BINGX_PROXY_URL;
delete process.env.MIN_EQUITY_USDT;

const rebalance = require("./rebalance");
const portfolio = require("./portfolio");
const store = require("./store");
const { BingXClient } = require("./bingx");

// server.js destructures these at require time, so they must be mocked first and never restored.
const m = {
  equityOf: mock.method(rebalance, "equityOf", async () => 500),
  ensureOneWay: mock.method(rebalance, "ensureOneWay", async () => null),
  rebalanceAccount: mock.method(rebalance, "rebalanceAccount", async () => {}),
  bookPositions: mock.method(rebalance, "bookPositions", async () => new Map()),
  closeBook: mock.method(rebalance, "closeBook", async () => []),
  isRunning: mock.method(rebalance, "isRunning", () => false),
  loadPortfolio: mock.method(portfolio, "loadPortfolio", async () => ({})),
  quotes: mock.method(portfolio, "quotes", async () => ({})),
  saveAccount: mock.method(store, "saveAccount", async () => ACCOUNT_ID),
  getAccount: mock.method(store, "getAccount", async () => null),
  accountByOwner: mock.method(store, "accountByOwner", async () => null),
  secretOf: mock.method(store, "secretOf", async () => FAKE_SECRET),
  deleteAccount: mock.method(store, "deleteAccount", async () => {}),
  recordActivity: mock.method(store, "recordActivity", async () => {}),
};

const { handle, authorized } = require("./server");

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const FAKE_KEY = "FAKEKEYabcdefghij0123456789";
const FAKE_SECRET = "FAKESECRETabcdefghij0123456789";

function row(overrides = {}) {
  return {
    id: ACCOUNT_ID,
    owner_id: "owner-1",
    api_key: FAKE_KEY,
    secret_ciphertext: "c2VhbGVk",
    secret_iv: "aXY=",
    secret_tag: "dGFn",
    started_equity: 500,
    peak_equity: 520,
    halted: false,
    book: "flywheel",
    ...overrides,
  };
}

const defaults = {
  equityOf: async () => 500,
  ensureOneWay: async () => null,
  rebalanceAccount: async () => {},
  bookPositions: async () => new Map(),
  closeBook: async () => [],
  isRunning: () => false,
  loadPortfolio: async () => ({}),
  quotes: async () => ({}),
  saveAccount: async () => ACCOUNT_ID,
  getAccount: async () => null,
  accountByOwner: async () => null,
  secretOf: async () => FAKE_SECRET,
  deleteAccount: async () => {},
  recordActivity: async () => {},
};

let server;
let base;

before(async () => {
  // Same error wrapper server.js puts around handle(), so a thrown request becomes a 500.
  server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Something went wrong" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  for (const [name, fn] of Object.entries(m)) {
    fn.mock.mockImplementation(defaults[name]);
    fn.mock.resetCalls();
  }
});

async function call(path, { method = "GET", auth = `Bearer ${TOKEN}`, body } = {}) {
  const headers = {};
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: typeof body === "string" ? body : body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

function connect(overrides = {}) {
  return call("/accounts", { method: "POST", body: { ownerId: "owner-1", apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, ...overrides } });
}

describe("auth", () => {
  test("/health returns 200 without auth", async () => {
    const res = await call("/health", { auth: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  for (const [label, auth] of [
    ["missing", null],
    ["wrong length", `Bearer ${TOKEN}x`],
    ["wrong value", `Bearer ${"u".repeat(40)}`],
    ["non-Bearer", `Basic ${TOKEN}`],
    ["bare token", TOKEN],
  ]) {
    test(`${label} Authorization gives 401`, async () => {
      const res = await call("/prices?symbols=BTC", { auth });
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "Unauthorized" });
      assert.equal(m.quotes.mock.callCount(), 0);
    });
  }

  test("authorized() is false when BOT_TOKEN is shorter than 32 chars", () => {
    const original = process.env.BOT_TOKEN;
    try {
      const short = "s".repeat(31);
      process.env.BOT_TOKEN = short;
      assert.equal(authorized({ headers: { authorization: `Bearer ${short}` } }), false);
      process.env.BOT_TOKEN = "";
      assert.equal(authorized({ headers: { authorization: "Bearer " } }), false);
    } finally {
      process.env.BOT_TOKEN = original;
    }
    assert.equal(authorized({ headers: { authorization: `Bearer ${TOKEN}` } }), true);
  });
});

describe("GET /prices", () => {
  test("passes the split symbols to quotes", async () => {
    m.quotes.mock.mockImplementation(async () => ({ BTC: 1, ETH: 2 }));
    const res = await call("/prices?symbols=BTC,ETH,SOL");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { BTC: 1, ETH: 2 });
    assert.deepEqual(m.quotes.mock.calls[0].arguments, [["BTC", "ETH", "SOL"]]);
  });
});

describe("GET /owner-account", () => {
  test("400 without ownerId", async () => {
    const res = await call("/owner-account");
    assert.equal(res.status, 400);
    assert.equal(m.accountByOwner.mock.callCount(), 0);
  });

  test("404 when nothing is found", async () => {
    const res = await call("/owner-account?ownerId=nobody");
    assert.equal(res.status, 404);
    assert.deepEqual(m.accountByOwner.mock.calls[0].arguments, ["nobody"]);
  });

  test("200 with the accountId when found", async () => {
    m.accountByOwner.mock.mockImplementation(async () => row());
    const res = await call("/owner-account?ownerId=owner-1");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { accountId: ACCOUNT_ID });
  });
});

describe("POST /accounts", () => {
  test("400 for a missing ownerId", async () => {
    const res = await connect({ ownerId: "  " });
    assert.equal(res.status, 400);
    assert.equal(m.equityOf.mock.callCount(), 0);
  });

  for (const [label, overrides] of [
    ["short key", { apiKey: "abc123" }],
    ["key with symbols", { apiKey: "FAKEKEY-abc_def!ghij0123" }],
    ["short secret", { apiSecret: "abc" }],
    ["missing secret", { apiSecret: undefined }],
  ]) {
    test(`400 for a bad key/secret format (${label})`, async () => {
      const res = await connect({ ownerId: `format-${label}`, ...overrides });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "Enter the API key and secret from BingX.");
      assert.equal(m.equityOf.mock.callCount(), 0);
      assert.equal(m.saveAccount.mock.callCount(), 0);
    });
  }

  test("400 when BingX rejects the key", async () => {
    m.equityOf.mock.mockImplementation(async () => {
      throw new Error("Signature verification failed");
    });
    const res = await connect({ ownerId: "reject" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /^BingX didn't accept this key: Signature verification failed/);
    assert.equal(m.saveAccount.mock.callCount(), 0);
  });

  test("400 below MIN_EQUITY_USDT (100)", async () => {
    m.equityOf.mock.mockImplementation(async () => 99.5);
    const res = await connect({ ownerId: "poor" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 100 USDT/);
    assert.match(res.body.error, /99\.50/);
    assert.equal(m.ensureOneWay.mock.callCount(), 0);
    assert.equal(m.saveAccount.mock.callCount(), 0);
  });

  test("400 with the ensureOneWay message", async () => {
    m.ensureOneWay.mock.mockImplementation(async () => {
      throw new Error("Switch BingX to one-way mode first.");
    });
    const res = await connect({ ownerId: "hedge" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Switch BingX to one-way mode first." });
    assert.equal(m.saveAccount.mock.callCount(), 0);
  });

  test("200 saves the account and starts the first rebalance", async () => {
    const res = await connect({ ownerId: "happy" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { accountId: ACCOUNT_ID, started: true });
    assert.ok(m.equityOf.mock.calls[0].arguments[0] instanceof BingXClient);
    assert.equal(m.saveAccount.mock.callCount(), 1);
    const saved = m.saveAccount.mock.calls[0].arguments[0];
    assert.equal(saved.ownerId, "happy");
    assert.equal(saved.apiKey === FAKE_KEY, true);
    assert.equal(saved.apiSecret === FAKE_SECRET, true);
    assert.equal(saved.equity, 500);
    assert.equal(m.rebalanceAccount.mock.callCount(), 1);
    assert.deepEqual(m.rebalanceAccount.mock.calls[0].arguments, [ACCOUNT_ID]);
    assert.ok(!res.text.includes(FAKE_SECRET));
  });

  test("a failing first rebalance does not break the response", async () => {
    const quiet = mock.method(console, "error", () => {});
    m.rebalanceAccount.mock.mockImplementation(async () => {
      throw new Error("boom");
    });
    try {
      const res = await connect({ ownerId: "first-rebalance-fails" });
      assert.equal(res.status, 200);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      quiet.mock.restore();
    }
  });

  test("429 on the 11th attempt from the same ownerId", async () => {
    const ownerId = `rate-${Date.now()}-${Math.random()}`;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const res = await connect({ ownerId, apiKey: "bad" });
      assert.equal(res.status, 400, `attempt ${attempt}`);
    }
    const res = await connect({ ownerId });
    assert.equal(res.status, 429);
    assert.equal(m.equityOf.mock.callCount(), 0);
    // Another owner is not affected.
    const other = await connect({ ownerId: `${ownerId}-other` });
    assert.equal(other.status, 200);
  });

  test("invalid JSON gives 500 Something went wrong", async () => {
    const res = await call("/accounts", { method: "POST", body: "{not json" });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "Something went wrong" });
    assert.equal(m.saveAccount.mock.callCount(), 0);
  });
});

describe("GET /accounts/:id", () => {
  test("404 when the account is missing", async () => {
    const res = await call(`/accounts/${ACCOUNT_ID}`);
    assert.equal(res.status, 404);
    assert.deepEqual(m.getAccount.mock.calls[0].arguments, [ACCOUNT_ID]);
  });

  test("returns status with positions mapped and no secrets", async () => {
    m.getAccount.mock.mockImplementation(async () => row());
    m.isRunning.mock.mockImplementation(() => true);
    m.bookPositions.mock.mockImplementation(async () => new Map([["BTC", 0.5], ["ETH", -2], ["SOL", 0]]));
    const res = await call(`/accounts/${ACCOUNT_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, true);
    assert.equal(res.body.accountId, ACCOUNT_ID);
    assert.equal(res.body.running, true);
    assert.deepEqual(m.isRunning.mock.calls[0].arguments, [ACCOUNT_ID]);
    assert.deepEqual(res.body.positions, [
      { symbol: "BTC-USDT", side: "long", quantity: 0.5 },
      { symbol: "ETH-USDT", side: "short", quantity: 2 },
    ]);
    assert.equal(res.body.positionsError, null);
    for (const field of ["apiKey", "api_key", "apiSecret", "secret", "secret_ciphertext", "secret_iv", "secret_tag"]) {
      assert.equal(field in res.body, false, `${field} leaked`);
    }
    assert.ok(!res.text.includes(FAKE_KEY), "full key leaked");
    assert.ok(!res.text.includes(FAKE_SECRET), "secret leaked");
    assert.ok(!res.text.includes("c2VhbGVk"), "ciphertext leaked");
  });

  test("positionsError is set when bookPositions rejects", async () => {
    m.getAccount.mock.mockImplementation(async () => row());
    m.bookPositions.mock.mockImplementation(async () => {
      throw new Error("BingX timeout");
    });
    const res = await call(`/accounts/${ACCOUNT_ID}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.positions, []);
    assert.equal(res.body.positionsError, "BingX timeout");
    assert.equal(res.body.running, false);
  });

  test("/portfolio returns the loadPortfolio result", async () => {
    const account = row();
    m.getAccount.mock.mockImplementation(async () => account);
    m.loadPortfolio.mock.mockImplementation(async () => ({ equity: 512, legs: [{ coin: "BTC" }] }));
    const res = await call(`/accounts/${ACCOUNT_ID}/portfolio`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { equity: 512, legs: [{ coin: "BTC" }] });
    assert.equal(m.loadPortfolio.mock.calls[0].arguments[0], account);
    assert.equal(m.bookPositions.mock.callCount(), 0);
  });

  test("/portfolio 404 when the account is missing", async () => {
    const res = await call(`/accounts/${ACCOUNT_ID}/portfolio`);
    assert.equal(res.status, 404);
    assert.equal(m.loadPortfolio.mock.callCount(), 0);
  });
});

describe("DELETE /accounts/:id", () => {
  test("404 when missing", async () => {
    const res = await call(`/accounts/${ACCOUNT_ID}`, { method: "DELETE" });
    assert.equal(res.status, 404);
    assert.equal(m.deleteAccount.mock.callCount(), 0);
  });

  test("without ?close=true deletes without closing positions", async () => {
    m.getAccount.mock.mockImplementation(async () => row());
    const res = await call(`/accounts/${ACCOUNT_ID}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { disconnected: true });
    assert.equal(m.closeBook.mock.callCount(), 0);
    assert.deepEqual(m.deleteAccount.mock.calls[0].arguments, [ACCOUNT_ID]);
  });

  test("with ?close=true closes the book then deletes", async () => {
    m.getAccount.mock.mockImplementation(async () => row());
    const res = await call(`/accounts/${ACCOUNT_ID}?close=true`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { disconnected: true });
    assert.equal(m.closeBook.mock.callCount(), 1);
    const [client, id, reason] = m.closeBook.mock.calls[0].arguments;
    assert.ok(client instanceof BingXClient);
    assert.equal(client.apiKey === FAKE_KEY, true);
    assert.equal(client.apiSecret === FAKE_SECRET, true);
    assert.equal(id, ACCOUNT_ID);
    assert.equal(reason, "exit");
    assert.equal(m.deleteAccount.mock.callCount(), 1);
  });

  test("502 and no delete when closeBook reports errors", async () => {
    m.getAccount.mock.mockImplementation(async () => row());
    m.closeBook.mock.mockImplementation(async () => ["BTC-USDT: rejected"]);
    const res = await call(`/accounts/${ACCOUNT_ID}?close=true`, { method: "DELETE" });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /BTC-USDT: rejected/);
    assert.equal(m.deleteAccount.mock.callCount(), 0);
  });
});

describe("unknown routes", () => {
  for (const [method, path] of [
    ["GET", "/accounts/not-a-uuid"],
    ["DELETE", "/accounts/not-a-uuid"],
    ["GET", `/accounts/${ACCOUNT_ID}/extra`],
    ["GET", "/nope"],
    ["PUT", `/accounts/${ACCOUNT_ID}`],
  ]) {
    test(`${method} ${path.replace(ACCOUNT_ID, ":id")} gives 404`, async () => {
      const res = await call(path, { method });
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "Not found" });
      assert.equal(m.getAccount.mock.callCount(), 0);
    });
  }
});
