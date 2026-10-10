import { EntityManager } from "@mikro-orm/postgresql";
import {
  InfrastructureTransientError,
  isTransientPostgresError,
  SqlTransaction,
  TransactionRunnerPort,
} from "../../../application/ports/transaction-runner.port";

export class MikroTransactionRunner implements TransactionRunnerPort {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly lockTimeoutMs = Number(process.env.DB_LOCK_TIMEOUT_MS ?? "2000"),
    private readonly statementTimeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? "10000"),
    private readonly maxAttempts = Number(process.env.DB_TRANSACTION_RETRIES ?? "3"),
    private readonly retryBackoffMs = Number(process.env.DB_TRANSACTION_RETRY_BACKOFF_MS ?? "10"),
  ) {}

  async run<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const fork = this.entityManager.fork({ clear: true });
      try {
        return await fork.transactional(async (transactionManager) => {
          const transactionContext = transactionManager.getTransactionContext();
          await transactionManager.getConnection().execute(
            `set local lock_timeout = '${this.lockTimeoutMs}ms'`,
            [],
            "all",
            transactionContext,
          );
          await transactionManager.getConnection().execute(
            `set local statement_timeout = '${this.statementTimeoutMs}ms'`,
            [],
            "all",
            transactionContext,
          );
          const sql: SqlTransaction = {
            execute: async <R extends Record<string, unknown>>(
              statement: string,
              params: readonly unknown[] = [],
            ) => {
              const expanded: unknown[] = [];
              const query = statement.replace(/\$(\d+)/g, (_match, index: string) => {
                expanded.push(params[Number(index) - 1]);
                return "?";
              });
              return transactionManager.getConnection().execute<R[]>(
                query,
                expanded,
                "all",
                transactionContext,
              );
            },
          };
          return work(sql);
        });
      } catch (error) {
        if (isTransientPostgresError(error)) {
          if (attempt < this.maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, this.retryBackoffMs * attempt));
            continue;
          }
          throw new InfrastructureTransientError("transient PostgreSQL failure", { cause: error });
        }
        throw error;
      }
    }
    throw new InfrastructureTransientError("transaction retry limit exhausted");
  }
}
