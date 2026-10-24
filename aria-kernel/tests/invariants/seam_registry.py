"""ARIA-HIGH-138 — the closed registry of the kernel's process seams.

WHY. Every seam the live chain touched failed under a test that mocked
exactly the process that failed live: HIGH-117 (the maintenance lane's
compaction), HIGH-123 (git inside the sandbox), HIGH-124 (kernel authority
and the package import inside the sandbox), MEDIUM-134 (the suite on a host
other than the droplet). A mechanism was added and pinned, and nothing asked
whether the production path reaches it through a real process. This module
is the one owner of the answer: which modules ARE seams, which real-process
test proves each one, and which spawn sites were reviewed and are not seams.

Three tables live here and nowhere else:

``SEAM_REGISTRY``
    Maps each seam module (repo-relative path) to its real-process test
    file(s) and a one-line naming of the real process the test exercises
    (a real bwrap, a real unix socket, a real ssh-agent, a real executor
    child, a real git push to a real bare remote). A seam without a
    real-process test cannot be registered, and a spawn site outside the
    registry cannot appear silently: ``tests/invariants/test_seam_registry.py``
    fails by name on an unclassified spawn site.

``SPAWN_ONLY_NOT_SEAM``
    The reviewed set: modules with a spawn site that this review classified
    as plumbing rather than a seam (read-only git/gh probes, host capability
    probes, doors that spawn a child already registered elsewhere), each
    with its one-line reason. A row with an empty reason or a module that
    lost its spawn site fails the invariant, so the set cannot rot into a
    dumping ground.

``iter_spawn_sites`` / ``process_layer_patches``
    The one detector for both directions of the contract. The walk set is
    the process layer: ``subprocess.run/Popen/check_output/check_call/call``,
    ``os.exec*/spawn*/system``, ``asyncio.create_subprocess_*``, asyncio's
    ``open_connection``/``start_server``/``start_unix_server`` (an outbound
    connect to a provider is as much a seam as a listener), an outbound
    ``socket.create_connection``, a direct ``.bind(`` listener, and a class
    deriving a ``socketserver`` listener (the brokers bind that way). The
    patch-ban set is the spawn/listen half of that layer — what a test may
    never ``mock.patch`` while claiming to prove a seam. The far END of an
    outbound path may be a declared fixture (a fixture ``gh`` on PATH, a
    recording loopback server, a fake opener in a refusal proof): a fixture
    endpoint is a substitute for the far side, not a mock of the process
    this side, which is the distinction HIGH-117/123/124 were killed by.
    Patching limits or argv builders (a weakened containment flag list) is
    declared fault injection through the real process and stays allowed.

The lane half of the contract: tests named in ``SEAM_REGISTRY`` declare
``REAL_PROCESS_SEAMS`` naming their seams, and their host-capability skips
fail (not skip) under ``ARIA_REQUIRE_REAL_SEAMS=1`` —
``tests/_helpers/real_process_seams.py``. Sandbox-backend skips have their
own owner (``tests/_helpers/sandbox_pins.py``, refused by the suite runner)
and are deliberately not re-owned here.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import MappingProxyType
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parents[3]

# The reviewed walk scope: every module under the kernel package with a spawn
# site must be classified (SEAM_REGISTRY or SPAWN_ONLY_NOT_SEAM). tools/ is
# walked per registry entry instead (only the executor drain is a seam there
# today); a new tools-side seam still cannot register without a spawn site,
# because the closure check runs the same detector over every entry.
WALK_ROOT = "aria-kernel/aria_kernel"

_SUBPROCESS_PRIMITIVES = frozenset({"run", "Popen", "check_output", "check_call", "call"})
_OS_SPAWN_PREFIXES = ("exec", "spawn", "system")
_ASYNCIO_SPAWN_PREFIXES = ("create_subprocess_",)
_ASYNCIO_CONNECT_LISTEN = frozenset({"open_connection", "start_server", "start_unix_server"})
_SOCKETSERVER_LISTENERS = frozenset({"UnixStreamServer", "UnixDatagramServer", "TCPServer", "UDPServer"})


def _dotted_chain(node: ast.AST) -> list[str]:
    """The attribute chain of an expression as its spelled parts, root first."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    parts.reverse()
    return parts


