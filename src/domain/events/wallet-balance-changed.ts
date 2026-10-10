import { EventContext, IntegrationEvent } from "./integration-event";
import { Wallet } from "../wallet/wallet";
import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: string;
  readonly money: ReturnType<WalletLedgerEntry["money"]["toJSON"]>;
  readonly balanceBefore: ReturnType<WalletLedgerEntry["balanceBefore"]["toJSON"]>;
  readonly balanceAfter: ReturnType<WalletLedgerEntry["balanceAfter"]["toJSON"]>;
  readonly walletVersion: number;
}

export class WalletBalanceChanged
  extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(
    eventId: string,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ) {
    super(
      eventId,
      wallet.id,
      context.correlationId,
      context.causationId,
      entry.createdAt,
      {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    );
  }

  static from(
    eventId: string,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(eventId, wallet, entry, context);
  }
}
