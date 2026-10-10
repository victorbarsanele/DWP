import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../../config/configuration";
import { ApplicationModule } from "../../../application/application.module";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { PendingReferenceResolverWorker } from "../pending-reference-resolver.worker";
import { MikroTransactionRunner } from "../../persistence/mikro-orm/transaction-runner.adapter";
import { MetricsRegistry } from "../../../application/services/metrics.registry";
import { OutboxMessagePublisher } from "./outbox-message-publisher";
import { OutboxPublisherWorker } from "./outbox-publisher-worker";
import { SqsQueueProvisioner } from "./sqs-queue-provisioner";
import { SqsWorkerLifecycle } from "./sqs-worker-lifecycle";
import { WagerTransactionMessageHandler } from "./wager-transaction-message.handler";
import { WagerTransactionWorker } from "./wager-transaction-worker";

@Module({
  imports: [ApplicationModule],
  providers: [
    {
      provide: SQSClient,
      useFactory: () => {
        const config = loadConfig().sqs;
        return new SQSClient({
          endpoint: config.endpoint,
          region: config.region,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          },
        });
      },
    },
    {
      provide: SqsQueueProvisioner,
      inject: [SQSClient],
      useFactory: (client: SQSClient) => new SqsQueueProvisioner(client, loadConfig().sqs),
    },
    {
      provide: WagerTransactionMessageHandler,
      inject: [SQSClient, ProcessWagerTransactionUseCase, MetricsRegistry],
      useFactory: (
        client: SQSClient,
        useCase: ProcessWagerTransactionUseCase,
        metrics: MetricsRegistry,
      ) => new WagerTransactionMessageHandler(client, useCase, 1, metrics),
    },
    {
      provide: WagerTransactionWorker,
      inject: [SQSClient, WagerTransactionMessageHandler],
      useFactory: (
        client: SQSClient,
        handler: WagerTransactionMessageHandler,
      ) => new WagerTransactionWorker(client, handler),
    },
    {
      provide: OutboxMessagePublisher,
      inject: [MikroTransactionRunner, SQSClient, MetricsRegistry],
      useFactory: (
        transactions: MikroTransactionRunner,
        client: SQSClient,
        metrics: MetricsRegistry,
      ) => new OutboxMessagePublisher(transactions, client, metrics),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [OutboxMessagePublisher],
      useFactory: (publisher: OutboxMessagePublisher) =>
        new OutboxPublisherWorker(publisher),
    },
    {
      provide: PendingReferenceResolverWorker,
      inject: [ProcessWagerTransactionUseCase],
      useFactory: (useCase: ProcessWagerTransactionUseCase) =>
        new PendingReferenceResolverWorker(
          useCase,
          loadConfig().pendingReferences.pollIntervalMs,
        ),
    },
    {
      provide: SqsWorkerLifecycle,
      inject: [
        SQSClient,
        SqsQueueProvisioner,
        WagerTransactionWorker,
        OutboxPublisherWorker,
        PendingReferenceResolverWorker,
      ],
      useFactory: (
        client: SQSClient,
        queues: SqsQueueProvisioner,
        wagers: WagerTransactionWorker,
        outbox: OutboxPublisherWorker,
        pendingReferences: PendingReferenceResolverWorker,
      ) => new SqsWorkerLifecycle(client, queues, wagers, outbox, pendingReferences),
    },
  ],
  exports: [SQSClient, SqsQueueProvisioner],
})
export class SqsMessagingModule {}
