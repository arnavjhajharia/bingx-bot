const { UNIVERSE } = require("./book");
const { BingXClient, publicGet, bingxError, coinOf } = require("./bingx");
const store = require("./store");

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Latest prices keyed as BTCUSDT (the frontend's form), for the requested coins of the book. */
async function quotes(symbols) {
  const wanted = new Set(
    symbols
      .map((symbol) => String(symbol || "").toUpperCase().replace(/-?USDT$/, ""))
      .filter((coin) => UNIVERSE.includes(coin))
  );
  if (wanted.size === 0) return { prices: {}, rate: null };
  const response = await publicGet("/openApi/swap/v1/ticker/price");
  if (bingxError(response)) return { prices: {}, rate: null };
  const prices = {};
  for (const row of response.body.data || []) {
    const coin = coinOf(row.symbol);
    const price = num(row.price);
    if (wanted.has(coin) && price) prices[`${coin}USDT`] = price;
  }
  return { prices, rate: null };
}

/** Everything on the account. Positions outside the book are shown and marked, never traded. */
async function loadPortfolio(row) {
  const client = new BingXClient(row.api_key, await store.secretOf(row));
  const [balance, positions] = await Promise.all([
    client.get("/openApi/swap/v3/user/balance"),
    client.get("/openApi/swap/v2/user/positions"),
  ]);
  const end = Date.now();
  const fills = await client
    .get("/openApi/swap/v2/trade/allFillOrders", { tradingUnit: "COIN", startTs: end - 7 * 24 * 60 * 60 * 1000, endTs: end })
    .catch((error) => ({ status: 0, body: { code: -1, msg: error.message } }));

  const balanceError = bingxError(balance);
  const rows = balanceError ? [] : Array.isArray(balance.body.data) ? balance.body.data : [balance.body.data];
  const usdt = rows.find((r) => r && r.asset === "USDT") || rows[0] || {};

  const positionsError = bingxError(positions);
  const fillsError = bingxError(fills);
  const fillRows = fillsError ? [] : fills.body.data?.fill_orders || fills.body.data?.fillOrders || fills.body.data || [];

  return {
    connected: true,
    ...store.publicAccount(row),
    asset: "USDT",
    equity: num(usdt.equity),
    balance: num(usdt.balance),
    unrealizedPnl: num(usdt.unrealizedProfit),
    availableMargin: num(usdt.availableMargin),
    balanceError,
    positions: (positionsError ? [] : positions.body.data || []).map((p) => ({
      symbol: p.symbol,
      inBook: UNIVERSE.includes(coinOf(p.symbol)),
      side: String(p.positionSide).toUpperCase() === "SHORT" || Number(p.positionAmt) < 0 ? "short" : "long",
      quantity: Math.abs(num(p.positionAmt) || 0),
      entryPrice: num(p.avgPrice),
      markPrice: num(p.markPrice),
      unrealizedPnl: num(p.unrealizedProfit),
      leverage: num(p.leverage),
      liquidationPrice: num(p.liquidationPrice),
    })),
    positionsError,
    trades: (Array.isArray(fillRows) ? fillRows : []).slice(0, 50).map((t) => ({
      id: t.orderId ?? t.tradeId ?? null,
      time: t.filledTime ?? t.time ?? null,
      symbol: t.symbol,
      side: t.side,
      price: num(t.price),
      quantity: num(t.volume ?? t.qty ?? t.quantity),
      fee: num(t.commission),
      realizedProfit: num(t.realisedPNL ?? t.realizedPnl),
    })),
    tradesError: fillsError,
  };
}

module.exports = { loadPortfolio, quotes };
