/**
 * Public API for the ScadaRuntime feature module.
 *
 * Import the module itself and any re-exported services / DTOs / entities
 * from this single entry point rather than from deep internal paths.
 */

export { ScadaRuntimeModule } from './scada-runtime.module';
export * from './services';
export * from './dto';
export * from './entities';
