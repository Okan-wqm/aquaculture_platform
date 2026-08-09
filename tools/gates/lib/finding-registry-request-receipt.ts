import { TextDecoder } from 'node:util';

import { canonicalJson } from './canonical-json';

export const FINDING_REGISTRY_REQUEST_RECEIPT_SCHEMA = 'aqua/finding-registry-request-receipt/v1';
export const FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME = 'finding-registry-request-receipt.json';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,199}$/;

export interface FindingRegistryRequestReceiptV1 {
  readonly $schema: typeof FINDING_REGISTRY_REQUEST_RECEIPT_SCHEMA;
  readonly repository: string;
  readonly repository_id: string;
  readonly workflow_ref: string;
  readonly workflow_sha: string;
  readonly workflow_run_id: number;
  readonly workflow_run_attempt: number;
  readonly command_id: string;
  readonly operation: 'add' | 'close';
  readonly input_sha256: string;
}

type ReceiptInput = Omit<FindingRegistryRequestReceiptV1, '$schema'>;

function assertBoundedLine(value: string, field: string, maxBytes: number): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`${field} is not one bounded canonical line`);
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

export function buildFindingRegistryRequestReceipt(
  input: ReceiptInput,
): FindingRegistryRequestReceiptV1 {
  if (!REPOSITORY_PATTERN.test(input.repository)) {
    throw new Error('receipt repository is not canonical');
  }
  if (!REPOSITORY_ID_PATTERN.test(input.repository_id)) {
    throw new Error('receipt repository_id is not canonical');
  }
  assertBoundedLine(input.workflow_ref, 'receipt workflow_ref', 512);
  if (!SHA_PATTERN.test(input.workflow_sha)) {
    throw new Error('receipt workflow_sha is not canonical');
  }
  assertPositiveSafeInteger(input.workflow_run_id, 'receipt workflow_run_id');
  assertPositiveSafeInteger(input.workflow_run_attempt, 'receipt workflow_run_attempt');
  if (!COMMAND_ID_PATTERN.test(input.command_id)) {
    throw new Error('receipt command_id is not canonical');
  }
  if (input.operation !== 'add' && input.operation !== 'close') {
    throw new Error('receipt operation is not canonical');
  }
  if (!SHA256_PATTERN.test(input.input_sha256)) {
    throw new Error('receipt input_sha256 is not canonical');
  }

  return Object.freeze({
    $schema: FINDING_REGISTRY_REQUEST_RECEIPT_SCHEMA,
    repository: input.repository,
    repository_id: input.repository_id,
    workflow_ref: input.workflow_ref,
    workflow_sha: input.workflow_sha,
    workflow_run_id: input.workflow_run_id,
    workflow_run_attempt: input.workflow_run_attempt,
    command_id: input.command_id,
    operation: input.operation,
    input_sha256: input.input_sha256,
  });
}

export function serializeFindingRegistryRequestReceipt(
  receipt: FindingRegistryRequestReceiptV1,
): string {
  return `${canonicalJson(receipt)}\n`;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('finding registry request receipt must be a JSON object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`receipt ${field} must be a string`);
  return value;
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new Error(`receipt ${field} must be a number`);
  return value;
}

export function parseFindingRegistryRequestReceipt(bytes: Buffer): FindingRegistryRequestReceiptV1 {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('finding registry request receipt is not valid UTF-8 JSON');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('finding registry request receipt is not valid UTF-8 JSON');
  }
  const input = record(value);
  if (input['$schema'] !== FINDING_REGISTRY_REQUEST_RECEIPT_SCHEMA) {
    throw new Error('finding registry request receipt schema is not supported');
  }
  const operation = stringField(input['operation'], 'operation');
  const receipt = buildFindingRegistryRequestReceipt({
    repository: stringField(input['repository'], 'repository'),
    repository_id: stringField(input['repository_id'], 'repository_id'),
    workflow_ref: stringField(input['workflow_ref'], 'workflow_ref'),
    workflow_sha: stringField(input['workflow_sha'], 'workflow_sha'),
    workflow_run_id: numberField(input['workflow_run_id'], 'workflow_run_id'),
    workflow_run_attempt: numberField(input['workflow_run_attempt'], 'workflow_run_attempt'),
    command_id: stringField(input['command_id'], 'command_id'),
    operation:
      operation === 'add' || operation === 'close'
        ? operation
        : (() => {
            throw new Error('receipt operation is not canonical');
          })(),
    input_sha256: stringField(input['input_sha256'], 'input_sha256'),
  });
  if (text !== serializeFindingRegistryRequestReceipt(receipt)) {
    throw new Error('finding registry request receipt bytes are not canonical');
  }
  return receipt;
}
