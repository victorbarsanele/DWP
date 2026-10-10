import { OutboxMessagePublisher } from "./outbox-message-publisher";

export class OutboxPublisherWorker {
  private stopping = false;
  private loop?: Promise<void>;

  constructor(private readonly publisher: OutboxMessagePublisher) {}

  start(queueUrl: string): void {
    if (this.loop !== undefined) throw new Error("outbox publisher is already running");
    this.stopping = false;
    this.loop = this.poll(queueUrl);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.loop = undefined;
  }

  private async poll(queueUrl: string): Promise<void> {
    while (!this.stopping) {
      try {
        const published = await this.publisher.publishOne(queueUrl);
        if (!published) await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error(JSON.stringify({
          event: "outbox.publisher.failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
