/**
 * ProtocolResolutionService pinleri (W3).
 *
 * Üç canlı kusurun kök nedeni tek çözücünün olmamasıydı:
 *  - manuel geçiş bandı feedId'den seçiyordu → aynı pellet iki bandda
 *    kullanıldığında yanlış oran kilitleniyordu (FARM-MEDIUM-251);
 *  - 06:00 üretimi `autoTransition` ayarını hiç okumuyordu → operatörün
 *    manuel seçimi ertesi sabah eziliyordu (FARM-LOW-262);
 *  - band geçişinde FCR yenilenmiyordu → büyüme ~%55 sapıyordu
 *    (FARM-MEDIUM-252).
 */
import {
  ProtocolResolutionInput,
  ProtocolResolutionService,
} from '../services/protocol-resolution.service';
import { ProtocolRateService } from '../services/protocol-rate.service';
import {
  FcrResolvedSource,
  ProtocolBand,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';

function band(over: Partial<ProtocolBand>): ProtocolBand {
  return {
    minWeightG: 0,
    maxWeightG: 50,
    feedId: 'feed-a',
    feedCode: 'FA',
    feedName: 'Feed A',
    feedingRatePercent: 4,
    expectedFcr: 0.9,
    ...over,
  } as ProtocolBand;
}

/** band0: 0–50 F1 %4 FCR 0.9 | band1: 50–150 F1 %3 FCR 1.4 | band2: 150+ F2 %2 */
const BANDS: ProtocolBand[] = [
  band({}),
  band({
    minWeightG: 50,
    maxWeightG: 150,
    feedingRatePercent: 3,
    expectedFcr: 1.4,
  }),
  band({
    minWeightG: 150,
    maxWeightG: 5000,
    feedId: 'feed-b',
    feedCode: 'FB',
    feedName: 'Feed B',
    feedingRatePercent: 2,
    expectedFcr: 1.6,
  }),
];

// The fixture is declared AT the input contract the resolver reads, so no cast
// is needed at all: the four members are exactly `ProtocolResolutionInput`'s
// protocol slice, and a change to `ProtocolSettings` breaks this factory at
// compile time instead of reaching `resolve()` as a shape it cannot use.
function makeProtocol(
  over: { autoTransition?: boolean; transitionBufferG?: number } = {},
): ProtocolResolutionInput['protocol'] {
  return {
    bands: BANDS,
    temperatureAdjustments: [],
    fcrMatrix: undefined,
    settings: {
      autoTransition: over.autoTransition ?? true,
      transitionBufferG: over.transitionBufferG ?? 20,
      growthApplicationMode: 'per_meal' as const,
      underfeedAlertThresholdPercent: 15,
      fcrSource: ProtocolFcrSource.BAND,
    },
  };
}

const NO_TEMPERATURE = { celsius: null, source: 'none' as const };

describe('ProtocolResolutionService', () => {
  const service = new ProtocolResolutionService(new ProtocolRateService());

  it('band tabanı TANK ORTALAMASIDIR (karar: dominant-biomass değil)', () => {
    expect(service.resolveBandBasisWeight({ avgWeightG: 87.5 })).toBe(87.5);
  });

  it('FCR bandla BİRLİKTE yenilenir — geçişte eski bandın FCR&#39;ı kullanılmaz', () => {
    const inBand0 = service.resolve({
      protocol: makeProtocol(),
      assignment: { overrides: {}, currentBandIndex: 0, currentFeedId: 'feed-a' },
      bandBasisWeightG: 30,
      temperature: NO_TEMPERATURE,
    });
    const inBand1 = service.resolve({
      protocol: makeProtocol(),
      assignment: { overrides: {}, currentBandIndex: 0, currentFeedId: 'feed-a' },
      bandBasisWeightG: 90, // band1'e buffer'ı aşarak girdi
      temperature: NO_TEMPERATURE,
    });

    expect(inBand0?.expectedFcr).toBe(0.9);
    expect(inBand0?.fcrResolvedSource).toBe(FcrResolvedSource.BAND);
    // Eski davranış: snapshot donduğu için burada da 0.9 kullanılıyordu →
    // o öğünün büyümesi ~%55 fazla hesaplanıyordu.
    expect(inBand1?.expectedFcr).toBe(1.4);
    expect(inBand1?.bandIndex).toBe(1);
    expect(inBand1?.bandChanged).toBe(true);
  });

  it('histerezis: buffer içinde MEVCUT band korunur (salınım yok)', () => {
    const result = service.resolve({
      protocol: makeProtocol({ transitionBufferG: 20 }),
      assignment: { overrides: {}, currentBandIndex: 0, currentFeedId: 'feed-a' },
      bandBasisWeightG: 60, // band1 sınırı 50; 50+20=70'in altında
      temperature: NO_TEMPERATURE,
    });
    expect(result?.bandIndex).toBe(0);
    expect(result?.bandChanged).toBe(false);
  });

  it('autoTransition=false: mevcut band KORUNUR — manuel seçim ezilmez (FARM-LOW-262)', () => {
    const result = service.resolve({
      protocol: makeProtocol({ autoTransition: false }),
      assignment: { overrides: {}, currentBandIndex: 0, currentFeedId: 'feed-a' },
      bandBasisWeightG: 400, // ağırlık band2'yi işaret ediyor
      temperature: NO_TEMPERATURE,
    });
    expect(result?.bandIndex).toBe(0);
    expect(result?.feed.id).toBe('feed-a');
  });

  it('autoTransition=false ve mevcut band yoksa ağırlıktan çözülür (ilk plan)', () => {
    const result = service.resolve({
      protocol: makeProtocol({ autoTransition: false }),
      assignment: { overrides: {}, currentBandIndex: undefined, currentFeedId: undefined },
      bandBasisWeightG: 400,
      temperature: NO_TEMPERATURE,
    });
    expect(result?.bandIndex).toBe(2);
  });

  describe('resolveManualTransitionBand (FARM-MEDIUM-251)', () => {
    it('aynı yem iki bandda: AĞIRLIĞA karşılık gelen band seçilir, ilk eşleşme değil', () => {
      // 60 g → band1 (50–150, %3). feedId'den seçen eski kod band0'ı (%4)
      // kilitliyor ve balık %33 fazla besleniyordu.
      expect(service.resolveManualTransitionBand(BANDS, 60, 'feed-a')).toBe(1);
    });

    it('komşu banda manuel geçişe izin verir (operatör erken/geç geçiş yapabilir)', () => {
      expect(service.resolveManualTransitionBand(BANDS, 140, 'feed-b')).toBe(2);
    });

    it('ağırlıktan uzak bandın yemine geçiş REDDEDİLİR (null)', () => {
      // 10 g balık → band0; feed-b band2'nin yemi, komşu değil.
      expect(service.resolveManualTransitionBand(BANDS, 10, 'feed-b')).toBeNull();
    });

    it('protokolde olmayan yem REDDEDİLİR', () => {
      expect(service.resolveManualTransitionBand(BANDS, 60, 'feed-zzz')).toBeNull();
    });
  });
});
