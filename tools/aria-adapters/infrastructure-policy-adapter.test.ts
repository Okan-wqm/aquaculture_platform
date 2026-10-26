import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

import { makeFixtureTree } from '../gates/fixture-tree';
import { natsCredentialAuth } from '../gates/infra-policy/nats-identity';
import { composeServicePrivilege } from '../gates/infra-policy/runtime-privilege';
import { MODULE_SOURCE_PINNING } from '../gates/infra-policy/terraform-pins';
import {
  authorityProbes,
  probesAsTerraform,
  reviewerProbes,
  terraformSourceProbes,
} from '../gates/infra-policy/terraform-source-probes';
import { classifyInfraFile } from '../gates/lib/infra/classify';
import { readNatsConf } from '../gates/lib/infra/nats-conf';
import { composeServices } from '../gates/lib/infra/workloads';
import { readYamlDocuments } from '../gates/lib/infra/yaml-documents';

import { analyzeInfrastructurePolicy } from './infrastructure-policy-adapter';

// ARIA-HIGH-012 (plan Task 15): the regression ref the closure contract names
// (aria_kernel/autonomy_evidence.py). Written test-first for the landing that
// ports the adapter shell of fix/aria-kc-adapters-observation (146601b5d) onto
// the one-owner-per-rule layer of aria-chain/g017-012-rules (c4b89bfb1); the
// decision and its evidence are high-012-compare.md (PLAN-v2 F0.4).
//
// The contract, in the order this file checks it:
//   1. The adapter is a projection. Every claim comes from the owner the CI
//      gates already run (tools/gates/infra-policy/*, read through
//      tools/gates/lib/infra/*): the import graph says so, the adapter defines
//      no Dockerfile, HCL, YAML, NATS or secret reader or rule of its own, and
//      it touches the filesystem only through adapter-fs.ts (no statSync,
//      ARIA-LOW-593).
//   2. The manifest names each root compose file (no `docker-compose*.yml`
//      glob, which both scope gates refuse) and lets the room read the owners.
//   3. A semantic workspace with a safe and an unsafe twin per claim: the five
//      planned claims plus the two owners B added (header-inheritance drops,
//      Terraform module sources). A `{{` outside a Helm template is text, not
//      a reason to skip a file; a credential is located, never copied into
//      the output; an alias bomb and a nesting bomb are parse failures that
//      name their file, not an aborted scan.
//   4. The real repository: every infrastructure file the classifier owner
//      knows under the manifest's roots is observed, the production cAdvisor
//      socket binds and the password NATS config are claimed.
//   5. The round-2 review blockers (kc/r12-review/REVIEW.txt): the nginx include
//      map comes from the header owner, an include it cannot see is carried
//      down to the levels under it, and a Terraform credential never reaches
//      the output.
//   6. The round-3 review blockers (kc/r12r2-review/REVIEW.txt).
//   7. The round-4 review blocker R1 residual (kc/r12r3-review/REVIEW.txt): a
//      Terraform source is reported only from parts that pass a shape check,
//      through a type only terraform-pins.ts constructs.
//
// The workspace is built at run time, as workflow-shell-safety's is: a
// committed fixture holding an alias bomb or a nesting bomb would be read by
// infra-policy.spec.ts's corpus test, which requires every tracked
// infrastructure file to parse.

const REPO_ROOT = resolve(__dirname, '..', '..');
const TOOL_ID = 'infrastructure-policy-adapter';
const ADAPTER_SOURCE = join(__dirname, `${TOOL_ID}.ts`);
const MANIFEST_PATH = join(__dirname, `${TOOL_ID}.tool.json`);

const OWNER = {
  image: 'tools/gates/infra-policy/image-reference.ts',
  privilege: 'tools/gates/infra-policy/runtime-privilege.ts',
  guards: 'tools/gates/infra-policy/runtime-guards.ts',
  nats: 'tools/gates/infra-policy/nats-identity.ts',
  secret: 'tools/gates/infra-policy/secret-allowlist-premise.ts',
  headers: 'tools/gates/infra-policy/nginx-header-inheritance.ts',
  terraform: 'tools/gates/infra-policy/terraform-pins.ts',
} as const;
const READERS = [
  'tools/gates/lib/infra/classify.ts',
  'tools/gates/lib/infra/read-infra-file.ts',
  'tools/gates/lib/infra/workloads.ts',
] as const;
const PLANNED_RULES = [
  'floating_artifact',
  'privileged_runtime',
  'literal_secret',
  'nats_password_identity',
  'missing_runtime_guard',
] as const;
const ADDED_RULES = ['security_header_inheritance_drop', 'unpinned_terraform_source'] as const;

// =========================================================== 1. the projection
const adapterText = readFileSync(ADAPTER_SOURCE, 'utf8');
const adapterAst = ts.createSourceFile(ADAPTER_SOURCE, adapterText, ts.ScriptTarget.ES2022, true);

/** Every module the adapter loads: static imports, re-exports, require() and import(). */
const importedModules: string[] = [];
const importedNames: string[] = [];
const declaredNames: string[] = [];
const regexLiterals: string[] = [];
const identifiers = new Set<string>();
const visit = (node: ts.Node): void => {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    importedModules.push(node.moduleSpecifier.text);
    const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        importedNames.push((element.propertyName ?? element.name).text);
      }
    }
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  ) {
    const [specifier] = node.arguments;
    importedModules.push(
      specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : '<dynamic>',
    );
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name)
  ) {
    declaredNames.push(node.name.text);
  }
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) regexLiterals.push(node.getText());
  if (ts.isIdentifier(node)) identifiers.add(node.text);
  ts.forEachChild(node, visit);
};
visit(adapterAst);

const repoModule = (specifier: string): string | null =>
  specifier.startsWith('.')
    ? `${resolve(__dirname, specifier).slice(REPO_ROOT.length + 1)}.ts`
    : null;
