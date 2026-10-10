export interface SqlTransaction {
  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

export interface TransactionRunnerPort {
  run<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}

export class InfrastructureTransientError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InfrastructureTransientError";
  }
}

export function isTransientPostgresError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "40001"
    || code === "40P01"
    || code === "55P03"
    || code === "57014"
    || code?.startsWith("08") === true
    || code?.startsWith("53") === true;
}
