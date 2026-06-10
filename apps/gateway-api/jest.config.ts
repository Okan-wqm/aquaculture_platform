export default {
  displayName: 'gateway-api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // WHY: seeds INTERNAL_SERVICE_SECRET before any module import — the
  // HIGH-003 HMAC signer hard-fails without it and every proxied request
  // in the suite exercises the signing path.
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/gateway-api',
};
