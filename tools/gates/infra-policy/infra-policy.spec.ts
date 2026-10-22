#!/usr/bin/env ts-node
/**
 * Infrastructure readers (tools/gates/lib/infra) and rule owners (tools/gates/infra-policy).
 *
 * WHY this spec exists (ARIA-HIGH-012): every infrastructure rule the repository had was
 * welded inside one jest spec and applied to one hard-coded file, so ARIA's
 * infrastructure-policy adapter could only copy them — a second owner per rule. The rules
 * now live here once; ci-image-registry, mobile-csp-headers and the e2e NATS invariants
 * call them, and the adapter will too.
 *
 * WHAT it pins: each reader on its parser traps (multi-document YAML with anchors and merge
 * keys, Dockerfile continuations / escape directive / heredocs / ARG in FROM / stage
 * references, HCL heredocs and comment braces, nginx and NATS comment and quote handling),
 * each rule owner on paired positive and negative inputs, and every reader on every tracked
 * file of its format (zero read errors), so a reader that stops understanding the real
 * corpus fails here instead of silently dropping files.
 *
 * Runner: node:test under ts-node (tools/gates/run-all.mjs walks tools/gates recursively).
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';
import { Alias } from 'yaml';

import { classifyInfraFile, INFRA_FORMATS, type InfraFormat } from '../lib/infra/classify';
import { readDockerfile } from '../lib/infra/dockerfile';
import { readHclBlocks } from '../lib/infra/hcl-blocks';
import { readNatsConf } from '../lib/infra/nats-conf';
import { readNginx } from '../lib/infra/nginx-conf';
import type { ReadError } from '../lib/infra/read-error';
import { readInfraFile } from '../lib/infra/read-infra-file';
import {
  composeBuildDockerfile,
  composeEnvironment,
  composeServices,
  containerEnv,
  k8sWorkloads,
  kustomizePatchTargets,
  podContainers,
} from '../lib/infra/workloads';
import { readYamlDocuments, type YamlPath } from '../lib/infra/yaml-documents';
import { REPO_ROOT } from '../lib/repo-root';

import { imagePinVerdict, parseImageReference, PIN_MUTABILITY } from './image-reference';
import { natsCredentialAuth } from './nats-identity';
import { addHeaderNames, headerInheritanceDrops, headerLevels } from './nginx-header-inheritance';
import * as headerOwner from './nginx-header-inheritance';
import { composeGuards, podGuards } from './runtime-guards';
import {
  composeServicePrivilege,
  composeServiceUser,
  dockerfileFinalUser,
  podContainerUser,
  podSpecPrivilege,
} from './runtime-privilege';
import {
  ENV_SECRET_RULE_ID,
  gitleaksPatterns,
  loadEnvSecretRule,
  secretsHiddenByPathAllowlist,
  type StructuredEnvEntry,
  translateRe2,
} from './secret-allowlist-premise';
import { MODULE_SOURCE_PINNING, moduleSourcePin, providerConstraints } from './terraform-pins';
import {
  authorityProbes,
  CHECKSUM_HEX,
  FORCED_PREFIXES,
  markerWindows,
  probesAsTerraform,
  reviewerProbes,
  terraformSourceProbes,
  type TerraformSourceProbe,
} from './terraform-source-probes';

function repoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/**
 * The windows of `literal` (four characters, case folded) found in `text`. A parse error that
 * upper-cases a Dockerfile keyword, or a YAML escape error that quotes four characters of a
 * scalar, still hands part of a credential on; a whole-string match would miss both.
 */
function credentialWindowsIn(text: string, literal: string): string[] {
  const folded = text.toLowerCase();
  const found: string[] = [];
  for (let i = 0; i + 4 <= literal.length; i += 1) {
    const window = literal.slice(i, i + 4).toLowerCase();
    if (folded.includes(window)) found.push(window);
  }
  return found;
}

/**
 * An export of nginx-header-inheritance.ts that the B1 fix adds. Looked up by name so the spec
 * compiles before the export exists and the case fails on its absence, not on a type error.
 */
function headerOwnerExport(name: string): unknown {
  const found = Object.entries(headerOwner).find(([key]) => key === name);
  assert.ok(found !== undefined, `nginx-header-inheritance.ts exports ${name}`);
  return found[1];
}

/** The item at `index`; a missing item fails the test here instead of as a TypeError later. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `no item at index ${index}`);
  return item;
}

function present<T>(value: T | null | undefined, what: string): T {
  assert.ok(value !== null && value !== undefined, `${what} is absent`);
  return value;
}

function trackedFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((p) => p.length > 0);
}

// ---------------------------------------------------------------- classify

void test('classifyInfraFile decides the format by basename and path segment', () => {
  const table: Array<[string, string | null]> = [
    ['Dockerfile.agent-tooling', 'dockerfile'],
    ['apps/sensor-ingestion/Dockerfile', 'dockerfile'],
    ['infrastructure/docker/Dockerfile.backend.dev', 'dockerfile'],
    ['web/app.Dockerfile', 'dockerfile'],
    ['infrastructure/docker/Dockerfile.dockerignore', null],
    ['docker-compose.droplet.yml', 'compose'],
    ['infrastructure/simulators/docker-compose.simulators.yml', 'compose'],
    ['compose.yaml', 'compose'],
    ['infrastructure/deploy/postgres-dr-bootstrap-rollback.override.yml', 'compose'],
    ['infrastructure/helm/aquaculture/templates/secrets.yaml', 'helm_template'],
    ['infrastructure/helm/aquaculture/templates/NOTES.txt', 'helm_template'],
    ['infra/helm/charts/aquaculture-platform/templates/_helpers.tpl', 'helm_template'],
    ['infrastructure/helm/aquaculture/Chart.yaml', 'helm_chart'],
    ['infrastructure/helm/aquaculture/values-production.yaml', 'helm_values'],
    ['infra/kubernetes/data/kafka/values.yaml', 'helm_values'],
    ['infrastructure/monitoring/loki/loki-values.yaml', 'helm_values'],
    ['infrastructure/helm/aquaculture/files/nats-service-identities.yaml', null],
    ['infrastructure/kubernetes/base/auth-service.yaml', 'k8s'],
    ['deploy/production/kustomization.yaml', 'k8s'],
    ['deploy/production/secret.yaml.template', 'k8s'],
    ['infra/argocd/projects/aquaculture-platform.yaml', 'k8s'],
    ['infrastructure/terraform/modules/staging-droplet/main.tf', 'terraform'],
    ['infra/terraform/environments/prod/terraform.tfvars', 'terraform'],
    ['infrastructure/nginx/droplet.conf', 'nginx'],
    ['infrastructure/docker/nginx/default.conf.template', 'nginx'],
    ['nginx/nginx.conf', 'nginx'],
    ['infrastructure/docker/nats/nats-auth-enabled.conf', 'nats'],
    ['infrastructure/docker/redis/redis.conf', null],
    ['infrastructure/nats/services.yaml', null],
    ['infrastructure/monitoring/droplet/prometheus.yml', null],
    ['tests/invariants/nginx-route-resolution.spec.ts', null],
  ];
  for (const [path, format] of table) {
    assert.equal(classifyInfraFile(path), format, path);
  }
});

// ---------------------------------------------------------------- YAML

void test('readYamlDocuments: multi-document, anchors, merge keys, positions, errors', () => {
  const text = [
    'x-limits: &limits', //                     1
    '  mem_limit: 512m', //                     2
    'services:', //                             3
    '  web:', //                                4
    '    <<: *limits', //                       5
    '    image: "redis:7"', //                  6
    '    command: "privileged: true"', //       7
    '---', //                                   8
    'kind: Deployment', //                      9
    '---', //                                   10
    'bad: [1, 2', //                            11 (end of input)
  ].join('\n');
  const read = readYamlDocuments(text);
  assert.equal(read.docs.length, 2, 'the broken third document yields an error, not a value');
  const first = nth(read.docs, 0);
  assert.deepEqual(first.value, {
    'x-limits': { mem_limit: '512m' },
    services: { web: { mem_limit: '512m', image: 'redis:7', command: 'privileged: true' } },
  });
  assert.equal(first.lineOf(['services', 'web', 'image']), 6);
  assert.equal(first.lineOf(['services', 'web', 'mem_limit']), 2, 'a merged key cites its anchor');
  assert.equal(first.lineOf(['services', 'nope']), null);
  assert.equal(nth(read.docs, 1).line, 9);
  assert.equal(read.errors.length, 1);
  assert.equal(nth(read.errors, 0).line, 11);
  // An alias bomb (each level aliases the previous one ten times) is a read error, not a value
  // graph that grows tenfold per level for every caller that walks it.
  const bomb = ['a0: &a0 [x]'];
  for (let level = 1; level <= 6; level += 1) {
    bomb.push(
      `a${level}: &a${level} [${Array(10)
        .fill(`*a${level - 1}`)
        .join(', ')}]`,
    );
  }
  const bombRead = readYamlDocuments(bomb.join('\n'));
  // A count, not deepEqual: on failure the assertion must not render the exploded value.
  assert.equal(bombRead.docs.length, 0);
  assert.match(nth(bombRead.errors, 0).message, /alias/i);
  // The same bomb through merge keys: yaml@2.9.0 counts aliases only in Alias.toJS, and a merge
  // source is copied without that count, so this 400-byte chain took ~1 s at depth 6 (~10 s at
  // depth 7, tenfold per level) and returned with no error.
  const mergeBomb = ['m0: &m0 {x: 1}'];
  for (let level = 1; level <= 6; level += 1) {
    mergeBomb.push(
      `m${level}: &m${level} {<<: [${Array(10)
        .fill(`*m${level - 1}`)
        .join(', ')}], k${level}: 1}`,
    );
  }
  const started = Date.now();
  const mergeRead = readYamlDocuments(mergeBomb.join('\n'));
  assert.equal(mergeRead.docs.length, 0);
  assert.match(nth(mergeRead.errors, 0).message, /alias/i);
  assert.ok(Date.now() - started < 500, 'the budget refuses before the expansion runs');
});

void test('readYamlDocuments resolves aliases once per document, not once per alias', () => {
  // yaml@2.9.0's Alias.resolve(doc) walks the whole document unless it is handed the toJS
  // cache, so resolving each alias on its own costs O(aliases x nodes): a 110 KB compose file
  // with 4000 merge keys took 46 s in readYamlDocuments (verify-security-1 yaml-quadratic).
  // The cost is counted, not timed: an uncached resolve is one full-document walk.
  const fullWalks = (services: number): number => {
    const lines = ['x-base: &base', '  restart: unless-stopped', '  mem_limit: 256m', 'services:'];
    const merged: YamlPath[] = [];
    for (let index = 0; index < services; index += 1) {
      lines.push(`  s${index}:`, '    <<: *base', `    image: "redis:7.${index}.0"`);
      merged.push(['services', `s${index}`, 'mem_limit']);
    }
    const resolve = Alias.prototype.resolve;
    let walks = 0;
    Alias.prototype.resolve = function countedResolve(
      this: Alias,
      ...args: Parameters<typeof resolve>
    ): ReturnType<typeof resolve> {
      if (args[1]?.aliasResolveCache === undefined) walks += 1;
      return resolve.apply(this, args);
    };
    try {
      const read = readYamlDocuments(lines.join('\n'));
      assert.deepEqual(read.errors, []);
      const doc = nth(read.docs, 0);
      // lineOf follows the merge key through the alias too (the second per-alias walk today).
      for (const path of merged) assert.equal(doc.lineOf(path), 3);
    } finally {
      Alias.prototype.resolve = resolve;
    }
    return walks;
  };
  const few = fullWalks(20);
  const many = fullWalks(200);
  assert.ok(many <= 2, `${many} full-document walks for one document with 200 aliases`);
  assert.equal(many, few, 'the walk count does not grow with the number of aliases');
});

void test('workloads: compose services, env forms, build Dockerfile; k8s pod specs; kustomize targets', () => {
  const compose = nth(
    readYamlDocuments(
      [
        'services:',
        '  api:',
        '    build: { context: ./apps/api, dockerfile: ../../infrastructure/docker/Dockerfile.backend }',
        '    environment:',
        '      JWT_SECRET: abc',
        '      EMPTY:',
        '  worker:',
        '    build: ./worker',
        '    environment: ["A=1", "B"]',
        '',
      ].join('\n'),
    ).docs,
    0,
  ).value;
  const services = composeServices(compose);
  assert.deepEqual(
    services.map((s) => s.name),
    ['api', 'worker'],
  );
  assert.deepEqual(
    composeEnvironment(nth(services, 0)).map((e) => [e.key, e.value]),
    [
      ['JWT_SECRET', 'abc'],
      ['EMPTY', null],
    ],
  );
  assert.deepEqual(
    composeEnvironment(nth(services, 1)).map((e) => [e.key, e.value]),
    [
      ['A', '1'],
      ['B', null],
    ],
  );
  assert.equal(
    composeBuildDockerfile(nth(services, 0), 'docker-compose.yml'),
    'infrastructure/docker/Dockerfile.backend',
    'dockerfile is relative to the build context',
  );
  assert.equal(
    composeBuildDockerfile(nth(services, 0), 'deploy/docker-compose.yml'),
    'deploy/infrastructure/docker/Dockerfile.backend',
    'the context is relative to the compose file',
  );
  assert.equal(composeBuildDockerfile(nth(services, 1), 'docker-compose.yml'), 'worker/Dockerfile');

  const cron = nth(
    readYamlDocuments(
      [
        'apiVersion: batch/v1',
        'kind: CronJob',
        'metadata: { name: backup }',
        'spec:',
        '  jobTemplate:',
        '    spec:',
        '      template:',
        '        spec:',
        '          initContainers: [{ name: init, image: busybox }]',
        '          containers:',
        '            - name: run',
        '              env:',
        '                - { name: TOKEN, value: literal-value }',
        '                - name: REF',
        '                  valueFrom: { secretKeyRef: { name: s, key: k } }',
        '',
      ].join('\n'),
    ).docs,
    0,
  ).value;
  const [workload] = k8sWorkloads(cron);
  assert.ok(workload);
  assert.equal(workload.kind, 'CronJob');
  assert.equal(workload.name, 'backup');
  const containers = podContainers(workload);
  assert.deepEqual(
    containers.map((c) => [c.name, c.init]),
    [
      ['init', true],
      ['run', false],
    ],
  );
  assert.deepEqual(
    containerEnv(nth(containers, 1)).map((e) => [e.key, e.value]),
    [
      ['TOKEN', 'literal-value'],
      ['REF', null],
    ],
  );

  const kustomization = nth(
    readYamlDocuments(
      [
        'patches:',
        '  - patch: |-',
        '      kind: Deployment',
        '      metadata: { name: backend }',
        '  - path: hpa-patch.yaml',
        '    target: { kind: HorizontalPodAutoscaler, name: backend }',
        'patchesStrategicMerge: [memory.yaml]',
        '',
      ].join('\n'),
    ).docs,
    0,
  ).value;
  assert.deepEqual(
    kustomizePatchTargets(kustomization, 'deploy/production/kustomization.yaml').map((t) => [
      t.kind,
      t.name,
      t.file,
    ]),
    [
      ['Deployment', 'backend', null],
      ['HorizontalPodAutoscaler', 'backend', 'deploy/production/hpa-patch.yaml'],
      [null, null, 'deploy/production/memory.yaml'],
    ],
  );
});

// ---------------------------------------------------------------- Dockerfile

void test('readDockerfile: stages, ARG in FROM, stage refs, continuations, heredocs, escape directive', () => {
  const text = [
    '# syntax=docker/dockerfile:1.7', //                  1
    'ARG BASE=node:22.12.0-alpine', //                    2
    'FROM ${BASE} AS Builder', //                         3
    'USER node', //                                       4
    'RUN apk add \\', //                                  5
    '# a comment inside a continuation', //               6
    '    curl', //                                        7
    'RUN <<EOF', //                                       8
    'FROM evil:latest', //                                9
    'USER root', //                                       10
    'EOF', //                                             11
    'FROM --platform=$BUILDPLATFORM nginx:1.27-alpine', // 12
    'COPY --from=builder /app /app', //                   13
    'HEALTHCHECK NONE', //                                14
    'FROM builder AS final', //                           15
    '',
  ].join('\n');
  const read = readDockerfile(text);
  assert.deepEqual(read.errors, []);
  assert.equal(read.stages.length, 3, 'FROM inside a heredoc body is not a stage');
  const [builder, nginx, final] = read.stages;
  assert.ok(builder && nginx && final);
  assert.equal(builder.from, 'node:22.12.0-alpine');
  assert.equal(builder.fromLine, 3);
  assert.equal(builder.user, 'node');
  assert.equal(builder.runs.length, 2);
  assert.equal(nth(builder.runs, 0).body.replace(/\s+/g, ' '), 'apk add curl');
  assert.equal(nginx.platform, '$BUILDPLATFORM');
  assert.equal(nginx.isStageRef, false);
  assert.equal(nginx.user, null, 'USER root inside the heredoc body is not an instruction');
  assert.deepEqual(nginx.healthcheck, { line: 14, disabled: true });
  assert.equal(final.isStageRef, true);
  assert.equal(final.baseStage, 0, 'stage names are case-insensitive');

  const backtick = readDockerfile(
    ['# escape=`', 'FROM alpine:3.20', 'RUN echo a `', '    b', 'USER 65534', ''].join('\n'),
  );
  assert.deepEqual(backtick.errors, []);
  assert.equal(nth(nth(backtick.stages, 0).runs, 0).body.replace(/\s+/g, ' '), 'echo a b');
  assert.equal(nth(backtick.stages, 0).user, '65534');

  assert.ok(
    readDockerfile('RUN true\n').errors.length > 0,
    'an instruction before FROM is an error',
  );
  assert.ok(readDockerfile('FROM a\nRUN <<EOF\nnever closed\n').errors.length > 0);
});

void test('dockerfileFinalUser follows stage references and treats an absent USER as unset', () => {
  const buildOnly = readDockerfile('FROM node:22 AS b\nUSER node\nFROM nginx:1.27.3\n');
  assert.equal(dockerfileFinalUser(buildOnly).verdict, 'unset', 'USER only in the build stage');
  const inherited = readDockerfile('FROM node:22 AS b\nUSER node\nFROM b\n');
  assert.deepEqual(
    [dockerfileFinalUser(inherited).verdict, dockerfileFinalUser(inherited).user],
    ['non_root', 'node'],
  );
  const root = readDockerfile('FROM x@sha256:' + 'a'.repeat(64) + '\nUSER 0:0\n');
  assert.equal(dockerfileFinalUser(root).verdict, 'root');
  assert.equal(dockerfileFinalUser(root).line, 2);
});

void test('a runtime user named by a variable is unresolved, never non_root', () => {
  // WHY: `USER $APP_USER` and compose `user: "${UID}"` take their value from a build argument or
  // the environment at build or run time; the file does not say whether it is 0. userVerdict
  // read every name that is not `root` or `0` as non_root, so the variable form passed as a
  // safe runtime user (kc/r12-review M2, runtime-privilege.ts userVerdict). An owner that cannot
  // tell reports unresolved, the way terraform-pins.ts reports an unclassifiable source.
  const PIN = `FROM node:22@sha256:${'a'.repeat(64)}\n`;
  const variableUsers: readonly string[] = [
    '$APP_USER',
    '${APP_USER}',
    '${APP_UID:-1000}',
    '$UID:$GID',
    '${UID}:${GID}',
  ];
  for (const user of variableUsers) {
    const final = dockerfileFinalUser(readDockerfile(`${PIN}ARG APP_USER\nUSER ${user}\n`));
    assert.equal(final.verdict, 'unresolved', `Dockerfile USER ${user}`);
    assert.equal(final.line, 3, `Dockerfile USER ${user} keeps its line`);
    const service = nth(
      composeServices(
        nth(readYamlDocuments(`services:\n  app:\n    user: ${JSON.stringify(user)}\n`).docs, 0)
          .value,
      ),
      0,
    );
    assert.equal(composeServiceUser(service).verdict, 'unresolved', `compose user ${user}`);
  }
  // A user the file names stays judged as written.
  const judged: ReadonlyArray<readonly [string, string]> = [
    ['node', 'non_root'],
    ['1000:1000', 'non_root'],
    ['root', 'root'],
    ['0:0', 'root'],
  ];
  for (const [user, verdict] of judged) {
    assert.equal(
      dockerfileFinalUser(readDockerfile(`${PIN}USER ${user}\n`)).verdict,
      verdict,
      `Dockerfile USER ${user}`,
    );
    const service = nth(
      composeServices(
        nth(readYamlDocuments(`services:\n  app:\n    user: ${JSON.stringify(user)}\n`).docs, 0)
          .value,
      ),
      0,
    );
    assert.equal(composeServiceUser(service).verdict, verdict, `compose user ${user}`);
  }
});

// ---------------------------------------------------------------- HCL

void test('readHclBlocks: nested blocks, heredocs, comment braces, template strings, objects', () => {
  const text = [
    '# } a comment brace', //                                       1
    'terraform {', //                                               2
    '  required_providers {', //                                    3
    '    aws = { source = "hashicorp/aws", version = "~> 5.0" }', // 4
    '    random = { source = "hashicorp/random" }', //              5
    '  }', //                                                       6
    '}', //                                                         7
    '/* { block comment', //                                        8
    '   } */', //                                                   9
    'module "vpc" {', //                                            10
    '  source = "git::https://example.com/vpc.git?ref=main"', //    11
    '  name   = "${var.project}-{x}"', //                           12
    '  script = <<-EOT', //                                         13
    '    version = "9.9.9" }', //                                   14
    '    EOT', //                                                   15
    '  list = [', //                                                16
    '    "a", // trailing comment }', //                            17
    '  ]', //                                                       18
    '}', //                                                         19
    '',
  ].join('\n');
  const read = readHclBlocks(text);
  assert.deepEqual(read.errors, []);
  assert.deepEqual(
    read.blocks.map((b) => [b.type, b.labels, b.line]),
    [
      ['terraform', [], 2],
      ['module', ['vpc'], 10],
    ],
  );
  const providers = nth(nth(read.blocks, 0).blocks, 0);
  assert.equal(providers.type, 'required_providers');
  const aws = providers.attributes.aws;
  assert.ok(aws && aws.object);
  assert.equal(present(aws.object.version, 'version').string, '~> 5.0');
  const vpc = nth(read.blocks, 1);
  assert.equal(
    present(vpc.attributes.source, 'source').string,
    'git::https://example.com/vpc.git?ref=main',
  );
  // A template is not a literal: `string` is its value only for a quoted literal with no
  // interpolation. That expectation is the case 'readHclBlocks evaluates a quoted literal'.
  assert.equal(present(vpc.attributes.name, 'name').raw, '"${var.project}-{x}"');
  assert.equal(vpc.attributes.version, undefined, 'version inside a heredoc is not an attribute');
  assert.equal(present(vpc.attributes.list, 'list').line, 16);
  assert.ok(readHclBlocks('a {\n  b = 1\n').errors.length > 0, 'an unclosed block is an error');
});

