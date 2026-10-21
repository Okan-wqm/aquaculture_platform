import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

import { makeFixtureTree } from '../gates/fixture-tree';
import { natsCredentialAuth } from '../gates/infra-policy/nats-identity';
import { composeServicePrivilege } from '../gates/infra-policy/runtime-privilege';
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
  manifest.declared_scope.filter((glob) => /compose/.test(glob) && /[*?[{]/.test(glob)),
  [],
  'a compose glob at the root has no root to sit under: both scope gates refuse it (A-3)',
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

process.stdout.write('infrastructure-policy-adapter.test.ts OK\n');
