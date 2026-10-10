import Decimal from "decimal.js";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../shared/domain-error";

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_INTEGER_DIGITS = 17;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.validateCurrency(props.currency);
    if (
      typeof props.amount !== "string"
      || !AMOUNT_PATTERN.test(props.amount)
      || props.amount.split(".")[0]!.replace(/^0+/, "").length > MAX_INTEGER_DIGITS
    ) {
      throw new InvalidMoneyError("amount must be a non-negative decimal with at most 17 integer digits and 2 decimals");
    }
    return new Money(new Decimal(props.amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return !this.value.isZero() && this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError("currency must be an uppercase ISO-4217 code");
    }
    return currency;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError("money currencies differ");
    }
  }
}
