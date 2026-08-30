import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

export const STORE_SPEC_CHILD_PROTOCOL_VERSION = 1 as const;

export const STORE_SPEC_CHILD_PHASE_KINDS = Object.freeze([
  'BOOTSTRAPPED',
  'PREPARED_SNAPSHOT',
  'ALLOCATION_COMMITTED',
  'LOCK_ACQUIRED',
  'LOCK_RELEASED',
  'CONTENTION_CONFIRMED',
  'BLOCKING_ACQUIRE_STARTED',
] as const);

export const STORE_SPEC_PARENT_COMMAND_KINDS = Object.freeze([
  'START',
  'RELEASE_PREPARED_SNAPSHOT',
  'RELEASE_LOCK',
  'BEGIN_BLOCKING_ACQUIRE',
] as const);

export type StoreSpecChildPhaseKindV1 = (typeof STORE_SPEC_CHILD_PHASE_KINDS)[number];
export type StoreSpecParentCommandKindV1 = (typeof STORE_SPEC_PARENT_COMMAND_KINDS)[number];
export type StoreSpecProtocolActorV1 = 'CHILD' | 'PARENT';

export type StoreSpecProtocolStepV1 =
  | Readonly<{ readonly actor: 'CHILD'; readonly kind: StoreSpecChildPhaseKindV1 }>
  | Readonly<{ readonly actor: 'PARENT'; readonly kind: StoreSpecParentCommandKindV1 }>;

export type StoreSpecChildEntrypointIdV1 = 'LOCK_FIXTURE' | 'STORE_SPEC';
export type StoreSpecLoaderProfileIdV1 = 'TS_NODE_REGISTER' | 'TS_NODE_TRANSPILE_ONLY';

interface StoreSpecLoaderProfileContractShapeV1 {
  readonly coordinate: string;
  readonly module: 'ts-node/register' | 'ts-node/register/transpile-only';
}

interface StoreSpecEntrypointContractShapeV1 {
  readonly entrypointRelativeToGates: string;
  readonly loaderProfile: StoreSpecLoaderProfileIdV1;
}

interface StoreSpecModeContractShapeV1 {
  readonly entrypoint: StoreSpecChildEntrypointIdV1;
  readonly expectedTestTermination: Readonly<{
    readonly atSequence: number;
    readonly signal: NodeJS.Signals;
  }> | null;
  readonly transcript: readonly StoreSpecProtocolStepV1[];
}

function childStep(kind: StoreSpecChildPhaseKindV1): StoreSpecProtocolStepV1 {
  return Object.freeze({ actor: 'CHILD', kind });
}

function parentStep(kind: StoreSpecParentCommandKindV1): StoreSpecProtocolStepV1 {
  return Object.freeze({ actor: 'PARENT', kind });
}

function defineModeContractV1<const Contract extends StoreSpecModeContractShapeV1>(
  contract: Contract,
): Contract {
  if (contract.transcript.length === 0 || contract.transcript[0]?.kind !== 'BOOTSTRAPPED') {
    throw new Error('Every finding-registry store child transcript must start with BOOTSTRAPPED');
  }
  const seen = new Set<string>();
  for (const step of contract.transcript) {
    const identity = `${step.actor}:${step.kind}`;
    if (seen.has(identity)) {
      throw new Error(`Finding-registry store child transcript repeats ${identity}`);
    }
    seen.add(identity);
  }
  if (
    contract.expectedTestTermination !== null &&
    (!Number.isSafeInteger(contract.expectedTestTermination.atSequence) ||
      contract.expectedTestTermination.atSequence <= 0 ||
      contract.expectedTestTermination.atSequence >= contract.transcript.length)
  ) {
    throw new Error('Finding-registry expected termination must name a nonterminal sequence');
  }
  return Object.freeze({
    entrypoint: contract.entrypoint,
    expectedTestTermination:
      contract.expectedTestTermination === null
        ? null
        : Object.freeze({ ...contract.expectedTestTermination }),
    transcript: Object.freeze([...contract.transcript]),
  }) as Contract;
}

export interface StoreSpecTransportContractV1 {
  readonly contractId: 'aqua.finding-registry-store-spec-transport/v1';
  readonly environment: Readonly<{
    readonly sessionId: 'AQUA_STORE_SPEC_CHILD_SESSION_ID';
    readonly tsNodeProject: 'TS_NODE_PROJECT';
  }>;
  readonly entrypoints: Readonly<
    Record<StoreSpecChildEntrypointIdV1, StoreSpecEntrypointContractShapeV1>
  >;
  readonly loaderProfiles: Readonly<
    Record<StoreSpecLoaderProfileIdV1, StoreSpecLoaderProfileContractShapeV1>
  >;
  readonly modes: Readonly<Record<string, StoreSpecModeContractShapeV1>>;
  readonly output: Readonly<{
    readonly stderr: StoreSpecOutputContractV1;
    readonly stdout: StoreSpecOutputContractV1;
  }>;
  readonly progressDeadlineMs: number;
  readonly protocolVersion: typeof STORE_SPEC_CHILD_PROTOCOL_VERSION;
  readonly termination: Readonly<{
    readonly closeAfterExitDeadlineMs: number;
    readonly exitAfterSignalDeadlineMs: number;
    readonly failureSignal: 'SIGKILL';
  }>;
}

export interface StoreSpecOutputContractV1 {
  readonly maxBytes: number;
  readonly policy: 'CAPTURE_STRICT_UTF8_FAIL_CLOSED';
}

