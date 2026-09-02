# Execution, Confinement ve Supply-Chain Sözleşmesi

[Authority index](INDEX.md) · Owners: S17-S24, S26 ve S60.

## Process ve credential data flow

Provider CLI ve bütün child tool/artifact staging yalnız dedicated `aria-worker-vm` üzerindedir;
production droplet ve control VM üzerinde CLI process'i çalışamaz. Her job için supervisor bir
ephemeral microVM/volume ve ayrı PID/mount/user/network namespace kurar:

```text
control/scheduler --signed job capability--> broker admission
broker auth socket --> provider CLI (ephemeral UID 32001/32002, snapshot RO)
provider tool request --job-scoped mTLS RPC--> executor tool child (UID 32003, worktree RW)
executor result --redacted digest--> broker --> quarantine/CAS admission
```

Provider credential byte'ı environment, argv, file, worktree, response veya artifact'a girmez.
Operator credential agent'ının authenticated Unix socket'i yalnız provider CLI PID namespace'ine
mount edilir; executor/tool child namespace'inde socket/path yoktur. Broker doğrudan shell/tool
child çalıştıramaz; CLI tool invocation yalnız executor RPC'sine gider. Executor provider endpoint,
credential agent veya broker home/config'e route bulamaz. Subscription CLI bu mediated contract'ı
sağlamıyorsa S20/S21 `BLOCKED` olur; daha geniş credential veya Git authority verilmez.

Her child process exact image/toolchain digest'i, read-only rootfs, no-new-privileges, empty ambient
capability set, bounded `/proc`, syscall policy ve CPU/RAM/PID/disk/inode/I/O/network deadline ile
başlar. Orphan child terminal/reconciled olmadan cleanup başlayamaz. Process ancestry ve cgroup/VM
placement evidence'a bağlanır.

## Canonical effect envelope

Broker, CAS ve publisher admission aynı kapalı envelope'u taşır:

```text
missionId, jobId, attemptId, effectId, idempotencyKey,
leaseEpoch, fencingToken, cancelGeneration, recoveryEpoch,
workspaceId, code/base/headRepositoryId, snapshotSha, fullInputDigest,
budgetReservationId, dlpAdmissionId, toolchainManifestDigest,
capability, permittedTools, timeout, issuedAt, expiresAt
```

Envelope operator policy key'iyle imzalı short-lived capability'dir; broker authority DB credential
almaz. Dispatcher başlamadan, provider process spawn'dan hemen önce ve response/CAS/DB admission
öncesi current lease/cancel/recovery epoch'u capability introspection endpoint'inden doğrular.
Stale/cancelled attempt yeni call başlatamaz veya output admit edemez. Gönderilmiş fakat sonucu
belirsiz call `UNKNOWN` ve reservation `HELD_UNKNOWN` kalır; retry yeni `effectId` üretemez.

Race oracle'ı lease expiry/cancel/retry'ı before-send, sent-before-response, response-before-CAS ve
CAS-before-DB sınırlarında çalıştırır. Her sınırda en çok bir provider call, tek settlement ve stale
output için sıfır admission gerekir.

## Supervisor-owned workspace ve cleanup

Caller/persisted path cleanup authority değildir. Supervisor random opaque `workspaceVolumeId`
üretir; immutable parent root/mount executor UID'sine yazılamaz. Normal teardown terminal/fenced job
microVM veya job-scoped volume destroy işlemidir. Path-recursive fallback yoktur.

Volume destroy mümkün değilse cleanup yalnız açılmış directory handle'larına göre çalışır:

- handle-relative no-symlink traversal (`openat2`-eşdeğer semantics), same device/mount/inode;
- registered worktree + opaque volume ID + active lease/cancel/child terminal state atomik check;
- delete öncesi immediate identity revalidation; parent rename/mount yetkisi yalnız supervisor'da;
- adjacent/active worktree, reused path/job ID, orphan CWD ve nonzero Git remove fail-closed;
- bind-mount/symlink/rename swap algılanırsa yalnız incident/freeze, recursive silme yok.

Multi-process destructive test exact disposable terminal volume dışındaki hiçbir inode'un
değişmediğini before/after inventory digest'iyle kanıtlar.

## Hermetic toolchain ve dependency admission

Operator-owned complete `ToolchainManifest`, `OP-05` tarafından S17 başlamadan önce versioned,
imzalı ve current olarak admit edilir; S20/S21 provider-capable process spawn gate'i bu prerequisite
digest'ine DB constraint ile bağlıdır. Manifest şunların tamamını pinler:

- broker/executor/base image digest ve trusted signer/attestation;
- Codex/Claude CLI exact version, binary digest/signature ve installer/source;
- enabled plugin, MCP, hook, tool ve config digest allowlist'i; repo-local discovery default off;
- OS, Node, npm ve diğer runtime/tool version/digest'leri;
- workspace manifest/lockfile digest, registry/source, package integrity ve lifecycle-script allowlist;
- SBOM, vulnerability/license policy, builder/scanner/rules digest ve cache-key inputs;
- Git signer allowlist/fingerprint, subject/workspace binding, validity/revocation ve allowed format.

Her spawn binary/image/plugin/MCP/hook/OS/runtime/lock/registry/lifecycle/SBOM/signer/build alanlarının
tamamını current manifest ve invalidation epoch'uyla yeniden doğrular. Missing/drifted/unlisted
plugin/MCP/hook/settings, auto-update, mutable tag, unknown registry, lifecycle change veya manifest
downgrade halinde provider process count sıfırdır. Cache key bütün manifest girdilerini kapsar.
Controlled-network `npm ci`/eşdeğer clean install ve iki clean build aynı normalized artifact digest
üretir; nondeterminism success değil typed denied witness'tır.

S22 exact immutable base..head commit setini shell interpolation olmadan çözer ve her commit'i
trusted signer setine göre doğrular. Unsigned, mixed, unknown, expired/revoked, wrong-workspace,
rewritten/cherry-pick/rebase range reddedilir. Evidence; source/diff, signer-set, toolchain,
dependency, image, OS ve artifact digest'lerini birlikte bağlar. S22 TDD/reproducibility evidence'ı
toplar; ilk toolchain admission noktası değildir ve önceki provider spawn'ı geriye dönük meşrulaştıramaz.

## Artifact ve malicious-repository negatives

Repository/prompt fixtures `/proc/*/environ`, credential home/config/socket, SSH agent, `.netrc`,
Git credential helper/include/hook, alternate remote, direct HTTPS/SSH push, unauthorized path,
provider egress ve secret reflection dener. Broker/executor network denial'ına ek provider/GitHub
state delta'sı sıfır olmalıdır. Environment assignment/encoded secret DLP kuralları
[data contract](data-privacy.md)'tadır.

İki plane ayrıdır: operator development sprint branch'i normal signed green commit/push protokolü
izler; runtime mission sandbox'ında Git/provider credential/route yoktur. `EXECUTE_NO_PUSH`
evidence'ı yalnız exact runtime attempt, image, network policy, repository ID, before/after remote
state ve observation window'a bağlanır; program-delivery push'u o principal/window içinde değildir.
