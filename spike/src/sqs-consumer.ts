import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const queueUrl = process.argv[2];
if (!queueUrl) throw new Error("queue URL required");
const client = new SQSClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
let currentReceipt: string | undefined;
let stopping = false;

process.on("SIGTERM", async () => {
  stopping = true;
  if (currentReceipt) {
    await client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: currentReceipt,
      VisibilityTimeout: 0,
    }));
    console.log("sigterm:visibility-returned");
  }
  await client.destroy();
  process.exit(0);
});

while (!stopping) {
  const response = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 1,
    VisibilityTimeout: 30,
  }));
  const message = response.Messages?.[0];
  if (!message?.ReceiptHandle) continue;
  currentReceipt = message.ReceiptHandle;
  console.log(`consumer:received:${message.Body}`);
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  if (!stopping) {
    await client.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: currentReceipt,
    }));
    currentReceipt = undefined;
  }
}
