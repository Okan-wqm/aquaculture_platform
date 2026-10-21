# SCADA e2e F0 deferred debt (2026-10-20)

**Scope.** The pre-existing duplicates, gaps and defects that the F0 work orders (the e2e rebuild's reality gate, PLAN Faz 0) deliberately leave in place, registered with an owner, a deadline and a registry id instead of being dropped or silently refactored. Nothing here is closed by F0. The decision record that scopes F0 is held outside the repository; every claim below carries its own repository evidence.

**Method.** Each row was re-verified on 2026-10-20 against HEAD 3f8b7ee65 with the rg, awk, ls, jq or docker command printed under it; the output is quoted verbatim (lines cut at 200 characters). Where a claim of the F0 plan's draft list did not re-verify as worded (F0-D09 silent skip, F0-D12 line numbers, F0-D13 writer count), the row states what the evidence shows; a draft row that duplicates an open finding was not registered (F0-D06, below). Each section also states the strongest counter-argument and the evidence that defeats it.

**Registry.** Every row is registered in `docs/reviews/_registry/findings.jsonl` through npm run findings:add with raised_in_cycle 2026-10-20-scada-e2e-f0, state OPEN, owner_agent claude, owner_user Okan-wqm and deadline 2026-11-30. The heading of each section below is the registry id; commit trailers and detector exceptions cite the id, never the F0-Dnn label.

## Label to id table

<!-- prettier-ignore-start -->

| Label | Registry id |
| ----- | ----------- |
| F0-D01 | SENSOR-MEDIUM-338 |
| F0-D02 | SENSOR-LOW-339 |
| F0-D03 | INFRA-MEDIUM-239 |
| F0-D04 | SENSOR-MEDIUM-340 |
| F0-D05 | INFRA-LOW-240 |
| F0-D07 | INFRA-MEDIUM-241 |
| F0-D08 | INFRA-MEDIUM-242 |
| F0-D09 | SENSOR-MEDIUM-341 |
| F0-D10 | SENSOR-LOW-342 |
| F0-D11 | INFRA-MEDIUM-243 |
| F0-D12 | INFRA-HIGH-244 |
| F0-D13 | INFRA-LOW-245 |
| F0-D14 | INFRA-LOW-246 |
| F0-D15 | INFRA-LOW-247 |
| F0-D16 | INFRA-LOW-248 |
| F0-D17 | SENSOR-LOW-343 |
| F0-D18 | INFRA-LOW-249 |
| F0-D19 | INFRA-LOW-250 |
| F0-D20 | INFRA-LOW-251 |
| F0-D21 | INFRA-LOW-252 |

<!-- prettier-ignore-end -->

### SENSOR-MEDIUM-338

**F0 golden-path steps are independent: no artifact chain carries the S3 saved SCADA document into the S7 deploy bundle, so a green S7 would not prove that deploy ships what S3 saved**

- Label: F0-D01 · Severity: MEDIUM · Domain: SENSOR · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: docs/plans/2026-10-19-scada-e2e-rebuild/PLAN.md section 1 (the golden path is one chain: the screen placed in step 3 is the document step 6 maps unchanged and step 7 ships)

**Claim.** PLAN section 1 defines steps 3 to 7 as one scenario: the screen placed in step 3 reaches step 6 unchanged and step 7 ships it inside one signed bundle. The F0 lane runs every step as its own independent test step, so nothing hands the document S3 saved to the bundle S7 sends. UNVERIFIED in the repository today: the independence is the F0 design; no golden-path code exists yet (ls e2e/scada exits 2). Verify when the golden-path spec lands by reading its steps manifest for a shared artifact path.

**Evidence at registration.**

```text
$ rg -n -e 'ayrı bir test adımıdır' -e '^3\. \*\*Ekran' -e '^6\. \*\*Devreye alma' -e '^7\. \*\*Deploy' docs/plans/2026-10-19-scada-e2e-rebuild/PLAN.md
32:Plan bitince aşağıdaki senaryo, CI'da gerçek bileşenlerle (mock'suz) baştan sona otomatik çalışmalı. Bileşenler: Postgres, NATS, Mosquitto, sensor-service, web arayüzü, release derlemesiyle edge aj
44:3. **Ekran.** Tank, pompa ve vanayı yerleştirir; portları düz borularla bağlar; ekipmanı taşıyınca borular takip eder.
47:6. **Devreye alma.** Edge cihazı eklenir ve çevrimiçi olur. Taslak tag'ler, program ve ekran değişmeden, cihaz kanallarına eşlenir.
48:7. **Deploy.** Paket ve program tek bir imzalı paket olarak gönderilir. Cihaz imzayı ve politikayı doğrular, uygular ve onay (ack) döner. Arayüz "uygulandı" bilgisini yalnızca bu onaydan sonra göst
(exit 0)

$ ls e2e/scada
ls: cannot access 'e2e/scada': No such file or directory
(exit 2)
```

**Strongest counter-argument.** Independence is deliberate: in F0 every step is expected red, and a chain would only propagate the first failure into all later steps.

**What defeats it.** The deliberate choice is a stated non-claim of F0, not a resolution: this finding is its tracked debt, owned and dated, and SENSOR-HIGH-337 stays the umbrella that F0 does not close.

**Fix direction.** In the phase that turns S3 and S7 green, make S3 write the saved document into the step-report artifact directory and S7 read exactly that file when it builds its bundle (or seed both from one fixture), and add a test that fails when the S7 bundle source differs from the S3 saved document.

### SENSOR-LOW-339

**The agent-io-config v2 golden fixture lives in tools/gates/fixtures, outside the contract fixture home libs/sensor-contracts/fixtures**

- Label: F0-D02 · Severity: LOW · Domain: SENSOR · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: Contract fixtures have one home, libs/sensor-contracts/fixtures (PLAN Faz 0 item 3, PLAN.md:100)

**Claim.** The other contract fixtures (command-envelope, `deploy-*`) live in libs/sensor-contracts/fixtures; the io-config golden fixture lives in tools/gates/fixtures. edge-device.service.ts calls it the wire SSoT, the sensor-service spec reads it by a tools/gates path, and the enterprise gate lists it as a required string. The Rust side has no reference to it at all (rg over sens-api-gateway exits 1), so the fixture is not part of the cross-language fixture legs either.

**Evidence at registration.**

```text
$ ls tools/gates/fixtures libs/sensor-contracts/fixtures
libs/sensor-contracts/fixtures:
alarm
command-envelope.json
deploy-bundle.json
deploy-process.json
deploy-program.json
deploy-scada-package-unsupported-widget.json
deploy-scada-package.json
undeploy-scada-package.json

tools/gates/fixtures:
agent-io-config-v2.golden.json
plan-coverage
(exit 0)

$ rg -n 'agent-io-config-v2.golden' apps/sensor-service tools --glob '*.ts'
tools/gates/sens-enterprise-validation.ts:1089:        '../../../tools/gates/fixtures/agent-io-config-v2.golden.json',
tools/gates/sens-enterprise-validation.ts:1094:        ...hasAll(sensorFixture, ['agent-io-config-v2.golden.json', 'schemaVersion']),
tools/gates/sens-enterprise-validation.ts:1103:        [IO_CONFIG, 'sens-api-gateway/src/main.rs', 'apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts', 'tools/gates/fixtures/age
tools/gates/sens-enterprise-validation.ts:1108:          lineRef('apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts', 'agent-io-config-v2.golden.json'),
apps/sensor-service/src/edge-device/edge-device.service.ts:175:// tools/gates/fixtures/agent-io-config-v2.golden.json is the wire SSoT.
apps/sensor-service/src/edge-device/edge-device.service.ts:1487:   * tag wire format (tools/gates/fixtures/agent-io-config-v2.golden.json
apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts:124:        join(process.cwd(), 'tools/gates/fixtures/agent-io-config-v2.golden.json'),
(exit 0)

$ rg -n agent-io-config-v2.golden sens-api-gateway
(no output)
(exit 1)
```

**Strongest counter-argument.** tools/gates is the gate tooling directory, so the fixture sits next to its first consumer.

**What defeats it.** The consumers are the sensor-service spec and the production service comment that names it the wire SSoT (edge-device.service.ts:175, :1487); a wire SSoT outside the contract home is a second home, and the Rust consumer cannot find it from the home.

**Fix direction.** Move the fixture into libs/sensor-contracts/fixtures and update the four named references in the same commit (the gate at sens-enterprise-validation.ts:1089-1108 names it as a required string), then let the Rust fixture leg consume it. Not moved by the F0 e2e work: the gate is outside its seams.

### INFRA-MEDIUM-239

**Two hand-rolled NATS smoke PKIs and an anonymous docker.io nats:2.10.24-alpine pull duplicate infrastructure/docker/scripts/generate-internal-certs.sh and the nats entry of ci-images.json**

- Label: F0-D03 · Severity: MEDIUM · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md NATS Authentication (ADR-014/ADR-015: one cert issuer) and the CI image mirror policy (INFRA-HIGH-227, .github/manifests/ci-images.json)

**Claim.** Each smoke harness mints its own CA, server cert and client certs with openssl genrsa (boot-path :21,:25,:45; messaging :17,:21,:28), although generate-internal-certs.sh already issues the same artifacts: a nats server row (:67), per-service mTLS client certs whose CN is the services.yaml name (generate_per_service_client_cert, :775, roster read at :859) and an output directory chosen by CERTS_DIR or DEPLOY_CERTS_DIR (:13-26). The two harnesses also disagree with each other (CA key 2048 bits in boot-path :21, 4096 in messaging :17). Both pull docker.io nats:2.10.24-alpine anonymously (boot-path :61, messaging :43) although ci-images.json mirrors nats at tag 2.10-alpine.

**Evidence at registration.**

```text
$ rg -n -e 'openssl genrsa' -e 'nats:2\.10' scripts/nats/boot-path-acl-smoke-harness.sh scripts/nats/messaging-acl-smoke-harness.sh
scripts/nats/boot-path-acl-smoke-harness.sh:21:openssl genrsa -out "$TMP_DIR/ca-key.pem" 2048 >/dev/null 2>&1
scripts/nats/boot-path-acl-smoke-harness.sh:25:openssl genrsa -out "$TMP_DIR/certs/nats-key.pem" 2048 >/dev/null 2>&1
scripts/nats/boot-path-acl-smoke-harness.sh:45:  openssl genrsa -out "$TMP_DIR/clients/${name}-key.pem" 2048 >/dev/null 2>&1
scripts/nats/boot-path-acl-smoke-harness.sh:61:  nats:2.10.24-alpine -c /etc/nats/nats.conf >/dev/null
scripts/nats/messaging-acl-smoke-harness.sh:17:openssl genrsa -out "$TMP_DIR/ca-key.pem" 4096 >/dev/null 2>&1
scripts/nats/messaging-acl-smoke-harness.sh:21:openssl genrsa -out "$TMP_DIR/certs/nats-key.pem" 2048 >/dev/null 2>&1
scripts/nats/messaging-acl-smoke-harness.sh:28:openssl genrsa -out "$TMP_DIR/client/messaging_service-key.pem" 2048 >/dev/null 2>&1
scripts/nats/messaging-acl-smoke-harness.sh:43:  nats:2.10.24-alpine -c /etc/nats/nats.conf >/dev/null
(exit 0)

$ rg -n -e 'MANAGED_SERVER_SETS=\(' -e "'nats\|nats" -e 'CERTS_DIR="\$\{CERTS_DIR' -e '^generate_per_service_client_cert\(\)' -e '^SERVICES_YAML=' infrastructure/docker/scripts/generate-internal-certs.sh
22:  CERTS_DIR="${CERTS_DIR:-${REPO_ROOT}/certs}"
66:MANAGED_SERVER_SETS=(
67:  'nats|nats|DNS:nats,DNS:aqua-nats,DNS:localhost|0644'
775:generate_per_service_client_cert() {
859:SERVICES_YAML="${REPO_ROOT}/infrastructure/nats/services.yaml"
(exit 0)

$ rg -n -A4 '"name": "nats"' .github/manifests/ci-images.json
27:      "name": "nats",
28-      "upstream": "docker.io/library/nats:2.10-alpine",
29-      "digest": "sha256:b83efabe3e7def1e0a4a31ec6e078999bb17c80363f881df35edc70fcb6bb927",
30-      "mirror": "ghcr.io/okan-wqm/aquaculture_platform/ci/nats",
31-      "tag": "2.10-alpine"
(exit 0)
```

**Strongest counter-argument.** A smoke PKI must be disposable and self-contained (7-day CA, CN localhost); sharing the production issuer would couple the smoke to production material.

**What defeats it.** The issuer is already parameterised for this: CERTS_DIR may point at any absolute directory (:13-26) and the client leaves it issues are the per-identity CNs the boot-path harness derives from services.yaml itself. The differences are layout, key size and the loopback IP SAN the harness adds (the issuer nats SAN set at :67 has DNS names only); the SAN is a point the migration must check, not a reason for a second PKI.

**Fix direction.** Issue the smoke PKI through generate-internal-certs.sh with CERTS_DIR set to the harness temporary directory (check the loopback SAN and the 365-day leaf validity against what the harnesses assume), and pull nats from the ci-images.json mirror (ghcr.io/okan-wqm/aquaculture_platform/ci/nats). Until then the F0 single-definition detector carries the two harnesses as keyed exceptions that cite this finding. Not migrated by the F0 e2e work: it touches the nats-invariants lane.

### SENSOR-MEDIUM-340

**No differential TS-vs-Rust corpus and no silent-drop round trip exist for the sensor contracts, and the five deploy-signature pin constants are hand-copied between deploy-signing.service.spec.ts and deploy_sig.rs**

- Label: F0-D04 · Severity: MEDIUM · Domain: SENSOR · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: SENSOR-HIGH-337: contract fixtures are produced by the real producers and consumed on both sides (PLAN Faz 0 item 3, PLAN.md:100)

**Claim.** The TS spec declares PINNED_SEED_HEX, PINNED_TENANT, PINNED_SHA, PINNED_CANONICAL_HEX and PINNED_SIGNATURE_HEX (:18,:19,:20,:21,:28) and the Rust test spells the same canonical hex and signature again (deploy_sig.rs:485-512); two literal copies of one vector. A search for a differential corpus or a silent-drop guard in libs/sensor-contracts, the sensor-service sources and the Rust fixture tests finds nothing (exit 1).

**Evidence at registration.**

```text
$ rg -n '^const PINNED_' apps/sensor-service/src/deploy-artifact/__tests__/deploy-signing.service.spec.ts
18:const PINNED_SEED_HEX = '01'.repeat(32);
19:const PINNED_TENANT = 'tenant-42';
20:const PINNED_SHA = 'a'.repeat(64);
21:const PINNED_CANONICAL_HEX =
28:const PINNED_SIGNATURE_HEX =
(exit 0)

$ rg -n -e 'fn cross_language_pinned_vector' -e 'expected_canonical_hex =' -e 'const PINNED_SIGNATURE_HEX' sens-api-gateway/src/scripting/deploy_sig.rs
481:    fn cross_language_pinned_vector() {
485:        let expected_canonical_hex = concat!(
512:    const PINNED_SIGNATURE_HEX: &str = "cf5e386d472b0d2af37a04093d670f75e96e46c548df9574c4dabb27ae605573b0e0de262f62fbbe5f947136b4ce300478a8247b9c1cfa9737fac2a16d79be06";
(exit 0)

$ rg -n -i -e 'differential' -e 'silent.?drop' libs/sensor-contracts apps/sensor-service/src sens-api-gateway/src/contract_fixtures_tests.rs
(no output)
(exit 1)
```

**Strongest counter-argument.** The pinned vector is a cross-language known-answer test and is hand-copied on purpose: a generated copy would make the test circular.

**What defeats it.** A known-answer literal belongs in exactly one place, read by both tests; today it is in two (TS :18-30, Rust :485-512). The differential corpus and the silent-drop guard have no such argument, and the absence proof shows neither exists.

**Fix direction.** Add a differential corpus (TS emits mutations of the generated positive fixtures with the real validator verdict; the Rust consumer accepts iff the recorded verdict is accept) and a silent-drop guard (serde round trip keeps every input leaf, allowlist keyed to finding ids); move the signature vector into one JSON file under libs/sensor-contracts/fixtures read by both the TS spec and the Rust test. Not part of the F0 e2e work: the F0 fixture legs cover generated frames, not mutations.

### INFRA-LOW-240

**scripts/deploy/droplet-up.sh generates per-service `MINIO_<SVC>_ACCESS_KEY/SECRET_KEY` and `NATS_<SVC>_SVC_USER/PASS` credentials that no running service consumes**

- Label: F0-D05 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: ADR-015 (NATS identity is the cert CN only): the `NATS_*_SVC_*` bookkeeping credentials were left for audit as BACKLOG-NATS-003 (docs/adr/015-nats-cert-is-identity-ssot.md:183)

**Claim.** `NATS_<SVC>_SVC_USER/PASS` are generated for ten services (droplet-up.sh:1258-1259, :1421-1422); inside droplet-up.sh only those generators and one comment (:1248) name them, and no file outside it does (exit 1, hidden files included). The four MinIO key pairs are generated (:1037-1038) and read only by the MinIO user provisioner (:229-230), which loops over gateway, farm, sensor and messaging. The compose services that set `MINIO_ACCESS_KEY` (gateway-api, farm-service, admin-api-service, messaging-service) take it from `MINIO_USER` and `MINIO_PASSWORD` (:759-760, :971-972, :1205-1206, :1823-1824), the same variables that become the MinIO root user (:692-693); sensor-service sets none, admin-api-service is not provisioned, and no file outside droplet-up.sh names a `MINIO_<SVC>` key (exit 1, hidden files included). The provisioned users and prefix policies exist but no service authenticates as them.

**Evidence at registration.**

```text
$ rg -n -e 'generate_credential "MINIO_' -e 'read_env_file_value "MINIO_' -e 'for SVC in gateway' -e 'MINIO_CONSUMER_SERVICES=' scripts/deploy/droplet-up.sh
228:  for SVC in gateway farm sensor messaging; do
229:    ACCESS_KEY=$(read_env_file_value "MINIO_$(echo "${SVC}" | tr '[:lower:]' '[:upper:]')_ACCESS_KEY")
230:    SECRET_KEY=$(read_env_file_value "MINIO_$(echo "${SVC}" | tr '[:lower:]' '[:upper:]')_SECRET_KEY")
1035:MINIO_CONSUMER_SERVICES="gateway farm sensor messaging"
1037:  generate_credential "MINIO_${SVC^^}_ACCESS_KEY" "${ENV_FILE}"
1038:  generate_credential "MINIO_${SVC^^}_SECRET_KEY" "${ENV_FILE}"
(exit 0)

$ rg -n -e '_SVC_(USER|PASS)' -e 'for SVC in AUTH' scripts/deploy/droplet-up.sh
1248:  # NATS_*_SVC_USER / NATS_*_SVC_PASS are historical (internal
1257:  for SVC in AUTH FARM SENSOR GATEWAY NOTIFICATION BILLING ALERT HR MESSAGING HYDROPONICS; do
1258:    generate_credential "NATS_${SVC}_SVC_USER"
1259:    generate_credential "NATS_${SVC}_SVC_PASS"
1420:  for SVC in AUTH FARM SENSOR GATEWAY NOTIFICATION BILLING ALERT HR MESSAGING HYDROPONICS; do
1421:    generate_credential "NATS_${SVC}_SVC_USER"
1422:    generate_credential "NATS_${SVC}_SVC_PASS"
(exit 0)

$ rg --hidden -n -e '_SVC_(USER|PASS)' -g '!node_modules' -g '!.git' -g '!docs/**' -g '!scripts/deploy/droplet-up.sh' .
(no output)
(exit 1)

$ rg --hidden -n -e 'MINIO_(GATEWAY|FARM|SENSOR|MESSAGING)_' -g '!node_modules' -g '!.git' -g '!docs/**' -g '!scripts/deploy/droplet-up.sh' .
(no output)
(exit 1)

$ rg -n -e 'MINIO_ACCESS_KEY: ' -e 'MINIO_SECRET_KEY: ' -e 'MINIO_ROOT_USER: ' docker-compose.droplet.yml
692:      MINIO_ROOT_USER: ${MINIO_USER:?MINIO_USER is required}
759:      MINIO_ACCESS_KEY: ${MINIO_USER:?MINIO_USER is required}
760:      MINIO_SECRET_KEY: ${MINIO_PASSWORD:?MINIO_PASSWORD is required}
971:      MINIO_ACCESS_KEY: ${MINIO_USER:?MINIO_USER is required}
972:      MINIO_SECRET_KEY: ${MINIO_PASSWORD:?MINIO_PASSWORD is required}
1205:      MINIO_ACCESS_KEY: ${MINIO_USER:?MINIO_USER is required}
1206:      MINIO_SECRET_KEY: ${MINIO_PASSWORD:?MINIO_PASSWORD is required}
1823:      MINIO_ACCESS_KEY: ${MINIO_USER:?MINIO_USER is required}
1824:      MINIO_SECRET_KEY: ${MINIO_PASSWORD:?MINIO_PASSWORD is required}
(exit 0)

$ rg -n 'BACKLOG-NATS-003' docs/adr/015-nats-cert-is-identity-ssot.md
183:  consumption is being audited (BACKLOG-NATS-003); if nothing reads
(exit 0)
```

**Strongest counter-argument.** The MinIO keys are consumed: provision_minio_service_credentials reads all four pairs and creates MinIO users with per-prefix policies (SEC-HIGH-109).

**What defeats it.** Creating a user is not consuming it: every compose service that sets a MinIO key uses the root credential, so the per-prefix policy isolation SEC-HIGH-109 describes is provisioned but not in force. For NATS the ADR itself says the variables are removable if nothing reads them, and rg shows nothing outside the generators names them.

**Fix direction.** Either wire the per-service credentials into the compose services (`MINIO_ACCESS_KEY` from `MINIO_<SVC>_ACCESS_KEY`) so the policies take effect, or delete the generation and the provisioner; delete the `NATS_*_SVC_*` generation (BACKLOG-NATS-003). Not part of the F0 e2e work: production deploy path.

### INFRA-MEDIUM-241

**WS_CORS_ORIGINS is absent from the sensor-service environment of docker-compose.droplet.yml, so the SCADA runtime WebSocket gateway denies every browser origin in production**

- Label: F0-D07 · Severity: MEDIUM · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: libs/backend-common/src/websocket/build-ws-cors-config.ts:125 (WS_CORS_ORIGINS must be set in production for every WebSocket gateway)

**Claim.** The only WS_CORS_ORIGINS line of docker-compose.droplet.yml is :765, inside gateway-api. The sensor-service block (:1029-1130) sets NODE_ENV production (:1036) and CORS_ORIGINS (:1043), has no env_file and no WS_CORS_ORIGINS. The SCADA runtime gateway reads WS_CORS_ORIGINS (:80) and, in production without it, returns origin false (:92-93) and logs "connections blocked" (:194).

**Evidence at registration.**

```text
$ rg -n WS_CORS_ORIGINS docker-compose.droplet.yml
765:      WS_CORS_ORIGINS: ${CORS_ORIGINS:-https://app.suderra.com}
(exit 0)

$ awk 'NR==1029 || (NR>=1029 && NR<=1130 && /NODE_ENV|CORS|env_file/) {print NR": "$0}' docker-compose.droplet.yml
1029:   sensor-service:
1036:       NODE_ENV: production
1043:       CORS_ORIGINS: ${CORS_ORIGINS:-https://app.suderra.com}
(exit 0)

$ rg -n -e "process.env\['WS_CORS_ORIGINS'\]" -e 'Production without explicit config' -e 'connections blocked' apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts
80:  const originsConfig = process.env['WS_CORS_ORIGINS'] ?? '';
92:  // Production without explicit config: deny all
194:        'SCADA WebSocket Gateway: WS_CORS_ORIGINS not set in production — connections blocked',
(exit 0)
```

**Strongest counter-argument.** The value could arrive from an env_file or the deploy bootstrap rather than the compose block.

**What defeats it.** The block has no env_file (the awk listing above shows only NODE_ENV and CORS_ORIGINS lines for :1029-1130) and the one compose hit for the droplet is gateway-api; a value injected outside compose would be undeclared configuration, which the compose-env invariants exist to prevent.

**Fix direction.** Add WS_CORS_ORIGINS: ${CORS_ORIGINS:-https://app.suderra.com} to the sensor-service environment (same spelling as gateway-api :765) and extend the compose environment invariant to require it for every service that hosts a WebSocket gateway. Not part of the F0 e2e work: production compose file.

### INFRA-MEDIUM-242

**docs/runbooks/staging-environment.md tells operators to generate MQTT_SENSOR_SERVICE_HASH with mosquitto_passwd -H sha512, which yields a $6$ hash that MqttAuthService.verifyPassword rejects because it accepts only $7$**

- Label: F0-D08 · Severity: MEDIUM · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: Runbook accuracy: a documented operator command must produce a value the consumer accepts (docs/runbooks/staging-environment.md:200 against apps/sensor-service/src/edge-device/mqtt-auth.service.ts:514)

**Claim.** The runbook command (:200) uses -H sha512 and says the result is a $7$ string (:203). The eclipse-mosquitto:2 image prints algorithm id 6 for -H sha512 and 7 for -H sha512-pbkdf2 (probe below; the runbook names the untagged image, which was not probed). sensor-service reads the hash from MQTT_SENSOR_SERVICE_HASH (mqtt-auth.service.ts:107, compose :1062), verifies the service password with verifyPassword (:162), and verifyPassword returns false unless the hash splits into five parts with parts[1] equal to 7 (:514).

**Evidence at registration.**

```text
$ rg -n -e 'mosquitto_passwd -c' -e 'Copy the resulting' docs/runbooks/staging-environment.md
200:docker run --rm -it eclipse-mosquitto mosquitto_passwd -c -H sha512 -b - sensor_service '<MQTT_SENSOR_SERVICE_PASSWORD>' | tail -n 1 | cut -d: -f2
203:Copy the resulting `$7$...` string into `MQTT_SENSOR_SERVICE_HASH`. Rotate this hash whenever the password rotates (they travel as a pair — see the secret-rotation runbook).
(exit 0)

$ rg -n -e "MQTT_SENSOR_SERVICE_HASH'\)" -e 'return this.verifyPassword\(password, serviceHash\)' -e "parts\[1\] !== '7'" apps/sensor-service/src/edge-device/mqtt-auth.service.ts
107:      ['sensor_service', this.configService.get<string>('MQTT_SENSOR_SERVICE_HASH')],
162:      return this.verifyPassword(password, serviceHash);
514:      if (parts.length !== 5 || parts[1] !== '7') {
(exit 0)

$ docker run --rm --network none eclipse-mosquitto:2 sh -c "mosquitto_passwd -c -H sha512 -b /tmp/p sensor_service pw-secret-test >/dev/null 2>&1 && cut -d: -f2 /tmp/p | cut -d'\$' -f2"   # algorithm id printed for -H sha512
6
(exit 0)

$ docker run --rm --network none eclipse-mosquitto:2 sh -c "mosquitto_passwd -c -H sha512-pbkdf2 -b /tmp/p sensor_service pw-secret-test >/dev/null 2>&1 && cut -d: -f2 /tmp/p | cut -d'\$' -f2"   # algorithm id printed for -H sha512-pbkdf2
7
(exit 0)
```

**Strongest counter-argument.** Mosquitto itself accepts both formats, so the broker keeps working with a $6$ entry; only the cloud verifier is strict.

**What defeats it.** The runbook value is not placed in the broker file but in MQTT_SENSOR_SERVICE_HASH, whose only consumer is the strict verifier (rg: mqtt-auth.service.ts:107 reads it, :162 verifies it, :514 rejects anything but $7$); the broker acceptance is irrelevant to that path. The probe prints only the algorithm id, never the hash.

**Fix direction.** Change the runbook to -H sha512-pbkdf2 and add a test that runs the documented command (or the F0 shell generator) and passes its output through the real verifyPassword; the F0 secrets generator carries that standing test. The $7$ format also has two spec-local mirrors (mqtt-auth.service.spec.ts:63-70, mqtt-acl.mosquitto.spec.ts:36-40) that should call MqttAuthService.hashPassword. Not part of the F0 e2e work: the runbook is outside its file list.

### SENSOR-MEDIUM-341

**auth-service boots green when the super-admin seed is skipped: six warn-and-skip statements in seed.service.ts leave the seed undone, and seed() still logs "Database seed completed successfully"**

- Label: F0-D09 · Severity: MEDIUM · Domain: SENSOR · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach tier 3: the wrong state (a platform with no super admin) must be detectable at build or boot, not only in a log line

**Claim.** The skip is not silent (each skip logs at warn), but it is invisible to health and to the seed summary. Missing or malformed SUPER_ADMIN_EMAIL, missing or weak SUPER_ADMIN_PASSWORD, or a production password without an email each log "skipping" and return (six statements, below); seed() then logs "Database seed completed successfully" (:117), and a thrown seed error is swallowed by design (:119, "Seed failure must NOT crash the service"). A fresh stack with the variables unset therefore boots with no super admin and a success line.

**Evidence at registration.**

```text
$ rg -n -i -e 'skipping super admin' -e 'skipping seed' apps/auth-service/src/database/seed.service.ts
66:          'SUPER_ADMIN_EMAIL not set — skipping super admin seed. ' +
77:      this.logger.warn('SUPER_ADMIN_EMAIL not configured — skipping super admin seed.');
83:      this.logger.warn(`Invalid email format for SUPER_ADMIN_EMAIL: ${email} — skipping seed.`);
202:        'SUPER_ADMIN_PASSWORD not set — skipping super admin creation. ' +
212:          'SUPER_ADMIN_PASSWORD is set but SUPER_ADMIN_EMAIL is missing — skipping seed.',
223:          'Skipping super admin creation. Fix password and restart to seed.',
(exit 0)

$ rg -n -e 'seed completed successfully' -e 'must NOT crash' apps/auth-service/src/database/seed.service.ts
117:      this.logger.log('Database seed completed successfully');
119:      // IMPORTANT: Seed failure must NOT crash the service.
(exit 0)
```

**Strongest counter-argument.** The warn lines are the signal and the design comment says the service must start regardless of seed outcome; adding a hard failure would break deployments that seed out of band.

**What defeats it.** This finding does not ask for a crash; it asks that the outcome be detectable: the final success log is emitted on the skip paths too (:117 follows seedSuperAdmin returning), so a log search for the success line cannot tell a seeded platform from an unseeded one, and no readiness signal exists for it.

**Fix direction.** Have seedSuperAdmin return its outcome (created, existing, skipped with reason), log the summary from that outcome, and expose "super admin present" on the auth-service readiness endpoint so a deployment (and the F0 stack) can assert it; keep boot non-fatal.

### SENSOR-LOW-342

**sensor-service imports a web runtime enum: scada-runtime/scada-types.ts re-exports ScadaSocketEvent from web/modules/sensor-module through a relative path out of the backend tree**

- Label: F0-D10 · Severity: LOW · Domain: SENSOR · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architecture Map: apps/ (backend) and web/ (microfrontends) are separate trees; shared contracts belong in libs/

**Claim.** scada-types.ts line 24 re-exports every type from web/modules/sensor-module/src/types/scada-runtime.types.ts and line 26 re-exports the value ScadaSocketEvent, which is a runtime enum there (:100) and is used as a value by the gateway (scada-runtime.gateway.ts:42 imports it without type-only).

**Evidence at registration.**

```text
$ rg -n '^export' apps/sensor-service/src/scada-runtime/scada-types.ts
24:export type * from '../../../../web/modules/sensor-module/src/types/scada-runtime.types';
26:export { ScadaSocketEvent } from '../../../../web/modules/sensor-module/src/types/scada-runtime.types';
(exit 0)

$ rg -n "export enum ScadaSocketEvent" web/modules/sensor-module/src/types/scada-runtime.types.ts
100:export enum ScadaSocketEvent {
(exit 0)

$ rg -n -m 3 -e "import \{ ScadaSocketEvent \}" -e 'ScadaSocketEvent\.' apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts
42:import { ScadaSocketEvent } from './scada-types';
206:        this.emitError(client, ScadaSocketEvent.AUTH, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Authentication required');
214:        this.emitError(client, ScadaSocketEvent.AUTH, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Invalid or expired token');
(exit 0)
```

**Strongest counter-argument.** The file is a deliberate single choke point with a documented TODO for a path alias, and type-only imports are erased at compile time.

**What defeats it.** Line 24 is type-only but line 26 is a value export of an enum, so the backend output contains a runtime dependency on a web source file; the choke point limits the number of places, not the direction of the dependency.

**Fix direction.** Move scada-runtime.types.ts, including the ScadaSocketEvent enum, into a lib (libs/sensor-contracts) imported by sensor-service and web/modules/sensor-module through a path alias, and delete scada-types.ts.

### INFRA-MEDIUM-243

**MinIO is pinned as three distinct image references (two releases) across four compose files and has no entry in ci-images.json, so the CI lane pulls quay.io/minio/minio anonymously outside the INFRA-HIGH-227 mirror policy**

- Label: F0-D11 · Severity: MEDIUM · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one definition per pin) and INFRA-HIGH-227 (CI pulls no third-party image anonymously; mirrors listed in .github/manifests/ci-images.json)

**Claim.** The droplet pins quay.io/minio/minio:RELEASE.2025-04-03T14-56-28Z, dev pins minio/minio at the same release from Docker Hub, and docker-compose.yml and docker-compose.infra.yml pin RELEASE.2025-01-20T15-46-22Z. ci-images.json has no minio entry (exit 1), so a CI lane that starts the droplet MinIO pulls quay.io anonymously. That is three distinct image references and two releases. The F0 e2e lane pulls quay.io/minio anonymously and keeps the droplet pin (the same precedent as the nats lane); mirroring the image into GHCR is the fix this finding tracks.

**Evidence at registration.**

```text
$ rg -n 'image:.*minio' docker-compose*.yml
docker-compose.dev.yml:84:    image: minio/minio:RELEASE.2025-04-03T14-56-28Z
docker-compose.droplet.yml:687:    image: quay.io/minio/minio:RELEASE.2025-04-03T14-56-28Z
docker-compose.yml:87:    image: minio/minio:RELEASE.2025-01-20T15-46-22Z
docker-compose.infra.yml:95:    image: minio/minio:RELEASE.2025-01-20T15-46-22Z
(exit 0)

$ rg -n -i minio .github/manifests/ci-images.json
(no output)
(exit 1)

$ rg -n 'upstream" != ' .github/workflows/ci-image-mirror.yml
86:              || [ "$upstream" != "docker.io/library/${name}:${tag}" ]; then
(exit 0)
```

**Strongest counter-argument.** The droplet pin is a deliberate production decision (pinned 2026-04-05, droplet compose :686) and dev may lag it.

**What defeats it.** Dev already moved to the droplet release (from another registry) while docker-compose.yml and docker-compose.infra.yml stayed on 2025-01-20, so the drift is unreconciled copies, not intentional lag; and the mirror allow-list (ci-image-mirror.yml:86) accepts only docker.io/library upstreams, so adding MinIO also needs that rule changed.

**Fix direction.** Keep the droplet pin as the one pin; add MinIO to ci-images.json mirrored into GHCR (extend the allow-list at ci-image-mirror.yml:86 to the quay.io upstream), make every compose file and the CI lane consume that pin, and extend ci-image-registry.spec.ts to cover compose image references.

### INFRA-HIGH-244

**S3 unavailability aborts service boot: MinioClientService.onModuleInit awaits ensureBucketExists, which logs and rethrows, and gateway-api, farm-service and admin-api-service all load StorageModule**

- Label: F0-D12 · Severity: HIGH · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (root cause): a dependency outage must degrade the dependent feature, not abort the process (precedent apps/auth-service/src/database/seed.service.ts:119)

**Claim.** onModuleInit (:111-113) awaits ensureBucketExists, whose catch logs and rethrows (:126-128), for every transient error as well as for misconfiguration. Three services register StorageModule (rg below). A throwaway probe confirms the framework half: a provider whose onModuleInit rejects makes NestFactory.createApplicationContext reject. During any restart while the object store is unreachable, those three services do not start. The rethrow is the throw at :128. In the sandbox this blocks the F0 stack because no MinIO image is obtainable (decision record, not repository evidence).

**Evidence at registration.**

```text
$ awk 'NR>=111 && NR<=129 {print NR": "$0}' libs/storage/src/minio-client.service.ts
111:   async onModuleInit(): Promise<void> {
112:     await this.ensureBucketExists();
113:   }
114:
115:   /**
116:    * Ensure the default bucket exists, create if not
117:    */
118:   async ensureBucketExists(): Promise<void> {
119:     try {
120:       if (await this.bucketExists()) {
121:         this.logger.log(`Bucket exists: ${this.bucket}`);
122:         return;
123:       }
124:       await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
125:       this.logger.log(`Created bucket: ${this.bucket}`);
126:     } catch (error) {
127:       this.logger.error(`Failed to ensure bucket exists: ${describeError(error)}`);
128:       throw error;
129:     }
(exit 0)

$ rg -n 'StorageModule.forRootAsync' apps --glob '*.module.ts'
apps/admin-api-service/src/app.module.ts:248:    StorageModule.forRootAsync({
apps/gateway-api/src/app.module.ts:414:    StorageModule.forRootAsync({
apps/farm-service/src/app.module.ts:394:    StorageModule.forRootAsync({
(exit 0)

$ NODE_PATH=$PWD/node_modules node nest-oninit-probe.js   # probe source below, not committed; exit 1 is the rejected boot
boot: rejected with S3 unreachable (probe)
(exit 1)
```

```js
require('reflect-metadata');
const { Injectable, Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
class Probe {
  async onModuleInit() {
    throw new Error('S3 unreachable (probe)');
  }
}
Injectable()(Probe);
class AppModule {}
Module({ providers: [Probe] })(AppModule);
NestFactory.createApplicationContext(AppModule, { logger: false })
  .then(() => {
    console.log('boot: resolved');
  })
  .catch((e) => {
    console.log('boot: rejected with ' + e.message);
    process.exitCode = 1;
  });
```

**Strongest counter-argument.** S3 is a hard dependency for file features and the bucket must exist; failing fast at boot is intended, as the production credential check already throws.

**What defeats it.** Failing fast on missing credentials (a configuration error that never heals) is different from failing on unreachability (a condition that heals by itself): the same rethrow covers both, and gateway-api is the platform entry point, so an object-store outage during a restart keeps the whole API down although only uploads need S3.

**Fix direction.** Make bucket provisioning degrade instead of throw: onModuleInit attempts the bucket check, logs on failure and registers the storage state as a readiness indicator (health shows storage down) with a retry; keep the fail-fast for missing credentials.

### INFRA-LOW-245

**Two writers produce web/shell/src/generated/remoteHashes.json with different algorithms (scripts/generate-sri-hashes.sh sha384 for every remote, ci-affected.yml a sha256 heredoc for farm-module) and ci-full.yml keeps its own hard-coded list of the seven remotes**

- Label: F0-D13 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one writer per generated artifact)

