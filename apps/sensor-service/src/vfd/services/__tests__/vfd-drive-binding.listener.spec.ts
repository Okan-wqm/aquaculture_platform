/**
 * The three pieces of news a drive must act on, and what it does with each.
 *
 * Routing is the whole job of this class, so the tests assert on the effects it
 * asks the binding service for — an attestation applied with the OWNER's own
 * timestamp, a revocation on deletion, a unit-set rewrite on assignment change.
 */
import { createBaseEvent } from '@platform/event-contracts';
import type {
  BaseEvent,
  EquipmentDeletedEvent,
  UnitFeederAssignmentsChangedEvent,
  VfdDriveBindingAttestedEvent,
} from '@platform/event-contracts';
import { Test, TestingModule } from '@nestjs/testing';

import { VfdDriveBindingListener } from '../vfd-drive-binding.listener';
import { VfdDriveBindingService } from '../vfd-drive-binding.service';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const DRIVE = 'bbbbbbbb-2222-4333-8444-555555555555';
const EQUIPMENT = 'cccccccc-3333-4444-8555-666666666666';
const TANK = 'dddddddd-4444-4555-8666-777777777777';

interface BindingServiceDouble {
  applyAttestation: jest.Mock;
  revokeForEquipment: jest.Mock;
  applyUnitFeederSet: jest.Mock;
}

/** The bus double, so the subscription test can read the subjects asked for. */
interface EventBusDouble {
  subscribeTo: jest.Mock;
  publish: jest.Mock;
}

