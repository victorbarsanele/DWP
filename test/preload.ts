import { loadConfig } from "../src/config/configuration";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL ??= loadConfig().testDatabaseUrl;
