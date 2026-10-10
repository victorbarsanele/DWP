import { WagerTransactionProcessed } from "../../domain/events";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { Money } from "../../domain/money/money";
import { FailureCode } from "../../domain/shared/failure-code";
import { Wallet } from "../../domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { CreateWalletInput, WalletResult } from "../dto/wagering.dto";
import { ClockPort, IdGeneratorPort } from "../ports/id-clock.port";
import { TransactionRunnerPort } from "../ports/transaction-runner.port";
import { WageringPortFactory } from "../ports/wagering.ports";

export class CreateWalletUseCase {
  constructor(
    private readonly runner: TransactionRunnerPort,
    private readonly ports: WageringPortFactory,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  async execute(input: CreateWalletInput): Promise<WalletResult> {
    const initialBalance = Money.from(input.initialBalance);
    if (initialBalance.isNegative()) {
      throw new Error(FailureCode.ValidationError);
    }
    return this.runner.run(async (sql) => {
      const ports = this.ports.forTransaction(sql);
      if (await ports.wallets.findByPlayerCurrency(input.playerId, initialBalance.currency)) {
        throw new Error(FailureCode.WalletAlreadyExists);
      }
      const wallet = Wallet.open({
        id: input.id,
        playerId: input.playerId,
        initialBalance,
        now: this.clock.now(),
      });
      await ports.wallets.insert(wallet);
      if (!initialBalance.isZero()) {
        const openingId = this.ids.next();
        const opening = {
          id: openingId,
          providerId: "internal",
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `internal:opening:${wallet.id}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "internal",
          gameId: "wallet-opening",
          kind: "OPENING",
          amount: initialBalance.toString(),
          currency: initialBalance.currency,
          payloadHash: "0".repeat(64),
          createdAt: this.clock.now(),
        };
        const inserted = await ports.wagers.insertIfAbsent(opening);
        if (inserted === undefined) throw new Error(FailureCode.WalletAlreadyExists);
        const openingEntry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: openingId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          createdAt: this.clock.now(),
        });
        await ports.ledger.insert(openingEntry);
        await sql.execute(
          `update wager_transactions
           set status = 'PROCESSED', result_balance_amount = $2,
               result_balance_currency = $3, result_wallet_version = $4,
               processed_at = $5, updated_at = $5
           where id = $1`,
          [openingId, wallet.balance.toString(), wallet.currency, wallet.version, this.clock.now()],
        );
        const context = {
          correlationId: input.correlationId ?? this.ids.next(),
          causationId: openingId,
        };
        await ports.outbox.append(WagerTransactionProcessed.from(this.ids.next(),
          { id: openingId, walletId: wallet.id, kind: "OPENING", status: "PROCESSED", processedAt: this.clock.now(), createdAt: this.clock.now() } as never,
          context));
        await ports.outbox.append(WalletBalanceChanged.from(
          this.ids.next(), wallet, openingEntry, context,
        ));
      }
      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
