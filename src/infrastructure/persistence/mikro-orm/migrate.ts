import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { mikroOrmOptions } from "./mikro-orm.options";

const requestedAction = process.argv[2];
const useTestDatabase = requestedAction === "test-up" || requestedAction === "test-down";
const action = useTestDatabase ? requestedAction.replace("test-", "") : requestedAction;
if (action !== "up" && action !== "down") {
  throw new Error("Usage: bun run migrate:up|migrate:down");
}
if (useTestDatabase) {
  process.env.TEST_DATABASE_URL ??=
    "postgresql://spike:spike@127.0.0.1:55432/spike_test";
}

const orm = await MikroORM.init(mikroOrmOptions());
try {
  if (action === "up") {
    await orm.getMigrator().up();
  } else {
    await orm.getMigrator().down();
  }
} finally {
  await orm.close(true);
}
