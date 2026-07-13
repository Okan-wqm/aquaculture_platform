/**
 * SCADA package script write-time validation.
 *
 * Scripts are stored as untrusted tenant code inside `packageData.scripts` and
 * executed at runtime by the QuickJS sandbox. These tests pin the save-boundary
 * guards that keep malformed/oversized script payloads out of the store: code
 * must be a bounded string, the script count is capped, and `mode` is
 * constrained — each rejected (never truncated).
 *
 * We exercise the private `validateScripts` guard directly (it is a pure,
 * collaborator-free structural check) so the test needs no TypeORM wiring.
 */
import { BadRequestException } from '@nestjs/common';
import { ScadaPackageService } from '../scada-package.service';

type ScriptValidator = (data: Record<string, unknown>) => void;

/** Reach the private structural guard without constructing the full service. */
function getValidator(): ScriptValidator {
  const proto = ScadaPackageService.prototype as unknown as {
    validateScripts: ScriptValidator;
  };
  return proto.validateScripts.bind(proto);
}

const validateScripts = getValidator();

function scriptWith(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 's1', name: 'x', code, trigger: 'event', enabled: true, ...extra };
}

describe('ScadaPackageService.validateScripts', () => {
  it('accepts a package with no scripts key', () => {
    expect(() => validateScripts({})).not.toThrow();
  });

  it('accepts well-formed scripts within limits', () => {
    expect(() =>
      validateScripts({ scripts: [scriptWith('return 1'), scriptWith('return 2', { mode: 'server' })] }),
    ).not.toThrow();
  });

  it('rejects a non-array scripts value', () => {
    expect(() => validateScripts({ scripts: {} })).toThrow(BadRequestException);
  });

  it('rejects more than the maximum number of scripts', () => {
    const scripts = Array.from({ length: 51 }, (_, i) => scriptWith(`return ${i}`));
    expect(() => validateScripts({ scripts })).toThrow(/maximum of 50/);
  });

  it('rejects a script whose code is not a string', () => {
    expect(() => validateScripts({ scripts: [{ id: 's1', code: 123 }] })).toThrow(/string `code`/);
  });

  it('rejects a script whose code exceeds the size cap', () => {
    const huge = 'x'.repeat(65_537);
    expect(() => validateScripts({ scripts: [scriptWith(huge)] })).toThrow(/exceeds the maximum size/);
  });

  it('accepts a script exactly at the size cap', () => {
    const atCap = 'x'.repeat(65_536);
    expect(() => validateScripts({ scripts: [scriptWith(atCap)] })).not.toThrow();
  });

  it('rejects an unknown execution mode', () => {
    expect(() => validateScripts({ scripts: [scriptWith('return 1', { mode: 'daemon' })] })).toThrow(
      /'server' or 'client'/,
    );
  });

  it('rejects a non-object script entry', () => {
    expect(() => validateScripts({ scripts: ['not-an-object'] })).toThrow(/must be an object/);
  });
});
