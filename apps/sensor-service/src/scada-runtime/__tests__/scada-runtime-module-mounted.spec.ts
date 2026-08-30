import 'reflect-metadata';

import { AppModule } from '../../app.module';
import { ScadaRuntimeModule } from '../scada-runtime.module';

/**
 * SENSOR-HIGH-045 — ScadaRuntimeModule must be mounted in AppModule.
 *
 * The /scada WebSocket control plane (gateway, tag manager, alarm engine,
 * DAQ storage) lived as a complete but UNIMPORTED module: nothing referenced
 * ScadaRuntimeModule, so the gateway never mounted in the running service and
 * every operator runtime feature — subscribe, tag write, alarm ack — was dead
 * code. This pins the AppModule import so the control plane cannot silently
 * fall out of the composition root again.
 */
describe('ScadaRuntimeModule mount (SENSOR-HIGH-045)', () => {
  it('AppModule imports ScadaRuntimeModule', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(Array.isArray(imports)).toBe(true);
    expect(imports).toContain(ScadaRuntimeModule);
  });
});
