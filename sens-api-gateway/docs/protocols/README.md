# Protocol Reference Index — `sens-api-gateway`

**Source of truth:** `sens-api-gateway` v1.6.0 @ HEAD `3413db47`, snapshot 2026-04-24.

**Scope:** This directory is the normative wire-contract reference for every industrial protocol implemented by the Suderra edge agent. Each chapter is written in RFC 2119 (MUST / SHOULD / MAY) style and is intended as the document a third-party integrator or a Siemens / PROFIBUS User Organization test lab would use to certify interoperability.

This index is a re-expression of the customer-facing reality of the code in `sens-api-gateway/src/`. The Turkish form-builder-oriented documents under `sensorprotocols/` remain the product-owner's source of truth; this tree adds the binding wire-format chapter that a Siemens integrator expects.

## Compliance terminology

The keywords **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this document and each child chapter are to be interpreted as described in RFC 2119 and RFC 8174.

## Status vocabulary

| Status | Meaning |
|--------|---------|
| `PRESENT` | Implemented, wired into `main.rs`, covered by tests or HIL bench. |
| `PARTIAL` | Compiled path exists; feature subset is live. Gaps are listed explicitly. |
| `CODE-COMPILED-NOT-WIRED` | Module compiles; actor/driver is NOT instantiated by `main.rs`. Tracked via orphan-finding. |
| `ROADMAP-QX` | Not implemented. Planned for quarter QX, with a tracking finding ID. |
| `NOT-PURSUED` | No plan to implement. Chapter explains why. |

## Protocol matrix

