const crypto = require("crypto");
const { Pool } = require("pg");

let pool;

/** API secrets are sealed with AES-256-GCM under a key derived from KEY_ENCRYPTION_SECRET, and never logged. */
function encryptionKey() {
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) throw new Error("KEY_ENCRYPTION_SECRET is not set (32+ characters)");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(row) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.secret_iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.secret_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.secret_ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  pool = new Pool({ connectionString, max: 5, ssl: local ? undefined : { rejectUnauthorized: false } });
  return pool;
}

async function migrate() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      secret_ciphertext TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      started_equity DOUBLE PRECISION,
      peak_equity DOUBLE PRECISION,
      last_rebalance_day TEXT,
      halted BOOLEAN NOT NULL DEFAULT FALSE,
      paused_reason TEXT,
      last_error TEXT,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await getPool().query("CREATE INDEX IF NOT EXISTS accounts_owner ON accounts (owner_id)");
  await getPool().query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS book TEXT");
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS activity (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      book TEXT,
      account_id TEXT,
      owner_id TEXT,
      kind TEXT NOT NULL,
      symbol TEXT,
      side TEXT,
      quantity DOUBLE PRECISION,
      price DOUBLE PRECISION,
      notional_usd DOUBLE PRECISION,
      equity DOUBLE PRECISION,
      ok BOOLEAN,
      detail TEXT
    )
  `);
  await getPool().query("CREATE INDEX IF NOT EXISTS activity_book_at ON activity (book, at DESC)");
  await getPool().query("CREATE INDEX IF NOT EXISTS activity_account_at ON activity (account_id, at DESC)");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One row per connect, rebalance, order, skip, halt, or failure. Secrets are never written. */
async function recordActivity(event) {
  try {
    await getPool().query(
      `INSERT INTO activity (book, account_id, owner_id, kind, symbol, side, quantity, price, notional_usd, equity, ok, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.book || null,
        event.accountId || null,
        event.ownerId || null,
        String(event.kind || "event").slice(0, 40),
        event.symbol || null,
        event.side || null,
        num(event.quantity),
        num(event.price),
        num(event.notionalUsd),
        num(event.equity),
        typeof event.ok === "boolean" ? event.ok : null,
        event.detail ? String(event.detail).slice(0, 2000) : null,
      ]
    );
  } catch (error) {
    console.error("activity", error.message);
  }
}

