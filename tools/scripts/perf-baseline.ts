#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
//
// perf-baseline.ts — sensor-service ingestion baseline load generator (Faz 0 PR-B).
//
// WHY this script exists
//   The Rust hybrid migration plan
//   (docs/plans/sensor-rust-migration/PLAN.md, ADR-025) gates Faz 2 on a
//   *measured* baseline of the existing NestJS sensor-service ingestion
//   path. Without numbers, "5-10x faster on the same budget" is a guess.
//   This script produces those numbers reproducibly.
//
// WHAT it does
//   1. Connects to an MQTT broker as a configurable number of synthetic
//      tenants × sensors × channels.
//   2. Publishes JSON sensor metric payloads at a precise rate with
//      `producer_ts` (epoch-ms) embedded so ingestion latency can be
//      measured downstream against `now() - producer_ts` in the DB.
//   3. Holds the rate for a configurable duration and optionally fires a
//      short 2x burst, matching the protocol in
//      docs/perf/baseline-2026-04.md.
//   4. Pulls the sensor-service Prometheus endpoint before/after the run
//      so RSS, GC counters, and any custom ingestion histograms land in
//      the JSON report — without coupling this script to the
//      sensor-service code at all.
//
// WHAT it does NOT do
//   - Spin up infrastructure. Caller is responsible for postgres + redis +
//     nats + mqtt-broker + sensor-service all being healthy. The runbook
//     in docs/perf/baseline-2026-04.md says how.
//   - Read the database. Latency capture requires a SQL query against
//     `sensor.sensor_metrics` after the run; the runbook prints it
//     verbatim and the operator pastes the result into the report.
//   - Tune the MQTT broker, sensor-service connection pool, or batch
//     processor. Baseline = stock configuration as it ships in
//     docker-compose.droplet.yml.
//
// USAGE
//   node --experimental-strip-types tools/scripts/perf-baseline.ts \
//     --broker mqtt://localhost:1883 \
//     --tenants 50 --sensors-per-tenant 200 --channels-per-sensor 10 \
//     --rate 5000 --duration 300 --burst-factor 2 --burst-secs 30 \
//     --metrics-url http://localhost:3000/metrics \
//     --output docs/perf/runs/2026-04-baseline-5krps.json
//
// Memory: feedback_tooling_language.md — TypeScript via Node 22 type-stripping;
// no Python, no transpile step, no bundler.

import { connect, type IClientPublishOptions, type MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit, hrtime, env, stdout } from 'node:process';

// ---------- Argument parsing ----------------------------------------------

interface Args {
    broker: string;
    tenants: number;
    sensorsPerTenant: number;
    channelsPerSensor: number;
    rate: number;
    duration: number;
    burstFactor: number;
    burstSecs: number;
    metricsUrl: string | null;
    output: string;
    qos: 0 | 1;
    clientId: string;
}

function parseArgs(): Args {
    const map = new Map<string, string>();
    for (let i = 2; i < argv.length; i += 2) {
        const k = argv[i];
        const v = argv[i + 1];
        if (!k?.startsWith('--') || v === undefined) {
            stderr(`unrecognised arg pair near index ${i}: ${k} ${v}`);
            exit(2);
        }
        map.set(k.slice(2), v);
    }
    const num = (key: string, fallback: number): number => {
        const raw = map.get(key);
        if (!raw) return fallback;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            stderr(`--${key} must be a finite number, got '${raw}'`);
            exit(2);
        }
        return parsed;
    };
    const qosRaw = num('qos', 1);
    if (qosRaw !== 0 && qosRaw !== 1) {
        stderr(`--qos must be 0 or 1 (QoS-2 is not part of the baseline protocol)`);
        exit(2);
    }
    return {
        broker: map.get('broker') ?? 'mqtt://localhost:1883',
        tenants: num('tenants', 50),
        sensorsPerTenant: num('sensors-per-tenant', 200),
        channelsPerSensor: num('channels-per-sensor', 10),
        rate: num('rate', 5000),
        duration: num('duration', 300),
        burstFactor: num('burst-factor', 2),
        burstSecs: num('burst-secs', 30),
        metricsUrl: map.get('metrics-url') ?? null,
        output: map.get('output') ?? `docs/perf/runs/baseline-${Date.now()}.json`,
        qos: qosRaw,
        clientId: map.get('client-id') ?? `perf-baseline-${randomUUID().slice(0, 8)}`,
    };
}

function stderr(msg: string): void {
    process.stderr.write(`[perf-baseline] ${msg}\n`);
}

// ---------- Topic + payload synthesis -------------------------------------

interface Routing {
    tenants: string[];
    sensorIds: string[][];
    channelIds: string[][][];
}