**Claim.** scripts/generate-sri-hashes.sh writes remoteHashes.json (:47) with sha384 (:69); ci-affected.yml writes the same path with a sha256 heredoc for the farm remote only (:680-685); ci-full.yml (:354-397) does not write: it calls the script (:397) and asserts the output against its own hard-coded list of seven remotes with a sha384 pattern (:405-411, :417), which is a second roster. The shell documents the format as sha384 (remoteIntegrity.ts:57) and imports the file (remoteIntegrity.ts:61).

**Evidence at registration.**

```text
$ rg -n -e 'OUTPUT_FILE=' -e 'openssl dgst' scripts/generate-sri-hashes.sh
47:OUTPUT_FILE="${OUTPUT_DIR}/remoteHashes.json"
69:  hash=$(openssl dgst -sha384 -binary "$file" | openssl base64 -A)
(exit 0)

$ rg -n -e 'openssl dgst' -e 'remoteHashes.json' -e 'farm-module/remoteEntry.js": "sha256' .github/workflows/ci-affected.yml
680:          FARM_REMOTE_HASH="$(openssl dgst -sha256 -binary "$FARM_REMOTE_ENTRY" | openssl base64 -A)"
681:          cat > web/shell/src/generated/remoteHashes.json <<JSON
683:            "/remotes/farm-module/remoteEntry.js": "sha256-${FARM_REMOTE_HASH}"
(exit 0)

$ rg -n -e '^  generate-sri-hashes:' -e 'generate-sri-hashes.sh' -e 'sha384' -e 'remoteEntry.js' .github/workflows/ci-full.yml
354:  generate-sri-hashes:
397:        run: bash scripts/generate-sri-hashes.sh --base-dir "$PWD"
405:            '/remotes/admin-panel/remoteEntry.js',
406:            '/remotes/dashboard/remoteEntry.js',
407:            '/remotes/farm-module/remoteEntry.js',
408:            '/remotes/hr-module/remoteEntry.js',
409:            '/remotes/hydroponics-module/remoteEntry.js',
410:            '/remotes/sensor-module/remoteEntry.js',
411:            '/remotes/tenant-admin/remoteEntry.js',
417:          const invalid = expected.filter((key) => !/^sha384-[A-Za-z0-9+/=]+$/.test(map[key] ?? ''));
(exit 0)

$ rg -n -e 'remoteHashes.json' -e 'sha384' web/shell/src/utils/remoteIntegrity.ts
53:// web/shell/src/generated/remoteHashes.json after each frontend build.
57:// Format: { '/remotes/<module>/remoteEntry.js': 'sha384-<base64>' }
61:  '../generated/remoteHashes.json',
(exit 0)

$ rg -n remoteHashes .gitignore
107:web/shell/src/generated/remoteHashes.json
(exit 0)
```

