import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanonicalFileReadBudget } from '../src/runtime/canonical-file-read-budget';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('canonical file aggregate read budget', () => {
  it('limits the next immutable read to the remaining aggregate bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-read-budget-'));
    temporaryRoots.push(root);
    const first = join(root, 'first.bin');
    const second = join(root, 'second.bin');
    writeFileSync(first, Buffer.alloc(8));
    writeFileSync(second, Buffer.alloc(8));
    const budget = new CanonicalFileReadBudget(12);

    expect(budget.read(first, 'first fixture', 8)).toHaveLength(8);
    expect(() => budget.read(second, 'second fixture', 8)).toThrow(/byte limit/);
  });

  it('fails before opening another path after the aggregate is exhausted', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-read-budget-'));
    temporaryRoots.push(root);
    const exact = join(root, 'exact.bin');
    writeFileSync(exact, Buffer.alloc(4));
    const budget = new CanonicalFileReadBudget(4);
    budget.read(exact, 'exact fixture', 4);

    expect(() => budget.read(join(root, 'missing.bin'), 'missing fixture', 1)).toThrow(
      /aggregate byte limit/,
    );
  });
});
