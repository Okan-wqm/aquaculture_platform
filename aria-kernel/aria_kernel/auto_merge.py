from __future__ import annotations

import fnmatch
import json
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any, Protocol

from .ledger import append_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


DEFAULT_POLICY: dict[str, Any] = {
    "schema_version": 1,
    "enabled": False,
    "base_branch": "snowball",
    "merge_method": "squash",
    "allowed_low_risk_globs": [
        "docs/**",
        "*.md",
        "tests/**",
        "aria-kernel/tests/**",
        "tools/aria-adapters/**/__tests__/**",
        "tools/aria-adapters/**/*.test.ts",
        "tools/aria-adapters/**/*.spec.ts",
        "tools/aria-adapters/fixtures/**",
        "tools/aria-adapters/*.tool.json",
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/*.test.tsx",
        "**/*.spec.tsx",
        "**/*.test.js",
        "**/*.spec.js",
        "**/test_*.py",
        "**/*_test.py",
    ],
    "hard_forbidden_globs": [
        ".github/workflows/**",
        ".github/actions/**",
        "aria-kernel/aria_kernel/**",
        "infra/**",
        "docker/**",
        "docker-compose.yml",
        "docker/docker-compose.yml",
        "**/migrations/**",
        "**/*Migration*",
        "**/.env*",
        "**/*secret*",
        "**/*credential*",
        "**/*private-key*",
        "**/*pricing*",
        "**/*billing*",
        "apps/billing-service/**",
    ],
    "runtime_forbidden_globs": [
        "apps/**/src/**",
        "web/**/src/**",
        "libs/**/src/**",
        "platform/libs/**/src/**",
        "sens-api-gateway/src/**",
    ],
    "config_forbidden_globs": [
        "package.json",
        "package-lock.json",
        "nx.json",
        "tsconfig*.json",
        "**/*.config.*",
        "**/project.json",
        "**/Dockerfile",
    ],
    "require_unresolved_conversations": True,
}


class GitHubAdapter(Protocol):
    def get_pr(self, number: int) -> dict[str, Any]:
        ...

    def get_latest_head_sha(self, number: int) -> str | None:
        ...

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        ...

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        ...

    def get_reviews(self, number: int) -> dict[str, Any]:
        ...

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        ...

    def get_pr_diff(self, number: int) -> str | None:
        """Plan 023 v3 §P-6 — required Protocol method.

        Live mode (GhCliGitHubAdapter) implements via `gh pr diff
        <number>`. Snapshot/test mode returns the diff fixture from
        the seeded payload. evaluate_auto_merge fails-closed on
        empty / whitespace / malformed diff content (P-6 fix), so an
        adapter implementation that returns None / empty surfaces as
        an explicit auto_merge_blocked reason rather than a silent
        path-class-only acceptance.
        """
        ...

    def merge_pr(self, number: int, *, method: str, expected_head_sha: str) -> dict[str, Any]:
        ...


def normalize_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    candidate = deepcopy(DEFAULT_POLICY)
    if policy:
        for key, value in policy.items():
            candidate[key] = value
    if candidate.get("merge_method") != "squash":
        raise GovernanceError("auto-merge policy supports only squash merge")
    if candidate.get("base_branch") != "snowball":
        raise GovernanceError("auto-merge policy supports only the snowball base branch")
    return candidate


