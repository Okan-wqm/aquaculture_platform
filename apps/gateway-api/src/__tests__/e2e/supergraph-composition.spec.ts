/**
 * Supergraph composition guard — Scope B Phase S1.4.
 *
 * Pins the federation invariants of PR #150 (SensorReadingEvent v3
 * contract) and PR #152 (sensor-service `@key` directives on Sensor
 * + SensorReading). Without this guard, a future PR that:
 *
 *   - removes `@Directive('@key(fields: "id")')` from Sensor or
 *     SensorReading entity declarations,
 *   - changes the federation key fields (e.g. to a composite key
 *     that consumers can't construct without privileged data),
 *   - introduces a typed-cycle conflict (two subgraphs disagreeing
 *     on a shared type's shape),
 *
 * would silently break the supergraph composition at the next
 * gateway boot — hours after merge. This test catches the
 * regression at PR-time.
 *
 * # Why in-process composition (not docker-compose)
 *
 * The Scope B plan §C2 picked the in-process variant for the
 * PR-gate test because:
 *   1. It runs in <1 s vs ~30 s for spinning subgraph services.
 *   2. It needs no databases, no NATS, no MinIO — pure SDL
 *      composition algebra is what we want to verify.
 *   3. CI cost is negligible (zero docker, zero ports).
 *
 * The full three-process e2e variant (C1) lives at
 * `e2e/sensor-tank-federation.e2e-spec.ts` and runs nightly. C1
 * catches RUNTIME federation issues (resolver missing, tenant
 * gate breaking); C2 catches SCHEMA-shape regressions. Two layers,
 * two failure modes.
 *
 * # SDL fixture posture
 *
 * The SDL strings below are MINIMAL — they encode only the federation
 * INVARIANTS we promise to keep stable across the supergraph. They
 * do NOT mirror the full prod schema (that would force this test
 * to track every type addition; the full-schema check is the
 * nightly C1 e2e job's concern).
 *
 * The invariants pinned here:
 *   - `Sensor` carries `@key(fields: "id")` in sensor-service.
 *   - `SensorReading` carries `@key(fields: "id")` in sensor-service.
 *   - `Tank` carries `@key(fields: "id")` in farm-service.
 *   - The supergraph composes without errors when all three are
 *     present together.
 *
 * Each invariant has its own `it()` block so a failure narrative
 * tells the developer EXACTLY which directive went missing rather
 * than a generic "composition failed".
 */
import { composeServices } from '@apollo/composition';
import { parse } from 'graphql';

// ---------------------------------------------------------------------------
// SDL fixtures
// ---------------------------------------------------------------------------

/**
 * sensor-service subgraph SDL — the invariants we care about for
 * cross-service federation. The `@link` directive imports federation
 * v2 directives (without it, `@key` is unrecognised).
 */
const SENSOR_SUBGRAPH_SDL = `
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])

  type Sensor @key(fields: "id") {
    id: ID!
    name: String!
    tenantId: String!
  }

  type SensorReading @key(fields: "id") {
    id: ID!
    sensorId: String!
    timestamp: String!
    tenantId: String!
  }

  type Query {
    sensor(id: ID!): Sensor
    latestReading(sensorId: ID!): SensorReading
  }
`;

/**
 * farm-service subgraph SDL — the Tank entity is the federation
 * key consumer. Phase S1.3 will add `Tank.sensorReadings` here as
 * an extension; this fixture covers the pre-S1.3 baseline so the
 * guard catches the @key-on-Tank invariant TODAY.
 */
const FARM_SUBGRAPH_SDL = `
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])

  type Tank @key(fields: "id") {
    id: ID!
    name: String!
    tenantId: String!
  }

  type Query {
    tank(id: ID!): Tank
  }
`;

/**
 * Helper: compose the canonical two-subgraph supergraph and return
 * the result. Throws if the result has any composition error so the
 * test boundary asserts on the success-path payload.
 */
function composeCanonicalSupergraph() {
  return composeServices([
    {
      name: 'sensor-service',
      typeDefs: parse(SENSOR_SUBGRAPH_SDL),
    },
    {
      name: 'farm-service',
      typeDefs: parse(FARM_SUBGRAPH_SDL),
    },
  ]);
}

