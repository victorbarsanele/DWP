import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from "../shared/domain-error";
import { Money } from "../money/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../ledger/wallet-ledger-entry";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletMovement {
  readonly entry: WalletLedgerEntry;
  readonly balance: Money;
  readonly version: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly createdAtValue: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    readonly id: string;
    readonly playerId: string;
    readonly initialBalance: Money;
    readonly now: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("wallet initial balance cannot be negative");
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(props.now),
      new Date(props.now),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get createdAt(): Date { return new Date(this.createdAtValue); }
  get updatedAt(): Date { return new Date(this._updatedAt); }

  debit(props: {
    readonly entryId: string;
    readonly transactionId: string;
    readonly amount: Money;
    readonly now: Date;
  }): WalletMovement {
    this.assertMovable(props.amount);
    if (this._balance.isLessThan(props.amount)) {
      throw new InsufficientFundsError("wallet balance is insufficient");
    }
    return this.applyMovement(props, LedgerDirection.Debit, this._balance.subtract(props.amount));
  }

  credit(props: {
    readonly entryId: string;
    readonly transactionId: string;
    readonly amount: Money;
    readonly now: Date;
  }): WalletMovement {
    this.assertMovable(props.amount);
    return this.applyMovement(props, LedgerDirection.Credit, this._balance.add(props.amount));
  }

  private applyMovement(
    props: {
      readonly entryId: string;
      readonly transactionId: string;
      readonly amount: Money;
      readonly now: Date;
    },
    direction: LedgerDirection,
    balanceAfter: Money,
  ): WalletMovement {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.amount,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.now,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(props.now);
    return { entry, balance: this._balance, version: this._version };
  }

  private assertMovable(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidMoneyError("wallet movement amount must be positive");
    }
    if (amount.currency !== this.currency || this._balance.currency !== this.currency) {
      throw new CurrencyMismatchError("wallet and movement currencies must match");
    }
  }
}
