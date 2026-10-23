/**
 * The one owner of "what is an infrastructure file, and in which format" (ARIA-HIGH-012).
 *
 * WHY one owner: the infrastructure-policy adapter enumerates with this function and its
 * manifest's declared scope is checked against it, so a second hand list of globs would drift
 * from what is actually read. The decision is by basename and path segment only (no file
 * content), so it is cheap, deterministic and testable on paths that do not exist.
 *
 * `helm_template` files are Go templates; no reader parses them unrendered. They are
 * classified so a caller can report them as excluded instead of skipping them silently.
 */

/** Every format, once: the union below is derived from it, so the two cannot disagree. */
export const INFRA_FORMATS = [
  'dockerfile',
  'compose',
  'k8s',
  'helm_values',
  'helm_chart',
  'helm_template',
  'terraform',
  'nginx',
  'nats',
] as const;

export type InfraFormat = (typeof INFRA_FORMATS)[number];

/** Path segments under which a YAML file is a Kubernetes manifest (plain or kustomize). */
const K8S_SEGMENTS: ReadonlySet<string> = new Set(['kubernetes', 'k8s', 'argocd']);
/** Path segments that mark a Helm chart tree. */
const HELM_SEGMENTS: ReadonlySet<string> = new Set(['helm', 'charts']);

const YAML_EXT = /\.ya?ml$/;
const YAML_TEMPLATE_EXT = /\.ya?ml\.template$/;
const COMPOSE_BASENAME = /^(?:docker-)?compose(?:[.-][^/]*)?\.ya?ml$/;
const COMPOSE_OVERRIDE_BASENAME = /\.override\.ya?ml$/;
const HELM_VALUES_BASENAME = /(?:^|[-.])values(?:[-.][^/]*)?\.ya?ml$/;
const KUSTOMIZATION_BASENAME = /^kustomization\.ya?ml$/i;
const CONF_EXT = /\.conf(?:\.template)?$/;

function isDockerfileBasename(base: string): boolean {
  if (base.endsWith('.dockerignore')) return false;
  return (
    base === 'Dockerfile' ||
    base.startsWith('Dockerfile.') ||
    base.endsWith('.Dockerfile') ||
    base.endsWith('.dockerfile')
  );
}

function classifyYaml(base: string, dirs: readonly string[]): InfraFormat | null {
  if (COMPOSE_BASENAME.test(base) || COMPOSE_OVERRIDE_BASENAME.test(base)) return 'compose';
  const inHelm = dirs.some((d) => HELM_SEGMENTS.has(d));
  if (inHelm) {
    if (dirs.includes('templates')) return 'helm_template';
    if (base === 'Chart.yaml' || base === 'Chart.yml') return 'helm_chart';
  }
  // Values files of third-party charts live outside a chart tree too
  // (infra/kubernetes/data/kafka/values.yaml, infrastructure/monitoring/loki/loki-values.yaml).
  if (HELM_VALUES_BASENAME.test(base)) return 'helm_values';
  if (inHelm) return null; // chart data files (files/*.yaml) are read by templates, not deployed
  if (KUSTOMIZATION_BASENAME.test(base)) return 'k8s';
  if (dirs.some((d) => K8S_SEGMENTS.has(d)) || dirs[0] === 'deploy') return 'k8s';
  return null;
}

/** Classify a repo-relative path; null means "not an infrastructure file this layer reads". */
export function classifyInfraFile(relPath: string): InfraFormat | null {
  const parts = relPath.split('/').filter((p) => p.length > 0);
  const base = parts[parts.length - 1];
  if (base === undefined) return null;
  const dirs = parts.slice(0, -1);

  if (isDockerfileBasename(base)) return 'dockerfile';
  if (base.endsWith('.tf') || base.endsWith('.tfvars')) return 'terraform';
  if (dirs.some((d) => HELM_SEGMENTS.has(d)) && dirs.includes('templates')) return 'helm_template';
  if (base.endsWith('.tpl')) return 'helm_template';
  if (YAML_EXT.test(base)) return classifyYaml(base, dirs);
  if (YAML_TEMPLATE_EXT.test(base)) {
    return dirs.some((d) => K8S_SEGMENTS.has(d)) || dirs[0] === 'deploy' ? 'k8s' : null;
  }
  if (CONF_EXT.test(base)) {
    if (dirs.includes('nats') || base.startsWith('nats')) return 'nats';
    if (dirs.includes('nginx') || base.startsWith('nginx')) return 'nginx';
  }
  return null;
}
