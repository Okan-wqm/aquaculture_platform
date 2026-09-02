import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, validate } from 'graphql';
import { parseStrictJson } from './canonical.mjs';
import { buildApiContract, loadApiSchema, replayDecision } from './api-contract.mjs';

const queryNames = [
  'ariaOverview',
  'ariaMissions',
  'ariaMission',
  'ariaTimeline',
  'ariaProviderStatus',
  'ariaPolicyStatus',
  'ariaProgramProgress',
];
const mutationNames = [
  'createAriaMissionDraft',
  'postAriaConversationMessage',
  'submitAriaMission',
  'cancelAriaMission',
  'retryAriaMission',
  'freezeAriaAutonomy',
  'resumeAriaAutonomy',
  'requestAriaMergeEvaluation',
  'acknowledgeAriaDecision',
];
const mutationActivations = [
  { name: 'createAriaMissionDraft', sprint: 'S15' },
  { name: 'postAriaConversationMessage', sprint: 'S15' },
  { name: 'submitAriaMission', sprint: 'S15' },
  { name: 'cancelAriaMission', sprint: 'S17' },
  { name: 'retryAriaMission', sprint: 'S17' },
  { name: 'freezeAriaAutonomy', sprint: 'S39' },
  { name: 'resumeAriaAutonomy', sprint: 'S39' },
  { name: 'requestAriaMergeEvaluation', sprint: 'S30' },
  { name: 'acknowledgeAriaDecision', sprint: 'S15' },
];
const phaseMutationNames = {
  S06: [],
  S07: [],
  S08: [],
  S15: mutationNames.filter((name) => [0, 1, 2, 8].includes(mutationNames.indexOf(name))),
  S17: mutationNames.filter((name) => [0, 1, 2, 3, 4, 8].includes(mutationNames.indexOf(name))),
  S30: mutationNames.filter((name) => ![5, 6].includes(mutationNames.indexOf(name))),
  S39: mutationNames,
  S46: mutationNames,
};
const lifecycleMapping = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PLANNED: 'PLANNED',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  SUCCEEDED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};
const commonInput = [
  ['requestId', 'UUID!'],
  ['workspaceId', 'ID!'],
  ['expectedVersion', 'Long!'],
  ['clientIssuedAt', 'DateTime!'],
];

