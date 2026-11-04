const { UNIVERSE, targetWeights, shouldHalt } = require("./book");
const { BingXClient, publicGet, bingxError, symbolOf, coinOf } = require("./bingx");
const { planOrders, leverageFor, grossOf } = require("./plan");
const store = require("./store");

const DAY_MS = 24 * 60 * 60 * 1000;
/** Leverage the bot will set on any coin. The book is scaled down to fit under it. */
const MAX_LEVERAGE = Number(process.env.MAX_LEVERAGE) || 10;
/** A failing day is retried this many times, then left until tomorrow. */
const MAX_ATTEMPTS_PER_DAY = 3;

const running = new Set();
const attempts = new Map();

const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Key problems pause the account instead of retrying: the user has to fix them on BingX. */
function isKeyProblem(message) {
  return /signature|api ?key|apikey|permission|whitelist|ip |not allowed|unauthori|forbidden|invalid key/i.test(message || "");
}

async function contracts() {
  const response = await publicGet("/openApi/swap/v2/quote/contracts");
  const error = bingxError(response);
  if (error) throw new Error(error);
  const out = {};
  for (const row of response.body.data || []) {
    const coin = coinOf(row.symbol);
    if (!UNIVERSE.includes(coin)) continue;
    if (Number(row.status) !== 1 || row.apiStateOpen === false || row.apiStateOpen === "false") continue;
    out[coin] = {
      precision: Number(row.quantityPrecision) || 0,
      minQty: Number(row.tradeMinQuantity) || 0,
      minUsdt: Number(row.tradeMinUSDT) || 0,
    };
  }
  return out;
}

