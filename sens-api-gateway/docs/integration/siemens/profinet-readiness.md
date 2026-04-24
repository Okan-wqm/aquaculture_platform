# PROFINET Readiness

**Scope:** Declaration of PROFINET IO device status and IRT (Isochronous Real-Time) capability.

---

## Core declaration

**`sens-api-gateway` is NOT a PROFINET IO device.**

**PROFINET Conformance Class: NONE.**

**Status: NOT-PLANNED.**

There is no GSDML file, no PROFINET IO-Device stack, no MAC-layer real-time scheduler, no vendor ID registered with PI (PROFIBUS & PROFINET International), and no certification under IEC 61158 / IEC 61784-2. The gateway will not appear in a TIA Portal hardware catalogue as a PROFINET device.

---

## Siemens version compatibility matrix

| PROFINET consumer | Can the gateway be wired as a PROFINET IO device? | Status |
|---|---|---|
| TIA Portal (any version) | NO | NOT-PLANNED |
| SIMATIC IO-Controller (S7-1500, ET 200SP) | NO | NOT-PLANNED |
| SIMATIC SCALANCE / infrastructure | Ethernet-level reachability YES; PROFINET IO device role NO | PARTIAL (Ethernet only) |
| PI Certification Tool | NO | NOT-PLANNED |

---

## Conformance-class gap analysis

PROFINET defines four Conformance Classes. The gateway does not claim any of them; this table lists what would have to be true for a claim to stand.

| CC | Technical requirement | Gateway today | To achieve |
|---|---|---|---|
| CC-A | Basic PROFINET RT communication (cyclic data exchange over IEEE 802.3 MAC frames) | ABSENT — no RT stack | 6-9 months stack work + vendor-ID registration with PI |
| CC-B | CC-A + network diagnostics (LLDP-based topology discovery, SNMP MIB-2) | ABSENT | 2-3 months on top of CC-A |
| CC-B/PA | CC-B plus Process Automation additions (System Redundancy, Configuration-in-Run) | ABSENT | 3-4 months on top of CC-B |
| CC-C | CC-B + IRT (Isochronous Real-Time) with deterministic bandwidth reservation | ABSENT — Rust tokio scheduler is not hard-real-time | 6+ months; requires RT kernel patch or dedicated FPGA/ASIC for MAC scheduling |

**Aggregate effort to add PROFINET IO-Device role with CC-B:** estimated 12 months of dedicated engineering effort PLUS PI vendor-ID registration PLUS conformance certification at an accredited PROFINET test lab (Siemens, PI, PNO). IRT (CC-C) is an additional 6+ months and is gated on real-time kernel adoption — not currently in the Rust agent's technology plan.

---

## Why the gateway is not a PROFINET IO device

1. **No real-time MAC scheduler.** PROFINET RT frames require deterministic sub-millisecond transmission windows. The Rust tokio runtime is a general-purpose async I/O scheduler — it does not offer the guaranteed latency PROFINET RT expects, and PROFINET IRT's sub-microsecond determinism is not achievable for a user-space Rust process on a general Linux kernel (requires RT-patched kernel or dedicated FPGA/ASIC — see `profinet-readiness.md#conformance-class-gap-analysis`).
2. **No PROFINET IO-Device protocol stack.** Neither an in-house implementation nor a commercial stack (Renesas R-IN, Siemens SPI3 stack, Huawei Solid-Run, Molex CIP) is linked into the agent.
3. **No GSDML shipped.** GSDML (General Station Description Markup Language) is the mandatory XML descriptor a PROFINET IO-Device hands to a TIA Portal project. The repo ships no `GSDML-V2.4-*.xml` file.
4. **No vendor ID.** The gateway does not own a PI-registered Vendor ID (fees + compliance process through PROFIBUS & PROFINET International).
5. **No PI certification.** PROFINET IO-Device certification requires testing at an accredited PI test lab and issuing a PI certificate. The product holds no PI certificate.

These five points constitute the evidence chain a Siemens reviewer can cite when filing the product as "MQTT-only / OPC UA-only edge gateway, not a PROFINET IO device".

---

## Alternative positioning

The gateway integrates into a PROFINET plant, just not AS a PROFINET IO device. Two valid topologies:

### Topology A — gateway parallel to the PROFINET fieldbus

```
┌──────────────────┐      PROFINET RT      ┌──────────────┐
│ S7-1500 IO-Ctrl  │ <───────────────────> │ ET 200SP IO  │
│ (TIA Portal)     │                       │ (distributed │
└──────┬───────────┘                       │  I/O island) │
       │                                   └──────────────┘
       │ OPC UA or S7comm
       ▼
┌──────────────────┐
│ sens-api-gateway │
└──────────────────┘
```

The S7-1500 IO-Controller owns the PROFINET network; the gateway is a second-tier consumer that reads from the PLC's OPC UA server or via S7comm PUT/GET. See `tia-portal.md` and `s7-area-mapping.md`.

### Topology B — gateway on a separate Ethernet segment

Gateway lives on the supervisory LAN, not the fieldbus. It does not see PROFINET traffic directly; all data enters via OPC UA / MQTT. This is the topology most customers deploy today and has no PROFINET implications.

---

## If a customer RFP demands a PROFINET IO-Device role

1. **Scope the requested Conformance Class.** CC-A is the minimum; CC-B usually the real expectation; CC-C only for motion-control integration (which is not the aquaculture / hydroponics use-case).
2. **Escalate to architectural-arbiter.** The decision to add a PROFINET IO-Device stack is an ADR-level change — it adds a commercial stack dependency (fee), certification cost, real-time kernel requirement, and a 12+ month engineering runway.
3. **Commission vendor-ID registration with PI.** This is a 3-6 month administrative process that runs in parallel with stack work.
4. **Pick a stack vendor.** Renesas R-IN32M4 / R-IN32M3 Module is the most common Siemens-friendly silicon path; Siemens SPI3 is the pure-software path.
5. **Update this chapter** — remove the NOT-PLANNED label and add a GSDML shipment plan.

---

## Cross-reference

- IEC 61158 / IEC 61784-2 compliance discussion: `sens-api-gateway/docs/compliance/`
- TIA Portal integration paths available without PROFINET: `tia-portal.md`
- Siemens RFP response template for the PROFINET section: `sens-api-gateway/docs/siemens-rfp/`
