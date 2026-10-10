import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { describe, expect, it } from "bun:test";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm/mikro-orm.options";

describe("reversible migrations", () => {
  it("runs up, down, up and restores schema", async () => {
    const orm = await MikroORM.init(mikroOrmOptions());
    try {
      await orm.getMigrator().down();
      const afterDown = await orm.em.getConnection().execute<{ exists: boolean }[]>(
        `select exists (
          select 1 from information_schema.tables where table_name = 'wallets'
        ) as exists`,
      );
      expect(afterDown[0]?.exists).toBe(false);
      await orm.getMigrator().up();
      const afterUp = await orm.em.getConnection().execute<{ exists: boolean }[]>(
        `select exists (
          select 1 from information_schema.tables where table_name = 'wallets'
        ) as exists`,
      );
      expect(afterUp[0]?.exists).toBe(true);
    } finally {
      await orm.close(true);
    }
  });
});
