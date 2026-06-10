#!/usr/bin/env node
import process from 'node:process';

const prometheusUrl = process.env.PROMETHEUS_URL;

function fail(message) {
  process.stderr.write(`messaging-canary-metrics gate failed: ${message}\n`);
  process.exit(1);
}

if (!prometheusUrl) {
  fail('PROMETHEUS_URL is required; canary metrics must be checked against a real Prometheus API');
}

const checks = [
  {
    name: 'oldest pending outbox age',
    query: 'max(messaging_outbox_oldest_pending_age_seconds)',
    max: Number(process.env.MESSAGING_OUTBOX_OLDEST_PENDING_MAX_SECONDS ?? '300'),
  },
  {
    name: 'DLQ growth',
    query: 'sum(increase(messaging_dlq_growth_total[5m]))',
    max: Number(process.env.MESSAGING_DLQ_GROWTH_MAX_5M ?? '0'),
  },
  {
    name: 'subject payload mismatches',
    query: 'sum(increase(messaging_subject_payload_mismatch_total[5m]))',
    max: Number(process.env.MESSAGING_SUBJECT_MISMATCH_MAX_5M ?? '0'),
  },
  {
    name: 'websocket eviction failures',
    query: 'sum(increase(messaging_websocket_eviction_failure_total[5m]))',
    max: Number(process.env.MESSAGING_WS_EVICTION_FAILURE_MAX_5M ?? '0'),
  },
  {
    name: 'readiness flaps',
    query: 'sum(increase(messaging_readiness_flap_total[5m]))',
    max: Number(process.env.MESSAGING_READINESS_FLAP_MAX_5M ?? '0'),
  },
  {
    name: 'send-message p99 latency',
    query:
      'histogram_quantile(0.99, sum(rate(messaging_send_message_latency_seconds_bucket[5m])) by (le))',
    max: Number(process.env.MESSAGING_SEND_MESSAGE_P99_MAX_SECONDS ?? '1'),
  },
];

async function queryPrometheus(query) {
  const url = new URL('/api/v1/query', prometheusUrl);
  url.searchParams.set('query', query);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    fail(`Prometheus query failed with HTTP ${response.status}: ${query}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    fail(`Prometheus query returned non-success status for ${query}`);
  }
  return body.data?.result ?? [];
}

for (const check of checks) {
  if (!Number.isFinite(check.max)) {
    fail(`${check.name} threshold is not a finite number`);
  }
  const result = await queryPrometheus(check.query);
  if (result.length === 0) {
    fail(`${check.name} returned no series for query: ${check.query}`);
  }
  const values = result
    .map((series) => Number(series.value?.[1] ?? 'NaN'))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    fail(`${check.name} returned no numeric samples`);
  }
  const observed = Math.max(...values);
  if (observed > check.max) {
    fail(`${check.name} observed ${observed}, threshold ${check.max}`);
  }
  process.stdout.write(`OK: ${check.name} ${observed} <= ${check.max}\n`);
}