const importedRepoFiles = new Set(
  importedModules.flatMap((specifier) => {
    const file = repoModule(specifier);
    return file === null ? [] : [file];
  }),
);
for (const owner of [...Object.values(OWNER), ...READERS]) {
  assert.ok(importedRepoFiles.has(owner), `the adapter reads its verdicts from ${owner}`);
}
// The readers and rules live in their owners: no parser package is loaded here,
// and the filesystem is reached through the containment owner only.
assert.deepEqual(
  importedModules.filter((specifier) =>
    ['yaml', 'js-yaml', 'smol-toml', 'fs', 'node:fs', 'fs/promises', 'node:fs/promises'].includes(
      specifier,
    ),
  ),
  [],
  'no parser package and no node:fs (adapter-fs.ts owns workspace access, ARIA-LOW-593)',
);
assert.equal(importedModules.includes('<dynamic>'), false, 'every loaded module is named');
assert.equal(importedNames.includes('statSync'), false, 'statSync is not imported');
assert.equal(identifiers.has('statSync'), false, 'statSync is not called');
// A's private readers and rules (146601b5d), each replaced by an owner in
// high-012-compare.md section 5: none may come back under its old name.
const PRIVATE_COPIES = [
  'dockerInstructions',
  'dockerFromReferences',
  'dockerFinalStageUser',
  'dockerEnvArgEntries',
  'hclTokens',
  'parseHcl',
  'loadAll',
  'locateLine',
  'yamlEvidenceLine',
  'docStartLines',
  'classOfFile',
  'scanNatsConf',
  'SECRET_KEY_NAME',
  'isLiteralSecretValue',
  'scanEnvironment',
  'scanEnvFile',
  'walkImageMaps',
  'DIGEST_SUFFIX',
];
assert.deepEqual(
  declaredNames.filter((name) => PRIVATE_COPIES.includes(name)),
  [],
  'a reader or rule the owners hold is not declared again in the adapter',
);
assert.deepEqual(
  regexLiterals.filter((literal) => /\{\{|\\\{\\\{/.test(literal)),
  [],
  'a {{ anywhere is not a Helm template: classifyInfraFile decides what is one (A-4)',
);
// The owner spec's test-first cases (todo until their fix lands) must all be
// live before this regression ref can close ARIA-HIGH-012.
assert.equal(
  /\btodo\s*:/.test(
    readFileSync(join(REPO_ROOT, 'tools/gates/infra-policy/infra-policy.spec.ts'), 'utf8'),
  ),
  false,
  'tools/gates/infra-policy/infra-policy.spec.ts still marks a landing case todo',
);

// ============================================================ 2. the manifest
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  declared_scope: string[];
  allowed_read_globs: string[];
  default_input: { roots: string[] };
  rules: Record<string, unknown>;
};
const trackedFiles = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) => path.length > 0);
const rootComposeFiles = trackedFiles
  .filter((path) => !path.includes('/') && classifyInfraFile(path) === 'compose')
  .sort();
assert.ok(rootComposeFiles.length > 0, 'the repository root carries compose files');
assert.deepEqual(
  manifest.declared_scope.filter(
    (glob) => /compose/.test(glob) && !glob.includes('/') && /[*?[{]/.test(glob),
  ),
  [],
  'a compose glob with no directory prefix has no root to sit under: both scope gates refuse it ' +
    '(A-3); under a root (apps/**/compose*.yml) it has one (B15)',
);
for (const compose of rootComposeFiles) {
  assert.ok(manifest.declared_scope.includes(compose), `declared_scope names ${compose}`);
  assert.ok(manifest.default_input.roots.includes(compose), `default_input.roots walks ${compose}`);
}
for (const rule of [...PLANNED_RULES, ...ADDED_RULES]) {
  assert.ok(rule in manifest.rules, `the manifest carries the ${rule} contract`);
}
const globRegex = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  );
const readable = (path: string): boolean =>
  manifest.allowed_read_globs.some((glob) => globRegex(glob).test(path));
for (const path of ['.gitleaks.toml', ...Object.values(OWNER), ...READERS]) {
  assert.ok(readable(path), `the adapter room may read ${path}`);
}

// ================================================= 3. the semantic workspace
const DIGEST = `sha256:${'d'.repeat(64)}`;
const SECRET_COMPOSE = 'Qv7Lm2Xp9TzR4wKd';
const SECRET_K8S = 'Hb4Rn8Wc2Ys6Jt0Mf';
const NATS_LITERAL = 'Lit3ral-Nats-Pass-77';

const COMPOSE = 'docker-compose.yml';
const DOCKERFILE_WORKER = 'infrastructure/docker/Dockerfile.worker';
const DOCKERFILE_API = 'infrastructure/docker/Dockerfile.api';
const DOCKERFILE_OPS = 'infrastructure/docker/Dockerfile.ops';
const K8S_API = 'infrastructure/kubernetes/base/api.yaml';
const K8S_WORKER = 'infrastructure/kubernetes/base/worker.yaml';
const K8S_AGENT = 'infrastructure/kubernetes/base/agent.yaml';
const K8S_REPORTER = 'infrastructure/kubernetes/base/reporter.yaml';
const K8S_BOMB = 'infrastructure/kubernetes/base/bomb.yaml';
const OVERLAY_PROD = 'infrastructure/kubernetes/overlays/prod/kustomization.yaml';
const OVERLAY_STRAY = 'infrastructure/kubernetes/overlays/stray/kustomization.yaml';
const TERRAFORM = 'infrastructure/terraform/main.tf';
const NATS_CERT = 'infrastructure/docker/nats/nats.conf';
const NATS_AUTH = 'infrastructure/docker/nats/nats-auth.conf';
const NATS_LITERAL_CONF = 'infrastructure/docker/nats/nats-literal.conf';
const NATS_DEEP = 'infrastructure/docker/nats/nats-deep.conf';
const NGINX = 'infrastructure/docker/nginx/app.conf';

const TERRAFORM_TEXT = [
  'module "branch" { source = "git::https://git.acme.test/vpc.git?ref=main" }', //            1
  `module "commit" { source = "git::https://git.acme.test/vpc.git?ref=${'b'.repeat(40)}" }`, // 2
  'module "registry" {', //                                                                   3
  '  source  = "terraform-aws-modules/vpc/aws"', //                                           4
  '  version = "5.1.2"', //                                                                   5
  '}', //                                                                                     6
  'module "local" { source = "../modules/vpc" }', //                                          7
  'module "archive" { source = "https://artifacts.acme.test/vpc.zip" }', //                   8
  '',
].join('\n');

const guardsPatch = (workload: string): string[] => [
  'patches:',
  '  - patch: |-',
  '      apiVersion: apps/v1',
  '      kind: Deployment',
  `      metadata: { name: ${workload} }`,
  '      spec:',
  '        template:',
  '          spec:',
  '            containers:',
  `              - name: ${workload}`,
  '                resources: { limits: { memory: 256Mi } }',
  '                readinessProbe: { httpGet: { path: /ready, port: 8080 } }',
  '                livenessProbe: { httpGet: { path: /live, port: 8080 } }',
];

const FILES: Readonly<Record<string, string>> = {
  [COMPOSE]: [
    '# rendered once by {{ .Values.never }}: a comment, not a template', //       1
    'x-base: &base', //                                                            2
    '  restart: unless-stopped', //                                                3
    'services:', //                                                                4
    '  api:', //                                                                   5
    '    <<: *base', //                                                            6
    '    image: ghcr.io/acme/api:${TAG:?TAG required}', //                         7
    '    user: "1000"', //                                                         8
    '    healthcheck:', //                                                         9
    `      test: ["CMD-SHELL", "docker inspect --format '{{.State.Health.Status}}' api"]`, // 10
    '    environment:', //                                                         11
    `      POSTGRES_PASSWORD: ${SECRET_COMPOSE}`, //                               12
    '      REDIS_PASSWORD: ${REDIS_PASSWORD}', //                                  13
    '      JWT_SECRET: change-me-before-deploy', //                                14
    '  worker:', //                                                                15
    '    image: ghcr.io/acme/worker:${TAG:-latest}', //                            16
    '    command: ["sh", "-c", "echo privileged: true"]', //                       17
    '  cache:', //                                                                 18
    '    image: redis:7-alpine', //                                                19
    '  pinned:', //                                                                20
    `    image: redis@${DIGEST}`, //                                               21
    '  cadvisor:', //                                                              22
    `    image: gcr.io/cadvisor/cadvisor@${DIGEST}`, //                            23
    '    volumes:', //                                                             24
    '      - /:/rootfs:ro', //                                                     25
    '      - /var/run:/var/run:ro', //                                             26
    '      - ./config:/etc/cadvisor:ro', //                                        27
    '  debug:', //                                                                 28
    `    image: busybox@${DIGEST}`, //                                             29
    '    privileged: true', //                                                     30
    '',
  ].join('\n'),
  [DOCKERFILE_WORKER]: [
    '# syntax=docker/dockerfile:1.7', //                1
    `FROM node:22.12.0-alpine@${DIGEST} AS builder`, // 2
    'USER node', //                                     3
    'RUN npm ci', //                                    4
    'FROM debian:bookworm-slim', //                     5
    'COPY --from=builder /app /app', //                 6
    '',
  ].join('\n'),
  [DOCKERFILE_API]: [
    `FROM gcr.io/distroless/nodejs22-debian12@${DIGEST}`, // 1
    'USER 65532', //                                        2
    'RUN <<EOF', //                                         3
    'FROM evil:latest', //                                  4
    'USER root', //                                         5
    'EOF', //                                               6
    '',
  ].join('\n'),
  [DOCKERFILE_OPS]: [`FROM alpine@${DIGEST}`, 'USER root', ''].join('\n'),
  [K8S_API]: [
    'apiVersion: apps/v1', //                                                      1
    'kind: Deployment', //                                                         2
    'metadata: { name: api }', //                                                  3
    'spec:', //                                                                    4
    '  template:', //                                                              5
    '    spec:', //                                                                6
    '      containers:', //                                                        7
    '        - name: api', //                                                      8
    `          image: ghcr.io/acme/api@${DIGEST}`, //                              9
    '          securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false }', // 10
    '          resources: { limits: { memory: 512Mi } }', //                       11
    '          readinessProbe: { httpGet: { path: /ready, port: 8080 } }', //      12
    '          livenessProbe: { httpGet: { path: /live, port: 8080 } }', //        13
    '        - name: sidecar', //                                                  14
    `          image: ghcr.io/acme/sidecar@${DIGEST}`, //                          15
    '          resources: { limits: { memory: 64Mi } }', //                        16
    '          readinessProbe: { tcpSocket: { port: 9000 } }', //                  17
    '',
  ].join('\n'),
  [K8S_WORKER]: [
    '# rendered by {{ .Release.Name }} once: a comment, not a template', //    1
    'apiVersion: apps/v1', //                                                   2
    'kind: Deployment', //                                                      3
    'metadata: { name: worker }', //                                            4
    'spec:', //                                                                 5
    '  template:', //                                                           6
    '    spec:', //                                                             7
    '      containers:', //                                                     8
    '        - name: worker', //                                                9
    '          image: ghcr.io/acme/worker:latest', //                           10
    '          env:', //                                                        11
    `            - { name: JWT_SECRET, value: ${SECRET_K8S} }`, //              12
    '            - name: REDIS_PASSWORD', //                                    13
    '              valueFrom: { secretKeyRef: { name: redis, key: password } }', // 14
    '',
  ].join('\n'),
  [K8S_AGENT]: [
    'apiVersion: apps/v1', //                                                         1
    'kind: DaemonSet', //                                                             2
    'metadata: { name: agent }', //                                                   3
    'spec:', //                                                                       4
    '  template:', //                                                                 5
    '    spec:', //                                                                   6
    '      volumes:', //                                                              7
    '        - { name: runtime, hostPath: { path: /run/containerd/containerd.sock } }', // 8
    '      containers:', //                                                           9
    '        - name: agent', //                                                       10
    `          image: ghcr.io/acme/agent@${DIGEST}`, //                               11
    '          securityContext: { privileged: true }', //                             12
    '          resources: { limits: { memory: 128Mi } }', //                          13
    '          readinessProbe: { exec: { command: [true] } }', //                     14
    '          livenessProbe: { exec: { command: [true] } }', //                      15
    '',
  ].join('\n'),
  [K8S_REPORTER]: [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata: { name: reporter }',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: reporter',
    `          image: ghcr.io/acme/reporter@${DIGEST}`,
    '',
  ].join('\n'),
  // The prod overlay deploys the reporter base and patches its guards in; the
  // stray overlay patches a `worker` it never deploys (its resources hold
  // api.yaml only), so the worker base stays claimed (A-10).
  [OVERLAY_PROD]: [
    'resources:',
    '  - ../../base/reporter.yaml',
    ...guardsPatch('reporter'),
    '',
  ].join('\n'),
  [OVERLAY_STRAY]: ['resources:', '  - ../../base/api.yaml', ...guardsPatch('worker'), ''].join(
    '\n',
  ),
  // Each level aliases the previous one ten times: 10^7 nodes from 300 bytes.
  [K8S_BOMB]: [
    'a0: &a0 [x]',
    ...Array.from(
      { length: 7 },
      (_, index) => `a${index + 1}: &a${index + 1} [${Array(10).fill(`*a${index}`).join(', ')}]`,
    ),
    '',
  ].join('\n'),
  [TERRAFORM]: TERRAFORM_TEXT,
  [NATS_CERT]: [
    'authorization {',
    '  users: [',
    '    { user: "CN=api", permissions: { publish: { allow: ["events.>"] } } }',
    '  ]',
    '}',
    '',
  ].join('\n'),
  [NATS_AUTH]: ['authorization {', '  user: $NATS_USER', '  password: $NATS_PASS', '}', ''].join(
    '\n',
  ),
  [NATS_LITERAL_CONF]: [
    'authorization {',
    '  users: [',
    `    { user: "CN=legacy", password: "${NATS_LITERAL}" }`,
    '  ]',
    '}',
    '',
  ].join('\n'),
  [NATS_DEEP]: `${'a {'.repeat(10_000)}${'}'.repeat(10_000)}\n`,
  [NGINX]: [
    'server {', //                                                         1
    '  listen 80;', //                                                     2
    '  add_header X-Frame-Options DENY always;', //                        3
    `  add_header Content-Security-Policy "default-src 'self'" always;`, // 4
    '  location /health {', //                                             5
    '    add_header Content-Type application/json;', //                    6
    `    return 200 '{"ok":true}';`, //                                    7
    '  }', //                                                              8
    '  location /assets/ {', //                                            9
    '    add_header Cache-Control "public, max-age=31536000";', //         10
    '    add_header X-Frame-Options DENY always;', //                      11
    `    add_header Content-Security-Policy "default-src 'self'" always;`, // 12
    '  }', //                                                              13
    '  location / {', //                                                   14
    '    try_files $uri /index.html;', //                                  15
    '  }', //                                                              16
    '}', //                                                                17
    '',
  ].join('\n'),
};

const workspace = makeFixtureTree('aria-infrastructure-policy-');
const write = (path: string, body: string): void => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), body, 'utf8');
};
for (const [path, body] of Object.entries(FILES)) write(path, body);
// The secret premise is gitleaks' own env-secret rule, read from the workspace.
write('.gitleaks.toml', readFileSync(join(REPO_ROOT, '.gitleaks.toml'), 'utf8'));

