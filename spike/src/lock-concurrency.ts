import "reflect-metadata";
import { EntitySchema, LockMode, MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import pg from "pg";

interface LockRow {
  id: string;
  balance: string;
}

const LockSchema = new EntitySchema<LockRow>({
  name: "LockRow",
  tableName: "lock_rows",
  properties: {
    id: { type: "uuid", primary: true },
    balance: { type: "numeric", precision: 19, scale: 2 },
  },
});

const orm = await MikroORM.init({
  entities: [LockSchema],
  dbName: "spike",
  host: "127.0.0.1",
  port: 55432,
  user: "spike",
  password: "spike",
  driver: PostgreSqlDriver,
  pool: { min: 10, max: 10 },
  debug: true,
});
await orm.schema.refreshDatabase();
const id = crypto.randomUUID();
await orm.em.getConnection().execute(
  "insert into lock_rows (id, balance) values (?, ?)",
  [id, "100.00"],
);

await orm.em.fork().transactional(async (tx) => {
  const row = await tx.findOne(LockSchema, id, {
    lockMode: LockMode.PESSIMISTIC_WRITE,
  });
  console.log(JSON.stringify({ lockProbeInsideTransaction: row?.balance }));
});

let lockOutsideTransaction = "not-tested";
try {
  await orm.em.fork().findOne(
    LockSchema,
    id,
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  );
  lockOutsideTransaction = "unexpectedly-accepted";
} catch (error) {
  lockOutsideTransaction = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify({ lockOutsideTransaction }));

async function lockedDebit(amount: string): Promise<boolean> {
  const fork = orm.em.fork({ clear: true });
  return fork.transactional(async (tx) => {
    const row = await tx.findOne(LockSchema, id, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    if (row === null) throw new Error("lock row missing");
    const balance = row.balance;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const numericBalance = Number.parseFloat(balance);
    if (numericBalance < Number.parseFloat(amount)) return false;
    row.balance = (numericBalance - Number.parseFloat(amount)).toFixed(2);
    await tx.flush();
    return true;
  });
}

async function reset(balance: string): Promise<void> {
  await orm.em.getConnection().execute(
    "update lock_rows set balance = ? where id = ?",
    [balance, id],
  );
}

async function readBalance(): Promise<string> {
  const result = await orm.em.getConnection().execute<{ balance: string }[]>(
    "select balance::text as balance from lock_rows where id = ?",
    [id],
  );
  return result[0]?.balance ?? "missing";
}

async function unsafeDebit(pool: pg.Pool, amount: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const read = await client.query<{ balance: string }>(
      "select balance::text as balance from lock_rows where id = $1",
      [id],
    );
    const balance = Number.parseFloat(read.rows[0]?.balance ?? "0");
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (balance < amount) {
      await client.query("rollback");
      return false;
    }
    await client.query(
      "update lock_rows set balance = $1 where id = $2",
      [balance - amount, id],
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const pool = new pg.Pool({
  host: "127.0.0.1",
  port: 55432,
  database: "spike",
  user: "spike",
  password: "spike",
  max: 10,
});
await reset("100.00");
const unsafeResults = await Promise.all([
  unsafeDebit(pool, 80),
  unsafeDebit(pool, 80),
]);
console.log(JSON.stringify({
  negativeControl: {
    appliedCount: unsafeResults.filter(Boolean).length,
    finalBalance: await readBalance(),
  },
}));

const rounds: Array<{ appliedCount: number; finalBalance: string }> = [];
for (let round = 0; round < 20; round += 1) {
  await reset("100.00");
  const applied = await Promise.all([
    lockedDebit("80.00"),
    lockedDebit("80.00"),
  ]);
  rounds.push({ appliedCount: applied.filter(Boolean).length, finalBalance: await readBalance() });
}
console.log(JSON.stringify({
  twentyRounds: {
    allOneApplied: rounds.every((round) => round.appliedCount === 1),
    allTwenty: rounds,
  },
}));

await reset("100.00");
const fifty = await Promise.all(
  Array.from({ length: 50 }, () => lockedDebit("10.00")),
);
console.log(JSON.stringify({
  fiftyDebits: {
    appliedCount: fifty.filter(Boolean).length,
    finalBalance: await readBalance(),
  },
}));

await pool.end();
await orm.close(true);
