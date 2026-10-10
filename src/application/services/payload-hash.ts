import { createHash } from "node:crypto";
import { Money } from "../../domain/money/money";

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export interface BusinessPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeBusinessPayload(input: BusinessPayload): string {
  return canonical({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
    money: {
      amount: input.money.amount,
      currency: input.money.currency,
    },
  });
}

export function payloadHash(input: BusinessPayload): string {
  const normalized = Money.from(input.money).toJSON();
  return createHash("sha256")
    .update(canonicalizeBusinessPayload({ ...input, money: normalized }), "utf8")
    .digest("hex");
}
