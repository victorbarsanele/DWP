import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { NestFactory } from "@nestjs/core";
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import pg from "pg";
import { ProcessWagerInput } from "../../../src/application/dto/wagering.dto";
import { InfrastructureTransientError } from "../../../src/application/ports/transaction-runner.port";
import { WageringPortFactory } from "../../../src/application/ports/wagering.ports";
import { CreateWalletUseCase } from "../../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { loadConfig } from "../../../src/config/configuration";
import { assertWalletInvariant } from "../postgres/helpers/assert-wallet-invariant";
import { AppModule } from "../../../src/app.module";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm/mikro-orm.options";
import { MikroTransactionRunner } from "../../../src/infrastructure/persistence/mikro-orm/transaction-runner.adapter";
import { MikroWageringPortFactory } from "../../../src/infrastructure/persistence/mikro-orm/wagering.adapter";
import { OutboxMessagePublisher } from "../../../src/infrastructure/messaging/sqs/outbox-message-publisher";
import { SqsQueueProvisioner } from "../../../src/infrastructure/messaging/sqs/sqs-queue-provisioner";
import {
  ProcessWagerFromInbox,
  WagerTransactionMessageHandler,
} from "../../../src/infrastructure/messaging/sqs/wager-transaction-message.handler";
import { WagerTransactionWorker } from "../../../src/infrastructure/messaging/sqs/wager-transaction-worker";

const CONSUMER_NAME = "wager-transactions";
const sqsConfig = loadConfig().sqs;

function id(): string {
  return crypto.randomUUID();
}

function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: sqsConfig.endpoint,
    region: sqsConfig.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}

interface TestQueues {
  readonly sourceUrl: string;
  readonly deadLetterUrl: string;
}