def classify_changed_files(
    changed_files: list[str | dict[str, Any]],
    *,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active_policy = normalize_policy(policy)
    paths = [_changed_file_path(item) for item in changed_files]
    paths = [path for path in paths if path]
    low_risk: list[str] = []
    forbidden: list[str] = []
    unknown: list[str] = []
    for path in paths:
        if _matches_any(path, active_policy["hard_forbidden_globs"]):
            forbidden.append(path)
        elif _matches_any(path, active_policy["allowed_low_risk_globs"]):
            low_risk.append(path)
        elif _matches_any(path, active_policy["runtime_forbidden_globs"]):
            forbidden.append(path)
        elif _matches_any(path, active_policy["config_forbidden_globs"]):
            forbidden.append(path)
        else:
            unknown.append(path)

    buckets = sum(1 for bucket in (low_risk, forbidden, unknown) if bucket)
    if not paths:
        risk_class = "unknown"
    elif forbidden and buckets > 1:
        risk_class = "mixed"
    elif forbidden:
        risk_class = "forbidden"
    elif unknown and low_risk:
        risk_class = "mixed"
    elif unknown:
        risk_class = "unknown"
    else:
        risk_class = "low"
    return {
        "schema_version": 1,
        "risk_class": risk_class,
        "eligible": risk_class == "low",
        "changed_files": paths,
        "low_risk_files": low_risk,
        "forbidden_files": forbidden,
        "unknown_files": unknown,
    }


def evaluate_auto_merge(
    *,
    pr: dict[str, Any],
    github: dict[str, Any],
    policy: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    dry_run: bool = True,
    diff_text: str | None = None,
) -> dict[str, Any]:
    active_policy = normalize_policy(policy)
    reasons: list[str] = []
    pr_number = pr.get("number")
    base_branch = _first_string(pr, "base_branch", "baseRefName", "base")
    head_sha = _first_string(pr, "head_sha", "headRefOid", "head")
    # Plan 023 v3 §P-4 — strict latest_head_sha lookup. Pre-fix the
    # `or head_sha` fallback meant a failed lookup (network 5xx, gh
    # adapter bug, missing snapshot field) silently substituted the
    # PR's own head_sha. The follow-up equality check then always
    # passed because both values were the same — defeating the
    # force-push detection that latest_head_sha exists to provide.
    # Post-fix: empty / missing falls through to the
    # "latest PR head SHA unavailable" reason below; gate blocks.
    latest_head_sha = _first_string(github, "latest_head_sha")
    changed_files = pr.get("changed_files", pr.get("files", []))
    if not isinstance(changed_files, list):
        changed_files = []
    risk = classify_changed_files(changed_files, policy=active_policy)

    # Plan 022 §H-2 — diff content scan. classify_changed_files only
    # looks at path globs; pre-fix a low-risk path (apps/**/*.ts) could
    # carry suppression patterns (`as any`, `// @ts-ignore`, `.skip`)
    # that auto-merge would silently approve. Now the diff is scanned
    # via suppression_scanner.scan_unified_diff_text and any hit
    # demotes the risk to 'unknown'.
    suppression_hits: list[dict[str, Any]] = []
    if diff_text is None and pr.get("diff_text"):
        diff_text = pr.get("diff_text")
    if diff_text is None:
        # Diff content REQUIRED for auto-merge. Fail-closed: caller
        # must supply diff (typically via gh pr diff <pr_number>) so
        # path-class + content-class AND-merge can run.
        reasons.append("diff_text missing — auto_merge_requires_diff_content")
    elif not diff_text.strip():
        # Plan 023 v3 §P-6 — empty / whitespace-only diff treated as a
        # missing diff. Pre-fix scan_unified_diff_text("") returned []
        # and the gate concluded "clean". Empty diff is a signal that
        # diff fetching broke; the gate fails closed.
        reasons.append(
            "auto_merge_requires_nonempty_unified_diff: diff_text was "
            "empty or whitespace-only; auto-merge cannot evaluate "
            "content-class without diff content"
        )
    elif "+++ b/" not in diff_text and "rename to " not in diff_text and "new file mode" not in diff_text:
        # Plan 023 v3 §P-6 — minimal unified-diff structural check.
        # A blob without any +++ b/<path> header / rename to / new file
        # mode line is not a unified diff; the suppression scanner's
        # parse_unified_diff() would silently produce zero file_changes
        # and return zero matches.
        reasons.append(
            "auto_merge_diff_unparseable_or_empty: diff_text does not "
            "contain a unified-diff file header (+++ b/<path>, "
            "rename to, or new file mode); auto-merge cannot trust "
            "the content-class result"
        )
    else:
        from .suppression_scanner import scan_unified_diff_text
        for match in scan_unified_diff_text(diff_text):
            suppression_hits.append({
                "category": match.category,
                "detector": match.detector,
                "file": match.file,
                "line": match.line,
                "text": match.text,
            })
        if suppression_hits:
            # Path-class + content-class AND merge: any suppression hit
            # demotes the eligibility regardless of path classification.
            risk = {**risk, "eligible": False,
                    "risk_class": "unknown",
                    "suppression_hits": suppression_hits}
            reasons.append(f"diff carries {len(suppression_hits)} suppression "
                           f"pattern(s); auto-merge blocked")

    if active_policy.get("enabled") is not True:
        reasons.append("policy disabled")
    if base_branch != active_policy["base_branch"]:
        reasons.append(f"base branch must be {active_policy['base_branch']}")
    if active_policy.get("merge_method") != "squash":
        reasons.append("merge method must be squash")
    if not head_sha:
        reasons.append("PR head SHA unavailable")
    if not latest_head_sha:
        reasons.append("latest PR head SHA unavailable")
    if head_sha and latest_head_sha and head_sha != latest_head_sha:
        reasons.append("PR head SHA changed since evaluation target was recorded")
    if not risk["eligible"]:
        reasons.append(f"diff risk is {risk['risk_class']}")

    required = _required_checks(github)
    if not required["readable"]:
        reasons.append("branch protection required checks unreadable")
    elif not required["checks"]:
        reasons.append("branch protection has no required checks")
    check_result = _required_checks_result(github, required["checks"], head_sha)
    if not check_result["readable"]:
        reasons.append("check runs unreadable")
    elif check_result["missing"]:
        reasons.append("required checks missing: " + ", ".join(check_result["missing"]))
    elif check_result["not_success"]:
        reasons.append("required checks not successful: " + ", ".join(check_result["not_success"]))

    review_result = _review_result(pr, github)
    if not review_result["readable"]:
        reasons.append("review state unreadable")
    elif review_result["requested_changes_count"] > 0:
        reasons.append("requested changes present")

    conversation_result = _conversation_result(github)
    if active_policy.get("require_unresolved_conversations", True):
        if not conversation_result["readable"]:
            reasons.append("unresolved conversation state unreadable")
        elif conversation_result["unresolved_count"] > 0:
            reasons.append("unresolved conversations present")

    eligible = not reasons
    decision = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "pr_number": pr_number,
        "base_branch": base_branch,
        "head_sha": head_sha,
        "latest_head_sha": latest_head_sha,
        "dry_run": dry_run,
        "decision": "eligible" if eligible else "blocked",
        "eligible": eligible,
        "reasons": reasons,
        "risk": risk,
        "required_checks": required,
        "check_result": check_result,
        "review_result": review_result,
        "conversation_result": conversation_result,
        "policy": {
            "enabled": active_policy["enabled"],
            "base_branch": active_policy["base_branch"],
            "merge_method": active_policy["merge_method"],
        },
    }
    _append_decision(base_dir, decision)
    return decision


