#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const POLICY_PATH = resolve(REPO_ROOT, 'infrastructure/security/csp.policy.json');

function usage() {
  console.error('Usage: node scripts/security/render-csp.mjs --check|--write --target <all|target>');
  process.exit(2);
}

function parseArgs(argv) {
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : undefined;
  const targetIndex = argv.indexOf('--target');
  const target = targetIndex >= 0 ? argv[targetIndex + 1] : 'all';
  if (!mode || !target) usage();
  return { mode, target };
}

function readPolicy() {
  if (!existsSync(POLICY_PATH)) {
    throw new Error(`Missing CSP policy: ${POLICY_PATH}`);
  }
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
}

function renderPolicy(policy) {
  return policy.directiveOrder
    .map((directive) => {
      const values = policy.directives[directive];
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`CSP directive has no values: ${directive}`);
      }
      return `${directive} ${values.join(' ')}`;
    })
    .join('; ');
}

function renderMeta(policyText) {
  const lines = policyText.split('; ').map((line) => `      ${line};`);
  return `<meta http-equiv="Content-Security-Policy" content="\n${lines.join('\n')}\n    " />`;
}

function applyOutput(original, output, policyText) {
  if (output.kind === 'html-meta') {
    const meta = renderMeta(policyText);
    const pattern = /<meta http-equiv="Content-Security-Policy" content="[\s\S]*?"\s*\/>/m;
    if (!pattern.test(original)) {
      throw new Error(`CSP meta tag not found in ${output.path}`);
    }
    return original.replace(pattern, meta);
  }

  if (output.kind === 'nginx-header') {
    const header = `add_header Content-Security-Policy "${policyText};" always;`;
    const pattern = /add_header Content-Security-Policy ".*?" always;/g;
    if (!pattern.test(original)) {
      throw new Error(`CSP nginx header not found in ${output.path}`);
    }
    return original.replace(pattern, header);
  }

  throw new Error(`Unknown CSP output kind: ${output.kind}`);
}

function selectOutputs(policy, target) {
  if (target === 'all') return policy.outputs;
  const outputs = policy.outputs.filter((output) => output.target === target);
  if (outputs.length === 0) {
    throw new Error(`Unknown CSP target: ${target}`);
  }
  return outputs;
}

function main() {
  const { mode, target } = parseArgs(process.argv.slice(2));
  const policy = readPolicy();
  const policyText = renderPolicy(policy);
  const outputs = selectOutputs(policy, target);
  const stale = [];

  for (const output of outputs) {
    const filePath = resolve(REPO_ROOT, output.path);
    const original = readFileSync(filePath, 'utf8');
    const rendered = applyOutput(original, output, policyText);
    if (rendered !== original) {
      stale.push(output.path);
      if (mode === 'write') {
        writeFileSync(filePath, rendered, 'utf8');
      }
    }
  }

  if (mode === 'check' && stale.length > 0) {
    console.error(`CSP generated outputs are stale:\n${stale.map((path) => `  - ${path}`).join('\n')}`);
    process.exit(1);
  }

  console.log(
    stale.length === 0
      ? `CSP generated outputs are current (${outputs.length} target(s)).`
      : `Rendered CSP outputs:\n${stale.map((path) => `  - ${path}`).join('\n')}`,
  );
}

main();
