/**
 * Asking an owner module how many members without its grant wrote to it recently (PKG-06
 * "Readiness"; ADR-051 §3, request.{farm,hr,sensor}.recentWriterIds).
 *
 * WHY: only the owner module knows who wrote to it, and only auth knows who holds which grant
 * (libs/event-contracts/src/module-activity-queries.ts). auth names the members, the owner
 * answers a count. auth_service is the subjects' one declared sender and sends its own
 * ServiceCaller from the subjects' first release (C5).
 *
 * WHAT: `askRecentWriters` sends, per users.role, the ids of the members without the module's
 * grant in requests of at most MAX_USER_IDS, over the subject's request-reply transport
 * (NatsRequestReply, plain JSON — the responders' transport), and sums the counts. A role with
 * no such member is zero without a request. Any failure — transport, a reply the contract guard
 * refuses, or an error reply — makes the whole module UNAVAILABLE: a partial sum would read as
 * a smaller number than the truth. Logs carry the module and the failure kind, never an id. The
 * reserved hydroponics has no writers and no subject: NOT_TRACKED.
 */
import {
  MODULE_ROLES,
  isActiveOwnerModuleCode,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import type { Logger } from '@nestjs/common';
import type { NatsRequestReply } from '@platform/event-bus';
import {
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  RECENT_WRITER_QUERY_LIMITS,
  isRecentWriterIdsReply,
  recentWriterIdsRequest,
  type RecentWriterIdsRequest,
} from '@platform/event-contracts';

import type { RecentWriterReadiness, RoleCount } from './module-access-readiness';

/** An owner answers a bounded count over indexed audit rows; a slower answer is unavailable. */
const RECENT_WRITERS_TIMEOUT_MS = 5_000;

export interface RecentWritersQuestion {
  readonly tenantId: string;
  readonly module: OwnerModuleCode;
  /** The members without the module's grant, by users.role. */
  readonly withoutGrant: ReadonlyMap<ModuleRole, readonly string[]>;
  readonly windowDays: number;
}

type Count = { readonly answered: true; readonly count: number } | { readonly answered: false };

function chunks(ids: readonly string[]): string[][] {
  const size = RECENT_WRITER_QUERY_LIMITS.MAX_USER_IDS;
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += size) out.push(ids.slice(start, start + size));
  return out;
}

async function askOnce(
  requestReply: NatsRequestReply,
  subject: string,
  request: RecentWriterIdsRequest,
  logger: Logger,
  module: OwnerModuleCode,
): Promise<Count> {
  let reply: unknown;
  try {
    reply = await requestReply.requestTyped<RecentWriterIdsRequest, unknown>(subject, request, {
      timeoutMs: RECENT_WRITERS_TIMEOUT_MS,
    });
  } catch (error) {
    logUnanswered(logger, module, 'request_failed', error);
    return { answered: false };
  }
  if (!isRecentWriterIdsReply(reply)) {
    logUnanswered(logger, module, 'malformed_reply');
    return { answered: false };
  }
  if (!reply.ok) {
    logUnanswered(logger, module, reply.error);
    return { answered: false };
  }
  return { answered: true, count: reply.data.recentWriterCount };
}

function logUnanswered(
  logger: Logger,
  module: OwnerModuleCode,
  reason: string,
  error?: unknown,
): void {
  logger.warn(
    JSON.stringify({
      event: 'module_access_readiness_owner_unavailable',
      module,
      reason,
      ...(error === undefined
        ? {}
        : { errorType: error instanceof Error ? error.name : 'UnknownError' }),
    }),
  );
}

export async function askRecentWriters(
  requestReply: NatsRequestReply,
  question: RecentWritersQuestion,
  logger: Logger,
): Promise<RecentWriterReadiness> {
  const { module } = question;
  if (!isActiveOwnerModuleCode(module)) return { status: 'NOT_TRACKED', byUserRole: [] };
  const subject = MODULE_ACTIVITY_QUERY_SUBJECTS[module];

  const byUserRole: RoleCount[] = [];
  for (const role of MODULE_ROLES) {
    let count = 0;
    for (const ids of chunks(question.withoutGrant.get(role) ?? [])) {
      const answer = await askOnce(
        requestReply,
        subject,
        recentWriterIdsRequest(question.tenantId, ids, question.windowDays),
        logger,
        module,
      );
      if (!answer.answered) return { status: 'UNAVAILABLE', byUserRole: [] };
      count += answer.count;
    }
    byUserRole.push({ role, count });
  }
  return { status: 'ANSWERED', byUserRole };
}
