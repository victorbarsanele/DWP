import { describe, expect, it } from "bun:test";
import Decimal from "decimal.js";
import { Money } from "../../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../../src/domain/shared/domain-error";

describe("Money", () => {
  it("accepts zero, integer and one decimal and normalizes to two decimals", () => {
    expect(Money.from({ amount: "0", currency: "BRL" }).toString()).toBe("0.00");
    expect(Money.from({ amount: "1", currency: "BRL" }).toString()).toBe("1.00");
    expect(Money.from({ amount: "1.9", currency: "BRL" }).toString()).toBe("1.90");
  });

  it("rejects more than two decimal places", () => {
    expect(() => Money.from({ amount: "1.001", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  it("rejects negative, empty, NaN, Infinity and scientific notation", () => {
    for (const amount of ["-1.00", "", "NaN", "Infinity", "1e2"]) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    }
  });

  it("rejects 18 or more integer digits and invalid currency", () => {
    expect(() => Money.from({ amount: "123456789012345678.00", currency: "BRL" }))
      .toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
  });

  it("keeps arithmetic immutable and rejects mixed currencies", () => {
    const original = Money.from({ amount: "10.00", currency: "BRL" });
    const result = original.add(Money.from({ amount: "2.00", currency: "BRL" }));
    expect(original.toString()).toBe("10.00");
    expect(result.toString()).toBe("12.00");
    expect(original.subtract(Money.from({ amount: "12.00", currency: "BRL" })).isNegative())
      .toBe(true);
    expect(original.negate().toString()).toBe("-10.00");
    expect(() => original.add(Money.from({ amount: "1.00", currency: "USD" })))
      .toThrow(CurrencyMismatchError);
  });

  it("does not depend on Decimal floating point arithmetic", () => {
    const value = Money.from({ amount: "0.10", currency: "BRL" })
      .add(Money.from({ amount: "0.20", currency: "BRL" }));
    expect(value.toString()).toBe("0.30");
    expect(new Decimal(value.toString()).toFixed(2)).toBe("0.30");
  });
});