/**
 * The sole V1 authority for child mode/entrypoint identity, process
 * construction, progress, output resource bounds, and exit/close deadlines.
 * Consumers compile runtime values from this immutable descriptor instead of
 * maintaining parallel spawn or termination constants.
 */
export const STORE_SPEC_TRANSPORT_CONTRACT_V1 = Object.freeze({
  contractId: 'aqua.finding-registry-store-spec-transport/v1',
  environment: Object.freeze({
    sessionId: 'AQUA_STORE_SPEC_CHILD_SESSION_ID',
    tsNodeProject: 'TS_NODE_PROJECT',
  }),
  entrypoints: Object.freeze({
    LOCK_FIXTURE: Object.freeze({
      entrypointRelativeToGates: 'lib/finding-registry-lock.fixture.ts',
      loaderProfile: 'TS_NODE_REGISTER',
    }),
    STORE_SPEC: Object.freeze({
      entrypointRelativeToGates: 'finding-registry-store.spec.ts',
      loaderProfile: 'TS_NODE_TRANSPILE_ONLY',
    }),
  }),
  loaderProfiles: Object.freeze({
    TS_NODE_REGISTER: Object.freeze({
      coordinate: require.resolve('ts-node/register'),
      module: 'ts-node/register',
    }),
    TS_NODE_TRANSPILE_ONLY: Object.freeze({
      coordinate: require.resolve('ts-node/register/transpile-only'),
      module: 'ts-node/register/transpile-only',
    }),
  }),
  modes: Object.freeze({
    '--kernel-lock-holder': defineModeContractV1({
      entrypoint: 'LOCK_FIXTURE',
      expectedTestTermination: { atSequence: 3, signal: 'SIGKILL' },
      transcript: [
        childStep('BOOTSTRAPPED'),
        parentStep('START'),
        childStep('LOCK_ACQUIRED'),
        parentStep('RELEASE_LOCK'),
        childStep('LOCK_RELEASED'),
      ],
    }),
    '--kernel-lock-contender': defineModeContractV1({
      entrypoint: 'LOCK_FIXTURE',
      expectedTestTermination: null,
      transcript: [
        childStep('BOOTSTRAPPED'),
        parentStep('START'),
        childStep('CONTENTION_CONFIRMED'),
        parentStep('BEGIN_BLOCKING_ACQUIRE'),
        childStep('BLOCKING_ACQUIRE_STARTED'),
        childStep('LOCK_ACQUIRED'),
        childStep('LOCK_RELEASED'),
      ],
    }),
    '--worktree-allocator-child': defineModeContractV1({
      entrypoint: 'STORE_SPEC',
      expectedTestTermination: null,
      transcript: [
        childStep('BOOTSTRAPPED'),
        parentStep('START'),
        childStep('PREPARED_SNAPSHOT'),
        parentStep('RELEASE_PREPARED_SNAPSHOT'),
        childStep('ALLOCATION_COMMITTED'),
      ],
    }),
    '--transport-output-overflow-child': defineModeContractV1({
      entrypoint: 'STORE_SPEC',
      expectedTestTermination: null,
      transcript: [childStep('BOOTSTRAPPED'), parentStep('START'), childStep('LOCK_ACQUIRED')],
    }),
    '--transport-close-stall-child': defineModeContractV1({
      entrypoint: 'STORE_SPEC',
      expectedTestTermination: null,
      transcript: [childStep('BOOTSTRAPPED'), parentStep('START'), childStep('LOCK_ACQUIRED')],
    }),
  }),
  output: Object.freeze({
    stderr: Object.freeze({ maxBytes: 65_536, policy: 'CAPTURE_STRICT_UTF8_FAIL_CLOSED' }),
    stdout: Object.freeze({ maxBytes: 65_536, policy: 'CAPTURE_STRICT_UTF8_FAIL_CLOSED' }),
  }),
  progressDeadlineMs: 30_000,
  protocolVersion: STORE_SPEC_CHILD_PROTOCOL_VERSION,
  termination: Object.freeze({
    closeAfterExitDeadlineMs: 5_000,
    exitAfterSignalDeadlineMs: 5_000,
    failureSignal: 'SIGKILL',
  }),
} as const satisfies StoreSpecTransportContractV1);

export const STORE_SPEC_CHILD_SESSION_ENV = STORE_SPEC_TRANSPORT_CONTRACT_V1.environment.sessionId;

export type StoreSpecChildModeV1 = keyof typeof STORE_SPEC_TRANSPORT_CONTRACT_V1.modes;

export type StoreSpecChildModeForEntrypointV1<Entrypoint extends StoreSpecChildEntrypointIdV1> = {
  readonly [Mode in StoreSpecChildModeV1]: (typeof STORE_SPEC_TRANSPORT_CONTRACT_V1.modes)[Mode]['entrypoint'] extends Entrypoint
    ? Mode
    : never;
}[StoreSpecChildModeV1];

export type StoreSpecAllocationCommittedPayloadV1 = Readonly<{
  readonly preparationAttempts: number;
}>;

type StoreSpecPayloadForKindV1<Kind extends string> = Kind extends 'ALLOCATION_COMMITTED'
  ? StoreSpecAllocationCommittedPayloadV1
  : Readonly<Record<never, never>>;

type StoreSpecEnvelopeV1<Kind extends string> = Readonly<{
  readonly kind: Kind;
  readonly mode: StoreSpecChildModeV1;
  readonly payload: StoreSpecPayloadForKindV1<Kind>;
  readonly protocolVersion: typeof STORE_SPEC_CHILD_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly sessionId: string;
}>;

