/**
 * The drive reading layer, where a wire value becomes something a worker acts on.
 *
 * This is the narrowest and most safety-critical code in the VFD surface, because
 * it is where an absent measurement could quietly become a zero and an
 * unobserved shaft could quietly become "stopped". Both would be lies with a
 * machine on the other end, so both are pinned here rather than only through the
 * screens that render them.
 */
import { describe, expect, it } from 'vitest';

import {
  driveCommandRefusal,
  drivenUnitSummary,
  isFeederDrive,
  readDriveRunState,
  readDriveTelemetry,
  readIsConnected,
} from '../vfd-drive';

describe('readDriveTelemetry', () => {
  it('returns null — never zero — for anything the drive did not report', () => {
    // The whole point. A missing key, a null, a string and a NaN are all "we do
    // not know", and every one of them must survive as null all the way to the
    // screen, which then renders nothing instead of a measurement.
    const telemetry = readDriveTelemetry({
      outputFrequency: null,
      motorCurrent: 'n/a',
      outputPower: Number.NaN,
    });

    expect(telemetry.outputFrequencyHz).toBeNull();
    expect(telemetry.motorCurrentA).toBeNull();
    expect(telemetry.motorSpeedRpm).toBeNull();
    expect(telemetry.outputPowerKw).toBeNull();
  });

  it('returns null for every value when there is no reading at all', () => {
    expect(readDriveTelemetry(null)).toEqual({
      outputFrequencyHz: null,
      motorCurrentA: null,
      motorSpeedRpm: null,
      outputPowerKw: null,
      faultCode: null,
    });
  });

  it('passes a real zero through — a drive genuinely at 0 Hz reported that', () => {
    // The distinction that makes the rule above meaningful: absent is null,
    // measured-as-zero is zero.
    expect(readDriveTelemetry({ outputFrequency: 0 }).outputFrequencyHz).toBe(0);
  });

  it('reads the four parameters every brand config declares in the same unit', () => {
    expect(
      readDriveTelemetry({
        outputFrequency: 49.9,
        motorCurrent: 12.25,
        motorSpeed: 1450,
        outputPower: 5.5,
        faultCode: 0,
      }),
    ).toEqual({
      outputFrequencyHz: 49.9,
      motorCurrentA: 12.25,
      motorSpeedRpm: 1450,
      outputPowerKw: 5.5,
      faultCode: 0,
    });
  });

  it('ignores speedReference, which is a different UNIT per brand', () => {
    // ABB declares it %, Danfoss and Rockwell Hz, Siemens RPM — and the wire
    // carries the number without its unit. Reading it would be right for one
    // brand in four, which is why the design's drive PERCENTAGE is absent.
    const telemetry = readDriveTelemetry({ speedReference: 78 });
    expect(Object.values(telemetry).every((value) => value === null)).toBe(true);
  });
});

describe('readDriveRunState', () => {
  it('reports UNKNOWN when nothing was observed — never "stopped"', () => {
    // A drive that has not been observed is not a drive at rest. Saying "Stopped"
    // here would tell a worker an auger is still while it is turning.
    expect(readDriveRunState(null)).toBe('unknown');
    expect(readDriveRunState({})).toBe('unknown');
    expect(readDriveRunState({ running: 'yes' })).toBe('unknown');
  });

  it('reports stopped only on a real observation', () => {
    expect(readDriveRunState({ running: false })).toBe('stopped');
  });

  it('reports running', () => {
    expect(readDriveRunState({ running: true, fault: false })).toBe('running');
  });

  it('lets a fault win over running — a drive coasting down from a trip is faulted', () => {
    expect(readDriveRunState({ running: true, fault: true })).toBe('faulted');
    expect(readDriveRunState({ running: false, fault: true })).toBe('faulted');
  });
});

describe('driveCommandRefusal', () => {
  it.each([
    ['UNBOUND', /not bound to the equipment it turns/i],
    ['UNATTESTED', /has not confirmed it yet/i],
    ['EXPIRED', /aged out/i],
  ] as const)('explains the %s refusal in the server’s own terms', (outcome, expected) => {
    // Mirrors VfdDriveBindingService.assertActuable, which is the authority —
    // the client explains, it does not decide.
    const reason = driveCommandRefusal(outcome, 'PENDING');
    expect(reason).not.toBeNull();
    expect(reason ?? '').toMatch(expected);
  });

  it('names the two other unattested causes specifically', () => {
    expect(driveCommandRefusal('UNATTESTED', 'UNKNOWN_EQUIPMENT') ?? '').toMatch(
      /no longer exists/i,
    );
    expect(driveCommandRefusal('UNATTESTED', 'INACTIVE_EQUIPMENT') ?? '').toMatch(/is inactive/i);
  });

  it.each(['NOT_A_FEEDER', 'FEEDER_WITHOUT_UNIT', 'FEEDER_AMBIGUOUS', 'FEEDER_UNIT'] as const)(
    'does NOT refuse %s',
    (outcome) => {
      // assertActuable deliberately does not require a unit: a pump serves none,
      // and a feeder whose assignment lapsed must still be able to run — refusing
      // that would stop feeding, which is the worse welfare outcome.
      expect(driveCommandRefusal(outcome, 'ATTESTED')).toBeNull();
    },
  );
});

describe('drivenUnitSummary', () => {
  it('gives each non-answer its own words rather than one silence', () => {
    expect(drivenUnitSummary({ outcome: 'UNBOUND', units: [] })).toBe('Not bound to any equipment');
    expect(drivenUnitSummary({ outcome: 'FEEDER_WITHOUT_UNIT', units: [] })).toBe(
      'Feeder with no unit assigned',
    );
    expect(
      drivenUnitSummary({ outcome: 'NOT_A_FEEDER', equipmentCategory: 'pump', units: [] }),
    ).toBe('Drives pump equipment — serves no unit');
  });

  it('names every unit an ambiguous feeder serves, and guesses at none', () => {
    expect(
      drivenUnitSummary({
        outcome: 'FEEDER_AMBIGUOUS',
        units: [
          { unitId: 'a', unitCode: 'U-01', unitType: 'CAGE', doseSharePercent: 60 },
          { unitId: 'b', unitCode: 'U-02', unitType: 'CAGE', doseSharePercent: 40 },
        ],
      }),
    ).toBe('Feeder serving U-01, U-02');
  });
});

describe('isFeederDrive', () => {
  it('is true only for the feeder outcomes, so a pump is never asked for a dosing mode', () => {
    expect(isFeederDrive('FEEDER_UNIT')).toBe(true);
    expect(isFeederDrive('FEEDER_AMBIGUOUS')).toBe(true);
    expect(isFeederDrive('FEEDER_WITHOUT_UNIT')).toBe(true);
    expect(isFeederDrive('NOT_A_FEEDER')).toBe(false);
    expect(isFeederDrive('UNBOUND')).toBe(false);
  });
});

describe('readIsConnected', () => {
  it('keeps "never tested" apart from "not reachable"', () => {
    // A drive nobody has ever tested is neither connected nor disconnected, and
    // calling it unreachable would be an accusation the server never made.
    expect(readIsConnected(null)).toBeNull();
    expect(readIsConnected({})).toBeNull();
    expect(readIsConnected({ isConnected: false })).toBe(false);
    expect(readIsConnected({ isConnected: true })).toBe(true);
  });
});
