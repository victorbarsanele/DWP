import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { LockSchema } from "./shared-lock-schema";

@Injectable()
export class MikroProbeService {
  constructor(private readonly em: EntityManager) {}

  async probe(): Promise<string> {
    const fork = this.em.fork();
    return fork.transactional(async (tx) => {
      const result = await tx.getConnection().execute<{ value: string }[]>(
        "select 'nestjs-mikro-transaction-ok' as value",
      );
      return result[0]?.value ?? "missing";
    });
  }
}

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [LockSchema],
      dbName: "spike",
      host: "127.0.0.1",
      port: 55432,
      user: "spike",
      password: "spike",
      driver: PostgreSqlDriver,
    }),
  ],
  providers: [MikroProbeService],
  exports: [MikroProbeService],
})
export class MikroProbeModule {}
