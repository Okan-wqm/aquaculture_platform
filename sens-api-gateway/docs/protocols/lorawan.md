# LoRaWAN — Wire Contract Reference

**Protocol role on this device:** LoRaWAN **network server** + packet-forwarder aggregation. `suderra-agent` runs an SX1302 concentrator HAL (`sens-api-gateway/vendor/sx1302_hal`) and terminates the MAC layer locally: OTAA / ABP join, uplink MIC verify, payload decrypt, codec decode, downlink scheduling.

RFC 2119 keywords apply.

## 1. Standard + version

- **LoRaWAN L2 1.0.x Specification** — LoRa Alliance TS001-1.0.4 (October 2020). The implementation targets the 1.0.x wire format (Classic A join + 32-bit frame counters).
- **Cayenne Low Power Payload** — myDevices / Semtech, Cayenne LPP reference format.
- Regional Parameters — **LoRa Alliance RP002-1.0.3** (sub-set; see § 3.4 supported regions).
- Physical layer: LoRa chirp spread-spectrum, SX1302 concentrator.

## 2. Crate + feature flag

- Feature flag: `lorawan` (`Cargo.toml:341`). OFF by default.
- Crates gated by the flag (`Cargo.toml:287-296`):
  - `aes = "0.8"` — AES-128 block cipher (ECB mode primitive).
  - `cmac = "0.7"` — AES-CMAC (RFC 4493) MIC computation.
  - `lorawan = "0.9"` — LoRa Alliance 1.0.x packet (de)serialisation helpers.
  - `subtle = "2"` — constant-time comparison for MIC (timing-side-channel defence).
  - `zeroize = "1"` — cryptographic key material zero-on-drop (promoted to required for non-LoRa builds too — see Cargo.toml comment).
- Native library: `vendor/sx1302_hal` built via `build.rs` + `cc` + `bindgen` (build-deps `Cargo.toml:400-403`).

## 3. Supported operations

### 3.1 Activation

| Activation | Status | Anchor |
|------------|--------|--------|
| OTAA (Over-The-Air Activation) | PRESENT | `src/lora/mac.rs:8`, `src/lora/mac.rs:337` (`handle_join_request`) |
| ABP (Activation By Personalisation) | PRESENT | Activation enum `src/lora/types.rs` |

### 3.2 Device classes

| Class | Status | Anchor |
|-------|--------|--------|
| Class A | PRESENT | `src/lora/mac.rs:94` — "downlink only in RX1/RX2 after uplink" |
| Class B (beacon + ping slot) | ROADMAP-Q4 | Not implemented |
| Class C (continuous RX2) | ROADMAP-Q4 | Enum value defined `src/lora/types.rs:240-245` but downlink path is Class-A only |

### 3.3 MAC commands

The implementation processes MIC + payload cryptography for data uplink; it does not act on most MAC-layer control commands beyond the join handshake. `LinkADRReq`, `LinkCheckAns`, `DutyCycleReq`, `RXParamSetupReq`, `DevStatusReq`, `NewChannelReq`, `RXTimingSetupReq` are NOT yet emitted.

### 3.4 Regional plans

Enum `LoRaRegion` (`src/lora/types.rs:253-268`): `EU868`, `US915`, `CN470`, `AU915`, `AS923`, `KR920`, `IN865`. Regional-parameter channel plan details (dwell time, TX duty-cycle caps, default DR ranges) are partially encoded — tenants deploying outside EU868 MUST HIL-verify channel plan + duty cycle before go-live.

### 3.5 Payload codecs

| Codec | Status | Anchor |
|-------|--------|--------|
| Cayenne LPP | PRESENT | `src/lora/types.rs:277-279`, `src/lora/codec.rs` |
| Raw binary (f32 LE or BE per 4 bytes) | PRESENT | `src/lora/types.rs:280-284` |
| Custom codec (named decoder) | PRESENT (resolution via scripting engine — see `scripting/` module) | `src/lora/types.rs:285-289` |

## 4. Wire format

### 4.1 OTAA Join procedure

```mermaid
sequenceDiagram
    participant D as End Device (DevEUI, AppEUI, AppKey)
    participant G as Gateway (SX1302)
    participant N as Network/App Server (this agent)
    D->>G: PHYPayload MHDR=0x00 JoinRequest { AppEUI(8), DevEUI(8), DevNonce(2), MIC(4) }
    G->>N: Packet-forwarder uplink with RSSI + SNR + freq + datarate
    N->>N: Look up DevEUI → LoRaDeviceConfig; if not registered → rate-limit + reject (unknown_device_tracker)
    N->>N: Verify MIC_req = aes128_cmac(AppKey, MHDR | AppEUI | DevEUI | DevNonce)[0..4]
    N->>N: Check DevNonce not seen (spec § 6.2.4 replay guard)
    N->>N: Generate AppNonce(3), NetID(3), DevAddr(4)
    N->>N: SessionKeys: NwkSKey = aes128_encrypt(AppKey, 0x01 | AppNonce | NetID | DevNonce | pad)
    N->>N:               AppSKey = aes128_encrypt(AppKey, 0x02 | AppNonce | NetID | DevNonce | pad)
    N->>G: Downlink PHYPayload MHDR=0x20 JoinAccept { AppNonce(3), NetID(3), DevAddr(4), DLSettings(1), RxDelay(1), [CFList(16) optional], MIC(4) } — encrypted with AppKey (LoRaWAN quirk: decrypt uses AES-ECB-encrypt)
    G->>D: RX1 or RX2 window — JoinAccept
    Note over D,N: DevAddr + session keys persisted in SessionStore (SQLite, encrypted via SQLCipher)
```

