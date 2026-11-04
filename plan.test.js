const test = require("node:test");
const assert = require("node:assert/strict");
const { planOrders, floorTo, leverageFor } = require("./plan");
const { fitToLeverage, orderId } = require("./rebalance");
const { signingString } = require("./bingx");

const contracts = {
  BTC: { precision: 4, minQty: 0.0001, minUsdt: 2 },
  ETH: { precision: 2, minQty: 0.01, minUsdt: 2 },
  SOL: { precision: 2, minQty: 0.03, minUsdt: 2 },
};
const prices = { BTC: 80_000, ETH: 2_000, SOL: 100 };

test("opens a new book from flat", () => {
  const { orders } = planOrders({ weights: { BTC: 0.5, ETH: -0.5 }, equity: 1000, prices, positions: new Map(), contracts });
  assert.deepEqual(orders, [
    { coin: "BTC", side: "BUY", quantity: 0.0062, reduceOnly: false },
    { coin: "ETH", side: "SELL", quantity: 0.25, reduceOnly: false },
  ]);
});

test("leaves coins outside the book alone", () => {
  const positions = new Map([["PEPE", 1_000_000], ["BTC", 0.0062]]);
  const { orders } = planOrders({ weights: { BTC: 0.5 }, equity: 1000, prices, positions, contracts });
  assert.equal(orders.length, 0);
});

test("reductions come before increases, and a flip closes then opens", () => {
  const positions = new Map([["BTC", 0.01], ["ETH", -0.1]]);
  const { orders } = planOrders({ weights: { BTC: -0.4, ETH: -0.6 }, equity: 1000, prices, positions, contracts });
  assert.deepEqual(orders, [
    { coin: "BTC", side: "SELL", quantity: 0.01, reduceOnly: true },
    { coin: "BTC", side: "SELL", quantity: 0.005, reduceOnly: false },
    { coin: "ETH", side: "SELL", quantity: 0.2, reduceOnly: false },
  ]);
});

test("closes coins that left the book, reduce-only", () => {
  const { orders } = planOrders({ weights: {}, equity: 1000, prices, positions: new Map([["SOL", -3]]), contracts });
  assert.deepEqual(orders, [{ coin: "SOL", side: "BUY", quantity: 3, reduceOnly: true }]);
});

test("shrinking a position is one reduce-only order", () => {
  const { orders } = planOrders({ weights: { ETH: 0.2 }, equity: 1000, prices, positions: new Map([["ETH", 0.5]]), contracts });
  assert.deepEqual(orders, [{ coin: "ETH", side: "SELL", quantity: 0.4, reduceOnly: true }]);
});

test("skips changes inside the rebalance band", () => {
  const { orders } = planOrders({ weights: { SOL: 0.5 }, equity: 1000, prices, positions: new Map([["SOL", 4.98]]), contracts });
  assert.equal(orders.length, 0);
});

test("skips increases below the BingX minimum and says so", () => {
  const { orders, skipped } = planOrders({ weights: { SOL: 0.002 }, equity: 1000, prices, positions: new Map(), contracts, band: 0 });
  assert.equal(orders.length, 0);
  assert.match(skipped[0].reason, /below BingX minimum/);
});

test("reports a target too small to trade at all", () => {
  const { orders, skipped } = planOrders({ weights: { ETH: 0.009 }, equity: 1000, prices, positions: new Map(), contracts, band: 0 });
  assert.equal(orders.length, 0);
  assert.match(skipped[0].reason, /too small/);
});

test("quantities round toward zero", () => {
  assert.equal(floorTo(0.00629, 4), 0.0062);
  assert.equal(floorTo(-2.999, 0), 2);
});

test("leverage is the lowest whole number that carries the book, capped", () => {
  assert.equal(leverageFor(3.79, 10), 5);
  assert.equal(leverageFor(12, 10), 10);
  assert.equal(leverageFor(0.2, 10), 1);
});

test("a book over the cap is scaled down evenly", () => {
  const { weights, scale } = fitToLeverage({ BTC: 3, ETH: -3, SOL: 3, DOT: -3 }, 10);
  assert.equal(scale, 8 / 12);
  assert.equal(weights.BTC, 2);
  assert.equal(weights.ETH, -2);
});

test("order ids are stable per account, day, coin and step, and within BingX's 40 characters", () => {
  const id = orderId("0f3c9a1e-1111-2222-3333-444455556666", "2026-11-04", "DOGE", 12);
  assert.equal(id, "fw0f3c9a1e20261104doge12");
  assert.ok(id.length <= 40);
});

test("the signature covers parameters sorted by key", () => {
  assert.equal(signingString({ timestamp: 2, symbol: "BTC-USDT", side: "BUY", empty: "" }), "side=BUY&symbol=BTC-USDT&timestamp=2");
});
