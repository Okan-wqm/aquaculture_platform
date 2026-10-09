# The Jev lane's system-CA resolution was host-specific and CI-red (2026-10-09)

Owner: claude (implementation), okan (review).

## ARIA-MEDIUM-417

`system_one._public_transport_config` resolved the TLS trust bundle solely from
`ssl.get_default_verify_paths().openssl_cafile` and refused with
`public_remote_ca_unavailable` when that path is absent. On GitHub's hosted
runners the compiled default is absent (the distro bundle is what exists), so
every kernel-side System One flow refused before transport classification:
suite shard 5 on PR #1756 failed with `refused/public_remote_ca_unavailable`
where `unavailable/transport_raised:OSError`, `vendor_error_http_503` and
`answer_malformed` were expected, and `test_options_are_a_deterministic_per_state_permutation`
died on `transport.payloads[0]` (IndexError) for the same reason — the transport
was never called. Locally the compiled default exists, so the lane was green
everywhere except CI (run 37956780146, job 113909518878).

Rule: a SYSTEM trust source must be resolved portably; refusing on a host
without the compiled default is a host assumption, not a security posture.

Fix: `_system_ca_bundle()` tries the compiled default first, then the distro
SYSTEM bundles (Debian/Ubuntu, RHEL, openSUSE — admin-owned paths, never an
environment override and never a custom CA), and only then fails closed with
`public_remote_ca_unavailable`. Verified by unit proof (compiled default
forced empty → the distro bundle resolves) and by the full
`test_jev_runtime` + `test_system_one` suites (57 passed, 49 subtests).
