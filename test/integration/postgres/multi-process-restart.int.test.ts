import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import pg from "pg";
import { resolve } from "node:path";

interface ProcessorProcess {
  readonly port: number;
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly stderr: Promise<string>;
}

interface WalletResponse {
  readonly id: string;
  readonly balance: { readonly amount: string; readonly currency: string };
}

interface WagerResponse {
  readonly transactionId: string;
  readonly status: string;
  readonly idempotentReplay: boolean;
}

function id(): string {
  return crypto.randomUUID();
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine an available TCP port");
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
  return address.port;
}

function launchProcessor(port: number): ProcessorProcess {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.NODE_ENV = "test";
  env.PORT = String(port);

  const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  return {
    port,
    child,
    stderr: new Response(child.stderr).text(),
  };
}

async function stopProcessor(processor: ProcessorProcess): Promise<void> {
  if (processor.child.exitCode === null) {
    processor.child.kill("SIGTERM");
    await Promise.race([processor.child.exited, Bun.sleep(5000)]);
    if (processor.child.exitCode === null) {
      processor.child.kill("SIGKILL");
      await processor.child.exited;
    }
  }
}

async function waitUntilReady(processor: ProcessorProcess): Promise<void> {
  const deadline = Date.now() + 45000;
  let lastFailure = "readiness endpoint did not respond";
  while (Date.now() < deadline) {
    if (processor.child.exitCode !== null) {
      throw new Error(
        `Processor exited with code ${processor.child.exitCode}: ${await processor.stderr}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${processor.port}/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
      lastFailure = `readiness returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = String(error);
    }
    await Bun.sleep(100);
  }
  await stopProcessor(processor);
  throw new Error(`Processor did not become ready: ${lastFailure}; ${await processor.stderr}`);
}

describe("multi-process wagering and restart with PostgreSQL", () => {
  setDefaultTimeout(90000);
  const database = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  const processors: ProcessorProcess[] = [];

  beforeAll(async () => {
    for (let index = 0; index < 3; index += 1) {
      const processor = launchProcessor(await availablePort());
      processors.push(processor);
      await waitUntilReady(processor);
    }
  });

  afterAll(async () => {
    await Promise.all(processors.map(stopProcessor));
    await database.end();
  });

  test("three Bun processes deduplicate 50 parallel requests and replay after process restart", async () => {
    expect(new Set(processors.map((processor) => processor.child.pid)).size).toBe(3);
    const playerId = id();
    const walletResponse = await fetch(`http://127.0.0.1:${processors[0]!.port}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(walletResponse.status).toBe(201);
    const wallet = await walletResponse.json() as WalletResponse;

    const idempotencyKey = `three-processes-${id()}`;
    const input = {
      providerId: "multi-process-test",
      externalTransactionId: id(),
      playerId,
      walletId: wallet.id,
      roundId: "three-process-round",
      gameId: "three-process-game",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    };
    const results = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const processor = processors[index % processors.length]!;
      const response = await fetch(
        `http://127.0.0.1:${processor.port}/wagering/transactions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(input),
        },
      );
      expect([200, 201]).toContain(response.status);
      return await response.json() as WagerResponse;
    }));
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
      [wallet.id, idempotencyKey],
    );
    expect(financialRows.rows[0]).toEqual({
      balance_amount: "20.00",
      wagers: "1",
      debits: "1",
    });

    const stopped = processors[0]!;
    await stopProcessor(stopped);
    const restarted = launchProcessor(stopped.port);
    processors[0] = restarted;
    await waitUntilReady(restarted);

    const replayResponse = await fetch(
      `http://127.0.0.1:${restarted.port}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as WagerResponse;
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(results[0]?.transactionId);
    expect(wallet.balance.amount).toBe("100.00");
  });
});
