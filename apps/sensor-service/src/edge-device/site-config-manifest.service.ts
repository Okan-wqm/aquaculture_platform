import { Injectable } from '@nestjs/common';

import { type DeviceBrokerEndpoint } from './device-broker';
import {
  contractTimestamp,
  type DeviceBinding,
  type DsseEnvelope,
  SITE_PATHS,
  type SignedStatement,
  type SitePath,
  type SiteConfigStatement,
  statementDigest,
  STATEMENT,
} from './edge-contract';
import { UPDATE_CHANNEL } from './edge-update-channel';
import { assertContractSchema } from './edge-statement-schemas';
import {
  assertDeliverableWindow,
  UpdateRefusedError,
  type UpdateTarget,
  type UpdateWindow,
} from './edge-update-manifest.service';
import { ManifestSigner } from './manifest-signer';
import { SuderraEdgeConfig } from './suderra-edge.config';

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
  /** Where root fetches the site bundle, for a statement that travels the update channel. */
  readonly siteBundleUrl?: string;
}

/** Root installs site files of at most 1 MiB (site-config.schema.json `file`). */
const MAX_SITE_FILE_BYTES = 1_048_576;

/**
 * Root fetches at most `max_site_bundle_bytes` of a site bundle. The bundle holds at
 * most one file per fixed site path, each at most {@link MAX_SITE_FILE_BYTES}, base64
 * encoded, and one RBAC manifest envelope (at most 64 KiB, the contract's statement
 * bound): so no bundle the producer can build is over the fetch bound, and this fails
 * at load if the contract's bounds ever stop saying so.
 */
const WORST_CASE_SITE_BUNDLE_BYTES =
  Math.ceil((MAX_SITE_FILE_BYTES * SITE_PATHS.length) / 3) * 4 + 65_536 + 1_024;
if (WORST_CASE_SITE_BUNDLE_BYTES > UPDATE_CHANNEL.maxSiteBundleBytes) {
  throw new Error(
    `a site bundle of ${SITE_PATHS.length} files of ${MAX_SITE_FILE_BYTES} bytes can exceed the ${UPDATE_CHANNEL.maxSiteBundleBytes} bytes root fetches`,
  );
}

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
  const statement: SiteConfigStatement = {
    _type: STATEMENT.siteConfig,
    tenant_id: input.tenantId,
    device_id: input.deviceId,
    device_binding: input.binding,
    update_seq: input.updateSeq,
    not_before: input.notBefore,
    expires_at: input.expiresAt,
    files,
    ...(input.siteBundleUrl === undefined ? {} : { site_bundle_url: input.siteBundleUrl }),
    rbac_manifest: {
      digest: input.rbac.digest,
      policy_version: input.rbac.body.policy_version,
    },
  };
  assertContractSchema('site-config', statement);
  return statement;
}

