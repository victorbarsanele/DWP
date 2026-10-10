import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from "../../../src/domain/shared/domain-error";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";

const now = new Date("2026-01-01T00:00:00.000Z");
const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });

describe("Wallet", () => {
  it("starts at version one with initial balance", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      now,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  it("debits and creates a balanced debit entry", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      now,
    });
    const movement = wallet.debit({
      entryId: "entry-1",
      transactionId: "transaction-1",
      amount: money("30.00"),
      now,
    });
    expect(movement.entry.direction).toBe(LedgerDirection.Debit);
    expect(movement.entry.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe("70.00");
    expect(wallet.version).toBe(2);
  });

  it("credits and increments version only when balance moves", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("0.00"),
      now,
    });
    const movement = wallet.credit({
      entryId: "entry-1",
      transactionId: "transaction-1",
      amount: money("10.00"),
      now,
    });
    expect(movement.entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(2);
  });

  it("rejects insufficient funds without mutating state", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("10.00"),
      now,
    });
    expect(() => wallet.debit({
      entryId: "entry-1",
      transactionId: "transaction-1",
      amount: money("11.00"),
      now,
    })).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  it("rejects negative, zero and mismatched movement currency", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("10.00"),
      now,
    });
    expect(() => wallet.credit({
      entryId: "entry-1",
      transactionId: "transaction-1",
      amount: Money.zero("BRL"),
      now,
    })).toThrow(InvalidMoneyError);
    expect(() => wallet.credit({
      entryId: "entry-2",
      transactionId: "transaction-2",
      amount: money("1.00", "USD"),
      now,
    })).toThrow(CurrencyMismatchError);
    expect(() => Wallet.open({
      id: "wallet-2",
      playerId: "player-2",
      initialBalance: Money.zero("BRL").negate(),
      now,
    })).toThrow(InvalidMoneyError);
    expect(() => wallet.credit({
      entryId: "entry-3",
      transactionId: "transaction-3",
      amount: money("1.00", "USD"),
      now,
    })).toThrow(CurrencyMismatchError);
  });
});