def iter_spawn_sites(source: Path) -> tuple[str, ...]:
    """Every process-layer primitive this module's source spells, sorted.

    A module with an empty tuple is not a seam candidate; the registry and
    the reviewed set both key on this one detector so neither can disagree
    with the walk.
    """
    try:
        tree = ast.parse(source.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return ()
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            parts = _dotted_chain(node.func)
            if len(parts) >= 2:
                root, attr = parts[0], parts[-1]
                if root == "subprocess" and attr in _SUBPROCESS_PRIMITIVES:
                    found.add(".".join(parts))
                elif root == "os" and attr.startswith(_OS_SPAWN_PREFIXES):
                    found.add(".".join(parts))
                elif root == "asyncio" and (
                    attr.startswith(_ASYNCIO_SPAWN_PREFIXES) or attr in _ASYNCIO_CONNECT_LISTEN
                ):
                    found.add(".".join(parts))
                elif root == "socket" and attr == "create_connection":
                    found.add(".".join(parts))
            if isinstance(node.func, ast.Attribute) and node.func.attr == "bind":
                found.add("<expr>.bind")
        elif isinstance(node, ast.ClassDef):
            for base in node.bases:
                parts = _dotted_chain(base)
                if len(parts) == 2 and parts[0] == "socketserver" and parts[1] in _SOCKETSERVER_LISTENERS:
                    found.add(f"socketserver.{parts[1]}(base)")
    return tuple(sorted(found))


# The patch targets a real-process test may never spell: the spawn/listen
# half of the walk set. Outbound connect is deliberately absent — a fake
# opener or recording loopback is a declared fixture endpoint, not a mock of
# the process under test (see the module docstring).
_BANNED_PATCH_ANY_ATTR = frozenset({"subprocess", "socket"})
_BANNED_OS_ATTR_PREFIXES = _OS_SPAWN_PREFIXES
_BANNED_ASYNCIO_ATTRS = frozenset({"create_subprocess_exec", "create_subprocess_shell", "start_server", "start_unix_server"})


def _banned_patch_target(root: str, attr: str) -> bool:
    if root in _BANNED_PATCH_ANY_ATTR:
        return True
    if root == "os" and attr.startswith(_BANNED_OS_ATTR_PREFIXES):
        return True
    return root == "asyncio" and (attr in _BANNED_ASYNCIO_ATTRS or attr.startswith(_ASYNCIO_SPAWN_PREFIXES))


def process_layer_patches(test_source: Path) -> list[str]:
    """The mock.patch targets in a test file that fake the process layer.

    Only ``patch`` / ``patch.object`` / ``patch.multiple`` calls are
    examined; ``patch.dict(os.environ, ...)`` builds the child's environment
    and is not a process mock.
    """
    try:
        tree = ast.parse(test_source.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return [f"{test_source}: unreadable"]
    banned: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        parts = _dotted_chain(node.func)
        if not parts or parts[-1] not in {"patch", "object", "multiple"}:
            continue
        if "patch" not in parts:  # patch(...) / mock.patch(...) / mock.patch.object(...)
            continue
        if not node.args:
            continue
        target = node.args[0]
        if isinstance(target, ast.Constant) and isinstance(target.value, str):
            # patch("module.subprocess.run") — judge the last two parts.
            words = target.value.split(".")
            if len(words) >= 2 and _banned_patch_target(words[-2], words[-1]):
                banned.append(target.value)
        elif isinstance(target, ast.Attribute):
            # patch.object(gw.asyncio, "open_connection") — the object's
            # chain names the module ("gw.asyncio" ends in asyncio).
            words = _dotted_chain(target)
            attr = node.args[1].value if len(node.args) > 1 and isinstance(node.args[1], ast.Constant) else ""
            if words and _banned_patch_target(words[-1], str(attr)):
                banned.append(".".join(words + [str(attr)]))
    return banned


def real_process_seam_markers() -> dict[str, tuple[str, ...]]:
    """Every ``REAL_PROCESS_SEAMS`` declaration under aria-kernel/tests.

    Maps the test file (repo-relative POSIX path) to the seams it declares
    itself the real-process proof of. The registry cross-checks this in both
    directions: a seam whose declared test does not name it, and a marker
    naming an unregistered seam, both fail the invariant.
    """
    markers: dict[str, tuple[str, ...]] = {}
    for path in sorted((REPO_ROOT / "aria-kernel" / "tests").rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            if not any(isinstance(t, ast.Name) and t.id == "REAL_PROCESS_SEAMS" for t in node.targets):
                continue
            declared: tuple[str, ...] = ()
            if isinstance(node.value, (ast.Tuple, ast.List)):
                literals = [
                    element.value
                    for element in node.value.elts
                    if isinstance(element, ast.Constant) and isinstance(element.value, str)
                ]
                declared = tuple(literals)
            markers[path.relative_to(REPO_ROOT).as_posix()] = declared
    return markers


class SeamEntry(NamedTuple):
    """One seam: the real-process tests that prove it, and the process they run."""

    tests: tuple[str, ...]
    process: str


SEAM_REGISTRY: MappingProxyType[str, SeamEntry] = MappingProxyType(
    {
        "aria-kernel/aria_kernel/git_containment.py": SeamEntry(
            tests=("aria-kernel/tests/test_git_containment.py",),
            process="real bwrap argv hosting real git inside the kernel's containment",
        ),
        "aria-kernel/aria_kernel/implementation_safety.py": SeamEntry(
            tests=("aria-kernel/tests/test_executor_implementation_identity.py",),
            process="real bwrap hosting the executor's managed CLI substitute and its signed "
            "git commit (the sandbox argv owner)",
        ),
        "aria-kernel/aria_kernel/self_improvement.py": SeamEntry(
            tests=("aria-kernel/tests/test_derived_authority_set.py",),
            process="invariants_only_grow runs the suite's own collector (aria-suite-run.sh --collect) "
            "inside the validation sandbox on real base/head git trees, beside read-only git plumbing "
            "for the authority set's tree",
        ),
        "aria-kernel/aria_kernel/hook_broker.py": SeamEntry(
            tests=("aria-kernel/tests/test_hook_broker.py",),
            process="serve_hook_broker on a real unix socket with a real subprocess client",
        ),
        "aria-kernel/aria_kernel/mcp_broker.py": SeamEntry(
            tests=("aria-kernel/tests/test_mcp_broker.py",),
            process="the MCP broker serving on a real unix socket",
        ),
        "aria-kernel/aria_kernel/token_broker.py": SeamEntry(
            tests=("aria-kernel/tests/test_token_broker.py",),
            process="the GitHub App token broker started as a real subprocess (the PEM piped to its "
            "stdin), serving mints on a real unix socket to a loopback provider fixture",
        ),
        "aria-kernel/aria_kernel/signing_agent.py": SeamEntry(
            tests=("aria-kernel/tests/test_signing_agent.py",),
            process="a real ssh-agent with real ssh-add keys, signing real git commits",
        ),
        "aria-kernel/aria_kernel/implementation_delivery.py": SeamEntry(
            tests=("aria-kernel/tests/test_executor_implementation_identity.py",),
            process="the delivery chain (stamp, pre-gates, publication identity) through the "
            "real executor child",
        ),
        "aria-kernel/aria_kernel/state_store.py": SeamEntry(
            tests=("aria-kernel/tests/test_state_publish_maintenance.py",),
            process="a real git publish of the compacted state, pushed to a real bare remote",
        ),
        "aria-kernel/aria_kernel/provider_gateway.py": SeamEntry(
            tests=("aria-kernel/tests/test_provider_gateway.py",),
            process="the gateway serving on a real unix socket, forwarding to a real loopback "
            "server (ARIA-MEDIUM-563)",
        ),
        "aria-kernel/aria_kernel/containment_probe.py": SeamEntry(
            tests=("aria-kernel/tests/test_containment_probe.py",),
            process="the real probe: a real git probe hosted by real bwrap",
        ),
        "aria-kernel/aria_kernel/egress_proxy.py": SeamEntry(
            tests=("aria-kernel/tests/test_egress_proxy.py",),
            process="the allowlist proxy serving on a real loopback listener and a real unix "
            "socket, against a real echo server",
        ),
        "aria-kernel/aria_kernel/egress_relay.py": SeamEntry(
            tests=("aria-kernel/tests/test_sandbox_egress_boundary.py",),
            process="the in-room relay's real CONNECT tunnel under real bwrap, to a real endpoint",
        ),
        "tools/aria-poc/ci_executor_drain.py": SeamEntry(
            tests=("aria-kernel/tests/test_executor_implementation_identity.py",),
            process="the real executor drain child provisioning per-request worktrees and "
            "running the managed CLI under real bwrap",
        ),
    }
)

# The reviewed set: spawn sites this review classified as plumbing, not
# seams. Reasons state what the module spawns (from its own argv), never a
# verdict the argv cannot support — "read-only" appears only where the
# subcommands spelled in the source are reads.
SPAWN_ONLY_NOT_SEAM: MappingProxyType[str, str] = MappingProxyType(
    {
        "aria-kernel/aria_kernel/actions_artifacts.py": "gh API argv fetching Actions artifacts; a repo-side download, no hosted child",
        "aria-kernel/aria_kernel/adapter_room.py": "runs the room's adapter child under its budget; the adapter suites own the adapter side",
        "aria-kernel/aria_kernel/agent_genesis.py": "git rev-parse/restore probes plus one `npm run` build of a generated skill package",
        "aria-kernel/aria_kernel/apply_engine.py": "git status and apply-preview argv over the workspace",
        "aria-kernel/aria_kernel/auto_merge.py": "gh CLI writes over the fixture-gh far end; the write seat's real child is the registered drain seam",
        "aria-kernel/aria_kernel/autonomy_closure.py": "the registry-verify subprocess (dynamic argv); repo tooling, not a hosted child",
        "aria-kernel/aria_kernel/autonomy_evidence.py": "read-only git -C probes over autonomy evidence rows",
        "aria-kernel/aria_kernel/branch_update_lineage.py": "git lineage plumbing (init, -c) on its fixture repos",
        "aria-kernel/aria_kernel/burn_in.py": "git argv through its bounded runner for burn-in bookkeeping",
        "aria-kernel/aria_kernel/change_paths.py": "git diff plumbing over changed paths",
        "aria-kernel/aria_kernel/checkpoint.py": "git index plumbing (update-index, ls-files) on its snapshot area",
        "aria-kernel/aria_kernel/ci.py": "one gh CLI probe of CI status",
        "aria-kernel/aria_kernel/convergence_drainer.py": "read-only git rev-parse probe",
        "aria-kernel/aria_kernel/convergent_skill_authoring.py": "read-only git show/rev-parse probes",
        "aria-kernel/aria_kernel/cycle.py": "read-only git rev-parse probe",
        "aria-kernel/aria_kernel/doctor.py": "host tool --version probes (the doctor self-check)",
        "aria-kernel/aria_kernel/evidence_collector.py": "read-only git rev-parse/cat-file/show probes collecting evidence",
        "aria-kernel/aria_kernel/evidence_probe.py": "git probe with dynamic argv over evidence reads",
        "aria-kernel/aria_kernel/experiment_night.py": "read-only git rev-parse probe",
        "aria-kernel/aria_kernel/finding_closure.py": "read-only git -C probe over closure rows",
        "aria-kernel/aria_kernel/gh_token_factory.py": "ssh-keygen fingerprint and key minting for the installation token",
        "aria-kernel/aria_kernel/github_adapters.py": "the gh CLI adapter (paginated reads); the GitHub far end is a declared fixture, not an unproven seam",
        "aria-kernel/aria_kernel/git_probe.py": "read-only git -C probe",
        "aria-kernel/aria_kernel/habitat.py": "host capability probes (sudo -n, ssh-keygen -y)",
        "aria-kernel/aria_kernel/implementation_identity.py": "read-only git -C commit verification probe",
        "aria-kernel/aria_kernel/implementation_replan.py": "read-only git ls-files probe",
        "aria-kernel/aria_kernel/lane_classifier.py": "one gh pr probe for lane classification",
        "aria-kernel/aria_kernel/main_anchor.py": "git argv through its bounded runner, anchoring main",
        "aria-kernel/aria_kernel/memory.py": "read-only git cat-file/diff/show probes over memory rows",
        "aria-kernel/aria_kernel/merge_lane_workspace.py": "git plumbing on the merge lane's workspace",
        "aria-kernel/aria_kernel/merge_record.py": "read-only git patch-id/-c probes for merge attribution",
        "aria-kernel/aria_kernel/migration.py": "read-only git rev-parse probe",
        "aria-kernel/aria_kernel/observation_coverage.py": "read-only git -C probe",
        "aria-kernel/aria_kernel/operator_request_signature.py": "ssh-keygen -Y verification of operator acknowledgements",
        "aria-kernel/aria_kernel/phase2_utils.py": "read-only git rev-parse probe",
        "aria-kernel/aria_kernel/planner_dispatch_hook.py": "spawns the executor child (the planner dispatch door); the child is the registered ci_executor_drain seam",
        "aria-kernel/aria_kernel/plan_coverage.py": "plan-coverage computation through its bounded runner (fixed argv, no shell); a gate helper, not a hosted child",
        "aria-kernel/aria_kernel/plan_import_resolution.py": "module-specifier resolution through its bounded runner (ARIA-HIGH-397); a gate helper, not a hosted child",
        "aria-kernel/aria_kernel/plan_synthesizer.py": "read-only git diff/log probes plus one gh CLI read",
        "aria-kernel/aria_kernel/pr_branch_update.py": "one gh api branch update over the fixture-gh far end",
        "aria-kernel/aria_kernel/preflight.py": "read-only git status probe plus one gh api read",
        "aria-kernel/aria_kernel/pr_manager.py": "read-only git rev-parse/log/diff probes beside gh CLI PR writes (fixture gh far end)",
        "aria-kernel/aria_kernel/promotion_controller.py": "read-only git rev-parse probe",
        "aria-kernel/aria_kernel/readiness_diff_surface.py": "read-only git cat-file/-c probes over the readiness surface",
        "aria-kernel/aria_kernel/readiness_proofs.py": "gh api reads plus git bundle verification of readiness proofs",
        "aria-kernel/aria_kernel/recovery.py": "one gh pr probe plus a read-only git ls-remote",
        "aria-kernel/aria_kernel/recursive_impact.py": "grep -rln scans plus one `npx nx` graph query",
        "aria-kernel/aria_kernel/runtime_artifacts.py": "read-only git -C/rev-parse probes over run artifacts",
        "aria-kernel/aria_kernel/security/policy_proxy.py": "outbound socket.create_connection liveness probe; no listener, no child",
        "aria-kernel/aria_kernel/security/profile.py": "read-only git -C probe",
        "aria-kernel/aria_kernel/self_revert.py": "git revert plumbing plus one gh pr call over the fixture-gh far end",
        "aria-kernel/aria_kernel/semantic_memory.py": "one /bin/sh -c git helper for memory dedup",
        "aria-kernel/aria_kernel/skill_curator.py": "git ls-files/restore on the curated skill tree",
        "aria-kernel/aria_kernel/skill_genesis.py": "git rev-parse/restore plus one `npm run` build of the generated skill",
        "aria-kernel/aria_kernel/snapshot.py": "git argv through its bounded runner for snapshots",
        "aria-kernel/aria_kernel/state_snapshot.py": "ssh-keygen -Y verification of the state snapshot's signature",
        "aria-kernel/aria_kernel/system_one.py": "git argv through its bounded runner",
        "aria-kernel/aria_kernel/system_one_points.py": "git argv through its bounded runner",
        "aria-kernel/aria_kernel/tool_runner.py": "read-only git status probes around tool runs",
        "aria-kernel/aria_kernel/trailer_scan.py": "git trailer scan with dynamic argv over commit reads",
        "aria-kernel/aria_kernel/trust.py": "git verification with dynamic argv over commit reads",
        "aria-kernel/aria_kernel/twin.py": "read-only git -C probe",
        "aria-kernel/aria_kernel/validation.py": "read-only git rev-parse/status probes",
        "aria-kernel/aria_kernel/verification_gate.py": "git probe at the verification gate",
        "aria-kernel/aria_kernel/worker_dispatch.py": "git worktree plumbing for the worker seat; the child it serves is the registered drain seam",
        "aria-kernel/aria_kernel/worker_dispatch_hook.py": "spawns the executor child (the worker dispatch door); the child is the registered ci_executor_drain seam",
        "aria-kernel/aria_kernel/workspace.py": "read-only git rev-list/rev-parse/config probes",
        "aria-kernel/aria_kernel/workspace_view.py": "git probe of the workspace view",
        "aria-kernel/aria_kernel/worktree.py": "git worktree/status plumbing",
    }
)

__all__ = [
    "REPO_ROOT",
    "SEAM_REGISTRY",
    "SPAWN_ONLY_NOT_SEAM",
    "WALK_ROOT",
    "SeamEntry",
    "iter_spawn_sites",
    "process_layer_patches",
    "real_process_seam_markers",
]
