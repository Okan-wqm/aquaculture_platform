# Farm Secret Key Rotation

## Scope

This covers Sentinel Hub credentials, regulatory credentials, service identity secrets, and farm encryption keys.

## Rotation Steps

1. Create a new key version in the secret manager.
2. Deploy readers with dual-read support for current and previous key versions.
3. Backfill encrypted records to the new version.
4. Verify no records remain on the retired version.
5. Remove the retired key from active decrypt paths after backup retention requirements are met.

## Validation

- Credential read succeeds for rotated tenants.
- Credential write stores the new key version.
- Audit rows record actor, key purpose, tenant, and correlation ID.
- Client errors never include provider credential material.