const ROOTS = [COMPOSE, 'infrastructure'];
const output = analyzeInfrastructurePolicy({ roots: ROOTS }, workspace);

type Finding = (typeof output.findings)[number];
const byPosition = (a: Finding, b: Finding): number =>
  a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path);
const byRule = (rule: string): Finding[] =>
  output.findings.filter((finding) => finding.rule === rule).sort(byPosition);
const claims = (rule: string): [string, number, string][] =>
  byRule(rule).map((finding) => [finding.path, finding.line, finding.owner_rule_id]);
const observation = (id: string): Record<string, unknown> => {
  const found = output.observations.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `missing observation ${id}`);
  return found.details ?? {};
};

// ---------------------------------------------------------- the five claims
assert.deepEqual(
  claims('floating_artifact'),
  [
    [COMPOSE, 16, 'interpolated_default'],
    [COMPOSE, 19, 'floating'],
    [DOCKERFILE_WORKER, 5, 'opaque_tag'],
    [K8S_WORKER, 10, 'floating'],
  ],
  'imagePinVerdict decides: not the ${TAG:?} form, the digests, the builder FROM, or the FROM in a heredoc body',
);
assert.deepEqual(
  claims('privileged_runtime'),
  [
    [COMPOSE, 25, 'docker_socket'],
    [COMPOSE, 26, 'docker_socket'],
    [COMPOSE, 30, 'privileged'],
    [DOCKERFILE_OPS, 2, 'root'],
    [DOCKERFILE_WORKER, 5, 'unset'],
    [K8S_AGENT, 8, 'docker_socket'],
    [K8S_AGENT, 12, 'privileged'],
  ],
  'runtime-privilege decides: the cAdvisor-style / and /var/run binds, the containerd socket ' +
    'hostPath, privileged:true, a final stage that never drops root; not the project bind, the ' +
    'quoted lookalike, USER node in the builder stage or USER root in a heredoc body',
);
assert.deepEqual(
  claims('literal_secret'),
  [
    [COMPOSE, 12, 'aquaculture-env-secret-assignment'],
    [K8S_WORKER, 12, 'aquaculture-env-secret-assignment'],
  ],
  'the gitleaks env-secret rule decides, in files its path allowlist hides: not ${REDIS_PASSWORD}, ' +
    'the change-me placeholder or the secretKeyRef',
);
assert.deepEqual(
  claims('nats_password_identity'),
  [
    [NATS_AUTH, 2, 'interpolated_user'],
    [NATS_AUTH, 3, 'password'],
    [NATS_LITERAL_CONF, 3, 'password'],
  ],
  'nats-identity decides: the certificate-CN config is clean',
);
assert.deepEqual(
  byRule('missing_runtime_guard').map((finding) => [finding.path, finding.line]),
  [
    [K8S_API, 14],
    [K8S_WORKER, 9],
  ],
  'runtime-guards decides: the sidecar lacks a liveness probe, the worker everything; the ' +
    'reporter is guarded by the overlay that deploys it, the worker patch in an overlay that ' +
    'does not deploy it supplies nothing',
);
// The two owners B added (high-012-compare.md section 5, "Also").
assert.deepEqual(
  byRule('security_header_inheritance_drop').map((finding) => [finding.path, finding.line]),
  [[NGINX, 5]],
  '/health drops the CSP and X-Frame-Options; /assets/ re-declares both; / declares nothing',
);
assert.deepEqual(
  claims('unpinned_terraform_source'),
  [
    [TERRAFORM, 1, 'git_branch_ref'],
    [TERRAFORM, 8, 'archive'],
  ],
  'terraform-pins decides: an archive without a checksum is unpinned (landing fix 3)',
);
assert.deepEqual(
  [...new Set(output.findings.map((finding) => finding.rule))].sort(),
  [...PLANNED_RULES, ...ADDED_RULES].sort(),
);

// Every claim names the owner that decided it, as the sibling adapters do.
const OWNER_OF: Readonly<Record<string, string>> = {
  floating_artifact: OWNER.image,
  privileged_runtime: OWNER.privilege,
  literal_secret: OWNER.secret,
  nats_password_identity: OWNER.nats,
  missing_runtime_guard: OWNER.guards,
  security_header_inheritance_drop: OWNER.headers,
  unpinned_terraform_source: OWNER.terraform,
};
for (const finding of output.findings) {
  assert.equal(finding.owner, OWNER_OF[finding.rule], `${finding.id} names its owner`);
}

// The composition is evidence, scoped to the overlay that deploys the base.
assert.equal(
  output.observations.find(
    (candidate) =>
      candidate.id === `${TOOL_ID}:composition:${K8S_REPORTER}#Deployment/reporter/reporter`,
  )?.type,
  'infrastructure_composition',
);
assert.deepEqual(
  output.observations
    .filter((candidate) => candidate.type === 'infrastructure_composition')
    .map((candidate) => candidate.id)
    .filter((id) => id.includes('worker')),
  [],
);

// ------------------------------------------------ text is not a template
// A `{{` in a comment or a healthcheck string is text: both files are read
// by every rule that reads their format, and their claims are above.
for (const path of [COMPOSE, K8S_WORKER]) {
  const details = observation(`${TOOL_ID}:file:${path}`);
  assert.equal(details.parsed, true, `${path} is parsed`);
  assert.equal('excluded' in details, false, `${path} is not excluded as a template`);
}

// ------------------------------------------- credentials and parse failures
const serialised = JSON.stringify(output);
for (const literal of [SECRET_COMPOSE, SECRET_K8S, NATS_LITERAL]) {
  assert.equal(serialised.includes(literal), false, 'a credential is located, never copied');
}
const summary = observation(`${TOOL_ID}:summary`);
assert.deepEqual(
  summary.parse_failure_paths,
  [NATS_DEEP, K8S_BOMB].sort(),
  'the alias bomb and the 10 000-level nesting are named read errors, and the scan goes on',
);
assert.equal(summary.unobserved_files, 0);
for (const path of [K8S_BOMB, NATS_DEEP]) {
  assert.ok(
    output.observations.some(
      (candidate) => candidate.type === 'infrastructure_parse_failure' && candidate.path === path,
    ),
    `${path} carries a parse-failure observation`,
  );
}

// ------------------------------------------------------- evidence contract
for (const finding of output.findings) {
  assert.ok(output.read_paths.includes(finding.path), `${finding.id} cites a read path`);
  assert.ok(finding.evidence.length >= 1);
  for (const ref of finding.evidence) {
    assert.ok(output.read_paths.includes(ref.path), `${finding.id} evidence is a read path`);
  }
  assert.match(finding.fingerprint, /^sha256:[0-9a-f]{64}$/);
}
assert.equal(new Set(output.findings.map((finding) => finding.id)).size, output.findings.length);
for (const path of [...Object.keys(FILES), '.gitleaks.toml']) {
  assert.ok(output.read_paths.includes(path), `${path} was read`);
}
assert.ok(output.evidence_sources.every((source) => output.read_paths.includes(source)));

