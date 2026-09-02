import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { buildProjectionSet } from './projections.mjs';
import { markdownLinks } from './markdown.mjs';
import { verifyHistory } from './verify-history.mjs';
import { verifyApiContract } from './verify-api.mjs';
import { verifyAuthorityContracts } from './verify-authority.mjs';
import { verifyMapping } from './verify-mapping.mjs';
import { verifyProvenance } from './verify-provenance.mjs';
import { verifyReadability } from './verify-readability.mjs';
import { verifyTarget } from './verify-target.mjs';

function add(errors, code, message) {
  errors.push({ code, message });
}

function filesUnder(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

function runCheck(errors, code, check) {
  try {
    errors.push(...check());
  } catch (error) {
    add(errors, code, error instanceof Error ? error.message : String(error));
  }
}

function verifyProjectionParity(planRoot, repositoryRoot) {
  const errors = [];
  for (const [relativePath, expected] of buildProjectionSet(planRoot, repositoryRoot)) {
    const path = join(planRoot, relativePath);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== expected) {
      add(errors, 'PROJECTION_PARITY', `${relativePath}: missing or drifted`);
    }
  }
  return errors;
}

function normalizeTarget(target) {
  const withoutTitle = target.trim().replace(/^<|>$/gu, '');
  return decodeURI(withoutTitle.split('#')[0]);
}

function verifyRelativeLinks(planRoot) {
  const errors = [];
  for (const path of filesUnder(planRoot).filter((file) => file.endsWith('.md'))) {
    for (const link of markdownLinks(readFileSync(path, 'utf8'))) {
      if (/^(?:https?:|mailto:|repo:|#)/u.test(link)) continue;
      const target = normalizeTarget(link);
      if (target && !existsSync(resolve(dirname(path), target))) {
        add(errors, 'RELATIVE_LINK', `${relative(planRoot, path)} -> ${link}`);
      }
    }
  }
  return errors;
}

function verifyD0Projection(planRoot) {
  const errors = [];
  const progress = readFileSync(join(planRoot, 'PROGRESS.md'), 'utf8');
  if (
    !progress.includes('**D0 state:** `VERIFYING`') ||
    progress.includes('**D0 state:** `DONE`')
  ) {
    add(errors, 'D0_STATE', 'PROGRESS must derive D0 VERIFYING');
  }
  if (!progress.startsWith('<!-- GENERATED:'))
    add(errors, 'D0_STATE', 'PROGRESS generated marker missing');
  return errors;
}

export function verifyD0(planRoot, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? resolve(planRoot, '../../..');
  const errors = [];
  let targetFacts = null;
  runCheck(errors, 'TARGET_RESOLUTION', () => {
    const result = verifyTarget(repositoryRoot, options.target);
    targetFacts = result.facts;
    return result.errors;
  });
  runCheck(errors, 'PROGRAM_PARITY', () => verifyMapping(planRoot, repositoryRoot));
  runCheck(errors, 'API_CONTRACT', () => verifyApiContract(planRoot));
  runCheck(errors, 'AUTHORITY_CONTRACT', () => verifyAuthorityContracts(planRoot));
  runCheck(errors, 'HISTORICAL_EVIDENCE', () => verifyHistory(planRoot, repositoryRoot));
  runCheck(errors, 'READABILITY_POLICY', () => verifyReadability(planRoot, repositoryRoot));
  runCheck(errors, 'VERIFIER_PROVENANCE', () => verifyProvenance(planRoot));
  runCheck(errors, 'PROJECTION_PARITY', () => verifyProjectionParity(planRoot, repositoryRoot));
  runCheck(errors, 'RELATIVE_LINK', () => verifyRelativeLinks(planRoot));
  runCheck(errors, 'D0_STATE', () => verifyD0Projection(planRoot));
  return { errors, targetFacts };
}
