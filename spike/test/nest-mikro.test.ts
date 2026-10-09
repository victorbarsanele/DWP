import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "bun:test";
import { MikroProbeModule, MikroProbeService } from "../src/nest-mikro-service";

describe("MikroORM Nest integration", () => {
  it("injects EntityManager and runs forked transaction", async () => {
    const module = await Test.createTestingModule({
      imports: [MikroProbeModule],
    }).compile();
    const service = module.get(MikroProbeService);
    expect(await service.probe()).toBe("nestjs-mikro-transaction-ok");
    await module.close();
  }, 30_000);
});
