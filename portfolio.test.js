const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("https");

const store = require("./store");
const { BingXClient } = require("./bingx");
const { UNIVERSE } = require("./book");
const { loadPortfolio, quotes } = require("./portfolio");

const IN_BOOK = UNIVERSE[0];
const OUT_OF_BOOK = "ZZZ-USDT";

const BALANCE = "/openApi/swap/v3/user/balance";
const POSITIONS = "/openApi/swap/v2/user/positions";
const FILLS = "/openApi/swap/v2/trade/allFillOrders";

const ok = (data) => ({ status: 200, body: { code: 0, msg: "", data } });
const refused = (msg) => ({ status: 200, body: { code: 100001, msg } });

function fixtureRow(overrides = {}) {
  return {
    id: 7,
    api_key: "ABCDEFGHIJKLMNOP",
    halted: false,
    stopping: false,
    paused_reason: null,
    started_equity: "1000",
    peak_equity: "1100",
    last_rebalance_day: "2026-11-14",
    last_run_at: "2026-11-14T00:05:00Z",
    last_error: null,
    created_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

/** Mocks the store secret and the signed client; `responses` maps path -> response or function. */
function mockAccount(responses) {
  mock.method(store, "secretOf", async () => "fake-secret");
  const get = mock.method(BingXClient.prototype, "get", async function (path, params) {
    const answer = responses[path];
    if (typeof answer === "function") return answer(path, params);
    if (answer === undefined) throw new Error(`unexpected path ${path}`);
    return answer;
  });
  return get;
}

/** Fakes https.request so it answers with `body` (JSON-encoded) and records the request options. */
function mockHttps(body, statusCode = 200) {
  return mock.method(https, "request", (options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      process.nextTick(() => {
        callback(res);
        res.emit("data", JSON.stringify(body));
        res.emit("end");
      });
    };
    req.destroy = (error) => req.emit("error", error);
    return req;
  });
}

afterEach(() => {
  mock.restoreAll();
});

describe("loadPortfolio", () => {
  test("balance as an array picks the USDT row and parses numeric strings", async () => {
    mockAccount({
      [BALANCE]: ok([
        { asset: "VST", equity: "1", balance: "1", unrealizedProfit: "0", availableMargin: "1" },
        { asset: "USDT", equity: "1234.5", balance: "1200", unrealizedProfit: "-3.25", availableMargin: "900.1" },
      ]),
      [POSITIONS]: ok([]),
      [FILLS]: ok([]),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.connected, true);
    assert.equal(p.asset, "USDT");
    assert.equal(p.equity, 1234.5);
    assert.equal(p.balance, 1200);
    assert.equal(p.unrealizedPnl, -3.25);
    assert.equal(p.availableMargin, 900.1);
    assert.equal(p.balanceError, null);
    assert.equal(p.positionsError, null);
    assert.equal(p.tradesError, null);
  });

  test("balance as a single object is used directly", async () => {
    mockAccount({
      [BALANCE]: ok({ asset: "USDT", equity: "50", balance: "40", unrealizedProfit: "10", availableMargin: "30" }),
      [POSITIONS]: ok([]),
      [FILLS]: ok([]),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.equity, 50);
    assert.equal(p.balance, 40);
    assert.equal(p.unrealizedPnl, 10);
    assert.equal(p.availableMargin, 30);
  });

  test("falls back to the first row when no USDT row exists", async () => {
    mockAccount({
      [BALANCE]: ok([
        { asset: "VST", equity: "77", balance: "70", unrealizedProfit: "7", availableMargin: "60" },
        { asset: "USDC", equity: "1", balance: "1", unrealizedProfit: "0", availableMargin: "1" },
      ]),
      [POSITIONS]: ok([]),
      [FILLS]: ok([]),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.equity, 77);
    assert.equal(p.balance, 70);
  });

  test("non-numeric balance values become null", async () => {
    mockAccount({
      [BALANCE]: ok([{ asset: "USDT", equity: "abc", balance: undefined, unrealizedProfit: "NaN", availableMargin: {} }]),
      [POSITIONS]: ok([]),
      [FILLS]: ok([]),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.equity, null);
    assert.equal(p.balance, null);
    assert.equal(p.unrealizedPnl, null);
    assert.equal(p.availableMargin, null);
  });

  test("a balance error is reported while positions and trades still fill in", async () => {
    mockAccount({
      [BALANCE]: refused("bad balance"),
      [POSITIONS]: ok([{ symbol: `${IN_BOOK}-USDT`, positionSide: "LONG", positionAmt: "2" }]),
      [FILLS]: ok([{ orderId: 1, symbol: `${IN_BOOK}-USDT`, price: "10", volume: "1" }]),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.balanceError, "BingX: bad balance");
    assert.equal(p.equity, null);
    assert.equal(p.balance, null);
    assert.equal(p.positions.length, 1);
    assert.equal(p.trades.length, 1);
    assert.equal(p.positionsError, null);
    assert.equal(p.tradesError, null);
  });

  test("a positions error is reported while balance and trades still fill in", async () => {
    mockAccount({
      [BALANCE]: ok([{ asset: "USDT", equity: "100" }]),
      [POSITIONS]: { status: 500, body: null },
      [FILLS]: ok([{ orderId: 1 }]),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.positionsError, "BingX returned 500");
    assert.deepEqual(p.positions, []);
    assert.equal(p.equity, 100);
    assert.equal(p.trades.length, 1);
    assert.equal(p.balanceError, null);
  });

  test("a trades error is reported while balance and positions still fill in", async () => {
    mockAccount({
      [BALANCE]: ok([{ asset: "USDT", equity: "100" }]),
      [POSITIONS]: ok([{ symbol: `${IN_BOOK}-USDT`, positionAmt: "1" }]),
      [FILLS]: refused("no fills for you"),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.tradesError, "BingX: no fills for you");
    assert.deepEqual(p.trades, []);
    assert.equal(p.equity, 100);
    assert.equal(p.positions.length, 1);
  });

  test("a rejected fills call gives tradesError and no crash", async () => {
    mockAccount({
      [BALANCE]: ok([{ asset: "USDT", equity: "100" }]),
      [POSITIONS]: ok([]),
      [FILLS]: async () => {
        throw new Error("socket hang up");
      },
    });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.tradesError, "BingX: socket hang up");
    assert.deepEqual(p.trades, []);
    assert.equal(p.equity, 100);
  });

  test("fills are requested for the last 7 days in COIN units", async () => {
    const get = mockAccount({ [BALANCE]: ok([]), [POSITIONS]: ok([]), [FILLS]: ok([]) });
    await loadPortfolio(fixtureRow());
    const call = get.mock.calls.find((c) => c.arguments[0] === FILLS);
    const params = call.arguments[1];
    assert.equal(params.tradingUnit, "COIN");
    assert.equal(params.endTs - params.startTs, 7 * 24 * 60 * 60 * 1000);
  });

  test("positions: side, quantity, inBook and numeric fields", async () => {
    mockAccount({
      [BALANCE]: ok([]),
      [POSITIONS]: ok([
        {
          symbol: `${IN_BOOK}-USDT`,
          positionSide: "LONG",
          positionAmt: "0.5",
          avgPrice: "100",
          markPrice: "110",
          unrealizedProfit: "5",
          leverage: "3",
          liquidationPrice: "50",
        },
        { symbol: OUT_OF_BOOK, positionSide: "short", positionAmt: "4" },
        { symbol: `${IN_BOOK}-USDT`, positionSide: "BOTH", positionAmt: "-2.5" },
        { symbol: `${IN_BOOK}-USDT`, positionSide: "BOTH", positionAmt: "garbage" },
      ]),
      [FILLS]: ok([]),
    });
    const p = await loadPortfolio(fixtureRow());
    assert.deepEqual(p.positions[0], {
      symbol: `${IN_BOOK}-USDT`,
      inBook: true,
      side: "long",
      quantity: 0.5,
      entryPrice: 100,
      markPrice: 110,
      unrealizedPnl: 5,
      leverage: 3,
      liquidationPrice: 50,
    });
    assert.equal(p.positions[1].inBook, false);
    assert.equal(p.positions[1].side, "short");
    assert.equal(p.positions[1].quantity, 4);
    assert.equal(p.positions[1].entryPrice, null);
    assert.equal(p.positions[2].side, "short");
    assert.equal(p.positions[2].quantity, 2.5);
    assert.equal(p.positions[3].side, "long");
    assert.equal(p.positions[3].quantity, 0);
  });

  for (const [label, data] of [
    ["data.fill_orders", (rows) => ({ fill_orders: rows })],
    ["data.fillOrders", (rows) => ({ fillOrders: rows })],
    ["data as an array", (rows) => rows],
  ]) {
    test(`fills read from ${label}`, async () => {
      mockAccount({
        [BALANCE]: ok([]),
        [POSITIONS]: ok([]),
        [FILLS]: ok(data([{ orderId: "o1", symbol: `${IN_BOOK}-USDT`, side: "BUY", price: "10", volume: "2" }])),
      });
      const p = await loadPortfolio(fixtureRow());
      assert.equal(p.trades.length, 1);
      assert.equal(p.trades[0].id, "o1");
      assert.equal(p.trades[0].price, 10);
    });
  }

  test("fills data of an unexpected shape gives no trades", async () => {
    mockAccount({ [BALANCE]: ok([]), [POSITIONS]: ok([]), [FILLS]: ok({ something: "else" }) });
    const p = await loadPortfolio(fixtureRow());
    assert.deepEqual(p.trades, []);
    assert.equal(p.tradesError, null);
  });

  test("trades are capped at 50", async () => {
    const rows = Array.from({ length: 75 }, (_, i) => ({ orderId: i }));
    mockAccount({ [BALANCE]: ok([]), [POSITIONS]: ok([]), [FILLS]: ok(rows) });
    const p = await loadPortfolio(fixtureRow());
    assert.equal(p.trades.length, 50);
    assert.equal(p.trades[0].id, 0);
    assert.equal(p.trades[49].id, 49);
  });

  test("trade field fallbacks", async () => {
    mockAccount({
      [BALANCE]: ok([]),
      [POSITIONS]: ok([]),
      [FILLS]: ok([
        {
          orderId: "order",
          tradeId: "trade",
          filledTime: "t1",
          time: "t2",
          symbol: "BTC-USDT",
          side: "SELL",
          price: "1.5",
          volume: "3",
          qty: "4",
          quantity: "5",
          commission: "-0.01",
          realisedPNL: "2",
          realizedPnl: "9",
        },
        { tradeId: "trade", time: "t2", qty: "4", quantity: "5", realizedPnl: "9" },
        { quantity: "5" },
        {},
      ]),
    });
    const [a, b, c, d] = (await loadPortfolio(fixtureRow())).trades;
    assert.deepEqual(a, {
      id: "order",
      time: "t1",
      symbol: "BTC-USDT",
      side: "SELL",
      price: 1.5,
      quantity: 3,
      fee: -0.01,
      realizedProfit: 2,
    });
    assert.equal(b.id, "trade");
    assert.equal(b.time, "t2");
    assert.equal(b.quantity, 4);
    assert.equal(b.realizedProfit, 9);
    assert.equal(c.quantity, 5);
    assert.equal(d.id, null);
    assert.equal(d.time, null);
    assert.equal(d.quantity, null);
    assert.equal(d.realizedProfit, null);
  });

  test("public account fields are spread in and the API key is masked", async () => {
    mockAccount({ [BALANCE]: ok([]), [POSITIONS]: ok([]), [FILLS]: ok([]) });
    const row = fixtureRow();
    const p = await loadPortfolio(row);
    assert.equal(p.accountId, 7);
    assert.equal(p.apiKeyHint, "ABCD…MNOP");
    assert.equal(p.halted, false);
    assert.equal(p.pausedReason, null);
    assert.equal(p.startedEquity, "1000");
    assert.equal(p.peakEquity, "1100");
    assert.equal(p.lastRebalanceDay, "2026-11-14");
    assert.equal(p.lastRunAt, "2026-11-14T00:05:00Z");
    assert.equal(p.lastError, null);
    assert.equal(p.createdAt, "2026-11-01T00:00:00Z");
    assert.ok(!JSON.stringify(p).includes(row.api_key), "full API key must not leak");
    assert.ok(!JSON.stringify(p).includes("fake-secret"), "secret must not leak");

    const short = await loadPortfolio(fixtureRow({ api_key: "SHORT" }));
    assert.equal(short.apiKeyHint, "••••");
  });

  test("the client is built from the row's key and the stored secret", async () => {
    const secretOf = mock.method(store, "secretOf", async () => "fake-secret");
    const seen = [];
    mock.method(BingXClient.prototype, "get", async function (path) {
      seen.push({ apiKey: this.apiKey, apiSecret: this.apiSecret, path });
      return ok([]);
    });
    const row = fixtureRow();
    await loadPortfolio(row);
    assert.equal(secretOf.mock.callCount(), 1);
    assert.equal(secretOf.mock.calls[0].arguments[0], row);
    assert.equal(seen.length, 3);
    for (const call of seen) {
      assert.equal(call.apiKey, row.api_key);
      assert.equal(call.apiSecret, "fake-secret");
    }
  });
});

describe("quotes", () => {
  test("no HTTP call when no requested symbol is in the book", async () => {
    const request = mockHttps({ code: 0, data: [] });
    assert.deepEqual(await quotes(["ZZZUSDT", "QQQ-USDT", "", null]), { prices: {}, rate: null });
    assert.deepEqual(await quotes([]), { prices: {}, rate: null });
    assert.equal(request.mock.callCount(), 0);
  });

  test("accepts BTCUSDT, btc-usdt and BTC forms and keys output as COINUSDT", async () => {
    const [a, b, c] = UNIVERSE;
    const request = mockHttps({
      code: 0,
      data: [
        { symbol: `${a}-USDT`, price: "100.5" },
        { symbol: `${b}-USDT`, price: "20" },
        { symbol: `${c}-USDT`, price: "3" },
      ],
    });
    const result = await quotes([`${a}USDT`, `${b.toLowerCase()}-usdt`, c]);
    assert.deepEqual(result, { prices: { [`${a}USDT`]: 100.5, [`${b}USDT`]: 20, [`${c}USDT`]: 3 }, rate: null });
    assert.equal(request.mock.callCount(), 1);
    const options = request.mock.calls[0].arguments[0];
    assert.equal(options.method, "GET");
    assert.equal(options.path, "/openApi/swap/v1/ticker/price");
  });

  test("skips coins not requested, coins outside the book and zero/invalid prices", async () => {
    const [a, b, c, d] = UNIVERSE;
    mockHttps({
      code: 0,
      data: [
        { symbol: `${a}-USDT`, price: "1" },
        { symbol: `${b}-USDT`, price: "0" },
        { symbol: `${c}-USDT`, price: "n/a" },
        { symbol: `${d}-USDT`, price: "4" },
        { symbol: OUT_OF_BOOK, price: "9" },
      ],
    });
    const result = await quotes([a, b, c, "ZZZ"]);
    assert.deepEqual(result.prices, { [`${a}USDT`]: 1 });
  });

  test("returns empty prices on a BingX error code", async () => {
    mockHttps({ code: 80012, msg: "service unavailable", data: [{ symbol: `${IN_BOOK}-USDT`, price: "1" }] });
    assert.deepEqual(await quotes([IN_BOOK]), { prices: {}, rate: null });
  });

  test("returns empty prices on an HTTP error", async () => {
    mockHttps({ msg: "down" }, 503);
    assert.deepEqual(await quotes([IN_BOOK]), { prices: {}, rate: null });
  });

  test("missing data gives empty prices", async () => {
    mockHttps({ code: 0 });
    assert.deepEqual(await quotes([IN_BOOK]), { prices: {}, rate: null });
  });
});
