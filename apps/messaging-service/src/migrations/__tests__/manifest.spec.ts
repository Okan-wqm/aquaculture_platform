import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { MESSAGING_MIGRATIONS } from '../manifest';

function timestampFrom(value: string): number {
  const match = value.match(/(\d{13})/);
  if (!match) {
    throw new Error(`Messaging migration has no 13-digit timestamp: ${value}`);
  }
  return Number(match[1]);
}

describe('MESSAGING_MIGRATIONS authority', () => {
  it('is frozen, ordered, unique, and set-equal to every numeric migration source', () => {
    const sourceTimestamps = readdirSync(resolve(__dirname, '..'))
      .filter((fileName) => /^\d{13}-.+\.ts$/.test(fileName))
      .map(timestampFrom)
      .sort((left, right) => left - right);
    const manifestTimestamps = MESSAGING_MIGRATIONS.map((Migration) =>
      timestampFrom(Migration.name),
    );

    expect(Object.isFrozen(MESSAGING_MIGRATIONS)).toBe(true);
    expect(new Set(manifestTimestamps).size).toBe(manifestTimestamps.length);
    expect(manifestTimestamps).toEqual([...manifestTimestamps].sort((left, right) => left - right));
    expect(manifestTimestamps).toEqual(sourceTimestamps);
  });
});
