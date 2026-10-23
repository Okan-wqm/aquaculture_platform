/**
 * Runtime privilege and runtime user — the one owner for compose, Kubernetes and Dockerfile
 * (ARIA-HIGH-012).
 *
 * WHY structural: `privileged: true` inside a quoted command string, or `USER root` in a build
 * stage that the final image does not inherit, are not settings. These functions read the
 * parsed objects (workloads.ts, dockerfile.ts), so only effective configuration counts.
 * Kubernetes precedence follows the API: a container securityContext field overrides the pod
 * securityContext field of the same name; privileged, allowPrivilegeEscalation and
 * capabilities exist only per container; host namespaces only per pod.
 */
import { posix } from 'node:path';

import type { DockerfileRead, DockerStage } from '../lib/infra/dockerfile';
import {
  asMap,
  type ComposeService,
  type K8sContainer,
  type K8sWorkload,
  podContainers,
  yamlAt,
} from '../lib/infra/workloads';
import type { YamlPath } from '../lib/infra/yaml-documents';

export type PrivilegeReason =
  | 'privileged'
  | 'capability'
  | 'host_namespace'
  /** A container runtime socket (docker, containerd, CRI-O) or a directory above one. */
  | 'docker_socket'
  | 'privilege_escalation'
  /** seccomp or AppArmor confinement switched off. */
  | 'unconfined'
  /**
   * A host bind whose source this owner cannot place: a relative path that climbs out of the
   * compose project directory, a `~` or `$VAR` path, or a non-absolute hostPath. Where it lands
   * depends on the checkout and the environment, so it is reported, never read as safe.
   */
  | 'unresolved_bind';

/**
 * Whether each reason is a proven privilege or a bind this owner could not place. A Record over
 * the union: a new reason without an entry does not compile, so none can default to either.
 */
export const PRIVILEGE_REASON_VERDICT: Readonly<
  Record<PrivilegeReason, 'privileged' | 'unresolved'>
> = {
  privileged: 'privileged',
  capability: 'privileged',
  host_namespace: 'privileged',
  docker_socket: 'privileged',
  privilege_escalation: 'privileged',
  unconfined: 'privileged',
  unresolved_bind: 'unresolved',
};

export interface PrivilegeHit {
  readonly reason: PrivilegeReason;
  readonly detail: string;
  readonly path: YamlPath;
  /** Container name for a Kubernetes hit; null for a pod-level or compose hit. */
  readonly container: string | null;
}

/** Capabilities that amount to host or network control, or a known container escape. */
export const DANGEROUS_CAPABILITIES: ReadonlySet<string> = new Set([
  'ALL',
  'SYS_ADMIN',
  'NET_ADMIN',
  'SYS_MODULE', // load a kernel module
  'SYS_PTRACE', // trace and inject into other processes
  'SYS_RAWIO', // raw I/O ports and /dev/mem
  'DAC_READ_SEARCH', // open_by_handle_at: read any host file ("shocker")
  'BPF', // load eBPF programs
]);
/**
 * Container runtime sockets: whoever reaches one starts containers on the host. Both spellings of
 * each (`/var/run` is `/run` on every current distribution).
 */
const RUNTIME_SOCKETS: readonly string[] = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/run/containerd/containerd.sock',
  '/run/containerd/containerd.sock',
  '/var/run/crio/crio.sock',
  '/run/crio/crio.sock',
];

/**
 * An absolute host path that exposes a runtime socket: the socket itself or any directory above
 * it (`/`, `/var/run`, `/run`, `/run/containerd`). A read-only bind does not help, connect() on a
 * unix socket is not a write. The path is normalised as the kernel resolves it (`.`, `..`,
 * repeated and trailing slashes), so `/./` and `/var/lib/../run` are what they name.
 */
function exposesRuntimeSocket(absoluteHostPath: string): boolean {
  const normal = posix.normalize(absoluteHostPath).replace(/(.)\/+$/, '$1');
  return RUNTIME_SOCKETS.some(
    (socket) => socket === normal || normal === '/' || socket.startsWith(`${normal}/`),
  );
}

/**
 * What a compose bind source names. compose resolves a source that starts with `.` against the
 * project directory (the checkout): one that stays inside it is project content, one that climbs
 * out depends on where the checkout lives. `~` and `$VAR` depend on the environment. A source
 * with none of these shapes is a named volume (https://docs.docker.com/reference/compose-file/services/#volumes).
 */
function composeBindSource(source: string): 'host' | 'project' | 'volume' | 'unresolved' {
  if (source.startsWith('/')) return 'host';
  if (source.startsWith('~') || source.includes('$')) return 'unresolved';
  if (source.startsWith('.')) {
    const normal = posix.normalize(source);
    return normal === '..' || normal.startsWith('../') ? 'unresolved' : 'project';
  }
  return 'volume';
}