### 4.2 Data uplink PHYPayload layout

```
MHDR (1B)  | MACPayload (N bytes) | MIC (4B)
```

`MACPayload` for Data Up:

```
FHDR (7..22B) | FPort (1B, optional) | FRMPayload (N-7-1)
```

`FHDR`:

```
DevAddr (4B LE) | FCtrl (1B) | FCnt (2B LE) | FOpts (0-15 B, optional)
```

`FCtrl`:

| Bit | Field |
|-----|-------|
| 7 | ADR |
| 6 | ADRACKReq (uplink) / RFU (downlink) |
| 5 | ACK |
| 4 | FPending (downlink) / RFU (uplink) |
| 3:0 | FOptsLen |

### 4.3 MIC computation (B0 block)

Per LoRaWAN 1.0.x spec § 4.4 (`src/lora/crypto.rs:30-63`):

```
B0 = 0x49 | 0x00 0x00 0x00 0x00 | Dir (1B: 0=up,1=down) | DevAddr (4B) | FCnt (4B LE) | 0x00 | len(MAC message)
MIC = aes128_cmac(key, B0 || msg)[0..4]
```

Verification is constant-time (`subtle::ConstantTimeEq`, `src/lora/crypto.rs:22`).

### 4.4 FRMPayload encryption (AES-128-CTR)

Per spec § 4.3.3.1:

```
Ai = 0x01 | 0x00 0x00 0x00 0x00 | Dir | DevAddr | FCnt (4B LE) | 0x00 | i (1B, starting at 1)
S  = aes128_encrypt(key, A1) || aes128_encrypt(key, A2) || ...
FRMPayload' = FRMPayload XOR S[0..len(FRMPayload)]
```

`key` is `NwkSKey` when `FPort == 0` (MAC commands in FRMPayload), otherwise `AppSKey`.

### 4.5 Join-Accept encryption (LoRaWAN quirk)

The network server **decrypts** a Join-Accept with AES-ECB in its **encrypt** direction (spec § 6.2.5). `src/lora/crypto.rs` (via `encrypt_join_accept`) performs this intentional reversal.

## 5. Error handling

- MIC mismatch → packet dropped, `stats.mic_failures++`.
- Unknown DevEUI on Join-Request → rate-limited at 10 join-requests / 5 min per DevEUI; beyond that the device is tarpitted (`src/lora/mac.rs:401`, `src/lora/mac.rs:146-148`).
- Frame-counter regression → emit `MacEvent::FrameCounterReset` and WARN; this may indicate device reboot **or** a replay attack. The event is observable externally so operators can raise an alarm.
- DevNonce replay (same DevEUI sends the same DevNonce twice) → Join-Request rejected (spec § 6.2.4, `src/lora/mac.rs:435`).
- Join-Accept rate limit: `DEFAULT_JOIN_ACCEPT_BUDGET_PER_SEC = 10` (`src/lora/mac.rs:119`) — protects the SX1302 TX duty cycle during a join storm.
- Invalid Join-Request size (≠ 23 bytes): rejected (`src/lora/mac.rs:369`).

## 6. Authentication + encryption

- Device-to-server authentication is provided by **AppKey** (OTAA root) → derived **NwkSKey** (MIC) + **AppSKey** (payload). All keys are 128-bit AES.
- Integrity: AES-128-CMAC over B0 | message. Constant-time MIC comparison defeats byte-at-a-time timing side-channels (`src/lora/crypto.rs:66-79`).
- Confidentiality: AES-128-CTR on FRMPayload. No forward secrecy (session keys derived once per join; re-join rotates).
- Replay protection: 32-bit FCntUp / FCntDown monotonic counters + DevNonce replay check on join.
- Persistence: session keys + frame counters are stored in SQLite via SQLCipher (bundled-sqlcipher, `Cargo.toml:94`) with AES-256-CBC at rest, database key derived from `machine-id`.

LoRaWAN 1.0.x has a known architectural weakness: the MIC + payload keys are derived from AppKey + DevNonce + AppNonce only; an attacker with an archival packet capture who can induce a Join replay can recover session keys. The spec mitigates this via the DevNonce replay check (implemented) and RECOMMENDS migration to **1.0.4 / 1.1** which separates `NwkKey` and `AppKey`. 1.1 is a ROADMAP-Q4 item.