**Strongest counter-argument.** The ci-affected hash is a throwaway for one browser smoke build of the shell, not a release artifact.

**What defeats it.** It writes the very path the production script writes and the shell build reads, with a different algorithm than the documented sha384 format; the file is gitignored (.gitignore:107), so a difference between the two outputs never appears in a diff.

**Fix direction.** Make ci-affected.yml call scripts/generate-sri-hashes.sh (with a remotes argument for the one remote it built) and move the expected-remote roster that ci-full asserts into the script, so there is one writer and one roster.

### INFRA-LOW-246

**Node is pinned three different ways across 7 Dockerfiles (22.12.0-alpine3.20, 22.13.1-bookworm-slim, 22.13.1-alpine3.20) while tools/toolchain/versions.json says 22 and .nvmrc says 20.11.0**

- Label: F0-D14 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: tools/toolchain/versions.json is the toolchain SSoT (node 22); CLAUDE.md Architectural Approach (one definition per pin)

**Claim.** Nine FROM node lines in seven Dockerfiles carry three different tags; .nvmrc says 20.11.0 and package.json engines allow >=20.11.0, a different major from every image and from the toolchain manifest (node 22). The stale .nvmrc is recorded in this finding because its fix is the same single Node pin. The F0 image-closure work deletes Dockerfile.prebuilt, which leaves six files.

