import { afterAll, describe, expect, it } from "bun:test";
import {
  expectPostgresError,
  id,
  insertWallet,
  insertWager,
  pool,
} from "./helpers/database";

describe("PostgreSQL schema guarantees", () => {
  it("accepts valid rows in every table", async () => {
    const { walletId, playerId } = await insertWallet();
    const transactionId = await insertWager(walletId, playerId, {
      status: "PROCESSED",
      snapshotAmount: "90.00",
      snapshotCurrency: "BRL",
      snapshotVersion: 2,
      processedAt: new Date(),
    });
    await pool.query(
      `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency,
         balance_before, balance_after)
       values ($1, $2, $3, 'CREDIT', '10.00', 'BRL', '80.00', '90.00')`,
      [id(), walletId, transactionId],
    );
    const consumerName = `consumer-${id()}`;
    const messageId = `message-${id()}`;
    await pool.query(
      `insert into inbox_messages (consumer_name, message_id, payload_hash)
       values ($1, $2, $3)`,
      [consumerName, messageId, "b".repeat(64)],
    );
    await pool.query(
      `insert into outbox_messages
        (id, event_id, aggregate_id, event_type, version, payload, occurred_at)
       values ($1, $2, $3, 'TestEvent', 1, '{}', current_timestamp)`,
      [id(), id(), walletId],
    );
  });

  it("rounds numeric(19,2), leaving scale validation to Money.from", async () => {
    const walletId = id();
    const playerId = id();
    await pool.query(
      `insert into wallets (id, player_id, currency, balance_amount, version)
       values ($1, $2, 'BRL', '1.999', 1)`,
      [walletId, playerId],
    );
    const result = await pool.query<{ balance: string }>(
      "select balance_amount::text as balance from wallets where id = $1",
      [walletId],
    );
    expect(result.rows[0]?.balance).toBe("2.00");
  });

  it("enforces wallet identity, balance, version and currency", async () => {
    const playerId = id();
    await expectPostgresError(
      () => pool.query(
        `insert into wallets (id, player_id, currency, balance_amount, version)
         values ($1, $2, 'BRL', '-0.01', 1)`,
        [id(), playerId],
      ),
      { code: "23514", constraint: "wallets_balance_non_negative" },
    );
    await expectPostgresError(
      () => pool.query(
        `insert into wallets (id, player_id, currency, balance_amount, version)
         values ($1, $2, 'BRL', '1.00', 0)`,
        [id(), id()],
      ),
      { code: "23514", constraint: "wallets_version_positive" },
    );
    await expectPostgresError(
      () => pool.query(
        `insert into wallets (id, player_id, currency, balance_amount, version)
         values ($1, $2, 'brl', '1.00', 1)`,
        [id(), id()],
      ),
      { code: "23514", constraint: "wallets_currency_iso" },
    );
    await insertWallet(id(), "1.00", "BRL");
    const duplicate = await insertWallet(id(), "2.00", "BRL");
    await expectPostgresError(
      () => pool.query(
        `insert into wallets (id, player_id, currency, balance_amount, version)
         values ($1, $2, 'BRL', '2.00', 1)`,
        [id(), duplicate.playerId],
      ),
      { code: "23505", constraint: "wallets_player_currency_unique" },
    );
  });

  it("enforces wager kind, status, amount, attempts, currency and references", async () => {
    const { walletId, playerId } = await insertWallet();
    const cases: Array<{
      overrides: Record<string, unknown>;
      constraint: string;
    }> = [
      { overrides: { kind: "INVALID" }, constraint: "wager_kind_valid" },
      { overrides: { status: "INVALID" }, constraint: "wager_status_valid" },
      { overrides: { amount: "0.00" }, constraint: "wager_amount_positive" },
      { overrides: { attempts: -1 }, constraint: "wager_attempts_non_negative" },
      { overrides: { currency: "brl" }, constraint: "wager_currency_iso" },
      {
        overrides: { kind: "REFUND" },
        constraint: "wager_reference_required",
      },
      {
        overrides: {
          kind: "OPENING",
          referenceExternalId: "forbidden",
        },
        constraint: "wager_reference_forbidden_for_opening",
      },
    ];
    for (const testCase of cases) {
      await expectPostgresError(
        () => insertWager(walletId, playerId, testCase.overrides),
        { code: "23514", constraint: testCase.constraint },
      );
    }
  });

  it("enforces snapshot and failure/status coherence", async () => {
    const { walletId, playerId } = await insertWallet();
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        status: "PENDING_REFERENCE",
        referenceExternalId: "missing",
        snapshotAmount: "90.00",
      }),
      { code: "23514", constraint: "wager_snapshot_all_or_none" },
    );
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        status: "PENDING_REFERENCE",
        referenceExternalId: "missing",
      }),
      { code: "23514", constraint: "wager_status_snapshot_coherence" },
    );
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        status: "REJECTED",
        failureCode: null,
        snapshotAmount: "90.00",
        snapshotCurrency: "BRL",
        snapshotVersion: 1,
      }),
      { code: "23514", constraint: "wager_status_failure_coherence" },
    );
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        status: "PROCESSED",
        failureCode: "BAD",
        snapshotAmount: "90.00",
        snapshotCurrency: "BRL",
        snapshotVersion: 1,
      }),
      { code: "23514", constraint: "wager_status_failure_coherence" },
    );
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        status: "PENDING_REFERENCE",
        referenceExternalId: "missing",
        snapshotAmount: "90.00",
        snapshotCurrency: "brl",
        snapshotVersion: 1,
      }),
      { code: "23514", constraint: "wager_snapshot_currency_iso" },
    );
    await insertWager(walletId, playerId, {
      status: "FAILED",
      failureCode: "PERMANENT_INFRASTRUCTURE_FAILURE",
    });
  });

  it("allows pending resolution snapshot replacement and blocks other changes", async () => {
    const { walletId, playerId } = await insertWallet();
    const betId = await insertWager(walletId, playerId, {
      status: "PROCESSED",
      snapshotAmount: "90.00",
      snapshotCurrency: "BRL",
      snapshotVersion: 2,
      processedAt: new Date(),
    });
    const pendingId = await insertWager(walletId, playerId, {
      kind: "REFUND",
      status: "PENDING_REFERENCE",
      referenceExternalId: "bet-external",
      snapshotAmount: "90.00",
      snapshotCurrency: "BRL",
      snapshotVersion: 2,
    });
    await expectPostgresError(
      () => pool.query(
        `update wager_transactions
         set result_balance_amount = '80.00'
         where id = $1`,
        [pendingId],
      ),
      { code: "55000", message: "pending wager result snapshot is immutable" },
    );
    await pool.query(
      `update wager_transactions
       set status = 'PROCESSED',
           reference_transaction_id = $2,
           result_balance_amount = '100.00',
           result_balance_currency = 'BRL',
           result_wallet_version = 3,
           processed_at = current_timestamp
       where id = $1`,
      [pendingId, betId],
    );
    await expectPostgresError(
      () => pool.query(
        `update wager_transactions set game_id = 'changed' where id = $1`,
        [pendingId],
      ),
      { code: "55000", message: "terminal wager transaction is immutable" },
    );
    await expectPostgresError(
      () => pool.query("delete from wager_transactions where id = $1", [pendingId]),
      { code: "55000", message: "wager transactions are immutable" },
    );
  });

  it("enforces one processed reversal while allowing rejected plus processed", async () => {
    const { walletId, playerId } = await insertWallet();
    const betId = await insertWager(walletId, playerId, {
      status: "PROCESSED",
      snapshotAmount: "90.00",
      snapshotCurrency: "BRL",
      snapshotVersion: 2,
      processedAt: new Date(),
    });
    await insertWager(walletId, playerId, {
      kind: "REFUND",
      status: "REJECTED",
      referenceExternalId: "bet-ref",
      referenceId: betId,
      failureCode: "REFERENCE_AMOUNT_MISMATCH",
      snapshotAmount: "90.00",
      snapshotCurrency: "BRL",
      snapshotVersion: 2,
    });
    await insertWager(walletId, playerId, {
      kind: "REFUND",
      status: "PROCESSED",
      referenceExternalId: "bet-ref",
      referenceId: betId,
      snapshotAmount: "100.00",
      snapshotCurrency: "BRL",
      snapshotVersion: 3,
      processedAt: new Date(),
    });
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        kind: "ROLLBACK",
        status: "PROCESSED",
        referenceExternalId: "bet-ref",
        referenceId: betId,
        snapshotAmount: "90.00",
        snapshotCurrency: "BRL",
        snapshotVersion: 4,
        processedAt: new Date(),
      }),
      { code: "23505", constraint: "wager_one_processed_reversal_per_reference_idx" },
    );
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        kind: "REFUND",
        status: "PROCESSED",
        referenceExternalId: "no-internal-ref",
        snapshotAmount: "100.00",
        snapshotCurrency: "BRL",
        snapshotVersion: 3,
        processedAt: new Date(),
      }),
      { code: "23514", constraint: "wager_processed_reversal_has_reference" },
    );
    await expectPostgresError(
      () => insertWager(walletId, playerId, {
        kind: "ROLLBACK",
        status: "PROCESSED",
        referenceExternalId: "no-internal-ref-rollback",
        snapshotAmount: "100.00",
        snapshotCurrency: "BRL",
        snapshotVersion: 3,
        processedAt: new Date(),
      }),
      { code: "23514", constraint: "wager_processed_reversal_has_reference" },
    );
  });

  it("enforces wallet and transaction foreign keys", async () => {
    await expectPostgresError(
      () => pool.query(
        `insert into wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, player_id,
           wallet_id, round_id, game_id, kind, status, amount, currency, payload_hash)
         values ($1, 'p', $2, $3, $4, $5, 'r', 'g', 'BET', 'PENDING', '1.00',
           'BRL', $6)`,
        [id(), `e-${id()}`, `k-${id()}`, id(), id(), "c".repeat(64)],
      ),
      { code: "23503", constraint: "wager_wallet_fk" },
    );
    const { walletId } = await insertWallet();
    await expectPostgresError(
      () => pool.query(
        `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency,
           balance_before, balance_after)
         values ($1, $2, $3, 'CREDIT', '1.00', 'BRL', '0.00', '1.00')`,
        [id(), walletId, id()],
      ),
      { code: "23503", constraint: "ledger_transaction_fk" },
    );
  });

  it("enforces ledger direction, amounts, balances, currency and uniqueness", async () => {
    const { walletId, playerId } = await insertWallet();
    const transactionId = await insertWager(walletId, playerId);
    const cases: Array<{ sql: string; values: unknown[]; constraint: string }> = [
      {
        sql: `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values ($1, $2, $3, 'BAD', '1.00', 'BRL', '0.00', '1.00')`,
        values: [id(), walletId, transactionId],
        constraint: "ledger_direction_valid",
      },
      {
        sql: `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values ($1, $2, $3, 'CREDIT', '0.00', 'BRL', '0.00', '0.00')`,
        values: [id(), walletId, id()],
        constraint: "ledger_amount_positive",
      },
      {
        sql: `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values ($1, $2, $3, 'CREDIT', '1.00', 'brl', '0.00', '1.00')`,
        values: [id(), walletId, id()],
        constraint: "ledger_currency_iso",
      },
      {
        sql: `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values ($1, $2, $3, 'CREDIT', '1.00', 'BRL', '-1.00', '0.00')`,
        values: [id(), walletId, id()],
        constraint: "ledger_before_non_negative",
      },
      {
        sql: `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values ($1, $2, $3, 'DEBIT', '1.00', 'BRL', '0.00', '1.00')`,
        values: [id(), walletId, id()],
        constraint: "ledger_arithmetic",
      },
    ];
    for (const testCase of cases) {
      await expectPostgresError(
        () => pool.query(testCase.sql, testCase.values),
        { code: "23514", constraint: testCase.constraint },
      );
    }
    await pool.query(
      `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values ($1, $2, $3, 'CREDIT', '1.00', 'BRL', '0.00', '1.00')`,
      [id(), walletId, transactionId],
    );
    await expectPostgresError(
      () => pool.query(
        `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values ($1, $2, $3, 'CREDIT', '1.00', 'BRL', '1.00', '2.00')`,
        [id(), walletId, transactionId],
      ),
      { code: "23505", constraint: "ledger_one_per_wallet_transaction" },
    );
  });

  it("blocks ledger update and delete with SQLSTATE 55000", async () => {
    const { walletId, playerId } = await insertWallet();
    const transactionId = await insertWager(walletId, playerId);
    const ledgerId = id();
    await pool.query(
      `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values ($1, $2, $3, 'CREDIT', '1.00', 'BRL', '0.00', '1.00')`,
      [ledgerId, walletId, transactionId],
    );
    await expectPostgresError(
      () => pool.query("update wallet_ledger_entries set balance_after = '2.00' where id = $1", [ledgerId]),
      { code: "55000", message: "ledger entries are immutable" },
    );
    await expectPostgresError(
      () => pool.query("delete from wallet_ledger_entries where id = $1", [ledgerId]),
      { code: "55000", message: "ledger entries are immutable" },
    );
  });

  it("enforces inbox primary key and outbox guarantees", async () => {
    const consumerName = `consumer-${id()}`;
    const messageId = `message-${id()}`;
    await pool.query(
      `insert into inbox_messages (consumer_name, message_id, payload_hash)
       values ($1, $2, $3)`,
      [consumerName, messageId, "d".repeat(64)],
    );
    await expectPostgresError(
      () => pool.query(
        `insert into inbox_messages (consumer_name, message_id, payload_hash)
        values ($1, $2, $3)`,
        [consumerName, messageId, "e".repeat(64)],
      ),
      { code: "23505", constraint: "inbox_messages_pkey" },
    );
    const aggregateId = id();
    const eventId = id();
    await pool.query(
      `insert into outbox_messages
        (id, event_id, aggregate_id, event_type, version, payload, occurred_at)
       values ($1, $2, $3, 'Test', 1, '{}', current_timestamp)`,
      [id(), eventId, aggregateId],
    );
    await expectPostgresError(
      () => pool.query(
        `insert into outbox_messages
          (id, event_id, aggregate_id, event_type, version, payload, occurred_at)
         values ($1, $2, $3, 'Test', 1, '{}', current_timestamp)`,
        [id(), eventId, aggregateId],
      ),
      { code: "23505", constraint: "outbox_messages_event_id_key" },
    );
    await expectPostgresError(
      () => pool.query(
        `insert into outbox_messages
          (id, event_id, aggregate_id, event_type, version, payload, occurred_at)
         values ($1, $2, $3, 'Test', 0, '{}', current_timestamp)`,
        [id(), id(), aggregateId],
      ),
      { code: "23514", constraint: "outbox_version_positive" },
    );
    await expectPostgresError(
      () => pool.query(
        `insert into outbox_messages
          (id, event_id, aggregate_id, event_type, version, attempts, payload, occurred_at)
         values ($1, $2, $3, 'Test', 1, -1, '{}', current_timestamp)`,
        [id(), id(), aggregateId],
      ),
      { code: "23514", constraint: "outbox_attempts_non_negative" },
    );
  });

  it("handles both idempotency collisions without aborting READ COMMITTED", async () => {
    const { walletId, playerId } = await insertWallet();
    const collisionProvider = `provider-${id()}`;
    const collisionKey = `key-${id()}`;
    const collisionExternalId = `external-${id()}`;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const first = await client.query(
        `insert into wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, player_id,
           wallet_id, round_id, game_id, kind, status, amount, currency, payload_hash)
         values ($1, $2, $3, $4, $5, $6, 'r', 'g',
           'BET', 'PENDING', '1.00', 'BRL', $7)
         on conflict do nothing returning id`,
        [id(), collisionProvider, collisionExternalId, collisionKey, playerId, walletId, "f".repeat(64)],
      );
      expect(first.rowCount).toBe(1);
      const keyCollision = await client.query(
        `insert into wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, player_id,
           wallet_id, round_id, game_id, kind, status, amount, currency, payload_hash)
         values ($1, $2, $3, $4, $5, $6, 'r', 'g',
           'BET', 'PENDING', '1.00', 'BRL', $7)
         on conflict do nothing returning id`,
        [id(), `provider-${id()}`, `external-${id()}`, collisionKey, playerId, walletId, "g".repeat(64)],
      );
      expect(keyCollision.rowCount).toBe(0);
      const externalCollision = await client.query(
        `insert into wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, player_id,
           wallet_id, round_id, game_id, kind, status, amount, currency, payload_hash)
         values ($1, $2, $3, $4, $5, $6, 'r', 'g',
           'BET', 'PENDING', '1.00', 'BRL', $7)
         on conflict do nothing returning id`,
        [id(), collisionProvider, collisionExternalId, `key-${id()}`, playerId, walletId, "h".repeat(64)],
      );
      expect(externalCollision.rowCount).toBe(0);
      const selected = await client.query(
        "select count(*)::int as count from wager_transactions where idempotency_key = $1",
        [collisionKey],
      );
      expect(selected.rows[0]?.count).toBe(1);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
});

afterAll(async () => {
  await pool.end();
});
