// ============================================================================
// useVfdCommand — start/stop a drive, ONLINE ONLY (ORPHAN-MEDIUM-575)
// ============================================================================
//
// THE SAFETY RULE THIS HOOK EXISTS TO KEEP. Every other write in this app goes
// through the offline queue, and that is right for all of them: they record
// something that already happened, so replaying them later records the same
// fact. A drive command is not a record, it is an ACT, and it happens when it is
// delivered. A start that drains from the queue after the worker has stowed the
// phone spins an auger nobody is standing next to.
//
// So this hook does not import the queue. It cannot: the mechanism that makes
// queueing a drive command a BUILD failure rather than a rule to remember lives
// in src/pwa/actuation-commands.ts + the `QueueExcludesActuationCommands` guard
// in src/pwa/operation-registry.ts, and this file is simply on the other side of
// that line — it talks to `graphqlRequest` directly and nowhere else.
//
// AND THE REFUSAL IS SPOKEN, NOT SWALLOWED. When the device is offline the hook
// returns a refusal with a reason, which the screen renders in an alert region.
// A silent no-op, or a disabled button with no explanation, teaches a worker
// that the app is broken; it must instead say that the command was not sent and
// will not be sent later.
//
// THREE OUTCOMES, KEPT APART BECAUSE THEY MEAN DIFFERENT THINGS:
//   refused — nothing was sent. Either this device is offline, or the SERVER
//             declined before touching the drive (`assertActuable`: unbound,
//             unattested or stale binding). Nothing moved, and nothing will.
//   failed  — the command reached the drive's gateway and did not take. Something
//             may have moved; the drive's own state is the authority, so the
//             screen re-reads it.
//   sent    — the drive acknowledged.

import { useCallback, useState } from 'react';

import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';

import { MOBILE_START_VFD, MOBILE_STOP_VFD } from '@/graphql/vfd-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Role } from '@/types';
import { meetsRoleFloor } from '@/utils/role-rank';

/** The two commands this client offers. */
export type DriveCommand = 'start' | 'stop';

export type DriveCommandStatus = 'sent' | 'refused' | 'failed';

export interface DriveCommandOutcome {
  status: DriveCommandStatus;
  /** Operator-readable, and always says whether anything was sent. */
  message: string;
}

export interface UseVfdCommandResult {
  send: (command: DriveCommand) => Promise<DriveCommandOutcome>;
  isSending: boolean;
  /** The last outcome, for the screen's alert region. Null until one exists. */
  outcome: DriveCommandOutcome | null;
  clearOutcome: () => void;
  /**
   * True when the operator's role clears the server's own floor for start/stop
   * (`@Roles(TENANT_ADMIN, MODULE_MANAGER)` on the command resolver). False hides
   * the controls, so nobody presses a button the server will reject.
   */
  canCommand: boolean;
  /** False when this device cannot reach the server, so the screen can say so before a press. */
  isOnline: boolean;
}

/**
 * The offline answer. It states BOTH halves — not sent, and not queued — because
 * a worker who has spent a shift watching mortality entries queue up will
 * reasonably assume this one queued too.
 */
export const OFFLINE_REFUSAL_MESSAGE =
  'Not sent: this device is offline. Drive commands are never queued — a command that arrived hours late would move a machine nobody is watching. Move into coverage and press again.';

function labelFor(command: DriveCommand): string {
  return command === 'start' ? 'Start' : 'Stop';
}

/** The message of a thrown failure, without letting an unknown reach the screen raw. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'The server did not answer.';
}

/**
 * Commands for ONE drive.
 *
 * `onCommandSettled` is called after any outcome that could have changed the
 * drive; the screen uses it to re-read the drive's own state rather than
 * assuming the command's effect. An optimistic "Running" written by the client
 * would be a claim about a shaft that only the drive can make.
 */
export function useVfdCommand(
  vfdDeviceId: string,
  onCommandSettled?: () => void,
): UseVfdCommandResult {
  const isOnline = useNetworkStatus();
  const { user } = useAuth();
  const [isSending, setIsSending] = useState(false);
  const [outcome, setOutcome] = useState<DriveCommandOutcome | null>(null);

  const role: Role | undefined = user?.role;
  // Mirrors the server matrix exactly, through the same rank SSoT every other
  // role-floored control in this app uses (src/utils/role-rank.ts). FAIL-CLOSED:
  // no user, no commands.
  const canCommand = role !== undefined && meetsRoleFloor(role, 'MODULE_MANAGER');

  const send = useCallback(
    async (command: DriveCommand): Promise<DriveCommandOutcome> => {
      if (!isOnline) {
        // The whole point of this branch: it returns WITHOUT touching the
        // network and WITHOUT touching the queue, and it says so out loud.
        const refusal: DriveCommandOutcome = {
          status: 'refused',
          message: OFFLINE_REFUSAL_MESSAGE,
        };
        setOutcome(refusal);
        return refusal;
      }

      setIsSending(true);
      try {
        const result =
          command === 'start'
            ? (await graphqlRequest(MOBILE_START_VFD, { vfdDeviceId })).startVfd
            : (await graphqlRequest(MOBILE_STOP_VFD, { vfdDeviceId })).stopVfd;

        const settled: DriveCommandOutcome = result.success
          ? {
              status: 'sent',
              message: `${labelFor(command)} acknowledged by the drive.`,
            }
          : {
              status: 'failed',
              message:
                result.error ??
                `The drive did not accept ${labelFor(command).toLowerCase()}. Check the drive itself.`,
            };
        setOutcome(settled);
        return settled;
      } catch (error) {
        // A throw here is the SERVER declining — `assertActuable` raises before
        // anything is written to the drive, and its message names the reason
        // (unbound / unconfirmed / aged out). Passing that message through
        // verbatim is the difference between "it did not work" and an operator
        // knowing an administrator has to bind the drive.
        const refusal: DriveCommandOutcome = {
          status: 'refused',
          message: `Not sent: ${messageOf(error)}`,
        };
        setOutcome(refusal);
        return refusal;
      } finally {
        setIsSending(false);
        onCommandSettled?.();
      }
    },
    [isOnline, vfdDeviceId, onCommandSettled],
  );

  const clearOutcome = useCallback((): void => setOutcome(null), []);

  return { send, isSending, outcome, clearOutcome, canCommand, isOnline };
}
