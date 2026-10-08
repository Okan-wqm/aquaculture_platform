"""ARIA-HIGH-388 — the delivery's authority is admitted before the spawn.

Measured 2026-10-08: the store's profile fell from ``strict`` to ``standard``
at 04:38Z (the unlock ladder's 72 h evidence window). An implementation
request minted under strict and claimed after the drop would spend a whole
spawn and then be refused at ``apply_gate`` as the REQUEST's fault. The
admission now refuses it first, as the host's: released harness-class and
retried once the authority is back.
"""
from __future__ import annotations

from datetime import datetime, timezone

from aria_kernel.implementation_delivery import DELIVERY_ACTIONS
from tests.test_executor_event_driven_planning import _PlanCase


class DeliveryAuthorityIsAdmittedBeforeTheSpawn(_PlanCase):
    def test_a_profile_without_the_delivery_actions_is_refused_at_admission(self) -> None:
        from aria_kernel.implementation_delivery import delivery_admission_refusal

        refused = delivery_admission_refusal(workspace_root=self.root, base_dir=self.tools, proposal_id="",
                                             job_deadline_epoch=None)
        self.assertEqual(refused, f"authority_absent:profile=standard:missing={','.join(sorted(DELIVERY_ACTIONS))}")

    def test_a_profile_holding_them_is_not_refused_for_authority(self) -> None:
        from aria_kernel.implementation_delivery import delivery_admission_refusal
        from tests._helpers.operator_acts import operator_set_profile

        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        refused = delivery_admission_refusal(workspace_root=self.root, base_dir=self.tools, proposal_id="",
                                             job_deadline_epoch=datetime.now(timezone.utc).timestamp() + 10**6)
        self.assertFalse(str(refused or "").startswith("authority_absent"), refused)
