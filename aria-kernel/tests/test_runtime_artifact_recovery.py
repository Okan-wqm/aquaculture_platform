from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import runtime_artifacts
from aria_kernel.ledger import load_declared_jsonl, rewrite_declared_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.state_store import tools_root
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding
from tests.test_state_store import StateStoreTestCase, _git


class RecoveryEvidenceProjectionTests(unittest.TestCase):
    def test_malformed_identity_metadata_does_not_crash_diagnostic_projection(self) -> None:
        from aria_kernel.runtime_artifact_recovery import recovery_evidence_issues
        self.assertEqual(recovery_evidence_issues(
            [], [{'artifact_id': []}], [{'artifact_id': {}}], cycle_id=None), [])


class GitArtifactRecoveryTests(StateStoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.store = self._bootstrap()
        self.tools = tools_root(self.store)
        set_profile('standard', operator_approval_ref='fixture', base_dir=self.tools)
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        self.written = runtime_artifacts.write_run_artifact(
            base_dir=self.tools, run_id='old-run', cycle_uid='old-cycle', tool_id='fixture',
            kind='tool_run', payload={'benign': 'historical fixture'}, run_status='ok')
        self.path = self.tools / self.written['artifact_ref']['uri']
        self.content = self.path.read_bytes()
        self._commit_in_store(self.store, 'fixture historical artifact')
        self.source = _git(self.store.root, 'rev-parse', 'HEAD').strip()
        self.path.unlink()
        rewrite_declared_jsonl(self.tools / 'run-artifacts/artifact-index.jsonl', [],
                               expected_surface='runtime_artifact_index', migration_id='fixture-deletion')
        self._commit_in_store(self.store, 'fixture historical deletion')
        self.expected = _git(self.store.root, 'rev-parse', 'HEAD').strip()
        self.claims = {p: (self.tools / p).read_bytes() for p in (
            'run-artifacts/manifest.jsonl', 'observability/artifact-inventory.jsonl')}
        self.env = mock.patch.dict(os.environ, {'ARIA_TEST_RECOVERY_APPROVAL': 'approved'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def recover(self, **overrides: object) -> dict:
        self.assertTrue(hasattr(runtime_artifacts, 'recover_git_history_artifacts'),
                        'canonical Git-history recovery API is absent')
        args = dict(store=self.store, expected_state_sha=self.expected, source_state_sha=self.source,
                    recovery_id='fixture-recovery', reason='Restore verified historical fixture',
                    operator_approval_ref='ack-env:ARIA_TEST_RECOVERY_APPROVAL', acknowledge=True)
        args.update(overrides)
        return runtime_artifacts.recover_git_history_artifacts(**args)

    def events(self) -> list[dict]:
        return load_declared_jsonl(self.tools / 'retention/events.jsonl', expected_surface='retention_events')

    def test_recovers_projection_only_loss_without_attesting_whole_source(self) -> None:
        result = self.recover()
        self.assertEqual(result['status'], 'recovered')
        self.assertEqual(result['source_snapshot_scope'], 'not_full_verified')
        self.assertEqual(result['expected_base_head'], self.expected)
        self.assertIsNone(result['published_state_sha'])
        self.assertEqual(self.path.read_bytes(), self.content)
        self.assertTrue(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])
        for path, content in self.claims.items():
            self.assertEqual((self.tools / path).read_bytes(), content)
        self.assertEqual([row['event'] for row in self.events()], [
            'artifact_git_recovery_started', 'artifact_recovered_from_git_history'])
        self.assertNotIn('historical fixture', json.dumps(result))
        self.assertEqual(self.recover()['status'], 'already_recovered')
        self.assertEqual(len(self.events()), 2)

    def test_dry_run_does_not_write_any_file(self) -> None:
        before = {str(p): p.read_bytes() for p in self.store.root.rglob('*') if p.is_file()}
        self.assertEqual(self.recover(dry_run=True)['status'], 'dry_run')
        after = {str(p): p.read_bytes() for p in self.store.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_recovered_cycle_keeps_diagnostics_without_promotion_credit(self) -> None:
        from tests._helpers.declared_fixtures import append_declared_fixture
        def add_cycle(cycle_id='old-cycle', written=None):
            written = self.written if written is None else written
            (self.tools / 'registry.json').write_text('{"tools": []}')
            append_declared_fixture(self.tools / 'cycles.jsonl', {
                'cycle_id': cycle_id, 'event': 'completed', 'status': 'completed',
            }, expected_surface='cycles')
            append_declared_fixture(self.tools / 'runs.jsonl', {
                'schema_version': 2, 'run_id': written['artifact_ref']['produced_by_workflow_run_id'],
                'tool_id': 'fixture', 'cycle_id': cycle_id, 'status': 'ok',
                'artifact_ref': written['artifact_ref'],
                'artifact_refs': [written['artifact_ref']],
                'artifact_hash': written['artifact_hash'],
                'artifact_status': written['artifact_status'],
                'runner': {'raw_findings_count': 0},
            }, expected_surface='runs')
        self._replace_historical_fixture(add_cycle)
        self.recover()
        self.assertTrue(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])
        result = runtime_artifacts.classify_cycle_evidence(base_dir=self.tools, cycle_id='old-cycle')
        self.assertFalse(result['promotion_eligible'])
        self.assertEqual(result['cycle_evidence_class'], 'historical_recovered')
        self.assertGreater(result['verified_artifact_count'], 0)
        self.assertIsNotNone(runtime_artifacts.resolve_artifact_payload(
            self.written['artifact_ref'], base_dir=self.tools))
        add_cycle('later-cycle')
        self.assertFalse(runtime_artifacts.classify_cycle_evidence(
            base_dir=self.tools, cycle_id='later-cycle')['promotion_eligible'])
        fresh = runtime_artifacts.write_run_artifact(
            base_dir=self.tools, run_id='fresh-run', cycle_uid='fresh-cycle', tool_id='fixture',
            kind='tool_run', payload={'benign': 'new execution'}, run_status='ok')
        add_cycle('fresh-cycle', fresh)
        self.assertTrue(runtime_artifacts.classify_cycle_evidence(
            base_dir=self.tools, cycle_id='fresh-cycle')['promotion_eligible'])

    def test_recovered_storage_cannot_approve_runtime_v2(self) -> None:
        (self.tools / 'registry.json').write_text('{"tools": []}')
        self.recover()
        bundle = self.tools / 'runtime/recovery-fixture-bundle.json'
        bundle.parent.mkdir(parents=True, exist_ok=True)
        bundle.write_text(json.dumps({'target_sha': _git(self.repo, 'rev-parse', 'HEAD').strip()}))
        with self.assertRaisesRegex(GovernanceError, 'needs_revalidation'):
            runtime_artifacts.approve_runtime_v2_promotion(
                evidence_bundle=bundle, base_dir=self.tools, workspace_root=self.repo,
                operator_approval_ref='ack-env:ARIA_TEST_RECOVERY_APPROVAL')

    def test_missing_malformed_or_unknown_recovery_state_never_verifies_evidence(self) -> None:
        (self.tools / 'registry.json').write_text('{"tools": []}')
        self.recover()
        self.assertTrue(runtime_artifacts.verify_runtime_artifacts(base_dir=self.tools)['valid'])
        baseline = self.events()
        for field, value in (('evidence_status', None), ('evidence_status', 'unknown'),
                             ('acceptance_boundary', None), ('targets', 'malformed')):
            with self.subTest(field=field, value=value):
                rows = json.loads(json.dumps(baseline))
                for row in rows:
                    if value is None:
                        row.pop(field)
                    else:
                        row[field] = value
                rewrite_declared_jsonl(self.tools / 'retention/events.jsonl', rows,
                                       expected_surface='retention_events', migration_id='fixture-invalid-recovery')
                result = runtime_artifacts.verify_runtime_artifacts(base_dir=self.tools)
                self.assertFalse(result['valid'])
                self.assertEqual(result['evidence_status'], 'integrity_failed')

    def test_foreign_host_identity_refuses_before_intent(self) -> None:
        path = self.tools / 'repo_identity.json'
        identity = json.loads(path.read_text())
        identity['bound_canonical_identity'] = 'foreign/repository'
        path.write_text(json.dumps(identity))
        with self.assertRaisesRegex(GovernanceError, 'binding'):
            self.recover()
        self.assertFalse(self.path.exists())
        self.assertEqual(self.events(), [])

    def test_refuses_bad_binding_and_unacknowledged_recovery_without_blob(self) -> None:
        for override in ({'acknowledge': False}, {'source_state_sha': 'HEAD'},
                         {'expected_state_sha': self.source}, {'source_state_sha': 'f' * 40},
                         {'operator_approval_ref': 'unrecorded'}):
            with self.subTest(override=override), self.assertRaises(GovernanceError):
                self.recover(**override)
            self.assertFalse(self.path.exists())

    def test_refuses_unattributed_existing_blob(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(self.content)
        with self.assertRaisesRegex(GovernanceError, 'unexpected'):
            self.recover()

    def test_retry_after_index_write_uses_intent_plan(self) -> None:
        from aria_kernel.ledger import StateTransaction
        original = StateTransaction.append_declared_jsonl
        def fail_receipt(transaction, path, record, **kwargs):
            if record.get('event') == 'artifact_recovered_from_git_history':
                raise OSError('fixture interruption')
            return original(transaction, path, record, **kwargs)
        with mock.patch.object(StateTransaction, 'append_declared_jsonl', fail_receipt):
            with self.assertRaisesRegex(OSError, 'fixture interruption'):
                self.recover()
        self.assertEqual(len(self.events()), 1)
        self.assertTrue(self.path.exists())
        self.assertEqual(self.recover()['recovered_count'], 1)
        self.assertEqual(len(self.events()), 2)
        with self.assertRaisesRegex(GovernanceError, 'binding'):
            self.recover(reason='Different operator justification')

    def test_retry_before_first_blob_keeps_graph_invalid(self) -> None:
        with mock.patch('aria_kernel.runtime_artifact_recovery._materialize', side_effect=OSError('before blob')):
            with self.assertRaisesRegex(OSError, 'before blob'):
                self.recover()
        self.assertFalse(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])
        self.assertEqual(self.recover()['status'], 'recovered')

    def test_retry_after_blob_before_index_and_divergent_bytes_refuse(self) -> None:
        from aria_kernel.ledger import StateTransaction
        with mock.patch.object(StateTransaction, 'rewrite_declared_jsonl', side_effect=OSError('before index')):
            with self.assertRaisesRegex(OSError, 'before index'):
                self.recover()
        self.assertTrue(self.path.exists())
        self.path.write_bytes(b'divergent benign fixture')
        with self.assertRaisesRegex(GovernanceError, 'unexpected_target'):
            self.recover()
        self.path.write_bytes(self.content)
        self.assertEqual(self.recover()['status'], 'recovered')

    def test_completed_index_without_receipt_still_invalid(self) -> None:
        from aria_kernel.ledger import StateTransaction
        original = StateTransaction.append_declared_jsonl
        def interrupt(transaction, path, row, **kwargs):
            if row.get('event') == 'artifact_recovered_from_git_history':
                raise OSError('before receipt')
            return original(transaction, path, row, **kwargs)
        with mock.patch.object(StateTransaction, 'append_declared_jsonl', interrupt):
            with self.assertRaises(OSError):
                self.recover()
        self.assertFalse(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])

    def test_local_current_claim_mutation_refuses_before_intent(self) -> None:
        path = self.tools / 'run-artifacts/manifest.jsonl'
        path.write_bytes(path.read_bytes() + b'\n')
        with self.assertRaisesRegex(GovernanceError, 'claim_bytes_changed'):
            self.recover()
        self.assertFalse(self.path.exists())
        self.assertEqual(self.events(), [])

    def test_symlink_parent_refuses_before_intent(self) -> None:
        parent = self.path.parent
        parent.rmdir()
        parent.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaises(GovernanceError):
            self.recover()
        self.assertEqual(self.events(), [])

    def test_new_current_artifact_and_existing_index_order_are_preserved(self) -> None:
        new = runtime_artifacts.write_run_artifact(
            base_dir=self.tools, run_id='new-run', cycle_uid='new-cycle', tool_id='fixture',
            kind='tool_run', payload={'benign': 'new evidence'}, run_status='ok')
        new_path = self.tools / new['artifact_ref']['uri']
        new_bytes = new_path.read_bytes()
        self._commit_in_store(self.store, 'fixture new evidence')
        self.expected = _git(self.store.root, 'rev-parse', 'HEAD').strip()
        index_bytes = (self.tools / "run-artifacts/artifact-index.jsonl").read_bytes()
        self.recover()
        self.assertTrue((self.tools / "run-artifacts/artifact-index.jsonl").read_bytes().startswith(index_bytes))
        rows = load_declared_jsonl(self.tools / 'run-artifacts/artifact-index.jsonl',
                                  expected_surface='runtime_artifact_index')
        self.assertEqual([r['artifact_id'] for r in rows], [new['artifact_id'], self.written['artifact_id']])
        self.assertEqual(new_path.read_bytes(), new_bytes)

    def test_unrelated_source_snapshot_is_not_required(self) -> None:
        self.assertFalse((self.store.root / 'snapshot.json').exists())
        self.assertEqual(self.recover()['status'], 'recovered')

    def test_unrelated_graph_loss_refuses_before_recovery_intent(self) -> None:
        new = runtime_artifacts.write_run_artifact(
            base_dir=self.tools, run_id='unrelated-run', cycle_uid='unrelated-cycle', tool_id='fixture',
            kind='tool_run', payload={'benign': True}, run_status='ok')
        (self.tools / new['artifact_ref']['uri']).unlink()
        self._commit_in_store(self.store, 'fixture unrelated loss')
        self.expected = _git(self.store.root, 'rev-parse', 'HEAD').strip()
        with self.assertRaisesRegex(GovernanceError, 'graph'):
            self.recover()
        self.assertFalse(self.path.exists())
        self.assertEqual(self.events(), [])

    def test_cli_refusal_is_machine_readable(self) -> None:
        import io
        from aria_kernel.cli import main
        argv = ['--tools-dir', str(self.tools), 'runtime', 'recover-git-history-artifacts',
                '--workspace-root', str(self.repo), '--expected-state-sha', 'HEAD',
                '--source-state-sha', self.source, '--recovery-id', 'fixture-recovery',
                '--reason', 'Restore verified historical fixture',
                '--operator-approval-ref', 'ack-env:ARIA_TEST_RECOVERY_APPROVAL', '--acknowledge']
        output = io.StringIO()
        with mock.patch('sys.stdout', output):
            self.assertEqual(main(argv), 4)
        self.assertEqual(json.loads(output.getvalue())['status'], 'refused')
        self.assertFalse(self.path.exists())

    def test_cli_requires_binding_and_routes_to_canonical_api(self) -> None:
        from aria_kernel.cli import main
        argv = ['--tools-dir', str(self.tools), 'runtime', 'recover-git-history-artifacts',
                '--workspace-root', str(self.repo), '--expected-state-sha', self.expected,
                '--source-state-sha', self.source, '--recovery-id', 'fixture-recovery',
                '--reason', 'Restore verified historical fixture',
                '--operator-approval-ref', 'ack-env:ARIA_TEST_RECOVERY_APPROVAL', '--acknowledge', '--dry-run']
        with mock.patch('sys.stdout'):
            self.assertEqual(main(argv), 0)
        self.assertFalse(self.path.exists())

    def test_recovery_excludes_future_dated_old_acceptance_and_keeps_violations(self) -> None:
        from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock
        from aria_kernel.ledger import append_declared_jsonl
        path = self.tools / 'enterprise/acceptance-events.jsonl'
        for event_type, status in [('observe_success', 'success'), ('critical_violation', 'violation')]:
            append_declared_jsonl(path, {'event_type': event_type, 'status': status,
                                        'recorded_at': '2099-01-01T00:00:00Z'},
                                  expected_surface='enterprise_acceptance_events')
        self.recover()
        verdict = evaluate_autonomy_unlock(lane='L1', base_dir=self.tools)
        self.assertEqual(verdict.counts['observe_successes'], 0)
        self.assertEqual(verdict.counts['critical_violations'], 1)
        self.assertTrue(any('revalidation' in reason for reason in verdict.reasons))

    def test_post_recovery_unbound_success_is_not_independent_validation(self) -> None:
        from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock, record_acceptance_event
        self.recover()
        record_acceptance_event(event_type='observe_success', base_dir=self.tools)
        verdict = evaluate_autonomy_unlock(lane='L1', base_dir=self.tools)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.counts['observe_successes'], 0)

    def test_missing_or_altered_acceptance_boundary_fails_closed(self) -> None:
        from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock, record_acceptance_event
        record_acceptance_event(event_type='observe_success', base_dir=self.tools)
        self.recover()
        path = self.tools / 'retention/events.jsonl'
        for boundary in (None, {'row_count': 0, 'rows_digest': 'sha256:' + '0' * 64}):
            rows = self.events()
            for row in rows:
                row['acceptance_boundary'] = boundary
            rewrite_declared_jsonl(path, rows, expected_surface='retention_events', migration_id='fixture-bad-boundary')
            verdict = evaluate_autonomy_unlock(lane='L1', base_dir=self.tools)
            self.assertFalse(verdict.valid)
            self.assertEqual(verdict.counts['observe_successes'], 0)
            self.assertIn('artifact_recovery_acceptance_boundary_invalid', verdict.reasons)

    def test_immutable_count_accumulator_and_standalone_exclude_same_old_credit(self) -> None:
        from aria_kernel.autonomy_evidence import _StreamingEvidenceAccumulator
        from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock, record_acceptance_event
        record_acceptance_event(event_type='observe_success', base_dir=self.tools)
        record_acceptance_event(event_type='critical_violation', base_dir=self.tools)
        self.recover()
        acceptance = load_declared_jsonl(self.tools / 'enterprise/acceptance-events.jsonl',
                                        expected_surface='enterprise_acceptance_events')
        accumulator = _StreamingEvidenceAccumulator()
        accumulator.consume_recovery_bound_acceptance(acceptance, [{'valid': True}], self.events())
        verdict = evaluate_autonomy_unlock(lane='L1', base_dir=self.tools)
        self.assertEqual(accumulator.acceptance_success_event_counts['observe_success'], verdict.counts['observe_successes'])
        self.assertEqual(accumulator.metrics['acceptance_critical_violations'], verdict.counts['critical_violations'])
        self.assertEqual(accumulator.acceptance_unlock_counts['valid'], 0)
        self.assertIn('artifact_recovery_acceptance_needs_revalidation', accumulator.native_blockers['autonomy_unlock'])

    def test_governance_approval_dry_run_is_read_only(self) -> None:
        from tests.test_runtime_artifacts import _record_test_approval, _APPROVAL_REF
        _record_test_approval(self.tools)
        before = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.store.root.rglob('*') if p.is_file()}
        self.recover(dry_run=True, operator_approval_ref=_APPROVAL_REF)
        after = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.store.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_pending_recovery_blocks_all_positive_acceptance(self) -> None:
        from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock, record_acceptance_event
        record_acceptance_event(event_type='observe_success', base_dir=self.tools)
        with mock.patch('aria_kernel.runtime_artifact_recovery._materialize', side_effect=OSError('fixture crash')):
            with self.assertRaises(OSError):
                self.recover()
        verdict = evaluate_autonomy_unlock(lane='L1', base_dir=self.tools)
        self.assertEqual(verdict.counts['observe_successes'], 0)
        self.assertIn('artifact_recovery_incomplete', verdict.reasons)

    def _replace_historical_fixture(self, change) -> None:
        _git(self.store.root, 'reset', '--hard', self.source)
        change()
        self._commit_in_store(self.store, 'fixture changed historical source')
        self.source = _git(self.store.root, 'rev-parse', 'HEAD').strip()
        self.path.unlink(missing_ok=True)
        rewrite_declared_jsonl(self.tools / 'run-artifacts/artifact-index.jsonl', [],
                               expected_surface='runtime_artifact_index', migration_id='fixture-deletion')
        self._commit_in_store(self.store, 'fixture deletion after changed source')
        self.expected = _git(self.store.root, 'rev-parse', 'HEAD').strip()

    def test_source_stream_hash_mismatch_refuses_before_intent(self) -> None:
        self._replace_historical_fixture(lambda: self.path.write_bytes(b'x' * len(self.content)))
        with self.assertRaisesRegex(GovernanceError, 'source_hash_or_size_mismatch'):
            self.recover()
        self.assertEqual(self.events(), [])

    def test_source_size_mismatch_refuses_before_intent(self) -> None:
        self._replace_historical_fixture(lambda: self.path.write_bytes(b'wrong size'))
        with self.assertRaisesRegex(GovernanceError, 'source_size_mismatch'):
            self.recover()
        self.assertEqual(self.events(), [])

    def test_source_projection_disagreement_refuses(self) -> None:
        def change():
            path = self.tools / 'run-artifacts/artifact-index.jsonl'
            rows = load_declared_jsonl(path, expected_surface='runtime_artifact_index')
            rows[0]['sha256'] = 'sha256:' + 'a' * 64
            rewrite_declared_jsonl(path, rows, expected_surface='runtime_artifact_index', migration_id='fixture')
        self._replace_historical_fixture(change)
        with self.assertRaisesRegex(GovernanceError, 'source_projection_mismatch'):
            self.recover()
        self.assertEqual(self.events(), [])

    def test_duplicate_source_identity_refuses(self) -> None:
        def change():
            path = self.tools / 'run-artifacts/artifact-index.jsonl'
            rows = load_declared_jsonl(path, expected_surface='runtime_artifact_index')
            rewrite_declared_jsonl(path, rows + rows, expected_surface='runtime_artifact_index', migration_id='fixture')
        self._replace_historical_fixture(change)
        with self.assertRaisesRegex(GovernanceError, 'projection_duplicate'):
            self.recover()

    def test_git_replacement_refs_cannot_rebind_source_objects(self) -> None:
        original = _git(self.store.root, 'rev-parse', f'{self.source}:tools/run-artifacts/artifact-index.jsonl').strip()
        replacement = _git(self.store.root, 'rev-parse', f'{self.expected}:tools/run-artifacts/artifact-index.jsonl').strip()
        _git(self.store.root, 'replace', original, replacement)
        self.assertEqual(self.recover()['status'], 'recovered')
        self.assertEqual(self.path.read_bytes(), self.content)

    def test_non_ancestor_refuses(self) -> None:
        unrelated = _git(self.repo, 'rev-parse', 'HEAD').strip()
        with self.assertRaisesRegex(GovernanceError, 'source_not_ancestor'):
            self.recover(source_state_sha=unrelated)
        self.assertEqual(self.events(), [])

    def test_retry_after_durable_receipt_does_not_duplicate_it(self) -> None:
        from aria_kernel.ledger import StateTransaction
        original = StateTransaction.append_declared_jsonl
        def interrupt(transaction, path, row, **kwargs):
            result = original(transaction, path, row, **kwargs)
            if row.get('event') == 'artifact_recovered_from_git_history':
                raise OSError('after receipt')
            return result
        with mock.patch.object(StateTransaction, 'append_declared_jsonl', interrupt):
            with self.assertRaisesRegex(OSError, 'after receipt'):
                self.recover()
        self.assertEqual(self.recover()['status'], 'already_recovered')
        self.assertEqual(len(self.events()), 2)

    def test_source_projection_traversal_refuses(self) -> None:
        def change():
            for surface, relative in runtime_artifacts.ARTIFACT_PROJECTION_PATHS.items():
                path = self.tools / relative
                rows = load_declared_jsonl(path, expected_surface=surface)
                key = 'path' if surface == 'runtime_artifact_inventory' else 'current_uri'
                rows[0][key] = 'run-artifacts/hot/../outside.json'
                rewrite_declared_jsonl(path, rows, expected_surface=surface, migration_id='fixture')
        self._replace_historical_fixture(change)
        with self.assertRaisesRegex(GovernanceError, 'path'):
            self.recover()
        self.assertEqual(self.events(), [])

    def test_source_git_symlink_refuses(self) -> None:
        def change():
            self.path.unlink()
            self.path.symlink_to('benign-fixture-target')
        self._replace_historical_fixture(change)
        with self.assertRaisesRegex(GovernanceError, 'source_object_not_regular'):
            self.recover()
        self.assertEqual(self.events(), [])

    def test_completed_recovery_refuses_later_index_loss(self) -> None:
        self.recover()
        rewrite_declared_jsonl(self.tools / 'run-artifacts/artifact-index.jsonl', [],
                               expected_surface='runtime_artifact_index', migration_id='fixture-new-loss')
        with self.assertRaisesRegex(GovernanceError, 'unexpected_index'):
            self.recover()

    def test_multiple_artifact_plan_survives_interruption_between_blobs(self) -> None:
        def add_source_artifacts():
            for number in range(2):
                runtime_artifacts.write_run_artifact(
                    base_dir=self.tools, run_id=f'extra-{number}', cycle_uid='old-cycle', tool_id='fixture',
                    kind='tool_run', payload={'benign': number}, run_status='ok')
        self._replace_historical_fixture(add_source_artifacts)
        for path in (self.tools / 'run-artifacts/hot').rglob('*.json'):
            path.unlink()
        self._commit_in_store(self.store, 'fixture remove all source blobs')
        self.expected = _git(self.store.root, 'rev-parse', 'HEAD').strip()
        from aria_kernel import runtime_artifact_recovery as recovery
        original = recovery._materialize
        attempts = 0
        def interrupt(store, root, target):
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                raise OSError('between blobs')
            return original(store, root, target)
        with mock.patch.object(recovery, '_materialize', interrupt):
            with self.assertRaisesRegex(OSError, 'between blobs'):
                self.recover()
        self.assertEqual(len(self.events()[0]['targets']), 3)
        self.assertEqual(self.recover()['recovered_count'], 3)
        self.assertTrue(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])

    def test_receipt_target_identity_cannot_alias_another_artifact(self) -> None:
        from aria_kernel.runtime_artifact_recovery import _digest
        self.recover()
        rows = self.events()
        for row in rows:
            row['targets'][0]['artifact_id'] = 'wrong-artifact-identity'
            row['target_plan_digest'] = _digest(row['targets'])
        rewrite_declared_jsonl(self.tools / 'retention/events.jsonl', rows,
                               expected_surface='retention_events', migration_id='fixture')
        self.assertFalse(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])

    def test_receipt_source_index_digest_must_match_restored_index_row(self) -> None:
        from aria_kernel.runtime_artifact_recovery import _digest
        self.recover()
        rows = self.events()
        for row in rows:
            row['targets'][0]['source_index_row_digest'] = 'sha256:' + '0' * 64
            row['target_plan_digest'] = _digest(row['targets'])
        rewrite_declared_jsonl(self.tools / 'retention/events.jsonl', rows,
                               expected_surface='retention_events', migration_id='fixture')
        self.assertFalse(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])

    def test_duplicate_receipt_target_plan_is_invalid(self) -> None:
        from aria_kernel.runtime_artifact_recovery import _digest
        self.recover()
        rows = self.events()
        for row in rows:
            row['targets'].append(dict(row['targets'][0]))
            row['target_plan_digest'] = _digest(row['targets'])
        rewrite_declared_jsonl(self.tools / 'retention/events.jsonl', rows,
                               expected_surface='retention_events', migration_id='fixture')
        self.assertFalse(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])

    def test_dry_run_discloses_reviewable_metadata_plan(self) -> None:
        result = self.recover(dry_run=True)
        self.assertEqual(result['targets'][0]['artifact_id'], self.written['artifact_id'])
        self.assertEqual(result['targets'][0]['uri'], self.written['artifact_ref']['uri'])
        self.assertEqual(result['targets'][0]['size_bytes'], len(self.content))
        self.assertNotIn('index_row', result['targets'][0])
        self.assertNotIn('benign', json.dumps(result))

    def test_receipt_plan_mismatch_invalidates_storage_graph(self) -> None:
        self.recover()
        rows = self.events()
        rows[-1]['target_plan_digest'] = 'sha256:' + '0' * 64
        rewrite_declared_jsonl(self.tools / 'retention/events.jsonl', rows,
                               expected_surface='retention_events', migration_id='fixture')
        self.assertFalse(runtime_artifacts.verify_artifacts(base_dir=self.tools)['valid'])



