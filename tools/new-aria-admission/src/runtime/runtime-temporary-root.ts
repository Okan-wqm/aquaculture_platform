import { tmpdir } from 'node:os';

export function runtimeTemporaryRoot(): string {
  for (const name of ['TMPDIR', 'TMP', 'TEMP'] as const) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return tmpdir();
}
