from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Mapping

# ARIA-HIGH-189 — findings.jsonl is feedback_store's declared ledger; it is
# read and rewritten through the owner's primitives, never the raw ledger
# writer (which refuses a declared surface the first time it holds a row).
from .feedback_store import findings_path
from .feedback_store import load_jsonl as load_findings_rows
from .feedback_store import rewrite_jsonl as rewrite_findings_rows
from .ledger import (
    append_declared_jsonl,
    load_declared_jsonl,
)
from .agent_surface import ROLE_TARGET_PAIRING
from .memory import latest_beliefs, record_learning_event
from .tool_registry import GovernanceError, ensure_tools_dir, list_tools, utc_now

if TYPE_CHECKING:
    from .workspace import WorkspacePaths


# E14 — the change-intelligence agent the `change_intelligence` role always
# named and nothing ever minted. The mechanical impact map below matches
# evidence refs against changed paths by glob; it cannot see a coupling that is
# not spelled as a path (a renamed symbol, a moved contract, a belief whose
# evidence moved file). That reading is what the agent is for, and the merge
# commit is when it is worth paying for.
CHANGE_INTELLIGENCE_ROLE = "change_intelligence"
# The generic agent of the role is the role's first pairing: one owner of
# "which agent serves a role" (agent_surface), never a second spelling here.
CHANGE_INTELLIGENCE_AGENT = ROLE_TARGET_PAIRING[CHANGE_INTELLIGENCE_ROLE][0]

# Evidence-ref budget for one change-intelligence envelope. A merge of 400
# files must not be pasted whole into a prompt; the agent is told the full
# count and reads the rest from the merge commit itself.
_MAX_CHANGED_FILE_REFS = 40

# Mint budget per run — see dispatch_change_intelligence for WHY a backlog
# must not become one night's bill.
DEFAULT_MAX_CHANGE_INTELLIGENCE_REQUESTS = 3


_DECLARED_SURFACE_BY_JSONL_SUFFIX: dict[str, str] = {
    "evidence-impact.jsonl": "evidence_impact",
    "cycle-state/incremental-plans.jsonl": "cycle_incremental_plans",
    "memory/beliefs.jsonl": "memory_beliefs",
}


