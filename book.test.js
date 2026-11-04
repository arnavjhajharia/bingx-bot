const test = require("node:test");
const assert = require("node:assert/strict");
const { UNIVERSE, targetWeights, leverageForGross, shouldHalt, grossOf, roundQty } = require("./book");

function history() {
  return UNIVERSE.map((coin, index) => {
    const drift = (index - (UNIVERSE.length - 1) / 2) * 0.004;
    const bars = [];
    let close = 100;
    for (let day = 0; day < 80; day += 1) {
      const open = close;
      close = open * (1 + drift + 0.01 * Math.sin(day + index));
      const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      bars.push({ date, open, close });
    }
    return { coin, bars };
  });
}

test("ranks the strongest four long and the weakest four short", () => {
  const book = targetWeights(history());
  const entries = Object.entries(book.weights);
  const longs = entries.filter((row) => row[1] > 0).map((row) => row[0]);
  const shorts = entries.filter((row) => row[1] < 0).map((row) => row[0]);
  assert.deepEqual(new Set(longs), new Set(["AAVE", "BCH", "UNI", "NEAR"]));
  assert.deepEqual(new Set(shorts), new Set(["BTC", "ETH", "SOL", "BNB"]));
  assert.equal(longs.length + shorts.length, 8);
  assert.ok(grossOf(book.weights) <= 12);
  assert.ok(grossOf(book.weights) > 0);
});

test("leverage is the lowest integer that can carry the book", () => {
  assert.equal(leverageForGross(12, 100), 15);
  assert.equal(leverageForGross(0.48, 100), 1);
  assert.equal(leverageForGross(12, 10), 10);
});

test("halts after a 75 percent drawdown", () => {
  assert.equal(shouldHalt(250, 1000), true);
  assert.equal(shouldHalt(251, 1000), false);
  assert.equal(shouldHalt(1000, 0), false);
});

test("rounds quantity to the contract precision", () => {
  assert.equal(roundQty(37.84, 0), 38);
  assert.equal(roundQty(4.44, 1), 4.4);
});