export type StoreSpecChildMessageV1 = {
  readonly [Kind in StoreSpecChildPhaseKindV1]: StoreSpecEnvelopeV1<Kind>;
}[StoreSpecChildPhaseKindV1];

export type StoreSpecParentMessageV1 = {
  readonly [Kind in StoreSpecParentCommandKindV1]: StoreSpecEnvelopeV1<Kind>;
}[StoreSpecParentCommandKindV1];

export type StoreSpecProtocolEventV1 =
  | Readonly<{
      readonly actor: 'CHILD';
      readonly kind: StoreSpecChildPhaseKindV1;
      readonly sequence: number;
    }>
  | Readonly<{
      readonly actor: 'PARENT';
      readonly kind: StoreSpecParentCommandKindV1;
      readonly sequence: number;
    }>;

export interface StoreSpecProtocolStateV1 {
  readonly mode: StoreSpecChildModeV1;
  readonly sequence: number;
}

export class StoreSpecProtocolViolationV1 extends Error {
  readonly code = 'STORE_SPEC_PROTOCOL_VIOLATION_V1' as const;

  constructor(message: string) {
    super(message);
    this.name = 'StoreSpecProtocolViolationV1';
  }
}

export class StoreSpecOutputViolationV1 extends Error {
  readonly code = 'STORE_SPEC_OUTPUT_VIOLATION_V1' as const;

  constructor(
    readonly channel: StoreSpecOutputChannelV1,
    readonly limitBytes: number,
    readonly observedBytes: number,
    message: string,
  ) {
    super(message);
    this.name = 'StoreSpecOutputViolationV1';
  }
}

export class StoreSpecTerminationViolationV1 extends Error {
  readonly code = 'STORE_SPEC_TERMINATION_VIOLATION_V1' as const;

  constructor(
    readonly reason: 'CLOSE_DEADLINE_EXCEEDED' | 'EXIT_DEADLINE_EXCEEDED' | 'SIGNAL_REJECTED',
    message: string,
  ) {
    super(message);
    this.name = 'StoreSpecTerminationViolationV1';
  }
}

export type StoreSpecOutputChannelV1 = keyof typeof STORE_SPEC_TRANSPORT_CONTRACT_V1.output;

export interface StoreSpecBoundedOutputCollectorV1 {
  readonly byteLength: number;
  append(chunk: string | Uint8Array): void;
  readUtf8(): string;
}