describe("SQS wager transaction consumer with LocalStack and PostgreSQL", () => {
  setDefaultTimeout(30000);
  const trackedWallets = new Set<string>();
  const queueUrls = new Set<string>();
  const databasePool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 5000,
  });
  const inspector = createSqsClient();
  let orm: MikroORM;
  let productionPorts: MikroWageringPortFactory;
  let runner: MikroTransactionRunner;
  let ids: { next(): string };
  let clock: { now(): Date };

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmOptions());
    productionPorts = new MikroWageringPortFactory(orm.em);
    runner = new MikroTransactionRunner(orm.em);
    ids = { next: id };
    clock = { now: () => new Date() };
  });

  afterAll(async () => {
    for (const queueUrl of queueUrls) {
      await inspector.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    await inspector.destroy();
    await databasePool.end();
    await orm.em.getConnection().getKnex().destroy();
  });

  afterEach(async () => {
    for (const walletId of trackedWallets) {
      await assertWalletInvariant(walletId, "0.00");
    }
    trackedWallets.clear();
  });

  test("provisions FIFO queues with a persistent redrive policy", async () => {
    const suffix = id().replaceAll("-", "");
    const provisioner = new SqsQueueProvisioner(inspector, {
      ...sqsConfig,
      wagerQueueName: `dwp-provisioned-${suffix}.fifo`,
      wagerDlqName: `dwp-provisioned-dlq-${suffix}.fifo`,
      maxReceiveCount: 3,
    });
    const queues = await provisioner.ensureQueues();
    queueUrls.add(queues.wagerTransactions);
    queueUrls.add(queues.deadLetter);
    queueUrls.add(queues.events);
    expect(await provisioner.ensureQueues()).toEqual(queues);

    const sourceAttributes = await inspector.send(new GetQueueAttributesCommand({
      QueueUrl: queues.wagerTransactions,
      AttributeNames: ["FifoQueue", "RedrivePolicy"],
    }));
    const redrivePolicy = JSON.parse(sourceAttributes.Attributes?.RedrivePolicy ?? "{}") as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string;
    };
    const deadLetterAttributes = await inspector.send(new GetQueueAttributesCommand({
      QueueUrl: queues.deadLetter,
      AttributeNames: ["QueueArn"],
    }));
    expect(sourceAttributes.Attributes?.FifoQueue).toBe("true");
    expect(redrivePolicy.deadLetterTargetArn).toBe(deadLetterAttributes.Attributes?.QueueArn);
    expect(redrivePolicy.maxReceiveCount).toBe("3");
    const eventAttributes = await inspector.send(new GetQueueAttributesCommand({
      QueueUrl: queues.events,
      AttributeNames: ["FifoQueue"],
    }));
    expect(eventAttributes.Attributes?.FifoQueue).toBe("true");
  });

  test("starts the consumer through Nest and drains it during application shutdown", async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.init();
      const queues = await app.get(SqsQueueProvisioner).ensureQueues();
      queueUrls.add(queues.wagerTransactions);
      queueUrls.add(queues.deadLetter);
      queueUrls.add(queues.events);
      expect(app.get(WagerTransactionWorker)).toBeInstanceOf(WagerTransactionWorker);
    } finally {
      await app.close();
    }
  });

  test("commits Inbox and financial effects before acknowledging a message", async () => {
    const queues = await createQueues();
    const wallet = await createWallet("100.00");
    const message = envelope(wallet.walletId, wallet.playerId, "10.00");
    await send(queues.sourceUrl, message);
    const received = await receive(queues.sourceUrl);
    expect(received?.Body).toBeDefined();

    const handler = new WagerTransactionMessageHandler(
      inspector,
      createUseCase(productionPorts),
    );
    await handler.handle(queues.sourceUrl, received!);

    const counts = await countsFor(wallet.walletId, message.messageId);
    expect(counts).toEqual({ wagers: 1, ledgerDebits: 1, inbox: 1, processedInbox: 1 });
    expect(await receive(queues.sourceUrl)).toBeUndefined();
  });

  test("acknowledges a committed business rejection as terminal", async () => {
    const queues = await createQueues();
    const wallet = await createWallet("5.00");
    const message = envelope(wallet.walletId, wallet.playerId, "10.00");
    await send(queues.sourceUrl, message);
    const received = await receive(queues.sourceUrl);
    const handler = new WagerTransactionMessageHandler(
      inspector,
      createUseCase(productionPorts),
    );
    await handler.handle(queues.sourceUrl, received!);

    const wager = await databasePool.query<{ status: string; failure_code: string }>(
      `select status, failure_code from wager_transactions
       where wallet_id = $1 and kind = 'BET'`,
      [wallet.walletId],
    );
    expect(wager.rows[0]).toEqual({
      status: "REJECTED",
      failure_code: "INSUFFICIENT_FUNDS",
    });
    expect(await countsFor(wallet.walletId, message.messageId))
      .toEqual({ wagers: 1, ledgerDebits: 0, inbox: 1, processedInbox: 1 });
    expect(await receive(queues.sourceUrl)).toBeUndefined();
  });

  test("redelivery after commit is deduplicated by the persistent Inbox", async () => {
    const queues = await createQueues();
    const wallet = await createWallet("100.00");
    const message = envelope(wallet.walletId, wallet.playerId, "10.00");
    await send(queues.sourceUrl, message);
    const firstDelivery = await receive(queues.sourceUrl);
    expect(firstDelivery?.Body).toBeDefined();

    const useCase = createUseCase(productionPorts);
    await useCase.executeFromInbox(message.data, {
      consumerName: CONSUMER_NAME,
      messageId: message.messageId,
      payloadHash: hashMessage(firstDelivery!.Body!),
    });
    const redelivery = await waitForMessage(queues.sourceUrl);
    expect(redelivery?.MessageId).toBe(firstDelivery?.MessageId);

    await new WagerTransactionMessageHandler(inspector, useCase)
      .handle(queues.sourceUrl, redelivery!);
    expect(await countsFor(wallet.walletId, message.messageId))
      .toEqual({ wagers: 1, ledgerDebits: 1, inbox: 1, processedInbox: 1 });
    expect(await receive(queues.sourceUrl)).toBeUndefined();
  });

  test("rolls Inbox back with financial effects when transaction fails", async () => {
    const queues = await createQueues();
    const wallet = await createWallet("100.00");
    const message = envelope(wallet.walletId, wallet.playerId, "10.00");
    await send(queues.sourceUrl, message);
    const firstDelivery = await receive(queues.sourceUrl);
    expect(firstDelivery?.Body).toBeDefined();

    const failingPorts: WageringPortFactory = {
      forTransaction: (transaction) => {
        const ports = productionPorts.forTransaction(transaction);
        return {
          ...ports,
          outbox: {
            append: async () => {
              throw new Error("injected outbox failure");
            },
          },
        };
      },
    };
    await expect(createUseCase(failingPorts).executeFromInbox(message.data, {
      consumerName: CONSUMER_NAME,
      messageId: message.messageId,
      payloadHash: hashMessage(firstDelivery!.Body!),
    })).rejects.toThrow("injected outbox failure");
    expect(await countsFor(wallet.walletId, message.messageId))
      .toEqual({ wagers: 0, ledgerDebits: 0, inbox: 0, processedInbox: 0 });

    const redelivery = await waitForMessage(queues.sourceUrl);
    expect(redelivery?.Body).toBe(firstDelivery?.Body);
    await new WagerTransactionMessageHandler(
      inspector,
      createUseCase(productionPorts),
    ).handle(queues.sourceUrl, redelivery!);
    expect(await countsFor(wallet.walletId, message.messageId))
      .toEqual({ wagers: 1, ledgerDebits: 1, inbox: 1, processedInbox: 1 });
  });

  test("retries transient failures and sends invalid messages to the configured DLQ", async () => {
    const retryQueues = await createQueues();
    const wallet = await createWallet("100.00");
    const retryMessage = envelope(wallet.walletId, wallet.playerId, "10.00");
    await send(retryQueues.sourceUrl, retryMessage);
    let attempts = 0;
    const retryingUseCase: ProcessWagerFromInbox = {
      executeFromInbox: async () => {
        attempts += 1;
        if (attempts === 1) throw new InfrastructureTransientError("temporary database failure");
        return undefined;
      },
    };
    const retryHandler = new WagerTransactionMessageHandler(inspector, retryingUseCase);
    const first = await receive(retryQueues.sourceUrl);
    await retryHandler.handle(retryQueues.sourceUrl, first!);
    const second = await waitForMessage(retryQueues.sourceUrl);
    expect(second?.MessageId).toBe(first?.MessageId);
    await retryHandler.handle(retryQueues.sourceUrl, second!);
    expect(attempts).toBe(2);
    expect(await receive(retryQueues.sourceUrl)).toBeUndefined();

    const dlqQueues = await createQueues();
    await sendRaw(dlqQueues.sourceUrl, "{invalid");
    const permanentHandler = new WagerTransactionMessageHandler(
      inspector,
      createUseCase(productionPorts),
    );
    const invalidFirst = await receive(dlqQueues.sourceUrl);
    await permanentHandler.handle(dlqQueues.sourceUrl, invalidFirst!);
    const invalidSecond = await waitForMessage(dlqQueues.sourceUrl);
    await permanentHandler.handle(dlqQueues.sourceUrl, invalidSecond!);
    let deadLetter: Message | undefined;
    for (let attempt = 0; attempt < 5 && deadLetter === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const nextDelivery = await receive(dlqQueues.sourceUrl);
      if (nextDelivery !== undefined) {
        await permanentHandler.handle(dlqQueues.sourceUrl, nextDelivery);
      }
      deadLetter = await receive(dlqQueues.deadLetterUrl);
    }
    expect(deadLetter?.Body).toBe("{invalid");
  });

  test("SIGTERM shutdown waits for in-flight work to finish before closing SQS", async () => {
    const queues = await createQueues();
    const workerClient = createSqsClient();
    const message = envelope(id(), id(), "1.00");
    await send(queues.sourceUrl, message);

    let started!: () => void;
    const processingStarted = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const finishWork = new Promise<void>((resolve) => { finish = resolve; });
    const handler = {
      handle: async (queueUrl: string, received: Message) => {
        started();
        await finishWork;
        await workerClient.send(new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: received.ReceiptHandle!,
        }));
      },
    };
    const worker = new WagerTransactionWorker(
      workerClient,
      handler,
    );
    worker.start(queues.sourceUrl);
    await processingStarted;

    let shutdownFinished = false;
    const shutdown = worker.stop().then(() => { shutdownFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(shutdownFinished).toBe(false);
    finish();
    await shutdown;
    workerClient.destroy();
    expect(await receive(queues.sourceUrl)).toBeUndefined();
  });

  test("two concurrent publishers claim and publish every Outbox event once", async () => {
    const eventQueueUrl = await createEventQueue();
    const eventIds = await insertOutboxEvents(12);
    const firstPublisher = new OutboxMessagePublisher(runner, inspector);
    const secondPublisher = new OutboxMessagePublisher(runner, inspector);

    await Promise.all([
      drainOutbox(firstPublisher, eventQueueUrl),
      drainOutbox(secondPublisher, eventQueueUrl),
    ]);

    const rows = await databasePool.query<{ event_id: string; published_at: Date | null }>(
      `select event_id, published_at from outbox_messages where event_id = any($1::uuid[])`,
      [eventIds],
    );
    expect(rows.rows).toHaveLength(eventIds.length);
    expect(rows.rows.every((row) => row.published_at !== null)).toBe(true);

    const publishedIds = new Set<string>();
    for (let index = 0; index < eventIds.length; index += 1) {
      const message = await receive(eventQueueUrl);
      expect(message?.Body).toBeDefined();
      publishedIds.add(JSON.parse(message!.Body!).eventId as string);
      await inspector.send(new DeleteMessageCommand({
        QueueUrl: eventQueueUrl,
        ReceiptHandle: message!.ReceiptHandle!,
      }));
    }
    expect([...publishedIds].sort()).toEqual([...eventIds].sort());
    expect(await receive(eventQueueUrl)).toBeUndefined();
  });

  test("committed events recover after restart and failed sends persist backoff", async () => {
    const eventQueueUrl = await createEventQueue();
    const [eventId] = await insertOutboxEvents(1);
    const publisherAfterRestart = new OutboxMessagePublisher(runner, inspector);
    expect(await publisherAfterRestart.publishOne(eventQueueUrl)).toBe(true);
    const recovered = await receive(eventQueueUrl);
    expect(JSON.parse(recovered!.Body!).eventId).toBe(eventId);
    await inspector.send(new DeleteMessageCommand({
      QueueUrl: eventQueueUrl,
      ReceiptHandle: recovered!.ReceiptHandle!,
    }));

    const [retryEventId] = await insertOutboxEvents(1);
    const publisher = new OutboxMessagePublisher(runner, inspector);
    expect(await publisher.publishOne(
      `${sqsConfig.endpoint}/000000000000/missing-outbox-queue.fifo`,
    )).toBe(true);
    const scheduled = await databasePool.query<{
      attempts: number;
      published_at: Date | null;
      next_attempt_at: Date;
    }>(
      `select attempts, published_at, next_attempt_at from outbox_messages where event_id = $1`,
      [retryEventId],
    );
    expect(Number(scheduled.rows[0]?.attempts)).toBe(1);
    expect(scheduled.rows[0]?.published_at).toBeNull();
    expect(scheduled.rows[0]?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await publisher.publishOne(eventQueueUrl)).toBe(true);
    const retried = await receive(eventQueueUrl);
    expect(JSON.parse(retried!.Body!).eventId).toBe(retryEventId);
    await inspector.send(new DeleteMessageCommand({
      QueueUrl: eventQueueUrl,
      ReceiptHandle: retried!.ReceiptHandle!,
    }));
    const published = await databasePool.query<{ published_at: Date | null }>(
      `select published_at from outbox_messages where event_id = $1`,
      [retryEventId],
    );
    expect(published.rows[0]?.published_at).not.toBeNull();
  });

  async function createWallet(initialBalance: string): Promise<{ walletId: string; playerId: string }> {
    const walletId = id();
    const playerId = id();
    trackedWallets.add(walletId);
    await new CreateWalletUseCase(runner, productionPorts, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: initialBalance, currency: "BRL" },
    });
    return { walletId, playerId };
  }

  function createUseCase(ports: WageringPortFactory): ProcessWagerTransactionUseCase {
    return new ProcessWagerTransactionUseCase(runner, ports, clock, ids);
  }

  async function createQueues(): Promise<TestQueues> {
    const suffix = id().replaceAll("-", "");
    const deadLetter = await inspector.send(new CreateQueueCommand({
      QueueName: `dwp-test-dlq-${suffix}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "1",
      },
    }));
    expect(deadLetter.QueueUrl).toBeDefined();
    const arn = await inspector.send(new GetQueueAttributesCommand({
      QueueUrl: deadLetter.QueueUrl!,
      AttributeNames: ["QueueArn"],
    }));
    const deadLetterArn = arn.Attributes?.QueueArn;
    expect(deadLetterArn).toBeDefined();

    const source = await inspector.send(new CreateQueueCommand({
      QueueName: `dwp-test-wagers-${suffix}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "1",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: "2",
        }),
      },
    }));
    expect(source.QueueUrl).toBeDefined();
    queueUrls.add(deadLetter.QueueUrl!);
    queueUrls.add(source.QueueUrl!);
    return { sourceUrl: source.QueueUrl!, deadLetterUrl: deadLetter.QueueUrl! };
  }

  async function createEventQueue(): Promise<string> {
    const suffix = id().replaceAll("-", "");
    const result = await inspector.send(new CreateQueueCommand({
      QueueName: `dwp-test-events-${suffix}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }));
    expect(result.QueueUrl).toBeDefined();
    queueUrls.add(result.QueueUrl!);
    return result.QueueUrl!;
  }

  async function insertOutboxEvents(count: number): Promise<string[]> {
    await databasePool.query(
      `update outbox_messages set published_at = current_timestamp
       where published_at is null`,
    );
    const eventIds = Array.from({ length: count }, id);
    for (const eventId of eventIds) {
      const aggregateId = id();
      await databasePool.query(
        `insert into outbox_messages
         (id, event_id, aggregate_id, event_type, version, payload, occurred_at)
         values ($1, $2, $3, 'TestEvent', 1, $4::jsonb, current_timestamp)`,
        [
          eventId,
          eventId,
          aggregateId,
          JSON.stringify({
            eventId,
            eventType: "TestEvent",
            aggregateId,
            version: 1,
            data: { test: true },
          }),
        ],
      );
    }
    return eventIds;
  }

  async function drainOutbox(publisher: OutboxMessagePublisher, queueUrl: string): Promise<void> {
    let attempts = 0;
    while (await publisher.publishOne(queueUrl)) {
      attempts += 1;
      if (attempts > 20) throw new Error("outbox publisher did not become idle");
    }
  }

  async function send(queueUrl: string, message: ReturnType<typeof envelope>): Promise<void> {
    await inspector.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: message.data.walletId,
      MessageDeduplicationId: id(),
    }));
  }

  async function sendRaw(queueUrl: string, body: string): Promise<void> {
    await inspector.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: id(),
      MessageDeduplicationId: id(),
    }));
  }

  async function receive(queueUrl: string): Promise<Message | undefined> {
    const result = await inspector.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 1,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }));
    return result.Messages?.[0];
  }

  async function waitForMessage(queueUrl: string): Promise<Message | undefined> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const message = await receive(queueUrl);
      if (message !== undefined) return message;
    }
    return undefined;
  }

  async function countsFor(walletId: string, messageId: string) {
    const result = await databasePool.query<{
      wagers: string;
      ledger_debits: string;
      inbox: string;
      processed_inbox: string;
    }>(
      `select
         (select count(*) from wager_transactions
           where wallet_id = $1 and kind <> 'OPENING') as wagers,
         (select count(*) from wallet_ledger_entries
           where wallet_id = $1 and direction = 'DEBIT') as ledger_debits,
         (select count(*) from inbox_messages
           where consumer_name = $2 and message_id = $3) as inbox,
         (select count(*) from inbox_messages
           where consumer_name = $2 and message_id = $3 and processed_at is not null) as processed_inbox`,
      [walletId, CONSUMER_NAME, messageId],
    );
    const row = result.rows[0]!;
    return {
      wagers: Number(row.wagers),
      ledgerDebits: Number(row.ledger_debits),
      inbox: Number(row.inbox),
      processedInbox: Number(row.processed_inbox),
    };
  }
});

function envelope(walletId: string, playerId: string, amount: string) {
  const messageId = id();
  const data: ProcessWagerInput = {
    providerId: `provider-${id()}`,
    externalTransactionId: `external-${id()}`,
    idempotencyKey: `key-${id()}`,
    playerId,
    walletId,
    roundId: `round-${id()}`,
    gameId: `game-${id()}`,
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: "BRL" },
  };
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  };
}

function hashMessage(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
