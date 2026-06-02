# Messaging Partitions Runbook

Messaging `messages` and `message_receipts` are partitioned parents. Startup must fail closed if the parent tables are missing or not partitioned with the expected range key.

## Tenant Bootstrap

Tenant schema provisioning must create `messages` and `message_receipts` as partitioned parents, clone existing source partition bounds, seed the tenant migration ledger, then call the partition manager schema ensure API for current and future partition windows. Do not clone source-only infrastructure tables into tenant schemas; `MODULE_SCHEMAS.infrastructureTables` is authoritative.

Validation SQL:

```sql
SELECT n.nspname, c.relname, c.relkind, pg_get_partkeydef(c.oid) AS partition_key
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('messaging', '<tenant_schema>')
  AND c.relname IN ('messages', 'message_receipts');
```

Expected:

- `relkind = 'p'` for both parent tables.
- `messages` partition key is `RANGE ("createdAt")`.
- `message_receipts` partition key is `RANGE ("receiptCreatedAt")`.

## Failure Handling

If startup reports a non-partitioned parent:

1. Stop writers.
2. Take a database backup or snapshot.
3. Run the messaging migration runner for `1800600000000-PartitionMessagingParents`.
4. Verify row counts:

```sql
SELECT COUNT(*) FROM messaging.messages;
SELECT COUNT(*) FROM messaging.message_receipts;
SELECT COUNT(*) FROM messaging.message_idempotency_keys;
```

5. Verify parent metadata with the validation SQL above.
6. Verify FK/index recreation:

```sql
SELECT conname
FROM pg_constraint
WHERE connamespace = 'messaging'::regnamespace
  AND conname IN (
    'FK_message_idempotency_keys_message',
    'FK_feba9c7cced72676c716bc3e7bd',
    'FK_113e9f1bde01433819f03b64dec'
  );
```

7. Restart the service only after validation passes. If any copy/count/metadata check fails, keep writers stopped and restore from the preflight backup; do not manually drop backup tables created by the repair migration.