// Synthetic tenant/sensor/channel UUID space. Stable across runs so that
// downstream cache and DB rows are reproducible. UUID-v5-style derivation
// from a deterministic seed keeps allocation cost off the hot path.
function buildRouting(args: Args): Routing {
    const tenants: string[] = [];
    const sensorIds: string[][] = [];
    const channelIds: string[][][] = [];
    for (let t = 0; t < args.tenants; t += 1) {
        const tenantId = uuidFromSeed(`tenant-${t}`);
        tenants.push(tenantId);
        const sensorRow: string[] = [];
        const channelRow: string[][] = [];
        for (let s = 0; s < args.sensorsPerTenant; s += 1) {
            const sensorId = uuidFromSeed(`sensor-${t}-${s}`);
            sensorRow.push(sensorId);
            const channels: string[] = [];
            for (let c = 0; c < args.channelsPerSensor; c += 1) {
                channels.push(uuidFromSeed(`channel-${t}-${s}-${c}`));
            }
            channelRow.push(channels);
        }
        sensorIds.push(sensorRow);
        channelIds.push(channelRow);
    }
    return { tenants, sensorIds, channelIds };
}

// Derive a stable UUID-v4-shaped string from a seed. Not RFC-compliant
// (the variant nibble is fudged) but identical seed -> identical UUID,
// which is all this test needs.
function uuidFromSeed(seed: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < seed.length; i += 1) {
        const ch = seed.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = (h1 ^ (h1 >>> 16)) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
    const a = hex(h1, 8);
    const b = hex(h2 & 0xffff, 4);
    const c = `4${hex((h2 >>> 16) & 0x0fff, 3)}`;
    const d = `${hex(0x8 + (h1 & 0x3), 1)}${hex((h1 >>> 4) & 0x0fff, 3)}`;
    const e = `${hex(h1, 8)}${hex(h2, 4)}`.slice(0, 12);
    return `${a}-${b}-${c}-${d}-${e}`;
}

interface Picked {
    tenantIdx: number;
    sensorIdx: number;
    channelIdx: number;
}

function pickRoute(routing: Routing, args: Args, n: number): Picked {
    // Round-robin distribution keeps the load even across all
    // tenants/sensors/channels rather than skewing toward a hot key.
    const tenantIdx = n % args.tenants;
    const sensorIdx = Math.floor(n / args.tenants) % args.sensorsPerTenant;
    const channelIdx = Math.floor(n / (args.tenants * args.sensorsPerTenant)) % args.channelsPerSensor;
    return { tenantIdx, sensorIdx, channelIdx };
}

// ---------- Run loop ------------------------------------------------------

interface Counters {
    publishedAttempted: number;
    publishedAck: number;
    publishedError: number;
    rateSnapshots: { wallSec: number; sentSinceLast: number }[];
    startedAtMs: number;
    finishedAtMs: number;
}

