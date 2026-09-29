import { createHash } from 'crypto';
import type { Repository } from 'typeorm';
import { collaborator } from '@aquaculture/testing';

import { AuditService, fingerprintToolOutput } from '../audit.service';
import type { ToolExecutionAudit } from '../tool-execution-audit.entity';
import type { ToolResult } from '../../tools/core/tool.interface';
import { humanToolContext } from '../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';

/**
 * K7 / K10 (V-T1b-6): `ai.tool_execution_audit` is one table for every tenant,
 * so it keeps a fingerprint of a tool's output — never the output itself.
 */
describe('AuditService — tool output fingerprint', () => {
  const ctx = humanToolContext({ userId: 'u1' });
  const secret = { tankId: 'T-9', dissolvedOxygen: 4.2, financeTotal: 91000 };
  const result: ToolResult = { success: true, data: secret, durationMs: 3, cacheable: false };

  const build = (): { service: AuditService; create: jest.Mock } => {
    const create = jest.fn().mockImplementation((row: Partial<ToolExecutionAudit>) => row);
    const repo = collaborator<Repository<ToolExecutionAudit>>(
      { create, save: jest.fn().mockResolvedValue(undefined) },
      'Repository<ToolExecutionAudit>',
    );
    return { service: new AuditService(repo), create };
  };

  it('stores the sha256 and byte size of the output, not the payload', async () => {
    // SCENARIO: a farm tool returns tenant business data.
    // EXPECTS: the row carries a fingerprint; no field of it holds the payload.
    const { service, create } = build();
    await service.logToolExecution('get_tank_capacity', {}, result, ctx);

    const serialized = JSON.stringify(secret);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSha256: createHash('sha256').update(serialized).digest('hex'),
        outputBytes: Buffer.byteLength(serialized, 'utf8'),
      }),
    );
    const row: unknown = create.mock.calls[0]?.[0];
    expect(row).not.toHaveProperty('output');
    expect(JSON.stringify(row)).not.toContain('91000');
  });

  it('stores no fingerprint for a failed call', async () => {
    const { service, create } = build();
    await service.logToolExecution(
      'get_tank_capacity',
      {},
      { success: false, error: 'boom', durationMs: 1, cacheable: false },
      ctx,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ outputSha256: undefined, outputBytes: undefined }),
    );
  });

  it('fingerprints an explicit null and leaves undefined unfingerprinted', () => {
    expect(fingerprintToolOutput(null)).toEqual({
      outputSha256: createHash('sha256').update('null').digest('hex'),
      outputBytes: 4,
    });
    expect(fingerprintToolOutput(undefined)).toBeUndefined();
  });
});
