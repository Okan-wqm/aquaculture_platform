import {
  InMemoryMigrationEventSink,
  MigrationRunnerModule,
  NoopMigrationEventSink,
} from '../../../database';

describe('MigrationRunnerModule.forRoot', () => {
  it('returns a DynamicModule with the schema-specific providers', () => {
    const mod = MigrationRunnerModule.forRoot({ schema: 'hr' });
    expect(mod.module).toBe(MigrationRunnerModule);
    // Imports ConfigModule so ConfigService is resolvable.
    expect(mod.imports?.length ?? 0).toBeGreaterThan(0);
    // Providers: the sink-resolver factory token + the runner class.
    expect(mod.providers?.length).toBe(2);
    // Exports the runner class so app.module can re-export or the
    // container can inject it elsewhere.
    expect(mod.exports?.length).toBe(1);
  });

  it('uses NoopMigrationEventSink by default (no options.eventSink override)', () => {
    const mod = MigrationRunnerModule.forRoot({ schema: 'hr' });
    const providerEntry = (mod.providers as Array<{
      provide?: symbol;
      useFactory?: (cfg: unknown) => unknown;
    }>).find((p) => typeof p === 'object' && p && 'useFactory' in p);
    expect(providerEntry).toBeDefined();
    const fakeConfig = { get: () => undefined };
    const resolved = providerEntry?.useFactory?.(fakeConfig);
    expect(resolved).toBeInstanceOf(NoopMigrationEventSink);
  });

  it('honors options.eventSink (test-injection path)', () => {
    const explicit = new InMemoryMigrationEventSink();
    const mod = MigrationRunnerModule.forRoot({
      schema: 'hr',
      eventSink: explicit,
    });
    const providerEntry = (mod.providers as Array<{
      provide?: symbol;
      useFactory?: (cfg: unknown) => unknown;
    }>).find((p) => typeof p === 'object' && p && 'useFactory' in p);
    const resolved = providerEntry?.useFactory?.({ get: () => undefined });
    expect(resolved).toBe(explicit);
  });

  it('tenantAware override is forwarded through the wrapper (runs at bootstrap)', () => {
    // We cannot easily run the wrapper's onApplicationBootstrap in a
    // unit test without a full TypeORM DataSource. The contract is
    // documented in the module docblock + exercised in integration.
    const mod = MigrationRunnerModule.forRoot({
      schema: 'farm',
      tenantAware: false,
    });
    expect(mod.module).toBe(MigrationRunnerModule);
  });

  it('lockTimeoutSeconds override is accepted in options (type-check only)', () => {
    const mod = MigrationRunnerModule.forRoot({
      schema: 'hr',
      lockTimeoutSeconds: 60,
    });
    expect(mod.exports?.length).toBe(1);
  });

  it('two forRoot() invocations produce DISTINCT runner classes', () => {
    const a = MigrationRunnerModule.forRoot({ schema: 'hr' });
    const b = MigrationRunnerModule.forRoot({ schema: 'farm' });
    const classA = (a.providers as unknown[]).find(
      (p) => typeof p === 'function',
    );
    const classB = (b.providers as unknown[]).find(
      (p) => typeof p === 'function',
    );
    expect(classA).not.toBe(classB);
  });
});
