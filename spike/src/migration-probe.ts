import { MikroORM } from "@mikro-orm/postgresql";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { LockSchema } from "./shared-lock-schema";

const orm = await MikroORM.init({
  entities: [LockSchema],
  dbName: "spike",
  host: "127.0.0.1",
  port: 55432,
  user: "spike",
  password: "spike",
  driver: PostgreSqlDriver,
  migrations: {
    path: "src/migrations",
    tableName: "spike_migrations",
  },
});

const migrator = orm.getMigrator();
await migrator.up();
const connection = orm.em.getConnection();
const ledgerId = crypto.randomUUID();
const transactionId = crypto.randomUUID();
await connection.execute(
  "insert into spike_ledger (id, balance) values (?, ?)",
  [ledgerId, "10.00"],
);
await connection.execute(
  "insert into spike_transactions (id, reference_transaction_id, kind, status) values (?, ?, ?, ?)",
  [transactionId, ledgerId, "REFUND", "PROCESSED"],
);

const failures: Record<string, string> = {};
for (const [name, sql] of [
  ["update", "update spike_ledger set balance = 9.00 where id = ?"],
  ["delete", "delete from spike_ledger where id = ?"],
] as const) {
  try {
    await connection.execute(sql, [ledgerId]);
  } catch (error) {
    failures[name] = error instanceof Error ? error.message : String(error);
  }
}

try {
  await connection.execute(
    "insert into spike_ledger (id, balance) values (?, ?)",
    [crypto.randomUUID(), "-0.01"],
  );
} catch (error) {
  failures.check = error instanceof Error ? error.message : String(error);
}

try {
  await connection.execute(
    "insert into spike_transactions (id, reference_transaction_id, kind, status) values (?, ?, ?, ?)",
    [crypto.randomUUID(), ledgerId, "ROLLBACK", "PROCESSED"],
  );
} catch (error) {
  failures.partialUnique = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify({ afterUp: { failures } }));

await migrator.down();
const afterDown = await connection.execute<{ exists: boolean }[]>(
  `select exists (select 1 from information_schema.tables where table_name = 'spike_ledger') as exists`,
);
const functionAfterDown = await connection.execute<{ exists: boolean }[]>(
  `select exists (select 1 from pg_proc where proname = 'spike_ledger_immutable') as exists`,
);
console.log(JSON.stringify({
  afterDown: {
    ledgerExists: afterDown[0]?.exists,
    functionExists: functionAfterDown[0]?.exists,
  },
}));

await migrator.up();
const afterUpAgain = await connection.execute<{ exists: boolean }[]>(
  `select exists (select 1 from information_schema.tables where table_name = 'spike_ledger') as exists`,
);
console.log(JSON.stringify({ afterUpAgain: { ledgerExists: afterUpAgain[0]?.exists } }));
await orm.close(true);
