/**
 * The one map from an infrastructure format to its reader (ARIA-HIGH-012).
 *
 * WHY: infra-policy.spec.ts reads every tracked infrastructure file by format, and the
 * infrastructure-policy adapter does the same. A dispatch written in each would be a second
 * owner of "which reader reads this format" and drift when a format is added. The switch is
 * exhaustive over InfraFormat, so a new format without a reader does not compile.
 */
import type { InfraFormat } from './classify';
import { type DockerfileRead, readDockerfile } from './dockerfile';
import { type HclRead, readHclBlocks } from './hcl-blocks';
import { type NatsRead, readNatsConf } from './nats-conf';
import { type NginxRead, readNginx } from './nginx-conf';
import { readYamlDocuments, type YamlRead } from './yaml-documents';

export type InfraRead =
  | { readonly format: 'dockerfile'; readonly read: DockerfileRead }
  | {
      readonly format: 'compose' | 'k8s' | 'helm_values' | 'helm_chart';
      readonly read: YamlRead;
    }
  | { readonly format: 'terraform'; readonly read: HclRead }
  | { readonly format: 'nginx'; readonly read: NginxRead }
  | { readonly format: 'nats'; readonly read: NatsRead }
  /** A Go template: no reader parses it unrendered; the caller reports it as excluded. */
  | { readonly format: 'helm_template'; readonly read: null };

export function readInfraFile(format: InfraFormat, text: string): InfraRead {
  switch (format) {
    case 'dockerfile':
      return { format, read: readDockerfile(text) };
    case 'compose':
    case 'k8s':
    case 'helm_values':
    case 'helm_chart':
      return { format, read: readYamlDocuments(text) };
    case 'terraform':
      return { format, read: readHclBlocks(text) };
    case 'nginx':
      return { format, read: readNginx(text) };
    case 'nats':
      return { format, read: readNatsConf(text) };
    case 'helm_template':
      return { format, read: null };
  }
}
