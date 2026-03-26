import { RiskEvaluatorService } from '../risk-evaluator.service';
import { RiskLevel, RISK_LEVEL_SCORES } from '../parameter-risk-rules';

describe('RiskEvaluatorService', () => {
  let service: RiskEvaluatorService;

  beforeEach(() => {
    service = new RiskEvaluatorService();
  });

  describe('evaluateRisk', () => {
    // === Critical escalation tests ===

    it('should return CRITICAL for accel_time_1 = 0.5 (below 1s threshold)', () => {
      const result = service.evaluateRisk('accel_time_1', 0.5);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
      expect(result.riskScore).toBe(RISK_LEVEL_SCORES[RiskLevel.CRITICAL]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('ESCALATED'))).toBe(true);
    });

    it('should return MEDIUM for accel_time_1 = 5.0 (above 1s threshold)', () => {
      const result = service.evaluateRisk('accel_time_1', 5.0);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
      expect(result.riskScore).toBe(RISK_LEVEL_SCORES[RiskLevel.MEDIUM]);
    });

    it('should return CRITICAL for accel_time_2 = 0.8 (wildcard match, below 1s)', () => {
      const result = service.evaluateRisk('accel_time_2', 0.8);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
    });

    it('should return CRITICAL for max_frequency = 70 (above 60Hz)', () => {
      const result = service.evaluateRisk('max_frequency', 70);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
      expect(result.riskScore).toBe(100);
    });

    it('should return HIGH for max_frequency = 50 (normal range)', () => {
      const result = service.evaluateRisk('max_frequency', 50);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
      expect(result.riskScore).toBe(RISK_LEVEL_SCORES[RiskLevel.HIGH]);
    });

    it('should return CRITICAL for thermal_protection_mode = 0 (disabled)', () => {
      const result = service.evaluateRisk('thermal_protection_mode', 0);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
      expect(result.warnings.some((w) => w.includes('thermal protection'))).toBe(true);
    });

    it('should return HIGH for thermal_protection_mode = 2 (enabled)', () => {
      const result = service.evaluateRisk('thermal_protection_mode', 2);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
    });

    it('should return CRITICAL for decel_time_1 = 0.3 (below 0.5s)', () => {
      const result = service.evaluateRisk('decel_time_1', 0.3);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
      expect(result.warnings.some((w) => w.includes('DC bus overvoltage'))).toBe(true);
    });

    it('should return MEDIUM for decel_time_1 = 3.0 (normal range)', () => {
      const result = service.evaluateRisk('decel_time_1', 3.0);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    // === Current limit escalation ===

    it('should return HIGH for current_limit_percent = 250 (above 200%)', () => {
      const result = service.evaluateRisk('current_limit_percent', 250);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
      expect(result.warnings.some((w) => w.includes('200%'))).toBe(true);
    });

    it('should return MEDIUM for current_limit_percent = 150 (normal range)', () => {
      const result = service.evaluateRisk('current_limit_percent', 150);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    // === Motor stop tests ===

    it('should require motor stop for motor_voltage_nom', () => {
      const result = service.evaluateRisk('motor_voltage_nom', 400);
      expect(result.requiresMotorStop).toBe(true);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
    });

    it('should require motor stop for motor_current_nom', () => {
      const result = service.evaluateRisk('motor_current_nom', 8.5);
      expect(result.requiresMotorStop).toBe(true);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
    });

    it('should require motor stop for motor_power_nom', () => {
      const result = service.evaluateRisk('motor_power_nom', 4.0);
      expect(result.requiresMotorStop).toBe(true);
    });

    it('should require motor stop for motor_speed_nom', () => {
      const result = service.evaluateRisk('motor_speed_nom', 1450);
      expect(result.requiresMotorStop).toBe(true);
    });

    it('should require motor stop for motor_cos_phi', () => {
      const result = service.evaluateRisk('motor_cos_phi', 0.85);
      expect(result.requiresMotorStop).toBe(true);
    });

    it('should require motor stop for vf_curve_mode', () => {
      const result = service.evaluateRisk('vf_curve_mode', 1);
      expect(result.requiresMotorStop).toBe(true);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
    });

    it('should require motor stop for voltage_boost', () => {
      const result = service.evaluateRisk('voltage_boost', 5);
      expect(result.requiresMotorStop).toBe(true);
    });

    it('should require motor stop for slip_compensation', () => {
      const result = service.evaluateRisk('slip_compensation', 50);
      expect(result.requiresMotorStop).toBe(true);
    });

    it('should NOT require motor stop for parameters without that flag', () => {
      const result = service.evaluateRisk('accel_time_1', 5.0);
      expect(result.requiresMotorStop).toBe(false);
    });

    // === Low risk tests ===

    it('should return LOW for jog_frequency', () => {
      const result = service.evaluateRisk('jog_frequency', 5);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
      expect(result.requiresMotorStop).toBe(false);
      expect(result.riskScore).toBe(RISK_LEVEL_SCORES[RiskLevel.LOW]);
    });

    it('should return LOW for jog_ramp_time (wildcard match)', () => {
      const result = service.evaluateRisk('jog_ramp_time', 2);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    it('should return LOW for modbus_address', () => {
      const result = service.evaluateRisk('modbus_address', 10);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    it('should return LOW for baudrate_select', () => {
      const result = service.evaluateRisk('baudrate_select', 3);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    it('should return LOW for response_delay', () => {
      const result = service.evaluateRisk('response_delay', 50);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    it('should return LOW for di_1_function', () => {
      const result = service.evaluateRisk('di_1_function', 2);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    it('should return LOW for do_1_function', () => {
      const result = service.evaluateRisk('do_1_function', 3);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    it('should return LOW for relay_1_function', () => {
      const result = service.evaluateRisk('relay_1_function', 1);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    // === Medium risk tests ===

    it('should return MEDIUM for min_frequency', () => {
      const result = service.evaluateRisk('min_frequency', 5);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should return MEDIUM for torque_limit_motor', () => {
      const result = service.evaluateRisk('torque_limit_motor', 150);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should return MEDIUM for pid_p_gain', () => {
      const result = service.evaluateRisk('pid_p_gain', 2.0);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should return MEDIUM for s_curve_start', () => {
      const result = service.evaluateRisk('s_curve_start', 0.5);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should return MEDIUM for skip_freq_1', () => {
      const result = service.evaluateRisk('skip_freq_1', 25);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should return MEDIUM for skip_band', () => {
      const result = service.evaluateRisk('skip_band', 2);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should return MEDIUM for stall_detection', () => {
      const result = service.evaluateRisk('stall_detection', 1);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    // === Unknown parameter test ===

    it('should return MEDIUM for unknown parameter', () => {
      const result = service.evaluateRisk('unknown_param_xyz', 42);
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
      expect(result.warnings).toContain('No specific risk rule found — defaulting to MEDIUM');
      expect(result.riskScore).toBe(RISK_LEVEL_SCORES[RiskLevel.MEDIUM]);
    });

    // === Limits parameter passthrough ===

    it('should pass limits to escalation condition', () => {
      const result = service.evaluateRisk('max_frequency', 70, { min: 0, max: 120 });
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
    });

    // === Edge cases ===

    it('should handle boundary value exactly at escalation threshold for accel_time', () => {
      const result = service.evaluateRisk('accel_time_1', 1.0);
      // value < 1.0 triggers escalation, so 1.0 should NOT escalate
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should handle boundary value exactly at max_frequency escalation threshold', () => {
      const result = service.evaluateRisk('max_frequency', 60);
      // value > 60 triggers escalation, so 60 should NOT escalate
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
    });

    it('should handle boundary value exactly at decel_time escalation threshold', () => {
      const result = service.evaluateRisk('decel_time_1', 0.5);
      // value < 0.5 triggers escalation, so 0.5 should NOT escalate
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should handle boundary value exactly at current_limit escalation threshold', () => {
      const result = service.evaluateRisk('current_limit_percent', 200);
      // value > 200 triggers escalation, so 200 should NOT escalate
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });
  });

  describe('evaluateBatchRisk', () => {
    it('should return highest risk from batch', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'jog_frequency', value: 5 },
        { parameterName: 'accel_time_1', value: 0.5 },
        { parameterName: 'modbus_address', value: 10 },
      ]);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
      expect(result.riskScore).toBe(RISK_LEVEL_SCORES[RiskLevel.CRITICAL]);
    });

    it('should aggregate motor stop requirements', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'jog_frequency', value: 5 },
        { parameterName: 'motor_voltage_nom', value: 400 },
      ]);
      expect(result.requiresMotorStop).toBe(true);
    });

    it('should not require motor stop when no items need it', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'jog_frequency', value: 5 },
        { parameterName: 'modbus_address', value: 10 },
      ]);
      expect(result.requiresMotorStop).toBe(false);
    });

    it('should deduplicate warnings', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'accel_time_1', value: 0.5 },
        { parameterName: 'accel_time_2', value: 0.3 },
      ]);
      const uniqueWarnings = new Set(result.warnings);
      expect(uniqueWarnings.size).toBe(result.warnings.length);
    });

    it('should return LOW when all items are low risk', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'jog_frequency', value: 5 },
        { parameterName: 'modbus_address', value: 10 },
        { parameterName: 'baudrate_select', value: 3 },
      ]);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
      expect(result.riskScore).toBe(RISK_LEVEL_SCORES[RiskLevel.LOW]);
    });

    it('should handle empty batch', () => {
      const result = service.evaluateBatchRisk([]);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
      expect(result.warnings).toHaveLength(0);
      expect(result.requiresMotorStop).toBe(false);
    });

    it('should handle single-item batch', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'max_frequency', value: 70 },
      ]);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
    });

    it('should pass limits through to individual evaluations', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'max_frequency', value: 70, limits: { min: 0, max: 120 } },
        { parameterName: 'jog_frequency', value: 5 },
      ]);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
    });

    it('should combine motor stop from multiple items', () => {
      const result = service.evaluateBatchRisk([
        { parameterName: 'motor_voltage_nom', value: 400 },
        { parameterName: 'motor_current_nom', value: 8.5 },
        { parameterName: 'vf_curve_mode', value: 2 },
      ]);
      expect(result.requiresMotorStop).toBe(true);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
    });
  });
});