describe('VfdDriveBindingListener', () => {
  let bindingService: BindingServiceDouble;
  let eventBus: EventBusDouble;
  let listener: VfdDriveBindingListener;

  beforeEach(async () => {
    bindingService = {
      applyAttestation: jest.fn().mockResolvedValue(undefined),
      revokeForEquipment: jest.fn().mockResolvedValue(1),
      applyUnitFeederSet: jest.fn().mockResolvedValue(undefined),
    };
    eventBus = {
      subscribeTo: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdDriveBindingListener,
        { provide: VfdDriveBindingService, useValue: bindingService },
        { provide: 'EVENT_BUS', useValue: eventBus },
      ],
    }).compile();

    listener = module.get<VfdDriveBindingListener>(VfdDriveBindingListener);
  });

  it('applies an attestation, stamped with the moment the OWNER looked', async () => {
    const event: VfdDriveBindingAttestedEvent = {
      ...createBaseEvent<VfdDriveBindingAttestedEvent>('VfdDriveBindingAttested', TENANT, {
        aggregateId: EQUIPMENT,
        aggregateType: 'Equipment',
      }),
      timestamp: '2026-08-07T10:00:00.000Z',
      vfdDeviceId: DRIVE,
      drivenEquipmentId: EQUIPMENT,
      outcome: 'attested',
      equipmentCategory: 'feeding',
      equipmentCode: 'F-1',
      equipmentName: 'Feeder 1',
      servedUnits: [{ unitId: TANK, unitType: 'tank', unitCode: 'T-1', doseSharePercent: 100 }],
    };

    await listener.handle(event);

    expect(bindingService.applyAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        vfdDeviceId: DRIVE,
        drivenEquipmentId: EQUIPMENT,
        outcome: 'attested',
        equipmentCategory: 'feeding',
        // Freshness is judged from when the owner looked, not from delivery time —
        // a message that sat in a queue must not look newer than it is.
        attestedAt: new Date('2026-08-07T10:00:00.000Z'),
        servedUnits: [{ unitId: TANK, unitType: 'tank', unitCode: 'T-1', doseSharePercent: 100 }],
      }),
    );
  });

  it('drops an attestation whose shape it cannot trust, leaving the drive unattested', async () => {
    // A unit id that is not a uuid. The static type is satisfied — only the wire
    // schema catches it — and believing it would write a binding row pointing at
    // a container nothing can resolve.
    const event: VfdDriveBindingAttestedEvent = {
      ...createBaseEvent<VfdDriveBindingAttestedEvent>('VfdDriveBindingAttested', TENANT, {
        aggregateId: EQUIPMENT,
        aggregateType: 'Equipment',
      }),
      vfdDeviceId: DRIVE,
      drivenEquipmentId: EQUIPMENT,
      outcome: 'attested',
      equipmentCategory: 'feeding',
      servedUnits: [
        { unitId: 'not-a-uuid', unitType: 'tank', unitCode: 'T-1', doseSharePercent: 100 },
      ],
    };

    await listener.handle(event);

    expect(bindingService.applyAttestation).not.toHaveBeenCalled();
  });

  it('drops an attestation carrying an over-long equipment name', async () => {
    const event: VfdDriveBindingAttestedEvent = {
      ...createBaseEvent<VfdDriveBindingAttestedEvent>('VfdDriveBindingAttested', TENANT, {
        aggregateId: EQUIPMENT,
        aggregateType: 'Equipment',
      }),
      vfdDeviceId: DRIVE,
      drivenEquipmentId: EQUIPMENT,
      outcome: 'attested',
      equipmentCategory: 'pump',
      equipmentName: 'x'.repeat(501),
      servedUnits: [],
    };

    await listener.handle(event);

    expect(bindingService.applyAttestation).not.toHaveBeenCalled();
  });

  it('revokes every binding onto deleted equipment, without waiting for a refresh', async () => {
    const event: EquipmentDeletedEvent = {
      ...createBaseEvent<EquipmentDeletedEvent>('EquipmentDeleted', TENANT, {
        aggregateId: EQUIPMENT,
        aggregateType: 'Equipment',
      }),
      equipmentId: EQUIPMENT,
      name: 'Feeder 1',
      code: 'F-1',
      deletedAt: '2026-08-07T10:00:00.000Z',
    };

    await listener.handle(event);

    expect(bindingService.revokeForEquipment).toHaveBeenCalledWith(TENANT, EQUIPMENT);
  });

  it('rewrites the unit’s feeder set, so an ended assignment stops being claimed', async () => {
    const event: UnitFeederAssignmentsChangedEvent = {
      ...createBaseEvent<UnitFeederAssignmentsChangedEvent>(
        'UnitFeederAssignmentsChanged',
        TENANT,
        { aggregateId: TANK, aggregateType: 'FeederAssignment' },
      ),
      unitId: TANK,
      unitType: 'tank',
      unitCode: 'T-1',
      siteId: 'site-1',
      feeders: [],
      endedAssignmentIds: ['assignment-1'],
    };

    await listener.handle(event);

    expect(bindingService.applyUnitFeederSet).toHaveBeenCalledWith({
      tenantId: TENANT,
      unitId: TANK,
      unitType: 'tank',
      unitCode: 'T-1',
      feeders: [],
    });
  });

  it('acts on nothing when the tenant cannot be trusted', async () => {
    const event = {
      ...createBaseEvent<EquipmentDeletedEvent>('EquipmentDeleted', TENANT, {
        aggregateId: EQUIPMENT,
        aggregateType: 'Equipment',
      }),
      tenantId: 'not-a-uuid',
      equipmentId: EQUIPMENT,
      name: 'Feeder 1',
      code: 'F-1',
      deletedAt: '2026-08-07T10:00:00.000Z',
    } as BaseEvent;

    await listener.handle(event);

    expect(bindingService.revokeForEquipment).not.toHaveBeenCalled();
  });

  it('subscribes to all three subjects with the publisher’s 3-segment shape', async () => {
    await listener.onModuleInit();

    expect(eventBus.subscribeTo.mock.calls.map((call) => call[0])).toEqual([
      'events.*.VfdDriveBindingAttested',
      'events.*.EquipmentDeleted',
      'events.*.UnitFeederAssignmentsChanged',
    ]);
  });
});
