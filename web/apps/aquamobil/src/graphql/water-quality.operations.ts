import { gql } from 'graphql-tag';

/**
 * Water-quality documents live here, not beside the page, so codegen's aquamobil
 * pluck set (`web/apps/aquamobil/src/graphql/**\/*.ts`, codegen.ts:47) reaches
 * them and emits `CreateWaterQualityInput` into `src/generated/graphql.ts`.
 *
 * WHY THIS FILE EXISTS: the input type used to be hand-mirrored in `src/types`.
 * When farm-service deleted the fixed `parameters` field in favour of
 * `dynamicParameters`, the mirror kept it, the page kept sending it, and GraphQL
 * variable coercion rejected EVERY measurement at runtime while the offline lane
 * still rendered a success screen. A hand-written mirror cannot fail at compile
 * time; the generated type can, which is the whole point of moving these here.
 */

/**
 * Fetch all active equipment using the equipmentList query.
 * Uses { isActive: true } filter to match the web RecordTab behavior,
 * ensuring non-tank equipment (sensors, pumps, filters) with
 * status='operational' are included alongside tank equipment (status='active').
 */
export const EQUIPMENT_LIST_QUERY = gql`
  query EquipmentList($filter: EquipmentFilterInput) {
    equipmentList(filter: $filter) {
      items {
        id
        name
        code
        equipmentType {
          category
          name
        }
      }
    }
  }
`;

export const EQUIPMENT_PARAMS_QUERY = gql`
  query EquipmentParameters($equipmentId: ID!) {
    equipmentParameters(equipmentId: $equipmentId) {
      parameterConfig {
        id
        code
        name
        unit
        dataType
        precision
        group
        optimalMin
        optimalMax
        warningMin
        warningMax
        criticalMin
        criticalMax
        enumValues
        displayOrder
        isRequired
        chartColor
      }
    }
  }
`;

export const CREATE_WQ_MUTATION = gql`
  mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!) {
    createWaterQualityMeasurement(input: $input) {
      id
      overallStatus
      hasAlarm
    }
  }
`;
