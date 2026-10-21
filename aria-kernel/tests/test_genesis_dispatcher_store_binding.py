"""ARIA-MEDIUM-507 — the convergent drafters and judges read back the result
an agent delivered for the request they minted, from the store they are
bound to.

``select_drafter`` and ``select_judge`` took the store from
``evidence_pack["_base_dir"]``, a key no producer writes
(``evidence_collector.EvidencePack`` has none). ``accepted_response`` returns
None for a None store, so every call minted its envelope wherever
``tools_dir(None)`` resolved, polled its full timeout (600 s by default,
inside the cycle) without reading the store once, and returned the
``dispatchers_unavailable`` fallback: a delivered draft was never read.

The store is now bound where the dispatcher is built (the drainer's root,
``autonomy_orchestrator``), so the evidence pack carries evidence only.
"""
from __future__ import annotations

import ast
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import dispatcher_factory
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.dispatcher_factory import DispatcherConfig, select_drafter, select_judge
from aria_kernel.tool_registry import ensure_tools_dir
from tests.test_genesis_adapter_custody import GOOD_SOURCE, _manifest, accept_drafter_result

# A poll long enough to read the store a few times, short enough for a test.
FAST = DispatcherConfig({"poll_timeout_seconds": 5.0, "poll_interval_seconds": 0.01})
# What the drainer hands every drafter and judge: the pack Phase 0 collected
# (ARIA-HIGH-614 — the envelope's citation box derives from it), and no store.
EVIDENCE_PACK = {
    "seed_id": "seed-507",
    "base_commit_sha": "a" * 40,
    "declared_scope": ["docs/"],
    "claim_types": ["api_contract"],
    "observations": [
        {"file_path": "docs/aria/SPEC.md", "line": 1 + index,
         "snippet": "spec line", "claim_class": "api_contract"}
        for index in range(3)
    ],
}
SEED_RULE = {"id": "seed-rule", "description": "cite three evidence refs per rule"}


class _StoreCase(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="aria-507-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.tools = ensure_tools_dir(base / "aria-tools")
        # A second store the process could resolve on its own: nothing may land there.
        self.elsewhere = ensure_tools_dir(base / "elsewhere")

    def deliver_on_first_poll(self, details: dict, *, role: str):
        """The consumer: on the dispatcher's first wait, accept a result for
        the request it just minted, as the executor's submit path would."""
        real_sleep = dispatcher_factory.time.sleep
        delivered: list[str] = []

        def sleep(seconds: float) -> None:
            if not delivered:
                [request] = list_agent_invocation_requests(base_dir=self.tools)
                accept_drafter_result(self.tools, request["request_id"], details, role=role)
                delivered.append(request["request_id"])
            real_sleep(seconds)

        return mock.patch.object(dispatcher_factory.time, "sleep", side_effect=sleep), delivered


class DrafterReadsTheDeliveredDraft(_StoreCase):
    def test_the_accepted_result_for_the_minted_request_is_the_draft(self) -> None:
        drafter = select_drafter(role="primary_authoring", base_dir=self.tools, config=FAST, cycle_id="cyc-507")
        details = {"draft_id": "draft-507", "rules": [{"id": "r1"}], "adapter_source": GOOD_SOURCE,
                   "adapter_manifest": _manifest()}
        patch, delivered = self.deliver_on_first_poll(details, role="primary_authoring")
        with mock.patch.dict("os.environ", {"ARIA_TOOLS_DIR": str(self.elsewhere)}), patch:
            draft = drafter(seed_id="seed-507", must_satisfy=[SEED_RULE], evidence_pack=dict(EVIDENCE_PACK),
                            round_number=1)

        self.assertNotIn("dispatchers_unavailable", draft)
        self.assertEqual(draft["invocation_request_id"], delivered[0])
        self.assertEqual((draft["draft_id"], draft["rules"], draft["adapter_source"]),
                         ("draft-507", [{"id": "r1"}], GOOD_SOURCE))
        self.assertEqual(list_agent_invocation_requests(base_dir=self.elsewhere), [])


class JudgeReadsTheDeliveredVerdict(_StoreCase):
    def test_the_accepted_result_for_the_minted_request_is_the_verdict(self) -> None:
        judge = select_judge(role="evidence_judgment", base_dir=self.tools, config=FAST, cycle_id="cyc-507")
        patch, _delivered = self.deliver_on_first_poll(
            {"verdict": "no_gaps", "gaps": []}, role="evidence_judgment",
        )
        with mock.patch.dict("os.environ", {"ARIA_TOOLS_DIR": str(self.elsewhere)}), patch:
            verdict = judge(primary_draft={}, sandbox_result={"precision": 1.0},
                            evidence_pack=dict(EVIDENCE_PACK))

        self.assertEqual(verdict, {"verdict": "no_gaps", "gaps": [], "evidence_refs": []})
        self.assertEqual(list_agent_invocation_requests(base_dir=self.elsewhere), [])


class TheStoreIsBoundAtTheProducer(unittest.TestCase):
    def test_a_dispatcher_cannot_be_built_without_its_store(self) -> None:
        for factory, role in ((select_drafter, "primary_authoring"), (select_judge, "adversarial_judgment")):
            with self.subTest(factory=factory.__name__), self.assertRaises(TypeError):
                factory(role=role, cycle_id="cyc-507")

    def test_no_kernel_module_names_the_evidence_pack_store_key(self) -> None:
        # The key had six readers and no writer; a reader that comes back
        # would read None again.
        kernel = Path(dispatcher_factory.__file__).resolve().parent
        readers = sorted(
            str(path.relative_to(kernel)) for path in kernel.rglob("*.py")
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
            if isinstance(node, ast.Constant) and node.value == "_base_dir"
        )
        self.assertEqual(readers, [])


if __name__ == "__main__":
    unittest.main()