| Chapter | Standard | Our version | Crate / feature flag | Status | Primary evidence |
|---------|----------|-------------|----------------------|--------|------------------|
| [modbus-tcp.md](./modbus-tcp.md) | IEC 61158 / MBAP — Modbus Application Protocol v1.1b3 (2012) | Client-only; FC 1/2/3/4/5/6 | `rodbus = "=1.4.0"` / default | PARTIAL | `src/modbus.rs:55-68`, `Cargo.toml:70` |
| [modbus-rtu.md](./modbus-rtu.md) | Modbus over Serial Line V1.02 (2006), 11-bit UART | Client-only; identical FC set to TCP | `rodbus = "=1.4.0"` + `tokio-serial = "5.4"` / default, `target_os="linux"` | PARTIAL | `src/modbus.rs:713-758`, `Cargo.toml:70-72` |
| [mqtt.md](./mqtt.md) | OASIS MQTT v3.1.1 (2014) | Client-only (v3.1.1); username+password + TLS 1.2+ | `rumqttc = "0.25"` / default | PRESENT | `src/mqtt.rs:193-269`, `Cargo.toml:33` |
| [opc-ua.md](./opc-ua.md) | IEC 62541-6 OPC UA v1.04 (2017) — TCP binary transport | Hand-rolled TCP binary client; `SecurityPolicy#None` is the wired default endpoint path | *(hand-rolled; `opcua = "0.12"` pulled only for the OPC UA **server** feature `opc-ua-server`, not for this client)* | PARTIAL | `src/plc_programming/opcua.rs:43-69`, `Cargo.toml:266` |
| [s7comm.md](./s7comm.md) | Siemens S7 Communication over ISO-on-TCP (RFC 1006) | Hand-rolled S7comm client; COTP + S7 Job/Ack | *(hand-rolled, no external crate)* | PARTIAL | `src/plc_programming/s7comm.rs:36-103` |
| [ethernet-ip.md](./ethernet-ip.md) | ODVA CIP Vol. 1 + EtherNet/IP Vol. 2 | Hand-rolled EtherNet/IP encapsulation + CIP tag services | *(hand-rolled, no external crate)* | PARTIAL | `src/plc_programming/ethernet_ip.rs:36-80` |
| [ads.md](./ads.md) | Beckhoff AMS/ADS Protocol Specification | Hand-rolled ADS/AMS over TCP; symbol R/W | *(hand-rolled, no external crate)* | PARTIAL | `src/plc_programming/ads.rs:42-125` |
| [codesys.md](./codesys.md) | CODESYS Gateway V3 binary wire (vendor proprietary) | Hand-rolled login / symbol / variable ops; magic `0xCD 0x55 0x00 0x00` | *(hand-rolled, no external crate)* | PARTIAL | `src/plc_programming/codesys.rs:38-53` |
| [lorawan.md](./lorawan.md) | LoRaWAN L2 1.0.x (LoRa Alliance, 2017) | OTAA + ABP, Class A; AES-128-CMAC MIC; AES-128-CTR payload; Cayenne LPP codec | `aes=0.8`, `cmac=0.7`, `lorawan=0.9`, `subtle=2` / feature `lorawan` | PRESENT (feature-gated) | `src/lora/mod.rs:1-53`, `src/lora/mac.rs`, `Cargo.toml:287-296,341` |
| [i2c.md](./i2c.md) | NXP UM10204 I²C-bus specification Rev. 7.0 (2021) | 7-bit address; standard-mode 100 kHz default; RPi `target_os="linux"` via rppal | `rppal = "0.17"` / feature `gpio` | PRESENT | `src/i2c.rs:1-60`, `Cargo.toml:315,326` |
| [spi.md](./spi.md) | Motorola SPI-B-A01 (de-facto) | Mode 0/1/2/3, MSB/LSB, configurable clock | `rppal = "0.17"` / feature `gpio` | CODE-COMPILED-NOT-WIRED | `src/spi.rs:22-23`, `Cargo.toml:315` |
| [pwm.md](./pwm.md) | RPi SoC PWM peripheral + BCM2835 PWM0/PWM1 | Hardware PWM + software PWM fallback; servo-mode helper | `rppal = "0.17"` / feature `gpio` | CODE-COMPILED-NOT-WIRED | `src/pwm.rs:20-21`, `Cargo.toml:315` |
| [gpio.md](./gpio.md) | BCM2835 / BCM2711 / BCM2712 GPIO peripheral | BCM numbering; pull-up / pull-down; rising/falling interrupt via rppal | `rppal = "0.17"` / feature `gpio` | PRESENT | `src/gpio.rs:1-20`, `Cargo.toml:315,326` |
| [atlas-ezo.md](./atlas-ezo.md) | Atlas Scientific EZO circuit datasheet family (pH/DO/EC/ORP/RTD) | I²C mode, `R` measurement command, ASCII float response | *(application layer — runs on `src/i2c.rs` transport)* | PRESENT | `src/atlas_ezo.rs:1-119` |

## Documented gaps (orphan-findings)

The chapters below call out the following open gaps. These are tracked, not hidden:

| Finding ID | Area | Nature |
|------------|------|--------|
| `ORPHAN-EDGE-003` | MQTT | Broker authentication is username + password only; per-device client-cert mTLS is ROADMAP. |
| `ORPHAN-EDGE-005` | OPC UA | Client is hand-rolled; `SecurityPolicy#None` is the live path. `Basic256Sha256` / `SignAndEncrypt` is ROADMAP. |
| `ORPHAN-EDGE-010` | Modbus | Function codes 15/16/17/22/23/43 are NOT implemented. Multi-write, diagnostics, and file records out-of-module by design. |
| `ORPHAN-EDGE-014` | SPI + PWM | Module compiles with `#![allow(dead_code)]`. Not wired into `main.rs`. Status is `CODE-COMPILED-NOT-WIRED`. |

## Conventions used by each chapter

Each chapter is structured as eleven numbered sections (Standard, Crate, Operations, Wire format, Error handling, Authentication + encryption, Configuration, Worked example, Test coverage, Interop status, Evidence) followed by a closing `## Interop test plan` with concrete input→expected-output vectors.

Cross-references use relative markdown links inside this tree. Evidence anchors use the form `src/<file>.rs:<line>` resolving against the repository root of the branch on which this snapshot was built.
