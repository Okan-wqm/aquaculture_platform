/**
 * ProtocolValidationService — birleşik protokolün TEK doğrulama SSoT'si.
 *
 * Saf (DB'siz) servis: CRUD handler'ları kaydetmeden önce, migration
 * dönüştürücüsü taşımadan önce AYNI kuralları buradan geçirir — iki ayrı
 * doğrulama kopyası (v1'in program-entity + resolver ikiliği) burada biter.
 * Hata listesi döner (throw etmez) — çağıran bağlama uygun istisnayı seçer.
 *
 * Kural kaynakları: v1 `FeedingProgram.validateFeedAssignments` (boşluk/örtüşme)
 * + `validateFCRTable` portu; öğün planı kuralları plan §1.1 (K-18/D-15);
 * sınır sabitleri entity dosyasında (DoS cap'leri dahil).
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';

import {
  FcrMatrix,
  MealSchedule,
  MAX_EXPECTED_FCR,
  MAX_FCR_TEMPERATURES,
  MAX_FCR_WEIGHTS,
  MAX_FEEDING_RATE_PERCENT,
  MAX_MEALS_PER_DAY,
  MAX_PROTOCOL_BANDS,
  MAX_TEMP_MULTIPLIER,
  MIN_EXPECTED_FCR,
  MIN_TEMP_MULTIPLIER,
  ProtocolBand,
  ProtocolFcrSource,
  ProtocolSettings,
  TemperatureAdjustment,
} from '../entities/feeding-protocol-v2.entity';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const PERCENT_SUM_TOLERANCE = 0.01;

export interface ProtocolValidationInput {
  bands: ProtocolBand[];
  defaultMealSchedule: MealSchedule;
  settings: ProtocolSettings;
  temperatureAdjustments?: TemperatureAdjustment[];
  fcrMatrix?: FcrMatrix;
}

@Injectable()
export class ProtocolValidationService {
  /** Tüm kuralları çalıştırır; boş dizi = geçerli protokol. */
  validateProtocol(input: ProtocolValidationInput): string[] {
    const errors: string[] = [];
    this.validateBands(input.bands, errors);
    this.validateMealSchedule(input.defaultMealSchedule, 'defaultMealSchedule', errors);
    for (const [index, band] of input.bands.entries()) {
      if (band.mealSchedule) {
        this.validateMealSchedule(band.mealSchedule, `bands[${index}].mealSchedule`, errors);
      }
    }
    this.validateTemperatureAdjustments(input.temperatureAdjustments, errors);
    this.validateFcrMatrix(input.fcrMatrix, input.settings, errors);
    this.validateSettings(input.settings, errors);
    return errors;
  }

  private validateBands(bands: ProtocolBand[], errors: string[]): void {
    if (!bands?.length) {
      errors.push('bands: en az bir ağırlık bandı gerekli');
      return;
    }
    if (bands.length > MAX_PROTOCOL_BANDS) {
      errors.push(`bands: en fazla ${MAX_PROTOCOL_BANDS} band tanımlanabilir`);
    }

    const sorted = [...bands].sort((a, b) => a.minWeightG - b.minWeightG);
    for (const [i, band] of sorted.entries()) {
      const label = `bands[${i}] (${band.minWeightG}-${band.maxWeightG}g)`;
      if (!(band.minWeightG >= 0)) errors.push(`${label}: minWeightG negatif olamaz`);
      if (!(band.maxWeightG > band.minWeightG)) {
        errors.push(`${label}: maxWeightG, minWeightG'den büyük olmalı`);
      }
      if (!band.feedId) errors.push(`${label}: feedId zorunlu`);
      if (
        !(band.feedingRatePercent >= 0) ||
        band.feedingRatePercent > MAX_FEEDING_RATE_PERCENT
      ) {
        errors.push(
          `${label}: feedingRatePercent 0-${MAX_FEEDING_RATE_PERCENT} aralığında olmalı`,
        );
      }
      if (band.expectedFcr < MIN_EXPECTED_FCR || band.expectedFcr > MAX_EXPECTED_FCR) {
        errors.push(
          `${label}: expectedFcr ${MIN_EXPECTED_FCR}-${MAX_EXPECTED_FCR} aralığında olmalı`,
        );
      }

      const prev = i > 0 ? sorted[i - 1] : undefined;
      if (prev) {
        if (band.minWeightG < prev.maxWeightG) {
          errors.push(
            `bands: ${prev.maxWeightG}g sınırında örtüşme (overlap) — bantlar yarı-açık [min,max) olmalı`,
          );
        } else if (band.minWeightG > prev.maxWeightG) {
          errors.push(
            `bands: ${prev.maxWeightG}g ile ${band.minWeightG}g arasında boşluk (gap) — bantlar bitişik olmalı`,
          );
        }
      }
    }
  }

  private validateMealSchedule(schedule: MealSchedule, label: string, errors: string[]): void {
    if (
      !Number.isInteger(schedule.mealsPerDay) ||
      schedule.mealsPerDay < 1 ||
      schedule.mealsPerDay > MAX_MEALS_PER_DAY
    ) {
      errors.push(`${label}: mealsPerDay 1-${MAX_MEALS_PER_DAY} aralığında tam sayı olmalı`);
      return;
    }
    if (schedule.entries.length !== schedule.mealsPerDay) {
      errors.push(
        `${label}: entries sayısı (${schedule.entries.length}) mealsPerDay (${schedule.mealsPerDay}) ile eşit olmalı`,
      );
      return;
    }

    let previousMinutes = -1;
    let percentSum = 0;
    for (const [i, entry] of schedule.entries.entries()) {
      if (!TIME_PATTERN.test(entry.time)) {
        errors.push(`${label}.entries[${i}]: saat HH:mm formatında olmalı (${entry.time})`);
        continue;
      }
      const [hh = 0, mm = 0] = entry.time.split(':').map(Number);
      const minutes = hh * 60 + mm;
      if (minutes <= previousMinutes) {
        errors.push(`${label}: öğün saatleri kesin artan olmalı (${entry.time})`);
      }
      previousMinutes = minutes;
      if (!(entry.percentOfDaily > 0)) {
        errors.push(`${label}.entries[${i}]: percentOfDaily pozitif olmalı`);
      }
      percentSum += entry.percentOfDaily;
    }
    if (Math.abs(percentSum - 100) > PERCENT_SUM_TOLERANCE) {
      errors.push(
        `${label}: percentOfDaily toplamı 100 olmalı (±${PERCENT_SUM_TOLERANCE}); mevcut ${percentSum}`,
      );
    }
  }

  private validateTemperatureAdjustments(
    adjustments: TemperatureAdjustment[] | undefined,
    errors: string[],
  ): void {
    if (!adjustments?.length) return;
    const sorted = [...adjustments].sort((a, b) => a.minC - b.minC);
    for (const [i, adj] of sorted.entries()) {
      const label = `temperatureAdjustments[${i}] (${adj.minC}-${adj.maxC}°C)`;
      if (!(adj.maxC > adj.minC)) errors.push(`${label}: maxC > minC olmalı`);
      if (adj.rateMultiplier < MIN_TEMP_MULTIPLIER || adj.rateMultiplier > MAX_TEMP_MULTIPLIER) {
        errors.push(
          `${label}: rateMultiplier ${MIN_TEMP_MULTIPLIER}-${MAX_TEMP_MULTIPLIER} aralığında olmalı`,
        );
      }
      const prevAdj = i > 0 ? sorted[i - 1] : undefined;
      if (prevAdj && adj.minC < prevAdj.maxC) {
        errors.push('temperatureAdjustments: sıcaklık bantları örtüşemez (overlap)');
      }
    }
  }

  private validateFcrMatrix(
    matrix: FcrMatrix | undefined,
    settings: ProtocolSettings,
    errors: string[],
  ): void {
    if (!matrix) {
      if (settings.fcrSource === ProtocolFcrSource.MATRIX) {
        errors.push('fcrMatrix: fcrSource=matrix seçiliyken FCR matrisi zorunlu');
      }
      return;
    }
    if (matrix.temperatures.length === 0 || matrix.temperatures.length > MAX_FCR_TEMPERATURES) {
      errors.push(`fcrMatrix: temperatures 1-${MAX_FCR_TEMPERATURES} girdi olmalı`);
    }
    if (matrix.weights.length === 0 || matrix.weights.length > MAX_FCR_WEIGHTS) {
      errors.push(`fcrMatrix: weights 1-${MAX_FCR_WEIGHTS} girdi olmalı`);
    }
    if (matrix.fcrValues.length !== matrix.temperatures.length) {
      errors.push('fcrMatrix: fcrValues satır sayısı temperatures ile eşit olmalı');
      return;
    }
    for (const [i, row] of matrix.fcrValues.entries()) {
      if (row.length !== matrix.weights.length) {
        errors.push(`fcrMatrix: fcrValues[${i}] sütun sayısı weights ile eşit olmalı`);
        continue;
      }
      for (const value of row) {
        if (value < MIN_EXPECTED_FCR || value > MAX_EXPECTED_FCR) {
          errors.push(
            `fcrMatrix: değerler ${MIN_EXPECTED_FCR}-${MAX_EXPECTED_FCR} aralığında olmalı`,
          );
        }
      }
    }
  }

  private validateSettings(settings: ProtocolSettings, errors: string[]): void {
    if (settings.transitionBufferG < 0) {
      errors.push('settings.transitionBufferG negatif olamaz');
    }
    if (
      settings.underfeedAlertThresholdPercent < 1 ||
      settings.underfeedAlertThresholdPercent > 100
    ) {
      errors.push('settings.underfeedAlertThresholdPercent 1-100 aralığında olmalı');
    }
    if (
      settings.minFeedingRatePercent !== undefined &&
      settings.maxFeedingRatePercent !== undefined &&
      settings.minFeedingRatePercent > settings.maxFeedingRatePercent
    ) {
      errors.push('settings: minFeedingRatePercent maxFeedingRatePercent değerini aşamaz');
    }
  }
}
