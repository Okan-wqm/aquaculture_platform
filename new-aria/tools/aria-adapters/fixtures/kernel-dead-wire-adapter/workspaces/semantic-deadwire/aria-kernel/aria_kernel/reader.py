"""Fixture module: the production reader half of the semantic-regression case.

It names two of the policy's keys and ignores the rest. Everything this file
reads is a FALSE-POSITIVE TRAP for the `policy_key_never_read` rule; everything
it omits is a true positive.
"""


def resolve(policy: dict) -> tuple[int, bool]:
    # TRAP: read through .get() — the rule must see this as a read.
    cycles = int(policy.get("shadow_min_clean_cycles") or 5)
    # TRAP: read through subscript on a nested block, one level down.
    block = policy["nested_block"]
    return cycles, bool(block["read_by_the_module"])