// The same tree twice gives the same answer; a line shift keeps fingerprints.
assert.deepEqual(analyzeInfrastructurePolicy({ roots: ROOTS }, workspace), output);
write(TERRAFORM, `# shifted\n# shifted\n${TERRAFORM_TEXT}`);
const shifted = analyzeInfrastructurePolicy({ roots: ROOTS }, workspace).findings.filter(
  (finding) => finding.path === TERRAFORM,
);
assert.deepEqual(
  shifted.map((finding) => finding.fingerprint),
  output.findings.filter((finding) => finding.path === TERRAFORM).map((f) => f.fingerprint),
);
assert.deepEqual(
  shifted.map((finding) => finding.line).sort((a, b) => a - b),
  [3, 10],
);

// ---------------------------------------------------------- input contract
assert.throws(() => analyzeInfrastructurePolicy({}, workspace), /roots is required/);
assert.throws(
  () => analyzeInfrastructurePolicy({ roots: ['../escape'] }, workspace),
  /not a contained workspace-relative path/,
);
assert.deepEqual(
  analyzeInfrastructurePolicy(
    { roots: ROOTS, repo_snapshot: { allowed_paths: [TERRAFORM] } },
    workspace,
  ).read_paths,
  [TERRAFORM],
  'a snapshot pins every read to its allowed set',
);

// ======================================================== 4. the real repo
const real = analyzeInfrastructurePolicy({ roots: manifest.default_input.roots }, REPO_ROOT);
const realObservation = (id: string): Record<string, unknown> | undefined =>
  real.observations.find((candidate) => candidate.id === id)?.details;
const realSummary = realObservation(`${TOOL_ID}:summary`) ?? {};
assert.equal(realSummary.authorities_complete, true);
assert.equal(realSummary.unobserved_files, 0);

// Every file the classifier owner calls infrastructure, under a walked root,
// is observed: read and judged, a named parse failure, or an excluded Helm
// template. No floor and no count: the surface is the classifier's.
const underRoots = (path: string): boolean =>
  manifest.default_input.roots.some((root) => path === root || path.startsWith(`${root}/`));
const surface = trackedFiles.filter((path) => underRoots(path) && classifyInfraFile(path) !== null);
assert.ok(surface.length > 0);
assert.deepEqual(
  surface.filter((path) => realObservation(`${TOOL_ID}:file:${path}`) === undefined),
  [],
  'an infrastructure file under the roots without a file observation is a silent skip',
);
for (const failure of real.observations.filter(
  (candidate) => candidate.type === 'infrastructure_parse_failure',
)) {
  assert.ok(real.read_paths.includes(String(failure.path)), `${String(failure.path)} was read`);
}
// A Helm values file whose only `{{` sits in a comment is parsed (A-4).
const valuesCi = realObservation(`${TOOL_ID}:file:infrastructure/helm/aquaculture/values-ci.yaml`);
assert.equal(valuesCi?.parsed, true);
assert.equal(valuesCi !== undefined && 'excluded' in valuesCi, false);

// The production cAdvisor binds / and /var/run: the docker socket is reachable
// from it. The lines come from the owner, the claim must cite each one.
const DROPLET = 'docker-compose.droplet.yml';
const dropletDoc = readYamlDocuments(readFileSync(join(REPO_ROOT, DROPLET), 'utf8')).docs[0];
assert.ok(dropletDoc !== undefined);
const cadvisor = composeServices(dropletDoc.value).find((service) => service.name === 'cadvisor');
assert.ok(cadvisor !== undefined, 'the droplet runs cadvisor');
const socketLines = composeServicePrivilege(cadvisor)
  .filter((hit) => hit.reason === 'docker_socket')
  .map((hit) => dropletDoc.lineOf(hit.path));
assert.ok(socketLines.length >= 2, 'the owner sees the / and /var/run binds');
assert.deepEqual(
  real.findings
    .filter(
      (finding) =>
        finding.rule === 'privileged_runtime' &&
        finding.path === DROPLET &&
        finding.owner_rule_id === 'docker_socket',
    )
    .map((finding) => finding.line)
    .filter((line) => socketLines.includes(line))
    .sort((a, b) => a - b),
  [...socketLines].sort((a, b) => (a ?? 0) - (b ?? 0)),
);

// The repository's password NATS config, claimed hit for hit.
const NATS_ENABLED = 'infrastructure/docker/nats/nats-auth-enabled.conf';
assert.deepEqual(
  real.findings
    .filter((finding) => finding.rule === 'nats_password_identity' && finding.path === NATS_ENABLED)
    .map((finding) => finding.line)
    .sort((a, b) => a - b),
  natsCredentialAuth(readNatsConf(readFileSync(join(REPO_ROOT, NATS_ENABLED), 'utf8')).tree).map(
    (hit) => hit.line,
  ),
);

// The postgres images are governed by .github/manifests/postgres-image.json,
// and the WAL-G derivative's USER root is that manifest's sanctioned exception.
assert.deepEqual(
  real.findings.filter(
    (finding) =>
      finding.rule === 'floating_artifact' && /timescaledb|postgres|pgvector/.test(finding.subject),
  ),
  [],
  'postgres-family images are judged by the postgres image manifest',
);
assert.ok(
  real.observations.some((candidate) => candidate.type === 'infrastructure_sanctioned_root_user'),
  'the sanctioned USER root is recorded',
);
assert.deepEqual(
  real.findings.filter(
    (finding) =>
      finding.rule === 'privileged_runtime' &&
      finding.path === 'infrastructure/docker/Dockerfile.postgres-walg',
  ),
  [],
  'the WAL-G derivative keeps its manifest-sanctioned root user',
);

