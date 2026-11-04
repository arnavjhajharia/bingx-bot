/** Momentum Rider daily book. Same rules as the frontend backtest. */

const UNIVERSE = [
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX",
  "LINK", "SUI", "LTC", "DOT", "NEAR", "UNI", "BCH", "AAVE",
];

const RULES = {
  lookback: 14,
  k: 4,
  slot: 0.06,
  targetVol: 1,
  maxGross: 12,
  scaleFloor: 0.1,
  scaleCeil: 12,
  volWindow: 30,
  dispWindow: 90,
  dispQuantile: 0.8,
  dispFloor: 0.25,
  dispMinSamples: 20,
  minNames: 8,
  minBars: 50,
  rebalanceBand: 0.005,
  haltDrawdown: 0.75,
};

function populationStdev(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function metricsAt(bars, index, lookback) {
  if (index < lookback) return null;
  for (let k = index - lookback; k <= index; k += 1) {
    const bar = bars[k];
    if (!bar || !(bar.close > 0)) return null;
  }
  const daily = [];
  for (let k = index - lookback + 1; k <= index; k += 1) {
    const prev = bars[k - 1].close;
    const close = bars[k].close;
    if (!(prev > 0)) return null;
    daily.push(close / prev - 1);
  }
  const past = bars[index - lookback].close;
  const close = bars[index].close;
  const ret = past > 0 ? close / past - 1 : null;
  const vol = populationStdev(daily);
  if (ret == null || vol == null || !(vol > 1e-12)) return null;
  return { score: ret / vol, ret, day: daily[daily.length - 1] };
}

function targetWeights(coins, rules = RULES) {
  const names = coins.map((coin) => coin.coin);
  const byCoin = new Map();
  const dates = new Set();
  for (const coin of coins) {
    const map = new Map();
    const ordered = coin.bars.slice().sort((a, b) => a.date.localeCompare(b.date));
    for (const bar of ordered) {
      if (!(bar.open > 0) || !(bar.close > 0)) continue;
      map.set(bar.date, { open: bar.open, close: bar.close });
      dates.add(bar.date);
    }
    byCoin.set(coin.coin, map);
  }
  const calendar = [...dates].sort();
  const series = new Map();
  for (const name of names) {
    const map = byCoin.get(name);
    series.set(name, calendar.map((date) => map.get(date)));
  }

  const dispHist = [];
  const baseRets = [];
  let weights = new Map();
  let dispMult = 1;
  let volScale = 1;
  let valid = 0;

  for (let index = 0; index < calendar.length; index += 1) {
    const scored = [];
    for (const name of names) {
      const row = metricsAt(series.get(name), index, rules.lookback);
      if (row) scored.push({ coin: name, ...row });
    }
    valid = scored.length;
    let dispersion = null;
    if (valid >= 2) {
      const mean = scored.reduce((sum, row) => sum + row.ret, 0) / valid;
      const sse = scored.reduce((sum, row) => sum + (row.ret - mean) ** 2, 0);
      dispersion = Math.sqrt(sse / (valid - 1));
    }
    dispMult = 1;
    if (dispersion != null && dispHist.length >= rules.dispMinSamples) {
      const sorted = dispHist.slice().sort((a, b) => a - b);
      const at = Math.min(sorted.length - 1, Math.floor(rules.dispQuantile * sorted.length));
      if (dispersion > sorted[at]) dispMult = rules.dispFloor;
    }

    const taken = new Set();
    const longs = [];
    const shorts = [];
    if (valid >= rules.minNames) {
      const pool = scored.slice();
      for (let slot = 0; slot < rules.k; slot += 1) {
        let best = -1;
        for (let i = 0; i < pool.length; i += 1) {
          if (taken.has(pool[i].coin)) continue;
          if (best === -1 || pool[i].score > pool[best].score) best = i;
        }
        if (best >= 0) {
          taken.add(pool[best].coin);
          longs.push(pool[best].coin);
        }
      }
      for (let slot = 0; slot < rules.k; slot += 1) {
        let worst = -1;
        for (let i = 0; i < pool.length; i += 1) {
          if (taken.has(pool[i].coin)) continue;
          if (worst === -1 || pool[i].score < pool[worst].score) worst = i;
        }
        if (worst >= 0) {
          taken.add(pool[worst].coin);
          shorts.push(pool[worst].coin);
        }
      }
    }

    const dayReturn = new Map(scored.map((row) => [row.coin, row.day]));
    let base = 0;
    if (longs.length + shorts.length > 0) {
      for (const coin of longs) base += rules.slot * (dayReturn.get(coin) ?? 0);
      for (const coin of shorts) base -= rules.slot * (dayReturn.get(coin) ?? 0);
    }
    baseRets.push(base);
    volScale = 1;
    if (baseRets.length >= rules.volWindow) {
      const raw = populationStdev(baseRets.slice(-rules.volWindow));
      const ann = raw == null ? null : raw * Math.sqrt(365);
      volScale = ann == null
        ? 1
        : ann <= 1e-8
          ? rules.scaleCeil
          : Math.max(rules.scaleFloor, Math.min(rules.scaleCeil, rules.targetVol / ann));
    }

    if (index >= rules.minBars && valid >= rules.minNames) {
      let weight = rules.slot * dispMult * volScale;
      const heldN = longs.length + shorts.length;
      if (heldN > 0 && weight * heldN > rules.maxGross) weight = rules.maxGross / heldN;
      weights = new Map();
      for (const coin of longs) weights.set(coin, weight);
      for (const coin of shorts) weights.set(coin, -weight);
    }

    if (dispersion != null) {
      dispHist.push(dispersion);
      if (dispHist.length > rules.dispWindow) dispHist.shift();
    }
  }

  const out = {};
  for (const [coin, weight] of weights) out[coin] = weight;
  return {
    date: calendar[calendar.length - 1] ?? null,
    weights: out,
    valid,
    dispMult,
    volScale,
  };
}

function grossOf(weights) {
  return Object.values(weights).reduce((sum, weight) => sum + Math.abs(weight), 0);
}

/** Lowest integer leverage that can carry this gross book, capped by the contract. */
function leverageForGross(gross, maxLeverage) {
  const needed = Math.max(1, Math.ceil(Math.abs(gross) / 0.8));
  const cap = Math.max(1, Math.floor(Number(maxLeverage) || 1));
  return Math.min(cap, needed);
}

function shouldHalt(equity, peak, rules = RULES) {
  return peak > 0 && equity >= 0 && (peak - equity) / peak >= rules.haltDrawdown;
}

function roundQty(qty, precision) {
  const digits = Math.max(0, Number(precision) || 0);
  const factor = 10 ** digits;
  return Math.round(qty * factor) / factor;
}

module.exports = {
  UNIVERSE,
  RULES,
  targetWeights,
  grossOf,
  leverageForGross,
  shouldHalt,
  roundQty,
};
