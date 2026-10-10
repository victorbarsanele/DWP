import { EventContext, IntegrationEvent } from "./integration-event";
import { WagerTransaction } from "../wagering/wager-transaction";

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly referenceExternalTransactionId: string;
  readonly status: "PENDING_REFERENCE";
}

export class WagerTransactionPendingReference
  extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(
    eventId: string,
    transaction: WagerTransaction,
    context: EventContext,
  ) {
    if (transaction.referenceExternalTransactionId === undefined) {
      throw new Error("pending reference event requires reference");
    }
    super(
      eventId,
      transaction.walletId,
      context.correlationId,
      context.causationId,
      transaction.createdAt,
      {
        transactionId: transaction.id,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        status: "PENDING_REFERENCE",
      },
    );
  }

  static from(
    eventId: string,
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(eventId, transaction, context);
  }
}