// ============================ 5. the round-2 review blockers (B1, B2)
// kc/r12-review/REVIEW.txt, on 78d38a761:
//   B1  the adapter passed headerLevels an empty include map (the map lived only in
//       mobile-csp-headers.spec.ts), and an unseen include stopped at its own level, so with
//       aquamobil.conf's /assets/ include removed ARIA claimed nothing, and /health (:48), which
//       drops the whole security set, was neither claimed nor recorded;
//   B2  a Terraform module source went verbatim into the finding subject and message, oauth2
//       token and S3 secret included.
// Each check below runs and its failure is collected, so one run names every contract that is
// still broken instead of stopping at the first.
const blockerFailures: string[] = [];
const check = (name: string, body: () => void): void => {
  try {
    body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    blockerFailures.push(`${name}: ${message.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
};

check('B1 the adapter takes the include map from the header owner', () => {
  assert.ok(importedNames.includes('includedHeadersFrom'), 'it imports includedHeadersFrom');
  assert.equal(
    /includedHeaders\s*:\s*new Map\b/.test(adapterText),
    false,
    'it builds no include map of its own',
  );
});

const SECURITY_INCLUDE = '/etc/nginx/snippets/security-headers.conf';
const SECURITY_SNIPPET = 'infrastructure/docker/nginx/snippets/security-headers.conf';
const AQUAMOBIL = 'infrastructure/docker/nginx/aquamobil.conf';
const aquamobil = readFileSync(join(REPO_ROOT, AQUAMOBIL), 'utf8');
/** `text` with `from` replaced by `to`; the anchor must exist, so a mutation is never vacuous. */
const mutate = (text: string, from: string, to: string): string => {
  assert.ok(text.includes(from), `mutation anchor present: ${JSON.stringify(from)}`);
  return text.replace(from, to);
};
/** The 1-based line of the first line of `text` that contains `needle`. */
const lineOf = (text: string, needle: string): number => {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `${needle} is in the text`);
  return index + 1;
};
const ASSETS_CACHE = '        add_header Cache-Control "public, immutable, max-age=31536000";\n';
const ASSETS_INCLUDE = `        include ${SECURITY_INCLUDE}; # SEC-MEDIUM-052\n`;
const SERVER_INCLUDE = `\n    include ${SECURITY_INCLUDE};\n`;
const withoutAssetsInclude = mutate(aquamobil, `${ASSETS_CACHE}${ASSETS_INCLUDE}`, ASSETS_CACHE);
const withoutBothIncludes = mutate(withoutAssetsInclude, SERVER_INCLUDE, '\n');

const MOBILE = 'infrastructure/docker/nginx/mobile.conf';
const MOBILE_NO_ASSETS = 'infrastructure/docker/nginx/mobile-no-assets-include.conf';
const MOBILE_NO_INCLUDES = 'infrastructure/docker/nginx/mobile-no-includes.conf';
const UNSEEN = 'infrastructure/docker/nginx/unseen-include.conf';
const UNSEEN_TARGET = '/etc/nginx/conf.d/extra-headers.conf';
const TERRAFORM_CREDENTIALS = 'infrastructure/terraform/credentials.tf';
const TF_LITERALS = {
  oauthToken: 'Rt5Wq8Zm3Kx1Vb7N',
  keyId: 'Kid4Ux7Ob1Ea3Ip9',
  keySecret: 'Ms8Tq2Wv5Yz1Ac6D',
  sessionToken: 'Ss3Gh7Jk0Lq4Np8R',
  sshKey: 'U3NoS2V5Rml4dHVyZQ',
  ftpPassword: 'Fp6Xc9Vb2Nm5Qw8E',
};
const BLOCKER_FILES: Readonly<Record<string, string>> = {
  // The snippet sits at its repo path, where the header owner's map says the include comes from.
  [SECURITY_SNIPPET]: readFileSync(join(REPO_ROOT, SECURITY_SNIPPET), 'utf8'),
  [MOBILE]: aquamobil,
  [MOBILE_NO_ASSETS]: withoutAssetsInclude,
  [MOBILE_NO_INCLUDES]: withoutBothIncludes,
  [UNSEEN]: [
    'server {', //                                               1
    `  include ${UNSEEN_TARGET};`, //                            2
    '  location /x/ { add_header Cache-Control "no-store"; }', // 3
    '  location /y/ { try_files $uri =404; }', //                4
    '}', //                                                      5
    '',
  ].join('\n'),
  [TERRAFORM_CREDENTIALS]: [
    `module "oauth" { source = "git::https://oauth2:${TF_LITERALS.oauthToken}@gitlab.example.com/org/net.git" }`, // 1
    'module "s3_keys" {', //                                                                                      2
    `  source = "s3::https://s3.amazonaws.com/bucket/mod.zip?aws_access_key_id=${TF_LITERALS.keyId}&aws_access_key_secret=${TF_LITERALS.keySecret}&aws_access_token=${TF_LITERALS.sessionToken}"`, // 3
    '}', //                                                                                                       4
    `module "ssh_key" { source = "git::ssh://git@example.com/org/m.git?ref=main&sshkey=${TF_LITERALS.sshKey}" }`, // 5
    `module "ftp" { source = "ftp://deploy:${TF_LITERALS.ftpPassword}@mirror.example/vpc.zip" }`, //               6
    '',
  ].join('\n'),
};
const blockerWorkspace = makeFixtureTree('aria-infrastructure-policy-r2-');
for (const [path, body] of Object.entries(BLOCKER_FILES)) {
  mkdirSync(dirname(join(blockerWorkspace, path)), { recursive: true });
  writeFileSync(join(blockerWorkspace, path), body, 'utf8');
}
const blockerOutput = analyzeInfrastructurePolicy({ roots: ['infrastructure'] }, blockerWorkspace);
const headerClaimLines = (path: string): number[] =>
  blockerOutput.findings
    .filter((f) => f.rule === 'security_header_inheritance_drop' && f.path === path)
    .map((f) => f.line)
    .sort((a, b) => a - b);
const unresolvedAt = (
  observations: typeof blockerOutput.observations,
  rule: string,
  path: string,
): Record<string, unknown>[] =>
  observations
    .filter(
      (candidate) =>
        candidate.type === 'infrastructure_unresolved_verdict' &&
        candidate.path === path &&
        candidate.details?.rule === rule,
    )
    .map((candidate) => candidate.details ?? {});

check('B1 aquamobil.conf as committed: only /health (:48) is claimed', () => {
  assert.deepEqual(headerClaimLines(MOBILE), [48]);
});
check('B1 the /assets/ include removed (aquamobil.conf:101): /assets/ is claimed', () => {
  assert.deepEqual(headerClaimLines(MOBILE_NO_ASSETS), [
    48,
    lineOf(withoutAssetsInclude, 'location /assets/'),
  ]);
});
check('B1 the server include and the /assets/ include removed: /assets/ is still claimed', () => {
  assert.deepEqual(headerClaimLines(MOBILE_NO_INCLUDES), [
    lineOf(withoutBothIncludes, 'location /health'),
    lineOf(withoutBothIncludes, 'location /assets/'),
  ]);
});
check('B1 the owner knows the security-headers include: it is never unresolved', () => {
  for (const path of [MOBILE, MOBILE_NO_ASSETS, MOBILE_NO_INCLUDES]) {
    assert.deepEqual(
      unresolvedAt(blockerOutput.observations, 'security_header_inheritance_drop', path).filter(
        (details) => JSON.stringify(details).includes(SECURITY_INCLUDE),
      ),
      [],
      `${path} records the security-headers include as unseen`,
    );
  }
});
check(
  'B1 a location under an unseen include that sets its own header is recorded, not clean',
  () => {
    // /x/ drops whatever the server's unseen include adds: the adapter cannot claim it and must
    // not read it as clean.
    assert.ok(
      unresolvedAt(blockerOutput.observations, 'security_header_inheritance_drop', UNSEEN).some(
        (details) => details.line === 3,
      ),
      'unseen-include.conf /x/ (line 3) is recorded unresolved',
    );
    assert.deepEqual(headerClaimLines(UNSEEN), []);
  },
);

check('B2 no Terraform credential reaches any output', () => {
  const text = JSON.stringify(blockerOutput);
  for (const [name, literal] of Object.entries(TF_LITERALS)) {
    assert.equal(text.includes(literal), false, `the ${name} is in the output`);
  }
});
check('B2 the redacted sources are still claimed and still name where they come from', () => {
  const terraform = blockerOutput.findings
    .filter((f) => f.rule === 'unpinned_terraform_source' && f.path === TERRAFORM_CREDENTIALS)
    .sort((a, b) => a.line - b.line);
  assert.deepEqual(
    terraform.map((f) => [f.line, f.owner_rule_id]),
    [
      [1, 'git_unpinned'],
      [3, 'archive'],
      [5, 'git_branch_ref'],
    ],
  );
  const [oauth, s3, ssh] = terraform;
  assert.ok(oauth?.subject.includes('gitlab.example.com/org/net.git'));
  assert.ok(s3?.subject.includes('s3.amazonaws.com/bucket/mod.zip'));
  assert.ok(ssh?.subject.includes('example.com/org/m.git'));
  assert.ok(
    unresolvedAt(
      blockerOutput.observations,
      'unpinned_terraform_source',
      TERRAFORM_CREDENTIALS,
    ).some((details) => details.line === 6),
    'the ftp source the owner cannot classify is recorded unresolved',
  );
});

// The real repository: aquamobil.conf's /health drops the security set (it sets Content-Type).
check('B1 the real aquamobil.conf /health (:48) is claimed or recorded', () => {
  const claimed = real.findings.some(
    (f) => f.rule === 'security_header_inheritance_drop' && f.path === AQUAMOBIL && f.line === 48,
  );
  const recorded = unresolvedAt(
    real.observations,
    'security_header_inheritance_drop',
    AQUAMOBIL,
  ).some((details) => details.line === 48);
  assert.ok(claimed || recorded, 'aquamobil.conf:48 is neither claimed nor recorded');
});
check('B1 the real aquamobil.conf security-headers include is known, never unresolved', () => {
  assert.deepEqual(
    unresolvedAt(real.observations, 'security_header_inheritance_drop', AQUAMOBIL).filter(
      (details) => JSON.stringify(details).includes(SECURITY_INCLUDE),
    ),
    [],
  );
});
check('B1 a drop the owner sees under an unseen ancestor include stays a claim', () => {
  // droplet.conf includes mime.types at http level (:49); /remotes/dashboard/ drops the CSP and
  // HSTS whatever mime.types adds, so carrying the unseen include down must not silence it.
  assert.ok(
    real.findings.some(
      (f) =>
        f.rule === 'security_header_inheritance_drop' &&
        f.path === 'infrastructure/nginx/droplet.conf' &&
        f.subject === 'location /remotes/dashboard/',
    ),
    'droplet.conf /remotes/dashboard/ is claimed',
  );
});

// ============================ 6. the round-3 review blockers (R1, R2, M2, M4)
// kc/r12r2-review/REVIEW.txt, on 6d28cefab:
//   R1  terraform-pins.ts masked four go-getter argument names, so an S3 presigned URL
//       (X-Amz-Credential, X-Amz-Security-Token, X-Amz-Signature), an Azure SAS `sig=` and a
//       `?token=` reached the finding subject and message verbatim;
//   R2  a reader error quoted the text it failed on (hcl-blocks.ts `unexpected ${token.text}`),
//       and that text became the infrastructure_parse_failure observation;
//   M2  `USER $APP_USER` and compose `user: "${UID}"` read as non_root, so a user the file does
//       not name passed as clean;
//   M4  the guards every overlay patches into a base were unioned, so an overlay supplying the
//       memory limit and a sibling supplying the probes together silenced the base's claim,
//       although each deployment runs without part of its guards.
// The checks are collected with section 5's, so one run names every contract still broken.
const R3_TF_LITERALS = {
  amzCredential: 'Ak2Vq7Lx4Np9Rw3T',
  amzSecurityToken: 'St8Jm1Xc6Bv3Qz5H',
  amzSignature: 'e4c19b7a2d6f03e85c1b9a7d4e2f6c08',
  sasSignature: 'Sv6Fg3Hk8Lp1Zx4C',
  githubToken: 'Gh5Rt2Yu7Io3Pa9S',
  unknownArgument: 'Un4Mb8Vc1Xz6Lk2J',
  privateToken: 'Pv9Hy3Gt6Fr1De8W',
} as const;
const R2_LITERAL = 'Wd3Kp8Zr5Qm1Tx7G';
const M2_SHA = 'f'.repeat(64);
const R3_PRESIGNED = 'infrastructure/terraform/presigned.tf';
const R3_PARSE: Readonly<Record<string, string>> = {
  'infrastructure/terraform/broken.tf': `module "a" {\n  source = "./x"\n}\n"${R2_LITERAL}"\n`,
  'infrastructure/terraform/heredoc.tfvars': `<<EOT\n${R2_LITERAL}\nEOT\n`,
  'infrastructure/docker/nginx/broken.conf': `server {\n  listen 80;\n}\n${R2_LITERAL}\n`,
  'infrastructure/docker/nats/broken.conf': `authorization {\n  password: "${R2_LITERAL}\n}\n`,
  'infrastructure/kubernetes/base/broken.yaml': `apiVersion: v1\nkind: Secret\nstringData:\n  token: *${R2_LITERAL}\n`,
  'infrastructure/simulators/docker-compose.broken.yml': `services:\n  app:\n    environment:\n      DB_PASSWORD: "\\u${R2_LITERAL}"\n`,
  'infrastructure/helm/broken/values.yaml': `auth:\n  password: |${R2_LITERAL}\n    x\n`,
  'infrastructure/docker/Dockerfile.broken': `FROM node:22\n${R2_LITERAL}\n`,
};
const M2_DOCKERFILE = 'infrastructure/docker/Dockerfile.varuser';
const M2_COMPOSE = 'infrastructure/simulators/docker-compose.varuser.yml';
const M4_SPLIT = 'infrastructure/kubernetes/base/split.yaml';
const M4_LONE = 'infrastructure/kubernetes/base/lone.yaml';
const M4_SOLO = 'infrastructure/kubernetes/base/solo.yaml';
const M4_GUARD_LINES = {
  memory_limit: '                resources: { limits: { memory: 256Mi } }',
  readiness_probe: '                readinessProbe: { httpGet: { path: /ready, port: 8080 } }',
  liveness_probe: '                livenessProbe: { httpGet: { path: /live, port: 8080 } }',
} as const;
type M4Guard = keyof typeof M4_GUARD_LINES;
const M4_ALL_GUARDS: readonly M4Guard[] = ['liveness_probe', 'memory_limit', 'readiness_probe'];
/** A kustomization that deploys `base` and patches exactly `guards` into its one container. */
const overlayFor = (base: string, workload: string, guards: readonly M4Guard[]): string =>
  [
    'resources:',
    `  - ../../base/${base}`,
    ...(guards.length === 0
      ? []
      : [...guardsPatch(workload).slice(0, 10), ...guards.map((guard) => M4_GUARD_LINES[guard])]),
    '',
  ].join('\n');
/** A Deployment of one container that carries no guard of its own. */
const unguardedBase = (workload: string): string =>
  [
    'apiVersion: apps/v1', //                                     1
    'kind: Deployment', //                                        2
    `metadata: { name: ${workload} }`, //                         3
    'spec:', //                                                   4
    '  template:', //                                             5
    '    spec:', //                                               6
    '      containers:', //                                       7
    `        - name: ${workload}`, //                             8
    `          image: ghcr.io/acme/${workload}@${DIGEST}`, //     9
    '',
  ].join('\n');
const M4_CONTAINER_LINE = 8;
const ROUND3_FILES: Readonly<Record<string, string>> = {
  [R3_PRESIGNED]: [
    `module "presigned" { source = "https://bucket.s3.amazonaws.com/mod.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${R3_TF_LITERALS.amzCredential}%2F20261022%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Expires=3600&X-Amz-Security-Token=${R3_TF_LITERALS.amzSecurityToken}&X-Amz-Signature=${R3_TF_LITERALS.amzSignature}" }`, // 1
    `module "sas" { source = "https://acct.blob.core.windows.net/c/mod.zip?sv=2022-11-02&sr=b&sig=${R3_TF_LITERALS.sasSignature}" }`, // 2
    `module "github_raw" { source = "https://raw.githubusercontent.com/org/r/main/mod.zip?token=${R3_TF_LITERALS.githubToken}" }`, // 3
    `module "unknown_argument" { source = "https://mirror.example/mod.zip?p=${R3_TF_LITERALS.unknownArgument}" }`, // 4
    `module "git_token" { source = "git::https://gitlab.example.com/org/net.git?ref=main&depth=1&private_token=${R3_TF_LITERALS.privateToken}" }`, // 5
    '',
  ].join('\n'),
  ...R3_PARSE,
  [M2_DOCKERFILE]: [`FROM node:22@sha256:${M2_SHA}`, 'ARG APP_USER', 'USER $APP_USER', ''].join(
    '\n',
  ),
  [M2_COMPOSE]: [
    'services:', //                                  1
    '  app:', //                                     2
    `    image: busybox@${DIGEST}`, //               3
    '    user: "${UID}:${GID}"', //                  4
    '',
  ].join('\n'),
  // split.yaml is deployed by two overlays: one patches in only the memory limit, the other only
  // the probes. Neither deployment runs with all three guards.
  [M4_SPLIT]: unguardedBase('split'),
  'infrastructure/kubernetes/overlays/split-memory/kustomization.yaml': overlayFor(
    'split.yaml',
    'split',
    ['memory_limit'],
  ),
  'infrastructure/kubernetes/overlays/split-probes/kustomization.yaml': overlayFor(
    'split.yaml',
    'split',
    ['readiness_probe', 'liveness_probe'],
  ),
  // lone.yaml is deployed by an overlay that supplies every guard and by one that supplies none.
  [M4_LONE]: unguardedBase('lone'),
  'infrastructure/kubernetes/overlays/lone-full/kustomization.yaml': overlayFor(
    'lone.yaml',
    'lone',
    M4_ALL_GUARDS,
  ),
  'infrastructure/kubernetes/overlays/lone-bare/kustomization.yaml': overlayFor(
    'lone.yaml',
    'lone',
    [],
  ),
  // The twin: solo.yaml is deployed only by an overlay that supplies every guard.
  [M4_SOLO]: unguardedBase('solo'),
  'infrastructure/kubernetes/overlays/solo-full/kustomization.yaml': overlayFor(
    'solo.yaml',
    'solo',
    M4_ALL_GUARDS,
  ),
};
const round3Workspace = makeFixtureTree('aria-infrastructure-policy-r3-');
for (const [path, body] of Object.entries(ROUND3_FILES)) {
  mkdirSync(dirname(join(round3Workspace, path)), { recursive: true });
  writeFileSync(join(round3Workspace, path), body, 'utf8');
}
const round3Output = analyzeInfrastructurePolicy({ roots: ['infrastructure'] }, round3Workspace);
/** The four-character windows of `literal` (case folded) that `text` contains. */
const windowsOf = (text: string, literal: string): string[] => {
  const folded = text.toLowerCase();
  const found: string[] = [];
  for (let i = 0; i + 4 <= literal.length; i += 1) {
    const window = literal.slice(i, i + 4).toLowerCase();
    if (folded.includes(window)) found.push(window);
  }
  return found;
};

check('R1 no presigned, SAS, token or unknown query value reaches any output', () => {
  const text = JSON.stringify(round3Output);
  assert.deepEqual(
    Object.entries(R3_TF_LITERALS)
      .filter(([, literal]) => windowsOf(text, literal).length > 0)
      .map(([name]) => name),
    [],
  );
});
check('R1 the masked sources are still claimed and keep their host and allow-listed ref', () => {
  const terraform = round3Output.findings
    .filter((f) => f.rule === 'unpinned_terraform_source' && f.path === R3_PRESIGNED)
    .sort((a, b) => a.line - b.line);
  assert.deepEqual(
    terraform.map((f) => [f.line, f.owner_rule_id]),
    [
      [1, 'archive'],
      [2, 'archive'],
      [3, 'archive'],
      [4, 'archive'],
      [5, 'git_branch_ref'],
    ],
  );
  const [presigned, sas, github, unknown, gitToken] = terraform;
  assert.ok(presigned?.subject.includes('bucket.s3.amazonaws.com/mod.zip'));
  assert.ok(sas?.subject.includes('acct.blob.core.windows.net/c/mod.zip'));
  assert.ok(github?.subject.includes('raw.githubusercontent.com/org/r/main/mod.zip'));
  assert.ok(unknown?.subject.includes('mirror.example/mod.zip'));
  assert.ok(gitToken?.subject.includes('gitlab.example.com/org/net.git'));
  assert.ok(gitToken?.subject.includes('ref=main'), 'ref is an allow-listed argument');
  assert.ok(gitToken?.subject.includes('depth=1'), 'depth is an allow-listed argument');
});

check('R2 every malformed file is a named parse failure', () => {
  assert.deepEqual(
    Object.keys(R3_PARSE).filter(
      (path) =>
        !round3Output.observations.some(
          (candidate) =>
            candidate.type === 'infrastructure_parse_failure' && candidate.path === path,
        ),
    ),
    [],
  );
});
check('R2 no parse failure carries any part of the text its reader failed on', () => {
  const leaking = round3Output.observations
    .filter((candidate) => candidate.type === 'infrastructure_parse_failure')
    .filter((candidate) => windowsOf(JSON.stringify(candidate), R2_LITERAL).length > 0)
    .map((candidate) => String(candidate.path))
    .sort();
  assert.deepEqual(leaking, []);
  assert.equal(JSON.stringify(round3Output).includes(R2_LITERAL), false, 'the literal is output');
});

/** The privileged_runtime claims and unresolved records at `path`:`line`. */
const userVerdictsAt = (path: string, line: number): { claimed: number; unresolved: number } => ({
  claimed: round3Output.findings.filter(
    (f) => f.rule === 'privileged_runtime' && f.path === path && f.line === line,
  ).length,
  unresolved: unresolvedAt(round3Output.observations, 'privileged_runtime', path).filter(
    (details) => details.line === line,
  ).length,
});
check('M2 a Dockerfile USER named by a variable is recorded unresolved, never clean', () => {
  assert.deepEqual(userVerdictsAt(M2_DOCKERFILE, 3), { claimed: 0, unresolved: 1 });
});
check('M2 a compose user named by a variable is recorded unresolved, never clean', () => {
  assert.deepEqual(userVerdictsAt(M2_COMPOSE, 4), { claimed: 0, unresolved: 1 });
});

/** The guards named by the missing_runtime_guard claims on a base's one container. */
const claimedGuards = (path: string): string[] => [
  ...new Set(
    round3Output.findings
      .filter(
        (f) =>
          f.rule === 'missing_runtime_guard' && f.path === path && f.line === M4_CONTAINER_LINE,
      )
      .flatMap((f) => f.owner_rule_id.split(',')),
  ),
];
check('M4 guards split across sibling overlays do not silence the base claim', () => {
  // The memory overlay's deployment runs without probes, the probe overlay's without a memory
  // limit: every guard is missing from some deployment of split.yaml.
  assert.deepEqual(claimedGuards(M4_SPLIT).sort(), [...M4_ALL_GUARDS]);
});
check('M4 an overlay that supplies every guard does not cover a sibling that supplies none', () => {
  assert.deepEqual(claimedGuards(M4_LONE).sort(), [...M4_ALL_GUARDS]);
});
check('M4 the twin: a base whose only overlay supplies every guard is not claimed', () => {
  assert.deepEqual(claimedGuards(M4_SOLO), []);
});

// ======================== 7. the round-4 review blocker (R1 residual)
// kc/r12r3-review/REVIEW.txt, on e7e14ff83: terraform-pins.ts still derives the reported source
// by masking the written address, the third round in which that leaked by a new path:
//   (a) the last `@` of the whole address is taken before the query and fragment are split, so
//       a GCS V2 signed URL's GoogleAccessId=sa@... swallows the `?` and Signature= is output,
//       and so are ?password=pre@X, ?token=a@X and #x@X;
//   (b) an allow-listed argument keeps whatever value it holds: checksum=file:<presigned URL>,
//       ref=x?token=X, ref=v1;token=X;
//   (c) a scheme-less user without `:` is kept for any user: ghp_X@github.com/org/x.git.
// The corpus (tools/gates/infra-policy/terraform-source-probes.ts) plants a distinct marker in
// every position of a module source under every go-getter forced prefix; the owner spec holds
// the same corpus. Round 5 (kc/r12r4-review, R1 residual-2) adds authorityProbes: a userinfo
// user whose `@` is percent-encoded or an HCL escape, or a user:password with no host, reached
// the finding subject and message as the host (05-probe-leak.log probes 1, 2, 3, 17).
const R4_PROBES = 'infrastructure/terraform/probes.tf';
const R4_READABLE = 'infrastructure/terraform/readable.tf';
const R4_TOKEN = 'Hx4Qw8Zk2Jv6Nm9T';
const round4Probes = [...terraformSourceProbes(), ...reviewerProbes(), ...authorityProbes()];
const ROUND4_FILES: Readonly<Record<string, string>> = {
  [R4_PROBES]: probesAsTerraform(round4Probes),
  [R4_READABLE]: [
    `module "git_https" { source = "git::https://ghp_${R4_TOKEN}@github.com/org/net.git?ref=main&depth=1&private_token=${R4_TOKEN}" }`, // 1
    'module "scp" { source = "git@github.com:org/m.git?ref=main" }', // 2
    '',
  ].join('\n'),
};
const round4Workspace = makeFixtureTree('aria-infrastructure-policy-r4-');
for (const [path, body] of Object.entries(ROUND4_FILES)) {
  mkdirSync(dirname(join(round4Workspace, path)), { recursive: true });
  writeFileSync(join(round4Workspace, path), body, 'utf8');
}
const round4Output = analyzeInfrastructurePolicy({ roots: ['infrastructure'] }, round4Workspace);

check('R1r no part of a marker planted in any source position reaches any output', () => {
  const text = JSON.stringify(round4Output);
  const leaking = round4Probes
    .filter((probe) => windowsOf(text, probe.marker).length > 0)
    .map((probe) => probe.name);
  assert.deepEqual(leaking, [], `${leaking.length} probes leak a part of their marker`);
  assert.deepEqual(windowsOf(text, R4_TOKEN), [], 'the readable.tf token is output');
});
check(
  'R1r every probe keeps its claim: unpinned claimed with its verdict, unresolved recorded, pinned silent',
  () => {
    // The verdict is judged on the parsed source, so rebuilding the reported form moves no claim.
    const moved: string[] = [];
    round4Probes.forEach((probe, index) => {
      const line = index + 1;
      const claims = round4Output.findings
        .filter(
          (f) => f.rule === 'unpinned_terraform_source' && f.path === R4_PROBES && f.line === line,
        )
        .map((f) => f.owner_rule_id);
      const recorded = unresolvedAt(
        round4Output.observations,
        'unpinned_terraform_source',
        R4_PROBES,
      ).some((details) => details.line === line);
      const pinning = MODULE_SOURCE_PINNING[probe.verdict];
      const expected =
        pinning === 'unpinned'
          ? { claims: [probe.verdict], recorded: false }
          : { claims: [], recorded: pinning === 'unresolved' };
      if (JSON.stringify({ claims, recorded }) !== JSON.stringify(expected)) {
        moved.push(`${probe.name} (line ${line}): ${JSON.stringify({ claims, recorded })}`);
      }
    });
    assert.deepEqual(moved, []);
  },
);
check('R1r a claim names the host, path, ref and depth, and no user', () => {
  const subjectAt = (line: number): string => {
    const claim = round4Output.findings.find(
      (f) => f.rule === 'unpinned_terraform_source' && f.path === R4_READABLE && f.line === line,
    );
    assert.ok(claim, `readable.tf:${line} is claimed`);
    return claim.subject;
  };
  const gitHttps = subjectAt(1);
  for (const part of ['github.com', 'org/net.git', 'ref=main', 'depth=1']) {
    assert.ok(gitHttps.includes(part), `${part} is readable in ${JSON.stringify(gitHttps)}`);
  }
  assert.equal(gitHttps.includes('ghp_'), false, `no user in ${gitHttps}`);
  const scp = subjectAt(2);
  for (const part of ['github.com', 'org/m.git', 'ref=main']) {
    assert.ok(scp.includes(part), `${part} is readable in ${JSON.stringify(scp)}`);
  }
  assert.equal(scp.includes('git@'), false, `the scp login is userinfo, not reported: ${scp}`);
});
check('R1r the Terraform finding subject and message take only the reported-source type', () => {
  // WHY (tier 1): the adapter prints a Terraform source only through terraform-pins.ts's
  // reported-source type, so passing the written address, or a template that embeds it, to the
  // finding's subject or message is a compile error. Read with the type checker on the adapter:
  // at every call that emits unpinned_terraform_source, a plain string is not assignable to the
  // argument given for the `subject` or the `message` parameter.
  const program = ts.createProgram([ADAPTER_SOURCE], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    types: ['node'],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ADAPTER_SOURCE);
  assert.ok(source, 'the adapter is in the program');
  const emits: ts.CallExpression[] = [];
  const findEmits = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) !== 'recordUnresolved' &&
      node.arguments.some((arg) => arg.getText(source) === 'RULES.unpinned_terraform_source')
    ) {
      emits.push(node);
    }
    ts.forEachChild(node, findEmits);
  };
  findEmits(source);
  assert.ok(emits.length > 0, 'the adapter emits unpinned_terraform_source');
  const stringType = checker.getStringType();
  const accepting: string[] = [];
  for (const call of emits) {
    const signature = checker.getResolvedSignature(call);
    assert.ok(signature, `${call.expression.getText(source)} resolves to a signature`);
    const names = signature.getParameters().map((parameter) => parameter.name);
    for (const name of ['subject', 'message']) {
      const index = names.indexOf(name);
      const argument = index < 0 ? undefined : call.arguments[index];
      if (argument === undefined) {
        accepting.push(`${call.expression.getText(source)} has no ${name} argument`);
        continue;
      }
      const type = checker.getTypeAtLocation(argument);
      if (checker.isTypeAssignableTo(stringType, type)) {
        accepting.push(
          `${name} is ${checker.typeToString(type)}: ${argument.getText(source).slice(0, 80)}`,
        );
      }
    }
  }
  assert.deepEqual(accepting, []);
});

