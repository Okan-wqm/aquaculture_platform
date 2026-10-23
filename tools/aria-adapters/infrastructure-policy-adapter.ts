#!/usr/bin/env ts-node
// ARIA-HIGH-012 — infrastructure-policy observation (plan Task 15).
//
// WHY: ARIA read no infrastructure file for policy meaning. The CI gates judge
// compose, Kubernetes, Dockerfile, Terraform, nginx and NATS files and fail a
// pull request, but the autonomy loop never saw a floating image reference, a
// privileged or root runtime, a literal secret the gitleaks path allowlist
// hides, a credential-based NATS identity, a workload container without its
// runtime guards, a security-header inheritance drop or an unpinned Terraform
// module source.
//
// WHAT: an observation over the manifest's roots that is a projection of the
// rule owners the gates already run. It reads every file through the one
// reader per format (tools/gates/lib/infra: classifyInfraFile decides what an
// infrastructure file is and which format it has, readInfraFile reads it) and
// takes every verdict from the one owner of its rule (tools/gates/infra-policy):
//
//   floating_artifact                 image-reference.ts (imagePinVerdict,
//                                     PIN_MUTABILITY); a postgres-family image a
//                                     manifest consumer references is judged by
//                                     tools/gates/postgres-image-manifest.ts
//   privileged_runtime                runtime-privilege.ts (compose and pod
//                                     privilege, PRIVILEGE_REASON_VERDICT, the
//                                     runtime user)
//   literal_secret                    secret-allowlist-premise.ts over the
//                                     env-secret rule of .gitleaks.toml
//   nats_password_identity            nats-identity.ts (natsCredentialAuth)
//   missing_runtime_guard             runtime-guards.ts (podGuards)
//   security_header_inheritance_drop  nginx-header-inheritance.ts (headerLevels
//                                     over includedHeadersFrom's include map)
//   unpinned_terraform_source         terraform-pins.ts (moduleSourcePin,
//                                     MODULE_SOURCE_PINNING)
//
// Nothing here parses a format or restates a rule. What stays here is the
// shell: the input contract (roots required, containment, snapshot), the byte
// and file caps, claims with occurrence-stable fingerprints and evidence, one
// observation per file, and the provenance of the owners whose text decided.
//
// No silent skip: a file that does not read is a named parse failure, a Helm
// template (no reader parses one unrendered) is an excluded observation, a file
// over the byte cap is a refusal, and a verdict an owner reports as unresolved
// (a bind source it cannot place, a runtime user named by a variable, a module
// source it cannot classify, an nginx include it cannot see, or a level that
// sets headers under one) is an
// observation, never a clean result. A credential is located by path, line and
// key, never copied into the output.
//
// A kustomize overlay that patches resources and probes into a base workload it
// deploys supplies that guard: the composition is recorded as evidence instead
// of a claim. A patch in an overlay that does not deploy the base supplies
// nothing to it, and a guard counts only when every deployment of the base
// (each kustomization no other one lists) supplies it.
import { createHash } from 'node:crypto';
import { join, posix, relative } from 'node:path';

import { REGISTRY_IMAGE_COMPOSES } from '../gates/compose-registry-images';
import {
  imagePinVerdict,
  parseImageReference,
  PIN_MUTABILITY,
} from '../gates/infra-policy/image-reference';
import { natsCredentialAuth, type NatsCredentialHit } from '../gates/infra-policy/nats-identity';
import { headerLevels, includedHeadersFrom } from '../gates/infra-policy/nginx-header-inheritance';
import { podGuards } from '../gates/infra-policy/runtime-guards';
import {
  composeServicePrivilege,
  composeServiceUser,
  dockerfileFinalUser,
  podContainerUser,
  podSpecPrivilege,
  PRIVILEGE_REASON_VERDICT,
  type PrivilegeHit,
} from '../gates/infra-policy/runtime-privilege';
import {
  ENV_SECRET_RULE_ID,
  type EnvSecretRule,
  loadEnvSecretRule,
  secretsHiddenByPathAllowlist,
  type StructuredEnvEntry,
} from '../gates/infra-policy/secret-allowlist-premise';
import {
  MODULE_SOURCE_PINNING,
  moduleSourcePin,
  reportedModuleLabels,
  type ReportedSource,
  type ReportedSourceMessage,
  unpinnedSourceMessage,
} from '../gates/infra-policy/terraform-pins';
import { classifyInfraFile, type InfraFormat } from '../gates/lib/infra/classify';
import type { DockerfileRead } from '../gates/lib/infra/dockerfile';
import type { HclRead } from '../gates/lib/infra/hcl-blocks';
import type { NatsRead } from '../gates/lib/infra/nats-conf';
import type { NginxRead } from '../gates/lib/infra/nginx-conf';
import { readInfraFile, type InfraRead } from '../gates/lib/infra/read-infra-file';
import {
  composeEnvironment,
  composeServices,
  containerEnv,
  k8sWorkloads,
  kustomizePatchTargets,
  kustomizeResources,
  podContainers,
} from '../gates/lib/infra/workloads';
import {
  readYamlDocuments,
  type YamlDocument,
  type YamlPath,
  type YamlRead,
} from '../gates/lib/infra/yaml-documents';
import {
  expectedPostgresImageFor,
  isPostgresFamilyImage,
  parsePostgresImageManifest,
  POSTGRES_IMAGE_MANIFEST_PATH,
  type PostgresImageManifest,
} from '../gates/postgres-image-manifest';

