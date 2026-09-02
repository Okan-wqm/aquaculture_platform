const plan = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';

function negative(controlId, script, outputMarker) {
  return Object.freeze({
    control_id: controlId,
    argv: Object.freeze(['node', `${plan}/verification/${script}`]),
    artifact_uri: `evidence-output/${controlId}.log`,
    output_marker: outputMarker,
  });
}

function role(scope, sourcePath, controlId, negativeControl) {
  return Object.freeze({
    scope,
    source_paths: Object.freeze([`${plan}/${sourcePath}`]),
    control_id: controlId,
    negative_control: negativeControl,
  });
}

export const REVIEW_ROLE_POLICY = Object.freeze({
  integrity: role(
    'D0 exact target identity and immutable commit evidence',
    'verification/target-manifest.json',
    'target-integrity',
    negative(
      'target-authority-mutations',
      'test-target-controls.mjs',
      'PASS target-controls external-signature=required empty-range=denied',
    ),
  ),
  identity: role(
    'D0 reviewer identity separation and external authority',
    'authority/identity-authority-tcb.md',
    'identity-separation',
    negative(
      'reviewer-authority-mutations',
      'test-review-authority-controls.mjs',
      'PASS review-authority-controls=10',
    ),
  ),
  authorization: role(
    'D0 admission authorization and capability boundaries',
    'verification/review-policy.json',
    'authority-boundaries',
    negative('admission-mutations', 'test-dossier-admission.mjs', 'PASS dossier-admission=17'),
  ),
  'execution-containment': role(
    'D0 execution containment and fail-closed controls',
    'authority/execution-supply-chain.md',
    'execution-containment',
    negative(
      'containment-contract-mutations',
      'test-contract-regressions.mjs',
      'PASS contract-regressions',
    ),
  ),
  'supply-chain': role(
    'D0 hermetic runtime and supply-chain bindings',
    'verification/lib/hermetic-git.mjs',
    'supply-chain-hermeticity',
    negative(
      'hermetic-git-mutations',
      'test-hermetic-git.mjs',
      'PASS hermetic-git path=digest-pinned env=scrubbed config=neutralized',
    ),
  ),
  'data-privacy': role(
    'D0 data privacy and secret handling boundaries',
    'authority/data-privacy.md',
    'privacy-secret-handling',
    negative(
      'privacy-contract-mutations',
      'test-contract-regressions.mjs',
      'PASS contract-regressions',
    ),
  ),
  'cost-capacity': role(
    'D0 cost and capacity fail-closed gates',
    'phases/P02.md',
    'cost-capacity-fail-closed',
    negative(
      'cost-capacity-contract-mutations',
      'test-contract-regressions.mjs',
      'PASS contract-regressions',
    ),
  ),
  'reliability-dr': role(
    'D0 reliability, recovery and isolation controls',
    'authority/operations-reliability.md',
    'reliability-recovery',
    negative(
      'parallel-isolation-mutations',
      'test-parallel-isolation.mjs',
      'PASS parallel-isolation suites=2 verifier=1 sibling-cleanup=exact-owner',
    ),
  ),
  'github-delivery': role(
    'D0 GitHub delivery and remote readback proof',
    'authority/github-delivery.md',
    'github-delivery-proof',
    negative('delivery-mutations', 'test-delivery-controls.mjs', 'PASS delivery-controls'),
  ),
  'api-ui': role(
    'D0 API and UI closure ordering',
    'authority/api-ui.md',
    'api-ui-contract-parity',
    negative('api-closure-mutations', 'test-api-closure-order.mjs', 'PASS api-closure-order'),
  ),
  'portability-readability': role(
    'D0 portable runtime and readable dependency boundaries',
    'verification/readability-policy.json',
    'portability-readability',
    negative(
      'readability-mutations',
      'test-readability-dependencies.mjs',
      'PASS readability-dependencies',
    ),
  ),
  appellate: role(
    'D0 ordered review aggregation and final disposition',
    'authority/verification-evidence.md',
    'aggregate-appellate-disposition',
    negative('appellate-mutations', 'test-dossier-resolution.mjs', 'PASS dossier-resolution=9'),
  ),
});

export const REQUIRED_ROLE_CONTROL = Object.freeze(
  Object.fromEntries(
    Object.entries(REVIEW_ROLE_POLICY).map(([name, policy]) => [name, policy.control_id]),
  ),
);
