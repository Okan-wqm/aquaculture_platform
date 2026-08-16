/**
 * fcrSource=feed FCR çözümünün saf yardımcıları — cron üretimi (06:00),
 * K-9 admin aksiyonları VE tükenme tahmini (Faz 7) aynı toplu-okuma
 * girdisini buradan kurar. Scheduled operation ile forecast projection
 * arasındaki döngüsel importu kırmak için servis dosyasından taşındı;
 * davranış birebir (scheduled-feeding-operation.chunk.spec.ts pinler).
 *
 * @module FeedingProtocol/Services
 */
import { Feed } from '../../feed/entities/feed.entity';
import {
  FcrMatrix,
  FeedingProtocolV2,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';

/**
 * fcrSource=feed protokollerin band yem kimlikleri — sayfa başına tek IN
 * sorgusunun girdisi (NFR 4. toplu okuma) — SAF (spec pinli).
 */
export function collectFeedSourceFeedIds(
  protocols: Array<Pick<FeedingProtocolV2, 'bands' | 'settings'>>,
): string[] {
  return [
    ...new Set(
      protocols
        .filter((p) => p.settings.fcrSource === ProtocolFcrSource.FEED)
        .flatMap((p) => p.bands.map((band) => band.feedId)),
    ),
  ];
}

/**
 * Feed.feedingMatrix2D.fcrMatrix taşıyan yemlerden FcrMatrix haritası — SAF
 * (spec pinli). Matrissiz yem haritaya girmez: resolveExpectedFcr band
 * fallback'ini provenanslı (source=BAND) uygular, sessiz sapma yok.
 */
export function buildFeedFcrMatrixMap(
  feeds: Array<Pick<Feed, 'id' | 'feedingMatrix2D'>>,
): Map<string, FcrMatrix> {
  const map = new Map<string, FcrMatrix>();
  for (const feed of feeds) {
    const matrix = feed.feedingMatrix2D;
    if (matrix?.fcrMatrix?.length) {
      map.set(feed.id, {
        temperatures: matrix.temperatures,
        weights: matrix.weights,
        fcrValues: matrix.fcrMatrix,
      });
    }
  }
  return map;
}
