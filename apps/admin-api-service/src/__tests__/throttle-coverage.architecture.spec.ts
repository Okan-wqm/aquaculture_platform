import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * APA-370 throttle-coverage discipline.
 *
 * The app-level ThrottlerGuard applies a default rate limit to EVERY route
 * unless it is explicitly skipped with `@SkipThrottle()`. A class-level
 * `@SkipThrottle()` therefore silently removes ALL app-level throttling from
 * every method in the controller — including future state-mutating handlers.
 * That is exactly how `POST /health/circuit-breakers/:name/reset` (a mutating
 * operational endpoint) ended up with zero rate limiting: the class-level
 * `@SkipThrottle()` was meant for the public GET probes but covered the whole
 * controller.
 *
 * This gate fails the build if:
 *   1. any admin-api controller declares a CLASS-level `@SkipThrottle()`
 *      (a skip must be a deliberate per-method decision, never blanket); or
 *   2. any state-mutating handler (@Post/@Put/@Patch/@Delete) carries
 *      `@SkipThrottle()` while not being `@Public()` — a mutation must always
 *      be subject to at least the default throttle.
 *
 * Together these guarantee no future mutating endpoint can silently ship
 * un-throttled. There is deliberately NO allowlist; comments are stripped so a
 * doc comment mentioning a decorator is never mistaken for a real one.
 */
const REPO_ROOT = execSync('git rev-parse --show-toplevel', {
  encoding: 'utf-8',
}).trim();

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

interface Member {
  readonly decorators: string;
  readonly signature: string;
}

/**
 * Group each decorator run with the first declaration line that follows it.
 * Parameter decorators (@Body/@Param, on their own lines inside a method
 * signature) form harmless spurious members carrying no HTTP-verb decorator, so
 * they never trip the mutation checks below.
 */
function decoratedMembers(src: string): Member[] {
  const lines = stripComments(src).split('\n');
  const members: Member[] = [];
  let buf: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('@')) {
      buf.push(line);
      continue;
    }
    if (buf.length > 0) {
      members.push({ decorators: buf.join('\n'), signature: line });
      buf = [];
    }
  }
  return members;
}

const MUTATION = /@(?:Post|Put|Patch|Delete)\(/;
const SKIP_THROTTLE = /@SkipThrottle\(/;
const PUBLIC = /@Public\(/;
const isClassDecl = (sig: string): boolean => /\bclass\s+\w+/.test(sig);

function controllerFiles(): string[] {
  return execSync("git ls-files -- 'apps/admin-api-service/src/**/*.controller.ts'", {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f.trim().length > 0);
}

function throttleViolations(): string[] {
  const violations: string[] = [];
  for (const rel of controllerFiles()) {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
    for (const member of decoratedMembers(src)) {
      if (isClassDecl(member.signature)) {
        if (SKIP_THROTTLE.test(member.decorators)) {
          violations.push(
            `${rel}: class-level @SkipThrottle() — apply it per-method on public probes only`,
          );
        }
        continue;
      }
      if (MUTATION.test(member.decorators) && SKIP_THROTTLE.test(member.decorators) && !PUBLIC.test(member.decorators)) {
        violations.push(
          `${rel}: state-mutating handler under @SkipThrottle() without @Public() (${member.signature.slice(0, 60)})`,
        );
      }
    }
  }
  return violations;
}

describe('APA-370 — admin-api throttle coverage', () => {
  it('no controller removes app-level throttling from a state-mutating endpoint', () => {
    expect(throttleViolations()).toEqual([]);
  });

  it('the parser actually sees the admin-api controllers (sanity floor)', () => {
    // Guards against a broken glob silently making the gate vacuous.
    expect(controllerFiles().length).toBeGreaterThan(10);
  });
});
