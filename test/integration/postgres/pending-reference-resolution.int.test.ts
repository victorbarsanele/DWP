import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import pg from "pg";
import { CreateWalletUseCase } from "../../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { RandomIdGenerator, SystemClock } from "../../../src/application/services/clock";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction";
import { assertWalletInvariant } from "./helpers/assert-wallet-invariant";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm/mikro-orm.options";
import { MikroTransactionRunner } from "../../../src/infrastructure/persistence/mikro-orm/transaction-runner.adapter";
import { MikroWageringPortFactory } from "../../../src/infrastructure/persistence/mikro-orm/wagering.adapter";

function id(): string {
  return crypto.randomUUID();
}

describe("pending reference resolver with PostgreSQL", () => {
  setDefaultTimeout(30000);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 5000,
  });
  const trackedWallets = new Set<string>();
  let orm: MikroORM;
  let runner: MikroTransactionRunner;
  let ports: MikroWageringPortFactory;
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmOptions());
    runner = new MikroTransactionRunner(orm.em);
    ports = new MikroWageringPortFactory(orm.em);
  });

  afterAll(async () => {
    await pool.end();
    await orm.em.getConnection().getKnex().destroy();
  });

  afterEach(async () => {
    for (const walletId of trackedWallets) {
      await assertWalletInvariant(walletId);
    }
    trackedWallets.clear();
  });

  test("resolves a REFUND after its BET reference arrives", async () => {
    const { walletId, playerId } = await createWallet("100.00");
    const useCase = new ProcessWagerTransactionUseCase(runner, ports, clock, ids, 0);
    const providerId = `provider-${id()}`;
    const referenceExternalId = `external-${id()}`;
    const roundId = `round-${id()}`;
    const pending = await useCase.execute({
      providerId,
      externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`,
      playerId,
      walletId,
      roundId,
      gameId: "game",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: referenceExternalId,
      money: { amount: "10.00", currency: "BRL" },
    });
    expect(pending.status).toBe("PENDING_REFERENCE");
    expect(pending.failureCode).toBe(FailureCode.ReferencePending);

    const bet = await useCase.execute({
      providerId,
      externalTransactionId: referenceExternalId,
      idempotencyKey: `key-${id()}`,
      playerId,
      walletId,
      roundId,
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "10.00", currency: "BRL" },
    });
    expect(bet.status).toBe("PROCESSED");
    await deferOtherPendingReferences(pending.transactionId);
    expect(await useCase.resolveNextPendingReference()).toBe(true);

    const resolved = await pool.query<{
      status: string;
      failure_code: string | null;
      reference_transaction_id: string;
      result_balance_amount: string;
      attempts: number;
    }>(
      `select status, failure_code, reference_transaction_id,
              result_balance_amount::text, attempts
         from wager_transactions where id = $1`,
      [pending.transactionId],
    );
    expect(resolved.rows[0]).toEqual({
      status: "PROCESSED",
      failure_code: null,
      reference_transaction_id: bet.transactionId,
      result_balance_amount: "100.00",
      attempts: 1,
    });
    expect(await useCase.resolveNextPendingReference()).toBe(false);
  });

  test("rejects a missing reference after configured attempt limit", async () => {
    const { walletId, playerId } = await createWallet("50.00");
    const useCase = new ProcessWagerTransactionUseCase(
      runner,
      ports,
      clock,
      ids,
      0,
      1,
    );
    const pending = await useCase.execute({
      providerId: `provider-${id()}`,
      externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: "game",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: `missing-${id()}`,
      money: { amount: "10.00", currency: "BRL" },
    });
    expect(pending.status).toBe("PENDING_REFERENCE");
    await deferOtherPendingReferences(pending.transactionId);
    expect(await useCase.resolveNextPendingReference()).toBe(true);

    const expired = await pool.query<{ status: string; failure_code: string | null; attempts: number }>(
      `select status, failure_code, attempts
         from wager_transactions where id = $1`,
      [pending.transactionId],
    );
    expect(expired.rows[0]).toEqual({
      status: "REJECTED",
      failure_code: FailureCode.ReferenceNotFound,
      attempts: 1,
    });
  });

  async function createWallet(initialBalance: string): Promise<{ walletId: string; playerId: string }> {
    const walletId = id();
    const playerId = id();
    trackedWallets.add(walletId);
    trackedWallets.add(walletId);
    await new CreateWalletUseCase(runner, ports, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: initialBalance, currency: "BRL" },
    });
    return { walletId, playerId };
  }

  async function deferOtherPendingReferences(keepId: string): Promise<void> {
    await pool.query(
      `update wager_transactions
          set next_attempt_at = current_timestamp + interval '1 day'
        where status = 'PENDING_REFERENCE' and id <> $1`,
      [keepId],
    );
  }
});
