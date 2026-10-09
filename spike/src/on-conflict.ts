import pg from "pg";

const pool = new pg.Pool({
  host: "127.0.0.1",
  port: 55432,
  database: "spike",
  user: "spike",
  password: "spike",
  max: 10,
});

await pool.query(`
  create table if not exists idempotency_rows (
    id uuid primary key,
    idempotency_key text not null unique,
    payload_hash text not null
  )
`);
await pool.query("truncate idempotency_rows");

async function insertOrRead(index: number): Promise<{
  inserted: boolean;
  visibleAfterCommit: boolean;
}> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: string }>(
      `insert into idempotency_rows (id, idempotency_key, payload_hash)
       values ($1, $2, $3)
       on conflict (idempotency_key) do nothing
       returning id`,
      [crypto.randomUUID(), "same-key", `hash-${index}`],
    );
    await client.query("commit");
    if (inserted.rowCount === 1) {
      return { inserted: true, visibleAfterCommit: true };
    }
    const existing = await client.query(
      "select id from idempotency_rows where idempotency_key = $1",
      ["same-key"],
    );
    return { inserted: false, visibleAfterCommit: existing.rowCount === 1 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const results = await Promise.all(
  Array.from({ length: 50 }, (_, index) => insertOrRead(index)),
);
console.log(JSON.stringify({
  onConflictReturning: {
    total: results.length,
    inserted: results.filter((result) => result.inserted).length,
    losersReadingAfterCommit: results.filter((result) => !result.inserted && result.visibleAfterCommit).length,
    rows: (await pool.query("select count(*)::int as count from idempotency_rows")).rows[0]?.count,
    isolation: (await pool.query("show transaction_isolation")).rows[0]?.transaction_isolation,
    sqlShape: "INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id",
    returnShape: "{ rows: [{ id }], rowCount: 1 } or { rows: [], rowCount: 0 }",
  },
}));

await pool.query("truncate idempotency_rows");
await pool.query(
  "insert into idempotency_rows (id, idempotency_key, payload_hash) values ($1, $2, $3)",
  [crypto.randomUUID(), "duplicate", "first"],
);
const fallback = await pool.connect();
let abortedError = "";
try {
  await fallback.query("begin");
  try {
    await fallback.query(
      "insert into idempotency_rows (id, idempotency_key, payload_hash) values ($1, $2, $3)",
      [crypto.randomUUID(), "duplicate", "second"],
    );
  } catch (error) {
    abortedError = error instanceof Error ? error.message : String(error);
  }
  try {
    await fallback.query(
      "select id from idempotency_rows where idempotency_key = $1",
      ["duplicate"],
    );
  } catch (error) {
    abortedError += ` | follow-up: ${error instanceof Error ? error.message : String(error)}`;
  }
  await fallback.query("rollback");
} finally {
  fallback.release();
}
console.log(JSON.stringify({ uniqueViolationFallback: { abortedError } }));
await pool.end();
