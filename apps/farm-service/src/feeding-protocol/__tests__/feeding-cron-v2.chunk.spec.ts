/**
 * MealWindowUpcoming toplu şekli (K-2): 500 girdi/event cap + devam
 * event'leri. Cap sabiti wire-schema validator'ıyla AYNI değerdir — şekil
 * sonradan değiştirilemez (breaking).
 *
 * + NFR 4. toplu okuma yardımcıları (fcrSource=feed yem matrisleri):
 *   collectFeedSourceFeedIds / buildFeedFcrMatrixMap — saf, spec pinli.
 */
import {
  chunkWindowEntries,
  MEAL_WINDOW_MAX_ENTRIES,
} from '../services/feeding-cron-v2.service';
import {
  buildFeedFcrMatrixMap,
  collectFeedSourceFeedIds,
} from '../services/feed-fcr-source.util';
import {
  FeedingProtocolV2,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';
import { Feed } from '../../feed/entities/feed.entity';

describe('chunkWindowEntries (K-2 batched window shape)', () => {
  it('caps each event at 500 entries with continuation batches', () => {
    const entries = Array.from({ length: 1201 }, (_, i) => i);
    const chunks = chunkWindowEntries(entries, MEAL_WINDOW_MAX_ENTRIES);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(201);
    // Sıra korunur — batchIndex tüketici için deterministiktir.
    expect(chunks[2]![0]).toBe(1000);
  });

  it('returns no batches for an empty window (no empty events on the wire)', () => {
    expect(chunkWindowEntries([], MEAL_WINDOW_MAX_ENTRIES)).toEqual([]);
  });

  it('keeps the 1000-unit common-first-meal case within a small batch count', () => {
    const chunks = chunkWindowEntries(Array.from({ length: 1000 }, (_, i) => i), MEAL_WINDOW_MAX_ENTRIES);
    expect(chunks).toHaveLength(2);
  });
});

describe('feed FCR matrix bulk-read helpers (NFR 4. toplu okuma)', () => {
  const protocol = (
    fcrSource: ProtocolFcrSource,
    feedIds: string[],
  ): Pick<FeedingProtocolV2, 'bands' | 'settings'> => ({
    bands: feedIds.map((feedId, index) => ({
      minWeightG: index * 100,
      maxWeightG: (index + 1) * 100,
      feedId,
      feedCode: `F${index}`,
      feedName: `Feed ${index}`,
      feedingRatePercent: 2,
      expectedFcr: 1.2,
    })),
    settings: {
      autoTransition: true,
      transitionBufferG: 10,
      growthApplicationMode: 'per_meal',
      underfeedAlertThresholdPercent: 15,
      fcrSource,
    },
  });

  it('collectFeedSourceFeedIds yalnız fcrSource=feed protokollerin band yemlerini, tekilleştirerek toplar', () => {
    const ids = collectFeedSourceFeedIds([
      protocol(ProtocolFcrSource.FEED, ['feed-a', 'feed-b']),
      protocol(ProtocolFcrSource.FEED, ['feed-b', 'feed-c']),
      protocol(ProtocolFcrSource.BAND, ['feed-x']),
      protocol(ProtocolFcrSource.MATRIX, ['feed-y']),
    ]);
    expect(ids.sort()).toEqual(['feed-a', 'feed-b', 'feed-c']);
  });

  it('collectFeedSourceFeedIds feed kaynaklı protokol yoksa boş döner (sorgu atılmaz sinyali)', () => {
    expect(collectFeedSourceFeedIds([protocol(ProtocolFcrSource.BAND, ['feed-x'])])).toEqual([]);
  });

  it('buildFeedFcrMatrixMap fcrMatrix taşıyan yemleri FcrMatrix şekline çevirir, taşımayanları haritaya almaz', () => {
    const withMatrix: Pick<Feed, 'id' | 'feedingMatrix2D'> = {
      id: 'feed-a',
      feedingMatrix2D: {
        temperatures: [10, 14],
        weights: [100, 200],
        rates: [
          [2.5, 2.0],
          [3.0, 2.4],
        ],
        fcrMatrix: [
          [1.0, 1.4],
          [1.1, 1.5],
        ],
      },
    };
    const withoutFcr: Pick<Feed, 'id' | 'feedingMatrix2D'> = {
      id: 'feed-b',
      feedingMatrix2D: {
        temperatures: [10],
        weights: [100],
        rates: [[2.5]],
      },
    };
    const noMatrix: Pick<Feed, 'id' | 'feedingMatrix2D'> = { id: 'feed-c' };

    const map = buildFeedFcrMatrixMap([withMatrix, withoutFcr, noMatrix]);

    expect([...map.keys()]).toEqual(['feed-a']);
    expect(map.get('feed-a')).toEqual({
      temperatures: [10, 14],
      weights: [100, 200],
      fcrValues: [
        [1.0, 1.4],
        [1.1, 1.5],
      ],
    });
  });
});
