import {
  DeleteQueueCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import pg from "pg";
import { AppModule } from "../../../src/app.module";
import { loadConfig } from "../../../src/config/configuration";
import { HttpExceptionFilter } from "../../../src/http/http-exception.filter";
import { SqsQueueProvisioner } from "../../../src/infrastructure/messaging/sqs/sqs-queue-provisioner";

function id(): string {
  return crypto.randomUUID();
}

const suffix = id().replaceAll("-", "");
process.env.SQS_WAGER_QUEUE_NAME = `dwp-api-${suffix}.fifo`;
process.env.SQS_WAGER_DLQ_NAME = `dwp-api-dlq-${suffix}.fifo`;
process.env.SQS_EVENT_QUEUE_NAME = `dwp-api-events-${suffix}.fifo`;

function createSqsClient(): SQSClient {
  const config = loadConfig().sqs;
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}

describe("wallet operations HTTP API with PostgreSQL and LocalStack", () => {
  setDefaultTimeout(30000);
  const database = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let queues: { wagerTransactions: string; deadLetter: string; events: string };
  const inspector = createSqsClient();

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
    queues = await app.get(SqsQueueProvisioner).ensureQueues();
  });

  afterAll(async () => {
    await app.close();
    for (const QueueUrl of Object.values(queues)) {
      await inspector.send(new DeleteQueueCommand({ QueueUrl }));
    }
    await inspector.destroy();
    await database.end();
  });

  test("exposes health, stable ledger pagination, reconciliation, and Prometheus metrics", async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "alive" });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      dependencies: { postgresql: "up", sqs: "up" },
    });

    const playerId = id();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = await created.json() as { id: string };

    const wager = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `api-${id()}`,
      },
      body: JSON.stringify({
        providerId: "integration-provider",
        externalTransactionId: id(),
        playerId,
        walletId: wallet.id,
        roundId: "api-round",
        gameId: "api-game",
        kind: "BET",
        money: { amount: "80.00", currency: "BRL" },
      }),
    });
    expect(wager.status).toBe(201);

    const firstPageResponse = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1`);
    expect(firstPageResponse.status).toBe(200);
    const firstPage = await firstPageResponse.json() as {
      entries: { direction: string }[];
      nextCursor?: string;
    };
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]?.direction).toBe("CREDIT");
    expect(firstPage.nextCursor).toBeString();

    const secondPageResponse = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${firstPage.nextCursor}`,
    );
    const secondPage = await secondPageResponse.json() as { entries: { direction: string }[] };
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0]?.direction).toBe("DEBIT");

    const consistent = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    expect(consistent.status).toBe(201);
    expect(await consistent.json()).toMatchObject({
      storedBalance: "20.00",
      calculatedBalance: "20.00",
      consistent: true,
      status: "CONSISTENT",
    });

    await database.query("update wallets set balance_amount = 19.00 where id = $1", [wallet.id]);
    const diverged = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    expect(await diverged.json()).toMatchObject({
      storedBalance: "19.00",
      calculatedBalance: "20.00",
      consistent: false,
      status: "DIVERGED",
    });
    expect((await database.query<{ balance_amount: string }>(
      "select balance_amount::text from wallets where id = $1",
      [wallet.id],
    )).rows[0]?.balance_amount).toBe("19.00");

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    const exposition = await metrics.text();
    expect(exposition).toContain("reconciliation_divergences_total 1");
    expect(exposition).toMatch(/wager_transactions\{status="PROCESSED"\} \d+/);
    expect(exposition).toContain("outbox_oldest_pending_age_seconds");
  });

  test("rejects malformed ledger cursors and limits", async () => {
    const playerId = id();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "0.00", currency: "BRL" },
      }),
    });
    const wallet = await created.json() as { id: string };
    const cursor = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?cursor=not-a-cursor`);
    expect(cursor.status).toBe(400);
    const limit = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=101`);
    expect(limit.status).toBe(400);
  });
});