/** compose-spec types booleans as boolean | string; the CLI reads these strings as true. */
function composeTrue(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === 'string' && ['true', 'yes', 'y', 'on'].includes(value.toLowerCase()))
  );
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function capabilityName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  return upper.startsWith('CAP_') ? upper.slice(4) : upper;
}

function volumeSource(volume: unknown): string | null {
  if (typeof volume === 'string') return volume.split(':')[0] ?? null;
  const map = asMap(volume);
  return map !== null && typeof map.source === 'string' ? map.source : null;
}

export function composeServicePrivilege(service: ComposeService): PrivilegeHit[] {
  const spec = service.spec;
  const hits: PrivilegeHit[] = [];
  const hit = (
    reason: PrivilegeReason,
    detail: string,
    field: string | number,
    ...rest: (string | number)[]
  ): void => {
    hits.push({ reason, detail, path: [...service.path, field, ...rest], container: null });
  };
  if (composeTrue(spec.privileged)) hit('privileged', 'privileged: true', 'privileged');
  list(spec.cap_add).forEach((cap, index) => {
    const name = capabilityName(cap);
    if (name !== null && DANGEROUS_CAPABILITIES.has(name))
      hit('capability', `cap_add ${name}`, 'cap_add', index);
  });
  for (const field of ['network_mode', 'pid', 'ipc', 'userns_mode'] as const) {
    if (spec[field] === 'host') hit('host_namespace', `${field}: host`, field);
  }
  list(spec.volumes).forEach((volume, index) => {
    const source = volumeSource(volume);
    if (source === null) return;
    const place = composeBindSource(source);
    if (place === 'host' && exposesRuntimeSocket(source))
      hit('docker_socket', `mounts ${source}`, 'volumes', index);
    else if (place === 'unresolved') hit('unresolved_bind', `mounts ${source}`, 'volumes', index);
  });
  list(spec.security_opt).forEach((option, index) => {
    // `seccomp:unconfined`, `seccomp=unconfined`, `apparmor:unconfined`, `apparmor=unconfined`.
    if (typeof option === 'string' && /^(?:seccomp|apparmor)[:=]unconfined$/i.test(option))
      hit('unconfined', `security_opt ${option}`, 'security_opt', index);
  });
  return hits;
}

export type RuntimeUserVerdict =
  | 'root'
  | 'non_root'
  | 'unset'
  /**
   * A user named by a variable (`USER $APP_USER`, compose `user: "${UID}:${GID}"`): a build
   * argument or the environment decides it when the image is built or the service runs, so this
   * owner cannot tell whether it is 0. Reported, never read as non_root (ARIA-HIGH-012 round-3
   * M2), the way an unplaceable bind is `unresolved_bind`.
   */
  | 'unresolved';

export interface RuntimeUser {
  readonly verdict: RuntimeUserVerdict;
  readonly user: string | null;
}

/**
 * The verdict on a Dockerfile USER or compose `user:` value, `user[:group]`; only the user decides
 * whether the process runs as root. Both files expand `$NAME` and `${NAME...}` in it (Dockerfile
 * from ARG/ENV, compose from the environment), so a user with a `$` is unresolved, a `${UID:-0}`
 * default included: the default is only a fallback. A `${UID:-1000}` user has a `:` inside its
 * braces; the part before the first `:` still holds its `$`, so it is unresolved as a whole.
 */
function userVerdict(user: string): RuntimeUserVerdict {
  const colon = user.indexOf(':');
  const name = (colon < 0 ? user : user.slice(0, colon)).trim();
  if (name.includes('$')) return 'unresolved';
  return name === 'root' || name === '0' ? 'root' : 'non_root';
}

/** Compose `user:` — overrides the image's USER for that service. */
export function composeServiceUser(
  service: ComposeService,
): RuntimeUser & { readonly path: YamlPath } {
  const value = service.spec.user;
  const path = [...service.path, 'user'];
  if (typeof value === 'string' || typeof value === 'number') {
    const user = String(value);
    return { verdict: userVerdict(user), user, path };
  }
  return { verdict: 'unset', user: null, path };
}

/**
 * The user the final stage runs as. A stage without USER inherits from the stage it is built
 * FROM; a final stage on an external image without USER is 'unset' (the base image decides,
 * which for most official images is root).
 */
