# ADR-0005 — config.runtime.* NATS Subject Namespace + Scoped Secret-Reply Inbox

**Status:** proposed
**Date:** 2026-07-13
**Branch:** feat/billing-stripe-runtime-config
**Resolves:** ARCH-HIGH-001, SEC-CRITICAL-001 (Faz C dual review — auth-security-expert + architectural-arbiter)
**Finding reference:** docs/reviews/orphan-findings.md#ORPHAN-HIGH-397

> Numbering note: `adr-0004` is already taken by `2026-07-11-adr-0004-money-wire-representation.md`; this ADR uses the next free number (0005). The review brief referenced "adr-0004" before that collision was known.

## Context

Billing Revival Faz C (D6) makes config-service a NATS request-reply responder so
billing-service can read the *effective* Stripe configuration — including the
decrypted secret key — at runtime without a redeploy. Two subject-space decisions
are load-bearing and must be ratified rather than left implicit:

1. **RPC namespace.** The platform RPC convention is `request.{service}.{...}`
   (`infrastructure/nats/services.yaml`, enforced by `services.schema.json` + the
   `nats-invariants` RPC-coverage scan). The Faz C reads use a NEW top-level
   namespace `config.runtime.get` / `config.runtime.get_secret` instead. This is
   deliberate: the secret read must be grantable to *exactly one* cert CN, and the
   broad `request.{service}.>` grants (which several services hold) must never be
   able to cover it. But `config.runtime.*` falls OUTSIDE the generic RPC-coverage
   scan's prefix set — so the grant that protects the plaintext secret is invisible
   to the drift detector unless explicitly pinned.

2. **Reply subject.** Core-NATS request-reply returns the reply on an inbox subject
   the client mints. The default inbox prefix is `_INBOX.`, and **every** service
   cert in `services.yaml` holds `subscribe: _INBOX.>`. A decrypted Stripe secret
   returning on `_INBOX.<nuid>` is therefore passively readable by any compromised
   non-billing service (`subscribe('_INBOX.>')`). This is SEC-CRITICAL-001.

## Decision

### 1. Keep the `config.runtime.*` namespace (do NOT fold into `request.*`)

`config.runtime.get` / `config.runtime.get_secret` remain a distinct namespace.
`services.schema.json` admits the `config.runtime.` prefix (same SSoT mechanism by
which `policy.` and `sensor.lookup` were previously added for new responders). The
`get_secret` subject is granted to the `billing_service` CN alone; no `>` grant
covers it.

Because the namespace escapes the generic RPC-coverage scan, an EXPLICIT PINNED
assertion block is added to `e2e/tests/integration/nats-invariants.spec.ts`
("config-runtime secret-read grants") that fails the build if:
- billing_service loses either `config.runtime.*` publish grant, or config_service
  loses either subscribe grant;
- any service outside `{billing,config}` gains a `config.runtime.*` grant;
- an allowlisted caller in the contract SSoT lacks its matching publish grant
  (`CONFIG_RUNTIME_{SECRET,NONSECRET}_ALLOWLIST` in `@platform/event-contracts`);
- the secret and non-secret caller allowlists overlap (ARCH-MEDIUM-004).

Tier-3 "make it detectable": the cert-CN grant, the handler per-caller allowlist,
and the contract keys are now bound by one invariant and cannot drift apart.

### 2. Scoped secret-reply inbox `_INBOXBILLINGCFG.` (SEC-CRITICAL-001)

The config-runtime client registers its NatsV3Client with
`inboxPrefix: CONFIG_RUNTIME_INBOX_PREFIX` (`_INBOXBILLINGCFG`). `createInbox`
yields `_INBOXBILLINGCFG.<nuid>` — a first token DISTINCT from `_INBOX`, so the
platform-wide `_INBOX.>` grants can NEVER match it (NATS matching is segment-exact
on the first token). NATS ACLs grant `_INBOXBILLINGCFG.>` to `billing_service`
(subscribe) and `config_service` (publish) ONLY; `services.schema.json` admits the
token and the pinned invariant asserts no other CN holds it.

### 3. Systemic `_INBOX.>` exposure is tracked, NOT fixed here

The shared `_INBOX.>` reply channel is a platform-wide weakness (auth
password-reset / user-data replies ride it too). Narrowing every service to a
per-service scoped inbox is tracked as **ORPHAN-CRITICAL-402** (owner infra-expert
+ security-reviewer). This PR isolates ONLY the config-secret path to bound the
blast radius without a fleet-wide change.

## Consequences

**Positive:** the plaintext Stripe secret is grantable to one CN and its reply is
unreadable by any other cert; the protecting grants are build-time enforced;
future callers of `config.runtime.*` are auto-covered by the parity invariant.

**Negative / accepted:** a second inbox-prefix convention now exists
(`_INBOXBILLINGCFG.` alongside `_INBOX.`); the `config.runtime.` and
`_INBOXBILLINGCFG.` prefixes are two more entries in the `services.schema.json`
allowlist. Both are the intended cost of not routing a secret over a shared token.

**Follow-up:** ORPHAN-CRITICAL-402 (platform-wide scoped inboxes) supersedes this
ADR's scoping decision once complete.
