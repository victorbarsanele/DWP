import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import pg from "pg";
import { MikroORM } from "@mikro-orm/postgresql";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm/mikro-orm.options";
import { MikroTransactionRunner } from "../../../src/infrastructure/persistence/mikro-orm/transaction-runner.adapter";
import { MikroWageringPortFactory } from "../../../src/infrastructure/persistence/mikro-orm/wagering.adapter";
import { CreateWalletUseCase } from "../../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { InfrastructureTransientError, SqlTransaction } from "../../../src/application/ports/transaction-runner.port";
import { WageringPortFactory } from "../../../src/application/ports/wagering.ports";
import { assertWalletInvariant } from "./helpers/assert-wallet-invariant";
function id(): string {
  return crypto.randomUUID();
}

process.env.DB_LOCK_TIMEOUT_MS ??= "5000";
process.env.DB_TRANSACTION_RETRIES ??= "1";
process.env.DB_TRANSACTION_RETRY_BACKOFF_MS ??= "1";
process.env.DB_POOL_MAX ??= "20";


class TestClock {
  now(): Date { return new Date(); }
}

class TestIds {
  next(): string { return id(); }
}

describe("wagering application with PostgreSQL", () => {
  setDefaultTimeout(30000);
  const trackedWallets = new Set<string>();
  const trackWallet = (walletId: string): string => {
    trackedWallets.add(walletId);
    return walletId;
  };
  let orm: MikroORM;
  const inspectionPool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? "******127.0.0.1:55432/spike_test",
    max: 10,
    connectionTimeoutMillis: 5000,
  });
  /*
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://spike:spike@127.0.0.1:55432/spike_test",
    max: 1,
  });
  */

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmOptions());
  });

  afterAll(async () => {
    await orm.em.getConnection().getKnex().destroy();
    await inspectionPool.end();
  });

  afterEach(async () => {
    for (const walletId of trackedWallets) {
      await assertWalletInvariant(walletId);
    }
    trackedWallets.clear();
  });

  test("creates wallet with atomic opening and processes BET", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();

    const walletResult = await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(walletResult.balance.amount).toBe("100.00");

    const result = await new ProcessWagerTransactionUseCase(
      runner,
      factory,
      clock,
      ids,
    ).execute({
      providerId: `provider-${id()}`,
      externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.balance.amount).toBe("20.00");
    expect(result.walletVersion).toBe(2);

    const rows = (await inspectionPool.query<Record<string, unknown>>(
      `select w.balance_amount, w.version,
              (select count(*) from wallet_ledger_entries l where l.wallet_id = w.id) as ledger_count,
              (select count(*) from outbox_messages o where o.aggregate_id = w.id) as outbox_count
       from wallets w where w.id = $1`,
      [walletId],
    )).rows;
    expect(rows[0].balance_amount).toBe("20.00");
    expect(Number(rows[0].version)).toBe(2);
    expect(Number(rows[0].ledger_count)).toBe(2);
    expect(Number(rows[0].outbox_count)).toBe(4);
  });

  test("commits business rejection and replays original snapshot", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "50.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const input = {
      providerId: `provider-${id()}`,
      externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
      kind: WagerTransactionKind.Bet,
      money: { amount: "10.00", currency: "BRL" },
    };
    const first = await process.execute(input);
    expect(first.status).toBe("PROCESSED");
    expect(first.balance.amount).toBe("40.00");

    const rejected = await process.execute({
      ...input,
      idempotencyKey: `key-${id()}`,
      externalTransactionId: `external-${id()}`,
      playerId: id(),
    });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.failureCode).toBe(FailureCode.PlayerWalletMismatch);

    const second = await process.execute({
      ...input,
      idempotencyKey: `key-${id()}`,
      externalTransactionId: `external-${id()}`,
      money: { amount: "5.00", currency: "BRL" },
    });
    expect(second.status).toBe("PROCESSED");
    expect(second.balance.amount).toBe("35.00");

    const replay = await process.execute(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe("40.00");

    const rows = (await inspectionPool.query<Record<string, unknown>>(
      `select count(*) filter (where status = 'REJECTED') as rejected,
              count(*) filter (where status = 'PROCESSED') as processed
       from wager_transactions where wallet_id = $1`,
      [walletId],
    )).rows;
    expect(Number(rows[0].rejected)).toBe(1);
    expect(Number(rows[0].processed)).toBe(3);
  });

  test("serializes concurrent bets on one wallet", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const submit = (suffix: string) => process.execute({
      providerId: `provider-${id()}`,
      externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${suffix}-${id()}`,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    });
    const results = await Promise.all([submit("a"), submit("b")]);
    expect(results.filter((result) => result.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((result) => result.status === "REJECTED")).toHaveLength(1);
    const rows = (await inspectionPool.query<{ balance_amount: string; ledger_count: string }>(
      `select w.balance_amount,
              (select count(*) from wallet_ledger_entries l where l.wallet_id = w.id) as ledger_count
       from wallets w where w.id = $1`,
      [walletId],
    )).rows;
    expect(rows[0].balance_amount).toBe("20.00");
    expect(Number(rows[0].ledger_count)).toBe(2);
  });

  test("processes WIN and LOSS references with correct ledger effects", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const providerId = `provider-${id()}`;
    const base = {
      providerId,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
    };
    const bet = await process.execute({
      ...base,
      externalTransactionId: `bet-${id()}`,
      idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "BRL" },
    });
    expect(bet.status).toBe("PROCESSED");
    const betExternal = (await inspectionPool.query<{ external_transaction_id: string }>(
      `select external_transaction_id from wager_transactions where id = $1`,
      [bet.transactionId],
    )).rows[0].external_transaction_id;

    const win = await process.execute({
      ...base,
      externalTransactionId: `win-${id()}`,
      idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: betExternal,
    });
    expect(win.status).toBe("PROCESSED");
    expect(win.balance.amount).toBe("130.00");

    const loss = await process.execute({
      ...base,
      externalTransactionId: `loss-${id()}`,
      idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Loss,
      money: { amount: "1.00", currency: "BRL" },
      referenceExternalTransactionId: betExternal,
    });
    expect(loss.status).toBe("PROCESSED");
    expect(loss.balance.amount).toBe("130.00");
    expect(loss.walletVersion).toBe(win.walletVersion);

    const rows = (await inspectionPool.query<{ ledger_count: string; balance_amount: string }>(
      `select (select count(*) from wallet_ledger_entries where wallet_id = $1) as ledger_count,
              balance_amount from wallets where id = $1`,
      [walletId],
    )).rows;
    expect(Number(rows[0].ledger_count)).toBe(3);
    expect(rows[0].balance_amount).toBe("130.00");
  });

  test("processes REFUND and ROLLBACK in reference direction", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const providerId = `provider-${id()}`;
    const base = {
      providerId,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
    };
    const betExternal = `bet-${id()}`;
    const bet = await process.execute({
      ...base,
      externalTransactionId: betExternal,
      idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "BRL" },
    });
    expect(bet.status).toBe("PROCESSED");

    const refund = await process.execute({
      ...base,
      externalTransactionId: `refund-${id()}`,
      idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Refund,
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId: betExternal,
    });
    expect(refund.status).toBe("PROCESSED");
    expect(refund.balance.amount).toBe("100.00");

    const refundExternal = (await inspectionPool.query<{ external_transaction_id: string }>(
      `select external_transaction_id from wager_transactions where id = $1`,
      [refund.transactionId],
    )).rows[0].external_transaction_id;
    const rollback = await process.execute({
      ...base,
      externalTransactionId: `rollback-refund-${id()}`,
      idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Rollback,
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId: refundExternal,
    });
    expect(rollback.status).toBe("PROCESSED");
    expect(rollback.balance.amount).toBe("80.00");
  });

  test("rejects rollback that would make balance negative", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const providerId = `provider-${id()}`;
    const base = {
      providerId,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
    };
    const bet = await process.execute({
      ...base, externalTransactionId: `bet-${id()}`, idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
    });
    const winExternal = `win-${id()}`;
    const win = await process.execute({
      ...base, externalTransactionId: winExternal, idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Win, money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: (await inspectionPool.query<{ external_transaction_id: string }>(
        `select external_transaction_id from wager_transactions where id = $1`,
        [bet.transactionId],
      )).rows[0].external_transaction_id,
    });
    expect(win.status).toBe("PROCESSED");
    const spend = await process.execute({
      ...base, externalTransactionId: `spend-${id()}`, idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
    });
    expect(spend.status).toBe("PROCESSED");
    const rollback = await process.execute({
      ...base, externalTransactionId: `rollback-${id()}`, idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Rollback, money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: winExternal,
    });
    expect(rollback.status).toBe("REJECTED");
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
  });

  test("deduplicates identical concurrent submissions", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const input = {
      providerId: `provider-${id()}`,
      externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
      kind: WagerTransactionKind.Bet,
      money: { amount: "10.00", currency: "BRL" },
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, () => process.execute(input)),
    );
    expect(results.filter((result) => result.status === "PROCESSED")).toHaveLength(50);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);
    const rows = (await inspectionPool.query<{ balance_amount: string; ledger_count: string }>(
      `select w.balance_amount,
              (select count(*) from wallet_ledger_entries where wallet_id = w.id) as ledger_count
       from wallets w where w.id = $1`,
      [walletId],
    )).rows;
    expect(rows[0].balance_amount).toBe("90.00");
    expect(Number(rows[0].ledger_count)).toBe(2);
  });

  test("persists PENDING_REFERENCE with backoff snapshot", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const result = await process.execute({
      providerId: `provider-${id()}`,
      externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`,
      playerId,
      walletId,
      roundId: `round-${id()}`,
      gameId: `game-${id()}`,
      kind: WagerTransactionKind.Rollback,
      money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: `missing-${id()}`,
    });
    expect(result.status).toBe("PENDING_REFERENCE");
    expect(result.failureCode).toBe(FailureCode.ReferencePending);
    const rows = (await inspectionPool.query<{ attempts: number; next_attempt_at: Date | null }>(
      `select attempts, next_attempt_at from wager_transactions where id = $1`,
      [result.transactionId],
    )).rows;
    expect(Number(rows[0].attempts)).toBe(0);
    expect(rows[0].next_attempt_at).not.toBeNull();
  });

  test("processes 50 of 100 bets with bounded parallelism", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId, playerId, initialBalance: { amount: "500.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const inputs = Array.from({ length: 100 }, () => ({
      providerId: `provider-${id()}`, externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`, playerId, walletId,
      roundId: `round-${id()}`, gameId: `game-${id()}`,
      kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
    }));
    const submitWithRedelivery = async (input: (typeof inputs)[number]) => {
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        try {
          return await process.execute(input);
        } catch (error) {
          if (!(error instanceof InfrastructureTransientError) || attempt === 20) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, attempt));
        }
      }
      throw new Error("unreachable");
    };
    const results = [];
    for (let offset = 0; offset < inputs.length; offset += 2) {
      results.push(...await Promise.all(
        inputs.slice(offset, offset + 2).map(submitWithRedelivery),
      ));
    }
    expect(results.filter((result) => result.status === "PROCESSED")).toHaveLength(50);
    expect(results.filter((result) => result.status === "REJECTED")).toHaveLength(50);
    const rows = (await inspectionPool.query<{ balance_amount: string; ledger_count: string }>(
      `select w.balance_amount,
              (select count(*) from wallet_ledger_entries where wallet_id = w.id) as ledger_count
       from wallets w where w.id = $1`, [walletId],
    )).rows;
    expect(rows[0].balance_amount).toBe("0.00");
    expect(Number(rows[0].ledger_count)).toBe(51);
  });

  test("processes concurrent bets on distinct wallets", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const inputs = [];
    for (let index = 0; index < 10; index += 1) {
      const walletId = trackWallet(id());
      const playerId = id();
      await new CreateWalletUseCase(runner, factory, clock, ids).execute({
        id: walletId, playerId, initialBalance: { amount: "20.00", currency: "BRL" },
      });
      inputs.push({
        providerId: `provider-${id()}`, externalTransactionId: `external-${id()}`,
        idempotencyKey: `key-${id()}`, playerId, walletId,
        roundId: `round-${id()}`, gameId: `game-${id()}`,
        kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
      });
    }
    const results = await Promise.all(inputs.map((input) => process.execute(input)));
    expect(results.every((result) => result.status === "PROCESSED")).toBe(true);
    expect(results.every((result) => result.balance.amount === "10.00")).toBe(true);
  });

  test("serializes concurrent REFUND and ROLLBACK", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId, playerId, initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const providerId = `provider-${id()}`;
    const reference = `bet-${id()}`;
    const base = { providerId, playerId, walletId, roundId: `round-${id()}`, gameId: `game-${id()}` };
    const bet = await process.execute({
      ...base, externalTransactionId: reference, idempotencyKey: `key-${id()}`,
      kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
    });
    expect(bet.status).toBe("PROCESSED");
    const results = await Promise.all([
      process.execute({
        ...base, externalTransactionId: `refund-${id()}`, idempotencyKey: `key-${id()}`,
        kind: WagerTransactionKind.Refund, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: reference,
      }),
      process.execute({
        ...base, externalTransactionId: `rollback-${id()}`, idempotencyKey: `key-${id()}`,
        kind: WagerTransactionKind.Rollback, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: reference,
      }),
    ]);
    expect(results.filter((result) => result.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((result) => result.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(1);
  });

  test("creates zero-balance wallet without OPENING and rejects duplicate identity", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    const create = new CreateWalletUseCase(runner, factory, clock, ids);
    const result = await create.execute({
      id: walletId, playerId, initialBalance: { amount: "0.00", currency: "BRL" },
    });
    expect(result.balance.amount).toBe("0.00");
    const counts = (await inspectionPool.query<{ ledger_count: string; outbox_count: string }>(
      `select
         (select count(*) from wallet_ledger_entries where wallet_id = $1) as ledger_count,
         (select count(*) from outbox_messages where aggregate_id = $1) as outbox_count`,
      [walletId],
    )).rows[0];
    expect(Number(counts.ledger_count)).toBe(0);
    expect(Number(counts.outbox_count)).toBe(0);
    await expect(create.execute({
      id: id(), playerId, initialBalance: { amount: "1.00", currency: "BRL" },
    })).rejects.toThrow(FailureCode.WalletAlreadyExists);
  });

  test("rolls back wager, ledger and outbox on transient outbox failure", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId, playerId, initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const failingFactory: WageringPortFactory = {
      forTransaction: (transaction) => {
        const ports = factory.forTransaction(transaction);
        return {
          ...ports,
          outbox: {
            append: async (_event) => {
              throw new InfrastructureTransientError("outbox unavailable");
            },
          },
        };
      },
    };
    const nativeRunner = {
      run: async <T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> => {
        const client = await inspectionPool.connect();
        try {
          await client.query("begin");
          const result = await work({
            execute: async <R extends Record<string, unknown>>(
              sql: string,
              params: readonly unknown[] = [],
            ) => (await client.query(sql, [...params])).rows as R[],
          });
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const process = new ProcessWagerTransactionUseCase(nativeRunner, failingFactory, clock, ids);
    const input = {
      providerId: `provider-${id()}`, externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`, playerId, walletId,
      roundId: `round-${id()}`, gameId: `game-${id()}`,
      kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
    };
    await expect(process.execute(input)).rejects.toBeInstanceOf(InfrastructureTransientError);
    const rows = (await inspectionPool.query<{
      balance_amount: string; wagers: string; ledger: string; outbox: string;
    }>(
      `select w.balance_amount,
              (select count(*) from wager_transactions where wallet_id = w.id) as wagers,
              (select count(*) from wallet_ledger_entries where wallet_id = w.id) as ledger,
              (select count(*) from outbox_messages where aggregate_id = w.id) as outbox
       from wallets w where w.id = $1`, [walletId],
    )).rows[0];
    expect(rows.balance_amount).toBe("100.00");
    expect(Number(rows.wagers)).toBe(1);
    expect(Number(rows.ledger)).toBe(1);
    expect(Number(rows.outbox)).toBe(2);
  });

  test("returns idempotency payload and external identity conflicts without aborting", async () => {
    const clock = new TestClock();
    const ids = new TestIds();
    const runner = new MikroTransactionRunner(orm.em);
    const factory = new MikroWageringPortFactory(orm.em);
    const walletId = trackWallet(id());
    const playerId = id();
    await new CreateWalletUseCase(runner, factory, clock, ids).execute({
      id: walletId, playerId, initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const process = new ProcessWagerTransactionUseCase(runner, factory, clock, ids);
    const base = {
      providerId: `provider-${id()}`, externalTransactionId: `external-${id()}`,
      idempotencyKey: `key-${id()}`, playerId, walletId,
      roundId: `round-${id()}`, gameId: `game-${id()}`,
      kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
    };
    expect((await process.execute(base)).status).toBe("PROCESSED");
    const mismatch = await process.execute({
      ...base, money: { amount: "11.00", currency: "BRL" },
    });
    expect(mismatch.failureCode).toBe(FailureCode.IdempotencyKeyPayloadMismatch);
    const externalConflict = await process.execute({
      ...base, idempotencyKey: `key-${id()}`, money: { amount: "10.00", currency: "BRL" },
    });
    expect(externalConflict.failureCode).toBe(FailureCode.ExternalTransactionIdConflict);
    const valid = await process.execute({
      ...base, idempotencyKey: `key-${id()}`, externalTransactionId: `external-${id()}`,
      money: { amount: "5.00", currency: "BRL" },
    });
    expect(valid.status).toBe("PROCESSED");
  });
});