export function createStoreSpecBoundedOutputCollectorV1(
  channel: StoreSpecOutputChannelV1,
): StoreSpecBoundedOutputCollectorV1 {
  const contract = STORE_SPEC_TRANSPORT_CONTRACT_V1.output[channel];
  const chunks: Buffer[] = [];
  let byteLength = 0;
  return {
    get byteLength() {
      return byteLength;
    },
    append: (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      const observedBytes = byteLength + bytes.byteLength;
      if (observedBytes > contract.maxBytes) {
        throw new StoreSpecOutputViolationV1(
          channel,
          contract.maxBytes,
          observedBytes,
          `Finding registry store child ${channel} exceeded ${String(contract.maxBytes)} bytes`,
        );
      }
      chunks.push(bytes);
      byteLength = observedBytes;
    },
    readUtf8: () => {
      const bytes = Buffer.concat(chunks, byteLength);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (error) {
        throw new StoreSpecOutputViolationV1(
          channel,
          contract.maxBytes,
          byteLength,
          `Finding registry store child ${channel} violated ${contract.policy}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function compileStoreSpecChildArgvV1(
  gatesDirectory: string,
  mode: StoreSpecChildModeV1,
  args: readonly string[],
): readonly string[] {
  const modeContract = STORE_SPEC_TRANSPORT_CONTRACT_V1.modes[mode];
  const spawnContract = STORE_SPEC_TRANSPORT_CONTRACT_V1.entrypoints[modeContract.entrypoint];
  const loaderProfile =
    STORE_SPEC_TRANSPORT_CONTRACT_V1.loaderProfiles[spawnContract.loaderProfile];
  return Object.freeze([
    '-r',
    loaderProfile.coordinate,
    resolve(gatesDirectory, spawnContract.entrypointRelativeToGates),
    mode,
    ...args,
  ]);
}

export function sendStoreSpecIpcMessageV1(
  connected: boolean,
  send: (callback: (error: Error | null) => void) => void,
): Promise<void> {
  if (!connected) {
    return Promise.reject(
      new StoreSpecProtocolViolationV1('Finding registry store child IPC is disconnected'),
    );
  }
  return new Promise<void>((resolveSend, rejectSend) => {
    send((error) => {
      if (error === null) resolveSend();
      else rejectSend(error);
    });
  });
}

export type StoreSpecChildCloseResultV1 = Readonly<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}>;

type StoreSpecChildLifecycleCommonV1 = Readonly<{
  readonly exit: StoreSpecChildCloseResultV1 | null;
  readonly ipc: 'CONNECTED' | 'DISCONNECTED';
}>;

export type StoreSpecChildLifecycleStateV1 =
  | (StoreSpecChildLifecycleCommonV1 & Readonly<{ readonly status: 'RUNNING' }>)
  | (StoreSpecChildLifecycleCommonV1 &
      Readonly<{
        readonly expectedSignal: NodeJS.Signals;
        readonly status: 'EXPECTED_TERMINATION_REQUESTED';
      }>)
  | (StoreSpecChildLifecycleCommonV1 &
      Readonly<{
        readonly result: StoreSpecChildCloseResultV1;
        readonly status: 'CLOSED';
      }>)
  | (StoreSpecChildLifecycleCommonV1 &
      Readonly<{
        readonly closure?: StoreSpecChildCloseResultV1;
        readonly failure: Error;
        readonly secondaryFailures: readonly Error[];
        readonly status: 'FAILED';
      }>);

export type StoreSpecChildLifecycleEventV1 =
  | Readonly<{ readonly type: 'CHILD_MESSAGE' }>
  | Readonly<{ readonly type: 'IPC_DISCONNECTED' }>
  | Readonly<{
      readonly result: StoreSpecChildCloseResultV1;
      readonly type: 'EXITED';
    }>
  | Readonly<{
      readonly signal: NodeJS.Signals;
      readonly type: 'EXPECTED_TERMINATION_REQUESTED';
    }>
  | Readonly<{
      readonly failure: Error;
      readonly type: 'TRANSPORT_FAILED';
    }>
  | Readonly<{
      readonly protocolTerminal: boolean;
      readonly result: StoreSpecChildCloseResultV1;
      readonly type: 'CLOSED';
    }>;

export function createStoreSpecChildLifecycleStateV1(): StoreSpecChildLifecycleStateV1 {
  return Object.freeze({ exit: null, ipc: 'CONNECTED', status: 'RUNNING' });
}

type StoreSpecFailedChildLifecycleStateV1 = Extract<
  StoreSpecChildLifecycleStateV1,
  { readonly status: 'FAILED' }
>;

function failedStoreSpecChildLifecycleV1(
  state: StoreSpecFailedChildLifecycleStateV1,
  failure: Error,
  closure?: StoreSpecChildCloseResultV1,
): StoreSpecFailedChildLifecycleStateV1;
function failedStoreSpecChildLifecycleV1(
  state: StoreSpecChildLifecycleStateV1,
  failure: Error,
  closure?: StoreSpecChildCloseResultV1,
): StoreSpecChildLifecycleStateV1;
function failedStoreSpecChildLifecycleV1(
  state: StoreSpecChildLifecycleStateV1,
  failure: Error,
  closure?: StoreSpecChildCloseResultV1,
): StoreSpecChildLifecycleStateV1 {
  if (state.status === 'FAILED') {
    const secondaryFailures =
      failure === state.failure || state.secondaryFailures.includes(failure)
        ? state.secondaryFailures
        : Object.freeze([...state.secondaryFailures, failure]);
    return Object.freeze({
      ...state,
      ...(closure === undefined ? {} : { closure: Object.freeze({ ...closure }) }),
      secondaryFailures,
    });
  }
  return Object.freeze({
    exit: state.exit,
    ipc: state.ipc,
    ...(closure === undefined ? {} : { closure: Object.freeze({ ...closure }) }),
    failure,
    secondaryFailures: Object.freeze([]),
    status: 'FAILED',
  });
}

function lifecycleViolationV1(
  state: StoreSpecChildLifecycleStateV1,
  message: string,
  closure?: StoreSpecChildCloseResultV1,
): StoreSpecChildLifecycleStateV1 {
  return failedStoreSpecChildLifecycleV1(state, new StoreSpecProtocolViolationV1(message), closure);
}

export function reduceStoreSpecChildLifecycleV1(
  state: StoreSpecChildLifecycleStateV1,
  event: StoreSpecChildLifecycleEventV1,
): StoreSpecChildLifecycleStateV1 {
  if (state.status === 'FAILED') {
    if (event.type === 'IPC_DISCONNECTED' && state.ipc === 'CONNECTED') {
      return Object.freeze({ ...state, ipc: 'DISCONNECTED' });
    }
    if (event.type === 'EXITED') {
      if (state.exit === null) {
        return Object.freeze({ ...state, exit: Object.freeze({ ...event.result }) });
      }
      return failedStoreSpecChildLifecycleV1(
        state,
        new StoreSpecProtocolViolationV1('Finding registry store failed child emitted exit twice'),
      );
    }
    if (event.type === 'TRANSPORT_FAILED') {
      return failedStoreSpecChildLifecycleV1(state, event.failure);
    }
    if (event.type === 'CLOSED') {
      let failed = state;
      if (state.exit === null) {
        failed = failedStoreSpecChildLifecycleV1(
          failed,
          new StoreSpecProtocolViolationV1(
            'Finding registry store failed child closed before an exit result was observed',
          ),
        );
      } else if (
        state.exit.code !== event.result.code ||
        state.exit.signal !== event.result.signal
      ) {
        failed = failedStoreSpecChildLifecycleV1(
          failed,
          new StoreSpecProtocolViolationV1(
            'Finding registry store failed child close result diverged from its exit result',
          ),
        );
      }
      if (state.ipc !== 'DISCONNECTED') {
        failed = failedStoreSpecChildLifecycleV1(
          failed,
          new StoreSpecProtocolViolationV1(
            'Finding registry store failed child closed before its IPC channel disconnected',
          ),
        );
      }
      return failedStoreSpecChildLifecycleV1(failed, state.failure, event.result);
    }
    return state;
  }
  if (state.status === 'CLOSED') {
    return lifecycleViolationV1(
      state,
      `Finding registry store lifecycle received ${event.type} after close`,
      state.result,
    );
  }
  if (event.type === 'TRANSPORT_FAILED') {
    return failedStoreSpecChildLifecycleV1(state, event.failure);
  }
  if (event.type === 'CHILD_MESSAGE') {
    if (state.status !== 'RUNNING' || state.ipc !== 'CONNECTED') {
      return lifecycleViolationV1(
        state,
        'Finding registry store child sent an IPC message after termination began',
      );
    }
    return state;
  }
  if (event.type === 'IPC_DISCONNECTED') {
    if (state.ipc === 'DISCONNECTED') {
      return lifecycleViolationV1(state, 'Finding registry store child IPC disconnected twice');
    }
    return Object.freeze({ ...state, ipc: 'DISCONNECTED' });
  }
  if (event.type === 'EXITED') {
    if (state.exit !== null) {
      return lifecycleViolationV1(state, 'Finding registry store child emitted exit twice');
    }
    const exited = Object.freeze({ ...state, exit: Object.freeze({ ...event.result }) });
    if (
      state.status === 'EXPECTED_TERMINATION_REQUESTED' &&
      (event.result.code !== null || event.result.signal !== state.expectedSignal)
    ) {
      return lifecycleViolationV1(
        exited,
        `Finding registry store child did not honor expected ${state.expectedSignal} exit`,
      );
    }
    if (state.status === 'RUNNING' && (event.result.code !== 0 || event.result.signal !== null)) {
      return lifecycleViolationV1(
        exited,
        `Finding registry store child exited unsuccessfully: code=${String(event.result.code)} signal=${String(event.result.signal)}`,
      );
    }
    return exited;
  }
  if (event.type === 'EXPECTED_TERMINATION_REQUESTED') {
    if (state.status !== 'RUNNING' || state.ipc !== 'CONNECTED') {
      return lifecycleViolationV1(
        state,
        'Finding registry store expected termination was requested out of lifecycle phase',
      );
    }
    return Object.freeze({
      expectedSignal: event.signal,
      exit: state.exit,
      ipc: state.ipc,
      status: 'EXPECTED_TERMINATION_REQUESTED',
    });
  }

  if (state.exit === null) {
    return lifecycleViolationV1(
      state,
      'Finding registry store child closed before an exit result was observed',
      event.result,
    );
  }
  if (state.exit.code !== event.result.code || state.exit.signal !== event.result.signal) {
    return lifecycleViolationV1(
      state,
      'Finding registry store child close result diverged from its exit result',
      event.result,
    );
  }
  if (state.ipc !== 'DISCONNECTED') {
    return lifecycleViolationV1(
      state,
      'Finding registry store child closed before its IPC channel disconnected',
      event.result,
    );
  }
  if (state.status === 'RUNNING') {
    if (!event.protocolTerminal || event.result.code !== 0 || event.result.signal !== null) {
      return lifecycleViolationV1(
        state,
        `Finding registry store child closed unsuccessfully: code=${String(event.result.code)} signal=${String(event.result.signal)}`,
        event.result,
      );
    }
  } else if (event.result.code !== null || event.result.signal !== state.expectedSignal) {
    return lifecycleViolationV1(
      state,
      `Finding registry store child did not honor expected ${state.expectedSignal} termination`,
      event.result,
    );
  }
  return Object.freeze({
    exit: state.exit,
    ipc: state.ipc,
    result: Object.freeze({ ...event.result }),
    status: 'CLOSED',
  });
}

export interface StoreSpecSignalRequestResultV1 {
  readonly lifecycle: StoreSpecChildLifecycleStateV1;
  readonly signalIssued: boolean;
}

export function issueStoreSpecProcessSignalV1(
  lifecycle: StoreSpecChildLifecycleStateV1,
  signal: NodeJS.Signals,
  kill: (signal: NodeJS.Signals) => boolean,
): StoreSpecSignalRequestResultV1 {
  let signalIssued = false;
  try {
    signalIssued = kill(signal);
  } catch (error) {
    const failure = new StoreSpecTerminationViolationV1(
      'SIGNAL_REJECTED',
      `Finding registry store child signal ${signal} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Object.freeze({
      lifecycle: reduceStoreSpecChildLifecycleV1(lifecycle, {
        failure,
        type: 'TRANSPORT_FAILED',
      }),
      signalIssued: false,
    });
  }
  if (signalIssued) return Object.freeze({ lifecycle, signalIssued: true });
  const failure = new StoreSpecTerminationViolationV1(
    'SIGNAL_REJECTED',
    `Finding registry store child rejected signal ${signal}`,
  );
  return Object.freeze({
    lifecycle: reduceStoreSpecChildLifecycleV1(lifecycle, {
      failure,
      type: 'TRANSPORT_FAILED',
    }),
    signalIssued: false,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function isStoreSpecChildModeV1(value: unknown): value is StoreSpecChildModeV1 {
  return typeof value === 'string' && Object.hasOwn(STORE_SPEC_TRANSPORT_CONTRACT_V1.modes, value);
}

export function isStoreSpecChildModeForEntrypointV1<
  Entrypoint extends StoreSpecChildEntrypointIdV1,
>(entrypoint: Entrypoint, value: unknown): value is StoreSpecChildModeForEntrypointV1<Entrypoint> {
  return (
    isStoreSpecChildModeV1(value) &&
    STORE_SPEC_TRANSPORT_CONTRACT_V1.modes[value].entrypoint === entrypoint
  );
}

export function parseStoreSpecChildModeForEntrypointV1<
  Entrypoint extends StoreSpecChildEntrypointIdV1,
>(entrypoint: Entrypoint, value: unknown): StoreSpecChildModeForEntrypointV1<Entrypoint> {
  if (!isStoreSpecChildModeForEntrypointV1(entrypoint, value)) {
    throw new StoreSpecProtocolViolationV1(
      `Finding registry store child mode is not owned by ${entrypoint}: ${String(value)}`,
    );
  }
  return value;
}

export function storeSpecChildModesForEntrypointV1<Entrypoint extends StoreSpecChildEntrypointIdV1>(
  entrypoint: Entrypoint,
): readonly StoreSpecChildModeForEntrypointV1<Entrypoint>[] {
  return Object.freeze(
    (Object.keys(STORE_SPEC_TRANSPORT_CONTRACT_V1.modes) as StoreSpecChildModeV1[]).filter(
      (mode): mode is StoreSpecChildModeForEntrypointV1<Entrypoint> =>
        isStoreSpecChildModeForEntrypointV1(entrypoint, mode),
    ),
  );
}

export function assertStoreSpecEntrypointDispatchSetEqualityV1(
  entrypoint: StoreSpecChildEntrypointIdV1,
  dispatch: Readonly<Record<string, unknown>>,
): void {
  const actualKeys = Reflect.ownKeys(dispatch);
  if (actualKeys.some((key) => typeof key !== 'string')) {
    throw new StoreSpecProtocolViolationV1(
      `Finding registry store ${entrypoint} dispatch contains a symbol mode`,
    );
  }
  const actual = (actualKeys as string[]).sort();
  const expected = [...storeSpecChildModesForEntrypointV1(entrypoint)].sort();
  if (actual.length !== expected.length || actual.some((mode, index) => mode !== expected[index])) {
    throw new StoreSpecProtocolViolationV1(
      `Finding registry store ${entrypoint} dispatch does not equal its mode catalog`,
    );
  }
}

function isStoreSpecChildPhaseKindV1(value: unknown): value is StoreSpecChildPhaseKindV1 {
  return STORE_SPEC_CHILD_PHASE_KINDS.some((kind) => kind === value);
}

function isStoreSpecParentCommandKindV1(value: unknown): value is StoreSpecParentCommandKindV1 {
  return STORE_SPEC_PARENT_COMMAND_KINDS.some((kind) => kind === value);
}

function assertStoreSpecSessionIdV1(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new StoreSpecProtocolViolationV1('Finding registry store IPC session ID is invalid');
  }
}

function validatePayloadV1(
  kind: StoreSpecChildPhaseKindV1 | StoreSpecParentCommandKindV1,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new StoreSpecProtocolViolationV1('Finding registry store IPC payload is invalid');
  }
  if (kind === 'ALLOCATION_COMMITTED') {
    if (
      !hasExactKeys(value, ['preparationAttempts']) ||
      !Number.isSafeInteger(value.preparationAttempts) ||
      (value.preparationAttempts as number) <= 0
    ) {
      throw new StoreSpecProtocolViolationV1(
        'Finding registry store allocation result payload is invalid',
      );
    }
    return Object.freeze({ preparationAttempts: value.preparationAttempts });
  }
  if (!hasExactKeys(value, [])) {
    throw new StoreSpecProtocolViolationV1(
      'Finding registry store no-payload message carried unexpected fields',
    );
  }
  return Object.freeze({});
}

function modeAllowsEventV1(
  mode: StoreSpecChildModeV1,
  actor: StoreSpecProtocolActorV1,
  kind: StoreSpecChildPhaseKindV1 | StoreSpecParentCommandKindV1,
): boolean {
  return STORE_SPEC_TRANSPORT_CONTRACT_V1.modes[mode].transcript.some(
    (step) => step.actor === actor && step.kind === kind,
  );
}

interface StoreSpecExpectedPeerV1 {
  readonly mode: StoreSpecChildModeV1;
  readonly sessionId: string;
}

function parseEnvelopeV1(
  value: unknown,
  actor: StoreSpecProtocolActorV1,
  expected: StoreSpecExpectedPeerV1,
): StoreSpecChildMessageV1 | StoreSpecParentMessageV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'mode', 'payload', 'protocolVersion', 'sequence', 'sessionId']) ||
    value.protocolVersion !== STORE_SPEC_CHILD_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    !isStoreSpecChildModeV1(value.mode)
  ) {
    throw new StoreSpecProtocolViolationV1('Finding registry store sent an invalid IPC envelope');
  }
  assertStoreSpecSessionIdV1(value.sessionId);
  if (value.sessionId !== expected.sessionId || value.mode !== expected.mode) {
    throw new StoreSpecProtocolViolationV1(
      'Finding registry store IPC envelope crossed its governed session or mode',
    );
  }
  const kindIsValid =
    actor === 'CHILD'
      ? isStoreSpecChildPhaseKindV1(value.kind)
      : isStoreSpecParentCommandKindV1(value.kind);
  if (!kindIsValid || !modeAllowsEventV1(value.mode, actor, value.kind as never)) {
    throw new StoreSpecProtocolViolationV1(
      'Finding registry store IPC event is not declared by its mode contract',
    );
  }
  const payload = validatePayloadV1(
    value.kind as StoreSpecChildPhaseKindV1 | StoreSpecParentCommandKindV1,
    value.payload,
  );
  return Object.freeze({
    kind: value.kind,
    mode: value.mode,
    payload,
    protocolVersion: STORE_SPEC_CHILD_PROTOCOL_VERSION,
    sequence: value.sequence,
    sessionId: value.sessionId,
  }) as StoreSpecChildMessageV1 | StoreSpecParentMessageV1;
}

