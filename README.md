# bingx-bot

Runs the Momentum Rider book (Flywheel HighIQ Algo on xade.xyz) on users' own BingX perpetual futures accounts. One service trades many accounts: each user connects their own BingX API key, the money never leaves their BingX account, and once a day (just after 00:00 UTC) the bot moves each account to the same book, sized to its equity.

Modelled on [shark-bot](https://github.com/harshalmadnani/shark-bot), with BingX in place of Shark Exchange and these changes:

- **Only the book's 16 coins are traded.** Other positions on the account are the user's and are left alone (shark-bot closes them).
- **Disconnect does not close anything** unless asked: `DELETE /accounts/:id?close=true`.
- **Reductions first, reduce-only**, then increases. A side flip is a close then an open.
- **Every order has a `clientOrderId`** (account, day, coin, step). A lost reply is looked up, not resent.
- **Leverage capped** at `MAX_LEVERAGE` (10). A book that needs more is scaled down evenly, which is a departure from the backtest on those days and is recorded in `lastError`.
- **A failing day is retried 3 times**, not every 15 minutes until midnight.
- **Key problems pause the account** with a message for the user (revoked key, missing permission, IP not whitelisted).
- **The 75% drawdown stop** closes the book's coins and halts the account.

## Files

| File | |
|---|---|
| `server.js` | HTTP API for the Xade frontend, behind `BOT_TOKEN`; the 15-minute loop |
| `rebalance.js` | the daily run per account |
| `plan.js` | pure planner: positions + target book → orders (tested) |
| `book.js` | strategy rules, identical to shark-bot and the frontend backtest |
| `bingx.js` | BingX client: HMAC-SHA256 over sorted parameters, `X-BX-APIKEY`; errors are `code != 0` |
| `store.js` | Postgres; API secrets sealed with AES-256-GCM |
| `portfolio.js` | balance, positions, recent fills |

## API (all but `/health` need `Authorization: Bearer $BOT_TOKEN`)

- `POST /accounts` `{ ownerId, apiKey, apiSecret }`: checks the key, at least `MIN_EQUITY_USDT`, one-way mode; saves it and starts a first rebalance.
- `GET /accounts/:id`: status and the book's positions.
- `GET /accounts/:id/portfolio`: balance, all positions (marked `inBook`), recent fills.
- `DELETE /accounts/:id[?close=true]`
- `GET /prices?symbols=BTCUSDT,ETHUSDT`

## Run and test

```
npm ci
npm test
cp .env.example .env   # fill it in
npm start
```

`BINGX_HOST=open-api-vst.bingx.com` is BingX's demo exchange; use it until the bot has traded demo accounts cleanly for a few days. BingX may be unreachable from some Indian networks: use a VPN locally. The deployed service runs in Frankfurt.

## For users

Use a BingX account (or sub-account) dedicated to the bot. Create an API key with perpetual futures trading enabled, withdrawals disabled, and restricted to the service's outbound IP addresses (Render dashboard → service → Connect → Outbound).
