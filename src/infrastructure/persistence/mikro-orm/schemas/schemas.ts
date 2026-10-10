import { EntitySchema } from "@mikro-orm/core";

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  payloadHash: string;
  failureCode?: string;
  attempts: number;
  nextAttemptAt?: Date;
  resultBalanceAmount?: string;
  resultBalanceCurrency?: string;
  resultWalletVersion?: number;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: "WalletRow",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { fieldName: "player_id", type: "uuid" },
    currency: { type: "string", length: 3 },
    balanceAmount: { fieldName: "balance_amount", type: "numeric", precision: 19, scale: 2 },
    version: { type: "integer" },
    createdAt: { fieldName: "created_at", type: "timestamptz" },
    updatedAt: { fieldName: "updated_at", type: "timestamptz" },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: "WagerTransactionRow",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { fieldName: "provider_id", type: "string", length: 100 },
    externalTransactionId: { fieldName: "external_transaction_id", type: "string", length: 255 },
    idempotencyKey: { fieldName: "idempotency_key", type: "string", length: 255 },
    playerId: { fieldName: "player_id", type: "uuid" },
    walletId: { fieldName: "wallet_id", type: "uuid" },
    roundId: { fieldName: "round_id", type: "string", length: 255 },
    gameId: { fieldName: "game_id", type: "string", length: 255 },
    kind: { type: "string", length: 16 },
    status: { type: "string", length: 24 },
    amount: { type: "numeric", precision: 19, scale: 2 },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: { fieldName: "reference_external_transaction_id", type: "string", length: 255, nullable: true },
    referenceTransactionId: { fieldName: "reference_transaction_id", type: "uuid", nullable: true },
    payloadHash: { fieldName: "payload_hash", type: "string", length: 64 },
    failureCode: { fieldName: "failure_code", type: "string", length: 80, nullable: true },
    attempts: { type: "integer" },
    nextAttemptAt: { fieldName: "next_attempt_at", type: "timestamptz", nullable: true },
    resultBalanceAmount: { fieldName: "result_balance_amount", type: "numeric", precision: 19, scale: 2, nullable: true },
    resultBalanceCurrency: { fieldName: "result_balance_currency", type: "string", length: 3, nullable: true },
    resultWalletVersion: { fieldName: "result_wallet_version", type: "integer", nullable: true },
    createdAt: { fieldName: "created_at", type: "timestamptz" },
    updatedAt: { fieldName: "updated_at", type: "timestamptz" },
    processedAt: { fieldName: "processed_at", type: "timestamptz", nullable: true },
  },
});

export const LedgerSchema = new EntitySchema({
  name: "WalletLedgerEntryRow",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { fieldName: "wallet_id", type: "uuid" },
    transactionId: { fieldName: "transaction_id", type: "uuid" },
    direction: { type: "string", length: 6 },
    amount: { type: "numeric", precision: 19, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { fieldName: "balance_before", type: "numeric", precision: 19, scale: 2 },
    balanceAfter: { fieldName: "balance_after", type: "numeric", precision: 19, scale: 2 },
    createdAt: { fieldName: "created_at", type: "timestamptz" },
  },
});

export const InboxSchema = new EntitySchema({
  name: "InboxMessageRow",
  tableName: "inbox_messages",
  properties: {
    consumerName: { fieldName: "consumer_name", type: "string", length: 100, primary: true },
    messageId: { fieldName: "message_id", type: "string", length: 255, primary: true },
    payloadHash: { fieldName: "payload_hash", type: "string", length: 64 },
    receivedAt: { fieldName: "received_at", type: "timestamptz" },
    processedAt: { fieldName: "processed_at", type: "timestamptz", nullable: true },
  },
});

export const OutboxSchema = new EntitySchema({
  name: "OutboxMessageRow",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    eventId: { fieldName: "event_id", type: "uuid", unique: true },
    aggregateId: { fieldName: "aggregate_id", type: "uuid" },
    eventType: { fieldName: "event_type", type: "string", length: 100 },
    version: { type: "integer" },
    payload: { type: "json" },
    occurredAt: { fieldName: "occurred_at", type: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { fieldName: "next_attempt_at", type: "timestamptz" },
    publishedAt: { fieldName: "published_at", type: "timestamptz", nullable: true },
  },
});

export const entities = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerSchema,
  InboxSchema,
  OutboxSchema,
];