export function parseStoreSpecChildMessageV1(
  value: unknown,
  expected: StoreSpecExpectedPeerV1,
): StoreSpecChildMessageV1 {
  return parseEnvelopeV1(value, 'CHILD', expected) as StoreSpecChildMessageV1;
}

export function parseStoreSpecParentMessageV1(
  value: unknown,
  expected: StoreSpecExpectedPeerV1,
): StoreSpecParentMessageV1 {
  return parseEnvelopeV1(value, 'PARENT', expected) as StoreSpecParentMessageV1;
}

export function createStoreSpecProtocolStateV1(
  mode: StoreSpecChildModeV1,
): StoreSpecProtocolStateV1 {
  return Object.freeze({ mode, sequence: 0 });
}

export function expectedStoreSpecProtocolStepV1(
  state: StoreSpecProtocolStateV1,
): StoreSpecProtocolStepV1 | null {
  return STORE_SPEC_TRANSPORT_CONTRACT_V1.modes[state.mode].transcript[state.sequence] ?? null;
}

export function reduceStoreSpecProtocolV1(
  state: StoreSpecProtocolStateV1,
  event: StoreSpecProtocolEventV1,
): StoreSpecProtocolStateV1 {
  const expected = expectedStoreSpecProtocolStepV1(state);
  if (
    expected === null ||
    event.sequence !== state.sequence ||
    event.actor !== expected.actor ||
    event.kind !== expected.kind
  ) {
    throw new StoreSpecProtocolViolationV1(
      `Finding registry store IPC transition is illegal at sequence ${String(state.sequence)}`,
    );
  }
  return Object.freeze({ mode: state.mode, sequence: state.sequence + 1 });
}

