import { Money } from "../../domain/money/money";
import {
  WagerReference,
  WagerTransaction,
} from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { IntegrationEvent } from "../../domain/events/integration-event";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { SqlTransaction, TransactionRunnerPort } from "./transaction-runner.port";

export interface NewWagerRecord {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly amount: string;
  readonly currency: string;
  readonly referenceExternalTransactionId?: string;
  readonly payloadHash: string;
  readonly createdAt: Date;
}

export interface WagerRepositoryPort {
  insertIfAbsent(record: NewWagerRecord): Promise<string | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findReferenceForUpdate(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findProcessedReversal(referenceId: string): Promise<WagerTransaction | undefined>;
  updateDecision(input: {
    transaction: WagerTransaction;
    snapshot: Money;
    walletVersion: number;
    attempts: number;
    nextAttemptAt: Date | null;
  }): Promise<void>;
}

export interface WalletRepositoryPort {
  findById(id: string, lock: boolean): Promise<Wallet | undefined>;
  findByPlayerCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}

export interface LedgerRepositoryPort {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxWriterPort {
  append(event: IntegrationEvent<unknown>): Promise<void>;
}

export interface WageringPorts {
  readonly wagers: WagerRepositoryPort;
  readonly wallets: WalletRepositoryPort;
  readonly ledger: LedgerRepositoryPort;
  readonly outbox: OutboxWriterPort;
}

export interface WageringPortFactory {
  forTransaction(transaction: SqlTransaction): WageringPorts;
}
