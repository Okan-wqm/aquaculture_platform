/**
 * VFD Parameter Risk Assessment Rules
 * IEC 62443 SL-2 compliant dynamic risk evaluation
 *
 * Risk levels:
 * - LOW: cosmetic/non-critical params (jog freq, comm settings)
 * - MEDIUM: operational params safe to change at runtime (ramp times, PID)
 * - HIGH: performance-critical, may require motor stop (motor nameplate, V/f curve)
 * - CRITICAL: safety-impacting, can damage equipment (extreme accel, disable protection)
 */

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface ParameterRiskRule {
  /** Glob pattern for parameter name: 'accel_time_*', 'max_frequency' */
  parameterPattern: string;
  /** Default risk for this parameter */
  baseRisk: RiskLevel;
  /** Optional condition that escalates risk when true */
  escalationCondition?: (value: number, limits: { min?: number; max?: number }) => boolean;
  /** Risk level when escalation triggers */
  escalatedRisk?: RiskLevel;
  /** Whether motor must be stopped to apply this parameter */
  requiresMotorStop?: boolean;
  /** Human-readable reason shown in UI */
  reason: string;
}

export interface RiskAssessmentResult {
  riskLevel: RiskLevel;
  requiresMotorStop: boolean;
  warnings: string[];
  /** Numeric score 0-100 for sorting/comparison */
  riskScore: number;
}

export const RISK_LEVEL_SCORES: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 10,
  [RiskLevel.MEDIUM]: 40,
  [RiskLevel.HIGH]: 70,
  [RiskLevel.CRITICAL]: 100,
};

export const PARAMETER_RISK_RULES: ParameterRiskRule[] = [
  // === CRITICAL RULES — can damage equipment or endanger personnel ===
  {
    parameterPattern: 'accel_time_*',
    baseRisk: RiskLevel.MEDIUM,
    escalationCondition: (value) => value < 1.0,
    escalatedRisk: RiskLevel.CRITICAL,
    reason: 'Acceleration time <1s can cause mechanical shock, coupling damage, and overcurrent trip',
  },
  {
    parameterPattern: 'decel_time_*',
    baseRisk: RiskLevel.MEDIUM,
    escalationCondition: (value) => value < 0.5,
    escalatedRisk: RiskLevel.CRITICAL,
    reason: 'Deceleration time <0.5s can cause DC bus overvoltage and regenerative fault',
  },
  {
    parameterPattern: 'max_frequency',
    baseRisk: RiskLevel.HIGH,
    escalationCondition: (value) => value > 60,
    escalatedRisk: RiskLevel.CRITICAL,
    reason: 'Exceeding 60Hz nameplate frequency may damage motor bearings, windings, or connected equipment',
  },
  {
    parameterPattern: 'thermal_protection_mode',
    baseRisk: RiskLevel.HIGH,
    escalationCondition: (value) => value === 0,
    escalatedRisk: RiskLevel.CRITICAL,
    reason: 'Disabling thermal protection removes overcurrent and overheat safety — motor may be damaged',
  },
  {
    parameterPattern: 'current_limit_percent',
    baseRisk: RiskLevel.MEDIUM,
    escalationCondition: (value) => value > 200,
    escalatedRisk: RiskLevel.HIGH,
    reason: 'Current limit >200% of nominal exceeds motor thermal capacity for sustained operation',
  },

  // === HIGH RULES — requires motor stop, affects motor performance ===
  {
    parameterPattern: 'motor_voltage_nom',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'Motor nameplate voltage change requires motor stop and auto-tune re-run',
  },
  {
    parameterPattern: 'motor_current_nom',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'Motor nameplate current change requires motor stop and auto-tune re-run',
  },
  {
    parameterPattern: 'motor_power_nom',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'Motor nameplate power change requires motor stop and auto-tune re-run',
  },
  {
    parameterPattern: 'motor_speed_nom',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'Motor nameplate speed change requires motor stop and auto-tune re-run',
  },
  {
    parameterPattern: 'motor_cos_phi',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'Motor power factor change requires motor stop and auto-tune re-run',
  },
  {
    parameterPattern: 'vf_curve_mode',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'V/f curve change affects motor control method — requires motor stop',
  },
  {
    parameterPattern: 'voltage_boost',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'Voltage boost change affects low-speed torque — requires motor stop',
  },
  {
    parameterPattern: 'slip_compensation',
    baseRisk: RiskLevel.HIGH,
    requiresMotorStop: true,
    reason: 'Slip compensation change affects speed regulation — requires motor stop',
  },

  // === MEDIUM RULES — operational impact but safe at runtime ===
  {
    parameterPattern: 'accel_time_*',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Acceleration time affects motor ramp-up behavior',
  },
  {
    parameterPattern: 'decel_time_*',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Deceleration time affects motor ramp-down behavior',
  },
  {
    parameterPattern: 'min_frequency',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Minimum frequency affects low-speed operation range',
  },
  {
    parameterPattern: 'current_limit_percent',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Current limit affects motor torque capability',
  },
  {
    parameterPattern: 'torque_limit_*',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Torque limit affects motor loading behavior',
  },
  {
    parameterPattern: 'pid_*',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'PID controller parameters affect process control stability',
  },
  {
    parameterPattern: 's_curve_*',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'S-curve settings affect ramp smoothness',
  },
  {
    parameterPattern: 'skip_freq_*',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Skip frequency avoids mechanical resonance — incorrect values may cause vibration',
  },
  {
    parameterPattern: 'skip_band',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Skip band width around skip frequencies',
  },
  {
    parameterPattern: 'stall_detection',
    baseRisk: RiskLevel.MEDIUM,
    reason: 'Stall detection affects motor protection response',
  },

  // === LOW RULES — cosmetic or non-critical ===
  {
    parameterPattern: 'jog_*',
    baseRisk: RiskLevel.LOW,
    reason: 'Jog parameters affect manual jog operation only',
  },
  {
    parameterPattern: 'modbus_address',
    baseRisk: RiskLevel.LOW,
    reason: 'Communication address — non-critical operational parameter',
  },
  {
    parameterPattern: 'baudrate_*',
    baseRisk: RiskLevel.LOW,
    reason: 'Communication baud rate — non-critical operational parameter',
  },
  {
    parameterPattern: 'response_delay',
    baseRisk: RiskLevel.LOW,
    reason: 'Communication response delay — non-critical operational parameter',
  },
  {
    parameterPattern: 'di_*_function',
    baseRisk: RiskLevel.LOW,
    reason: 'Digital input function assignment',
  },
  {
    parameterPattern: 'do_*_function',
    baseRisk: RiskLevel.LOW,
    reason: 'Digital output function assignment',
  },
  {
    parameterPattern: 'relay_*_function',
    baseRisk: RiskLevel.LOW,
    reason: 'Relay output function assignment',
  },
];