**Evidence at registration.**

```text
$ rg -n '^FROM node' infrastructure/docker --glob 'Dockerfile.*'
infrastructure/docker/Dockerfile.frontend:10:FROM node:22.12.0-alpine3.20@sha256:40be63691f20f56b21e8e0e8e4d80f27b5a5ad45b82816e0a39d3e0e9aaab7fb AS base
infrastructure/docker/Dockerfile.aquamobil:12:FROM node:22.13.1-alpine3.20 AS builder
infrastructure/docker/Dockerfile.db-migrate:25:FROM node:22.13.1-bookworm-slim AS base
infrastructure/docker/Dockerfile.backend:17:FROM node:22.12.0-alpine3.20@sha256:40be63691f20f56b21e8e0e8e4d80f27b5a5ad45b82816e0a39d3e0e9aaab7fb AS base
infrastructure/docker/Dockerfile.backend:75:FROM node:22.12.0-alpine3.20@sha256:40be63691f20f56b21e8e0e8e4d80f27b5a5ad45b82816e0a39d3e0e9aaab7fb AS production
infrastructure/docker/Dockerfile.prebuilt:13:FROM node:22.12.0-alpine3.20 AS deps
infrastructure/docker/Dockerfile.prebuilt:22:FROM node:22.12.0-alpine3.20 AS production
infrastructure/docker/Dockerfile.backend.simple:20:FROM node:22.13.1-bookworm-slim AS base
infrastructure/docker/Dockerfile.backend.dev:9:FROM node:22.12.0-alpine3.20 AS development
(exit 0)

$ rg -n . .nvmrc
1:20.11.0
(exit 0)

$ rg -n '"node"' tools/toolchain/versions.json
2:  "node": "22",
(exit 0)

$ rg -n -A2 '"engines"' package.json
349:  "engines": {
350-    "node": ">=20.11.0",
351-    "npm": ">=10.0.0"
(exit 0)
```