async function listActivity({ book, accountId, kind, limit } = {}) {
  const where = [];
  const params = [];
  if (book) {
    params.push(book);
    where.push(`book = $${params.length}`);
  }
  if (accountId) {
    params.push(accountId);
    where.push(`account_id = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    where.push(`kind = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  const result = await getPool().query(
    `SELECT id, at, book, account_id, owner_id, kind, symbol, side, quantity, price, notional_usd, equity, ok, detail
     FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

function numOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Connected accounts and their recorded book, without keys or secrets. */
async function adminOverview() {
  const result = await getPool().query(`
    SELECT a.id,
           a.owner_id,
           COALESCE(NULLIF(a.book, ''), 'flywheel') AS book,
           a.halted,
           a.last_run_at,
           COALESCE(a.started_equity, (SELECT equity FROM activity WHERE account_id = a.id AND equity IS NOT NULL ORDER BY at ASC LIMIT 1)) AS start_equity,
           COALESCE(SUM(act.notional_usd) FILTER (WHERE act.kind = 'order' AND act.ok IS TRUE), 0)::float8 AS volume,
           (SELECT equity FROM activity WHERE account_id = a.id AND equity IS NOT NULL ORDER BY at DESC LIMIT 1) AS aum
    FROM accounts a
    LEFT JOIN activity act ON act.account_id = a.id
    GROUP BY a.id
    ORDER BY MIN(a.created_at) ASC
  `);
  const rows = result.rows.map((row) => {
    const volume = Number(row.volume) || 0;
    const startEquity = numOrNull(row.start_equity);
    const aum = numOrNull(row.aum);
    return {
      id: row.id,
      ownerId: row.owner_id || null,
      label: String(row.id).slice(0, 8),
      book: row.book,
      halted: row.halted,
      lastRunAt: row.last_run_at,
      volume,
      startEquity,
      aum,
      pnl: startEquity != null && aum != null ? aum - startEquity : null,
      fees: 0,
      unrealized: null,
    };
  });
  const pnls = rows.map((row) => row.pnl).filter((value) => value != null);
  const aums = rows.map((row) => row.aum).filter((value) => value != null);
  return {
    unit: "USDT",
    feeBps: 0,
    accounts: rows.length,
    volume: rows.reduce((sum, row) => sum + row.volume, 0),
    pnl: pnls.length ? pnls.reduce((sum, value) => sum + value, 0) : null,
    aum: aums.length ? aums.reduce((sum, value) => sum + value, 0) : null,
    fees: 0,
    unrealized: null,
    rows,
  };
}

async function activitySummary() {
  const result = await getPool().query(`
    SELECT COALESCE(book, 'untagged') AS book,
           kind,
           count(*)::int AS events,
           count(DISTINCT account_id)::int AS accounts,
           coalesce(sum(notional_usd) FILTER (WHERE ok IS TRUE AND kind = 'order'), 0)::float8 AS filled_notional_usd
    FROM activity
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  return result.rows;
}

/** One BingX key per account; reconnecting the same key updates it and clears a pause, not a halt. */
async function saveAccount({ ownerId, apiKey, apiSecret, equity, book = "flywheel" }) {
  const sealed = encrypt(apiSecret);
  const existing = await getPool().query("SELECT id FROM accounts WHERE api_key = $1", [apiKey]);
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await getPool().query(
      `UPDATE accounts SET owner_id = $2, secret_ciphertext = $3, secret_iv = $4, secret_tag = $5,
              paused_reason = NULL, last_error = NULL, book = COALESCE($6, book)
        WHERE id = $1`,
      [id, ownerId, sealed.ciphertext, sealed.iv, sealed.tag, book]
    );
    return id;
  }
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO accounts (id, owner_id, api_key, secret_ciphertext, secret_iv, secret_tag, started_equity, peak_equity, book)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
    [id, ownerId, apiKey, sealed.ciphertext, sealed.iv, sealed.tag, equity, book]
  );
  return id;
}

async function getAccount(id) {
  const result = await getPool().query("SELECT * FROM accounts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

/** The owner's most recent account, so a new device or login can restore it from their id alone. */
async function accountByOwner(ownerId) {
  const result = await getPool().query(
    "SELECT * FROM accounts WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1",
    [ownerId]
  );
  return result.rows[0] || null;
}

async function secretOf(row) {
  return decrypt(row);
}

/** Accounts the daily run trades: not halted by the drawdown stop and not paused by a key problem. */
async function listTradable() {
  const result = await getPool().query(
    "SELECT * FROM accounts WHERE halted = FALSE AND paused_reason IS NULL ORDER BY created_at ASC"
  );
  return result.rows;
}

async function markRun(id, { peakEquity, lastRebalanceDay, halted, lastError, pausedReason = null }) {
  await getPool().query(
    `UPDATE accounts
        SET peak_equity = $2, last_rebalance_day = $3, halted = $4, last_error = $5, paused_reason = $6, last_run_at = NOW()
      WHERE id = $1`,
    [id, peakEquity, lastRebalanceDay, halted, lastError, pausedReason]
  );
}

async function deleteAccount(id) {
  await getPool().query("DELETE FROM accounts WHERE id = $1", [id]);
}

function publicAccount(row) {
  if (!row) return null;
  const key = row.api_key || "";
  return {
    accountId: row.id,
    apiKeyHint: key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "••••",
    halted: row.halted,
    pausedReason: row.paused_reason,
    startedEquity: row.started_equity,
    peakEquity: row.peak_equity,
    lastRebalanceDay: row.last_rebalance_day,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    book: row.book || "flywheel",
    ownerId: row.owner_id || null,
  };
}

module.exports = {
  migrate,
  saveAccount,
  getAccount,
  accountByOwner,
  secretOf,
  listTradable,
  markRun,
  deleteAccount,
  publicAccount,
  getPool,
  recordActivity,
  listActivity,
  activitySummary,
  adminOverview,
};