import {
  collectFiles,
  containedWorkspace,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  normalizeWorkspacePath,
  pathAllowedBySnapshot,
  requireScanRoots,
  type RepoSnapshot,
  workspaceFileBytes,
} from './adapter-fs';

const TOOL_ID = 'infrastructure-policy-adapter';

const OWNER = {
  image: 'tools/gates/infra-policy/image-reference.ts',
  privilege: 'tools/gates/infra-policy/runtime-privilege.ts',
  guards: 'tools/gates/infra-policy/runtime-guards.ts',
  nats: 'tools/gates/infra-policy/nats-identity.ts',
  secret: 'tools/gates/infra-policy/secret-allowlist-premise.ts',
  headers: 'tools/gates/infra-policy/nginx-header-inheritance.ts',
  terraform: 'tools/gates/infra-policy/terraform-pins.ts',
  postgres: 'tools/gates/postgres-image-manifest.ts',
} as const;
const GITLEAKS_CONFIG = '.gitleaks.toml';
const SELF = 'tools/aria-adapters/infrastructure-policy-adapter.ts';

/**
 * The files whose text decides a verdict here: the containment owner, the
 * readers, the rule owners and this shell. Their hashes are the observation's
 * provenance (`metadata.authorities`).
 */
const AUTHORITY_PATHS: readonly string[] = [
  'tools/aria-adapters/adapter-fs.ts',
  'tools/gates/compose-registry-images.ts',
  'tools/gates/lib/infra/classify.ts',
  'tools/gates/lib/infra/dockerfile.ts',
  'tools/gates/lib/infra/hcl-blocks.ts',
  'tools/gates/lib/infra/nats-conf.ts',
  'tools/gates/lib/infra/nginx-conf.ts',
  'tools/gates/lib/infra/read-error.ts',
  'tools/gates/lib/infra/read-infra-file.ts',
  'tools/gates/lib/infra/workloads.ts',
  'tools/gates/lib/infra/yaml-documents.ts',
  ...Object.values(OWNER),
  SELF,
];

