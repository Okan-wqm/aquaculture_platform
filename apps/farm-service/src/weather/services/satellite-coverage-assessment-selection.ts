import { SATELLITE_COVERAGE_LEGACY_METHOD } from '../entities/environment-observation.types';
import { SatelliteSceneCoverageAssessment } from '../entities/satellite-scene-coverage-assessment.entity';
import { SatelliteSceneObservation } from '../entities/satellite-scene-observation.entity';
import { CDSE_COVERAGE_METHOD } from './cdse-sentinel.provider';

function newestAssessment(
  assessments: readonly SatelliteSceneCoverageAssessment[],
): SatelliteSceneCoverageAssessment | undefined {
  return [...assessments].sort((left, right) => {
    const timeDifference = right.createdAt.getTime() - left.createdAt.getTime();
    return timeDifference !== 0 ? timeDifference : right.id.localeCompare(left.id);
  })[0];
}

/**
 * Resolves the one canonical assessment exposed by read APIs without hiding
 * the append-only history retained for algorithm upgrades.
 */
export function selectSatelliteCoverageAssessment(
  scene: SatelliteSceneObservation,
): SatelliteSceneCoverageAssessment {
  const current = scene.coverageAssessments.find(
    (assessment) => assessment.coverageMethod === CDSE_COVERAGE_METHOD,
  );
  if (current) {
    return current;
  }

  const newestVersioned = newestAssessment(
    scene.coverageAssessments.filter(
      (assessment) => assessment.coverageMethod !== SATELLITE_COVERAGE_LEGACY_METHOD,
    ),
  );
  if (newestVersioned) {
    return newestVersioned;
  }

  const legacy = scene.coverageAssessments.find(
    (assessment) => assessment.coverageMethod === SATELLITE_COVERAGE_LEGACY_METHOD,
  );
  if (legacy) {
    return legacy;
  }

  throw new Error('Satellite scene has no persisted coverage assessment');
}
