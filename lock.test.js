// One copy of the bot at a time per account: the run lease. A Render deploy runs the old and new instance
// side by side; shark-bot saw both rebalance the same accounts a minute apart on 2026-11-12.
const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");
const store = require("./store");
const { UNIVERSE } = require("./book");
const rb = require("./rebalance");

const ID = "4d39ae0d-1111-2222-3333-444455556666";
const DAY_MS = 24 * 60 * 60 * 1000;

/** 120 closed daily candles per coin, each coin with its own steady drift, so the book forms. */
function candles(coinIndex) {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const drift = (coinIndex - UNIVERSE.length / 2) * 0.002;
  const rows = [];
  for (let day = 120; day >= 1; day -= 1) {
    const t = 120 - day;
    const close = 100 * Math.exp(drift * t + 0.01 * Math.sin(t + coinIndex));
    rows.push({ time: today - day * DAY_MS, open: close * 0.999, close });
  }
  return rows.reverse(); // BingX answers newest first
}

/** Fake BingX: records every request path and answers like a funded, flat, one-way account. */
function exchange() {
  const calls = [];
  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () =>
      setImmediate(() => {
        const [path, query = ""] = options.path.split("?");
        calls.push(`${options.method} ${path}`);
        const params = new URLSearchParams(query);
        let data = {};
        if (path === "/openApi/swap/v3/user/balance") data = [{ asset: "USDT", equity: "10000" }];
        else if (path === "/openApi/swap/v2/user/positions") data = [];
        else if (path === "/openApi/swap/v1/positionSide/dual") data = { dualSidePosition: "false" };
        else if (path === "/openApi/swap/v2/quote/contracts") {
          data = UNIVERSE.map((coin) => ({ symbol: `${coin}-USDT`, status: 1, quantityPrecision: 4, tradeMinQuantity: 0.0001, tradeMinUSDT: 1 }));
        } else if (path === "/openApi/swap/v3/quote/klines") {
          data = candles(UNIVERSE.indexOf(params.get("symbol").replace(/-USDT$/, "")));
        }
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        res.emit("data", JSON.stringify({ code: 0, data }));
        res.emit("end");
      });
    return req;
  };
  return calls;
}

const ORDER = "POST /openApi/swap/v2/trade/order";

function stubStore({ lease = true, lastDay = null, renewals = Infinity } = {}) {
  const row = { id: ID, book: "flywheel", owner_id: "did:privy:x", api_key: "FAKEKEYFAKEKEYFAKE", peak_equity: 10000, last_rebalance_day: lastDay, halted: false, paused_reason: null };
  const log = [];
  let renewed = 0;
  store.getAccount = async () => (log.includes("delete") ? null : { ...row });
  store.claimRun = async () => { log.push("claim"); return lease ? { ...row } : null; };
  store.renewRun = async () => { renewed += 1; log.push("renew"); return renewed <= renewals; };
  store.releaseRun = async () => { log.push("release"); };
  store.deleteAccount = async () => { log.push("delete"); };
  store.secretOf = async () => "FAKESECRETFAKESECRET";
  store.recordActivity = async () => {};
  store.markRun = async () => { log.push("markRun"); };
  return log;
}

test("an account leased by another copy is skipped and nothing is sent to BingX", async () => {
  const calls = exchange();
  const log = stubStore({ lease: false });
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.deepEqual(result, { skipped: true, locked: true });
  assert.deepEqual(calls, [], "no BingX call at all");
  assert.ok(!log.includes("release"), "a lease it never took is not released");
});

test("an account another copy already finished today is skipped after taking the lease", async () => {
  const calls = exchange();
  const log = stubStore({ lastDay: rb.utcDay() });
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.deepEqual(result, { skipped: true, done: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(log, ["claim", "release"]);
});

test("a full run renews the lease before every order and releases it at the end", async () => {
  const calls = exchange();
  const log = stubStore();
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.equal(result.error, undefined, result.error);
  const orders = calls.filter((call) => call === ORDER).length;
  assert.ok(orders > 0, "the book is opened");
  assert.equal(log.filter((entry) => entry === "renew").length, orders, "one renewal per order");
  assert.equal(log[0], "claim");
  assert.equal(log.at(-1), "release");
});

test("a run that loses its lease stops before the next order and does not record the day", async () => {
  const calls = exchange();
  const log = stubStore({ renewals: 2 });
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.equal(result.leaseLost, true);
  assert.equal(result.placed, 2);
  assert.equal(calls.filter((call) => call === ORDER).length, 2, "exactly the orders sent before the lease was lost");
  assert.ok(!log.includes("markRun"), "the copy that took over owns the account's record now");
});

test("the lease is released when a run fails", async () => {
  exchange();
  const log = stubStore();
  store.secretOf = async () => { throw new Error("bad decrypt"); };
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.equal(result.error, "bad decrypt");
  assert.equal(log.at(-1), "release");
});

test("disconnect deletes while holding the lease and closes nothing unless asked", async () => {
  const calls = exchange();
  const log = stubStore();
  const result = await rb.disconnectAccount(ID);
  assert.equal(result.disconnected, true);
  assert.deepEqual(log, ["claim", "delete"], "deleted under the lease; nothing can reopen positions in between");
  assert.deepEqual(calls, []);
});

test("disconnect waits for a running rebalance and answers 409 if it does not finish", async () => {
  exchange();
  const log = stubStore({ lease: false });
  await assert.rejects(rb.disconnectAccount(ID, { waitMs: 1500 }), (error) => error.status === 409);
  assert.ok(!log.includes("delete"), "the account is not deleted mid-run");
});
