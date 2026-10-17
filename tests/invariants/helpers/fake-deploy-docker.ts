/**
 * Fake Docker daemon for the droplet release-rollback and compose-recreate
 * contracts (INFRA-HIGH-230).
 *
 * The deploy scripts are only trustworthy if their Docker side effects are
 * proven, not grepped: the 2026-10-17 incident was a rollback that re-pointed
 * `<svc>:<release-sha>` at the pre-release image and then failed in
 * `docker compose up` on a name conflict left by the previous attempt. This
 * harness records every `docker` invocation (with the `TAG` compose would
 * interpolate) and keeps a tiny image/container model in plain files so a spec
 * can assert which tags moved, which containers were removed and whether
 * compose ran at all.
 *
 * Model (all under `state/`, never inside `bin/`, which is the only directory
 * prepended to PATH):
 *   compose-config.json   output of `docker compose config --format json`
 *   containers.tsv        output of `docker ps -a --no-trunc --format ...`
 *                         (id, name, state, compose project, compose service)
 *   running-names         output of `docker ps --format '{{.Names}}'`
 *   compose-ps/<svc>      container id `docker compose ps -q <svc>` prints
 *   containers/<id>/<f>   inspect fields: health running restarts started
 *                         image exit (exit = "running exitcode finishedAt")
 *   images/<ref>          image id a reference resolves to ('/', ':', '@' -> '_')
 *   psql-output           what `docker exec -i aqua-postgres psql ...` prints
 *   compose-up-fail       when present, `docker compose up` prints it and fails
 *   invocations.log       one line per call: "TAG=<tag>\t<argv...>"
 *   removed.log           container ids passed to `docker rm -f`
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFixtureTree } from '../../../tools/gates/fixture-tree';

export interface FakeContainer {
  id: string;
  name: string;
  state: string;
  project: string;
  service: string;
  health?: string;
  running?: string;
  restarts?: string;
  startedAt?: string;
  image?: string;
}

export interface FakeDockerFixture {
  root: string;
  bin: string;
  state: string;
  writeComposeConfig(project: string, services: Record<string, string>): void;
  addContainer(container: FakeContainer): void;
  setComposePs(service: string, containerId: string): void;
  setRunningNames(names: readonly string[]): void;
  setImage(ref: string, imageId: string): void;
  imageOf(ref: string): string | undefined;
  setPsqlOutput(output: string): void;
  setDbMigrateExit(running: string, exitCode: string, finishedAt: string): void;
  invocations(): string[];
  removed(): string[];
  cleanup(): void;
}

function imageFileName(ref: string): string {
  return ref.replace(/[/:@]/g, '_');
}

const FAKE_DOCKER = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'state="${FAKE_DOCKER_STATE:?}"',
  'printf "TAG=%s\\t%s\\n" "${TAG:-}" "$*" >> "${state}/invocations.log"',
  'image_file() { printf "%s/images/%s" "${state}" "$(printf "%s" "$1" | tr "/:@" "___")"; }',
  'case "${1:-}" in',
  '  compose)',
  '    shift',
  '    while [ "$#" -gt 0 ]; do',
  '      case "$1" in',
  '        -f|--file|-p|--project-name) shift 2 ;;',
  '        *) break ;;',
  '      esac',
  '    done',
  '    case "${1:-}" in',
  '      config) cat "${state}/compose-config.json" ;;',
  '      ps)',
  '        svc="${!#}"',
  '        if [ -f "${state}/compose-ps/${svc}" ]; then cat "${state}/compose-ps/${svc}"; fi',
  '        ;;',
  '      up)',
  '        if [ -f "${state}/compose-up-fail" ]; then cat "${state}/compose-up-fail" >&2; exit 1; fi',
  '        ;;',
  '    esac',
  '    ;;',
  '  ps)',
  '    case " $* " in',
  '      *" -a "*) cat "${state}/containers.tsv" ;;',
  '      *) cat "${state}/running-names" ;;',
  '    esac',
  '    ;;',
  '  rm)',
  '    shift',
  '    [ "${1:-}" != -f ] || shift',
  '    for id in "$@"; do printf "%s\\n" "${id}" >> "${state}/removed.log"; done',
  '    ;;',
  '  inspect)',
  '    shift',
  '    fmt=""',
  '    id=""',
  '    while [ "$#" -gt 0 ]; do',
  '      case "$1" in',
  '        --format=*) fmt="${1#--format=}" ;;',
  '        --format) fmt="$2"; shift ;;',
  '        *) id="$1" ;;',
  '      esac',
  '      shift',
  '    done',
  '    dir="${state}/containers/${id}"',
  '    [ -d "${dir}" ] || { echo "Error: No such object: ${id}" >&2; exit 1; }',
  '    case "${fmt}" in',
  '      *ExitCode*) cat "${dir}/exit" ;;',
  '      *Health*) cat "${dir}/health" ;;',
  '      *RestartCount*) cat "${dir}/restarts" ;;',
  '      *StartedAt*) cat "${dir}/started" ;;',
  '      *State.Running*) cat "${dir}/running" ;;',
  '      *.Image*) cat "${dir}/image" ;;',
  '      *) echo "fake docker: unsupported inspect format ${fmt}" >&2; exit 2 ;;',
  '    esac',
  '    ;;',
  '  image)',
  '    ref="${!#}"',
  '    file="$(image_file "${ref}")"',
  '    [ -f "${file}" ] || { echo "Error: No such image: ${ref}" >&2; exit 1; }',
  '    cat "${file}"',
  '    ;;',
  '  tag)',
  '    src="$2"',
  '    dst="$3"',
  '    case "${src}" in',
  '      sha256:*) id="${src}" ;;',
  '      *)',
  '        file="$(image_file "${src}")"',
  '        [ -f "${file}" ] || { echo "Error: No such image: ${src}" >&2; exit 1; }',
  '        id="$(cat "${file}")"',
  '        ;;',
  '    esac',
  '    printf "%s\\n" "${id}" > "$(image_file "${dst}")"',
  '    ;;',
  '  exec)',
  '    cat > /dev/null',
  '    [ -f "${state}/psql-output" ] || exit 1',
  '    cat "${state}/psql-output"',
  '    ;;',
  '  *) echo "fake docker: unsupported command $*" >&2; exit 2 ;;',
  'esac',
  '',
].join('\n');

export function createFakeDeployDocker(): FakeDockerFixture {
  const root = mkdtempSync(join(tmpdir(), 'aqua-fake-deploy-docker-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  for (const dir of [bin, state, join(state, 'compose-ps'), join(state, 'containers')]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(join(state, 'images'));
  writeFileSync(join(state, 'containers.tsv'), '');
  writeFileSync(join(state, 'running-names'), '');
  writeFileSync(join(state, 'invocations.log'), '');
  writeFileSync(join(state, 'removed.log'), '');
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);

  const containerDir = (id: string): string => {
    const dir = join(state, 'containers', id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  return {
    root,
    bin,
    state,
    writeComposeConfig(project, services): void {
      const config = {
        name: project,
        services: Object.fromEntries(
          Object.entries(services).map(([service, containerName]) => [
            service,
            { container_name: containerName },
          ]),
        ),
      };
      writeFileSync(join(state, 'compose-config.json'), `${JSON.stringify(config)}\n`);
    },
    addContainer(container): void {
      const row = [
        container.id,
        container.name,
        container.state,
        container.project,
        container.service,
      ].join('\t');
      writeFileSync(join(state, 'containers.tsv'), `${row}\n`, { flag: 'a' });
      const dir = containerDir(container.id);
      writeFileSync(join(dir, 'health'), `${container.health ?? 'healthy'}\n`);
      writeFileSync(join(dir, 'running'), `${container.running ?? 'true'}\n`);
      writeFileSync(join(dir, 'restarts'), `${container.restarts ?? '0'}\n`);
      writeFileSync(join(dir, 'started'), `${container.startedAt ?? '2026-10-17T09:00:00Z'}\n`);
      writeFileSync(join(dir, 'image'), `${container.image ?? ''}\n`);
    },
    setComposePs(service, containerId): void {
      writeFileSync(join(state, 'compose-ps', service), `${containerId}\n`);
    },
    setRunningNames(names): void {
      writeFileSync(join(state, 'running-names'), names.map((name) => `${name}\n`).join(''));
    },
    setImage(ref, imageId): void {
      writeFileSync(join(state, 'images', imageFileName(ref)), `${imageId}\n`);
    },
    imageOf(ref): string | undefined {
      const file = join(state, 'images', imageFileName(ref));
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
    },
    setPsqlOutput(output): void {
      writeFileSync(join(state, 'psql-output'), output);
    },
    setDbMigrateExit(running, exitCode, finishedAt): void {
      writeFileSync(
        join(containerDir('aqua-db-migrate'), 'exit'),
        `${running} ${exitCode} ${finishedAt}\n`,
      );
    },
    invocations(): string[] {
      return readFileSync(join(state, 'invocations.log'), 'utf8').split('\n').filter(Boolean);
    },
    removed(): string[] {
      return readFileSync(join(state, 'removed.log'), 'utf8').split('\n').filter(Boolean);
    },
    cleanup(): void {
      removeFixtureTree(root);
    },
  };
}
