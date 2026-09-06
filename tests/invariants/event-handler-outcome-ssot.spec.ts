import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { isNatsEventHandler } from './helpers/nats-event-handler';
import { stripComments } from './helpers/ts-source';

/**
 * INVARIANT: every NATS handler returns a delivery outcome and no handler
 * swallows a failure (PLAT-HIGH-902).
 *
 * The bus folds `HandlerOutcome` values; a handler that catches an error and
 * falls through would return `undefined`, which the bus terminates loudly —
 * but the catch itself is the regression this spec pins at source: a catch
 * body inside a NATS handler must end in an outcome (`HandlerOutcome.…`,
 * `outcomeForError(`) or rethrow. Hand-rolled retry ladders (re-publishing
 * with a bumped `retryCount`, the notification-service DLQ helper) are
 * banned outright — the bus owns redelivery and dead-lettering — and the bus
 * itself must fold and terminate. No allowlist.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const SOURCE_ROOTS = ['apps', 'libs/backend-common/src'] as const;
const BUS = 'platform/libs/event-bus/src/nats/nats-event-bus.ts';
const INTERFACE = 'platform/libs/event-bus/src/interfaces/event-bus.interface.ts';

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

interface SourceFile {
  readonly relativePath: string;
  readonly code: string;
}

function natsHandlers(): SourceFile[] {
  return SOURCE_ROOTS.flatMap((root) =>
    listSourceFiles(resolve(REPO_ROOT, root))
      .map((file) => ({
        relativePath: toPosix(relative(REPO_ROOT, file)),
        code: stripComments(readFileSync(file, 'utf-8')),
      }))
      .filter(({ code }) => isNatsEventHandler(code)),
  );
}

/**
 * Brace-matched body of a block starting at `openBraceIndex` (the `{`).
 * Comments are already stripped, and the handler sources carry no braces
 * inside string literals that would unbalance the scan.
 */
function blockBody(code: string, openBraceIndex: number): string {
  let depth = 1;
  let i = openBraceIndex + 1;
  const start = i;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return code.slice(start, i - 1);
}

/**
 * The body of the method that receives the delivery: `handle(` on a class
 * handler, or the method an inline `handle: (event) => this.<name>(…)` arrow
 * delegates to. Helper methods (idempotency claims, per-item loops) are out
 * of scope — their catches convert to a value the delivery method folds.
 */
function deliveryMethodBody(code: string): string | undefined {
  const delegate =
    /\bhandle\s*:\s*(?:async\s*)?\([^)]*\)[^=]*=>\s*(?:\{\s*(?:await\s+|return\s+)?)?this\.(\w+)\(/.exec(
      code,
    );
  const name = delegate?.[1] ?? 'handle';
  const signature = new RegExp(
    `\\b(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*:\\s*Promise<[^>]+>\\s*\\{`,
  );
  const match = signature.exec(code);
  if (!match) return undefined;
  return blockBody(code, match.index + match[0].length - 1);
}

/**
 * Body of every OUTERMOST `catch (…) {` block of a method body — a catch whose
 * `try` is a top-level statement of the method. A catch nested inside a loop
 * or an inner block (a best-effort per-item fan-out that logs and continues)
 * is the handler's decision; the outermost ones are the ones that would
 * otherwise end the method without an outcome.
 */
function outermostCatchBodies(methodBody: string): string[] {
  const bodies: string[] = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(methodBody)) !== null) {
    // Depth of the `catch` keyword relative to the method body: the try block
    // has already closed, so an outermost catch sits at depth 0.
    let depth = 0;
    for (let i = 0; i < match.index; i += 1) {
      const ch = methodBody[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth === 0) {
      bodies.push(blockBody(methodBody, match.index + match[0].length - 1));
    }
  }
  return bodies;
}

/** A catch body that neither returns an outcome nor rethrows. */
function swallows(body: string): boolean {
  return !(
    /\bHandlerOutcome\s*\./.test(body) ||
    /\boutcomeForError\s*\(/.test(body) ||
    /\bthrow\b/.test(body)
  );
}

describe('INVARIANT: NATS handler delivery outcome (PLAT-HIGH-902)', () => {
  const handlers = natsHandlers();

  it('the contract asks every handler for a HandlerOutcome', () => {
    const contract = stripComments(readFileSync(resolve(REPO_ROOT, INTERFACE), 'utf-8'));
    expect(contract).toContain('handle(event: TEvent): Promise<HandlerOutcome>;');
    expect(contract).not.toMatch(/handle\(event: TEvent\): Promise<void>/);
  });

  it('finds the handler population', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(30);
  });

  it('every NATS handler declares handle(): Promise<HandlerOutcome>', () => {
    const offenders = handlers
      .filter(
        ({ code }) =>
          !/\bhandle\s*\([^)]*\)\s*:\s*Promise<HandlerOutcome>/.test(code) &&
          !/\bhandle\s*:\s*(?:async\s*)?\([^)]*\)\s*(?::\s*Promise<HandlerOutcome>)?\s*=>/.test(
            code,
          ),
      )
      .map(({ relativePath }) => relativePath);
    expect(offenders).toEqual([]);
  });

  it('no NATS handler declares a void handle', () => {
    const offenders = handlers
      .filter(({ code }) => /\bhandle\s*\([^)]*\)\s*:\s*Promise<void>/.test(code))
      .map(({ relativePath }) => relativePath);
    expect(offenders).toEqual([]);
  });

  it('every NATS handler exposes a delivery method the spec can read', () => {
    const offenders = handlers
      .filter(({ code }) => deliveryMethodBody(code) === undefined)
      .map(({ relativePath }) => relativePath);
    expect(offenders).toEqual([]);
  });

  it('no outermost catch of a delivery method swallows a failure', () => {
    const offenders = handlers
      .filter(({ code }) => {
        const body = deliveryMethodBody(code);
        return body !== undefined && outermostCatchBodies(body).some(swallows);
      })
      .map(({ relativePath }) => relativePath);
    expect(offenders).toEqual([]);
  });

  it('no handler re-implements retry: the bus owns redelivery and dead-lettering', () => {
    const offenders = handlers
      .filter(
        ({ code }) =>
          /\bhandleFailedEvent\s*\(/.test(code) ||
          /\bretryCount\s*:\s*[A-Za-z]/.test(code) ||
          /\bawait\s+this\.handle\s*\(/.test(code),
      )
      .map(({ relativePath }) => relativePath);
    expect(offenders).toEqual([]);
  });

  it('the bus folds outcomes and terminates dead letters', () => {
    const bus = stripComments(readFileSync(resolve(REPO_ROOT, BUS), 'utf-8'));
    expect(bus).toContain('foldHandlerOutcomes(');
    expect(bus).toContain('msg.term(');
    expect(bus).toContain('this.deadLetterSink.record(');
    expect(bus).not.toMatch(/handlerFailed/);
  });
});
