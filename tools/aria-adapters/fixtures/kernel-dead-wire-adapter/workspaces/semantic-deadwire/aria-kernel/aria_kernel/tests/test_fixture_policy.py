"""Fixture test module: THE trap this rule exists to survive.

A test that names an unread tunable is exactly how the tunable stays green
while governing nothing. `orphan_promotion_ceiling` and `never_read_anywhere`
appear here and NOWHERE in production, so the adapter must still flag both —
if it counts this file as evidence of a read, the rule certifies dead
configuration.
"""


def test_policy_keys_exist(policy):
    assert policy["orphan_promotion_ceiling"] == 3
    assert policy["nested_block"]["never_read_anywhere"] == 0.9
