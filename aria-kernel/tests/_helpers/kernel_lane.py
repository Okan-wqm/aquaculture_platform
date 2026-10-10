"""The kernel lane's PR surface, read from aria-kernel.yml (INFRA-HIGH-215).

`aria-kernel` is a required context, so the workflow runs on every pull
request and reports on every one. Whether a PR runs the suite is decided by the
`changes` job from its `KERNEL_SURFACE` list, which was the `pull_request`
`paths:` filter until that filter left PRs outside it waiting on a context that
never reported. Tests that pin a path into the surface read it here, from the
one place it lives.
"""

from __future__ import annotations

from typing import Any, Mapping


def kernel_lane_surface(workflow: Mapping[str, Any]) -> list[str]:
    """The globs a PR must touch for the kernel lane to run its jobs."""
    for step in workflow["jobs"]["changes"]["steps"]:
        if step.get("id") == "scope":
            return [line for line in step["env"]["KERNEL_SURFACE"].splitlines() if line.strip()]
    raise AssertionError("aria-kernel.yml: the `changes` job has no `scope` step")
