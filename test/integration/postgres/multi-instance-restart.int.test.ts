import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import pg from "pg";
import { CreateWalletUseCase } from "../../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { RandomIdGenerator, SystemClock } from "../../../src/application/services/clock";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm/mikro-orm.options";
import { MikroTransactionRunner } from "../../../src/infrastructure/persistence/mikro-orm/transaction-runner.adapter";
import { MikroWageringPortFactory } from "../../../src/infrastructure/persistence/mikro-orm/wagering.adapter";
import { assertWalletInvariant } from "./helpers/assert-wallet-invariant";

interface ProcessorStack {
  readonly orm: MikroORM;
  readonly createWallet: CreateWalletUseCase;
  readonly processWager: ProcessWagerTransactionUseCase;
}

async function createStack(): Promise<ProcessorStack> {
  const orm = await MikroORM.init(mikroOrmOptions());
  const runner = new MikroTransactionRunner(orm.em);
  const ports = new MikroWageringPortFactory(orm.em);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  return {
    orm,
    createWallet: new CreateWalletUseCase(runner, ports, clock, ids),
    processWager: new ProcessWagerTransactionUseCase(runner, ports, clock, ids),
  };
}

function id(): string {
  return crypto.randomUUID();
}

describe("multi-instance wagering and restart with PostgreSQL", () => {
  setDefaultTimeout(90000);
  const database = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  const stacks: ProcessorStack[] = [];
  let activeStacks: ProcessorStack[] = [];
  const closedStacks = new Set<ProcessorStack>();

  beforeAll(async () => {
    for (let index = 0; index < 3; index += 1) stacks.push(await createStack());
    activeStacks = [...stacks];
  });

  afterAll(async () => {
    for (const stack of stacks) {
      if (!closedStacks.has(stack)) await stack.orm.close(true);
    }
    await database.end();
  });

  test("three independent processor instances deduplicate 50 parallel requests and retain invariant after restart", async () => {
    expect(new Set(activeStacks.map((stack) => stack.processWager)).size).toBe(3);
    const playerId = id();
    const walletId = id();
    await activeStacks[0]!.createWallet.execute({
      id: walletId,
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const input = {
      providerId: "multi-instance-test",
      externalTransactionId: id(),
      idempotencyKey: `three-instances-${id()}`,
      playerId,
      walletId,
      roundId: "three-instance-round",
      gameId: "three-instance-game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    };
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      activeStacks[index % activeStacks.length]!.processWager.execute(input),
    ));
    expect(results.every((result) => result.status === "PROCESSED")).toBe(true);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);

    const financialRows = await database.query<{
      balance_amount: string;
      wagers: string;
      debits: string;
    }>(
      `select w.balance_amount::text,
              (select count(*)::text from wager_transactions t
                where t.wallet_id = w.id and t.idempotency_key = $2) as wagers,
              (select count(*)::text from wallet_ledger_entries l
                where l.wallet_id = w.id and l.direction = 'DEBIT') as debits
         from wallets w where w.id = $1`,
      [walletId, input.idempotencyKey],
    );
    expect(financialRows.rows[0]).toEqual({
      balance_amount: "20.00",
      wagers: "1",
      debits: "1",
    });

    const stopped = activeStacks[0]!;
    await stopped.orm.close(true);
    closedStacks.add(stopped);
    const restarted = await createStack();
    stacks.push(restarted);
    activeStacks = [restarted, ...activeStacks.slice(1)];
    const replay = await restarted.processWager.execute(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(results[0]?.transactionId);
    expect(replay.balance?.amount).toBe("20.00");
    await assertWalletInvariant(walletId, "0.00");
  });
});
