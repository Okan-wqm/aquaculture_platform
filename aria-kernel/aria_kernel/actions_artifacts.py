"""ARIA-HIGH-218 — evidence one lane publishes and another lane verifies by download.

WHY this module exists
----------------------
The claim lane built the rollback bundle and its retention copy under the
tools root (``enterprise/rollback-artifacts/*.bundle``,
``.archive/rollback/**``), and the proofs named them by tools-relative
path. Neither path is a declared state surface, so ``state publish`` never
carried them to ``aria/state``, and the merge lane — another runner, at
another time — re-hashed files that did not exist on its host: every
rollback and retention proof failed ``enterprise_proof_uri_missing``.

A git bundle of ``main`` is the whole history of the repository. Declaring
it as a published surface would put one full-history blob per readiness
claim into the state branch — past the snapshot's per-blob cap
(``state_snapshot.SNAPSHOT_MAX_SURFACE_BLOB_BYTES``) and GitHub's 100 MB
per-file limit for this repository, and forever in the branch's history.
The ``artifact`` state class already states the rule for bulky,
re-derivable bytes: the record pins the sha256 and the bytes ride
elsewhere. So the bundle is published as a GitHub Actions artifact, and
the proofs pin it by reference: ``actions-artifact:<owner>/<repo>/<id>``
for the archive (the artifact's zip, its sha256) and the same reference
with ``#<member>`` for the bundle inside it (the bundle's sha256). The
verifier downloads the artifact through the API and re-hashes both.

WHAT it does
------------
* :func:`actions_artifact_uri` / :func:`parse_actions_artifact_uri` — the
  one spelling of a published reference;
* :func:`fetch_actions_artifact` — the one download: metadata and the zip
  bytes of one artifact, through ``gh api`` with the caller's ``GH_TOKEN``
  (a token that may read Actions). Bounded, and refused by name when the
  artifact is expired, missing or unreadable;
* :func:`artifact_member` — one member of the downloaded zip.

Tests replace :func:`fetch_actions_artifact` on this module (callers look
it up here at call time) to serve an artifact without the network.
"""
from __future__ import annotations

import hashlib
import io
import json
import subprocess
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from .tool_registry import GovernanceError

ACTIONS_ARTIFACT_URI_SCHEME = "actions-artifact:"
# An artifact is a zip the claim lane uploaded; a rollback bundle of this
# repository is well under this, and the bound keeps a hostile response from
# being read without end.
MAX_ACTIONS_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
ACTIONS_ARTIFACT_FETCH_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class FetchedArtifact:
    """One downloaded Actions artifact: what GitHub says it is, and its bytes."""

    repo: str
    artifact_id: str
    name: str
    created_at: str
    expires_at: str
    workflow_run_id: str
    zip_bytes: bytes

    @property
    def zip_sha256(self) -> str:
        return "sha256:" + hashlib.sha256(self.zip_bytes).hexdigest()

    def retention_days(self) -> float:
        """The retention GitHub granted this artifact, measured from its own
        creation and expiry timestamps."""
        created = _parse_utc(self.created_at)
        expires = _parse_utc(self.expires_at)
        if created is None or expires is None:
            raise GovernanceError(
                f"actions_artifact_retention_unmeasurable:{self.repo}/{self.artifact_id}"
            )
        return (expires - created).total_seconds() / 86400.0


ArtifactFetcher = Callable[..., FetchedArtifact]


def actions_artifact_uri(repo: str, artifact_id: str, member: str | None = None) -> str:
    _require_repo(repo)
    if not str(artifact_id).isdigit():
        raise GovernanceError(f"actions_artifact_id_must_be_numeric:{artifact_id!r}")
    uri = f"{ACTIONS_ARTIFACT_URI_SCHEME}{repo}/{artifact_id}"
    if member is not None:
        if not member or "/" in member or "#" in member or member in {".", ".."}:
            raise GovernanceError(f"actions_artifact_member_invalid:{member!r}")
        uri += f"#{member}"
    return uri


