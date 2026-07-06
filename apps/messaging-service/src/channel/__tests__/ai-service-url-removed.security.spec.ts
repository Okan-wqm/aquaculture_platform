import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { Channel } from '../entities/channel.entity';
import { CreateChannelInput } from '../dto/create-channel.input';

/**
 * MSG-HIGH-060 regression guard.
 *
 * The per-channel `aiServiceUrl` override was a data-exfiltration vector: a
 * member could set it to any public HTTPS endpoint and the bridge POSTed
 * tenantId + the last 50 messages there (SSRF checks only blocked internal
 * targets). This spec fails if anyone re-introduces the write path or a
 * persisted column, keeping the field a read-only, always-null, non-persisted
 * remnant kept solely for client back-compat.
 */
describe('aiServiceUrl exfiltration vector removal (MSG-HIGH-060)', () => {
  it('Channel.aiServiceUrl is NOT a persisted TypeORM column', () => {
    const columns = getMetadataArgsStorage().columns.filter(
      (c) => c.target === Channel,
    );
    const persisted = columns.map((c) => c.propertyName);
    expect(persisted).not.toContain('aiServiceUrl');
    // Sanity: the sibling AI field that legitimately persists is still a column.
    expect(persisted).toContain('aiPersona');
  });

  it('Channel.aiServiceUrl always reads as null (no data to exfiltrate)', () => {
    const channel = new Channel();
    expect(channel.aiServiceUrl).toBeNull();
  });

  it('CreateChannelInput does not accept an aiServiceUrl write', () => {
    // The DTO must not declare the field — a create request can no longer set a
    // member-controlled AI endpoint. class-validator/GraphQL only bind declared
    // properties, so an absent property is an un-writable one.
    const input = new CreateChannelInput();
    expect('aiServiceUrl' in input).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(CreateChannelInput.prototype, 'aiServiceUrl'),
    ).toBe(false);
  });
});
