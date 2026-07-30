import coverageBaselinesJson from './service-coverage-baselines.json';

export interface ServiceCoverageFloor {
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
  readonly statements: number;
}

export type ServiceCoverageProject = keyof typeof coverageBaselinesJson;

/**
 * TypeScript resolves the Jest configs' `.js` import to this typed adapter,
 * while Jest's early config loader consumes the CommonJS sibling. Both expose
 * the same JSON data SSoT; project identities are derived from that JSON.
 */
const coverageBaselines: Readonly<Record<ServiceCoverageProject, ServiceCoverageFloor>> =
  Object.freeze(coverageBaselinesJson);

export default coverageBaselines;
