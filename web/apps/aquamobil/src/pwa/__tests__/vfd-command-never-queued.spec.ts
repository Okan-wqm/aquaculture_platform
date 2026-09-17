/**
 * A drive command must NEVER enter the offline queue.
 *
 * WHY THIS GATE EXISTS, and why it is a BAN rather than a ratchet. Every other
 * write this app queues describes something that already happened; replaying it
 * later records the same fact. A drive command is an ACT that happens on
 * DELIVERY. A `startVfd` drained from the queue two hours after the worker
 * pressed it spins an auger nobody is standing next to, into a pen nobody is
 * watching. There is no version of that which is acceptable, so there is no
 * baseline to shrink — the count is zero and stays zero.
 *
 * TWO GATES, BECAUSE THEY CATCH DIFFERENT MISTAKES:
 *   • The COMPILE gate (`QueueExcludesActuationCommands` in
 *     ../operation-registry.ts) catches the obvious path — someone adds
 *     `'startVfd'` to the `OperationType` union so they can call `addToQueue`
 *     with it. That fails `npm run typecheck`, on a line whose name says why.
 *   • This TEST catches the sneaky one — a command document added to the
 *     registry under an innocent op name (`'recordDose'`, say), which the type
 *     system cannot see because the union member is not the root field. It reads
 *     the registry's SOURCE and looks for the mutation calls themselves.
 *
 * It also asserts the compile gate is still WIRED. A guard that gets deleted in
 * a refactor is worse than no guard, because the file still reads as if it is
 * protected.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ACTUATION_COMMAND_ROOT_FIELDS } from '../actuation-commands';
import { OPERATION_MUTATIONS } from '../operation-registry';

const PWA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(PWA_DIR, '..');

const REGISTRY_SOURCE = readFileSync(join(PWA_DIR, 'operation-registry.ts'), 'utf8');
const TYPES_SOURCE = readFileSync(join(SRC_DIR, 'types', 'index.ts'), 'utf8');

/** The `OperationType` union as written, so the members can be read literally. */
function operationTypeUnion(): string {
  const match = /export type OperationType =([\s\S]*?);/.exec(TYPES_SOURCE);
  expect(match, 'the OperationType union could not be found in src/types/index.ts').not.toBeNull();
  return match?.[1] ?? '';
}

describe('drive commands are never queued', () => {
  it('names every actuation mutation the sensor subgraph exposes', () => {
    // A gate that silently guards an empty list is worse than no gate. These are
    // the write mutations on apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts.
    expect(ACTUATION_COMMAND_ROOT_FIELDS).toContain('startVfd');
    expect(ACTUATION_COMMAND_ROOT_FIELDS).toContain('stopVfd');
    expect(ACTUATION_COMMAND_ROOT_FIELDS).toContain('sendVfdCommand');
    // The emergency stop is on the list even though the server lets every
    // authenticated user call it: an e-stop that arrives late is worse than one
    // that never arrives, because the operator believed the machine was stopping.
    expect(ACTUATION_COMMAND_ROOT_FIELDS).toContain('emergencyStopVfd');
  });

  it.each(ACTUATION_COMMAND_ROOT_FIELDS)(
    'BANS %s from the queue-replayed mutation documents',
    (rootField) => {
      for (const [opType, document] of Object.entries(OPERATION_MUTATIONS)) {
        expect(
          new RegExp(`\\b${rootField}\\s*\\(`).test(document),
          `The queued operation '${opType}' replays ${rootField}. A drive command that drains ` +
            'from the queue moves a machine nobody is watching — these are online-only. Send it ' +
            'through src/hooks/useVfdCommand.ts instead.',
        ).toBe(false);
      }
    },
  );

  it.each(ACTUATION_COMMAND_ROOT_FIELDS)('BANS %s from the OperationType union', (rootField) => {
    expect(
      operationTypeUnion().includes(`'${rootField}'`),
      `'${rootField}' was added to OperationType, which is what makes addToQueue accept it. ` +
        'Drive commands are online-only.',
    ).toBe(false);
  });

  it('keeps the compile-time guard wired into the registry', () => {
    // If this assertion is what breaks, the TYPE gate has been deleted and only
    // this test stands between a queued command and a field. Restore it.
    expect(REGISTRY_SOURCE).toContain('QueueExcludesActuationCommands');
    expect(REGISTRY_SOURCE).toMatch(
      /MustBeNever<\s*Extract<OperationType, ActuationCommandRootField>\s*>/,
    );
  });

  it('keeps the command hook off the queue entirely', () => {
    // The hook is the only place this client sends a drive command. It must not
    // reach the queue even as a fallback — "online first, queue on failure" is
    // the pattern that would reintroduce the hazard by the back door.
    const hook = readFileSync(join(SRC_DIR, 'hooks', 'useVfdCommand.ts'), 'utf8');
    for (const queueSymbol of [
      'useOfflineQueue',
      'addToQueue',
      'queueOperation',
      'offline-queue',
    ]) {
      expect(
        hook.includes(queueSymbol),
        `useVfdCommand references ${queueSymbol}. A drive command must reach the network or ` +
          'refuse — never wait in a queue.',
      ).toBe(false);
    }
  });
});
