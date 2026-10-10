import { EventContext, IntegrationEvent } from "./integration-event";
import { WagerTransaction } from "../wagering/wager-transaction";
import { FailureCode } from "../shared/failure-code";

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly failureCode: FailureCode;
  readonly status: "REJECTED";
}

export class WagerTransactionRejected
  extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(
    eventId: string,
    transaction: WagerTransaction,
    context: EventContext,
  ) {
    if (transaction.failureCode === undefined) {
      throw new Error("rejected transaction requires failureCode");
    }
    super(
      eventId,
      transaction.walletId,
      context.correlationId,
      context.causationId,
      transaction.processedAt ?? transaction.createdAt,
      {
        transactionId: transaction.id,
        failureCode: transaction.failureCode,
        status: "REJECTED",
      },
    );
  }

  static from(
    eventId: string,
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(eventId, transaction, context);
  }
}
