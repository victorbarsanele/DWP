import {
  Controller,
  Get,
  Res,
} from "@nestjs/common";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { HttpQueryService } from "./query.service";
import { SqsQueueProvisioner } from "../infrastructure/messaging/sqs/sqs-queue-provisioner";
import { MetricsRegistry } from "../application/services/metrics.registry";

type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): void;
};

@Controller()
export class OperationsController {
  constructor(
    private readonly queries: HttpQueryService,
    private readonly metrics: MetricsRegistry,
    private readonly client: SQSClient,
    private readonly queues: SqsQueueProvisioner,
  ) {}

  @Get("health/live")
  live() {
    return { status: "alive" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) response: ResponseLike) {
    const [database, sqs] = await Promise.all([
      this.check("postgresql", () => this.queries.ping()),
      this.check("sqs", async () => {
        const urls = await this.queues.ensureQueues();
        await Promise.all(Object.values(urls).map((QueueUrl) =>
          this.client.send(new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ["QueueArn"],
          })),
        ));
      }),
    ]);
    const ready = database === "up" && sqs === "up";
    response.statusCode = ready ? 200 : 503;
    return {
      status: ready ? "ready" : "not_ready",
      dependencies: { postgresql: database, sqs },
    };
  }

  @Get("metrics")
  async metricsEndpoint(@Res({ passthrough: true }) response: ResponseLike): Promise<string> {
    const [databaseMetrics, urls] = await Promise.all([
      this.queries.operationalMetrics(),
      this.queues.ensureQueues(),
    ]);
    const dlq = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: urls.deadLetter,
      AttributeNames: ["ApproximateNumberOfMessages"],
    }));
    const rawDeadLetterMessages = dlq.Attributes?.ApproximateNumberOfMessages;
    if (rawDeadLetterMessages === undefined) {
      throw new Error("SQS did not return dead-letter queue message count");
    }
    const deadLetterMessages = Number(rawDeadLetterMessages);
    if (!Number.isSafeInteger(deadLetterMessages) || deadLetterMessages < 0) {
      throw new Error("SQS returned invalid dead-letter queue message count");
    }
    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return this.metrics.renderPrometheus({ ...databaseMetrics, deadLetterMessages });
  }

  private async check(name: string, operation: () => Promise<unknown>): Promise<"up" | "down"> {
    try {
      await operation();
      return "up";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ dependency: name, readiness: "down", error: message }));
      return "down";
    }
  }
}