async function publishAtRate(
    client: MqttClient,
    args: Args,
    routing: Routing,
    rate: number,
    durationSec: number,
    counters: Counters,
    phaseLabel: string,
): Promise<void> {
    const intervalNs = BigInt(Math.floor(1_000_000_000 / rate));
    const startNs = hrtime.bigint();
    const endNs = startNs + BigInt(durationSec) * 1_000_000_000n;
    let sent = 0;
    let lastSnapshotNs = startNs;
    let lastSnapshotSent = 0;

    const opts: IClientPublishOptions = { qos: args.qos, retain: false };

    while (true) {
        const targetNs = startNs + intervalNs * BigInt(sent);
        const nowNs = hrtime.bigint();
        if (targetNs > nowNs) {
            const sleepMs = Number(targetNs - nowNs) / 1_000_000;
            // Cooperative pacing — sleep up to ~1ms so the event loop can
            // drain ack callbacks before we queue more.
            await sleep(Math.min(sleepMs, 1));
            continue;
        }
        if (nowNs >= endNs) break;

        const route = pickRoute(routing, args, sent);
        const tenantId = routing.tenants[route.tenantIdx]!;
        const sensorId = routing.sensorIds[route.tenantIdx]![route.sensorIdx]!;
        const channelId = routing.channelIds[route.tenantIdx]![route.sensorIdx]![route.channelIdx]!;

        // Topic shape mirrors the existing sensor-service MQTT contract
        // (apps/sensor-service/src/ingestion/ingestion-mqtt-listener.service.ts):
        //   sensors/<tenant>/<sensor>/data
        const topic = `sensors/${tenantId}/${sensorId}/data`;

        const payload = JSON.stringify({
            tenantId,
            sensorId,
            channelId,
            value: 20 + ((sent % 100) / 10), // synthetic, deterministic
            quality: 1,
            producerTs: Date.now(),
        });

        counters.publishedAttempted += 1;
        sent += 1;

        client.publish(topic, payload, opts, (err) => {
            if (err) {
                counters.publishedError += 1;
            } else {
                counters.publishedAck += 1;
            }
        });

        // 1-second rate snapshot for the report.
        if (nowNs - lastSnapshotNs >= 1_000_000_000n) {
            const wallSec = Number(nowNs - startNs) / 1_000_000_000;
            counters.rateSnapshots.push({
                wallSec: Number(wallSec.toFixed(3)),
                sentSinceLast: sent - lastSnapshotSent,
            });
            stdout.write(
                `[${phaseLabel}] t=${wallSec.toFixed(1)}s sent=${sent} (${sent - lastSnapshotSent}/s) acked=${counters.publishedAck} err=${counters.publishedError}\n`,
            );
            lastSnapshotNs = nowNs;
            lastSnapshotSent = sent;
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

// ---------- Prometheus snapshot ------------------------------------------

interface MetricsSnapshot {
    fetchedAtMs: number;
    raw: string | null;
    error: string | null;
}

async function snapshotMetrics(url: string | null): Promise<MetricsSnapshot> {
    const fetchedAtMs = Date.now();
    if (!url) return { fetchedAtMs, raw: null, error: 'no metrics-url provided' };
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (!resp.ok) {
            return { fetchedAtMs, raw: null, error: `HTTP ${resp.status}` };
        }
        return { fetchedAtMs, raw: await resp.text(), error: null };
    } catch (e) {
        return { fetchedAtMs, raw: null, error: (e as Error).message };
    }
}

// ---------- Main ----------------------------------------------------------

async function main(): Promise<void> {
    const args = parseArgs();
    stderr(`broker=${args.broker} tenants=${args.tenants} sensors=${args.sensorsPerTenant} channels=${args.channelsPerSensor}`);
    stderr(`rate=${args.rate}/s duration=${args.duration}s burst=${args.burstFactor}x for ${args.burstSecs}s qos=${args.qos}`);

    const routing = buildRouting(args);
    stderr(`routing built — ${routing.tenants.length * args.sensorsPerTenant * args.channelsPerSensor} unique (tenant,sensor,channel) tuples`);

    const client = connect(args.broker, {
        clientId: args.clientId,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 5_000,
        username: env.MQTT_USERNAME,
        password: env.MQTT_PASSWORD,
    });

    await new Promise<void>((res, rej) => {
        client.once('connect', () => res());
        client.once('error', (e) => rej(e));
    });
    stderr(`connected as ${args.clientId}`);

    const counters: Counters = {
        publishedAttempted: 0,
        publishedAck: 0,
        publishedError: 0,
        rateSnapshots: [],
        startedAtMs: Date.now(),
        finishedAtMs: 0,
    };

    const beforeMetrics = await snapshotMetrics(args.metricsUrl);

    await publishAtRate(client, args, routing, args.rate, args.duration, counters, 'sustained');

    if (args.burstSecs > 0 && args.burstFactor > 1) {
        const burstRate = Math.round(args.rate * args.burstFactor);
        stderr(`entering burst phase: ${burstRate}/s for ${args.burstSecs}s`);
        await publishAtRate(client, args, routing, burstRate, args.burstSecs, counters, 'burst');
    }

    counters.finishedAtMs = Date.now();
    const afterMetrics = await snapshotMetrics(args.metricsUrl);

    // Drain — wait for in-flight QoS-1 acks before disconnecting.
    stderr('draining acks...');
    const drainStartMs = Date.now();
    while (
        counters.publishedAttempted > counters.publishedAck + counters.publishedError &&
        Date.now() - drainStartMs < 30_000
    ) {
        await sleep(100);
    }

    await new Promise<void>((res) => client.end(false, {}, () => res()));
    stderr('disconnected');

    const report = {
        scriptVersion: '0.1.0',
        args,
        counters,
        ratePlanned: args.rate,
        rateAchievedAvg:
            counters.publishedAttempted /
            ((counters.finishedAtMs - counters.startedAtMs) / 1000),
        beforeMetrics,
        afterMetrics,
    };

    const outPath = resolve(process.cwd(), args.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    stderr(`report written -> ${outPath}`);
    stderr(
        `summary: attempted=${counters.publishedAttempted} acked=${counters.publishedAck} ` +
            `err=${counters.publishedError} avg=${report.rateAchievedAvg.toFixed(0)}/s`,
    );
}

main().catch((e: unknown) => {
    stderr(`fatal: ${(e as Error).stack ?? String(e)}`);
    exit(1);
});
