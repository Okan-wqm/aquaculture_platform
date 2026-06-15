export default {
  displayName: 'auth-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/auth-service',
  // AUDIT-MEDIUM-015 mock hygiene: without these, jest.spyOn/mock state leaks
  // across the service's spec files. restoreMocks restores spied originals and
  // clearMocks resets call counts between tests. resetMocks stays FALSE on
  // purpose — resetMocks:true wipes mockReturnValue/mockImplementation primed in
  // beforeEach (token.service.spec / authentication.service.spec rely on that).
  restoreMocks: true,
  clearMocks: true,
  resetMocks: false,
  // AUDIT-MEDIUM-015 (PARTIAL): mock hygiene above is the substantive, safe fix.
  // The finding also asked to raise this floor to ~80 and scope the coverage
  // denominator (collectCoverageFrom). Empirically the auth-service suite covers
  // only ~42% lines / ~25% functions of the executable domain code, so an 80%
  // floor is NOT yet achievable — reaching it requires the AUDIT-HIGH-009 spec
  // expansion (jwt-auth.guard, webauthn, provisioning, RBAC, RLS specs), which is
  // largely REMAINING. Raising the floor + adding a domain-scoped
  // collectCoverageFrom must land WITH those specs (otherwise the gate fails for
  // the wrong reason or the number regresses against the current inflated-glob
  // baseline). Keeping the existing 60% floor here; the floor-raise is tracked.
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60,
    },
  },
};
