import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { AppConfig } from "../../../config/configuration";

export interface SqsQueueUrls {
  readonly wagerTransactions: string;
  readonly deadLetter: string;
  readonly events: string;
}

export class SqsQueueProvisioner {
  private queues?: Promise<SqsQueueUrls>;

  constructor(
    private readonly client: SQSClient,
    private readonly config: AppConfig["sqs"],
  ) {}

  ensureQueues(): Promise<SqsQueueUrls> {
    this.queues ??= this.createQueues();
    return this.queues;
  }

  private async createQueues(): Promise<SqsQueueUrls> {
    const deadLetterQueue = await this.client.send(new CreateQueueCommand({
      QueueName: this.config.wagerDlqName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }));
    if (deadLetterQueue.QueueUrl === undefined) {
      throw new Error("SQS did not return the dead-letter queue URL");
    }

    const deadLetterAttributes = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueue.QueueUrl,
      AttributeNames: ["QueueArn"],
    }));
    const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
    if (deadLetterArn === undefined) {
      throw new Error("SQS did not return the dead-letter queue ARN");
    }

    const wagerQueue = await this.client.send(new CreateQueueCommand({
      QueueName: this.config.wagerQueueName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: String(this.config.maxReceiveCount),
        }),
      },
    }));
    if (wagerQueue.QueueUrl === undefined) {
      throw new Error("SQS did not return the wager queue URL");
    }

    const eventQueue = await this.client.send(new CreateQueueCommand({
      QueueName: this.config.eventQueueName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }));
    if (eventQueue.QueueUrl === undefined) {
      throw new Error("SQS did not return the event queue URL");
    }

    return {
      wagerTransactions: wagerQueue.QueueUrl,
      deadLetter: deadLetterQueue.QueueUrl,
      events: eventQueue.QueueUrl,
    };
  }
}
