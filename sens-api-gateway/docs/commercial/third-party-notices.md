# Third-Party Notices — Suderra Edge Agent

> **(LEGAL REVIEW REQUIRED)** — This file is the human-readable NOTICES document distributed alongside the Edge Agent binary. The machine-generated source-of-truth is produced by `cargo bundle-licenses` on every release tag; see the regeneration procedure in `oss-attribution.md` §5 and §1. This file is the rendered form of that output with licence bodies inlined.

Document date: 2026-04-24
Gateway version covered: 1.6.0

---

## 1. Purpose and structure

The Suderra Edge Agent binary incorporates open-source components licensed under permissive and weak-copyleft open-source licences. This document:

- Attributes each incorporated component by name, version, author, and licence.
- Carries the full text of each applicable licence once per licence family.
- Flags any vendored or natively compiled upstream code whose licence text is not automatically captured by Cargo metadata (§4).

The document is generated mechanically at release time and hand-reviewed for the §4 vendored-code section. The canonical YAML form (`third-party-notices.generated.yaml`) is produced by:

```
cargo bundle-licenses --format yaml --output docs/commercial/third-party-notices.generated.yaml
```

and is the authoritative artefact for audit purposes.

---

## 2. Incorporated components (summary)

The full component list — direct and transitive — is in the YAML artefact referenced in §1. For human review, the direct-dependency summary is tabulated in `oss-attribution.md` §1 and is not duplicated here. Licence families represented in the transitive closure as of v1.6.0:

- Apache-2.0 (with and without LLVM exception)
- MIT
- BSD-2-Clause
- BSD-3-Clause
- ISC
- MPL-2.0 (weak copyleft; see `oss-attribution.md` §2.3 for compliance posture)
- Unicode-3.0
- CDLA-Permissive-2.0
- CC0-1.0
- OpenSSL (transitively via `ring` and SQLCipher's vendored OpenSSL)
- Zlib
- BSL-1.0
- Unlicense

The `cargo-deny` gate in `sens-api-gateway/deny.toml:37-53` enforces that only the above families appear in the dependency tree.

---

## 3. Licence texts

The full text of each licence family appears below once. Per-component attribution (crate name, version, copyright holder) is in the generated YAML and is rendered by the distribution tooling into the on-device `NOTICES` file at `/opt/suderra/NOTICES`.

### 3.1 Apache License, Version 2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/
```

The full licence text is distributed in the on-device `NOTICES` file. For a canonical copy, see `https://www.apache.org/licenses/LICENSE-2.0`.

### 3.2 MIT License

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Per-component copyright holders are enumerated in the generated YAML.

### 3.3 BSD 2-Clause License

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. …
```

(Full text per component in the generated YAML.)

### 3.4 BSD 3-Clause License

Applicable to `rodbus` (clarified in `deny.toml:72-78`), `ed25519-dalek`, `subtle`, and `bindgen` (build-only). The text adds a third clause prohibiting use of the contributor names for endorsement:

```
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.
```

(Full text per component in the generated YAML.)

### 3.5 ISC License

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
```

### 3.6 Mozilla Public License Version 2.0 (MPL-2.0)

Applicable to `opcua` 0.12 (feature `opc-ua-server`). The weak-copyleft obligation applies file-level; Suderra's compliance posture is documented in `oss-attribution.md` §2.3 (the crate is used unmodified, so the obligation to publish modified files does not attach). Canonical text: `https://mozilla.org/MPL/2.0/`.

### 3.7 OpenSSL License

Applicable transitively via `ring` (exception clause in `deny.toml:56-59`) and via the `bundled-sqlcipher-vendored-openssl` feature (`Cargo.toml:94`). Canonical text: `https://www.openssl.org/source/license.html`.

### 3.8 Other licence families

Unicode-3.0, CDLA-Permissive-2.0, CC0-1.0, Zlib, BSL-1.0, Unlicense, and Apache-2.0 WITH LLVM-exception are applicable to a small number of transitive crates. Canonical texts are included in the generated YAML.

---

## 4. Vendored and natively compiled upstream code

The following upstream code is incorporated in the binary through mechanisms that do not surface through Cargo metadata, and therefore requires explicit handling here.

### 4.1 Semtech SX1302 HAL — **licence status requires urgent resolution**

- **Source:** `sens-api-gateway/vendor/sx1302_hal/` — upstream: `https://github.com/Lora-net/sx1302_hal`
- **Feature gate:** `lorawan` (see `Cargo.toml:341`)
- **Role:** Native C hardware-abstraction layer for the Semtech SX1302 LoRa concentrator; compiled and linked via `cc` (build-time dependency) and bound via `bindgen`.
- **Licence file in-tree:** **NOT FOUND.** The vendored directory contains only a Turkish-language `README.md` instructing the operator to clone the upstream repository at build time. No `LICENSE`, `COPYING`, or `NOTICE` file is present in `sens-api-gateway/vendor/sx1302_hal/`.

**(LEGAL REVIEW URGENT — handled separately as a blocking finding; not covered by the default commercial licence — see `license-model.md` §6 and the resolution track recorded in `oss-attribution.md` §3.1.)**

Redistribution of a binary built with `--features lorawan` requires, prior to any commercial distribution:

1. Pinning the upstream commit / tag used for the release build.
2. Mirroring the upstream `LICENSE.TXT` into `sens-api-gateway/vendor/sx1302_hal/LICENSE` at that commit.
3. Legal confirmation that the upstream terms permit redistribution as part of a proprietary product, or adoption of the dynamic-loading alternative in `oss-attribution.md` §3.1.

Until resolved, commercial binaries must be built with `--no-default-features --features gpio,health` (or an equivalent set excluding `lorawan`). This restriction is recorded as a pre-distribution blocker.

### 4.2 SQLCipher + bundled OpenSSL

- **Source:** Bundled via the `rusqlite` 0.34 `bundled-sqlcipher-vendored-openssl` feature (`Cargo.toml:94`).
- **Licence:** SQLCipher source is under the BSD-3-Clause-based Zetetic licence; the bundled OpenSSL is under the OpenSSL licence (or Apache-2.0 for the 3.x series used). Both are permitted by `deny.toml`.
- **Attribution:** Carried in the generated YAML.

### 4.3 Rust standard library and compiler builtins

- **Source:** The Rust standard library (`std`) and its `core`, `alloc`, `proc_macro`, and `test` crates; the `compiler_builtins` crate.
- **Licence:** MIT OR Apache-2.0.
- **Attribution:** Deemed covered by §3.1 / §3.2 above and by the generated YAML.

---

## 5. Rendering and distribution

The `NOTICES` file on the target device (`/opt/suderra/NOTICES`) is rendered from the generated YAML by the packaging step in the CI pipeline. A checksum of the rendered `NOTICES` is captured in the release-manifest signature (ADR-021 slot 5) so that any post-release modification of the NOTICES file would invalidate the release signature and be detected by the deployed fleet at update time.

---

## 6. Regeneration cadence

- **Every release tag** (minor or major): Cargo resolves a fresh dependency tree; the YAML is regenerated; the present human-readable document is diffed for family-level changes.
- **Every security-patch release:** Only the YAML is regenerated; the human-readable document is unchanged unless a family-level change has landed.
- **Manual review triggers:** Introduction of a new vendored upstream (§4), introduction of a new licence family not already in §3, or a change to the `cargo-deny` allowlist (`deny.toml:37-53`).

---

Export-control reference date: 2026-04-24
