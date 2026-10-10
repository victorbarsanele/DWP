import {
  WagerTransactionProcessed,
  WagerTransactionPendingReference,
  WagerTransactionRejected,
} from "../../domain/events";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { Wallet } from "../../domain/wallet/wallet";
import { Money } from "../../domain/money/money";
import { FailureCode } from "../../domain/shared/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  WagerReference,
} from "../../domain/wagering/wager-transaction";
import { ClockPort, IdGeneratorPort } from "../ports/id-clock.port";
import { TransactionRunnerPort } from "../ports/transaction-runner.port";
import {
  WageringPortFactory,
  WageringPorts,
} from "../ports/wagering.ports";
import { ProcessWagerInput, WagerResult } from "../dto/wagering.dto";
import { payloadHash } from "../services/payload-hash";

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly runner: TransactionRunnerPort,
    private readonly ports: WageringPortFactory,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly pendingBackoffSeconds = 2,
  ) {}

  async execute(input: ProcessWagerInput): Promise<WagerResult> {
    const money = Money.from(input.money);
    const hash = payloadHash(input);
    const now = this.clock.now();
    return this.runner.run(async (sql) => {
      const currentPorts = this.ports.forTransaction(sql);
      const existingWallet = await currentPorts.wallets.findById(input.walletId, false);
      if (existingWallet === undefined) {
        return this.result(
          input.idempotencyKey,
          WagerTransactionStatus.Rejected,
          input.walletId,
          Money.zero(money.currency),
          1,
          false,
          FailureCode.WalletNotFound,
        );
      }
      const id = this.ids.next();
      const inserted = await currentPorts.wagers.insertIfAbsent({
        id,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        amount: money.toString(),
        currency: money.currency,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        payloadHash: hash,
        createdAt: now,
      });

      if (inserted === undefined) {
        const byKey = await currentPorts.wagers.findByIdempotencyKey(input.idempotencyKey);
        if (byKey !== undefined) {
          if (!byKey.matchesPayload(hash)) {
            return this.result(
              byKey.id,
              byKey.status,
              input.walletId,
              existingWallet.balance,
              existingWallet.version,
              false,
              FailureCode.IdempotencyKeyPayloadMismatch,
            );
          }
          return this.replay(byKey, existingWallet);
        }
        const byExternal = await currentPorts.wagers.findByProviderExternal(
          input.providerId,
          input.externalTransactionId,
        );
        if (byExternal !== undefined) {
          return this.result(
            byExternal.id,
            byExternal.status,
            byExternal.walletId,
            existingWallet.balance,
            existingWallet.version,
            false,
            FailureCode.ExternalTransactionIdConflict,
          );
        }
        throw new Error("idempotency insert conflict disappeared before SELECT");
      }

      const transaction = WagerTransaction.create({
        id: inserted,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: hash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: now,
      });
      const wallet = await currentPorts.wallets.findById(input.walletId, true);
      if (wallet === undefined) throw new Error("wallet disappeared after preflight");
      if (wallet.playerId !== input.playerId || wallet.currency !== money.currency) {
        transaction.reject(
          wallet.playerId !== input.playerId
            ? FailureCode.PlayerWalletMismatch
            : FailureCode.CurrencyMismatch,
          now,
        );
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts: 0,
          nextAttemptAt: null,
        });
        await this.writeRejected(currentPorts, transaction, input.correlationId, now);
        return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false, transaction.failureCode);
      }

      const reference = input.referenceExternalTransactionId === undefined
        ? undefined
        : await currentPorts.wagers.findReferenceForUpdate(
          input.providerId,
          input.referenceExternalTransactionId,
        );
      const referenceDecision = transaction.validateReference(reference as WagerReference | undefined);
      if (referenceDecision.type === "WAIT") {
        transaction.markPendingReference(now);
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts: 0,
          nextAttemptAt: new Date(now.getTime() + this.pendingBackoffSeconds * 1000),
        });
        await currentPorts.outbox.append(WagerTransactionPendingReference.from(
          this.ids.next(),
          transaction,
          { correlationId: input.correlationId ?? this.ids.next(), causationId: transaction.id },
        ));
        return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false, FailureCode.ReferencePending);
      }
      if (referenceDecision.type === "REJECT") {
        transaction.reject(referenceDecision.code, now);
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts: 0,
          nextAttemptAt: null,
        });
        await this.writeRejected(currentPorts, transaction, input.correlationId, now);
        return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false, transaction.failureCode);
      }
      if (transaction.requiresReference() && reference !== undefined) {
        const prior = await currentPorts.wagers.findProcessedReversal(reference.id);
        if (prior !== undefined) {
          transaction.reject(FailureCode.ReferenceAlreadyReversed, now);
          await currentPorts.wagers.updateDecision({
            transaction,
            snapshot: wallet.balance,
            walletVersion: wallet.version,
            attempts: 0,
            nextAttemptAt: null,
          });
          await this.writeRejected(currentPorts, transaction, input.correlationId, now);
          return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false, transaction.failureCode);
        }
      }

      if (transaction.kind === WagerTransactionKind.Bet) {
        try {
          const movement = wallet.debit({
            entryId: this.ids.next(),
            transactionId: transaction.id,
            amount: money,
            now,
          });
          await currentPorts.ledger.insert(movement.entry);
          await currentPorts.wallets.update(wallet);
          transaction.markProcessed(undefined, now);
          await currentPorts.wagers.updateDecision({
            transaction,
            snapshot: wallet.balance,
            walletVersion: wallet.version,
            attempts: 0,
            nextAttemptAt: null,
          });
          await this.writeProcessed(currentPorts, transaction, movement.entry, wallet, input.correlationId, now);
          return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false);
        } catch (error) {
          if (error instanceof Error && error.name === "InsufficientFundsError") {
            transaction.reject(FailureCode.InsufficientFunds, now);
            await currentPorts.wagers.updateDecision({
              transaction,
              snapshot: wallet.balance,
              walletVersion: wallet.version,
              attempts: 0,
              nextAttemptAt: null,
            });
            await this.writeRejected(currentPorts, transaction, input.correlationId, now);
            return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false, transaction.failureCode);
          }
          throw error;
        }
      }

      if (transaction.kind === WagerTransactionKind.Loss) {
        transaction.markProcessed(reference?.id, now);
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts: 0,
          nextAttemptAt: null,
        });
        await currentPorts.outbox.append(WagerTransactionProcessed.from(
          this.ids.next(), transaction, { correlationId: input.correlationId ?? this.ids.next(), causationId: transaction.id },
        ));
        return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false);
      }

      const direction = transaction.ledgerDirectionFor(reference);
      let movement;
      try {
        movement = direction === "DEBIT"
          ? wallet.debit({ entryId: this.ids.next(), transactionId: transaction.id, amount: money, now })
          : wallet.credit({ entryId: this.ids.next(), transactionId: transaction.id, amount: money, now });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "InsufficientFundsError") throw error;
        transaction.reject(
          transaction.kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalInsufficientFunds
            : FailureCode.InsufficientFunds,
          now,
        );
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts: 0,
          nextAttemptAt: null,
        });
        await this.writeRejected(currentPorts, transaction, input.correlationId, now);
        return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false, transaction.failureCode);
      }
      await currentPorts.ledger.insert(movement.entry);
      await currentPorts.wallets.update(wallet);
      transaction.markProcessed(reference?.id, now);
      await currentPorts.wagers.updateDecision({
        transaction,
        snapshot: wallet.balance,
        walletVersion: wallet.version,
        attempts: 0,
        nextAttemptAt: null,
      });
      await this.writeProcessed(currentPorts, transaction, movement.entry, wallet, input.correlationId, now);
      return this.result(transaction.id, transaction.status, wallet.id, wallet.balance, wallet.version, false);
    });
  }

  private async writeRejected(
    ports: WageringPorts,
    transaction: WagerTransaction,
    correlationId: string | undefined,
    now: Date,
  ): Promise<void> {
    await ports.outbox.append(WagerTransactionRejected.from(
      this.ids.next(), transaction, { correlationId: correlationId ?? this.ids.next(), causationId: transaction.id },
    ));
  }

  private async writeProcessed(
    ports: WageringPorts,
    transaction: WagerTransaction,
    entry: WalletLedgerEntry,
    wallet: Wallet,
    correlationId: string | undefined,
    now: Date,
  ): Promise<void> {
    const context = { correlationId: correlationId ?? this.ids.next(), causationId: transaction.id };
    await ports.outbox.append(WagerTransactionProcessed.from(
      this.ids.next(), transaction, context,
    ));
    await ports.outbox.append(WalletBalanceChanged.from(
      this.ids.next(),
      wallet,
      entry,
      context,
    ));
    void now;
  }

  private replay(transaction: WagerTransaction, wallet: { balance: Money; version: number }): WagerResult {
    return this.result(
      transaction.id,
      transaction.status,
      transaction.walletId,
      transaction.resultBalance ?? wallet.balance,
      transaction.resultWalletVersion ?? wallet.version,
      true,
      transaction.failureCode,
    );
  }

  private result(
    transactionId: string,
    status: WagerTransactionStatus,
    walletId: string,
    balance: Money,
    walletVersion: number,
    idempotentReplay: boolean,
    failureCode?: FailureCode,
  ): WagerResult {
    void walletId;
    return {
      transactionId,
      status,
      balance: balance.toJSON(),
      walletVersion,
      idempotentReplay,
      ...(failureCode === undefined ? {} : { failureCode }),
    };
  }
}
