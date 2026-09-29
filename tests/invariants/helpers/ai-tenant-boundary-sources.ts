/**
 * Source-scanning helpers shared by the K10 AI tenant-boundary invariants
 * (ai-tenant-boundary.spec.ts, ai-tenant-boundary-data-layer.spec.ts).
 *
 * WHY one module: both specs must agree on what "the responder of subject X"
 * is and on how comments are stripped — two private copies would drift and
 * one spec would start judging code the other never sees.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import yaml from 'js-yaml';

import { FARM_AI_QUERY_SUBJECTS } from '../../../libs/event-contracts/src/farm-ai-queries';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

/** Non-test TypeScript sources under `path` (skips __tests__, fixtures, specs). */
export function sources(path: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, path))) {
    const child = `${path}/${entry}`;
    if (statSync(resolve(REPO_ROOT, child)).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sources(child));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.test.ts')
    ) {
      out.push(child);
    }
  }
  return out;
}

/** Every TypeScript file under `path`, tests included. */
export function allTs(path: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, path))) {
    const child = `${path}/${entry}`;
    if (statSync(resolve(REPO_ROOT, child)).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...allTs(child));
    } else if (entry.endsWith('.ts')) {
      out.push(child);
    }
  }
  return out;
}

/** Source with block and line comments removed (string contents kept). */
export function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

export function offenders(files: string[], pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(code(file)));
}

/** Non-test sources of every backend app (`apps/<app>/src`). */
export function appSources(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'apps')).flatMap((app) =>
    statSync(resolve(REPO_ROOT, `apps/${app}/src`), { throwIfNoEntry: false })?.isDirectory()
      ? sources(`apps/${app}/src`)
      : [],
  );
}

interface ServicesManifest {
  services: Array<{ name: string; publish?: string[] }>;
}

/** The subjects a service may publish, from the NATS SSoT (infrastructure/nats/services.yaml). */
export function publishGrants(serviceName: string): string[] {
  const manifest = yaml.load(read('infrastructure/nats/services.yaml')) as ServicesManifest;
  return manifest.services.find((service) => service.name === serviceName)?.publish ?? [];
}

/** Every AI-facing request subject: the `request.*` subjects ai_service may publish. */
export function aiRequestSubjects(): string[] {
  return publishGrants('ai_service').filter((subject) => subject.startsWith('request.'));
}

/** `FARM_AI_QUERY_SUBJECTS.X` → its subject string. */
export const FARM_AI_SUBJECT_BY_CONSTANT: ReadonlyMap<string, string> = new Map(
  Object.entries(FARM_AI_QUERY_SUBJECTS).map(([key, value]) => [
    `FARM_AI_QUERY_SUBJECTS.${key}`,
    value,
  ]),
);

/** One `@MessagePattern` handler: the file it lives in and its text (decorator → next decorator). */
export interface ResponderHandler {
  readonly file: string;
  readonly body: string;
}

/**
 * subject → every `@MessagePattern` handler that answers it, across all apps.
 * A handler's body is the text from its decorator to the next `@MessagePattern`
 * (or the end of the file), so private helpers declared after it are included.
 */
export function respondersBySubject(): Map<string, ResponderHandler[]> {
  const handlers = new Map<string, ResponderHandler[]>();
  for (const file of appSources()) {
    const text = code(file);
    if (!text.includes('@MessagePattern(')) continue;
    const decorators = [...text.matchAll(/@MessagePattern\(\s*([^)]+?)\s*\)/g)];
    decorators.forEach((match, index) => {
      const raw = match[1] ?? '';
      const literal = /^['"]([^'"]+)['"]$/.exec(raw)?.[1];
      const resolved = literal ?? FARM_AI_SUBJECT_BY_CONSTANT.get(raw);
      const subjectConst = /^const SUBJECT = ['"]([^'"]+)['"]/m.exec(text)?.[1];
      const subject = resolved ?? (raw === 'SUBJECT' ? subjectConst : undefined);
      if (subject === undefined) return;
      const start = match.index ?? 0;
      const end = decorators[index + 1]?.index ?? text.length;
      handlers.set(subject, [
        ...(handlers.get(subject) ?? []),
        { file, body: text.slice(start, end) },
      ]);
    });
  }
  return handlers;
}
