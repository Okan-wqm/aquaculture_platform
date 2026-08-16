import { Injectable, type Provider } from '@nestjs/common';

export const FEEDING_CLOCK_PORT = Symbol('FEEDING_CLOCK_PORT');

/** One explicit wall-clock capability for scheduler cut creation. */
export interface FeedingClockPort {
  now(): Date;
}

@Injectable()
export class SystemFeedingClock implements FeedingClockPort {
  now(): Date {
    return new Date();
  }
}

export const FEEDING_CLOCK_PROVIDER: Provider = Object.freeze({
  provide: FEEDING_CLOCK_PORT,
  useClass: SystemFeedingClock,
});
