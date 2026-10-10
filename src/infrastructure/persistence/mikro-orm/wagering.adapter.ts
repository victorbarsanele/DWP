import { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../../domain/money/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { Wallet } from "../../../domain/wallet/wallet";
import {
  LedgerRepositoryPort,
  NewWagerRecord,
  OutboxWriterPort,
  WagerRepositoryPort,
  WalletRepositoryPort,
  WageringPortFactory,
  WageringPorts,
} from "../../../application/ports/wagering.ports";
import { SqlTransaction } from "../../../application/ports/transaction-runner.port";
import { IntegrationEvent } from "../../../domain/events";

type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return new Date(value as string | Date);
}

function wallet(row: Row): Wallet {
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    currency: String(row.currency),
    balance: Money.from({ amount: String(row.balance_amount), currency: String(row.currency) }),
    version: Number(row.version),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  });
}

function wager(row: Row): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash),
    walletId: String(row.wallet_id),
    playerId: String(row.player_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: String(row.kind) as WagerTransactionKind,
    money: Money.from({ amount: String(row.amount), currency: String(row.currency) }),
    referenceExternalTransactionId: row.reference_external_transaction_id === null
      ? undefined : String(row.reference_external_transaction_id),
    createdAt: date(row.created_at),
    status: String(row.status) as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id === null
      ? undefined : String(row.reference_transaction_id),
    failureCode: row.failure_code === null ? undefined : row.failure_code as never,
    processedAt: row.processed_at === null ? undefined : date(row.processed_at),
    resultBalance: row.result_balance_amount === null ? undefined
      : Money.from({ amount: String(row.result_balance_amount), currency: String(row.result_balance_currency) }),
    resultWalletVersion: row.result_wallet_version === null ? undefined : Number(row.result_wallet_version),
  });
}

class MikroWalletRepository implements WalletRepositoryPort {
  constructor(private readonly sql: SqlTransaction) {}

  async findById(id: string, lock: boolean): Promise<Wallet | undefined> {
    const rows = await this.sql.execute(
      `select id, player_id, currency, balance_amount, version, created_at, updated_at
       from wallets where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? undefined : wallet(rows[0]);
  }

  async findByPlayerCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const rows = await this.sql.execute(
      `select id, player_id, currency, balance_amount, version, created_at, updated_at
       from wallets where player_id = $1 and currency = $2`,
      [playerId, currency],
    );
    return rows[0] === undefined ? undefined : wallet(rows[0]);
  }

  async insert(value: Wallet): Promise<void> {
    await this.sql.execute(
      `insert into wallets
       (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $6)`,
      [value.id, value.playerId, value.currency, value.balance.toString(), value.version, value.createdAt],
    );
  }

  async update(value: Wallet): Promise<void> {
    await this.sql.execute(
      `update wallets set balance_amount = $2, version = $3, updated_at = $4
       where id = $1`,
      [value.id, value.balance.toString(), value.version, value.updatedAt],
    );
  }
}

class MikroWagerRepository implements WagerRepositoryPort {
  constructor(private readonly sql: SqlTransaction) {}

  async insertIfAbsent(record: NewWagerRecord): Promise<string | undefined> {
    const rows = await this.sql.execute<{ id: string }>(
      `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, player_id, wallet_id,
        round_id, game_id, kind, status, amount, currency, reference_external_transaction_id,
        payload_hash, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$11,$12,$13,$14,$14)
       on conflict do nothing returning id`,
      [
        record.id, record.providerId, record.externalTransactionId, record.idempotencyKey,
        record.playerId, record.walletId, record.roundId, record.gameId, record.kind,
        record.amount, record.currency, record.referenceExternalTransactionId ?? null,
        record.payloadHash, record.createdAt,
      ],
    );
    return rows[0]?.id;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    return this.findOne("idempotency_key = $1", [key]);
  }

  async findByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne("provider_id = $1 and external_transaction_id = $2", [providerId, externalTransactionId]);
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne("id = $1", [id]);
  }

  async findReferenceForUpdate(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne(
      "provider_id = $1 and external_transaction_id = $2",
      [providerId, externalTransactionId],
      true,
    );
  }

  async findProcessedReversal(referenceId: string): Promise<WagerTransaction | undefined> {
    return this.findOne(
      `reference_transaction_id = $1 and status = 'PROCESSED'
       and kind in ('REFUND','ROLLBACK')`,
      [referenceId],
    );
  }

  async updateDecision(input: {
    transaction: WagerTransaction;
    snapshot: Money;
    walletVersion: number;
    attempts: number;
    nextAttemptAt: Date | null;
  }): Promise<void> {
    await this.sql.execute(
      `update wager_transactions set status = $2, failure_code = $3,
       reference_transaction_id = $4, result_balance_amount = $5,
       result_balance_currency = $6, result_wallet_version = $7,
       attempts = $8, next_attempt_at = $9, processed_at = $10, updated_at = $10
       where id = $1`,
      [
        input.transaction.id,
        input.transaction.status,
        input.transaction.failureCode ?? null,
        input.transaction.referenceTransactionId ?? null,
        input.snapshot.toString(),
        input.snapshot.currency,
        input.walletVersion,
        input.attempts,
        input.nextAttemptAt,
        input.transaction.processedAt ?? new Date(),
      ],
    );
  }

  private async findOne(where: string, params: readonly unknown[], lock = false): Promise<WagerTransaction | undefined> {
    const rows = await this.sql.execute(
      `select * from wager_transactions where ${where}${lock ? " for update" : ""}`,
      params,
    );
    return rows[0] === undefined ? undefined : wager(rows[0]);
  }
}

class MikroLedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly sql: SqlTransaction) {}

  async insert(entry: import("../../../domain/ledger/wallet-ledger-entry").WalletLedgerEntry): Promise<void> {
    await this.sql.execute(
      `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.id, entry.walletId, entry.transactionId, entry.direction,
        entry.money.toString(), entry.money.currency, entry.balanceBefore.toString(),
        entry.balanceAfter.toString(), entry.createdAt,
      ],
    );
  }
}

class MikroOutboxWriter implements OutboxWriterPort {
  constructor(private readonly sql: SqlTransaction) {}

  async append(event: IntegrationEvent<unknown>): Promise<void> {
    const payload = event.toJSON();
    await this.sql.execute(
      `insert into outbox_messages
       (id, event_id, aggregate_id, event_type, version, payload, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        event.eventId, event.eventId, event.aggregateId, event.eventType,
        event.version, JSON.stringify(payload), event.occurredAt,
      ],
    );
  }
}

export class MikroWageringPortFactory implements WageringPortFactory {
  constructor(private readonly entityManager: EntityManager) {}

  forTransaction(transaction: SqlTransaction): WageringPorts {
    void this.entityManager;
    return {
      wagers: new MikroWagerRepository(transaction),
      wallets: new MikroWalletRepository(transaction),
      ledger: new MikroLedgerRepository(transaction),
      outbox: new MikroOutboxWriter(transaction),
    };
  }
}
