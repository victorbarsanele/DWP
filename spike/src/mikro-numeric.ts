import { MikroORM, EntitySchema } from "@mikro-orm/postgresql";
import Decimal from "decimal.js";

interface NumericRow {
  id: string;
  amount: string;
}

const NumericSchema = new EntitySchema<NumericRow>({
  name: "NumericRow",
  tableName: "numeric_rows",
  properties: {
    id: { type: "uuid", primary: true },
    amount: { type: "numeric", precision: 19, scale: 2 },
  },
});

const orm = await MikroORM.init({
  entities: [NumericSchema],
  dbName: "spike",
  host: "127.0.0.1",
  port: 55432,
  user: "spike",
  password: "spike",
  driver: (await import("@mikro-orm/postgresql")).PostgreSqlDriver,
});

await orm.schema.refreshDatabase();
const em = orm.em.fork();
const values = ["0.10", "0.20", "1234567890123.45"];
for (const [index, amount] of values.entries()) {
  await em.insert("NumericRow", { id: crypto.randomUUID(), amount });
  if (index === values.length - 1) await em.flush();
}

const rows = await em.getConnection().execute<NumericRow[]>(
  "select amount::text as amount from numeric_rows order by amount",
);
const decimalSum = new Decimal("0.10").plus(new Decimal("0.20")).toFixed(2);
console.log(JSON.stringify({
  rows,
  amountTypes: rows.map((row) => typeof row.amount),
  decimalSum,
  largeValue: rows.find((row) => row.amount === "1234567890123.45")?.amount,
}));

await orm.close(true);
