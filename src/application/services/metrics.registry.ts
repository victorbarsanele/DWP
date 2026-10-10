export type CounterMetricName =
  | "idempotency_duplicates_total"
  | "inbox_duplicates_total"
  | "retries_total"
  | "database_lock_conflicts_total"
  | "reconciliation_divergences_total"
  | "outbox_publish_failures_total";

export class MetricsRegistry {
  private readonly counters = new Map<CounterMetricName, number>([
    ["idempotency_duplicates_total", 0],
    ["inbox_duplicates_total", 0],
    ["retries_total", 0],
    ["database_lock_conflicts_total", 0],
    ["reconciliation_divergences_total", 0],
    ["outbox_publish_failures_total", 0],
  ]);
  private processingCount = 0;
  private processingDurationSumMs = 0;

  increment(name: CounterMetricName): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  observeWagerProcessingDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error("wager processing duration must be a finite non-negative number");
    }
    this.processingCount += 1;
    this.processingDurationSumMs += durationMs;
  }

  renderPrometheus(operational?: {
    statuses: { status: string; count: string }[];
    outboxLagSeconds: string;
    deadLetterMessages: number;
  }): string {
    const counters = [...this.counters.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `# TYPE ${name} counter\n${name} ${value}`);
    counters.push(
      "# TYPE wager_processing_duration_ms summary",
      `wager_processing_duration_ms_count ${this.processingCount}`,
      `wager_processing_duration_ms_sum ${this.processingDurationSumMs.toFixed(3)}`,
    );
    if (operational !== undefined) {
      counters.push("# TYPE wager_transactions gauge");
      for (const { status, count } of operational.statuses) {
        counters.push(`wager_transactions{status="${status}"} ${count}`);
      }
      counters.push(
        "# TYPE outbox_oldest_pending_age_seconds gauge",
        `outbox_oldest_pending_age_seconds ${Number(operational.outboxLagSeconds)}`,
        "# TYPE sqs_dead_letter_messages gauge",
        `sqs_dead_letter_messages ${operational.deadLetterMessages}`,
      );
    }
    return counters.join("\n");
  }
}