export function assertStoreSpecProtocolTerminalV1(state: StoreSpecProtocolStateV1): void {
  if (expectedStoreSpecProtocolStepV1(state) !== null) {
    throw new StoreSpecProtocolViolationV1(
      `Finding registry store child closed before sequence ${String(state.sequence)} completed`,
    );
  }
}

function createEnvelopeV1<Kind extends StoreSpecChildPhaseKindV1 | StoreSpecParentCommandKindV1>(
  state: StoreSpecProtocolStateV1,
  sessionId: string,
  kind: Kind,
  payload: StoreSpecPayloadForKindV1<Kind>,
): StoreSpecEnvelopeV1<Kind> {
  assertStoreSpecSessionIdV1(sessionId);
  const expected = expectedStoreSpecProtocolStepV1(state);
  if (expected === null || expected.kind !== kind) {
    throw new StoreSpecProtocolViolationV1(
      `Finding registry store tried to emit ${kind} out of sequence`,
    );
  }
  const canonicalPayload = validatePayloadV1(kind, payload) as StoreSpecPayloadForKindV1<Kind>;
  return Object.freeze({
    kind,
    mode: state.mode,
    payload: canonicalPayload,
    protocolVersion: STORE_SPEC_CHILD_PROTOCOL_VERSION,
    sequence: state.sequence,
    sessionId,
  });
}

