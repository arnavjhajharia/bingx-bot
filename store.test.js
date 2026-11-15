const { test, mock, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Fake, non-secret test values. pg.Pool connects lazily and query() is mocked, so no database is contacted.
process.env.KEY_ENCRYPTION_SECRET = "x".repeat(40);
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";

const store = require("./store");

const pool = store.getPool();
const calls = [];
const rows = new Map();

function norm(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

async function fakeQuery(sql, params = []) {
  const text = norm(sql);
  calls.push({ sql: text, params });
  if (/^SELECT id FROM accounts WHERE api_key = \$1/.test(text)) {
    const row = [...rows.values()].find((r) => r.api_key === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (/^INSERT INTO accounts/.test(text)) {
    const [id, owner_id, api_key, secret_ciphertext, secret_iv, secret_tag, equity, book, owner_email] = params;
    rows.set(id, {
      id, owner_id, api_key, secret_ciphertext, secret_iv, secret_tag,
      started_equity: equity, peak_equity: equity, book, owner_email,
      last_rebalance_day: null, halted: false, paused_reason: null, last_error: null,
      last_run_at: null, created_at: new Date(),
    });
    return { rows: [] };
  }
  if (/^UPDATE accounts SET owner_id = \$2/.test(text)) {
    const [id, owner_id, secret_ciphertext, secret_iv, secret_tag, book, owner_email] = params;
    const row = rows.get(id);
    Object.assign(row, {
      owner_id, secret_ciphertext, secret_iv, secret_tag,
      paused_reason: null, last_error: null,
      book: book ?? row.book, owner_email: owner_email ?? row.owner_email,
    });
    return { rows: [] };
  }
  if (/^UPDATE accounts SET peak_equity = \$2/.test(text)) {
    const [id, peak_equity, last_rebalance_day, halted, last_error, paused_reason] = params;
    const row = rows.get(id);
    if (row) Object.assign(row, { peak_equity, last_rebalance_day, halted, last_error, paused_reason, last_run_at: new Date() });
    return { rows: [] };
  }
  if (/^SELECT \* FROM accounts WHERE id = \$1/.test(text)) {
    const row = rows.get(params[0]);
    return { rows: row ? [row] : [] };
  }
  if (/^SELECT \* FROM accounts WHERE owner_id = \$1 ORDER BY created_at DESC/.test(text)) {
    const found = [...rows.values()].filter((r) => r.owner_id === params[0]).sort((a, b) => b.created_at - a.created_at);
    return { rows: found.slice(0, 1) };
  }
  if (/^SELECT \* FROM accounts WHERE halted = FALSE/.test(text)) {
    return { rows: [...rows.values()].filter((r) => !r.halted && r.paused_reason == null) };
  }
  if (/^DELETE FROM accounts WHERE id = \$1/.test(text)) {
    rows.delete(params[0]);
    return { rows: [] };
  }
  // DDL (CREATE / ALTER / INDEX) and anything else.
  return { rows: [] };
}

mock.method(pool, "query", fakeQuery);

beforeEach(() => {
  calls.length = 0;
  rows.clear();
});

after(async () => {
  mock.restoreAll();
  await pool.end();
});

const SECRET = "fake-secret-value-for-tests-0123456789";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("getPool returns the same pool every time", () => {
  assert.equal(store.getPool(), pool);
  assert.equal(store.getPool(), store.getPool());
});

test("migrate creates the accounts table, owner index, and added columns", async () => {
  await store.migrate();
  const sqls = calls.map((c) => c.sql);
  assert.ok(sqls.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS accounts")));
  assert.ok(sqls.some((s) => s.includes("CREATE INDEX IF NOT EXISTS accounts_owner ON accounts (owner_id)")));
  assert.ok(sqls.some((s) => s.includes("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS book")));
  assert.ok(sqls.some((s) => s.includes("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owner_email")));
  assert.ok(sqls.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS activity")));
});

test("saveAccount for a new key INSERTs a UUID with started = peak = equity and no plaintext secret", async () => {
  const id = await store.saveAccount({ ownerId: "owner-1", apiKey: "APIKEY-NEW-123456", apiSecret: SECRET, equity: 1234.5 });
  assert.match(id, UUID_RE);
  const insert = calls.find((c) => c.sql.startsWith("INSERT INTO accounts"));
  assert.ok(insert, "expected an INSERT");
  assert.equal(insert.params[0], id);
  assert.ok(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$7,/.test(insert.sql), "started_equity and peak_equity both bind $7");
  assert.equal(insert.params[6], 1234.5);

  const row = rows.get(id);
  assert.equal(row.started_equity, 1234.5);
  assert.equal(row.peak_equity, 1234.5);
  for (const field of ["secret_ciphertext", "secret_iv", "secret_tag"]) {
    assert.equal(typeof row[field], "string");
    assert.ok(!row[field].includes(SECRET), `${field} must not contain the plaintext`);
  }
  for (const call of calls) {
    for (const p of call.params) assert.notEqual(p, SECRET, "plaintext secret must never be sent to the database");
  }
});

test("secretOf decrypts back to the original secret", async () => {
  const id = await store.saveAccount({ ownerId: "o", apiKey: "K-ROUNDTRIP-1", apiSecret: SECRET, equity: 10 });
  const plain = await store.secretOf(rows.get(id));
  assert.ok(plain === SECRET, "round trip should return the original secret");
});

function flipFirstByte(b64) {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
}

test("tampering with the tag or ciphertext makes secretOf throw", async () => {
  const id = await store.saveAccount({ ownerId: "o", apiKey: "K-TAMPER-1", apiSecret: SECRET, equity: 10 });
  const row = rows.get(id);
  await assert.rejects(store.secretOf({ ...row, secret_tag: flipFirstByte(row.secret_tag) }));
  await assert.rejects(store.secretOf({ ...row, secret_ciphertext: flipFirstByte(row.secret_ciphertext) }));
});

test("saveAccount with an existing api_key UPDATEs and keeps halted and equity values", async () => {
  const id = await store.saveAccount({ ownerId: "owner-a", apiKey: "K-EXISTING-1", apiSecret: SECRET, equity: 100 });
  const row = rows.get(id);
  Object.assign(row, { halted: true, peak_equity: 150, paused_reason: "bad key", last_error: "boom" });
  calls.length = 0;

  const NEW_SECRET = "another-fake-secret-for-tests-987654";
  const again = await store.saveAccount({ ownerId: "owner-b", apiKey: "K-EXISTING-1", apiSecret: NEW_SECRET, equity: 999 });
  assert.equal(again, id);
  assert.ok(!calls.some((c) => c.sql.startsWith("INSERT")), "must not INSERT for an existing key");
  const update = calls.find((c) => c.sql.startsWith("UPDATE accounts SET owner_id"));
  assert.ok(update);
  assert.ok(update.sql.includes("paused_reason = NULL"));
  assert.ok(update.sql.includes("last_error = NULL"));
  assert.ok(!/halted|started_equity|peak_equity/.test(update.sql), "UPDATE must not touch halted or equity");
  assert.equal(update.params[0], id);
  assert.equal(update.params[1], "owner-b");
  assert.ok(!update.params.includes(999));

  const updated = rows.get(id);
  assert.equal(updated.owner_id, "owner-b");
  assert.equal(updated.halted, true);
  assert.equal(updated.started_equity, 100);
  assert.equal(updated.peak_equity, 150);
  assert.equal(updated.paused_reason, null);
  assert.equal(updated.last_error, null);
  assert.ok((await store.secretOf(updated)) === NEW_SECRET, "secret should be replaced");
});

test("getAccount and accountByOwner return null when there are no rows", async () => {
  assert.equal(await store.getAccount("missing"), null);
  assert.equal(await store.accountByOwner("nobody"), null);
  const byOwner = calls.find((c) => c.sql.includes("WHERE owner_id = $1"));
  assert.ok(byOwner.sql.includes("ORDER BY created_at DESC LIMIT 1"));
  assert.deepEqual(byOwner.params, ["nobody"]);
});

test("getAccount and accountByOwner return a stored row", async () => {
  const id = await store.saveAccount({ ownerId: "owner-x", apiKey: "K-GET-1", apiSecret: SECRET, equity: 5 });
  assert.equal((await store.getAccount(id)).id, id);
  assert.equal((await store.accountByOwner("owner-x")).id, id);
});

test("listTradable filters out halted and paused accounts", async () => {
  await store.listTradable();
  const call = calls.find((c) => c.sql.startsWith("SELECT * FROM accounts WHERE"));
  assert.ok(call.sql.includes("halted = FALSE"));
  assert.ok(call.sql.includes("paused_reason IS NULL"));
});

test("markRun passes params in order with pausedReason defaulting to null", async () => {
  await store.markRun("acc-1", { peakEquity: 200, lastRebalanceDay: "2026-11-15", halted: false, lastError: null });
  const call = calls.find((c) => c.sql.startsWith("UPDATE accounts SET peak_equity"));
  assert.deepEqual(call.params, ["acc-1", 200, "2026-11-15", false, null, null]);
  assert.ok(call.sql.includes("last_run_at = NOW()"));

  calls.length = 0;
  await store.markRun("acc-2", { peakEquity: 1, lastRebalanceDay: "d", halted: true, lastError: "e", pausedReason: "p" });
  assert.deepEqual(calls[0].params, ["acc-2", 1, "d", true, "e", "p"]);
});

test("deleteAccount deletes by id", async () => {
  const id = await store.saveAccount({ ownerId: "o", apiKey: "K-DEL-1", apiSecret: SECRET, equity: 1 });
  calls.length = 0;
  await store.deleteAccount(id);
  assert.equal(calls[0].sql, "DELETE FROM accounts WHERE id = $1");
  assert.deepEqual(calls[0].params, [id]);
  assert.equal(rows.has(id), false);
});

test("publicAccount hides the key and every secret field", () => {
  assert.equal(store.publicAccount(null), null);
  const row = {
    id: "acc", api_key: "ABCDEFGHIJKL", secret_ciphertext: "c", secret_iv: "i", secret_tag: "t",
    halted: false, paused_reason: null, started_equity: 1, peak_equity: 2, owner_id: "o",
  };
  const pub = store.publicAccount(row);
  assert.equal(pub.apiKeyHint, "ABCD…IJKL");
  assert.equal(pub.accountId, "acc");
  assert.equal(pub.book, "flywheel");
  for (const k of Object.keys(pub)) assert.ok(!k.toLowerCase().includes("secret"), `unexpected field ${k}`);
  assert.ok(!JSON.stringify(pub).includes("ABCDEFGHIJKL"));
  assert.equal(store.publicAccount({ ...row, api_key: "SHORT123" }).apiKeyHint, "••••");
  assert.equal(store.publicAccount({ ...row, api_key: undefined }).apiKeyHint, "••••");
});

test("encryption requires KEY_ENCRYPTION_SECRET of 32+ characters", async () => {
  const original = process.env.KEY_ENCRYPTION_SECRET;
  try {
    process.env.KEY_ENCRYPTION_SECRET = "too-short";
    await assert.rejects(store.saveAccount({ ownerId: "o", apiKey: "K1", apiSecret: SECRET, equity: 1 }), /KEY_ENCRYPTION_SECRET/);
    delete process.env.KEY_ENCRYPTION_SECRET;
    await assert.rejects(store.saveAccount({ ownerId: "o", apiKey: "K2", apiSecret: SECRET, equity: 1 }), /KEY_ENCRYPTION_SECRET/);
  } finally {
    process.env.KEY_ENCRYPTION_SECRET = original;
  }
  assert.equal(calls.length, 0, "nothing reaches the database when encryption fails");
});
