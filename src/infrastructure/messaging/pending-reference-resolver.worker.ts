import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";

export class PendingReferenceResolverWorker {
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly pollIntervalMs = 1000,
  ) {}

  start(): void {
    if (this.loop !== undefined) throw new Error("pending reference resolver is already running");
    this.stopping = false;
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.loop = undefined;
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const resolved = await this.useCase.resolveNextPendingReference();
        if (!resolved) await this.wait();
      } catch (error) {
        console.error(JSON.stringify({
          event: "pending_reference.resolution_failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        await this.wait();
      }
    }
  }

  private async wait(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
}
