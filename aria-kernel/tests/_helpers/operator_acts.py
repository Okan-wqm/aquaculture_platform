"""GitHub, faked, for operator approvals (ARIA-CRITICAL-216) — never the network.

An authority grant is proven by a comment or pull request review that an
operator's GitHub account posted. Tests stand in for GitHub with
:class:`FakeGitHubActs`, which answers the same reads the kernel's gh adapter
makes (``operator_approval.OperatorActReader``) and returns the payload shapes
the REST API returns, so the verifier's parsing is exercised, not bypassed.
:func:`github_operator_acts` installs the fake through the one production seam,
``operator_approval.github_act_reader``.
"""

from __future__ import annotations

import itertools
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel.operator_approval import approval_line, load_operators_policy
from aria_kernel.tool_registry import GovernanceError

OPERATOR_LOGIN = "Okan-wqm"
OWNER = "Okan-wqm"
REPO = "aquaculture_platform"
REPOSITORY = f"{OWNER}/{REPO}"

# Comment and review ids are unique across GitHub, and the verifier keys an
# act's single use on its id, so every fake in a process draws from one count.
_ACT_IDS = itertools.count(4101)


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeGitHubActs:
    """Comments and reviews an operator (or anyone else) posted, by id."""

    owner = OWNER
    repo = REPO

    def __init__(self) -> None:
        self.comments: dict[int, dict[str, Any]] = {}
        self.reviews: dict[tuple[int, int], dict[str, Any]] = {}
        self.review_edits: dict[str, str | None] = {}
        self.reads: list[tuple[str, Any]] = []

    def _id(self) -> int:
        return next(_ACT_IDS)

    def comment(
        self,
        body: str,
        *,
        login: str = OPERATOR_LOGIN,
        user_type: str = "User",
        issue: int = 1,
        created_at: datetime | None = None,
        edited_at: datetime | None = None,
    ) -> str:
        comment_id = self._id()
        created = created_at or datetime.now(timezone.utc) - timedelta(minutes=1)
        self.comments[comment_id] = {
            "id": comment_id,
            "node_id": f"IC_{comment_id}",
            "user": {"login": login, "type": user_type},
            "body": body,
            "created_at": _stamp(created),
            "updated_at": _stamp(edited_at or created),
            "issue_url": f"https://api.github.com/repos/{REPOSITORY}/issues/{issue}",
            "html_url": f"https://github.com/{REPOSITORY}/issues/{issue}#issuecomment-{comment_id}",
        }
        return f"gh:{REPOSITORY}#{issue}/comment/{comment_id}"

    def review(
        self,
        body: str,
        *,
        login: str = OPERATOR_LOGIN,
        user_type: str = "User",
        pr: int = 2,
        state: str = "APPROVED",
        submitted_at: datetime | None = None,
        last_edited_at: datetime | None = None,
    ) -> str:
        review_id = self._id()
        submitted = submitted_at or datetime.now(timezone.utc) - timedelta(minutes=1)
        node_id = f"PRR_{review_id}"
        self.reviews[(pr, review_id)] = {
            "id": review_id,
            "node_id": node_id,
            "user": {"login": login, "type": user_type},
            "body": body,
            "state": state,
            "submitted_at": _stamp(submitted),
            "pull_request_url": f"https://api.github.com/repos/{REPOSITORY}/pulls/{pr}",
            "html_url": f"https://github.com/{REPOSITORY}/pull/{pr}#pullrequestreview-{review_id}",
        }
        self.review_edits[node_id] = _stamp(last_edited_at) if last_edited_at else None
        return f"gh:{REPOSITORY}#{pr}/review/{review_id}"

    def approve(self, surface: str, scope: Mapping[str, str], **comment_kwargs: Any) -> str:
        """An operator comment carrying exactly the approval line for ``scope``."""
        return self.comment(
            "Approving.\n\n" + approval_line(surface, scope) + "\n", **comment_kwargs,
        )

    # ----- operator_approval.OperatorActReader --------------------------------

    def get_issue_comment(self, comment_id: int) -> dict[str, Any]:
        self.reads.append(("comment", comment_id))
        if comment_id not in self.comments:
            raise GovernanceError("gh: Not Found (HTTP 404)")
        return dict(self.comments[comment_id])

    def get_pull_request_review(self, number: int, review_id: int) -> dict[str, Any]:
        self.reads.append(("review", (number, review_id)))
        if (number, review_id) not in self.reviews:
            raise GovernanceError("gh: Not Found (HTTP 404)")
        return dict(self.reviews[(number, review_id)])

    def get_review_last_edited_at(self, node_id: str) -> str | None:
        self.reads.append(("review_edit", node_id))
        if node_id not in self.review_edits:
            raise GovernanceError("gh: review node not found")
        return self.review_edits[node_id]


@contextmanager
def github_operator_acts(
    *, operators: tuple[str, ...] | None = None,
) -> Iterator[FakeGitHubActs]:
    """Route every operator-approval read to a fresh :class:`FakeGitHubActs`.

    ``operators`` replaces the policy's login list (the checked-in policy
    names one operator; a separation-of-duties fixture needs two).
    """
    fake = FakeGitHubActs()
    policy = load_operators_policy()
    if operators is not None:
        policy = {**policy, "operator_logins": list(operators)}
    with mock.patch(
        "aria_kernel.operator_approval.github_act_reader", return_value=fake,
    ), mock.patch(
        "aria_kernel.operator_approval.load_operators_policy",
        side_effect=lambda supplied=None: load_operators_policy(supplied if supplied is not None else policy),
    ):
        yield fake


def operator_set_profile(
    profile: str,
    *,
    base_dir: str | Path | None = None,
    scheduler_ceiling: str | None = None,
) -> dict[str, Any]:
    """``set_profile`` as the operator, on a GitHub act approving exactly it.

    The approval names the profile and the ceiling the transition leaves in
    force (the recorded one when ``scheduler_ceiling`` is omitted), which is
    the scope ``set_profile`` verifies when the transition widens authority.
    """
    from aria_kernel.runtime_profile import get_scheduler_profile_ceiling, set_profile

    ceiling = scheduler_ceiling or get_scheduler_profile_ceiling(base_dir=base_dir)
    with github_operator_acts() as github:
        ref = github.approve("runtime_profile", {"profile": profile, "ceiling": ceiling})
        return set_profile(
            profile,
            operator_approval_ref=ref,
            base_dir=base_dir,
            scheduler_ceiling=scheduler_ceiling,
        )


__all__ = [
    "OPERATOR_LOGIN",
    "REPOSITORY",
    "FakeGitHubActs",
    "github_operator_acts",
    "operator_set_profile",
]
