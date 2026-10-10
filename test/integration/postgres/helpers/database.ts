import pg from "pg";
import { expect } from "bun:test";

export const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL
    ?? "postgresql://spike:spike@127.0.0.1:55432/spike_test",
  max: 10,
});

let poolClosed = false;
process.once("beforeExit", async () => {
  if (!poolClosed) {
    poolClosed = true;
    await pool.end();
  }
});

export function id(): string {
  return crypto.randomUUID();
}

export async function expectPostgresError(
  operation: () => Promise<unknown>,
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  try {
    await operation();
    throw new Error("Expected PostgreSQL operation to fail");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const postgresError = error as Error & {
      code?: string;
      constraint?: string;
    };
    expect(postgresError.code).toBe(expected.code);
    if (expected.constraint !== undefined) {
      expect(postgresError.constraint).toBe(expected.constraint);
    }
    if (expected.message !== undefined) {
      expect(postgresError.message).toContain(expected.message);
    }
  }
}

export async function insertWallet(
  walletId = id(),
  balance = "100.00",
  currency = "BRL",
): Promise<{ walletId: string; playerId: string }> {
  const playerId = id();
  await pool.query(
    `insert into wallets
      (id, player_id, currency, balance_amount, version)
     values ($1, $2, $3, $4, 1)`,
    [walletId, playerId, currency, balance],
  );
  return { walletId, playerId };
}

export async function insertWager(
  walletId: string,
  playerId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const values = {
    id: id(),
    providerId: `provider-${id()}`,
    externalId: `external-${id()}`,
    idempotencyKey: `key-${id()}`,
    roundId: "round-test",
    gameId: "game-test",
    kind: "BET",
    status: "PENDING",
    amount: "10.00",
    currency: "BRL",
    referenceExternalId: null,
    referenceId: null,
    payloadHash: "a".repeat(64),
    failureCode: null,
    attempts: 0,
    nextAttemptAt: null,
    snapshotAmount: null,
    snapshotCurrency: null,
    snapshotVersion: null,
    processedAt: null,
    ...overrides,
  };
  await pool.query(
    `insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key,
       player_id, wallet_id, round_id, game_id, kind, status, amount, currency,
       reference_external_transaction_id, reference_transaction_id, payload_hash,
       failure_code, attempts, next_attempt_at, result_balance_amount,
       result_balance_currency, result_wallet_version, processed_at)
     values
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21, $22)`,
    [
      values.id,
      values.providerId,
      values.externalId,
      values.idempotencyKey,
      playerId,
      walletId,
      values.roundId,
      values.gameId,
      values.kind,
      values.status,
      values.amount,
      values.currency,
      values.referenceExternalId,
      values.referenceId,
      values.payloadHash,
      values.failureCode,
      values.attempts,
      values.nextAttemptAt,
      values.snapshotAmount,
      values.snapshotCurrency,
      values.snapshotVersion,
      values.processedAt,
    ],
  );
  return values.id;
}

export async function assertWalletInvariant(
  walletId: string,
  databasePool: pg.Pool = pool,
): Promise<void> {
  const walletResult = await databasePool.query<{ balance_amount: string }>(
    "select balance_amount::text from wallets where id = $1",
    [walletId],
  );
  expect(walletResult.rows).toHaveLength(1);

  const ledgerResult = await databasePool.query<{
    transaction_id: string;
    balance_before: string;
    balance_after: string;
  }>(
    `select transaction_id, balance_before::text, balance_after::text
       from wallet_ledger_entries
      where wallet_id = $1
      order by created_at, id`,
    [walletId],
  );
  const transactionIds = ledgerResult.rows.map((row) => row.transaction_id);
  expect(new Set(transactionIds).size).toBe(transactionIds.length);

  if (ledgerResult.rows.length > 0) {
    expect(ledgerResult.rows[0]?.balance_before).toBe("0.00");
    for (let index = 1; index < ledgerResult.rows.length; index += 1) {
      expect(ledgerResult.rows[index]?.balance_before)
        .toBe(ledgerResult.rows[index - 1]?.balance_after);
    }
    expect(ledgerResult.rows.at(-1)?.balance_after)
      .toBe(walletResult.rows[0]?.balance_amount);
  } else {
    expect(walletResult.rows[0]?.balance_amount).toBe("0.00");
  }
}
