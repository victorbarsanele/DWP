import "reflect-metadata";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "bun:test";
import Decimal from "decimal.js";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm/mikro-orm.options";
import {
  WalletSchema,
  type WalletRow,
} from "../../../src/infrastructure/persistence/mikro-orm/schemas/schemas";
import { id, pool } from "./helpers/database";

@Injectable()
class LockProbeService {
  constructor(private readonly entityManager: EntityManager) {}

  async debit(walletId: string, amount: string): Promise<boolean> {
    const fork = this.entityManager.fork({ clear: true });
    return fork.transactional(async (transactionManager) => {
      const wallet = await transactionManager.findOne(WalletSchema, walletId, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      if (wallet === null) throw new Error("wallet missing");
      const balance = new Decimal(wallet.balanceAmount);
      if (balance.lessThan(amount)) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
      wallet.balanceAmount = balance.minus(amount).toFixed(2);
      await transactionManager.flush();
      return true;
    });
  }
}

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmOptions())],
  providers: [LockProbeService],
})
class LockProbeModule {}

describe("Nest DI and pessimistic wallet lock", () => {
  it("uses constructor DI, fork, transaction and FOR UPDATE", async () => {
    const walletId = id();
    const playerId = id();
    await pool.query(
      `insert into wallets (id, player_id, currency, balance_amount, version)
       values ($1, $2, 'BRL', '100.00', 1)`,
      [walletId, playerId],
    );
    const testingModule = await Test.createTestingModule({
      imports: [LockProbeModule],
    }).compile();
    const service = testingModule.get(LockProbeService);
    const applied = await Promise.all([
      service.debit(walletId, "80.00"),
      service.debit(walletId, "80.00"),
    ]);
    const result = await pool.query<{ balance_amount: string }>(
      "select balance_amount::text from wallets where id = $1",
      [walletId],
    );
    expect(applied.filter(Boolean)).toHaveLength(1);
    expect(result.rows[0]?.balance_amount).toBe("20.00");
    await testingModule.close();
  });
});
