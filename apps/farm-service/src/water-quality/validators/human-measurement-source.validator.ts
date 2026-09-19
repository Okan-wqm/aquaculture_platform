/**
 * IsHumanMeasurementSource Decorator
 *
 * FARM-AI v3 (Sprint 2.3): the human-facing create-water-quality GraphQL
 * input must NEVER claim machine provenance. `source: SENSOR_AUTOMATIC` (or
 * SENSOR_TRIGGERED) submitted by a user or an AI-driven client makes
 * hand-entered data look sensor-produced — poisoning every downstream
 * consumer that trusts machine sources differently (trend rules, the
 * future action_watch rule engine, sensor/ manual drift checks).
 *
 * Nothing in the codebase legitimately produces sensor_auto / sensor_trigger
 * through this input; machine measurements arrive via their own ingestion
 * path with server-set provenance. The validator therefore rejects exactly
 * the machine sources and leaves the human-enterable provenance values
 * (MANUAL, LAB_ANALYSIS, CALIBRATION) untouched.
 *
 * @module WaterQuality/Validators
 */
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { MeasurementSource } from '../entities/water-quality-measurement.entity';

/** Provenance that only machine ingestion paths may set. */
const MACHINE_SOURCES: ReadonlySet<string> = new Set([
  MeasurementSource.SENSOR_AUTOMATIC,
  MeasurementSource.SENSOR_TRIGGERED,
]);

@ValidatorConstraint({ name: 'isHumanMeasurementSource', async: false })
export class HumanMeasurementSourceConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && !MACHINE_SOURCES.has(value as MeasurementSource);
  }

  defaultMessage(arguments_: ValidationArguments): string {
    return (
      `${arguments_.property} must not claim machine provenance ` +
      `(sensor_auto / sensor_trigger are set by sensor ingestion, not by this input)`
    );
  }
}

export function IsHumanMeasurementSource(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isHumanMeasurementSource',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: HumanMeasurementSourceConstraint,
    });
  };
}
