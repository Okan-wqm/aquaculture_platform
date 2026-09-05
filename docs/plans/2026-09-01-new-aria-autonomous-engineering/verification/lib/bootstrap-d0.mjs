import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, parseStrictJson } from './canonical.mjs';
import { materializeVerifiedNode } from './private-node.mjs';
import { withProvenanceSnapshot } from './provenance-snapshot.mjs';
import { assertRuntimeBinding, copyVerifiedRuntimeDependencies } from './runtime-dependencies.mjs';
import { loadVerifiedProvenance } from './verify-provenance.mjs';
import { verifyAuthorizedTarget, verifyTarget } from './verify-target.mjs';

function failure(code, error) {
  return { code, message: error instanceof Error ? error.message : String(error) };
}

function verifiedTarget(repositoryRoot, options) {
  return options.target
    ? verifyTarget(repositoryRoot, options.target, options.targetAuthority)
    : verifyAuthorizedTarget(repositoryRoot, options.targetAuthority);
}

function workerEnvironment() {
  return {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: process.env.PATH ?? '',
    TZ: 'UTC',
  };
}

function runSemanticWorker(snapshot, repositoryRoot, targetFacts, privateNode) {
  const inputPath = join(snapshot.repositoryRoot, '.d0-worker-input.json');
  const workerPath = join(snapshot.planRoot, 'verification/verify-worker.mjs');
  writeFileSync(
    inputPath,
    canonicalJson({
      schema_version: '1.0.0',
      source_repository_root: repositoryRoot,
      target_facts: targetFacts,
    }),
    { flag: 'wx', mode: 0o400 },
  );
  const result = spawnSync(privateNode, [workerPath, inputPath], {
    cwd: snapshot.repositoryRoot,
    encoding: 'utf8',
    env: workerEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${result.status ?? 'unknown'}`;
    throw new Error(`verified semantic worker failed: ${detail}`);
  }
  const output = parseStrictJson(result.stdout);
  if (!Array.isArray(output.errors)) throw new Error('verified semantic worker output is invalid');
  return output.errors;
}

function runVerifiedSnapshot(provenance, repositoryRoot, targetFacts) {
  return withProvenanceSnapshot(provenance.files, (snapshot) => {
    copyVerifiedRuntimeDependencies(repositoryRoot, snapshot.repositoryRoot, targetFacts);
    const privateNode = materializeVerifiedNode(
      process.execPath,
      snapshot.repositoryRoot,
      targetFacts.node_tool,
    );
    return runSemanticWorker(snapshot, repositoryRoot, targetFacts, privateNode);
  });
}

export function verifyD0Bootstrap(planRoot, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? resolve(planRoot, '../../..');
  const target = verifiedTarget(repositoryRoot, options);
  if (target.errors.length > 0 || !target.facts) {
    return { errors: target.errors, targetFacts: target.facts };
  }
  let provenance;
  try {
    provenance = loadVerifiedProvenance(planRoot, {
      repositoryRoot,
      revision: target.facts.head_sha,
      gitTool: target.facts.git_tool,
    });
  } catch (error) {
    return { errors: [failure('VERIFIER_PROVENANCE', error)], targetFacts: target.facts };
  }
  try {
    assertRuntimeBinding(target.facts, provenance.metadata.runtime);
    const errors = runVerifiedSnapshot(provenance, repositoryRoot, target.facts);
    return { errors, targetFacts: target.facts };
  } catch (error) {
    return { errors: [failure('VERIFIED_RUNTIME', error)], targetFacts: target.facts };
  }
}
