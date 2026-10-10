import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";
import { HttpExceptionFilter } from "./http/http-exception.filter";

const config = loadConfig();
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.enableShutdownHooks();
app.useGlobalFilters(new HttpExceptionFilter());
app.use((
  request: { method: string; url: string; headers: Record<string, string | string[] | undefined> },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    on(event: string, listener: () => void): void;
  },
  next: () => void,
) => {
  const correlationId = typeof request.headers["x-correlation-id"] === "string"
    && request.headers["x-correlation-id"]!.length > 0
    ? request.headers["x-correlation-id"] as string
    : crypto.randomUUID();
  response.setHeader("X-Correlation-Id", correlationId);
  const startedAt = Date.now();
  response.on("finish", () => {
    console.log(JSON.stringify({
      method: request.method,
      route: request.url.split("?")[0],
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
      correlationId,
    }));
  });
  next();
});
await app.listen(config.port);
