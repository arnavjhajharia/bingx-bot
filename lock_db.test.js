// The run lease against a real Postgres. Needs TEST_DATABASE_URL pointed at a throwaway database.
const test = require("node:test");
const assert = require("node:assert/strict");

const URL = process.env.TEST_DATABASE_URL;
test("the run lease is exclusive, renewable, expires, and is released only by its holder", { skip: !URL }, async () => {
  process.env.DATABASE_URL = URL;
  process.env.KEY_ENCRYPTION_SECRET ||= "test-secret-test-secret-test-secret";
  const store = require("./store");
  await store.migrate();
  await store.migrate();
  const pool = store.getPool();
  const query = (sql, params) => pool.query(sql, params);
  const id = "11111111-2222-3333-4444-555555555555";
  await query("DELETE FROM accounts WHERE id = $1", [id]);
  await query(
    "INSERT INTO accounts (id, owner_id, api_key, secret_ciphertext, secret_iv, secret_tag) VALUES ($1, 'did:privy:t', 'k-lease', 'c', 'i', 't')",
    [id]
  );

  const first = await store.claimRun(id);
  assert.equal(first.id, id, "the claim returns the fresh row");
  assert.equal(await store.claimRun(id), null, "a second claim fails while the lease is held");
  assert.equal(await store.renewRun(id), true, "the holder can renew");

  await query("UPDATE accounts SET run_lock_owner = 'other-instance' WHERE id = $1", [id]);
  assert.equal(await store.renewRun(id), false, "a lease taken by another copy cannot be renewed");
  await store.releaseRun(id);
  assert.equal(await store.claimRun(id), null, "only the holder can release it");

  await query("UPDATE accounts SET run_lock_until = NOW() - interval '1 second' WHERE id = $1", [id]);
  assert.ok(await store.claimRun(id), "an expired lease can be taken");
  await query("UPDATE accounts SET run_lock_until = NOW() - interval '1 second' WHERE id = $1", [id]);
  assert.equal(await store.renewRun(id), false, "an expired lease cannot be renewed, even by its holder");
  assert.ok(await store.claimRun(id), "so it is taken afresh");
  await store.releaseRun(id);
  assert.ok(await store.claimRun(id), "a released lease can be taken");
  assert.equal(await store.claimRun("99999999-0000-0000-0000-000000000000"), null, "no account, no lease");
  await query("DELETE FROM accounts WHERE id = $1", [id]);
  await pool.end();
});