// ======== 8. DET scope-3 (ledger B15): the scan surface is what the classifier says
// build/DET-RCA/scope.md B15. The surface is hand lists (declared_scope, default_input.roots,
// allowed_read_globs) that nothing ties to classifyInfraFile, so the next service Dockerfile or
// non-root compose file outside the roots is read by no one and missed by no one, and a root a
// checkout lacks is a crash (tool quarantined) instead of an observation. Latent today: every
// tracked classified file sits under a root. Red at the base: the seven source directories are no
// roots, an absent root throws, and the invariant names templates/NOTES.txt (a Helm template that
// no declared_scope glob names). Green at the base on purpose: the near-miss negatives that
// guard the fix, and the invariant's self-test (its predicate lives here, so it cannot be red).
const NEW_ROOTS = ['apps', 'libs', 'platform', 'web', 'e2e', 'sens-api-gateway', 'scripts'];
const FIXTURES = 'tools/aria-adapters/fixtures/';

// The kernel's own glob matcher, through the `python3 -I -S` bridge shape of kernel-owners.ts:
// no second glob grammar (braces and `**` are the kernel's).
const GLOB_BRIDGE = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from aria_kernel.canonical_path import matches_repo_glob',
  'ask = json.load(sys.stdin)',
  'json.dump([p for p in ask["paths"] if not any(matches_repo_glob(p, g) for g in ask["globs"])], sys.stdout)',
].join('\n');
const outsideGlobs = (paths: readonly string[], globs: readonly string[]): string[] =>
  JSON.parse(
    execFileSync('python3', ['-I', '-S', '-c', GLOB_BRIDGE, join(REPO_ROOT, 'aria-kernel')], {
      encoding: 'utf8',
      input: JSON.stringify({ paths, globs }),
    }),
  ) as string[];
