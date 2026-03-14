# ADR-010: Frontend Styling Strategy

**Date:** 2026-03-14
**Status:** Accepted
**Deciders:** Platform Team

---

## Context

The admin-panel uses two styling approaches:

1. **Tailwind CSS** (majority): Used across all pages and components via utility classes. Configured with `tailwind.config.js` and `postcss.config.js`.
2. **Inline CSS-in-JS** (`style={{ }}` objects): Found in 13 files, primarily in pages that render dynamic layouts -- QueryEditor, FeatureTogglesPage, SecurityDashboardPage, AnalyticsDashboardPage, PerformanceDashboardPage, DatabaseManagementPage, and others.

The inline styles typically handle dynamic values (calculated widths, conditional colors, chart dimensions) that are harder to express as static Tailwind classes.

## Decision

**Tailwind CSS is the sole styling standard for new code.**

1. New components and pages must use Tailwind utility classes exclusively
2. Dynamic values use Tailwind's arbitrary value syntax: `w-[${width}px]`, `bg-[${color}]`
3. Existing inline CSS-in-JS in 13 files is accepted as technical debt
4. No CSS modules, styled-components, or other CSS-in-JS libraries

## Consequences

**Positive:**
- Single styling paradigm simplifies onboarding and code review
- Tailwind's purge ensures minimal CSS bundle size
- Consistent design tokens via tailwind.config.js

**Negative:**
- 13 existing files with inline styles remain as refactoring backlog
- Some truly dynamic styles (chart rendering, canvas positioning) may still need inline style objects
