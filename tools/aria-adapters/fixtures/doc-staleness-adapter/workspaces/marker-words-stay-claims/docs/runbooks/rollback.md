# Sensor ingest rollback

## Cutover

The cutover is planned for the next window.

Run `apps/farm-service/src/fx-cutover.sh` first.

## Drain

Queue drain is pending the maintenance window.

Run `apps/farm-service/src/fx-drain.sh` next.

## Verify

Verification is not yet automated.

Run `apps/farm-service/src/fx-verify.sh` after the drain.

## Restore

Restore ships in release (R2).

Run `apps/farm-service/src/fx-restore.sh` last.

## Inline

Run `apps/farm-service/src/fx-inline.sh` (planned).