export function dockerfileFinalUser(
  read: DockerfileRead,
): RuntimeUser & { readonly line: number | null; readonly stageIndex: number | null } {
  let stage: DockerStage | undefined = read.stages[read.stages.length - 1];
  const seen = new Set<number>();
  while (stage !== undefined && !seen.has(stage.index)) {
    seen.add(stage.index);
    const index = stage.index;
    if (stage.user !== null) {
      return {
        verdict: userVerdict(stage.user),
        user: stage.user,
        line: stage.userLine,
        stageIndex: index,
      };
    }
    stage = stage.baseStage === null ? undefined : read.stages[stage.baseStage];
  }
  return { verdict: 'unset', user: null, line: null, stageIndex: null };
}

function securityContext(
  spec: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const map = asMap(spec.securityContext);
  return map === null ? {} : map;
}

/** `seccompProfile` / `appArmorProfile` of type Unconfined in one securityContext. */
function unconfinedProfiles(
  context: Readonly<Record<string, unknown>>,
  base: YamlPath,
  container: string | null,
): PrivilegeHit[] {
  return (['seccompProfile', 'appArmorProfile'] as const).flatMap((profile) =>
    yamlAt(context, [profile, 'type']) === 'Unconfined'
      ? [
          {
            reason: 'unconfined' as const,
            detail: `securityContext.${profile} Unconfined`,
            path: [...base, profile, 'type'],
            container,
          },
        ]
      : [],
  );
}

export function podSpecPrivilege(workload: K8sWorkload): PrivilegeHit[] {
  const hits: PrivilegeHit[] = [];
  const pod = workload.podSpec;
  for (const field of ['hostNetwork', 'hostPID', 'hostIPC'] as const) {
    if (pod[field] === true) {
      hits.push({
        reason: 'host_namespace',
        detail: `${field}: true`,
        path: [...workload.podSpecPath, field],
        container: null,
      });
    }
  }
  list(pod.volumes).forEach((volume, index) => {
    const hostPath = asMap(yamlAt(volume, ['hostPath']));
    if (hostPath === null || typeof hostPath.path !== 'string') return;
    // The API requires an absolute hostPath; any other spelling is not a path this owner can place.
    const reason = !hostPath.path.startsWith('/')
      ? 'unresolved_bind'
      : exposesRuntimeSocket(hostPath.path)
        ? 'docker_socket'
        : null;
    if (reason !== null) {
      hits.push({
        reason,
        detail: `hostPath ${hostPath.path}`,
        path: [...workload.podSpecPath, 'volumes', index],
        container: null,
      });
    }
  });
  hits.push(
    ...unconfinedProfiles(securityContext(pod), [...workload.podSpecPath, 'securityContext'], null),
  );
  for (const container of podContainers(workload)) {
    const context = securityContext(container.spec);
    const base = [...container.path, 'securityContext'];
    if (context.allowPrivilegeEscalation === true) {
      hits.push({
        reason: 'privilege_escalation',
        detail: 'allowPrivilegeEscalation: true',
        path: [...base, 'allowPrivilegeEscalation'],
        container: container.name,
      });
    }
    if (context.privileged === true) {
      hits.push({
        reason: 'privileged',
        detail: 'privileged: true',
        path: [...base, 'privileged'],
        container: container.name,
      });
    }
    const add = list(yamlAt(context, ['capabilities', 'add']));
    add.forEach((cap, index) => {
      const name = capabilityName(cap);
      if (name !== null && DANGEROUS_CAPABILITIES.has(name)) {
        hits.push({
          reason: 'capability',
          detail: `capabilities.add ${name}`,
          path: [...base, 'capabilities', 'add', index],
          container: container.name,
        });
      }
    });
    hits.push(...unconfinedProfiles(context, base, container.name));
  }
  return hits;
}

/** Effective runAsUser / runAsNonRoot for one container (container overrides pod). */
export function podContainerUser(
  workload: K8sWorkload,
  container: K8sContainer,
): RuntimeUser & { readonly runAsUser: number | null; readonly runAsNonRoot: boolean | null } {
  const pod = securityContext(workload.podSpec);
  const own = securityContext(container.spec);
  const pick = (field: string): unknown => (own[field] !== undefined ? own[field] : pod[field]);
  const runAsUserRaw = pick('runAsUser');
  const runAsNonRootRaw = pick('runAsNonRoot');
  const runAsUser = typeof runAsUserRaw === 'number' ? runAsUserRaw : null;
  const runAsNonRoot = typeof runAsNonRootRaw === 'boolean' ? runAsNonRootRaw : null;
  let verdict: RuntimeUserVerdict = 'unset';
  if (runAsUser === 0) verdict = 'root';
  else if (runAsUser !== null) verdict = 'non_root';
  else if (runAsNonRoot === true) verdict = 'non_root';
  return { verdict, user: runAsUser === null ? null : String(runAsUser), runAsUser, runAsNonRoot };
}
