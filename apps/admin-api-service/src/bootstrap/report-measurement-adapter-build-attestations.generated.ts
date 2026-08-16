/**
 * Build-provenance projection for report measurement adapters.
 *
 * This file is the bootstrap input consumed by AnalyticsModule. It is compiled
 * against the exact authority graph, so adding a QUALIFIED catalog binding
 * without a corresponding build-produced attestation fails module bootstrap.
 * The current projection is intentionally empty because every production
 * measurement authority remains BLOCKED.
 */
import {
  COMPILED_REPORT_AUTHORITY_GRAPH,
  compileReportMeasurementAdapterBuildAttestationSet,
  type ReportMeasurementAdapterBuildAttestationSourceV1,
} from '@platform/reporting-contracts';

const BUILD_ATTESTATION_SOURCES = Object.freeze(
  [] satisfies readonly ReportMeasurementAdapterBuildAttestationSourceV1[],
);

export const COMPILED_REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATION_SET =
  compileReportMeasurementAdapterBuildAttestationSet(
    COMPILED_REPORT_AUTHORITY_GRAPH,
    BUILD_ATTESTATION_SOURCES,
  );
