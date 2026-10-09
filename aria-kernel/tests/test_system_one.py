"""System One `ask` (ARIA-LOW-252) — registry-only questions, state BUILT from references, the call ledger.

The transport is a scripted callable (never the network). The registry is the
file ``<bound workspace>/aria-config/system-one-questions.json`` the store is
bound to — the only place a question can come from — and every state value is
built by ``system_one`` from a reference into that workspace's git repository
or finding registry: a caller never hands it text.

One property per test:

* A transport that fails (or raises) yields a pipeline-safe ``Unavailable`` and
  exactly one ``unavailable`` row; ``ask`` never raises into its caller.
* A question that is not English, a question not in the registry, and a call
  from a decision point the question is not registered for are refused, and
  the transport is never called.
* Text instead of a reference, a path that escapes or names a credential
  file, a commit that is not a sha or not in the repository, an unregistered
  finding: refused before egress.
* Repository content that carries a credential shape, an e-mail address or a
  routable IPv4 address, or Turkish, is refused by the backstop over the
  FINAL payload — keys included — and never reaches the ledger.
* The ledger row carries the state's sha256, an id-shaped subject, the exact
  model id and the VALIDATED answer only — never the state, never the
  vendor's raw object.
* Choice options are shuffled deterministically per (question, state).
* Disabled (the seeded default): no network, no row — main's behaviour.
* An answer from a model other than the registry's runs as shadow.
* The seeded registry validates, is disabled, and every question is shadow.
* The ledger is an observation surface, not memory, and no other kernel
  module names it (an answer is never read back as a lesson or must_satisfy).
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import system_one
from aria_kernel.jev_runtime import JevReply, JevUnavailable
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.state_manifest import STATE_SURFACES
from aria_kernel.system_one import Answer, StateRef, Unavailable, ask, load_registry
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"

_J0 = {
    "id": "J0", "version": 1, "type": "noul",
    "instructions": "The diff fixes the problem described in the finding", "criteria": None,
    "decision_point": ["pre_pr_open", "merge_authority"], "mode": "shadow",
    "thresholds": {"question_below": 0.05}, "state_keys": ["finding", "diff"],
}
_KIND = {
    "id": "KIND", "version": 2, "type": "choice", "instructions": "Which kind of change the diff is",
    "criteria": {"fix": "A bug fix", "feature": "New behaviour", "refactor": "Same behaviour, new shape",
                 "test": "Tests only", "docs": "Documentation only"},
    "decision_point": ["pre_pr_open"], "mode": "order", "thresholds": {}, "state_keys": ["diff"],
}
_TURKISH = {**_J0, "id": "TR", "instructions": "Bu diff bulguyu düzeltiyor mu"}
_TRANSLIT = {**_J0, "id": "TRA", "instructions": "Bu diff bulguyu duzeltiyor mu"}
_UNBUILDABLE = {**_J0, "id": "ENV", "state_keys": ["finding", "env"]}

_FINDING = {"id": "ARIA-HIGH-123", "title": "Repository query skips tenant scoping",
            "rule_violated": "Use getScopedRepository"}


class _Transport:
    def __init__(self, *replies: object) -> None:
        self.replies = list(replies)
        self.payloads: list[dict[str, Any]] = []

    def __call__(self, payload: dict[str, Any]) -> JevReply | JevUnavailable:
        self.payloads.append(payload)
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        assert isinstance(reply, (JevReply, JevUnavailable))
        return reply


def _noul(p: float, model: str = "jev-1.13.0", name: str = "J0") -> JevReply:
    return JevReply(model=model, answers={name: {"type": "noul", "noul": p}}, input_tokens=120)


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.git("init", "-q", "-b", "main")
        (self.root / ".gitignore").write_text("aria-tools/\n", encoding="utf-8")
        registry = self.root / "docs" / "reviews" / "_registry" / "findings.jsonl"
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps(_FINDING) + "\n", encoding="utf-8")
        # "Public" is what the remote origin publishes: commits are pushed to a
        # bare origin, and the finding registry is read as origin/main holds it.
        self.origin = Path(self._tmp.name + "-origin.git")
        subprocess.run(["git", "init", "-q", "--bare", str(self.origin)], check=True)
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(self.origin)], check=False))
        self.git("remote", "add", "origin", str(self.origin))
        # The module fetches only from its pinned public URL; here that URL is the bare origin.
        pinned = mock.patch.object(system_one, "PUBLIC_REPOSITORY_URL", str(self.origin))
        pinned.start()
        self.addCleanup(pinned.stop)
        self.base = self.commit_file("src/x.ts", "repo.getRepository(X)\n", "base")
        self.fix = self.commit_file("src/x.ts", "repo.getScopedRepository(X)\n", "scope the repository")
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.write_registry([_J0, _KIND, _TURKISH, _TRANSLIT, _UNBUILDABLE])

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True,
                              text=True).stdout.strip()

    def commit_file(self, path: str, content: str, message: str, *, push: bool = True) -> str:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.git("add", "-A")
        self.git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false",
                 "commit", "-q", "-m", message)
        if push:
            self.git("push", "-q", "origin", "HEAD:main")
        return self.git("rev-parse", "HEAD")

    def refs(self, commit: str | None = None, path: str = "src/x.ts") -> dict[str, StateRef]:
        return {"finding": StateRef(finding_id="ARIA-HIGH-123"), "diff": StateRef(commit=commit or self.fix, path=path)}

    def write_registry(self, questions: list[dict[str, Any]], *, enabled: bool = True) -> None:
        path = self.root / "aria-config" / "system-one-questions.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "$schema": "aria/system-one-questions/v1", "enabled": enabled, "model": "jev-1.13.0",
            "questions": questions,
        }), encoding="utf-8")

    def rows(self) -> list[dict[str, Any]]:
        path = self.tools.joinpath(*system_one.CALLS_RELPATH)
        return load_declared_jsonl(path, expected_surface=system_one.CALLS_SURFACE) if path.exists() else []

    def reset_rows(self) -> None:
        self.tools.joinpath(*system_one.CALLS_RELPATH).unlink(missing_ok=True)

    def ask(self, question_id: str, refs: Any, transport: _Transport, point: str = "pre_pr_open",
            subject: str | None = "ARIA-HIGH-123") -> Answer | Unavailable:
        return ask(question_id, refs, decision_point=point, base_dir=self.tools, subject=subject, transport=transport)


class Availability(_Store):
    def test_unavailable_transport_is_pipeline_safe_and_recorded_once(self) -> None:
        result = self.ask("J0", self.refs(), _Transport(JevUnavailable("vendor_error_http_503")))
        self.assertEqual(result, Unavailable("J0", "unavailable", "vendor_error_http_503"))
        (row,) = self.rows()
        self.assertEqual((row["outcome"], row["reason"], row["answer"], row["model"]),
                         ("unavailable", "vendor_error_http_503", None, None))

    def test_a_raising_transport_never_reaches_the_caller(self) -> None:
        result = self.ask("J0", self.refs(), _Transport(OSError("boom")))
        self.assertEqual(result, Unavailable("J0", "unavailable", "transport_raised:OSError"))
        self.assertEqual([row["outcome"] for row in self.rows()], ["unavailable"])

    def test_disabled_registry_calls_nothing_and_writes_nothing(self) -> None:
        self.write_registry([_J0], enabled=False)
        transport = _Transport()
        result = self.ask("J0", self.refs(), transport)
        self.assertEqual(result, Unavailable("J0", "unavailable", "system_one_disabled"))
        self.assertEqual((transport.payloads, self.rows()), ([], []))

    def test_absent_registry_is_disabled(self) -> None:
        (self.root / "aria-config" / "system-one-questions.json").unlink()
        result = self.ask("J0", self.refs(), _Transport())
        self.assertEqual(result, Unavailable("J0", "unavailable", "registry_absent"))
        self.assertEqual(self.rows(), [])


class Refusals(_Store):
    def assert_refused(self, result: Answer | Unavailable, transport: _Transport, reason: str) -> None:
        self.assertIsInstance(result, Unavailable)
        assert isinstance(result, Unavailable)
        self.assertEqual((result.outcome, result.reason.split(":")[0]), ("refused", reason))
        self.assertEqual(transport.payloads, [])
        self.assertEqual([(row["outcome"], row["reason"]) for row in self.rows()], [("refused", result.reason)])

    def test_non_english_question_is_refused(self) -> None:
        for question_id in ("TR", "TRA"):
            with self.subTest(question_id=question_id):
                transport = _Transport()
                self.assert_refused(self.ask(question_id, self.refs(), transport), transport, "question_not_english")
                self.reset_rows()

    def test_a_state_key_with_no_builder_is_refused(self) -> None:
        transport = _Transport()
        self.assert_refused(self.ask("ENV", {"finding": StateRef(finding_id="ARIA-HIGH-123"),
                                             "env": StateRef(path="x")}, transport), transport, "state_key_unbuildable")

    def test_question_not_in_registry_is_refused(self) -> None:
        transport = _Transport()
        self.assert_refused(self.ask("J9", self.refs(), transport), transport, "question_not_registered")

    def test_decision_point_the_question_is_not_registered_for_is_refused(self) -> None:
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(), transport, point="judge_fanout"), transport,
                            "decision_point_not_registered")

    def test_text_is_never_accepted_in_place_of_a_reference(self) -> None:
        for refs, reason in (
            ({"finding": {"finding": "f", "rule": "r"}, "diff": "a diff"}, "state_shape"),
            ("free text", "state_shape"),
            ({"diff": StateRef(commit=self.fix, path="src/x.ts")}, "state_shape"),
            ({**self.refs(), "env": StateRef(path="x")}, "state_shape"),
        ):
            with self.subTest(refs=str(refs)[:30]):
                transport = _Transport()
                self.assert_refused(self.ask("J0", refs, transport), transport, reason)
                self.reset_rows()

    def test_bad_references_are_refused_before_egress(self) -> None:
        for refs, reason in (
            (self.refs(path="../../etc/passwd"), "path_refused"),
            (self.refs(path="/etc/passwd"), "path_refused"),
            (self.refs(path="src/*.ts"), "path_refused"),
            (self.refs(path="aria-tools/runs.jsonl"), "path_refused"),
            (self.refs(path="config/.env.production"), "path_credential_shaped"),
            (self.refs(path="deploy/id_rsa"), "path_credential_shaped"),
            (self.refs(path="gcp/credentials.json"), "path_credential_shaped"),
            (self.refs(path="infra/prod.tfvars"), "path_credential_shaped"),
            (self.refs(path="ops/kubeconfig"), "path_credential_shaped"),
            (self.refs(path="home/.netrc"), "path_credential_shaped"),
            (self.refs(path="keys/AuthKey_ABC.p8"), "path_credential_shaped"),
            (self.refs(path="gcp/service-account-prod.json"), "path_credential_shaped"),
            (self.refs(commit="HEAD"), "commit_not_a_sha"),
            (self.refs(commit="0" * 40), "reference_not_in_repository"),
            ({"finding": StateRef(finding_id="ARIA-HIGH-999"), "diff": StateRef(commit=self.fix, path="src/x.ts")},
             "finding_not_registered"),
            ({"finding": StateRef(finding_id="not an id"), "diff": StateRef(commit=self.fix, path="src/x.ts")},
             "finding_id_malformed"),
        ):
            with self.subTest(reason=reason, refs=str(refs)[:60]):
                transport = _Transport()
                self.assert_refused(self.ask("J0", refs, transport), transport, reason)
                self.reset_rows()

    def test_only_commits_a_public_remote_holds_are_admissible(self) -> None:
        # Review (a): cat-file -e admitted unpushed work and stash commits,
        # whose third parent carries ignored files.
        unpushed = self.commit_file("src/local.ts", "const customer = 'Jane Roe, +47 99 99 99 99';\n",
                                    "local only", push=False)
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(commit=unpushed, path="src/local.ts"), transport), transport,
                            "commit_not_on_public_remote")
        self.reset_rows()
        (self.root / "notes.local").write_text("tenant debt 120000 NOK\n", encoding="utf-8")
        (self.root / ".gitignore").write_text("aria-tools/\nnotes.local\n", encoding="utf-8")
        self.git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "stash", "push", "-q", "--all")
        stash_untracked = self.git("rev-parse", "stash@{0}^3")
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(commit=stash_untracked, path="notes.local"), transport),
                            transport, "commit_not_on_public_remote")
        self.reset_rows()
        self.git("push", "-q", "origin", f"{unpushed}:refs/heads/aria-impl-1")
        self.assertIsInstance(self.ask("J0", self.refs(commit=unpushed, path="src/local.ts"), _Transport(_noul(0.4))),
                              Answer)

    def test_the_checkouts_own_remote_configuration_cannot_make_a_commit_public(self) -> None:
        # Re-review bypasses: a narrowed refspec with a planted origin/x, the
        # origin URL pointed at the checkout itself, and that URL plus a
        # +refs/stash refspec. None of them is consulted.
        unpushed = self.commit_file("src/local2.ts", "const tenant = 'local';\n", "local only", push=False)
        self.git("config", "remote.origin.fetch", "+refs/heads/none:refs/remotes/origin/none")
        self.git("update-ref", "refs/remotes/origin/x", unpushed)
        self.git("update-ref", "refs/aria-public/heads/planted", unpushed)
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(commit=unpushed, path="src/local2.ts"), transport), transport,
                            "commit_not_on_public_remote")
        self.reset_rows()
        self.assertEqual(self.git("for-each-ref", "refs/aria-public/heads/planted"), "")  # pruned
        self.git("config", "remote.origin.url", str(self.root))
        self.git("config", "remote.origin.fetch", "+refs/stash:refs/remotes/origin/stash")
        (self.root / "ignored.local").write_text("tenant debt\n", encoding="utf-8")
        (self.root / ".gitignore").write_text("aria-tools/\nignored.local\n", encoding="utf-8")
        self.git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "stash", "push", "-q", "--all")
        stash_untracked = self.git("rev-parse", "stash@{0}^3")
        self.git("fetch", "-q", "origin")  # url -> self, refspec -> the stash: origin/stash now "holds" it
        self.assertNotEqual(self.git("for-each-ref", "--contains", stash_untracked, "refs/remotes/origin/"), "")
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(commit=stash_untracked, path="ignored.local"), transport),
                            transport, "commit_not_on_public_remote")

    def test_only_the_pruned_heads_namespace_counts_as_public(self) -> None:
        # Re-review: --prune cleans only refs/aria-public/heads/*, so a ref
        # planted beside it must not count.
        unpushed = self.commit_file("src/local3.ts", "const tenant = 'local';\n", "local only", push=False)
        for planted in ("refs/aria-public/x", "refs/aria-public/tags/v1"):
            with self.subTest(planted=planted):
                self.git("update-ref", planted, unpushed)
                transport = _Transport()
                self.assert_refused(self.ask("J0", self.refs(commit=unpushed, path="src/local3.ts"), transport),
                                    transport, "commit_not_on_public_remote")
                self.reset_rows()

    def test_repository_transport_config_is_overridden_on_every_public_call(self) -> None:
        # A proxy, disabled verification, a custom CA or a credential helper in
        # the checkout's config must not shape what "public" means.
        for key, value in (("http.proxy", "http://127.0.0.1:9"), ("http.sslVerify", "false"),
                           ("http.sslCAInfo", "/tmp/evil-ca.pem"), ("credential.helper", "store")):
            self.git("config", key, value)
        real_run = subprocess.run
        calls: list[list[str]] = []

        def recording_run(argv, *args, **kwargs):  # type: ignore[no-untyped-def]
            calls.append(list(argv))
            return real_run(argv, *args, **kwargs)

        with mock.patch.object(system_one.subprocess, "run", side_effect=recording_run):
            self.assertIsInstance(self.ask("J0", self.refs(), _Transport(_noul(0.6))), Answer)
        public = [argv for argv in calls if "ls-remote" in argv or "fetch" in argv]
        self.assertEqual(len(public), 2)
        for argv in public:
            settings = {argv[i + 1] for i, item in enumerate(argv) if item == "-c"}
            self.assertIn("http.proxy=", settings)
            self.assertIn("http.sslVerify=true", settings)
            self.assertIn("credential.helper=", settings)
            self.assertTrue(any(s.startswith("http.sslCAInfo=") and s != "http.sslCAInfo=/tmp/evil-ca.pem"
                                for s in settings))

    def test_a_url_rewrite_of_the_pinned_repository_is_refused(self) -> None:
        self.git("config", f"url.{self.root}.insteadOf", str(self.origin))
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(), transport), transport, "public_remote_url_rewritten")

    def test_the_finding_registry_is_read_as_origin_main_holds_it(self) -> None:
        registry = self.root / "docs" / "reviews" / "_registry" / "findings.jsonl"
        registry.write_text(registry.read_text(encoding="utf-8") + json.dumps(
            {"id": "ARIA-HIGH-777", "title": "Local only", "rule_violated": "r"}) + "\n", encoding="utf-8")
        transport = _Transport()
        refs = {"finding": StateRef(finding_id="ARIA-HIGH-777"), "diff": StateRef(commit=self.fix, path="src/x.ts")}
        self.assert_refused(self.ask("J0", refs, transport), transport, "finding_not_registered")

    def test_repository_content_with_a_credential_shape_is_refused(self) -> None:
        leaks = (
            "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIE",
            "DB_" + "PASSWORD=" + "hunter2hunter2",
            "token apikey_" + "0123456789abcdef" * 2,
            "gh" + "p_" + "A" * 36,
            "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + ".abcdefghijkl",
            "s" + "k_live_" + "a1B2c3D4e5F6g7H8i9",
            "wh" + "sec_" + "a1B2c3D4e5F6g7H8i9",
            "postgres://user:" + "s3cret" + "@db:5432/x",
            "password: " + "'" + "hunter2" + "'",
            "do" + "p_v1_" + "a" * 64,
            "S" + "G." + "a" * 22 + "." + "b" * 43,
            "np" + "m_" + "a" * 36,
        )
        for index, leak in enumerate(leaks):
            with self.subTest(leak=leak[:14]):
                commit = self.commit_file(f"src/leak{index}.ts", f"const x = 1;\n{leak}\n", f"leak {index}")
                transport = _Transport()
                self.assert_refused(self.ask("J0", self.refs(commit=commit, path=f"src/leak{index}.ts"), transport),
                                    transport, "state_secret_shaped")
                self.assertNotIn(leak, (self.tools / "system-one" / "calls.jsonl").read_text(encoding="utf-8"))
                self.reset_rows()

    def test_personal_data_in_repository_content_is_refused(self) -> None:
        for index, (text, reason) in enumerate((
            ("contact: jane.doe@customer.no", "state_personal_data"),
            ("upstream 10.20.30.40:5432", "state_personal_data"),
        )):
            with self.subTest(text=text):
                commit = self.commit_file(f"src/pd{index}.ts", text + "\n", f"pd {index}")
                transport = _Transport()
                self.assert_refused(self.ask("J0", self.refs(commit=commit, path=f"src/pd{index}.ts"), transport),
                                    transport, reason)
                self.reset_rows()
        # Documentation addresses and loopback are public by definition.
        commit = self.commit_file("src/ok.ts", "a@example.com 127.0.0.1 192.0.2.10\n", "public")
        self.assertIsInstance(self.ask("J0", self.refs(commit=commit, path="src/ok.ts"), _Transport(_noul(0.5))), Answer)

    def test_non_english_repository_content_is_refused(self) -> None:
        commit = self.commit_file("src/tr.ts", "// Kiracı sınırı aşılıyor\n", "tr")
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(commit=commit, path="src/tr.ts"), transport), transport,
                            "state_not_english")

    def test_a_payload_over_the_wire_cap_is_refused(self) -> None:
        transport = _Transport()
        with mock.patch.object(system_one, "PAYLOAD_MAX_BYTES", 200):
            self.assert_refused(self.ask("J0", self.refs(), transport), transport, "payload_too_large")

    def test_the_backstop_reads_mapping_keys_too(self) -> None:
        # Review H1: keys skipped every check. A built state never has
        # caller keys, and the backstop reads them anyway.
        key = "-----BEGIN RSA " + "PRIVATE KEY-----"
        refusal = system_one._egress_refusal({"model": "m", "state": "{}", "questions": {}}, {key: "x"})
        self.assertEqual(refusal, "state_secret_shaped:credential_shape")

    def test_a_free_text_subject_is_refused(self) -> None:
        transport = _Transport()
        self.assert_refused(self.ask("J0", self.refs(), transport, subject="customer jane.doe asked"), transport,
                            "subject_not_an_id")


class Ledger(_Store):
    def test_answered_row_carries_hash_model_validated_answer_never_the_state(self) -> None:
        transport = _Transport(JevReply("jev-1.13.0", {"J0": {"type": "noul", "noul": 0.93, "explain": "x" * 500}}, 120))
        result = self.ask("J0", self.refs(), transport, subject="PR#1756")
        self.assertEqual(result, Answer(
            question_id="J0", version=1, type="noul", value=0.93, confidence=None, probabilities=None,
            model="jev-1.13.0", mode="shadow", decision_point="pre_pr_open",
        ))
        sent = transport.payloads[0]
        self.assertEqual((sent["model"], list(sent["questions"])), ("jev-1.13.0", ["J0"]))
        self.assertEqual(sent["questions"]["J0"], {"type": "noul", "instructions": _J0["instructions"]})
        state = json.loads(sent["state"])
        self.assertEqual(state["finding"], {"finding": _FINDING["title"], "rule": _FINDING["rule_violated"]})
        self.assertIn("+repo.getScopedRepository(X)", state["diff"])
        (row,) = self.rows()
        self.assertEqual(row["state_sha256"], "sha256:" + hashlib.sha256(sent["state"].encode("utf-8")).hexdigest())
        self.assertEqual(
            {k: row[k] for k in ("question_id", "question_version", "model", "decision_point", "mode",
                                 "outcome", "input_tokens", "subject")},
            {"question_id": "J0", "question_version": 1, "model": "jev-1.13.0", "decision_point": "pre_pr_open",
             "mode": "shadow", "outcome": "answered", "input_tokens": 120, "subject": "PR#1756"},
        )
        self.assertEqual(row["answer"], {"value": 0.93, "confidence": None, "probabilities": None})
        self.assertIsInstance(row["latency_ms"], int)
        raw = (self.tools / "system-one" / "calls.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("getScopedRepository", raw)
        self.assertNotIn("tenant scoping", raw)
        self.assertNotIn("explain", raw)

    def test_malformed_answer_is_unavailable(self) -> None:
        for model, answers in (("jev-1.13.0", {}), ("jev-1.13.0", {"J0": {"type": "noul", "noul": 1.7}}),
                               ("jev-1.13.0", {"J0": {"type": "score", "score": 1}}),
                               ("jev 1.13\nX", {"J0": {"type": "noul", "noul": 0.5}})):
            with self.subTest(answers=answers, model=model):
                result = self.ask("J0", self.refs(), _Transport(JevReply(model, answers, 5)))
                self.assertEqual(result, Unavailable("J0", "unavailable", "answer_malformed"))

    def test_other_model_answers_in_shadow_and_only_known_options_are_kept(self) -> None:
        reply = JevReply("jev-1.14.0", {"KIND": {"type": "choice", "choice": "fix", "confidence": 0.8,
                                                 "probabilities": {"fix": 0.8, "test": 0.2, "injected": 0.9}}}, 9)
        result = self.ask("KIND", {"diff": StateRef(commit=self.fix, path="src/x.ts")}, _Transport(reply))
        assert isinstance(result, Answer)
        self.assertEqual((result.value, result.mode, result.model), ("fix", "shadow", "jev-1.14.0"))
        (row,) = self.rows()
        self.assertEqual(row["declared_mode"], "order")
        self.assertEqual(row["answer"]["probabilities"], {"fix": 0.8, "test": 0.2})


class Shuffle(_Store):
    def order_for(self, commit: str) -> list[str]:
        transport = _Transport(JevReply("jev-1.13.0", {"KIND": {
            "type": "choice", "choice": "fix", "confidence": 0.9, "probabilities": {"fix": 0.9}}}, 1))
        self.ask("KIND", {"diff": StateRef(commit=commit, path="src/x.ts")}, transport)
        return list(transport.payloads[0]["questions"]["KIND"]["criteria"])

    def test_options_are_a_deterministic_per_state_permutation(self) -> None:
        commits = [self.commit_file("src/x.ts", f"change {index}\n", f"change {index}") for index in range(12)]
        orders = [self.order_for(commit) for commit in commits]
        for order in orders:
            self.assertEqual(sorted(order), sorted(_KIND["criteria"]))
        self.assertEqual(self.order_for(commits[3]), orders[3])
        self.assertGreater(len({tuple(order) for order in orders}), 1)
        self.assertGreater(len({order[0] for order in orders}), 1)


class SeededRegistry(unittest.TestCase):
    def test_registry_is_valid_and_every_question_is_shadow_with_the_validated_wording(self) -> None:
        # Whether System One is on is the operator's call (ADR-0027) and is not pinned here; what is
        # pinned is that every question is still SHADOW and still says what was measured.
        registry = load_registry(_REPO_ROOT)
        self.assertEqual(registry.model, "jev-1.13.0")
        self.assertEqual(registry.invalid, {})
        self.assertEqual({q.mode for q in registry.questions.values()}, {"shadow"})
        self.assertEqual({qid: q.instructions for qid, q in registry.questions.items()}, {
            "J0": "The diff fixes the problem described in the finding",
            "R5": "The diff does what the message says",
            "J2": "The code excerpt is evidence for the problem the finding describes",
            "R4": "How relevant this file is to the problem described",
            "J1-tenant-scoping": "The query in this excerpt is scoped to the current tenant",
        })

    def test_registry_is_operator_policy_aria_cannot_write(self) -> None:
        from aria_kernel.implementation_safety import READONLY_PATHS
        from aria_kernel.self_improvement import AUTHORITY_SURFACES

        registry = "/".join(system_one.REGISTRY_RELPATH)
        self.assertTrue(any(registry.startswith(prefix) for prefix in READONLY_PATHS))
        self.assertIn(registry, AUTHORITY_SURFACES)

    def test_ledger_is_an_unread_observation_surface(self) -> None:
        (surface,) = [s for s in STATE_SURFACES if s.name == system_one.CALLS_SURFACE]
        self.assertEqual((surface.path_pattern, surface.observe_class, surface.memory, surface.write_driving),
                         ("system-one/calls.jsonl", "observation", False, False))
        readers = [
            path.name for path in _KERNEL.glob("*.py")
            if path.name not in ("system_one.py", "state_manifest.py")
            and ("system_one_calls" in (text := path.read_text(encoding="utf-8")) or "system-one/calls" in text)
        ]
        self.assertEqual(readers, [])


if __name__ == "__main__":
    unittest.main()
