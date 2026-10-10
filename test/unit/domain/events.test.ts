import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { WagerTransactionPendingReference } from "../../../src/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../../src/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../../src/domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed";

const context = { correlationId: "correlation-1", causationId: "cause-1" };
const now = new Date("2026-01-01T00:00:00.000Z");
const transaction = WagerTransaction.create({
  id: "transaction-1",
  providerId: "provider",
  externalTransactionId: "external",
  idempotencyKey: "key",
  payloadHash: "a".repeat(64),
  walletId: "wallet-1",
  playerId: "player",
  roundId: "round",
  gameId: "game",
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: "10.00", currency: "BRL" }),
  createdAt: now,
});

describe("integration events", () => {
  it("propagates correlation and causation in processed event envelope", () => {
    transaction.markProcessed(undefined, now);
    const event = WagerTransactionProcessed.from("event-1", transaction, context);
    const json = event.toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.correlationId).toBe("correlation-1");
    expect(json.causationId).toBe("cause-1");
    expect(json.data).toEqual({
      transactionId: "transaction-1",
      kind: WagerTransactionKind.Bet,
      status: "PROCESSED",
    });
  });

  it("serializes rejected and pending reference events", () => {
    const rejected = WagerTransaction.rehydrate({
      ...transaction,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(WagerTransactionRejected.from("event-2", rejected, context).toJSON().data)
      .toEqual({
        transactionId: "transaction-1",
        failureCode: FailureCode.InsufficientFunds,
        status: "REJECTED",
      });
    const pending = WagerTransaction.create({
      ...transaction,
      id: "transaction-2",
      externalTransactionId: "external-2",
      idempotencyKey: "key-2",
      referenceExternalTransactionId: "reference",
    });
    pending.markPendingReference(now);
    expect(WagerTransactionPendingReference.from("event-3", pending, context).toJSON().data)
      .toEqual({
        transactionId: "transaction-2",
        referenceExternalTransactionId: "reference",
        status: "PENDING_REFERENCE",
      });
  });

  it("serializes wallet balance changed with Money props", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
      now,
    });
    const movement = wallet.credit({
      entryId: "entry-1",
      transactionId: "transaction-1",
      amount: Money.from({ amount: "5.00", currency: "BRL" }),
      now,
    });
    const event = WalletBalanceChanged.from("event-4", wallet, movement.entry, context);
    expect(event.toJSON().data).toEqual({
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: "CREDIT",
      money: { amount: "5.00", currency: "BRL" },
      balanceBefore: { amount: "10.00", currency: "BRL" },
      balanceAfter: { amount: "15.00", currency: "BRL" },
      walletVersion: 2,
    });
  });
});
