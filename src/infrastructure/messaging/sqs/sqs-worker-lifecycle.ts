import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { OutboxPublisherWorker } from "./outbox-publisher-worker";
import { SqsQueueProvisioner } from "./sqs-queue-provisioner";
import { WagerTransactionWorker } from "./wager-transaction-worker";
import { PendingReferenceResolverWorker } from "../pending-reference-resolver.worker";

export class SqsWorkerLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: SqsQueueProvisioner,
    private readonly wagers: WagerTransactionWorker,
    private readonly outbox: OutboxPublisherWorker,
    private readonly pendingReferences: PendingReferenceResolverWorker,
  ) {}

  async onModuleInit(): Promise<void> {
    const urls = await this.queues.ensureQueues();
    this.wagers.start(urls.wagerTransactions);
    this.outbox.start(urls.events);
    this.pendingReferences.start();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.wagers.stop(),
      this.outbox.stop(),
      this.pendingReferences.stop(),
    ]);
    this.client.destroy();
    console.log(JSON.stringify({ event: "sqs.lifecycle.shutdown_complete" }));
  }
}
