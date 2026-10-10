export interface AppConfig {
  nodeEnv: string;
  databaseUrl?: string;
  testDatabaseUrl: string;
  port: number;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  sqs: {
    endpoint: string;
    region: string;
  };
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(name: string, fallback: string): number {
  const value = Number.parseInt(required(name, fallback), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid positive integer environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const databaseUrl = process.env.DATABASE_URL;
  return {
    nodeEnv: required("NODE_ENV", "development"),
    port: integer("PORT", "3000"),
    databaseUrl,
    testDatabaseUrl: required(
      "TEST_DATABASE_URL",
      "postgresql://spike:spike@127.0.0.1:55432/spike_test",
    ),
    database: {
      host: required("DATABASE_HOST", "127.0.0.1"),
      port: integer("DATABASE_PORT", "55432"),
      name: required("DATABASE_NAME", "spike"),
      user: required("DATABASE_USER", "spike"),
      password: required("DATABASE_PASSWORD", "spike"),
    },
    sqs: {
      endpoint: required("SQS_ENDPOINT", "http://127.0.0.1:4566"),
      region: required("AWS_REGION", "us-east-1"),
    },
  };
}