def record_pr_lifecycle(
    pr: dict[str, Any],
    *,
    event: str = "observed",
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "event": event,
        "pr_number": pr.get("number"),
        "base_branch": _first_string(pr, "base_branch", "baseRefName", "base"),
        "head_sha": _first_string(pr, "head_sha", "headRefOid", "head"),
        "task_id": pr.get("task_id"),
        "proposal_id": pr.get("proposal_id"),
        "changed_files": [_changed_file_path(item) for item in pr.get("changed_files", pr.get("files", []))],
    }
    if base_dir is None:
        return row
    return append_jsonl(ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl", row)


def merge_if_green(
    *,
    adapter: GitHubAdapter,
    pr_number: int,
    policy: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    dry_run: bool = True,
    diff_text: str | None = None,
) -> dict[str, Any]:
    pr = adapter.get_pr(pr_number)
    record_pr_lifecycle(pr, event="observed", base_dir=base_dir, cycle_id=cycle_id)
    github = collect_github_snapshot(adapter, pr)
    # Plan 022 §H-2 — auto-merge content scan requires diff_text. If
    # caller didn't pass it, fall back to pr.diff_text (some adapters
    # surface it directly), then to the adapter if it exposes a
    # get_pr_diff() optional method. Otherwise pass None and let
    # evaluate_auto_merge fail-closed.
    if diff_text is None:
        diff_text = pr.get("diff_text")
        if diff_text is None and hasattr(adapter, "get_pr_diff"):
            try:
                diff_text = adapter.get_pr_diff(pr_number)  # type: ignore[attr-defined]
            except Exception:
                diff_text = None
    decision = evaluate_auto_merge(
        pr=pr,
        github=github,
        policy=policy,
        base_dir=base_dir,
        cycle_id=cycle_id,
        dry_run=dry_run,
        diff_text=diff_text,
    )
    if not decision["eligible"] or dry_run:
        return decision

    head_sha = str(decision["head_sha"])
    latest_head_sha = adapter.get_latest_head_sha(pr_number)
    if latest_head_sha != head_sha:
        blocked = dict(decision)
        blocked.update(
            {
                "recorded_at": utc_now(),
                "decision": "blocked",
                "eligible": False,
                "latest_head_sha": latest_head_sha,
                "reasons": ["PR head SHA changed after green evaluation"],
            },
        )
        _append_decision(base_dir, blocked)
        return blocked

    try:
        merge_result = adapter.merge_pr(pr_number, method="squash", expected_head_sha=head_sha)
    except Exception as exc:  # pragma: no cover - exercised by adapter fakes in tests
        failed = dict(decision)
        failed.update(
            {
                "recorded_at": utc_now(),
                "decision": "failed",
                "eligible": False,
                "reasons": [str(exc)],
            },
        )
        _append_decision(base_dir, failed)
        return failed

    merged = dict(decision)
    merged.update(
        {
            "recorded_at": utc_now(),
            "decision": "merged",
            "eligible": True,
            "merge_result": merge_result,
        },
    )
    _append_decision(base_dir, merged)
    record_pr_lifecycle(pr, event="merged", base_dir=base_dir, cycle_id=cycle_id)
    return merged


def collect_github_snapshot(adapter: GitHubAdapter, pr: dict[str, Any]) -> dict[str, Any]:
    pr_number = int(pr["number"])
    base_branch = _first_string(pr, "base_branch", "baseRefName", "base")
    head_sha = _first_string(pr, "head_sha", "headRefOid", "head")
    snapshot: dict[str, Any] = {}
    snapshot["latest_head_sha"] = _safe_call(lambda: adapter.get_latest_head_sha(pr_number), default=None)
    snapshot["branch_protection"] = _safe_call(
        lambda: adapter.get_required_checks(str(base_branch)),
        default={"readable": False, "required_checks": []},
    )
    snapshot["checks"] = _safe_call(
        lambda: adapter.get_checks(str(head_sha)),
        default={"readable": False, "runs": []},
    )
    snapshot["reviews"] = _safe_call(
        lambda: adapter.get_reviews(pr_number),
        default={"readable": False, "items": []},
    )
    snapshot["conversations"] = _safe_call(
        lambda: adapter.get_unresolved_conversation_count(pr_number),
        default={"readable": False, "unresolved_count": None},
    )
    return snapshot


class SnapshotGitHubAdapter:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.merge_calls: list[dict[str, Any]] = []

    def get_pr(self, number: int) -> dict[str, Any]:
        pr = self.payload.get("pr", {})
        if pr.get("number") != number:
            raise GovernanceError(f"snapshot PR number does not match: {number}")
        return deepcopy(pr)

    def get_latest_head_sha(self, number: int) -> str | None:
        _ = number
        return self.payload.get("github", {}).get("latest_head_sha") or self.payload.get("pr", {}).get("head_sha")

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        _ = base_branch
        return deepcopy(self.payload.get("github", {}).get("branch_protection", {}))

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        _ = head_sha
        return deepcopy(self.payload.get("github", {}).get("checks", {}))

    def get_reviews(self, number: int) -> dict[str, Any]:
        _ = number
        return deepcopy(self.payload.get("github", {}).get("reviews", {"readable": True, "items": []}))

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        _ = number
        return deepcopy(
            self.payload.get("github", {}).get("conversations", {"readable": True, "unresolved_count": 0}),
        )

    def get_pr_diff(self, number: int) -> str | None:
        """Plan 023 v3 §P-6 — read pre-seeded diff from the snapshot
        payload. Returns None when the fixture didn't supply a diff so
        evaluate_auto_merge's empty-diff fail-closed gate fires."""
        _ = number
        diff = self.payload.get("github", {}).get("pr_diff")
        if not isinstance(diff, str) or not diff.strip():
            return None
        return diff

    def merge_pr(self, number: int, *, method: str, expected_head_sha: str) -> dict[str, Any]:
        call = {"number": number, "method": method, "expected_head_sha": expected_head_sha}
        self.merge_calls.append(call)
        return {"merged": True, **call}


class GhCliGitHubAdapter:
    def __init__(self, *, cwd: str | Path = ".") -> None:
        self.cwd = Path(cwd)
        repo = self._gh_json(["repo", "view", "--json", "owner,name"])
        owner = repo.get("owner", {})
        self.owner = owner.get("login") if isinstance(owner, dict) else None
        self.repo = repo.get("name")
        if not self.owner or not self.repo:
            raise GovernanceError("unable to determine GitHub repository owner/name")

    def get_pr(self, number: int) -> dict[str, Any]:
        payload = self._gh_json(
            [
                "pr",
                "view",
                str(number),
                "--json",
                "number,baseRefName,headRefOid,files,reviews,reviewDecision",
            ],
        )
        return {
            "number": payload.get("number"),
            "base_branch": payload.get("baseRefName"),
            "head_sha": payload.get("headRefOid"),
            "changed_files": payload.get("files", []),
            "reviews": payload.get("reviews", []),
            "review_decision": payload.get("reviewDecision"),
        }

    def get_latest_head_sha(self, number: int) -> str | None:
        return self.get_pr(number).get("head_sha")

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        payload = self._gh_api_json(
            [
                f"repos/{self.owner}/{self.repo}/branches/{base_branch}/protection/required_status_checks",
            ],
        )
        checks = payload.get("contexts", [])
        checks.extend(item.get("context") for item in payload.get("checks", []) if isinstance(item, dict))
        return {"readable": True, "required_checks": sorted({str(check) for check in checks if check})}

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        runs = self._gh_api_json([f"repos/{self.owner}/{self.repo}/commits/{head_sha}/check-runs"]).get(
            "check_runs",
            [],
        )
        statuses = self._gh_api_json([f"repos/{self.owner}/{self.repo}/commits/{head_sha}/status"]).get(
            "statuses",
            [],
        )
        return {"readable": True, "runs": [*runs, *statuses]}

    def get_reviews(self, number: int) -> dict[str, Any]:
        return {"readable": True, "items": self.get_pr(number).get("reviews", [])}

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        query = """
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { isResolved }
              }
            }
          }
        }
        """
        unresolved = 0
        cursor: str | None = None
        while True:
            args = [
                "api",
                "graphql",
                "-f",
                f"query={query}",
                "-F",
                f"owner={self.owner}",
                "-F",
                f"repo={self.repo}",
                "-F",
                f"number={number}",
            ]
            if cursor:
                args.extend(["-F", f"cursor={cursor}"])
            payload = self._gh_json(args)
            threads = (
                payload.get("data", {})
                .get("repository", {})
                .get("pullRequest", {})
                .get("reviewThreads", {})
            )
            for node in threads.get("nodes", []):
                if not node.get("isResolved"):
                    unresolved += 1
            page_info = threads.get("pageInfo", {})
            if not page_info.get("hasNextPage"):
                return {"readable": True, "unresolved_count": unresolved}
            cursor = page_info.get("endCursor")

    def get_pr_diff(self, number: int) -> str | None:
        """Plan 023 v3 §P-6 — fetch the unified diff from gh CLI.

        Returns the diff text on success, or None on any subprocess
        failure / empty output. evaluate_auto_merge's empty-diff gate
        then converts the None / empty case into an explicit
        auto_merge_requires_nonempty_unified_diff blocking reason.
        """
        try:
            completed = subprocess.run(
                ["gh", "pr", "diff", str(number)],
                cwd=self.cwd, capture_output=True, text=True, check=False,
            )
        except (FileNotFoundError, OSError):
            return None
        if completed.returncode != 0:
            return None
        diff = completed.stdout or ""
        return diff if diff.strip() else None

    def merge_pr(self, number: int, *, method: str, expected_head_sha: str) -> dict[str, Any]:
        if method != "squash":
            raise GovernanceError("only squash merge is allowed")
        completed = subprocess.run(
            [
                "gh",
                "pr",
                "merge",
                str(number),
                "--squash",
                "--match-head-commit",
                expected_head_sha,
            ],
            cwd=self.cwd,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "gh pr merge failed")
        return {"merged": True, "method": "squash", "expected_head_sha": expected_head_sha}

    def _gh_api_json(self, args: list[str]) -> dict[str, Any]:
        return self._gh_json(["api", *args])

    def _gh_json(self, args: list[str]) -> dict[str, Any]:
        completed = subprocess.run(
            ["gh", *args],
            cwd=self.cwd,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "gh command failed")
        if not completed.stdout.strip():
            return {}
        return json.loads(completed.stdout)


def _required_checks(github: dict[str, Any]) -> dict[str, Any]:
    protection = github.get("branch_protection", github.get("required_checks", {}))
    if isinstance(protection, list):
        return {"readable": True, "checks": sorted({str(item) for item in protection if item})}
    if not isinstance(protection, dict):
        return {"readable": False, "checks": []}
    readable = protection.get("readable", True) is True
    checks = protection.get("required_checks", protection.get("contexts", protection.get("checks", [])))
    names: list[str] = []
    if isinstance(checks, list):
        for item in checks:
            if isinstance(item, dict):
                name = item.get("name") or item.get("context")
            else:
                name = item
            if name:
                names.append(str(name))
    return {"readable": readable, "checks": sorted(set(names))}


def _required_checks_result(github: dict[str, Any], required: list[str], head_sha: str | None) -> dict[str, Any]:
    checks_payload = github.get("checks", github.get("check_runs", {}))
    if isinstance(checks_payload, list):
        readable = True
        runs = checks_payload
    elif isinstance(checks_payload, dict):
        readable = checks_payload.get("readable", True) is True
        runs = checks_payload.get("runs", checks_payload.get("check_runs", checks_payload.get("statuses", [])))
    else:
        readable = False
        runs = []
    if not readable:
        return {"readable": False, "missing": required, "not_success": []}

    by_name: dict[str, dict[str, Any]] = {}
    for run in runs if isinstance(runs, list) else []:
        if not isinstance(run, dict):
            continue
        run_head = run.get("head_sha") or run.get("sha")
        if run_head and head_sha and run_head != head_sha:
            continue
        name = run.get("name") or run.get("context")
        if name:
            by_name[str(name)] = run

    missing = [name for name in required if name not in by_name]
    not_success = [name for name in required if name in by_name and not _check_success(by_name[name])]
    return {"readable": True, "missing": missing, "not_success": not_success}


def _review_result(pr: dict[str, Any], github: dict[str, Any]) -> dict[str, Any]:
    reviews = github.get("reviews", pr.get("reviews", {"readable": True, "items": []}))
    if isinstance(reviews, list):
        items = reviews
        readable = True
        explicit_count = None
    elif isinstance(reviews, dict):
        readable = reviews.get("readable", True) is True
        items = reviews.get("items", reviews.get("reviews", []))
        explicit_count = reviews.get("requested_changes_count")
    else:
        return {"readable": False, "requested_changes_count": 0}
    if not readable:
        return {"readable": False, "requested_changes_count": 0}
    if not isinstance(items, list):
        items = []
    if isinstance(explicit_count, int):
        requested_changes_count = explicit_count
    else:
        requested_changes_count = sum(
            1
            for review in items if isinstance(review, dict)
            and str(review.get("state", review.get("reviewDecision", ""))).upper() == "CHANGES_REQUESTED"
        )
    return {"readable": True, "requested_changes_count": requested_changes_count}


def _conversation_result(github: dict[str, Any]) -> dict[str, Any]:
    conversations = github.get("conversations", github.get("review_threads", None))
    if isinstance(conversations, dict):
        readable = conversations.get("readable", True) is True
        count = conversations.get("unresolved_count", conversations.get("unresolved_conversation_count"))
        return {"readable": readable, "unresolved_count": count if isinstance(count, int) else 0}
    if isinstance(conversations, int):
        return {"readable": True, "unresolved_count": conversations}
    return {"readable": False, "unresolved_count": 0}


def _check_success(run: dict[str, Any]) -> bool:
    state = str(run.get("state", "")).lower()
    status = str(run.get("status", "")).lower()
    conclusion = str(run.get("conclusion", "")).lower()
    if state:
        return state == "success"
    if conclusion:
        return conclusion == "success" and status in ("", "completed")
    return False


def _append_decision(base_dir: str | Path | None, decision: dict[str, Any]) -> None:
    if base_dir is None:
        return
    append_jsonl(ensure_tools_dir(base_dir) / "auto-merge-decisions.jsonl", decision)


def _changed_file_path(item: str | dict[str, Any]) -> str:
    if isinstance(item, str):
        return _normalize_path(item)
    if isinstance(item, dict):
        return _normalize_path(str(item.get("path") or item.get("filename") or item.get("fileName") or ""))
    return ""


def _normalize_path(path: str) -> str:
    return path.replace("\\", "/").lstrip("./")


def _matches_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def _first_string(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _safe_call(func: Any, *, default: Any) -> Any:
    try:
        return func()
    except Exception:
        return default
