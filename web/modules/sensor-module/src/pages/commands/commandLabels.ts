/**
 * The words the command log uses for what the server says happened.
 *
 * Exhaustive records over the generated GraphQL unions (and the preview's own
 * unions): a new command, send status or deployment status does not compile
 * until it has its words in both locales.
 */
import type { MessageKey } from '@aquaculture/shared-ui';
import type {
  DeploymentStatus,
  FeedingParameterStatus,
  VfdCommandType,
} from '@platform/shared-ui/generated/graphql-types';

export const VFD_COMMAND_KEYS: Readonly<Record<VfdCommandType, MessageKey>> = {
  START: 'sensorCommands.vfdCommand.START',
  STOP: 'sensorCommands.vfdCommand.STOP',
  REVERSE: 'sensorCommands.vfdCommand.REVERSE',
  SET_FREQUENCY: 'sensorCommands.vfdCommand.SET_FREQUENCY',
  SET_SPEED: 'sensorCommands.vfdCommand.SET_SPEED',
  FAULT_RESET: 'sensorCommands.vfdCommand.FAULT_RESET',
  QUICK_STOP: 'sensorCommands.vfdCommand.QUICK_STOP',
  EMERGENCY_STOP: 'sensorCommands.vfdCommand.EMERGENCY_STOP',
  JOG_FORWARD: 'sensorCommands.vfdCommand.JOG_FORWARD',
  JOG_REVERSE: 'sensorCommands.vfdCommand.JOG_REVERSE',
  COAST_STOP: 'sensorCommands.vfdCommand.COAST_STOP',
};

/**
 * The unit a drive command's value carries (vfd-command.resolver.ts:
 * setVfdFrequency takes Hz, setVfdSpeed a percentage); other commands carry
 * no value, or a raw one.
 */
export const VFD_VALUE_KEYS: Readonly<Partial<Record<VfdCommandType, MessageKey>>> = {
  SET_FREQUENCY: 'sensorCommands.value.hz',
  SET_SPEED: 'sensorCommands.value.percent',
};

/**
 * The origins sensor-service writes into `source` today (vfd-command-audit-log
 * entity: 'operator', 'automation', 'system'). The column is free text, so an
 * origin outside this list is shown as written.
 */
export const COMMAND_SOURCE_KEYS: Readonly<Record<string, MessageKey>> = {
  operator: 'sensorCommands.source.operator',
  automation: 'sensorCommands.source.automation',
  system: 'sensorCommands.source.system',
};

export const FEEDING_STATUS_KEYS: Readonly<Record<FeedingParameterStatus, MessageKey>> = {
  DRAFT: 'sensorCommands.feedingStatus.DRAFT',
  PENDING: 'sensorCommands.feedingStatus.PENDING',
  SENT: 'sensorCommands.feedingStatus.SENT',
  ACKNOWLEDGED: 'sensorCommands.feedingStatus.ACKNOWLEDGED',
  ACTIVE: 'sensorCommands.feedingStatus.ACTIVE',
  SUPERSEDED: 'sensorCommands.feedingStatus.SUPERSEDED',
  ERROR: 'sensorCommands.feedingStatus.ERROR',
};

export const DEPLOYMENT_STATUS_KEYS: Readonly<Record<DeploymentStatus, MessageKey>> = {
  PENDING: 'sensorCommands.deployStatus.PENDING',
  DEPLOYING: 'sensorCommands.deployStatus.DEPLOYING',
  SUCCESS: 'sensorCommands.deployStatus.SUCCESS',
  FAILED: 'sensorCommands.deployStatus.FAILED',
  ROLLED_BACK: 'sensorCommands.deployStatus.ROLLED_BACK',
};
