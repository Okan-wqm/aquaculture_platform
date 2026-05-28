# Farm Data Classification

## Classes

| Class                       | Data                                                                       | Controls                                                      |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Public operational metadata | non-sensitive species names, public status labels                          | normal access control                                         |
| Tenant confidential         | farms, tanks, batches, feeding, health, harvest, stock                     | tenant isolation, RBAC, audit on writes                       |
| Personal data               | worker identity, contact fields, createdBy and updatedBy links             | minimised logs, retention policy, export and erasure controls |
| Secret                      | Sentinel Hub credentials, regulatory credentials, service identity secrets | envelope encryption, key rotation, no client exposure         |
| Compliance record           | audit logs, regulatory submissions, erasure evidence                       | immutable audit, retention schedule, restricted access        |

## Logging Rules

Logs must not contain raw credentials, tokens, passwords, private keys, SQL connection strings, or raw tenant UUID labels in high-cardinality metrics.

## Encryption Rules

New secret storage must use versioned AES-256-GCM or platform envelope encryption. AES-CBC records remain readable only for migration and backfill flows.
