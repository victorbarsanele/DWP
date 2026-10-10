import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

type Row = Record<string, unknown>;

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
}
