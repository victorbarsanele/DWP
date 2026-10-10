import { describe, expect, it } from "bun:test";
import {
  InvalidReferenceError,
  InvalidTransactionStateError,
} from "../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import {
  WagerReference,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { Money } from "../../../src/domain/money/money";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const amount = (value: string) => Money.from({ amount: value, currency: "BRL" });
const create = (kind: WagerTransactionKind, value = "10.00") =>
  WagerTransaction.create({
    id: `transaction-${kind}`,
    providerId: "provider",
    externalTransactionId: `external-${kind}`,
    idempotencyKey: `key-${kind}`,
    payloadHash: "a".repeat(64),
    walletId: "wallet",
    playerId: "player",
    roundId: "round",
    gameId: "game",
    kind,
    money: amount(value),
    createdAt,
    ...(
      kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
        ? { referenceExternalTransactionId: "reference" }
        : {}
    ),
  });

const reference = (
  kind: WagerTransactionKind,
  status: WagerTransactionStatus,
  value = "10.00",
): WagerReference => ({
  id: "reference",
  providerId: "provider",
  playerId: "player",
  walletId: "wallet",
  roundId: "round",
  kind,
  status,
  money: amount(value),
});

describe("WagerTransaction", () => {
  it("starts pending and requires reference for reversals", () => {
    expect(create(WagerTransactionKind.Bet).status).toBe(WagerTransactionStatus.Pending);
    expect(() => WagerTransaction.create({
      id: "transaction",
      providerId: "provider",
      externalTransactionId: "external",
      idempotencyKey: "key",
      payloadHash: "a".repeat(64),
      walletId: "wallet",
      playerId: "player",
      roundId: "round",
      gameId: "game",
      kind: WagerTransactionKind.Rollback,
      money: amount("10.00"),
      createdAt,
      referenceExternalTransactionId: undefined,
    })).toThrow(InvalidReferenceError);
  });

  it("allows only valid transitions and rejects terminal changes", () => {
    const transaction = create(WagerTransactionKind.Bet);
    transaction.markPendingReference(createdAt);
    transaction.markProcessed(undefined, createdAt);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(() => transaction.reject(FailureCode.InsufficientFunds, createdAt))
      .toThrow(InvalidTransactionStateError);
  });

  it("maps balance effect and rollback directions", () => {
    expect(create(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe("DEBIT");
    expect(create(WagerTransactionKind.Win).ledgerDirectionFor()).toBe("CREDIT");
    expect(create(WagerTransactionKind.Refund).ledgerDirectionFor()).toBe("CREDIT");
    expect(create(WagerTransactionKind.Rollback).ledgerDirectionFor(
      reference(WagerTransactionKind.Bet, WagerTransactionStatus.Processed),
    )).toBe("CREDIT");
    expect(create(WagerTransactionKind.Rollback).ledgerDirectionFor(
      reference(WagerTransactionKind.Win, WagerTransactionStatus.Processed),
    )).toBe("DEBIT");
    expect(create(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
  });

  it("waits for absent or pending reversal reference", () => {
    const transaction = create(WagerTransactionKind.Refund);
    expect(transaction.validateReference(undefined)).toEqual({
      type: "WAIT",
      code: FailureCode.ReferencePending,
    });
    expect(transaction.validateReference(
      reference(WagerTransactionKind.Bet, WagerTransactionStatus.PendingReference),
    )).toEqual({ type: "WAIT", code: FailureCode.ReferencePending });
  });

  it("rejects rejected reference as not processed", () => {
    const transaction = create(WagerTransactionKind.Refund);
    expect(transaction.validateReference(
      reference(WagerTransactionKind.Bet, WagerTransactionStatus.Rejected),
    )).toEqual({ type: "REJECT", code: FailureCode.ReferenceNotProcessed });
  });

  it("does not compare value for referenced WIN", () => {
    const transaction = create(WagerTransactionKind.Win, "99.00");
    expect(transaction.validateReference(
      reference(WagerTransactionKind.Bet, WagerTransactionStatus.Processed, "10.00"),
    )).toEqual({ type: "VALID" });
  });

  it("compares value for REFUND and ROLLBACK", () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      const transaction = create(kind, "99.00");
      expect(transaction.validateReference(
        reference(WagerTransactionKind.Bet, WagerTransactionStatus.Processed, "10.00"),
      )).toEqual({ type: "REJECT", code: FailureCode.ReferenceAmountMismatch });
    }
  });

  it("validates reference identity, kind and currency", () => {
    const transaction = create(WagerTransactionKind.Refund);
    expect(transaction.validateReference({
      ...reference(WagerTransactionKind.Win, WagerTransactionStatus.Processed),
    })).toEqual({ type: "REJECT", code: FailureCode.InvalidReferenceKind });
    expect(transaction.validateReference({
      ...reference(WagerTransactionKind.Bet, WagerTransactionStatus.Processed),
      providerId: "other-provider",
    })).toEqual({ type: "REJECT", code: FailureCode.ReferenceIdentityMismatch });
    expect(transaction.validateReference({
      ...reference(WagerTransactionKind.Bet, WagerTransactionStatus.Processed),
      money: Money.from({ amount: "10.00", currency: "USD" }),
    })).toEqual({ type: "REJECT", code: FailureCode.ReferenceCurrencyMismatch });
  });

  it("decides processed reversal uniqueness", () => {
    const transaction = create(WagerTransactionKind.Refund);
    expect(() => transaction.assertReversalNotAlreadyProcessed(
      create(WagerTransactionKind.Bet),
    )).not.toThrow();
    const processed = WagerTransaction.rehydrate({
      ...create(WagerTransactionKind.Refund),
      status: WagerTransactionStatus.Processed,
    });
    expect(() => transaction.assertReversalNotAlreadyProcessed(processed))
      .toThrow(InvalidReferenceError);
  });
});