/** The invariant: what the classifier calls infrastructure (fixtures aside) is under a default
 * root, declared and readable in the adapter room. Returns the paths that are not. */
const scopeGaps = (paths: readonly string[]): string[] => {
  const infra = paths.filter((p) => classifyInfraFile(p) !== null && !p.startsWith(FIXTURES));
  return [
    ...new Set([
      ...infra.filter((p) => !underRoots(p)),
      ...outsideGlobs(infra, manifest.declared_scope),
      ...outsideGlobs(infra, manifest.allowed_read_globs),
    ]),
  ].sort();
};

check('B15 invariant: every tracked infrastructure file is under a root and declared', () => {
  assert.deepEqual(scopeGaps(trackedFiles), []);
});
check('B15 invariant self-test: a classified file in an unlisted directory is a gap', () => {
  const gaps = ['ops/docker-compose.yml', 'ops/svc/Dockerfile'];
  const fine = ['ops/README.md', 'ops/config.yml', `${FIXTURES}cases/Dockerfile.unread`];
  for (const path of gaps) assert.notEqual(classifyInfraFile(path), null, path);
  assert.deepEqual(scopeGaps([...gaps, ...fine]), gaps);
});
check('B15 scope: Dockerfiles and compose files under the new roots are in', () => {
  const names = [
    'Dockerfile',
    'deep/er/Dockerfile.prod',
    'api.Dockerfile',
    'docker-compose.dev.yml',
  ];
  const paths = NEW_ROOTS.flatMap((root) =>
    [...names, 'compose.yaml'].map((n) => `${root}/svc/${n}`),
  );
  for (const path of paths) assert.notEqual(classifyInfraFile(path), null, path);
  assert.deepEqual([...new Set(scopeGaps(paths).map((p) => p.split('/')[0]))], []);
});
check('B15 near-miss: sources, docs and plain config under the new roots stay undeclared', () => {
  // A broad `*.{yml,yaml,conf}` would make the kernel's observation map call unread app config observed.
  const plain = ['apps/x/src/compose.ts', 'apps/x/docs/compose-notes.md', 'apps/x/application.yml'];
  plain.push(
    'libs/x/README.md',
    'web/shell/config.yaml',
    'e2e/tests/compose.spec.ts',
    'scripts/ci/build.sh',
  );
  for (const path of plain) assert.equal(classifyInfraFile(path), null, path);
  assert.deepEqual(outsideGlobs(plain, manifest.declared_scope), plain);
  assert.deepEqual(outsideGlobs(plain, manifest.allowed_read_globs), plain);
});

