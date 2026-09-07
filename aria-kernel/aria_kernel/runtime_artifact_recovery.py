"""Operator-gated storage recovery from exact ancestral Git objects.

The retention intent is the durable retry plan. It is never execution evidence.
The existing state publisher remains the only commit and remote-write owner.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import uuid
from pathlib import Path
from typing import Any, Iterator

from .ledger import LEDGER_ROW_MAX_BYTES, canonical_json, load_declared_jsonl, state_transaction, verify_jsonl_chunks
from .operator_approval import OperatorApprovalUnrecorded, verify_operator_approval_ref
from .runtime_artifacts import ARTIFACT_PROJECTION_PATHS, ARTIFACT_VERIFIER_VERSION, _resolve_uri, verify_artifacts
from .state_store import (
    StateStore, _git, _run_git, _is_worktree_of,
    _state_store_lifecycle_lock, _valid_host_identity, tools_root,
)
from .tool_registry import GovernanceError, utc_now
from .workspace import canonical_identity

RECOVERY_VERSION = 'artifact-git-recovery-v1'
STARTED = 'artifact_git_recovery_started'
COMPLETED = 'artifact_recovered_from_git_history'
_SHA = re.compile(r'[0-9a-f]{40}')
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}')
_INDEX = 'runtime_artifact_index'
_EVENTS = 'retention/events.jsonl'
_ACCEPTANCE = 'enterprise/acceptance-events.jsonl'


def _digest(value: Any) -> str:
    return 'sha256:' + hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _plain(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in {'ledger_hash', 'previous_ledger_hash'}}


def _object(store: StateStore, sha: str, relative: str) -> tuple[str, int]:
    output = _git(store.root, '--no-replace-objects', 'ls-tree', sha, '--', 'tools/' + relative).strip()
    fields = output.split('\t')
    if len(fields) != 2 or fields[1] != 'tools/' + relative:
        raise GovernanceError('artifact_recovery_source_object_missing')
    mode, kind, object_id = fields[0].split()
    if mode != '100644' or kind != 'blob' or not _SHA.fullmatch(object_id):
        raise GovernanceError('artifact_recovery_source_object_not_regular')
    size = int(_git(store.root, '--no-replace-objects', 'cat-file', '-s', object_id).strip())
    return object_id, size


def _chunks(store: StateStore, object_id: str, size: int) -> Iterator[bytes]:
    from .autonomy_evidence import _iter_git_output_bounded
    return _iter_git_output_bounded(store.root, '--no-replace-objects', 'cat-file', 'blob', object_id,
                                   max_bytes=size, expected_size=size,
                                   unavailable='artifact_recovery_source_blob_unavailable')


def _projection(store: StateStore, sha: str, surface: str) -> tuple[list[dict[str, Any]], str]:
    relative = ARTIFACT_PROJECTION_PATHS[surface]
    object_id, size = _object(store, sha, relative)
    if size > 64 * 1024 * 1024:
        raise GovernanceError('artifact_recovery_projection_budget_exceeded')
    rows: list[dict[str, Any]] = []
    summary = verify_jsonl_chunks(_chunks(store, object_id, size), source=relative,
                                 expected_size=size, max_line_bytes=1024 * 1024, max_rows=100000,
                                 expected_surface=surface, expected_surface_instance=relative,
                                 on_row=lambda row: rows.append(_plain(row)))
    return rows, 'sha256:' + summary['sha256']


def _claims(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    paths: set[str] = set()
    for row in rows:
        artifact_id = row.get('artifact_id')
        uri = row.get('current_uri') or row.get('uri') or row.get('path')
        size = row.get('size_bytes') if 'size_bytes' in row else row.get('bytes')
        if (not isinstance(artifact_id, str) or not artifact_id or not isinstance(uri, str)
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', str(row.get('sha256')))
                or not isinstance(size, int) or isinstance(size, bool) or size < 0):
            raise GovernanceError('artifact_recovery_projection_invalid')
        if artifact_id in result or uri in paths:
            raise GovernanceError('artifact_recovery_projection_duplicate')
        result[artifact_id] = {'artifact_id': artifact_id, 'uri': uri, 'sha256': row['sha256'], 'size_bytes': size}
        paths.add(uri)
    return result


def _valid_hot_uri(uri: Any) -> bool:
    return (isinstance(uri, str) and uri.startswith('run-artifacts/hot/') and uri.endswith('.json')
            and Path(uri).as_posix() == uri and not any(p in {'', '.', '..'} for p in uri.split('/')))


def _hot_path(root: Path, uri: str) -> Path:
    if not _valid_hot_uri(uri):
        raise GovernanceError('artifact_recovery_hot_path_invalid')
    return _resolve_uri(root, uri)


def _hash_file(path: Path) -> tuple[str, int]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    digest = hashlib.sha256()
    size = 0
    with os.fdopen(fd, 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise GovernanceError('artifact_recovery_target_not_regular')
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
        after = os.fstat(handle.fileno())
    if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise GovernanceError('artifact_recovery_target_changed')
    return 'sha256:' + digest.hexdigest(), size


def _verify_source(store: StateStore, target: dict[str, Any]) -> None:
    digest = hashlib.sha256()
    size = 0
    for chunk in _chunks(store, target['source_object_id'], target['size_bytes']):
        digest.update(chunk)
        size += len(chunk)
    if ('sha256:' + digest.hexdigest(), size) != (target['sha256'], target['size_bytes']):
        raise GovernanceError('artifact_recovery_source_hash_or_size_mismatch')


def _materialize(store: StateStore, root: Path, target: dict[str, Any]) -> None:
    """Publish a verified temp inode without replacing any existing target."""
    path = _hot_path(root, target['uri'])
    if path.exists():
        if _hash_file(path) != (target['sha256'], target['size_bytes']):
            raise GovernanceError('artifact_recovery_unexpected_target_bytes')
        return
    parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temp_name = '.recovery-' + uuid.uuid4().hex + '.tmp'
    try:
        for part in Path(target['uri']).parts[:-1]:
            try:
                os.mkdir(part, dir_fd=parent_fd)
                os.fsync(parent_fd)
            except FileExistsError:
                pass
            child_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = child_fd
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent_fd)
        digest = hashlib.sha256()
        size = 0
        try:
            with os.fdopen(fd, 'wb') as handle:
                for chunk in _chunks(store, target['source_object_id'], target['size_bytes']):
                    handle.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            if ('sha256:' + digest.hexdigest(), size) != (target['sha256'], target['size_bytes']):
                raise GovernanceError('artifact_recovery_source_hash_or_size_mismatch')
            _hot_path(root, target['uri'])
            os.link(temp_name, path.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
            os.fsync(parent_fd)
        finally:
            os.unlink(temp_name, dir_fd=parent_fd)
            os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    if _hash_file(_hot_path(root, target['uri'])) != (target['sha256'], target['size_bytes']):
        raise GovernanceError('artifact_recovery_materialization_mismatch')


def _require_host_binding(store: StateStore, root: Path) -> None:
    if not _valid_host_identity(root, canonical_identity(store.repo_root), store.repo_root):
        raise GovernanceError('artifact_recovery_host_binding_invalid')


def recover_git_history_artifacts(
    *, store: StateStore, expected_state_sha: str, source_state_sha: str,
    recovery_id: str, reason: str, operator_approval_ref: str,
    acknowledge: bool = False, dry_run: bool = False,
) -> dict[str, Any]:
    if not acknowledge:
        raise GovernanceError('artifact_recovery_requires_acknowledge')
    if not _SHA.fullmatch(expected_state_sha) or not _SHA.fullmatch(source_state_sha):
        raise GovernanceError('artifact_recovery_requires_exact_state_shas')
    if not _ID.fullmatch(recovery_id):
        raise GovernanceError('artifact_recovery_id_invalid')
    # The API and CLI share the existing audit-reason content contract.
    from .cli import _validate_reason
    try:
        reason = _validate_reason(reason)
    except argparse.ArgumentTypeError as exc:
        raise GovernanceError('artifact_recovery_reason_invalid') from exc
    root = tools_root(store)
    if root != root.resolve() or not _is_worktree_of(store.repo_root, store.root):
        raise GovernanceError('artifact_recovery_state_store_invalid')
    _require_host_binding(store, root)
    try:
        verify_operator_approval_ref(operator_approval_ref, base_dir=root, surface='artifact_git_recovery')
    except OperatorApprovalUnrecorded as exc:
        raise GovernanceError('artifact_recovery_operator_approval_unrecorded') from exc
    # All Git reads are exact object reads. Historical unrelated state is not attested.
    if _git(store.root, '--no-replace-objects', 'rev-parse', 'HEAD').strip() != expected_state_sha:
        raise GovernanceError('artifact_recovery_expected_state_mismatch')
    for sha in (expected_state_sha, source_state_sha):
        if _git(store.root, '--no-replace-objects', 'cat-file', '-t', sha, check=False).strip() != 'commit':
            raise GovernanceError('artifact_recovery_state_commit_missing')
    ancestry = _run_git(store.root, ('--no-replace-objects', 'merge-base', '--is-ancestor',
                                      source_state_sha, expected_state_sha))
    if ancestry.returncode not in {0, 1}:
        raise GovernanceError('artifact_recovery_ancestry_unavailable')
    if source_state_sha == expected_state_sha or ancestry.returncode != 0:
        raise GovernanceError('artifact_recovery_source_not_ancestor')
    source = {surface: _projection(store, source_state_sha, surface)[0] for surface in ARTIFACT_PROJECTION_PATHS}
    current = {surface: _projection(store, expected_state_sha, surface) for surface in ARTIFACT_PROJECTION_PATHS}
    source_claims = {surface: _claims(rows) for surface, rows in source.items()}
    current_claims = {surface: _claims(rows[0]) for surface, rows in current.items()}
    targets: list[dict[str, Any]] = []
    for row in source[_INDEX]:
        claim = source_claims[_INDEX][row['artifact_id']]
        artifact_id = claim['artifact_id']
        if artifact_id in current_claims[_INDEX]:
            continue
        if artifact_id not in current_claims['runtime_artifact_manifest']:
            continue
        _hot_path(root, claim['uri'])
        if any(claim != source_claims[surface].get(artifact_id) for surface in ARTIFACT_PROJECTION_PATHS):
            raise GovernanceError('artifact_recovery_source_projection_mismatch')
        if any(claim != current_claims[surface].get(artifact_id) for surface in ARTIFACT_PROJECTION_PATHS if surface != _INDEX):
            raise GovernanceError('artifact_recovery_current_projection_mismatch')
        object_id, size = _object(store, source_state_sha, claim['uri'])
        if size != claim['size_bytes']:
            raise GovernanceError('artifact_recovery_source_size_mismatch')
        target = {**claim, 'source_object_id': object_id, 'source_index_row_digest': _digest(row)}
        _verify_source(store, target)
        targets.append(target)
    targets.sort(key=lambda row: (row['uri'], row['artifact_id']))
    if not targets:
        raise GovernanceError('artifact_recovery_no_targets')
    source_rows = {row['artifact_id']: row for row in source[_INDEX]}
    recovered_rows = [source_rows[target['artifact_id']] for target in targets]
    binding = {
        'recovery_id': recovery_id, 'expected_state_sha': expected_state_sha,
        'source_state_sha': source_state_sha, 'reason': reason,
        'operator_approval_ref': operator_approval_ref,
        'implementation_version': RECOVERY_VERSION, 'validator_version': ARTIFACT_VERIFIER_VERSION,
        'source_snapshot_scope': 'not_full_verified', 'evidence_class': 'historical_recovered',
        'evidence_status': 'needs_revalidation',
        'claim_digests': {s: value[1] for s, value in current.items() if s != _INDEX},
        'target_plan_digest': _digest(targets), 'targets': targets,
    }
    if len(canonical_json(binding).encode('utf-8')) > LEDGER_ROW_MAX_BYTES - 1024:
        raise GovernanceError('artifact_recovery_plan_budget_exceeded')
    paths = [root / relative for relative in (*ARTIFACT_PROJECTION_PATHS.values(), _EVENTS, _ACCEPTANCE)]
    paths.extend(_hot_path(root, target['uri']) for target in targets)
    if dry_run:
        return _recover_locked(store, root, paths, current, binding, recovered_rows, dry_run=True)
    with _state_store_lifecycle_lock(store.repo_root):
        with state_transaction(paths) as transaction:
            return _recover_locked(store, root, paths, current, binding, recovered_rows, transaction=transaction)


def _recover_locked(store: StateStore, root: Path, paths: list[Path], current: dict,
                    binding: dict, recovered_rows: list[dict[str, Any]], *,
                    dry_run: bool = False, transaction: Any = None) -> dict[str, Any]:
    _require_host_binding(store, root)
    if _git(store.root, '--no-replace-objects', 'rev-parse', 'HEAD').strip() != binding['expected_state_sha']:
        raise GovernanceError('artifact_recovery_expected_state_mismatch')
    for path in paths:
        _resolve_uri(root, path.relative_to(root).as_posix())
    for surface, digest in binding['claim_digests'].items():
        if _hash_file(root / ARTIFACT_PROJECTION_PATHS[surface])[0] != digest:
            raise GovernanceError('artifact_recovery_current_claim_bytes_changed')
    events = load_declared_jsonl(root / _EVENTS, expected_surface='retention_events')
    matching = [row for row in events if row.get('recovery_id') == binding['recovery_id']]
    intents = [row for row in matching if row.get('event') == STARTED]
    receipts = [row for row in matching if row.get('event') == COMPLETED]
    if len(intents) > 1 or len(receipts) > 1 or (receipts and not intents):
        raise GovernanceError('artifact_recovery_receipt_invalid')
    if any(any(row.get(k) != v for k, v in binding.items()) for row in matching):
        raise GovernanceError('artifact_recovery_binding_mismatch')
    if intents:
        from .autonomy_unlock import recovery_admissible_acceptance_rows
        acceptance = load_declared_jsonl(root / _ACCEPTANCE, expected_surface='enterprise_acceptance_events')
        _admitted, blockers = recovery_admissible_acceptance_rows(acceptance, matching)
        if 'artifact_recovery_acceptance_boundary_invalid' in blockers:
            raise GovernanceError('artifact_recovery_acceptance_boundary_invalid')
    if any(row.get('event') == STARTED and row.get('recovery_id') != binding['recovery_id']
           and not any(r.get('event') == COMPLETED and r.get('recovery_id') == row.get('recovery_id') for r in events)
           for row in events):
        raise GovernanceError('artifact_recovery_other_intent_pending')
    baseline = current[_INDEX][0]
    merged = baseline + recovered_rows
    _claims(merged)
    index = [_plain(row) for row in load_declared_jsonl(root / ARTIFACT_PROJECTION_PATHS[_INDEX], expected_surface=_INDEX)]
    if (receipts and index != merged) or (index != baseline and (not intents or index != merged)):
        raise GovernanceError('artifact_recovery_unexpected_index_state')
    for target in binding['targets']:
        path = _hot_path(root, target['uri'])
        if path.exists() and (not intents or _hash_file(path) != (target['sha256'], target['size_bytes'])):
            raise GovernanceError('artifact_recovery_unexpected_target_bytes')
        if receipts and not path.exists():
            raise GovernanceError('artifact_recovery_completed_target_missing')
    target_ids = {target['artifact_id'] for target in binding['targets']}
    target_uris = {target['uri'] for target in binding['targets']}
    for issue in verify_artifacts(base_dir=root)['issues']:
        permitted = (
            (issue.get('code') == 'run_artifact_missing' and issue.get('artifact_id') in target_ids)
            or (issue.get('code') == 'artifact_projection_missing' and issue.get('artifact_id') in target_ids
                and issue.get('surface') == _INDEX)
            or (issue.get('code') == 'artifact_unindexed' and issue.get('path') in target_uris)
            or issue == {'code': 'artifact_recovery_incomplete', 'recovery_id': binding['recovery_id']}
        )
        if not permitted:
            raise GovernanceError('artifact_recovery_preflight_graph_invalid')
    result = {k: v for k, v in binding.items() if k not in {'targets', 'reason', 'operator_approval_ref'}}
    result.update(status='dry_run' if dry_run else 'already_recovered' if receipts else 'recovered',
                  recovered_count=len(binding['targets']), expected_base_head=binding['expected_state_sha'],
                  published_state_sha=None)
    if dry_run:
        return {**result, 'targets': binding['targets']}
    if not intents:
        acceptance = load_declared_jsonl(root / _ACCEPTANCE, expected_surface='enterprise_acceptance_events')
        boundary = {'row_count': len(acceptance), 'rows_digest': _digest([_plain(row) for row in acceptance]),
                    'tip_ledger_hash': acceptance[-1].get('ledger_hash') if acceptance else None}
        intent = {**binding, 'event': STARTED, 'schema_version': 1, 'recorded_at': utc_now(),
                  'acceptance_boundary': boundary}
        transaction.append_declared_jsonl(root / _EVENTS, intent, expected_surface='retention_events')
    else:
        intent = intents[0]
    for target in binding['targets']:
        _materialize(store, root, target)
    if index != merged:
        transaction.rewrite_declared_jsonl(root / ARTIFACT_PROJECTION_PATHS[_INDEX], merged,
                                          expected_surface=_INDEX, migration_id='git-recovery.' + binding['recovery_id'])
    for surface, digest in binding['claim_digests'].items():
        if _hash_file(root / ARTIFACT_PROJECTION_PATHS[surface])[0] != digest:
            raise GovernanceError('artifact_recovery_current_claim_bytes_changed')
    verification = verify_artifacts(base_dir=root)
    if any(issue != {'code': 'artifact_recovery_incomplete', 'recovery_id': binding['recovery_id']}
           for issue in verification['issues']):
        raise GovernanceError('artifact_recovery_final_graph_invalid')
    _require_host_binding(store, root)
    if _git(store.root, '--no-replace-objects', 'rev-parse', 'HEAD').strip() != binding['expected_state_sha']:
        raise GovernanceError('artifact_recovery_expected_state_mismatch')
    if not receipts:
        transaction.append_declared_jsonl(root / _EVENTS, {
            **binding, 'schema_version': 1, 'event': COMPLETED, 'recorded_at': utc_now(),
            'acceptance_boundary': intent['acceptance_boundary'], 'verification_status': 'storage_verified',
        }, expected_surface='retention_events')
    return result


def recovery_evidence_issues(
    events: list[dict[str, Any]], index_rows: list[dict[str, Any]],
    artifact_refs: list[Any], *, cycle_id: str | None,
) -> list[dict[str, Any]]:
    """Retain storage diagnostics without admitting recovered execution evidence.

    The storage graph validates the recovery plan separately. Cycle scope comes
    from the canonical index or an actual run reference, never from timestamps.
    Missing cycle identity remains unbound and cannot earn positive credit.
    """
    # Match the storage graph's diagnostic identity normalization even when
    # it has already rejected malformed projection/reference metadata.
    index = {str(row.get('artifact_id') or ''): row for row in index_rows}
    referenced = {str(ref.get('artifact_id') or '') for ref in artifact_refs if isinstance(ref, dict)}
    recovered: set[str] = set()
    for event in events:
        if event.get('event') not in {STARTED, COMPLETED}:
            continue
        targets = event.get('targets')
        if not _valid_target_plan(targets):
            continue  # The storage graph rejects malformed plans.
        for target in targets:
            artifact_id = target['artifact_id']
            row = index.get(artifact_id, {})
            bound_cycle = row.get('cycle_uid') or row.get('cycle_id')
            if cycle_id is None or not bound_cycle or bound_cycle == cycle_id or artifact_id in referenced:
                recovered.add(artifact_id)
    return [{'code': 'artifact_recovery_needs_revalidation', 'artifact_id': artifact_id}
            for artifact_id in sorted(recovered)]


def _valid_target_plan(targets: Any) -> bool:
    if not isinstance(targets, list) or not targets:
        return False
    keys = {'artifact_id', 'uri', 'sha256', 'size_bytes', 'source_object_id', 'source_index_row_digest'}
    ids: set[str] = set()
    uris: set[str] = set()
    for target in targets:
        if (not isinstance(target, dict) or set(target) != keys
                or not isinstance(target['artifact_id'], str) or not target['artifact_id']
                or not _valid_hot_uri(target['uri'])
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', str(target['sha256']))
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', str(target['source_index_row_digest']))
                or not _SHA.fullmatch(str(target['source_object_id']))
                or not isinstance(target['size_bytes'], int) or isinstance(target['size_bytes'], bool)
                or target['size_bytes'] < 0
                or target['artifact_id'] in ids or target['uri'] in uris):
            return False
        ids.add(target['artifact_id'])
        uris.add(target['uri'])
    return targets == sorted(targets, key=lambda target: (target['uri'], target['artifact_id']))


def recovery_graph_issues(
    events: list[dict[str, Any]], blobs: dict[str, tuple[str, int]],
    projections: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Shared filesystem/immutable-tree provenance validation, including pending intent."""
    by_surface_id: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for surface in ARTIFACT_PROJECTION_PATHS:
        by_surface_id[surface] = {}
        for row in projections.get(surface, []):
            by_surface_id[surface].setdefault(str(row.get('artifact_id') or ''), []).append(row)
    issues: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}
    completed: set[str] = set()
    for row in events:
        if row.get('event') not in {STARTED, COMPLETED}:
            continue
        recovery_id = row.get('recovery_id')
        if not isinstance(recovery_id, str) or not _ID.fullmatch(recovery_id):
            issues.append({'code': 'artifact_recovery_invalid_binding'})
            continue
        if row['event'] == STARTED:
            targets = row.get('targets')
            valid = (
                recovery_id not in seen and _valid_target_plan(targets)
                and row.get('target_plan_digest') == _digest(targets)
                and row.get('implementation_version') == RECOVERY_VERSION
                and row.get('evidence_status') == 'needs_revalidation'
                and row.get('evidence_class') == 'historical_recovered'
                and row.get('source_snapshot_scope') == 'not_full_verified'
                and _SHA.fullmatch(str(row.get('expected_state_sha') or ''))
                and _SHA.fullmatch(str(row.get('source_state_sha') or ''))
                and isinstance(row.get('acceptance_boundary'), dict)
            )
            if not valid:
                issues.append({'code': 'artifact_recovery_invalid_binding', 'recovery_id': recovery_id})
                continue
            seen[recovery_id] = row
        else:
            intent = seen.get(recovery_id)
            excluded = {'event', 'recorded_at', 'ledger_hash', 'previous_ledger_hash'}
            if (intent is None or recovery_id in completed
                    or any(row.get(k) != v for k, v in intent.items() if k not in excluded)
                    or row.get('verification_status') != 'storage_verified'):
                issues.append({'code': 'artifact_recovery_invalid_receipt', 'recovery_id': recovery_id})
                continue
            completed.add(recovery_id)
            for target in intent['targets']:
                if blobs.get(target['uri']) != (target['sha256'], target['size_bytes']):
                    issues.append({'code': 'artifact_recovery_receipt_blob_mismatch', 'recovery_id': recovery_id})
                expected = {key: target[key] for key in ('artifact_id', 'uri', 'sha256', 'size_bytes')}
                for surface in ARTIFACT_PROJECTION_PATHS:
                    rows = by_surface_id[surface].get(target['artifact_id'], [])
                    try:
                        claims = _claims(rows)
                        valid = len(rows) == 1 and claims.get(target['artifact_id']) == expected
                    except GovernanceError:
                        valid = False
                    if valid and surface == _INDEX:
                        valid = _digest(_plain(rows[0])) == target['source_index_row_digest']
                    if not valid:
                        issues.append({'code': 'artifact_recovery_receipt_projection_mismatch',
                                       'recovery_id': recovery_id, 'artifact_id': target['artifact_id'], 'surface': surface})
    for recovery_id in seen.keys() - completed:
        issues.append({'code': 'artifact_recovery_incomplete', 'recovery_id': recovery_id})
    return issues
