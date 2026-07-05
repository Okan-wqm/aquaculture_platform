import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * FAZ0-BOOT-02 architecture invariant.
 *
 * WHY: OutboxModule.forFeature(AiOutbox) wires repositories/publishers but the
 * DataSource learns entity METADATA only from the root `entities:` list in
 * app.module.ts. When AiOutbox was missing there, outbox repository DI failed
 * and SourceSchemaBootstrap/TenantSchemaSync never created the outbox table —
 * the service could not boot in a composed environment. Sibling precedent:
 * messaging-service registers MessagingOutbox in both places.
 *
 * Source-level check (same style as the farm tenant-schema-routing
 * architecture spec): every entity under src/outbox must appear in the
 * TypeORM entities list.
 */
describe('ai-service TypeORM entity registration (FAZ0-BOOT-02)', () => {
  const appModuleSource = readFileSync(
    join(__dirname, '..', 'app.module.ts'),
    'utf8',
  );

  const readEntitiesList = (): string => {
    const match = appModuleSource.match(/entities:\s*\[([^\]]*)\]/);
    const captured = match?.[1];
    if (captured === undefined) {
      throw new Error(
        'app.module.ts no longer declares an inline `entities: [...]` list — update this spec alongside the config refactor',
      );
    }
    return captured;
  };

  it('registers AiOutbox in the DataSource entities list', () => {
    expect(readEntitiesList()).toContain('AiOutbox');
  });

  it('registers every domain entity the modules depend on', () => {
    const entities = readEntitiesList();
    for (const required of [
      'AgentConversation',
      'TenantAgentConfig',
      'ToolExecutionAudit',
      'AiOutbox',
    ]) {
      expect(entities).toContain(required);
    }
  });
});
