export default {
  displayName: 'farm-service-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/__tests__/integration/**/*.spec.ts',
    '<rootDir>/src/**/*.integration.spec.ts',
    '<rootDir>/src/**/*.postgres.spec.ts',
    '<rootDir>/src/__tests__/e2e/race-conditions.spec.ts',
    // Saf statik/reflection kapısı (Docker gerektirmez), ama HİÇBİR config'e
    // girmiyordu: unit config `\.e2e-spec\.ts$`'i ignore ediyor ve buradaki
    // desenlerin hiçbiri ona ulaşmıyordu. Koşması bedava, koşmaması ise tam
    // olarak bu programın kapattığı sessiz-kapsam boşluğu.
    '<rootDir>/src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts',
  ],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/farm-service-integration',
  maxWorkers: 1,
  // Bir Testcontainers boot'u soğuk imajda 60 sn'yi aşabilir ve `testTimeout`
  // `beforeAll`'ı da kapsar. Süitler bugüne dek bunu dosya başına
  // `jest.setTimeout(120_000)` yazarak telafi ediyordu — kopyala-yapıştır
  // disiplini. Varsayılanı yükseltmek doğru davranışı sıfır-efor hâline
  // getirir (tier-2): satırı unutan yeni bir spec, gerçek bir kusur gibi
  // görünen sahte bir timeout üretmez.
  testTimeout: 120000,
};
