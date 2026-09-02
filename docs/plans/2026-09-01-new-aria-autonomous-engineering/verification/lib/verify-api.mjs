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

function verifyRoots(errors, contract) {
  if (!equal(Object.keys(contract.query_fields), queryNames)) {
    add(errors, 'query root roster drift');
  }
  if (!equal(Object.keys(contract.mutation_fields), mutationNames)) {
    add(errors, 'mutation root roster drift');
  }
}

function verifyEnums(errors, contract) {
  const expected = {
    AriaSectionStatus: ['OK', 'EMPTY', 'MISSING', 'CORRUPT', 'UNAVAILABLE'],
    AriaFreshness: ['CURRENT', 'STALE'],
  };
  if (!equal(contract.enums, expected)) add(errors, 'status/freshness enum drift');
}

function verifyInputs(errors, contract) {
  const inputs = Object.entries(contract.input_types).filter(([name]) => name.endsWith('Input'));
  for (const [name, fields] of inputs) {
    const common = Object.entries(fields).slice(0, 4);
    if (!equal(common, commonInput)) add(errors, `${name}: common command fields drift`);
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
  const actual = parseStrictJson(
    readFileSync(join(planRoot, 'verification/generated-api-contract.json'), 'utf8'),
  );
  if (!equal(actual, expected)) add(errors, 'generated schema/client snapshot drift');
  verifyRoots(errors, expected);
  verifyEnums(errors, expected);
  verifyInputs(errors, expected);
  verifyUnknownInputDenial(errors, planRoot);
  verifyReplay(errors);
  return errors;
}
