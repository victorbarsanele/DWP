import {
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TransactionRunnerPort } from "../../../application/ports/transaction-runner.port";
import { MetricsRegistry } from "../../../application/services/metrics.registry";

export class OutboxMessagePublisher {
  constructor(
    private readonly transactions: TransactionRunnerPort,
    private readonly client: SQSClient,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async publishOne(queueUrl: string): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const messages = await transaction.execute<{
        id: string;
        event_id: string;
        aggregate_id: string;
        payload: unknown;
        attempts: number;
      }>(
        `select id, event_id, aggregate_id, payload, attempts
           from outbox_messages
          where published_at is null and next_attempt_at <= current_timestamp
          order by occurred_at, id
          for update skip locked
          limit 1`,
      );
      const message = messages[0];
      if (message === undefined) return false;

      try {
        const body = typeof message.payload === "string"
          ? message.payload
          : JSON.stringify(message.payload);
        if (body === undefined) throw new Error("outbox payload is not serializable");

        await this.client.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: message.aggregate_id,
          MessageDeduplicationId: message.event_id,
        }));
      } catch (error) {
        const attempt = Number(message.attempts) + 1;
        const retryDelaySeconds = Math.min(300, 2 ** Math.min(attempt - 1, 8));
        this.metrics?.increment("retries_total");
        this.metrics?.increment("outbox_publish_failures_total");
        await transaction.execute(
          `update outbox_messages
              set attempts = attempts + 1,
                  next_attempt_at = current_timestamp + ($2 * interval '1 second')
            where id = $1 and published_at is null`,
          [message.id, retryDelaySeconds],
        );
        console.error(JSON.stringify({
          event: "outbox.publish.failure",
          eventId: message.event_id,
          attempt,
          retryDelaySeconds,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        return true;
      }

      const updated = await transaction.execute<{ id: string }>(
        `update outbox_messages
            set published_at = current_timestamp
          where id = $1 and published_at is null
          returning id`,
        [message.id],
      );
      if (updated.length !== 1) {
        throw new Error("outbox message could not be marked published");
      }
      return true;
    });
  }
}
