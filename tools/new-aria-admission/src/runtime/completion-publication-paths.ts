import { isAbsolute, normalize, relative, sep } from 'node:path';

import type { CompletionAdmissionDescriptor } from './completion-admission-request';

export interface CompletionPublicationPaths {
  readonly output_path: string;
  readonly bundle_path: string;
  readonly checkpoint_root: string;
  readonly current_epoch_root: string;
  readonly input_paths: readonly string[];
}

export function completionDescriptorInputPaths(
  descriptor: CompletionAdmissionDescriptor,
  repositoryRoot?: string,
): readonly string[] {
  return Object.freeze([
    descriptor.target_request_path,
    descriptor.git_path,
    descriptor.operator_envelope_path,
    descriptor.operator_trust_root_path,
    descriptor.evidence_trust_root_path,
    descriptor.execution_trust_root_path,
    descriptor.event_policy_path,
    descriptor.freshness_policy_path,
    descriptor.event_chain_path,
    descriptor.evidence_attestation_path,
    ...descriptor.manifest_paths,
    ...descriptor.objects.map(({ path }) => path),
    ...(repositoryRoot === undefined ? [] : [repositoryRoot]),
  ]);
}

function canonical(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new TypeError('completion publication path must be absolute and canonical');
  }
}

function contains(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

export function assertCompletionPublicationPaths(input: CompletionPublicationPaths): void {
  const destinations = [
    input.output_path,
    input.bundle_path,
    input.checkpoint_root,
    input.current_epoch_root,
  ];
  for (const path of [...destinations, ...input.input_paths]) canonical(path);
  for (let left = 0; left < destinations.length; left += 1) {
    for (let right = left + 1; right < destinations.length; right += 1) {
      const leftPath = destinations[left];
      const rightPath = destinations[right];
      if (leftPath === undefined || rightPath === undefined || overlaps(leftPath, rightPath)) {
        throw new TypeError('completion publication destinations overlap');
      }
    }
  }
  for (const destination of destinations) {
    if (input.input_paths.some((path) => overlaps(destination, path))) {
      throw new TypeError('completion publication destination overlaps an input resource');
    }
  }
}
