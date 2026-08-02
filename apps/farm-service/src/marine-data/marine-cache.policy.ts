import { Injectable } from '@nestjs/common';

export type MarineCacheSubject = 'render';

export interface MarineCacheHeaders {
  readonly cacheControl: string;
  readonly vary: readonly string[];
}
const AUTHENTICATED_RESPONSE_VARY = ['Authorization', 'Cookie'] as const;

@Injectable()
export class MarineCachePolicy {
  headersFor(_subject: MarineCacheSubject, status = 200): MarineCacheHeaders {
    if (status < 200 || status >= 300) {
      return this.noStore();
    }

    return this.noStore();
  }

  private noStore(): MarineCacheHeaders {
    return {
      cacheControl: 'no-store',
      vary: AUTHENTICATED_RESPONSE_VARY,
    };
  }
}
