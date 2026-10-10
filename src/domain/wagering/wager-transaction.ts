import {
  InvalidReferenceError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from "../shared/domain-error";
import { FailureCode } from "../shared/failure-code";
import { Money } from "../money/money";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface WagerReference {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly money: Money;
}

export type ReferenceDecision =
  | { readonly type: "VALID" }
  | { readonly type: "WAIT"; readonly code: FailureCode.ReferencePending }
  | { readonly type: "REJECT"; readonly code: FailureCode };

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

export interface CreateWagerTransactionProps extends Omit<
  WagerTransactionState,
  "status" | "referenceTransactionId" | "failureCode" | "processedAt"
> {}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError("wager amount must be positive");
    }
    if (
      (props.kind === WagerTransactionKind.Refund
        || props.kind === WagerTransactionKind.Rollback)
      && props.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidReferenceError("reversal requires reference");
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidReferenceError("OPENING is internal only");
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined ? undefined : new Date(state.processedAt),
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt);
  }

  markPendingReference(_at: Date): void {
    this.assertTransition(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertTransition(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at);
    this._failureCode = undefined;
  }

  reject(code: FailureCode, at: Date): void {
    this.assertTransition(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date(at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertTransition(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date(at);
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund
      || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  validateReference(reference: WagerReference | undefined): ReferenceDecision {
    if (reference === undefined) {
      return this.requiresReference()
        ? { type: "WAIT", code: FailureCode.ReferencePending }
        : { type: "VALID" };
    }
    if (
      reference.status === WagerTransactionStatus.Pending
      || reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { type: "WAIT", code: FailureCode.ReferencePending };
    }
    if (
      reference.status === WagerTransactionStatus.Rejected
      || reference.status === WagerTransactionStatus.Failed
    ) {
      return { type: "REJECT", code: FailureCode.ReferenceNotProcessed };
    }
    if (this.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      return { type: "REJECT", code: FailureCode.InvalidReferenceKind };
    }
    if (
      this.kind === WagerTransactionKind.Rollback
      && ![
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ].includes(reference.kind)
    ) {
      return { type: "REJECT", code: FailureCode.InvalidReferenceKind };
    }
    if (
      this.kind === WagerTransactionKind.Win
      && reference.kind !== WagerTransactionKind.Bet
    ) {
      return { type: "REJECT", code: FailureCode.InvalidReferenceKind };
    }
    if (
      reference.providerId !== this.providerId
      || reference.playerId !== this.playerId
      || reference.walletId !== this.walletId
      || reference.roundId !== this.roundId
    ) {
      return { type: "REJECT", code: FailureCode.ReferenceIdentityMismatch };
    }
    if (reference.money.currency !== this.money.currency) {
      return { type: "REJECT", code: FailureCode.ReferenceCurrencyMismatch };
    }
    if (
      (this.kind === WagerTransactionKind.Refund
        || this.kind === WagerTransactionKind.Rollback)
      && !reference.money.equals(this.money)
    ) {
      return { type: "REJECT", code: FailureCode.ReferenceAmountMismatch };
    }
    return { type: "VALID" };
  }

  assertReversalNotAlreadyProcessed(existing: WagerTransaction | undefined): void {
    if (existing?.status === WagerTransactionStatus.Processed) {
      throw new InvalidReferenceError(FailureCode.ReferenceAlreadyReversed);
    }
  }

  ledgerDirectionFor(reference?: WagerReference): "DEBIT" | "CREDIT" {
    if (this.kind === WagerTransactionKind.Bet) return "DEBIT";
    if (
      this.kind === WagerTransactionKind.Win
      || this.kind === WagerTransactionKind.Refund
      || this.kind === WagerTransactionKind.Opening
    ) return "CREDIT";
    if (this.kind === WagerTransactionKind.Rollback && reference !== undefined) {
      return reference.kind === WagerTransactionKind.Bet ? "CREDIT" : "DEBIT";
    }
    throw new InvalidReferenceError("ROLLBACK requires valid reference");
  }

  private assertTransition(next: WagerTransactionStatus): void {
    const valid = this._status === WagerTransactionStatus.Pending
      ? [
          WagerTransactionStatus.PendingReference,
          WagerTransactionStatus.Processed,
          WagerTransactionStatus.Rejected,
          WagerTransactionStatus.Failed,
        ].includes(next)
      : this._status === WagerTransactionStatus.PendingReference
        ? [
            WagerTransactionStatus.Processed,
            WagerTransactionStatus.Rejected,
            WagerTransactionStatus.Failed,
          ].includes(next)
        : false;
    if (!valid) throw new InvalidTransactionStateError("invalid wager transaction transition");
  }
}
