/**
 * Neutral command-surface authority shared by the finding-writer CLIs and the
 * repository closure compiler. This module is declarative and import-safe: it
 * owns executable identities, admitted operations, and mutation classification,
 * but performs no repository I/O and exposes no mutation capability.
 */

export type FindingWriterCliMutationClass = 'MUTATION' | 'READ_ONLY';

interface FindingWriterCliOperationContract {
  readonly operation: string;
  readonly selector: string;
  readonly mutation: 'ALWAYS' | 'NEVER' | 'UNLESS_ARGUMENT';
  readonly readOnlyArgument?: string;
}

interface FindingWriterCliExecutableContract {
  readonly executablePath:
    | 'tools/gates/finding-registry.ts'
    | 'tools/gates/source-finding-inventory.ts';
  readonly selectorKind: 'FIRST_ARGUMENT' | 'EXCLUSIVE_FLAG';
  readonly operations: readonly FindingWriterCliOperationContract[];
  readonly allowedArguments: readonly string[];
}

function freezeOperationContract(
  operation: FindingWriterCliOperationContract,
): FindingWriterCliOperationContract {
  return Object.freeze({ ...operation });
}

function freezeExecutableContract(
  executable: FindingWriterCliExecutableContract,
): FindingWriterCliExecutableContract {
  return Object.freeze({
    ...executable,
    operations: Object.freeze(executable.operations.map(freezeOperationContract)),
    allowedArguments: Object.freeze([...executable.allowedArguments]),
  });
}

const RAW_FINDING_WRITER_CLI_COMMAND_CONTRACT = [
  {
    executablePath: 'tools/gates/finding-registry.ts',
    selectorKind: 'FIRST_ARGUMENT',
    operations: [
      { operation: 'verify', selector: 'verify', mutation: 'NEVER' },
      { operation: 'writer-preflight', selector: 'writer-preflight', mutation: 'NEVER' },
      { operation: 'request-digest', selector: 'request-digest', mutation: 'NEVER' },
      { operation: 'add', selector: 'add', mutation: 'ALWAYS' },
      { operation: 'close', selector: 'close', mutation: 'ALWAYS' },
      {
        operation: 'sweep',
        selector: 'sweep',
        mutation: 'UNLESS_ARGUMENT',
        readOnlyArgument: '--dry-run',
      },
      { operation: 'export', selector: 'export', mutation: 'NEVER' },
      { operation: 'list', selector: 'list', mutation: 'NEVER' },
    ],
    allowedArguments: [],
  },
  {
    executablePath: 'tools/gates/source-finding-inventory.ts',
    selectorKind: 'EXCLUSIVE_FLAG',
    operations: [
      { operation: 'static', selector: '--static', mutation: 'NEVER' },
      { operation: 'check', selector: '--check', mutation: 'NEVER' },
      { operation: 'write', selector: '--write', mutation: 'ALWAYS' },
      { operation: 'refresh', selector: '--refresh', mutation: 'ALWAYS' },
    ],
    allowedArguments: ['--scope=full', '--scope=remote'],
  },
] as const satisfies readonly FindingWriterCliExecutableContract[];

type FindingWriterRegistryExecutableContract = Extract<
  (typeof RAW_FINDING_WRITER_CLI_COMMAND_CONTRACT)[number],
  { readonly executablePath: 'tools/gates/finding-registry.ts' }
>;

type FindingWriterRegistryMutationOperationContract = Extract<
  FindingWriterRegistryExecutableContract['operations'][number],
  { readonly mutation: 'ALWAYS' | 'UNLESS_ARGUMENT' }
>;

export type FindingWriterRegistryMutationOperation =
  FindingWriterRegistryMutationOperationContract['operation'];

export const FINDING_WRITER_CLI_COMMAND_CONTRACT = Object.freeze(
  RAW_FINDING_WRITER_CLI_COMMAND_CONTRACT.map((executable) => freezeExecutableContract(executable)),
);

export const FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS: readonly FindingWriterRegistryMutationOperation[] =
  Object.freeze(
    RAW_FINDING_WRITER_CLI_COMMAND_CONTRACT[0].operations
      .filter(
        (operation): operation is FindingWriterRegistryMutationOperationContract =>
          operation.mutation !== 'NEVER',
      )
      .map((operation) => operation.operation),
  );

export type FindingWriterCliExecutablePath =
  (typeof FINDING_WRITER_CLI_COMMAND_CONTRACT)[number]['executablePath'];

