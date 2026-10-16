import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { RecordedActor } from '../../../common/recorded-actor';
import { OpcUaAdapter } from '../../../protocol/adapters/industrial/opcua.adapter';
import type { CreateFeedingParameterDto } from '../../dto/feeding-parameter.dto';
import { FeedingParameter, ParameterStatus } from '../../entities/feeding-parameter.entity';
import { PlcConnection } from '../../entities/plc-connection.entity';
import { PlcControlResolver } from '../../resolvers/plc-control.resolver';
import { FeedingParameterService } from '../feeding-parameter.service';
import { PlcAlarmService } from '../plc-alarm.service';
import { PlcConnectionService } from '../plc-connection.service';
import { PlcTelemetryService } from '../plc-telemetry.service';

/**
 * A feeding parameter set names the person who prepared it (command log,
 * /sensor/commands, "Prepared by").
 *
 * `createdBy` held only the JWT subject, so the feeding sends of the command
 * log showed a user UUID. Creating and cloning a set now records the author's
 * e-mail next to the id, and the resolvers hand the authenticated caller in.
 */

const TENANT = '5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c';
const CONNECTION_ID = '6f5e4d3c-2b1a-4098-8e7d-6c5b4a3f2e1d';
const AUTHOR: RecordedActor = {
  userId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
  email: 'feed.manager@farm.test',
};

function createInput(): CreateFeedingParameterDto {
  return {
    plcConnectionId: CONNECTION_ID,
    name: 'Spring ration',
    biomassKg: 1200,
    fcr: 1.1,
    targetDailyFeedKg: 24,
    schedule: [{ time: '08:00', amountKg: 12 }],
    thresholds: { oxygenMin: 5, oxygenCritical: 4, tempMax: 18, tempCritical: 20 },
    vfdSettings: { blowerMinSpeed: 10, blowerMaxSpeed: 90, doserMinSpeed: 10, doserMaxSpeed: 90 },
  };
}

describe('feeding parameter author (command log "prepared by")', () => {
  let service: FeedingParameterService;
  let repo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((row: Partial<FeedingParameter>) =>
        Object.assign(new FeedingParameter(), row),
      ),
      save: jest.fn(async (row: FeedingParameter) => Object.assign(row, { id: 'fp-new' })),
      findOne: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        FeedingParameterService,
        { provide: getRepositoryToken(FeedingParameter), useValue: repo },
        {
          provide: getRepositoryToken(PlcConnection),
          useValue: {
            findOne: jest.fn().mockResolvedValue({ id: CONNECTION_ID, tenantId: TENANT }),
          },
        },
        { provide: OpcUaAdapter, useValue: {} },
      ],
    }).compile();
    service = module.get(FeedingParameterService);
  });

  it('create records the author id and e-mail', async () => {
    await service.create(createInput(), TENANT, AUTHOR);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ParameterStatus.DRAFT,
        createdBy: AUTHOR.userId,
        createdByEmail: AUTHOR.email,
      }),
    );
  });

  it("clone records the cloning person as the new set's author", async () => {
    repo.findOne.mockResolvedValue(
      Object.assign(new FeedingParameter(), {
        ...createInput(),
        id: 'fp-1',
        tenantId: TENANT,
        version: '1.0',
        status: ParameterStatus.ACTIVE,
        createdBy: 'someone-else',
        createdByEmail: 'someone.else@farm.test',
      }),
    );

    await service.clone('fp-1', TENANT, undefined, AUTHOR);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ParameterStatus.DRAFT,
        createdBy: AUTHOR.userId,
        createdByEmail: AUTHOR.email,
      }),
    );
  });
});

describe('PlcControlResolver hands the authenticated caller in as the author', () => {
  it('createFeedingParameter and cloneFeedingParameter pass the JWT subject and e-mail', async () => {
    const feedingParameterService = {
      create: jest.fn().mockResolvedValue({ id: 'fp-new' }),
      clone: jest.fn().mockResolvedValue({ id: 'fp-clone' }),
    };
    const module = await Test.createTestingModule({
      providers: [
        PlcControlResolver,
        { provide: FeedingParameterService, useValue: feedingParameterService },
        { provide: PlcConnectionService, useValue: {} },
        { provide: PlcAlarmService, useValue: {} },
        { provide: PlcTelemetryService, useValue: {} },
      ],
    }).compile();
    const resolver = module.get(PlcControlResolver);
    const user = {
      sub: AUTHOR.userId,
      email: 'feed.manager@farm.test',
      tenantId: TENANT,
      roles: ['MODULE_MANAGER'],
    };
    const input = createInput();

    await resolver.createFeedingParameter(input, TENANT, user);
    await resolver.cloneFeedingParameter('fp-1', 'Spring ration v2', TENANT, user);

    const actor = { userId: AUTHOR.userId, email: 'feed.manager@farm.test' };
    expect(feedingParameterService.create).toHaveBeenCalledWith(input, TENANT, actor);
    expect(feedingParameterService.clone).toHaveBeenCalledWith(
      'fp-1',
      TENANT,
      'Spring ration v2',
      actor,
    );
  });
});