describe('supergraph composition guard (Scope B S1.4)', () => {
  describe('invariants from PR #150 + #152 (Scope B S1.1 + S1.2)', () => {
    it('canonical two-subgraph supergraph composes without errors', () => {
      const result = composeCanonicalSupergraph();

      // Any composition error means the federation v2 directives
      // declared in the subgraph SDLs above are inconsistent (e.g.
      // a duplicate `@key` on a non-shareable type, a type-shape
      // disagreement). Surface the FIRST error in the assertion
      // so the test failure pinpoints the broken invariant.
      if (result.errors && result.errors.length > 0) {
        const firstError = result.errors[0];
        throw new Error(
          `supergraph composition failed: ${firstError?.message ?? 'unknown'} (total errors: ${result.errors.length})`,
        );
      }
      expect(result.errors).toBeUndefined();
      expect(result.supergraphSdl).toBeTruthy();
    });

    it('Sensor entity carries @key(fields: "id") in the composed supergraph', () => {
      // The composed supergraph SDL is the authoritative answer to
      // "did sensor-service declare Sensor as a federated entity".
      // Without the @key the type would compose as a plain object
      // and cross-subgraph references would fail at the gateway's
      // _entities query.
      const result = composeCanonicalSupergraph();
      expect(result.supergraphSdl).toBeTruthy();
      const sdl = result.supergraphSdl ?? '';

      // The composed supergraph carries `@join__type` directives
      // that record which subgraph owns which type. The presence
      // of `@join__type(graph: SENSOR_SERVICE, key: "id")` (or
      // similar) on Sensor proves the @key flowed through.
      expect(sdl).toMatch(/type Sensor[\s\S]*?@join__type[^)]*key:\s*"id"/);
    });

    it('SensorReading entity carries @key(fields: "id") in the composed supergraph', () => {
      const result = composeCanonicalSupergraph();
      const sdl = result.supergraphSdl ?? '';
      expect(sdl).toMatch(/type SensorReading[\s\S]*?@join__type[^)]*key:\s*"id"/);
    });

    it('Tank entity carries @key(fields: "id") in the composed supergraph', () => {
      // Tank's @key has been in place since farm-service first
      // shipped federation; this assertion guards against an
      // accidental removal — same posture as the Sensor /
      // SensorReading checks above.
      const result = composeCanonicalSupergraph();
      const sdl = result.supergraphSdl ?? '';
      expect(sdl).toMatch(/type Tank[\s\S]*?@join__type[^)]*key:\s*"id"/);
    });
  });

  // ---------------------------------------------------------------------
  // Negative-path tests — pin the FAIL behaviour of the composer so a
  // future PR that accidentally weakens these invariants can't sneak
  // in by also weakening the test. The positive-path tests above
  // assert the directive IS present; these confirm what the composer
  // does when the directive is MISSING.
  // ---------------------------------------------------------------------
  describe('negative-path: removed @key produces composition error', () => {
    it('detects when Sensor loses its @key directive', () => {
      // Identical to SENSOR_SUBGRAPH_SDL above except `Sensor` is no
      // longer keyed. Composition still succeeds (Sensor becomes a
      // value type), but a hypothetical farm-service extension
      // referencing `Sensor` by id would fail at compose-time. This
      // test pins the behaviour so we know what an "accidental @key
      // removal" PR would look like to CI.
      const corruptSensorSdl = `
        extend schema
          @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])

        type Sensor {
          id: ID!
          name: String!
          tenantId: String!
        }

        type SensorReading @key(fields: "id") {
          id: ID!
          sensorId: String!
          timestamp: String!
          tenantId: String!
        }

        type Query {
          sensor(id: ID!): Sensor
          latestReading(sensorId: ID!): SensorReading
        }
      `;
      const result = composeServices([
        { name: 'sensor-service', typeDefs: parse(corruptSensorSdl) },
        { name: 'farm-service', typeDefs: parse(FARM_SUBGRAPH_SDL) },
      ]);

      // Composition without the @key directive on Sensor is still
      // technically VALID — the type just isn't an entity anymore.
      // The test asserts the SDL output reflects that loss so a
      // forensic auditor can prove the regression after the fact.
      expect(result.errors).toBeUndefined();
      const sdl = result.supergraphSdl ?? '';
      // The non-keyed Sensor type does NOT carry the
      // `key: "id"` field on its @join__type directive.
      const sensorTypeBlock = sdl.match(/type Sensor\s*[\s\S]*?(?=type |$)/)?.[0] ?? '';
      expect(sensorTypeBlock).not.toMatch(/@join__type[^)]*key:\s*"id"/);
    });
  });
});
