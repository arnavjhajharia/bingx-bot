const { UNIVERSE, RULES } = require("./book");

/** Round toward zero to the contract's quantity precision, so the bot never asks for more than it means to. */
function floorTo(qty, precision) {
  const digits = Math.max(0, Number(precision) || 0);
  const factor = 10 ** digits;
  return Math.trunc(Math.abs(qty) * factor + 1e-9) / factor;
}

/** Lowest whole leverage that carries this gross book, at most `cap`. */
function leverageFor(gross, cap) {
  const needed = Math.max(1, Math.ceil(Math.abs(gross) / 0.8));
  return Math.min(Math.max(1, Math.floor(cap)), needed);
}

/**
 * The orders that take an account from its positions to today's book.
 *
 * Only the book's own coins are touched: anything else on the account is the
 * user's and is left alone. Reductions come first (reduce-only), so margin is
 * freed before it is used. A position that flips side is closed, then opened.
 * Increases below the contract minimum are skipped and reported, not forced.
 *
 * @param {object} input
 * @param {Record<string, number>} input.weights   signed target weight per coin (share of equity)
 * @param {number} input.equity                    account equity in USDT
 * @param {Record<string, number>} input.prices    last price per coin
 * @param {Map<string, number>} input.positions    signed quantity per coin
 * @param {Record<string, {precision:number, minQty:number, minUsdt:number}>} input.contracts
 * @param {number} [input.band]                    skip changes smaller than this share of equity
 */
function planOrders({ weights, equity, prices, positions, contracts, band = RULES.rebalanceBand }) {
  const reduces = [];
  const increases = [];
  const skipped = [];

  for (const coin of UNIVERSE) {
    const contract = contracts[coin];
    const price = prices[coin];
    const current = positions.get(coin) || 0;
    if (!contract || !(price > 0)) {
      if (current !== 0 || weights[coin]) skipped.push({ coin, reason: "no price or contract" });
      continue;
    }

    const weight = weights[coin] || 0;
    const rawTarget = weight !== 0 && equity > 0 ? (weight * equity) / price : 0;
    const target = Math.sign(rawTarget) * floorTo(rawTarget, contract.precision);
    if (weight !== 0 && target === 0 && current === 0) {
      skipped.push({ coin, reason: "too small for this account to hold" });
      continue;
    }
    const delta = target - current;
    if (floorTo(delta, contract.precision) === 0) continue;

    const closing = target === 0;
    if (!closing && Math.abs(delta) * price <= equity * band) continue;

    const flips = current !== 0 && target !== 0 && Math.sign(current) !== Math.sign(target);
    const shrinking = current !== 0 && Math.sign(current) === Math.sign(target) && Math.abs(target) < Math.abs(current);

    if (current !== 0 && (closing || flips || shrinking)) {
      const quantity = floorTo(closing || flips ? current : current - target, contract.precision);
      if (quantity > 0) {
        reduces.push({ coin, side: current > 0 ? "SELL" : "BUY", quantity, reduceOnly: true });
      }
    }

    const opening = flips ? target : Math.sign(target) === Math.sign(current) || current === 0 ? target - current : 0;
    if (target !== 0 && Math.sign(opening) === Math.sign(target) && opening !== 0) {
      const quantity = floorTo(opening, contract.precision);
      const notional = quantity * price;
      if (quantity <= 0) continue;
      if (quantity < contract.minQty || notional < contract.minUsdt) {
        skipped.push({ coin, reason: `below BingX minimum (${quantity} ${coin}, $${notional.toFixed(2)})` });
        continue;
      }
      increases.push({ coin, side: target > 0 ? "BUY" : "SELL", quantity, reduceOnly: false });
    }
  }

  return { orders: [...reduces, ...increases], skipped };
}

/** Gross exposure of a weight book, as a multiple of equity. */
function grossOf(weights) {
  return Object.values(weights).reduce((sum, weight) => sum + Math.abs(weight), 0);
}

module.exports = { planOrders, floorTo, leverageFor, grossOf };
