import { FailureCode } from "../domain/shared/failure-code";
import { Money } from "../domain/money/money";
import { WagerTransactionKind } from "../domain/wagering/wager-transaction";

export class HttpValidationError extends Error {
  readonly failureCode = FailureCode.ValidationError;

  constructor(readonly fields: string[]) {
    super(`Invalid request fields: ${fields.join(", ")}`);
    this.name = "HttpValidationError";
  }
}

function requiredString(value: unknown, field: string, fields: string[]): string {
  if (typeof value !== "string" || value.length === 0) fields.push(field);
  return String(value ?? "");
}

function uuid(value: unknown, field: string, fields: string[]): string {
  const result = requiredString(value, field, fields);
  if (
    result.length > 0
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)
  ) fields.push(field);
  return result;
}

function money(value: unknown, field: string, fields: string[]): { amount: string; currency: string } {
  if (typeof value !== "object" || value === null) {
    fields.push(field);
    return { amount: "", currency: "" };
  }
  const input = value as { amount?: unknown; currency?: unknown };
  const amount = requiredString(input.amount, `${field}.amount`, fields);
  const currency = requiredString(input.currency, `${field}.currency`, fields);
  if (!/^[A-Z]{3}$/.test(currency)) fields.push(`${field}.currency`);
  try {
    Money.from({ amount, currency });
  } catch {
    fields.push(`${field}.amount`);
  }
  return { amount, currency };
}

function validateKey(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,255}$/.test(value)) {
    throw new HttpValidationError(["Idempotency-Key"]);
  }
  return value;
}

export function validateCreateWalletBody(body: unknown) {
  const fields: string[] = [];
  if (typeof body !== "object" || body === null) throw new HttpValidationError(["body"]);
  const input = body as { playerId?: unknown; initialBalance?: unknown };
  const playerId = uuid(input.playerId, "playerId", fields);
  const initialBalance = money(input.initialBalance, "initialBalance", fields);
  if (fields.length > 0) throw new HttpValidationError([...new Set(fields)]);
  return { playerId, initialBalance };
}

export function validateWagerBody(body: unknown, idempotencyKey: unknown) {
  const fields: string[] = [];
  const key = validateKey(idempotencyKey);
  if (typeof body !== "object" || body === null) throw new HttpValidationError(["body"]);
  const input = body as Record<string, unknown>;
  const playerId = uuid(input.playerId, "playerId", fields);
  const walletId = uuid(input.walletId, "walletId", fields);
  const providerId = requiredString(input.providerId, "providerId", fields);
  const externalTransactionId = requiredString(input.externalTransactionId, "externalTransactionId", fields);
  const roundId = requiredString(input.roundId, "roundId", fields);
  const gameId = requiredString(input.gameId, "gameId", fields);
  const kind = requiredString(input.kind, "kind", fields);
  const allowed: readonly string[] = Object.values(WagerTransactionKind)
    .filter((value) => value !== WagerTransactionKind.Opening);
  if (!allowed.includes(kind as WagerTransactionKind)) fields.push("kind");
  const transactionMoney = money(input.money, "money", fields);
  if (
    (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback)
    && typeof input.referenceExternalTransactionId !== "string"
  ) fields.push("referenceExternalTransactionId");
  if (fields.length > 0) throw new HttpValidationError([...new Set(fields)]);
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: key,
    playerId,
    walletId,
    roundId,
    gameId,
    kind: kind as WagerTransactionKind,
    money: transactionMoney,
    ...(typeof input.referenceExternalTransactionId === "string"
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
  };
}
