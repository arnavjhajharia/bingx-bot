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
}

/** One BingX key per account; reconnecting the same key updates it and clears a pause, not a halt. */
async function saveAccount({ ownerId, apiKey, apiSecret, equity }) {
  const sealed = encrypt(apiSecret);
  const existing = await getPool().query("SELECT id FROM accounts WHERE api_key = $1", [apiKey]);
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await getPool().query(
      `UPDATE accounts SET owner_id = $2, secret_ciphertext = $3, secret_iv = $4, secret_tag = $5,
              paused_reason = NULL, last_error = NULL
        WHERE id = $1`,
      [id, ownerId, sealed.ciphertext, sealed.iv, sealed.tag]
    );
    return id;
  }
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO accounts (id, owner_id, api_key, secret_ciphertext, secret_iv, secret_tag, started_equity, peak_equity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [id, ownerId, apiKey, sealed.ciphertext, sealed.iv, sealed.tag, equity]
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
  };
}

module.exports = { migrate, saveAccount, getAccount, accountByOwner, secretOf, listTradable, markRun, deleteAccount, publicAccount, getPool };
