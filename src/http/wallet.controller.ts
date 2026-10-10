import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import Decimal from "decimal.js";
import { CreateWalletUseCase } from "../application/use-cases/create-wallet.use-case";
import { RandomIdGenerator } from "../application/services/clock";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process-wager-transaction.use-case";
import { MetricsRegistry } from "../application/services/metrics.registry";
import { FailureCode, FAILURE_METADATA } from "../domain/shared/failure-code";
import { HttpQueryService } from "./query.service";
import { HttpValidationError, validateCreateWalletBody, validateWagerBody } from "./validation";
import { HttpFailure } from "./http-errors";
import { LedgerCursor } from "./query.service";
import { ProviderAuthGuard } from "./provider-auth.guard";

type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): void;
};

function moneyRow(row: Record<string, unknown>, prefix = "") {
  return {
    amount: String(row[`${prefix}balance_amount`] ?? row.amount),
    currency: String(row[`${prefix}balance_currency`] ?? row.currency),
  };
}

function failureStatus(code: FailureCode): number {
  return FAILURE_METADATA[code].httpStatus;
}

function dateString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("database returned invalid ledger timestamp");
  return date.toISOString();
}

function encodeLedgerCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeLedgerCursor(value: string): LedgerCursor {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpValidationError(["cursor"]);
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) throw new Error("invalid cursor");
    const cursor = decoded as { createdAt?: unknown; id?: unknown };
    const createdAt = new Date(String(cursor.createdAt));
    if (
      !Number.isFinite(createdAt.getTime())
      || typeof cursor.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id)
    ) throw new Error("invalid cursor");
    return { createdAt, id: cursor.id };
  } catch {
    throw new HttpValidationError(["cursor"]);
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly ids: RandomIdGenerator,
    private readonly queries: HttpQueryService,
    private readonly metrics: MetricsRegistry,
  ) {}

  private correlation(value: string | undefined, response: ResponseLike): string {
    const correlationId = value && value.length > 0 ? value : this.ids.next();
    response.setHeader("X-Correlation-Id", correlationId);
    return correlationId;
  }

  @Post("wallets")
  async create(@Body() body: unknown, @Headers("x-correlation-id") correlationId: string | undefined, @Res({ passthrough: true }) response: ResponseLike) {
    const input = validateCreateWalletBody(body);
    const result = await this.createWallet.execute({
      id: this.ids.next(),
      ...input,
      correlationId: this.correlation(correlationId, response),
    });
    response.statusCode = 201;
    return {
      id: result.walletId,
      playerId: result.playerId,
      balance: result.balance,
      version: result.version,
    };
  }

  @Post("wagering/transactions")
  async process(@Body() body: unknown, @Headers("idempotency-key") idempotencyKey: string | undefined, @Headers("x-correlation-id") correlationId: string | undefined, @Res({ passthrough: true }) response: ResponseLike) {
    const input = validateWagerBody(body, idempotencyKey);
    const result = await this.processWager.execute({
      ...input,
      correlationId: this.correlation(correlationId, response),
    });
    if (result.failureCode !== undefined) {
      response.statusCode = failureStatus(result.failureCode);
      return {
        code: result.failureCode,
        failureCode: result.failureCode,
        retryable: FAILURE_METADATA[result.failureCode].retryable,
        message: result.failureCode,
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance,
        idempotentReplay: result.idempotentReplay,
      };
    }
    response.statusCode = result.idempotentReplay
      ? (result.status === "PENDING_REFERENCE" ? 202 : 200)
      : (result.status === "PENDING_REFERENCE" ? 202 : 201);
    return result;
  }

  @Get("wallets/:walletId")
  async getWallet(@Param("walletId") walletId: string, @Res({ passthrough: true }) response: ResponseLike) {
    const row = await this.queries.wallet(walletId);
    if (row === undefined) throw new HttpFailure(FailureCode.WalletNotFound, "Wallet not found");
    response.statusCode = 200;
    return {
      id: String(row.id),
      playerId: String(row.player_id),
      balance: { amount: String(row.balance_amount), currency: String(row.currency) },
      version: Number(row.version),
    };
  }

  @Get("wallets/:walletId/ledger")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("limit") rawLimit: string | undefined,
    @Query("cursor") rawCursor: string | undefined,
  ) {
    const wallet = await this.queries.wallet(walletId);
    if (wallet === undefined) throw new HttpFailure(FailureCode.WalletNotFound, "Wallet not found");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpValidationError(["limit"]);
    }
    const cursor = rawCursor === undefined ? undefined : decodeLedgerCursor(rawCursor);
    const rows = await this.queries.ledgerPage(walletId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => ({
        id: String(row.id),
        transactionId: String(row.transaction_id),
        direction: String(row.direction),
        amount: { amount: String(row.amount), currency: String(row.currency) },
        balanceBefore: String(row.balance_before),
        balanceAfter: String(row.balance_after),
        createdAt: dateString(row.created_at),
      })),
      nextCursor: hasMore && last !== undefined
        ? encodeLedgerCursor({ createdAt: dateString(last.created_at), id: String(last.id) })
        : undefined,
    };
  }

  @Post("wallets/:walletId/reconciliation")
  async reconcileWallet(@Param("walletId") walletId: string) {
    const row = await this.queries.reconciliation(walletId);
    if (row === undefined) throw new HttpFailure(FailureCode.WalletNotFound, "Wallet not found");
    const storedBalance = new Decimal(String(row.stored_balance));
    const calculatedBalance = new Decimal(String(row.calculated_balance));
    const consistent = storedBalance.equals(calculatedBalance);
    if (!consistent) {
      this.metrics.increment("reconciliation_divergences_total");
    }
    return {
      walletId: String(row.id),
      currency: String(row.currency),
      storedBalance: storedBalance.toFixed(2),
      calculatedBalance: calculatedBalance.toFixed(2),
      checkedEntries: Number(row.checked_entries),
      consistent,
      status: consistent ? "CONSISTENT" : "DIVERGED",
    };
  }

  @Get("wagering/transactions/:transactionId")
  async getTransaction(@Param("transactionId") transactionId: string) {
    const row = await this.queries.wager(transactionId);
    if (row === undefined) throw new HttpFailure(FailureCode.TransactionNotFound, "Transaction not found");
    return this.transactionResponse(row);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getProviderTransaction(@Param("providerId") providerId: string, @Param("externalTransactionId") externalId: string) {
    const row = await this.queries.wagerByProviderExternal(providerId, externalId);
    if (row === undefined) throw new HttpFailure(FailureCode.TransactionNotFound, "Transaction not found");
    return this.transactionResponse(row);
  }

  private transactionResponse(row: Record<string, unknown>) {
    return {
      transactionId: String(row.id),
      providerId: String(row.provider_id),
      externalTransactionId: String(row.external_transaction_id),
      playerId: String(row.player_id),
      walletId: String(row.wallet_id),
      roundId: String(row.round_id),
      gameId: String(row.game_id),
      kind: String(row.kind),
      status: String(row.status),
      amount: { amount: String(row.amount), currency: String(row.currency) },
      failureCode: row.failure_code ?? undefined,
      balance: row.result_balance_amount === null ? undefined : {
        amount: String(row.result_balance_amount),
        currency: String(row.result_balance_currency),
      },
      walletVersion: row.result_wallet_version === null ? undefined : Number(row.result_wallet_version),
    };
  }
}
