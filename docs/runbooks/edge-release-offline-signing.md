# Runbook: signing a production edge agent release offline

**Owner:** release owner and the custodians of the edge-release ceremony key
**Related:** ADR-048 DEC-3.9 and DEC-20, Suderra-OS `docs/security/key-ceremony.md` and
`docs/security/key-management.md` (the key's ceremony, custody and inventory),
`.github/workflows/edge-agent-release.yml`, `.github/workflows/edge-release-publish.yml`,
`scripts/edge/edge_release.py`

## What this is

A Suderra OS device installs an agent release only if the release statement
(`suderra.edge-release.v1`, a DSSE envelope) verifies under an `edge-release` key its OS image pins.
Production images pin only the key of the production key ceremony. That key lives in the custodians'
HSM and never enters CI, so for a production release the pipeline builds, states the provenance and
stops; the custodians sign the statements offline and the pipeline publishes after verifying them.

| Mode                   | Repository variable `EDGE_RELEASE_SIGNING_MODE` | Who signs                                                                      | Consumed by             |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------- |
| `ci-key` (default)     | unset or `ci-key`                               | the dev/CI key, job `sign-release-statement` of the `edge-release` environment | dev and QEMU images, CI |
| `offline` (production) | `offline`                                       | the ceremony key in the custodians' HSM                                        | production images       |

A release has exactly one signature (DSSE envelope, `maxItems: 1`), so one tag is one mode.

## Roles

Two-person integrity, as in the OS key ceremony: the **signing operator** drives the HSM, the
**security witness** compares the sheet and counter-signs the transcript. The **release owner** pushes
the tags and approves the publishing job. Role bindings are the ceremony's
(`release-governance/<version>/role-bindings.json`).

## Setup (operator actions, once; status: bekliyor: operatör)

These cannot be done by the repository. Until they are done every production release stops here.

1. The production key ceremony has produced the `edge-release` key inside the HSM and recorded, in the
   inventory of Suderra-OS `docs/security/key-management.md`, its **keyid** (lowercase hex SHA-256 of the
   32-byte raw public key) and its public key PEM (RFC 8410 SubjectPublicKeyInfo).
2. Repository variable `EDGE_RELEASE_SIGNING_MODE` is `offline`.
3. The environment `edge-release-publish` exists with required reviewers (at least one other than the
   person who pushes the tag), deployment policy "selected branches and tags" with only the tag rule
   `agent-statements-v*`, and the variable `EDGE_RELEASE_KEYID` equal to the ceremony's keyid. It has no
   secret. `.github/provisioned-secrets.json` `environments.edge-release-publish` is the check list.
4. The secret `EDGE_RELEASE_SIGNING_KEY` is deleted from the environment `edge-release`, and no
   repository or organization secret of that name exists. The dev/CI key signs nothing in `offline` mode
   and no production image pins it.
5. A tag ruleset protects `agent-v*` and `agent-statements-v*`: only the release owners may create them.

## Per release

1. **Build.** The release owner pushes `agent-v<version>` on a commit reachable from `main` whose Cargo
   version is `<version>`. The pipeline passes both CIs, builds every row, states the provenance in the job
   `prepare-offline-statements`, prints the **signing sheet** in that job's summary and creates a **draft**
   release `agent-v<version>` holding the build outputs, their `.sha256`, SBOM, notice, provenance and
   cosign material. It holds no statement.
2. **Carry.** On an online workstation:
   ```bash
   mkdir bundle && gh release download agent-v<version> --repo <owner>/<repo> --dir bundle
   git archive --format=tar --prefix=repo/ agent-v<version> scripts/edge contracts/suderra-edge/v1 \
     sens-api-gateway/release sens-api-gateway/Cargo.toml > repo.tar
   git rev-parse agent-v<version>^{commit}      # the witness writes this commit down from their own clone
   sha256sum bundle/* repo.tar > carry.sha256   # compare after the transfer
   ```
   Move `bundle/`, `repo.tar` and `carry.sha256` to the offline machine on write-once or freshly formatted
   media. The offline machine needs Python 3.11 or newer and nothing else.
3. **Re-derive and review (offline).** Both people, on the offline machine:
   ```bash
   sha256sum -c carry.sha256 && tar -xf repo.tar && cd repo
   python3 -I scripts/edge/edge_release.py statements --artifacts ../bundle --out-dir ../payloads \
     --expect-version <version>
   python3 -I scripts/edge/edge_release.py offline-request --artifacts ../bundle --payloads ../payloads \
     --out-dir ../request --expect-tag agent-v<version> --expect-commit <commit from step 2> \
     --expect-repository <owner>/<repo>
   ```
   The payloads are derived here from the artifact bytes; the ones the pipeline uploaded are not used.
   `offline-request` re-checks every payload against the bytes, every provenance against the tag, commit,
   repository and the release workflow, and refuses on any difference, writing nothing. It prints the sheet.
   The witness checks, before anything is signed:
   - the last line `sheet-sha256 <hex>` equals the one in the job summary of the build run (a second channel:
     read it in the GitHub UI, not from the carried media);
   - `tag`, `repository` and `commit` are the release ticket's;
   - for each artifact the `board_profile`, `cargo_features`, `security_version`, `min_os_version` and
     `agent_abi` are the ticket's, and `archive sha256` equals the draft release's `.sha256` file.
4. **Sign (HSM).** For each `request/<artifact>.release.pae` the HSM produces the raw 64-byte Ed25519
   signature (RFC 8032 pure Ed25519: no prehash, no context) of exactly the file's bytes, written to
   `signatures/<artifact>.release.sig`. The tool is HSM-agnostic and holds no PKCS#11 or vendor code. With a
   YubiHSM 2 and `yubihsm-shell` (the `sign-eddsa` action; options `-i/--object-id`, `-A/--algorithm`,
   `--authkey`, `-C/--connector`, `--in`/`--out`, `--informat`/`--outformat` are those of its manual page,
   <https://man.archlinux.org/man/yubihsm-shell.1.en>):
   ```bash
   yubihsm-shell --connector <connector from the ceremony ticket> --authkey <auth key id> \
     -a sign-eddsa -i <edge-release object id> -A ed25519 \
     --informat binary --in request/<artifact>.release.pae \
     --outformat binary --out signatures/<artifact>.release.sig
   ```
   Check the line against `yubihsm-shell --help` of the installed version; enter the HSM password as the
   ceremony ticket prescribes, never on a shared shell history. A wrong input or output format is not
   dangerous: the next step verifies every signature before it writes a statement.
5. **Assemble and verify (offline).**
   ```bash
   python3 -I scripts/edge/edge_release.py offline-assemble --artifacts ../bundle --payloads ../payloads \
     --signatures ../signatures --public-key <ceremony public key PEM> --expect-keyid <keyid> \
     --out-dir ../statements
   python3 -I scripts/edge/edge_release.py verify --artifacts ../bundle --statements ../statements \
     --public-key ../statements/edge-release.pub --expect-keyid <keyid>
   ```
   `offline-assemble` stages the envelopes, passes the whole set through the publish gate's verifier
   (Ed25519 `verify_strict`, the contract's statement checks, the payload byte for byte this release's
   statement of the artifact bytes) and writes `statements/` only if every one passes. It refuses a keyid other
   than the ceremony's, a TEST-ONLY contract key, a signature of another key, row or message, a signature that
   is not 64 bytes, and a missing or extra signature. Statements and the public key are public data.
6. **Upload.** On the online workstation, after a hash comparison of the transferred files:
   ```bash
   gh release upload agent-v<version> --repo <owner>/<repo> statements/*.release.dsse.json statements/edge-release.pub
   ```
7. **Publish.** The release owner pushes the tag on the same commit:
   ```bash
   git tag -s agent-statements-v<version> <commit> && git push origin agent-statements-v<version>
   ```
   The workflow `edge-release-publish` checks that the tag, the Cargo version, the release tag and its commit
   agree and that the commit is reachable from `main`; after the environment's reviewers approve, it checks that
   the release is still a draft holding exactly the planned files, verifies every statement under the
   environment's `EDGE_RELEASE_KEYID` (the uploaded public key is accepted only if it hashes to it), adds the
   manifest (cosign keyless, by this workflow) and publishes the release with notes that state the statements
   were signed offline.
8. **Anyone can verify afterwards**, offline or not, with the same tool and the keyid of the inventory:
   ```bash
   gh release download agent-v<version> --repo <owner>/<repo> --dir release
   python3 -I scripts/edge/edge_release.py verify --artifacts release --statements release \
     --public-key release/edge-release.pub --expect-keyid <keyid>
   ```

## When the pipeline refuses

| Refusal                                                                     | Meaning                                                             | Action                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `offline-request`: provenance tag, commit or repository is not the expected | the build ran for another commit or repository than the ticket's    | stop; do not sign; investigate the run                                   |
| `offline-request`: the payload is not the statement this release makes      | the statements the pipeline uploaded differ from the artifact bytes | stop; the build outputs may have been replaced                           |
| `offline-assemble`: signature does not verify                               | wrong format, wrong key, wrong message or a swapped row             | sign again from the PAE files; check the object id and the output format |
| publish job: the release is not a draft, or a file is missing or unexpected | someone published or edited the draft                               | do not push the tag again; open an incident, rebuild with a new version  |
| publish job: a statement does not verify under `EDGE_RELEASE_KEYID`         | the uploaded statements are not the ceremony key's                  | stop; compare the variable with the inventory                            |

A rebuild of the same version produces other archive bytes (the compiler is not yet reproducible, DEC-20 P2),
so statements signed for one build never verify against another: after any rebuild, repeat the procedure.

## Rehearsal

Before the first production release, and in every key drill, run steps 3 to 5 with a throwaway software key
(never the production key, never a TEST-ONLY contract key: both refuse):

```bash
openssl genpkey -algorithm ed25519 -out rehearsal.pem && openssl pkey -in rehearsal.pem -pubout -out rehearsal.pub
mkdir -p signatures
for p in request/*.release.pae; do
  openssl pkeyutl -sign -rawin -inkey rehearsal.pem -in "$p" -out "signatures/$(basename "$p" .release.pae).release.sig"
done
```

`tests/invariants/edge-release-pipeline.spec.ts` runs these commands in CI with a generated key, including every
refusal above, and pins that the offline envelopes equal the ones the CI signing job writes for the same key.

## What is not covered by a test

The GitHub side of steps 1, 6 and 7 (a draft release, `gh release upload`, the environment's approval, the tag
ruleset) and the HSM step run only on the real repository and a real HSM. The workflows are linted with
actionlint and their structure is pinned by the spec; the first production release is their first execution.
