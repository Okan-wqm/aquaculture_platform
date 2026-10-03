# GraphQL call-site variables are unchecked, and interpolated documents are skipped (G5)

- Date: 2026-10-03
- Cycle: 2026-10-03-aria-find-gaps
- Author: claude (owner_user: okan)
- Measured on: main 405f2ecac

## FE-MEDIUM-315

`scripts/ci/validate-graphql-operations.mjs` validates frontend operation documents against the
composed supergraph. It never looks at the call that sends a document, and it does not validate
every document either.

### What the gate did

- `:118` deletes every `${...}` interpolation, so `items { ${FIELDS} }` becomes `items { }`.
- `:121-123` a document that then fails to parse is skipped with `continue`. On 405f2ecac that
  is 223 of 1039 operation documents: a vacuous pass the gate's own header forbids.
- Nothing reads a call site. The variables passed by `graphqlRequest(client, DOC, vars)`,
  `graphqlClient.request(DOC, vars)`, `graphqlFetch`, `useGraphQLQuery(key, DOC, opts)` and
  `{ query, variables }` bodies are never compared with what the operation declares.

### Consequences, measured

GraphQL ignores a variable the operation does not declare, so a key the operation lacks is a
filter the server never applies. A probe over 684 call sites (639 resolved, 45 unresolved)
found 14 such call sites, all undeclared keys:

- `web/modules/hr-module/src/hooks/useLeaves.ts:145` sends `{ filter, pagination }` to
  `GetLeaveRequests`, which declares `employeeId`, `status`, `leaveTypeId`, `startDate`,
  `endDate`, `page` and `limit` (`web/modules/hr-module/src/graphql/leave.operations.ts:56`).
- `useLeaves.ts:194` sends `{ approverId }` to `GetPendingLeaveApprovals`
  (`$departmentId $page $limit`).
- `web/modules/hr-module/src/hooks/useCertifications.ts:280` sends `{ filter, pagination }`.
- Eleven in hr-module in all; three in farm-module, where a react-query `enabled` flag sits
  inside the variables object.
