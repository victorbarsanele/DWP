import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";

const config = loadConfig();
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.enableShutdownHooks();
await app.listen(config.port);
