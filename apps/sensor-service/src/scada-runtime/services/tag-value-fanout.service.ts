/**
 * TagValueFanoutService — the live-data PRODUCER for the /scada control plane.
 *
 * The operator runtime subscribes to tags by canonical TagRef (the registry
 * fqn, `deviceCode/localName`), but the ingestion plane keys every metric by
 * `sensorId/channelId`. Until this service existed NOTHING bridged the two:
 * `gateway.pushTagValues` had zero production callers, so operator screens
 * authenticated, subscribed, and then showed null forever (SENSOR-HIGH-046).
 *
 * Responsibilities:
 *  1. Resolve `(tenantId, sensorId, channelId)` → registry fqn(s) via the
 *     UnifiedTag registry's `source.sensorId/channelId` linkage.
 *  2. Cache that resolution (positive AND negative) with a short TTL so the
 *     per-metric hot path stays off the database. Sensors without a registry
 *     tag are the common case on day one — the negative cache makes them one
 *     query per TTL window, not one per reading.
 *  3. Push the mapped TagValueChange batch through the gateway's tenant-fenced
 *     routing (`pushTagValues` — which also updates the TagManager value cache
 *     so late subscribers get the last value on subscribe).
 *
 * fanoutMetric NEVER throws: fan-out is best-effort by design. A failure here
 * must not poison the ingestion path (JetStream redelivery would replay the
 * same failure forever).
 */

import { Injectable, Logger } from '@nestjs/common';

import { UnifiedTagService } from '../../process/services/unified-tag.service';
import type { TagQuality, TagValueChange } from '../scada-types';

import { ScadaRuntimeGateway } from '../scada-runtime.gateway';

/** One ingested metric, as the ingestion consumer sees it. */
export interface IngestedMetricForFanout {
  tenantId: string;
  sensorId: string;
  channelId: string;
  value: number;
  /** ms-epoch producer timestamp. */
  timestampMs: number;
  /** IEC 61131-3 subset 0..=3 (good / uncertain / bad / not-connected). */
  qualityCode: number;
}

interface CacheEntry {
  fqns: string[];
  expiresAt: number;
}

/** Staleness upper bound for the (sensor,channel)→fqn resolution. */
const CACHE_TTL_MS = 60_000;

/** Hard cap on cache entries; oldest-inserted evicted beyond this. */
const CACHE_MAX_ENTRIES = 10_000;

/**
 * Map the wire quality code to the socket TagQuality.
 *
 * Primary contract: the Rust sidecar's IEC 61131-3 subset 0..=3
 * (0=good, 1=uncertain, 2=bad, 3=not-connected). Tolerated fallback: the
 * legacy OPC-UA ranges used elsewhere in this service (192..255 good,
 * 64..127 uncertain) so a future caller on the legacy path cannot mislabel
 * good data as bad.
 */
export function mapQualityCode(code: number): TagQuality {
  if (code === 0 || (code >= 192 && code <= 255)) return 'good';
  if (code === 1 || (code >= 64 && code <= 127)) return 'uncertain';
  return 'bad';
}

@Injectable()
export class TagValueFanoutService {
  private readonly logger = new Logger(TagValueFanoutService.name);

  /** `${tenantId}\0${sensorId}\0${channelId}` → resolution (60s TTL). */
  private readonly cache = new Map<string, CacheEntry>();

  /** Fan-out counters, logged by the ingestion consumer's stats roll-up. */
  private pushedCount = 0;
  private unmappedCount = 0;

  constructor(
    private readonly unifiedTagService: UnifiedTagService,
    private readonly gateway: ScadaRuntimeGateway,
  ) {}

  /**
   * Resolve the metric to registry fqn(s) and push to subscribed sockets.
   * Best-effort: resolution/push failures are logged, never thrown.
   */
  async fanoutMetric(metric: IngestedMetricForFanout): Promise<void> {
    try {
      const fqns = await this.resolveFqns(
        metric.tenantId,
        metric.sensorId,
        metric.channelId,
      );
      if (fqns.length === 0) {
        this.unmappedCount++;
        return;
      }

      const quality = mapQualityCode(metric.qualityCode);
      const values: TagValueChange[] = fqns.map((fqn) => ({
        tagId: fqn,
        value: metric.value,
        timestamp: metric.timestampMs,
        quality,
      }));
      this.gateway.pushTagValues(metric.tenantId, values);
      this.pushedCount += values.length;
    } catch (error) {
      this.logger.warn(
        `fanoutMetric failed (sensor=${metric.sensorId} channel=${metric.channelId}): ${(error as Error).message}`,
      );
    }
  }

  /** Read-and-reset counters for the caller's periodic stats roll-up. */
  drainStats(): { pushed: number; unmapped: number } {
    const stats = { pushed: this.pushedCount, unmapped: this.unmappedCount };
    this.pushedCount = 0;
    this.unmappedCount = 0;
    return stats;
  }

  private async resolveFqns(
    tenantId: string,
    sensorId: string,
    channelId: string,
  ): Promise<string[]> {
    const key = `${tenantId}\0${sensorId}\0${channelId}`;
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.fqns;

    const fqns = await this.unifiedTagService.findFqnsBySensorSource(
      tenantId,
      sensorId,
      channelId,
    );

    // Cache positives AND negatives — unmapped sensors dominate until the
    // registry is populated, and each must cost one query per TTL, not one
    // per reading. Bounded: evict oldest-inserted beyond the cap.
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(key); // re-insert so refreshes move to the tail
    this.cache.set(key, { fqns, expiresAt: now + CACHE_TTL_MS });

    return fqns;
  }
}
