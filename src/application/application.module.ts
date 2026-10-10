import { Module } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { CreateWalletUseCase } from "./use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./use-cases/process-wager-transaction.use-case";
import { SystemClock, RandomIdGenerator } from "./services/clock";
import { MikroTransactionRunner } from "../infrastructure/persistence/mikro-orm/transaction-runner.adapter";
import { MikroWageringPortFactory } from "../infrastructure/persistence/mikro-orm/wagering.adapter";

@Module({
  providers: [
    SystemClock,
    RandomIdGenerator,
    {
      provide: MikroTransactionRunner,
      inject: [EntityManager],
      useFactory: (entityManager: EntityManager) => new MikroTransactionRunner(entityManager),
    },
    {
      provide: MikroWageringPortFactory,
      inject: [EntityManager],
      useFactory: (entityManager: EntityManager) => new MikroWageringPortFactory(entityManager),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [MikroTransactionRunner, MikroWageringPortFactory, SystemClock, RandomIdGenerator],
      useFactory: (
        runner: MikroTransactionRunner,
        ports: MikroWageringPortFactory,
        clock: SystemClock,
        ids: RandomIdGenerator,
      ) => new ProcessWagerTransactionUseCase(runner, ports, clock, ids),
    },
    {
      provide: CreateWalletUseCase,
      inject: [MikroTransactionRunner, MikroWageringPortFactory, SystemClock, RandomIdGenerator],
      useFactory: (
        runner: MikroTransactionRunner,
        ports: MikroWageringPortFactory,
        clock: SystemClock,
        ids: RandomIdGenerator,
      ) => new CreateWalletUseCase(runner, ports, clock, ids),
    },
  ],
  exports: [ProcessWagerTransactionUseCase, CreateWalletUseCase],
})
export class ApplicationModule {}
