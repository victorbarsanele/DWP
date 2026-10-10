import { FailureCode, FAILURE_METADATA } from "../domain/shared/failure-code";

export class HttpFailure extends Error {
  constructor(
    readonly failureCode: FailureCode,
    message: string,
    readonly fields?: string[],
  ) {
    super(message);
    this.name = "HttpFailure";
  }
}

export function failureBody(failureCode: FailureCode, message: string, fields?: string[]) {
  const metadata = FAILURE_METADATA[failureCode];
  return {
    code: failureCode,
    failureCode,
    retryable: metadata.retryable,
    message,
    ...(fields === undefined ? {} : { fields }),
  };
}
