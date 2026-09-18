/**
 * Admin mutation-handler enumeration — the ONE source three gates share.
 *
 * `admin-mutation-audit-coverage` (every mutation is audited),
 * `platform-admin-mfa-ssot` (every irreversible mutation is @Destructive) and
 * `platform-capability-coverage` (every mutation names its capability) all
 * need the same answer to "which handlers mutate, and what decorates them?".
 * Three private copies of that scan had already drifted in what they treated
 * as a decorator block; a handler one gate saw and another missed is exactly
 * the hole a gate exists to close. This module is the scan; the specs only
 * judge.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const ADMIN_SERVICE_SRC = 'apps/admin-api-service/src';

export interface AdminMutationHandler {
  /** `<repo-relative controller path>#<method name>` */
  readonly id: string;
  readonly file: string;
  readonly verb: 'Post' | 'Put' | 'Patch' | 'Delete';
  readonly name: string;
  /** The contiguous decorator block above the method signature, comments stripped. */
  readonly block: string;
  /** Everything above `export class` in the file — class-level decorators live here. */
  readonly classDecorators: string;
  /** `@Public()` on the handler or its class: no principal, no capability, no MFA. */
  readonly isPublic: boolean;
}

export function readRepoFile(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** Drop block + line comments so a docstring mention never counts as a decorator. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

/** Every admin-api controller source file, tracked or newly added, specs excluded. */
export function adminControllerFiles(): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      `${ADMIN_SERVICE_SRC}/**/*.controller.ts`,
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((rel) => rel.length > 0 && !rel.endsWith('.spec.ts'));
}

const HTTP_MUTATION = /^\s*@(Post|Put|Patch|Delete)\(/;
const SIGNATURE = /^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\(/;

/** Every @Post/@Put/@Patch/@Delete handler in one controller file. */
export function adminMutationHandlers(file: string): AdminMutationHandler[] {
  const src = stripComments(readRepoFile(file));
  const lines = src.split('\n');
  const classStart = src.indexOf('export class');
  const classDecorators = classStart === -1 ? '' : src.slice(0, classStart);
  const handlers: AdminMutationHandler[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const verb = HTTP_MUTATION.exec(lines[i] ?? '')?.[1] as
      | AdminMutationHandler['verb']
      | undefined;
    if (!verb) continue;
    // Walk back over the contiguous decorator block, then forward to the signature.
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1] ?? '')) start -= 1;
    let sigIndex = i + 1;
    while (sigIndex < lines.length && !SIGNATURE.test(lines[sigIndex] ?? '')) sigIndex += 1;
    const name = SIGNATURE.exec(lines[sigIndex] ?? '')?.[1];
    if (!name) throw new Error(`${file}:${i + 1}: mutation decorator with no handler signature`);
    const block = lines.slice(start, sigIndex).join('\n');
    handlers.push({
      id: `${file}#${name}`,
      file,
      verb,
      name,
      block,
      classDecorators,
      isPublic: /@Public\(\)/.test(block) || /@Public\(\)/.test(classDecorators),
    });
    i = sigIndex;
  }
  return handlers;
}

/** Every mutation handler across the admin-api fleet. */
export function allAdminMutationHandlers(): AdminMutationHandler[] {
  return adminControllerFiles().flatMap(adminMutationHandlers);
}
