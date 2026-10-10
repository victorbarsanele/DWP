import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { CreateWalletUseCase } from "../application/use-cases/create-wallet.use-case";
import { RandomIdGenerator } from "../application/services/clock";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process-wager-transaction.use-case";
import { FailureCode, FAILURE_METADATA } from "../domain/shared/failure-code";
import { HttpQueryService } from "./query.service";
import { HttpValidationError, validateCreateWalletBody, validateWagerBody } from "./validation";
import { HttpFailure } from "./http-errors";

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

@Controller()
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly ids: RandomIdGenerator,
    private readonly queries: HttpQueryService,
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
