import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { loadConfig } from "../../../config/configuration";
import { entities } from "./schemas/schemas";

export function mikroOrmOptions() {
  const config = loadConfig();
  const clientUrl =
    process.env.TEST_DATABASE_URL
    ?? (config.nodeEnv === "test" ? config.databaseUrl : undefined);
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
    pool: { min: 2, max: 10 },
  };
}