## 7. Configuration schema

```yaml
lorawan:
  enabled: true
  region: EU868                      # EU868 | US915 | CN470 | AU915 | AS923 | KR920 | IN865
  net_id: [0x00, 0x00, 0x00]         # 3-byte network identifier
  rx1_delay_secs: 1
  max_join_accepts_per_sec: 10
  devices:
    - dev_eui: 00-01-02-03-04-05-06-07
      app_eui: 00-00-00-00-00-00-00-00
      app_key: "<16-byte-hex-AppKey>"   # 32 hex chars; provisioned per device
      activation: otaa                # otaa | abp
      device_class: A                 # A | B | C
      tag_prefix: "lora_flow1_"
      codec:
        type: cayenne_lpp             # cayenne_lpp | raw_binary | custom
      adr_enabled: true
```

See `src/lora/types.rs:300-329` for `LoRaDeviceConfig`.

## 8. Worked example

Uplink telemetry from a Cayenne-LPP-configured sensor (temperature 22.4 °C on channel 1, humidity 55 % on channel 2):

```
MHDR=0x40                            unconfirmed data up
DevAddr=26 01 1A 3F                  assigned during join
FCtrl=0x80                           ADR on, no FOpts
FCnt=0x002A
FPort=0x01
FRMPayload (decrypted):
  01 67 00 E0                        ch1, type 0x67 (temperature), 0x00E0 = 224 / 10 = 22.4
  02 68 6E                           ch2, type 0x68 (humidity), 0x6E = 110 / 2 = 55 %
MIC=aes128_cmac(NwkSKey, B0|msg)[0..4]
```

Codec emits: `("lora_flow1_temperature", 22.4)`, `("lora_flow1_humidity", 55.0)`.

## 9. Test coverage

- `src/lora/crypto.rs` and `src/lora/mac.rs` are the primary targets of LoRaWAN unit tests (MIC vectors from spec Annex, Join-Request/Accept round-trip, session key derivation, DevNonce replay guard, frame-counter regression detection).
- Integration with the SX1302 HAL is validated on the bench against RAK5146 + Semtech SX1302 CoreCell reference designs.
- LoRa Alliance Certification pre-compliance testing is RECOMMENDED before listing a device profile as customer-facing.

## 10. Interop certification status

- **LoRa Alliance Certification (LoRaWAN-Certified CID):** not pursued at device level (we run network-server-side).
- **LoRaWAN 1.0.4 network-server equivalence:** self-assessed PARTIAL — see § 6 roadmap to 1.1.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| Feature `lorawan` gates AES + CMAC + lorawan crate | `Cargo.toml:287-296, 341` |
| SX1302 HAL via build-deps cc + bindgen + glob | `Cargo.toml:400-403` |
| MIC computation per spec § 4.4 | `src/lora/crypto.rs:30-63` |
| Constant-time MIC verification | `src/lora/crypto.rs:66-79` |
| OTAA handshake | `src/lora/mac.rs:337-` |
| DevNonce replay check | `src/lora/mac.rs:435` |
| Unknown-device rate limit 10 / 5 min | `src/lora/mac.rs:146-148, 401` |
| Join-Accept budget 10 / s | `src/lora/mac.rs:119, 179-181` |
| 32-bit frame counter handling | `MacEvent::FrameCounterReset`, `src/lora/mac.rs:73-79` |
| Regional enum | `src/lora/types.rs:253-268` |
| Device classes enum | `src/lora/types.rs:240-245` |
| Cayenne LPP / raw-binary / custom codec | `src/lora/types.rs:277-289` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| L1 | OTAA Join-Request with correct AppKey, 23-byte PHYPayload | Join-Accept emitted; DevAddr assigned; session persisted |
| L2 | Replay the same DevNonce within the same session | Second Join-Request rejected (spec § 6.2.4) |
| L3 | Uplink with invalid MIC | Dropped; `mic_failures++`; no MacEvent |
| L4 | Uplink FCnt lower than last known for the device | `FrameCounterReset` MacEvent emitted; WARN log; uplink processed (spec permits device reboot) |
| L5 | Unknown DevEUI sends 11 Join-Requests within 5 min | Tarpit kicks in; subsequent Join-Requests silently dropped |
| L6 | 11th Join-Request in the same second from distinct known devices | Join-Accept budget exhausts; 1 request/s beyond 10 is rejected; `join_storm_rejects++` |
| L7 | Cayenne LPP payload `01 67 00 E0` | Decoded `("...temperature", 22.4)` |
| L8 | Raw-binary payload `41 B3 33 33` BE f32 | Decoded `22.4` |
| L9 | Downlink queued for Class-A device | Transmitted in RX1 window after next uplink |
| L10 | Device reconfigured from `EU868` to `US915` | Channel-plan mismatch surfaces as Join failure until the device is re-provisioned |
