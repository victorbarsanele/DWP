import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "bun:test";

@Injectable()
class ConstructorProbe {
  value(): string {
    return "bun-test-di-ok";
  }
}

@Injectable()
class ConsumerProbe {
  constructor(private readonly dependency: ConstructorProbe) {}

  value(): string {
    return this.dependency.value();
  }
}

describe("Nest DI under bun test", () => {
  it("resolves constructor metadata without explicit @Inject", async () => {
    const module = await Test.createTestingModule({
      providers: [ConstructorProbe, ConsumerProbe],
    }).compile();
    expect(module.get(ConsumerProbe).value()).toBe("bun-test-di-ok");
    await module.close();
  });
});
