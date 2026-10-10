import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

type Row = Record<string, unknown>;

export interface LedgerCursor {
  readonly createdAt: Date;
  readonly id: string;
}

@Injectable()
export class HttpQueryService {
  constructor(private readonly entityManager: EntityManager) {}

  private async query<T extends Row>(sql: string, params: readonly unknown[]): Promise<T[]> {
    const fork = this.entityManager.fork({ clear: true });
    return fork.getConnection().execute<T[]>(sql, [...params], "all");
  }

  async wallet(id: string): Promise<Row | undefined> {
    const rows = await this.query<Row>(
      `select id, player_id, currency, balance_amount, version
       from wallets where id = ?`,
      [id],
    );
    return rows[0];
  }

  async ping(): Promise<void> {
    const rows = await this.query<{ ready: number }>("select 1 as ready", []);
    if (rows[0]?.ready !== 1) throw new Error("PostgreSQL readiness query returned no result");
  }

  async wager(id: string): Promise<Row | undefined> {
    const rows = await this.query<Row>(
      `select id, provider_id, external_transaction_id, player_id, wallet_id,
              round_id, game_id, kind, status, amount, currency,
              failure_code, result_balance_amount, result_balance_currency,
              result_wallet_version, idempotent_replay
       from wager_transactions where id = ?`,
      [id],
    );
    return rows[0];
  }

  async wagerByProviderExternal(providerId: string, externalId: string): Promise<Row | undefined> {
    const rows = await this.query<Row>(
      `select id, provider_id, external_transaction_id, player_id, wallet_id,
              round_id, game_id, kind, status, amount, currency,
              failure_code, result_balance_amount, result_balance_currency,
              result_wallet_version
       from wager_transactions
       where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalId],
    );
    return rows[0];
  }

  async ledgerPage(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<Row[]> {
    const cursorPredicate = cursor === undefined
      ? ""
      : "and (created_at, id) > (?::timestamptz, ?::uuid)";
    const params = cursor === undefined
      ? [walletId, limit]
      : [walletId, cursor.createdAt, cursor.id, limit];
    return this.query<Row>(
      `select id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before,
              balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? ${cursorPredicate}
        order by created_at, id
        limit ?`,
      params,
    );
  }

  async reconciliation(walletId: string): Promise<Row | undefined> {
    const rows = await this.query<Row>(
      `select w.id, w.currency, w.balance_amount::text as stored_balance,
              coalesce(sum(case when l.direction = 'CREDIT'
                                then l.amount else -l.amount end), 0)::text
                as calculated_balance,
              count(l.id)::text as checked_entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id, w.currency, w.balance_amount`,
      [walletId],
    );
    return rows[0];
  }

  async operationalMetrics(): Promise<{
    statuses: { status: string; count: string }[];
    outboxLagSeconds: string;
  }> {
    const statuses = await this.query<{ status: string; count: string }>(
      `select status, count(*)::text as count
         from wager_transactions
        group by status
        order by status`,
      [],
    );
    const lag = await this.query<{ seconds: string }>(
      `select coalesce(
                extract(epoch from current_timestamp - min(occurred_at)),
                0
              )::text as seconds
         from outbox_messages
        where published_at is null`,
      [],
    );
    const outboxLagSeconds = lag[0]?.seconds;
    if (outboxLagSeconds === undefined) throw new Error("outbox lag query returned no row");
    return { statuses, outboxLagSeconds };
  }
}
