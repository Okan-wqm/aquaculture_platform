"""Plan 024 v3 followup §E — read-time upcasters for legacy ledger
schemas. New schemas SHOULD bump schema_version + ship a sibling
upcaster module."""
from aria_kernel.upcasters.cycles import upcast_cycle_row, upcast_cycle_rows

__all__ = ["upcast_cycle_row", "upcast_cycle_rows"]
