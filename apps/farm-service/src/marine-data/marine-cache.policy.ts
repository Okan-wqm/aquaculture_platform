import { Injectable } from '@nestjs/common';

export type MarineCacheSubject =
  | 'layers'
  | 'availability'
  | 'tile'
  | 'point-query'
  | 'aoi-analysis';

export interface MarineCacheHeaders {
  readonly cacheControl: string;
  readonly vary: readonly string[];
}

const PRIVATE_TILE_MAX_AGE_SECONDS = 900;
const PRIVATE_TILE_STALE_REVALIDATE_SECONDS = 300;
const PRIVATE_CATALOG_MAX_AGE_SECONDS = 300;
const PRIVATE_AVAILABILITY_MAX_AGE_SECONDS = 60;
const AUTHENTICATED_RESPONSE_VARY = ['Authorization', 'Cookie'] as const;

@Injectable()
export class MarineCachePolicy {
  headersFor(subject: MarineCacheSubject, status = 200): MarineCacheHeaders {
    if (status < 200 || status >= 300) {
      return this.noStore();
    }

    switch (subject) {
      case 'tile':
        return this.privateCache(
          PRIVATE_TILE_MAX_AGE_SECONDS,
          PRIVATE_TILE_STALE_REVALIDATE_SECONDS,
        );
      case 'layers':
        return this.privateCache(PRIVATE_CATALOG_MAX_AGE_SECONDS);
      case 'availability':
        return this.privateCache(PRIVATE_AVAILABILITY_MAX_AGE_SECONDS);
      case 'point-query':
      case 'aoi-analysis':
        return this.noStore();
    }
  }

  private privateCache(maxAgeSeconds: number, staleWhileRevalidateSeconds?: number): MarineCacheHeaders {
    const directives = [
      'private',
      `max-age=${maxAgeSeconds}`,
      ...(staleWhileRevalidateSeconds === undefined
        ? []
        : [`stale-while-revalidate=${staleWhileRevalidateSeconds}`]),
    ];
    return {
      cacheControl: directives.join(', '),
      vary: AUTHENTICATED_RESPONSE_VARY,
    };
  }

  private noStore(): MarineCacheHeaders {
    return {
      cacheControl: 'no-store',
      vary: AUTHENTICATED_RESPONSE_VARY,
    };
  }
}
