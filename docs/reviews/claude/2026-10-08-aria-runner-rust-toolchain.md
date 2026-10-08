# The first CONVERGED plan's implementer was refused before the spawn (2026-10-08)

Context: plan `plan-cyc-20261007T225133Z-auto` (F-013, admin-panel tenant config) was the
first plan to reach `CONVERGED` without an operator in the loop: round 2, every gate passed,
coverage `covered`. Executor run 37705018969 recorded `implementation_requested`. The next
executor run, 37713931273, dispatched `AIR-aria-implementer-e056f97fe09b`. The kernel refused
it 52 s in, before the agent was spawned:

```text
implementation_delivery_unavailable: sandbox_unavailable:validation_toolchain_unresolvable:cargo (before the spawn)
drain_child_refused request_id=AIR-aria-implementer-e056f97fe09b detail=implementation_delivery_unavailable
```

Owner: claude (implementation), okan (review). Deadline 2026-10-15.

## ARIA-HIGH-383

The validation room binds every toolchain the tree declares, or it refuses by name.

- `implementation_safety._DECLARED_TOOLCHAINS` (`implementation_safety.py:1571`) maps the root
  `Cargo.toml` (a `[workspace]`) to cargo and rustc.
- `wrap_validation_in_sandbox` (`implementation_safety.py:1667`) resolves each declared
  toolchain on the validation environment's PATH.
- If one does not resolve, it raises `validation_toolchain_unresolvable:<tool>`
  (`implementation_safety.py:1673`).

The room was right to refuse. Its contract is that a suite runs against the tree's own
toolchains. The lane was the fault:

- No ARIA lane provisioned Rust.
- The self-hosted runner's user (`gharunner`) had no rustup home.
- The runner's `.path` did not carry `~/.cargo/bin`.

Every delivery, whatever it touched, was therefore refused at admission. So was every
self-revert and branch-update validation in the cycle lane, which builds the same room through
`implementation_delivery.validation_sandbox_for`. This had never surfaced because no plan had
reached `CONVERGED` before.

Reproduced on the runner, as `gharunner`, against its own checkout:

- With the runner's PATH, `wrap_validation_in_sandbox` refuses
  `validation_toolchain_unresolvable:cargo`.
- With `~/.cargo/bin` prepended, the room builds. It binds `~/.rustup`, `~/.cargo` and the
  pinned `1.88.0-x86_64-unknown-linux-gnu` toolchain.

Fix:

- Both lanes that build the room now call `./.github/actions/setup-rust-workspace`:
  `aria-agent-executor.yml` before `Run CI executor`, and `aria-auto-cycle.yml` before the
  nightly cycle.
- That is the same action the CI lanes use. The pinned channel, components and targets come
  from `tools/quality/rust-toolchain-manifest.json`.
- dtolnay's step puts `$CARGO_HOME/bin` on the job PATH.
- The action's own verify (`quality.mjs rust-toolchain check`) fails the job by name if the
  toolchain is not the declared one.

The runner was provisioned once by hand, with rustup for `gharunner`: the 1.88.0 minimal
profile plus rustfmt, clippy and rust-src, and the three manifest targets. The action is then a
near no-op on every run.

Detection (tier 3): `test_executor_workflow_sandbox_contract.py` I-SBX-05 reads the declared
toolchains from `validation_toolchains_for(repo root)`. It fails if:

- a declared toolchain has no provisioning action;
- either room-building lane omits that action;
- either lane runs the action after the step that builds the room.

It fails on main (`aria-agent-executor.yml builds the validation room but never provisions
cargo`) and passes with the fix.

Not changed: the room's refusal itself. Admitting a web-only plan without cargo would make the
room's contents depend on a guess about which commands a suite will reach, through Nx, into a
Cargo project.
