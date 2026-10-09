import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";

const client = new SQSClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const suffix = Date.now().toString();
const sourceName = `spike-source-${suffix}.fifo`;
const dlqName = `spike-dlq-${suffix}.fifo`;
const dedupName = `spike-dedup-${suffix}.fifo`;
const sigtermName = `spike-sigterm-${suffix}.fifo`;

async function createFifo(name: string, attributes: Record<string, string> = {}) {
  const result = await client.send(new CreateQueueCommand({
    QueueName: name,
    Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", ...attributes },
  }));
  if (!result.QueueUrl) throw new Error(`queue URL missing for ${name}`);
  return result.QueueUrl;
}

async function queueArn(url: string): Promise<string> {
  const result = await client.send(new GetQueueAttributesCommand({
    QueueUrl: url,
    AttributeNames: ["QueueArn"],
  }));
  const arn = result.Attributes?.QueueArn;
  if (!arn) throw new Error("queue ARN missing");
  return arn;
}

async function receive(url: string, visibilityTimeout = 1): Promise<Message | undefined> {
  const result = await client.send(new ReceiveMessageCommand({
    QueueUrl: url,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 1,
    VisibilityTimeout: visibilityTimeout,
  }));
  return result.Messages?.[0];
}

const dlqUrl = await createFifo(dlqName);
const dlqArn = await queueArn(dlqUrl);
const sourceUrl = await createFifo(sourceName, {
  VisibilityTimeout: "1",
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "2" }),
});
const dedupUrl = await createFifo(dedupName);
const sigtermUrl = await createFifo(sigtermName);

await client.send(new SendMessageCommand({
  QueueUrl: sourceUrl,
  MessageBody: "redelivery",
  MessageGroupId: "wallet-redelivery",
  MessageDeduplicationId: "redelivery-1",
}));
const first = await receive(sourceUrl, 1);
await new Promise((resolve) => setTimeout(resolve, 1_500));
const second = await receive(sourceUrl, 1);
console.log(JSON.stringify({
  redelivery: {
    firstMessageId: first?.MessageId,
    secondMessageId: second?.MessageId,
    sameMessage: first?.MessageId === second?.MessageId,
  },
}));
if (second?.ReceiptHandle) {
  await client.send(new DeleteMessageCommand({ QueueUrl: sourceUrl, ReceiptHandle: second.ReceiptHandle }));
}

await client.send(new SendMessageCommand({
  QueueUrl: sourceUrl,
  MessageBody: "dead-letter",
  MessageGroupId: "wallet-dlq",
  MessageDeduplicationId: "dead-letter-1",
}));
const dlqAttempts: number[] = [];
for (let attempt = 1; attempt <= 4; attempt += 1) {
  const message = await receive(sourceUrl, 1);
  if (message) {
    dlqAttempts.push(attempt);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}
const deadLetter = await receive(dlqUrl, 1);
console.log(JSON.stringify({
  deadLetter: {
    attemptsWithoutAck: dlqAttempts,
    deliveredToDlq: deadLetter?.Body,
  },
}));
if (deadLetter?.ReceiptHandle) {
  await client.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: deadLetter.ReceiptHandle }));
}

for (let index = 0; index < 2; index += 1) {
  await client.send(new SendMessageCommand({
    QueueUrl: dedupUrl,
    MessageBody: `dedup-${index}`,
    MessageGroupId: "wallet-dedup",
    MessageDeduplicationId: "same-dedup-id",
  }));
}
const dedupMessages: Message[] = [];
for (let index = 0; index < 2; index += 1) {
  const message = await receive(dedupUrl);
  if (message) {
    dedupMessages.push(message);
    await client.send(new DeleteMessageCommand({
      QueueUrl: dedupUrl,
      ReceiptHandle: message.ReceiptHandle!,
    }));
  }
}
console.log(JSON.stringify({
  sqsDedup: { sent: 2, received: dedupMessages.length, bodies: dedupMessages.map((message) => message.Body) },
}));

await client.send(new SendMessageCommand({
  QueueUrl: sourceUrl,
  MessageBody: "head-first",
  MessageGroupId: "wallet-hol",
  MessageDeduplicationId: "hol-1",
}));
await client.send(new SendMessageCommand({
  QueueUrl: sourceUrl,
  MessageBody: "head-second",
  MessageGroupId: "wallet-hol",
  MessageDeduplicationId: "hol-2",
}));
const holFirst = await receive(sourceUrl, 5);
const holBlocked = await receive(sourceUrl, 1);
if (holFirst?.ReceiptHandle) {
  await client.send(new DeleteMessageCommand({ QueueUrl: sourceUrl, ReceiptHandle: holFirst.ReceiptHandle }));
}
const holAfterAck = await receive(sourceUrl, 1);
console.log(JSON.stringify({
  headOfLine: {
    first: holFirst?.Body,
    whileInvisible: holBlocked?.Body ?? null,
    afterAck: holAfterAck?.Body ?? null,
  },
}));
if (holAfterAck?.ReceiptHandle) {
  await client.send(new DeleteMessageCommand({ QueueUrl: sourceUrl, ReceiptHandle: holAfterAck.ReceiptHandle }));
}

await client.send(new SendMessageCommand({
  QueueUrl: sigtermUrl,
  MessageBody: "sigterm-message",
  MessageGroupId: "wallet-sigterm",
  MessageDeduplicationId: "sigterm-1",
}));
const child = Bun.spawn(["bun", "run", "src/sqs-consumer.ts", sigtermUrl], {
  stdout: "pipe",
  stderr: "pipe",
});
await new Promise((resolve) => setTimeout(resolve, 2_000));
child.kill("SIGTERM");
await child.exited;
const childOutput = await new Response(child.stdout).text();
const returned = await receive(sigtermUrl, 1);
console.log(JSON.stringify({
  sigterm: {
    childOutput: childOutput.trim(),
    messageVisibleAfterShutdown: returned?.Body ?? null,
  },
}));
if (returned?.ReceiptHandle) {
  await client.send(new DeleteMessageCommand({ QueueUrl: sigtermUrl, ReceiptHandle: returned.ReceiptHandle }));
}

for (const url of [sourceUrl, dlqUrl, dedupUrl, sigtermUrl]) {
  await client.send(new DeleteQueueCommand({ QueueUrl: url }));
}
await client.destroy();
