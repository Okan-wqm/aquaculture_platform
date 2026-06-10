-- Aquaculture Platform database init handoff.
--
-- Runtime/deploy init scripts do not own database objects or privileges.
-- apps/db-migrate platform bootstrap is the single DDL authority.

\echo 'database init handoff: db-migrate platform bootstrap owns database objects and privileges'
