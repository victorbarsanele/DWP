import pg from "pg";
import { expect } from "bun:test";

export async function assertWalletInvariant(
  walletId: string,
  initialBalance = "0.00",
): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL
      ?? "******127.0.0.1:55432/spike_test",
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  let walletResult: { rows: { balance_amount: string }[] };
  let ledgerResult: { rows: {
    transaction_id: string;
    balance_before: string;
    balance_after: string;
  }[] };
  try {
    walletResult = await client.query(
      "select balance_amount::text from wallets where id = $1",
      [walletId],
    );
    ledgerResult = await client.query(
      `select transaction_id, balance_before::text, balance_after::text
         from wallet_ledger_entries
        where wallet_id = $1
        order by created_at, id`,
      [walletId],
    );
  } finally {
    await client.end();
  }
  expect(walletResult!.rows).toHaveLength(1);
  const transactionIds = ledgerResult!.rows.map((row) => row.transaction_id);
  expect(new Set(transactionIds).size).toBe(transactionIds.length);

  if (ledgerResult!.rows.length === 0) {
    expect(walletResult.rows[0]?.balance_amount).toBe(initialBalance);
    return;
  }

  let expectedBefore = initialBalance;
  const remaining = [...ledgerResult!.rows];
  while (remaining.length > 0) {
    const index = remaining.findIndex((row) => row.balance_before === expectedBefore);
    expect(index).toBeGreaterThanOrEqual(0);
    const [entry] = remaining.splice(index, 1);
    expectedBefore = entry!.balance_after;
  }
  expect(expectedBefore).toBe(walletResult.rows[0]?.balance_amount);
}
