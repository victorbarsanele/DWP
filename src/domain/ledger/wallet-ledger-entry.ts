import { InvalidMoneyError } from "../shared/domain-error";
import { Money } from "../money/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {}

export class WalletLedgerEntry {
  private constructor(private readonly props: CreateLedgerEntryProps) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError("ledger amount must be positive");
    }
    if (
      !props.balanceBefore.equals(
        Money.zero(props.balanceBefore.currency).add(props.balanceBefore),
      )
      || props.money.currency !== props.balanceAfter.currency
      || props.money.currency !== props.balanceBefore.currency
    ) {
      throw new InvalidMoneyError("ledger currencies must match");
    }
    const expected = props.direction === LedgerDirection.Debit
      ? props.balanceBefore.subtract(props.money)
      : props.balanceBefore.add(props.money);
    if (!expected.equals(props.balanceAfter) || props.balanceAfter.isNegative()) {
      throw new InvalidMoneyError("ledger balances are not arithmetically consistent");
    }
    return new WalletLedgerEntry({ ...props });
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...state });
  }

  get id(): string { return this.props.id; }
  get walletId(): string { return this.props.walletId; }
  get transactionId(): string { return this.props.transactionId; }
  get direction(): LedgerDirection { return this.props.direction; }
  get money(): Money { return this.props.money; }
  get balanceBefore(): Money { return this.props.balanceBefore; }
  get balanceAfter(): Money { return this.props.balanceAfter; }
  get createdAt(): Date { return new Date(this.props.createdAt); }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
