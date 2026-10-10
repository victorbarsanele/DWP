export interface ClockPort {
  now(): Date;
}

export interface IdGeneratorPort {
  next(): string;
}