**Strongest counter-argument.** Alpine versus bookworm-slim is deliberate per image (glibc for native modules) and a 22.12 versus 22.13 patch difference is harmless.

**What defeats it.** Two backend Dockerfiles (Dockerfile.backend, 22.12.0-alpine3.20, and Dockerfile.backend.simple, 22.13.1-bookworm-slim) differ in both Node patch and base OS; a deliberate per-image choice would be recorded in tools/toolchain/versions.json, which holds only the major (22).

**Fix direction.** Pin one Node image reference in tools/toolchain/versions.json and have every Dockerfile take it through a build ARG; derive .nvmrc from the same value; add an invariant that fails on a FROM node line that does not use the ARG. Not part of the F0 e2e work: it changes no Node pin.

### INFRA-LOW-247

**14 files hand-declare raw-YAML `Compose*` interfaces (13 specs plus scripts/deploy/compose-profile-contract.ts), so the compose document shape has no single type**

- Label: F0-D15 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one definition per shape)

**Claim.** Fourteen files declare their own `Compose*` interface for the parsed compose YAML (first declaration per file listed below); compose-profile-contract.ts parses with js-yaml (:2, :60). They read raw YAML, which the rendered-config reader of the F0 compose work does not, so they cannot merge into its type.

**Evidence at registration.**

