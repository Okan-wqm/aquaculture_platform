#!/usr/bin/env node

const prometheusUrl = process.env.PROMETHEUS_URL;
if (!prometheusUrl) {
  console.error('PROMETHEUS_URL is required for messaging canary metric gate.');
  process.exit(1);
}

const thresholds = {
  outboxOldestPendingAgeSeconds: Number(
    process.env.MESSAGING_CANARY_OUTBOX_OLDEST_PENDING_MAX_SECONDS ?? '300',
  ),
  dlqGrowth: Number(process.env.MESSAGING_CANARY_DLQ_GROWTH_MAX ?? '0'),
  subjectPayloadMismatch: Number(process.env.MESSAGING_CANARY_SUBJECT_PAYLOAD_MISMATCH_MAX ?? '0'),
  websocketEvictionFailures: Number(
    process.env.MESSAGING_CANARY_WEBSOCKET_EVICTION_FAILURE_MAX ?? '0',
  ),
  readinessFlaps: Number(process.env.MESSAGING_CANARY_READINESS_FLAP_MAX ?? '1'),
  sendMessageP99Seconds: Number(process.env.MESSAGING_CANARY_SEND_MESSAGE_P99_MAX_SECONDS ?? '1'),
};

const checks = [
  {
    name: 'outbox oldest pending age',
    query: 'max(messaging_outbox_oldest_pending_age_seconds)',
    max: thresholds.outboxOldestPendingAgeSeconds,
  },
  {
    name: 'DLQ growth',
    query: 'max(messaging_dlq_growth)',
    max: thresholds.dlqGrowth,
  },
  {
    name: 'subject payload mismatch',
    query: 'increase(messaging_subject_payload_mismatch_total[10m])',
    max: thresholds.subjectPayloadMismatch,
  },
  {
    name: 'websocket eviction failures',
    query: 'increase(messaging_websocket_eviction_failure_total[10m])',
    max: thresholds.websocketEvictionFailures,
  },
  {
    name: 'readiness flaps',
    query: 'increase(messaging_readiness_flap_total[10m])',
    max: thresholds.readinessFlaps,
  },
  {
    name: 'sendMessage p99 latency',
    query:
      'histogram_quantile(0.99, sum(rate(messaging_send_message_latency_seconds_bucket[10m])) by (le))',
    max: thresholds.sendMessageP99Seconds,
  },
];

async function queryPrometheus(query) {
  const url = new URL('/api/v1/query', prometheusUrl);
  url.searchParams.set('query', query);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Prometheus HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.status !== 'success') {
    throw new Error(`Prometheus query failed: ${JSON.stringify(payload)}`);
  }
  const value = payload.data?.result?.[0]?.value?.[1];
  return value === undefined ? 0 : Number(value);
}

const failures = [];
for (const check of checks) {
  const value = await queryPrometheus(check.query);
  if (!Number.isFinite(value) || value > check.max) {
    failures.push(`${check.name}: ${value} > ${check.max}`);
  }
}

if (failures.length > 0) {
  console.error('Messaging canary metric gate failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('Messaging canary metric gate passed.');