def parse_actions_artifact_uri(uri: str) -> tuple[str, str, str | None]:
    """``(repo, artifact_id, member)`` of a published reference; refuses
    anything else by name — a tools-relative path is not a publication."""
    if not isinstance(uri, str) or not uri.startswith(ACTIONS_ARTIFACT_URI_SCHEME):
        raise GovernanceError(f"actions_artifact_uri_not_published:{uri!r}")
    body = uri[len(ACTIONS_ARTIFACT_URI_SCHEME):]
    reference, _, member = body.partition("#")
    owner, _, rest = reference.partition("/")
    name, _, artifact_id = rest.partition("/")
    repo = f"{owner}/{name}"
    if not owner or not name or not artifact_id.isdigit():
        raise GovernanceError(f"actions_artifact_uri_malformed:{uri!r}")
    # Round-trip through the one spelling, so two spellings of one reference
    # cannot both be accepted.
    canonical = actions_artifact_uri(repo, artifact_id, member or None)
    if canonical != uri:
        raise GovernanceError(f"actions_artifact_uri_malformed:{uri!r}")
    return repo, artifact_id, (member or None)


def fetch_actions_artifact(
    *,
    repo: str,
    artifact_id: str,
    gh_cli: str = "gh",
) -> FetchedArtifact:
    """Download one Actions artifact: its metadata and its zip bytes."""
    _require_repo(repo)
    if not str(artifact_id).isdigit():
        raise GovernanceError(f"actions_artifact_id_must_be_numeric:{artifact_id!r}")
    metadata_raw = _gh_api(gh_cli, f"repos/{repo}/actions/artifacts/{artifact_id}")
    try:
        metadata = json.loads(metadata_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GovernanceError(f"actions_artifact_metadata_unparseable:{repo}/{artifact_id}") from exc
    if not isinstance(metadata, dict) or str(metadata.get("id")) != str(artifact_id):
        raise GovernanceError(f"actions_artifact_metadata_mismatch:{repo}/{artifact_id}")
    if metadata.get("expired") is not False:
        raise GovernanceError(f"actions_artifact_expired:{repo}/{artifact_id}")
    workflow_run = metadata.get("workflow_run") if isinstance(metadata.get("workflow_run"), dict) else {}
    zip_bytes = _gh_api(gh_cli, f"repos/{repo}/actions/artifacts/{artifact_id}/zip")
    return FetchedArtifact(
        repo=repo,
        artifact_id=str(artifact_id),
        name=str(metadata.get("name") or ""),
        created_at=str(metadata.get("created_at") or ""),
        expires_at=str(metadata.get("expires_at") or ""),
        workflow_run_id=str(workflow_run.get("id") or ""),
        zip_bytes=zip_bytes,
    )


def artifact_member(fetched: FetchedArtifact, member: str) -> bytes:
    """The bytes of ``member`` inside the downloaded zip, refused by name when
    the zip is unreadable or the member absent."""
    try:
        with zipfile.ZipFile(io.BytesIO(fetched.zip_bytes)) as archive:
            names = archive.namelist()
            if member not in names:
                raise GovernanceError(
                    f"actions_artifact_member_missing:{fetched.repo}/{fetched.artifact_id}#{member}"
                )
            return archive.read(member)
    except zipfile.BadZipFile as exc:
        raise GovernanceError(
            f"actions_artifact_zip_unreadable:{fetched.repo}/{fetched.artifact_id}"
        ) from exc


def _gh_api(gh_cli: str, path: str) -> bytes:
    try:
        completed = subprocess.run(
            [gh_cli, "api", path],
            capture_output=True,
            check=False,
            timeout=ACTIONS_ARTIFACT_FETCH_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GovernanceError(f"actions_artifact_fetch_failed:{path}:{exc.__class__.__name__}") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip().splitlines()
        raise GovernanceError(
            f"actions_artifact_fetch_failed:{path}:{(stderr[0] if stderr else 'gh api exited non-zero')[:200]}"
        )
    if len(completed.stdout) > MAX_ACTIONS_ARTIFACT_BYTES:
        raise GovernanceError(f"actions_artifact_exceeds_bound:{path}")
    return completed.stdout


def _require_repo(repo: str) -> None:
    owner, _, name = str(repo or "").partition("/")
    if not owner or not name or "/" in name:
        raise GovernanceError(f"actions_artifact_repo_invalid:{repo!r}")


def _parse_utc(text: str) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        return None
    return moment.astimezone(timezone.utc)


__all__ = [
    "ACTIONS_ARTIFACT_URI_SCHEME",
    "ArtifactFetcher",
    "FetchedArtifact",
    "actions_artifact_uri",
    "artifact_member",
    "fetch_actions_artifact",
    "parse_actions_artifact_uri",
]
