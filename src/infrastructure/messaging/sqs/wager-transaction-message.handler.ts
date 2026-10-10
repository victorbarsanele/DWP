import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { InfrastructureTransientError } from "../../../application/ports/transaction-runner.port";
import { InboxPayloadMismatchError } from "../../../application/ports/inbox-message.port";
import { ProcessWagerInput } from "../../../application/dto/wagering.dto";
import { HttpValidationError, validateWagerBody } from "../../../http/validation";
import { MetricsRegistry } from "../../../application/services/metrics.registry";

const CONSUMER_NAME = "wager-transactions";

interface WagerQueueEnvelope {
  readonly messageId: string;
  readonly input: ProcessWagerInput;
  readonly payloadHash: string;
  readonly correlationId: string;
}

export class InvalidWagerQueueMessageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidWagerQueueMessageError";
  }
}

export type ProcessWagerFromInbox = Pick<ProcessWagerTransactionUseCase, "executeFromInbox">;

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export class WagerTransactionMessageHandler {
  constructor(
    private readonly client: SQSClient,
    private readonly processWager: ProcessWagerFromInbox,
    private readonly retryBaseSeconds = 1,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async handle(queueUrl: string, message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined) {
      console.error(JSON.stringify({
        event: "sqs.message.receipt_handle_missing",
        messageId: message.MessageId,
      }));
      return;
    }

    try {
      const envelope = this.parse(message.Body);
      await this.processWager.executeFromInbox(
        { ...envelope.input, correlationId: envelope.correlationId },
        {
          consumerName: CONSUMER_NAME,
          messageId: envelope.messageId,
          payloadHash: envelope.payloadHash,
        },
      );
    } catch (error) {
      if (
        error instanceof InvalidWagerQueueMessageError
        || error instanceof InboxPayloadMismatchError
      ) {
        console.error(JSON.stringify({
          event: "sqs.message.permanent_failure",
          messageId: message.MessageId,
          errorName: error.name,
        }));
        return;
      }

      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
      this.metrics?.increment("retries_total");
      const delaySeconds = Math.min(
        300,
        this.retryBaseSeconds * 2 ** Math.max(0, receiveCount - 1),
      );
      console.error(JSON.stringify({
        event: error instanceof InfrastructureTransientError
          ? "sqs.message.transient_failure"
          : "sqs.message.processing_failure",
        messageId: message.MessageId,
        receiveCount,
        visibilityDelaySeconds: delaySeconds,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      await this.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delaySeconds,
      }));
      return;
    }

    await this.client.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }));
  }

  private parse(body: string | undefined): WagerQueueEnvelope {
    if (body === undefined) throw new InvalidWagerQueueMessageError("message body is missing");
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch (error) {
      throw new InvalidWagerQueueMessageError("message body is not valid JSON", { cause: error });
    }

    const envelope = record(value);
    if (
      envelope === undefined
      || typeof envelope.messageId !== "string"
      || !/^[\x21-\x7e]{1,255}$/.test(envelope.messageId)
      || envelope.type !== "WagerTransactionRequested"
      || typeof envelope.occurredAt !== "string"
      || Number.isNaN(Date.parse(envelope.occurredAt))
    ) {
      throw new InvalidWagerQueueMessageError("message envelope is invalid");
    }

    const data = record(envelope.data);
    if (data === undefined) throw new InvalidWagerQueueMessageError("message data is invalid");
    let input: ProcessWagerInput;
    try {
      input = validateWagerBody(data, data.idempotencyKey);
    } catch (error) {
      if (error instanceof HttpValidationError) {
        throw new InvalidWagerQueueMessageError("message data failed validation", { cause: error });
      }
      throw error;
    }

    return {
      messageId: envelope.messageId,
      input,
      payloadHash: createHash("sha256").update(body, "utf8").digest("hex"),
      correlationId: typeof envelope.correlationId === "string"
        ? envelope.correlationId
        : envelope.messageId,
    };
  }
}