/** The walk stops here, far above the surface's ~220 files. */
const MAX_SOURCE_FILES = 4000;
/** A single file above this is refused with an observation, never read. */
const MAX_FILE_BYTES = 2_000_000;
/** The whole scan stops (throws) past this: a budget is a refusal, not a hole. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const KUSTOMIZATION_BASENAME = /^kustomization\.ya?ml$/i;

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly repo_snapshot?: RepoSnapshot & { readonly base_commit_sha?: string | null };
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly details?: Record<string, unknown>;
}

type InfrastructureRule =
  | 'floating_artifact'
  | 'privileged_runtime'
  | 'literal_secret'
  | 'nats_password_identity'
  | 'missing_runtime_guard'
  | 'security_header_inheritance_drop'
  | 'unpinned_terraform_source';

type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

interface AdapterFinding {
  readonly id: string;
  readonly rule: InfrastructureRule;
  readonly severity: FindingSeverity;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence: number;
  /** The module whose rule decided the verdict, and the verdict it reported. */
  readonly owner: string;
  readonly owner_rule_id: string;
  readonly range: { readonly start_line: number; readonly end_line: number };
  /** The construct the verdict is about (an image reference, a key, a level, a source). */
  readonly subject: string;
  readonly remediation: string;
  readonly target_sha: string | null;
  readonly fingerprint: string;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly unknown[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

interface Projection {
  readonly severity: FindingSeverity;
  readonly confidence: number;
  readonly remediation: string;
}

/**
 * One entry per rule the manifest contracts. Each rule id is written as a
 * literal `rule:` here: the rule-contract pin
 * (aria-kernel/tests/test_rule_contract_manifests.py) reads the emitted
 * vocabulary from this source.
 */
type RuleProjection<R extends InfrastructureRule = InfrastructureRule> = Projection & {
  readonly rule: R;
};

/**
 * What a claim of rule R prints as its subject and message. A Terraform source is printed only
 * as terraform-pins.ts reports it (ReportedSource, ReportedSourceMessage): a plain string, the
 * address as written or a template around it, does not compile there (ARIA-HIGH-012 round-4
 * review R1 residual). The check is `rule extends R`, so a projection widened to every rule
 * demands the Terraform types too rather than slipping past them.
 */
type ClaimSubject<R extends InfrastructureRule> = 'unpinned_terraform_source' extends R
  ? ReportedSource
  : string;
type ClaimMessage<R extends InfrastructureRule> = 'unpinned_terraform_source' extends R
  ? ReportedSourceMessage
  : string;

const RULES: { readonly [R in InfrastructureRule]: RuleProjection<R> } = {
  floating_artifact: {
    rule: 'floating_artifact',
    severity: 'high',
    confidence: 0.8,
    remediation:
      'Pin the image by digest (`@sha256:…`) or require the tag (`${TAG:?TAG required}`) so the same bytes run everywhere; a postgres image follows .github/manifests/postgres-image.json.',
  },
  privileged_runtime: {
    rule: 'privileged_runtime',
    severity: 'high',
    confidence: 0.85,
    remediation:
      'Drop the privilege (privileged, host namespaces, dangerous capabilities, runtime-socket binds, unconfined profiles) and run as an unprivileged user (`USER app`, `runAsNonRoot`).',
  },
  literal_secret: {
    rule: 'literal_secret',
    severity: 'high',
    confidence: 0.85,
    remediation:
      'Reference the secret (`${VAR}`, a secretKeyRef or a secret file) instead of committing it, and rotate the committed value: the gitleaks path allowlist hides it from the CI scan.',
  },
  nats_password_identity: {
    rule: 'nats_password_identity',
    severity: 'high',
    confidence: 0.9,
    remediation:
      'Identify the client by its mTLS certificate (`user: "CN=<name>"` under verify_and_map, ADR-015) and remove the password, token, nkey or non-certificate user.',
  },
  missing_runtime_guard: {
    rule: 'missing_runtime_guard',
    severity: 'medium',
    confidence: 0.7,
    remediation:
      'Give the container a memory limit and readiness and liveness probes, in the base or in the overlay that deploys it.',
  },
  security_header_inheritance_drop: {
    rule: 'security_header_inheritance_drop',
    severity: 'medium',
    confidence: 0.8,
    remediation:
      'Re-apply the dropped headers at this level (include the security-headers snippet), because a level that sets any add_header inherits none.',
  },
  unpinned_terraform_source: {
    rule: 'unpinned_terraform_source',
    severity: 'medium',
    confidence: 0.8,
    remediation:
      'Pin the module: a commit or version tag (`?ref=`), a registry `version`, or a go-getter `?checksum=` on an archive.',
  },
};

// ------------------------------------------------------------------ helpers
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * The line a YAML value path is written on. A value the reader cannot place
 * (a merge chain deeper than it follows) is cited at its document's first
 * line, which is where the value's document starts.
 */
function lineAt(doc: YamlDocument, path: YamlPath): number {
  const line = doc.lineOf(path);
  return line === null ? doc.line : line;
}

function guardKey(file: string, kind: string, name: string, container: string): string {
  return `${file}#${kind}/${name}/${container}`;
}

interface FileWork {
  readonly path: string;
  readonly format: InfraFormat;
  readonly read: InfraRead;
}

interface Composition {
  readonly overlay: string;
  readonly kind: string;
  readonly name: string;
  readonly container: string;
  readonly supplied: readonly string[];
}

export function analyzeInfrastructurePolicy(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = requireScanRoots(TOOL_ID, input.roots);
  const workspace = containedWorkspace(workspaceRoot);
  const targetSha = input.repo_snapshot?.base_commit_sha ?? null;
  const readPaths = new Set<string>();
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const allowed = (path: string): boolean =>
    workspace.entry(path) === 'file' && pathAllowedBySnapshot(workspaceRoot, path, input);

  // ------------------------------------------------------ the scan surface
  for (const root of roots) {
    const entry = workspace.entry(root);
    if (entry === 'refused') {
      throw new Error(`${TOOL_ID}: root is not a contained workspace-relative path: ${root}`);
    }
    if (entry !== 'directory' && entry !== 'file') {
      throw new Error(`${TOOL_ID}: scan root is not a readable workspace path: ${root}`);
    }
    if (entry === 'file' && classifyInfraFile(root) === null) {
      throw new Error(`${TOOL_ID}: scan root is not an infrastructure file: ${root}`);
    }
  }
  const relativePath = (absolute: string): string =>
    normalizeWorkspacePath(relative(workspaceRoot, absolute));
  const collected = filterFilesBySnapshot(
    roots.flatMap((root) =>
      workspace.entry(root) === 'file'
        ? [join(workspaceRoot, root)]
        : collectFiles(workspaceRoot, join(workspaceRoot, root), {
            extensions: [''],
            includeFile: (_name, path) => classifyInfraFile(relativePath(path)) !== null,
          }),
    ),
    workspaceRoot,
    input,
  )
    .map(relativePath)
    .sort();
  if (collected.length > MAX_SOURCE_FILES) {
    throw new Error(
      `${TOOL_ID}: the scan surface holds ${collected.length} files, above the ${MAX_SOURCE_FILES} file cap`,
    );
  }

  let totalBytes = 0;
  const budgetedRead = (path: string): string => {
    const text = workspace.readFile(path);
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`${TOOL_ID}: the scan passed the ${MAX_TOTAL_BYTES} byte budget`);
    }
    readPaths.add(path);
    return text;
  };

  // --------------------------------------------------- the policy premises
  const postgresManifest: PostgresImageManifest | null = allowed(POSTGRES_IMAGE_MANIFEST_PATH)
    ? parsePostgresImageManifest(budgetedRead(POSTGRES_IMAGE_MANIFEST_PATH))
    : null;
  const secretRule: EnvSecretRule | null = allowed(GITLEAKS_CONFIG)
    ? loadEnvSecretRule(budgetedRead(GITLEAKS_CONFIG))
    : null;

  // ----------------------------------------------------------- the claims
  const occurrences = new Map<string, number>();
  const emit = <R extends InfrastructureRule>(
    projection: RuleProjection<R>,
    owner: string,
    ownerRuleId: string,
    path: string,
    line: number,
    subject: ClaimSubject<R>,
    message: ClaimMessage<R>,
    extraEvidence: readonly EvidenceRef[] = [],
  ): void => {
    const key = [projection.rule, path, ownerRuleId, subject.replace(/\s+/g, ' ').trim()].join(
      '\n',
    );
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const fingerprint = sha256(`${key}\n${occurrence}`);
    const at = Math.max(1, line);
    findings.push({
      id: `${TOOL_ID}:${projection.rule}:${path}:${fingerprint.slice(7, 23)}`,
      rule: projection.rule,
      severity: projection.severity,
      path,
      line: at,
      message: `${message} (line ${at})`,
      evidence: [{ path, line: at }, ...extraEvidence],
      confidence: projection.confidence,
      owner,
      owner_rule_id: ownerRuleId,
      range: { start_line: at, end_line: at },
      subject,
      remediation: projection.remediation,
      target_sha: targetSha,
      fingerprint,
    });
  };

  /** A verdict an owner could not reach: recorded where it sits, never read as clean. */
  const unresolved: Record<string, number> = {};
  const recordUnresolved = (
    { rule }: RuleProjection,
    path: string,
    line: number,
    details: Record<string, unknown>,
  ): void => {
    unresolved[rule] = (unresolved[rule] ?? 0) + 1;
    observations.push({
      id: `${TOOL_ID}:unresolved:${rule}:${path}:${line}:${unresolved[rule]}`,
      type: 'infrastructure_unresolved_verdict',
      path,
      details: { rule, line, ...details },
    });
  };

  const judgeImage = (path: string, image: unknown, line: number): void => {
    if (typeof image !== 'string' || image.trim().length === 0) return;
    if (
      postgresManifest !== null &&
      postgresManifest.consumers.includes(path) &&
      isPostgresFamilyImage(image)
    ) {
      const expected = expectedPostgresImageFor(postgresManifest, path);
      if (image.trim() === expected) return;
      emit(
        RULES.floating_artifact,
        OWNER.postgres,
        'manifest_divergence',
        path,
        line,
        image.trim(),
        `\`${image.trim()}\` is a postgres image that diverges from ${POSTGRES_IMAGE_MANIFEST_PATH}, which expects \`${expected}\` in this file`,
        [{ path: POSTGRES_IMAGE_MANIFEST_PATH }],
      );
      return;
    }
    const verdict = imagePinVerdict(parseImageReference(image));
    if (PIN_MUTABILITY[verdict] === 'immutable') return;
    emit(
      RULES.floating_artifact,
      OWNER.image,
      verdict,
      path,
      line,
      image.trim(),
      `\`${image.trim()}\` is a mutable image reference (${verdict}): the bytes it runs can change under an unchanged file`,
    );
  };

  const judgePrivilege = (path: string, hit: PrivilegeHit, line: number): void => {
    if (PRIVILEGE_REASON_VERDICT[hit.reason] === 'unresolved') {
      recordUnresolved(RULES.privileged_runtime, path, line, {
        owner: OWNER.privilege,
        reason: hit.reason,
        detail: hit.detail,
      });
      return;
    }
    const who = hit.container === null ? '' : ` (container ${hit.container})`;
    emit(
      RULES.privileged_runtime,
      OWNER.privilege,
      hit.reason,
      path,
      line,
      `${hit.detail}${who}`,
      `${hit.detail}${who} gives the container ${hit.reason.replace(/_/g, ' ')} privilege on the host`,
    );
  };

  const claimRootUser = (path: string, line: number, verdict: string, detail: string): void => {
    emit(
      RULES.privileged_runtime,
      OWNER.privilege,
      verdict,
      path,
      line,
      detail,
      verdict === 'root'
        ? `${detail}: the container runs as root`
        : `${detail}: no USER drops root, so the base image decides and the container runs as root unless it sets one`,
    );
  };

  /** A runtime user named by a variable: the owner cannot tell whether it is root. */
  const recordUnresolvedUser = (path: string, line: number, detail: string): void => {
    recordUnresolved(RULES.privileged_runtime, path, line, {
      owner: OWNER.privilege,
      reason: 'unresolved_user',
      detail,
    });
  };

  // --------------------------------------------------------- reading pass
  const formatCounts: Record<string, number> = {};
  const parseFailures: string[] = [];
  const refused: string[] = [];
  let excludedTemplates = 0;
  let archived = 0;
  const work: FileWork[] = [];
  const fileDetails = new Map<string, Record<string, unknown>>();

  for (const path of collected) {
    const format = classifyInfraFile(path);
    if (format === null) {
      throw new Error(`${TOOL_ID}: collected a path the classifier does not own: ${path}`);
    }
    formatCounts[format] = (formatCounts[format] ?? 0) + 1;
    if (isArchivedWorkspacePath(path)) {
      archived += 1;
      fileDetails.set(path, { format, parsed: false, excluded: 'archived' });
      continue;
    }
    const bytes = workspaceFileBytes(workspaceRoot, path);
    if (bytes > MAX_FILE_BYTES) {
      refused.push(path);
      observations.push({
        id: `${TOOL_ID}:refused:${path}`,
        type: 'infrastructure_scan_refusal',
        path,
        details: { reason: 'file_over_byte_cap', bytes, cap: MAX_FILE_BYTES },
      });
      fileDetails.set(path, { format, parsed: false, refused: 'file_over_byte_cap' });
      continue;
    }
    const read = readInfraFile(format, budgetedRead(path));
    if (read.read === null) {
      excludedTemplates += 1;
      fileDetails.set(path, { format, parsed: false, excluded: 'helm_template_requires_render' });
      continue;
    }
    if (read.read.errors.length > 0) {
      parseFailures.push(path);
      observations.push({
        id: `${TOOL_ID}:parse-failure:${path}`,
        type: 'infrastructure_parse_failure',
        path,
        details: { format, errors: read.read.errors },
      });
      fileDetails.set(path, { format, parsed: false });
      continue;
    }
    fileDetails.set(path, { format, parsed: true });
    work.push({ path, format, read });
  }

  // ---------------------------------------------- kustomize compositions
  // Which base files each kustomization deploys (its resources, through the
  // kustomizations of the directories it lists), and which guards its patches
  // supply to which workload container. Computed before any claim, so read
  // order never decides a verdict.
  const yamlByPath = new Map<string, YamlRead>();
  for (const item of work) {
    if (item.read.format === 'k8s') yamlByPath.set(item.path, item.read.read);
  }
  const isKustomization = (path: string): boolean =>
    KUSTOMIZATION_BASENAME.test(posix.basename(path));
  const kustomizationIn = (dir: string): string | null => {
    for (const name of ['kustomization.yaml', 'kustomization.yml', 'Kustomization']) {
      const candidate = posix.join(dir, name);
      if (yamlByPath.has(candidate)) return candidate;
    }
    return null;
  };
  const deployedBy = (kustomization: string, seen: Set<string>): Set<string> => {
    const deployed = new Set<string>();
    if (seen.has(kustomization)) return deployed;
    seen.add(kustomization);
    for (const doc of yamlByPath.get(kustomization)?.docs ?? []) {
      for (const resource of kustomizeResources(doc.value, kustomization)) {
        if (yamlByPath.has(resource)) {
          if (isKustomization(resource)) {
            for (const file of deployedBy(resource, seen)) deployed.add(file);
          } else {
            deployed.add(resource);
          }
          continue;
        }
        const nested = kustomizationIn(resource);
        if (nested !== null) for (const file of deployedBy(nested, seen)) deployed.add(file);
      }
    }
    return deployed;
  };
  const kustomizationReads = [...yamlByPath].filter(([path]) => isKustomization(path));
  // The guards each kustomization's own patches supply, per workload container.
  const ownCompositions = new Map<string, Composition[]>();
  for (const [kustomization, read] of kustomizationReads) {
    const compositions: Composition[] = [];
    for (const doc of read.docs) {
      for (const target of kustomizePatchTargets(doc.value, kustomization)) {
        const bodies =
          target.inline !== null
            ? readYamlDocuments(target.inline).docs
            : target.file !== null
              ? (yamlByPath.get(target.file)?.docs ?? [])
              : [];
        for (const body of bodies) {
          for (const workload of k8sWorkloads(body.value)) {
            const kind = target.kind ?? workload.kind;
            const name = target.name ?? workload.name;
            if (name === null) continue;
            for (const container of podContainers(workload)) {
              if (container.name === null) continue;
              const missing = new Set<string>(podGuards(workload, container).missing);
              const guards = ['memory_limit', 'readiness_probe', 'liveness_probe'].filter(
                (gap) => !missing.has(gap),
              );
              if (guards.length > 0) {
                compositions.push({
                  overlay: kustomization,
                  kind,
                  name,
                  container: container.name,
                  supplied: guards,
                });
              }
            }
          }
        }
      }
    }
    ownCompositions.set(kustomization, compositions);
  }
  // The kustomizations each one lists among its resources, as a file or as the
  // kustomization of a listed directory.
  const listedIn = new Map<string, string[]>();
  for (const [kustomization, read] of kustomizationReads) {
    const listed: string[] = [];
    for (const doc of read.docs) {
      for (const resource of kustomizeResources(doc.value, kustomization)) {
        if (yamlByPath.has(resource)) {
          if (isKustomization(resource)) listed.push(resource);
          continue;
        }
        const nested = kustomizationIn(resource);
        if (nested !== null) listed.push(nested);
      }
    }
    listedIn.set(kustomization, listed);
  }
  // A deployment is a kustomization no other kustomization lists: what
  // `kustomize build` is run on. Its build applies the patches of every
  // kustomization it reaches, and only those, to the bases it deploys. A base
  // deployed by several (dev, staging, production) runs once per deployment,
  // so a guard counts as supplied only when every deployment of the base
  // supplies it: the guards of sibling overlays are never unioned (ARIA-HIGH-012
  // round-3 review M4).
  const listed = new Set([...listedIn.values()].flat());
  const deploymentsOf = new Map<string, string[]>();
  const suppliedBy = new Map<string, Map<string, Set<string>>>();
  for (const [deployment] of kustomizationReads.filter(([path]) => !listed.has(path))) {
    for (const file of deployedBy(deployment, new Set())) {
      deploymentsOf.set(file, [...(deploymentsOf.get(file) ?? []), deployment]);
    }
    const reached = new Set<string>();
    const pending = [deployment];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (reached.has(next)) continue;
      reached.add(next);
      pending.push(...(listedIn.get(next) ?? []));
    }
    for (const kustomization of reached) {
      const compositions = ownCompositions.get(kustomization) ?? [];
      if (compositions.length === 0) continue;
      for (const file of deployedBy(kustomization, new Set())) {
        for (const composition of compositions) {
          const key = guardKey(file, composition.kind, composition.name, composition.container);
          const byDeployment = suppliedBy.get(key) ?? new Map<string, Set<string>>();
          const guards = byDeployment.get(deployment) ?? new Set<string>();
          for (const guard of composition.supplied) guards.add(guard);
          byDeployment.set(deployment, guards);
          suppliedBy.set(key, byDeployment);
        }
      }
    }
  }

  // ------------------------------------------------------------ the rules
  const envEntries: StructuredEnvEntry[] = [];

  const scanCompose = (path: string, doc: YamlDocument): void => {
    for (const service of composeServices(doc.value)) {
      judgeImage(path, service.spec.image, lineAt(doc, [...service.path, 'image']));
      for (const hit of composeServicePrivilege(service)) {
        judgePrivilege(path, hit, lineAt(doc, hit.path));
      }
      const user = composeServiceUser(service);
      if (user.verdict === 'root') {
        claimRootUser(
          path,
          lineAt(doc, user.path),
          'root',
          `service ${service.name} user ${String(user.user)}`,
        );
      } else if (user.verdict === 'unresolved') {
        recordUnresolvedUser(
          path,
          lineAt(doc, user.path),
          `service ${service.name} user ${String(user.user)}`,
        );
      }
      for (const entry of composeEnvironment(service)) {
        if (entry.value === null) continue;
        envEntries.push({
          path,
          line: lineAt(doc, entry.path),
          key: entry.key,
          value: entry.value,
        });
      }
    }
  };

  const scanK8s = (path: string, doc: YamlDocument): void => {
    for (const workload of k8sWorkloads(doc.value)) {
      for (const hit of podSpecPrivilege(workload)) {
        judgePrivilege(path, hit, lineAt(doc, hit.path));
      }
      for (const container of podContainers(workload)) {
        judgeImage(path, container.spec.image, lineAt(doc, [...container.path, 'image']));
        const user = podContainerUser(workload, container);
        if (user.verdict === 'root') {
          claimRootUser(
            path,
            lineAt(doc, container.path),
            'root',
            `container ${String(container.name)} runAsUser 0`,
          );
        }
        for (const entry of containerEnv(container)) {
          if (entry.value === null) continue;
          envEntries.push({
            path,
            line: lineAt(doc, entry.path),
            key: entry.key,
            value: entry.value,
          });
        }
        const missing = podGuards(workload, container).missing;
        if (missing.length === 0) continue;
        const name = workload.name === null ? '' : workload.name;
        const composed =
          container.name === null
            ? undefined
            : suppliedBy.get(guardKey(path, workload.kind, name, container.name));
        const deployments = [...(deploymentsOf.get(path) ?? [])].sort();
        const suppliedIn = (deployment: string): string[] => {
          const guards = composed === undefined ? undefined : composed.get(deployment);
          return missing.filter((gap) => guards !== undefined && guards.has(gap));
        };
        // Supplied only when every deployment of this base supplies it.
        const supplied = missing.filter(
          (gap) =>
            deployments.length > 0 &&
            deployments.every((deployment) => suppliedIn(deployment).includes(gap)),
        );
        const remaining = missing.filter((gap) => !supplied.includes(gap));
        if (composed !== undefined && container.name !== null) {
          observations.push({
            id: `${TOOL_ID}:composition:${guardKey(path, workload.kind, name, container.name)}`,
            type: 'infrastructure_composition',
            path,
            details: {
              overlays: deployments,
              supplied,
              remaining,
              deployments: deployments.map((deployment) => ({
                overlay: deployment,
                supplied: suppliedIn(deployment),
              })),
            },
          });
        }
        if (remaining.length === 0) continue;
        const subject = `${workload.kind}/${name}/${String(container.name)}`;
        emit(
          RULES.missing_runtime_guard,
          OWNER.guards,
          remaining.join(','),
          path,
          lineAt(doc, container.path),
          subject,
          `${subject} runs without ${remaining.join(', ')}: nothing bounds its memory or restarts it when it stops serving`,
        );
      }
    }
  };

  const scanDockerfile = (path: string, read: DockerfileRead): void => {
    for (const stage of read.stages) {
      if (stage.isStageRef || stage.isScratch) continue;
      judgeImage(path, stage.from, stage.fromLine);
    }
    const final = dockerfileFinalUser(read);
    if (final.verdict === 'non_root') return;
    const lastStage = read.stages[read.stages.length - 1];
    const line =
      final.line === null ? (lastStage === undefined ? 1 : lastStage.fromLine) : final.line;
    if (final.verdict === 'unresolved') {
      recordUnresolvedUser(path, line, `USER ${String(final.user)}`);
      return;
    }
    if (postgresManifest !== null && path === postgresManifest.dockerfile) {
      // The WAL-G derivative must read and write the physical PGDATA backup
      // boundary; postgres-image-uniformity.spec.ts pins `USER root` on the
      // manifest's dockerfile. The manifest decided: evidence, never a claim.
      observations.push({
        id: `${TOOL_ID}:sanctioned-root-user:${path}`,
        type: 'infrastructure_sanctioned_root_user',
        path,
        details: { line, user: final.user, authority: POSTGRES_IMAGE_MANIFEST_PATH },
      });
      return;
    }
    claimRootUser(
      path,
      line,
      final.verdict,
      final.user === null ? 'the final stage sets no USER' : `USER ${final.user}`,
    );
  };

  const scanTerraform = (path: string, read: HclRead): void => {
    for (const block of read.blocks) {
      if (block.type !== 'module') continue;
      const pin = moduleSourcePin(block);
      const pinning = MODULE_SOURCE_PINNING[pin.verdict];
      if (pinning === 'unresolved') {
        recordUnresolved(RULES.unpinned_terraform_source, path, pin.line, {
          owner: OWNER.terraform,
          verdict: pin.verdict,
          module: reportedModuleLabels(block),
        });
      } else if (pinning === 'unpinned') {
        emit(
          RULES.unpinned_terraform_source,
          OWNER.terraform,
          pin.verdict,
          path,
          pin.line,
          pin.source,
          unpinnedSourceMessage(block, pin),
        );
      }
    }
  };

  // The headers each snippet an image delivers adds, read once and only when an nginx file is
  // scanned. The snippet is read like a premise: within the snapshot, the byte cap and the budget;
  // one that cannot be read leaves its include unresolved wherever it appears.
  let includedHeaders: ReadonlyMap<string, readonly string[]> | null = null;
  const nginxIncludes = (): ReadonlyMap<string, readonly string[]> => {
    includedHeaders ??= includedHeadersFrom((snippet) =>
      allowed(snippet) && workspaceFileBytes(workspaceRoot, snippet) <= MAX_FILE_BYTES
        ? budgetedRead(snippet)
        : null,
    );
    return includedHeaders;
  };

  const scanNginx = (path: string, read: NginxRead): void => {
    for (const level of headerLevels(read.tree, { includedHeaders: nginxIncludes() })) {
      const subject = `${level.context} ${level.location}`.trim();
      if (level.unresolvedIncludes.length > 0) {
        // What the include adds is unknown here, so the level's drops are too.
        recordUnresolved(RULES.security_header_inheritance_drop, path, level.line, {
          owner: OWNER.headers,
          level: subject,
          includes: level.unresolvedIncludes,
          inherited_includes: level.inheritedUnresolvedIncludes,
        });
        continue;
      }
      if (level.dropped.length === 0) {
        // A level that sets headers under an unseen include drops whatever that include adds:
        // not clean, and not a claim this adapter can make.
        if (level.declared.length > 0 && level.inheritedUnresolvedIncludes.length > 0) {
          recordUnresolved(RULES.security_header_inheritance_drop, path, level.line, {
            owner: OWNER.headers,
            level: subject,
            inherited_includes: level.inheritedUnresolvedIncludes,
          });
        }
        continue;
      }
      // A drop the owner sees is certain: an unseen include above can only add to it.
      emit(
        RULES.security_header_inheritance_drop,
        OWNER.headers,
        'add_header_inheritance',
        path,
        level.line,
        subject,
        `${subject} sets ${level.declared.join(', ')} and so serves without ${level.dropped.join(', ')}`,
      );
    }
  };

  const scanNats = (path: string, read: NatsRead): void => {
    for (const hit of natsCredentialAuth(read.tree)) {
      emit(
        RULES.nats_password_identity,
        OWNER.nats,
        hit.kind,
        path,
        hit.line,
        natsSubject(hit),
        `${natsSubject(hit)} authenticates a NATS client by something other than its certificate CN (ADR-015)`,
      );
    }
  };

  for (const item of work) {
    const findingsBefore = findings.length;
    const { read } = item;
    switch (read.format) {
      case 'compose':
        for (const doc of read.read.docs) scanCompose(item.path, doc);
        break;
      case 'k8s':
        for (const doc of read.read.docs) scanK8s(item.path, doc);
        break;
      case 'helm_values':
      case 'helm_chart':
        // Read whole and observed; no owner rules a values or chart file.
        break;
      case 'dockerfile':
        scanDockerfile(item.path, read.read);
        break;
      case 'terraform':
        scanTerraform(item.path, read.read);
        break;
      case 'nginx':
        scanNginx(item.path, read.read);
        break;
      case 'nats':
        scanNats(item.path, read.read);
        break;
      case 'helm_template':
        break;
    }
    const details = fileDetails.get(item.path);
    if (details !== undefined) details.findings = findings.length - findingsBefore;
  }

  // The secret premise judges every structured env entry at once.
  if (secretRule === null) {
    observations.push({
      id: `${TOOL_ID}:rule-unavailable:literal_secret`,
      type: 'infrastructure_rule_unavailable',
      details: {
        rule: 'literal_secret',
        reason: `${GITLEAKS_CONFIG} is not readable in this workspace or snapshot`,
        env_entries: envEntries.length,
      },
    });
  } else {
    for (const hidden of secretsHiddenByPathAllowlist(envEntries, secretRule)) {
      emit(
        RULES.literal_secret,
        OWNER.secret,
        ENV_SECRET_RULE_ID,
        hidden.path,
        hidden.line,
        hidden.key,
        `${hidden.key} holds a ${hidden.secretLength}-character literal that the ${ENV_SECRET_RULE_ID} rule reports, hidden from the CI scan by the path allowlist \`${hidden.hiddenBy}\``,
        [{ path: GITLEAKS_CONFIG }],
      );
      const details = fileDetails.get(hidden.path);
      if (details !== undefined && typeof details.findings === 'number') details.findings += 1;
    }
  }

  // Every collected file carries one file observation: read and judged, a
  // named parse failure, an excluded template or archive, or a refusal.
  const registryComposes: readonly string[] = REGISTRY_IMAGE_COMPOSES;
  for (const path of collected) {
    const details = fileDetails.get(path);
    if (details === undefined) continue;
    observations.push({
      id: `${TOOL_ID}:file:${path}`,
      type: 'infrastructure_file',
      path,
      details: {
        ...details,
        ...(details.format === 'compose'
          ? { deploy_ssot_registry_only: registryComposes.includes(path) }
          : {}),
      },
    });
  }
  const unobservedFiles = collected.filter((path) => !fileDetails.has(path)).length;

  // ------------------------------------------------------------ provenance
  const authorities: Record<string, string | null> = {};
  for (const path of AUTHORITY_PATHS) {
    authorities[path] = allowed(path) ? sha256(budgetedRead(path)) : null;
  }

  const findingCounts: Record<string, number> = {};
  for (const finding of findings) {
    findingCounts[finding.rule] = (findingCounts[finding.rule] ?? 0) + 1;
  }
  observations.push({
    id: `${TOOL_ID}:summary`,
    type: 'infrastructure_policy_summary',
    details: {
      files: collected.length,
      formats: formatCounts,
      parse_failures: parseFailures.length,
      parse_failure_paths: [...parseFailures].sort(),
      excluded_helm_templates: excludedTemplates,
      archived_files: archived,
      refused_paths: [...refused].sort(),
      unobserved_files: unobservedFiles,
      clean: unobservedFiles === 0 && refused.length === 0 && parseFailures.length === 0,
      findings: findingCounts,
      unresolved,
      rules_unavailable: secretRule === null ? ['literal_secret'] : [],
      postgres_manifest_read: postgresManifest !== null,
      bytes_read: totalBytes,
      authorities,
      authorities_complete: Object.values(authorities).every((hash) => hash !== null),
      target_sha: targetSha,
    },
  });

  const sortedReadPaths = [...readPaths].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: { scanMode: 'infrastructure_policy_v1', authorities },
  };
}

/** A credential key by its key alone, a user identity by key and value. */
function natsSubject(hit: NatsCredentialHit): string {
  return 'value' in hit ? `${hit.key} ${hit.value}` : `${hit.key} (${hit.secretLength} characters)`;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      input += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeInfrastructurePolicy(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