// The adapter on a synthetic checkout with the PRODUCTION roots, every one materialised and clean,
// so a throw or an unread file is the manifest's doing, not the fixture's.
const writeAt = (base: string, path: string, body: string): void => {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), body, 'utf8');
};
const materialiseRoots = (base: string, absent: readonly string[] = []): void => {
  for (const root of manifest.default_input.roots.filter((r) => !absent.includes(r))) {
    const format = classifyInfraFile(root);
    if (format === 'dockerfile') writeAt(base, root, `FROM alpine@${DIGEST}\nUSER 65532\n`);
    else if (format === 'compose')
      writeAt(base, root, `services:\n  s:\n    image: redis@${DIGEST}\n`);
    else mkdirSync(join(base, root), { recursive: true });
  }
};
const lazy = <T>(body: () => T): (() => T) => {
  let cached: { readonly value: T } | undefined;
  return () => (cached ??= { value: body() }).value;
};
const asClaim = (f: Finding): string => `${f.rule} ${f.path}:${f.line} ${f.owner_rule_id}`;
const composePrivileged = `services:\n  s:\n    image: redis@${DIGEST}\n    privileged: true\n`;
const READ_AND_CLAIMED: Readonly<Record<string, string>> = {
  'apps/farm-service/Dockerfile': 'FROM node:latest\nRUN npm ci\n',
  'apps/sensor-ingestion/Dockerfile': 'FROM node:latest\nRUN npm ci\n', // a file root today
  'apps/x/docker-compose.dev.yml': composePrivileged,
  'web/shell/Dockerfile': 'FROM nginx:latest\n',
  'apps/clean/Dockerfile': `FROM node:22.12.0-alpine@${DIGEST}\nUSER 65532\n`, // pinned, non-root
};
const UNREAD: Readonly<Record<string, string>> = {
  'apps/x/Dockerfile.dockerignore': 'node_modules\nFROM node:latest\n',
  'apps/x/docs/compose-notes.md': 'services:\n  s:\n    privileged: true\n',
  'apps/x/src/compose.ts': 'export const compose = { privileged: true };\n',
  [`${FIXTURES}infrastructure-policy-adapter/cases/Dockerfile.bad`]: 'FROM node:latest\n',
  'ops/docker-compose.yml': composePrivileged, // a directory no root names
};
const b15Workspace = makeFixtureTree('aria-infrastructure-policy-b15-');
materialiseRoots(b15Workspace);
for (const [path, body] of Object.entries({ ...READ_AND_CLAIMED, ...UNREAD })) {
  writeAt(b15Workspace, path, body);
}
const b15Run = lazy(() =>
  analyzeInfrastructurePolicy({ roots: manifest.default_input.roots }, b15Workspace),
);

check('B15 a service Dockerfile and a non-root compose file are read and claimed', () => {
  const out = b15Run();
  assert.deepEqual(out.findings.map(asClaim).sort(), [
    'floating_artifact apps/farm-service/Dockerfile:1 floating',
    'floating_artifact apps/sensor-ingestion/Dockerfile:1 floating',
    'floating_artifact web/shell/Dockerfile:1 floating',
    'privileged_runtime apps/farm-service/Dockerfile:1 unset',
    'privileged_runtime apps/sensor-ingestion/Dockerfile:1 unset',
    'privileged_runtime apps/x/docker-compose.dev.yml:4 privileged',
    'privileged_runtime web/shell/Dockerfile:1 unset',
  ]);
  for (const path of Object.keys(READ_AND_CLAIMED)) {
    assert.ok(out.read_paths.includes(path), `${path} was read`);
    assert.ok(
      out.observations.some((o) => o.id === `${TOOL_ID}:file:${path}`),
      `${path} observed`,
    );
  }
});
check('B15 near-miss: rejected names, fixtures and an unlisted directory are not read', () => {
  const out = b15Run();
  for (const path of Object.keys(UNREAD)) {
    assert.equal(out.read_paths.includes(path), false, `${path} was read`);
    assert.equal(
      out.observations.some((o) => o.path === path),
      false,
      `${path} is observed`,
    );
    assert.equal(
      out.findings.some((f) => f.path === path),
      false,
      `${path} is claimed`,
    );
  }
});
check('B15 near-miss: a file under two roots is one observation and one claim', () => {
  // apps/sensor-ingestion/Dockerfile is a root of its own today and, under apps/, a second one.
  const ids = [...b15Run().findings, ...b15Run().observations].map((entry) => entry.id);
  assert.deepEqual(
    ids.filter((id, index) => ids.indexOf(id) !== index),
    [],
  );
});

// A declared root the checkout does not hold: the hand list outlives a directory.
const ABSENT = ['deploy', 'docker-compose.watch.yml'];
const absentWorkspace = makeFixtureTree('aria-infrastructure-policy-b15-absent-');
materialiseRoots(absentWorkspace, ABSENT);
writeAt(absentWorkspace, 'infrastructure/docker/Dockerfile.api', 'FROM node:latest\nUSER node\n');
const absentRun = lazy(() =>
  analyzeInfrastructurePolicy({ roots: manifest.default_input.roots }, absentWorkspace),
);
check('B15 a declared root the workspace lacks is an observation, not a throw', () => {
  for (const root of ABSENT) assert.ok(manifest.default_input.roots.includes(root), root);
  // The type is the contract; `path` or `details.root` may name the root. A present root,
  // empty or not, is never named, and the scan goes on past the absent ones.
  const named = absentRun()
    .observations.filter((o) => o.type === 'infrastructure_root_absent')
    .map((o) => (typeof o.path === 'string' ? o.path : String(o.details?.root)));
  assert.deepEqual(named.sort(), [...ABSENT].sort());
  assert.deepEqual(absentRun().findings.map(asClaim), [
    'floating_artifact infrastructure/docker/Dockerfile.api:1 floating',
  ]);
});
check('B15 near-miss: a refused root and a root that is no infrastructure file still throw', () => {
  const refused = makeFixtureTree('aria-infrastructure-policy-b15-refused-');
  writeAt(refused, 'README.md', '# not infrastructure\n');
  mkdirSync(join(refused, 'real'));
  symlinkSync(join(refused, 'real'), join(refused, 'linked'));
  const run = (root: string) => (): unknown =>
    analyzeInfrastructurePolicy({ roots: [root] }, refused);
  assert.throws(run('README.md'), /not an infrastructure file/);
  assert.throws(run('linked'), /not a contained workspace-relative path/);
});

assert.deepEqual(
  blockerFailures,
  [],
  'the round-2 (B1, B2), round-3 (R1, R2, M2, M4), round-4 (R1 residual) review blockers are ' +
    'fixed and the DET scope-3 (B15) scope contract holds',
);

process.stdout.write('infrastructure-policy-adapter.test.ts OK\n');
