import { Injectable } from '@nestjs/common';

import {
  contractTimestamp,
  type DeviceBinding,
  type SignedStatement,
  type SitePath,
  type SiteConfigStatement,
  statementDigest,
  STATEMENT,
} from './edge-contract';
import { ManifestSigner } from './manifest-signer';
import { SUDERRA_EDGE_MQTT_PORT, SuderraEdgeConfig } from './suderra-edge.config';

/**
 * The signed site config (ADR-048 DEC-4.10, DEC-4.12): device-bound,
 * tenant-bound, signed with the `config-integrity` key, naming every site
 * file by digest and size and the RBAC manifest by statement digest and
 * policy_version. In P0 it travels only inside a provisioning delivery.
 *
 * `config.yaml` is the agent's configuration document. On Suderra OS it is
 * the only source of the agent's identity and endpoints (DEC-4.6, DEC-10.1):
 * the broker is 8883 TLS, fixed here — an activation response can never set
 * or downgrade it — and the single-use provisioning token the agent presents
 * once to activate. The token is spent at the first authenticated broker
 * session (DEC-5.7), after which the copy in the file authorizes nothing.
 */

export interface SiteConfigInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly binding: DeviceBinding;
  readonly updateSeq: number;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly files: ReadonlyMap<SitePath, Buffer>;
  readonly rbac: SignedStatement<typeof STATEMENT.rbacManifest>;
}

/** Root installs site files of at most 1 MiB (site-config.schema.json `file`). */
const MAX_SITE_FILE_BYTES = 1_048_576;

export function buildSiteConfig(input: SiteConfigInput): SiteConfigStatement {
  if (!input.files.has('config.yaml')) {
    throw new Error('A site config always names config.yaml');
  }
  const files: Record<string, { digest: { sha256: string }; size_bytes: number }> = {};
  for (const [path, bytes] of [...input.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (bytes.length > MAX_SITE_FILE_BYTES) {
      throw new Error(`Site file ${path} exceeds ${MAX_SITE_FILE_BYTES} bytes`);
    }
    files[path] = { digest: statementDigest(bytes), size_bytes: bytes.length };
  }
  return {
    _type: STATEMENT.siteConfig,
    tenant_id: input.tenantId,
    device_id: input.deviceId,
    device_binding: input.binding,
    update_seq: input.updateSeq,
    not_before: input.notBefore,
    expires_at: input.expiresAt,
    files,
    rbac_manifest: {
      digest: input.rbac.digest,
      policy_version: input.rbac.body.policy_version,
    },
  };
}

export interface AgentConfigInput {
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly tenantId: string;
  readonly apiUrl: string;
  readonly provisioningToken: string;
  readonly mqttHost: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The Suderra OS agent's config.yaml. Every scalar is a JSON string literal,
 * which is a YAML double-quoted scalar, so no value can change the document's
 * structure; the inputs are validated as well.
 */
export function renderSuderraOsAgentConfig(input: AgentConfigInput): Buffer {
  if (!UUID.test(input.deviceId) || !UUID.test(input.tenantId)) {
    throw new Error('device_id and tenant_id must be lowercase UUIDs');
  }
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(input.deviceCode)) {
    throw new Error('device_code is not a contract device code');
  }
  if (!/^[0-9a-f]{64}$/.test(input.provisioningToken)) {
    throw new Error('the provisioning token is not 64 lowercase hex characters');
  }
  const q = (value: string): string => JSON.stringify(value);
  const lines = [
    '# Suderra edge agent configuration, delivered in a signed site config (ADR-048 DEC-4.12).',
    `device_id: ${q(input.deviceId)}`,
    `device_code: ${q(input.deviceCode)}`,
    `tenant_id: ${q(input.tenantId)}`,
    `api_url: ${q(input.apiUrl)}`,
    `provisioning_token: ${q(input.provisioningToken)}`,
    'mqtt:',
    `  broker: ${q(input.mqttHost)}`,
    `  port: ${SUDERRA_EDGE_MQTT_PORT}`,
    '  tls:',
    '    enabled: true',
    '    verify_hostname: true',
    '',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface DeviceSiteConfigRequest {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly binding: DeviceBinding;
  readonly updateSeq: number;
  readonly window: { readonly notBefore: Date; readonly expiresAt: Date };
  readonly provisioningToken: string;
  readonly rbac: SignedStatement<typeof STATEMENT.rbacManifest>;
}

export interface SignedSiteConfig {
  readonly statement: SignedStatement<typeof STATEMENT.siteConfig>;
  readonly files: ReadonlyMap<SitePath, Buffer>;
}

@Injectable()
export class SiteConfigManifestService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  forDevice(request: DeviceSiteConfigRequest): SignedSiteConfig {
    const settings = this.config.settings;
    const files = new Map<SitePath, Buffer>([
      [
        'config.yaml',
        renderSuderraOsAgentConfig({
          deviceId: request.deviceId,
          deviceCode: request.deviceCode,
          tenantId: request.tenantId,
          apiUrl: settings.apiUrl,
          provisioningToken: request.provisioningToken,
          mqttHost: settings.mqttHost,
        }),
      ],
    ]);
    const signer = new ManifestSigner(settings.keys.configIntegrity);
    const statement = signer.sign(
      STATEMENT.siteConfig,
      buildSiteConfig({
        tenantId: request.tenantId,
        deviceId: request.deviceId,
        binding: request.binding,
        updateSeq: request.updateSeq,
        notBefore: contractTimestamp(request.window.notBefore),
        expiresAt: contractTimestamp(request.window.expiresAt),
        files,
        rbac: request.rbac,
      }),
    );
    return { statement, files };
  }
}
