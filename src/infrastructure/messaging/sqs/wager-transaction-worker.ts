import {
  ChangeMessageVisibilityCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export interface SqsMessageHandler {
  handle(queueUrl: string, message: Message): Promise<void>;
}

export class WagerTransactionWorker {
  private stopping = false;
  private controller?: AbortController;
  private loop?: Promise<void>;

  constructor(
    private readonly client: SQSClient,
    private readonly handler: SqsMessageHandler,
  ) {}

  start(queueUrl: string): void {
    if (this.loop !== undefined) throw new Error("SQS worker is already running");
    this.stopping = false;
    this.controller = new AbortController();
    this.loop = this.poll(queueUrl, this.controller.signal);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    await this.loop;
    this.loop = undefined;
    this.controller = undefined;
  }

  private async poll(queueUrl: string, signal: AbortSignal): Promise<void> {
    while (!this.stopping) {
      let messages: Message[];
      try {
        const response = await this.client.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 10,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }), { abortSignal: signal });
        messages = response.Messages ?? [];
      } catch (error) {
        if (this.stopping && error instanceof Error && error.name === "AbortError") return;
        console.error(JSON.stringify({
          event: "sqs.receive.failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      for (const message of messages) {
        if (this.stopping) {
          if (message.ReceiptHandle !== undefined) {
            try {
              await this.client.send(new ChangeMessageVisibilityCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0,
              }));
            } catch (error) {
              console.error(JSON.stringify({
                event: "sqs.message.visibility_release_failure",
                messageId: message.MessageId,
                errorName: error instanceof Error ? error.name : "UnknownError",
              }));
            }
          }
          break;
        }
        try {
          await this.handler.handle(queueUrl, message);
        } catch (error) {
          console.error(JSON.stringify({
            event: "sqs.message.worker_failure",
            messageId: message.MessageId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          }));
        }
      }
    }
  }
}