```text
$ rg -n -m1 '^(export )?(interface|type) Compose' tests e2e scripts tools --glob '*.spec.ts' --glob 'compose-profile-contract.ts'
scripts/deploy/compose-profile-contract.ts:9:interface ComposeFile {
e2e/tests/integration/nats-invariants.spec.ts:108:type ComposeVolume = string | { source?: string; target?: string; read_only?: boolean };
tests/invariants/admin-api-production-posture.spec.ts:28:interface ComposeService {
tests/invariants/public-service-edge-hardening.spec.ts:117:interface ComposePort {
tests/invariants/deploy-startup-budget-ssot.spec.ts:43:interface ComposeHealthcheck {
tests/invariants/production-cert-identity-store.spec.ts:38:interface ComposeService {
tests/invariants/farm-environment-deployment-contract.spec.ts:23:interface ComposeService {
tests/invariants/container-log-rotation.spec.ts:47:interface ComposeFile {
tests/invariants/auth-frontend-url-deployment-contract.spec.ts:41:interface ComposeService {
tests/invariants/postgres-runtime-contract.spec.ts:28:interface ComposeService {
tests/invariants/action-link-origin-deployment-contract.spec.ts:49:interface ComposeService {
tests/invariants/service-criticality-profile-contract.spec.ts:8:interface ComposeFile {
tests/invariants/admin-billing-runtime-contract.spec.ts:25:interface ComposeManifest {
tests/invariants/walg-pitr-contract.spec.ts:138:interface ComposeService {
(exit 0)

$ rg -l '^(export )?(interface|type) Compose' tests e2e scripts tools --glob '*.spec.ts' --glob 'compose-profile-contract.ts' | wc -l
14
(exit 0)

$ rg -l '^(export )?interface ComposeService\b' tests e2e scripts tools --glob '*.spec.ts' --glob 'compose-profile-contract.ts'
tests/invariants/admin-api-production-posture.spec.ts
e2e/tests/integration/nats-invariants.spec.ts
tests/invariants/public-service-edge-hardening.spec.ts
tests/invariants/deploy-startup-budget-ssot.spec.ts
tests/invariants/production-cert-identity-store.spec.ts
tests/invariants/farm-environment-deployment-contract.spec.ts
tests/invariants/auth-frontend-url-deployment-contract.spec.ts
tests/invariants/postgres-runtime-contract.spec.ts
tests/invariants/action-link-origin-deployment-contract.spec.ts
tests/invariants/walg-pitr-contract.spec.ts
(exit 0)

$ rg -n -e "from 'js-yaml'" -e 'yaml.load' scripts/deploy/compose-profile-contract.ts
2:import yaml from 'js-yaml';
60:    parsed = yaml.load(readFileSync(composeFile, 'utf8'));
(exit 0)
```

**Strongest counter-argument.** Each spec reads only the fields it asserts on; one shared type would be a superset nobody uses fully.

**What defeats it.** The service and document wrappers are redeclared in most of the files (ten of the fourteen declare ComposeService, second listing); a shared document type with optional fields costs nothing and removes fourteen places that must follow a compose schema change.

**Fix direction.** Add one raw-document parser with one exported ComposeDocument type next to the compose-cli reader (rendering resolves interpolation and extends, raw YAML does not, so the two types stay separate) and migrate the fourteen files.

### INFRA-LOW-248

**25 workflows carry their own actions/setup-node and npm ci preamble instead of the .github/actions/setup-node-env composite, which has no consumer**

- Label: F0-D16 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one definition per CI preamble); the composite .github/actions/setup-node-env/action.yml is the shared definition

**Claim.** rg finds actions/setup-node@ in 25 of the 56 files of .github/workflows and all 25 also spell npm ci; no workflow uses the setup-node-env composite (exit 1). ci-affected.yml:659-660 additionally spells the two e2e install lines (npm --prefix e2e ci and playwright install) that the new F0 e2e-scada workflow also needs, recorded here so they are not forgotten. The F0 CI-lane work repairs the composite and makes the new e2e-scada.yml its first consumer, so F0 adds no 26th copy.

**Evidence at registration.**

```text
$ rg --hidden -l 'actions/setup-node@' .github/workflows | wc -l
25
(exit 0)

$ ls .github/workflows | wc -l
56
(exit 0)

$ comm -12 <(rg --hidden -l 'actions/setup-node@' .github/workflows | sort) <(rg --hidden -l 'npm ci' .github/workflows | sort) | wc -l
25
(exit 0)

$ rg --hidden -l 'uses: .*setup-node-env' .github
(no output)
(exit 1)

$ rg -n "npm --prefix e2e" .github/workflows/ci-affected.yml
659:          npm --prefix e2e ci --ignore-scripts --no-audit
660:          npm --prefix e2e exec playwright install --with-deps chromium
1384:          npm --prefix e2e ci --package-lock-only --ignore-scripts --no-audit --no-fund
1400:          npm --prefix e2e audit --audit-level=moderate --omit=dev --json > npm-audit-e2e-production.json
1403:          npm --prefix e2e audit --audit-level=high --json > npm-audit-e2e-full.json
(exit 0)
```

**Strongest counter-argument.** The workflows differ in cache keys and registry settings, so a composite would become a parameter list.

**What defeats it.** The composite already exists with inputs and defaults, so the parameter list is written; the evidence for demand is 25 identical preambles and zero consumers.