void test('readHclBlocks evaluates a quoted literal: escapes decode to their value, and a template with an interpolation is not a literal', () => {
  // WHY: Terraform reads a quoted string as its evaluated value (HCL native syntax: `\n`,
  // `\r`, `\t`, `\"`, `\\`, `\uNNNN`, `\UNNNNNNNN`, and `$${` / `%%{` for a literal `${` /
  // `%{`). The reader kept the token text, so `\u0040` reached terraform-pins.ts as six
  // characters, not as `@`, and a userinfo the owner withholds when written `@` was parsed as
  // a host (r12r4-review probes 2, 3). The one HCL reader returns the value, so every
  // consumer sees what Terraform sees; a string holding a `${...}` or `%{...}` sequence is a
  // template whose value this reader does not evaluate, so it is no literal (`string` null),
  // and its raw text stays.
  const read = readHclBlocks(
    [
      'locals {',
      '  newline    = "a\\nb"',
      '  carriage   = "a\\rb"',
      '  tab        = "a\\tb"',
      '  quote      = "a\\"b"',
      '  backslash  = "a\\\\b"',
      '  short      = "a\\u0040b"',
      '  long       = "a\\U0001F600b"',
      '  long_at    = "a\\U00000040b"',
      '  all        = "\\\\u0040\\"\\u0067\\n"',
      '  dollar     = "a$${b}"',
      '  percent    = "a%%{b}"',
      '  plain      = "a-b"',
      '  interp     = "${var.a}"',
      '  embedded   = "a-${var.a}-b"',
      '  directive  = "%{ if var.a }x%{ endif }"',
      '  nested     = "${"inner"}"',
      '  after_esc  = "a\\u0040${var.a}"',
      '  object     = { version = "~\\u003e 5.0", source = "hashicorp/${var.p}" }',
      '}',
      'module "vpc\\u005fa" {',
      '  source = "./m"',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const locals = nth(read.blocks, 0).attributes;
  const value = (name: string): string | null => present(locals[name], name).string;
  assert.deepEqual(
    Object.fromEntries(
      [
        'newline',
        'carriage',
        'tab',
        'quote',
        'backslash',
        'short',
        'long',
        'long_at',
        'all',
        'dollar',
        'percent',
        'plain',
      ].map((name) => [name, value(name)]),
    ),
    {
      newline: 'a\nb',
      carriage: 'a\rb',
      tab: 'a\tb',
      quote: 'a"b',
      backslash: 'a\\b',
      short: 'a@b',
      long: 'a\u{1F600}b',
      long_at: 'a@b',
      all: '\\u0040"g\n',
      dollar: 'a${b}',
      percent: 'a%{b}',
      plain: 'a-b',
    },
    'a quoted literal is its evaluated value',
  );
  assert.deepEqual(
    ['interp', 'embedded', 'directive', 'nested', 'after_esc'].filter(
      (name) => value(name) !== null,
    ),
    [],
    'a string with a template interpolation or directive is not a literal',
  );
  assert.equal(present(locals.short, 'short').raw, '"a\\u0040b"', 'raw keeps the written text');
  assert.equal(present(locals.interp, 'interp').raw, '"${var.a}"', 'raw keeps the template');
  const entries = present(present(locals.object, 'object').object, 'object entries');
  assert.equal(present(entries.version, 'version').string, '~> 5.0');
  assert.equal(present(entries.source, 'object source').string, null);
  assert.deepEqual(nth(read.blocks, 1).labels, ['vpc_a'], 'a quoted label is its value');
});

void test('terraform pins: module sources and provider constraints', () => {
  const read = readHclBlocks(
    [
      'module "a" { source = "git::https://e.com/m.git" }',
      'module "b" { source = "git::https://e.com/m.git?ref=main" }',
      'module "c" { source = "git::https://e.com/m.git?ref=' + 'b'.repeat(40) + '" }',
      'module "d" { source = "github.com/org/m?ref=v1.2.3" }',
      'module "e" { source = "terraform-aws-modules/vpc/aws" }',
      'module "f" {',
      '  source  = "terraform-aws-modules/vpc/aws"',
      '  version = "5.1.2"',
      '}',
      'module "g" { source = "../modules/vpc" }',
      'terraform {',
      '  required_providers {',
      '    aws    = { source = "hashicorp/aws", version = "~> 5.0" }',
      '    random = { source = "hashicorp/random" }',
      '    legacy = "~> 2.0"',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const modules = read.blocks.filter((b) => b.type === 'module');
  assert.deepEqual(
    modules.map((m) => moduleSourcePin(m).verdict),
    [
      'git_unpinned',
      'git_branch_ref',
      'git_commit',
      'git_tag',
      'registry_unversioned',
      'registry_versioned',
      'local',
    ],
  );
  // Which verdicts pin is asserted once, in the fail-closed case below (landing fix 3).
  const terraform = read.blocks.find((b) => b.type === 'terraform');
  assert.ok(terraform);
  assert.deepEqual(
    providerConstraints(terraform).map((p) => [p.provider, p.version]),
    [
      ['aws', '~> 5.0'],
      ['random', null],
      ['legacy', '~> 2.0'],
    ],
  );
});

void test('terraform pins fail closed: an archive is unpinned unless checksummed, an unknown source is unresolved', () => {
  // An http(s)/s3/gcs archive changes when the object behind the URL is overwritten, and a source
  // the owner cannot classify must not count as pinned (image-reference.ts: `malformed` is
  // mutable). The checksum form is go-getter's `?checksum=<type>:<value>`.
  const read = readHclBlocks(
    [
      'module "git_unpinned" { source = "git::https://e.com/m.git" }',
      'module "git_branch" { source = "git::https://e.com/m.git?ref=main" }',
      'module "git_commit" { source = "git::https://e.com/m.git?ref=' + 'b'.repeat(40) + '" }',
      'module "git_tag" { source = "github.com/org/m?ref=v1.2.3" }',
      'module "registry_bare" { source = "terraform-aws-modules/vpc/aws" }',
      'module "registry_versioned" {',
      '  source  = "terraform-aws-modules/vpc/aws"',
      '  version = "5.1.2"',
      '}',
      'module "local" { source = "../modules/vpc" }',
      'module "https_archive" { source = "https://e.com/vpc.zip" }',
      'module "s3_archive" { source = "s3::https://bucket.s3.amazonaws.com/vpc.zip" }',
      'module "gcs_archive" { source = "gcs::https://www.googleapis.com/storage/v1/b/vpc.zip" }',
      'module "checksummed" { source = "https://e.com/vpc.zip?checksum=sha256:' +
        'e'.repeat(64) +
        '" }',
      'module "odd_scheme" { source = "ftp-mirror:vpc" }',
      'module "no_source" { version = "1.0.0" }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  // The pinning is read through the Record, so it is the owner's answer and nobody else's.
  const pinning = (block: (typeof read.blocks)[number]): string =>
    MODULE_SOURCE_PINNING[moduleSourcePin(block).verdict];
  assert.deepEqual(
    read.blocks.filter((b) => b.type === 'module').map((m) => [m.labels[0], pinning(m)]),
    [
      ['git_unpinned', 'unpinned'],
      ['git_branch', 'unpinned'],
      ['git_commit', 'pinned'],
      ['git_tag', 'pinned'],
      ['registry_bare', 'unpinned'],
      ['registry_versioned', 'pinned'],
      ['local', 'pinned'],
      ['https_archive', 'unpinned'],
      ['s3_archive', 'unpinned'],
      ['gcs_archive', 'unpinned'],
      ['checksummed', 'pinned'],
      ['odd_scheme', 'unresolved'],
      ['no_source', 'unresolved'],
    ],
  );
  // A Record over the verdict union: a new verdict without an entry does not compile, and the
  // verdicts that do not pin are listed here, so none can default to pinned.
  const verdictsWith = (outcome: string): string[] =>
    Object.entries(MODULE_SOURCE_PINNING)
      .filter(([, value]) => value === outcome)
      .map(([verdict]) => verdict)
      .sort();
  assert.deepEqual(verdictsWith('unpinned'), [
    'archive',
    'git_branch_ref',
    'git_unpinned',
    'registry_unversioned',
  ]);
  assert.deepEqual(verdictsWith('unresolved'), ['unknown']);
});

void test('terraform pins carry no credential: the source is judged whole and reported without userinfo or credential arguments', () => {
  // WHY: the pin's source is the adapter's finding subject and message, which ARIA keeps in its
  // state and evidence long after the credential is rotated; the round-2 review found an oauth2
  // token and an S3 secret copied there verbatim (kc/r12-review probe-leak3.log). go-getter
  // takes credentials in the URL userinfo and in the aws_access_key_id, aws_access_key_secret,
  // aws_access_token and sshkey query arguments. The owner judges the address with them and
  // reports it without them, as nats-identity.ts reports a password's length and never its value.
  const literals = {
    oauthToken: 'Rt5Wq8Zm3Kx1Vb7N',
    bareToken: 'Pn2Hd6Js9Lc4Fg0Y',
    keyId: 'Kid4Ux7Ob1Ea3Ip9',
    keySecret: 'Ms8Tq2Wv5Yz1Ac6D',
    sessionToken: 'Ss3Gh7Jk0Lq4Np8R',
    sshKey: 'U3NoS2V5Rml4dHVyZQ',
    ftpPassword: 'Fp6Xc9Vb2Nm5Qw8E',
  };
  const read = readHclBlocks(
    [
      `module "oauth" { source = "git::https://oauth2:${literals.oauthToken}@gitlab.example.com/org/net.git" }`,
      `module "bare_token" { source = "git::https://${literals.bareToken}@github.com/org/m.git?ref=v1.2.3" }`,
      'module "s3_keys" {',
      `  source = "s3::https://s3.amazonaws.com/bucket/mod.zip?aws_access_key_id=${literals.keyId}&aws_access_key_secret=${literals.keySecret}&aws_access_token=${literals.sessionToken}"`,
      '}',
      `module "ssh_key" { source = "git::ssh://git@example.com/org/m.git?ref=main&sshkey=${literals.sshKey}" }`,
      `module "ftp" { source = "ftp://deploy:${literals.ftpPassword}@mirror.example/vpc.zip" }`,
      'module "scp" { source = "git@github.com:org/m.git?ref=v1.2.3" }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const pins = read.blocks
    .filter((b) => b.type === 'module')
    .map((block) => ({ module: block.labels[0], pin: moduleSourcePin(block) }));
  // The verdict is that of the whole address: redaction does not change what pins.
  assert.deepEqual(
    pins.map(({ module, pin }) => [module, pin.verdict]),
    [
      ['oauth', 'git_unpinned'],
      ['bare_token', 'git_tag'],
      ['s3_keys', 'archive'],
      ['ssh_key', 'git_branch_ref'],
      ['ftp', 'unknown'],
      ['scp', 'git_tag'],
    ],
  );
  const serialised = JSON.stringify(pins);
  for (const [name, literal] of Object.entries(literals)) {
    assert.equal(serialised.includes(literal), false, `the ${name} is not in any pin`);
  }
  // What is not a credential stays, so a finding still names where the module comes from.
  const source = (module: string): string =>
    present(pins.find((entry) => entry.module === module)?.pin.source, `${module} source`);
  assert.ok(source('oauth').includes('gitlab.example.com/org/net.git'));
  assert.ok(source('bare_token').includes('github.com/org/m.git?ref=v1.2.3'));
  assert.ok(source('s3_keys').startsWith('s3::https://s3.amazonaws.com/bucket/mod.zip'));
  assert.ok(source('ssh_key').includes('example.com/org/m.git'));
  assert.ok(source('ssh_key').includes('ref=main'));
  assert.ok(source('ftp').includes('mirror.example/vpc.zip'));
  // The scp-style login is userinfo like any other: the round-4 review (R1 residual c) found a
  // token written in its place kept verbatim, so no user is reported, `git@` included. That
  // expectation is the case 'terraform pins report a userinfo as present, never its text'.
  assert.ok(source('scp').includes('github.com'));
  assert.ok(source('scp').includes('org/m.git'));
  assert.ok(source('scp').includes('ref=v1.2.3'));
});

void test('terraform pins report a query value only for an allow-listed go-getter argument: presigned, SAS, token and unknown arguments are masked', () => {
  // WHY: the round-2 redaction is a deny list of four go-getter argument names, but the
  // credential in an HTTP archive URL is whatever its server reads: an S3 presigned URL carries
  // X-Amz-Credential, X-Amz-Security-Token and X-Amz-Signature, an Azure SAS URL `sig=`, a
  // GitHub raw URL `token=`, and any server may name its own. All of them reached the finding
  // subject and message (kc/r12r2-review probe-leak.log, ws/tf). The owner can name the
  // arguments it knows carry no credential; every other value is masked, and so is an argument
  // with no `=`, whose name is then its only content.
  const literals = {
    amzCredential: 'Kq3Xc8Vn2Bm7Lw5P',
    amzSecurityToken: 'Tz4Rf6Hy1Uj9Ik3O',
    amzSignature: 'b7e1c94d2a6f08e35d1c7a9b4f2e6d80',
    sasSignature: 'Sg5Dh8Fj2Kl6Qw9E',
    githubToken: 'Gt2Wq7Er4Ty8Ui1P',
    unknownArgument: 'Uv9Bn3Mq6Xc1Za4S',
    bareArgument: 'Ba7Ns2Dk5Lq8Wz3R',
    privateToken: 'Pt6Yh1Gb4Nm9Jk2L',
    gcsSignature: 'Gs3Lk8Jh5Fd2Sa7Q',
    joinedToken: 'Jt8Qa3Zs6Wx1Ed4C',
  };
  const sha = 'c'.repeat(64);
  const read = readHclBlocks(
    [
      'module "presigned" {',
      `  source = "https://bucket.s3.amazonaws.com/mod.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${literals.amzCredential}%2F20261022%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20261022T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Security-Token=${literals.amzSecurityToken}&X-Amz-Signature=${literals.amzSignature}"`,
      '}',
      'module "sas" {',
      `  source = "https://acct.blob.core.windows.net/c/mod.zip?sv=2022-11-02&sr=b&sp=r&se=2026-12-31T00%3A00%3A00Z&sig=${literals.sasSignature}%2B%3D"`,
      '}',
      `module "github_raw" { source = "https://raw.githubusercontent.com/org/r/main/mod.zip?token=${literals.githubToken}" }`,
      `module "unknown_argument" { source = "https://mirror.example/mod.zip?p=${literals.unknownArgument}" }`,
      `module "bare_argument" { source = "https://mirror.example/mod.zip?${literals.bareArgument}" }`,
      `module "git_token" { source = "git::https://gitlab.example.com/org/net.git?ref=main&depth=1&private_token=${literals.privateToken}" }`,
      `module "gcs" { source = "gcs::https://www.googleapis.com/storage/v1/bucket/mod.zip?GoogleAccessId=svc&Signature=${literals.gcsSignature}" }`,
      `module "checksummed" { source = "https://mirror.example/mod.tgz?archive=tar.gz&checksum=sha256:${sha}" }`,
      'module "joined" {',
      `  source = join("", ["https://mirror.example/mod.zip?token=", "${literals.joinedToken}"])`,
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const pins = read.blocks
    .filter((b) => b.type === 'module')
    .map((block) => ({ module: block.labels[0], pin: moduleSourcePin(block) }));
  // The verdict is still that of the whole address.
  assert.deepEqual(
    pins.map(({ module, pin }) => [module, pin.verdict]),
    [
      ['presigned', 'archive'],
      ['sas', 'archive'],
      ['github_raw', 'archive'],
      ['unknown_argument', 'archive'],
      ['bare_argument', 'archive'],
      ['git_token', 'git_branch_ref'],
      ['gcs', 'archive'],
      ['checksummed', 'archive_checksummed'],
      ['joined', 'unknown'],
    ],
  );
  const serialised = JSON.stringify(pins);
  const leaked = Object.entries(literals)
    .filter(([, literal]) => credentialWindowsIn(serialised, literal).length > 0)
    .map(([name]) => name);
  assert.deepEqual(leaked, [], 'no credential value, or any part of one, is in a pin');
  // What is not a credential stays readable: the host and path, and the allow-listed arguments.
  const source = (module: string): string =>
    present(pins.find((entry) => entry.module === module)?.pin.source, `${module} source`);
  assert.ok(source('presigned').startsWith('https://bucket.s3.amazonaws.com/mod.zip?'));
  assert.ok(source('sas').startsWith('https://acct.blob.core.windows.net/c/mod.zip?'));
  assert.ok(
    source('github_raw').startsWith('https://raw.githubusercontent.com/org/r/main/mod.zip'),
  );
  assert.ok(source('git_token').startsWith('git::https://gitlab.example.com/org/net.git?'));
  assert.ok(source('git_token').includes('ref=main'), 'ref is allow-listed');
  assert.ok(source('git_token').includes('depth=1'), 'depth is allow-listed');
  assert.ok(source('checksummed').includes('archive=tar.gz'), 'archive is allow-listed');
  assert.ok(source('checksummed').includes(`checksum=sha256:${sha}`), 'checksum is allow-listed');
});

/** Each probe paired with the pin moduleSourcePin gives its module, read from one `.tf` text. */
function pinsOf(
  probes: readonly TerraformSourceProbe[],
): Array<{ probe: TerraformSourceProbe; pin: ReturnType<typeof moduleSourcePin> }> {
  const read = readHclBlocks(probesAsTerraform(probes));
  assert.deepEqual(read.errors, [], 'the probe corpus is valid HCL');
  const modules = read.blocks.filter((b) => b.type === 'module');
  assert.deepEqual(
    modules.map((block) => block.labels[0]),
    probes.map((probe) => probe.name),
    'one module per probe, in order',
  );
  return modules.map((block, index) => ({
    probe: nth(probes, index),
    pin: moduleSourcePin(block),
  }));
}

/** The probes whose pin carries any four-character window of their planted marker. */
function leakingProbes(probes: readonly TerraformSourceProbe[]): string[] {
  return pinsOf(probes)
    .filter(({ probe, pin }) => credentialWindowsIn(JSON.stringify(pin), probe.marker).length > 0)
    .map(({ probe, pin }) => `${probe.name}: ${String(pin.source)}`);
}

void test('terraform pins keep their verdicts on the probe corpus, which covers every source position under every forced prefix', () => {
  // WHY: the reported source is an output of the owner; the verdict is judged on the parsed
  // source and must be the one judged before the reported form was rebuilt (e7e14ff83). Every
  // probe's verdict, and its pinned / unpinned / unresolved reading, is pinned here, live, so the
  // rebuild cannot move a verdict while it removes a leak.
  const probes = [...terraformSourceProbes(), ...reviewerProbes(), ...authorityProbes()];
  assert.deepEqual(
    pinsOf(probes)
      .filter(({ probe, pin }) => pin.verdict !== probe.verdict)
      .map(({ probe, pin }) => `${probe.name}: ${pin.verdict}, was ${probe.verdict}`),
    [],
  );
  // The corpus keeps the positions the review named: shrinking it would make the leak case
  // below pass without proving anything.
  const names = probes.map((probe) => probe.name);
  const positions = [
    'userinfo_password',
    'user_without_password',
    'host_bad_character',
    'port_not_digits',
    'path_parameter',
    'path_at_sign',
    'query_value',
    'query_name',
    'query_bare',
    'query_value_at_sign',
    'query_value_question',
    'query_value_semicolon',
    'query_value_hash',
    'gcs_v2_signature',
    'ref_nested_question',
    'ref_semicolon',
    'ref_at_sign',
    'depth_not_digits',
    'archive_not_a_type',
    'checksum_not_hex',
    'checksum_file_query',
    'checksum_file_userinfo',
    'fragment',
    'fragment_at_sign',
    // round 5 (kc/r12r4-review): an authority or scheme-less head that fails as a whole
    'authority_user_percent_at',
    'authority_user_hcl_at',
    'authority_user_hcl_long_at',
    'authority_port_not_digits',
    'authority_port_empty',
    'authority_port_percent_at',
    'authority_port_hcl_at',
    'schemeless_user_hcl_at',
    'schemeless_user_percent_at',
    'schemeless_head_segment_fails',
    'query_hcl_question',
    'fragment_hcl_hash',
  ];
  const missing: string[] = [];
  for (const position of positions) {
    for (const prefix of FORCED_PREFIXES) {
      const name = `${prefix === '' ? 'plain' : prefix.slice(0, -2)}_${position}`;
      if (!names.includes(name)) missing.push(name);
    }
  }
  for (const name of ['scp_user', 'scp_user_forced', 'token_user_shorthand', 'ssh_password']) {
    if (!names.includes(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], 'every position the review named is in the corpus');
  // A marker window found in an output is that probe's own leak: no window is shared by two
  // markers, and none is part of what a probe may legitimately report (its source without the
  // marker, its module label).
  const legitimate = new Set(
    probes.flatMap((probe) => [
      ...markerWindows(probe.source.split(probe.marker).join(' ')),
      ...markerWindows(probe.name),
    ]),
  );
  const owners = new Map<string, string>();
  const clashes: string[] = [];
  for (const probe of probes) {
    for (const window of markerWindows(probe.marker)) {
      const owner = owners.get(window);
      if (owner !== undefined) clashes.push(`${window}: ${owner} and ${probe.name}`);
      if (legitimate.has(window)) clashes.push(`${window}: ${probe.name} and a readable part`);
      owners.set(window, probe.name);
    }
  }
  assert.deepEqual(clashes, [], 'every marker window points at one probe');
});

void test("terraform pins report none of the round-4 reviewer's leaking sources with any part of the planted credential", () => {
  // WHY: kc/r12r3-review probe-leak-1..3.log. (a) maskUserinfo takes the last `@` of the whole
  // address before the query and fragment are split, so a GCS V2 signed URL's
  // GoogleAccessId=sa@proj... swallows the `?` and Signature= is kept, and so are
  // ?password=pre@X, ?token=a@X and #x@X. (b) an allow-listed argument keeps its value whatever
  // it holds: checksum=file:<presigned URL>, ref=x?token=X, ref=v1;token=X. (c) a scheme-less
  // user without `:` is kept for any user: ghp_X@github.com/org/x.git. Each source carries a
  // fresh marker where the reviewer planted LEAK...; none of it may be in the pin.
  assert.deepEqual(leakingProbes(reviewerProbes()), []);
});

void test('terraform pins report no planted marker from any syntactic position of a module source', () => {
  // WHY: three rounds of masking the written address each leaked through a position the
  // previous round did not try. A reported source built only from parts that pass a strict
  // shape check (forced getter and scheme from a closed set, a hostname-shaped host, path
  // segments of a safe class, an allow-listed argument only when its value has that
  // argument's shape, no userinfo ever) has no such position. The corpus plants a distinct
  // marker in every position: URL userinfo, a user without a password, host, port, path, each
  // query argument name and value (allow-listed ones included), nested `?`, `;`, `@` and `#`
  // inside values, the fragment and a checksum-file URL, under '', git::, s3::, gcs:: and
  // hg::, plus the scp-style, shorthand, ssh, s3-userinfo and registry forms. A marker that
  // sits in a readable position rides on a character that position's shape refuses.
  const leaking = leakingProbes(terraformSourceProbes());
  assert.deepEqual(leaking, [], `${leaking.length} probes leak a part of their marker`);
});

void test('terraform pins report no planted marker from an authority or scheme-less head that fails its shape as a whole', () => {
  // WHY: kc/r12r4-review 05-probe-leak.log. urlHostShape split the authority at its last `:`
  // and reported the left half when it had a hostname's shape, though the right half was no
  // port; schemelessHeadShape reported the left of `:` when the right failed SEGMENT; and
  // the owner parsed the HCL token text, so an `@` written `\u0040` was no `@`. A userinfo
  // user then sat in the host slot: (1) https://<token>:x-oauth-basic%40github.com/...,
  // (2) git::https://<token>:x-oauth-basic\u0040github.com/... (GitHub's documented token
  // form, valid Terraform), (3) ghp_<token>:x\u0040github.com/org/x.git, (17)
  // https://<token>:<pw>/m.zip. The corpus plants the marker as that user under every
  // forced prefix, with the `@` percent-encoded, HCL-escaped or absent; an authority is
  // reported only when it is host(:digits)? as a whole, a scheme-less head only when head
  // and the segment after its `:` both pass.
  const leaking = leakingProbes(authorityProbes());
  assert.deepEqual(leaking, [], `${leaking.length} probes leak a part of their marker`);
});

void test('terraform pins report an authority whole or not at all, decode HCL escapes and never percent-encoding', () => {
  // WHY: the required design (r12r4-review): (ii) the authority is reported only when it
  // matches host(:digits)? as a whole, else all of it is withheld, and a scheme-less head
  // only when head and the following segment both pass; (iii) percent-encoded text is never
  // decoded into a reported part, while an HCL escape is, by the reader, because Terraform
  // decodes it before go-getter sees the address. A readable source keeps its host and port.
  const read = readHclBlocks(
    [
      'module "host_port" { source = "https://example.com:8443/org/x.git?ref=main" }',
      'module "scheme_less" { source = "github.com/org/x?ref=v1.2.3" }',
      'module "scp_head" { source = "git::example.com:org/x.git?ref=main" }',
      'module "user_port_percent" { source = "https://deployer:8443%40github.com/m.zip" }',
      'module "user_port_hcl" { source = "https://deployer:8443\\u0040github.com/m.zip" }',
      'module "user_no_host" { source = "https://deployer:secret/m.zip" }',
      'module "head_fails" { source = "deployer:x;y/org/x.git" }',
      'module "head_hcl_at" { source = "ghp_deployer:x\\u0040github.com/org/x.git" }',
      'module "hcl_host" { source = "https://\\u0067ithub.com/org/x.git?ref=main" }',
      'module "percent_host" { source = "https://%67ithub.com/org/x.git?ref=main" }',
      'module "percent_path" { source = "https://example.com/a%2Fb/m.zip" }',
      'module "percent_user" { source = "https://deployer%3Asecret%40example.com/m.zip" }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const pins = new Map(
    read.blocks
      .filter((b) => b.type === 'module')
      .map((block) => [String(block.labels[0]), moduleSourcePin(block)]),
  );
  const source = (module: string): string => present(pins.get(module)?.source, `${module} source`);
  const problems: string[] = [];
  const expect = (module: string, holds: boolean, what: string): void => {
    if (!holds) problems.push(`${module}: ${what} in ${source(module)}`);
  };
  // A well-formed authority and head stay readable, the port included.
  expect('host_port', source('host_port').includes('example.com:8443/org/x.git'), 'host:port');
  expect('host_port', source('host_port').includes('ref=main'), 'ref=main');
  expect('scheme_less', source('scheme_less').includes('github.com/org/x'), 'head and path');
  expect('scp_head', source('scp_head').includes('example.com:org/x.git'), 'host:path');
  // An authority that is not host(:digits)? is withheld whole: no `:` and no half of it.
  for (const module of ['user_port_percent', 'user_port_hcl', 'user_no_host']) {
    expect(module, !source(module).includes('deployer'), 'no user');
    expect(module, !source(module).includes('8443'), 'no password half');
    expect(module, !source(module).includes('secret'), 'no password half');
    expect(module, /^https:\/\/[^:/]*\/m\.zip$/.test(source(module)), 'one withheld authority');
  }
  // A scheme-less head whose segment after `:` fails is withheld whole.
  for (const module of ['head_fails', 'head_hcl_at']) {
    expect(module, !source(module).includes('deployer'), 'no user');
    expect(module, /^[^:]*\/org\/x\.git$/.test(source(module)), 'one withheld head');
  }
  // An HCL escape is decoded by the reader: Terraform's address is https://github.com/...
  expect('hcl_host', source('hcl_host').includes('https://github.com/org/x.git'), 'host');
  // Percent-encoding is never decoded into a reported part.
  expect('percent_host', !source('percent_host').includes('github.com'), 'no decoded host');
  expect('percent_host', source('percent_host').includes('/org/x.git'), 'the path');
  expect('percent_path', !source('percent_path').includes('a/b'), 'no decoded segment');
  expect('percent_user', !source('percent_user').includes('example.com'), 'no decoded host');
  expect('percent_user', !source('percent_user').includes('deployer'), 'no user');
  assert.deepEqual(problems, []);
});

void test('terraform pins judge the value Terraform evaluates: an HCL escape is decoded, a template is no literal', () => {
  // WHY: the verdict, like the report, is of the address Terraform hands go-getter. Decoding
  // in the reader moves a verdict only where a source's value differs from its raw text, and
  // each such move is listed here with its reason:
  //   - `\u002e/modules/vpc` is `./modules/vpc`: local, was unknown;
  //   - `...m.zip\u003fchecksum=sha256:<hex>` has a query: archive_checksummed, was archive;
  //   - `git::...x.git\u003fref=v1.2.3` has a ref: git_tag, was git_unpinned;
  //   - `terraform-aws-modules\u002fvpc/aws` is a registry address: registry_unversioned,
  //     was unknown;
  //   - `\u0068ttps://example.com/m.zip` is an https archive: archive, was unknown;
  //   - a source with `${...}` or `%{...}` is a template this owner does not evaluate, so it
  //     is no literal: unknown (unresolved) and reported as one, was judged on its text
  //     (git_branch_ref for `?ref=${var.ref}`, archive for `https://${var.host}/m.zip`).
  // Each escaped source is also reported as its plain twin is: one value, one report.
  const hex = CHECKSUM_HEX;
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    ['local', '\\u002e/modules/vpc', './modules/vpc'],
    [
      'checksum',
      `https://example.com/m.zip\\u003fchecksum=sha256:${hex}`,
      `https://example.com/m.zip?checksum=sha256:${hex}`,
    ],
    [
      'ref',
      'git::https://example.com/x.git\\u003fref=v1.2.3',
      'git::https://example.com/x.git?ref=v1.2.3',
    ],
    ['registry', 'terraform-aws-modules\\u002fvpc/aws', 'terraform-aws-modules/vpc/aws'],
    ['scheme', '\\u0068ttps://example.com/m.zip', 'https://example.com/m.zip'],
    ['literal_dollar', './modules/$${x}', './modules/$${x}'],
  ];
  const read = readHclBlocks(
    [
      ...pairs.flatMap(([name, escaped, plain]) => [
        `module "escaped_${name}" { source = "${escaped}" }`,
        `module "plain_${name}" { source = "${plain}" }`,
      ]),
      'module "interpolated_ref" { source = "git::https://example.com/x.git?ref=${var.ref}" }',
      'module "interpolated_host" { source = "https://${var.host}/m.zip" }',
      'module "directive" { source = "%{ if var.a }./a%{ else }./b%{ endif }" }',
      'module "expression" { source = var.source }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const pins = new Map(
    read.blocks
      .filter((b) => b.type === 'module')
      .map((block) => [String(block.labels[0]), moduleSourcePin(block)]),
  );
  const pin = (module: string): ReturnType<typeof moduleSourcePin> =>
    present(pins.get(module), module);
  assert.deepEqual(
    pairs.map(([name]) => [name, pin(`escaped_${name}`).verdict]),
    [
      ['local', 'local'],
      ['checksum', 'archive_checksummed'],
      ['ref', 'git_tag'],
      ['registry', 'registry_unversioned'],
      ['scheme', 'archive'],
      ['literal_dollar', 'local'],
    ],
  );
  assert.deepEqual(
    pairs
      .filter(([name]) => pin(`escaped_${name}`).source !== pin(`plain_${name}`).source)
      .map(([name]) => `${name}: ${pin(`escaped_${name}`).source}`),
    [],
    'an escaped source is reported as its plain twin',
  );
  const notALiteral = pin('expression').source;
  for (const module of ['interpolated_ref', 'interpolated_host', 'directive']) {
    assert.equal(pin(module).verdict, 'unknown', `${module} is no literal`);
    assert.equal(MODULE_SOURCE_PINNING[pin(module).verdict], 'unresolved');
    assert.equal(pin(module).source, notALiteral, `${module} is reported as no literal`);
  }
});

void test('terraform pins report a userinfo as present, never its text, and keep the readable parts', () => {
  // WHY: the reported source names where a module comes from, so a finding stays useful: the
  // forced getter, scheme, host, path, a ref with a ref's shape, a digit depth, an archive
  // type and a <type>:<hex> checksum. A userinfo is never one of those parts, not even the
  // scp login `git@` (a token written in its place was kept verbatim, R1 residual c); the
  // owner records that one was present, so the reported pin of a source with a userinfo
  // differs from the pin of the same source without one.
  const token = 'Wz7Kq3Vx9Jm2Lp5R';
  const read = readHclBlocks(
    [
      `module "git_https" { source = "git::https://ghp_${token}@github.com/org/net.git?ref=v1.2.3&depth=1&private_token=${token}" }`,
      `module "archive" { source = "https://mirror.example/mod.tgz?archive=tar.gz&checksum=sha256:${CHECKSUM_HEX}&token=${token}" }`,
      'module "scp" { source = "git@github.com:org/m.git?ref=v1.2.3" }',
      'module "ssh" { source = "git::ssh://git@example.com/org/m.git?ref=main" }',
      'module "with_user" { source = "git::https://deploy@github.com/org/m.git?ref=v1.2.3" }',
      'module "without_user" { source = "git::https://github.com/org/m.git?ref=v1.2.3" }',
      'module "s3" { source = "s3::https://s3.amazonaws.com/bucket/mod.zip" }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const pins = new Map(
    read.blocks
      .filter((b) => b.type === 'module')
      .map((block) => [String(block.labels[0]), moduleSourcePin(block)]),
  );
  const source = (module: string): string => present(pins.get(module)?.source, `${module} source`);
  assert.deepEqual(credentialWindowsIn(JSON.stringify([...pins.values()]), token), []);

  const gitHttps = source('git_https');
  assert.ok(gitHttps.startsWith('git::https://'), `forced getter and scheme: ${gitHttps}`);
  for (const part of ['github.com', '/org/net.git', 'ref=v1.2.3', 'depth=1']) {
    assert.ok(gitHttps.includes(part), `${part} is readable in ${gitHttps}`);
  }
  const archive = source('archive');
  for (const part of [
    'mirror.example',
    '/mod.tgz',
    'archive=tar.gz',
    `checksum=sha256:${CHECKSUM_HEX}`,
  ]) {
    assert.ok(archive.includes(part), `${part} is readable in ${archive}`);
  }
  assert.ok(source('s3').startsWith('s3::https://s3.amazonaws.com/bucket/mod.zip'));

  for (const module of ['scp', 'ssh', 'with_user']) {
    assert.equal(source(module).includes('git@'), false, `${module}: no git@ in ${source(module)}`);
    assert.equal(
      source(module).includes('deploy'),
      false,
      `${module}: no user in ${source(module)}`,
    );
  }
  for (const part of ['github.com', 'org/m.git', 'ref=v1.2.3']) {
    assert.ok(source('scp').includes(part), `${part} is readable in ${source('scp')}`);
  }
  assert.ok(source('ssh').includes('example.com'), source('ssh'));
  const withoutLine = (module: string): string =>
    JSON.stringify({ ...present(pins.get(module), module), line: 0 });
  assert.notEqual(
    withoutLine('with_user'),
    withoutLine('without_user'),
    'a userinfo is recorded as present',
  );
});

void test('terraform pins: a reported source is a type only terraform-pins.ts constructs', () => {
  // WHY (tier 1): a reported source that is a plain string can be filled from the written
  // address by any later edit, which is how each round's leak came back. The pin's `source`
  // is a branded type a raw string is not assignable to, and no file but the owner casts to
  // it, so printing a raw source is a compile error and not a review finding.
  const ownerPath = join(REPO_ROOT, 'tools/gates/infra-policy/terraform-pins.ts');
  const program = ts.createProgram([ownerPath], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    types: [],
  });
  const checker = program.getTypeChecker();
  const ownerFile = present(program.getSourceFile(ownerPath), 'terraform-pins.ts');
  const ownerModule = present(checker.getSymbolAtLocation(ownerFile), 'owner module symbol');
  const pinSymbol = present(
    checker.getExportsOfModule(ownerModule).find((symbol) => symbol.name === 'ModuleSourcePin'),
    'ModuleSourcePin export',
  );
  const sourceProperty = present(
    checker.getDeclaredTypeOfSymbol(pinSymbol).getProperty('source'),
    'ModuleSourcePin.source',
  );
  const reported = checker.getNonNullableType(checker.getTypeOfSymbol(sourceProperty));
  assert.equal(
    checker.isTypeAssignableTo(checker.getStringType(), reported),
    false,
    `ModuleSourcePin.source is ${checker.typeToString(reported)}: a raw string fits it`,
  );
  const brand = reported.aliasSymbol?.name ?? reported.getSymbol()?.name ?? '';
  assert.match(brand, /^[A-Za-z_]\w*$/, 'the reported source type has a name');
  const castsElsewhere = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--', 'tools'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.endsWith('.ts') && path !== 'tools/gates/infra-policy/terraform-pins.ts')
    .filter((path) => new RegExp(`\\bas\\s+${brand}\\b|<${brand}>`).test(repoFile(path)));
  assert.deepEqual(castsElsewhere, [], `only terraform-pins.ts makes a ${brand}`);
});

// ---------------------------------------------------------------- nginx

void test('readNginx: comments, quotes, variables, nesting, line numbers', () => {
  const text = [
    'http {', //                                                    1
    '  # add_header X-Commented "x"; { }', //                       2
    '  server {', //                                                3
    '    add_header X-A "semi;colon # not a comment" always;', //   4
    '    location ~* ^/(a|b)\\.js$ {', //                           5
    '      return 200 \'{"ok":true}\';', //                         6
    '      proxy_set_header Host ${host};', //                      7
    '    }', //                                                     8
    '  }', //                                                       9
    '}', //                                                         10
    '',
  ].join('\n');
  const read = readNginx(text);
  assert.deepEqual(read.errors, []);
  const server = nth(present(nth(read.tree, 0).block, 'http block'), 0);
  assert.equal(server.name, 'server');
  assert.equal(server.line, 3);
  const serverBlock = present(server.block, 'server block');
  const header = nth(serverBlock, 0);
  assert.deepEqual(
    [header.name, header.args, header.line],
    ['add_header', ['X-A', 'semi;colon # not a comment', 'always'], 4],
  );
  const location = nth(serverBlock, 1);
  assert.deepEqual(location.args, ['~*', '^/(a|b)\\.js$']);
  const locationBlock = present(location.block, 'location block');
  assert.deepEqual(nth(locationBlock, 0).args, ['200', '{"ok":true}']);
  assert.deepEqual(nth(locationBlock, 1).args, ['Host', '${host}']);
  assert.ok(readNginx('server {\n listen 80;\n').errors.length > 0);
  assert.ok(readNginx('listen 80\n').errors.length > 0, 'a directive without ; is an error');
});

void test('readNginx returns on every input; only space, tab, CR and LF separate words', () => {
  // nginx's lexer (ngx_conf_read_token) separates on those four only, so a BOM or a no-break
  // space is part of a word and nginx rejects it as an unknown directive. A word loop that
  // stopped on any other whitespace consumed nothing and looped forever.
  const bom = readNginx('\uFEFFserver { listen 80; }');
  assert.deepEqual(
    bom.tree.map((d) => d.name),
    ['\uFEFFserver'],
  );
  const nbsp = readNginx('server {\u00A0listen 80; }');
  assert.deepEqual(
    present(nth(nbsp.tree, 0).block, 'server block').map((d) => [d.name, d.args]),
    [['\u00A0listen', ['80']]],
  );
  assert.deepEqual(readNginx('server {\f listen 80; }\v').errors, [
    // The error names the kind of failure, never the word it failed on (read-error.ts).
    { line: 1, message: 'directive has no ; or {' },
  ]);
  const alphabet = ['{', '}', ';', '#', '"', "'", '\\', '$', 'a', ' ', '\n'];
  const exotic = ['\u00A0', '\f', '\v', '\uFEFF', '\u2028'];
  let inputs = [''];
  for (let length = 1; length <= 4; length += 1) {
    inputs = inputs.flatMap((prefix) => [...alphabet, ...exotic].map((c) => prefix + c));
    for (const input of inputs) readNginx(input);
  }
});

void test('headerInheritanceDrops: 3-level inheritance reports declared and dropped headers', () => {
  const sec = '/etc/nginx/snippets/sec.conf';
  const tree = readNginx(
    [
      'http {',
      '  add_header X-Http "h";',
      '  server {',
      '    add_header Strict-Transport-Security "s" always;',
      '    add_header X-Frame-Options DENY always;',
      '    location / {',
      '      location /a/ { add_header Cache-Control "no-store"; }',
      `      location /b/ { add_header Cache-Control "no-store"; include ${sec}; }`,
      '    }',
      '    location /c/ { proxy_pass http://c; }',
      '    location /d/ { if ($x) { add_header X-If 1; } }',
      '    location /e/ { add_header strict-transport-security "s2"; }',
      `    location /f/ { include ${sec}; }`,
      '  }',
      '  server {',
      '    add_header X-Extra "e";',
      `    include ${sec};`,
      // The include re-applies the snippet only: X-Extra is still dropped here and in /h/.
      `    location /g/ { add_header Cache-Control "no-store"; include ${sec}; }`,
      `    location /h/ { include ${sec}; }`,
      '  }',
      '}',
      '',
    ].join('\n'),
  ).tree;
  const options = {
    includedHeaders: new Map([[sec, ['Strict-Transport-Security', 'X-Frame-Options']]]),
  };
  assert.deepEqual(
    headerInheritanceDrops(tree, options).map((d) => [
      d.context,
      d.location,
      d.declared,
      d.dropped,
    ]),
    [
      ['server', '', ['Strict-Transport-Security', 'X-Frame-Options'], ['X-Http']],
      ['location', '/a/', ['Cache-Control'], ['Strict-Transport-Security', 'X-Frame-Options']],
      ['if', '($x)', ['X-If'], ['Strict-Transport-Security', 'X-Frame-Options']],
      // A level re-declaring an inherited header (any case) does not drop it.
      ['location', '/e/', ['strict-transport-security'], ['X-Frame-Options']],
      ['server', '', ['X-Extra', 'Strict-Transport-Security', 'X-Frame-Options'], ['X-Http']],
      [
        'location',
        '/g/',
        ['Cache-Control', 'Strict-Transport-Security', 'X-Frame-Options'],
        ['X-Extra'],
      ],
      ['location', '/h/', ['Strict-Transport-Security', 'X-Frame-Options'], ['X-Extra']],
    ],
  );
  // Every level is listed, dropping or not: /b/ and /f/ re-apply the whole inherited set through
  // the include, /c/ sets nothing and inherits everything.
  const levels = headerLevels(tree, options);
  const at = (location: string): [readonly string[], readonly string[]] => {
    const level = present(
      levels.find((l) => l.location === location),
      `${location} level`,
    );
    return [level.declared, level.dropped];
  };
  assert.deepEqual(at('/b/'), [
    ['Cache-Control', 'Strict-Transport-Security', 'X-Frame-Options'],
    [],
  ]);
  assert.deepEqual(at('/f/'), [['Strict-Transport-Security', 'X-Frame-Options'], []]);
  assert.deepEqual(at('/c/'), [[], []]);
});

void test('headerInheritanceDrops on aquamobil.conf: /health is a raw drop, no Cache-Control drop', () => {
  const snippet = addHeaderNames(
    readNginx(repoFile('infrastructure/docker/nginx/snippets/security-headers.conf')).tree,
  );
  assert.deepEqual(snippet, [
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'Content-Security-Policy',
  ]);
  const include = '/etc/nginx/snippets/security-headers.conf';
  const drops = headerInheritanceDrops(
    readNginx(repoFile('infrastructure/docker/nginx/aquamobil.conf')).tree,
    { includedHeaders: new Map([[include, snippet]]) },
  );
  assert.deepEqual(
    drops.map((d) => [d.location, d.declared, d.dropped]),
    [['/health', ['Content-Type'], snippet]],
  );
});

void test('headerInheritanceDrops on droplet.conf: /remotes/dashboard/ drops the CSP', () => {
  const drops = headerInheritanceDrops(
    readNginx(repoFile('infrastructure/nginx/droplet.conf')).tree,
    {
      includedHeaders: new Map(),
    },
  );
  const dashboard = drops.find((d) => d.location === '/remotes/dashboard/');
  assert.ok(dashboard);
  assert.ok(dashboard.dropped.includes('Content-Security-Policy'));
  assert.ok(dashboard.dropped.includes('Strict-Transport-Security'));
  // /mobile/ sets its own HSTS: it drops the rest of the server set, never HSTS.
  const mobile = present(
    drops.find((d) => d.location === '/mobile/'),
    '/mobile/ drop',
  );
  assert.ok(mobile.declared.includes('Strict-Transport-Security'));
  assert.equal(mobile.dropped.includes('Strict-Transport-Security'), false);
});

// The round-2 review found the include map with a second owner and an unresolved include that
// stopped at its own level (B1, kc/r12-review/REVIEW.txt). These cases pin the fix.
const SECURITY_INCLUDE = '/etc/nginx/snippets/security-headers.conf';
const SECURITY_SNIPPET = 'infrastructure/docker/nginx/snippets/security-headers.conf';

void test('the nginx include map has one owner: the snippet an image delivers, its headers read from the snippet text', () => {
  // WHY: the include target to snippet map lived only in mobile-csp-headers.spec.ts, and the
  // adapter passed an empty map, so ARIA saw every security-headers include as unresolved and a
  // location that lost its include as clean. The owner holds the map once and callers ask it.
  // It does no I/O: the caller passes the reader (the adapter reads through adapter-fs.ts).
  const includes = headerOwnerExport('SNIPPET_INCLUDES');
  assert.ok(includes instanceof Map, 'SNIPPET_INCLUDES maps each include target to its repo path');
  assert.equal(includes.get(SECURITY_INCLUDE), SECURITY_SNIPPET);
  // Each pairing is what an image does: a tracked Dockerfile COPYs the snippet to the target,
  // so the map cannot name a target nginx never reads or a snippet no image ships.
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dockerfileTexts = trackedFiles()
    .filter((path) => classifyInfraFile(path) === 'dockerfile')
    .map((path) => repoFile(path));
  for (const [target, snippet] of includes) {
    assert.equal(typeof target, 'string');
    assert.equal(typeof snippet, 'string');
    const copy = new RegExp(
      `^\\s*COPY\\s+(?:--\\S+\\s+)*${escape(String(snippet))}\\s+${escape(String(target))}\\s*$`,
      'm',
    );
    assert.ok(
      dockerfileTexts.some((text) => copy.test(text)),
      `a tracked Dockerfile COPYs ${String(snippet)} to ${String(target)}`,
    );
  }

  const build = headerOwnerExport('includedHeadersFrom');
  assert.equal(typeof build, 'function', 'includedHeadersFrom(readRepoFile) builds the map');
  if (typeof build !== 'function') return;
  /** includedHeadersFrom(readRepoFile): the reader returns a repo file's text, or null. */
  const includedHeadersFrom = (readRepoFile: (path: string) => string | null): unknown =>
    Reflect.apply(build, undefined, [readRepoFile]);
  const asked: string[] = [];
  const fromRepo = includedHeadersFrom((path: string): string => {
    asked.push(path);
    return repoFile(path);
  });
  assert.ok(fromRepo instanceof Map);
  assert.deepEqual(asked.sort(), [...includes.values()].map(String).sort(), 'each snippet, once');
  assert.deepEqual([...fromRepo.keys()].sort(), [...includes.keys()].sort());
  assert.deepEqual(
    fromRepo.get(SECURITY_INCLUDE),
    addHeaderNames(readNginx(repoFile(SECURITY_SNIPPET)).tree),
  );
  // Derived, not restated: the headers are whatever the snippet text sets.
  const other = includedHeadersFrom((): string => 'add_header X-Only-This "1" always;\n');
  assert.ok(other instanceof Map);
  assert.deepEqual(other.get(SECURITY_INCLUDE), ['X-Only-This']);
  // Fail closed: a snippet that cannot be read, or reads with errors, is not known, so its
  // include stays unresolved instead of counting as one that adds nothing.
  const unreadable = includedHeadersFrom((): null => null);
  assert.ok(unreadable instanceof Map);
  assert.equal(unreadable.has(SECURITY_INCLUDE), false, 'an unreadable snippet is not known');
  const broken = includedHeadersFrom((): string => 'add_header X-Half "1"\n');
  assert.ok(broken instanceof Map);
  assert.equal(broken.has(SECURITY_INCLUDE), false, 'a snippet with read errors is not known');
});

void test('every caller of the header owner takes the include map from it and builds none of its own', () => {
  // A caller that builds its own map is the second owner B1 names (mobile-csp-headers.spec.ts
  // :30,72-74); one that passes an empty map is the adapter's fail-open (adapter.ts:800). This
  // spec builds synthetic maps on purpose and is not a caller.
  const OWNER_FILE = 'tools/gates/infra-policy/nginx-header-inheritance.ts';
  const callers = trackedFiles().filter(
    (path) =>
      path.endsWith('.ts') &&
      path !== OWNER_FILE &&
      path !== 'tools/gates/infra-policy/infra-policy.spec.ts' &&
      /infra-policy\/nginx-header-inheritance['"]/.test(repoFile(path)) &&
      /\b(?:headerLevels|headerInheritanceDrops)\s*\(/.test(repoFile(path)),
  );
  for (const known of [
    'tests/invariants/mobile-csp-headers.spec.ts',
    'tools/aria-adapters/infrastructure-policy-adapter.ts',
  ]) {
    assert.ok(callers.includes(known), `${known} asks the header owner`);
  }
  for (const caller of callers) {
    const text = repoFile(caller);
    assert.equal(
      /includedHeaders\s*:\s*new Map\b/.test(text),
      false,
      `${caller} builds its own include map`,
    );
    assert.ok(/\bincludedHeadersFrom\s*\(/.test(text), `${caller} takes the map from the owner`);
  }
});

void test('an include the owner cannot see is inherited, as unresolved, by every level under it', () => {
  // WHY: what an unseen include adds is unknown, and a level under it inherits that unknown:
  // with nothing known, aquamobil.conf's server include (:45) left /assets/ and /health reading
  // clean, though each sets its own header and so drops whatever the include adds. A parent's
  // unseen include can only add to what a child that sets its own headers loses, so the drops
  // the owner does see stay certain (droplet.conf's http-level mime.types include must not
  // silence /remotes/dashboard/).
  const UNSEEN = '/etc/nginx/unseen.conf';
  const UNSEEN_C = '/etc/nginx/unseen-c.conf';
  const tree = readNginx(
    [
      'server {', //                                                1
      '  add_header X-Frame-Options DENY always;', //               2
      `  include ${UNSEEN};`, //                                    3
      '  location /a/ { add_header Cache-Control "no-store"; }', // 4
      '  location /b/ { try_files $uri =404; }', //                 5
      '  location /c/ {', //                                        6
      `    include ${UNSEEN_C};`, //                                7
      '    location /d/ { add_header X-D 1; }', //                  8
      '  }', //                                                     9
      '}', //                                                       10
      'server {', //                                                11
      '  location /e/ { add_header Cache-Control "no-store"; }', // 12
      '}', //                                                       13
      '',
    ].join('\n'),
  ).tree;
  const inherited = (level: headerOwner.HeaderLevel): unknown =>
    'inheritedUnresolvedIncludes' in level ? level.inheritedUnresolvedIncludes : 'absent';
  assert.deepEqual(
    headerLevels(tree, { includedHeaders: new Map() }).map((level) => [
      level.line,
      level.location,
      level.unresolvedIncludes,
      inherited(level),
      level.dropped,
    ]),
    [
      [1, '', [UNSEEN], [], []],
      [4, '/a/', [], [UNSEEN], ['X-Frame-Options']],
      [5, '/b/', [], [UNSEEN], []],
      [6, '/c/', [UNSEEN_C], [UNSEEN], []],
      // Outermost first: /d/ sits under the server's include and /c/'s.
      [8, '/d/', [], [UNSEEN, UNSEEN_C], ['X-Frame-Options']],
      [11, '', [], [], []],
      [12, '/e/', [], [], []],
    ],
  );

  // aquamobil.conf with nothing known: the server's include reaches /health (:48) and every
  // location under the server, so none of them reads as clean.
  const levels = headerLevels(
    readNginx(repoFile('infrastructure/docker/nginx/aquamobil.conf')).tree,
    { includedHeaders: new Map() },
  );
  const health = present(
    levels.find((level) => level.location === '/health'),
    'aquamobil.conf /health level',
  );
  assert.equal(health.line, 48);
  assert.deepEqual(inherited(health), [SECURITY_INCLUDE]);
  for (const level of levels.filter((l) => l.context !== 'server')) {
    const all = [...level.unresolvedIncludes, ...[inherited(level)].flat()];
    assert.ok(all.includes(SECURITY_INCLUDE), `${level.location} sees the unseen include`);
  }
});

// ---------------------------------------------------------------- NATS

void test('readNatsConf: separators, maps, arrays, includes, comments, quotes', () => {
  const text = [
    'listen: 0.0.0.0:4222', //                        1
    'http_port = 8222', //                            2
    'server_name nats-1 # trailing comment', //       3
    '// a slash comment', //                          4
    'authorization {', //                             5
    '  # password: commented', //                     6
    '  users: [', //                                  7
    '    { user: "CN=a#b", permissions: { publish: { allow: ["x.>", "y"] } } },', // 8
    '  ]', //                                         9
    '}', //                                           10
    'include nats-tls.conf', //                       11
    '',
  ].join('\n');
  const read = readNatsConf(text);
  assert.deepEqual(read.errors, []);
  assert.deepEqual(
    read.tree.map((e) => [e.key, e.line]),
    [
      ['listen', 1],
      ['http_port', 2],
      ['server_name', 3],
      ['authorization', 5],
      ['include', 11],
    ],
  );
  const listen = nth(read.tree, 0).value;
  assert.ok(listen.kind === 'scalar');
  assert.equal(listen.raw, '0.0.0.0:4222');
  const server = nth(read.tree, 2).value;
  assert.ok(server.kind === 'scalar');
  assert.equal(server.raw, 'nats-1');
  const auth = nth(read.tree, 3).value;
  assert.ok(auth.kind === 'map');
  assert.deepEqual(
    auth.entries.map((e) => e.key),
    ['users'],
  );
  assert.ok(readNatsConf('authorization {\n  user: a\n').errors.length > 0);
});

void test('readNatsConf returns on every input: a stray } inside an array is an error', () => {
  // A value scan that consumes nothing on `}` used to loop forever inside `[...]`, so a typo
  // between `# END GENERATED` and the `]` of `users: [` hung the e2e gate instead of failing it.
  assert.ok(readNatsConf('a: [ } ]').errors.length > 0);
  assert.ok(readNatsConf('authorization { users: [ { user: "CN=a" } } ] }').errors.length > 0);
  const lines = repoFile('infrastructure/docker/nats/nats.conf').split('\n');
  const end = lines.findIndex((line) => line.includes('# END GENERATED'));
  assert.ok(end >= 0, 'nats.conf has an END GENERATED sentinel');
  const typo = [...lines.slice(0, end + 1), '    }', ...lines.slice(end + 1)].join('\n');
  assert.ok(readNatsConf(typo).errors.length > 0);
  // Every input of up to 4 structural characters terminates: each loop step consumes input.
  const alphabet = ['{', '}', '[', ']', ':', '=', ',', ';', '#', '/', '"', "'", 'a', '\n', ' '];
  let inputs = [''];
  for (let length = 1; length <= 4; length += 1) {
    inputs = inputs.flatMap((prefix) => alphabet.map((c) => prefix + c));
    for (const input of inputs) readNatsConf(input);
  }
});

void test('readers refuse nesting past a depth bound with a named error, never a stack overflow', () => {
  // The NATS, nginx and HCL readers descend recursively. 5000 levels (20 KB) overflowed the
  // stack, so a RangeError escaped readers whose contract is to return errors (read-error.ts):
  // the corpus test failed naming no file, and an adapter scan would abort instead of recording
  // one parse_error.
  const DEEP = 10_000;
  const SHALLOW = 32;
  const nested: Array<[string, (depth: number) => { readonly errors: readonly ReadError[] }]> = [
    ['nats map', (d) => readNatsConf(`${'a {'.repeat(d)}${'}'.repeat(d)}`)],
    ['nats array', (d) => readNatsConf(`a: ${'['.repeat(d)}${']'.repeat(d)}`)],
    ['nginx block', (d) => readNginx(`${'http {'.repeat(d)}${'}'.repeat(d)}`)],
    ['hcl block', (d) => readHclBlocks(`${'a {\n'.repeat(d)}${'}\n'.repeat(d)}`)],
    ['hcl object', (d) => readHclBlocks(`a = ${'{ b = '.repeat(d)}1${' }'.repeat(d)}\n`)],
  ];
  const outcome = (read: () => { readonly errors: readonly ReadError[] }): string[] | string => {
    try {
      return read().errors.map((error) => error.message);
    } catch (error) {
      return `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
  };
  for (const [label, read] of nested) {
    assert.deepEqual(
      outcome(() => read(SHALLOW)),
      [],
      `${label}: ${SHALLOW} levels read clean`,
    );
    const deep = outcome(() => read(DEEP));
    assert.ok(Array.isArray(deep), `${label}: ${DEEP} levels ${String(deep)}`);
    assert.ok(
      deep.some((message) => /nest|depth/i.test(message)),
      `${label}: ${DEEP} levels return a read error that names the nesting (${JSON.stringify(deep)})`,
    );
  }
});

void test('a read error carries the position and the kind of what failed, never the text it failed on', () => {
  // WHY: a read error becomes the adapter's infrastructure_parse_failure observation, which
  // ARIA keeps in its state and evidence. hcl-blocks.ts built `unexpected ${token.text}`, so a
  // malformed .tf with a credential on its own line put the credential there (kc/r12r2-review
  // probe-leak.log, ws/tf4); the same holds for every reader that quotes what it could not read:
  // an HCL block or attribute name, number, heredoc or heredoc delimiter, an nginx directive
  // name, a Dockerfile instruction, escape directive or heredoc delimiter, a YAML alias, escape
  // or block scalar header. Each format the classifier owns, except the Helm template no reader parses, has a
  // case here; a new format without one fails the coverage check.
  const S = 'Cr7Xv2Np9Lk4Wm8Q';
  // A credential that is all digits (a PIN, an account number) is a number token in HCL.
  const N = '48151623429071';
  const cases: ReadonlyArray<readonly [InfraFormat, string]> = [
    ['terraform', `module "a" {\n  source = "./x"\n}\n${S}\n`],
    ['terraform', `module "a" {\n  "${S}"\n}\n`],
    ['terraform', `access_key = "x"\nsecret = <<${S}\nbody\n`],
    ['terraform', `${S} =\n`],
    // A heredoc token's text is its whole body; a number token is the number.
    ['terraform', `<<EOT\n${S}\nEOT\n`],
    ['terraform', `module "a" <<EOT\n${S}\nEOT\n{\n}\n`],
    ['terraform', `${N} = 1\n`],
    ['terraform', `module "a" ${N} {\n}\n`],
    ['nginx', `server {\n  listen 80;\n}\n${S}\n`],
    ['nginx', `server {\n  auth_basic "${S}\n}\n`],
    ['nats', `authorization {\n  password: "${S}\n}\n`],
    ['nats', `port: 4222\n"${S}"\n`],
    ['nats', `authorization {\n  token: ${S}\n`],
    ['compose', `services:\n  app:\n    environment:\n      DB_PASSWORD: *${S}\n`],
    ['compose', `services:\n  app:\n    environment:\n      DB_PASSWORD: "\\u${S}"\n`],
    ['k8s', `apiVersion: v1\nkind: Secret\nstringData:\n  token: "\\u${S}"\n`],
    ['k8s', `apiVersion: v1\nkind: Secret\nstringData:\n  token: *${S}\n`],
    ['helm_values', `auth:\n  password: |${S}\n    x\n`],
    ['helm_chart', `apiVersion: v2\nname: *${S}\n`],
    ['dockerfile', `FROM node:22\n${S}\n`],
    ['dockerfile', `# escape=${S}\nFROM node:22\n`],
    ['dockerfile', `FROM node:22\nRUN <<${S}\necho\n`],
  ];
  assert.deepEqual(
    INFRA_FORMATS.filter(
      (format) => format !== 'helm_template' && !cases.some(([covered]) => covered === format),
    ),
    [],
    'every format a reader reads has a case',
  );
  const leaks: string[] = [];
  for (const [format, text] of cases) {
    const { read } = readInfraFile(format, text);
    assert.ok(read !== null, `${format} has a reader`);
    const lines = text.split('\n').length;
    assert.ok(read.errors.length > 0, `${format} ${JSON.stringify(text)} is a read failure`);
    for (const error of read.errors) {
      assert.ok(
        Number.isInteger(error.line) && error.line >= 1 && error.line <= lines,
        `${format}: the error keeps a line inside the file (${JSON.stringify(error)})`,
      );
      assert.ok(error.message.length > 0, `${format}: the error names what failed`);
    }
    const errorText = JSON.stringify(read.errors);
    const windows = [S, N].flatMap((literal) => credentialWindowsIn(errorText, literal));
    if (windows.length > 0) leaks.push(`${format} ${errorText}`);
  }
  assert.deepEqual(leaks, [], 'no read error carries any part of the text it failed on');
});

void test('natsCredentialAuth flags credential identity, not cert identity or comments', () => {
  const read = readNatsConf(
    [
      'authorization {',
      '  user: $NATS_USER',
      '  password: $NATS_PASS',
      '  # token: commented-out',
      '  users = [ { user: "CN=ok" }, { user: admin, pass: "x" } ]',
      '}',
      'accounts { A { users: [ { nkey: UABC } ] } }',
      'cluster { authorization { token: t } }',
      // nats-server reads `username` as `user` (opts.go: `case "user", "username"`), keys
      // case-insensitively; a quoted "$NAME" is a literal string, not a variable.
      'leafnodes { authorization { users: [ { username: $NATS_X_USER }, { USERNAME: admin } ] } }',
      'websocket { authorization { user: "$LITERAL" } }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  assert.deepEqual(
    natsCredentialAuth(read.tree).map((h) => [h.kind, h.key, h.line]),
    [
      ['interpolated_user', 'user', 2],
      ['password', 'password', 3],
      ['non_cert_user', 'user', 5],
      ['password', 'pass', 5],
      ['nkey', 'nkey', 7],
      ['token', 'token', 8],
      ['interpolated_user', 'username', 9],
      ['non_cert_user', 'USERNAME', 9],
      ['non_cert_user', 'user', 10],
    ],
  );
  // The real true positive by kind; line numbers of a repository file are not pinned here.
  const enabled = readNatsConf(repoFile('infrastructure/docker/nats/nats-auth-enabled.conf'));
  assert.deepEqual(
    natsCredentialAuth(enabled.tree).map((h) => [h.kind, h.key]),
    [
      ['interpolated_user', 'user'],
      ['password', 'password'],
    ],
  );
  assert.deepEqual(
    natsCredentialAuth(readNatsConf(repoFile('infrastructure/docker/nats/nats.conf')).tree),
    [],
  );
});

void test('natsCredentialAuth locates a password, token or nkey and never carries its value', () => {
  // A hit becomes the e2e failure message (CI log) and, through the infrastructure-policy
  // adapter, an ARIA finding, evidence and state that outlive rotating the credential. The
  // sibling owner already rules this: HiddenSecret (secret-allowlist-premise.ts) carries the
  // length, never the value. A user name or certificate DN is not a secret and keeps its value.
  const literals = {
    password: 'Pw-literal-91827364',
    pass: 'Ps-literal-55501234',
    token: 'Tk-literal-10293847',
    nkey: 'UAXNKEYLITERAL4Q5R6S7T8U9V0W1X2Y3Z4A5B6C7D8E9F0G1H2',
  } as const;
  const read = readNatsConf(
    [
      'authorization {', //                                                  1
      `  password: "${literals.password}"`, //                               2
      `  token: ${literals.token}`, //                                       3
      `  users = [ { user: admin, pass: "${literals.pass}" }, { nkey: ${literals.nkey} } ]`, // 4
      '}', //                                                                5
      '',
    ].join('\n'),
  );
  assert.deepEqual(read.errors, []);
  const hits = natsCredentialAuth(read.tree);
  const secretKinds: ReadonlySet<string> = new Set(['password', 'token', 'nkey']);
  const secrets = hits.filter((hit) => secretKinds.has(hit.kind));
  assert.deepEqual(
    secrets.map((hit) => [hit.kind, hit.key, hit.line]),
    [
      ['password', 'password', 2],
      ['token', 'token', 3],
      ['password', 'pass', 4],
      ['nkey', 'nkey', 4],
    ],
    'every credential is still found',
  );
  const serialised = JSON.stringify(hits);
  for (const [key, literal] of Object.entries(literals)) {
    assert.equal(serialised.includes(literal), false, `the ${key} literal is in the hits`);
  }
  assert.deepEqual(
    secrets.map((hit) => ('secretLength' in hit ? hit.secretLength : null)),
    [literals.password.length, literals.token.length, literals.pass.length, literals.nkey.length],
    'a secret hit carries the length of the value instead (as HiddenSecret does)',
  );
  assert.deepEqual(
    hits
      .filter((hit) => !secretKinds.has(hit.kind))
      .map((hit) => [hit.kind, 'value' in hit ? hit.value : null]),
    [['non_cert_user', 'admin']],
    'a user name is not a secret: it keeps its value',
  );
});

// ---------------------------------------------------------------- image references

void test('parseImageReference / imagePinVerdict', () => {
  const digest = 'sha256:' + 'c'.repeat(64);
  const table: Array<[string, string | null, string, string | null, string]> = [
    // ref, registry, name, tag, verdict
    ['redis:7-alpine', null, 'redis', '7-alpine', 'floating'],
    ['redis', null, 'redis', null, 'implicit_latest'],
    ['nats:2.10.24-alpine', null, 'nats', '2.10.24-alpine', 'exact_version'],
    ['postgres:latest', null, 'postgres', 'latest', 'floating'],
    ['timescale/timescaledb-ha:pg16', null, 'timescale/timescaledb-ha', 'pg16', 'opaque_tag'],
    [`node:22@${digest}`, null, 'node', '22', 'digest'],
    ['localhost:5000/img:1', 'localhost:5000', 'localhost:5000/img', '1', 'floating'],
    ['localhost:5000/img', 'localhost:5000', 'localhost:5000/img', null, 'implicit_latest'],
    [
      'ghcr.io/okan-wqm/aquaculture_platform/gateway-api:${TAG:?TAG required}',
      'ghcr.io',
      'ghcr.io/okan-wqm/aquaculture_platform/gateway-api',
      '${TAG:?TAG required}',
      'interpolated_required',
    ],
    [
      'ghcr.io/o/x:${TAG:-latest}',
      'ghcr.io',
      'ghcr.io/o/x',
      '${TAG:-latest}',
      'interpolated_default',
    ],
    ['ghcr.io/o/x:${TAG}', 'ghcr.io', 'ghcr.io/o/x', '${TAG}', 'interpolated_unchecked'],
    // One required and one defaulted variable: the tag can still fall back, so it is not required.
    [
      'ghcr.io/o/x:${A:?a}-${B:-b}',
      'ghcr.io',
      'ghcr.io/o/x',
      '${A:?a}-${B:-b}',
      'interpolated_default',
    ],
    ['ghcr.io/o/x:${A:?a}-$B', 'ghcr.io', 'ghcr.io/o/x', '${A:?a}-$B', 'interpolated_unchecked'],
    [
      'ghcr.io/o/x:${{ env.TAG }}',
      'ghcr.io',
      'ghcr.io/o/x',
      '${{ env.TAG }}',
      'interpolated_unchecked',
    ],
    [
      'quay.io/minio/minio:RELEASE.2025-04-03T14-56-28Z',
      'quay.io',
      'quay.io/minio/minio',
      'RELEASE.2025-04-03T14-56-28Z',
      'opaque_tag',
    ],
    ['rust:1.88-slim', null, 'rust', '1.88-slim', 'floating'],
    ['img:1234abc', null, 'img', '1234abc', 'opaque_tag'],
  ];
  for (const [raw, registry, name, tag, verdict] of table) {
    const ref = parseImageReference(raw);
    assert.deepEqual(
      [ref.registry, ref.name, ref.tag, imagePinVerdict(ref)],
      [registry, name, tag, verdict],
      raw,
    );
  }
  assert.equal(parseImageReference(`node@${digest}`).digest, digest);
  // PIN_MUTABILITY is a Record over the verdict union, so a new verdict without an entry does
  // not compile (it cannot default to immutable).
  assert.deepEqual(
    Object.entries(PIN_MUTABILITY)
      .filter(([, mutability]) => mutability === 'immutable')
      .map(([verdict]) => verdict),
    ['digest', 'interpolated_required'],
  );
});

// ---------------------------------------------------------------- runtime privilege and guards

void test('compose privilege, user and guards', () => {
  const doc = nth(
    readYamlDocuments(
      [
        'x-limits: &limits',
        '  mem_limit: 256m',
        'services:',
        '  bad:',
        '    privileged: true',
        '    cap_add: [CAP_SYS_ADMIN, CHOWN]',
        '    network_mode: host',
        '    user: "0:0"',
        '    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]',
        '  good:',
        '    <<: *limits',
        '    user: "1000"',
        '    command: ["sh", "-c", "privileged: true"]',
        '    healthcheck: { test: ["CMD", "true"] }',
        '  once:',
        '    restart: "no"',
        '  inherits:',
        '    healthcheck: { interval: 5s }',
        '    deploy: { resources: { limits: { memory: 1g } } }',
        '',
      ].join('\n'),
    ).docs,
    0,
  ).value;
  const [bad, good, once, inherits] = composeServices(doc);
  assert.ok(bad && good && once && inherits);
  assert.deepEqual(
    composeServicePrivilege(bad).map((h) => h.reason),
    ['privileged', 'capability', 'host_namespace', 'docker_socket'],
  );
  assert.deepEqual(
    composeServicePrivilege(good),
    [],
    'a quoted lookalike in a command is not a setting',
  );
  assert.equal(composeServiceUser(bad).verdict, 'root');
  assert.equal(composeServiceUser(good).verdict, 'non_root');
  assert.equal(composeServiceUser(once).verdict, 'unset');

  assert.deepEqual(composeGuards(good, { imageHealthcheck: 'absent' }).missing, []);
  assert.deepEqual(composeGuards(bad, { imageHealthcheck: 'absent' }).missing, [
    'healthcheck',
    'memory_limit',
  ]);
  assert.deepEqual(composeGuards(bad, { imageHealthcheck: 'present' }).missing, ['memory_limit']);
  const unresolved = composeGuards(bad, { imageHealthcheck: 'unresolved' });
  assert.deepEqual([unresolved.missing, unresolved.healthUnresolved], [['memory_limit'], true]);
  const oneShot = composeGuards(once, { imageHealthcheck: 'absent' });
  assert.deepEqual([oneShot.missing, oneShot.healthExempt], [['memory_limit'], 'one_shot']);
  assert.deepEqual(
    composeGuards(inherits, { imageHealthcheck: 'absent' }).missing,
    ['healthcheck'],
    'a healthcheck without test only retimes the image HEALTHCHECK',
  );
  assert.deepEqual(composeGuards(inherits, { imageHealthcheck: 'present' }).missing, []);
});

void test('compose privilege: socket-exposing binds, escape capabilities, unconfined profiles', () => {
  const doc = nth(
    readYamlDocuments(
      [
        'services:',
        '  parent:',
        // `:ro` does not stop connect() on a unix socket, so a parent bind exposes it too.
        '    volumes: ["/var/run:/host-run:ro", "/:/rootfs:ro", "/run/:/r", "/var/lib/x:/x"]',
        '  socket:',
        '    volumes: [{ type: bind, source: /var/run/docker.sock/, target: /s }]',
        '  caps:',
        '    cap_add: [SYS_MODULE, sys_ptrace, CAP_SYS_RAWIO, DAC_READ_SEARCH, BPF, CHOWN]',
        '  unconfined:',
        '    security_opt: ["seccomp:unconfined", "apparmor=unconfined", "no-new-privileges:true"]',
        '    userns_mode: host',
        '  stringly:',
        // compose-spec types booleans as boolean|string; the CLI reads "true"/"yes"/"on" as true.
        '    privileged: "true"',
        '  stringly_off:',
        '    privileged: "false"',
        '',
      ].join('\n'),
    ).docs,
    0,
  ).value;
  const reasons = (name: string): [string, string][] => {
    const service = present(
      composeServices(doc).find((s) => s.name === name),
      name,
    );
    return composeServicePrivilege(service).map((h) => [h.reason, h.detail]);
  };
  assert.deepEqual(reasons('parent'), [
    ['docker_socket', 'mounts /var/run'],
    ['docker_socket', 'mounts /'],
    ['docker_socket', 'mounts /run/'],
  ]);
  assert.deepEqual(reasons('socket'), [['docker_socket', 'mounts /var/run/docker.sock/']]);
  assert.deepEqual(
    reasons('caps').map(([reason]) => reason),
    ['capability', 'capability', 'capability', 'capability', 'capability'],
  );
  assert.deepEqual(reasons('unconfined'), [
    ['host_namespace', 'userns_mode: host'],
    ['unconfined', 'security_opt seccomp:unconfined'],
    ['unconfined', 'security_opt apparmor=unconfined'],
  ]);
  assert.deepEqual(reasons('stringly'), [['privileged', 'privileged: true']]);
  assert.deepEqual(reasons('stringly_off'), []);

  // The production cAdvisor binds / and /var/run: the docker socket is reachable from it.
  const droplet = readYamlDocuments(repoFile('docker-compose.droplet.yml'));
  const cadvisor = present(
    composeServices(nth(droplet.docs, 0).value).find((s) => s.name === 'cadvisor'),
    'droplet cadvisor service',
  );
  assert.ok(composeServicePrivilege(cadvisor).some((h) => h.reason === 'docker_socket'));
});

void test('pod privilege, user precedence and guards', () => {
  const doc = readYamlDocuments(
    [
      'kind: Deployment',
      'metadata: { name: api }',
      'spec:',
      '  template:',
      '    spec:',
      '      hostNetwork: true',
      '      securityContext: { runAsUser: 0, runAsNonRoot: false }',
      '      containers:',
      '        - name: app',
      '          securityContext: { runAsUser: 1000, allowPrivilegeEscalation: true }',
      '          resources: { limits: { memory: 1Gi } }',
      '          readinessProbe: { httpGet: { path: /, port: 80 } }',
      '        - name: sidecar',
      '          securityContext: { privileged: true, capabilities: { add: [NET_ADMIN] } }',
      '---',
      'kind: Job',
      'metadata: { name: once }',
      'spec: { template: { spec: { containers: [ { name: j, resources: { limits: { memory: 1Gi } } } ] } } }',
      '',
    ].join('\n'),
  ).docs;
  const [deployment] = k8sWorkloads(nth(doc, 0).value);
  assert.ok(deployment);
  const [app, sidecar] = podContainers(deployment);
  assert.ok(app && sidecar);
  assert.deepEqual(
    podSpecPrivilege(deployment).map((h) => [h.container, h.reason]),
    [
      [null, 'host_namespace'],
      ['app', 'privilege_escalation'],
      ['sidecar', 'privileged'],
      ['sidecar', 'capability'],
    ],
  );
  assert.equal(
    podContainerUser(deployment, app).verdict,
    'non_root',
    'container runAsUser overrides the pod',
  );
  assert.equal(podContainerUser(deployment, sidecar).verdict, 'root', 'the pod runAsUser applies');
  assert.deepEqual(podGuards(deployment, app).missing, ['liveness_probe']);
  assert.deepEqual(podGuards(deployment, sidecar).missing, [
    'memory_limit',
    'readiness_probe',
    'liveness_probe',
  ]);
  const [job] = k8sWorkloads(nth(doc, 1).value);
  assert.ok(job);
  assert.deepEqual(
    podGuards(job, nth(podContainers(job), 0)).missing,
    [],
    'a Job has no probes to miss',
  );

  const [agent] = k8sWorkloads(
    nth(
      readYamlDocuments(
        [
          'kind: DaemonSet',
          'metadata: { name: agent }',
          'spec:',
          '  template:',
          '    spec:',
          '      securityContext: { seccompProfile: { type: Unconfined } }',
          '      volumes:',
          '        - { name: run, hostPath: { path: /var/run } }',
          '        - { name: data, hostPath: { path: /var/lib/agent } }',
          '      containers:',
          '        - name: a',
          '          securityContext:',
          '            appArmorProfile: { type: Unconfined }',
          '            capabilities: { add: [SYS_PTRACE] }',
          '',
        ].join('\n'),
      ).docs,
      0,
    ).value,
  );
  assert.ok(agent);
  assert.deepEqual(
    podSpecPrivilege(agent).map((h) => [h.container, h.reason, h.detail]),
    [
      [null, 'docker_socket', 'hostPath /var/run'],
      [null, 'unconfined', 'securityContext.seccompProfile Unconfined'],
      ['a', 'capability', 'capabilities.add SYS_PTRACE'],
      ['a', 'unconfined', 'securityContext.appArmorProfile Unconfined'],
    ],
  );
});

void test('privilege: socket paths normalised, containerd and CRI-O sockets, binds that climb out are unresolved', () => {
  // exposesDockerSocket dropped only empty segments and knew docker.sock alone, and a relative
  // bind source returned "safe": each bind below gives the container a runtime socket and none
  // was reported (verify-security-1 socket-probe). compose resolves a relative source against
  // the project directory, the repository checkout: one that stays inside it is project
  // content, one that climbs out of it depends on where the checkout lives, so it is reported
  // unresolved instead of safe.
  const doc = nth(
    readYamlDocuments(
      [
        'services:',
        '  dots:',
        '    volumes: ["/./:/rootfs:ro", "/var/run/./docker.sock:/s", "/var/lib/../run:/r"]',
        '  runtimes:',
        '    volumes:',
        '      - /run/containerd/containerd.sock:/c',
        '      - /var/run/crio/crio.sock:/o',
        '      - /run/containerd:/d',
        '  climbs:',
        '    volumes:',
        '      - ../../../../../../var/run/docker.sock:/s',
        '      - { type: bind, source: ../shared, target: /x }',
        '  project:',
        '    volumes: ["./config:/etc/app:ro", "./a/../b:/b", "pgdata:/var/lib/postgresql/data"]',
        '',
      ].join('\n'),
    ).docs,
    0,
  ).value;
  const reasons = (name: string): [string, string][] =>
    composeServicePrivilege(
      present(
        composeServices(doc).find((s) => s.name === name),
        name,
      ),
    ).map((h) => [h.reason, h.detail]);
  assert.deepEqual(reasons('dots'), [
    ['docker_socket', 'mounts /./'],
    ['docker_socket', 'mounts /var/run/./docker.sock'],
    ['docker_socket', 'mounts /var/lib/../run'],
  ]);
  assert.deepEqual(reasons('runtimes'), [
    ['docker_socket', 'mounts /run/containerd/containerd.sock'],
    ['docker_socket', 'mounts /var/run/crio/crio.sock'],
    ['docker_socket', 'mounts /run/containerd'],
  ]);
  assert.deepEqual(reasons('climbs'), [
    ['unresolved_bind', 'mounts ../../../../../../var/run/docker.sock'],
    ['unresolved_bind', 'mounts ../shared'],
  ]);
  assert.deepEqual(reasons('project'), [], 'project content and a named volume are not host paths');

  const [node] = k8sWorkloads(
    nth(
      readYamlDocuments(
        [
          'kind: DaemonSet',
          'metadata: { name: node-agent }',
          'spec:',
          '  template:',
          '    spec:',
          '      volumes:',
          '        - { name: c, hostPath: { path: /run/containerd/containerd.sock } }',
          '        - { name: o, hostPath: { path: /var/run/crio/crio.sock } }',
          '        - { name: r, hostPath: { path: /var/lib/../run } }',
          '      containers: [ { name: a } ]',
          '',
        ].join('\n'),
      ).docs,
      0,
    ).value,
  );
  assert.ok(node);
  assert.deepEqual(
    podSpecPrivilege(node).map((h) => [h.reason, h.detail]),
    [
      ['docker_socket', 'hostPath /run/containerd/containerd.sock'],
      ['docker_socket', 'hostPath /var/run/crio/crio.sock'],
      ['docker_socket', 'hostPath /var/lib/../run'],
    ],
  );
});

// ---------------------------------------------------------------- secret premise

void test('every regex in .gitleaks.toml compiles after the RE2 translation', () => {
  const patterns = gitleaksPatterns(repoFile('.gitleaks.toml'));
  assert.ok(patterns.length >= 20, `found ${patterns.length} patterns`);
  for (const pattern of patterns) {
    assert.doesNotThrow(() => translateRe2(pattern.source), pattern.location);
  }
  assert.equal(translateRe2('(?i)abc').flags.includes('i'), true);
  assert.equal(translateRe2('a\\"b').test('a"b'), true);
  assert.throws(() => translateRe2('a(?i)b'), /cannot be translated/);
  assert.throws(() => translateRe2('[[:alpha:]]'), /cannot be translated/);
  assert.throws(() => translateRe2('\\z'), /cannot be translated/);
});

void test('secretsHiddenByPathAllowlist reports what the env-secret rule would report in hidden files', () => {
  const rule = loadEnvSecretRule(repoFile('.gitleaks.toml'));
  const doc = nth(
    readYamlDocuments(
      [
        'services:',
        '  api:',
        '    environment:',
        '      JWT_SECRET: Abcdefgh12345678',
        '      REDIS_PASSWORD: ${REDIS_PASSWORD}',
        '      POSTGRES_PASSWORD: change-me',
        '      SMTP_PASS: changeme-1234567890',
        '      UNRELATED_KEY: Abcdefgh12345678',
        '',
      ].join('\n'),
    ).docs,
    0,
  );
  const entries = (path: string): StructuredEnvEntry[] =>
    composeServices(doc.value).flatMap((service) =>
      composeEnvironment(service).flatMap((e) =>
        e.value === null
          ? []
          : [{ path, line: doc.lineOf(e.path) ?? 0, key: e.key, value: e.value }],
      ),
    );
  const hidden = secretsHiddenByPathAllowlist(entries('deploy/docker-compose.prod.yml'), rule);
  assert.deepEqual(
    hidden.map((h) => [h.path, h.key, h.line, h.secretLength]),
    [['deploy/docker-compose.prod.yml', 'JWT_SECRET', 4, 16]],
  );
  assert.match(nth(hidden, 0).hiddenBy, /docker-compose/);
  // A hit locates the secret; it never carries the value into findings, evidence or state.
  assert.equal(JSON.stringify(hidden).includes('Abcdefgh12345678'), false);
  assert.deepEqual(
    secretsHiddenByPathAllowlist(entries('apps/api/src/config.yml'), rule),
    [],
    'outside the path allowlist gitleaks itself reports it; nothing is hidden',
  );
});

void test('without secretGroup the secret is the first non-empty capture group, as gitleaks reads it', () => {
  // gitleaks v8 (detect.go): with capture groups and no secretGroup, the secret is the first
  // non-empty group; without capture groups it is the whole match. Defaulting to group 0 tested
  // value-shaped allowlists against `KEY=value`, so they never suppressed, and reported the
  // match length as the secret's. tests/invariants/gitleaks-allowlist-reachable.spec.ts
  // documents the same gitleaks rule.
  const toml = (regex: string): string =>
    [
      '[[rules]]',
      `id = "${ENV_SECRET_RULE_ID}"`,
      `regex = '''${regex}'''`,
      '[rules.allowlist]',
      String.raw`paths = ['''(?i)docker-compose[^/]*\.ya?ml$''']`,
      "regexes = ['''^aquaculture-sample-value$''']",
      '',
    ].join('\n');
  const entry = (line: number, key: string, value: string): StructuredEnvEntry => ({
    path: 'docker-compose.yml',
    line,
    key,
    value,
  });
  const entries = [
    entry(1, 'JWT_SECRET', 'Q7vLm2Xp9TzR4wKd'),
    entry(2, 'POSTGRES_PASSWORD', '"Hb4Rn8Wc2Ys6Jt0M"'),
    entry(3, 'POSTGRES_PASSWORD', 'aquaculture-sample-value'),
  ];
  // The quoted and the bare spelling capture in different groups; neither is group 1 for both.
  const grouped = loadEnvSecretRule(
    toml(
      String.raw`(?i)(?:JWT_SECRET|POSTGRES_PASSWORD)\s*[=:]\s*(?:"([^"\s]{12,})"|([A-Za-z0-9+/=_-]{12,}))`,
    ),
  );
  assert.deepEqual(
    secretsHiddenByPathAllowlist(entries, grouped).map((h) => [h.line, h.key, h.secretLength]),
    [
      [1, 'JWT_SECRET', 16],
      [2, 'POSTGRES_PASSWORD', 16],
    ],
    'the value is the secret: its length is reported and the value allowlist suppresses line 3',
  );
  // No capture group: the whole match is the secret, as before.
  const whole = loadEnvSecretRule(toml(String.raw`(?i)JWT_SECRET\s*[=:]\s*[A-Za-z0-9]{12,}`));
  assert.deepEqual(
    secretsHiddenByPathAllowlist(entries, whole).map((h) => [h.line, h.secretLength]),
    [[1, 'JWT_SECRET=Q7vLm2Xp9TzR4wKd'.length]],
  );
});

// ---------------------------------------------------------------- real corpus

void test('every reader reads every tracked file of its format with zero errors', () => {
  const failures: string[] = [];
  const counts = new Map<string, number>();
  for (const path of trackedFiles()) {
    const format = classifyInfraFile(path);
    if (format === null) continue;
    counts.set(format, (counts.get(format) ?? 0) + 1);
    const { read } = readInfraFile(format, repoFile(path));
    if (read === null) continue;
    for (const error of read.errors) failures.push(`${path}:${error.line} ${error.message}`);
  }
  assert.deepEqual(failures, []);
  for (const format of INFRA_FORMATS) {
    if (format === 'helm_template') continue;
    assert.ok((counts.get(format) ?? 0) > 0, `no tracked ${format} file was read`);
  }
});
