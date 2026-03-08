/**
 * PID Controller with:
 * - Derivative-on-PV (no setpoint kick)
 * - Filtered derivative (1st order, N coefficient)
 * - Back-calculation anti-windup
 * - Split-range output: [-100,+100] -> acid [0,100] / base [0,100]
 * - Conditional integration (freeze integral on large errors)
 */

import { PIDParams, PIDState } from './types';

export interface PIDOutput {
  output: number;       // -100 to +100 (negative=acid, positive=base)
  acidPercent: number;  // 0-100
  basePercent: number;  // 0-100
  state: PIDState;
}

/**
 * Run one PID tick.
 * error = setpoint - processValue (positive = needs base, negative = needs acid)
 */
export function pidStep(
  setpoint: number,
  processValue: number,
  pidState: PIDState,
  params: PIDParams,
  dt: number,
  gainScheduleFactor: number = 1.0,
): PIDOutput {
  const error = setpoint - processValue;

  // Effective gains with gain scheduling
  const Kp = params.Kp * gainScheduleFactor;
  const Ki = params.Ki * gainScheduleFactor;
  const Kd = params.Kd * gainScheduleFactor;

  // Proportional
  const P = Kp * error;

  // Conditional integration: freeze when error is large (>1.0 pH unit or equiv)
  let integral = pidState.integral;
  if (Math.abs(error) < 1.0) {
    integral += Ki * error * dt;
  }

  // Derivative-on-PV (not on error) to avoid setpoint kick
  const dpv = (processValue - pidState.prevPV) / dt;
  // Filtered derivative (1st order low-pass)
  const alpha = dt * params.N / (1 + dt * params.N);
  const filteredDeriv = alpha * dpv + (1 - alpha) * pidState.prevDerivative;
  const D = -Kd * filteredDeriv;

  // Raw output
  let rawOutput = P + integral + D;

  // Rate limiting
  const maxChange = params.rateMax * dt;
  const delta = rawOutput - pidState.output;
  if (Math.abs(delta) > maxChange) {
    rawOutput = pidState.output + Math.sign(delta) * maxChange;
  }

  // Clamp to [-100, +100]
  const clampedOutput = Math.max(-100, Math.min(100, rawOutput));

  // Back-calculation anti-windup
  if (clampedOutput !== rawOutput) {
    const backCalcGain = 1.0 / (Kp > 0 ? Kp : 1);
    integral += backCalcGain * (clampedOutput - rawOutput);
  }

  // Split-range: negative output = acid, positive = base
  const acidPercent = clampedOutput < 0 ? Math.min(100, -clampedOutput) : 0;
  const basePercent = clampedOutput > 0 ? Math.min(100, clampedOutput) : 0;

  const newState: PIDState = {
    integral,
    prevError: error,
    prevPV: processValue,
    prevDerivative: filteredDeriv,
    output: clampedOutput,
  };

  return {
    output: clampedOutput,
    acidPercent,
    basePercent,
    state: newState,
  };
}

/**
 * Run EC PID tick (simpler: output 0-100 for nutrient pump)
 */
export function ecPidStep(
  setpoint: number,
  processValue: number,
  pidState: PIDState,
  params: PIDParams,
  dt: number,
): { nutPercent: number; state: PIDState } {
  const error = setpoint - processValue;

  const P = params.Kp * error;

  let integral = pidState.integral;
  if (Math.abs(error) < 0.5) {
    integral += params.Ki * error * dt;
  }

  const dpv = (processValue - pidState.prevPV) / dt;
  const alpha = dt * params.N / (1 + dt * params.N);
  const filteredDeriv = alpha * dpv + (1 - alpha) * pidState.prevDerivative;
  const D = -params.Kd * filteredDeriv;

  let rawOutput = P + integral + D;

  const maxChange = params.rateMax * dt;
  const delta = rawOutput - pidState.output;
  if (Math.abs(delta) > maxChange) {
    rawOutput = pidState.output + Math.sign(delta) * maxChange;
  }

  const clampedOutput = Math.max(0, Math.min(100, rawOutput));

  if (clampedOutput !== rawOutput) {
    const backCalcGain = 1.0 / (params.Kp > 0 ? params.Kp : 1);
    integral += backCalcGain * (clampedOutput - rawOutput);
  }

  const newState: PIDState = {
    integral,
    prevError: error,
    prevPV: processValue,
    prevDerivative: filteredDeriv,
    output: clampedOutput,
  };

  return { nutPercent: clampedOutput, state: newState };
}
