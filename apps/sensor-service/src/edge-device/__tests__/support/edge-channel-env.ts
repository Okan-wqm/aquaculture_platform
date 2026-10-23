import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  asObject,
  asString,
  FIXTURES,
  type JsonObject,
  keyringFile,
  objects,
} from '../../../../../../tests/invariants/lib/suderra-edge-contract';

/**
 * A full Suderra OS channel configuration over the contract's TEST-ONLY keys and
 * its trust-anchors bundle 1, the way the golden spec sets one up: every signing
 * key is the keyring's seed, the bundle anchors them, and the RBAC window is the
 * golden RBAC manifest's. Specs of the update, escrow and release services take
 * their `SuderraEdgeConfig` from here so they all sign what the fixtures verify.
 */

const TA1 = 'trust-anchors/valid/bundle-seq-1.dsse.json';
const RBAC1 = 'rbac-manifest/valid/platform-actor-policy-1.dsse.json';
const REL_160 = 'edge-release/valid/revpi-connect4-aarch64-1.6.0.dsse.json';

const fixtureText = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');
const bodyOf = (rel: string): JsonObject => {
  const envelope = JSON.parse(fixtureText(rel)) as { payload: string };
  return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as JsonObject;
};

/** The keyring's TEST-ONLY seed of a purpose and epoch. */
export function seedOf(purpose: string, epoch: number): Buffer {
  const entry = objects(keyringFile['keys'], 'keys').find(
    (key) => key['purpose'] === purpose && key['epoch'] === epoch,
  );
  if (entry === undefined) throw new Error(`keyring has no ${purpose} epoch ${epoch}`);
  return createHash('sha256').update(asString(entry['seed_label'], 'seed_label'), 'utf8').digest();
}

const secretOf = (purpose: string): string => `ed25519:1:${seedOf(purpose, 1).toString('hex')}`;

function fleetRootEnv(): string {
  const entry = objects(keyringFile['keys'], 'keys').find((k) => k['purpose'] === 'fleet-root');
  if (entry === undefined) throw new Error('keyring has no fleet-root key');
  return `${String(entry['epoch'])}:${asString(entry['public_key'], 'public_key')}`;
}

export function channelEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const rbac = bodyOf(RBAC1);
  const actor = asObject((rbac['actors'] as JsonObject[])[0], 'actor');
  return {
    SUDERRA_EDGE_PROVISIONING_SIGNING_KEY: secretOf('edge-provisioning'),
    SUDERRA_EDGE_CONFIG_INTEGRITY_SIGNING_KEY: secretOf('config-integrity'),
    SUDERRA_EDGE_RBAC_MANIFEST_SIGNING_KEY: secretOf('rbac-manifest'),
    SUDERRA_EDGE_DEVICE_LIFECYCLE_SIGNING_KEY: secretOf('device-lifecycle'),
    SUDERRA_EDGE_COMMAND_SIGNING_KEY: secretOf('command'),
    SUDERRA_EDGE_TRUST_ANCHORS: fixtureText(TA1),
    SUDERRA_EDGE_FLEET_ROOT_KEYS: fleetRootEnv(),
    SUDERRA_EDGE_PLATFORM_ACTOR_ID: asString(actor['actor_id'], 'actor_id'),
    SUDERRA_EDGE_RBAC_POLICY_VERSION: String(rbac['policy_version']),
    SUDERRA_EDGE_RBAC_NOT_BEFORE: asString(rbac['not_before'], 'not_before'),
    SUDERRA_EDGE_RBAC_EXPIRES_AT: asString(rbac['expires_at'], 'expires_at'),
    SUDERRA_EDGE_RELEASE_URL_TEMPLATE: 'https://edge-releases.example.com/agent/{version}/{asset}',
    SUDERRA_EDGE_RELEASE_REPOSITORY: 'example-org/aquaculture',
    SUDERRA_EDGE_AGENT_VERSION: asString(bodyOf(REL_160)['version'], 'version'),
    SUDERRA_EDGE_MQTT_HOST: 'mqtt-devices.example.com',
    SUDERRA_EDGE_API_URL: 'https://api.example.com',
    ...overrides,
  };
}