function add(errors, message) {
  errors.push({ code: 'API_CONTRACT', message });
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function apiPolicy(planRoot) {
  return parseStrictJson(readFileSync(join(planRoot, 'verification/api-policy.json'), 'utf8'));
}

function verifySchemaClosure(errors, contract, policy) {
  if (!equal(contract.schema_closure, policy.terminal_closure)) {
    add(errors, 'terminal SDL closure drift');
  }
}

function verifyRoots(errors, contract) {
  if (!equal(Object.keys(contract.query_fields), queryNames)) {
    add(errors, 'query root roster drift');
  }
  if (!equal(Object.keys(contract.mutation_fields), mutationNames)) {
    add(errors, 'mutation root roster drift');
  }
}

function verifyEnums(errors, planRoot) {
  const expected = {
    AriaFreshness: ['CURRENT', 'STALE'],
    AriaMissionState: [...Object.values(lifecycleMapping), 'UNKNOWN'],
    AriaRiskClass: ['LOW', 'MEDIUM', 'HIGH', 'PROHIBITED', 'UNKNOWN'],
    AriaSectionStatus: ['OK', 'EMPTY', 'MISSING', 'CORRUPT', 'UNAVAILABLE'],
  };
  const schema = loadApiSchema(planRoot);
  const actual = Object.fromEntries(
    Object.keys(expected).map((name) => [
      name,
      schema
        .getType(name)
        .getValues()
        .map((value) => value.name),
    ]),
  );
  if (!equal(actual, expected)) add(errors, 'status/freshness enum drift');
}

function verifyActivationPolicy(errors, policy) {
  const expectedKeys = [
    'schema_version',
    'policy_id',
    'terminal_closure',
    'query_activation_sprint',
    'phase_checkpoints',
    'mutation_activations',
    'lifecycle_mapping',
  ];
  if (
    !equal(Object.keys(policy), expectedKeys) ||
    policy.schema_version !== '1.0.0' ||
    policy.policy_id !== 'new-aria-public-api-v1' ||
    policy.query_activation_sprint !== 'S06' ||
    !equal(policy.phase_checkpoints, Object.keys(phaseMutationNames)) ||
    !equal(policy.mutation_activations, mutationActivations) ||
    !equal(policy.lifecycle_mapping, lifecycleMapping)
  ) {
    add(errors, 'phase activation policy drift');
  }
}

function verifyPhaseContracts(errors, contract) {
  for (const [sprintId, mutations] of Object.entries(phaseMutationNames)) {
    const expected = {
      query_root: 'Query',
      mutation_root: mutations.length === 0 ? null : 'Mutation',
      query_count: queryNames.length,
      mutation_count: mutations.length,
      query_source: 'terminal.query_fields',
      mutation_fields: mutations,
    };
    if (!equal(contract.phase_contracts[sprintId], expected)) {
      add(errors, `${sprintId}: phase-active GraphQL contract drift`);
    }
  }
}

function verifyPhaseCards(errors, planRoot) {
  const card = readFileSync(join(planRoot, 'phases/P01.md'), 'utf8');
  const normalize = (value) => value.replace(/\s+/gu, ' ');
  const s06 = normalize(card.slice(card.indexOf('## S06'), card.indexOf('## S07')));
  const s07 = normalize(card.slice(card.indexOf('## S07'), card.indexOf('## S08')));
  if (
    !s06.includes('Phase-active exact `7Q/0M` SDL') ||
    !s06.includes("introspection'da `Mutation` root yoktur")
  ) {
    add(errors, 'S06 phase-card parity drift');
  }
  if (!s07.includes('generated `7Q/0M` composition') || !s07.includes('`Mutation` root/document')) {
    add(errors, 'S07 phase-card parity drift');
  }
}

function verifyInputs(errors, planRoot) {
  const schema = loadApiSchema(planRoot);
  const inputs = Object.values(schema.getTypeMap()).filter(
    (type) => type.astNode?.kind === 'InputObjectTypeDefinition' && type.name.endsWith('Input'),
  );
  for (const type of inputs) {
    const common = Object.values(type.getFields())
      .slice(0, 4)
      .map((field) => [field.name, String(field.type)]);
    if (!equal(common, commonInput)) add(errors, `${type.name}: common command fields drift`);
  }
  if (inputs.length !== 9) {
    add(errors, 'mutation input roster must contain nine closed types');
  }
}

function verifyUnknownInputDenial(errors, planRoot) {
  const schema = loadApiSchema(planRoot);
  const document = parse(`mutation {
    createAriaMissionDraft(input: {
      requestId: "00000000-0000-0000-0000-000000000000"
      workspaceId: "w"
      expectedVersion: 0
      clientIssuedAt: "2026-09-01T00:00:00Z"
      repositoryId: "r"
      snapshotSha: "s"
      title: "t"
      unknownField: "deny"
    }) { __typename }
  }`);
  if (validate(schema, document).length === 0) add(errors, 'unknown input field was accepted');
}

function verifyReplay(errors) {
  const result = { commandId: 'c-1', aggregateId: 'a-1', version: 1 };
  const stored = { payloadDigest: 'payload-a', result };
  if (replayDecision(null, 'payload-a').action !== 'DISPATCH_ONCE') {
    add(errors, 'before-commit response-loss decision drift');
  }
  if (!equal(replayDecision(stored, 'payload-a'), { action: 'RETURN_STORED', result })) {
    add(errors, 'after-commit stored result is not recoverable');
  }
  if (replayDecision(stored, 'payload-b').action !== 'INVALID_PAYLOAD_REUSE') {
    add(errors, 'changed-payload request reuse was accepted');
  }
}

export function verifyApiContract(planRoot) {
  const errors = [];
  const expected = buildApiContract(planRoot);
  const policy = apiPolicy(planRoot);
  const actual = parseStrictJson(
    readFileSync(join(planRoot, 'verification/generated-api-contract.json'), 'utf8'),
  );
  if (!equal(actual, expected)) add(errors, 'generated schema/client snapshot drift');
  verifySchemaClosure(errors, expected, policy);
  verifyActivationPolicy(errors, policy);
  verifyRoots(errors, expected);
  verifyEnums(errors, planRoot);
  verifyPhaseContracts(errors, expected);
  verifyPhaseCards(errors, planRoot);
  verifyInputs(errors, planRoot);
  verifyUnknownInputDenial(errors, planRoot);
  verifyReplay(errors);
  return errors;
}
