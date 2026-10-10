import { Module } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { CreateWalletUseCase } from "./use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./use-cases/process-wager-transaction.use-case";
import { SystemClock, RandomIdGenerator } from "./services/clock";
import { MikroTransactionRunner } from "../infrastructure/persistence/mikro-orm/transaction-runner.adapter";
import { MikroWageringPortFactory } from "../infrastructure/persistence/mikro-orm/wagering.adapter";
import { loadConfig } from "../config/configuration";
import { MetricsRegistry } from "./services/metrics.registry";

@Module({
  providers: [
    SystemClock,
    RandomIdGenerator,
    MetricsRegistry,
    {
      provide: MikroTransactionRunner,
      inject: [EntityManager, MetricsRegistry],
      useFactory: (entityManager: EntityManager, metrics: MetricsRegistry) =>
        new MikroTransactionRunner(
          entityManager,
          undefined,
          undefined,
          undefined,
          undefined,
          metrics,
        ),
    },
    {
      provide: MikroWageringPortFactory,
      inject: [EntityManager],
      useFactory: (entityManager: EntityManager) => new MikroWageringPortFactory(entityManager),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [
        MikroTransactionRunner,
        MikroWageringPortFactory,
        SystemClock,
        RandomIdGenerator,
        MetricsRegistry,
      ],
      useFactory: (
        runner: MikroTransactionRunner,
        ports: MikroWageringPortFactory,
        clock: SystemClock,
        ids: RandomIdGenerator,
        metrics: MetricsRegistry,
      ) => {
        const config = loadConfig().pendingReferences;
        return new ProcessWagerTransactionUseCase(
          runner,
          ports,
          clock,
          ids,
          2,
          config.maxAttempts,
          config.ttlSeconds * 1000,
          300,
          metrics,
        );
      },
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
  exports: [
    ProcessWagerTransactionUseCase,
    CreateWalletUseCase,
    RandomIdGenerator,
    MikroTransactionRunner,
    MetricsRegistry,
  ],
})
export class ApplicationModule {}