def _declared_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if len(concrete.parts) >= 2:
        suffix = "/".join(concrete.parts[-2:])
        if suffix in _DECLARED_SURFACE_BY_JSONL_SUFFIX:
            return _DECLARED_SURFACE_BY_JSONL_SUFFIX[suffix]
    return _DECLARED_SURFACE_BY_JSONL_SUFFIX.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return append_declared_jsonl(path, record, expected_surface=surface)
    raise GovernanceError(f"pr_tracking_append_unknown_surface:{Path(path).as_posix()}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    raise GovernanceError(f"pr_tracking_load_unknown_surface:{Path(path).as_posix()}")


def _merges(root: Path) -> list[dict[str, Any]]:
    """Every merged ARIA PR, in ledger order, read where its one writer records it.

    ARIA-LOW-424 — ``merge_record.record_merge`` is the only writer of a
    ``merged`` row (ARIA-HIGH-390), in ``pr-lifecycle.jsonl``. This module
    used to copy those rows into two ledgers of its own and read the copy: a
    second record of the same fact, which only lags or disagrees with its
    owner. The readers below take the owner's rows, each with its lineage
    attestation folded (ARIA-HIGH-409), and nothing is copied.
    """
    from .merge_record import fold_merged_rows, lifecycle_rows

    return fold_merged_rows(lifecycle_rows(root))


def change_intelligence_subject_ref(*, pr_number: Any, head_sha: Any) -> str:
    """The stable name of WHAT a change-intelligence request is about: one
    merged PR at one head SHA — not the cycle that happened to notice it."""
    return f"merged-pr:{pr_number}:{head_sha}"


@dataclass(frozen=True, slots=True)
class ChangeSubject:
    """WP-D1 — one change named by its caller: ``(base, head)`` as full commit
    ids the workspace can read, and the paths the change touches.

    The room (or a Board-named subject) reviews exactly this change; the merge
    feed's subjects are ARIA's own merges. Built only by
    ``resolve_change_subject``, so a subject that exists has both ends resolved.
    """

    base: str
    head: str
    changed_files: tuple[str, ...]

    @property
    def ref(self) -> str:
        """The subject's stable name, the key of ``minted_subject_refs``."""
        return f"change:{self.base}..{self.head}"


def resolve_change_subject(
    workspace_root: str | Path, *, change_base: str | None, change_head: str | None,
) -> ChangeSubject:
    """Resolve both ends of one change in the workspace, or refuse BY NAME.

    A missing end and an end the workspace cannot read are different
    refusals, and each names the end (``change_base`` / ``change_head``): the
    caller fixes the argument it got wrong instead of reading a review of a
    change that never existed. Local git only (``rev-parse`` and ``diff``),
    so the entry never touches a remote.
    """
    from .evidence_probe import GitProbeSession

    root = Path(workspace_root)
    session = GitProbeSession()
    resolved: dict[str, str] = {}
    for name, value in (("change_base", change_base), ("change_head", change_head)):
        requested = (value or "").strip()
        if not requested:
            raise GovernanceError(f"change_review_subject_missing:{name}")
        resolution = session.resolve_baseline(root, requested)
        if resolution.commit_sha is None:
            raise GovernanceError(
                f"change_review_subject_unresolvable:{name}:{requested} "
                f"({resolution.unavailable_reason}: {resolution.detail})"
            )
        resolved[name] = resolution.commit_sha
    diff = session.run(
        ["git", "diff", "--name-only", "-z", "--no-renames", resolved["change_base"], resolved["change_head"]],
        cwd=root,
    )
    if not diff.answered or diff.returncode != 0:
        raise GovernanceError(
            f"change_review_diff_unavailable:{resolved['change_base']}..{resolved['change_head']} "
            f"({diff.unavailable_reason or diff.stderr.strip()[:200]})"
        )
    changed = tuple(path for path in diff.stdout.decode("utf-8", errors="replace").split("\0") if path)
    return ChangeSubject(base=resolved["change_base"], head=resolved["change_head"], changed_files=changed)


@dataclass(frozen=True, slots=True)
class _ChangeOffer:
    """One subject the dispatcher may ask about, whichever feed named it."""

    subject_ref: str
    head_sha: str
    changed_files: list[str]
    header: str
    # WP-D2 — the two commits whose diff is the change: the operator's
    # (base, head), a merge's (merge_sha^1, merge_sha). None names why the
    # hunks cannot be read.
    diff_range: tuple[str, str] | None
    diff_unavailable: str | None = None
    # The merge feed's PR number; None for an operator-named change.
    pr_number: Any = None


def _operator_offer(subject: ChangeSubject) -> _ChangeOffer:
    return _ChangeOffer(
        subject_ref=subject.ref,
        head_sha=subject.head,
        changed_files=list(subject.changed_files),
        header=(
            "Plan the revalidation impact of this change, named by the operator.\n"
            f"change_base: {subject.base}\n"
            f"change_head: {subject.head}\n"
        ),
        diff_range=(subject.base, subject.head),
    )


def _merge_offer(merge: dict[str, Any]) -> _ChangeOffer:
    pr_number = merge.get("pr_number")
    head_sha = str(merge.get("head_sha"))
    merge_sha = merge.get("merge_sha")
    return _ChangeOffer(
        subject_ref=change_intelligence_subject_ref(pr_number=pr_number, head_sha=head_sha),
        head_sha=head_sha,
        changed_files=_string_list(merge.get("changed_files")),
        header=(
            "Plan the revalidation impact of this merge. The kernel's glob "
            "match over changed paths is already recorded in "
            "evidence-impact.jsonl; your job is the coupling it cannot see.\n"
            f"pr_number: {pr_number}\n"
            f"head_sha: {head_sha}\n"
        ),
        diff_range=(f"{merge_sha}^1", str(merge_sha)) if merge_sha else None,
        diff_unavailable=None if merge_sha else "the merged row records no merge_sha",
        pr_number=pr_number,
    )


def _change_hunks(workspace_root: Path, offer: _ChangeOffer) -> str:
    """WP-D2 step 1 — the change's unified diff, or the named reason it is not attached.

    Local git only, through the probe session ``resolve_change_subject``
    uses, so the entry never touches a remote; ``--end-of-options`` keeps a
    recorded commit name from ever being read as an option.
    """
    from .evidence_probe import GitProbeSession

    if offer.diff_range is None:
        return f"hunks not attached: {offer.diff_unavailable}"
    base, head = offer.diff_range
    diff = GitProbeSession().run(
        ["git", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--end-of-options", base, head],
        cwd=workspace_root,
    )
    if not diff.answered or diff.returncode != 0:
        return (f"hunks not attached: git diff {base} {head} gave no answer "
                f"({diff.unavailable_reason or diff.stderr.strip()[:200]})")
    return diff.stdout.decode("utf-8", errors="replace")


@dataclass(frozen=True, slots=True)
class _ChangeImpact:
    """What the closure says of one change: the prose the agent reads, and the same facts as data."""

    prose: str
    # The roots of the services the change reaches, in closure order (none when the closure is held).
    impacted_roots: list[str]
    # The services the change itself touches as ``(project, root)``: closure order, or name order when held.
    touched: list[tuple[str, str]]
    # The map the paths are attributed against (``impact_graph.project_for_path``).
    project_roots: Mapping[str, str]
    routing: str


def _change_impact(
    workspace_root: Path, changed_files: list[str], *, root: Path, service_facts: Mapping[str, Any],
) -> _ChangeImpact:
    """WP-D2 step 3 — the services the change reaches, upstream first, from
    ``impact_graph.cycle_service_examination`` (the one closure owner): the
    prose the agent reads (a held closure is its named hold) and, as data, the
    services' roots in the same order, from ``impact_graph.project_map`` (the
    one name-to-root accessor); a held closure reaches no root.

    SE-5 — the touched services are the entries the change's own files landed
    in (``reason == "changed"``), in the closure's order, so a seat plan walks
    them upstream first. A held closure has no order to give: its touched
    services are the ``changed_projects`` it still reports, sorted by name, and
    the routing says so (``closure_held``) rather than reaching zero services.
    """
    from .impact_graph import cycle_service_examination, project_map

    examination = cycle_service_examination(
        workspace_root=workspace_root, changed_files=changed_files, service_facts=service_facts, base_dir=root,
    )
    roots = project_map(base_dir=root, workspace_root=workspace_root)
    if "hold" in examination:
        return _ChangeImpact(
            prose="impact closure held: " + json.dumps(examination["hold"], sort_keys=True, ensure_ascii=False),
            impacted_roots=[],
            touched=[(name, roots[name]) for name in examination["changed_projects"]],
            project_roots=roots,
            routing="closure_held",
        )
    lines = ["Impacted services in dependency order (upstream first):"]
    for entry in examination["examination_order"]:
        detail = f"layer {entry['layer']}; {entry['reason']}"
        if entry["changed_files"]:
            detail += f"; {entry['changed_files']} changed file(s)"
        if entry["evidence"]:
            detail += "; edge evidence " + json.dumps(entry["evidence"], sort_keys=True, ensure_ascii=False)
        lines.append(f"- {entry['project']} ({detail})")
    return _ChangeImpact(
        prose="\n".join(lines),
        impacted_roots=[roots[entry["project"]] for entry in examination["examination_order"]],
        touched=[
            (entry["project"], roots[entry["project"]])
            for entry in examination["examination_order"] if entry["reason"] == "changed"
        ],
        project_roots=roots,
        routing="closure",
    )


@dataclass(frozen=True, slots=True)
class SeatPlan:
    """The seats one change is asked about, and the touched services past the cap that are held."""

    seats: tuple[str, ...]
    held: tuple[tuple[str, str], ...]


def plan_change_seats(touched: list[tuple[str, str]], *, service_cap: int, lens_cap: int) -> SeatPlan:
    """The seats of one change from its touched services ``[(project, root)]`` in closure order. Pure.

    One ``service:<project>`` seat per touched service, the first ``service_cap``
    of them in the order given; the rest are ``held``, not dropped. A
    cross-cutting ``lens`` seat follows when ``lens_cap`` allows one and any
    touched service's root is a code root (``impact_graph.is_code_root``) —
    a held service counts, a web-only or tooling-only change does not. A change
    with neither a service seat nor a lens gets the whole-change seat: a change
    is never left unreviewed because routing could not name a seat.
    """
    from .agent_invocations import LENS_SEAT, WHOLE_CHANGE_SEAT, service_seat
    from .impact_graph import is_code_root

    seats = [service_seat(project) for project, _ in touched[:service_cap]]
    if lens_cap >= 1 and any(is_code_root(root) for _, root in touched):
        seats.append(LENS_SEAT)
    return SeatPlan(tuple(seats) or (WHOLE_CHANGE_SEAT,), tuple(touched[service_cap:]))


# What the lens seat is asked to look across (DESIGN-discovery f.2.3).
_LENS_CONCERNS = ["security", "tenant_isolation", "contracts"]
_SEAT_SENTENCE = (
    "You are one seat of this change's review: the seat block below names the one service, or the "
    "cross-cutting lens, you are asked about. Answer for the whole change as above; weigh the seat first.\n"
)


def _seat_block(seat: str, *, changed_files: list[str], impact: _ChangeImpact) -> str:
    """What a routed seat adds to the prompt: one fixed sentence and its identity block; nothing for the whole-change seat.

    A project name comes from the repository (``project.json``) and a path from
    the change, so neither is ever written outside the ``untrusted_`` block
    ``text_safety.untrusted_block`` escapes. The sentence names no project.
    The service's files are the changed files ``impact_graph.project_for_path``
    attributes to it (the one path -> project rule), capped like the files
    listed for the whole change.
    """
    from .agent_invocations import LENS_SEAT, seat_service
    from .impact_graph import project_for_path
    from .text_safety import untrusted_block

    service = seat_service(seat)
    if service is not None:
        service_files = [path for path in changed_files if project_for_path(path, impact.project_roots) == service]
        identity = {
            "seat": seat, "service": service,
            "service_files": service_files[:_MAX_CHANGED_FILE_REFS], "service_file_count": len(service_files),
        }
    elif seat == LENS_SEAT:
        identity = {"seat": seat, "lens": _LENS_CONCERNS}
    else:
        return ""
    return _SEAT_SENTENCE + untrusted_block("untrusted_change_seat", json.dumps(identity, ensure_ascii=False)) + "\n"


def dispatch_change_intelligence(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    subject: ChangeSubject | None = None,
    workspace: WorkspacePaths | None = None,
    max_requests: int = DEFAULT_MAX_CHANGE_INTELLIGENCE_REQUESTS,
) -> dict[str, Any]:
    """Mint the change-intelligence envelopes of each subject, one per seat. Idempotent.

    Two feeds, one mint. With ``subject`` (WP-D1, mode ``change_review``) the
    one change the operator named is the only subject, admitted as
    ``change_review.operator_subject`` — critical path, so a room run on an
    empty store is never held at the door. Without it, the merge feed: every
    merged ARIA PR, admitted as ``change_review.merge_feed`` (discretionary).

    Anchored to the subject's head SHA rather than the workspace head: the
    question is what THAT change invalidated, and evidence grading must
    resolve against the tree the agent is asked about.

    Newest merge first, and at most ``max_requests`` CHANGES per run (a change
    is never cut short by the run budget: its seats are minted together): the
    first run after this producer lands sees every merge ever recorded in
    ``pr-lifecycle.jsonl``, and an unbounded mint would turn a backlog into one
    night's LLM bill. The remainder is not lost — it is minted by later runs,
    oldest surviving last, which is also the order in which the answers still
    matter.

    WP-D2 — the envelope carries the change as DATA (PLAN-v2 F4.0,
    ARIA-MEDIUM-826): its paths and hunks in ``<untrusted_diff>``, the
    services it reaches in ``<untrusted_change_impact>``, and the area's
    memory (with ``workspace``: past findings and missed signals too) in the
    established-knowledge block, each escaped by
    ``text_safety.untrusted_block``, so no path, hunk or memory row can plant
    a line outside its tag. The hunks and the impact are read from
    ``workspace``, whose tree the closure reads as the change's (the room's
    tree is cut at the head, HARNESS §3.1; the nightly's checkout holds the
    merge); a dispatch without one says so inside the blocks. The same facts
    ride on the row as data (``change_context``: the listed files and the
    impacted services' roots), from which ``envelope_file_set`` derives the
    context-recall file set.

    SE-5 — a change is asked once per SEAT (``plan_change_seats``): one per
    touched service up to ``change_review.seats.service_seats_per_change`` in
    closure order, one cross-cutting lens, or the whole change when routing
    names neither. Every seat holds the same change data; a routed seat adds
    its identity (``_seat_block``) and is asked of the agent
    ``agent_surface.resolve_seat_agent`` names. The door decides the change's
    seats in ONE call (``count``), so a change is admitted or refused whole;
    the touched services past the cap are held by name after that
    (``judgment_funnel.hold_change_seat``). The dedup is per seat and
    independent of the agent (``agent_invocations.minted_subject_seats``): a
    dispatch that stopped between seats mints only the missing ones, and a seat
    is not asked again because its agent changed. A ``minted`` entry names its
    seat, its agent, the reason a per-service agent was not used
    (``agent_state``) and how the seat was routed (``routing``).
    """
    from .agent_invocations import (
        WHOLE_CHANGE_SEAT,
        create_agent_invocation_request,
        minted_subject_seats,
        seat_service,
        service_seat,
    )
    from .agent_surface import resolve_seat_agent
    from .genesis_policy import change_review_policy
    from .judgment_funnel import SERVICE_SEATS_PER_CHANGE_CAP, hold_change_seat
    from .pressure_evidence import split_citable_refs
    from .request_admission import admit_request
    from .text_safety import untrusted_block
    from .tool_registry import bound_workspace_root

    root = ensure_tools_dir(base_dir)
    seat_caps = change_review_policy(bound_workspace_root(root))["seats"]
    service_cap, lens_cap = seat_caps["service_seats_per_change"], seat_caps["lens_seats_per_change"]
    # One ledger pass for the whole merge backlog: the merge list only grows,
    # so a per-merge lookup would re-verify the request chain once per merge
    # per cycle.
    seats_asked = minted_subject_seats(role=CHANGE_INTELLIGENCE_ROLE, base_dir=root)
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    offers: list[_ChangeOffer] = []
    # The workspace's code facts, computed once per dispatch and only when a
    # change needs its seats planned: they are the closure's contract edges (SE-3/SE-4).
    service_facts: Mapping[str, Any] | None = None
    changes_minted = 0
    if subject is not None:
        offers.append(_operator_offer(subject))
    else:
        # The subject is the merged row's own (PR, head): the same name a
        # request minted from the retired merge-events copy carries, so a
        # merge already asked about is never asked again (ARIA-LOW-424).
        for merge in reversed(_merges(root)):
            if merge.get("pr_number") is None or not merge.get("head_sha"):
                skipped.append({"pr_number": merge.get("pr_number"), "reason": "merge_event_not_anchored"})
                continue
            offers.append(_merge_offer(merge))
    for offer in offers:
        already = seats_asked.get(offer.subject_ref, frozenset())
        change_entry = {"pr_number": offer.pr_number, "subject_ref": offer.subject_ref}
        if WHOLE_CHANGE_SEAT in already:
            skipped.append({**change_entry, "reason": "already_dispatched"})
            continue
        # A change nothing was asked of needs no plan to be left for a later run.
        if changes_minted >= max_requests and not already:
            skipped.append({**change_entry, "reason": "mint_budget_exhausted"})
            continue
        changed_files = offer.changed_files
        impact: _ChangeImpact | None = None
        if workspace is None:
            plan, routing = SeatPlan((WHOLE_CHANGE_SEAT,), ()), "unrouted:no_workspace"
        else:
            if service_facts is None:
                from .plan_coverage import compute_service_facts_at_head

                service_facts = compute_service_facts_at_head(workspace_root=workspace.repo_root)
            impact = _change_impact(workspace.repo_root, changed_files, root=root, service_facts=service_facts)
            plan = plan_change_seats(impact.touched, service_cap=service_cap, lens_cap=lens_cap)
            routing = impact.routing if plan.seats != (WHOLE_CHANGE_SEAT,) else "unrouted:no_touched_service"
        missing = [seat for seat in plan.seats if seat not in already]
        if not missing:
            skipped.append({**change_entry, "reason": "already_dispatched"})
            continue
        # Completing a change some of whose seats were asked still takes a run's slot.
        if changes_minted >= max_requests:
            skipped.append({**change_entry, "reason": "mint_budget_exhausted"})
            continue
        # ARIA-HIGH-364 — impact analysis of a merge starts new work:
        # discretionary. A refused merge stays unasked and is walked again
        # next cycle; a cycle-wide refusal holds for this cycle, so the walk stops.
        # The operator's named change is the work itself (critical path).
        # WP-D4 — either way the mint names its change, so the door counts the
        # change's seats and refuses the one past the registered seats. That
        # refusal is the change's own: it is skipped by name and the walk goes on.
        # SE-5 — one decision for the seats still to ask, so the change is
        # admitted whole or not at all.
        admission = (
            admit_request(
                "change_review.operator_subject", CHANGE_INTELLIGENCE_ROLE, base_dir=root, cycle_id=cycle_id,
                subject_ref=offer.subject_ref, count=len(missing),
            )
            if subject is not None
            else admit_request(
                "change_review.merge_feed", CHANGE_INTELLIGENCE_ROLE, base_dir=root, cycle_id=cycle_id,
                subject_ref=offer.subject_ref, count=len(missing),
            )
        )
        if not admission.admitted:
            skipped.append({**change_entry, "reason": admission.refusal})
            if admission.refuses_this_change_only:
                continue
            break
        if impact is None:
            hunks = "hunks not attached: this dispatch was given no workspace to read the change from"
            impact_prose = "impact not computed: this dispatch was given no workspace to read the change from"
            impacted_roots: list[str] = []
        else:
            hunks = _change_hunks(workspace.repo_root, offer)
            impact_prose, impacted_roots = impact.prose, impact.impacted_roots
        listed_files = changed_files[:_MAX_CHANGED_FILE_REFS]
        listed = json.dumps(listed_files, ensure_ascii=False)
        for seat in missing:
            resolution = resolve_seat_agent(CHANGE_INTELLIGENCE_ROLE, seat_service(seat), base_dir=root)
            prompt = (
                offer.header
                + f"changed_file_count: {len(changed_files)}\n\n"
                "The change itself follows as data: its paths (the first "
                f"{_MAX_CHANGED_FILE_REFS}) and hunks in the diff block, the services "
                "it reaches in the change impact block.\n\n"
                + untrusted_block("untrusted_diff", f"changed_files: {listed}\n\n{hunks}")
                + "\n"
                + untrusted_block("untrusted_change_impact", impact_prose)
                + "\n"
                + (_seat_block(seat, changed_files=changed_files, impact=impact) if impact is not None else "")
                + "Return details.impact_map with beliefs_needs_revalidation, "
                "findings_needs_revalidation, fixtures_requires_rerun and "
                "confirmed_unchanged. Ground every entry in the change's commits, "
                "not in its description."
            )
            request = create_agent_invocation_request(
                target_agent=resolution.agent,
                role=CHANGE_INTELLIGENCE_ROLE,
                suggested_prompt=prompt,
                must_satisfy=[{
                    "id": "impact-map",
                    "description": (
                        "details.impact_map classifies every impacted belief, "
                        "finding and fixture with evidence from the change's commits"
                    ),
                }],
                allowed_scope=["**"],
                # ARIA-MEDIUM-385 — the change is the subject, never a citation;
                # a changed path the agent law cannot admit stays in the prompt.
                evidence_refs=split_citable_refs(listed_files)[0] or None,
                subject_ref=offer.subject_ref,
                cycle_id=cycle_id,
                target_sha=offer.head_sha,
                base_dir=root,
                admission=admission,
                change_review_workspace=workspace,
                change_context={"changed_files": listed_files, "impacted_roots": impacted_roots, "seat": seat},
            )
            minted.append({
                **change_entry, "request_id": request.get("request_id"),
                "seat": seat, "agent": resolution.agent, "agent_state": resolution.declined, "routing": routing,
            })
        # The services past the cap are held by name once their change was admitted and asked.
        for project, _ in plan.held:
            held_seat = service_seat(project)
            hold_change_seat(offer.subject_ref, held_seat, cap=service_cap, base_dir=root)
            skipped.append({**change_entry, "seat": held_seat, "reason": SERVICE_SEATS_PER_CHANGE_CAP})
        seats_asked[offer.subject_ref] = already | frozenset(missing)
        changes_minted += 1
    return {"schema_version": 1, "minted": minted, "skipped": skipped}


def subject_open_request_ids(subject: ChangeSubject, *, base_dir: str | Path | None = None) -> list[str]:
    """The subject's change-intelligence requests that have not reached a
    terminal state — what a settle loop waits on before it stops: every seat of
    the change, whichever agent holds it."""
    from .agent_invocations import derive_request_states, list_agent_invocation_requests
    from .agent_surface import TERMINAL_REQUEST_STATES

    rows = [
        row for row in list_agent_invocation_requests(
            base_dir=base_dir, role=CHANGE_INTELLIGENCE_ROLE,
        )
        if row.get("subject_ref") == subject.ref
    ]
    if not rows:
        return []
    states = derive_request_states(base_dir=base_dir)
    return [
        str(row.get("request_id")) for row in rows
        if states[str(row.get("request_id"))] not in TERMINAL_REQUEST_STATES
    ]


def envelope_file_set(request: Mapping[str, Any]) -> list[str]:
    """WP-D2 (conformance audit R16) — the file set of a minted change-review envelope: what
    ``context_recall`` reads as a case's ``envelope_files``.

    The change's files and the roots of the services it reaches, both from the
    request's ``change_context`` (data the mint stored beside the prose), and
    the twin slice the mint attached (``twin.twin_slice_files`` over
    ``repository_map``; a request with no map holds none). Sorted, unique. A
    request that was not minted by this dispatch has no ``change_context`` and
    no file set: refused by name, not measured as an empty envelope.
    """
    from .twin import twin_slice_files

    context = request.get("change_context")
    if context is None:
        raise GovernanceError(f"envelope_file_set_not_a_change_review_request: {request.get('request_id')!r}")
    twin_slice = request.get("repository_map")
    return sorted({
        *context["changed_files"], *context["impacted_roots"],
        *(twin_slice_files(twin_slice) if twin_slice is not None else ()),
    })


def context_recall(cases: Iterable[Mapping[str, Any]], *, repo_root: str | Path | None = None) -> dict[str, Any]:
    """WP-D2 exit metric (DESIGN-discovery row D2): did the envelope hold the fix's ground?

    Over bug cases ``{case_id, envelope_files, fix_files}`` — ``envelope_files``
    being the change-review envelope's file set (the change's files, the
    impacted services' roots, the twin slice; ``envelope_file_set`` derives it
    from a minted request) — a case is a hit when a file
    the fix F changed is one of those entries or lies under one (directory
    boundary, ``knowledge_graph._paths_related``). Deterministic, no LLM, and
    independent of case order (``missed`` is sorted). The share is judged
    against the pre-registered ``change_review.context.recall_floor``
    (``genesis_policy.change_review_policy``, SE-13 strict), with n and the
    Wilson lower bound of the one Wilson owner (``judge_calibration``). DEV
    cases only: the HELD-OUT set is measured once, at D-FINAL. No case
    measures nothing — share, Wilson bound and the floor verdict are None.
    """
    from .genesis_policy import change_review_policy
    from .judge_calibration import wilson_lower
    from .knowledge_graph import _paths_related

    floor = change_review_policy(repo_root)["context"]["recall_floor"]
    rows = list(cases)
    missed = sorted(
        str(case["case_id"]) for case in rows
        if not any(_paths_related(fixed, held) for fixed in case["fix_files"] for held in case["envelope_files"])
    )
    n, hits = len(rows), len(rows) - len(missed)
    share = hits / n if n else None
    return {
        "n": n, "hits": hits, "share": share, "wilson_lower": wilson_lower(hits, n), "missed": missed,
        "recall_floor": floor, "meets_floor": None if share is None else share >= floor,
    }


def plan_pr_impact(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan the impact of the newest merge (a ``no_pr_event`` row when none exists)."""
    root = ensure_tools_dir(base_dir)
    merges = _merges(root)
    return _plan_merge_impact(root, cycle_id, merges[-1] if merges else None)


def plan_new_merge_impact(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan the newest merge's impact once; ``{"status": "no_new_merge"}`` otherwise.

    The impact ledger names the merge each plan was for (``pr_event``: PR and
    head), so it is its own cursor: the newest merge it does not name is new.
    An idle night writes nothing (a ``no_pr_event`` row per cycle would bury
    the real transitions under identical repeats), and a plan that failed is
    planned again next cycle instead of being lost with the copy that used to
    say "new" (ARIA-LOW-424).
    """
    root = ensure_tools_dir(base_dir)
    merges = _merges(root)
    if not merges:
        return {"status": "no_new_merge"}
    newest = merges[-1]
    planned = {
        (row["pr_event"].get("pr_number"), row["pr_event"].get("head_sha"))
        for row in load_jsonl(root / "evidence-impact.jsonl")
        if isinstance(row.get("pr_event"), dict)
    }
    if (newest.get("pr_number"), newest.get("head_sha")) in planned:
        return {"status": "no_new_merge"}
    return _plan_merge_impact(root, cycle_id, newest)


def _plan_merge_impact(root: Path, cycle_id: str, merge: dict[str, Any] | None) -> dict[str, Any]:
    if merge is None:
        row = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "status": "no_pr_event",
            "changed_files": [],
            "impacted_beliefs": [],
            "carried_forward_beliefs": [],
            "impacted_findings": [],
            "impacted_adapters": [],
            "actions": [],
        }
        return append_jsonl(root / "evidence-impact.jsonl", row)
    changed_files = _string_list(merge.get("changed_files"))
    beliefs = latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl"))
    impacted_beliefs = []
    carried_forward_beliefs = []
    for belief in beliefs:
        if belief.get("status") == "withdrawn":
            continue
        evidence_refs = _string_list(belief.get("evidence_refs"))
        matched = _matched_refs(evidence_refs, changed_files)
        item = {
            "belief_id": belief.get("belief_id"),
            "status_before": belief.get("status", "supported"),
            "evidence_refs": evidence_refs,
            "matched_refs": matched,
        }
        if matched:
            impacted_beliefs.append(item)
        else:
            carried_forward_beliefs.append(item)
    impacted_findings = _impacted_findings(root, changed_files)
    impacted_adapters = _impacted_adapters(root, changed_files)
    _mark_beliefs_for_revalidation(root, cycle_id, impacted_beliefs)
    _mark_findings_for_revalidation(root, impacted_findings)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "status": "planned",
        # The merge as its owner recorded it. `base_sha` is gone with the
        # copy: no merged row carries one, and every copied row held None.
        "pr_event": {
            "pr_number": merge.get("pr_number"),
            "event": "merged",
            "head_sha": merge.get("head_sha"),
            "merge_commit_sha": merge.get("merge_sha"),
        },
        "changed_files": changed_files,
        "impacted_beliefs": impacted_beliefs,
        "carried_forward_beliefs": carried_forward_beliefs,
        "impacted_findings": impacted_findings,
        "impacted_adapters": impacted_adapters,
        "actions": _impact_actions(impacted_beliefs, impacted_findings, impacted_adapters),
    }
    return append_jsonl(root / "evidence-impact.jsonl", row)


def plan_incremental_cycle(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    impacts = [row for row in load_jsonl(root / "evidence-impact.jsonl") if row.get("cycle_id") == cycle_id]
    impact = impacts[-1] if impacts else plan_pr_impact(cycle_id=cycle_id, base_dir=root)
    actions = list(impact.get("actions", []))
    if not actions:
        actions = ["carry_forward_confirmed_memory", "skip_unchanged_confirmed_false_positives"]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "mode": "incremental",
        "changed_files": impact.get("changed_files", []),
        "impacted_beliefs_count": len(impact.get("impacted_beliefs", [])),
        "impacted_findings_count": len(impact.get("impacted_findings", [])),
        "impacted_adapters_count": len(impact.get("impacted_adapters", [])),
        "actions": actions,
    }
    return append_jsonl(root / "cycle-state" / "incremental-plans.jsonl", row)


def _mark_beliefs_for_revalidation(root: Path, cycle_id: str, impacted: list[dict[str, Any]]) -> None:
    if not impacted:
        return
    impacted_ids = {str(item.get("belief_id")) for item in impacted}
    for belief in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl")):
        belief_id = str(belief.get("belief_id") or "")
        if belief_id not in impacted_ids:
            continue
        row = dict(belief)
        row.update(
            {
                "recorded_at": utc_now(),
                "updated_at": utc_now(),
                "last_seen_cycle": cycle_id,
                "status": "needs_revalidation",
                "verification_status": "needs_revalidation",
                "needs_revalidation_cycles": int(row.get("needs_revalidation_cycles", 0)) + 1,
                "revalidation_reason": "PR or merge changed evidence reference",
            },
        )
        append_jsonl(root / "memory" / "beliefs.jsonl", row)
        record_learning_event(
            root,
            cycle_id=cycle_id,
            event_type="evidence_invalidated",
            target_type="belief",
            target_id=belief_id,
            repo_state_id=row.get("repo_state_id"),
            base_commit_sha=row.get("base_commit_sha"),
            evidence_hashes=_string_list(row.get("evidence_hashes")),
            details={"reason": "PR or merge changed evidence reference"},
        )


def _mark_findings_for_revalidation(root: Path, impacted: list[dict[str, Any]]) -> None:
    if not impacted:
        return
    keys = {(item.get("run_id"), item.get("finding_id")) for item in impacted}
    rows = []
    for row in load_findings_rows(findings_path(root)):
        if (row.get("run_id"), row.get("finding_id")) in keys and row.get("status") in ("open", "suppressed_false_positive"):
            row = dict(row)
            row["status"] = "needs_revalidation"
            row["updated_at"] = utc_now()
        rows.append(row)
    rewrite_findings_rows(findings_path(root), rows)


def _impacted_findings(root: Path, changed_files: list[str]) -> list[dict[str, Any]]:
    impacted = []
    for row in load_findings_rows(findings_path(root)):
        finding = row.get("finding") if isinstance(row.get("finding"), dict) else {}
        refs = _finding_refs(finding)
        matched = _matched_refs(refs, changed_files)
        if matched:
            impacted.append(
                {
                    "tool_id": row.get("tool_id"),
                    "run_id": row.get("run_id"),
                    "finding_id": row.get("finding_id"),
                    "finding_fingerprint": row.get("finding_fingerprint"),
                    "matched_refs": matched,
                },
            )
    return impacted


def _impacted_adapters(root: Path, changed_files: list[str]) -> list[dict[str, Any]]:
    impacted = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        fixture_set = str(tool.get("fixture_set") or "")
        patterns = [
            "aria-tools/registry.json",
            "aria-tools/fixtures/**",
            f"aria-tools/{fixture_set}/**",
            f"{fixture_set}/**",
        ]
        matched = [path for path in changed_files if any(_matches(path, pattern) for pattern in patterns)]
        if matched:
            impacted.append({"tool_id": tool_id, "matched_files": sorted(set(matched)), "impact": "fixture_or_manifest_changed"})
    return impacted


def _impact_actions(
    impacted_beliefs: list[dict[str, Any]],
    impacted_findings: list[dict[str, Any]],
    impacted_adapters: list[dict[str, Any]],
) -> list[str]:
    actions = []
    if impacted_beliefs or impacted_findings:
        actions.append("revalidate_impacted_evidence")
    if impacted_adapters:
        actions.append("rerun_impacted_adapter_fixtures")
        actions.append("invalidate_ai_precision_cache")
    if not actions:
        actions.append("carry_forward_confirmed_memory")
    return actions


def _finding_refs(finding: dict[str, Any]) -> list[str]:
    refs = []
    if isinstance(finding.get("path"), str):
        refs.append(finding["path"])
    evidence = finding.get("evidence")
    if isinstance(evidence, list):
        refs.extend(str(item.get("path")) for item in evidence if isinstance(item, dict) and isinstance(item.get("path"), str))
    return sorted(set(refs))


def _matched_refs(evidence_refs: list[str], changed_files: list[str]) -> list[str]:
    matched = []
    for ref in evidence_refs:
        for changed in changed_files:
            if changed == ref or _matches(changed, ref) or _matches(ref, changed):
                matched.append(ref)
                break
    return sorted(set(matched))


def _matches(path: str, pattern: str) -> bool:
    normalized_path = path.replace("\\", "/")
    normalized_pattern = pattern.replace("\\", "/")
    if fnmatch.fnmatch(normalized_path, normalized_pattern):
        return True
    if "/**/" in normalized_pattern:
        return fnmatch.fnmatch(normalized_path, normalized_pattern.replace("/**/", "/"))
    if normalized_pattern.endswith("/**"):
        return normalized_path.startswith(normalized_pattern[:-3])
    return False


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item.strip()]