export interface StoreSpecParentProtocolSessionV1 {
  readonly mode: StoreSpecChildModeV1;
  readonly sessionId: string;
  readonly state: StoreSpecProtocolStateV1;
  command(kind: StoreSpecParentCommandKindV1): StoreSpecParentMessageV1;
  observeChild(value: unknown): StoreSpecChildMessageV1;
  assertTerminal(): void;
}

export function createStoreSpecParentProtocolSessionV1(
  mode: StoreSpecChildModeV1,
  sessionId: string,
): StoreSpecParentProtocolSessionV1 {
  assertStoreSpecSessionIdV1(sessionId);
  let state = createStoreSpecProtocolStateV1(mode);
  return {
    mode,
    sessionId,
    get state() {
      return state;
    },
    command: (kind) => {
      const message = createEnvelopeV1(state, sessionId, kind, {});
      state = reduceStoreSpecProtocolV1(state, {
        actor: 'PARENT',
        kind,
        sequence: message.sequence,
      });
      return message;
    },
    observeChild: (value) => {
      const message = parseStoreSpecChildMessageV1(value, { mode, sessionId });
      state = reduceStoreSpecProtocolV1(state, {
        actor: 'CHILD',
        kind: message.kind,
        sequence: message.sequence,
      });
      return message;
    },
    assertTerminal: () => assertStoreSpecProtocolTerminalV1(state),
  };
}

export interface StoreSpecChildProtocolSessionV1 {
  readonly mode: StoreSpecChildModeV1;
  readonly sessionId: string;
  emitPhase(
    kind: Exclude<StoreSpecChildPhaseKindV1, 'ALLOCATION_COMMITTED'>,
    signal?: AbortSignal,
  ): Promise<void>;
  emitPhase(
    kind: 'ALLOCATION_COMMITTED',
    payload: StoreSpecAllocationCommittedPayloadV1,
    signal?: AbortSignal,
  ): Promise<void>;
  assertTerminal(): void;
}

export interface StoreSpecChildTransitionV1 {
  readonly completion: Promise<void>;
  readonly expectsParentCommand: boolean;
  acceptParentCommand(): void;
  fail(error: Error): void;
}

