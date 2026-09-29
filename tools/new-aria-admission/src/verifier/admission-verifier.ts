import { evaluateNegativeControl } from './negative-control';
import { authenticateVerifierInput } from './authenticated-input';
import type { AuthenticatedVerifierInput } from './authenticated-input';
import { canonicalVerifierBaselineReport } from './baseline-report';
import { decodeVerifierInput, readBoundedVerifierInput } from './verifier-input';

const REJECTED = Buffer.from('VERIFIER_INPUT_REJECTED\n');

interface Invocation {
  readonly controlId: string | undefined;
  readonly expectedOperatorTrustRootSha256: string;
  readonly baselineArgs: readonly string[];
}

function parseInvocation(argv: readonly string[]): Invocation {
  const baselineArgs = argv.slice(0, 4);
  if (
    (argv.length === 4 || argv.length === 6) &&
    argv[0] === '--mode' &&
    argv[1] === 'full' &&
    argv[2] === '--operator-trust-root-sha256' &&
    typeof argv[3] === 'string' &&
    /^[a-f0-9]{64}$/u.test(argv[3]) &&
    (argv.length === 4 || (argv[4] === '--negative-control' && typeof argv[5] === 'string'))
  ) {
    return Object.freeze({
      controlId: argv[5],
      expectedOperatorTrustRootSha256: argv[3],
      baselineArgs: Object.freeze(baselineArgs),
    });
  }
  throw new TypeError('verifier invocation is invalid');
}

function main(): void {
  try {
    const invocation = parseInvocation(process.argv.slice(2));
    const objects = decodeVerifierInput(readBoundedVerifierInput());
    const authenticated = authenticateVerifierInput(
      objects.slice(0, 4),
      invocation.expectedOperatorTrustRootSha256,
      process.cwd(),
      invocation.baselineArgs,
    );
    if (invocation.controlId === undefined) {
      if (objects.length !== 4) throw new TypeError('baseline input roster is invalid');
      process.stdout.write(canonicalVerifierBaselineReport(authenticated.verification.dossier));
      process.exitCode = 0;
      return;
    }
    const output = evaluateNegativeControl(invocation.controlId, objects, authenticated);
    process.stdout.write(output.stdout);
    process.stderr.write(output.stderr);
    process.exitCode = 1;
  } catch {
    process.stderr.write(REJECTED);
    process.exitCode = 2;
  }
}

main();
