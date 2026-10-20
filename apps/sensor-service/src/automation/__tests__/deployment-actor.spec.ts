import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ScheduledJobRunner } from '@aquaculture/backend-common/scheduling';

import type { RecordedActor } from '../../common/recorded-actor';
import { EdgeDeviceService } from '../../edge-device/edge-device.service';
import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import { EdgeCommandPublisher } from '../../edge-device/edge-command-publisher.service';
import {
  type BrokerDouble,
  publisherOverBroker,
} from '../../edge-device/test-helpers/edge-command-publisher';
import { AutomationResolver } from '../automation.resolver';
import { AutomationService } from '../automation.service';
import {
  AutomationProgram,
  DeployTarget,
  ProgramStatus,
} from '../entities/automation-program.entity';
import { DeploymentLog } from '../entities/deployment-log.entity';
import { ProgramStep } from '../entities/program-step.entity';
import { ProgramTransition } from '../entities/program-transition.entity';
import { ProgramVariable } from '../entities/program-variable.entity';
import { StepAction } from '../entities/step-action.entity';
import { DeploymentLogService } from '../services/deployment-log.service';

/**
 * A program deployment names the person behind it (command log, /sensor/commands).
 *
 * deployment_logs kept only the JWT subject, so the command log showed a user
 * UUID as "deployed by". Every write path now records the deployer's e-mail
 * next to the id, the way the VFD command ledger does: a deploy, a rollback
 * (whose four-eyes rule still compares ids), and the resolvers that hand the
 * authenticated caller in.
 */

const TENANT = '3f1c0b5e-8d7a-4c2b-9e61-5a4d3c2b1a09';
const PROGRAM_ID = 'b7e0a5c4-2f1d-4e3b-8a9c-6d5e4f3a2b10';
const DEVICE_ID = 'c8f1b6d5-3a2e-4f4c-9b0d-7e6f5a4b3c21';
const DEPLOYER: RecordedActor = {
  userId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  email: 'automation.engineer@farm.test',
};
const SECOND_PERSON: RecordedActor = {
  userId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  email: 'shift.lead@farm.test',
};

function setpointProgram(): AutomationProgram {
  return Object.assign(new AutomationProgram(), {
    id: PROGRAM_ID,
    tenantId: TENANT,
    programCode: 'AER-01',
    programName: 'Aeration cycle',
    status: ProgramStatus.APPROVED,
    deployTarget: DeployTarget.PLC_SETPOINT,
    targetPlcAddress: '10.0.0.20',
    targetPlcPort: 502,
    targetPlcProtocol: 'modbus',
    version: 4,
  });
}

describe('deployment actor (command log "deployed by")', () => {
  let service: AutomationService;
  let createLog: jest.Mock;
  let findLatestForProgram: jest.Mock;
  let programRepo: {
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    createLog = jest.fn().mockResolvedValue({ id: 'log-1' });
    findLatestForProgram = jest.fn();
    const versionBump = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    programRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(versionBump),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async (program: AutomationProgram) => program),
    };

    const module = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: getRepositoryToken(AutomationProgram), useValue: programRepo },
        { provide: getRepositoryToken(ProgramStep), useValue: {} },
        { provide: getRepositoryToken(StepAction), useValue: {} },
        { provide: getRepositoryToken(ProgramTransition), useValue: {} },
        { provide: getRepositoryToken(ProgramVariable), useValue: {} },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: ScheduledJobRunner, useValue: { run: jest.fn() } },
        {
          provide: EdgeDeviceService,
          useValue: {
            findByIdOrFail: jest
              .fn()
              .mockResolvedValue({ id: DEVICE_ID, deviceCode: 'EG-HALL-A', isOnline: true }),
          },
        },
        {
          provide: MqttClientService,
          useValue: {
            isConnectedToBroker: () => true,
            publish: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EdgeCommandPublisher,
          useFactory: (mqtt: BrokerDouble): EdgeCommandPublisher =>
            publisherOverBroker(mqtt, [{ id: DEVICE_ID, tenantId: TENANT }]),
          inject: [MqttClientService],
        },
        {
          provide: DeploymentLogService,
          useValue: { createLog, markDeploying: jest.fn(), findLatestForProgram },
        },
      ],
    }).compile();
    service = module.get(AutomationService);
    jest.spyOn(service, 'findByIdOrFail').mockImplementation(async () => setpointProgram());
  });

  it('a deploy records the deployer id and e-mail on its deployment log', async () => {
    const result = await service.deployProgram(PROGRAM_ID, DEVICE_ID, TENANT, DEPLOYER);

    expect(result.success).toBe(true);
    expect(createLog).toHaveBeenCalledTimes(1);
    expect(createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        programId: PROGRAM_ID,
        deviceId: DEVICE_ID,
        deployedBy: DEPLOYER.userId,
        deployedByEmail: DEPLOYER.email,
      }),
    );
    // The program row keeps the id: it is what identity checks compare.
    expect(programRepo.update).toHaveBeenCalledWith(
      PROGRAM_ID,
      expect.objectContaining({ deployedBy: DEPLOYER.userId }),
    );
  });

  it("a rollback records the initiator's e-mail, and the four-eyes rule compares ids", async () => {
    programRepo.findOne.mockResolvedValue(
      Object.assign(setpointProgram(), { status: ProgramStatus.DEPLOYED, deviceId: DEVICE_ID }),
    );
    findLatestForProgram.mockResolvedValue({ deployedBy: DEPLOYER.userId });

    await expect(service.rollbackDeployment(DEVICE_ID, TENANT, DEPLOYER)).rejects.toThrow(
      ForbiddenException,
    );
    expect(createLog).not.toHaveBeenCalled();

    const result = await service.rollbackDeployment(DEVICE_ID, TENANT, SECOND_PERSON);
    expect(result.success).toBe(true);
    expect(createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        deployedBy: SECOND_PERSON.userId,
        deployedByEmail: SECOND_PERSON.email,
      }),
    );
  });
});

