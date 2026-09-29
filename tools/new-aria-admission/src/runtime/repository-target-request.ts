import { RepositoryTargetRequest } from '../application/repository-target-verifier';
import { JsonValue, parseStrictJson } from '../kernel/strict-json';

const keys = [
  'repository_id',
  'workspace_id',
  'repository_root',
  'reviewed_ref',
  'base_sha',
  'head_sha',
] as const;
type JsonRecord = { [key: string]: JsonValue };

function stringField(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new TypeError(`repository target ${key} must be a non-empty string`);
  }
  return field;
}

export function loadRepositoryTargetRequest(bytes: Uint8Array): RepositoryTargetRequest {
  const value = parseStrictJson(bytes);
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError('repository target request schema is open or incomplete');
  }
  return {
    repository_id: stringField(value, 'repository_id'),
    workspace_id: stringField(value, 'workspace_id'),
    repository_root: stringField(value, 'repository_root'),
    reviewed_ref: stringField(value, 'reviewed_ref'),
    base_sha: stringField(value, 'base_sha'),
    head_sha: stringField(value, 'head_sha'),
  };
}