**Fix direction.** After the composite is repaired, migrate the 25 workflows in one pass and add a detector that fails when a workflow outside the composite spells actions/setup-node; give the two e2e install lines to a second small composite used by ci-affected.yml and e2e-scada.yml.

### SENSOR-LOW-343

**The F0 e2e lane has no expected-status regression guard: once a golden-path step turns green nothing fails when it turns red again, because F0 reports every step honestly and rejects an expected-red ratchet**

- Label: F0-D17 · Severity: LOW · Domain: SENSOR · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: PLAN section 5 (end-to-end layer, e2e/ is set up in Faz 0): the golden path and every phase exit gate must stay green once reached

**Claim.** UNVERIFIED as code: the lane does not exist yet (the e2e-scada workflow is created by the F0 CI-lane work; ls exits 2 below) and no expected-status mechanism exists under e2e (rg exit 1). The F0 decision rejects a ratchet because a lane that is green while the golden path is red would hide SENSOR-HIGH-337 itself. The consequence this finding tracks is the other side: after the first step turns green nothing prevents it from silently turning red again.

**Evidence at registration.**

```text
$ rg -n "Faz 0'da kurulur" docs/plans/2026-10-19-scada-e2e-rebuild/PLAN.md
283:| Uçtan uca        | Altın yol ve her fazın çıkış kapısı: gerçek sensor-service, Mosquitto, release edge ajanı ve Modbus simülatörü | `e2e/` (Faz 0'da kurulur)
(exit 0)

$ rg -l -e 'expected-status' -e 'expected-red' -e 'expectedStatus' e2e
(no output)
(exit 1)

$ ls .github/workflows/e2e-scada.yml
ls: cannot access '.github/workflows/e2e-scada.yml': No such file or directory
(exit 2)
```

**Strongest counter-argument.** A ratchet makes the lane green while the golden path is red, which is exactly SENSOR-HIGH-337.

**What defeats it.** That argument holds for F0 and is accepted; it does not hold after the first green step, which is when the guard is needed. This finding keeps the guard on a dated owner instead of leaving it as an unowned design note.

**Fix direction.** When the first step turns green, commit an expected-status manifest (step id to red or green) that the report program reads: a step recorded green that reports red fails the lane, and the manifest may only change in the commit that turns a step green.

### INFRA-LOW-249

**scripts/deploy/check-service-health.ts and assert-service-signals.ts keep private copies of the docker compose argv, a sleep primitive, a bounded poll loop and a container-state reader because the production host runs them as esbuild bundles**

- Label: F0-D18 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one definition per behaviour); the F0 single-definition detector keys these two files to this finding

**Claim.** Both scripts define their own sleep (:76, :83), spell docker compose argv themselves (check-service-health :103,:162; assert-service-signals :109,:119,:149), poll in a private bounded loop (check-service-health :301, sleeping at :315; assert-service-signals :297, sleeping at :317) and read container state through private code (inspectContainerRuntime, check-service-health :119). The F0 shared compose, poll and container-health modules do not migrate them because the production host runs them as esbuild bundles (prepare-production-host-runtime-bundle.sh:293-300); the raw-YAML interface finding covers typings only, so these copies need their own finding.

**Evidence at registration.**

```text
$ rg -n -e '^function sleep' -e "'compose'" -e 'await sleep' -e 'function inspectContainerRuntime' -e 'for \(let round' -e 'for \(;;\)' -e 'round \+= 1' scripts/deploy/check-service-health.ts scripts/deploy/assert-service-signals.ts
scripts/deploy/check-service-health.ts:76:function sleep(ms: number): Promise<void> {
scripts/deploy/check-service-health.ts:103:  const out = execFileSync('docker', ['compose', '-f', composeFile, 'config', '--services'], {
scripts/deploy/check-service-health.ts:119:function inspectContainerRuntime(containers: string[]): Map<string, ContainerRuntime> {
scripts/deploy/check-service-health.ts:162:  const result = spawnSync('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json'], {
scripts/deploy/check-service-health.ts:301:  for (let round = 1; round <= maxRounds; round += 1) {
scripts/deploy/check-service-health.ts:315:      await sleep(POLL_INTERVAL * 1000);
scripts/deploy/assert-service-signals.ts:83:function sleep(ms: number): Promise<void> {
scripts/deploy/assert-service-signals.ts:109:  const out = execFileSync('docker', ['compose', '-f', composeFile, 'config', '--services'], {
scripts/deploy/assert-service-signals.ts:119:  const result = spawnSync('docker', ['compose', '-f', composeFile, 'ps', '-a', '-q', service], {
scripts/deploy/assert-service-signals.ts:149:  const args = ['compose', '-f', composeFile, 'logs', '--no-color', '--no-log-prefix'];
scripts/deploy/assert-service-signals.ts:297:  for (;;) {
scripts/deploy/assert-service-signals.ts:317:    await sleep(sleepMs);
scripts/deploy/assert-service-signals.ts:318:    round += 1;
(exit 0)

$ rg -n -e '--bundle' -e 'check-service-health.ts' -e 'assert-service-signals.ts' tools/scripts/ci/prepare-production-host-runtime-bundle.sh
293:  "${NODE_BIN}" "${ESBUILD_PATH}" scripts/deploy/check-service-health.ts \
294:    --bundle --platform=node --format=esm --target=node22 --packages=bundle \
297:  "${NODE_BIN}" "${ESBUILD_PATH}" scripts/deploy/assert-service-signals.ts \
298:    --bundle --platform=node --format=esm --target=node22 --packages=bundle \
(exit 0)
```

**Strongest counter-argument.** Bundled production-host scripts cannot import repository helpers; a private copy is the price of a self-contained bundle.

**What defeats it.** The bundler is invoked with --bundle --packages=bundle (:294, :298), which inlines imported modules, so imports are not forbidden; the exclusion is only that the change touches the production deploy path and needs its own characterisation under the bundle invariants (tests/invariants/production-host-runtime-bundle.spec.ts).

**Fix direction.** Once the shared poll primitive, compose reader and container-health reader exist (scripts/ci/lib), migrate both scripts onto them under the existing bundle invariants, delete the private sleep, argv and inspect code, and remove the keyed exceptions that cite this finding from the single-definition detector.

### INFRA-LOW-250

**87 files under tests/invariants spawn their own git ls-files scan; the only shared readers (trackedPackageManifests in helpers/workflows.ts, listFiles in helpers/farm-graphql-surface.ts) have one and two importers**

- Label: F0-D19 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one definition per behaviour)

**Claim.** The count is the number of files whose source contains the literal git ls-files argument under tests/invariants (first command, 87 at registration; two of them are the shared helpers). ci-image-registry, nginx-route-resolution and public-service-edge-hardening are among them; the F0 invariant-library work rewrites those three onto one new helper and registers the remaining copies here as ONE finding instead of adding an 88th. The existing generic reader listFiles(root, patterns) (helpers/farm-graphql-surface.ts:46) has two importers (third command); a new helper should extend or reuse it rather than sit beside it.

**Evidence at registration.**

```text
$ rg -l "'ls-files'" tests/invariants --glob '*.ts' | wc -l
87
(exit 0)

$ rg -n "'ls-files'" tests/invariants/ci-image-registry.spec.ts tests/invariants/nginx-route-resolution.spec.ts tests/invariants/public-service-edge-hardening.spec.ts tests/invariants/helpers
tests/invariants/ci-image-registry.spec.ts:147:    ['-C', REPO_ROOT, 'ls-files', '--', '.github/workflows/*.yml', '.github/workflows/*.yaml'],
tests/invariants/public-service-edge-hardening.spec.ts:64:  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...pathspecs], {
tests/invariants/nginx-route-resolution.spec.ts:66:    ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
tests/invariants/helpers/farm-graphql-surface.ts:47:  const out = execFileSync('git', ['ls-files', ...patterns.map((p) => `${root}/${p}`)], {
tests/invariants/helpers/workflows.ts:27:  const out = execFileSync('git', ['ls-files', '*package.json'], {
(exit 0)

$ rg -n -e 'import .*listFiles' -e 'import .*trackedPackageManifests' -e 'export function listFiles' tests/invariants --glob '*.ts'
tests/invariants/farm-graphql-fe-be-parity.spec.ts:36:import { REPO_ROOT, listFiles, extractBackendFieldSet } from './helpers/farm-graphql-surface';
tests/invariants/helpers/farm-graphql-surface.ts:46:export function listFiles(root: string, patterns: string[]): string[] {
tests/invariants/hr-graphql-fe-be-parity.spec.ts:27:import { REPO_ROOT, listFiles, extractBackendFieldSet } from './helpers/farm-graphql-surface';
(exit 0)
```

**Strongest counter-argument.** Each spec scans a different pattern set, so a helper would add indirection for no gain.