describe('DeploymentLogService.createLog', () => {
  it('stores the deployer e-mail next to the deployer id', async () => {
    const repo = {
      create: jest.fn((row: Partial<DeploymentLog>) => row),
      save: jest.fn(async (row: Partial<DeploymentLog>) => ({ id: 'log-1', ...row })),
    };
    const module = await Test.createTestingModule({
      providers: [
        DeploymentLogService,
        { provide: getRepositoryToken(DeploymentLog), useValue: repo },
      ],
    }).compile();

    await module.get(DeploymentLogService).createLog({
      tenantId: TENANT,
      programId: PROGRAM_ID,
      deviceId: DEVICE_ID,
      commandId: 'cmd-1',
      version: 4,
      deployedBy: DEPLOYER.userId,
      deployedByEmail: DEPLOYER.email,
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ deployedBy: DEPLOYER.userId, deployedByEmail: DEPLOYER.email }),
    );
  });
});

describe('AutomationResolver hands the authenticated caller in as the actor', () => {
  it('deployProgram and rollbackDeployedProgram pass the JWT subject and e-mail', async () => {
    const automationService = {
      deployProgram: jest
        .fn()
        .mockResolvedValue({ success: true, programId: PROGRAM_ID, deviceId: DEVICE_ID }),
      rollbackDeployment: jest
        .fn()
        .mockResolvedValue({ success: true, programId: PROGRAM_ID, deviceId: DEVICE_ID }),
    };
    const module = await Test.createTestingModule({
      providers: [
        AutomationResolver,
        { provide: AutomationService, useValue: automationService },
        { provide: EdgeDeviceService, useValue: {} },
        { provide: DeploymentLogService, useValue: {} },
      ],
    }).compile();
    const resolver = module.get(AutomationResolver);
    const user = {
      sub: DEPLOYER.userId,
      email: 'automation.engineer@farm.test',
      tenantId: TENANT,
      roles: [],
    };

    await resolver.deployProgram({ programId: PROGRAM_ID, deviceId: DEVICE_ID }, TENANT, user);
    await resolver.rollbackDeployedProgram(DEVICE_ID, TENANT, user);

    expect(automationService.deployProgram).toHaveBeenCalledWith(
      PROGRAM_ID,
      DEVICE_ID,
      TENANT,
      { userId: DEPLOYER.userId, email: 'automation.engineer@farm.test' },
      undefined,
    );
    expect(automationService.rollbackDeployment).toHaveBeenCalledWith(DEVICE_ID, TENANT, {
      userId: DEPLOYER.userId,
      email: 'automation.engineer@farm.test',
    });
  });
});
