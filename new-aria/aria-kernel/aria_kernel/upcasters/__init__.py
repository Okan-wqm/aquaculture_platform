"""Plan 024 v3 followup §E — read-time upcasters for legacy ledger
schemas. New schemas SHOULD bump schema_version + ship a sibling
upcaster module.

Plan ARIA-V2 §3.5 added ``service_map_v1_to_v2`` for the SERVICE_MAP.json
schema bump (flat ``web`` list → typed ``web`` buckets with modules /
apps / shared_ui / shell). The module exposes ``upcast(v1) -> v2`` and
``downcast(v2) -> v1`` so consumers on either schema version can read
producers on the other.
"""
from aria_kernel.upcasters.cycles import upcast_cycle_row, upcast_cycle_rows
from aria_kernel.upcasters import service_map_v1_to_v2

__all__ = ["upcast_cycle_row", "upcast_cycle_rows", "service_map_v1_to_v2"]
