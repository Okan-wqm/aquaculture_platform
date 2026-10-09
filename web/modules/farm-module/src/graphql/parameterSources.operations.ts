/**
 * Parameter-source write operations and the reads only the binding UI makes
 * (FARM-HIGH-373): bind, unbind and replace a sensor channel as a source of a
 * water-quality parameter at a measurement point, the bind's dry run, what a
 * parameter records (declare / clear its measured quantity) and the channels
 * of a sensor to pick from.
 *
 * The reads both modules make — the sources at a point and a calculation's
 * resolved inputs — and the source-row fragment live in shared-ui
 * (`@aquaculture/shared-ui` water-chemistry/sources/operations.ts); these
 * documents append that fragment so a source row reads the same everywhere.
 *
 * @module FarmModule/GraphQL
 */
import {
  PARAMETER_SOURCE_FIELDS,
  type BoundChannelResult,
  type ParameterSourceRow,
} from '@aquaculture/shared-ui';
import type {
  ChannelBindingProblem,
  DataChannelType,
  WaterQualityParameterConfig,
} from '@platform/shared-ui/generated/graphql-types';

/** The selected fields of a schema type: present, nullable as the schema says. */
type Selected<T, K extends keyof T> = { readonly [P in K]-?: Exclude<T[P], undefined> };

export const BIND_PARAMETER_CHANNEL_MUTATION = `
  mutation BindParameterChannel($input: BindParameterChannelInput!) {
    bindParameterChannel(input: $input) {
      ...ParameterSourceFields
    }
  }
  ${PARAMETER_SOURCE_FIELDS}
`;

export interface BindParameterChannelResult {
  bindParameterChannel: ParameterSourceRow;
}

export const UNBIND_PARAMETER_CHANNEL_MUTATION = `
  mutation UnbindParameterChannel($sourceId: ID!) {
    unbindParameterChannel(sourceId: $sourceId) {
      unbound {
        ...ParameterSourceFields
      }
      promoted {
        ...ParameterSourceFields
      }
    }
  }
  ${PARAMETER_SOURCE_FIELDS}
`;

export interface UnbindParameterChannelResult {
  unbindParameterChannel: {
    unbound: ParameterSourceRow;
    /** The backup that took the unbound primary's place, if there was one. */
    promoted: ParameterSourceRow | null;
  };
}

export const REPLACE_PARAMETER_CHANNEL_MUTATION = `
  mutation ReplaceParameterChannel($input: ReplaceParameterChannelInput!) {
    replaceParameterChannel(input: $input) {
      ...ParameterSourceFields
    }
  }
  ${PARAMETER_SOURCE_FIELDS}
`;

export interface ReplaceParameterChannelResult {
  replaceParameterChannel: ParameterSourceRow;
}

/** The bind's own rule, without binding: the channel now and the problems a bind would be refused with. */
export const CHECK_PARAMETER_CHANNEL_BINDING_QUERY = `
  query CheckParameterChannelBinding($input: BindParameterChannelInput!) {
    checkParameterChannelBinding(input: $input) {
      channel {
        sensorId
        channelKey
        presence
        sensorActive
        enabled
        quantity
        unit
        latestValue
        latestAt
        latestQuality
        calibrationDueAt
      }
      problems
    }
  }
`;

export interface CheckParameterChannelBindingResult {
  checkParameterChannelBinding: {
    channel: BoundChannelResult;
    problems: ChannelBindingProblem[];
  };
}

/** What a parameter records and whether a channel fixes it (liveChannelSourceCount > 0). */
export const PARAMETER_QUANTITY_STATE_QUERY = `
  query ParameterQuantityState($id: ID!) {
    parameterConfig(id: $id) {
      id
      code
      unit
      quantity
      declaredQuantity
      quantityFamily
      declarableQuantities
      liveChannelSourceCount
    }
  }
`;

export type ParameterQuantityState = Selected<
  WaterQualityParameterConfig,
  | 'id'
  | 'code'
  | 'unit'
  | 'quantity'
  | 'declaredQuantity'
  | 'quantityFamily'
  | 'declarableQuantities'
  | 'liveChannelSourceCount'
>;

export interface ParameterQuantityStateResult {
  parameterConfig: ParameterQuantityState | null;
}

export const DECLARE_PARAMETER_QUANTITY_MUTATION = `
  mutation DeclareParameterQuantity($input: DeclareParameterQuantityInput!) {
    declareParameterQuantity(input: $input) {
      id
      quantity
      declaredQuantity
    }
  }
`;

export const CLEAR_PARAMETER_QUANTITY_MUTATION = `
  mutation ClearParameterQuantity($parameterConfigId: ID!) {
    clearParameterQuantity(parameterConfigId: $parameterConfigId) {
      id
      quantity
      declaredQuantity
    }
  }
`;

export type DeclaredQuantity = Selected<
  WaterQualityParameterConfig,
  'id' | 'quantity' | 'declaredQuantity'
>;

/** The channels of a sensor, with what each measures — the bind dialog's second picker. */
export const SENSOR_CHANNELS_QUERY = `
  query SensorChannelsForBinding($sensorId: ID!) {
    dataChannelsBySensor(sensorId: $sensorId) {
      id
      channelKey
      displayLabel
      unit
      isEnabled
      quantity
      quantityFamily
      displayOrder
    }
  }
`;

export type SensorChannelOption = Selected<
  DataChannelType,
  | 'id'
  | 'channelKey'
  | 'displayLabel'
  | 'unit'
  | 'isEnabled'
  | 'quantity'
  | 'quantityFamily'
  | 'displayOrder'
>;

export interface SensorChannelsResult {
  dataChannelsBySensor: SensorChannelOption[];
}
