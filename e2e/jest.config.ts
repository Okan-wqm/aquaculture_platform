import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';

const workspaceCompilerOptions = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions: { paths?: Record<string, string[]> };
  }
).compilerOptions;
const workspaceModuleNameMapper = pathsToModuleNameMapper(workspaceCompilerOptions.paths ?? {}, {
  prefix: '<rootDir>/../',
});

const config: Config = {
  displayName: 'e2e-workflow',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testMatch: ['<rootDir>/tests/**/*.spec.ts'],
  // Playwright-run suites (security, water-chemistry, mobile) are excluded —
  // the runner boundary is explicit so Jest never loads @playwright/test specs.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/security/',
    '<rootDir>/tests/water-chemistry/',
    '<rootDir>/tests/mobile/',
  ],
  // Resolve every workspace package from the same path authority used by
  // TypeScript and Nx. A library addition must not require a second Jest-only
  // alias registry before schema invariants can load the production graph.
  moduleNameMapper: workspaceModuleNameMapper,
};

export default config;
