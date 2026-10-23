# Runbook: edge contract key compromise, rotation and revocation (skeleton)

**Owner:** @Okan-wqm (release owner)
**Related:** ADR-048 DEC-3, DEC-15; `docs/adr/021-platform-key-ceremony-lifecycle.md` §1a (slots 10–17);
Suderra-OS `docs/security/key-ceremony.md` §Edge contract keys and `docs/security/key-management.md` (the inventory);
`docs/runbooks/edge-release-offline-signing.md`; findings EDGE-HIGH-119, INFRA-MEDIUM-257

## Status of this file

A skeleton, written in ADR-048 P1 so that every key has a place to point to. DEC-15 itself is a P2 deliverable: the
fleet-root-signed `suderra.key-epoch-advance.v1` statement that revokes a key, the QEMU re-keying drill
(`tests/qemu/key-epoch-advance-drill.py` in Suderra-OS) and Suderra-OS `docs/operations/key-compromise-response.md`.
Steps marked **[P2]** cannot be executed before that. Nothing here has been exercised on a fleet, and the contact
fields read `bekliyor: operatör` until the operator fills them. Where a section says what a key can sign it states
the contract (ADR-048 DEC-3, `statements.json`); where it says what to do it states what exists in P1.

## The frame every section uses

1. **Declare.** Open an incident (the incident-response process of the organisation); name the key by purpose and
   epoch exactly as the inventory table does; freeze releases (the repository variable of
   `edge-release-offline-signing.md` stops being used: push no `agent-v*` or `agent-statements-v*` tag).
2. **Contain.** Stop the key's use: an offline key is not unlocked; an online key's secret is removed from the secret
   store and the service that holds it restarted, so the Suderra OS endpoints that need it refuse requests.
3. **Scope.** List what the key signed since the suspected exposure: for the cloud's signers the audit trail of the
   signing calls; for `edge-release` the statements published since the last verified release.
4. **Revoke.** **[P2]** the fleet-root key signs a `key-epoch-advance` statement (purpose, new minimum epoch, revoked
   keyids, scope, time); a device raises its ratchet and never lowers it. Before P2 a key is not revoked on devices:
   it is replaced (step 5) and the old key stays accepted until the device's image or bundle no longer carries it.
5. **Rotate.** A ceremony produces the next epoch of the key (key-ceremony.md §Edge contract keys), the inventory row
   and `PRODUCTION_KEYIDS` are updated in one commit, and the key goes to where devices anchor it (the column
   _Device anchor_ of key-ceremony.md): a new OS image that pins epochs N and N+1 together (DEC-3.4) for the keys pinned
   in the image, a new trust-anchors bundle (signed by fleet-root, delivered by the `trust-anchors` update request) for
   the bundle-anchored ones.
6. **Verify.** `edge_key_inventory.py check` and `edge-key-inventory-contract-test.sh` on the updated table; on a device
   `suderra-installer edge verify-current`; for a release, `edge_release.py verify` with the new keyid.
7. **Disclose.** Customer-facing note when a statement signed by the key reached devices; KVKK/regulatory duties as the
   incident-response process says.

Contact for the incident, the custodians and the security owner: `bekliyor: operatör`.

## edge-release

- **Custody.** Offline HSM, two custodians; signs only release statements, offline, one release at a time.
- **What a leak allows.** A valid release statement for any artifact bytes. A device installs an agent only through a
  provisioning manifest or an update statement (both signed by `edge-provisioning`) that names that statement's digest,
  so a leaked `edge-release` key alone installs nothing; with `edge-provisioning` as well it can.
- **Contain.** Do not unlock the HSM; refuse to admit any release signed after the suspected exposure (the cloud's
  release admission names only admitted releases).
- **Rotate.** Ceremony → `edge-release/2.pub` in the next OS image beside epoch 1 (an image carries N and N+1), then
  statements signed with epoch 2 by the offline flow. Devices on an image that pins only epoch 1 do not accept epoch 2:
  the image rolls first.
- **Revoke.** **[P2]** `key-epoch-advance` for `edge-release`.

## edge-provisioning

- **Custody.** Online: a sensor-service secret (`SUDERRA_EDGE_PROVISIONING_SIGNING_KEY`) until the P2 KMS.
- **What a leak allows.** Provisioning manifests, update statements, activation receipts and `os-update` statements for
  any device, naming any release the cloud admitted; it cannot forge a release statement.