export interface AgentConfigInput {
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly tenantId: string;
  readonly apiUrl: string;
  /** The single-use token of a first provisioning; absent from the config of a device already activated. */
  readonly provisioningToken?: string;
  readonly broker: DeviceBrokerEndpoint;
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
  if (input.provisioningToken !== undefined && !/^[0-9a-f]{64}$/.test(input.provisioningToken)) {
    throw new Error('the provisioning token is not 64 lowercase hex characters');
  }
  const q = (value: string): string => JSON.stringify(value);
  const lines = [
    '# Suderra edge agent configuration, delivered in a signed site config (ADR-048 DEC-4.12).',
    `device_id: ${q(input.deviceId)}`,
    `device_code: ${q(input.deviceCode)}`,
    `tenant_id: ${q(input.tenantId)}`,
    `api_url: ${q(input.apiUrl)}`,
    ...(input.provisioningToken === undefined
      ? []
      : [`provisioning_token: ${q(input.provisioningToken)}`]),
    'mqtt:',
    `  broker: ${q(input.broker.host)}`,
    `  port: ${input.broker.port}`,
    '  tls:',
    `    enabled: ${input.broker.tls}`,
    '    verify_hostname: true',
    '',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Site commissioning gate SG-1 (ADR-048 Implementation, "Saha devreye alma
 * kapıları"): until P2 exit opens it — HMI authorization and per-tag device
 * routing, e-stop scope and persistence, DEC-13 per-output policy — sites
 * are monitoring-only pilots, and the cloud signs no site config that
 * enables a write to the field. Opening it is a reviewed change of this
 * constant together with the P2 controls, never configuration.
 */
export const SG1_FIELD_WRITES_OPEN = false;

/** Why a site config was not signed. */
export class SiteGateClosedError extends Error {
  constructor(reason: string) {
    super(`SG-1 is closed: the cloud signs monitoring-only site configs; ${reason}`);
    this.name = 'SiteGateClosedError';
  }
}

/**
 * The agent config.yaml settings that let the agent drive the field
 * (sens-api-gateway config.rs): a Modbus device with `allow_writes`, a GPIO
 * pin whose `direction` is an output, and any write-enabling switch of the
 * other protocol stacks.
 */
const FIELD_WRITE_SETTINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\s*-?\s*allow_writes\s*:\s*["']?(?:true|yes|on)\b/im, 'a Modbus device allows writes'],
  [/^\s*-?\s*direction\s*:\s*["']?(?:output|out)\b/im, 'a GPIO pin is an output'],
  [
    /^\s*-?\s*(?:writable|write_enabled|writes_enabled|allow_write)\s*:\s*["']?(?:true|yes|on)\b/im,
    'a protocol stack enables writes',
  ],
];

/**
 * The site files the cloud does not author until SG-1 opens: a PiCtory process image
 * (`revpi/config.rsc`) defines the RevPi's outputs, and `site-policy.json` is where the
 * per-output and HMI authorization policy lives (DEC-13), a P2 control.
 */
const SG1_CLOSED_FILES: ReadonlyArray<readonly [SitePath, string]> = [
  ['revpi/config.rsc', 'revpi/config.rsc defines field outputs'],
  ['site-policy.json', 'site-policy.json carries the per-output policy, a P2 control'],
];

/**
 * Refuses a site file set that would let the agent write to the field while
 * SG-1 is closed: a file the cloud does not author in P0/P1 (see above), or a
 * write-enabling setting in any text file of the set (config.yaml, io-config.yaml,
 * hardware-inventory.yaml).
 */
export function assertMonitoringOnlySite(files: ReadonlyMap<SitePath, Buffer>): void {
  if (SG1_FIELD_WRITES_OPEN) return;
  for (const [path, reason] of SG1_CLOSED_FILES) {
    if (files.has(path)) throw new SiteGateClosedError(reason);
  }
  for (const [path, bytes] of files) {
    if (path === 'revpi/config.rsc') continue;
    const text = bytes.toString('utf8');
    for (const [setting, reason] of FIELD_WRITE_SETTINGS) {
      if (setting.test(text)) throw new SiteGateClosedError(`${path}: ${reason}`);
    }
  }
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

/** The document root fetches from `site_bundle_url` (site-bundle.schema.json): the files and the RBAC manifest the statement names. */
export interface SiteBundleDocument {
  readonly _type: 'suderra.site-bundle.v1';
  readonly rbac_manifest: DsseEnvelope;
  readonly site_files: { readonly [path: string]: string };
}

/**
 * The site bundle of a site-config update. The document is unsigned: root checks
 * every byte of it against the signed statement, so it can only fail an update,
 * never change one. It is built from the same files and RBAC manifest the statement
 * is, and held to the contract schema; the fetch bound holds by construction (below).
 */
export function buildSiteBundle(
  files: ReadonlyMap<SitePath, Buffer>,
  rbac: SignedStatement<typeof STATEMENT.rbacManifest>,
): string {
  const siteFiles: Record<string, string> = {};
  for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (bytes.length > MAX_SITE_FILE_BYTES) {
      throw new UpdateRefusedError(
        'files-invalid',
        `${path} is over the ${MAX_SITE_FILE_BYTES} bytes of a site file`,
      );
    }
    siteFiles[path] = bytes.toString('base64');
  }
  const document: SiteBundleDocument = {
    _type: 'suderra.site-bundle.v1',
    rbac_manifest: rbac.envelope,
    site_files: siteFiles,
  };
  assertContractSchema('site-bundle', document);
  return JSON.stringify(document);
}

/** The path a site bundle is served at, under the platform API host the device's firewall already allows. */
export function siteBundleUrl(apiUrl: string, tenantId: string, requestId: string): string {
  return `${apiUrl}/api/devices/site-bundles/${tenantId}/${requestId}`;
}

export interface SiteUpdateFiles {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  /** Operator-authored files besides config.yaml; the cloud renders config.yaml itself. */
  readonly extraFiles: ReadonlyMap<SitePath, Buffer>;
}

/** What a site-config update carries, built before the statement is: the same files the statement names and the bundle root fetches. */
export interface PreparedSiteUpdate {
  readonly files: ReadonlyMap<SitePath, Buffer>;
  readonly bundle: string;
}

export interface SiteConfigUpdateInput {
  readonly target: Pick<UpdateTarget, 'tenantId' | 'deviceId' | 'binding'>;
  readonly files: ReadonlyMap<SitePath, Buffer>;
  readonly rbac: SignedStatement<typeof STATEMENT.rbacManifest>;
  readonly updateSeq: number;
  readonly window: UpdateWindow;
  readonly siteBundleUrl: string;
}

@Injectable()
export class SiteConfigManifestService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  /**
   * The files and the bundle of a site-config update for a device already activated.
   * config.yaml is the cloud's own and carries no provisioning token (the device's
   * token was spent at its first authenticated session, DEC-5.7); the operator's extra
   * files are named site paths, refused if they would let the agent write to the field
   * while SG-1 is closed.
   */
  prepareUpdate(
    request: SiteUpdateFiles,
    rbac: SignedStatement<typeof STATEMENT.rbacManifest>,
  ): PreparedSiteUpdate {
    const settings = this.config.settings;
    const files = new Map<SitePath, Buffer>([
      [
        'config.yaml',
        renderSuderraOsAgentConfig({
          deviceId: request.deviceId,
          deviceCode: request.deviceCode,
          tenantId: request.tenantId,
          apiUrl: settings.apiUrl,
          broker: settings.deviceBroker,
        }),
      ],
    ]);
    for (const [path, bytes] of request.extraFiles) {
      if (!SITE_PATHS.includes(path) || path === 'config.yaml') {
        throw new UpdateRefusedError(
          'files-invalid',
          `${path} is not a site file an operator supplies`,
        );
      }
      files.set(path, bytes);
    }
    try {
      assertMonitoringOnlySite(files);
    } catch (error) {
      if (error instanceof SiteGateClosedError) {
        throw new UpdateRefusedError('files-invalid', error.message);
      }
      throw error;
    }
    return { files, bundle: buildSiteBundle(files, rbac) };
  }

  /** The signed site config of an update: the window, the files and RBAC manifest by digest, and where root fetches them. */
  signUpdate(input: SiteConfigUpdateInput): SignedStatement<typeof STATEMENT.siteConfig> {
    assertDeliverableWindow(input.window);
    return new ManifestSigner(this.config.settings.keys.configIntegrity).sign(
      STATEMENT.siteConfig,
      buildSiteConfig({
        tenantId: input.target.tenantId,
        deviceId: input.target.deviceId,
        binding: input.target.binding,
        updateSeq: input.updateSeq,
        notBefore: contractTimestamp(input.window.notBefore),
        expiresAt: contractTimestamp(input.window.expiresAt),
        files: input.files,
        rbac: input.rbac,
        siteBundleUrl: input.siteBundleUrl,
      }),
    );
  }

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
          broker: settings.deviceBroker,
        }),
      ],
    ]);
    assertMonitoringOnlySite(files);
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