**What defeats it.** The call is the same in all of them and the patterns are arguments, which is exactly the shape listFiles(root, patterns) already has in helpers/farm-graphql-surface.ts:46; the variation is in the arguments, not in the code.

**Fix direction.** Migrate the remaining copies onto the one shared helper in batches and add a detector that counts private git ls-files calls in tests/invariants against a baseline that may only fall.

### INFRA-LOW-251

**infrastructure/scripts/setup-droplet.sh generates POSTGRES, REDIS, JWT and encryption secrets with its own openssl rand lines in a different alphabet and length from the generate_credential of scripts/deploy/droplet-up.sh**

- Label: F0-D20 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one definition per generator)

**Claim.** setup-droplet.sh spells four generators (:73-76: base64 filtered to alphanumerics at 24 and 48 characters, and hex 16), while droplet-up.sh generate_credential (:198-209) uses base64 with / + = removed at 32 characters. The script is documented as curl-piped by operators (:6), which is why the F0 secrets work leaves it in place.

**Evidence at registration.**

```text
$ rg -n 'openssl rand' infrastructure/scripts/setup-droplet.sh scripts/deploy/droplet-up.sh
infrastructure/scripts/setup-droplet.sh:73:    POSTGRES_PW=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
infrastructure/scripts/setup-droplet.sh:74:    REDIS_PW=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
infrastructure/scripts/setup-droplet.sh:75:    JWT_SEC=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 48)
infrastructure/scripts/setup-droplet.sh:76:    ENC_KEY=$(openssl rand -hex 16)
scripts/deploy/droplet-up.sh:206:    VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
scripts/deploy/droplet-up.sh:1220:      local VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
scripts/deploy/droplet-up.sh:1412:      local VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
(exit 0)

$ rg -n -e 'curl -fsSL' -e 'git clone' infrastructure/scripts/setup-droplet.sh
6:#   curl -fsSL https://raw.githubusercontent.com/Okan-wqm/aquaculture_platform/main/infrastructure/scripts/setup-droplet.sh | bash
31:    curl -fsSL https://get.docker.com | sh
61:    git clone "$REPO_URL" "$APP_DIR"
(exit 0)
```

**Strongest counter-argument.** The script runs on a bare host through curl, so it cannot source repository libraries.

**What defeats it.** The script clones the repository (:61) and enters it (:62) before it generates the secrets (:73-76), so the repository generator is on disk when the copy runs; the curl pipe only delivers the script itself. The differing alphabet and length are the cost of the copy.

**Fix direction.** Have setup-droplet.sh clone or fetch scripts/deploy/lib/required-env-secrets.sh at the pinned ref and call its generate_credential; until then the F0 generator detector carries it as a keyed exception that cites this finding.

## Not registered here

**F0-D06 (sensor_service has no EXECUTE grant on the tenant schema provisioner function).** Not registered: the single grant it points at is already tracked by the open finding PLAT-MEDIUM-920 ("Only farm_service is granted EXECUTE on list_active_tenant_schema_mappings, yet messaging and sensor call it"), whose evidence is the same file and line.

```text
$ rg -n 'GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings' apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql
630:GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO farm_service;
(exit 0)

$ jq -r 'select(.id=="PLAT-MEDIUM-920") | [.id,.state,.deadline,.evidence[0]] | @tsv' docs/reviews/_registry/findings.jsonl
PLAT-MEDIUM-920	OPEN	2026-11-30	apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql:630 (single grant)
(exit 0)

$ rg -n 'list_active_tenant_schema_mappings' libs/backend-common/src/database/tenant-schema.utils.ts
115:    'platform.list_active_tenant_schema_mappings()',
139:  | 'platform.list_active_tenant_schema_mappings()'
(exit 0)
```

If the F0 lane proves the severity is HIGH, re-rate PLAT-MEDIUM-920 through the registry override path (rows carry override_of) instead of appending a second row.

## Tracked by a PLAN phase (cited, not duplicated)

The F0 decision record assigns three items to PLAN Faz 1: the operator signer and the ten hazard specs H1 to H10 (item 5), and the typed bundle-ack extraction, edge_seq stamping and the command-response schema (item 6). PLAN.md names none of H1, H10 or edge_seq (rg exit 1 below), so the tracking rows are the registry findings the two PLAN items close; the phase that runs those items extends them. No row is registered for them here.

```text
$ rg -n -e '^5\. \*\*İmzalı komut' -e '^6\. \*\*Ack ve durum' docs/plans/2026-10-19-scada-e2e-rebuild/PLAN.md
113:5. **İmzalı komut ve anahtar dağıtımı (K9).** İmzalayıcı bağlanır. İmza anahtarı gizli bilgi hattına, runbook'a ve compose dosyasına eklenir ve bir varlık kontrolüyle korunur. Provisioning doğrula
114:6. **Ack ve durum doğruluğu (K8).**
(exit 0)

$ rg -n -e 'edge_seq' -e 'H1\.\.H10' -e '\bH10\b' docs/plans/2026-10-19-scada-e2e-rebuild/PLAN.md
(no output)
(exit 1)

$ ls docs/adr/048*
ls: cannot access 'docs/adr/048*': No such file or directory
(exit 2)

$ jq -r 'select(.id|test("^(SENSOR-CRITICAL-276|INFRA-CRITICAL-238|SENSOR-CRITICAL-277|SENSOR-CRITICAL-271|SENSOR-HIGH-278|EDGE-HIGH-077|SENSOR-MEDIUM-283|SENSOR-MEDIUM-284)$")) | [.id,.state,.deadline] | @tsv' docs/reviews/_registry/findings.jsonl
SENSOR-CRITICAL-271	OPEN	2026-11-30
SENSOR-CRITICAL-276	OPEN	2026-11-30
INFRA-CRITICAL-238	OPEN	2026-11-30
SENSOR-CRITICAL-277	OPEN	2026-11-30
SENSOR-HIGH-278	OPEN	2026-11-30
EDGE-HIGH-077	OPEN	2026-11-30
SENSOR-MEDIUM-283	OPEN	2026-11-30
SENSOR-MEDIUM-284	OPEN	2026-11-30
(exit 0)
```

- PLAN Faz 1 item 5 (PLAN.md:113): SENSOR-CRITICAL-276, INFRA-CRITICAL-238, SENSOR-CRITICAL-277.
- PLAN Faz 1 item 6 (PLAN.md:114): SENSOR-CRITICAL-271, SENSOR-HIGH-278, EDGE-HIGH-077, SENSOR-MEDIUM-283, SENSOR-MEDIUM-284.
- ADR-048 (the H1 to H10 decision) is held outside the repository while the arbiter conditions are pending; no docs/adr/048 file exists (ls exit 2 below).

## Citing these rows

Later F0 work orders read the label to id table above. Code comments, single-definition detector exceptions and commit bodies cite the registry id. The F0 exit-gate commit alone carries the Closes trailer for SENSOR-HIGH-337; no commit of F0 closes a row of this file.

### INFRA-LOW-252

**tools/factory-reset/lib/verify-tenant-clone.ts and scripts/ci/prewarm-postgres-testcontainer.ts keep synchronous execFileSync('sleep') loops beside the shared async poll-until primitive of the F0 e2e lane**

- Label: F0-D21 · Severity: LOW · Domain: INFRA · Deadline: 2026-11-30 · Owner: Okan-wqm
- Rule: CLAUDE.md Architectural Approach (one definition per behaviour); the poll-until header names these two files as the surviving exceptions

**Claim.** waitForTenantSchema polls psql once a second and sleeps through execFileSync('sleep', ['1']); the Postgres testcontainer prewarm backs off through execFileSync('sleep', [String(delaySeconds)]) with 10 seconds per attempt. Both callers are synchronous helpers, and poll-until.ts is asynchronous, so neither can adopt it without becoming async or without a synchronous form inside poll-until.ts. Found by the WO-01 verifier; it was not registered by the first pass of this review, so the single-definition detector keys these two files to this row.

**Evidence at registration.**

```text
$ rg -n "sleep" tools/factory-reset/lib/verify-tenant-clone.ts scripts/ci/prewarm-postgres-testcontainer.ts
tools/factory-reset/lib/verify-tenant-clone.ts:177:    // sleep — node's setTimeout is awkward in a sync helper.
tools/factory-reset/lib/verify-tenant-clone.ts:178:    execFileSync('sleep', ['1'], { stdio: 'ignore' });
scripts/ci/prewarm-postgres-testcontainer.ts:145:      execFileSync('sleep', [String(delaySeconds)]);
```

**Fix direction.** One primitive in two forms inside scripts/ci/lib/poll-until.ts (asynchronous and synchronous), both loops migrate to it, and the detector exception for these two files is removed in the same change.
