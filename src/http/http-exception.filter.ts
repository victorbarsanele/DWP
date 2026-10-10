import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { InfrastructureTransientError } from "../application/ports/transaction-runner.port";
import { FailureCode, FAILURE_METADATA } from "../domain/shared/failure-code";
import { HttpValidationError } from "./validation";
import { failureBody, HttpFailure } from "./http-errors";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => void;
      header: (name: string, value: string) => void;
      json: (body: unknown) => void;
    }>();
    if (exception instanceof InfrastructureTransientError) {
      response.header("Retry-After", "1");
      response.status(503);
      response.json(failureBody(FailureCode.InfrastructureTransient, "Transient infrastructure failure"));
      return;
    }
    if (exception instanceof HttpValidationError) {
      response.status(400);
      response.json(failureBody(FailureCode.ValidationError, exception.message, exception.fields));
      return;
    }
    if (exception instanceof HttpFailure) {
      response.status(FAILURE_METADATA[exception.failureCode].httpStatus);
      response.json(failureBody(exception.failureCode, exception.message, exception.fields));
      return;
    }
    if (exception instanceof SyntaxError) {
      response.status(400);
      response.json(failureBody(FailureCode.ValidationError, "Malformed JSON"));
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = exception.message;
      response.status(status);
      response.json({
        code: status >= 500 ? FailureCode.PermanentInfrastructureFailure : FailureCode.ValidationError,
        failureCode: status >= 500
          ? FailureCode.PermanentInfrastructureFailure
          : FailureCode.ValidationError,
        retryable: false,
        message: status >= 500 ? "Unexpected server error" : message,
      });
      return;
    }
    const code = (exception as { message?: string })?.message as FailureCode;
    if (Object.prototype.hasOwnProperty.call(FAILURE_METADATA, code)) {
      const metadata = FAILURE_METADATA[code];
      response.status(metadata.httpStatus);
      response.json(failureBody(code, code));
      return;
    }
    response.status(500);
    response.json(failureBody(FailureCode.PermanentInfrastructureFailure, "Unexpected server error"));
  }
}