- **Contain.** Remove the secret and restart sensor-service; issue nothing more and let the outstanding provisioning
  manifests and update statements lapse (each carries `not_before` and `expires_at`).
- **Rotate.** New epoch from a ceremony: OS image pin (N and N+1) and the bundle's copy; the cloud signs with the new
  key once devices pin it.
- **Revoke.** **[P2]** `key-epoch-advance` for `edge-provisioning`.

## config-integrity

- **Custody.** Online: `SUDERRA_EDGE_CONFIG_INTEGRITY_SIGNING_KEY`, anchored only in the trust-anchors bundle.
- **What a leak allows.** A `site-config` or `site-netpolicy` statement for any device in the bundle's tenant scope: the
  agent's point list, output allow-list and network policy.
- **Contain.** Remove the secret and restart; stop pushing site configs.
- **Rotate.** New key → new trust-anchors bundle signed by fleet-root → `trust-anchors` update request to the fleet.
- **Revoke.** **[P2]** `key-epoch-advance`.

## device-lifecycle

- **Custody.** Online: the signer's secret (`SUDERRA_EDGE_DEVICE_LIFECYCLE_SIGNING_KEY`), pinned in the OS image.
- **What a leak allows.** Device lifecycle statements (re-provisioning from maintenance; later break-glass, RMA,
  decommission): the ability to move devices between lifecycle states.
- **Contain.** Remove the secret and restart.
- **Rotate.** New epoch from a ceremony: pinned in the next OS image beside the old.
- **Revoke.** **[P2]** `key-epoch-advance`.

## command

- **Custody.** Online: `SUDERRA_EDGE_COMMAND_SIGNING_KEY`, the platform actor's key, anchored in the bundle and mapped to
  the actor by the RBAC manifest.
- **What a leak allows.** Command envelopes as the platform actor, within what the RBAC manifest permits that actor.
- **Contain.** Remove the secret and restart; the agent's own RBAC and command checks still apply.
- **Rotate.** New key → new RBAC manifest naming it → new bundle.
- **Revoke.** **[P2]** `key-epoch-advance`.

## rbac-manifest

- **Custody.** Online: `SUDERRA_EDGE_RBAC_MANIFEST_SIGNING_KEY`, anchored in the bundle.
- **What a leak allows.** An RBAC manifest that grants any actor any permission: it is the key that decides what
  `command` may do. Treat it as the most sensitive online key.
- **Contain.** Remove the secret and restart; re-sign and push the last known good manifest with a new key.
- **Rotate.** New key → new bundle → new manifest signed with it.
- **Revoke.** **[P2]** `key-epoch-advance`.

## fleet-root

- **Custody.** Offline HSM, two custodians; signs `trust-anchors` bundles and (P2) `key-epoch-advance` only.
- **What a leak allows.** A trust-anchors bundle that anchors any key: it replaces every bundle-anchored key and, with
  it, command and config authority. It is a fleet-wide incident.
- **Contain.** Do not unlock the HSM; stop pushing bundles; assume every bundle-anchored key is untrusted.
- **Rotate.** A new fleet-root pinned in a new OS image delivered over the separate RAUC chain (DEC-15), a new bundle
  signed by it, then every bundle-anchored key replaced.
- **Revoke.** Not by a statement: only the old fleet-root's own `key-epoch-advance` could, and it is the compromised key.
  The image is the recovery path. Production of the bundle: INFRA-MEDIUM-257.

## edge-image (P2)

KMS-held X.509 key whose certificate is embedded in the signed kernel's keyring (DEC-1.6). No key exists in P1. The
section is written with the key.

## RAUC bundle, FIT / UEFI db, verity and the device CA

These are Suderra-OS keys with their own ceremony and drill: Suderra-OS `docs/security/key-ceremony.md` §Rotation And
Revocation and §Compromise Drill (seven steps, replay-verified). The device CA (the private device PKI of P2/P3) is
written when it exists.

## Drill

DEC-15 requires a fleet-wide re-keying drill on the QEMU fleet at least once a year (**[P2]**:
`tests/qemu/key-epoch-advance-drill.py`). Until then the release flow's rehearsal with a throwaway key
(`edge-release-offline-signing.md` §Rehearsal) is the drill of the offline path.
