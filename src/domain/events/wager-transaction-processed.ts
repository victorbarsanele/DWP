import { IntegrationEvent, EventContext } from "./integration-event";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../wagering/wager-transaction";

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly kind: WagerTransactionKind;
  readonly status: "PROCESSED";
}

export class WagerTransactionProcessed
  extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(
    eventId: string,
    transaction: WagerTransaction,
    context: EventContext,
  ) {
    super(
      eventId,
      transaction.walletId,
      context.correlationId,
      context.causationId,
      transaction.processedAt ?? transaction.createdAt,
      {
        transactionId: transaction.id,
        kind: transaction.kind,
        status: "PROCESSED",
      },
    );
  }

  static from(
    eventId: string,
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(eventId, transaction, context);
  }
}
