"""Plan ARIA-V6 invariant package marker.

Predecessor: ARIA-V5 CONVERGED (5 commits; F-011 RESOLVED; 16
V5 invariants; convergence + review gates wired).

V6 closes the ~70% G1-G10 coverage gap via three architectural
mechanisms:

  * V6.1 Gate C — Lane-A specialist dispatch (specialist_review_runner)
  * V6.2 Convergent skill_authoring — LLM-debate adapter authoring
    with 3-CROSS-VERIFY evidence-grounding (Plan §2a operator vision)
  * V6.3 Adapter request seeds — 9 priority adapter requests
  * V6.4 Auto-promotion under safe conditions
  * V6.5 F-012 RESOLVED transition

Target total: 19 V6 invariants under tests/invariants/v6/.
"""
