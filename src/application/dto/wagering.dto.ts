import { FailureCode } from "../../domain/shared/failure-code";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction";

export interface ProcessWagerInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
  readonly correlationId?: string;
}

export interface WagerResult {
  readonly status: string;
  readonly transactionId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly walletVersion: number;
  readonly idempotentReplay: boolean;
  readonly failureCode?: FailureCode;
}

export interface CreateWalletInput {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: { readonly amount: string; readonly currency: string };
  readonly correlationId?: string;
}

export interface WalletResult {
  readonly walletId: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}