class RecoveryPublicationTests(StateStoreTestCase):
    def test_recovery_uses_normal_publisher_and_restores_verified_tree(self) -> None:
        from aria_kernel.state_store import publish_state, verify_state_store
        from tests.test_state_store import REPO_HASH
        store = self._bootstrap()
        tools = tools_root(store)
        set_profile('standard', operator_approval_ref='fixture', base_dir=tools)
        ensure_tools_binding(tools, workspace_root=self.repo)
        from aria_kernel.autonomy_unlock import record_acceptance_event
        record_acceptance_event(event_type='observe_success', base_dir=tools)
        record_acceptance_event(event_type='critical_violation', base_dir=tools)
        written = runtime_artifacts.write_run_artifact(
            base_dir=tools, run_id='run', cycle_uid='cycle', tool_id='fixture',
            kind='tool_run', payload={'benign': True}, run_status='ok')
        publish_state(store, snapshot=self._snapshot(store, 'source'), cycle_id='source', repo_hash=REPO_HASH)
        source = _git(store.root, 'rev-parse', 'HEAD').strip()
        (tools / written['artifact_ref']['uri']).unlink()
        rewrite_declared_jsonl(tools / 'run-artifacts/artifact-index.jsonl', [],
                               expected_surface='runtime_artifact_index', migration_id='fixture-deletion')
        snapshot = self._snapshot(store, 'deletion')
        (store.root / 'snapshot.json').write_text(json.dumps(snapshot))
        _git(store.root, 'add', '--update')
        _git(store.root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid',
             '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture historical deletion')
        _git(store.root, 'push', 'origin', 'HEAD:refs/heads/aria/state')
        expected = _git(store.root, 'rev-parse', 'HEAD').strip()
        self.assertFalse(verify_state_store(store, repo_hash=REPO_HASH)['valid'])
        with mock.patch.dict(os.environ, {'ARIA_TEST_RECOVERY_APPROVAL': 'approved'}):
            result = runtime_artifacts.recover_git_history_artifacts(
                store=store, expected_state_sha=expected, source_state_sha=source,
                recovery_id='publish-recovery', reason='Restore verified historical fixture',
                operator_approval_ref='ack-env:ARIA_TEST_RECOVERY_APPROVAL', acknowledge=True)
        self.assertEqual(_git(self.remote, 'rev-parse', 'refs/heads/aria/state').strip(), expected)
        from aria_kernel.state_store import StateStoreRefusal
        with self.assertRaisesRegex(StateStoreRefusal, 'base_head_moved'):
            publish_state(store, snapshot=self._snapshot(store, 'stale-base'),
                          cycle_id='maintenance', repo_hash=REPO_HASH, expected_base_head=source)
        self.assertEqual(_git(self.remote, 'rev-parse', 'refs/heads/aria/state').strip(), expected)
        published = publish_state(store, snapshot=self._snapshot(store, 'recovered'),
                                  cycle_id='maintenance', repo_hash=REPO_HASH,
                                  expected_base_head=result['expected_base_head'])
        self.assertTrue(published['published'])
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)['valid'])
        from aria_kernel.autonomy_evidence import _verify_snapshot_and_collect_evidence
        state_sha = _git(store.root, 'rev-parse', 'HEAD').strip()
        snapshot_object = _git(store.root, 'rev-parse', 'HEAD:snapshot.json').strip()
        accumulator = _verify_snapshot_and_collect_evidence(
            store=store, repo_identity=REPO_HASH, state_commit=state_sha,
            expected_snapshot_object_id=snapshot_object)
        self.assertEqual(accumulator.acceptance_success_event_counts['observe_success'], 0)
        self.assertEqual(accumulator.metrics['acceptance_critical_violations'], 1)
        self.assertIn('artifact_recovery_acceptance_needs_revalidation', accumulator.native_blockers['autonomy_unlock'])
