export interface InboxMessageRecord {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxRepositoryPort {
  insertIfAbsent(record: InboxMessageRecord): Promise<boolean>;
  markProcessed(consumerName: string, messageId: string, processedAt: Date): Promise<void>;
}

export class InboxPayloadMismatchError extends Error {
  constructor() {
    super("inbox message ID was reused with a different payload");
    this.name = "InboxPayloadMismatchError";
  }
}