/** Closed daily candles, oldest first. BingX returns newest first and includes today's open candle. */
async function dailyHistory(coin) {
  const response = await publicGet("/openApi/swap/v3/quote/klines", { symbol: symbolOf(coin), interval: "1d", limit: 400 });
  const error = bingxError(response);
  if (error) throw new Error(`${coin} candles: ${error}`);
  const now = Date.now();
  const bars = [];
  for (const candle of response.body.data || []) {
    const start = Number(candle.time);
    const open = Number(candle.open);
    const close = Number(candle.close);
    if (!Number.isFinite(start) || start + DAY_MS > now) continue;
    if (!(open > 0) || !(close > 0)) continue;
    bars.push({ date: new Date(start).toISOString().slice(0, 10), open, close });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { coin, bars };
}

async function equityOf(client) {
  const response = await client.get("/openApi/swap/v3/user/balance");
  const error = bingxError(response);
  if (error) throw new Error(error);
  const rows = Array.isArray(response.body.data) ? response.body.data : [response.body.data];
  const usdt = rows.find((row) => row && row.asset === "USDT") || rows[0];
  const equity = Number(usdt && (usdt.equity ?? usdt.balance));
  if (!Number.isFinite(equity)) throw new Error("BingX did not report a USDT balance");
  return equity;
}

/** Signed quantity per coin, for the book's coins only. Other positions are the user's and are not read here. */
async function bookPositions(client) {
  const response = await client.get("/openApi/swap/v2/user/positions");
  const error = bingxError(response);
  if (error) throw new Error(error);
  const qty = new Map();
  for (const position of response.body.data || []) {
    const coin = coinOf(position.symbol);
    if (!UNIVERSE.includes(coin)) continue;
    const amount = Number(position.positionAmt) || 0;
    const side = String(position.positionSide || "").toUpperCase();
    const signed = side === "SHORT" ? -Math.abs(amount) : side === "LONG" ? Math.abs(amount) : amount;
    qty.set(coin, (qty.get(coin) || 0) + signed);
  }
  return qty;
}

/** The bot trades one-way (one position per coin). Returns a message when the account cannot be switched. */
async function ensureOneWay(client) {
  const current = await client.get("/openApi/swap/v1/positionSide/dual");
  const error = bingxError(current);
  if (error) return error;
  const dual = String(current.body.data && current.body.data.dualSidePosition) === "true";
  if (!dual) return null;
  const switched = await client.post("/openApi/swap/v1/positionSide/dual", { dualSidePosition: "false" });
  const switchError = bingxError(switched);
  return switchError
    ? "Set BingX perpetual futures to one-way position mode (close open positions first), then reconnect."
    : null;
}

async function prepareSymbol(client, coin, leverage) {
  const symbol = symbolOf(coin);
  const margin = await client.post("/openApi/swap/v2/trade/marginType", { symbol, marginType: "CROSSED" });
  const marginError = bingxError(margin);
  if (marginError && !/no need|same|already/i.test(marginError)) return `${coin} margin: ${marginError}`;
  const lev = await client.post("/openApi/swap/v2/trade/leverage", { symbol, side: "BOTH", leverage });
  const levError = bingxError(lev);
  return levError ? `${coin} leverage: ${levError}` : null;
}

/** An id per account, day, coin and step, so a retried request can be matched instead of doubled. */
function orderId(accountId, day, coin, step) {
  return `fw${accountId.replace(/-/g, "").slice(0, 8)}${day.replace(/-/g, "")}${coin}${step}`.toLowerCase().slice(0, 40);
}

async function place(client, order, clientOrderId) {
  const symbol = symbolOf(order.coin);
  const params = {
    symbol,
    side: order.side,
    positionSide: "BOTH",
    type: "MARKET",
    quantity: order.quantity,
    clientOrderId,
  };
  if (order.reduceOnly) params.reduceOnly = "true";
  let response;
  try {
    response = await client.post("/openApi/swap/v2/trade/order", params);
  } catch (networkError) {
    // The reply was lost: ask whether BingX took the order before deciding it failed.
    const lookup = await client.get("/openApi/swap/v2/trade/order", { symbol, clientOrderId }).catch(() => null);
    if (lookup && !bingxError(lookup)) return lookup.body.data;
    throw new Error(`${order.coin}: ${networkError.message}`);
  }
  const error = bingxError(response);
  if (error) throw new Error(`${order.coin}: ${error}`);
  return response.body.data;
}

/** Close the book's own coins only, reduce-only. Used by the drawdown stop and on disconnect. */
async function closeBook(client, accountId, label) {
  const positions = await bookPositions(client);
  const info = await contracts();
  const zero = Object.fromEntries(UNIVERSE.map((coin) => [coin, 0]));
  const prices = Object.fromEntries(UNIVERSE.map((coin) => [coin, 1]));
  const { orders } = planOrders({ weights: zero, equity: 1, prices, positions, contracts: info, band: 0 });
  const errors = [];
  for (const [index, order] of orders.entries()) {
    try {
      await place(client, order, orderId(accountId, `${label}${Date.now() % 100000}`, order.coin, index));
    } catch (error) {
      errors.push(error.message);
    }
    await sleep(120);
  }
  return errors;
}

/** Fit the book under the leverage cap: scale every weight by the same factor, keeping its shape. */
function fitToLeverage(weights, cap) {
  const gross = grossOf(weights);
  const limit = cap * 0.8;
  if (gross <= limit || gross === 0) return { weights, scale: 1 };
  const scale = limit / gross;
  return { weights: Object.fromEntries(Object.entries(weights).map(([coin, w]) => [coin, w * scale])), scale };
}

async function rebalanceAccount(id) {
  if (running.has(id)) return { skipped: true };
  running.add(id);
  const today = utcDay();
  let row = null;
  try {
    row = await store.getAccount(id);
    if (!row || row.halted || row.paused_reason) return { skipped: true };
    const client = new BingXClient(row.api_key, await store.secretOf(row));

    const equity = await equityOf(client);
    const peak = row.peak_equity == null ? equity : Math.max(row.peak_equity, equity);

    if (shouldHalt(equity, peak)) {
      const errors = await closeBook(client, id, "halt");
      await store.markRun(id, {
        peakEquity: peak,
        lastRebalanceDay: today,
        halted: true,
        lastError: errors.length ? `Stopped at the 75% drawdown; some closes failed: ${errors.join("; ")}` : "Stopped at the 75% drawdown.",
      });
      return { halted: true, equity };
    }

    const modeProblem = await ensureOneWay(client);
    if (modeProblem) {
      await store.markRun(id, { peakEquity: peak, lastRebalanceDay: row.last_rebalance_day, halted: false, lastError: modeProblem, pausedReason: modeProblem });
      return { paused: modeProblem };
    }

    const [info, histories, positions] = await Promise.all([
      contracts(),
      Promise.all(UNIVERSE.map(dailyHistory)),
      bookPositions(client),
    ]);
    const book = targetWeights(histories);
    const { weights, scale } = fitToLeverage(book.weights, MAX_LEVERAGE);
    const prices = Object.fromEntries(histories.map((h) => [h.coin, h.bars[h.bars.length - 1]?.close ?? null]));
    const { orders, skipped } = planOrders({ weights, equity, prices, positions, contracts: info });

    const errors = [];
    const leverage = leverageFor(grossOf(weights), MAX_LEVERAGE);
    const prepared = new Set();
    for (const [index, order] of orders.entries()) {
      try {
        if (!order.reduceOnly && !prepared.has(order.coin)) {
          const problem = await prepareSymbol(client, order.coin, leverage);
          prepared.add(order.coin);
          if (problem) {
            errors.push(problem);
            continue;
          }
        }
        await place(client, order, orderId(id, today, order.coin, index));
      } catch (error) {
        errors.push(error.message);
      }
      await sleep(120);
    }

    const keyProblem = errors.find(isKeyProblem);
    const tries = (attempts.get(`${id}:${today}`) || 0) + 1;
    attempts.set(`${id}:${today}`, tries);
    const done = errors.length === 0 || tries >= MAX_ATTEMPTS_PER_DAY;
    const notes = [...errors, ...skipped.map((s) => `${s.coin} skipped: ${s.reason}`)];
    if (scale < 1) notes.push(`book scaled to ${(scale * 100).toFixed(0)}% to stay within ${MAX_LEVERAGE}x`);
    await store.markRun(id, {
      peakEquity: peak,
      lastRebalanceDay: done ? today : row.last_rebalance_day,
      halted: false,
      lastError: notes.length ? notes.join("; ") : null,
      pausedReason: keyProblem ? `BingX refused the API key: ${keyProblem}. Check the key, its permissions and its IP whitelist, then reconnect.` : null,
    });
    console.log(`rebalance ${id.slice(0, 8)} orders=${orders.length} errors=${errors.length} skipped=${skipped.length} scale=${scale.toFixed(2)}`);
    return { date: book.date, weights, equity, orders: orders.length, errors, skipped };
  } catch (error) {
    const message = error.message || String(error);
    await store
      .markRun(id, {
        peakEquity: row?.peak_equity ?? null,
        lastRebalanceDay: row?.last_rebalance_day ?? null,
        halted: false,
        lastError: message,
        pausedReason: isKeyProblem(message) ? `BingX refused the API key: ${message}. Check the key, its permissions and its IP whitelist, then reconnect.` : null,
      })
      .catch(() => {});
    console.error(`rebalance ${id.slice(0, 8)} failed: ${message}`);
    return { error: message };
  } finally {
    running.delete(id);
  }
}

async function runDue() {
  const today = utcDay();
  const accounts = await store.listTradable();
  const due = accounts.filter((account) => account.last_rebalance_day !== today);
  if (due.length) console.log(`rebalance due ${due.length}`);
  for (const account of due) await rebalanceAccount(account.id);
}

const isRunning = (id) => running.has(id);

module.exports = { rebalanceAccount, runDue, isRunning, closeBook, equityOf, bookPositions, ensureOneWay, contracts, fitToLeverage, utcDay, orderId };
