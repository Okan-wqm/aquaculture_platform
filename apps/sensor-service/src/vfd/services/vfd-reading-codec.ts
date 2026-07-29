import { VfdParameters, VfdStatusBits } from '../entities/vfd-reading.entity';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdEdgeReadValue } from './vfd-edge-read.service';

/**
 * A decoded VFD reading. Re-homed from the retired `vfd/adapters` module
 * (SENSOR-CRITICAL-007 / Faz 4): the telemetry read path is edge-delegated, and
 * this shape is what the edge register values decode into.
 */
export interface VfdReadResult {
  parameters: VfdParameters;
  statusBits: VfdStatusBits;
  rawValues: Record<string, number>;
  timestamp: Date;
  latencyMs: number;
  errors?: string[];
}

/**
 * VFD reading codec — the single, brand-neutral decode from raw Modbus register
 * values to the canonical `VfdReadResult`. Extracted verbatim from the base VFD
 * adapter (`parseStatusWord` + `mapParameterName`) so the edge-delegated telemetry
 * path decodes identically to the retired in-process path, without depending on
 * the fake adapters. Pure functions — no I/O.
 */

/** Snake-cased register parameter name → canonical camelCase `VfdParameters` key. */
const PARAMETER_NAME_MAP: Record<string, keyof VfdParameters> = {
  output_frequency: 'outputFrequency',
  motor_speed: 'motorSpeed',
  motor_current: 'motorCurrent',
  motor_voltage: 'motorVoltage',
  dc_bus_voltage: 'dcBusVoltage',
  output_power: 'outputPower',
  motor_torque: 'motorTorque',
  power_factor: 'powerFactor',
  energy_consumption: 'energyConsumption',
  kwh_counter: 'energyConsumption',
  kwh_accumulated: 'energyConsumption',
  accumulated_power: 'energyConsumption',
  running_hours: 'runningHours',
  running_time: 'runningHours',
  run_time: 'runningHours',
  power_on_hours: 'powerOnHours',
  power_on_time: 'powerOnHours',
  power_up_time: 'powerOnHours',
  start_count: 'startCount',
  drive_temp: 'driveTemperature',
  drive_thermal: 'driveTemperature',
  heatsink_temp: 'driveTemperature',
  igbt_temp: 'driveTemperature',
  motor_thermal: 'motorThermal',
  control_card_temp: 'controlCardTemperature',
  ambient_temp: 'ambientTemperature',
  status_word: 'statusWord',
  status_word_1: 'statusWord',
  fault_code: 'faultCode',
  current_fault: 'faultCode',
  fault_code_1: 'faultCode',
  warning_word: 'warningWord',
  warning_code: 'warningWord',
  alarm_word: 'alarmWord',
  alarm_code: 'alarmWord',
  speed_reference: 'speedReference',
  frequency_reference: 'frequencyReference',
  frequency_command: 'frequencyReference',
  speed_setpoint: 'speedReference',
};

/** Map a register parameter name to its canonical `VfdParameters` key, if known. */
export function mapParameterName(parameterName: string): keyof VfdParameters | null {
  return PARAMETER_NAME_MAP[parameterName] ?? null;
}

/**
 * Decode a CiA 402 / PROFIdrive status word into individual bits. Standard bit
 * mapping (bit 2 = operation enabled / running, bit 3 = fault, …).
 */
export function parseStatusWord(value: number): VfdStatusBits {
  return {
    ready: Boolean(value & 0x0001), // Bit 0: Ready to switch on
    running: Boolean(value & 0x0004), // Bit 2: Operation enabled
    fault: Boolean(value & 0x0008), // Bit 3: Fault
    voltageEnabled: Boolean(value & 0x0010), // Bit 4: Voltage enabled
    quickStopActive: !(value & 0x0020), // Bit 5: Quick stop (inverted)
    switchOnDisabled: Boolean(value & 0x0040), // Bit 6: Switch on disabled
    warning: Boolean(value & 0x0080), // Bit 7: Warning
    remote: Boolean(value & 0x0200), // Bit 9: Remote
    targetReached: Boolean(value & 0x0400), // Bit 10: Target reached
    internalLimit: Boolean(value & 0x0800), // Bit 11: Internal limit active
    atSetpoint: Boolean(value & 0x2000), // Bit 13: At setpoint
    direction: value & 0x8000 ? 'reverse' : 'forward', // Bit 15: Direction
  };
}

/**
 * Assemble a `VfdReadResult` from the drive's register mappings and the edge's
 * read_modbus values (matched by register address). A mapping the edge did not
 * return is recorded in `errors` — never silently defaulted to zero.
 */
export function buildVfdReadResult(
  mappings: VfdRegisterMapping[],
  edgeValues: VfdEdgeReadValue[],
  latencyMs: number,
  timestamp: Date,
): VfdReadResult {
  const byAddress = new Map<number, VfdEdgeReadValue>();
  for (const v of edgeValues) byAddress.set(v.address, v);

  const parameters: VfdParameters = {};
  const rawValues: Record<string, number> = {};
  let statusBits: VfdStatusBits = {};
  const errors: string[] = [];

  for (const m of mappings) {
    const value = byAddress.get(m.registerAddress);
    if (!value) {
      errors.push(`Register ${m.parameterName} (@${m.registerAddress}) not returned by edge`);
      continue;
    }
    rawValues[m.parameterName] = value.rawValue;
    const scale = Number(m.scalingFactor) || 1;
    const offset = Number(m.offset) || 0;
    const engineering = value.rawValue * scale + offset;

    const mapped = mapParameterName(m.parameterName);
    if (mapped) {
      parameters[mapped] = engineering;
      if (mapped === 'statusWord') {
        statusBits = parseStatusWord(value.rawValue);
      }
    } else {
      parameters[m.parameterName] = engineering;
    }
  }

  return {
    parameters,
    statusBits,
    rawValues,
    timestamp,
    latencyMs,
    ...(errors.length ? { errors } : {}),
  };
}
