import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DeployArtifactType } from '../../deploy-artifact/entities/deploy-artifact.entity';
import {
  ReleaseBundle,
  ReleaseBundleStatus,
} from '../entities/release-bundle.entity';
import {
  ReleaseBundleService,
  isLegalBundleTransition,
} from '../release-bundle.service';

const TENANT = 'tenant-uuid-1';
const COMMAND = 'command-uuid-1';

function makeBundle(status: ReleaseBundleStatus): ReleaseBundle {
  const bundle = new ReleaseBundle();
  bundle.id = 'bundle-1';
  bundle.tenantId = TENANT;
  bundle.deviceId = 'device-1';
  bundle.commandId = COMMAND;
  bundle.manifest = {
    bundleId: 'bundle-1',
    artifacts: [
      {
        artifactId: 'artifact-1',
        kind: DeployArtifactType.SCADA_PACKAGE,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  bundle.manifestSha256 = 'b'.repeat(64);
  bundle.status = status;
  return bundle;
}

describe('ReleaseBundle state machine — invalid transitions are unrepresentable', () => {
  const ALL = Object.values(ReleaseBundleStatus);

  /** The COMPLETE legal edge set. Everything else must be rejected. */
  const LEGAL: ReadonlyArray<[ReleaseBundleStatus, ReleaseBundleStatus]> = [
    [ReleaseBundleStatus.PENDING, ReleaseBundleStatus.STAGED],
    [ReleaseBundleStatus.PENDING, ReleaseBundleStatus.FAILED],
    [ReleaseBundleStatus.STAGED, ReleaseBundleStatus.CONFIRMED],
    [ReleaseBundleStatus.STAGED, ReleaseBundleStatus.FAILED],
    [ReleaseBundleStatus.CONFIRMED, ReleaseBundleStatus.ROLLED_BACK],
  ];

  it('accepts exactly the documented edges and nothing else (exhaustive matrix)', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = LEGAL.some(([f, t]) => f === from && t === to);
        expect(isLegalBundleTransition(from, to)).toBe(expected);
      }
    }
  });

  it('terminal states have no outgoing edges', () => {
    for (const to of ALL) {
      expect(isLegalBundleTransition(ReleaseBundleStatus.FAILED, to)).toBe(false);
      expect(isLegalBundleTransition(ReleaseBundleStatus.ROLLED_BACK, to)).toBe(false);
    }
  });

  describe('service enforcement', () => {
    let service: ReleaseBundleService;
    let repo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };

    beforeEach(async () => {
      repo = {
        findOne: jest.fn(),
        save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
        create: jest.fn(),
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ReleaseBundleService,
          { provide: getRepositoryToken(ReleaseBundle), useValue: repo },
        ],
      }).compile();
      service = module.get(ReleaseBundleService);
    });

    it('PENDING → STAGED → CONFIRMED walks the happy path with timestamps', async () => {
      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.PENDING));
      const staged = await service.markStaged(TENANT, COMMAND);
      expect(staged.status).toBe(ReleaseBundleStatus.STAGED);
      expect(staged.stagedAt).toBeInstanceOf(Date);

      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.STAGED));
      const confirmed = await service.markConfirmed(TENANT, COMMAND);
      expect(confirmed.status).toBe(ReleaseBundleStatus.CONFIRMED);
      expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    });

    it('rejects CONFIRMED after FAILED (late duplicate ack cannot resurrect a dead bundle)', async () => {
      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.FAILED));
      await expect(service.markConfirmed(TENANT, COMMAND)).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects STAGED after CONFIRMED (replayed staging ack is a no-op error, not a regression)', async () => {
      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.CONFIRMED));
      await expect(service.markStaged(TENANT, COMMAND)).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects a second FAILED on a terminal FAILED bundle', async () => {
      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.FAILED));
      await expect(service.markFailed(TENANT, COMMAND, 'again')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('markRolledBack only from CONFIRMED', async () => {
      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.CONFIRMED));
      const rolled = await service.markRolledBack(TENANT, 'bundle-1');
      expect(rolled.status).toBe(ReleaseBundleStatus.ROLLED_BACK);

      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.PENDING));
      await expect(service.markRolledBack(TENANT, 'bundle-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('FAILED records the error message and timestamp', async () => {
      repo.findOne.mockResolvedValueOnce(makeBundle(ReleaseBundleStatus.STAGED));
      const failed = await service.markFailed(TENANT, COMMAND, 'checksum mismatch');
      expect(failed.status).toBe(ReleaseBundleStatus.FAILED);
      expect(failed.errorMessage).toBe('checksum mismatch');
      expect(failed.failedAt).toBeInstanceOf(Date);
    });
  });
});
