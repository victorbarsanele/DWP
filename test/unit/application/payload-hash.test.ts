import { describe, expect, test } from "bun:test";
import { payloadHash } from "../../../src/application/services/payload-hash";
import { FAILURE_METADATA, FailureCode } from "../../../src/domain/shared/failure-code";

const base = {
  providerId: "provider",
  externalTransactionId: "external",
  playerId: "player",
  walletId: "wallet",
  roundId: "round",
  gameId: "game",
  kind: "BET",
  money: { amount: "10", currency: "BRL" },
};

describe("application helpers", () => {
  test("hash ignores property order and metadata", () => {
    const first = payloadHash(base);
    const second = payloadHash({
      ...base,
      money: { currency: "BRL", amount: "10.00" },
    });
    expect(first).toBe(second);
    expect(payloadHash({ ...base, correlationId: "ignored" } as never)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hash changes when business amount changes", () => {
    expect(payloadHash(base)).not.toBe(payloadHash({
      ...base,
      money: { amount: "11.00", currency: "BRL" },
    }));
  });

  test("keeps failure metadata stable", () => {
    const codes = Object.values(FailureCode);
    expect(Object.keys(FAILURE_METADATA)).toHaveLength(codes.length);
    for (const code of codes) {
      expect(typeof FAILURE_METADATA[code].retryable).toBe("boolean");
      expect([400, 404, 409, 422, 202, 500, 503]).toContain(FAILURE_METADATA[code].httpStatus);
    }
    expect(FAILURE_METADATA[FailureCode.ReferencePending]).toEqual({
      retryable: true, httpStatus: 202,
    });
  });
});
