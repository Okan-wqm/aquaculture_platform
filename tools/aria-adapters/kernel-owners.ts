// ARIA-HIGH-013 — the adapters' one door into the kernel's Python owners.
//
// WHY: a TypeScript adapter whose rule is owned by kernel Python (the
// governance-bypass definition the pre-PR-open perimeter refuses an argv
// with, the workflow contract registry) must ask that owner, not restate its
// rule. This module is the single place that crosses the language boundary,
// so the call shape — one bounded `python3 -I -S` process per scan, the
// owners imported from this checkout's aria-kernel/ — has one definition.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** The kernel the owners are read from: the adapters' own tree, like `../gates`. */
const KERNEL_ROOT = resolve(__dirname, '..', '..', 'aria-kernel');

/**
 * The ONE call into the Python owners. `-I -S`: isolated from the caller's
 * environment and current directory, and no site packages — the owners are
 * standard-library modules, so a bare interpreter answers exactly as the
 * kernel does.
 */
const KERNEL_BRIDGE = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from aria_kernel.implementation_safety import governance_bypass_refusal',
  'from aria_kernel.workflow_contract_registry import uncontracted_write_scopes, workflow_job_contract_for_file',
  'request = json.load(sys.stdin)',
  'jobs = []',
  'for job in request["jobs"]:',
  '    contract = workflow_job_contract_for_file(job["workflow_file"], job["job_id"])',
  '    granted = job["permissions"]',
  '    uncontracted = []',
  '    if contract is not None and isinstance(granted, dict):',
  '        uncontracted = list(uncontracted_write_scopes(granted, dict(contract.required_permissions)))',
  '    jobs.append({"governed": contract is not None, "uncontracted": uncontracted})',
  'argvs = [governance_bypass_refusal(argv) for argv in request["argvs"]]',
  'json.dump({"argvs": argvs, "jobs": jobs}, sys.stdout)',
].join('\n');

export interface KernelRequest {
  readonly argvs: readonly (readonly string[])[];
  readonly jobs: readonly {
    readonly workflow_file: string;
    readonly job_id: string;
    readonly permissions: Record<string, unknown> | string | null;
  }[];
}

export interface KernelAnswer {
  readonly argvs: readonly (readonly [string, string] | null)[];
  readonly jobs: readonly {
    readonly governed: boolean;
    readonly uncontracted: readonly string[];
  }[];
}

export function askKernelOwners(request: KernelRequest): KernelAnswer {
  if (request.argvs.length === 0 && request.jobs.length === 0) return { argvs: [], jobs: [] };
  let stdout: string;
  try {
    stdout = execFileSync('python3', ['-I', '-S', '-c', KERNEL_BRIDGE, KERNEL_ROOT], {
      input: JSON.stringify(request),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `kernel-owners: the kernel owners in ${KERNEL_ROOT} could not answer: ${detail}`,
    );
  }
  const answer = JSON.parse(stdout) as KernelAnswer;
  if (answer.argvs.length !== request.argvs.length || answer.jobs.length !== request.jobs.length) {
    throw new Error(
      `kernel-owners: the kernel owners answered ${answer.argvs.length}/${answer.jobs.length} of ${request.argvs.length}/${request.jobs.length} questions`,
    );
  }
  return answer;
}
