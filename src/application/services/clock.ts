import { ClockPort } from "../ports/id-clock.port";

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

export class RandomIdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}
