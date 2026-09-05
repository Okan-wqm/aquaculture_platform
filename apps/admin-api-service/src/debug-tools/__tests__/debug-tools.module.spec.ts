import { DebugToolsModule } from '../debug-tools.module';

describe('DebugToolsModule.forRoot production posture (INFRA-HIGH-142)', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('registers an empty shell when the flag is unset', () => {
    delete process.env['ENABLE_DEBUG_TOOLS'];
    process.env['NODE_ENV'] = 'production';
    const dynamic = DebugToolsModule.forRoot();
    expect(dynamic.controllers ?? []).toHaveLength(0);
    expect(dynamic.providers ?? []).toHaveLength(0);
  });

  it('refuses to boot when the flag is true in production', () => {
    process.env['ENABLE_DEBUG_TOOLS'] = 'true';
    process.env['NODE_ENV'] = 'production';
    expect(() => DebugToolsModule.forRoot()).toThrow(/not permitted when NODE_ENV=production/);
  });

  it('still honours the flag outside production', () => {
    process.env['ENABLE_DEBUG_TOOLS'] = 'true';
    process.env['NODE_ENV'] = 'development';
    const dynamic = DebugToolsModule.forRoot();
    expect((dynamic.controllers ?? []).length).toBeGreaterThan(0);
  });
});