export function createStoreSpecChildTransitionV1(
  sendCompletion: Promise<void>,
  expectsParentCommand: boolean,
): StoreSpecChildTransitionV1 {
  let parentCommandSettled = !expectsParentCommand;
  let resolveParentCommand!: () => void;
  const parentCommandCompletion = expectsParentCommand
    ? new Promise<void>((resolveCommand) => {
        resolveParentCommand = resolveCommand;
      })
    : Promise.resolve();
  let failureSettled = false;
  let rejectFailure!: (error: Error) => void;
  const failureCompletion = new Promise<never>((_resolveFailure, rejectTransition) => {
    rejectFailure = rejectTransition;
  });
  const completion = Promise.race([
    Promise.all([sendCompletion, parentCommandCompletion]).then(() => undefined),
    failureCompletion,
  ]);
  return {
    completion,
    expectsParentCommand,
    acceptParentCommand: () => {
      if (!expectsParentCommand || parentCommandSettled) {
        throw new StoreSpecProtocolViolationV1(
          'Finding registry store child received a duplicate or unexpected parent command',
        );
      }
      parentCommandSettled = true;
      resolveParentCommand();
    },
    fail: (error) => {
      if (failureSettled) return;
      failureSettled = true;
      rejectFailure(error);
    },
  };
}

function storeSpecSessionIdFromEnvironment(): string {
  const sessionId = process.env[STORE_SPEC_CHILD_SESSION_ENV];
  assertStoreSpecSessionIdV1(sessionId);
  return sessionId;
}

function sendStoreSpecChildProcessMessage(message: StoreSpecChildMessageV1): Promise<void> {
  return new Promise<void>((resolveSend, rejectSend) => {
    if (process.send === undefined || !process.connected) {
      rejectSend(
        new StoreSpecProtocolViolationV1(
          'Finding registry store child requires a connected IPC authority',
        ),
      );
      return;
    }
    // `process.send` is a receiver-bound Node capability: extracting it into a
    // function value loses the internal ChildProcess target and crashes before
    // sequence zero can be published. Invoke the capability through its owning
    // process object; the Promise constructor converts a concurrent disconnect
    // or synchronous send failure into the same typed transition failure path.
    process.send(message, (error: Error | null) => {
      if (error === null) resolveSend();
      else rejectSend(error);
    });
  });
}

export function createStoreSpecChildProtocolSessionV1(
  mode: StoreSpecChildModeV1,
): StoreSpecChildProtocolSessionV1 {
  const sessionId = storeSpecSessionIdFromEnvironment();
  let state = createStoreSpecProtocolStateV1(mode);
  let fatal: Error | undefined;
  let activeTransition: StoreSpecChildTransitionV1 | undefined;

  const fail = (error: Error): void => {
    if (fatal !== undefined) return;
    fatal = error;
    activeTransition?.fail(error);
  };
  const assertHealthy = (): void => {
    if (fatal !== undefined) throw fatal;
  };
  const onMessage = (value: unknown): void => {
    const transition = activeTransition;
    if (transition === undefined || !transition.expectsParentCommand) {
      fail(
        new StoreSpecProtocolViolationV1(
          'Finding registry store child received an out-of-phase parent command',
        ),
      );
      return;
    }
    try {
      const message = parseStoreSpecParentMessageV1(value, { mode, sessionId });
      state = reduceStoreSpecProtocolV1(state, {
        actor: 'PARENT',
        kind: message.kind,
        sequence: message.sequence,
      });
      transition.acceptParentCommand();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const onDisconnect = (): void => {
    fail(
      new StoreSpecProtocolViolationV1(
        'Finding registry store parent disconnected before protocol completion',
      ),
    );
  };
  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);

  const emitPhase = async (
    kind: StoreSpecChildPhaseKindV1,
    payloadOrSignal?: StoreSpecAllocationCommittedPayloadV1 | AbortSignal,
    maybeSignal?: AbortSignal,
  ): Promise<void> => {
    assertHealthy();
    const payload = kind === 'ALLOCATION_COMMITTED' ? payloadOrSignal : {};
    const signal =
      kind === 'ALLOCATION_COMMITTED'
        ? maybeSignal
        : payloadOrSignal instanceof AbortSignal
          ? payloadOrSignal
          : undefined;
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new StoreSpecProtocolViolationV1('Finding registry store child phase was aborted');
    }
    const message = createEnvelopeV1(
      state,
      sessionId,
      kind,
      payload as StoreSpecPayloadForKindV1<typeof kind>,
    ) as StoreSpecChildMessageV1;
    state = reduceStoreSpecProtocolV1(state, {
      actor: 'CHILD',
      kind,
      sequence: message.sequence,
    });
    const next = expectedStoreSpecProtocolStepV1(state);
    const transition = createStoreSpecChildTransitionV1(
      sendStoreSpecChildProcessMessage(message),
      next?.actor === 'PARENT',
    );
    activeTransition = transition;
    const abortListener = (): void => {
      fail(
        signal?.reason instanceof Error
          ? signal.reason
          : new StoreSpecProtocolViolationV1('Finding registry store child phase was aborted'),
      );
    };
    signal?.addEventListener('abort', abortListener, { once: true });
    try {
      await transition.completion;
      assertHealthy();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      assertHealthy();
    } finally {
      signal?.removeEventListener('abort', abortListener);
      if (activeTransition === transition) activeTransition = undefined;
    }
  };

  return {
    mode,
    sessionId,
    emitPhase,
    assertTerminal: () => {
      assertHealthy();
      assertStoreSpecProtocolTerminalV1(state);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    },
  };
}

export async function bootstrapStoreSpecChildProcess(
  mode: StoreSpecChildModeV1,
): Promise<StoreSpecChildProtocolSessionV1> {
  const session = createStoreSpecChildProtocolSessionV1(mode);
  await session.emitPhase('BOOTSTRAPPED');
  return session;
}
