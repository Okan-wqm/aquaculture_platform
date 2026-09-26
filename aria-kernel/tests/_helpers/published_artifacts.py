"""An in-memory stand-in for GitHub Actions artifacts (ARIA-HIGH-218).

The claim lane uploads the rollback bundle as an Actions artifact and the
merge lane verifies it by downloading it back. Tests publish files here and
serve them through the kernel's one download seam,
``aria_kernel.actions_artifacts.fetch_actions_artifact``, so the producer
and the verifier run their real code against bytes that did not come from
the tools root.
"""
from __future__ import annotations

import hashlib
import io
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator
from unittest.mock import patch

from aria_kernel.actions_artifacts import FetchedArtifact, actions_artifact_uri
from aria_kernel.tool_registry import GovernanceError


class PublishedArtifacts:
    def __init__(self, *, repo: str = "okan/aqua", retention_days: int = 30) -> None:
        self.repo = repo
        self.retention_days = retention_days
        self._artifacts: dict[str, FetchedArtifact] = {}
        self.fetches: list[tuple[str, str]] = []

    def publish(self, members: dict[str, bytes], *, name: str = "aria-rollback-bundle-1-1",
                workflow_run_id: str = "900001") -> str:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for member, data in members.items():
                archive.writestr(member, data)
        artifact_id = str(700000 + len(self._artifacts) + 1)
        created = datetime.now(timezone.utc)
        self._artifacts[artifact_id] = FetchedArtifact(
            repo=self.repo,
            artifact_id=artifact_id,
            name=name,
            created_at=created.isoformat().replace("+00:00", "Z"),
            expires_at=(created + timedelta(days=self.retention_days)).isoformat().replace("+00:00", "Z"),
            workflow_run_id=workflow_run_id,
            zip_bytes=buffer.getvalue(),
        )
        return artifact_id

    def publish_files(self, *paths: Path, **kwargs: str) -> str:
        return self.publish({path.name: path.read_bytes() for path in paths}, **kwargs)

    def replace_bytes(self, artifact_id: str, zip_bytes: bytes) -> None:
        current = self._artifacts[artifact_id]
        self._artifacts[artifact_id] = FetchedArtifact(
            repo=current.repo, artifact_id=current.artifact_id, name=current.name,
            created_at=current.created_at, expires_at=current.expires_at,
            workflow_run_id=current.workflow_run_id, zip_bytes=zip_bytes,
        )

    def expire(self, artifact_id: str) -> None:
        self._artifacts.pop(artifact_id)

    def fetch(self, *, repo: str, artifact_id: str) -> FetchedArtifact:
        self.fetches.append((repo, artifact_id))
        if repo != self.repo or artifact_id not in self._artifacts:
            raise GovernanceError(f"actions_artifact_fetch_failed:repos/{repo}/actions/artifacts/{artifact_id}:HTTP 404")
        return self._artifacts[artifact_id]

    def serve(self) -> "patch":
        """Patch the kernel's download seam to serve from this store."""
        return patch("aria_kernel.actions_artifacts.fetch_actions_artifact", side_effect=self.fetch)

    def references(self, artifact_id: str, member: str) -> dict[str, str]:
        """The proof fields that name ``member`` of ``artifact_id`` by reference."""
        fetched = self._artifacts[artifact_id]
        with zipfile.ZipFile(io.BytesIO(fetched.zip_bytes)) as archive:
            member_bytes = archive.read(member)
        return {
            "source_uri": actions_artifact_uri(self.repo, artifact_id, member),
            "archive_uri": actions_artifact_uri(self.repo, artifact_id),
            "source_sha256": "sha256:" + hashlib.sha256(member_bytes).hexdigest(),
            "archive_sha256": fetched.zip_sha256,
        }


def iter_members(zip_bytes: bytes) -> Iterator[str]:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        yield from archive.namelist()
