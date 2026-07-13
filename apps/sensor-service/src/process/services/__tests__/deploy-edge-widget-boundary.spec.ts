import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { Process } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';
import { MqttClientService } from '../../../shared-mqtt/mqtt-client.service';
import { EdgeDeviceService } from '../../../edge-device/edge-device.service';

/**
 * CONTRACT-H-002 — the publish-boundary widget transform.
 *
 * The builder emits ~53 widget types; the Rust edge parses 16. Before this
 * boundary existed, ONE unknown type made the whole package undeployable on
 * the device (serde enum failure) while the cloud reported success. Now:
 * control-semantics widgets (knob, vfd*, equipment, …) REJECT the deploy
 * with every violator named; decorative/display-only widgets are STRIPPED
 * from the shipped payload (the stored row keeps them) and the success
 * message says so.
 */

const TENANT = 'tenant-uuid-1';

function pkgRow(widgets: Array<Record<string, unknown>>): Partial<ScadaPackage> {
  return {
    id: 'pkg-1',
    tenantId: TENANT,
    name: 'HMI',
    status: ScadaPackageStatus.DRAFT,
    version: 2,
    packageData: {
      meta: { schemaVersion: 2, packageName: 'HMI' },
      screens: [
        {
          id: 's1',
          name: 'Main',
          screenType: 'dashboard',
          isDefault: true,
          widgets,
        },
      ],
    },
  };
}

function widget(id: string, widgetType: string): Record<string, unknown> {
  return { id, widgetType, position: { col: 0, row: 0, w: 2, h: 2 }, config: {} };
}

describe('deploy edge-widget boundary (CONTRACT-H-002)', () => {
  let service: ScadaPackageService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let publish: jest.Mock;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    publish = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
        {
          provide: MqttClientService,
          useValue: { isConnectedToBroker: () => true, publish },
        },
        {
          provide: EdgeDeviceService,
          useValue: {
            findByIdOrFail: jest.fn().mockResolvedValue({
              id: 'dev-1',
              deviceCode: 'EDGE-01',
              isOnline: true,
            }),
          },
        },
      ],
    }).compile();
    service = module.get(ScadaPackageService);
  });

  it('REJECTS a package with control-semantics widgets, naming every violator, before the broker', async () => {
    repo.findOne.mockResolvedValue(
      pkgRow([widget('w-knob', 'knob'), widget('w-gauge', 'gauge'), widget('w-vfd', 'vfdDrive')]),
    );

    await expect(
      service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1'),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: expect.stringMatching(/knob.*w-knob.*vfdDrive.*w-vfd/s),
    });
    expect(publish).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled(); // never flips PUBLISHED
  });

  it('STRIPS decorative widgets from the shipped payload but keeps them in the stored row', async () => {
    const row = pkgRow([
      widget('w-gauge', 'gauge'),
      widget('w-text', 'staticText'),
      widget('w-svg', 'svgRect'),
    ]);
    repo.findOne.mockResolvedValue(row);

    const result = await service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1');

    expect(result.success).toBe(true);
    expect(result.message).toContain('2'); // stripped count surfaced
    expect(result.message).toContain('staticText');

    expect(publish).toHaveBeenCalledTimes(1);
    const [, payload] = publish.mock.calls[0] as [string, { params: { screens: Array<{ widgets: Array<{ id: string }> }> } }];
    expect(payload.params.screens[0]!.widgets.map((w) => w.id)).toEqual(['w-gauge']);

    // The stored document is untouched — stripping is a PUBLISH concern.
    const storedScreens = (row.packageData as { screens: Array<{ widgets: unknown[] }> }).screens;
    expect(storedScreens[0]!.widgets).toHaveLength(3);
  });

  it('a fully-supported package deploys with no strip note', async () => {
    repo.findOne.mockResolvedValue(
      pkgRow([widget('w-gauge', 'gauge'), widget('w-toggle', 'toggleSwitch')]),
    );

    const result = await service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1');

    expect(result.success).toBe(true);
    expect(result.message).toBe('SCADA package deployed successfully');
    const [, payload] = publish.mock.calls[0] as [string, { params: { screens: Array<{ widgets: unknown[] }> } }];
    expect(payload.params.screens[0]!.widgets).toHaveLength(2);
  });
});
