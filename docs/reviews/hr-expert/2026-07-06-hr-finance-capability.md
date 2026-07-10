# HR finance capability — product-gap finding (2026-07-06)

Companion to `docs/reviews/farm-expert/2026-07-06-finance-capability.md` for
the HR side of the finance-tabs product request.

---

## HR-HIGH-001 — No labour-cost read model; free-text `position` blocks personnel analytics; HR analytics renders placeholder bars

**Severity:** HIGH · **Owner:** hr-expert · **Deadline:** 2026-07-20

Payroll rows store per-employee earnings/deductions, but the platform computes
**no** organization-level labour cost: no salary totals per workforce
category, no pension / social-insurance / medical-fund projection, no Total
Payroll, no per-department cost view. `employees.position` is free text, so
"how many managers / technicians / unskilled workers?" is unanswerable
structurally. `HRAnalyticsPage.tsx` ships department bars hardcoded to
`width: '0%'` — a placeholder rendered as if it were data.

**Architectural resolution (tier 1/2/3):** a structured `laborCategory` enum
column on `employees` (auto-mapped from existing position/department text,
editable in the employee form, UNCLASSIFIED surfaced with a warning instead of
silently wrong); per-tenant `hr_payroll_cost_settings` (fund percentages —
default 0, tenant-configurable — plus the 5% other-cost rule and the
event-projected default currency); labour-cost/personnel/salary/total-payroll
read models computed from employees + payrolls + rates via the `Money` VO; a
manual HR expense ledger (`hr_finance_categories` / `hr_finance_entries`,
dynamic categories as rows); and the HR analytics placeholders wired to the
real read model.