export interface AdmittedFindingWriterCliInvocation {
  readonly executablePath: FindingWriterCliExecutablePath;
  readonly operation: string;
  readonly mutationClass: FindingWriterCliMutationClass;
}

function executableContract(
  executablePath: string,
): FindingWriterCliExecutableContract | undefined {
  return FINDING_WRITER_CLI_COMMAND_CONTRACT.find(
    (candidate) => candidate.executablePath === executablePath,
  );
}

export function isFindingWriterCliExecutablePath(
  executablePath: string,
): executablePath is FindingWriterCliExecutablePath {
  return executableContract(executablePath) !== undefined;
}

function classifyMutation(
  operation: FindingWriterCliOperationContract,
  arguments_: readonly string[],
): FindingWriterCliMutationClass {
  if (operation.mutation === 'ALWAYS') return 'MUTATION';
  if (operation.mutation === 'NEVER') return 'READ_ONLY';
  if (operation.readOnlyArgument === undefined) {
    throw new Error(
      `Finding writer CLI contract lost its read-only argument: ${operation.operation}`,
    );
  }
  return arguments_.includes(operation.readOnlyArgument) ? 'READ_ONLY' : 'MUTATION';
}

/**
 * Admits one CLI invocation against the frozen command authority. Operation-
 * specific payload validation remains with the owning CLI; executable and
 * mutation semantics are closed here so compilers and dispatchers cannot drift.
 */
export function admitFindingWriterCliInvocation(
  executablePath: string,
  arguments_: readonly string[],
): AdmittedFindingWriterCliInvocation {
  const executable = executableContract(executablePath);
  if (executable === undefined) {
    throw new Error(`Finding writer CLI executable is not governed: ${executablePath}`);
  }

  let operation: FindingWriterCliOperationContract | undefined;
  if (executable.selectorKind === 'FIRST_ARGUMENT') {
    const selector = arguments_[0];
    operation = executable.operations.find((candidate) => candidate.selector === selector);
    if (operation === undefined) {
      throw new Error(
        `Finding writer CLI operation is not governed for ${executablePath}: ${selector ?? '<missing>'}`,
      );
    }
  } else {
    const operations = arguments_
      .map((argument) => executable.operations.find((candidate) => candidate.selector === argument))
      .filter(
        (candidate): candidate is FindingWriterCliOperationContract => candidate !== undefined,
      );
    if (operations.length !== 1) {
      throw new Error(
        `Finding writer CLI requires exactly one operation selector for ${executablePath}`,
      );
    }
    const selectedOperation = operations[0];
    if (selectedOperation === undefined) {
      throw new Error(`Finding writer CLI admission lost its operation: ${executablePath}`);
    }
    operation = selectedOperation;
    const admittedArguments = new Set([
      ...executable.allowedArguments,
      ...executable.operations.map((candidate) => candidate.selector),
    ]);
    const unknownArguments = arguments_.filter((argument) => !admittedArguments.has(argument));
    if (unknownArguments.length > 0) {
      throw new Error(
        `Finding writer CLI has unknown arguments for ${executablePath}: ${unknownArguments.join(',')}`,
      );
    }
    const scopes = arguments_.filter((argument) => executable.allowedArguments.includes(argument));
    if (scopes.length > 1) {
      throw new Error(`Finding writer CLI has multiple scope selectors for ${executablePath}`);
    }
    if (operation.mutation === 'ALWAYS' && arguments_.includes('--scope=remote')) {
      throw new Error(
        `Finding writer CLI mutation is supported only with --scope=full: ${operation.operation}`,
      );
    }
  }

  if (operation === undefined) {
    throw new Error(`Finding writer CLI admission lost its operation: ${executablePath}`);
  }

  return Object.freeze({
    executablePath: executable.executablePath,
    operation: operation.operation,
    mutationClass: classifyMutation(operation, arguments_),
  });
}

export function findingWriterCliOperationNames(
  executablePath: FindingWriterCliExecutablePath,
): readonly string[] {
  const executable = executableContract(executablePath);
  if (executable === undefined) {
    throw new Error(`Finding writer CLI executable is not governed: ${executablePath}`);
  }
  return Object.freeze(executable.operations.map((operation) => operation.operation));
}

export function isFindingWriterRegistryMutationOperation(
  value: string | undefined,
): value is FindingWriterRegistryMutationOperation {
  if (value === undefined) return false;
  const executable = executableContract('tools/gates/finding-registry.ts');
  const operation = executable?.operations.find((candidate) => candidate.operation === value);
  return operation !== undefined && operation.mutation !== 'NEVER';
}
