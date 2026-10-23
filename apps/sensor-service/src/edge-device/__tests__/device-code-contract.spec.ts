/**
 * SENSOR-LOW-238 — the device code has one definition, the contract's
 * (`common.schema.json` `$defs.device_code`), and the generator, the
 * controller and every fixture of the contract agree with it.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

import { collaborator } from '@aquaculture/testing';

import { DEVICE_CODE_PATTERN, isDeviceCode } from '../edge-contract';
import { DeviceModel } from '../entities/edge-device.entity';
import { ProvisioningController } from '../provisioning.controller';
import { ProvisioningService } from '../provisioning.service';

const REPO = resolve(__dirname, '../../../../..');
const CONTRACT = join(REPO, 'contracts/suderra-edge/v1');

function* jsonFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* jsonFiles(path);
    else if (name.endsWith('.json')) yield path;
  }
}

/** Every `device_code` member found anywhere in a parsed JSON value. */
function deviceCodesIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) deviceCodesIn(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      if (key === 'device_code' && typeof member === 'string') found.push(member);
      else deviceCodesIn(member, found);
    }
  }
  return found;
}

describe('the device code pattern is the contract pattern (SENSOR-LOW-238)', () => {
  it('is compiled from common.schema.json, not copied', () => {
    const schema = JSON.parse(
      readFileSync(join(CONTRACT, 'schemas/common.schema.json'), 'utf8'),
    ) as { $defs: { device_code: { pattern: string } } };
    expect(DEVICE_CODE_PATTERN.source).toBe(new RegExp(schema.$defs.device_code.pattern).source);
  });

  it.each(['EDGE-REVPI-0001', 'RPI-AABB1122', 'a', 'x'.repeat(50), 'lower_case-1'])(
    'admits %s',
    (code) => {
      expect(isDeviceCode(code)).toBe(true);
    },
  );

  it.each(['', 'x'.repeat(51), 'a/b', 'a b', 'a;b', 'EDGE+1', 'a\nb', 'ünicode'])(
    'refuses %j',
    (code) => {
      expect(isDeviceCode(code)).toBe(false);
    },
  );

  it('admits every device_code of the contract fixtures that is not an intentional negative', () => {
    const codes: string[] = [];
    for (const file of jsonFiles(join(CONTRACT, 'fixtures'))) {
      if (file.includes(`${join('', 'invalid')}`)) continue;
      deviceCodesIn(JSON.parse(readFileSync(file, 'utf8')), codes);
    }
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((code) => !isDeviceCode(code))).toEqual([]);
  });

  it('is what the generator mints for every device model and for the self-register path', () => {
    const service = Object.create(ProvisioningService.prototype) as ProvisioningService;
    const models: Array<DeviceModel | undefined> = [undefined, ...Object.values(DeviceModel)];
    for (const model of models) {
      for (let i = 0; i < 20; i += 1) {
        expect(isDeviceCode(service.generateDeviceCode(model))).toBe(true);
      }
    }
  });

  it('the controller holds no copy of a narrower pattern', () => {
    const source = readFileSync(
      join(REPO, 'apps/sensor-service/src/edge-device/provisioning.controller.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\[A-Z\]\{2,5\}/);
    expect(source).toContain('isDeviceCode(deviceCode)');
  });
});

describe('the controller routes answer a contract device code with the route, not a 400', () => {
  interface FakeResponse {
    status: (code: number) => FakeResponse;
    contentType: (type: string) => FakeResponse;
    set: (name: string, value: string) => FakeResponse;
    send: (text: string) => FakeResponse;
    sent: () => { status: number | null; body: string | null };
  }

  function response(): FakeResponse {
    let status: number | null = null;
    let body: string | null = null;
    const res: FakeResponse = {
      status: (code) => {
        status = code;
        return res;
      },
      contentType: () => res,
      set: () => res,
      send: (text) => {
        body = text;
        return res;
      },
      sent: () => ({ status, body }),
    };
    return res;
  }

  const service = {
    generateUninstallScript: jest.fn().mockResolvedValue('#!/bin/sh\nuninstall\n'),
    generateUpdateScript: jest.fn().mockResolvedValue('#!/bin/sh\nupdate\n'),
  };
  const controller = new ProvisioningController(
    collaborator<ProvisioningService>(service, 'ProvisioningService'),
  );

  it('uninstall: a code the old four-copy regex refused is served', async () => {
    const res = response();
    await controller.getUninstallScript('EDGE-REVPI-0001', res as never);
    expect(res.sent()).toEqual({ status: 200, body: '#!/bin/sh\nuninstall\n' });
    expect(service.generateUninstallScript).toHaveBeenCalledWith('EDGE-REVPI-0001');
  });

  it('update: the same', async () => {
    const res = response();
    await controller.getUpdateScript('EDGE-REVPI-0001', res as never);
    expect(res.sent()).toEqual({ status: 200, body: '#!/bin/sh\nupdate\n' });
    expect(service.generateUpdateScript).toHaveBeenCalledWith('EDGE-REVPI-0001');
  });

  it('install: the same (the token check comes after the format check)', async () => {
    const res = response();
    await controller.getInstallerScript('EDGE-REVPI-0001', undefined, res as never);
    expect(res.sent()).toEqual({ status: 401, body: 'Provisioning token required' });
  });

  it.each(['a b', 'x'.repeat(51), 'a;b'])(
    'a code outside the contract is a 400: %j',
    async (code) => {
      for (const route of [
        (res: unknown) => controller.getInstallerScript(code, 'a'.repeat(64), res as never),
        (res: unknown) => controller.getUninstallScript(code, res as never),
        (res: unknown) => controller.getUpdateScript(code, res as never),
      ]) {
        const res = response();
        await route(res);
        expect(res.sent()).toEqual({ status: 400, body: 'Invalid device code format' });
      }
    },
  );
});
