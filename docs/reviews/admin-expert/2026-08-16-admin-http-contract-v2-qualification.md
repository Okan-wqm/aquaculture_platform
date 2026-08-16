# Admin HTTP Contract V2 Qualification Review

## ADMIN-HIGH-004

The live admin API exposes 606 controller operations, but only 64 currently
qualify for deterministic V2 request/response contract emission. The compiler
reports 587 diagnostics across missing, unresolved, anonymous, and ORM-entity
wire types. A historical hand-curated manifest hid this coverage gap and cannot
be restored as a second route authority.

## Root cause

Controller metadata, TypeScript wire types, generated artifacts, and browser
consumers evolved independently. Many handlers infer return types or expose
persistence entities, so a compiler cannot prove their serialized contract.
Without a live-source gate, generated output can appear current while silently
covering only a selected subset of routes.

## Resolution contract

The V2 compiler must discover the live controller surface, emit only qualified
operations, and publish an exact content-addressed debt baseline for every
unqualified diagnostic. The baseline owns its source-main SHA, controller-source
digest, complete canonical diagnostic set and hash, qualified-manifest hash,
coverage counts, owner, deadline, and governed finding ID. Check mode fails on
artifact drift, diagnostic drift, source drift, registry mismatch, or expiry.
No diagnostic is ignored and no hand-maintained route manifest is accepted.

The baseline is a stop-line, not a completion claim. The finding remains open
until all 606 live operations have named, non-entity request and response wire
types, the diagnostic count is zero, and frontend consumers use the generated
authority.

## Acceptance

- Two write-mode compilations at one source revision are byte-identical.
- Check mode is read-only and rejects any source, artifact, diagnostic, owner,
  deadline, finding, or content-hash drift.
- The committed report states `64 / 606` qualified and `587` diagnostics until
  those numbers change through real controller contract work.
- Package, Nx, and always-on invariant entry points run the same compiler implementation.
