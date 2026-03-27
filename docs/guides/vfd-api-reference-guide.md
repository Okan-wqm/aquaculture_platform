# VFD Technical Reference Guide

**Platform:** Aquaculture SaaS
**Version:** 1.0
**Date:** 2026-03-27
**Audience:** System administrators, integrators, developers

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Supported VFD Brands and Models](#2-supported-vfd-brands-and-models)
3. [Communication Protocols](#3-communication-protocols)
4. [Parameter Categories Reference](#4-parameter-categories-reference)
5. [GraphQL API Reference](#5-graphql-api-reference)
6. [Change Set Workflow Reference](#6-change-set-workflow-reference)
7. [Automation Rules Reference](#7-automation-rules-reference)
8. [Risk Evaluation Rules](#8-risk-evaluation-rules)
9. [Edge Gateway Integration](#9-edge-gateway-integration)
10. [Glossary](#10-glossary)

---

## 1. System Architecture Overview

### 1.1 How the VFD System Works

The VFD management system follows a layered architecture. Data flows between the user's browser and the physical VFD devices through several components:

```
+------------------+     HTTPS/WSS      +------------------+     NATS/MQTT     +------------------+
|                  | <=================> |                  | <===============> |                  |
|  Web Browser     |                     |  Sensor Service  |                   |  Edge Gateway    |
|  (React SPA)     |     GraphQL API     |  (NestJS)        |   Message Queue   |  (Local Device)  |
|                  |                     |                  |                   |                  |
+------------------+                     +--------+---------+                   +--------+---------+
                                                  |                                      |
                                                  |  TypeORM + TimescaleDB               |  Modbus RTU/TCP
                                                  |                                      |  Profinet
                                                  v                                      |  EtherNet/IP
                                         +------------------+                            |  CANopen
                                         |                  |                            |  BACnet
                                         |  PostgreSQL      |                            v
                                         |  + TimescaleDB   |                   +------------------+
                                         |                  |                   |                  |
                                         +------------------+                   |  VFD Device      |
                                                                                |  (Physical)      |
                                                                                |                  |
                                                                                +------------------+
```

### 1.2 Component Overview

| Component | Technology | Responsibility |
|-----------|-----------|----------------|
| **Web Browser** | React SPA with Module Federation | User interface -- displays data, accepts commands |
| **API Gateway** | NestJS + GraphQL | Authentication, authorization, request routing |
| **Sensor Service** | NestJS | VFD business logic, change set management, risk evaluation, automation rules |
| **Database** | PostgreSQL + TimescaleDB | Persistent storage for device config, change sets, audit logs, and time-series readings |
| **Message Queue** | NATS | Asynchronous communication between services and edge gateways |
| **Edge Gateway** | Local device (on-site) | Translates between IP-based messages and physical VFD protocols (Modbus, Profinet, etc.) |
| **VFD Device** | Physical hardware | The actual Variable Frequency Drive controlling a motor |

### 1.3 Data Flow for a Parameter Change

1. User creates a change set in the browser (GraphQL mutation).
2. Sensor Service validates the change, evaluates risk, and stores it in PostgreSQL.
3. User submits the change set for approval.
4. Checker approves the change set.
5. Sensor Service publishes a "write parameters" command to NATS.
6. Edge Gateway receives the command, translates it to the VFD's protocol (e.g., Modbus register writes), and sends it to the VFD.
7. Edge Gateway reads back the parameter values for verification.
8. Verification result is published back to NATS.
9. Sensor Service updates the change set status and writes to the audit log.

### 1.4 Standards Compliance

| Standard | Scope | How This System Complies |
|----------|-------|------------------------|
| **IEC 62443 SL-2** | Industrial cybersecurity | Role-based access control (RBAC), Maker-Checker dual approval, immutable audit trail, authentication for all users |
| **IEC 61800-7-201** | VFD communication profiles | Control word / status word formats, CiA402 / PROFIdrive profile compatibility, standardized register mappings |
| **ISA-95 Level 2-3** | Automation pyramid | Level 2: Direct VFD communication (register read/write). Level 3: Change management, approval workflows, reporting |

---

## 2. Supported VFD Brands and Models

### 2.1 Danfoss FC Series

**Supported Models:** FC102, FC302, FC51, VLT 2800, VLT 5000, VLT 6000, VLT HVAC

**Supported Protocols:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP

**Register Calculation Formula:**
```
Register Address = (Parameter Number x 10) - 1
Example: Parameter 16-13 (Output Frequency) = (1613 x 10) - 1 = 16129
```

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry Count | 3 |

**Monitoring Registers:**

| Parameter | Danfoss Param | Register | Data Type | Scale | Unit | Critical | Poll (ms) |
|-----------|--------------|----------|-----------|-------|------|----------|-----------|
| Status Word | 16-03 | 16029 | STATUS_WORD | -- | -- | Yes | 200 |
| Output Frequency | 16-13 | 16129 | UINT16 | x0.1 | Hz | Yes | 500 |
| Motor Current | 16-14 | 16139 | UINT32 (2 reg) | x0.01 | A | Yes | 500 |
| Motor Voltage | 16-12 | 16119 | UINT16 | x0.1 | V | No | 1000 |
| Motor Speed | 16-17 | 16169 | INT32 (2 reg) | x1 | RPM | Yes | 500 |
| Motor Torque | 16-16 | 16159 | INT16 | x0.1 | % | No | 500 |
| Output Power | 16-10 | 16099 | INT32 (2 reg) | x0.1 | kW | Yes | 1000 |
| DC Bus Voltage | 16-30 | 16299 | UINT16 | x0.1 | V | No | 1000 |
| Power Factor | 16-11 | 16109 | INT16 | x0.01 | -- | No | 2000 |
| Speed Reference | 16-02 | 16019 | INT16 | x0.1 | Hz | No | 500 |
| Heatsink Temp | 16-34 | 16339 | INT16 | x0.1 | C | Yes | 5000 |
| Control Card Temp | 16-35 | 16349 | INT16 | x0.1 | C | No | 5000 |
| Motor Thermal | 16-33 | 16329 | UINT16 | x1 | % | No | 5000 |
| Running Hours | 15-00 | 14999 | UINT32 (2 reg) | x1 | h | No | 60000 |
| Power On Hours | 15-01 | 15009 | UINT32 (2 reg) | x1 | h | No | 60000 |
| Energy Consumption | 15-02 | 15019 | UINT32 (2 reg) | x1 | kWh | No | 60000 |
| Start Count | 15-03 | 15029 | UINT32 (2 reg) | x1 | -- | No | 60000 |
| Alarm Word | 16-90 | 16899 | UINT16 | -- | -- | Yes | 500 |
| Warning Word | 16-92 | 16919 | UINT16 | -- | -- | Yes | 500 |
| Fault Code | 15-94 | 15939 | UINT16 | -- | -- | Yes | 500 |

**Configuration Registers:**

| Parameter | Danfoss Param | Register | Data Type | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|--------------|----------|-----------|-------|------|-----|-----|---------|------|------------|
| Acceleration Time 1 | 3-41 | 3409 | UINT16 | x0.01 | s | 0.05 | 3600 | 10 | MEDIUM | No |
| Deceleration Time 1 | 3-42 | 3419 | UINT16 | x0.01 | s | 0.05 | 3600 | 10 | MEDIUM | No |
| Min Frequency | 4-11 | 4109 | UINT16 | x0.1 | Hz | 0 | 400 | 0 | MEDIUM | No |
| Max Frequency | 4-13 | 4129 | UINT16 | x0.1 | Hz | 0.1 | 400 | 50 | HIGH | No |
| Motor Nom. Power | 1-20 | 1199 | UINT16 | x0.01 | kW | 0.01 | 1000 | -- | HIGH | Yes |
| Motor Nom. Voltage | 1-22 | 1219 | UINT16 | x0.1 | V | 50 | 1000 | 400 | HIGH | Yes |
| Motor Nom. Current | 1-24 | 1239 | UINT16 | x0.01 | A | 0.01 | 10000 | -- | HIGH | Yes |
| Motor Nom. Speed | 1-25 | 1249 | UINT16 | x1 | RPM | 100 | 60000 | -- | HIGH | Yes |
| Current Limit % | 4-16 | 4159 | UINT16 | x0.1 | % | 0 | 400 | 160 | MEDIUM | No |
| PID P Gain | 7-03 | 7029 | UINT16 | x0.01 | -- | 0 | 10 | 1 | MEDIUM | No |
| PID I Time | 7-04 | 7039 | UINT16 | x0.01 | s | 0.01 | 9999 | 10 | MEDIUM | No |
| Jog Frequency | 3-19 | 3189 | UINT16 | x0.1 | Hz | 0 | 400 | 5 | LOW | No |
| Thermal Protection | 1-90 | 1899 | UINT16 | x1 | -- | 0 | 4 | 2 | CRITICAL | No |
| Modbus Address | 8-31 | 8309 | UINT16 | x1 | -- | 1 | 247 | 1 | LOW | No |

**Control Word (Register 49999 / P50-00) Bit Definitions:**

| Bit | Name | Description |
|-----|------|-------------|
| 0 | Reference Select 0 | Reference selection bit 0 |
| 1 | Reference Select 1 | Reference selection bit 1 |
| 2 | DC Brake | DC braking command |
| 3 | Coasting | Coast stop (free run) |
| 4 | Quick Stop | Quick stop command |
| 5 | Freeze Frequency | Freeze output frequency |
| 6 | Ramp Stop | Ramp stop |
| 7 | Reset | Fault reset |
| 8 | Jog | Jog mode |
| 9 | Ramp | Ramp selection |
| 10 | Data Valid | Data valid flag |
| 11 | Relay | Relay output control |
| 15 | Reverse | Reverse direction |

**Control Command Values:**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| START | 0x047F | Ramp start |
| STOP | 0x043C | Ramp stop |
| COAST | 0x0437 | Coast stop (free run) |
| QUICK_STOP | 0x042F | Quick stop |
| RESET | 0x04FF | Fault reset |
| JOG | 0x057F | Jog mode |

**Status Word (Register 16029 / P16-03) Bit Definitions:**

| Bit | Name | Description |
|-----|------|-------------|
| 0 | Control Ready | Drive ready for control |
| 1 | Drive Ready | Drive ready to run |
| 2 | Coasting | Coast stop active |
| 3 | Trip | Drive tripped (fault) |
| 4 | Trip Lock | Fault lock active |
| 7 | Warning | Warning active |
| 8 | At Reference | Speed at reference |
| 9 | Auto Mode | Automatic mode |
| 10 | Out of Freq Range | Output frequency out of range |
| 11 | Running | Motor running |
| 12 | Voltage Warning | DC bus voltage warning |
| 13 | Current Limit | Current limit active |
| 14 | Thermal Warning | Thermal warning |

**FC Protocol Activation Steps:**
1. Set parameter 8-01 to "FC Protocol"
2. Set parameter 8-30 to "MODBUS"
3. Set the slave address in parameter 8-31 (range: 1-247)
4. Set the baud rate in parameter 8-32 (default: 9600)
5. Restart the drive

**Known Limitations:**
- Maximum 32 devices on a single RS-485 line without a repeater
- Motor Current (P16-14) uses 2 registers (UINT32) -- requires reading 2 consecutive registers
- Register addressing starts from 0 in FC protocol, unlike standard Modbus which starts from 1

---

### 2.2 ABB ACS Series

**Supported Models:** ACS580, ACS880, ACS355, ACS310, ACS550, ACS800, ACS1000

**Supported Protocols:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP

**Register Calculation Formula:**
```
16-bit Register: Register = 40000 + (100 x Group) + Index
32-bit Register: Register = 420000 + (200 x Group) + (2 x Index)
```

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry Count | 3 |

**Monitoring Registers:**

| Parameter | ABB Param | Register | Data Type | Scale | Unit | Critical | Poll (ms) |
|-----------|----------|----------|-----------|-------|------|----------|-----------|
| Status Word (ZSW) | -- | 400051 | STATUS_WORD | -- | -- | Yes | 200 |
| Actual Speed | -- | 400052 | INT16 | x0.005 | % | Yes | 500 |
| Output Frequency | 01.06 | 40106 | INT16 | x0.01 | Hz | Yes | 500 |
| Motor Current | 01.07 | 40107 | INT16 | x0.01 | A | Yes | 500 |
| Motor Torque | 01.10 | 40110 | INT16 | x0.01 | % | No | 500 |
| DC Bus Voltage | 01.11 | 40111 | UINT16 | x0.01 | V | No | 1000 |
| Motor Voltage | 01.13 | 40113 | UINT16 | x1 | V | No | 1000 |
| Output Power | 01.14 | 40114 | INT16 | x0.01 | kW | Yes | 1000 |
| Motor Speed | 01.02 | 40102 | INT16 | x1 | RPM | Yes | 500 |
| Drive Temp | 05.11 | 40511 | INT16 | x1 | % | Yes | 5000 |
| Motor Thermal | 09.01 | 40901 | INT16 | x1 | % | No | 5000 |
| Energy Consumption | 01.20 | 40120 | UINT32 (2 reg) | x0.1 | kWh | No | 60000 |
| Running Hours | 05.03 | 40503 | UINT32 (2 reg) | x1 | h | No | 60000 |
| Power On Hours | 05.01 | 40501 | UINT32 (2 reg) | x1 | h | No | 60000 |
| Fault Code | 04.11 | 40411 | UINT16 | -- | -- | Yes | 500 |
| Warning Word | 04.21 | 40421 | UINT16 | -- | -- | Yes | 500 |

**Configuration Registers:**

| Parameter | ABB Param | Register | Data Type | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|----------|----------|-----------|-------|------|-----|-----|---------|------|------------|
| Accel Time 1 | 22.01 | 42201 | UINT16 | x0.1 | s | 0 | 1800 | 5 | MEDIUM | No |
| Decel Time 1 | 22.02 | 42202 | UINT16 | x0.1 | s | 0 | 1800 | 5 | MEDIUM | No |
| Min Frequency | 20.01 | 42001 | UINT16 | x0.1 | Hz | 0 | 500 | 0 | MEDIUM | No |
| Max Frequency | 20.02 | 42002 | UINT16 | x0.1 | Hz | 0.1 | 500 | 50 | HIGH | No |
| Motor Nom. Power | 99.04 | 49904 | UINT16 | x0.01 | kW | 0.12 | 2000 | -- | HIGH | Yes |
| Motor Nom. Voltage | 99.05 | 49905 | UINT16 | x1 | V | 100 | 1000 | 400 | HIGH | Yes |
| Motor Nom. Current | 99.06 | 49906 | UINT16 | x0.1 | A | 0.1 | 5000 | -- | HIGH | Yes |
| Motor Nom. Speed | 99.07 | 49907 | UINT16 | x1 | RPM | 100 | 30000 | -- | HIGH | Yes |
| Current Limit | 20.07 | 42007 | UINT16 | x0.1 | % | 0 | 300 | 150 | MEDIUM | No |
| PID Gain | 40.01 | 44001 | UINT16 | x0.01 | -- | 0 | 1000 | 100 | MEDIUM | No |
| PID Integration Time | 40.02 | 44002 | UINT16 | x0.1 | s | 0 | 3200 | 10 | MEDIUM | No |
| Jog Frequency | 21.10 | 42110 | UINT16 | x0.1 | Hz | 0 | 500 | 5 | LOW | No |
| Motor Thermal Protection | 30.01 | 43001 | UINT16 | x1 | -- | 0 | 3 | 1 | CRITICAL | No |
| Modbus Address | 53.01 | 45301 | UINT16 | x1 | -- | 1 | 247 | 1 | LOW | No |

**Control Word (Register 400001) Bit Definitions:**

| Bit | Name | Description |
|-----|------|-------------|
| 0 | Switch On | Power on command |
| 1 | Enable Voltage | Enable voltage |
| 2 | Quick Stop | Quick stop (inverted logic) |
| 3 | Enable Operation | Enable operation |
| 4 | Ramp Out Zero | Reset ramp output |
| 5 | Ramp Hold | Hold ramp |
| 6 | Ramp In Zero | Reset ramp input |
| 7 | Reset | Fault reset |
| 10 | Control Bit 0 | Control bit 0 |
| 11 | Direction | Direction (0=Forward, 1=Reverse) |

**Control Command Values:**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| SHUTDOWN | 0x0006 | Shutdown |
| SWITCH_ON | 0x0007 | Switch on |
| ENABLE_OPERATION | 0x000F | Enable operation |
| RUN_FORWARD | 0x000F | Run forward |
| RUN_REVERSE | 0x080F | Run reverse |
| QUICK_STOP | 0x0002 | Quick stop |
| DISABLE_VOLTAGE | 0x0000 | Disable voltage |
| FAULT_RESET | 0x0080 | Fault reset |

**Status Word (Register 400051) Bit Definitions:**

| Bit | Name | Description |
|-----|------|-------------|
| 0 | Ready to Switch On | Ready to switch on |
| 1 | Switched On | Main contactor closed |
| 2 | Operation Enabled | Operation enabled |
| 3 | Fault | Fault active |
| 4 | Voltage Enabled | DC bus voltage enabled |
| 5 | Quick Stop | Quick stop not active |
| 6 | Switch On Disabled | Switch on disabled |
| 7 | Warning | Warning active |
| 8 | At Setpoint | Speed at setpoint |
| 9 | Remote | Remote control active |
| 10 | Target Reached | Target speed reached |
| 11 | Internal Limit | Internal limit active |

**ABB Fault Codes:**

| Code | Description |
|------|-------------|
| 0 | No fault |
| 1 | Overcurrent |
| 2 | DC Overvoltage |
| 3 | Device Overtemperature |
| 4 | Short Circuit |
| 5 | Motor Overtemperature |
| 6 | Analog Input Loss |
| 7 | External Fault |
| 8 | Output Phase Loss |
| 9 | Undervoltage |
| 10 | AI1 Low Fault |
| 11 | AI2 Low Fault |
| 16 | Earth Fault |
| 22 | IGBT Overtemperature |
| 23 | Charging Fault |
| 25 | Motor Stall |
| 31 | PPCC Link Fault |
| 32 | Supply Phase Loss |
| 34 | ID Run Fault |
| 51 | Parameter Restore Fault |
| 52 | Fieldbus Communication Loss |
| 53 | Fieldbus Fault |
| 64 | Encoder Fault |

**Known Limitations:**
- ACS1000 series requires specific gateway configuration for medium-voltage drives
- Status Word register differs between ACS580 (400051) and older ACS800 series

---

### 2.3 Siemens SINAMICS G120

**Supported Models:** G120, G120C, G120D, G120P, G130, S120, MICROMASTER 440

**Supported Protocols:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, CANopen, BACnet/IP

**Parameter Structure:**
```
P0xxx: Read/Write parameters
r0xxx: Read-only parameters
Register = Parameter number (direct mapping)
```

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | **Even** |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry Count | 3 |

**Monitoring Registers:**

| Parameter | Siemens Param | Register | Data Type | Scale | Unit | Critical | Poll (ms) |
|-----------|--------------|----------|-----------|-------|------|----------|-----------|
| Status Word 1 (ZSW1) | r0052 | 52 | STATUS_WORD | -- | -- | Yes | 200 |
| Status Word 2 (ZSW2) | r0053 | 53 | STATUS_WORD | -- | -- | No | 500 |
| Output Frequency | r0024 | 24 | UINT16 | x0.01 | Hz | Yes | 500 |
| Motor Speed | r0021 | 21 | INT16 | x1 | RPM | Yes | 500 |
| Motor Current | r0027 | 27 | UINT16 | x0.01 | A | Yes | 500 |
| Motor Torque | r0026 | 26 | INT16 | x0.1 | % | No | 500 |
| Motor Voltage | r0025 | 25 | UINT16 | x0.1 | V | No | 1000 |
| Output Power | r0032 | 32 | INT16 | x0.1 | kW | Yes | 1000 |
| Power Factor | r0033 | 33 | INT16 | x0.001 | -- | No | 2000 |
| Speed Setpoint | r0022 | 22 | INT16 | x1 | RPM | No | 500 |
| Drive Temp | r0035 | 35 | INT16 | x0.1 | C | Yes | 5000 |
| Motor Thermal Load | r0034 | 34 | UINT16 | x0.1 | % | No | 5000 |
| Motor Temp | r0036 | 36 | INT16 | x0.1 | C | No | 5000 |
| Energy Consumption | r0039 | 39 | UINT32 (2 reg) | x0.1 | kWh | No | 60000 |
| Running Hours | r0080 | 80 | UINT32 (2 reg) | x1 | h | No | 60000 |
| Power On Hours | r0078 | 78 | UINT32 (2 reg) | x1 | h | No | 60000 |
| Fault Code | r0947 | 947 | UINT16 | -- | -- | Yes | 500 |
| Warning Code | r0952 | 952 | UINT16 | -- | -- | Yes | 500 |

**Configuration Registers:**

| Parameter | Siemens Param | Register | Data Type | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|--------------|----------|-----------|-------|------|-----|-----|---------|------|------------|
| Accel Time | P1120 | 1120 | UINT16 | x0.01 | s | 0 | 6500 | 10 | MEDIUM | No |
| Decel Time | P1121 | 1121 | UINT16 | x0.01 | s | 0 | 6500 | 10 | MEDIUM | No |
| Min Frequency | P1080 | 1080 | UINT16 | x0.01 | Hz | 0 | 650 | 0 | MEDIUM | No |
| Max Frequency | P1082 | 1082 | UINT16 | x0.01 | Hz | 0.01 | 650 | 50 | HIGH | No |
| Motor Rated Voltage | P0304 | 304 | UINT16 | x0.1 | V | 10 | 2000 | 400 | HIGH | Yes |
| Motor Rated Current | P0305 | 305 | UINT16 | x0.01 | A | 0.01 | 10000 | -- | HIGH | Yes |
| Motor Rated Power | P0307 | 307 | UINT16 | x0.01 | kW | 0.01 | 2000 | -- | HIGH | Yes |
| Motor Rated Speed | P0311 | 311 | UINT16 | x1 | RPM | 1 | 40000 | -- | HIGH | Yes |
| Current Limit | P0640 | 640 | UINT16 | x0.1 | % | 10 | 400 | 150 | MEDIUM | No |
| JOG Setpoint | P1058 | 1058 | UINT16 | x0.01 | Hz | 0 | 650 | 5 | LOW | No |
| Motor OL Protection | P0610 | 610 | UINT16 | x1 | -- | 0 | 3 | 1 | CRITICAL | No |
| Modbus Address | P2011 | 2011 | UINT16 | x1 | -- | 0 | 247 | 1 | LOW | No |

**Control Command Values (PROFIdrive):**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| OFF1 | 0x047E | Ramp stop |
| OFF2 | 0x047D | Coast stop (free run) |
| OFF3 | 0x047B | Quick stop |
| READY | 0x047E | Ready state |
| RUN_FORWARD | 0x047F | Run forward |
| RUN_REVERSE | 0x0C7F | Run reverse |
| ACKNOWLEDGE | 0x04FE | Fault acknowledge |
| JOG_FORWARD | 0x057F | Jog forward |
| JOG_REVERSE | 0x0D7F | Jog reverse |

**Siemens Fault Codes:**

| Code | Description |
|------|-------------|
| 0 | No fault |
| 1 | Overcurrent |
| 2 | DC Bus Overvoltage |
| 3 | Inverter I2t |
| 4 | Motor I2t |
| 5 | DC Bus Undervoltage |
| 7 | Motor Overtemperature |
| 8 | Heatsink Overtemperature |
| 11 | Motor Stall |
| 12 | Phase Failure |
| 13 | Internal Fault |
| 14 | Ground Fault |
| 15 | External Fault 1 |
| 18 | Power Stack |
| 25 | EEPROM Fault |
| 30 | Fieldbus Fault |
| 35 | Input Phase Loss |
| 40 | Motor Temperature Sensor Fault |
| 51 | Parameter Checksum Error |
| 52 | Safe Torque Off |
| 60 | Technology Controller Fault |
| 72 | Motor Phase Loss |
| 80 | Missing Motor Parameter |

**Known Limitations:**
- Siemens uses **Even** parity by default (unlike most other brands which use None)
- MICROMASTER 440 has a more limited parameter set than G120 series
- S120 drive system requires additional configuration for multi-axis applications

---

### 2.4 Schneider Altivar

**Supported Models:** Altivar 12, Altivar 312, Altivar 320, Altivar 340, Altivar 600, Altivar 900, Altivar Process

**Supported Protocols:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | **19200** |
| Data Bits | 8 |
| Parity | **Even** |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry Count | 3 |

**Monitoring Registers:**

| Parameter | Schneider Code | Register | Data Type | Scale | Unit | Critical | Poll (ms) |
|-----------|---------------|----------|-----------|-------|------|----------|-----------|
| Status Word (ETA) | ETA | 3201 | STATUS_WORD | -- | -- | Yes | 200 |
| Drive State (HMIS) | HMIS | 3202 | UINT16 | -- | -- | Yes | 200 |
| Output Frequency | RFR | 8602 | INT16 | x0.1 | Hz | Yes | 500 |
| Motor Speed | SPD | 8604 | INT16 | x1 | RPM | Yes | 500 |
| Motor Current | LCR | 3204 | UINT16 | x0.1 | A | Yes | 500 |
| Motor Voltage | UOP | 3208 | UINT16 | x0.1 | V | No | 1000 |
| Motor Torque | OTR | 3205 | INT16 | x0.1 | % | No | 500 |
| DC Bus Voltage | UDC | 3209 | UINT16 | x1 | V | No | 1000 |
| Output Power | OPR | 3206 | INT16 | x0.1 | kW | Yes | 1000 |
| Mains Voltage | ULN | 3210 | UINT16 | x1 | V | No | 2000 |
| Frequency Reference | FRH | 8603 | INT16 | x0.1 | Hz | No | 500 |
| Drive Thermal | THD | 3207 | UINT16 | x1 | % | Yes | 5000 |
| Motor Thermal | THR | 3211 | UINT16 | x1 | % | No | 5000 |
| Energy Consumption | -- | 7133 | UINT32 (2 reg) | x0.1 | kWh | No | 60000 |
| Running Hours | RTH | 7135 | UINT32 (2 reg) | x0.1 | h | No | 60000 |
| Power On Hours | PTH | 7137 | UINT32 (2 reg) | x0.1 | h | No | 60000 |
| Last Fault | LFT | 7121 | UINT16 | -- | -- | Yes | 500 |
| Current Fault | CFP | 7125 | UINT16 | -- | -- | Yes | 500 |
| Alarm Group 1 | ALG1 | 7130 | UINT16 | -- | -- | Yes | 500 |

**Configuration Registers:**

| Parameter | Schneider Code | Register | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|---------------|----------|-------|------|-----|-----|---------|------|------------|
| Accel Time | ACC | 9001 | x0.1 | s | 0.1 | 6000 | 3 | MEDIUM | No |
| Decel Time | dEC | 9002 | x0.1 | s | 0.1 | 6000 | 3 | MEDIUM | No |
| Low Speed (Min Freq) | LSP | 9003 | x0.1 | Hz | 0 | 500 | 0 | MEDIUM | No |
| High Speed (Max Freq) | HSP | 9004 | x0.1 | Hz | 0.1 | 500 | 50 | HIGH | No |
| Motor Nom. Voltage | UnS | 9201 | x1 | V | 100 | 1000 | 400 | HIGH | Yes |
| Motor Nom. Current | nCr | 9202 | x0.1 | A | 0.1 | 5000 | -- | HIGH | Yes |
| Motor Nom. Frequency | FrS | 9203 | x0.1 | Hz | 10 | 500 | 50 | HIGH | Yes |
| Motor Nom. Speed | nSP | 9204 | x1 | RPM | 100 | 30000 | -- | HIGH | Yes |
| Current Limit | CLI | 9207 | x0.1 | A | 0.1 | 5000 | -- | MEDIUM | No |
| JOG Frequency | JGF | 9006 | x0.1 | Hz | 0 | 500 | 10 | LOW | No |
| Motor Thermal Protection | tHP | 9301 | x1 | -- | 0 | 2 | 1 | CRITICAL | No |
| Modbus Address | Add | 8601 | x1 | -- | 1 | 247 | 1 | LOW | No |

**Control Command Values (CiA402):**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| SHUTDOWN | 0x0006 | Ready to switch on |
| SWITCH_ON | 0x0007 | Switched on |
| ENABLE_OPERATION | 0x000F | Operation enabled |
| DISABLE_VOLTAGE | 0x0000 | Disable voltage |
| QUICK_STOP | 0x0002 | Quick stop |
| FAULT_RESET | 0x0080 | Fault reset |
| RUN_FORWARD | 0x000F | Run forward |
| RUN_REVERSE | 0x080F | Run reverse |

**Known Limitations:**
- Schneider uses **19200 baud** and **Even parity** by default (different from most other brands)
- Altivar 12 has a reduced parameter set compared to larger Altivar models
- Current Limit is expressed in Amps (not percentage) on Schneider drives

---

### 2.5 Yaskawa

**Supported Models:** A1000, V1000, J1000, GA500, GA700, U1000, Z1000

**Supported Protocols:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen

**Register Structure:**
```
Monitor parameters: 0x2100+ (U1-xx series)
Configuration: MEMOBUS parameters
```

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | **2** |
| Timeout | 1000 ms |
| Retry Count | 3 |

**Monitoring Registers:**

| Parameter | Yaskawa Param | Register (Hex) | Register (Dec) | Data Type | Scale | Unit | Critical | Poll (ms) |
|-----------|--------------|----------------|----------------|-----------|-------|------|----------|-----------|
| Status Word | -- | 0x2100 | 8448 | STATUS_WORD | -- | -- | Yes | 200 |
| Frequency Reference | U1-01 | 0x2101 | 8449 | INT16 | x0.01 | Hz | No | 500 |
| Output Frequency | U1-02 | 0x2102 | 8450 | UINT16 | x0.01 | Hz | Yes | 500 |
| Motor Current | U1-03 | 0x2103 | 8451 | UINT16 | x0.01 | A | Yes | 500 |
| Output Voltage | U1-04 | 0x2104 | 8452 | UINT16 | x0.1 | V | No | 1000 |
| Motor Speed | U1-05 | 0x2105 | 8453 | INT16 | x1 | RPM | Yes | 500 |
| DC Bus Voltage | U1-07 | 0x2107 | 8455 | UINT16 | x0.1 | V | No | 1000 |
| Output Power | U1-08 | 0x2108 | 8456 | INT16 | x0.1 | kW | Yes | 1000 |
| Motor Torque | U1-09 | 0x2109 | 8457 | INT16 | x0.1 | % | No | 500 |
| IGBT Temp | U1-21 | 0x2115 | 8469 | INT16 | x0.1 | C | Yes | 5000 |
| Motor Thermal Load | U1-22 | 0x2116 | 8470 | UINT16 | x0.1 | % | No | 5000 |
| Drive Thermal Load | U1-23 | 0x2117 | 8471 | UINT16 | x0.1 | % | No | 5000 |
| kWh Counter | U4-01/02 | 0x2401 | 9217 | UINT32 (2 reg) | x0.1 | kWh | No | 60000 |
| Running Hours | U4-03/04 | 0x2403 | 9219 | UINT32 (2 reg) | x0.1 | h | No | 60000 |
| Power On Hours | U4-05/06 | 0x2405 | 9221 | UINT32 (2 reg) | x0.1 | h | No | 60000 |
| Start Count | U4-07/08 | 0x2407 | 9223 | UINT32 (2 reg) | x1 | -- | No | 60000 |
| Fault Code | U2-01 | 0x2201 | 8705 | UINT16 | -- | -- | Yes | 500 |
| Minor Alarm | U2-10 | 0x220A | 8714 | UINT16 | -- | -- | Yes | 500 |

**Configuration Registers:**

| Parameter | Yaskawa Param | Register (Hex) | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|--------------|----------------|-------|------|-----|-----|---------|------|------------|
| Accel Time 1 | C1-01 | 0x0108 | x0.1 | s | 0 | 6000 | 10 | MEDIUM | No |
| Decel Time 1 | C1-02 | 0x0109 | x0.1 | s | 0 | 6000 | 10 | MEDIUM | No |
| Min Frequency | d1-01 | 0x0110 | x0.01 | Hz | 0 | 400 | 0 | MEDIUM | No |
| Max Frequency | d1-02 | 0x0111 | x0.01 | Hz | 0.01 | 400 | 50 | HIGH | No |
| Motor Rated Power | E1-06 | 0x0145 | x0.01 | kW | 0.01 | 2000 | -- | HIGH | Yes |
| Motor Rated Voltage | E1-05 | 0x0144 | x0.1 | V | 100 | 1000 | 400 | HIGH | Yes |
| Motor Rated Current | E1-04 | 0x0143 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Yes |
| Motor Rated Speed | E1-09 | 0x0148 | x1 | RPM | 1 | 30000 | -- | HIGH | Yes |
| Current Limit | L1-01 | 0x0200 | x0.1 | % | 0 | 200 | 150 | MEDIUM | No |
| JOG Frequency | d1-17 | 0x011F | x0.01 | Hz | 0 | 400 | 6 | LOW | No |
| Motor OL Protection | L1-02 | 0x0201 | x1 | -- | 0 | 5 | 1 | CRITICAL | No |
| MEMOBUS Address | H5-01 | 0x0300 | x1 | -- | 1 | 247 | 1 | LOW | No |

**Control Command Values:**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| STOP | 0x0000 | Stop |
| RUN_FORWARD | 0x0001 | Run forward |
| RUN_REVERSE | 0x0003 | Run reverse |
| FAULT_RESET | 0x0008 | Fault reset |
| JOG_FORWARD | 0x0101 | Jog forward |
| JOG_REVERSE | 0x0103 | Jog reverse |
| BASE_BLOCK | 0x0800 | Base block |
| DC_BRAKING | 0x0401 | DC braking |

**Known Limitations:**
- Yaskawa uses **2 stop bits** by default (most brands use 1)
- J1000 series has limited fieldbus options compared to A1000/GA700

---

### 2.6 Delta VFD

**Supported Models:** VFD-E, VFD-EL, VFD-C, VFD-CP, VFD-M, VFD-MS300, VFD-C2000

**Supported Protocols:** Modbus RTU, Modbus TCP, CANopen

**Register Structure:**
```
Parameter group x 256 + parameter number
Example: Pr.01-00 = 0x0100, Pr.02-01 = 0x0201
```

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 500 ms |
| Retry Count | 3 |

**Monitoring Registers:**

| Parameter | Register (Hex) | Register (Dec) | Data Type | Scale | Unit | Critical | Poll (ms) |
|-----------|----------------|----------------|-----------|-------|------|----------|-----------|
| Status Word | 0x2100 | 8448 | STATUS_WORD | -- | -- | Yes | 200 |
| Frequency Command | 0x2101 | 8449 | UINT16 | x0.01 | Hz | No | 500 |
| Fault Code | 0x2102 | 8450 | UINT16 | -- | -- | Yes | 500 |
| Output Frequency | 0x2103 | 8451 | UINT16 | x0.01 | Hz | Yes | 500 |
| Motor Current | 0x2104 | 8452 | UINT16 | x0.01 | A | Yes | 500 |
| DC Bus Voltage | 0x2105 | 8453 | UINT16 | x0.1 | V | No | 1000 |
| Output Voltage | 0x2106 | 8454 | UINT16 | x0.1 | V | No | 1000 |
| Power Factor | 0x2107 | 8455 | INT16 | x0.001 | -- | No | 2000 |
| IGBT Temp | 0x2108 | 8456 | INT16 | x0.1 | C | Yes | 5000 |
| Motor Thermal | 0x2109 | 8457 | UINT16 | x0.1 | % | No | 5000 |
| Drive Thermal | 0x210A | 8458 | UINT16 | x0.1 | % | No | 5000 |
| Warning Code | 0x210B | 8459 | UINT16 | -- | -- | Yes | 500 |
| Motor Speed | 0x210C | 8460 | INT16 | x1 | RPM | Yes | 500 |
| Output Power | 0x210D | 8461 | INT16 | x0.1 | kW | Yes | 1000 |
| Motor Torque | 0x210E | 8462 | INT16 | x0.1 | % | No | 500 |

**Configuration Registers:**

| Parameter | Delta Param | Register (Hex) | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|------------|----------------|-------|------|-----|-----|---------|------|------------|
| Max Frequency | Pr.01-00 | 0x0100 | x0.01 | Hz | 0.01 | 600 | 60 | HIGH | No |
| JOG Frequency | Pr.01-03 | 0x0103 | x0.01 | Hz | 0 | 600 | 6 | LOW | No |
| Min Frequency | Pr.01-07 | 0x0107 | x0.01 | Hz | 0 | 600 | 0 | MEDIUM | No |
| Accel Time 1 | Pr.01-09 | 0x0109 | x0.1 | s | 0.1 | 6000 | 10 | MEDIUM | No |
| Decel Time 1 | Pr.01-10 | 0x010A | x0.1 | s | 0.1 | 6000 | 10 | MEDIUM | No |
| Thermal OL Relay | Pr.06-01 | 0x0601 | x1 | % | 30 | 110 | 100 | CRITICAL | No |
| Motor Rated Power | Pr.07-01 | 0x0701 | x0.01 | kW | 0.01 | 1000 | -- | HIGH | Yes |
| Motor Rated Voltage | Pr.07-02 | 0x0702 | x0.1 | V | 100 | 1000 | 400 | HIGH | Yes |
| Motor Rated Current | Pr.07-03 | 0x0703 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Yes |
| Motor Rated Speed | Pr.07-04 | 0x0704 | x1 | RPM | 1 | 30000 | -- | HIGH | Yes |
| Comm Address | Pr.09-00 | 0x0900 | x1 | -- | 1 | 254 | 1 | LOW | No |

**Control Command Values:**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| STOP | 0x0000 | Stop |
| RUN_FORWARD | 0x0001 | Run forward |
| RUN_REVERSE | 0x0003 | Run reverse |
| JOG_FORWARD | 0x0005 | Jog forward |
| JOG_REVERSE | 0x0007 | Jog reverse |
| FAULT_RESET | 0x0008 | Fault reset |

**Delta Fault Codes:**

| Code | Short Code | Description |
|------|-----------|-------------|
| 0 | -- | No fault |
| 1 | ocA | Overcurrent during acceleration |
| 2 | ocd | Overcurrent during deceleration |
| 3 | ocn | Overcurrent at constant speed |
| 4 | GFF | Ground fault |
| 5 | ov | Overvoltage |
| 6 | Lv | Undervoltage |
| 7 | oL1 | Motor overload |
| 8 | oL2 | Inverter overload |
| 9 | oH1 | Overtemperature 1 |
| 10 | oH2 | Overtemperature 2 |
| 11 | AFE | PID feedback loss |
| 12 | EF | External fault |
| 13 | CE | Communication error |
| 14 | cF3 | Auto-tune error |
| 15 | SoC | IGBT short circuit |

**Known Limitations:**
- Delta defaults to **60 Hz** max frequency (unlike most European brands which default to 50 Hz)
- Limited protocol support (only Modbus RTU, Modbus TCP, and CANopen)
- kWh counter uses separate low/high word registers (0x211A and 0x211B)

---

### 2.7 Mitsubishi FR Series

**Supported Models:** FR-A800, FR-E800, FR-F800, FR-D700, FR-A700, FR-E700

**Supported Protocols:** Modbus RTU, Modbus TCP, Profinet, EtherNet/IP, BACnet/IP

**Register Structure:**
```
Parameters: Pr.xxx
Modbus register = Parameter number (direct mapping)
Monitor registers: 200-212
```

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 500 ms |
| Retry Count | 3 |

**Configuration Registers:**

| Parameter | Mitsubishi Param | Register | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|-----------------|----------|-------|------|-----|-----|---------|------|------------|
| Max Frequency | Pr.1 | 1 | x0.01 | Hz | 0.01 | 400 | 50 | HIGH | No |
| Min Frequency | Pr.2 | 2 | x0.01 | Hz | 0 | 400 | 0 | MEDIUM | No |
| Base Frequency | Pr.3 | 3 | x0.01 | Hz | 0.01 | 400 | 50 | HIGH | Yes |
| Accel Time | Pr.7 | 7 | x0.1 | s | 0 | 3600 | 5 | MEDIUM | No |
| Decel Time | Pr.8 | 8 | x0.1 | s | 0 | 3600 | 5 | MEDIUM | No |
| Motor Rated Current | Pr.9 | 9 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Yes |
| JOG Frequency | Pr.15 | 15 | x0.01 | Hz | 0 | 400 | 5 | LOW | No |
| Current Limit | Pr.22 | 22 | x1 | % | 0 | 200 | 150 | MEDIUM | No |
| Motor Capacity | Pr.80 | 80 | x0.01 | kW | 0.01 | 1000 | -- | HIGH | Yes |
| Motor Poles | Pr.81 | 81 | x1 | -- | 2 | 12 | 4 | HIGH | Yes |
| Station Number | Pr.117 | 117 | x1 | -- | 0 | 247 | 0 | LOW | No |

**Control Command Values:**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| STOP | 0x0000 | Stop |
| RUN_FORWARD | 0x0001 | Run forward (STF) |
| RUN_REVERSE | 0x0003 | Run reverse (STR) |
| JOG_FORWARD | 0x0021 | Jog forward |
| JOG_REVERSE | 0x0023 | Jog reverse |
| FAULT_RESET | 0x0080 | Fault reset (RES) |
| COAST_STOP | 0x0200 | Coast stop (MRS) |

**Mitsubishi Fault Codes:**

| Code | Short Code | Description |
|------|-----------|-------------|
| 0 | -- | No fault |
| 1 | OC1 | Overcurrent during acceleration |
| 2 | OC2 | Overcurrent during deceleration |
| 3 | OC3 | Overcurrent at constant speed |
| 4-6 | OV1-OV3 | Regenerative overvoltage |
| 7 | THM | Motor electronic thermal relay trip |
| 8 | THT | Transistor electronic thermal trip |
| 9 | FIN | Heatsink overtemperature |
| 10 | CPU | CPU error |
| 11 | ILF | Input phase loss |
| 14 | GF | Output ground fault |
| 15 | LF | Output phase loss |
| 23 | UV | Undervoltage trip |
| 25 | OS | Overspeed |
| 30 | FAN | Cooling fan fault |

**Known Limitations:**
- Mitsubishi uses direct parameter-to-register mapping (Pr.1 = register 1), which simplifies addressing
- FR-D700 series has limited communication options compared to FR-A800

---

### 2.8 Rockwell PowerFlex

**Supported Models:** PowerFlex 523, PowerFlex 525, PowerFlex 527, PowerFlex 700, PowerFlex 753, PowerFlex 755

**Supported Protocols:** Modbus RTU, Modbus TCP, Profinet, EtherNet/IP

**Model Protocol Support:**

| Model | Max Power (kW) | Protocols |
|-------|---------------|-----------|
| PowerFlex 4 | 3.7 | Modbus RTU |
| PowerFlex 40 | 11 | Modbus RTU, DeviceNet |
| PowerFlex 525 | 22 | Modbus RTU, Modbus TCP, EtherNet/IP |
| PowerFlex 527 | 22 | EtherNet/IP |
| PowerFlex 755 | 2300 | Modbus TCP, EtherNet/IP, ControlNet, DeviceNet |

**Default Serial Communication Settings:**

| Setting | Value |
|---------|-------|
| Baud Rate | **19200** |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry Count | 3 |

**Configuration Registers:**

| Parameter | Rockwell Param | Register | Scale | Unit | Min | Max | Default | Risk | Motor Stop |
|-----------|---------------|----------|-------|------|-----|-----|---------|------|------------|
| Min Speed | P033 | 40033 | x0.01 | Hz | 0 | 500 | 0 | MEDIUM | No |
| Max Speed | P034 | 40034 | x0.01 | Hz | 0.01 | 500 | 60 | HIGH | No |
| Motor NP Volts | P035 | 40035 | x0.1 | V | 100 | 1000 | 460 | HIGH | Yes |
| Motor NP Amps | P036 | 40036 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Yes |
| Motor NP Hertz | P037 | 40037 | x0.1 | Hz | 10 | 500 | 60 | HIGH | Yes |
| Motor NP RPM | P038 | 40038 | x1 | RPM | 1 | 30000 | -- | HIGH | Yes |
| Motor OL Current | P039 | 40039 | x0.01 | A | 0 | 5000 | -- | MEDIUM | No |
| Motor OL Mode | P040 | 40040 | x1 | -- | 0 | 2 | 1 | CRITICAL | No |
| Accel Time 1 | P041 | 40041 | x0.1 | s | 0 | 3600 | 10 | MEDIUM | No |
| Decel Time 1 | P042 | 40042 | x0.1 | s | 0 | 3600 | 10 | MEDIUM | No |
| Comm Node Addr | P044 | 40044 | x1 | -- | 1 | 247 | 1 | LOW | No |
| Jog Speed | P050 | 40050 | x0.01 | Hz | 0 | 500 | 5 | LOW | No |

**Control Command Values:**

| Command | Hex Value | Description |
|---------|-----------|-------------|
| STOP | 0x0000 | Stop |
| START_FORWARD | 0x0002 | Start forward |
| START_REVERSE | 0x0042 | Start reverse |
| JOG_FORWARD | 0x0006 | Jog forward |
| JOG_REVERSE | 0x0046 | Jog reverse |
| CLEAR_FAULTS | 0x0008 | Clear faults |
| MOP_INCREMENT | 0x0102 | Motor potentiometer increment |
| MOP_DECREMENT | 0x0202 | Motor potentiometer decrement |

**Rockwell PowerFlex Fault Codes:**

| Code | Description |
|------|-------------|
| 0 | No fault |
| 2 | Auxiliary Input |
| 3 | Power Loss |
| 4 | Undervoltage |
| 5 | Overvoltage |
| 6 | Motor Stall |
| 7 | Motor Overload |
| 8 | Heatsink Overtemperature |
| 12 | Hardware Overcurrent |
| 13 | Ground Fault |
| 29 | Analog Input Loss |
| 33 | Auto Restart Tries |
| 48 | Parameters Defaulted |
| 63 | Software Overcurrent |
| 64 | Drive Overload |
| 70 | Power Unit |
| 80 | Network Loss |
| 100 | Parameter Checksum |

**Known Limitations:**
- Rockwell defaults to **19200 baud** and **60 Hz** max frequency (US standards)
- PowerFlex 527 only supports EtherNet/IP (no Modbus)
- Motor NP Volts defaults to 460V (US standard, not 400V European standard)

---

### Brand Comparison Summary

| Feature | Danfoss | ABB | Siemens | Schneider | Yaskawa | Delta | Mitsubishi | Rockwell |
|---------|---------|-----|---------|-----------|---------|-------|------------|----------|
| Default Baud Rate | 9600 | 9600 | 9600 | 19200 | 9600 | 9600 | 9600 | 19200 |
| Default Parity | None | None | Even | Even | None | None | None | None |
| Default Stop Bits | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 1 |
| Default Max Freq | 50 Hz | 50 Hz | 50 Hz | 50 Hz | 50 Hz | 60 Hz | 50 Hz | 60 Hz |
| Default Accel Time | 10 s | 5 s | 10 s | 3 s | 10 s | 10 s | 5 s | 10 s |
| Default Current Lim | 160% | 150% | 150% | -- | 150% | 150% | 150% | -- |

---

## 3. Communication Protocols

### 3.1 Modbus RTU (Serial)

**When to use:** The most common protocol. Use when VFDs are connected via RS-485 serial cabling. Available on all 8 supported brands.

**Physical Layer:**
- Electrical standard: RS-485 (differential signal, 2-wire)
- Cable: Shielded Twisted Pair (STP), 120 ohm impedance
- Maximum cable length: 1200 m at 9600 baud, 500 m at 19200 baud
- Termination: 120 ohm resistor required at both ends of the cable
- Maximum devices: 32 per segment (up to 247 with repeaters)

**Frame Structure:**
```
[Slave Address (1 byte)] [Function Code (1 byte)] [Data (N bytes)] [CRC16 (2 bytes)]
```

**Supported Function Codes:**

| FC | Name | Usage |
|----|------|-------|
| 03 | Read Holding Registers | Read parameter values from VFD |
| 04 | Read Input Registers | Read input register values |
| 06 | Write Single Register | Write a single parameter |
| 16 | Write Multiple Registers | Write multiple parameters in one transaction |

**CRC16 Calculation:** XOR-based calculation with polynomial 0xA001

**Troubleshooting Checklist:**
1. Verify baud rate, data bits, parity, and stop bits match between platform and VFD
2. Check that Slave ID is unique on the bus
3. Verify RS-485 cable termination (120 ohm at each end)
4. Check cable polarity (A/B wires not swapped)
5. Verify cable length does not exceed limits
6. Check for electromagnetic interference near high-power cables

### 3.2 Modbus TCP (Ethernet)

**When to use:** For newer installations with Ethernet infrastructure. Provides remote access capability over IP networks.

**Specifications:**
- Transport: TCP/IP
- Default port: **502**
- MBAP (Modbus Application Protocol) header:
  - Transaction ID: 2 bytes
  - Protocol ID: 2 bytes (0x0000 = Modbus)
  - Length: 2 bytes
  - Unit ID: 1 byte
- No CRC calculation needed (TCP/IP handles error detection)
- Connection management: Keep-alive recommended
- Most VFDs support 5-10 simultaneous connections

**Troubleshooting Checklist:**
1. Ping the VFD's IP address to verify network connectivity
2. Verify both devices are on the same subnet
3. Check that port 502 is not blocked by a firewall
4. Verify no other application is using port 502
5. Check Ethernet cable and switch connections

### 3.3 Profibus DP

**When to use:** In Siemens-based automation systems with existing Profibus infrastructure.

- Physical layer: RS-485, 9.6 kbit/s to 12 Mbit/s
- Cable length: 100 m (12 Mbit/s) to 1200 m (1.5 Mbit/s)
- Master-Slave architecture
- Data exchange: Cyclic (DP-V0), Acyclic (DP-V1)
- GSD file: Required for each VFD model (obtain from manufacturer)
- **Supported brands:** Danfoss, ABB, Siemens, Schneider, Yaskawa

### 3.4 Profinet

**When to use:** Modern Ethernet-based industrial systems, especially Siemens environments.

- Standard: IEEE 802.3 Ethernet
- Real-time data exchange: RT (software-based), IRT (hardware-based)
- GSDML file: Required for device description
- IP address and device name configuration required
- Default ports: UDP 34962-34964
- **Supported brands:** Danfoss, ABB, Siemens, Schneider, Yaskawa, Mitsubishi, Rockwell

### 3.5 EtherNet/IP

**When to use:** Rockwell/Allen-Bradley ecosystems and CIP-based automation.

- Based on CIP (Common Industrial Protocol) over Ethernet
- TCP port 44818 (explicit messaging -- configuration and diagnostics)
- UDP port 2222 (implicit messaging -- cyclic I/O data)
- EDS file: Required for device description
- Explicit Messaging: Configuration and diagnostic data
- Implicit Messaging: Cyclic I/O data
- **Supported brands:** Danfoss, ABB, Schneider, Yaskawa, Mitsubishi, Rockwell

### 3.6 CANopen

**When to use:** Compact installations with CAN bus infrastructure, lower-cost applications.

- Physical layer: CAN 2.0A/B
- Baud rate: 10 kbit/s to 1 Mbit/s
- Object Dictionary (OD) approach
- PDO (Process Data Object): Cyclic data
- SDO (Service Data Object): Configuration
- NMT (Network Management): Network management
- **Supported brands:** Danfoss, ABB, Siemens, Schneider, Yaskawa, Delta

### 3.7 BACnet IP / BACnet MS/TP

**When to use:** Building automation integration, HVAC applications.

- Standard: ASHRAE 135
- BACnet/IP: UDP port 47808 (0xBAC0)
- BACnet MS/TP: RS-485, EIA-485
- Object model: Analog Input/Output, Binary Input/Output
- Common in HVAC applications
- **Supported brands:** Danfoss, ABB, Siemens, Schneider, Mitsubishi

---

## 4. Parameter Categories Reference

### 4.1 Ramp Times

Controls how quickly a motor accelerates and decelerates. This is critical in aquaculture because sudden speed changes can cause water hammer (pressure surges) in piping systems.

**Typical Aquaculture Values:** 5-15 seconds for circulation pumps

| Parameter | Typical Range | Default | Risk | Motor Stop Required |
|-----------|--------------|---------|------|-------------------|
| Acceleration Time 1 | 0.05 - 3600 s | 5-10 s | MEDIUM (CRITICAL if < 1.0 s) | No |
| Deceleration Time 1 | 0.05 - 3600 s | 5-10 s | MEDIUM (CRITICAL if < 0.5 s) | No |

### 4.2 Frequency Limits

Sets the allowed speed range for the motor.

| Parameter | Typical Range | Default | Risk | Motor Stop Required |
|-----------|--------------|---------|------|-------------------|
| Minimum Frequency | 0 - 400 Hz | 0 Hz | MEDIUM | No |
| Maximum Frequency | 0.1 - 400 Hz | 50 Hz | HIGH (CRITICAL if > 60 Hz) | No |

**Skip Frequency (Resonance Avoidance):** Some motors vibrate at certain frequencies due to mechanical resonance. Skip frequency causes the VFD to quickly pass through these frequencies without lingering.

### 4.3 Motor Nameplate

Motor electrical ratings from the motor's nameplate label. These values are critical for proper motor control and protection.

| Parameter | Typical Range | Risk | Motor Stop Required |
|-----------|--------------|------|-------------------|
| Motor Nominal Power | 0.01 - 1000 kW | HIGH | **Yes** |
| Motor Nominal Voltage | 50 - 1000 V | HIGH | **Yes** |
| Motor Nominal Current | 0.01 - 10000 A | HIGH | **Yes** |
| Motor Nominal Speed | 100 - 60000 RPM | HIGH | **Yes** |

> **WARNING:** Changing motor nameplate values requires the motor to be stopped. These values cause the VFD to recalculate its motor model (auto-tune). Changing them while the motor is running can cause the VFD to fault.

### 4.4 Current/Torque Limits

| Parameter | Typical Range | Default | Risk | Motor Stop Required |
|-----------|--------------|---------|------|-------------------|
| Current Limit | 0 - 400% | 150-160% | MEDIUM (HIGH if > 200%) | No |

### 4.5 V/f Control

Controls the voltage-to-frequency ratio, which affects motor efficiency and torque at different speeds.

| Mode | Description | Use Case |
|------|-------------|----------|
| **Linear** | Voltage increases proportionally with frequency | Constant torque loads (conveyors, cranes) |
| **Square** | Voltage increases with the square of frequency | Variable torque loads (pumps, fans) -- recommended for aquaculture |

### 4.6 PID Controller

The VFD's built-in PID controller automatically adjusts motor speed to maintain a process variable (temperature, pressure, flow) at a target value.

| Parameter | Typical Range | Default | Risk |
|-----------|--------------|---------|------|
| PID P Gain | 0 - 10 | 1.0 | MEDIUM |
| PID I Time | 0.01 - 9999 s | 10.0 s | MEDIUM |
| PID D Time | 0 - 9999 s | 0 s | MEDIUM |

**Aquaculture PID Applications:**

| Application | Process Variable | Example Setpoint |
|-------------|-----------------|-----------------|
| Aeration pump | Dissolved Oxygen (DO) | 6.5 mg/L |
| Heating circulation pump | Water temperature | 24.0 deg C |
| Pressure pump | Line pressure | 2.5 bar |
| Flow pump | Flow rate | 100 L/min |

### 4.7 Protection

| Parameter | Values | Default | Risk |
|-----------|--------|---------|------|
| Motor Thermal Protection | 0=Off, 1=Warning, 2=Trip (default), 3=Warning+External, 4=Trip+External | 2 (Trip) | CRITICAL |

> **WARNING:** Motor thermal protection should NEVER be set to "Off" (value 0) except for brief testing purposes. Disabling thermal protection removes the safety mechanism that prevents the motor from overheating, which can cause winding damage and fire risk.

---

## 5. GraphQL API Reference

### 5.1 VFD Device Management

#### `registerVfdDevice` Mutation

Registers a new VFD device. Optionally performs a connection test during registration.

```graphql
mutation RegisterVfd($input: RegisterVfdInput!) {
  registerVfdDevice(input: $input) {
    success
    error
    connectionTestPassed
    latencyMs
    vfdDevice {
      id
      name
      brand
      modelSeries
      protocol
      status
      createdAt
    }
  }
}
```

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | String | Yes | Device name |
| brand | VfdBrand | Yes | Brand enum (danfoss, abb, siemens, ...) |
| modelSeries | String | Yes | Model series (FC302, ACS580, ...) |
| protocol | VfdProtocol | Yes | Communication protocol |
| configuration | JSON | Yes | Protocol-specific connection settings |
| farmId | ID | No | Associated farm |
| tankId | ID | No | Associated tank |
| skipConnectionTest | Boolean | No | If true, skips connection test during registration |

**Authorization:** `TENANT_ADMIN`, `MODULE_MANAGER`

**Return Type:** `VfdRegistrationResult`

| Field | Type | Description |
|-------|------|-------------|
| success | Boolean | Whether registration succeeded |
| vfdDevice | VfdDevice | The created device object |
| error | String | Error message (if failed) |
| connectionTestPassed | Boolean | Connection test result |
| latencyMs | Float | Connection latency in milliseconds |

---

#### `updateVfdDevice` Mutation

Updates an existing VFD device's information.

```graphql
mutation UpdateVfd($id: ID!, $input: UpdateVfdInput!) {
  updateVfdDevice(id: $id, input: $input) {
    id
    name
    brand
    modelSeries
    protocol
    status
    updatedAt
  }
}
```

**Authorization:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `deleteVfdDevice` Mutation

Permanently deletes a VFD device.

```graphql
mutation DeleteVfd($id: ID!) {
  deleteVfdDevice(id: $id)
}
```

**Authorization:** `TENANT_ADMIN` only

---

#### `activateVfdDevice` / `deactivateVfdDevice` Mutations

Activate or deactivate a VFD device.

```graphql
mutation ActivateVfd($id: ID!) {
  activateVfdDevice(id: $id) {
    id
    status
  }
}
```

**Authorization:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `testVfdConnection` Mutation

Tests connection to a VFD before registration.

```graphql
mutation TestConnection($input: TestVfdConnectionInput!) {
  testVfdConnection(input: $input) {
    success
    latencyMs
    error
    sampleData
    firmwareVersion
    deviceInfo
    testedAt
  }
}
```

**Authorization:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `vfdDevices` Query

Lists all VFD devices with filtering and pagination.

```graphql
query ListVfdDevices($filter: VfdDeviceFilter, $pagination: VfdPagination) {
  vfdDevices(filter: $filter, pagination: $pagination) {
    items {
      id
      name
      brand
      modelSeries
      protocol
      status
      latestReading {
        outputFrequency
        motorCurrent
        motorVoltage
        timestamp
      }
    }
    total
    page
    limit
    totalPages
  }
}
```

**Filter Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| brand | VfdBrand | Filter by brand |
| status | VfdDeviceStatus | Filter by status |
| farmId | ID | Filter by farm |
| tankId | ID | Filter by tank |
| search | String | Search by name |

---

#### `vfdDevice` Query

Single device query.

```graphql
query GetVfdDevice($id: ID!) {
  vfdDevice(id: $id) {
    id
    name
    brand
    modelSeries
    protocol
    status
    configuration
    latestReading {
      outputFrequency
      motorCurrent
      motorVoltage
      outputPower
      dcBusVoltage
      heatsinkTemp
      motorThermal
      faultCode
      statusWord
      timestamp
    }
  }
}
```

---

#### `vfdStats` Query

Fleet statistics.

```graphql
query VfdFleetStats {
  vfdStats {
    total
    active
    inactive
    faulted
    maintenance
    byBrand
    byProtocol
    byStatus
  }
}
```

---

### 5.2 VFD Command API

All command mutations return `VfdCommandResult`:

| Field | Type | Description |
|-------|------|-------------|
| success | Boolean | Whether the command succeeded |
| message | String | Result message |
| executedAt | DateTime | Execution timestamp |
| latencyMs | Float | Latency in milliseconds |

#### `sendVfdCommand` Mutation

General-purpose command.

```graphql
mutation SendCommand($vfdDeviceId: ID!, $command: VfdCommandInput!) {
  sendVfdCommand(vfdDeviceId: $vfdDeviceId, command: $command) {
    success
    message
    latencyMs
  }
}
```

**VfdCommandType enum values:** `start`, `stop`, `reverse`, `set_frequency`, `set_speed`, `fault_reset`, `quick_stop`, `emergency_stop`, `jog_forward`, `jog_reverse`, `coast_stop`

**Authorization:** `TENANT_ADMIN`, `MODULE_MANAGER`

#### Shortcut Mutations

```graphql
mutation StartVfd($vfdDeviceId: ID!) {
  startVfd(vfdDeviceId: $vfdDeviceId) { success message }
}

mutation StopVfd($vfdDeviceId: ID!) {
  stopVfd(vfdDeviceId: $vfdDeviceId) { success message }
}

mutation SetFreq($vfdDeviceId: ID!, $frequencyHz: Float!) {
  setVfdFrequency(vfdDeviceId: $vfdDeviceId, frequencyHz: $frequencyHz) { success message }
}

mutation SetSpeed($vfdDeviceId: ID!, $speedPercent: Float!) {
  setVfdSpeed(vfdDeviceId: $vfdDeviceId, speedPercent: $speedPercent) { success message }
}

mutation ResetFault($vfdDeviceId: ID!) {
  resetVfdFault(vfdDeviceId: $vfdDeviceId) { success message }
}
```

#### `emergencyStopVfd` Mutation

Emergency stop -- callable by **all authenticated users** regardless of role.

```graphql
mutation EmergencyStop($vfdDeviceId: ID!) {
  emergencyStopVfd(vfdDeviceId: $vfdDeviceId) {
    success
    message
  }
}
```

**Authorization:** All authenticated users (no role restriction)

---

### 5.3 VFD Reading API

#### `vfdReadings` Query

Retrieves historical readings from TimescaleDB.

```graphql
query GetReadings($vfdDeviceId: ID!, $from: DateTime, $to: DateTime, $limit: Int) {
  vfdReadings(vfdDeviceId: $vfdDeviceId, from: $from, to: $to, limit: $limit) {
    outputFrequency
    motorCurrent
    motorVoltage
    motorSpeed
    outputPower
    motorTorque
    dcBusVoltage
    heatsinkTemp
    motorThermal
    energyConsumption
    runningHours
    faultCode
    statusWord
    controlWord
    timestamp
  }
}
```

#### `vfdLatestReading` Query

Returns the most recent reading for a device.

```graphql
query LatestReading($vfdDeviceId: ID!) {
  vfdLatestReading(vfdDeviceId: $vfdDeviceId) {
    outputFrequency
    motorCurrent
    motorVoltage
    outputPower
    faultCode
    timestamp
  }
}
```

#### `vfdReadingStats` Query

Statistics for a given time period.

```graphql
query ReadingStats($vfdDeviceId: ID!, $period: String) {
  vfdReadingStats(vfdDeviceId: $vfdDeviceId, period: $period) {
    vfdDeviceId
    period
    avgFrequency
    avgCurrent
    avgPower
    maxFrequency
    maxCurrent
    maxPower
    totalEnergy
    runningTime
    faultCount
  }
}
```

**Period values:** `hour`, `day`, `week`, `month`, `custom`

#### `readVfdParameters` / `readVfdCriticalParameters` Mutations

Live parameter reading from the device.

```graphql
mutation ReadParams($vfdDeviceId: ID!, $parameters: [String!]) {
  readVfdParameters(vfdDeviceId: $vfdDeviceId, parameters: $parameters) {
    success
    data
    error
    readAt
  }
}
```

---

### 5.4 VFD Programming API (Maker-Checker Workflow)

#### `vfdParameterDefinitions` Query

Returns all parameter definitions for a device.

```graphql
query ParamDefs($vfdDeviceId: ID!, $group: String) {
  vfdParameterDefinitions(vfdDeviceId: $vfdDeviceId, group: $group) {
    parameterName
    displayName
    description
    group
    registerAddress
    dataType
    scalingFactor
    unit
    minValue
    maxValue
    defaultValue
    riskLevel
    requiresMotorStop
  }
}
```

**Group values:** `ramp_times`, `frequency_limits`, `motor_nameplate`, `current_limits`, `vf_control`, `pid_controller`, `digital_io`, `communication`, `protection`, `jog`, `advanced`

#### `createVfdChangeSet` Mutation

Creates a new change set in DRAFT status.

```graphql
mutation CreateChangeSet($input: CreateChangeSetInput!) {
  createVfdChangeSet(input: $input) {
    id
    status
    description
    items { parameterName currentValue newValue riskLevel }
    createdAt
    createdBy
  }
}
```

**Authorization:** `MODULE_MANAGER`, `TENANT_ADMIN` (Maker role)

#### `addVfdChangeSetItems` Mutation

Adds items to a DRAFT change set.

```graphql
mutation AddItems($changeSetId: ID!, $items: [ChangeSetItemInput!]!) {
  addVfdChangeSetItems(changeSetId: $changeSetId, items: $items) {
    id
    status
    items { id parameterName newValue riskLevel }
  }
}
```

#### `submitVfdChangeSetForApproval` Mutation

Submits a DRAFT change set for approval.

```graphql
mutation SubmitForApproval($changeSetId: ID!) {
  submitVfdChangeSetForApproval(changeSetId: $changeSetId) {
    id
    status
    submittedAt
  }
}
```

#### `approveVfdChangeSet` Mutation

Approves a PENDING_APPROVAL change set. Four-eyes principle: the creator cannot approve.

```graphql
mutation Approve($changeSetId: ID!) {
  approveVfdChangeSet(changeSetId: $changeSetId) {
    id
    status
    approvedAt
    approvedBy
  }
}
```

**Authorization:** `TENANT_ADMIN` only (Checker role)

#### `rejectVfdChangeSet` Mutation

Rejects a PENDING_APPROVAL change set.

```graphql
mutation Reject($input: RejectChangeSetInput!) {
  rejectVfdChangeSet(input: $input) {
    id
    status
    rejectedAt
    rejectionReason
  }
}
```

**Authorization:** `TENANT_ADMIN` only

#### `rollbackVfdChangeSet` Mutation

Rolls back an APPLIED or VERIFIED change set.

```graphql
mutation Rollback($input: RollbackChangeSetInput!) {
  rollbackVfdChangeSet(input: $input) {
    id
    status
    rolledBackAt
  }
}
```

**Authorization:** `MODULE_MANAGER`, `TENANT_ADMIN`

#### `vfdChangeSets` Query

Lists change sets for a device.

```graphql
query ChangeSets($vfdDeviceId: ID!, $status: VfdChangeSetStatus, $limit: Int, $offset: Int) {
  vfdChangeSets(vfdDeviceId: $vfdDeviceId, status: $status, limit: $limit, offset: $offset) {
    id
    status
    description
    riskLevel
    items { parameterName currentValue newValue status }
    createdAt
    createdBy
    approvedAt
    approvedBy
  }
}
```

#### `vfdParameterAuditLog` Query

Parameter change audit trail.

```graphql
query AuditLog($vfdDeviceId: ID!, $parameterName: String, $limit: Int) {
  vfdParameterAuditLog(vfdDeviceId: $vfdDeviceId, parameterName: $parameterName, limit: $limit) {
    parameterName
    oldValue
    newValue
    action
    userId
    timestamp
    changeSetId
  }
}
```

#### `vfdPendingApprovalCount` Query

Pending approval count for the tenant.

```graphql
query PendingCount {
  vfdPendingApprovalCount
}
```

#### `vfdCurrentParameterValues` Query

Reads live parameter values from the device.

```graphql
query CurrentValues($vfdDeviceId: ID!, $parameterNames: [String!]!) {
  vfdCurrentParameterValues(vfdDeviceId: $vfdDeviceId, parameterNames: $parameterNames)
}
```

---

### 5.5 VFD Automation API

#### `vfdAutomationRules` Query

Lists all automation rules for the tenant.

```graphql
query AutomationRules {
  vfdAutomationRules {
    id
    name
    description
    triggerCondition
    targetVfdDeviceIds
    parameterChanges
    requiresApproval
    priority
    isActive
    lastTriggeredAt
    triggerCount
  }
}
```

#### `createVfdAutomationRule` Mutation

```graphql
mutation CreateRule($input: CreateVfdAutomationRuleInput!) {
  createVfdAutomationRule(input: $input) {
    id
    name
    isActive
    triggerCondition
    parameterChanges
  }
}
```

**Input Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| name | String | Yes | -- | Rule name |
| description | String | No | -- | Description |
| triggerCondition | JSON | Yes | -- | Trigger condition |
| targetVfdDeviceIds | [String] | Yes | -- | Target device IDs |
| parameterChanges | JSON | Yes | -- | Parameter changes |
| requiresApproval | Boolean | No | true | Whether approval is needed |
| priority | Int | No | 100 | Priority (lower = higher) |

**Authorization:** `TENANT_ADMIN` only

#### `toggleVfdAutomationRule` Mutation

```graphql
mutation ToggleRule($id: ID!, $isActive: Boolean!) {
  toggleVfdAutomationRule(id: $id, isActive: $isActive) {
    id
    isActive
  }
}
```

**Authorization:** `MODULE_MANAGER`, `TENANT_ADMIN`

#### `deleteVfdAutomationRule` Mutation

Soft-deletes a rule.

```graphql
mutation DeleteRule($id: ID!) {
  deleteVfdAutomationRule(id: $id)
}
```

**Authorization:** `TENANT_ADMIN`

---

### 5.6 Configuration Queries

```graphql
query Brands { vfdBrands }
query Protocols { vfdProtocols }

query Registers($brand: VfdBrand!, $modelSeries: String!) {
  vfdRegisterMappings(brand: $brand, modelSeries: $modelSeries) {
    parameterName
    displayName
    registerAddress
    dataType
    scalingFactor
    unit
    isCritical
    isBitField
    bitDefinitions
  }
}

query BrandCommands($brand: VfdBrand!) {
  vfdBrandCommands(brand: $brand)
}
```

---

## 6. Change Set Workflow Reference

### 6.1 Status State Machine

```
DRAFT ---[submit]--> PENDING_APPROVAL ---[approve]--> APPROVED ---[apply]--> APPLYING ---[success]--> APPLIED ---[verify]--> VERIFIED
                                      \                                                             \
                                       ---[reject]--> REJECTED                                       ---[fail]--> FAILED
                                                                                                                    \
                                                                                                                     ---[rollback]--> ROLLED_BACK
                                                                                                    APPLIED/VERIFIED ---[rollback]--> ROLLED_BACK
```

### 6.2 Role Requirements

| Action | Required Role | Notes |
|--------|-------------|-------|
| Create change set (Maker) | MODULE_MANAGER, TENANT_ADMIN | -- |
| Edit draft change set | MODULE_MANAGER, TENANT_ADMIN | Only the creator or admins |
| Submit for approval | MODULE_MANAGER, TENANT_ADMIN | Only DRAFT status |
| Approve (Checker) | TENANT_ADMIN | Cannot be the same person as the Maker |
| Reject | TENANT_ADMIN | Must provide rejection reason |
| Standard rollback | MODULE_MANAGER, TENANT_ADMIN | Creates a new change set with previous values |
| Emergency rollback | MODULE_MANAGER, TENANT_ADMIN | Bypasses approval process, logged as emergency_override |

### 6.3 Scheduling Options

Change sets can be scheduled for future application:
- Date and time selector before submission
- Useful for maintenance windows (e.g., 02:00 AM, weekends)
- Scheduled change sets still require approval before the scheduled time

### 6.4 Rollback Procedure

**Standard Rollback:**
1. Select the change set to roll back (must be APPLIED or VERIFIED)
2. System creates a new change set with the original values
3. New change set goes through normal Maker-Checker approval
4. Original change set is linked via `rollbackOfId`

**Emergency Rollback:**
1. Bypasses Maker-Checker approval process
2. Requires MODULE_MANAGER or TENANT_ADMIN
3. Mandatory reason field
4. Logged as `emergency_override` in audit log
5. Subject to later review

---

## 7. Automation Rules Reference

### 7.1 Trigger Condition Syntax

```json
{
  "conditions": [
    { "sensorTag": "water_temperature", "operator": "<", "value": 15.0 },
    { "sensorTag": "ph_level", "operator": ">", "value": 7.5 }
  ],
  "logic": "AND"
}
```

### 7.2 Available Trigger Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `>` | Greater than | temperature > 28.0 |
| `<` | Less than | dissolved_oxygen < 5.0 |
| `>=` | Greater than or equal | pressure >= 3.0 |
| `<=` | Less than or equal | flow_rate <= 10.0 |
| `==` | Equals | status == "active" |
| `!=` | Not equals | status != "offline" |

**Logical combination:** `AND` (all conditions must be true) or `OR` (any condition must be true)

### 7.3 Parameter Change Format

```json
{
  "changes": [
    { "parameterName": "accel_time_1", "value": 15.0 },
    { "parameterName": "max_frequency", "value": 40.0 }
  ]
}
```

### 7.4 Execution Flow

1. NATS message broker delivers sensor readings
2. Automation engine evaluates trigger conditions
3. If conditions met and cooldown has elapsed: create change set
4. If `requiresApproval: true`: submit for Checker approval
5. If `requiresApproval: false`: apply directly to VFD
6. Update rule statistics (trigger count, last triggered time)

### 7.5 Error Handling

- **3 consecutive failures:** Rule is automatically deactivated
- **Deactivation notification:** Alarm sent to administrators
- **Manual reactivation required:** After investigating the cause
- **Priority conflict resolution:** Lower priority number wins; losing rule is skipped and logged
- **Conflicting rules:** Administrator notification sent

---

## 8. Risk Evaluation Rules

### 8.1 Risk Level Scores

| Level | Score | Description |
|-------|-------|-------------|
| LOW | 10 | Non-critical parameters (jog frequency, communication settings) |
| MEDIUM | 40 | Operational parameters changeable during runtime (ramp times, PID) |
| HIGH | 70 | Performance-critical, may require motor stop (motor nameplate, V/f curve) |
| CRITICAL | 100 | Safety-impacting, equipment damage risk (excessive acceleration, protection disable) |

### 8.2 Complete Risk Rules Table (30 Rules)

| Parameter Pattern | Base Risk | Escalation Condition | Escalated Risk | Motor Stop | Reason |
|-------------------|-----------|---------------------|----------------|------------|--------|
| `accel_time_*` | MEDIUM | Value < 1.0 s | CRITICAL | No | Acceleration < 1s causes mechanical shock, coupling damage, overcurrent trip |
| `decel_time_*` | MEDIUM | Value < 0.5 s | CRITICAL | No | Deceleration < 0.5s causes DC bus overvoltage and regenerative fault |
| `max_frequency` | HIGH | Value > 60 Hz | CRITICAL | No | Exceeding 60Hz nameplate frequency can damage bearings, windings, or connected equipment |
| `thermal_protection_mode` | HIGH | Value = 0 (Off) | CRITICAL | No | Disabling thermal protection removes overcurrent and overheating safety |
| `current_limit_percent` | MEDIUM | Value > 200% | HIGH | No | Current limit exceeding 200% of nominal exceeds motor thermal capacity |
| `motor_voltage_nom` | HIGH | -- | -- | Yes | Motor nameplate voltage change requires motor stop and auto-tune |
| `motor_current_nom` | HIGH | -- | -- | Yes | Motor nameplate current change requires motor stop and auto-tune |
| `motor_power_nom` | HIGH | -- | -- | Yes | Motor nameplate power change requires motor stop and auto-tune |
| `motor_speed_nom` | HIGH | -- | -- | Yes | Motor nameplate speed change requires motor stop and auto-tune |
| `motor_cos_phi` | HIGH | -- | -- | Yes | Motor power factor change requires motor stop and auto-tune |
| `vf_curve_mode` | HIGH | -- | -- | Yes | V/f curve change affects motor control method |
| `voltage_boost` | HIGH | -- | -- | Yes | Voltage boost change affects low-speed torque behavior |
| `slip_compensation` | HIGH | -- | -- | Yes | Slip compensation change affects speed regulation |
| `min_frequency` | MEDIUM | -- | -- | No | Minimum frequency affects low-speed operating range |
| `torque_limit_*` | MEDIUM | -- | -- | No | Torque limit affects motor loading behavior |
| `pid_*` | MEDIUM | -- | -- | No | PID controller parameters affect process control stability |
| `s_curve_*` | MEDIUM | -- | -- | No | S-curve settings affect ramp smoothness |
| `skip_freq_*` | MEDIUM | -- | -- | No | Skip frequency prevents mechanical resonance |
| `skip_band` | MEDIUM | -- | -- | No | Skip frequency band width |
| `stall_detection` | MEDIUM | -- | -- | No | Stall detection affects motor protection response |
| `jog_*` | LOW | -- | -- | No | Jog parameters only affect manual jog operation |
| `modbus_address` | LOW | -- | -- | No | Communication address -- non-critical |
| `baudrate_*` | LOW | -- | -- | No | Communication baud rate -- non-critical |
| `response_delay` | LOW | -- | -- | No | Communication response delay -- non-critical |
| `di_*_function` | LOW | -- | -- | No | Digital input function assignment |
| `do_*_function` | LOW | -- | -- | No | Digital output function assignment |
| `relay_*_function` | LOW | -- | -- | No | Relay output function assignment |

### 8.3 Batch Risk Aggregation

When a change set contains multiple parameter changes, the overall risk level is the **maximum** of all individual risk levels. For example, if a change set contains one LOW change and one HIGH change, the overall risk is HIGH.

### 8.4 Override Procedures

- Standard risk evaluation cannot be overridden by users
- Emergency rollback bypasses the Maker-Checker process but does NOT bypass risk evaluation
- All risk escalations and overrides are recorded in the audit log

---

## 9. Edge Gateway Integration

### 9.1 Communication Flow

The edge gateway is a local device installed at the fish farm facility. It acts as a translator between the cloud platform (which speaks IP/NATS) and the physical VFDs (which speak Modbus, Profinet, etc.).

```
Cloud Platform ---[NATS/MQTT over internet]--> Edge Gateway ---[Modbus RTU/TCP]--> VFD
```

### 9.2 Offline Queue Behavior

When the internet connection between the cloud platform and the edge gateway is interrupted:
- Monitoring data is queued locally on the edge gateway
- When connection is restored, queued data is sent to the cloud in chronological order
- Commands from the cloud are also queued and delivered when connection is restored
- Emergency stop commands have highest priority in the queue

### 9.3 Retry Logic

For failed register reads/writes:
- Default retry count: 3 attempts
- Retry delay: configurable per protocol (default: 100ms between retries)
- If all retries fail, the operation is marked as failed and reported to the cloud

### 9.4 Data Quality Indicators

Each reading from the edge gateway includes a quality indicator:
- **Good:** Value was read successfully within the expected time
- **Uncertain:** Value was read but with retries or slight delay
- **Bad:** Value could not be read (communication error)
- **Stale:** Value has not been updated within the expected polling interval

---

## 10. Glossary

| Term | Description |
|------|-------------|
| **VFD (Variable Frequency Drive)** | A power electronics device that controls AC motor speed by varying the frequency and voltage of the electrical supply. Also called "inverter," "drive," or "frequency converter." |
| **Inverter** | Synonymous with VFD. Technically refers to the circuit that converts DC to AC. |
| **Control Word** | A 16-bit register used to send commands to the VFD. Each bit represents a different command. |
| **Status Word** | A 16-bit register that reports the VFD's current state. Each bit represents a different status. |
| **Register** | An addressable memory location inside the VFD. Parameters are read from and written to register addresses. |
| **Modbus** | An industrial communication protocol. Comes in two variants: RTU (serial) and TCP (Ethernet). |
| **Slave ID / Unit ID** | A unique address (1-247) assigned to each device on a Modbus network. |
| **Baud Rate** | Serial communication speed in bits per second. Common values: 9600, 19200, 38400. |
| **Parity** | Error detection method in serial communication. Options: None, Even, Odd. |
| **RS-485** | An electrical standard for serial communication, using differential signaling on two wires. Supports long cable runs and multiple devices. |
| **Soft Start** | Gradually accelerating a motor from zero to target speed. Limits startup current and reduces mechanical stress. |
| **Ramp** | The gradual acceleration (ramp-up) or deceleration (ramp-down) of a motor over a configurable time period. |
| **PID** | Proportional-Integral-Derivative controller. An algorithm that automatically adjusts motor speed to maintain a process variable at a setpoint. |
| **V/f (Volts/Frequency)** | The voltage-to-frequency ratio. Defines the voltage the motor receives at different frequencies. |
| **Nameplate** | The metal label on a motor showing its electrical ratings: nominal power, voltage, current, speed, and power factor. |
| **Maker-Checker** | A dual-approval process (four-eyes principle) where one person proposes a change (Maker) and a different person approves it (Checker). Required by IEC 62443 SL-2. |
| **Change Set** | A group of one or more parameter changes managed as a single unit. Goes through the Maker-Checker approval process. |
| **Rollback** | Reversing an applied change by restoring the previous parameter values. |
| **Risk Level** | A classification of how dangerous a parameter change could be: LOW (10), MEDIUM (40), HIGH (70), CRITICAL (100). |
| **Audit Trail** | A permanent, immutable record of every parameter change -- who changed what, when, and why. Cannot be deleted or modified. |
| **Polling** | Periodically reading parameter values from the VFD at configurable intervals. |
| **Trip** | When the VFD stops the motor due to a detected fault condition. |
| **Cooldown** | The minimum time that must elapse before an automation rule can trigger again. |
| **Auto-Tune** | A process where the VFD measures the connected motor's electrical characteristics and calculates optimal control parameters. |
| **Regenerative** | When a motor acts as a generator, sending energy back to the VFD's DC bus. Occurs during rapid deceleration. |
| **Water Hammer** | A dangerous pressure surge in piping caused by suddenly stopping a pump. Can damage pipes, valves, and fittings. |
| **CiA402** | A standardized drive profile (CANopen drive profile) defining control word and status word formats. Used by ABB, Schneider, and others. |
| **PROFIdrive** | A standardized drive profile for Profibus/Profinet. Used primarily by Siemens. |
| **Edge Gateway** | A local device at the facility that translates between cloud protocols (NATS/MQTT) and VFD protocols (Modbus, Profinet, etc.). |
| **NATS** | A lightweight messaging system used for asynchronous communication between platform services and edge gateways. |
| **TimescaleDB** | A PostgreSQL extension optimized for time-series data. Used to store VFD readings history. |
| **GraphQL** | A query language for APIs. Used by this platform for all VFD operations (queries and mutations). |
| **RBAC** | Role-Based Access Control. Users are assigned roles (VIEWER, OPERATOR, MODULE_MANAGER, TENANT_ADMIN) that determine their permissions. |
| **SCADA** | Supervisory Control and Data Acquisition. A system for monitoring and controlling industrial equipment through visual dashboards. |

---

### Enum Reference

**VfdBrand:** `danfoss`, `abb`, `siemens`, `schneider`, `yaskawa`, `delta`, `mitsubishi`, `rockwell`

**VfdProtocol:** `modbus_rtu`, `modbus_tcp`, `profibus_dp`, `profinet`, `ethernet_ip`, `canopen`, `bacnet_ip`, `bacnet_mstp`

**VfdParameterCategory:** `status`, `motor`, `energy`, `thermal`, `fault`, `control`, `configuration`

**VfdParameterGroup:** `ramp_times`, `frequency_limits`, `motor_nameplate`, `current_limits`, `vf_control`, `pid_controller`, `digital_io`, `communication`, `protection`, `jog`, `advanced`

**VfdDeviceStatus:** `draft`, `pending_test`, `testing`, `test_failed`, `active`, `suspended`, `offline`

**VfdChangeSetStatus:** `draft`, `pending_approval`, `approved`, `applying`, `applied`, `verified`, `rejected`, `failed`, `rolled_back`

**RiskLevel:** `low` (10), `medium` (40), `high` (70), `critical` (100)

**VfdDataType:** `uint16`, `int16`, `uint32`, `int32`, `float32`, `control_word`, `status_word`

**VfdCommandType:** `start`, `stop`, `reverse`, `set_frequency`, `set_speed`, `fault_reset`, `quick_stop`, `emergency_stop`, `jog_forward`, `jog_reverse`, `coast_stop`

---

### Data Types and Scaling Reference

**Register Data Types:**

| Type | Size | Range | Registers | Description |
|------|------|-------|-----------|-------------|
| UINT16 | 16 bits | 0 to 65535 | 1 | Unsigned integer |
| INT16 | 16 bits | -32768 to 32767 | 1 | Signed integer |
| UINT32 | 32 bits | 0 to 4294967295 | 2 | Unsigned large integer |
| INT32 | 32 bits | -2147483648 to 2147483647 | 2 | Signed large integer |
| FLOAT32 | 32 bits | IEEE 754 | 2 | Floating point |
| CONTROL_WORD | 16 bits | Bit field | 1 | Control command bit field |
| STATUS_WORD | 16 bits | Bit field | 1 | Status information bit field |

**Scaling Formulas:**

Raw value to engineering value:
```
Engineering Value = Raw Value x Scale Factor + Offset
```

Engineering value to raw value:
```
Raw Value = (Engineering Value - Offset) / Scale Factor
```

**Scaling Examples:**

| Parameter | Raw Value | Scale | Result |
|-----------|-----------|-------|--------|
| Output Frequency (Danfoss) | 500 | x0.1 | 50.0 Hz |
| Motor Current (ABB) | 1250 | x0.01 | 12.50 A |
| Output Frequency (Siemens) | 5000 | x0.01 | 50.00 Hz |
| Heatsink Temp (Mitsubishi) | 453 | x0.1 | 45.3 C |

**Write Example:**
```
Target: Set 35.5 Hz frequency on Danfoss (scale x0.1)
Raw Value = 35.5 / 0.1 = 355
Write value 355 (0x0163) to the register
```

**Byte Order:**
- **Big Endian** (standard Modbus): Most significant byte first. Example: 0x1234 -> [0x12, 0x34]
- **Little Endian:** Least significant byte first. Some brands use this order.
- **Word Order (32-bit values):** Standard is high word first (AB CD). Some brands use low word first (CD AB). Delta uses separate low/high word registers for kWh counter.

---

### Platform Error Codes

| Code | Description | Probable Cause | Resolution |
|------|-------------|---------------|------------|
| CONNECTION_TIMEOUT | Connection timed out | Cable disconnected, wrong address, drive powered off | Check cabling and address configuration |
| CRC_ERROR | CRC error | Electrical noise, wrong baud rate/parity settings | Check cabling, termination, and serial settings |
| NO_RESPONSE | No response from device | Wrong slave address, device busy | Verify slave address and communication protocol |
| REGISTER_NOT_WRITABLE | Register is not writable | Read-only parameter | Check parameter definition |
| READBACK_MISMATCH | Read-back value does not match | Value out of bounds, drive rejected | Check min/max limits |
| MAKER_CHECKER_VIOLATION | Same user created and approved | Four-eyes principle violation | Use a different user for approval |
| CONCURRENT_CHANGESET | Another change set is in progress | Only one active change set per device | Complete or cancel the existing change set |

---

*This reference guide was generated from the `apps/sensor-service/src/vfd/` source code.*
*Last updated: 2026-03-27*
