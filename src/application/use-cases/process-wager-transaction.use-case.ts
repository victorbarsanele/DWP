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
import { InboxMessageRecord } from "../ports/inbox-message.port";
import { MetricsRegistry } from "../services/metrics.registry";

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly runner: TransactionRunnerPort,
    private readonly ports: WageringPortFactory,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly pendingBackoffSeconds = 2,
    private readonly pendingMaxAttempts = 5,
    private readonly pendingTtlMs = 86_400_000,
    private readonly pendingMaxBackoffSeconds = 300,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async execute(input: ProcessWagerInput): Promise<WagerResult> {
    const startedAt = performance.now();
    try {
      const result = await this.run(input);
      if (
        result.idempotentReplay
        || result.failureCode === FailureCode.IdempotencyKeyPayloadMismatch
      ) {
        this.metrics?.increment("idempotency_duplicates_total");
      }
      this.logOutcome(input, result);
      return result;
    } finally {
      this.metrics?.observeWagerProcessingDuration(performance.now() - startedAt);
    }
  }

  async executeFromInbox(
    input: ProcessWagerInput,
    inbox: Omit<InboxMessageRecord, "receivedAt">,
  ): Promise<WagerResult | undefined> {
    const startedAt = performance.now();
    const money = Money.from(input.money);
    const hash = payloadHash(input);
    const now = this.clock.now();
    try {
      const result = await this.runner.run(async (sql) => {
        const currentPorts = this.ports.forTransaction(sql);
        const inserted = await currentPorts.inbox.insertIfAbsent({
          ...inbox,
          receivedAt: now,
        });
        if (!inserted) return undefined;
        try {
          return await this.processTransaction(input, money, hash, now, currentPorts);
        } finally {
          await currentPorts.inbox.markProcessed(inbox.consumerName, inbox.messageId, now);
        }
      });
      if (result === undefined) {
        this.metrics?.increment("inbox_duplicates_total");
      } else if (
        result.idempotentReplay
        || result.failureCode === FailureCode.IdempotencyKeyPayloadMismatch
      ) {
        this.metrics?.increment("idempotency_duplicates_total");
      }
      this.logOutcome(input, result, inbox.messageId);
      return result;
    } finally {
      this.metrics?.observeWagerProcessingDuration(performance.now() - startedAt);
    }
  }

  private logOutcome(
    input: ProcessWagerInput,
    result: WagerResult | undefined,
    messageId?: string,
  ): void {
    console.log(JSON.stringify({
      event: "wager.transaction.completed",
      correlationId: input.correlationId ?? null,
      messageId: messageId ?? null,
      transactionId: result?.transactionId ?? null,
      walletId: input.walletId,
      providerId: input.providerId,
      status: result?.status ?? "INBOX_DUPLICATE",
      failureCode: result?.failureCode ?? null,
    }));
  }

  async resolveNextPendingReference(): Promise<boolean> {
    const now = this.clock.now();
    return this.runner.run(async (sql) => {
      const currentPorts = this.ports.forTransaction(sql);
      const candidate = await currentPorts.wagers.findNextPendingReference(now);
      if (candidate === undefined) return false;

      const wallet = await currentPorts.wallets.findById(candidate.walletId, true);
      if (wallet === undefined) throw new Error("pending reference wallet no longer exists");
      const pending = await currentPorts.wagers.findPendingReferenceForUpdate(candidate.id, now);
      if (pending === undefined) return true;

      const transaction = pending.transaction;
      const attempts = pending.attempts + 1;
      const reference = transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await currentPorts.wagers.findReferenceForUpdate(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        );
      const decision = transaction.validateReference(reference);

      if (decision.type === "WAIT") {
        const expired = attempts >= this.pendingMaxAttempts
          || now.getTime() - transaction.createdAt.getTime() >= this.pendingTtlMs;
        if (expired) {
          transaction.reject(
            reference === undefined
              ? FailureCode.ReferenceNotFound
              : FailureCode.ReferenceNotProcessed,
            now,
          );
          await currentPorts.wagers.updateDecision({
            transaction,
            snapshot: wallet.balance,
            walletVersion: wallet.version,
            attempts,
            nextAttemptAt: null,
          });
          await this.writeRejected(currentPorts, transaction, transaction.id, now);
          return true;
        }

        this.metrics?.increment("retries_total");
        const delaySeconds = Math.min(
          this.pendingMaxBackoffSeconds,
          this.pendingBackoffSeconds * 2 ** pending.attempts,
        );
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts,
          nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
        });
        return true;
      }

      if (decision.type === "REJECT") {
        transaction.reject(decision.code, now);
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts,
          nextAttemptAt: null,
        });
        await this.writeRejected(currentPorts, transaction, transaction.id, now);
        return true;
      }

      if (transaction.requiresReference() && reference !== undefined) {
        const prior = await currentPorts.wagers.findProcessedReversal(reference.id);
        if (prior !== undefined) {
          transaction.reject(FailureCode.ReferenceAlreadyReversed, now);
          await currentPorts.wagers.updateDecision({
            transaction,
            snapshot: wallet.balance,
            walletVersion: wallet.version,
            attempts,
            nextAttemptAt: null,
          });
          await this.writeRejected(currentPorts, transaction, transaction.id, now);
          return true;
        }
      }

      if (transaction.kind === WagerTransactionKind.Loss) {
        transaction.markProcessed(reference?.id, now);
        await currentPorts.wagers.updateDecision({
          transaction,
          snapshot: wallet.balance,
          walletVersion: wallet.version,
          attempts,
          nextAttemptAt: null,
        });
        await currentPorts.outbox.append(WagerTransactionProcessed.from(
          this.ids.next(),
          transaction,
          { correlationId: transaction.id, causationId: transaction.id },
        ));
        return true;
      }

      const direction = transaction.ledgerDirectionFor(reference);
      let movement;
      try {
        movement = direction === "DEBIT"
          ? wallet.debit({
            entryId: this.ids.next(),
            transactionId: transaction.id,
            amount: transaction.money,
            now,
          })
          : wallet.credit({
            entryId: this.ids.next(),
            transactionId: transaction.id,
            amount: transaction.money,
            now,
          });
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
          attempts,
          nextAttemptAt: null,
        });
        await this.writeRejected(currentPorts, transaction, transaction.id, now);
        return true;
      }

      await currentPorts.ledger.insert(movement.entry);
      await currentPorts.wallets.update(wallet);
      transaction.markProcessed(reference?.id, now);
      await currentPorts.wagers.updateDecision({
        transaction,
        snapshot: wallet.balance,
        walletVersion: wallet.version,
        attempts,
        nextAttemptAt: null,
      });
      await this.writeProcessed(
        currentPorts,
        transaction,
        movement.entry,
        wallet,
        transaction.id,
        now,
      );
      return true;
    });
  }

  private async run(input: ProcessWagerInput): Promise<WagerResult> {
    const money = Money.from(input.money);
    const hash = payloadHash(input);
    const now = this.clock.now();
    return this.runner.run(async (sql) => this.processTransaction(
      input,
      money,
      hash,
      now,
      this.ports.forTransaction(sql),
    ));
  }

  private async processTransaction(
    input: ProcessWagerInput,
    money: Money,
    hash: string,
    now: Date,
    currentPorts: WageringPorts,
  ): Promise<WagerResult> {
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
