import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { loadConfig } from "../../../config/configuration";
import { entities } from "./schemas/schemas";

export function mikroOrmOptions() {
  const config = loadConfig();
  const clientUrl = config.nodeEnv === "test"
    ? process.env.TEST_DATABASE_URL ?? config.databaseUrl
    : config.databaseUrl;
  return {
    entities,
    driver: PostgreSqlDriver,
    ...(clientUrl === undefined ? {} : { clientUrl }),
    ...(clientUrl === undefined
      ? {
          dbName: config.database.name,
          host: config.database.host,
          port: config.database.port,
          user: config.database.user,
          password: config.database.password,
        }
      : {}),
    migrations: {
      path: "src/infrastructure/persistence/mikro-orm/migrations",
      tableName: "mikro_orm_migrations",
    },
    pool: {
      min: Number(process.env.DB_POOL_MIN ?? "0"),
      max: Number(process.env.DB_POOL_MAX ?? "10"),
      acquireTimeoutMillis: Number(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS ?? "15000"),
      idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? "100"),
    },
  };
}
