#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEslintRuntimeEnv, applyNxRuntimeEnv } from './toolchain-runtime.mjs';

const [command, ...args] = process.argv.slice(2);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (!command) {
  process.stderr.write('Usage: node tools/toolchain/run.mjs <command> [...args]\n');
  process.exit(64);
}

function resolveCommandPath(rawCommand) {
  if (rawCommand.includes('/') || rawCommand.includes('\\')) {
    return rawCommand;
  }

  const commandName = process.platform === 'win32' ? `${rawCommand}.cmd` : rawCommand;
  const candidates = [
    resolve(process.cwd(), 'node_modules', '.bin', commandName),
    resolve(repoRoot, 'node_modules', '.bin', commandName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? rawCommand;
}

function commandBasename(rawCommand) {
  return rawCommand.split(/[\\/]/).pop() ?? rawCommand;
}

function isNxCommand(rawCommand, commandArgs) {
  const name = commandBasename(rawCommand);
  return name === 'nx' || (name === 'npx' && commandArgs[0] === 'nx');
}

function isEslintCommand(rawCommand, commandArgs) {
  const name = commandBasename(rawCommand);
  return name === 'eslint' || (name === 'npx' && commandArgs[0] === 'eslint');
}

const runsNx = isNxCommand(command, args);
const runsEslint = isEslintCommand(command, args);

if (runsNx) {
  applyNxRuntimeEnv();
} else if (runsEslint) {
  applyEslintRuntimeEnv();
}

const executable = runsNx && commandBasename(command) === 'nx' ? 'npx' : command;
const executableArgs = runsNx && commandBasename(command) === 'nx' ? ['nx', ...args] : args;

const result = spawnSync(resolveCommandPath(executable), executableArgs, {
  env: process.env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
