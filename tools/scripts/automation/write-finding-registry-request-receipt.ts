#!/usr/bin/env ts-node

import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  AUTOMATION_REPOSITORY,
  AUTOMATION_REPOSITORY_ID,
} from '../../gates/lib/automation-publication-policy';
import {
  buildFindingRegistryRequestReceipt,
  FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME,
  serializeFindingRegistryRequestReceipt,
} from '../../gates/lib/finding-registry-request-receipt';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string): number {
  const value = required(name);
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new Error(`${name} is not canonical`);
  return Number(value);
}

const operation = required('OPERATION');
if (operation !== 'add' && operation !== 'close') {
  throw new Error('OPERATION must be add or close');
}
if (required('GITHUB_REPOSITORY') !== AUTOMATION_REPOSITORY) {
  throw new Error('GITHUB_REPOSITORY differs from automation authority');
}
const runtimeRepositoryId = process.env['GITHUB_REPOSITORY_ID'];
if (runtimeRepositoryId && runtimeRepositoryId !== AUTOMATION_REPOSITORY_ID) {
  throw new Error('GITHUB_REPOSITORY_ID differs from automation authority');
}

const runnerTemp = realpathSync(required('RUNNER_TEMP'));
if (!lstatSync(runnerTemp).isDirectory()) throw new Error('RUNNER_TEMP is not a directory');
const outputPath = resolve(runnerTemp, FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME);
if (outputPath !== join(runnerTemp, FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME)) {
  throw new Error('request receipt path escaped RUNNER_TEMP');
}

const receipt = buildFindingRegistryRequestReceipt({
  repository: AUTOMATION_REPOSITORY,
  repository_id: AUTOMATION_REPOSITORY_ID,
  workflow_ref: required('GITHUB_WORKFLOW_REF'),
  workflow_sha: required('GITHUB_SHA'),
  workflow_run_id: positiveInteger('GITHUB_RUN_ID'),
  workflow_run_attempt: positiveInteger('GITHUB_RUN_ATTEMPT'),
  command_id: required('COMMAND_ID'),
  operation,
  input_sha256: required('INPUT_SHA256'),
});

writeFileSync(outputPath, serializeFindingRegistryRequestReceipt(receipt), {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
