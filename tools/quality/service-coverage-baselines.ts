import coverageBaselinesJson from './service-coverage-baselines.json';

export interface ServiceCoverageFloor {
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
  readonly statements: number;
}

export type ServiceCoverageProject =
  | 'admin-api-service'
  | 'auth-service'
  | 'billing-service'
  | 'farm-service'
  | 'hr-service'
  | 'sensor-service';

/**
 * First enforceable baselines captured when CI Full began running coverage on
 * every pull request. Keep these floors monotonic: raise them as coverage
 * improves, and never lower them to make a failing run pass.
 */
const coverageBaselines = Object.freeze(
  coverageBaselinesJson as Readonly<Record<ServiceCoverageProject, ServiceCoverageFloor>>,
);

export default coverageBaselines;
