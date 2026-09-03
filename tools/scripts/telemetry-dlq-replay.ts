#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
/**
 * telemetry-dlq-replay — Task 1 Step 1.6 replay half (SENSOR-HIGH-093).
 *
 * Re-publishes dead-lettered envelopes from AQUACULTURE_DLQ back onto their
 * ORIGINAL subjects, preserving identity:
 *
 *   - payload is byte-restored from payloadBase64 (no re-serialization);
 *   - Nats-Msg-Id = sourceEventId (deterministic since Task 1.4) when
 *     present, else <originalStream>.<originalSequence> — the same key the
 *     dead-letter hop used, so JetStream's duplicate window collapses an
 *     accidental double replay;
 *   - the DLQ copy is ACKed only AFTER the republish PubAck succeeds.
 *
 * AUTHORIZATION NOTE: this operator tool needs publish rights on the
 * original subjects and consume/ack rights on AQUACULTURE_DLQ. The
 * least-privilege `dlq_replayer` CN is minted with the Task 2 ACL surgery;
 * until then run it with an operator credential that carries those grants
 * — it deliberately fails closed on permission errors rather than
 * half-replaying.
 *
 * Usage:
 *   node tools/scripts/telemetry-dlq-replay.ts [--limit N] [--dry-run]
 *     [--subject-filter 'dlq.<tenant>.<type>'] [--interval-ms 50]
 *
 * Environment: NATS_URL (+ optional NATS_TLS_* / cert envs consumed by
 * buildNatsConnectionOptions — same factory the services use).
 */
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';

interface DlqEnvelope {
  tenantId?: string;
  originalStream: string;
  originalSubject: string;
  originalSequence?: number;
  sourceEventId?: string;
  payloadBase64: string;
  failureClass: string;
  errorDigest: string;
  deliveryCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

interface Args {
  limit: number;
  dryRun: boolean;
  subjectFilter: string;
  intervalMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 100, dryRun: false, subjectFilter: 'dlq.>', intervalMs: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--limit' && next) {
      args.limit = Number(next);
      i++;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--subject-filter' && next) {
      args.subjectFilter = next;
      i++;
    } else if (arg === '--interval-ms' && next) {
      args.intervalMs = Number(next);
      i++;
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error(
        'Usage: telemetry-dlq-replay [--limit N] [--dry-run] [--subject-filter S] [--interval-ms MS]',
      );
      process.exit(2);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    console.error('--limit must be a positive integer');
    process.exit(2);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env['NATS_URL'] ?? 'nats://localhost:4222';
  console.log(
    `[dlq-replay] connecting to ${url} (filter=${args.subjectFilter}, limit=${args.limit}${args.dryRun ? ', dry-run' : ''})`,
  );

  const nc = await connect({ servers: url });
  const js = jetstream(nc);
  // Create-or-update the durable replayer (same add() semantics as the
  // event-bus consumers) — a pull consumer with an explicit ack policy.
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add('AQUACULTURE_DLQ', {
    durable_name: 'dlq-replayer',
    ack_policy: 'explicit',
    filter_subject: args.subjectFilter,
  });
  const consumer = await js.consumers.get('AQUACULTURE_DLQ', 'dlq-replayer');

  const iter = await consumer.fetch({ max_messages: args.limit, expires: 10_000 });
  let replayed = 0;
  let skipped = 0;
  let failed = 0;

  for await (const msg of iter) {
    let envelope: DlqEnvelope;
    try {
      envelope = JSON.parse(msg.string()) as DlqEnvelope;
    } catch (error) {
      console.error(`[dlq-replay] unparseable envelope on ${msg.subject} — nak: ${String(error)}`);
      msg.nak();
      failed++;
      continue;
    }

    if (!envelope.originalSubject || !envelope.payloadBase64) {
      console.error(
        `[dlq-replay] envelope missing originalSubject/payload — ack-discarding ${msg.subject}`,
      );
      msg.ack();
      skipped++;
      continue;
    }

    const msgId =
      envelope.sourceEventId ??
      `${envelope.originalStream}.${envelope.originalSequence ?? msg.seq}`;

    if (args.dryRun) {
      console.log(
        `[dlq-replay] (dry-run) would replay ${envelope.originalSubject} msgID=${msgId} failureClass=${envelope.failureClass}`,
      );
      msg.ack();
      replayed++;
      continue;
    }

    try {
      const payload = Buffer.from(envelope.payloadBase64, 'base64');
      const ack = await js.publish(envelope.originalSubject, payload, {
        msgID: msgId,
        timeout: 5_000,
      });
      msg.ack();
      replayed++;
      console.log(
        `[dlq-replay] replayed ${envelope.originalSubject} (seq ${ack.seq}) msgID=${msgId}`,
      );
    } catch (error) {
      // Fail closed: no ack, message stays in the DLQ for the next run.
      console.error(
        `[dlq-replay] republish FAILED for ${envelope.originalSubject} — leaving in DLQ: ${String(error)}`,
      );
      msg.nak();
      failed++;
    }

    if (args.intervalMs > 0) {
      await new Promise((r) => setTimeout(r, args.intervalMs));
    }
  }

  console.log(`[dlq-replay] done: replayed=${replayed} skipped=${skipped} failed=${failed}`);
  await nc.drain();
}

main().catch((error) => {
  console.error(`[dlq-replay] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
