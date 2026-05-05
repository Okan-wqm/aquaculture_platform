export { StandardHealthController } from './standard-health.controller';
// Type-only re-exports — must be declared with `export type` under
// isolatedModules. Without the modifier, isolatedModules-aware
// transpilers (SWC, esbuild, ts-jest with isolatedModules option)
// cannot drop them at compile time and risk emitting orphan runtime
// references. Tightened monorepo-wide in PR-41 (PROC-MEDIUM-011).
export type {
  StandardHealthResponse,
  FrameworkVersionInfo,
  ReadinessResponse,
  HealthControllerOptions,
} from './standard-health.controller';

export { StandardHealthModule } from './standard-health.module';
