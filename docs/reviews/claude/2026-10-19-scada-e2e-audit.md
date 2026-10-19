# SCADA end-to-end audit (2026-10-19)

**Scope.** The SCADA path an operator uses to get a process running on a field device: the SCADA Builder (`/sensor/scada-packages`, `/sensor/scada-builder/*`), its links to tags, edge devices and automation programs (`/sensor/automation/*`), simulation, deploy, the cloud operator runtime (`/sensor/scada/operator/*`) and the edge HMI and agent (`sens-api-gateway`). Edge-device provisioning and online status were audited elsewhere and are out of this file except where a SCADA defect depends on them.

**Method.** Ten stage auditors (lifecycle, canvas and widgets, placement, connections, binding, simulation, settings, deploy, edit and delete, journey and tests) and two seam auditors (automation program path, cloud-to-edge transport) read the code on both sides of every seam (writer and reader, producer and consumer) and reported findings with `file:line` evidence. Each of the ten stages was then re-checked by an independent adversarial verifier whose instruction was to refute every finding; a completeness critic named the remaining gaps and two gap investigators covered them. 259 raw findings were merged into 91 canonical findings below. Verifier verdicts over the raw findings: CONFIRMED 152, PARTIAL 43, SELF 64 (SELF = verified by the reporting auditor by reading both sides or running code, not by a second agent). No raw finding was refuted. Where a verifier corrected a claim or a severity, the corrected text is the one used here. Findings marked "re-checked in session" were additionally re-read against the code by the session lead.

**Registry.** Every canonical finding is registered in `docs/reviews/_registry/findings.jsonl` under the id used as its heading, with owner `Okan-wqm`, the deadline of its plan phase, and the remediation plan at `docs/plans/2026-10-19-scada-e2e-rebuild/PLAN.md`.

**Severity.** CRITICAL 18, HIGH 42, MEDIUM 24, LOW 7.

## Index

| ID                                          | Severity | Plan phase | Title                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [SENSOR-CRITICAL-269](#sensor-critical-269) | CRITICAL | F3         | Automation programs created in the UI can never be approved: submitForReview requires SFC steps but the editor renders no Steps/Transitions tab, so Deploy is never enabled                                                                                                                                                    |
| [SENSOR-CRITICAL-270](#sensor-critical-270) | CRITICAL | F3         | Structured Text is never compiled or shipped: the cloud compiler is a mock that always succeeds, the RUST_ENGINE payload is built only from SFC steps (startup trigger + noop), and ADR-017 deploy_program{format:stbc} is unimplemented on the cloud side                                                                     |
| [SENSOR-CRITICAL-271](#sensor-critical-271) | CRITICAL | F1         | Device replies are never correlated: deploy/bundle acks are routed on a payload.command field the edge never sends (and rejections without bundleId are dropped), so deploy logs stay SENT, bundles stay PENDING/STAGED and programs time out as "no response"                                                                 |
| [EDGE-CRITICAL-072](#edge-critical-072)     | CRITICAL | F1         | Edge ST/bytecode VM has no output stage: program writes update only the in-memory ProcessImage and never reach GPIO/Modbus/I2C, outputs are never read back (seal-in logic faults), and forces neither drive the field nor survive the next scan                                                                               |
| [EDGE-HIGH-067](#edge-high-067)             | HIGH     | F3         | Edge fallback license enforces a 5000 ms minimum scan cycle and no license or verifying key is ever provisioned, so the default 100 ms program scan cycle is rejected                                                                                                                                                          |
| [EDGE-HIGH-068](#edge-high-068)             | HIGH     | F1         | Release edge binary is built without the gpio feature and cloud-defined GPIO tags never reach the GPIO actor (built only from config.yaml gpio[], which the installer writes empty), so no Raspberry Pi pin can be driven                                                                                                      |
| [EDGE-HIGH-069](#edge-high-069)             | HIGH     | F3         | Edge JSON script engine barely runs delivered programs: function blocks configured only at init, MANUAL mode never runs FBs, fb:-prefixed trigger sources unresolved, startup triggers hard-coded false                                                                                                                        |
| [SENSOR-HIGH-272](#sensor-high-272)         | HIGH     | F1         | Installer-written config.yaml sets neither signature_mode nor mtls.mode, and release builds refuse to boot with the Disabled/Legacy defaults                                                                                                                                                                                   |
| [EDGE-HIGH-070](#edge-high-070)             | HIGH     | F3         | Edge ST compiler cannot compile ordinary control programs: rejects >, >=, <=, <>, MOD, XOR, every IEC function block (TON/TOF/R_TRIG/CTU), TIME/STRING literals and STRING/ARRAY variables                                                                                                                                     |
| [EDGE-HIGH-071](#edge-high-071)             | HIGH     | F3         | Edge VM ignores declared initial values and starts every INT/REAL local as Bool(false)                                                                                                                                                                                                                                         |
| [EDGE-HIGH-073](#edge-high-073)             | HIGH     | F1         | Edge VM tag type map is built once at boot from the (empty) catalog, so every BOOL/INT tag write is rejected with TypeMismatch                                                                                                                                                                                                 |
| [SENSOR-HIGH-274](#sensor-high-274)         | HIGH     | F3         | Program I/O bound to device A is resolved with no device check, so deploying the program to device B drives device A's pins and Modbus tags                                                                                                                                                                                    |
| [SENSOR-HIGH-275](#sensor-high-275)         | HIGH     | F3         | Program outputs bound to Modbus or I2C channels can never actuate (register and slave discarded), and changing a channel requires delete and re-add, silently detaching program bindings                                                                                                                                       |
| [SENSOR-MEDIUM-273](#sensor-medium-273)     | MEDIUM   | F3         | PLC_SETPOINT deploy target sends no setpoints; the edge rejects it with "Missing setpoints"                                                                                                                                                                                                                                    |
| [EDGE-MEDIUM-074](#edge-medium-074)         | MEDIUM   | F1         | Four divergent tag-to-hardware write paths on the edge: analog HMI writes double-scaled, set_output writes every Modbus tag as a coil, different scaling and quality rules per path                                                                                                                                            |
| [EDGE-MEDIUM-075](#edge-medium-075)         | MEDIUM   | F1         | A failing bytecode program is retried on every scan indefinitely with only a device-log warning                                                                                                                                                                                                                                |
| [EDGE-MEDIUM-076](#edge-medium-076)         | MEDIUM   | F1         | Event-driven bytecode tasks never wake on field input changes (GPIO, Modbus, I2C reads bypass the change notification)                                                                                                                                                                                                         |
| [SENSOR-CRITICAL-276](#sensor-critical-276) | CRITICAL | F1         | Edge rejects every deploy command at the two-person-integrity gate: the cloud publishes only unsigned JSON, the envelope signer is not wired, nested deploy params cannot be canonicalised, and no RBAC manifest or co-approval flow exists                                                                                    |
| [INFRA-CRITICAL-238](#infra-critical-238)   | CRITICAL | F1         | SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX is not provisioned in any deployment (compose, env examples, helm, runbooks), so every bundle deploy is refused in production                                                                                                                                                               |
| [SENSOR-CRITICAL-277](#sensor-critical-277) | CRITICAL | F1         | Provisioning never delivers the deploy-signing public key to the device, so cmd_deploy_bundle always fails with "firmware_signing_pubkey not wired"                                                                                                                                                                            |
| [SENSOR-CRITICAL-280](#sensor-critical-280) | CRITICAL | F3         | Linking an automation program to a SCADA package breaks deploy: the builder's deploy never ships linked programs yet requires them approved, and deploy-time binding validation reads a flat shape the builder never writes                                                                                                    |
| [SENSOR-HIGH-278](#sensor-high-278)         | HIGH     | F1         | Every deploy and push reports success on broker publish, not on device confirmation (SCADA deploy, program deploy, bundle "staged", IO config "Cihaza Gonder"), and the server's stripped-widgets note is discarded                                                                                                            |
| [SENSOR-HIGH-279](#sensor-high-279)         | HIGH     | F6         | Cloud runtime and package status follow the latest SAVED draft, not the deployed revision: "Published vN", cloud alarms and scripts change on save, saves never reload the runtime, and deleting any package switches off the whole tenant runtime                                                                             |
| [EDGE-HIGH-077](#edge-high-077)             | HIGH     | F1         | Edge stores the cloud package version as the SQLite PRIMARY KEY, so redeploying the same version, any rollback or a bundle pre-image restore fails                                                                                                                                                                             |
| [SENSOR-MEDIUM-281](#sensor-medium-281)     | MEDIUM   | F6         | SCADA rollback and deploy history are unreachable from the UI, and rollback bypasses the publish-boundary checks                                                                                                                                                                                                               |
| [SENSOR-MEDIUM-282](#sensor-medium-282)     | MEDIUM   | F1         | Publish contract accepts numbers (fractional/negative positions, delays, trend values) that the edge's u32 fields reject, so one bad number fails the whole package on the device                                                                                                                                              |
| [SENSOR-MEDIUM-283](#sensor-medium-283)     | MEDIUM   | F1         | A failed bundle attempt moves programs to DEPLOYING outside the bundle transaction and blocks an immediate retry for 5 minutes                                                                                                                                                                                                 |
| [SENSOR-MEDIUM-284](#sensor-medium-284)     | MEDIUM   | F1         | Bundles inline every artifact in one MQTT message with no size check against the edge's 1 MiB packet cap                                                                                                                                                                                                                       |
| [SENSOR-CRITICAL-285](#sensor-critical-285) | CRITICAL | F1         | Cloud SCADA (builder preview and operator) subscribes by device-local tag name while the only producer publishes registry FQNs, so no live value ever arrives                                                                                                                                                                  |
| [SENSOR-CRITICAL-286](#sensor-critical-286) | CRITICAL | F1         | Edge device I/O values never enter the cloud /scada live plane; the registry live link only reaches sensor channels                                                                                                                                                                                                            |
| [SENSOR-CRITICAL-287](#sensor-critical-287) | CRITICAL | F1         | No SCADA control write from the browser reaches a device: bare names rejected, registered FQNs hit an event with no listener, the ACK is read as failure, setDigitalOutput sends a boolean the edge rejects, and widget commands (setValue, emergencyStop, vfd:\*) have no consumer                                            |
| [EDGE-CRITICAL-078](#edge-critical-078)     | CRITICAL | F2         | Edge HMI binds every widget through config.tag, but every builder config panel writes config.tagName, so no widget on the device shows a value                                                                                                                                                                                 |
| [EDGE-CRITICAL-079](#edge-critical-079)     | CRITICAL | F1         | Edge tag catalog is empty after every restart (io_config.yaml written but never read back), cloud DeviceIoConfig never creates or reconfigures a GPIO/Modbus/I2C driver, and nothing checks that bound tags exist on the device                                                                                                |
| [EDGE-CRITICAL-081](#edge-critical-081)     | CRITICAL | F1         | Edge agent rejects the edge HMI's confirm, PIN and alarm-ack replies (and the calibration confirm action), so no control write, E-STOP or alarm ack executes from the device screen                                                                                                                                            |
| [SENSOR-HIGH-288](#sensor-high-288)         | HIGH     | F1         | Widget binding has no single source of truth (tag, tagName, tagRef, variable keys): a stale tagRef shadows every rebind, device changes and Clear Binding do not update it, Bind overwrites device tags, and Auto-Bind records a key the widget never reads                                                                    |
| [SENSOR-HIGH-289](#sensor-high-289)         | HIGH     | F4         | Tag sourcing blocks design: the builder binds only to the selected device's DeviceIoConfig rows, draft/virtual tags cannot be created (DRAFT unreachable), device pickers truncate at 20/50, and typed tag names are discarded                                                                                                 |
| [EDGE-HIGH-080](#edge-high-080)             | HIGH     | F1         | Edge HMI writes to Modbus tags always go to the first configured Modbus device, ignoring the tag's slave_id                                                                                                                                                                                                                    |
| [EDGE-HIGH-082](#edge-high-082)             | HIGH     | F2         | Edge HMI renders only with internet access: React, ReactFlow and Recharts load from CDNs and the offline service worker can never install                                                                                                                                                                                      |
| [EDGE-MEDIUM-083](#edge-medium-083)         | MEDIUM   | F1         | Edge HMI funnels all WebSocket traffic through one lastMessage state with a no-op re-render scheduler: values render one message late and bursts can drop                                                                                                                                                                      |
| [EDGE-MEDIUM-085](#edge-medium-085)         | MEDIUM   | F6         | Edge calibration never works end to end: the engine receives no sensor reading or reference values and the builder writes sensors as strings where the edge HMI expects objects                                                                                                                                                |
| [EDGE-LOW-084](#edge-low-084)               | LOW      | F1         | Securing the edge HMI for LAN use locks the HMI page out, and hostname URLs are rejected                                                                                                                                                                                                                                       |
| [SENSOR-CRITICAL-290](#sensor-critical-290) | CRITICAL | F2         | Cloud operator runtime renders no widgets: the OperatorView registry is never populated, every widget is a "?" box, laid out on a 40x40 grid instead of the builder's 120x100                                                                                                                                                  |
| [SENSOR-CRITICAL-291](#sensor-critical-291) | CRITICAL | F2         | Pipes, background image, hidden flag, z-order and transforms exist only in the builder canvas: no runtime (cloud operator, popups, edge HMI) renders screen.edges or applies them                                                                                                                                              |
| [SENSOR-CRITICAL-292](#sensor-critical-292) | CRITICAL | F2         | 56% of palette entries, including every P&ID equipment symbol and the built-in demo, are reject-class at the publish boundary and make deploy fail; invariant tests enshrine this palette as the contract                                                                                                                      |
| [SENSOR-HIGH-294](#sensor-high-294)         | HIGH     | F4         | Several widgets show hard-coded demo data outside edit mode that looks like real readings                                                                                                                                                                                                                                      |
| [SENSOR-HIGH-295](#sensor-high-295)         | HIGH     | F4         | Equipment widgets misrepresent state: "Demo Status" permanently overrides the live tag, 4 valve types can never show open, tanks/feeder show >=90% full, P&ID tanks draw a fixed fill, and clicking analog equipment in simulation overwrites its value with a boolean                                                         |
| [SENSOR-HIGH-298](#sensor-high-298)         | HIGH     | F1         | E-STOP is unsafe end to end: hold time written in ms but multiplied by 1000 on the edge, edge E-STOP zeroes only "affected tags" (default none) while the dialog promises all outputs, and reset PIN is ignored/accepts any PIN                                                                                                |
| [SENSOR-HIGH-299](#sensor-high-299)         | HIGH     | F2         | Events, Animations and Permissions are saved in a format no runtime reads; builder animations freeze at mount; a Set Property event wipes the target widget's config and fires while editing; dialog/card overlays are non-interactive; pasted events keep original references                                                 |
| [SENSOR-HIGH-300](#sensor-high-300)         | HIGH     | F4         | ProcessView widget is a static 3-tank placeholder and "create SCADA package from process" imports an empty process                                                                                                                                                                                                             |
| [SENSOR-MEDIUM-293](#sensor-medium-293)     | MEDIUM   | F2         | Edge HMI lays screens out as a fixed 12x8 grid of 1fr cells while the builder canvas is unbounded 120x100 px cells, distorting or clipping layouts                                                                                                                                                                             |
| [SENSOR-MEDIUM-296](#sensor-medium-296)     | MEDIUM   | F2         | Widget config keys drift from renderers: keys panels write that no renderer reads (and vice versa), expression bindings never evaluated, multi-tag widgets never live, VFD Group unconfigurable, PushButton value stored as string the edge rejects                                                                            |
| [SENSOR-MEDIUM-297](#sensor-medium-297)     | MEDIUM   | F2         | All 50 FUXA catalog widgets render empty: catalogId is stored but no loader fetches the SVG                                                                                                                                                                                                                                    |
| [SENSOR-HIGH-301](#sensor-high-301)         | HIGH     | F4         | Undo/Redo can never work in any SCADA editor: nothing ever pushes history, buttons are dead or no-ops, so deleted equipment and pipes cannot be restored                                                                                                                                                                       |
| [SENSOR-HIGH-302](#sensor-high-302)         | HIGH     | F4         | Store-driven position changes (align/distribute, Properties X/Y) never move an existing node on the canvas; the next drag overwrites them                                                                                                                                                                                      |
| [SENSOR-HIGH-303](#sensor-high-303)         | HIGH     | F4         | Selection split-brain between React Flow and the store: shift-click empties selection, box-select keeps one widget, invisible store-only selections still receive Delete (across screens), locked/hidden widgets deleted, group clicks open the wrong widget                                                                   |
| [SENSOR-HIGH-304](#sensor-high-304)         | HIGH     | F4         | Equipment geometry makes straight connections impossible: canvas height comes from the SVG aspect ratio (not the stored size) while snapping is 100 px rows, so mating ports of adjacent equipment can never be collinear; sub-cell positions and resizes are silently rounded; ports of process widgets float off the drawing |
| [SENSOR-HIGH-305](#sensor-high-305)         | HIGH     | F4         | Rotating equipment rotates only the artwork; ports and node box stay unrotated, so pipes attach to the wrong side                                                                                                                                                                                                              |
| [SENSOR-HIGH-306](#sensor-high-306)         | HIGH     | F4         | Pipe model is geometric, not topological: orthogonal/bezier/polyline routes freeze to absolute bend points and stop following equipment, routing ignores port side, bends stay editable in preview, and line-type clicks erase custom routes                                                                                   |
| [SENSOR-MEDIUM-307](#sensor-medium-307)     | MEDIUM   | F4         | Pipe flow animation is a static checkbox, not derived from pump or valve state                                                                                                                                                                                                                                                 |
| [SENSOR-MEDIUM-310](#sensor-medium-310)     | MEDIUM   | F4         | Destructive edits are unsafe: deleting a screen leaves dangling links/events/bindings, one-click destructive actions lack confirmation, and global shortcuts are unscoped (Delete inside dialogs deletes the widget behind)                                                                                                    |
| [SENSOR-LOW-308](#sensor-low-308)           | LOW      | F4         | Connection model gaps: no reconnect of a pipe end, "signal lines" without signal ports, unlimited pipes per nozzle                                                                                                                                                                                                             |
| [SENSOR-LOW-309](#sensor-low-309)           | LOW      | F4         | Layout aids are broken: z-order buttons change nothing, smart guides and rulers ignore pan/zoom, click-to-add/paste stack at (2,2), Focus on Selection does nothing                                                                                                                                                            |
| [SENSOR-HIGH-311](#sensor-high-311)         | HIGH     | F4         | Unsaved SCADA work is silently discarded on in-app navigation (builder has only beforeunload; unified editor has no guard; a singleton store is reset/rehydrated by other pages)                                                                                                                                               |
| [SENSOR-HIGH-312](#sensor-high-312)         | HIGH     | F4         | When a package fails to load, the builder shows the previous package under the new id and Save overwrites the new package with it                                                                                                                                                                                              |
| [SENSOR-HIGH-313](#sensor-high-313)         | HIGH     | F4         | Deploy ships the stale server version when the pre-deploy save fails or is skipped, while the preview shows the unsaved local document                                                                                                                                                                                         |
| [SENSOR-HIGH-314](#sensor-high-314)         | HIGH     | F4         | Images embedded as base64 (stored twice) and the subgraph body limit make package saves fail                                                                                                                                                                                                                                   |
| [SENSOR-HIGH-315](#sensor-high-315)         | HIGH     | F4         | Opening a saved package with an empty store appends an empty "Screen 1", switches to it and marks the package dirty                                                                                                                                                                                                            |
| [SENSOR-HIGH-318](#sensor-high-318)         | HIGH     | F4         | Builder and unified editor create disjoint, mutually unreadable packages for the same plant (P&ID and HMI are unrelated drawings); delete only archives and deleted HMIs are re-adopted                                                                                                                                        |
| [SENSOR-MEDIUM-316](#sensor-medium-316)     | MEDIUM   | F4         | Save and delete failures discard or hide the server's reason                                                                                                                                                                                                                                                                   |
| [SENSOR-MEDIUM-317](#sensor-medium-317)     | MEDIUM   | F4         | No optimistic concurrency (last writer wins across tabs, editors and engineers), and edits made during an in-flight save are marked clean without being saved                                                                                                                                                                  |
| [SENSOR-MEDIUM-320](#sensor-medium-320)     | MEDIUM   | F4         | Export/import and templates lose data: screen JSON drops most fields, widget templates are memory-only, PDF export is invalid                                                                                                                                                                                                  |
| [SENSOR-MEDIUM-323](#sensor-medium-323)     | MEDIUM   | F5         | Simulation state survives Reset All, leaving and re-entering simulation, and leaks into the next package opened                                                                                                                                                                                                                |
| [SENSOR-LOW-319](#sensor-low-319)           | LOW      | F4         | Package list silently shows only the 20 most recent packages, and search replaces the page with a spinner                                                                                                                                                                                                                      |
| [SENSOR-LOW-321](#sensor-low-321)           | LOW      | F4         | Unreachable or no-op builder features presented as working (Recipe/Translations/DAQ/TagWatch panels never mounted, Publish to Cloud, status bar always Draft v1, placeholder unified-editor modes)                                                                                                                             |
| [SENSOR-LOW-322](#sensor-low-322)           | LOW      | F4         | The saved target device is ignored by the Deploy dialog                                                                                                                                                                                                                                                                        |
| [SENSOR-CRITICAL-324](#sensor-critical-324) | CRITICAL | F3         | Builder simulation "Run" feeds the program identifier (programCode) to the ST parser instead of the source, so no linked automation program ever runs in simulation and nothing tells the user                                                                                                                                 |
| [SENSOR-HIGH-325](#sensor-high-325)         | HIGH     | F5         | No builder alarm can fire in simulation (Alarm tab writes >,<,== while the evaluator knows gt/lt/eq), and the alarm banner shows configured rule counts as active alarms                                                                                                                                                       |
| [SENSOR-HIGH-326](#sensor-high-326)         | HIGH     | F3         | Browser ST interpreter silently diverges from the edge: TON/TOF/TP, R_TRIG/F_TRIG, counters and TIME literals do nothing; INT division, divide-by-zero, CONTINUE and casts behave differently; valid programs are rejected or the wrong POU runs                                                                               |
| [SENSOR-HIGH-327](#sensor-high-327)         | HIGH     | F3         | Simulation and the edge VM use opposite variable-to-tag models, so a program that works in one silently does nothing in the other; only one program can run at a time                                                                                                                                                          |
| [SENSOR-HIGH-329](#sensor-high-329)         | HIGH     | F5         | Interactive closed-loop simulation is impossible: no plant model (valve/pump/VFD actions never change flow or level), equipment has a single tag (no command vs feedback, fault/maintenance never from data), VFD widgets ignore the simulation plane and offer no frequency setpoint                                          |
| [SENSOR-HIGH-331](#sensor-high-331)         | HIGH     | F5         | Package scripts never execute in any runtime: the production CSP blocks the client sandbox, the edge drops scripts, server and browser sandbox APIs differ, and the Test button only logs to the console                                                                                                                       |
| [SENSOR-MEDIUM-328](#sensor-medium-328)     | MEDIUM   | F5         | Operator input in simulation restarts the scan timer (0 cycles while dragging, push-buttons never seen) and collapsing the right panel stops the program                                                                                                                                                                       |
| [SENSOR-LOW-330](#sensor-low-330)           | LOW      | F5         | Scenario tooling is static snapshots (no ramps, steps, fault injection, time acceleration, record/replay) and trends use a third read path in simulation                                                                                                                                                                       |
| [SENSOR-HIGH-332](#sensor-high-332)         | HIGH     | F6         | Alarms are inconsistent across runtimes: cloud alarm status is written to one store and read from two others, the rule tag means deviceCode/localName in the cloud but localName on the edge, cloud latches until an impossible ACK while the edge auto-clears, and rules from all packages merge by id                        |
| [EDGE-HIGH-086](#edge-high-086)             | HIGH     | F6         | Trends are permanently empty: edge trend history query mixes ms and s, only Trends-tab tags are recorded, and the cloud ignores trendConfig                                                                                                                                                                                    |
| [SENSOR-HIGH-334](#sensor-high-334)         | HIGH     | F6         | Control security is not enforced: no PIN can be set and hash formats disagree, widget role permissions are client-only with a self-selected operator role, the edge PIN accepts anything, and editors do not gate by role                                                                                                      |
| [SENSOR-MEDIUM-333](#sensor-medium-333)     | MEDIUM   | F6         | Cloud alarm evaluation, persistence and timer scripts run only while an operator view is open; alarm notifications cannot be configured and never send; active alarms are not restored after restart                                                                                                                           |
| [SENSOR-MEDIUM-335](#sensor-medium-335)     | MEDIUM   | F6         | Scheduler widget entries (day, hour range, tag, value) are never executed anywhere                                                                                                                                                                                                                                             |
| [EDGE-MEDIUM-087](#edge-medium-087)         | MEDIUM   | F6         | Edge schedule triggers evaluate cron fields in UTC with no site time zone, so local-time schedules fire offset by the UTC difference                                                                                                                                                                                           |
| [SENSOR-HIGH-337](#sensor-high-337)         | HIGH     | F0         | Tests give false confidence across the SCADA path: no page-level or E2E coverage, round-trip and cross-runtime tests replace the real seam with stand-ins, contract fixtures are hand-written, and a gate claims behaviour it does not test                                                                                    |
| [SENSOR-MEDIUM-336](#sensor-medium-336)     | MEDIUM   | F7         | No coherent SCADA journey: /sensor lands on a deprecated viewer, the operator view has no entry point, empty-tenant links are dead, process activation always fails, and editor modes/zoom leak between processes                                                                                                              |

## A. Automation program to edge execution

### SENSOR-CRITICAL-269

**Automation programs created in the UI can never be approved: submitForReview requires SFC steps but the editor renders no Steps/Transitions tab, so Deploy is never enabled**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 1; re-checked in session
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** submitForReview requires >=1 step and an INITIAL step; createProgram creates none and the editor renders no Steps/Transitions tab although the state and mutation exist.

**What the user sees.** 'Submit for review' fails with 'Program must have at least one step'; the Start Deployment button stays disabled forever.

**Root cause.** The lifecycle validates an SFC model (steps) while the editor only authors ST text; the step UI was never rendered.

**Fix direction.** Validate the ST program (parse + semantic check) instead of requiring SFC steps for ST programs, or render the step editor; one program model.

**Evidence (canonical citations).**

- `apps/sensor-service/src/automation/automation.service.ts:965-976`
- `apps/sensor-service/src/automation/automation.service.ts:149-204`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:557`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1480-1513`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:573,748,988`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1907,1919-1921`

<details><summary>Merged audit findings and full evidence</summary>

- **AUTO-01** (AUTO/XPORT; verdict SELF; severity BLOCKER): A program created in the UI can never be approved, so Deploy is never enabled
  - apps/sensor-service/src/automation/automation.service.ts:965-976 (step count + INITIAL step required)
  - apps/sensor-service/src/automation/automation.service.ts:149-204 (createProgram creates no steps)
  - web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:557 (tab union includes 'steps','transitions')
  - web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1480-1513 (only info/variables/code/simulation/deploy rendered)
  - web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:573,748,988 (dead add-step state/mutation/handler)
  - web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1907,1919-1921 (deploy disabled unless APPROVED)

</details>

### SENSOR-CRITICAL-270

**Structured Text is never compiled or shipped: the cloud compiler is a mock that always succeeds, the RUST_ENGINE payload is built only from SFC steps (startup trigger + noop), and ADR-017 deploy_program{format:stbc} is unimplemented on the cloud side**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 2; re-checked in session
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** translateProgramToEdgeScript builds the edge script only from steps/transitions/step actions; from ST it only regexes declarations. With no steps the payload is triggers:[startup] actions:[noop]. ioMappings computed but omitted. No cloud code sends deploy_st_source or deploy_bytecode_program; CompilerService is a mock that always succeeds.

**What the user sees.** Even if a program could be deployed, the device would run nothing the user wrote.

**Root cause.** Two program models (SFC JSON script vs ST bytecode) and the cloud only implements the SFC translation; ADR-017 path unimplemented on the cloud side.

**Fix direction.** Implement ADR-017: compile ST to the edge bytecode format (reuse the edge's compiler as the single implementation) and ship deploy_program{format:'stbc'}; delete the mock compiler.

**Evidence (canonical citations).**

- `apps/sensor-service/src/automation/automation.service.ts:1998,2025-2066`
- `apps/sensor-service/src/automation/automation.service.ts:1789,1793`
- `apps/sensor-service/src/automation/automation.service.ts:1747-1754`
- `apps/sensor-service/src/automation/compiler/services/compiler.service.ts:8-11`
- `sens-api-gateway/src/commands/deploy_st_source.rs`
- `sens-api-gateway/src/commands/deploy_bytecode_program.rs`
- `web/modules/sensor-module/src/graphql/automation.queries.ts`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:843`

<details><summary>Merged audit findings and full evidence</summary>

- **AUTO-02** (AUTO/XPORT; verdict SELF; severity BLOCKER): The Structured Text is never shipped for the default RUST_ENGINE target; an ST program deploys as a no-op
  - apps/sensor-service/src/automation/automation.service.ts:1998,2025-2066 (ST only regexed for declarations)
  - apps/sensor-service/src/automation/automation.service.ts:1789,1793 (startup trigger / noop fallback)
  - apps/sensor-service/src/automation/automation.service.ts:1747-1754 vs 1773-1806 (ioMappings dropped)
  - apps/sensor-service/src/automation/compiler/services/compiler.service.ts:8-11 ('Mock Compiler Service ... Always returns compilation successful')
  - sens-api-gateway/src/commands/deploy_st_source.rs, deploy_bytecode_program.rs (edge has real ST compiler/VM behind commands nothing in apps/ sends)
  - docs/adr (ADR-017 §1/§9: cloud compiles ST to signed bytecode, deploy_program {format:'stbc'})
- **AUTO-09** (AUTO/XPORT; verdict SELF; severity MEDIUM): Nothing validates the ST on save or deploy and the UI over-reports success
  - Claim: The page never calls validateStructuredText; the compiler is a mock; 'Deployment started successfully' is shown on MQTT publish and history does not poll.
  - web/modules/sensor-module/src/graphql/automation.queries.ts (validateStructuredText defined, unused by the page)
  - web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:843
  - apps/sensor-service/src/automation/compiler/services/compiler.service.ts:8-11

</details>

### SENSOR-CRITICAL-271

**Device replies are never correlated: deploy/bundle acks are routed on a payload.command field the edge never sends (and rejections without bundleId are dropped), so deploy logs stay SENT, bundles stay PENDING/STAGED and programs time out as "no response"**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 2; re-checked in session
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** The edge reply has no 'command' field (the listener's own comment says so) but deploy replies are routed on payload.command === 'deploy_program'|'deploy_to_codesys'|'deploy_auto'|'deploy_scada_package'. checkDeployTimeout then reverts the program and logs 'no response'.

**What the user sees.** Deploy history shows 'Deployment timeout: no response from device within 5 minutes' although the device answered; SCADA deploy logs stay SENT forever.

**Root cause.** Reply correlation keyed on a field the producer never sends instead of the commandId the cloud already stores.

**Fix direction.** Correlate replies by commandId against the pending deployment/scada deploy log rows; contract test with the real Rust CommandResponse fixture.

**Evidence (canonical citations).**

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:741-742`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:812-818,884`
- `sens-api-gateway/src/mqtt.rs:207-216`
- `apps/sensor-service/src/automation/automation.service.ts:2760,2771-2830`
- `sens-api-gateway/src/commands/bundle_deploy.rs:266-275,313-317`
- `sens-api-gateway/src/commands/dispatch_lifecycle.rs:234-240`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:982-990,1014-1037`

<details><summary>Merged audit findings and full evidence</summary>

- **AUTO-03** (AUTO/XPORT; verdict SELF; severity BLOCKER): Deploy replies from the device are never processed; after 5 minutes the program is marked 'no response'
  - apps/sensor-service/src/ingestion/mqtt-listener.service.ts:741-742 (comment: CommandResponse has no command field)
  - apps/sensor-service/src/ingestion/mqtt-listener.service.ts:812-818,884 (routing on payload.command)
  - sens-api-gateway/src/mqtt.rs:207-216 (CommandResponse fields)
  - apps/sensor-service/src/automation/automation.service.ts:2760,2771-2830 (timeout job)
- **XPORT-05** (AUTO/XPORT; verdict SELF; severity HIGH): Bundles get stuck: rolled_back unhandled, rejections without bundleId ignored, no timeout job
  - Claim: Edge can reply phase rolled_back but the cloud handles only staged/confirmed/failed; two-person and parse rejections carry no bundleId and are dropped; no scheduled timeout for release bundles.
  - sens-api-gateway/src/commands/bundle_deploy.rs:266-275,313-317
  - sens-api-gateway/src/commands/dispatch_lifecycle.rs:234-240
  - apps/sensor-service/src/ingestion/mqtt-listener.service.ts:982-990,1014-1037

</details>

### EDGE-CRITICAL-072

**Edge ST/bytecode VM has no output stage: program writes update only the in-memory ProcessImage and never reach GPIO/Modbus/I2C, outputs are never read back (seal-in logic faults), and forces neither drive the field nor survive the next scan**

- Severity: CRITICAL · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 5; re-checked in session
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** After each successful scan, run_scan_tick drains the VM's pending writes and calls commit_pending_writes. That function only calls ProcessImage::update_tag_raw(name, v, Good, Script), which inserts into the HashMap and sends a TagChange. run_scan_tick and both cadence drivers get only (registry, ProcessImage, declared_types, persistence, options). No GPIO, Modbus or I2C handle reaches them, so the VM cannot drive hardware even in principle. No other component turns Script-sourced ProcessImage values into hardware writes. Every hardware write call site in the crate lives in a different path: the HMI executor, set_output, the write commands, the JSON engine actions and safe-state. The two TagChange consumers do no I/O: the OPC UA LoggingNotifier (trace logging only, and not even compiled into the release binary) and the scheduler event listener (wakes tasks only). io_poll only reads, and the GPIO read skips output pins, so nothing reconciles or overwrites the commanded value. The same PI-only sink is used by force_value on an output (force_commands.rs:186-199) and by OPC UA client writes (opc_ua_server.rs:864-876). Both report success while the field device is untouched. Today the cloud cannot reach this path (AUTO-02). It is the ADR-017 target that AUTO-02's fix and SIM-05's model lead to, and the rewrite's program-to-widget link would run on it.

**What the user sees.** Once ST deploy works, the program sets pump_run := TRUE. The device screen shows the pump ACIK (green, quality dot green) and the cloud Edge Device page shows ON. The pump never starts. No error appears on any screen or in the log, because from the agent's point of view the write succeeded.

**Root cause.** ADR-017's VM was built as a pure ProcessImage-to-ProcessImage function (snapshot, run, commit). The IEC output-image-to-field step was never implemented. Each older write path (HMI executor, set_output, JSON engine) owns its own tag-to-hardware mapping, and none of them is shared with the VM.

**Fix direction.** Yes, the target edge runtime should get an explicit IEC-style output scan. Give each output TagConfig (DO/AO) an output-image slot. After the scan's commit phase, an OutputScan stage drives every slot whose commanded value changed, or whose last drive failed, through ONE OutputDriver keyed by TagConfig.protocol_config: GPIO pin -> GpioHandle::write_pin; Modbus slave_id/register -> write_coil or write_register_checked with reverse_scale; I2C. Make it impossible for a write to bypass the driver: ProcessImage should expose no public setter for DO/AO values except OutputDriver::command(), and the VM commit, the HMI executor, set_output, force, OPC UA, the JSON engine actions and safe-state should all call it. Record per-tag drive results (ok / error / simulated) and feed them into the confirmed-value model in OUT-05. Add a contract test that runs the real scan loop with a fake hardware port and asserts that a VM WriteTag on a DO results in exactly one port write.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scripting/bytecode_runner.rs:239-245`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:331-341`
- `sens-api-gateway/src/process_image.rs:350-387`
- `sens-api-gateway/src/scripting/bytecode_runner.rs:123-129`
- `sens-api-gateway/src/main.rs:5148-5157`
- `sens-api-gateway/src/main.rs:5649,5662,5669`
- `sens-api-gateway/src/commands/io_config.rs:178,200`
- `sens-api-gateway/src/commands/write.rs:120,204`
- `sens-api-gateway/src/scripting/engine.rs:1522,1602,1671`
- `sens-api-gateway/src/safe_state.rs:272-304`
- `sens-api-gateway/src/scripting/process_image_tagio.rs`
- `sens-api-gateway/src/scripting/task_scheduler.rs`
- `sens-api-gateway/src/opc_ua_server_runtime.rs:922-931`
- `sens-api-gateway/src/scripting/task_scheduler.rs:731-750`
- `Cargo.toml:503`
- `.github/workflows/edge-agent-release.yml:20,240`
- `sens-api-gateway/src/io_poll.rs:150-176`
- `sens-api-gateway/src/gpio.rs:520-523`
- `sens-api-gateway/src/commands/force_commands.rs:186-199`
- `sens-api-gateway/src/opc_ua_server.rs:864-876`
- `sens-api-gateway/src/safe_state.rs`
- `sens-api-gateway/src/scripting/engine.rs`
- `sens-api-gateway/src/gpio.rs`
- `sens-api-gateway/src/main.rs`
- `sens-api-gateway/src/i2c.rs`
- `sens-api-gateway/src/modbus.rs`
- `sens-api-gateway/src/commands/write.rs`
- `sens-api-gateway/src/commands/io_config.rs`
- `sens-api-gateway/src/scripting/task_scheduler.rs:731`
- `sens-api-gateway/src/opc_ua_server_runtime.rs:927`
- `sens-api-gateway/src/io_poll.rs:405-471`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:292-314`
- `sens-api-gateway/src/scripting/bytecode_runner.rs:286-304`
- `sens-api-gateway/src/main.rs:5646-5651`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:336-339`
- `sens-api-gateway/src/io_poll.rs:203-219`
- `sens-api-gateway/src/config.rs:2815-2817`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1499-1550`
- `sens-api-gateway/src/commands/io_config.rs:76`
- `sens-api-gateway/src/scripting/engine.rs:1515-1533`
- `sens-api-gateway/src/scripting/engine.rs:982-1036`
- `sens-api-gateway/static/scada-edge.html:1329-1338`
- `sens-api-gateway/src/io_poll.rs:486-503`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs:1700`

<details><summary>Merged audit findings and full evidence</summary>

- **OUT-01** (GAP2; verdict SELF; severity BLOCKER): The ST/bytecode VM has no output stage: program writes update only the in-memory ProcessImage and never reach a GPIO pin, Modbus coil/register or I2C device
  - writer: sens-api-gateway/src/scripting/bytecode_runner.rs:239-245 (VmOutcome::Returned -> drain -> commit_pending_writes(pi, writes))
  - sens-api-gateway/src/scripting/process_image_tagio.rs:331-341 (for each write: pi.update_tag_raw(&name, as_f64, TagQuality::Good, TagSource::Script); nothing else)
  - sens-api-gateway/src/process_image.rs:350-387 (update_tag_raw = HashMap insert + change_tx.send; no I/O)
  - sens-api-gateway/src/scripting/bytecode_runner.rs:123-129 (run_scan_tick signature: registry, pi, declared_types, persistence, options; no hardware handle); main.rs:5148-5157 and 5222-5233 (both drivers spawned with registry/pi/declared_types/persistence only)
  - grep of all hardware write call sites (.write*pin/.write_coil/.write_register): main.rs:5649,5662,5669; commands/io_config.rs:178,200; commands/write.rs:120,204; scripting/engine.rs:1522,1602,1671; safe_state.rs:272-304; none in scripting/bytecode*\*, process_image_tagio.rs or task_scheduler.rs
  - TagChange subscribers: opc_ua_server_runtime.rs:922-931 (LoggingNotifier); task_scheduler.rs:731-750 (trigger_event only); opc-ua-server feature (Cargo.toml:503) is not in the release features (.github/workflows/edge-agent-release.yml:20,240: scada-display only)
  - reader (no readback): io_poll.rs:150-176 (GPIO values from gpio.read_all only), gpio.rs:520-523 and 567-570 (read_all_pins `if config.direction != "input" { continue; }` in both the hardware and sim builds)
  - same PI-only sink: commands/force_commands.rs:186-199 (force -> update_tag_raw Force, no hardware); opc_ua_server.rs:864-876 (OPC UA write -> update_tag_raw OpcUaClient -> Ok(()))
  - RAN: scratchpad/outstage/sens-api-gateway/src/scripting/outstage_probe_tests.rs probe_b (log scratchpad/outstage/test2.log): compiled `pump_run := 50.0 < level;` against the cloud-shaped TagConfigs. Tick = Ok{writes_committed:1}, PI pump_run = {value:1.0, quality:Good, source:Script}, sim GPIO pin17 = Low, gpio.read_all pins = [5]
- **IOP-04** (GAP1; verdict SELF; severity HIGH): Program output writes go only into the ProcessImage; nothing drives the GPIO or Modbus output, yet the HMI shows the commanded state
  - Claim: commit_pending_writes stores each VM write with update_tag_raw(TagSource::Script). No task subscribes to Script-sourced or output-tag changes to call write_pin, write_coil or write_register. The only hardware writers are the HMI executor, set_output, write_gpio/write_modbus, the legacy JSON script actions and safe-state. io_poll reads only input pins and polled registers, so the Script value is never overwritten by a readback. It is broadcast to the HMI and published as io_data as if the output were on.
  - sens-api-gateway/src/scripting/process_image_tagio.rs:331-341 (commit = update_tag_raw only)
  - sens-api-gateway/src/scripting/bytecode_runner.rs:239-245 (commit after a successful run)
  - grep write_pin\|write_coil(\|write_register(: only safe_state.rs, scripting/engine.rs, gpio.rs, main.rs, i2c.rs, modbus.rs, commands/write.rs, commands/io_config.rs, none in the bytecode path
  - grep subscribe_changes in production code: only scripting/task_scheduler.rs:731 (event wakeups) and opc_ua_server_runtime.rs:927
  - sens-api-gateway/src/io_poll.rs:405-471 (all_tags, including Script values, go to io_data and HMI allTags)
  - RUN: ioprov_proof.rs printed 'PROOF pump_on after fresh-map tick = Some((1.0, Script)) (only ProcessImage changed; no GPIO handle involved)'
- **OUT-04** (GAP2; verdict SELF; severity HIGH): Output tags are never read back, so programs that read their own output (seal-in, toggle) fault every scan, and the HMI shows a value no writer agrees with
  - Claim: GPIO output pins are excluded from read_all, so a DO tag exists in the ProcessImage only after some writer puts it there. The VM snapshot holds only present Good/Simulated tags, and read_tag returns NotFound for anything else. A seal-in rung such as `pump_run := start OR (pump_run AND NOT stop)` therefore faults on the first LoadTag pump_run, the runner discards the write that would have created the tag, and the program never gets going. Once the tag exists, several writers fight over one slot and none of them reports the pin. The HMI executor drives the pin and calls update_tag(cmd.value). The VM's next commit, at most one scan later, overwrites the tag with the program's value without touching the pin. If the operator switches the pump ON from the HMI and the program computes FALSE, the HMI shows OFF while the pin stays HIGH. Modbus outputs get a readback only when config.yaml happens to list the coil under the same name; cloud DeviceIoConfig tags are not added to that read list.
  - gpio.rs:520-523 and 567-570 (outputs skipped in read_all_pins); io_poll.rs:150-176 (GPIO tag values come only from read_all)
  - process_image_tagio.rs:292-314 (snapshot = present Good/Simulated tags only), 135-142 (missing -> TagIoError::NotFound)
  - bytecode_runner.rs:286-304 (on Failed the pending writes are dropped, so the tag is never created)
  - RAN probe_d: `pump_run := start_cmd OR (pump_run AND NOT stop_cmd);` with a correct catalog, start_cmd=1 -> Failed{TagIoFailed{tag:"pump_run", direction:"load", reason:"tag not found in backend"}}
  - HMI writer: main.rs:5646-5651 (write_pin) and 5701-5705 (update_tag(cmd.tag, cmd.value)); VM overwrite: process_image_tagio.rs:336-339 (every tick, no comparison with the pin)
  - Modbus readback depends on the static read list: io_poll.rs:203-219 (match reg_value.name == cfg.tag_name); config.rs:2815-2817 (registers from config.yaml/provisioning); cloud tags come from edge-device.service.ts:1499-1550 (pushed only to ProcessImage via io_config.rs:76)
- **OUT-09** (GAP2; verdict SELF; severity MEDIUM): Inverse false state: JSON-engine GPIO and coil actions do drive the hardware but never update the ProcessImage, so the HMI and the cloud keep showing the output OFF
  - Claim: action_set_gpio and action_write_coil call the hardware handle and return success. They never touch the ProcessImage. sync_to_process_image publishes only 'var:<name>' and 'sensor:<name>' keys, never the output tag. GPIO output pins are not read back (gpio.rs:520-523), so a DO tag driven by the JSON engine, which is the engine bundle deploys use today, keeps its last HMI-written value or never appears. FB outputs also cannot target hardware; wire_fb_outputs accepts only var: and sensor:. Reachable today within the limits of AUTO-01/02/06.
  - writer: scripting/engine.rs:1515-1533 (write_pin, then ActionResult only), 1664-1680 (write_coil, then ActionResult only)
  - scripting/engine.rs:982-1036 (sync_to_process_image writes only var:{name} and sensor:{name}), 914-970 (wire_fb_outputs: var:/sensor: only; 'Direct GPIO/Modbus writes should be done via script actions')
  - reader: io_poll.rs:150-176 and gpio.rs:520-523 (no output readback); scada-edge.html:1329-1338 (indicator from tagStore value)
- **OUT-11** (GAP2; verdict SELF; severity LOW): Forcing an output neither drives the field device nor survives the next program scan
  - Claim: force_value writes the forced value only into the ProcessImage (source Force). io_poll respects forces (maybe_update_tag skips forced tags), but commit_pending_writes calls update_tag_raw without checking the force registry. A program that writes the forced tag overwrites the force within one scan, while the force registry and its banner still report it as active. The hardware never receives the forced value in either case (OUT-01). Not reachable from the cloud UI today (no force_value sender in apps/ or web/).
  - commands/force_commands.rs:186-199 (registry apply + update_tag_raw Force only)
  - io_poll.rs:486-503 (is_forced check on the input path only)
  - process_image_tagio.rs:331-341 (commit: no is_forced check); bytecode_compiler.rs:1700 (safe_state_pinned_tags always empty)
  - grep: no force_value in apps/sensor-service/src or web/modules/sensor-module/src

</details>

### EDGE-HIGH-067

**Edge fallback license enforces a 5000 ms minimum scan cycle and no license or verifying key is ever provisioned, so the default 100 ms program scan cycle is rejected**

- Severity: HIGH · Domain: EDGE · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 1
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** The edge starts with the most restrictive fallback license (min scan cycle 5000 ms). Raising it needs a license verified with the firmware signing key, which the installer never provides; the cloud never sends refresh_license; the cloud sends scanCycleMs=100 and the UI can't change it.

**What the user sees.** Once the other blockers are fixed, every program deploy is rejected by the device for scan cycle below minimum.

**Root cause.** License distribution is not part of provisioning.

**Fix direction.** Provision the license and its verifying key at install; surface scan cycle in the UI with the license limit.

**Evidence (canonical citations).**

- `sens-api-gateway/src/license.rs:177-197`
- `sens-api-gateway/src/main.rs:1035`
- `apps/sensor-service/src/edge-device/installer-script.service.ts:325-355`
- `apps/sensor-service/src/automation/entities/automation-program.entity.ts:203`
- `apps/sensor-service/src/automation/automation.service.ts:1780`

<details><summary>Merged audit findings and full evidence</summary>

- **AUTO-04** (AUTO/XPORT; verdict SELF; severity HIGH): The edge's fallback license rejects the default 100 ms scan cycle
  - sens-api-gateway/src/license.rs:177-197
  - sens-api-gateway/src/main.rs:1035
  - apps/sensor-service/src/edge-device/installer-script.service.ts:325-355 (firmware_update mode: disabled)
  - apps/sensor-service/src/automation/entities/automation-program.entity.ts:203
  - apps/sensor-service/src/automation/automation.service.ts:1780
  - sens-api-gateway/src/scripting/deploy.rs:114

</details>

### EDGE-HIGH-068

**Release edge binary is built without the gpio feature and cloud-defined GPIO tags never reach the GPIO actor (built only from config.yaml gpio[], which the installer writes empty), so no Raspberry Pi pin can be driven**

- Severity: HIGH · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 2
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** init_hardware_handles creates the GPIO actor only when config.yaml has GPIO entries, using exactly those entries. The installer-generated config.yaml contains `gpio: []`, so gpio_handle is None. update_io_config delivers the cloud's DeviceIoConfig GPIO tags to the ProcessImage only. GpioHandle::reconfigure exists but has no production caller. As a result, on a device provisioned by the platform installer, no GPIO input is ever read (io_poll skips when the handle is None), and every GPIO output path fails: the HMI executor ('GPIO unavailable'), set_output ('GPIO handle not available') and the JSON engine set_gpio ('GPIO not available'). With a hand-edited config.yaml, a pin missing there is rejected with 'Pin N not configured as output'. Any output stage built on the current actor inherits this split catalog. Modbus has a runtime provisioning command for VFD devices (provision.rs), but generic DeviceIoConfig Modbus tags are only matched against registers already listed for a device (SUSPECTED for the Modbus case; not traced end to end). This is independent of AUTO-05 (gpio feature off in release) and AUTO-07 (installer config does not boot).

**What the user sees.** On a Raspberry Pi installed through the platform's installer script, GPIO tags defined in the cloud never show a value, and pressing a GPIO pump or valve button on the device screen fails with 'GPIO unavailable', even on a build with the gpio feature.

**Root cause.** There are two I/O catalogs: config.yaml for the hardware actors and the cloud TagConfig for the ProcessImage. Nothing derives one from the other.

**Fix direction.** Make the cloud TagConfig the single source and derive the actor configuration from it automatically. Every applied update_io_config (and the boot-time restore from gap 1) rebuilds GpioConfig[] from the GPIO TagConfigs (pin, direction from io_type, invert, safe_state_level) and calls GpioHandle::reconfigure. Modbus tags get the same treatment through the existing provisioning actor. Reject an io config whose tag addresses no actor can serve, and return that in the update_io_config ack.

**Evidence (canonical citations).**

- `apps/sensor-service/src/edge-device/installer-script.service.ts:352-354`
- `sens-api-gateway/src/main.rs:2931-2941`
- `sens-api-gateway/src/gpio.rs:340`
- `sens-api-gateway/src/commands/io_config.rs:57-127`
- `sens-api-gateway/src/io_poll.rs:151`
- `sens-api-gateway/src/main.rs:5646-5654`
- `sens-api-gateway/src/commands/io_config.rs:174-184`
- `sens-api-gateway/src/scripting/engine.rs:1515-1532`
- `sens-api-gateway/src/gpio.rs:646-647`
- `sens-api-gateway/src/commands/provision.rs:1-40`
- `sens-api-gateway/src/io_poll.rs:203-219`
- `.github/workflows/edge-agent-release.yml:20,240`
- `sens-api-gateway/Cargo.toml:424-425`
- `sens-api-gateway/src/gpio.rs:502-508,557-575,613-618`

<details><summary>Merged audit findings and full evidence</summary>

- **OUT-06** (GAP2; verdict SELF; severity HIGH): Cloud-defined GPIO tags never reach the GPIO actor: the actor is built only from config.yaml gpio[], which the installer writes empty, and reconfigure() is never called
  - writer: apps/sensor-service/src/edge-device/installer-script.service.ts:352-354 and 450-452 (`modbus: []`, `gpio: []`)
  - sens-api-gateway/src/main.rs:2931-2941 (GpioHandle::new(self.config.gpio) only `if !self.config.gpio.is_empty()`)
  - gpio.rs:340 (pub async fn reconfigure); grep `.reconfigure(`: no production caller; commands/io_config.rs:57-127 (update_io_config: set_configs + alarms + persist only)
  - readers: io_poll.rs:151 (`if let Some(ref gpio) = gpio_handle`); main.rs:5646-5654 ('GPIO unavailable'); commands/io_config.rs:174-184 ('GPIO handle not available'); scripting/engine.rs:1515-1532 ('GPIO not available'); gpio.rs:646-647 and 672-673 ('Pin {} not configured as output')
  - Modbus: commands/provision.rs:1-40 (update_io_config 'only maps register tags onto PRE-EXISTING devices'); io_poll.rs:203-219
- **AUTO-05** (AUTO/XPORT; verdict SELF; severity HIGH): The shipped edge binary has no real GPIO
  - Claim: Release builds only --features scada-display; default features are [health] without gpio, so set_gpio reports success without touching pins and reads return simulated values. Modbus I/O is real.
  - .github/workflows/edge-agent-release.yml:20,240
  - sens-api-gateway/Cargo.toml:424-425 (default = [health]; gpio = [rppal])
  - sens-api-gateway/src/gpio.rs:502-508,557-575,613-618 (simulation branches)

</details>

### EDGE-HIGH-069

**Edge JSON script engine barely runs delivered programs: function blocks configured only at init, MANUAL mode never runs FBs, fb:-prefixed trigger sources unresolved, startup triggers hard-coded false**

- Severity: HIGH · Domain: EDGE · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 1
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** configure_from_program runs only at engine init; the UI hard-codes executionMode MANUAL mapped to event-driven where FBs never run; cloud emits fb:-prefixed trigger sources the edge value lookup cannot resolve; startup triggers hard-coded false in the check.

**What the user sees.** Timers/function blocks in a deployed program never execute until the agent restarts, if at all.

**Root cause.** The JSON script engine and the cloud translator evolved separately with no end-to-end test.

**Fix direction.** Retire the JSON-script path for ST programs in favour of the bytecode VM (AUTO-02); if kept, add an e2e fixture through execute_command.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scripting/engine.rs:450,511,663-707,750`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:966`
- `apps/sensor-service/src/automation/automation.service.ts:1766-1769`
- `sens-api-gateway/src/scripting/context.rs:145-215`
- `sens-api-gateway/src/scripting/triggers.rs:166`

<details><summary>Merged audit findings and full evidence</summary>

- **AUTO-06** (AUTO/XPORT; verdict SELF; severity HIGH): Even a delivered JSON program barely runs: FBs only at init, MANUAL mode skips FBs, fb: triggers unresolved, startup triggers never fire live
  - sens-api-gateway/src/scripting/engine.rs:450,511,663-707,750
  - web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:966 (executionMode MANUAL)
  - apps/sensor-service/src/automation/automation.service.ts:1766-1769 (MANUAL -> event-driven)
  - sens-api-gateway/src/scripting/context.rs:145-215 (no fb case)
  - sens-api-gateway/src/scripting/triggers.rs:166 (Startup => false)

</details>

### SENSOR-HIGH-272

**Installer-written config.yaml sets neither signature_mode nor mtls.mode, and release builds refuse to boot with the Disabled/Legacy defaults**

- Severity: HIGH · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 1
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** The installer sets neither signature_mode nor mtls.mode; they default to Disabled/Legacy, which release builds refuse at validate_faz2_security_coherence.

**What the user sees.** A freshly installed device never comes online.

**Root cause.** Installer template and release security validation drifted.

**Fix direction.** Generate config.yaml from the same schema the agent validates; installer e2e test boots the release binary with it.

**Evidence (canonical citations).**

- `apps/sensor-service/src/edge-device/installer-script.service.ts:325-355`
- `sens-api-gateway/src/command_envelope/envelope.rs:66-71`
- `sens-api-gateway/src/mtls/mode.rs:37-38`
- `sens-api-gateway/src/config.rs:3261,3747,3786-3805`

<details><summary>Merged audit findings and full evidence</summary>

- **AUTO-07** (AUTO/XPORT; verdict SELF; severity HIGH): A release agent will not boot with the config.yaml the installer writes
  - apps/sensor-service/src/edge-device/installer-script.service.ts:325-355
  - sens-api-gateway/src/command_envelope/envelope.rs:66-71
  - sens-api-gateway/src/mtls/mode.rs:37-38
  - sens-api-gateway/src/config.rs:3261,3747,3786-3805

</details>

### EDGE-HIGH-070

**Edge ST compiler cannot compile ordinary control programs: rejects >, >=, <=, <>, MOD, XOR, every IEC function block (TON/TOF/R_TRIG/CTU), TIME/STRING literals and STRING/ARRAY variables**

- Severity: HIGH · Domain: EDGE · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 3
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** compile_program accepts locals only of type BOOL/INT/REAL. `t1 : TON`, `rt : R_TRIG`, STRING and ARRAY declarations fail with CompileError::Unsupported. TIME and STRING literals are Unsupported, and so is array access. FB member access (t1.Q) is typed REAL, so `IF t1.Q` and `pump := t1.Q` fail with TypeMismatch. The FB-pin type tables (insert_fb_inputs/insert_fb_outputs) are populated only in unit tests. REAL_TO_INT and SHL are unknown stdlib functions, and MAX/MIN accept exactly 2 arguments. The function_blocks/ library (TON with WallClock/ScanCycle, R_TRIG, CTU) is therefore unreachable from ST source. The ST editor's snippet catalog inserts TON, TOF, R_TRIG, RAMP and BLINK, and its full 'PumpControl' template uses LIMITALARM, RAMP and T#100ms. None of these can deploy. The browser simulation runs the same code as silent no-ops (SIM-04), so the user gets neither an error nor a working timer anywhere.

**What the user sees.** I insert the editor's 'TON timer' snippet. In Simulation the timer never fires and no error appears. If the program reaches the device, the deploy is refused with an 'Unsupported' compile error, so a delayed pump start or a feeding interval cannot be built at all.

**Root cause.** The edge bytecode compiler implements only a BOOL/INT/REAL subset of ST, with no FB-instance or TIME types. The editor's snippets, the backend analyzer and the browser interpreter each assume a larger language, and nothing pins the supported subset in one place.

**Fix direction.** Define the supported ST profile once, as a capability table in a shared contract, and have the editor's diagnostics, the cloud validator and the simulation all reject anything outside it. Extend compile_program with FB-instance declarations backed by the existing function_blocks registry (typed pin catalog), TIME values, and STRING if needed. Only then compile the edge compiler and VM to wasm for simulation, as SIM-04 proposes. Add golden tests (TON/TOF/R_TRIG/CTU programs) that must compile and behave identically native and in wasm.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scripting/bytecode_compiler.rs:1638-1647`
- `sens-api-gateway/src/scripting/bytecode_deploy.rs:358-394`
- `web/modules/sensor-module/src/components/unified-editor/providers/st-snippets.ts:68-70`
- `sens-api-gateway/src/st_validator.rs:511-527`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs:620-707`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs:665-700`
- `sens-api-gateway/src/commands/deploy_st_source.rs:370`

<details><summary>Merged audit findings and full evidence</summary>

- **SIMV-02** (SIM-verifier; verdict SELF; severity HIGH): The edge ST compiler cannot compile any IEC function block (TON/TOF/R_TRIG/CTU/RAMP), TIME or STRING literals, STRING/ARRAY variables, REAL_TO_INT or SHL, so the editor's own snippets and template produce programs the device rejects, while the simulation silently accepts them
  - sens-api-gateway/src/scripting/bytecode*compiler.rs:1638-1647 (Unsupported 'only BOOL/INT/REAL supported at Batch 150'), :1711-1729 (data_type_to_st_type), :362-366 (string/time literal Unsupported), :367-369 (array access Unsupported), :371-390 (FB output inferred Real), :181-217 (insert_fb*\* used only by tests at :3234-3395)
  - sens-api-gateway/src/scripting/bytecode_deploy.rs:358-394 (the only ST-source deploy path)
  - web/modules/sensor-module/src/components/unified-editor/providers/st-snippets.ts:68-70 (TON + T#), :120-121 (R_TRIG), :130-132 (TOF + T#), :146 (RAMP), :151 (BLINK), :196 (PumpControl template with LIMITALARM/RAMP/T#100ms)
  - RAN: /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/verify-sim/edgec → 'TON instance: Unsupported variable t1 of type UserDefined("TON")'; 'R_TRIG: Unsupported'; 'TIME literal only: Unsupported string / time literals'; 'undeclared FB, IF t1.Q: TypeMismatch if-condition Bool vs Real'; 'STRING compare: Unsupported String'; 'ARRAY: Unsupported Array'; 'REAL_TO_INT: unknown stdlib function'; 'MAX 3 args: expects 2 arg(s), got 3'; 'SHL(1,3): unknown stdlib function SHL'
- **IOP-05** (GAP1; verdict SELF; severity HIGH): The edge bytecode compiler rejects '>', '>=', '<=', '<>', MOD and XOR, so ordinary control programs cannot compile on the device
  - Claim: st_validator's BinaryOp has Gt, Ge, Le, Neq, Mod, Power and Xor. compile_binary_op maps only Add, Sub, Mul, Div, Eq, Lt, And and Or. Every other operator falls through to TypeMismatch with matching operand types. A comparison like 'water_temp > 20.0' therefore fails to compile, and so does any '<>', '>=', '<=', MOD or XOR. This is the only real ST compiler in the system; an earlier stage proposed reusing it for the browser simulation through wasm.
  - sens-api-gateway/src/st_validator.rs:511-527 (BinaryOp variants)
  - sens-api-gateway/src/scripting/bytecode_compiler.rs:620-707 (compile_binary_op; 687 LtReal; 693-700 'Every other (op, type) is a type error')
  - grep BinaryOp::Gt\|Ge\|Le\|Ne\|Mod in src/scripting: no hits
  - RUN: ioprov_proof.rs operator matrix: 'a < b' COMPILES; 'a > b' -> TypeMismatch { op: "Gt" }; 'a >= b' -> Ge; 'a <= b' -> Le; 'a <> b' -> Neq; 'x XOR y' -> Xor; 'i MOD 2' -> Mod; 'a = b', 'x AND y' and 'NOT x' COMPILE
- **OUT-03** (GAP2; verdict SELF; severity HIGH): The edge ST compiler rejects >, >=, <=, <>, XOR and MOD, so most real control programs cannot be deployed to the VM
  - Claim: compile_binary_op maps only Add/Sub/Mul/Div, Eq, Lt, And and Or to opcodes. Every other BinaryOp the parser produces (Gt, Ge, Le, Neq, Mod, Power, Xor) falls into the catch-all and returns CompileError::TypeMismatch with identical left and right types. The opcode set has no GtX/GeX/LeX/Ne/Xor/Mod opcodes, and no code outside the compiler matches on those BinaryOp variants. `IF level > 50.0 THEN` is the most common line in an aquaculture control program, and it cannot be compiled. The error text names a type mismatch, which misleads the author. The repo's own e2e and roundtrip tests use only = and <, which is why CI passes.
  - sens-api-gateway/src/scripting/bytecode_compiler.rs:665-700 (final_op match: Add/Sub/Mul/Div, Eq, Lt, And, Or; `(op, t) => Err(CompileError::TypeMismatch { op, left: t, right: t })`)
  - sens-api-gateway/src/st_validator.rs:511-527 (parser BinaryOp has Mod, Power, Neq, Gt, Le, Ge, Xor)
  - grep: no `BinaryOp::Gt\|Ge\|Le\|Neq\|Mod\|Xor\|Power` anywhere in src/scripting/
  - commands/deploy_st_source.rs:370 (compile failure surfaces as 'ST source compile failed: ...')
  - RAN probe_f: `level > 50.0` -> COMPILE ERR TypeMismatch{op:"Gt",left:Real,right:Real}; `>=` Ge, `<=` Le, `<>` Neq, `a XOR b` Xor, `cnt MOD 2` Mod all COMPILE ERR; `<`, `=`, `NOT a` compile

</details>

### EDGE-HIGH-071

**Edge VM ignores declared initial values and starts every INT/REAL local as Bool(false)**

- Severity: HIGH · Domain: EDGE · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 1
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** The edge's only ST-source path is bytecode_deploy → parse_st → compile_program → ScriptVm. compile_program turns each declaration into a local slot and never reads VarDeclaration.initial_value. ScriptVm::new fills every non-RETAIN local with StValue::Bool(false), and only RETAIN slots get type-correct zeros. The comment there assumes a compiler-enforced write-before-read rule, but compile_program enforces none. Any read of an INT/REAL local before it is written therefore raises VmError::TypeMismatch on tick 0. Examples: `cnt := cnt + 1`, `a : INT := 7; q := a / b`, and the simulation-style `VAR_INPUT level : REAL; pump := level < 30.0`. The browser interpreter initialises by type and honours initial values, so the same programs work in the Simulation tab.

**What the user sees.** A program that counts presses, accumulates feed, or starts from a setpoint such as `target : REAL := 7.0` works in the Simulation tab. Once it is on the device, it stops at its very first scan, and nothing on the device is ever switched.

**Root cause.** The edge compiler and VM have no variable-initialisation contract: initial_value is dropped and locals are untyped Bool(false). The browser runs a separate interpreter with different initialisation semantics, so simulation cannot reveal this.

**Fix direction.** compile_program emits typed initialisation for every declared variable: a typed zero from the declared type, or the declared initial_value. This can be done through Bytecode init slots that ScriptVm::new applies, so a read-before-write is impossible by construction. Add a golden-program parity test (counter, initial value, VAR_INPUT read) run on both the native VM and the browser simulation engine. Latent today behind AUTO-02 (ST never shipped), but it blocks every realistic program once transport works.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scripting/bytecode_vm.rs:519-544`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs:1638-1656`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs`
- `sens-api-gateway/src/scripting/bytecode_deploy.rs:358-394`
- `web/modules/sensor-module/src/simulation/st-interpreter.ts`
- `sens-api-gateway/src/st_validator.rs`
- `sens-api-gateway/src/scripting/bytecode.rs`
- `sens-api-gateway/src/scripting/bytecode_vm.rs`

<details><summary>Merged audit findings and full evidence</summary>

- **SIMV-01** (SIM-verifier; verdict SELF; severity HIGH): Edge VM ignores declared initial values and starts every INT/REAL local as Bool(false), so counters, setpoints and VAR_INPUT reads fault on the first scan while the browser simulation runs them correctly
  - sens-api-gateway/src/scripting/bytecode_vm.rs:519-544 (ScriptVm::new: `vec![StValue::Bool(false); bc.local_count]`, only retain_vars re-typed)
  - sens-api-gateway/src/scripting/bytecode_compiler.rs:1638-1656 (declaration → SymbolEntry::local; initial_value unused); grep initial_value in bytecode_compiler.rs: only test fixtures (:2830+)
  - sens-api-gateway/src/scripting/bytecode_deploy.rs:358-394 (parse_st then compile_program; no validate/type-check gate in between)
  - browser counterpart: web/modules/sensor-module/src/simulation/st-interpreter.ts (initial values applied); RAN scratchpad/verify-sim/probe2.cjs 'initial value + counter' → cnt=21 after 3 cycles
  - RAN: /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/verify-sim/edgec (compiles the real st_validator.rs, bytecode.rs, bytecode_compiler.rs, bytecode_vm.rs) → 'INT div 7/2 with initial values: tick 0 VM ERROR TypeMismatch DivInt expected Int got Bool'; 'counter cnt := cnt + 1: tick 0 VM ERROR TypeMismatch AddInt'; 'sim-style VAR_INPUT REAL read: tick 0 VM ERROR TypeMismatch LtReal expected Real got Bool'; 'INT div assigned' (explicit writes first) → [7,2,3] OK

</details>

### EDGE-HIGH-073

**Edge VM tag type map is built once at boot from the (empty) catalog, so every BOOL/INT tag write is rejected with TypeMismatch**

- Severity: HIGH · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 2
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** main.rs builds declared_types from ProcessImage configs once, when the scan cycle is spawned. That happens before the CommandHandler exists, so no update_io_config can have arrived yet, and the map is always empty. The map is moved into the loop and never rebuilt. SnapshotTagIo::write_tag defaults an undeclared tag to Real and rejects any other value type. The compiler, which uses the live catalog at deploy time, types a DO tag as Bool. So 'pump_on := TRUE;' compiles and then fails at runtime. Reads of Bool tags also come back as Real.

**What the user sees.** Even after the I/O config is pushed and an ST program deploys successfully, any program that switches a digital output does nothing. The program reports as failed on every tick, with a type-mismatch error that has nothing to do with what the user wrote.

**Root cause.** A derived view of the tag catalog is captured once at startup instead of being read from the catalog's current version.

**Fix direction.** Have the scan cycle read the type catalog from the ProcessImage (or a versioned catalog handle) on every tick or every catalog change, and compile and execute against the same catalog version. Add a test: start with an empty catalog, apply a config, run a tick that writes a BOOL tag and assert Ok.

**Evidence (canonical citations).**

- `sens-api-gateway/src/main.rs:5121-5126`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:136-150`
- `sens-api-gateway/src/commands/deploy_st_source.rs:98-119`
- `sens-api-gateway/src/scripting/bytecode_vm.rs:884-912`
- `sens-api-gateway/src/main.rs:5120-5131`
- `sens-api-gateway/src/main.rs:5725`
- `sens-api-gateway/src/main.rs:5148-5157`
- `sens-api-gateway/src/scripting/bytecode_scan_cycle_task.rs:100-128`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:262-268`
- `sens-api-gateway/src/process_image.rs:402-408`
- `sens-api-gateway/src/commands/io_config.rs:76`
- `sens-api-gateway/src/commands/io_config.rs:791-798`
- `sens-api-gateway/src/commands/deploy_st_source.rs:274-279`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:177-202`
- `sens-api-gateway/src/scripting/bytecode_vm.rs:803-834`
- `sens-api-gateway/src/scripting/bytecode_runner.rs:286-315`
- `sens-api-gateway/src/scripting/bytecode_scan_cycle_task.rs:140-146`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1462`
- `apps/sensor-service/src/edge-device/entities/device-io-config.entity.ts:41-49`

<details><summary>Merged audit findings and full evidence</summary>

- **IOP-03** (GAP1; verdict SELF; severity HIGH): The VM's tag type map is built once at boot from the empty catalog, so every BOOL or INT tag write is rejected and the program fails on every scan tick
  - sens-api-gateway/src/main.rs:5121-5126 (declared_types_from_process_image(&pi) at spawn), 5149-5158 and 5229-5236 (passed by value into the loops), 5742 (CommandHandler::new comes later)
  - sens-api-gateway/src/scripting/process_image_tagio.rs:136-150 (read default Real), 170-196 (write: declared != got -> TypeMismatch), 269-280 (builder)
  - sens-api-gateway/src/commands/deploy_st_source.rs:98-119 (compile-time descriptor 'bool' -> Bool), 278-279
  - sens-api-gateway/src/scripting/bytecode_vm.rs:884-912 (WriteTag error aborts the program)
  - RUN: /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/ioprov/ioprov_proof.rs printed: 'PROOF tick with boot declared_types = [("pump_ctl", Failed { error: TagIoFailed { tag: "pump_on", direction: "write", reason: "type mismatch: expected Real, got Bool" } })]'; with a freshly rebuilt map, 'Ok { writes_committed: 1 }'
- **OUT-02** (GAP2; verdict SELF; severity HIGH): Correction to the gap statement: BOOL/INT tags do not 'run as REAL'. Every BOOL or INT write is rejected with TypeMismatch, so the whole program fails on every scan
  - Claim: main.rs builds the runtime declared-types catalog once, before the command handler exists, from ProcessImage configs that are always empty at boot. set_configs is called only by cmd_update_io_config, and the saved io_config.yaml is never reloaded. The catalog is moved into the cadence loop and never rebuilt, although the builder's own doc says it is meant to run per tick or on config reload. deploy_st_source, by contrast, compiles against the live configs, so pump_run is typed BOOL and the compiled code writes StValue::Bool. With an empty catalog, SnapshotTagIo::write_tag defaults the declared type to Real and returns TypeMismatch for any Bool or Int value. The VM returns an error, the runner discards ALL of that program's writes for the tick (commit_partial_on_error=false), and the next tick does the same. Reads are wrong too: a BOOL input arrives as Real, and And/Or/Not/JumpIfFalse use pop_bool, which also faults. Only programs whose every tag access is REAL work today. Those then hit OUT-01: an AO setpoint is committed as Good and never reaches the drive (probe C: vfd_speed=30.0 Good/Script). There is also a second, inconsistent type map: compile-time tag_config_to_descriptor has no io_type fallback and does not map bit/word/dword/sint, while the runtime infer_st_value_type does. Those types would mismatch even with a correct catalog. The cloud IoDataType values (bool, int16/32, uint16/32, float32/64) agree in both maps.
  - writer (catalog): sens-api-gateway/src/main.rs:5120-5131 (declared_types_from_process_image(&pi) once, before Step 7 command handler at main.rs:5725)
  - main.rs:5148-5157 (catalog moved into run_scan_cycle_loop); bytecode_scan_cycle_task.rs:100-128 (same &declared_types every tick)
  - process_image_tagio.rs:262-268 (doc: 'calls this once per scan tick (or per boot + config-reload)') vs the actual single call
  - process_image.rs:402-408 set_configs; only production caller commands/io_config.rs:76; io_config.yaml written at io_config.rs:791-798 but never read (grep: no reader of io_config.yaml or parse_io_config_to_tags outside the command)
  - compile side: commands/deploy_st_source.rs:274-279 (tags from pi.get_configs() at deploy time), 98-118 ('bool' -> StValueType::Bool, writable for DO)
  - reader: process_image_tagio.rs:177-202 (declared.unwrap_or(Real); declared != got -> TagIoError::TypeMismatch); 144-151 (reads default Real); bytecode_vm.rs:803-834 (And/Or/Not/JumpIfFalse pop_bool)
  - bytecode_runner.rs:286-315 (Failed -> writes discarded); bytecode_scan_cycle_task.rs:140-146 (warn only)
  - cloud dataType: apps/sensor-service/src/edge-device/edge-device.service.ts:1462 (cfg.dataType.toLowerCase()); entities/device-io-config.entity.ts:41-49
  - RAN probe_a: 'boot catalog size = 0' -> tick = Failed{TagIoFailed{tag:"pump_run", direction:"write", reason:"type mismatch: expected Real, got Bool"}}, PI pump_run = None
  - RAN probe_c: REAL AO program with the same empty catalog -> Ok{writes_committed:1}, vfd_speed = 30.0 Good Script

</details>

### SENSOR-HIGH-274

**Program I/O bound to device A is resolved with no device check, so deploying the program to device B drives device A's pins and Modbus tags**

- Severity: HIGH · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: CONFIRMED 1
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** Holds. loadIoConfigMap fetches DeviceIoConfig by id only. resolveVariableSource emits gpio:{pin} or sensor:{tagName} from whichever device owns that row, and neither deployProgram, validateAutomationBindings nor deployScadaWithAutomation compares the config's device with the deploy target. The program editor goes further and lets each variable pick its I/O from a different device, so one program can mix devices. addVariable stores ioConfigId without validating it, and updateProgramVariable has no UI consumer. This is latent behind the established program-approval and step-UI blockers, but it means wrong physical actuation as soon as those are fixed.

**What the user sees.** A program written while viewing device A, then deployed with a package to device B, switches whatever is wired to the same pin numbers on B. The editor offers no way to re-point a variable except delete and re-add.

**Root cause.** Program I/O identity is a hardware row id instead of a tag identity resolved against the deploy target.

**Fix direction.** Variables reference registry tags. At deploy, resolve each tag's source and assert source.edgeDeviceId equals the target device (fail closed). Add a variable re-bind UI.

**Evidence (canonical citations).**

- `apps/sensor-service/src/automation/entities/program-variable.entity.ts:124-130`
- `apps/sensor-service/src/automation/automation.service.ts:1747`
- `apps/sensor-service/src/automation/automation.service.ts`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1222-1308`
- `apps/sensor-service/src/automation/automation.resolver.ts:432-437`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx`
- `apps/sensor-service/src/automation/automation.service.ts:700-745`
- `apps/sensor-service/src/automation/automation.service.ts:1269-1340`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1665-1733`
- `apps/sensor-service/src/automation/automation.service.ts:2313-2320`

<details><summary>Merged audit findings and full evidence</summary>

- **LINK-14** (BIND; verdict CONFIRMED; severity HIGH): Program I/O bound to device A is resolved with no device check, so deploying to device B drives A's GPIO pins and Modbus tags, and a variable cannot be re-bound
  - apps/sensor-service/src/automation/entities/program-variable.entity.ts:124-130 (ioConfigId, ioTagName)
  - apps/sensor-service/src/automation/automation.service.ts:1747 (loadIoConfigMap(variables)), 1820-1842 (find by id only), 1874-1896 (gpio:{pin} from foreign config)
  - grep automation.service.ts: no cfg.deviceId comparison
  - apps/sensor-service/src/process/services/scada-package.service.ts:1222-1308 (no device consistency check)
  - apps/sensor-service/src/automation/automation.resolver.ts:432-437 (updateProgramVariable) vs web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx (only add/remove/sync variable mutations)
  - (verifier) apps/sensor-service/src/automation/automation.service.ts:700-745 (addVariable stores ioConfigId unvalidated), 1747-1754, 1820-1842 (find by id only), 1874-1896 (gpio:{pin} / sensor:{tagName})
  - (verifier) apps/sensor-service/src/automation/automation.service.ts:1269-1340 (deployProgram: no ioConfig.deviceId check); scada-package.service.ts:1222-1308 and 1376-1520 (no device consistency check)
  - (verifier) web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1665-1733 (per-variable 'Select device...' over allActiveDevices, then ioConfigId/ioTagName)
  - (verifier) apps/sensor-service/src/automation/automation.resolver.ts:432-437 (updateProgramVariable); grep web: no updateProgramVariable/updateVariable consumer
  - (verifier) apps/sensor-service/src/automation/automation.service.ts:2313-2320 (SET_OUTPUT gpio: -> set_gpio target pin)
  - Verifier: I checked translateSetOutput to make sure a gpio: source really becomes a hardware set_gpio action: it does, so the wrong-pin symptom is real for GPIO outputs. No device-consistency check exists anywhere in either deploy path.

</details>

### SENSOR-HIGH-275

**Program outputs bound to Modbus or I2C channels can never actuate (register and slave discarded), and changing a channel requires delete and re-add, silently detaching program bindings**

- Severity: HIGH · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 2
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** resolveVariableSource turns a variable linked to a non-GPIO DeviceIoConfig into 'sensor:{tagName}' and drops modbusRegister, modbusSlaveId and modbusFunction. translateSetOutput turns a SET_OUTPUT on that variable into {type:'write_modbus', device: params.device ?? tagName, address: params.address ?? 0} (warnMissingAddress only logs). On the edge, action_write_modbus calls modbus_handle.write_register(&device, address, value), which looks up a configured Modbus DEVICE by that name and fails with 'Device not found: <tagName>'. It always writes a holding register, never a coil. Inline ST assignments (step entry/exit) to a sensor:-resolved variable become set_variable, but the comment there says wire_fb_outputs writes Modbus. In fact wire_fb_outputs only stores into the script context (var:/sensor:), and io_poll has no output write-back. The ioMappings map is built but never placed in the shipped ProgramDefinition, and no edge code reads it. Only GPIO outputs (set_gpio) reach hardware.

**What the user sees.** Once a program can be deployed, any step that switches a Modbus relay or sets a VFD or analog output through a program variable does nothing on the plant. The edge log shows 'Device not found: <TAG_NAME>' or a write to register 0, while the deploy reported success. Only Raspberry Pi GPIO outputs respond.

**Root cause.** The program I/O identity is reduced to a source string ('sensor:{tagName}') that cannot carry the channel's protocol address. The output path was never connected to the process image or the channel config: ioMappings is computed and then dropped.

**Fix direction.** Program variables should reference registry tags. At the edge, writes should go through the same process-image tag write that the HMI and cmd_set_output use (process_image.get_config(tag) -> GPIO/Modbus coil-or-register/I2C), so the channel's own protocol config decides the address. Remove the address-0 default and fail the deploy when an output cannot be resolved to a writable channel on the target device.

**Evidence (canonical citations).**

- `apps/sensor-service/src/automation/automation.service.ts:1883-1893`
- `apps/sensor-service/src/automation/automation.service.ts:2313-2334`
- `apps/sensor-service/src/automation/automation.service.ts:2518-2537`
- `apps/sensor-service/src/automation/automation.service.ts:1749-1754`
- `sens-api-gateway/src/scripting/engine.rs:1536-1609`
- `sens-api-gateway/src/modbus.rs:215-219`
- `sens-api-gateway/src/scripting/engine.rs:937-966`
- `sens-api-gateway/src/io_poll.rs`
- `sens-api-gateway/src/commands/program/deploy.rs:148`
- `web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:634`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1075-1081`
- `apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts:270`
- `apps/sensor-service/src/automation/entities/program-variable.entity.ts:124-130`
- `apps/sensor-service/src/automation/automation.service.ts:1849-1858`
- `apps/sensor-service/src/process/services/unified-tag.service.ts:246-252`
- `apps/sensor-service/src/process/services/scada-package.service.ts:966-978`

<details><summary>Merged audit findings and full evidence</summary>

- **LINK-V-01** (BIND-verifier; verdict SELF; severity HIGH): Program outputs bound to Modbus (or I2C) channels can never actuate: the channel's register and slave are discarded, and writes target a Modbus device named after the tag at register 0
  - apps/sensor-service/src/automation/automation.service.ts:1883-1893 (ioConfigId -> gpio:{pin} or sensor:{cfg.tagName}; register/slave unused)
  - apps/sensor-service/src/automation/automation.service.ts:2313-2334 (SET_OUTPUT sensor: -> write_modbus device=tagName, address params.address or 0), 2345-2351 (warnMissingAddress returns 0)
  - apps/sensor-service/src/automation/automation.service.ts:2518-2537 (inline ST: non-gpio target -> set_variable)
  - apps/sensor-service/src/automation/automation.service.ts:1749-1754 (ioMappings built) vs 1772-1805 (returned ProgramDefinition has no ioMappings); grep io_mappings\|ioMappings in sens-api-gateway/src: none
  - sens-api-gateway/src/scripting/engine.rs:1536-1609 (action_write_modbus -> handle.write_register(&device, address, value)); sens-api-gateway/src/modbus.rs:215-219 and ~339 ('Device not found: {}')
  - sens-api-gateway/src/scripting/engine.rs:937-966 (FB outputs only var:/sensor: into context; 'Direct GPIO/Modbus writes should be done via script actions')
  - grep write_register\|write_coil\|write_pin in sens-api-gateway/src/io_poll.rs: none (no process-image -> output write-back)
  - sens-api-gateway/src/commands/program/deploy.rs:148 (deployed program goes to script_storage, the engine above)
- **LINK-V-02** (BIND-verifier; verdict SELF; severity MEDIUM): Changing a channel's pin, register or type requires delete and re-add, which silently detaches program variables and leaves a stale ACTIVE registry tag that the deploy gate still accepts
  - Claim: The I/O edit modal disables tagName, ioType and dataType and hides the module address, Modbus and GPIO fields. formToUpdateInput sends none of them, so the only way to correct a pin or register is to delete the channel and add it again, which creates a new DeviceIoConfig.id. removeIoConfig is a plain delete with no cascade. program_variables.io_config_id has no FK, and edge-device code never touches unified_tags. At the next program deploy the missing config only logs a warning, and the variable falls back to 'sensor:{ioTagName}'. For a former GPIO output that turns set_gpio into write_modbus device=<tagName> (see LINK-V-01), so the output silently stops working. The registry tag for a deleted channel stays ACTIVE with a stale source.ioConfigId, and re-running Discover skips the existing fqn, so the source is never refreshed. Because the deploy tag gate resolves bindings against the registry, not the device's channel table, a widget bound to a deleted channel passes the gate even in enforce mode.
  - web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:634 (tagName disabled on edit), 658 and 672 (ioType/dataType disabled), 684-794 (address/Modbus/GPIO fields only when !isEdit), 462-478 (formToUpdateInput: no tag/protocol fields)
  - apps/sensor-service/src/edge-device/edge-device.service.ts:1075-1081 (removeIoConfig: delete only)
  - apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts:270 (program_variables.io_config_id character varying, no FK); apps/sensor-service/src/automation/entities/program-variable.entity.ts:124-130
  - apps/sensor-service/src/automation/automation.service.ts:1849-1858 (missing config -> logger.warn only), 1898-1900 (fallback sensor:{ioTagName})
  - apps/sensor-service/src/process/services/unified-tag.service.ts:246-252 (discover skips existing fqn), 129-153 (no retire hook); grep: UnifiedTag not referenced from apps/sensor-service/src/edge-device
  - apps/sensor-service/src/process/services/scada-package.service.ts:966-978 (gate resolves `${deviceCode}/${tagName}` against the registry only)

</details>

### SENSOR-MEDIUM-273

**PLC_SETPOINT deploy target sends no setpoints; the edge rejects it with "Missing setpoints"**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: SELF 1
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** The edge requires 'setpoints' for the PlcSetpoint target; the cloud never sends them.

**What the user sees.** Deploying with target PLC setpoint fails on the device with 'Missing setpoints'.

**Root cause.** Producer/consumer drift.

**Fix direction.** Send setpoints or remove the target from the UI.

**Evidence (canonical citations).**

- `apps/sensor-service/src/automation/automation.service.ts:1360-1375`
- `sens-api-gateway/src/commands/ide_deploy.rs:385-393`

<details><summary>Merged audit findings and full evidence</summary>

- **AUTO-08** (AUTO/XPORT; verdict SELF; severity MEDIUM): PLC_SETPOINT target sends no setpoints
  - apps/sensor-service/src/automation/automation.service.ts:1360-1375
  - sens-api-gateway/src/commands/ide_deploy.rs:385-393

</details>

### EDGE-MEDIUM-074

**Four divergent tag-to-hardware write paths on the edge: analog HMI writes double-scaled, set_output writes every Modbus tag as a coil, different scaling and quality rules per path**

- Severity: MEDIUM · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 2
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** The HMI executor reverse-scales the engineering value into the register and then calls update*tag(cmd.value). update_tag applies the raw-to-engineering scaling again whenever the config has raw and engineering ranges, so the displayed value is wrong. Example: raw 0..4095, eng 0..100, operator sets 50, the register gets 2047, the HMI shows 1.2. cmd_set_output always calls write_coil(value != 0) for any Modbus tag, AO holding registers included. The JSON engine writes raw pin numbers or device/address pairs and never updates the ProcessImage (OUT-09). ModbusClient already performs FC6 readback verification by default and returns a ModbusWriteReceipt with protocol_ack and readback fields. ModbusHandle::write_register discards it (.map(|*| ())), and write_coil has no readback at all. So the one confirmed-value primitive the codebase has never reaches a caller. DEP-08 (first-device Modbus in the HMI executor) and LINK-04 (bool value in set_output) are further symptoms of the same duplication.

**What the user sees.** After setting a VFD or AO setpoint of 50 on the device screen the widget shows about 1.2. An analog output written through set_output toggles a coil instead of changing the setpoint, and the call reports success.

**Root cause.** Each feature duplicated the tag-to-protocol mapping instead of calling one driver, and the readback results were never part of any return contract.

**Fix direction.** Fold all paths into the single OutputDriver from OUT-01. Resolve the device by slave_id (fixes DEP-08), choose coil or register by io_type, apply reverse scaling once, and return a typed receipt (protocol_ack, readback value, verified) that feeds the feedback slot of OUT-05. Add FC1/FC5 coil readback. Add table-driven tests: one tag config, every caller, the same port call and the same displayed value.

**Evidence (canonical citations).**

- `sens-api-gateway/src/main.rs:5666-5675`
- `sens-api-gateway/src/main.rs:6311-6328`
- `sens-api-gateway/src/process_image.rs:327-346`
- `sens-api-gateway/src/commands/io_config.rs:186-201`
- `sens-api-gateway/src/scripting/engine.rs:1475-1534`
- `sens-api-gateway/src/modbus.rs:448-461`
- `sens-api-gateway/src/config.rs:1566-1568`
- `sens-api-gateway/src/commands/io_config.rs:186-209`
- `sens-api-gateway/src/main.rs:5656-5679`

<details><summary>Merged audit findings and full evidence</summary>

- **OUT-07** (GAP2; verdict SELF; severity MEDIUM): Four divergent tag-to-hardware write paths: HMI analog writes are displayed double-scaled, set_output writes a coil for analog Modbus tags, coil writes have no readback, and the register readback receipt is thrown away
  - HMI executor: main.rs:5666-5675 (reverse_scale -> write_register), 5703-5705 (update_tag(&cmd.tag, cmd.value,...)); main.rs:6311-6328 reverse_scale; reader process_image.rs:327-346 (update_tag scales again when the config has raw/eng ranges)
  - set_output: commands/io_config.rs:186-201 (Modbus -> always write_coil(bool_value) regardless of io_type), 239-243 (update_tag Good)
  - JSON engine: scripting/engine.rs:1475-1534, 1537-1611, 1614-1680 (pin/device/address from the action, no tag config)
  - modbus.rs:448-461 (ModbusWriteReceipt), 1130-1170 (FC6 readback, default on per config.rs:1566-1568), 215-219 (write_register discards the receipt), 1225-1250 (write_coil: ACK only)
- **IOP-09** (GAP1; verdict SELF; severity LOW): set_output writes every Modbus tag as a coil with value != 0, so analog outputs and holding-register setpoints become a boolean coil write
  - Claim: For ProtocolConfig::Modbus, cmd_set_output ignores io_type, register_type and function, and always calls write_coil(device, register, value != 0.0). An AO setpoint of 42.5 becomes 'coil ON' at the register address. The HMI executor in main.rs does distinguish DO from AO (coil vs reverse-scaled register) but picks the first device (DEP-08). The two write paths disagree, and neither is correct on its own.
  - sens-api-gateway/src/commands/io_config.rs:186-209 (bool_value = value != 0.0; write_coil only)
  - sens-api-gateway/src/main.rs:5656-5679 (HMI path: DO -> coil, else write_register(reverse_scale))

</details>

### EDGE-MEDIUM-075

**A failing bytecode program is retried on every scan indefinitely with only a device-log warning**

- Severity: MEDIUM · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 1
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** BytecodeRunResult::Failed is documented as 'the engine typically disables the program + emits an alert'. The only production consumers are the cadence loop, which counts the result and logs warn!, and the task scheduler, which aggregates statistics. The program stays enabled in the registry and runs again on the next tick. Its outputs keep whatever value they last had, and no safe-state applies. TypeMismatch (OUT-02), NotFound (OUT-04), DivideByZero (SIM-10) and gas exhaustion therefore produce a silently dead program that keeps flooding the journal at the scan rate.

**What the user sees.** The program shows as deployed and running everywhere, but does nothing. No alarm or status badge appears. Finding the cause requires SSH and journalctl.

**Root cause.** The runner returns results, but no layer was given responsibility for acting on them.

**Fix direction.** Give Failed a policy: after N consecutive faults, transition the program to FAULTED, which disables it, drives its declared outputs to their safe-state values through OutputDriver, raises an edge alarm, and publishes program status (state, last error, tick) on the MQTT status topic and the HMI websocket. Show it in the automation UI and on bound widgets.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scripting/bytecode_runner.rs:77-81`
- `sens-api-gateway/src/scripting/bytecode_scan_cycle_task.rs:131-147`
- `sens-api-gateway/src/main.rs:5159-5165`

<details><summary>Merged audit findings and full evidence</summary>

- **OUT-08** (GAP2; verdict SELF; severity MEDIUM): A failing bytecode program is retried on every scan indefinitely with only a device-log warning: it is never disabled, raises no alarm, and has no status on the HMI or in the cloud
  - bytecode_runner.rs:77-81 (doc: 'The engine typically disables the program + emits an alert'), 286-315 (Failed result)
  - bytecode_scan_cycle_task.rs:131-147 (Failed -> summary.programs_failed += 1; warn!), 159-165 (summary only logged at loop exit, main.rs:5159-5165)
  - grep: no registry.disable / alarm / MQTT publish on a Failed result in the single-cadence path

</details>

### EDGE-MEDIUM-076

**Event-driven bytecode tasks never wake on field input changes (GPIO, Modbus, I2C reads bypass the change notification)**

- Severity: MEDIUM · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 2
- Rule: ADR-017 (ST bytecode runtime): the cloud compiles ST and ships signed bytecode; the edge executes it and drives physical I/O

**Claim.** The multi-task scheduler's Event tasks are woken only by TagChange events. update_tag never sends on change_tx, although the struct doc says 'update_tag + update_tag_raw emit one TagChange per call'. io_poll stores GPIO, Modbus and generic I2C values with update_tag, and the HMI executor and set_output use update_tag as well. Only Atlas EZO reads, VM commits, JSON-engine var/sensor syncs, forces and OPC UA writes broadcast. A task with event_tag = start_button (GPIO DI) or a Modbus flow switch therefore never runs. Latent until config.scripting.tasks is used.

**What the user sees.** A program set to run 'on change of start_button' never runs when the button is pressed. It only runs if the tag happens to be written by a script or a force.

**Root cause.** The TagChange broadcast was added to update_tag_raw only, and the doc and tests cover only that function.

**Fix direction.** Make update_tag broadcast as well (or make it a thin wrapper over one internal insert-and-broadcast function, so no setter can skip it). Add a test that drives io_poll's update path and asserts the event task fires.

**Evidence (canonical citations).**

- `sens-api-gateway/src/process_image.rs:241-246`
- `sens-api-gateway/src/io_poll.rs:486-503`
- `sens-api-gateway/src/main.rs:5703-5705`
- `sens-api-gateway/src/commands/io_config.rs:239-243`
- `sens-api-gateway/src/scripting/task_scheduler.rs:731-750`
- `sens-api-gateway/src/process_image.rs:299-347`
- `sens-api-gateway/src/io_poll.rs:161-168`
- `sens-api-gateway/src/scripting/task_scheduler.rs:725-748`

<details><summary>Merged audit findings and full evidence</summary>

- **OUT-10** (GAP2; verdict SELF; severity MEDIUM): Event-driven bytecode tasks never wake on field input changes: GPIO, Modbus and generic I2C reads use update_tag, which does not broadcast TagChange
  - process_image.rs:241-246 (doc claims update_tag emits), 299-347 (update_tag: no change_tx.send), 380-386 (only update_tag_raw sends)
  - io_poll.rs:486-503 (maybe_update_tag -> pi.update_tag) used at 163-171, 208-216, 301-324, 344-367; main.rs:5703-5705 and io_config.rs:239-243 (update_tag)
  - task_scheduler.rs:731-750 (listener -> trigger_event(tag_change.tag_name))
  - RAN probe_e: subscribe_changes + update_tag("level") -> 'E update_tag broadcast received = false'
- **IOP-10** (GAP1; verdict SELF; severity LOW): Hardware input changes never wake event-driven tasks: update_tag (used for GPIO, Modbus and generic I2C reads) emits no TagChange
  - Claim: Only update_tag_raw sends on change_tx. update_tag, which io_poll uses for GPIO, Modbus and I2C register/direct reads, inserts the value without broadcasting. The multi-task scheduler's event listener wakes only on change_tx. A task configured to run on an input change therefore never fires for those inputs, only for script writes and Atlas EZO reads (which use update_tag_raw).
  - sens-api-gateway/src/process_image.rs:299-347 (update_tag: no change_tx.send), 349-385 (update_tag_raw sends)
  - sens-api-gateway/src/io_poll.rs:161-168, 203-210, 301-308, 343-350 (maybe_update_tag -> update_tag); 247-255 (Atlas EZO uses the raw variant)
  - sens-api-gateway/src/scripting/task_scheduler.rs:725-748 (listener only on subscribe_changes)

</details>

## B. Deploy transport and status

### SENSOR-CRITICAL-276

**Edge rejects every deploy command at the two-person-integrity gate: the cloud publishes only unsigned JSON, the envelope signer is not wired, nested deploy params cannot be canonicalised, and no RBAC manifest or co-approval flow exists**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 1; re-checked in session
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** deploy_program, deploy_scada_package and deploy_bundle all map to StaticPermission::DeployProgram, which requires two-person integrity; verified_co_approver is serde(skip_deserializing) so plain JSON is always false; the cloud only publishes unsigned JSON and CommandEnvelopeSignerService is not wired (always co_approver_signature null); canonicalisers reject nested params so deploys cannot be signed anyway; no RBAC manifest is ever sent.

**What the user sees.** Nothing ever deploys; the device replies two_person_integrity_required (which the cloud then ignores, AUTO-03).

**Root cause.** The edge security model (signed envelopes, co-approval, RBAC manifest) was built without the cloud half.

**Fix direction.** Implement the cloud half end to end (signer wired, canonical form supports the deploy payload by signing its hash, co-approval workflow in the UI, manifest distribution) or define a risk-tiered policy decided by the product owner; e2e test through execute_command.

**Evidence (canonical citations).**

- `sens-api-gateway/src/commands/catalog.rs:470-473,713-716,749-752`
- `sens-api-gateway/src/authz/permission.rs:584-599`
- `sens-api-gateway/src/mqtt.rs:202-203`
- `sens-api-gateway/src/commands/dispatch_lifecycle.rs:207-246`
- `apps/sensor-service/src/release-bundle/deploy-bundle-dispatcher.service.ts:157-188`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1035-1041,1078`
- `apps/sensor-service/src/automation/automation.service.ts:1386-1391,1449`
- `apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:249`
- `sens-api-gateway/src/command_envelope/canonical.rs:133-137`
- `sens-api-gateway/src/authz/manifest_runtime.rs:360-371`

<details><summary>Merged audit findings and full evidence</summary>

- **XPORT-01** (AUTO/XPORT; verdict SELF; severity BLOCKER): The edge rejects every deploy command the cloud can send at the two-person-integrity gate
  - sens-api-gateway/src/commands/catalog.rs:470-473,713-716,749-752
  - sens-api-gateway/src/authz/permission.rs:584-599
  - sens-api-gateway/src/mqtt.rs:202-203
  - sens-api-gateway/src/commands/dispatch_lifecycle.rs:207-246
  - apps/sensor-service/src/release-bundle/deploy-bundle-dispatcher.service.ts:157-188
  - apps/sensor-service/src/process/services/scada-package.service.ts:1035-1041,1078
  - apps/sensor-service/src/automation/automation.service.ts:1386-1391,1449
  - apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:249
  - sens-api-gateway/src/command_envelope/canonical.rs:133-137
  - sens-api-gateway/src/authz/manifest_runtime.rs:360-371

</details>

### INFRA-CRITICAL-238

**SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX is not provisioned in any deployment (compose, env examples, helm, runbooks), so every bundle deploy is refused in production**

- Severity: CRITICAL · Domain: INFRA · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 1; re-checked in session
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** deployScadaWithAutomation throws when DeploySigningService is not configured; the env var appears in no compose, env example, helm or runbook.

**What the user sees.** Unified editor 'deploy with automation' fails with 'Bundle deploys require deploy signing'.

**Root cause.** Secret introduced in code without deployment wiring.

**Fix direction.** Provision the key via the secret pipeline (runbook + compose + rotation) and add a config-presence invariant.

**Evidence (canonical citations).**

- `apps/sensor-service/src/process/services/scada-package.service.ts:1411-1416`
- `apps/sensor-service/src/deploy-artifact/deploy-signing.service.ts:18,122-136`
- `docker-compose.droplet.yml:1029-1085`

<details><summary>Merged audit findings and full evidence</summary>

- **XPORT-02** (AUTO/XPORT; verdict SELF; severity BLOCKER): Bundle (SCADA+automation) deploys are refused in production: SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX is not configured anywhere
  - apps/sensor-service/src/process/services/scada-package.service.ts:1411-1416
  - apps/sensor-service/src/deploy-artifact/deploy-signing.service.ts:18,122-136
  - docker-compose.droplet.yml:1029-1085 (sensor-service env, no such var)

</details>

### SENSOR-CRITICAL-277

**Provisioning never delivers the deploy-signing public key to the device, so cmd_deploy_bundle always fails with "firmware_signing_pubkey not wired"**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** Installer writes firmware_update mode disabled with no signing_pubkey_hex; cmd_deploy_bundle fails 'firmware_signing_pubkey not wired'; provisioning carries no signing key.

**What the user sees.** Bundle deploys fail on the device even after XPORT-01/02 are fixed.

**Root cause.** Key distribution missing from provisioning.

**Fix direction.** Deliver the deploy-signing public key (and rotation) through provisioning.

**Evidence (canonical citations).**

- `apps/sensor-service/src/edge-device/installer-script.service.ts:349-350,447-448`
- `sens-api-gateway/src/main.rs:2263-2273`
- `sens-api-gateway/src/commands/bundle_deploy.rs:327-338`

<details><summary>Merged audit findings and full evidence</summary>

- **XPORT-03** (AUTO/XPORT; verdict SELF; severity BLOCKER): The device never receives the public key to verify a bundle
  - apps/sensor-service/src/edge-device/installer-script.service.ts:349-350,447-448
  - sens-api-gateway/src/main.rs:2263-2273
  - sens-api-gateway/src/commands/bundle_deploy.rs:327-338

</details>

### SENSOR-CRITICAL-280

**Linking an automation program to a SCADA package breaks deploy: the builder's deploy never ships linked programs yet requires them approved, and deploy-time binding validation reads a flat shape the builder never writes**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: CONFIRMED 4, PARTIAL 1, SELF 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** The builder's Automation panel stores links in meta.automationBindings. Its Deploy button calls only useDeployScadaPackage → deployScadaPackageToEdge, the single-command path, which publishes only the SCADA package. That path still runs validateAutomationBindings, which rejects the deploy unless every linked program is APPROVED or DEPLOYED. The program-carrying bundle (deployScadaWithAutomation / useDeployScadaBundle) is wired only into UnifiedEditorPage.

**What the user sees.** After linking a program in the builder and deploying, either the deploy fails with 'Automation binding validation failed … must be APPROVED or DEPLOYED', or, once approved, the screens arrive on the device but the program logic never runs there.

**Root cause.** Two deploy entrypoints with different semantics, and the builder uses the one that ignores programs.

**Fix direction.** One deploy entrypoint (the bundle) for every editor, shipping the package plus its bound programs atomically.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:45,207,476-478`
- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:255-268`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:20`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:356-382`
- `apps/sensor-service/src/process/services/scada-package.service.ts:948-949`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:307,1276`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:57,307`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:89-110,235-237`
- `apps/sensor-service/src/process/resolvers/process.resolver.ts:387-401`
- `web/modules/sensor-module/src/hooks/useAutomationPrograms.ts:31-44,65-81`
- `apps/sensor-service/src/automation/automation.service.ts`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:165-167,179-182`
- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:234-252`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:307`
- `apps/sensor-service/src/automation/automation.service.ts:305-306`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:165-182`
- `apps/sensor-service/src/process/services/scada-package.service.ts:947-948`
- `web/modules/sensor-module/src/types/scada-package.types.ts:125-140`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:90-111`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1238-1243`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:89-111`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:367-382`
- `web/modules/sensor-module/src/types/scada-package.types.ts:135-140`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:90-110`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1240-1243`
- `web/modules/sensor-module/src/types/scada-package.types.ts:128-140`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:89-110`
- `apps/sensor-service/src/automation/entities/automation-program.entity.ts:152-155`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:374-379`
- `web/modules/sensor-module/src/types/scada-package.types.ts:124-140`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1658-1666`
- `apps/sensor-service/src/process/services/scada-package.service.ts:949`
- `libs/sensor-contracts/src/scada-package-doc/scada-package-doc.types.ts:82`
- `libs/sensor-contracts/src/__tests__/package-doc-upcaster.spec.ts:12`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1224`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1658-1663`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-09** (DEP; verdict CONFIRMED; severity BLOCKER): The builder's Deploy never ships the linked automation programs, yet still requires them to be approved
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:45,207,476-478 (useDeployScadaPackage only)
  - web/modules/sensor-module/src/hooks/useScadaPackage.ts:255-268 (deployScadaPackageToEdge)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:20 + AutomationBindingPanel.tsx:356-382 (programs linked in builder)
  - apps/sensor-service/src/process/services/scada-package.service.ts:948-949 (validateAutomationBindings), 1258-1266 (APPROVED/DEPLOYED required), 1035-1078 (only the package is published)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:307,1276 (only bundle caller)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:45,207,476-478 (only useDeployScadaPackage)
  - (verifier) web/modules/sensor-module/src/hooks/useScadaPackage.ts:255-268 (deployScadaPackageToEdge); 234-250 useDeployScadaBundle used only by pages/unified/UnifiedEditorPage.tsx:57,307
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:89-110,235-237 (links stored in meta.automationBindings)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:948-949 (validateAutomationBindings), 1258-1266 (APPROVED/DEPLOYED required), 1020-1078 (only the package is published); grep automationBindings server-side: only this validator and the bundle path (1390)
  - (verifier) apps/sensor-service/src/process/resolvers/process.resolver.ts:387-401 (BadRequest → {success:false, message} shown in the dialog)
  - Verifier: Verified, and I raised the severity. AUTO-01 says a program can never be approved in the UI, so linking any program makes the builder's Deploy fail outright. Even an approved program never ships through this path. That is exactly the user's 'link and deploy' flow, so the feature fails outright: BLOCKER. It duplicates sibling LINK-07.
- **LINK-07** (BIND; verdict CONFIRMED; severity HIGH): Linking any automation program in the builder makes Deploy fail, and when it passes the builder's deploy still never ships the program
  - Claim: Holds. ProgramSelector lists every program (filter {}, server filters only when a status is given), so DRAFT programs can be linked. The builder deploys through deployScadaPackageToEdge, which runs validateAutomationBindings (requires APPROVED/DEPLOYED) and publishes only deploy_scada_package. Programs ship only through deployScadaWithAutomation, which only UnifiedEditorPage uses. Sibling DEP-09 reports the same defect.
  - web/modules/sensor-module/src/hooks/useAutomationPrograms.ts:31-44,65-81 (filter: {})
  - apps/sensor-service/src/automation/automation.service.ts:~303-306 (status filter only when provided)
  - web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:165-167,179-182 ('No approved programs')
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:45,207,476-478 (deploy = useDeployScadaPackage)
  - apps/sensor-service/src/process/services/scada-package.service.ts:948-949 (validateAutomationBindings in single deploy), 1258-1268 (APPROVED/DEPLOYED required), 1033-1042 + 1074 (publishes only deploy_scada_package)
  - web/modules/sensor-module/src/hooks/useScadaPackage.ts:234-252 (useDeployScadaBundle) used only by pages/unified/UnifiedEditorPage.tsx:307
  - (verifier) apps/sensor-service/src/automation/automation.service.ts:305-306 (status filter only if provided)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:165-182 ('No approved programs' when the list is empty)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:45,207,476-478 (useDeployScadaPackage)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:947-948 (validateAutomationBindings), 1256-1268 (APPROVED/DEPLOYED), 1040 and 1154 (only 'deploy_scada_package' published; the program bundle lives in deployScadaWithAutomation at 1376)
  - (verifier) web/modules/sensor-module/src/hooks/useScadaPackage.ts:234-252; grep: useDeployScadaBundle used only at pages/unified/UnifiedEditorPage.tsx:307
  - Verifier: No other builder code calls the bundle path, and the dialog has no automation step. Both halves of the claim were verified.
- **LINK-08** (BIND; verdict CONFIRMED; severity MEDIUM): The backend validates a flat automation-binding shape the builder never writes, so the variable-to-widget mapping is unchecked, never shipped and never refreshed
  - Claim: Holds. The builder writes nested {programId, programName, programCode, variableBindings[]}, but the backend reads top-level variableId/boundWidgetId, so only the program-exists and status checks run. variableBindings/boundTag have no reader in apps, libs or the edge. Variables are snapshotted once, when the program is added. Siblings DEP-10, EDIT-06 and PLACE-V-02 report the same defect.
  - web/modules/sensor-module/src/types/scada-package.types.ts:125-140 (nested shape)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:90-111 (snapshot at add), 224-238 (meta.automationBindings), 357 (load)
  - apps/sensor-service/src/process/services/scada-package.service.ts:1238-1243 (top-level variableId/boundWidgetId), 1271-1299 (checks that never run), 1659-1663 (flat interface)
  - grep: no reader of variableBindings/boundTag outside web/modules/sensor-module/src/components/scada-builder (AutomationBindingPanel, SimulationSidebar) and store/scada/projectSlice.ts
  - (verifier) web/modules/sensor-module/src/types/scada-package.types.ts:125-140
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:89-111 (snapshot), 224-238 (meta.automationBindings)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:367-382 (variables fetched only for pendingProgram at add time)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:1238-1243, 1271-1299, 1659-1663 (flat interface)
  - (verifier) grep variableBindings\|boundTag in apps, libs, sens-api-gateway/src and static: no hits
  - Verifier: Both sides were read. No upcaster or mapper flattens the shape.
- **DEP-10** (DEP; verdict PARTIAL; severity LOW): Deploy-time binding validation reads a flat shape the builder never writes, so its variable and widget checks never run
  - Claim: validateAutomationBindings reads b.variableId and b.boundWidgetId at the top level of each binding. The builder nests them under variableBindings[], so the variable-ownership and widget-existence checks never run, and only program existence and status are enforced. The last sentence of the claim is wrong. programCode is the program's 30-char identifier (automation_programs.program_code, varchar(30)), not its source. The SCADA document carries programId, programName, programCode and variable metadata, not program source.
  - web/modules/sensor-module/src/types/scada-package.types.ts:135-140 (nested variableBindings)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:90-110 (addAutomationProgram writes the nested shape + programCode), 235-237 (serialized into meta)
  - apps/sensor-service/src/process/services/scada-package.service.ts:1240-1243 (reads b.variableId / b.boundWidgetId), 1270-1301 (checks gated on those), 1659-1663 (flat interface)
  - (verifier) web/modules/sensor-module/src/types/scada-package.types.ts:128-140 (nested variableBindings)
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:89-110, 235-237
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:1240-1243, 1270-1301, 1658-1663 (flat interface)
  - (verifier) apps/sensor-service/src/automation/entities/automation-program.entity.ts:152-155 (programCode = program_code length 30)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:374-379 (passes automationProgram.programCode)
  - Verifier: The flat-vs-nested mismatch is verified. The 'full source in the document' sub-claim is refuted by the entity definition. The impact is a missing validation, and it is moot while bindings never ship (DEP-09), so LOW. It duplicates siblings EDIT-06 and LINK-08.
- **EDIT-06** (EDIT; verdict CONFIRMED; severity LOW): The backend automation-binding check reads a flat shape the builder never writes, so deleted widgets or variables are never flagged at deploy
  - Claim: DUPLICATE of PLACE-V-02 (verdict_PLACE_5.json), DEP-10 (find_DEP_9.json) and LINK-08 (find_LINK_6.json); merge all four. The claim holds. The builder writes nested meta.automationBindings[].variableBindings[] (projectSlice.ts:90-111,235-237). validateAutomationBindings reads b.variableId and b.boundWidgetId at the top level (scada-package.service.ts:1240-1242, interface at :1659-1663), so checks 3 and 4 (:1268-1300) never run. Only the program existence and status check runs.
  - writer: web/modules/sensor-module/src/types/scada-package.types.ts:124-140 (VariableBinding nested under AutomationBinding.variableBindings); store/scada/projectSlice.ts:90-111 (addAutomationProgram), 235-237 (serialized into meta)
  - reader: apps/sensor-service/src/process/services/scada-package.service.ts:1658-1666 interface AutomationBinding { programId; variableId?; boundWidgetId? }; :1241-1243 variableIds/widgetIds = bindings.map(b => b.variableId / b.boundWidgetId); :1271-1300 checks 3 and 4
  - called from deploy: scada-package.service.ts:949 and :1572
  - libs/sensor-contracts/src/scada-package-doc/scada-package-doc.types.ts:82 automationBindings?: unknown[]; libs/sensor-contracts/src/**tests**/package-doc-upcaster.spec.ts:12 flat fixture
  - (verifier) writer: web/modules/sensor-module/src/store/scada/projectSlice.ts:90-111 (nested variableBindings), 235-237 (serialized into meta); types/scada-package.types.ts:124-140
  - (verifier) reader: apps/sensor-service/src/process/services/scada-package.service.ts:1224 (meta.automationBindings cast), 1240-1242 (top-level variableId/boundWidgetId), 1268-1300 (checks 3/4), 1659-1663 (flat interface)
  - (verifier) callers: scada-package.service.ts:949 (deploy), 1572 (bundle deploy)
  - (verifier) grep automationBindings\|variableBindings in libs/sensor-contracts/src and apps/sensor-service/src: no mapper or upcaster; contract types it as unknown[] (scada-package-doc.types.ts:82)
  - Verifier: There is no upcaster that flattens the shape. variableBindings has no consumer outside the builder's SimulationSidebar, so the missing checks have no device-side consequence. LOW is right for this facet; the merged finding is graded MEDIUM elsewhere.
- **PLACE-V-02** (PLACE-verifier; verdict SELF; severity MEDIUM): Backend deploy validation reads a flat automation-binding shape the builder never writes, so widget and variable link checks never run
  - Claim: The builder stores meta.automationBindings as {programId, programName, programCode, variableBindings:[{variableId, boundWidgetId, boundTag, ...}]}. The sensor-service validateAutomationBindings (called on deploy and on bundle deploy) types each binding as {programId, variableId?, boundWidgetId?} and collects b.variableId and b.boundWidgetId from the TOP level. For builder-written packages both lists are always empty, so check 3 (the variable exists and belongs to the program) and check 4 (the bound widget exists in the package) silently pass. Dangling links left by cut (PLACE-22), or variables deleted from a program, are never reported. Only the programId and status check works. No backend or edge code reads variableBindings or boundTag, so the widget-variable link in the builder has no effect outside the builder's own SimulationSidebar.
  - writer: web/modules/sensor-module/src/store/scada/projectSlice.ts:90-110 addAutomationProgram builds a nested variableBindings[]; L121-130 bindVariableToWidget sets variable.boundWidgetId/boundTag; L234-236 serialized as meta.automationBindings
  - types: web/modules/sensor-module/src/types/scada-package.types.ts:125-140 VariableBinding / AutomationBinding (nested)
  - reader: apps/sensor-service/src/process/services/scada-package.service.ts:1658-1663 interface AutomationBinding {programId; variableId?; boundWidgetId?}; L1241-1243 maps b.variableId / b.boundWidgetId from the top level; L1271-1297 checks 3 and 4 iterate those empty lists
  - callers: scada-package.service.ts:949 (deploy) and L1572 (bundle deploy)
  - grep 'variableBindings\|boundTag' in apps/, libs/ and sens-api-gateway/: no backend or edge consumer; the only runtime consumer is web/.../components/scada-builder/SimulationSidebar.tsx:452-474

</details>

### SENSOR-HIGH-278

**Every deploy and push reports success on broker publish, not on device confirmation (SCADA deploy, program deploy, bundle "staged", IO config "Cihaza Gonder"), and the server's stripped-widgets note is discarded**

- Severity: HIGH · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 1, SELF 2
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** scada-package.service sets PUBLISHED and returns 'deployed successfully' after publish; automation returns 'Program deployed to X'; unified editor shows 'Bundle staged' on outbox write; no resolver exposes release_bundles.

**What the user sees.** The UI says deployed while the device rejected it.

**Root cause.** Status derived from the send, not the ack.

**Fix direction.** Two-phase status (SENT -> CONFIRMED/FAILED from ack) with timeouts for every deploy kind; UI shows device truth.

**Evidence (canonical citations).**

- `apps/sensor-service/src/process/services/scada-package.service.ts:1078-1092`
- `apps/sensor-service/src/automation/automation.service.ts:1478`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1280`
- `web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:104-111`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1086-1092`
- `web/modules/sensor-module/src/components/deploy/ScadaPackagePreview.tsx:20-24`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:473`
- `web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:99-117`
- `web/modules/sensor-module/src/components/deploy/ScadaPackagePreview.tsx:19-24`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1573-1575`
- `apps/sensor-service/src/edge-device/edge-device.resolver.ts:394-403`
- `web/modules/sensor-module/src/graphql/edge-device.queries.ts:258-265`
- `web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:1158-1160`

<details><summary>Merged audit findings and full evidence</summary>

- **XPORT-04** (AUTO/XPORT; verdict SELF; severity HIGH): 'Deployed' is reported on broker publish, not device confirmation
  - apps/sensor-service/src/process/services/scada-package.service.ts:1078-1092
  - apps/sensor-service/src/automation/automation.service.ts:1478
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1280
- **DEP-12** (DEP; verdict CONFIRMED; severity MEDIUM): The Deploy dialog reports success on broker publish, throws away the server's 'widgets stripped' note, auto-closes, and previews counts that will not ship
  - Claim: On success:true the dialog shows the fixed text 'Deploy started successfully!' and closes after 2 s. The server's message, which lists the display-only widgets stripped from the device payload, is used only on failure. The bundle path discards the strip list entirely (const { doc: edgeDoc } = …). ScadaPackagePreview counts screens, widgets and size from the LOCAL store before the edge transform, so it includes widgets that will be stripped and the unsaved state (LIFE-07). Success means only 'the MQTT publish returned'.
  - web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:104-111 (message ignored on success; close after 2 s), 146-151 (fixed success text)
  - apps/sensor-service/src/process/services/scada-package.service.ts:1086-1092 (strip note in message), 1585-1588 (bundle path drops 'stripped')
  - web/modules/sensor-module/src/components/deploy/ScadaPackagePreview.tsx:20-24 (pre-transform counts and size)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:473 (preview from toScadaPackageJSON())
  - (verifier) web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:99-117 (on success: setDeploySuccess + close after 2 s; result.message used only on failure), 146-151 (fixed 'Deploy started successfully!')
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:1086-1092 (strippedNote in message), 1584-1587 (bundle path destructures only { doc })
  - (verifier) web/modules/sensor-module/src/components/deploy/ScadaPackagePreview.tsx:19-24 (counts from local store, pre-transform)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:473 (preview = toScadaPackageJSON())
  - Verifier: Holds as described. Success means only that the broker publish returned. It overlaps sibling XPORT-04.
- **IOP-07** (GAP1; verdict SELF; severity MEDIUM): 'Cihaza Gonder' shows a green success banner even when the push failed, timed out or the device was offline
  - Claim: pushIoConfigToDevice returns a resolved {success:false, error} when the device is offline, the build fails, the ack does not arrive within 15 s, or the edge rejects the config. The resolver passes that through unchanged. The page renders the success banner whenever pushMutation.isSuccess && pushMutation.data, and never reads data.success or data.error. The error banner covers only thrown network or GraphQL errors.
  - apps/sensor-service/src/edge-device/edge-device.service.ts:1573-1575 (offline -> {success:false}), 1593-1596, 1604-1611 (timeout -> {success:false}), 1638-1643, 1726-1732 (edge rejection)
  - apps/sensor-service/src/edge-device/edge-device.resolver.ts:394-403 (returns the result as-is)
  - web/modules/sensor-module/src/graphql/edge-device.queries.ts:258-265 (selects success, error)
  - web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:1158-1160 (mutate), 1504-1511 ('Konfigurasyon cihaza başarıyla gönderildi.' whenever isSuccess && data), 1512-1520 (isError only)

</details>

### SENSOR-HIGH-279

**Cloud runtime and package status follow the latest SAVED draft, not the deployed revision: "Published vN", cloud alarms and scripts change on save, saves never reload the runtime, and deleting any package switches off the whole tenant runtime**

- Severity: HIGH · Domain: SENSOR · Plan phase: F6 · Deadline: 2027-04-19
- Verification: CONFIRMED 2, SELF 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** The package moves to PUBLISHED as soon as the MQTT publish returns, before any device result. updateScadaPackage bumps version on every save and never resets status, so later edits leave a 'Published' package whose current package_data was never deployed. The list shows v{pkg.version} (the save counter) and 'Published'. ScadaOperatorPage renders the latest saved doc, not the deployed artifact. ScadaActivationService loads alarm rules and scripts from the CURRENT package_data of every 'published' row, so saved-but-undeployed edits go live in the cloud alarm and script runtime on the next activation, while the device runs the old artifact (or nothing).

**What the user sees.** The package list says 'Published v8' while the device shows v5, or nothing if the deploy was rejected. Cloud alarms and scripts change as soon as you save, without deploying. The operator view shows screens that are not on the device.

**Root cause.** Status and version live on the editable row. Nothing records which artifact is actually running where.

**Fix direction.** Make the deployed artifact (deploy log + artifact id, confirmed by the device ack) the source for the 'deployed version' and for the cloud runtime. Keep the draft and saved version separate from it, and add a 'modified since deploy' state.

**Evidence (canonical citations).**

- `apps/sensor-service/src/process/services/scada-package.service.ts:1077-1081`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:168-176`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:26-40`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:150-170`
- `apps/sensor-service/src/process/services/scada-package.service.ts:644-662`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:24-40`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:115-120`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:99-105`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:135-146`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:226,249-253`
- `apps/sensor-service/src/process/services/scada-package.service.ts:467-505`
- `apps/sensor-service/src/process/services/scada-package.service.ts:692-709`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1078-1081`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:239-248`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:50,207-218`
- `apps/sensor-service/src/process/services/scada-package.service.ts:496-503`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:167-186`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderStatusBar.tsx:40-41`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-13** (DEP; verdict CONFIRMED; severity HIGH): 'Published vN' and the cloud runtime reflect the latest SAVED document, not what was deployed
  - apps/sensor-service/src/process/services/scada-package.service.ts:1077-1081 (PUBLISHED right after publish), 467-506 (update: version+1, status untouched)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:168-176 (v{pkg.version} + status badge)
  - web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:26-40 (loads latest saved packageData)
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:150-170 (SELECT package_data … WHERE status='published' → alarm rules + scripts)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:1077-1081 (PUBLISHED right after MQTT publish), 467-506 (update bumps version, never touches status, emits no lifecycle event)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:644-662 (comment: only the bundle path waits for device confirmation)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:24-40 (renders latest saved packageData)
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:115-120 (reload on PUBLISHED), 150-175 (SELECT package_data WHERE status='published' → rules+scripts)
  - Verifier: Holds on both sides. There is no 'deployed artifact' column, and nothing resets status or records which artifact is running where. It overlaps siblings SET-06 and XPORT-04.
- **SET-06** (SET; verdict CONFIRMED; severity HIGH): Cloud alarms and scripts run the last saved draft rather than what was deployed, saves never reload, and deleting any package switches off the whole tenant
  - Claim: Holds. Sub-point (a), saved-but-undeployed edits going live in the cloud, overlaps sibling DEP-13. Sub-point (b), deleting any package (including a draft) deactivating the whole tenant's cloud runtime with no reactivation while any socket stays connected, is new. So is (c), that only status='published' rows are loaded.
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:99-105 (activate on operator connect), 114-120 (publish reload only if active), 122-128 (archive → deactivate tenant)
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:135-146 (activateTenant no-op if active), 152-157 (SELECT package_data ... WHERE status = 'published'), 196-201 (deactivate drops all)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:226,249-253 (CONNECTED emitted only when priorTenantConnections === 0)
  - apps/sensor-service/src/process/services/scada-package.service.ts:467-505 (update: status untouched, no lifecycle event)
  - apps/sensor-service/src/process/services/scada-package.service.ts:692-709 (delete → ARCHIVED event for any status)
  - apps/sensor-service/src/process/services/scada-package.service.ts:1078-1081 (single deploy marks PUBLISHED and emits)
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:99-105 activate on CONNECTED; 114-120 publish reload only if isTenantActive; 122-128 archive → deactivate(tenantId)
  - (verifier) scada-activation.service.ts:135-146 activateTenant no-op when active; 152-157 SELECT package_data … WHERE status='published'; 196-201 deactivate drops all rules and jobs
  - (verifier) alarm-engine.service.ts:239-248 deactivateTenant deletes tenant; isTenantActive = tenants.has
  - (verifier) scada-runtime.gateway.ts:226,249-253 CONNECTED only when priorTenantConnections === 0
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:467-505 update: status untouched, no lifecycle emit
  - (verifier) scada-package.service.ts:692-709 delete → ARCHIVED emitted for any non-archived status
  - (verifier) scada-package.service.ts:1077-1081 single deploy marks PUBLISHED and emits on MQTT publish
  - (verifier) scada-activation.service.ts:50,207-218 15-min idle eviction
  - Verifier: I confirmed there is no other activation entry point (grep activateTenant/setAlarmRules shows only this service). After an archive deactivates the tenant, a later publish is ignored and a new socket does not emit CONNECTED while others are connected, so the tenant stays dark. The defect is masked today by SET-02/03, but once the cloud alarm path works it produces wrong or missing alarms, so I kept HIGH.
- **LIFE-32** (LIFE-verifier; verdict SELF; severity MEDIUM): The package list shows 'Published vN' for content that was never confirmed on a device and keeps 'Published' after every later edit
  - Claim: The builder's deploy path (deployScadaPackageToEdge) sets status=PUBLISHED as soon as the MQTT publish returns, not on edge confirmation. The separate transport audit found that the edge rejects every deploy and replies are never routed back, so nothing ever reverts it. updateScadaPackage never touches status but increments version on each save. The list renders the status badge and 'v{version}' side by side, so after deploy + edits it reads 'Published v7' while at most v5 was ever sent and none was applied.
  - apps/sensor-service/src/process/services/scada-package.service.ts:1077-1081 (PUBLISHED on broker publish)
  - apps/sensor-service/src/process/services/scada-package.service.ts:496-503 (update: version++, status untouched)
  - grep 'ScadaPackageStatus.DRAFT' in sensor-service: only create (460), so status never returns to DRAFT on edit
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:167-186 (version column + status badge)
  - web/modules/sensor-module/src/pages/scada/ScadaBuilderStatusBar.tsx:40-41 (builder says 'Draft v1' at the same time)

</details>

### EDGE-HIGH-077

**Edge stores the cloud package version as the SQLite PRIMARY KEY, so redeploying the same version, any rollback or a bundle pre-image restore fails**

- Severity: HIGH · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** The bundle sub-claim needs one precision. The package pre-image restore always collides, because its version is already a row, so the bundle restore of a prior package can never succeed. When the package artifact itself was the failing step, the report wrongly says 'mixed state' for an untouched device. When the package applied and a LATER artifact failed, the restore also fails and the device really is left in a mixed state, on the NEW package.

**What the user sees.** If you press Deploy again (for example because nothing seemed to happen), roll back, or switch the device to another package with the same version number, the cloud says 'Deploy started successfully!' but the device keeps the old screens. Unified-editor bundles report a scary 'mixed state' failure for a device that was never touched.

**Root cause.** The edge history is keyed by a non-unique cloud counter instead of a device-local row id or the artifact hash.

**Fix direction.** Key the table with an autoincrement id (or the artifact sha) and store the version as data. Make re-applying the same artifact idempotent. Restore pre-images from memory without re-inserting. Add a Rust test for deploy → same-version redeploy → rollback.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scada_db.rs:284-290`
- `sens-api-gateway/src/scada_server.rs:421-431`
- `sens-api-gateway/src/commands/system.rs:426,478`
- `sens-api-gateway/src/commands/bundle_deploy.rs:224-227`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1025`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305`
- `sens-api-gateway/src/main.rs:5563-5605`
- `sens-api-gateway/src/commands/system.rs:426,478-497`
- `apps/sensor-service/src/process/services/scada-package.service.ts:502`
- `sens-api-gateway/src/scada_db.rs:881,895`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-02** (DEP; verdict CONFIRMED; severity HIGH): The edge uses the cloud package version as the SQLite PRIMARY KEY, so redeploying the same version, any rollback, or a bundle pre-image restore fails
  - sens-api-gateway/src/scada_db.rs:284-290 (version INTEGER PRIMARY KEY), 645-674 (UPDATE is_active=0; INSERT)
  - sens-api-gateway/src/scada_server.rs:421-431 (save_package first; ? aborts)
  - sens-api-gateway/src/commands/system.rs:426,478 (version from meta; deploy_package error → failed ack)
  - sens-api-gateway/src/commands/bundle_deploy.rs:224-227 (manifest version), 472-479 (apply), 500-506 (restore via deploy_package(prior))
  - apps/sensor-service/src/process/services/scada-package.service.ts:1025 (meta.version = pkg.version), 502 (version bumps only on update), 1136 & 1159-1160 (rollback reuses sourceEntityVersion)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305 (no save when not dirty → same version redeployed)
  - PROBE: python sqlite3 with the exact DDL and statements: save v3 OK; save v3 again → 'UNIQUE constraint failed: scada_package.version'; save v4 OK; rollback to v3 → same UNIQUE failure
  - (verifier) sens-api-gateway/src/scada_db.rs:284-290 (version INTEGER PRIMARY KEY), 645-674 (UPDATE is_active=0 then plain INSERT inside one tx)
  - (verifier) sens-api-gateway/src/scada_server.rs:421-431 (save_package first, ? aborts before file write/alarm reload/setPackage broadcast)
  - (verifier) sens-api-gateway/src/main.rs:5563-5605 (SCADA server only starts when ScadaDb opened, so db is always Some on this path)
  - (verifier) sens-api-gateway/src/commands/system.rs:426,478-497 (version from meta; Err → failed ack)
  - (verifier) sens-api-gateway/src/commands/bundle_deploy.rs:224-227, 431-439 (pre-image = current active package), 472-479, 500-506 (restore via deploy_package(prior))
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:502 (version+1 only on update), 1025 (meta.version = pkg.version), 1136 & 1159-1160 (rollback reuses sourceEntityVersion)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305 (no save when not dirty)
  - (verifier) PROBE (python sqlite3, exact DDL+statements): save 3 OK; save 3 → UNIQUE constraint failed; save 4 OK; save 3 → UNIQUE constraint failed (active row stays 4)
  - (verifier) scada_db.rs:881,895 tests use distinct versions only
  - Verifier: Holds on both sides and I reproduced it. Nothing bumps the version on deploy, and no upsert or ON CONFLICT exists. The only Rust tests use distinct versions. Today this sits behind XPORT-01, which makes the edge reject every deploy. Once that is fixed, a re-deploy, a rollback or a package switch will fail silently, because device replies are not processed (AUTO-03).

</details>

### SENSOR-MEDIUM-281

**SCADA rollback and deploy history are unreachable from the UI, and rollback bypasses the publish-boundary checks**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F6 · Deadline: 2027-04-19
- Verification: CONFIRMED 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** rollbackScadaPackageDeploy, scadaDeployLogs and latestScadaDeployLog exist in the API, but nothing in web/ calls them. The only 'Deployments' table (pages/commands) shows automation-program deploymentHistory. Rollback needs an artifactId that only scadaDeployLogs exposes, so it cannot be triggered from the UI. The service-side rollback:

- skips validateDeployScadaPackageParams and validateCommandEnvelope;
- skips assertPackageDeployable;
- leaves the package row and the cloud runtime on the newer version;
- reports success on broker publish;
- on the edge, collides on the version primary key (DEP-02).

**What the user sees.** No 'deploy history' or 'roll back' button exists anywhere for SCADA packages. The only way back is to re-edit the old design by hand.

**Root cause.** Backend capability built without a UI, and rollback treated as a raw republish.

**Fix direction.** Add a per-package and per-device deploy history view with a rollback action. Rollback goes through the same validated, acknowledged deploy pipeline and updates what the cloud records as deployed.

**Evidence (canonical citations).**

- `apps/sensor-service/src/process/resolvers/process.resolver.ts:291-321`
- `web/modules/sensor-module/src/pages/commands/DeploymentsSection.tsx:52`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1105-1206`
- `web/shared-ui/src/generated/graphql-types.ts`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-14** (DEP; verdict CONFIRMED; severity MEDIUM): Rollback and SCADA deploy history are unreachable from the UI, and rollback bypasses the publish-boundary checks
  - apps/sensor-service/src/process/resolvers/process.resolver.ts:291-321 (scadaDeployLogs, latestScadaDeployLog), 408-431 (rollback)
  - grep web/ for scadaDeployLogs\|latestScadaDeployLog\|rollbackScadaPackageDeploy → no callers
  - web/modules/sensor-module/src/pages/commands/DeploymentsSection.tsx:52 (automation deploymentHistory only)
  - apps/sensor-service/src/process/services/scada-package.service.ts:1105-1206 (no validator calls; no status or lifecycle change; 'Rollback … sent')
  - (verifier) apps/sensor-service/src/process/resolvers/process.resolver.ts:291-321 (scadaDeployLogs, latestScadaDeployLog), 408-431 (rollbackScadaPackageDeploy)
  - (verifier) grep web/ for scadaDeployLogs\|latestScadaDeployLog\|rollbackScadaPackageDeploy → only web/shared-ui/src/generated/graphql-types.ts
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:1105-1206 (no assertPackageDeployable, no validateDeployScadaPackageParams/validateCommandEnvelope, no status/lifecycle change, success on publish, version = sourceEntityVersion)
  - Verifier: Verified. No UI caller exists, and the rollback bypasses every publish-boundary check. On the edge it would collide with DEP-02 anyway. This is a missing recovery path rather than a direct blocker.

</details>

### SENSOR-MEDIUM-282

**Publish contract accepts numbers (fractional/negative positions, delays, trend values) that the edge's u32 fields reject, so one bad number fails the whole package on the device**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 2, PARTIAL 1, SELF 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** The cloud's strict publish schema types alarm delay, trendConfig, controlPermissions.emergencyStop and widget position only as 'number' (or leaves them unconstrained). The Rust structs use u32 (AlarmRule.delay, TrendConfig.retention_days/sample_interval_sec, EmergencyStopConfig.hold_duration, WidgetPosition, GridLayout). The builder's number inputs pass Number(e.target.value) through, so 2.5 or -1 is possible. Such a document passes cloud validation and the cloud reports success, but the agent's serde rejects the entire package. Positions are safe because pixelToGrid rounds and clamps.

**What the user sees.** Typing 'Delay (sec)' 1.5 on one alarm, or a fractional trend interval, makes every later deploy appear to succeed while the device keeps its old package (the agent logs 'Invalid SCADA package').

**Root cause.** The edge publish schema was tightened for enums but not for integer ranges.

**Fix direction.** Generate the edge schema from the Rust structs (or add integer and minimum constraints), and validate with it at save time so the builder shows the error on the field.

**Evidence (canonical citations).**

- `libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:19-29`
- `sens-api-gateway/src/scada_types.rs:115-120`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:171-185`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesTrendsTab.tsx:55-59`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:128-136`
- `sens-api-gateway/src/scada_types.rs`
- `libs/sensor-contracts/src/scada-package-doc/edge-scada-package-doc.schema.ts`
- `libs/sensor-contracts/src/schemas/deploy-scada-package.schema.ts`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:171-183`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:37-49`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:64-91`
- `libs/sensor-contracts/src/scada-package-doc/edge-scada-package-doc.schema.ts:16-17,32-38`
- `sens-api-gateway/src/commands/system.rs:365-380`
- `sens-api-gateway/src/scada_types.rs:171-172`
- `sens-api-gateway/src/commands/system.rs:365-395`
- `libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:84-85,105`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesTrendsTab.tsx:55,59`
- `sens-api-gateway/src/scada_db.rs:367-372`
- `libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:75-89`
- `libs/sensor-contracts/src/scada-package-doc/edge-scada-package-doc.schema.ts:51-68`
- `sens-api-gateway/src/trend_engine.rs:77`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:156,171,190,205`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:54,58,68,80-81`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:105-111`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:64-72`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:249`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:64-78`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:104-111`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/VideoStreamConfig.tsx:67`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/MapViewConfig.tsx:214,233`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-11** (DEP; verdict CONFIRMED; severity MEDIUM): The publish contract accepts numbers that the edge's u32 fields reject, and one bad number fails the whole package on the device
  - libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:19-29 (position: number), 75-89 (delay: number), 104-105 (controlPermissions/trendConfig: bare object)
  - sens-api-gateway/src/scada_types.rs:115-120, 172, 235, 248-251 (u32 fields)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:171-185 (delay = Number(input)), PropertiesTrendsTab.tsx:55-59, PropertiesControlTab.tsx:128-136
  - PROBE (real scada_types.rs): builder-shaped doc parses OK; alarm delay 2.5 → 'invalid type: floating point `2.5`, expected u32'; sampleIntervalSec 0.5 and E-stop holdDuration 1500.5 fail the same way; delay -1 → 'invalid value: integer `-1`, expected u32'
  - (verifier) libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:19-29 (position number), 75-89 (delay number), 104-105 (controlPermissions/trendConfig bare object); edge-scada-package-doc.schema.ts tightens only widgetType/screenType/severity/message; schemas/deploy-scada-package.schema.ts adds only meta.version integer
  - (verifier) sens-api-gateway/src/scada_types.rs:115-120, 172, 232-236, 248-251 (u32 fields)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:171-183 (delay = Number(input)), PropertiesTrendsTab.tsx:55-59, PropertiesControlTab.tsx:128-136
  - (verifier) PROBE (my own crate built offline against the real scada_types.rs): builder-shaped doc OK; delay 1.5 → 'invalid type: floating point `1.5`, expected u32'; delay -1 → 'invalid value: integer `-1`, expected u32'; sampleIntervalSec 0.5 and holdDuration 1500.5 fail the same way
  - (verifier) web/modules/sensor-module/src/constants/scada-widget-sizes.ts:37-49 (positions rounded+clamped, so safe)
  - Verifier: I reproduced it independently. The HTML step attributes do not stop typed fractional or negative values, and Number() passes them through. The cloud reports success while the edge rejects the whole package. It duplicates sibling SET-13.
- **POS-01** (OPS-verifier; verdict SELF; severity LOW): Properties X/Y/W/H accept fractional or negative numbers that pass cloud validation but make the whole package fail to deserialize on the edge
  - Claim: GeneralPropertiesSection passes Number(e.target.value) straight into the position. Typing 2.5 or -1 is accepted, because the HTML min and step attributes do not constrain typed values, and col/row are not clamped. Both the save schema and the strict edge schema type position fields as plain 'number'. The strict schema's doc-comment claims it is 'structurally guaranteed to deserialize on the edge'. The Rust WidgetPosition fields are u32, so serde rejects the whole ScadaPackage and the deploy fails on the device.
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:64-91 (no clamp/round on col,row; w,h only Math.max(1, v)), 156,190 (Number(e.target.value))
  - libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:19-29 (col/row/w/h: {type:'number'})
  - libs/sensor-contracts/src/scada-package-doc/edge-scada-package-doc.schema.ts:16-17,32-38 (claims structural guarantee; does not tighten position)
  - sens-api-gateway/src/scada_types.rs:115-120 (WidgetPosition u32); src/commands/system.rs:365-380 (parse failure → deploy error)
- **SET-13** (SET; verdict CONFIRMED; severity LOW): Fractional or negative alarm Delay or trend values pass cloud validation but make the edge reject the whole package; an empty Retention wipes edge trends
  - Claim: Holds (duplicates sibling DEP-11). serde rejects 2.5 or -1 for u32 fields, and deploy_scada_package returns 'Invalid SCADA package'. The cloud ALARM_RULE_SCHEMA and EDGE schema type delay as plain number, and trendConfig as an unconstrained object. Clearing a Trends input saves 0. Retention 0 sets the cutoff to now and deletes all rows; interval 0 samples every poll.
  - sens-api-gateway/src/scada_types.rs:171-172 (delay: Option<u32>), 247-254 (retention_days/sample_interval_sec: Option<u32>)
  - sens-api-gateway/src/commands/system.rs:365-395 (parse failure → 'Invalid SCADA package')
  - libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:84-85,105 (delay number; trendConfig object)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:171-185 (Delay accepts any number)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesTrendsTab.tsx:55,59 (Number('') → 0)
  - sens-api-gateway/src/scada_db.rs:367-372 (cutoff = now − retention_days)
  - (verifier) sens-api-gateway/src/scada_types.rs:171-172 delay Option<u32>; 247-254 retention_days/sample_interval_sec Option<u32>
  - (verifier) sens-api-gateway/src/commands/system.rs:365-395 parse failure → 'Invalid SCADA package'
  - (verifier) libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:75-89 delay {type:'number'}; 103-105 trendConfig {type:'object'}; edge-scada-package-doc.schema.ts:51-68 inherits
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesTrendsTab.tsx:55,59 Number(e.target.value)
  - (verifier) sens-api-gateway/src/scada_db.rs:367-372 cutoff = now − retention_days·86400000; trend_engine.rs:77 Duration::from_secs(sample_interval_sec)
  - Verifier: The constraints are absent on the cloud side and strict on the edge. The inputs needed to trigger this are uncommon, so LOW stands.
- **EDIT-05** (EDIT; verdict PARTIAL; severity LOW): Numeric property fields snap to 0 (W/H to 1) the moment they are cleared, so retyping produces wrong values; negative and fractional positions are stored
  - Claim: Snap-on-clear holds. Every numeric field stores Number(e.target.value) per keystroke (126 occurrences in 45 scada-builder files), so clearing a field stores 0 at once, and React rewrites the DOM to '0' or '1'. A wrong final value results only for fields that clamp to a non-zero minimum: W/H (GeneralPropertiesSection.tsx:80-93), VideoStream refreshInterval and similar. There, Backspace on '2' then typing '4' stores 14. For X/Y and unclamped config fields (gauge min/max, decimals) the final value is correct. The DOM keeps '03' or '0150', which React does not rewrite because '03' == 3. The only side effects are a transient 0 being stored and rendered, and a leading zero shown. The negative/fractional half is a DUPLICATE of POS-01 (verdict_OPS_3.json), which also carries its real consequence: the edge u32 WidgetPosition rejects the whole package.
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:156,171,190,205 onChange={(e) => handle...(..., Number(e.target.value))}; :80-93 Math.max(1, value) for W/H only; :64-78 no clamp or integer check for col/row
  - widget-configs/GaugeConfig.tsx:54,58,68,80-81 (min/max/decimals/zones use the same pattern); grep: 116 Number(e.target.value) in 42 files
  - pages/scada/usePropertiesPanelHandlers.ts:105-111 -> store/scada/widgetSlice.ts:64-72 writes the value through unvalidated; projectSlice.ts:249 position is serialized verbatim
  - RAN scratchpad/editdel/keys-test.tsx [9]: clearing W shows "1" and store w=1; clearing X shows "0" and store col=0; typing -3 gives col -3; typing 2.5 gives w 2.5 (number)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:64-78 (col/row unclamped), 80-93 (Math.max(1, value) for w/h), 156,171,190,205 (Number(e.target.value))
  - (verifier) store side: pages/scada/usePropertiesPanelHandlers.ts:104-111 -> store/scada/widgetSlice.ts:64-72 (unvalidated) -> projectSlice.ts:249 (position serialized verbatim)
  - (verifier) grep 'Number(e.target.value)' in components/scada-builder: 126 hits in 45 files; clamps at widget-configs/VideoStreamConfig.tsx:67 and MapViewConfig.tsx:214,233
  - (verifier) RAN /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/verify-edit/numeric-test.tsx: W Backspace -> DOM "1", then '4' -> DOM "14", store w 14; X Backspace -> DOM "0", then '3' -> DOM "03", store col 3 (correct)
  - (verifier) RAN (rebuilt harness) [9]: clear W -> "1"/w=1; clear X -> "0"/col=0; '-3' -> col -3; '2.5' -> w 2.5
  - Verifier: The title's 'retyping produces wrong values' is true only for clamped fields. The canvas change is visible immediately, so the user can see and fix it. That makes this a LOW annoyance, not data loss. The data-integrity part (fractional or negative values reaching the edge) is already filed as POS-01.

</details>

### SENSOR-MEDIUM-283

**A failed bundle attempt moves programs to DEPLOYING outside the bundle transaction and blocks an immediate retry for 5 minutes**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** Bundle staging moves programs to DEPLOYING outside the bundle transaction; package deploy then rejects while any bound program is not APPROVED/DEPLOYED.

**What the user sees.** Retry fails until the timeout returns the program to APPROVED.

**Root cause.** Side effects outside the transaction.

**Fix direction.** Move program state changes into the bundle transaction and derive from ack.

**Evidence (canonical citations).**

- `apps/sensor-service/src/automation/automation.service.ts:1517,1529-1576`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1258-1266,1439-1532`

<details><summary>Merged audit findings and full evidence</summary>

- **XPORT-06** (AUTO/XPORT; verdict SELF; severity MEDIUM): A failed attempt blocks an immediate retry for 5 minutes
  - apps/sensor-service/src/automation/automation.service.ts:1517,1529-1576
  - apps/sensor-service/src/process/services/scada-package.service.ts:1258-1266,1439-1532

</details>

### SENSOR-MEDIUM-284

**Bundles inline every artifact in one MQTT message with no size check against the edge's 1 MiB packet cap**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 1
- Rule: ADR-018 (edge RBAC/ABAC) and the root-cause rule: a deploy is signed end to end and its status comes from the device acknowledgement

**Claim.** Large HMI packages would be dropped silently and may loop on QoS1 redelivery.

**What the user sees.** Large packages never arrive.

**Root cause.** No size contract.

**Fix direction.** Size check at publish + chunked or pull-based artifact transfer.

**Evidence (canonical citations).**

- `sens-api-gateway/src/mqtt.rs:276,418-426`
- `apps/sensor-service/src/release-bundle/deploy-bundle-dispatcher.service.ts:150-188`

<details><summary>Merged audit findings and full evidence</summary>

- **XPORT-08** (AUTO/XPORT; verdict SELF; severity MEDIUM): Bundles inline all artifacts in one MQTT message with no size check vs the edge 1 MiB cap
  - sens-api-gateway/src/mqtt.rs:276,418-426
  - apps/sensor-service/src/release-bundle/deploy-bundle-dispatcher.service.ts:150-188

</details>

## C. Tag identity, live data and control writes

### SENSOR-CRITICAL-285

**Cloud SCADA (builder preview and operator) subscribes by device-local tag name while the only producer publishes registry FQNs, so no live value ever arrives**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 2
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** Holds as stated. Every cloud runtime (builder Preview through StableModeProvider type='live', and OperatorShell's default 'live' provider) subscribes with the device-local segment that getWidgetTagBinding/extractTagIds produce. The only producer of /scada values, TagValueFanoutService, pushes the registry fqn. TagManager routes on the exact key `${tenant}\0${tagId}`, so nothing is ever delivered. Two caveats. In the operator view this is currently hidden behind OPS-01 ('?' boxes), but builder Preview shows it directly. Sibling finding DEP-05 reports the same defect.

**What the user sees.** In builder Preview mode and on /sensor/scada/operator/:id, every tag-bound widget stays at its empty or default reading forever. The same device's values are live on the Edge Device detail page.

**Root cause.** There are two incompatible tag identities: the client keys tags by the device-local name and the server producer keys them by deviceCode/localName. The gateway's 'grandfathering' hides the mismatch instead of rejecting it.

**Fix direction.** Make the canonical TagRef (registry fqn) the only runtime key end to end. Widgets store the fqn (or the UnifiedTag id), widgetBinding stops reducing to the local name, and the gateway rejects non-TagRef subscribe keys with an error the client surfaces (the client currently ignores 'scada:error'). Strip deviceCode only at the edge boundary, where the agent knows its own code.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:12-14,22-24,30-40`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223,277`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:59-84`
- `web/modules/sensor-module/src/services/TagSubscriptionManager.ts:222-255`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:369-391`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:71-73,109-136,233-251`
- `apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:108-115`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223`
- `web/modules/sensor-module/src/components/scada-operator/OperatorShell.tsx:206,252`
- `web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx:40-42`
- `web/modules/sensor-module/src/services/TagSubscriptionManager.ts:245-258`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:376-391`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:71-73,109-136`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:59-92`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:21-24`
- `web/modules/sensor-module/src/services/TagSubscriptionManager.ts:248-262`
- `web/modules/sensor-module/src/providers/LiveDeviceDataProvider.tsx:271-276`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:371-391`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:71-73`
- `apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115`
- `apps/sensor-service/src/process/services/unified-tag.service.ts:102-119`
- `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:146-151`
- `web/modules/sensor-module/src/hooks/useRealtimeData.ts`

<details><summary>Merged audit findings and full evidence</summary>

- **LINK-01** (BIND; verdict CONFIRMED; severity BLOCKER): Cloud SCADA subscribes by device-local name, but the only producer publishes registry FQNs, so no live value ever arrives
  - web/modules/sensor-module/src/engine/tags/widgetBinding.ts:12-14,22-24,30-40 (tagRef reduced to localName)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223,277 (preview subscribes and indexes by the local name)
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:59-84 (localTagFromBindingValue), 279-285 (useRealtimeData(tagIds))
  - web/modules/sensor-module/src/services/TagSubscriptionManager.ts:222-255 (emits TAG_SUBSCRIBE with ids as given, no translation)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:369-391 (non-TagRef keys grandfathered: accepted silently)
  - apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:71-73,109-136,233-251 (exact tenant+tagId key)
  - apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:108-115 (tagId: fqn)
  - RUN: scratchpad/link/tm-test.ts built against the real tag-manager.service.ts gave 'sockets routed for fqn push: []' and 'value visible under subscribed key "pH_1": null'
  - (verifier) web/modules/sensor-module/src/engine/tags/widgetBinding.ts:12-14,22-24,30-40: tagRef is reduced to localName (read)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223 (useRealtimeData(liveTagIds) of local names), 275-278 (liveValues[tagName])
  - (verifier) web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:59-84 (localTagFromBindingValue), 279-285
  - (verifier) web/modules/sensor-module/src/components/scada-operator/OperatorShell.tsx:206,252 (default dataProviderType='live'); StableModeProvider.tsx:40-42 (preview -> live)
  - (verifier) web/modules/sensor-module/src/services/TagSubscriptionManager.ts:245-258 emits TAG_SUBSCRIBE {tagIds} with no translation
  - (verifier) apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:376-391: non-TagRef keys are accepted as legacy with no error
  - (verifier) apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:71-73,109-136 (subscribe key), 233-251 (updateTagValues exact-key routing)
  - (verifier) apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:108-115 (tagId: fqn). grep: gateway.pushTagValues has a single caller (fanout:115), and updateTagValues is reached only from gateway:768
  - (verifier) Re-ran scratchpad/link/out-tm.cjs: 'sockets routed for fqn push: []', 'value visible under subscribed key "pH_1": null'
  - Verifier: I looked for another producer or a client-side translation that could refute this. grep for pushTagValues/updateTagValues/fanoutMetric across apps, libs and platform finds only the fanout service, which the NATS ingestion consumer calls. No client code prefixes deviceCode. The LiveDeviceDataProvider cache is keyed by change.tagId as received (LiveDeviceDataProvider.tsx:121-130), so even an fqn push would land under a key the widgets never read. Re-running the auditor's harness against the real TagManagerService reproduced the result.
- **DEP-05** (DEP; verdict CONFIRMED; severity BLOCKER): The cloud operator subscribes with device-local tag names while the fan-out publishes registry FQNs, so no live value ever reaches the operator view
  - Claim: OperatorView reduces every binding to its local segment ('EDGE-01/pH_1' becomes 'pH_1') via localTagFromBindingValue and subscribes with that. The gateway accepts non-TagRef keys as 'grandfathered', and TagManager indexes the subscription as tenant\0pH_1. The only producer, TagValueFanoutService, pushes tagId = fqn ('EDGE-01/pH_1'), and TagManager routes by exact tenant-qualified key, so the routing map is always empty. Separately, fan-out can only resolve a metric when the registry row has source.sensorId/channelId. Tag discovery (discoverTags) never sets them; only a manual per-tag link in the Tag Registry page does. So even with matching keys, discovered tags stay unmapped.
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:59-92 (extractTagIds → localTagFromBindingValue), 197 (getWidgetTagBinding)
  - web/modules/sensor-module/src/engine/tags/widgetBinding.ts:21-24, 30-41 (TagRef reduced to localName)
  - web/modules/sensor-module/src/services/TagSubscriptionManager.ts:248-262 and providers/LiveDeviceDataProvider.tsx:271-276 (tagIds emitted as given)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:371-391 (non-TagRef keys accepted unchanged), 343-347
  - apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:71-73 (key tenant\0tagId), 233-247 (exact-key routing)
  - apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115 (TagValueChange.tagId = fqn)
  - apps/sensor-service/src/process/services/unified-tag.service.ts:102-119 (requires source->>'sensorId'), 268-272 (discoverTags source = {type, edgeDeviceId, ioConfigId} only)
  - web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:146-151 (sensor link is set only by manual edit)
  - (verifier) web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:59-92 (extractTagIds reduces every binding with localTagFromBindingValue)
  - (verifier) web/modules/sensor-module/src/engine/tags/widgetBinding.ts:21-24 (TagRef → localName), 30-41
  - (verifier) web/modules/sensor-module/src/services/TagSubscriptionManager.ts:248-262 (emits TAG_SUBSCRIBE tagIds unchanged)
  - (verifier) apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:371-391 (non-TagRef keys accepted unchanged, no local→fqn mapping), 343-347 (subscribeSocket with the same keys)
  - (verifier) apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:71-73 (tenant\0tagId), 233-250 (exact-key lookup in tagSubscribers)
  - (verifier) apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115 (tagId = fqn); grep pushTagValues/updateTagValues in apps+libs: fan-out is the only producer
  - (verifier) apps/sensor-service/src/process/services/unified-tag.service.ts:102-119 (requires source->>'sensorId'), 268-272 (discoverTags writes source {type, edgeDeviceId, ioConfigId} only)
  - (verifier) grep fqn/deviceCode in providers/\*.tsx, hooks/useRealtimeData.ts: no client-side mapping
  - Verifier: I looked for any mapper that rewrites the subscribe key: in the gateway partition, the TagManager, the live provider and useRealtimeData. None exists. Subscriptions are keyed tenant\0pH_1 and deliveries tenant\0DEV/pH_1, so routing is always empty. The registry-link gap means discovered tags would stay unmapped even with matching keys. This duplicates sibling LINK-01 and LINK-02.

</details>

### SENSOR-CRITICAL-286

**Edge device I/O values never enter the cloud /scada live plane; the registry live link only reaches sensor channels**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** Holds. Edge io_data reaches only (a) EdgeDeviceIoData -> gateway-api 'edgeIoData' room (consumers: Process Editor overlay and device page) and (b) sensor_metrics rows with sensorId=device.id and channelId=ioConfig.id, written by a direct writeImmediate. Neither path calls TagValueFanoutService. The only fanoutMetric caller is the NATS SensorMetricIngested consumer, which drops unknown sensors and is fed only by the Rust sidecar, whose WirePayload rejects the {timestamp,tags} shape. The edge agent publishes no sidecar-shaped sensor payloads, so an edge device's values can never reach /scada.

**What the user sees.** An engineer binds a gauge to a channel of their edge device, opens Preview or the operator view, and sees no value. The Edge Device page shows that channel updating every second.

**Root cause.** There are two live planes. The working edge plane (deviceCode + tagName over gateway-api) was disconnected from SCADA, and the new /scada plane is fed only by the sensor-ingestion pipeline, which edge I/O never enters.

**Fix direction.** In mqtt-listener.handleEdgeIoData, map each tag to `${deviceCode}/${tagName}` (exactly the registry fqn discoverTags mints) and call ScadaRuntimeGateway.pushTagValues(tenantId, ...). Alternatively, have TagValueFanoutService resolve source.edgeDeviceId+ioConfigId as well as sensorId/channelId. The data needed is already in the handler.

**Evidence (canonical citations).**

- `sens-api-gateway/src/io_poll.rs:17-38`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1198`
- `apps/gateway-api/src/websocket/nats-bridge.service.ts:199-230`
- `apps/gateway-api/src/websocket/sensor-readings.gateway.ts:362-372`
- `web/modules/sensor-module/src/hooks/useEdgeIoSocket.ts:237`
- `web/modules/sensor-module/src/components/process-editor/nodes/EquipmentNodeOverlay.tsx:101`
- `web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:1083`
- `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts:291-300`
- `apps/sensor-ingestion/src/payload.rs:287-336`
- `apps/sensor-service/src/process/services/unified-tag.service.ts:102-119`
- `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:59-71,247-281`
- `web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx:18-22`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1198-1201`
- `apps/gateway-api/src/websocket/nats-bridge.service.ts:198-230`
- `web/modules/sensor-module/src/hooks/useEdgeIoSocket.ts`
- `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts:211-219`

<details><summary>Merged audit findings and full evidence</summary>

- **LINK-02** (BIND; verdict CONFIRMED; severity BLOCKER): An edge device's I/O values never enter the /scada live plane; registry 'live link' only reaches sensor channels
  - sens-api-gateway/src/io_poll.rs:17-38 (IoDataPayload {timestamp, tags})
  - apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1198 (io_data case), 1387-1453 (EdgeDeviceIoData publish + persist only), 1506 (sensorId: device.id)
  - apps/gateway-api/src/websocket/nats-bridge.service.ts:199-230 and apps/gateway-api/src/websocket/sensor-readings.gateway.ts:362-372 ('edgeIoData' room per deviceCode)
  - web/modules/sensor-module/src/hooks/useEdgeIoSocket.ts:237 consumers: components/process-editor/nodes/EquipmentNodeOverlay.tsx:101, pages/EdgeDeviceDetailPage.tsx:1083 only
  - grep: fanoutMetric's only caller is apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts:291-300; same file 211-219 drops unknown sensorId
  - apps/sensor-ingestion/src/payload.rs:287-336 (deny_unknown_fields; sensorId/channelId required)
  - apps/sensor-service/src/process/services/unified-tag.service.ts:102-119 (fan-out match on source.sensorId/channelId), 268-272 (discovered tags get edgeDeviceId/ioConfigId only)
  - web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:59-71,247-281 (live link picks sensors + allDataChannels only)
  - web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx:18-22 (the device-code Layer-A path was retired in favour of /scada)
  - (verifier) apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1198-1201 (io_data case), 1387-1453 (handleEdgeIoData: EdgeDeviceIoData publish + persistIoDataToMetrics only), 1460-1520 (sensorId: device.id, channelId: config.id, writeImmediate)
  - (verifier) apps/gateway-api/src/websocket/nats-bridge.service.ts:198-230 -> sensor-readings.gateway.ts:362-372 (room edgeIo:tenant:deviceCode)
  - (verifier) web/modules/sensor-module/src/hooks/useEdgeIoSocket.ts consumers: EquipmentNodeOverlay.tsx:101, EdgeDeviceDetailPage.tsx:1083 only (grep)
  - (verifier) apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts:211-219 (unknown sensor dropped), 291-300 (only fanoutMetric caller)
  - (verifier) apps/sensor-ingestion/src/payload.rs:287-336 (deny_unknown_fields; tenantId/sensorId/channelId required)
  - (verifier) grep sens-api-gateway/src for sensorId wire fields: none, so the edge never emits a sidecar-shaped reading
  - (verifier) apps/sensor-service/src/process/services/unified-tag.service.ts:102-119 (fan-out matches source.sensorId), 265-272 (discovered tags carry edgeDeviceId/ioConfigId only)
  - (verifier) web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:59-71,247-281 (live link picks sensors + data channels only)
  - Verifier: I tried three possible refutations. First, a mapper on the persist path: persistIoDataToMetrics writes sensor_metrics directly and does not publish or fan out. Second, the sidecar picking up io_data: it subscribes to the topic but its strict schema rejects the payload. Third, the edge publishing sensor-shaped readings in parallel: nothing in sens-api-gateway emits sensorId/channelId. All three failed, so the claim stands.

</details>

### SENSOR-CRITICAL-287

**No SCADA control write from the browser reaches a device: bare names rejected, registered FQNs hit an event with no listener, the ACK is read as failure, setDigitalOutput sends a boolean the edge rejects, and widget commands (setValue, emergencyStop, vfd:\*) have no consumer**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 5
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** The core claim holds: no cloud SCADA write can reach a device. A bare name fails strict registry resolution and is answered on 'scada:error', which the client never handles, so the call times out after 5 s. A registered fqn only emits 'scada.tag.write', which has no listener anywhere, and the {status:'queued'} ACK is read as failure because the client checks payload.success. Three corrections. (1) For real users the role gate at gateway:441-449 fails first: the role comes from the platform JWT but the allowlist uses HMI roles (sibling SET-01). (2) The visible symptom is mostly silence, not a message on the widget. OperatorView calls `void toggleTag/writeTag`, so the rejection is unhandled, and only RuntimeInput renders useTagWrite.lastError. (3) Today the path is reachable only from the operator view, which renders '?' boxes (OPS-01), because builder Preview wires events to a no-op bus. Sibling findings DEP-06 and SET-01 report the same defect.

**What the user sees.** In the operator view (or anywhere a write is emitted), a toggle or setpoint does nothing on the plant. After up to 5 s the widget shows 'Write to <tag> timed out' or 'Write to <tag> failed', even when the gateway accepted the write.

**Root cause.** The write pipeline was built up to an internal event bus but the device-driver adapter was never written. The client and server ACK contracts were defined separately, and the key namespace mismatch from LINK-01 adds to the failure.

**Fix direction.** Add a ScadaTagWriteDispatcher (@OnEvent('scada.tag.write')). It resolves the fqn through the registry source (edgeDeviceId + ioConfigId -> tagName), publishes a signed 'set_output' {tag_name, value: number} command, correlates the edge response by commandId and only then emits TAG_WRITE_ACK {tagId, success, error}. The client sends fqns and handles 'scada:error'.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/hooks/useTagWrite.ts:52-81`
- `web/modules/sensor-module/src/providers/LiveDeviceDataProvider.tsx:136-146`
- `web/modules/sensor-module/src/providers/HybridDataProvider.tsx:189-199`
- `web/modules/sensor-module/src/services/ScadaSocketService.ts:53`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:461-482`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:30,261-282`
- `apps/sensor-service/src/scada-runtime/__tests__/tag-write-tenant-gate.spec.ts:102-112`
- `sens-api-gateway/src/commands/catalog.rs:417-425`
- `sens-api-gateway/src/commands/io_config.rs:135-172`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:101`
- `web/modules/sensor-module/src/services/index.ts:10`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:276,310-313`
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeInput.tsx:64,251-270`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:206`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:221`
- `apps/auth-service/src/modules/authentication/services/token.service.ts:368-371`
- `libs/backend-common/src/decorators/roles.decorator.ts:24,33,42,50`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:442-447`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:156`
- `apps/sensor-service/src/scada-runtime/dto/scada-socket.dto.ts:84-97`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:456-459`
- `web/modules/sensor-module/src/providers/HybridDataProvider.tsx:340-341`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:261-282`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:521-525`
- `apps/sensor-service/src/scada-runtime/__tests__/tag-write-tenant-gate.spec.ts:70`
- `libs/backend-common/src/decorators/roles.decorator.ts:24-50`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:441-448`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:898`
- `web/modules/sensor-module/src/providers/HybridDataProvider.tsx:85,333-336`
- `apps/sensor-service/src/scada-runtime/__tests__/tag-write-tenant-gate.spec.ts:66-71`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:302-317`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:21-24`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:469-482`
- `apps/sensor-service/src/process/services/tag-resolution.service.ts:68-72`
- `web/modules/sensor-module/src/services/ScadaSocketService.ts:348-357`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:261-281`
- `web/modules/sensor-module/src/types/scada-runtime.types.ts:99-141`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:30,261-281`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1835-1910`
- `sens-api-gateway/src/commands/io_config.rs:149-158`
- `sens-api-gateway/src/commands/dispatch_lifecycle.rs:308`
- `web/modules/sensor-module/src/components/process-editor/panels/PropertiesPanel.tsx:295-301`
- `sens-api-gateway/src/mqtt.rs:178-203`
- `web/modules/sensor-module/src/components/process-editor/panels/PropertiesPanel.tsx:295-305`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/SliderRenderer.tsx:20`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/KnobRenderer.tsx:191`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/NumericInputRenderer.tsx:20`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/DropdownSelectRenderer.tsx:82`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EmergencyStopRenderer.tsx:14-20`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:260-268`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdMiniWidget.tsx:90-91`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:223-245`
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeWidgetRenderer.tsx:312-321`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:221-245`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/NumericInputRenderer.tsx:16-22,40`
- `web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx:301-317`

<details><summary>Merged audit findings and full evidence</summary>

- **LINK-03** (BIND; verdict CONFIRMED; severity BLOCKER): Every SCADA write from the browser dies in the cloud: bare names are rejected, registered FQNs hit an event with no listener, and the ACK is read as failure
  - web/modules/sensor-module/src/hooks/useTagWrite.ts:52-81
  - web/modules/sensor-module/src/providers/LiveDeviceDataProvider.tsx:136-146 (if (payload.success) ... else reject), 284-310 (emit TAG_WRITE, 5 s timeout); providers/HybridDataProvider.tsx:189-199 (same)
  - web/modules/sensor-module/src/services/ScadaSocketService.ts:53 (ack typed {tagId, success, error})
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:461-482 (strict registry resolve; bare name rejected), 500-526 (writeTagValue + ACK {status:'queued'}), 886-898 (errors emitted as 'scada:error')
  - grep: no 'scada:error' listener in web/modules/sensor-module/src
  - apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:30,261-282 (emits 'scada.tag.write')
  - grep -rna 'scada.tag.write\|SCADA_TAG_WRITE_EVENT' apps libs platform: only the definition, the re-export and a module comment; no consumer
  - apps/sensor-service/src/scada-runtime/**tests**/tag-write-tenant-gate.spec.ts:102-112 (server pins status:'queued', which contradicts the client contract)
  - sens-api-gateway/src/commands/catalog.rs:417-425 (set_output entry), sens-api-gateway/src/commands/io_config.rs:135-172 (handler keyed by bare tag_name)
  - RUN: scratchpad/link/ns-test.ts isTagRef("pH_1") = false; tm-test.ts shows writeTagValue only emits 'scada.tag.write'
  - (verifier) apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:101 (WRITE_ALLOWED_ROLES operator/engineer/supervisor/admin), 441-449 (role gate first), 461-482 (strict resolve; bare name -> 'Tag is not registered'), 498-526 (writeTagValue + ACK {tagId,status:'queued',timestamp}), 886-898 (client.emit('scada:error'))
  - (verifier) apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:30,261-282 (emits only SCADA_TAG_WRITE_EVENT)
  - (verifier) grep -rna 'scada.tag.write\|SCADA_TAG_WRITE_EVENT' apps libs platform: definition, re-export (services/index.ts:10), module comments only; grep '@OnEvent(' in sensor-service: no scada.tag.write or wildcard listener
  - (verifier) web/modules/sensor-module/src/providers/LiveDeviceDataProvider.tsx:136-146 (if payload.success resolve, else reject), 284-310 (5 s timeout); HybridDataProvider.tsx:189-199 (same)
  - (verifier) web/modules/sensor-module/src/services/ScadaSocketService.ts:53 (ACK typed {tagId, success, error})
  - (verifier) grep "'scada:error'" web/modules/sensor-module/src: no listener
  - (verifier) web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:276,310-313 (void toggleTag/writeTag); widgets/RuntimeInput.tsx:64,251-270 (only lastError consumer)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:206 (builder events use a no-op bus)
  - Verifier: Every server-side hop was read, and searches for a listener (OnEvent, eventEmitter.on, onAny) found none. The ACK contract mismatch is confirmed on both sides. The severity stays BLOCKER, since no cloud control can actuate anything. The user-symptom text needed correcting because the error is mostly not displayed.
- **SET-01** (SET; verdict CONFIRMED; severity BLOCKER): Cloud tag writes never reach a device, and alarm ACKs are refused for every real user
  - Claim: Holds as stated. Two corrections. (a) The user never sees the role message. emitError sends 'scada:error', which the web client never listens for, so the write promise rejects after 5 s with 'Write to X timed out' and the 'Role TENANT_ADMIN…' text appears only in the server log. (b) The ALARM_ACK refusal cannot currently be triggered from the UI: the only mounted alarm tray has no ACK button (SET-02). New relative to sibling findings DEP-06/LINK-03: the role-vocabulary gate (1) and the whitelist stripping of `value` (2). Point (3), no listener for 'scada.tag.write', duplicates DEP-06(4)/LINK-03. Server-side writers (script $setTag at script-engine.service.ts:329, alarm setValue at alarm-engine.service.ts:729) bypass the role gate and the DTO and are affected only by (3).
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:101 (WRITE_ALLOWED_ROLES = ['operator','engineer','supervisor','admin'])
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:221 (role = payload.role ?? roles[0] ?? 'viewer', no mapping)
  - apps/auth-service/src/modules/authentication/services/token.service.ts:368-371 (JWT role: user.role, roles: [user.role])
  - libs/backend-common/src/decorators/roles.decorator.ts:24,33,42,50 (SUPER_ADMIN/TENANT_ADMIN/MODULE_MANAGER/MODULE_USER)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:442-447 (tag write denied), 592-594 (ALARM_ACK denied), 637-639 (ALARM_ACK_ALL denied)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:156 (@UsePipes(new ValidationPipe({ transform: true, whitelist: true })))
  - apps/sensor-service/src/scada-runtime/dto/scada-socket.dto.ts:84-97 (value!: unknown with no decorator)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:456-459 ('value is required')
  - web/modules/sensor-module/src/providers/HybridDataProvider.tsx:340-341 (writer sends {tagId, value, function:'set'})
  - apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:261-282 (writeTagValue only emits SCADA_TAG_WRITE_EVENT)
  - grep -a 'OnEvent(SCADA_TAG_WRITE\|scada.tag.write' in apps/sensor-service/src: only the constant definition and comments, no listener
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:521-525 (ACK 'queued')
  - apps/sensor-service/src/scada-runtime/**tests**/tag-write-tenant-gate.spec.ts:70 (test uses role 'operator')
  - Not executed: node_modules is not installed. The whitelist-stripping in (2) is documented class-validator behaviour, not a run result
  - (verifier) apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:101 WRITE_ALLOWED_ROLES = ['operator','engineer','supervisor','admin']
  - (verifier) apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:221 role = payload.role ?? roles[0] ?? 'viewer', with no mapping from platform roles
  - (verifier) apps/auth-service/src/modules/authentication/services/token.service.ts:368-371 role: user.role, roles: [user.role]; user.entity.ts:114 role!: Role
  - (verifier) libs/backend-common/src/decorators/roles.decorator.ts:24-50 Role enum = SUPER_ADMIN/TENANT_ADMIN/MODULE_MANAGER/MODULE_USER (disjoint from HmiRole)
  - (verifier) scada-runtime.gateway.ts:441-448 (tag write denied), 589-592 (ALARM_ACK denied), 637-640 (ALARM_ACK_ALL denied)
  - (verifier) scada-runtime.gateway.ts:156 @UsePipes(new ValidationPipe({ transform: true, whitelist: true })); dto/scada-socket.dto.ts:84-97 `value!: unknown` has no decorator (comment says this is deliberate); gateway 456-459 'value is required'
  - (verifier) tag-manager.service.ts:261-282 writeTagValue only emits SCADA_TAG_WRITE_EVENT; grep -a over apps/libs/platform/sens-api-gateway finds no @OnEvent or .on listener for 'scada.tag.write'
  - (verifier) scada-runtime.gateway.ts:898 errors are emitted as 'scada:error'; grep 'scada:error' in web/modules/sensor-module/src (non-test) returns nothing; HybridDataProvider.tsx:85,333-336 5 s timeout reject
  - (verifier) **tests**/tag-write-tenant-gate.spec.ts:66-71 seeds role 'operator' directly into the private clients map, bypassing handleConnection
  - (verifier) Not executed: node_modules is absent, so whitelist stripping rests on documented class-validator behaviour (class-validator ^0.14.3, @nestjs/common ^11.2.7)
  - Verifier: I read both seams. The JWT issuer only ever emits platform Role values, and the gateway casts them to HmiRole without translation, so includes() is always false. No second token issuer or role-mapping layer exists: validateToken returns the raw verified payload. The DTO's `value` is intentionally undecorated, and whitelist:true strips it. emitDecoratorMetadata is on in tsconfig.app/build, so the pipe receives the TagWriteDto metatype. I found no wildcard @OnEvent; the only OnEvent handlers in scada-runtime are the ack, activation and lifecycle events. Cloud control writes and ACKs therefore cannot work, which keeps this a BLOCKER for any cloud-side control.
- **DEP-06** (DEP; verdict CONFIRMED; severity HIGH): Cloud operator tag writes can never reach a device and always end as an error
  - Claim: Independent of CMD-01 (command strings dropped): (1) the client writes local names, but the gateway write gate resolves strictly as a TagRef; 'pH_1' is INVALID_GRAMMAR and the write is FORBIDDEN; (2) that rejection is emitted as 'scada:error', which is not in ScadaSocketEvent, so the client never listens and the write promise times out after 5 s; (3) when a write is accepted, the ACK is {tagId, status:'queued'}, but the client resolves only on payload.success and rejects with 'Write to X failed'; (4) TagManager.writeTagValue only emits the EventEmitter2 event 'scada.tag.write', and nothing in apps/ or libs/ listens. No device command is ever produced.
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:302-317 + engine/tags/widgetBinding.ts:21-24 (local tagId)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:469-482 (strict resolve → FORBIDDEN), 519-524 (ACK {status:'queued'}), 886-898 (emits 'scada:error')
  - apps/sensor-service/src/process/services/tag-resolution.service.ts:68-72 (non-TagRef → INVALID_GRAMMAR)
  - web/modules/sensor-module/src/services/ScadaSocketService.ts:348-357 (listens only to ScadaSocketEvent values; 'scada:error' not among them)
  - web/modules/sensor-module/src/providers/LiveDeviceDataProvider.tsx:136-146 (resolves only if payload.success), 301-304 (5 s timeout)
  - apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:261-281 (emit 'scada.tag.write'); grep 'scada.tag.write\|SCADA_TAG_WRITE_EVENT' in apps/ libs/ → no @OnEvent consumer
  - (verifier) web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:302-317 (handleCommand needs 'action:tagId'; widgets send bare 'toggle'/'setValue' → CMD-01)
  - (verifier) apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:469-482 (strict resolve; unregistered → FORBIDDEN), 519-524 (ACK {tagId,status:'queued',timestamp}, no success flag), 886-898 (emitError → 'scada:error')
  - (verifier) web/modules/sensor-module/src/types/scada-runtime.types.ts:99-141 (ScadaSocketEvent has no 'scada:error'); services/ScadaSocketService.ts:348-357 (only enum events are forwarded)
  - (verifier) web/modules/sensor-module/src/providers/LiveDeviceDataProvider.tsx:136-146 (resolve only if payload.success, else 'Write to X failed'), 288-304 (5 s timeout)
  - (verifier) apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:30,261-281 (emit 'scada.tag.write'); grep -a SCADA_TAG_WRITE_EVENT / @OnEvent('scada… / onAny in apps+libs → no consumer
  - Verifier: All four links are verified on both sides, including a binary-safe grep for listeners and wildcard @OnEvent handlers. The write path cannot reach a device and cannot produce a success result. It overlaps siblings LINK-03 and SET-01.
- **LINK-04** (BIND; verdict CONFIRMED; severity HIGH): The only working-looking cloud-to-edge write (setDigitalOutput -> set_output) sends a boolean that the edge rejects, while the cloud reports success
  - Claim: Holds. setDigitalOutput publishes params.value as a JSON boolean, and the edge's cmd_set_output requires as_f64(), so it answers 'Missing or invalid value parameter'. The cloud returns {success:true} as soon as the MQTT publish resolves, and the Process Editor dialog treats that as success. The command goes out as a legacy unsigned CommandMessage, and set_output is DenyUnsignedInEnforcing. Whether a second rejection happens therefore depends on the device's signature mode, which is still unverified.
  - apps/sensor-service/src/edge-device/edge-device.service.ts:1835-1910 (value: boolean in params; returns success after publish)
  - sens-api-gateway/src/commands/io_config.rs:149-158 (value must be f64)
  - sens-api-gateway/src/commands/dispatch_lifecycle.rs:308 (params passed unmodified)
  - sens-api-gateway/src/commands/catalog.rs:417-425 (DenyUnsignedInEnforcing)
  - web/modules/sensor-module/src/components/process-editor/panels/PropertiesPanel.tsx:295-301 (UI trusts result.success)
  - RUN: scratchpad/link/rs (cargo run --offline) printed 'params.get("value").and_then(\|v\| v.as_f64()) = None'
  - (verifier) apps/sensor-service/src/edge-device/edge-device.service.ts:1835-1910 (value: boolean in params; returns success right after mqtt.publish)
  - (verifier) sens-api-gateway/src/commands/io_config.rs:149-158 (value must be as_f64)
  - (verifier) sens-api-gateway/src/commands/dispatch_lifecycle.rs:308 (params passed to cmd_set_output unmodified)
  - (verifier) sens-api-gateway/src/mqtt.rs:178-203 (legacy CommandMessage: commandId/command/params/timestamp, unsigned)
  - (verifier) sens-api-gateway/src/commands/catalog.rs:417-425 (set_output DenyUnsignedInEnforcing)
  - (verifier) web/modules/sensor-module/src/components/process-editor/panels/PropertiesPanel.tsx:295-305 (only !result.success shows an error)
  - (verifier) serde_json Value::Bool.as_f64() returns None (auditor's offline cargo run; consistent with the serde_json API)
  - Verifier: No normaliser was found between dispatch and the handler, and mqtt-client.service publish adds no signing. This is not SCADA-builder code, but it is the only cloud-to-edge actuation path that exists, and it reports false success, so HIGH is appropriate.
- **CMD-01** (OPS; verdict CONFIRMED; severity HIGH): Widget command vocabulary has no consumer: setValue, emergencyStop and vfd:\* are dropped everywhere
  - Claim: Holds. No renderer emits 'writeTag', so that ScadaWidgetNode branch is dead. Only 'toggle' and 'press' (simulation-only) and 'navigate' do anything in the builder.
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/SliderRenderer.tsx:20, KnobRenderer.tsx:191, NumericInputRenderer.tsx:20 and :40 (controlled value=safeValue.toFixed), DropdownSelectRenderer.tsx:82 (onCommand('setValue'))
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/EmergencyStopRenderer.tsx:14-20 (confirm dialog then onCommand('emergencyStop'))
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:260-268, VfdMiniWidget.tsx:90-91 (vfd:\* commands)
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:223-245 (handles only navigate/toggle/press/writeTag, simulation-only)
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:302-317 (command.split(':'); if (!tagId) return)
  - web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeWidgetRenderer.tsx:312-321 (ignores \_command/\_value)
  - grep: no handler for 'vfd:' or 'emergencyStop' outside the emitting renderers
  - (verifier) grep of onCommand( in widget-renderers: setValue (Slider:20, NumericInput:20, Knob:191, DropdownSelect:82), emergencyStop (EmergencyStop:18), vfd:start/stop/program (VfdDriveWidget:260-268), vfd:navigate (VfdMini:91), toggle/press (ToggleSwitch:44, PushButton:22-24, Equipment:82), navigate (ScreenLink:31); no 'writeTag' emitter
  - (verifier) nodes/ScadaWidgetNode.tsx:221-245 (navigate; toggle/press/writeTag only when store.simulationMode)
  - (verifier) NumericInputRenderer.tsx:16-22,40 (controlled value=safeValue.toFixed(...), so with the command dropped React reverts every keystroke)
  - (verifier) components/scada-operator/OperatorView.tsx:302-317 (split(':'); if (!tagId) return)
  - (verifier) grep: 'emergencyStop'/'vfd:' have no consumer outside the emitting renderers; WidgetRenderer.tsx:301-317 passes onCommand through unchanged
  - Verifier: I checked whether WidgetRenderer translates commands, or whether some provider handles setValue. Neither does. The edge HMI has its own command path, so this finding concerns only the browser hosts.

</details>

### EDGE-CRITICAL-078

**Edge HMI binds every widget through config.tag, but every builder config panel writes config.tagName, so no widget on the device shows a value**

- Severity: CRITICAL · Domain: EDGE · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** Holds. Refinement: config.tag is undefined, so JSON.stringify drops the key. The Rust WsClientMessage::Command requires `tag: String`, so serde rejects the frame and the server replies {type:'error'}. The HMI has no handler for type 'error' (it only toasts on commandResult), so control taps fail with no feedback at all. They do not fail at a PIN or confirm step.

**What the user sees.** On the device's local HMI screen, gauges, numeric displays, tank levels and status lamps never show a value. Toggles, sliders, numeric inputs and push buttons send commands with an undefined tag, so they do nothing, or they fail the PIN/confirm flow for an empty tag.

**Root cause.** There are two binding vocabularies with no shared contract. The builder moved to tagName (and later tagRef), while the static edge HMI kept the original 'tag' key. No contract test covers widget config keys across the cloud/edge boundary.

**Fix direction.** Make the binding key part of the deploy contract. Either have edge-deploy-transform emit a canonical binding field that the edge HMI reads (one accessor mirroring getWidgetTagBinding), or switch scada-edge.html to resolve tagRef→tagName→tag. Add a fixture test that deploys a builder-produced widget and asserts the edge HMI resolves its tag.

**Evidence (canonical citations).**

- `sens-api-gateway/static/scada-edge.html:741,787,807,814,841,851,877,895,1307,1331,1354`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:33-35`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ToggleSwitchConfig.tsx:18-19`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SliderConfig.tsx:18-19`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/NumericInputConfig.tsx:18-19`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/PushButtonConfig.tsx:18-19`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/StatusIndicatorConfig.tsx:24-25`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/TankLevelConfig.tsx:18-19`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/NumericDisplayConfig.tsx:17-18`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts:66-74`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-123`
- `sens-api-gateway/src/scada_types.rs:102-110`
- `sens-api-gateway/src/scada_server.rs:501-505,1219-1224`
- `docs/SCADA_BUILDER_WIRING.md:140-148`
- `sens-api-gateway/static/scada-edge.html:741,787,807,841,877,1331,1354`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/NumericDisplayConfig.tsx:18-19`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts:63-74`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:93-97`
- `libs/sensor-contracts/fixtures/deploy-scada-package.json`
- `sens-api-gateway/src/scada_server.rs:1354-1365`
- `sens-api-gateway/static/scada-edge.html:1623-1720`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts`

<details><summary>Merged audit findings and full evidence</summary>

- **EDGE-01** (OPS; verdict CONFIRMED; severity BLOCKER): Edge HMI binds every widget through config.tag, but every builder config panel writes config.tagName
  - sens-api-gateway/static/scada-edge.html:741,787,807,814,841,851,877,895,1307,1331,1354 (tagStore[config.tag], send({tag: config.tag}))
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:33-35, ToggleSwitchConfig.tsx:18-19, SliderConfig.tsx:18-19, NumericInputConfig.tsx:18-19, PushButtonConfig.tsx:18-19, StatusIndicatorConfig.tsx:24-25, TankLevelConfig.tsx:18-19, NumericDisplayConfig.tsx:17-18 (onChange({ tagName }))
  - libs/sensor-contracts/src/scada-package-doc/upcast.ts:66-74 (adds only tagRef, legacy keys preserved, no 'tag')
  - libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-123 (widgets kept verbatim)
  - sens-api-gateway/src/scada_types.rs:102-110 (config: serde_json::Value passthrough); src/scada_server.rs:501-505,1219-1224 (package broadcast verbatim as setPackage)
  - docs/SCADA_BUILDER_WIRING.md:140-148 (configs previously wrote config.tag)
  - (verifier) sens-api-gateway/static/scada-edge.html:741,787,807,841,877,1331,1354 (tagStore[config.tag]); :814,851,856,895,1307 (send({type:'command', tag: config.tag}))
  - (verifier) web/.../widget-configs/GaugeConfig.tsx:34-35, ToggleSwitchConfig.tsx:18-19, SliderConfig.tsx:18-19, NumericInputConfig.tsx:18-19, PushButtonConfig.tsx:18-19, StatusIndicatorConfig.tsx:24-25, TankLevelConfig.tsx:18-19, NumericDisplayConfig.tsx:18-19 (all onChange({ tagName }))
  - (verifier) libs/sensor-contracts/src/scada-package-doc/upcast.ts:63-74 (writes only config.tagRef); edge-deploy-transform.ts:93-97 (ship widgets kept verbatim)
  - (verifier) libs/sensor-contracts/fixtures/deploy-scada-package.json: every ship widget uses tagRef/tagName and none uses 'tag'
  - (verifier) sens-api-gateway/src/scada_types.rs:102-110 (config: serde_json::Value passthrough), :318-322 (Command{tag:String,value:f64}); src/scada_server.rs:1354-1365 (parse error → {type:'error'}); scada-edge.html:1623-1720 (no 'error' branch)
  - (verifier) RAN: real upcast.ts + edge-deploy-transform.ts (node --experimental-transform-types, scratchpad verify-ops/run.ts) → edge payload config {"tagName":"ph","tagRef":"EDGE-01/temp"}, has config.tag = false
  - Verifier: No mapper on the cloud side (upcast, transform, deploy service) or the edge side (Rust passthrough, HMI setPackage handler at scada-edge.html:1635-1644) renames tagName/tagRef to tag. The contract fixture itself contains no 'tag' key.

</details>

### EDGE-CRITICAL-079

**Edge tag catalog is empty after every restart (io_config.yaml written but never read back), cloud DeviceIoConfig never creates or reconfigures a GPIO/Modbus/I2C driver, and nothing checks that bound tags exist on the device**

- Severity: CRITICAL · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: SELF 3; re-checked in session
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** In production, only the live update_io_config command fills the ProcessImage tag catalog. The other two set_configs callers are in test modules. The command writes /etc/suderra/io_config.yaml, but no code in the repository reads that file, and no boot step rebuilds the catalog. Nothing on the cloud side re-pushes the config when the device reconnects: pushIoConfigToDevice has a single caller, the GraphQL mutation behind one button. The edge never reports its loaded catalog (no count or hash in heartbeat/status), so the cloud keeps appliedConfigHash as 'applied' after the device has lost it. With an empty catalog, poll_cycle returns at io_poll.rs:146. That is before the io_data uplink and before broadcast_all_tags, evaluate_alarms and record_trends (io_poll.rs:465-471), which are their only production callers. The edge ST compiler resolves tags from the same empty catalog. Bytecode programs are rehydrated at boot (main.rs:2585) and then run against an empty snapshot.

**What the user sees.** After a power cycle or agent restart, the device HMI keeps the deployed screens, but every value shows '--', no alarm ever appears, trend charts stay empty and every button press fails silently. The cloud device page also stops receiving I/O data. Nothing changes until someone opens the edge device page and presses 'Cihaza Gonder' again. The cloud still records the config as applied.

**Root cause.** The ProcessImage catalog lives only in memory and is filled by a one-shot command. The persisted copy is write-only, and neither the edge (hydrate at boot) nor the cloud (reconcile on reconnect) owns restoring it.

**Fix direction.** Treat the device I/O manifest as a versioned, content-hashed artifact. The edge writes it atomically, hydrates it at boot before io_poll, the scan cycle and the HMI start, and reports the applied hash in every heartbeat. The cloud compares the reported hash with appliedConfigHash and re-pushes or flags drift on reconnect. Gate it with an integration test: apply, restart, assert the catalog and an io_data frame.

**Evidence (canonical citations).**

- `sens-api-gateway/src/commands/io_config.rs:76`
- `sens-api-gateway/src/commands/io_config.rs`
- `sens-api-gateway/src/opc_ua_server_runtime.rs:1431`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:538`
- `sens-api-gateway/src/process_image.rs:402-408`
- `sens-api-gateway/src/io_poll.rs:142-148`
- `sens-api-gateway/src/scada_server.rs:1241-1262`
- `sens-api-gateway/src/main.rs:5641-5643`
- `sens-api-gateway/src/commands/deploy_st_source.rs:278-279`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1566-1688`
- `apps/sensor-service/src/edge-device/edge-device.resolver.ts:394-403`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:774-800`
- `apps/sensor-service/src/edge-device/installer-script.service.ts:1144-1146`
- `sens-api-gateway/src/main.rs:2917-2951`
- `apps/sensor-service/src/edge-device/installer-script.service.ts:352,354`
- `sens-api-gateway/src/commands/io_config.rs:57-127`
- `sens-api-gateway/src/gpio.rs:340`
- `sens-api-gateway/src/modbus.rs:1566-1568`
- `sens-api-gateway/src/commands/provision.rs:109,112,202`
- `sens-api-gateway/src/safe_state.rs:327-328`
- `apps/sensor-service/src/vfd/services/vfd-edge-provisioning.service.ts:125-145`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1486-1497`
- `sens-api-gateway/src/io_poll.rs:150-173`
- `sens-api-gateway/src/gpio.rs:520-523`
- `sens-api-gateway/src/modbus.rs:893-960`
- `sens-api-gateway/src/config.rs:2798-2826`
- `sens-api-gateway/src/i2c.rs:456-467`
- `sens-api-gateway/src/commands/io_config.rs:183`
- `sens-api-gateway/src/main.rs:5653`
- `sens-api-gateway/src/scripting/engine.rs:1532`
- `sens-api-gateway/src/main.rs:4798-4802`
- `sens-api-gateway/src/safe_state.rs:95-123`
- `sens-api-gateway/src/commands/read.rs:157-167`
- `web/modules/sensor-module/src/hooks/useDeviceTags.ts:19-34`
- `apps/sensor-service/src/process/services/scada-package.service.ts:964-978`
- `apps/sensor-service/src/process/services/tag-resolution.service.ts:60-110`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1676-1679`
- `web/shared-ui/src/generated/graphql-types.ts:5109,5131`
- `apps/sensor-service/src/deploy-artifact/entities/deploy-artifact.entity.ts:11-15`
- `sens-api-gateway/src/commands/system.rs:358-498`

<details><summary>Merged audit findings and full evidence</summary>

- **IOP-01** (GAP1; verdict SELF; severity BLOCKER): The device's tag catalog is empty after every agent restart or power cycle: io_config.yaml is written but nothing reads it back, and nothing re-pushes it
  - sens-api-gateway/src/commands/io_config.rs:76 (sole production set_configs call), 120-122 (persist failure only warns), 793-798 (writes /etc/suderra/io_config.yaml)
  - grep across the repo for io_config.yaml: the only hits are the writer and comments in io_config.rs; there is no reader
  - grep set_configs: other callers are sens-api-gateway/src/opc_ua_server_runtime.rs:1431 (test mod at 982) and src/scripting/process_image_tagio.rs:538 (test mod at 343)
  - sens-api-gateway/src/process_image.rs:402-408 (set_configs replaces the in-memory map only)
  - sens-api-gateway/src/io_poll.rs:142-148 (configs.is_empty() returns early), 405-447 (io_data build and publish), 465-471 (HMI allTags, edge alarms, trends); grep confirms these three scada_state calls have no other caller
  - sens-api-gateway/src/scada_server.rs:1241-1262 (on WS connect the HMI gets allTags from the same empty ProcessImage)
  - sens-api-gateway/src/main.rs:5641-5643 (HMI write: 'Tag not found' when the catalog is empty)
  - sens-api-gateway/src/commands/deploy_st_source.rs:278-279 (compile catalog = pi.get_configs())
  - apps/sensor-service/src/edge-device/edge-device.service.ts:1566-1688 (push only on demand; appliedConfigHash set at 1676-1679 and never invalidated); grep pushIoConfigToDevice: only edge-device.resolver.ts:394-403
  - apps/sensor-service/src/ingestion/mqtt-listener.service.ts:774-800 (ack routing only; no reconnect re-push); grep across the edge for config_hash/tags_configured in status: none
  - /etc/suderra is writable by the service (installer-script.service.ts:1144-1146 ReadWritePaths), so the file is persisted but never read back
  - RUN: /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/ioprov/ioprov_proof.rs (cargo test against an unmodified copy of the gateway source) printed 'PROOF boot declared_types len = 0' and 'PROOF compile with empty catalog = Some(UnknownVariable { name: "water_temp" })'
- **IOP-02** (GAP1; verdict SELF; severity BLOCKER): Cloud DeviceIoConfig rows never create or reconfigure a GPIO, Modbus or I2C driver; reads and writes only work for hardware hand-written into config.yaml
  - Claim: Drivers are built once at boot from the local config.yaml. A GPIO actor exists only if config.gpio is non-empty, and an I2C actor only if config.i2c is non-empty. The Modbus actor always starts, but with config.modbus devices only. Both installers write 'modbus: []' and 'gpio: []' and no i2c. update_io_config touches only the ProcessImage map and the alarm manager. GpioHandle::reconfigure has no caller. ModbusManager::reconfigure is #[allow(dead_code)]. No edge command other than provision_modbus_device changes config.gpio, config.i2c or config.modbus. provision_modbus_device is sent only by the VFD module for drives bound to a gateway, never for DeviceIoConfig rows. The v2 cloud wire format deliberately dropped Modbus connection data, on the stated assumption that 'the agent resolves its own Modbus connection target from local provisioning', and no such local provisioning exists. On the read side, the protocol fields the cloud sends are ignored. Modbus values are matched to tags by config.yaml register name only, so slaveId, register and function are unused. GPIO reads cover only config.yaml pins whose direction is 'input'. I2C reads look up a config.yaml device by the tag name, so bus and address are unused. On the write side, every path fails. GPIO writes need a config.yaml output pin in both the real and the simulated build. Modbus set_output needs a config.yaml device with the same slave_id. Script actions fail without a GPIO actor. Boot safe-state is also built only from config.yaml, so outputs defined in the cloud are never driven to a safe state.
  - sens-api-gateway/src/main.rs:2917-2951 (init_hardware_handles from config.modbus/gpio/i2c; GPIO only if !config.gpio.is_empty() at 2932, I2C at 2943), 4795 (called once at boot)
  - apps/sensor-service/src/edge-device/installer-script.service.ts:352,354 and 450,452 ('modbus: []', 'gpio: []', no i2c key)
  - sens-api-gateway/src/commands/io_config.rs:57-127 (no driver call)
  - sens-api-gateway/src/gpio.rs:340 (reconfigure; grep '.reconfigure(' has no caller); sens-api-gateway/src/modbus.rs:1566-1568 (#[allow(dead_code)] reconfigure)
  - grep 'config.(gpio\|i2c\|modbus) =\|.push': only commands/provision.rs:109,112,202 (Modbus) and safe_state.rs:327-328 (test)
  - apps/sensor-service/src/vfd/services/vfd-edge-provisioning.service.ts:125-145 (the only provision_modbus_device sender, VFD only); reprovisionAllForEdge (171) has no caller
  - apps/sensor-service/src/edge-device/edge-device.service.ts:1486-1497 (comment: connection resolved from 'local provisioning'), 216-247 (AgentIoTagConfig has no host/port/serial fields)
  - sens-api-gateway/src/io_poll.rs:150-173 (GPIO matched by pin over gpio.read_all()), 196-212 (Modbus: reg_value.name == cfg.tag_name), 236-238, 282-284, 327 (I2C called with cfg.tag_name as the device name)
  - sens-api-gateway/src/gpio.rs:520-523 (only config.yaml input pins are read), 623/647 and 653-673 (write: 'Pin N not configured as output', also in the simulated build)
  - sens-api-gateway/src/modbus.rs:893-960 (ModbusClient reads only config.registers); src/config.rs:2798-2826, 2846-2873 (device and register config live in config.yaml)
  - sens-api-gateway/src/i2c.rs:456-467 (device_map.get(device) -> 'Device not found')
  - sens-api-gateway/src/commands/io_config.rs:183 ('GPIO handle not available'), 191-207 ('No Modbus device configured for slave_id'); src/main.rs:5653 ('GPIO unavailable'); src/scripting/engine.rs:1532 ('GPIO not available')
  - sens-api-gateway/src/main.rs:4798-4802 and src/safe_state.rs:95-123 (safe-state outputs only from config.yaml)
  - sens-api-gateway/src/commands/read.rs:157-167 (Auto-Detect scans the real platform, so the import -> push flow creates tags with no driver behind them)
- **IOP-06** (GAP1; verdict SELF; severity HIGH): Nothing checks that the tags a package or program binds actually exist on the device; appliedConfigHash is written but never read, and the edge accepts any tag
  - Claim: The builder's tag picker lists the cloud's active DeviceIoConfig rows. It does not know whether the device has applied them. The SCADA deploy gate resolves `${deviceCode}/${tagName}` against the cloud unified_tags table only, in warn mode by default (LINK-11). Even in enforce mode, a registry row proves only that the cloud database has the row. appliedConfigHash and lastConfigAckAt are set on a real ack but read by no backend code and selected by no frontend query (only the generated types). Neither the single nor the bundle deploy carries or triggers an I/O config: DeployArtifactType has SCADA_PACKAGE, PROCESS and AUTOMATION_PROGRAM, and no I/O manifest. Adding, editing or deleting a DeviceIoConfig row never auto-pushes. On the edge, cmd_deploy_scada_package validates the shape, the signature and that screens is non-empty, then reports 'deployed' without checking a single widget tag against the ProcessImage catalog.
  - web/modules/sensor-module/src/hooks/useDeviceTags.ts:19-34 (source = device.ioConfig.filter(isActive))
  - apps/sensor-service/src/process/services/scada-package.service.ts:964-978 and 1595-1601 (registry resolve), 853-857 (default 'warn')
  - apps/sensor-service/src/process/services/tag-resolution.service.ts:60-110 (lookup by fqn in tagRepository only)
  - apps/sensor-service/src/edge-device/edge-device.service.ts:1676-1679 (only writer); grep appliedConfigHash\|lastConfigAckAt: entity.ts:301-306, migration, spec, web/shared-ui/src/generated/graphql-types.ts:5109,5131 (no query selects it)
  - apps/sensor-service/src/deploy-artifact/entities/deploy-artifact.entity.ts:11-15 (no I/O config artifact type); grep update_io_config\|pushIoConfig in process/services and automation: none
  - sens-api-gateway/src/commands/system.rs:358-498 (deploy accepted; no get_config check)

</details>

### EDGE-CRITICAL-081

**Edge agent rejects the edge HMI's confirm, PIN and alarm-ack replies (and the calibration confirm action), so no control write, E-STOP or alarm ack executes from the device screen**

- Severity: CRITICAL · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: PARTIAL 2, SELF 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** WsClientMessage puts #[serde(tag="type", rename_all="camelCase")] on the enum, which renames only the variant tags. The struct-variant fields stay snake_case (request_id, alarm_id, point_index), but the HMI sends requestId, alarmId and pointIndex. So confirmResponse, pinResponse and alarmAck never deserialize, and calibrate loses pointIndex. The agent answers with {type:'error'}, which the HMI ignores. E-STOP always goes through confirmRequest → confirmResponse, so it never executes. Alarm ack never executes. Any write to a tag at Confirm or PIN level never executes. Confirm is the default for every tag not listed under 'No Security', and the lists start empty. One overstatement: a tag the user adds to the Control tab's 'No Security' list skips the confirm round-trip and executes directly. So 'no control write ever executes' holds only by default. Separately, today every HMI command already fails earlier, because widgets send tag: config.tag, which is undefined (EDGE-01), so the frame lacks the required `tag` field.

**What the user sees.** On the device HMI, tapping a switch, button, slider or numeric input shows 'Onayliyor musunuz?' (Are you sure?). Pressing Yes does nothing: no toast, and the value and output stay unchanged. E-STOP (after the hold and the confirm) leaves pumps running and never shows 'ACIL DURUM AKTIF'. The alarm list's 'Onayla' (acknowledge) button does nothing.

**Root cause.** serde rename_all on an enum renames variants, not variant fields. No test parses the client messages the HMI actually sends.

**Fix direction.** Use #[serde(rename_all_fields="camelCase")] (or per-variant rename_all) on WsClientMessage. Add a shared fixture set of every HMI→agent message that the HMI code produces and that Rust must parse. Show server 'error' frames in the HMI. Decide the default security level explicitly in the package rather than with a silent Confirm fallback.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scada_types.rs:316-353`
- `sens-api-gateway/static/scada-edge.html:1708`
- `sens-api-gateway/src/scada_server.rs:1354-1366`
- `sens-api-gateway/static/scada-edge.html:1625-1742`
- `web/modules/sensor-module/src/store/scada/types.ts:542-546`
- `sens-api-gateway/src/scada_types.rs`
- `sens-api-gateway/static/scada-edge.html:1622-1742`
- `sens-api-gateway/src/scada_server.rs:747-760`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:86-118`
- `sens-api-gateway/src/scada_server.rs:1747-1752`
- `sens-api-gateway/src/scada_server.rs:679-681`
- `sens-api-gateway/src/alarm_engine.rs:218-243`
- `sens-api-gateway/static/scada-edge.html:1677-1688`
- `sens-api-gateway/src/scada_server.rs:1259-1273`
- `sens-api-gateway/static/scada-edge.html:1155`
- `sens-api-gateway/src/scada_server.rs:1764-1807`
- `sens-api-gateway/src/calibration_engine.rs:182-193`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-01** (DEP; verdict PARTIAL; severity BLOCKER): The agent rejects the edge HMI's confirm, PIN and alarm-ack replies, so no control write, E-STOP or alarm ack ever executes from the device screen
  - sens-api-gateway/src/scada_types.rs:316-353 (enum-level rename_all; fields request_id, alarm_id, point_index)
  - sens-api-gateway/static/scada-edge.html:1708 (confirmResponse {requestId}), 1713 (pinResponse {requestId}), 1070 (alarmAck {alarmId}), 1195 (calibrate pointIndex)
  - sens-api-gateway/src/scada_server.rs:1354-1366 (parse error → {type:'error'}), 747-760 (unlisted tag → Confirm), 1436-1456 (confirmRequest), 1863-1890 (E-stop → confirmRequest only), 1565-1580 (only confirmResponse runs execute_command/execute_emergency_stop)
  - sens-api-gateway/static/scada-edge.html:1625-1742 (message switch: no 'error' branch)
  - web/modules/sensor-module/src/store/scada/types.ts:542-546 (securityLevels default to empty lists)
  - PROBE (scratchpad serdeproof crate built offline against the real scada_types.rs via #[path]): command / emergencyStop / requestTrend / emergencyReset parse OK; confirmResponse and pinResponse fail with "missing field `request_id`"; alarmAck fails with "missing field `alarm_id`"; calibrate parses but point_index=None
  - (verifier) sens-api-gateway/src/scada_types.rs:316-353 (enum-level rename_all; request_id, alarm_id, point_index fields; no rename_all_fields)
  - (verifier) sens-api-gateway/src/scada_server.rs:1354-1366 (parse error → {type:'error'}); scada-edge.html:1622-1742 (no 'error' branch)
  - (verifier) sens-api-gateway/src/scada_server.rs:747-760 (unlisted tag → SecurityLevel::Confirm), 1436-1456 (confirmRequest), 1863-1890 (E-stop only sends confirmRequest), 1565-1586 (only a parsed confirmResponse calls execute_emergency_stop/execute_command)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:86-118 ('No Security' list exists and is user-editable); store/scada/types.ts:542-546 (lists default empty)
  - (verifier) Re-ran the auditor's compiled probe (binary newer than scada_types.rs mtime): command/emergencyStop/emergencyReset/requestTrend OK; confirmResponse and pinResponse → missing field `request_id`; alarmAck → missing field `alarm_id`; calibrate → point_index None
  - (verifier) grep sens-api-gateway/src for confirmResponse/requestId parsing tests: none
  - Verifier: I read both sides and re-ran the serde probe; the core claim holds exactly. I looked for a pre-parse camel→snake mapping in handle_ws_message and found none. I also looked for a test that parses HMI frames and found none. I refuted only the totality ('no control write ever'), because the user can route tags through the 'No Security' list. E-STOP and alarm ack are broken unconditionally, so BLOCKER stands.
- **DEP-V-02** (DEP-verifier; verdict SELF; severity LOW): Even once alarmAck parses, the agent sends no reply or broadcast, so the HMI never shows the alarm as acknowledged
  - Claim: handle_alarm_ack calls AlarmEngine::acknowledge and only logs on error. It sends nothing to the requesting socket, and evaluate() explicitly does not broadcast AlarmEvent::Acknowledged. The HMI updates activeAlarms only on 'alarm' and 'alarmClear' frames, so an acknowledged but still-active alarm keeps its 'Onayla' (acknowledge) button and unacked styling on every connected HMI. Only a reconnect corrects it, because the on-connect replay carries acked:true. A failed ack ('Alarm … not found') is also invisible to the operator. This is masked today by DEP-01, since alarmAck never parses.
  - sens-api-gateway/src/scada_server.rs:1747-1752 (handle_alarm_ack: no socket reply, no broadcast)
  - sens-api-gateway/src/scada_server.rs:679-681 (AlarmEvent::Acknowledged → 'no broadcast needed')
  - sens-api-gateway/src/alarm_engine.rs:218-243 (acknowledge mutates state and DB only)
  - sens-api-gateway/static/scada-edge.html:1677-1688 (activeAlarms changed only by 'alarm'/'alarmClear'), 1070 (ack button shown while !acked)
  - sens-api-gateway/src/scada_server.rs:1259-1273 (on-connect replay is the only path that delivers acked:true)
- **DEP-17** (DEP; verdict PARTIAL; severity LOW): The edge calibration wizard's 'Onayla' (confirm) step can never advance: the HMI sends action 'confirm_point', the agent handles 'confirm'
  - Claim: The protocol mismatch is real. The HMI sends action 'confirm_point' with pointIndex, while handle_calibrate accepts only 'start', 'confirm' and 'cancel', and pointIndex deserializes to None. But the 'Onayla' button never even appears, so the stated symptom of pressing it doing nothing cannot occur. The button renders only when calibState.stable is true. stable comes only from CalibrationEngine::tick, which has no caller, so every state message carries stable:false. The wizard also cannot start, because config.sensors are strings (CALIB-EDGE-01). Even 'confirm' would fail with 'No readings collected' (see new finding DEP-V-01).
  - sens-api-gateway/static/scada-edge.html:1155 ('start'), 1195 ('confirm_point', pointIndex), 1196 ('cancel')
  - sens-api-gateway/src/scada*server.rs:1764-1807 (match 'start' \| 'confirm' \| 'cancel' \| * → warn)
  - PROBE: calibrate with pointIndex parses with point_index=None
  - (verifier) sens-api-gateway/static/scada-edge.html:1155 ('start'), 1195 (confirm button gated on calibState.state==='waiting_point' && calibState.stable; sends 'confirm_point'), 1196 ('cancel')
  - (verifier) sens-api-gateway/src/scada*server.rs:1764-1807 (match 'start' \| 'confirm' \| 'cancel' \| * → warn 'Unknown calibration action')
  - (verifier) sens-api-gateway/src/calibration_engine.rs:182-193 (start → stable:false), 197-246 (tick is the only producer of stable:true); grep '.tick(' across sens-api-gateway/src: no caller on the calibration engine
  - (verifier) verdict_OPS_3.json CALIB-EDGE-01 (start sends no tag because sensors are strings)
  - Verifier: The seam mismatch holds. Two earlier breaks mask it completely: start fails, and stable never becomes true, so the user-visible symptom described cannot happen. I re-graded it to LOW as a latent defect behind DEP-V-01 and CALIB-EDGE-01.

</details>

### SENSOR-HIGH-288

**Widget binding has no single source of truth (tag, tagName, tagRef, variable keys): a stale tagRef shadows every rebind, device changes and Clear Binding do not update it, Bind overwrites device tags, and Auto-Bind records a key the widget never reads**

- Severity: HIGH · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 3, PARTIAL 2, SELF 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** Holds and is proven by running the real upcaster. After the first save, config is {tagName:'temp', tagRef:'EDGE-01/temp'}. After the rebind and a second save it is {tagName:'ph', tagRef:'EDGE-01/temp'}, and that contradictory pair ships to the edge unchanged. The stale tagRef appears only when meta.edgeDeviceId was set at save time, because resolveDeviceCode needs it. Duplicate of LIFE-01.

**What the user sees.** The user changes a gauge's tag from 'temp' to 'ph' and the Tag field shows 'ph', but the gauge keeps showing temperature in preview and simulation, and still shows it after saving and reloading. Changing the target device leaves widgets pointing at the old device.

**Root cause.** tagRef was introduced as the canonical key but has no writer in the builder; only the server-side upcast writes it. The legacy writers were never migrated and the upcast is first-write-wins.

**Fix direction.** Make the builder write the canonical binding: TagBrowser onChange writes tagRef, built with the selected device's deviceCode, and clears the legacy keys. Route all readers, including ScadaWidgetNode.handleCommand and SimulationSidebar, through getWidgetTagBinding. Make the server upcast recompute tagRef whenever the legacy key changed, or reject documents where tagRef and tagName disagree.

**Evidence (canonical citations).**

- `apps/sensor-service/src/process/services/scada-package.service.ts:152-166`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts:40-41`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18,33-41`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:33-35`
- `web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:195-200`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:135-141`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:274-278`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:213,231-243`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:257`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:131-141`
- `web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:195-199`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:213`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:271-284`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts:37-42`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:88-101`
- `web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:196-202`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18,29-40`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:274`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:197`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts`
- `web/modules/sensor-module/src/store/scada/__tests__/scadaPackageRoundtrip.test.ts`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts:41-42`
- `apps/sensor-service/src/process/services/scada-package.service.ts:152-166,492`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:89-101`
- `web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:195-202`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:132-141`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:19,30-40`
- `sens-api-gateway/static/scada-edge.html:741,787,807,841`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts:37-58`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgTagBindingSection.tsx:54-56`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:58-64`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgTagBindingSection.tsx:52-54`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:89-99`
- `web/shared-ui/src/generated/graphql-types.ts`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:68-80,128-132`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:132-151`
- `apps/sensor-service/src/automation/automation.service.ts:1900-1918`
- `sens-api-gateway/src/scripting/engine.rs:937-939`
- `sens-api-gateway/src/process_image.rs:233-234,299`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:68-80`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:19`
- `apps/sensor-service/src/automation/automation.service.ts:1903-1918`
- `sens-api-gateway/src/scripting/engine.rs:982-1008`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:132-149`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:120`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:274-277`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:332-337`
- `web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18,30-41`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:269-283`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:173-178`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:442-444`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:451-457`

<details><summary>Merged audit findings and full evidence</summary>

- **BIND-01** (OPS; verdict CONFIRMED; severity HIGH): Re-binding a widget's tag after the first save is silently ignored: a stale config.tagRef shadows the new tagName
  - apps/sensor-service/src/process/services/scada-package.service.ts:152-166 (save-path upcastScadaPackageDoc with deviceCode)
  - libs/sensor-contracts/src/scada-package-doc/upcast.ts:40-41 (existing tagRef wins), 45-53 (promotion with deviceCode)
  - web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18,33-41 (precedence tagRef → tagName → tag → tagId)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:33-35 (TagBrowser value=config.tagName, writes only tagName; same pattern in all configs)
  - web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:195-200 (writes {tagName})
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:135-141 (bindVariableToWidgetAndSetTag sets tagName, deletes tag, leaves tagRef)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:274-278 (display via getWidgetTagBinding) vs nodes/ScadaWidgetNode.tsx:213,231-243 (commands via tagName\|\|tag)
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:257 (tagName\|\|tag)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:152-166 (save-path upcast with deviceCode)
  - (verifier) libs/sensor-contracts/src/scada-package-doc/upcast.ts:40-41 (existing valid tagRef wins), 43-56
  - (verifier) web/.../engine/tags/widgetBinding.ts:19,33-41 (tagRef first)
  - (verifier) grep: there is no tagRef writer or cleaner anywhere in web/modules/sensor-module/src (only readers/comments)
  - (verifier) store/scada/projectSlice.ts:131-141 (bindVariableToWidgetAndSetTag writes tagName, deletes tag, leaves tagRef); components/scada-builder/CsvTagDialog.tsx:195-199
  - (verifier) nodes/ScadaWidgetNode.tsx:213 (commands use tagName\|\|tag) vs ScreenCanvas.tsx:271-284 (display via getWidgetTagBinding)
  - (verifier) RAN: scratchpad verify-ops/run.ts output 'after rebind+save: {"tagName":"ph","tagRef":"EDGE-01/temp"}'
  - Verifier: I looked for a counter path: a builder-side upcast that recomputes tagRef, or a TagBrowser that writes tagRef. loadFromJSON upcasts without deviceCode, which leaves the existing tagRef in place. Nothing clears tagRef on rebind.
- **LIFE-01** (LIFE; verdict PARTIAL; severity HIGH): Re-binding a widget after its first save+reload does nothing: a stale config.tagRef keeps winning
  - Claim: Duplicate of OPS BIND-01. After the first save with a target device (or a read-path upcast with one), config.tagRef='<deviceCode>/<tagName>' is persisted. Every FE rebind writer (Properties panel merge, CSV import, bindVariableToWidgetAndSetTag) updates only config.tagName, and the upcaster returns any existing valid tagRef before it looks at tagName. The stale tagRef therefore survives every later save and device change, and getWidgetTagBinding (tagRef first) makes the builder canvas, preview and simulation show the OLD tag while the Properties panel shows the new one. The edge part of the claim is wrong: the edge HMI reads config.tag (EDGE-01), so it shows neither tag, not 'DO_1'. The cloud-operator symptom is moot because the operator renders '?' boxes (OPS-01).
  - libs/sensor-contracts/src/scada-package-doc/upcast.ts:37-42 (existing valid tagRef returned before legacy keys are considered)
  - apps/sensor-service/src/process/services/scada-package.service.ts:152-166 + 492 (save-boundary upcast with deviceCode from meta.edgeDeviceId)
  - web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:88-101 (config: {...widget.config, ...updates}; tagRef preserved)
  - web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:196-202 (CSV import writes tagName only)
  - web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18,29-40 (precedence tagRef > tagName)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:274 and components/scada-operator/OperatorView.tsx:197 (readers)
  - sens-api-gateway/src (grep: no tagRef/tag_ref reader; the edge uses tagName)
  - Proven by running the real upcast.ts under node --experimental-transform-types: save#1 {tagName:'pH_1',tagRef:'EDGE-01/pH_1'}; after rebind + save#2 {tagName:'DO_1',tagRef:'EDGE-01/pH_1'}; effective binding = EDGE-01/pH_1
  - web/modules/sensor-module/src/store/scada/**tests**/scadaPackageRoundtrip.test.ts (FE-only round-trip; no save-boundary upcast + rebind case)
  - (verifier) libs/sensor-contracts/src/scada-package-doc/upcast.ts:41-42 (existing valid tagRef returned first)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:152-166,492 (save upcast with deviceCode from meta.edgeDeviceId)
  - (verifier) web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:89-101 (config: {...widget.config, ...updates})
  - (verifier) web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:195-202
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:132-141 (sets tagName, deletes tag, keeps tagRef)
  - (verifier) web/modules/sensor-module/src/engine/tags/widgetBinding.ts:19,30-40
  - (verifier) grep 'tagRef' in sensor-module/src: no writer anywhere, only readers
  - (verifier) sens-api-gateway/static/scada-edge.html:741,787,807,841 (edge reads config.tag only)
  - (verifier) Ran the real upcast.ts (node --experimental-transform-types, scratchpad copy): save#1 {tagName:'pH_1',tagRef:'EDGE-01/pH_1'}; rebind + save with deviceCode EDGE-02 -> {tagName:'DO_1',tagRef:'EDGE-01/pH_1'}
  - Verifier: The core seam holds and I reproduced it, including the device-change case. The 'edge shows DO_1' symptom is false and the operator symptom is masked by OPS-01. This finding is the same as BIND-01.
- **LINK-11** (BIND; verdict CONFIRMED; severity MEDIUM): tagRef's device segment is frozen at first save; device switch and 'Clear Binding' do not update it, and the deploy gate checks a different identity
  - Claim: Holds, and it extends BIND-01/LIFE-01 with new triggers. In the upcaster an existing valid tagRef always wins, so retargeting the device keeps the first device's code. Clear Binding merges {tagName:''} into config and leaves tagRef. The deploy gate collects only top-level tagName/tag and resolves `${targetDeviceCode}/${name}`, so it validates a different identity than the tagRef that ships, and it double-prefixes a tagName that is already a full ref. The gate defaults to warn, and no compose, env or json file sets SCADA_DEPLOY_TAG_GATE. resolveTagRefs has no UI consumer.
  - libs/sensor-contracts/src/scada-package-doc/upcast.ts:37-58 (existing tagRef wins)
  - apps/sensor-service/src/process/services/scada-package.service.ts:152-166 (save upcast with meta.edgeDeviceId), 413-430 (gate reads tagName/tag only), 853-857 (default warn), 966-978 (refs from target deviceCode)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgTagBindingSection.tsx:54-56 (clear sets tagName '' only)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:58-64 (device switch only marks dirty)
  - grep: SCADA_DEPLOY_TAG_GATE appears only in .ts sources/tests, no compose/env
  - grep: resolveTagRefs not used in web/
  - RUN: scratchpad/link/ns-test.ts 'save#2 (device B) config = {"tagName":"pH_1","tagRef":"EDGE-AAAA/pH_1"}', 'deploy doc config = ... EDGE-AAAA/pH_1', double-prefix isTagRef=false
  - (verifier) libs/sensor-contracts/src/scada-package-doc/upcast.ts:37-58 (existing tagRef returned first)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:152-166 (save-time upcast), 412-430 (collectWidgetTagNames: tagName/tag only), 853-857 (default 'warn'), 966-978 (refs from target deviceCode)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgTagBindingSection.tsx:52-54 (clear -> {tagName:''}); pages/scada/usePropertiesPanelHandlers.ts:89-99 (config merged with spread, so tagRef survives)
  - (verifier) grep SCADA*DEPLOY_TAG_GATE in *.yml/_.yaml/_.env\_/\*.json: none; grep resolveTagRefs in web: only generated graphql-types.ts
  - (verifier) Re-ran scratchpad/link/out-ns.cjs: save#2 (device B) keeps tagRef EDGE-AAAA/pH_1; the double-prefixed ref fails isTagRef
  - Verifier: Every hop was read and the harness was re-run. Deploy does not write the upcast document back (scada-package.service.ts:1077-1079 saves status only), so the freeze comes from save-time promotion, as claimed.
- **LINK-10** (BIND; verdict PARTIAL; severity MEDIUM): 'Bind' silently overwrites the chosen widget's tag with the variable's ioTagName or varName; device-less variables bind widgets to a name no device has
  - Claim: The overwrite is confirmed. bindVariableToWidgetAndSetTag sets widget.config.tagName = ioTagName \|\| varName, deletes config.tag and leaves config.tagRef, so the canvas keeps reading the old tag through tagRef. autoBindByTag does not rewrite widgets. The suspected 'no mirroring' clause is refuted: the edge scripting engine does mirror context variables into the process image (sync_to_process_image, called each tick). It mirrors them under the key 'var:<name>' (and virtual sensors as 'sensor:<name>'), though, while Bind stores the bare varName, so the widget key still matches nothing the edge publishes. The outcome is the same, but the fix needs the prefix. Sibling SIM-14 overlaps.
  - web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:68-80,128-132 (shows current tag), 332-338 (variableTag = ioTagName \|\| varName)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:132-151 (overwrites tagName, deletes tag, keeps tagRef), 164-218 (autoBindByTag does not rewrite)
  - apps/sensor-service/src/automation/automation.service.ts:1900-1918 (no I/O -> var:{varName})
  - sens-api-gateway/src/scripting/engine.rs:937-939 (outputs to context); sens-api-gateway/src/process_image.rs:233-234,299 (HMI tags keyed by io-config tag_name)
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:132-151 (overwrite; tagRef untouched), 164-218 (autoBindByTag no rewrite)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:68-80 (picker shows current tag), 332-338 (variableTag = ioTagName \|\| varName)
  - (verifier) web/modules/sensor-module/src/engine/tags/widgetBinding.ts:19 (tagRef has precedence, so the canvas shows the stale tag)
  - (verifier) apps/sensor-service/src/automation/automation.service.ts:1903-1918 (no I/O -> var:{varName})
  - (verifier) sens-api-gateway/src/scripting/engine.rs:982-1008 (context vars written to the process image as format!("var:{}")), 708 and 775 (called each cycle)
  - (verifier) sens-api-gateway/src/process_image.rs:233-234,299 (HMI tags keyed by bare io-config tag_name)
  - Verifier: Reading engine.rs found the mirroring the auditor suspected was absent. The key mismatch (bare name vs 'var:'-prefixed) keeps the user-visible defect, so the verdict is PARTIAL with a corrected mechanism.
- **SIM-14** (SIM; verdict CONFIRMED; severity MEDIUM): Binding a program variable to a widget overwrites the widget's device tag, and after a reload the widget no longer reads the key the program writes
  - Claim: Holds. bindVariableToWidgetAndSetTag overwrites widget.config.tagName with ioTagName \|\| varName, deletes config.tag and leaves config.tagRef untouched. The canvas resolves tagRef first (getWidgetTagBinding), while the program tick, the sidebar and ScadaWidgetNode key on tagName. The upcaster keeps an existing valid tagRef. On any package saved at least once, the program writes a key the widget never reads, and the widget's device tag is replaced in the design. This is mostly covered by BIND-01 (stale tagRef shadows rebinding, automation bind included) and LINK-10 (Bind overwrites the widget's tag). It is kept as the simulation-specific consequence.
  - writer: web/modules/sensor-module/src/store/scada/projectSlice.ts:132-149 (tagName = tag; delete tag; tagRef untouched)
  - web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:120 (onSelect(widgetId, variableTag)), :331-337
  - reader: web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18 (tagRef first), components/scada-builder/ScreenCanvas.tsx:274-277
  - sidebar/command key: SimulationSidebar.tsx:257, ScadaWidgetNode.tsx:213 (tagName\|\|tag)
  - RAN: scratchpad/sim/bind-test.ts → config after bind {"tagName":"pump_cmd","tagRef":"EDGE-A/PUMP1_FB"}; program writes 'pump_cmd'; canvas reads 'PUMP1_FB'
  - (verifier) web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:332-337 (variableTag = v.ioTagName \|\| v.varName → bindVariableToWidgetAndSetTag)
  - (verifier) reader: web/modules/sensor-module/src/engine/tags/widgetBinding.ts:18,30-41 (tagRef first); web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:269-283
  - (verifier) libs/sensor-contracts/src/scada-package-doc/upcast.ts:37-58 (existing valid tagRef wins; legacy keys preserved)
  - (verifier) program/sidebar/command keys: SimulationSidebar.tsx:257, :470-475 (boundTag); ScadaWidgetNode.tsx:211 (tagName \|\| tag)
  - Verifier: I verified the writer and both readers. It overlaps prior findings but is not refuted.
- **SIMV-03** (SIM-verifier; verdict SELF; severity MEDIUM): Auto-Bind's label match records a binding key the matched widget never reads, so 'matched' variables do nothing in simulation
  - Claim: autoBindByTag first matches a variable's ioTagName \|\| varName against widget tags. If that fails, it falls back to a widget whose config.label equals the name and stores boundTag = the variable name, without changing the widget's config. The program tick writes simTagValues[varName] and reads inputs from simTagValues[varName]. The canvas reads the widget's own binding (getWidgetTagBinding: tagRef/tagName/tag), which is either a different tag or nothing, and the sidebar lists only widget tags, so no control writes that key. The panel still shows the variable as bound with a check mark and counts it in 'N matched'.
  - writer: web/modules/sensor-module/src/store/scada/projectSlice.ts:173-178 (labelToWidget map), :200-205 (label fallback → { boundWidgetId: widgetByLabel.id, boundTag: tagName } with no widget config change)
  - web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:442-444 ('{matched} matched' toast), :294 (bound check when boundWidgetId set)
  - reader: web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:451-457 and :470-475 (program I/O keyed by vb.boundTag), :253-269 (Tag Values list built from widget tagName\|\|tag only)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:269-283 (widget value read via getWidgetTagBinding(w.config), not boundTag)

</details>

### SENSOR-HIGH-289

**Tag sourcing blocks design: the builder binds only to the selected device's DeviceIoConfig rows, draft/virtual tags cannot be created (DRAFT unreachable), device pickers truncate at 20/50, and typed tag names are discarded**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 3, PARTIAL 1, SELF 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** Holds. All 31 TagBrowser usages are fed only by useDeviceTags(targetDeviceId), which reads edgeDevice(id).ioConfig filtered to isActive. With no device the dropdown says 'Select a target device first'. Focus opens the dropdown, so typing goes to the search box. Enter commits only in multiple mode, and an outside click clears the text, so free typing never reaches onChange unless the user presses Escape first. No builder component uses useUnifiedTags/useSearchTags. This overlaps sibling EDIT-02 (typing discarded) but is broader, because the registry is never offered at all.

**What the user sees.** Without an edge device selected, clicking any 'Tag' field says 'Select a target device first'. Whatever the user types disappears when they click away, so a design cannot be wired to tags before hardware exists.

**Root cause.** The builder's tag picker is hard-wired to one device's hardware channel table instead of to the tag registry, which is declared the SSoT.

**Fix direction.** Back TagBrowser with the registry (useUnifiedTags/useSearchTags with an optional edgeDeviceId filter), store the fqn or tag id, and allow 'create draft tag' inline. Keep useDeviceTags only as the commissioning-time channel picker.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/hooks/useDeviceTags.ts:19-34`
- `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:103-115`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:432`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgTagBindingSection.tsx:115-119`
- `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:58-68`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:352`
- `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:11-18`
- `apps/sensor-service/src/process/dto/unified-tag.dto.ts:9-14,33-121`
- `apps/sensor-service/src/process/entities/unified-tag.entity.ts:146-148`
- `apps/sensor-service/src/database/migrations/1801100000000-UnifiedTagLifecycle.ts:28`
- `apps/sensor-service/src/process/services/unified-tag.service.ts:42-56`
- `web/modules/sensor-module/src/hooks/useUnifiedTags.ts`
- `web/modules/sensor-module/src/graphql/unified-tag.queries.ts`
- `apps/sensor-service/src/process/dto/unified-tag.dto.ts:9-14`
- `libs/sensor-contracts/src/tag-ref.ts:29-39`
- `apps/sensor-service/src/process/resolvers/unified-tag.resolver.ts:105-177`
- `web/modules/sensor-module/src/hooks/useUnifiedTags.ts:276,341`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:210-216`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:149-159,176-207`
- `apps/sensor-service/src/edge-device/edge-device.service.ts:583-618`
- `apps/sensor-service/src/edge-device/edge-device.resolver.ts:98-120`
- `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:308,509-524`
- `web/modules/sensor-module/src/hooks/useDeviceTags.ts:20`
- `web/modules/sensor-module/src/hooks/useEdgeDevices.ts:297-314`
- `web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:308`
- `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:236`
- `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:58-67`
- `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:168`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:86-95`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:90-95`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:88-101`
- `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx`
- `web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:398`
- `apps/sensor-service/src/edge-device/dto/edge-device.dto.ts:134-138`
- `apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts:155`
- `apps/sensor-service/src/edge-device/entities/device-io-config.entity.ts:79-80`
- `libs/sensor-contracts/src/tag-ref.ts:35`

<details><summary>Merged audit findings and full evidence</summary>

- **LINK-05** (BIND; verdict CONFIRMED; severity HIGH): The builder can bind only to the selected edge device's DeviceIoConfig rows; with no device (or zero devices) no tag can be bound through the visible UI
  - web/modules/sensor-module/src/hooks/useDeviceTags.ts:19-34 (only source: edgeDevice.ioConfig, isActive)
  - web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:103-115 (open -> setSearch, not onChange), 117-126 (Enter only for multiple), 58-68 (outside click clears), 164-171 ('Select a target device first'), 236 (onFocus opens)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:432 (deviceId={targetDeviceId} into PropertiesPanel)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgTagBindingSection.tsx:115-119 (wrong location hint)
  - grep: useUnifiedTags/useSearchTags are used only by pages/tags/TagRegistryPage.tsx and pages/unified/UnifiedEditorPage.tsx (display list), never by components/scada-builder
  - RUN: scratchpad/link/tagbrowser-test.tsx with the real TagBrowser: 'dropdown after focus: Select a target device first'; 'onChange calls after typing while open: []'; 'after Enter calls: []'; 'after outside click: input value = ""'; 'after Escape then typing: calls = ["pH_1"]'
  - (verifier) web/modules/sensor-module/src/hooks/useDeviceTags.ts:19-34
  - (verifier) web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:58-68 (outside click clears), 103-115 (open -> setSearch), 117-126 (Enter only when multiple), 164-171 ('Select a target device first'), 236 (onFocus opens)
  - (verifier) grep -rln '<TagBrowser' components: 31 files; grep useUnifiedTags/useSearchTags: only pages/tags/TagRegistryPage.tsx and pages/unified/UnifiedEditorPage.tsx (a display-only LiveTagsPanel)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:432 (deviceId={targetDeviceId}); projectSlice.ts:352 (target restored from meta.edgeDeviceId)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgTagBindingSection.tsx:115-119 (hint points to widget properties; the selector is in the toolbar)
  - Verifier: The auditor's jsdom harness could not be re-run here (jsdom is not resolvable from the scratchpad), but the event logic in TagBrowser.tsx reads unambiguously: handleInputChange routes to setSearch while open, and onFocus sets open. The target device restores correctly on reload, so the defect is specific to the device-less and zero-channel cases, which is exactly the user's draft scenario.
- **LINK-06** (BIND; verdict PARTIAL; severity MEDIUM): Draft or virtual tags cannot be created anywhere, the DRAFT state is unreachable, and a registry tag can never be re-pointed at a device channel
  - Claim: Confirmed: no code path ever writes TagStatus.DRAFT. CreateTagInput has no status field, the entity and migration default to ACTIVE, and discoverTags sets none. So the Delete button (rendered only for drafts) never appears, every tag can only be retired, and createUnifiedTag/autoBindTags have no UI. Refuted: the claim that a tag can never be re-pointed. updateUnifiedTag accepts and applies fqn (grammar-validated), localName and source, which includes edgeDeviceId/ioConfigId/sensorId, and bumps the revision. Re-pointing is therefore possible through the API, and only the edit modal lacks those fields. The fqn grammar also accepts any 1-50 char prefix, so a logical 'SITE1/pH_1' tag is grammatically legal. Severity drops to MEDIUM: the builder does not consume the registry at all (LINK-05), so draft tags would not help until that is fixed, and the device-backed discover path works.
  - web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:11-18 (capability list), 323-336 + 525-540 (discover requires a device), 463-487 (Delete only when draft), 641-660 (retire 'geri alınamaz'), 117-177 (edit modal: no fqn/source device fields)
  - apps/sensor-service/src/process/dto/unified-tag.dto.ts:9-14,33-121 (fqn regex; no status on create)
  - apps/sensor-service/src/process/entities/unified-tag.entity.ts:146-148 (default ACTIVE)
  - apps/sensor-service/src/database/migrations/1801100000000-UnifiedTagLifecycle.ts:28 (DEFAULT 'active')
  - apps/sensor-service/src/process/services/unified-tag.service.ts:42-56 (createTag spreads input), 129-139 (hard delete only DRAFT), 252-273 (discovered tags: no status)
  - grep web/: createUnifiedTag / autoBindTags referenced only in hooks/useUnifiedTags.ts and graphql/unified-tag.queries.ts
  - (verifier) apps/sensor-service/src/process/dto/unified-tag.dto.ts:9-14 (FQN_REGEX from TAG_REF_PATTERN), CreateTagInput (no status); UpdateTagInput fields fqn (@Matches FQN_REGEX), localName, source, hierarchy
  - (verifier) libs/sensor-contracts/src/tag-ref.ts:29-39 (deviceCode segment is any [A-Za-z0-9][A-Za-z0-9_.-]{0,49})
  - (verifier) apps/sensor-service/src/process/services/unified-tag.service.ts:42-56 (createTag spreads input), 58-84 (updateTag applies fqn/localName/source + revision bump), 129-139 (hard delete only DRAFT), 252-273 (discovered: no status)
  - (verifier) grep TagStatus.DRAFT in apps/sensor-service/src/process: only the enum and the delete guard
  - (verifier) apps/sensor-service/src/process/entities/unified-tag.entity.ts:146-148 (default ACTIVE); apps/sensor-service/src/process/resolvers/unified-tag.resolver.ts:105-177 (create/update/delete/retire/discover/autoBind mutations exposed)
  - (verifier) web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:11-18 ('Delete: remove a tag'), 463-487 (Delete only when draft), 110-177 edit modal (only display, range, alarm and live-link source.sensorId/channelId)
  - (verifier) grep web: useCreateTag/useAutoBindTags defined in hooks/useUnifiedTags.ts:276,341, no component consumer
  - Verifier: The DRAFT-unreachable and no-create-UI parts hold. The 'never re-pointed' part is wrong at the API level, because updateTag writes fqn and source. updateTag also changes fqn without scanning references, but nothing stores registry ids today, so that is noted and not graded.
- **LINK-12** (BIND; verdict CONFIRMED; severity LOW): Device pickers are truncated (builder 50, Tag Registry 20, newest first, no search), so older devices cannot be targeted or discovered
  - Claim: Holds. The builder fetches 50 devices and the Tag Registry fetches the resolver default of 20, ordered createdAt DESC, with no search UI or inService filter. A saved target outside the page shows 'Select Device', while TagBrowser still lists its channels by id. Real impact is limited to tenants with more than 20 or 50 devices, so the severity is downgraded.
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:210-216
  - web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:149-159,176-207
  - apps/sensor-service/src/edge-device/edge-device.service.ts:583-618 (default 20, createdAt DESC)
  - apps/sensor-service/src/edge-device/edge-device.resolver.ts:98-120 (limit defaultValue 20; inService optional)
  - web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:308,509-524
  - web/modules/sensor-module/src/hooks/useDeviceTags.ts:20 (fetch by id, independent of list)
  - (verifier) web/modules/sensor-module/src/hooks/useEdgeDevices.ts:297-314 (passes the filter through; no default limit)
  - (verifier) apps/sensor-service/src/edge-device/edge-device.service.ts:583-618 (limit \|\| 20, order createdAt DESC)
  - (verifier) web/modules/sensor-module/src/pages/tags/TagRegistryPage.tsx:308, 518-522 (devices?.items)
  - (verifier) web/modules/sensor-module/src/hooks/useDeviceTags.ts:20 (fetch by id)
  - Verifier: Both sides were read. The defect is real but affects only large tenants, so LOW.
- **EDIT-02** (EDIT; verdict CONFIRMED; severity MEDIUM): Typing a tag name into any Tag field is silently discarded; only picking from the device list commits
  - Claim: DUPLICATE of LINK-05 (find_LINK_6.json), which already proved the same TagBrowser mechanics in jsdom; merge them. The claim holds. onFocus opens the dropdown (TagBrowser.tsx:236). While open, the input shows `search` (:234), and typing only updates search (:105-106). Enter commits only in multiple mode (:118). An outside mousedown closes and clears search without calling onChange (:58-67). With no deviceId the dropdown only says 'Select a target device first' (:165-170). Typed text commits only through the undiscoverable sequence focus -> Escape -> type, which then calls onChange on every keystroke (:107-110). About 30 tag fields use the component (29 widget-config panels plus UnifiedPropertiesPanel). Two fields bypass it with a plain input: SchedulerConfig.tsx:233 and FuxaWidgetConfig.tsx:325.
  - web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:236 onFocus={() => setOpen(true)}; :234 value={open ? search : ... value}
  - TagBrowser.tsx:103-115 if (open) setSearch(v) else onChange(v) ('Direct typing mode'); :117-126 Enter commits only when `multiple`
  - TagBrowser.tsx:58-67 outside mousedown -> setOpen(false); setSearch('') (typed text dropped, onChange never called)
  - TagBrowser.tsx:168 'Select a target device first' when deviceId is null
  - widget-configs/EquipmentConfig.tsx:86-95 the Tag field is a TagBrowser writing onChange({ tagName })
  - RAN scratchpad/editdel/tag-test.tsx: no device, device with tags, and device + Enter all give onChange calls = [] and stored value = old_tag after typing 'tank_level_1' and clicking the canvas; the field shows "" on focus
  - (verifier) writer side: web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:90-95 (TagBrowser value=config.tagName, onChange({tagName}))
  - (verifier) component: web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:58-67, 103-115, 117-126, 165-170, 234-236
  - (verifier) store side: pages/scada/usePropertiesPanelHandlers.ts:88-101 (onChange would merge correctly if it were ever called)
  - (verifier) grep '<TagBrowser': 30 component files outside TagBrowser.tsx
  - (verifier) RAN (rebuilt against HEAD) /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/verify-edit/tag-test.cjs: no device / device / device+Enter -> onChange calls = [], stored value = old_tag, field shows "" on focus
  - Verifier: No other code path commits typed text: there is no onBlur and no form submit, and the chevron toggle only flips open. With a device that has ioConfig rows, picking from the list works, so the feature is usable but misleading. The no-device impact (HIGH) is already carried by LINK-05, so MEDIUM is the right standalone grade.
- **LINK-V-03** (BIND-verifier; verdict SELF; severity LOW): The add-channel form accepts tag names up to 64 characters, but the column and the TagRef grammar allow only 50
  - Claim: EdgeDeviceDetailPage validates new channel names with /^[A-Z][A-Z0-9_]{1,63}$/ and tells the user 'maks 64 karakter'. AddIoConfigInput.tagName has only @IsString with no length limit, device_io_configs.tag_name is varchar(50), and TAG_REF_LOCAL_NAME_PATTERN allows 1-50 characters. A 51-64 character name passes the UI and then fails at the database insert, and such a name could never be promoted to a TagRef.
  - web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:398 (TAG_NAME_REGEX {1,63}), 561 (validation), 635-638 (pattern + 'maks 64 karakter' hint)
  - apps/sensor-service/src/edge-device/dto/edge-device.dto.ts:134-138 (AddIoConfigInput.tagName @IsString only)
  - apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts:155 (tag_name character varying(50)); entities/device-io-config.entity.ts:79-80 (length 50)
  - libs/sensor-contracts/src/tag-ref.ts:35 (local name max 50)

</details>

### EDGE-HIGH-080

**Edge HMI writes to Modbus tags always go to the first configured Modbus device, ignoring the tag's slave_id**

- Severity: HIGH · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** The SCADA command executor handles ProtocolConfig::Modbus { register, .. } by taking s.config.modbus.first(). The tag's slave_id is ignored, so coils and registers are written to the wrong field device on any site with more than one Modbus slave. The MQTT set_output path resolves the device by slave_id correctly.

**What the user sees.** On a multi-device Modbus installation, switching a pump or VFD from the device HMI actuates a register or coil on a different device, or appears to do nothing.

**Root cause.** The HMI executor duplicated write logic instead of reusing the slave-aware set_output path.

**Fix direction.** Route HMI writes through the same tag→device resolver as cmd_set_output. Add a test with two slaves.

**Evidence (canonical citations).**

- `sens-api-gateway/src/main.rs:5656-5679`
- `sens-api-gateway/src/process_image.rs:188-193`
- `sens-api-gateway/src/commands/io_config.rs:186-209`
- `sens-api-gateway/src/config.rs:218`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-08** (DEP; verdict CONFIRMED; severity HIGH): Edge HMI writes to Modbus tags always go to the FIRST configured Modbus device, ignoring the tag's slave_id
  - sens-api-gateway/src/main.rs:5656-5679 (ProtocolConfig::Modbus { register, .. } → s.config.modbus.first())
  - sens-api-gateway/src/process_image.rs:188-193 (Modbus config carries slave_id)
  - sens-api-gateway/src/commands/io_config.rs:186-209 (correct pattern: .find(\|d\| d.slave_id == \*slave_id))
  - (verifier) sens-api-gateway/src/main.rs:5656-5679 (ProtocolConfig::Modbus { register, .. } → s.config.modbus.first(); write_coil/write_register on that device's name)
  - (verifier) sens-api-gateway/src/process_image.rs:188-193 (Modbus { slave_id, register, function, register_type })
  - (verifier) sens-api-gateway/src/commands/io_config.rs:186-209 (cmd_set_output resolves .find(\|d\| d.slave_id == \*slave_id))
  - (verifier) sens-api-gateway/src/config.rs:218 (modbus: Vec<ModbusDeviceConfig>)
  - Verifier: The executor ignores slave_id, and no other HMI write path exists (WS command → cmd_tx → this executor). On multi-slave sites the wrong field device is actuated, which is a safety hazard. It becomes reachable once EDGE-01 and DEP-01 are fixed.

</details>

### EDGE-HIGH-082

**Edge HMI renders only with internet access: React, ReactFlow and Recharts load from CDNs and the offline service worker can never install**

- Severity: HIGH · Domain: EDGE · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** scada-edge.html loads react, react-dom, react-is, prop-types, reactflow (JS and CSS) and recharts from unpkg.com and cdn.jsdelivr.net. The service worker precache list names /libs/vendor/\*.js and .css and its comment claims 'All third-party libraries are vendored into /libs/ during the build'. In fact static/ holds only scada-edge.html and aquaculture-nodes.umd.js, and the router serves only /libs/aquaculture-nodes.umd.js. cache.addAll() rejects on the 404s, so the service worker install fails and nothing is cached.

**What the user sees.** When the farm uplink is down or the OT LAN has no internet, opening or reloading http://<device>:6526/scada shows a blank page, even though the agent and its WebSocket are healthy.

**Root cause.** The vendoring step was never implemented, and the HTML still points at CDNs.

**Fix direction.** Bundle the HMI and its dependencies into the binary (include_bytes) and serve them same-origin. Generate the precache list from the actual routes. Add a CI check that every PRECACHE_URL returns 200 from the router.

**Evidence (canonical citations).**

- `sens-api-gateway/static/scada-edge.html:16-24`
- `sens-api-gateway/src/scada_server.rs:128-145`
- `web/modules/sensor-module/public/libs/aquaculture-nodes.umd.js`
- `sens-api-gateway/static/scada-edge.html`
- `sens-api-gateway/static/scada-edge.html:6`
- `sens-api-gateway/src/scada_server.rs:65,74`
- `sens-api-gateway/build.rs`
- `sens-api-gateway/static/scada-edge.html:1825-1826`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-03** (DEP; verdict CONFIRMED; severity HIGH): The edge HMI renders only with internet access: React, ReactFlow and Recharts come from CDNs, and the 'offline' service worker can never install
  - sens-api-gateway/static/scada-edge.html:16-24 (CDN script and link tags)
  - sens-api-gateway/src/scada_server.rs:128-145 (PRECACHE_URLS + vendoring claim), 2236-2255 (router: no /libs/vendor route; only /libs/aquaculture-nodes.umd.js at 2242)
  - ls sens-api-gateway/static → aquaculture-nodes.umd.js, scada-edge.html only; grep 'libs/vendor' → only the SW string literal
  - (verifier) sens-api-gateway/static/scada-edge.html:6 (CSP whitelists unpkg/jsdelivr), 16-24 (react@18, react-dom@18, react-is@18, prop-types@15, reactflow@11.11.4 js+css, recharts@2 from CDNs)
  - (verifier) sens-api-gateway/src/scada_server.rs:65,74 (only the HTML and aquaculture-nodes.umd.js are embedded), 128-145 (PRECACHE_URLS list /libs/vendor/\* + the false vendoring comment), 2232-2248 (router: no /libs/vendor route, no ServeDir/fallback)
  - (verifier) ls sens-api-gateway/static → aquaculture-nodes.umd.js, scada-edge.html; repo-wide grep 'libs/vendor' → only the SW literal; build.rs only builds the SX1302 HAL
  - (verifier) scada-edge.html:1825-1826 (SW registered); cache.addAll rejects on any 404, so install fails
  - Verifier: I looked for a vendoring step (build.rs, the vendor/ dir, workflows), a static file server, and HTML rewriting in scada_page_handler (which only injects nonces). None exists. Because semver-range CDN URLs are redirects, the browser HTTP cache cannot reliably cover an offline reload either. A device whose OT LAN has no internet, or whose uplink drops, gets a blank HMI.

</details>

### EDGE-MEDIUM-083

**Edge HMI funnels all WebSocket traffic through one lastMessage state with a no-op re-render scheduler: values render one message late and bursts can drop**

- Severity: MEDIUM · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** useScadaWebSocket stores only the latest parsed frame (setLastMessage). An effect then applies it to module-level stores. The re-render that the frame triggers happens BEFORE the effect mutates tagStore, and scheduledTagUpdate is a self-recursive no-op (setAllTags is never called). Widgets therefore always show the state as of the previous frame. Two frames handled before React flushes are batched by React 18 createRoot, so only the last frame's effect runs. On connect the agent sends setPackage, allTags, every active alarm and emergency back-to-back, so setPackage or alarms can be lost until the next reconnect. The one-frame lag and the no-op scheduler are verified; the burst drop is the suspected part.

**What the user sees.** Device values lag one poll cycle behind reality. Sometimes after opening the HMI it shows the generic tag dashboard instead of the deployed screens, or misses active alarms, until a reload.

**Root cause.** A message stream modelled as a single React state slot.

**Fix direction.** Handle frames directly in onmessage (a reducer or external store with useSyncExternalStore). Never derive the stream from one state value.

**Evidence (canonical citations).**

- `sens-api-gateway/static/scada-edge.html:481-526`
- `sens-api-gateway/static/scada-edge.html:1588-1597`
- `sens-api-gateway/src/scada_server.rs:1219-1291`
- `sens-api-gateway/static/scada-edge.html:16-17`
- `sens-api-gateway/static/scada-edge.html:1586-1597`
- `sens-api-gateway/src/io_poll.rs:451-471`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-15** (DEP; verdict CONFIRMED; severity MEDIUM): The edge HMI funnels all WebSocket traffic through one 'lastMessage' state and a no-op re-render scheduler: values render one message late, and bursts can drop messages
  - sens-api-gateway/static/scada-edge.html:481-526 (single lastMessage state; onmessage → setLastMessage)
  - sens-api-gateway/static/scada-edge.html:1588-1597 (scheduledTagUpdate recursion), 1569 (setAllTags never called; grep), 1622-1742 (effect on [lastMessage] mutates tagStore/activeAlarms)
  - sens-api-gateway/src/scada_server.rs:1219-1291 (four kinds of frames sent back-to-back on connect)
  - sens-api-gateway/static/scada-edge.html:16-17 (react@18 / createRoot → automatic batching)
  - (verifier) sens-api-gateway/static/scada-edge.html:481-526 (single lastMessage useState; onmessage → setLastMessage)
  - (verifier) sens-api-gateway/static/scada-edge.html:1586-1597 (scheduledTagUpdate recurses, never calls setAllTags; grep setAllTags → declaration only), 1622-1742 (useEffect [lastMessage] mutates module-level tagStore after the render that read it)
  - (verifier) sens-api-gateway/src/io_poll.rs:451-471 (with a package and no process, one allTags frame per cycle, followed by an 'alarm' frame when one triggers)
  - (verifier) sens-api-gateway/src/scada_server.rs:1219-1291 (setPackage, allTags, alarms, emergency sent back-to-back on connect)
  - Verifier: The one-frame lag is verified. Widgets render from tagStore during the render that the frame triggers, the effect then mutates it, and nothing re-renders. With a deployed package and no legacy process there is one allTags frame per cycle, so values lag one full poll cycle. I could not prove the burst drop without a browser. It depends on whether several WebSocket message tasks run before React's scheduler task. If they do, React 18 batches them and only the last frame's effect runs. A dropped 'alarm' frame would be lost until reconnect, because it is broadcast only once. That part stays suspected, as the auditor said.

</details>

### EDGE-MEDIUM-085

**Edge calibration never works end to end: the engine receives no sensor reading or reference values and the builder writes sensors as strings where the edge HMI expects objects**

- Severity: MEDIUM · Domain: EDGE · Plan phase: F6 · Deadline: 2027-04-19
- Verification: SELF 2
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** CalibrationEngine::tick(tag, raw) is the only code that feeds readings into a calibration session and the only producer of stable:true. Nothing in sens-api-gateway calls it: io_poll, scada_server and main.rs never do. confirm_point averages session.readings, so it always returns Err('No readings collected'). handle_calibrate's 'start' ignores the widget config and hard-codes a two-point session with reference_value None for both points. confirm_point then falls back to reference = raw (unwrap_or(raw)), so a completed two-point calibration would yield slope = 1, offset = 0, an identity fit reported as R² = 1. calculate() only logs a CalibrationRecord to SQLite. ScadaDb::get_latest_calibration has no caller, so no calibration result is ever applied to process-image scaling. This sits behind CALIB-EDGE-01 (the wizard cannot start because config.sensors are strings) and DEP-17 ('confirm_point' vs 'confirm'), and remains after both are fixed.

**What the user sees.** On the device calibration screen, once a session starts, the stability bar never moves and the 'Onayla' (confirm) button never appears. If a session were ever forced to complete, it would report 'Kalibrasyon Tamamlandi' (calibration complete) with slope 1.000000 and offset 0.000000, and sensor readings would stay exactly as before.

**Root cause.** The calibration engine was built as a library (session state machine plus regression), but it was never wired to the I/O poll loop, the package calibration config, or the scaling pipeline.

**Fix direction.** Feed every active session from io_poll with the raw (unscaled) value of its tag. Drive start() from the package's calibration config, including per-point reference values entered on the HMI. Apply the accepted slope/offset to the tag's scaling, both persisted and loaded at startup through get_latest_calibration. Add an integration test: start → ticks → confirm ×2 → scaled value changes.

**Evidence (canonical citations).**

- `sens-api-gateway/src/calibration_engine.rs:197-246`
- `sens-api-gateway/src/calibration_engine.rs:249-275`
- `sens-api-gateway/src/scada_server.rs:1765-1789`
- `sens-api-gateway/src/calibration_engine.rs:320-345`
- `sens-api-gateway/src/scada_db.rs:542-545`
- `sens-api-gateway/static/scada-edge.html:1195`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/CalibrationWizardConfig.tsx:12-24`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/CalibrationStatusConfig.tsx:12-25`
- `sens-api-gateway/static/scada-edge.html:1147-1160`
- `sens-api-gateway/src/scada_types.rs:338-343`
- `sens-api-gateway/src/scada_server.rs:1354-1365`
- `sens-api-gateway/static/scada-edge.html:1623-1720`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-V-01** (DEP-verifier; verdict SELF; severity MEDIUM): The edge calibration engine never receives a sensor reading, uses no reference values, and its results are never applied, so device calibration cannot work even after the protocol fixes
  - sens-api-gateway/src/calibration_engine.rs:197-246 (tick: pushes readings, computes stable); grep '.tick(' in sens-api-gateway/src and tests → only tokio interval ticks, no CalibrationEngine caller
  - sens-api-gateway/src/calibration_engine.rs:249-275 (confirm_point: 'No readings collected' when readings empty; reference unwrap_or(raw))
  - sens-api-gateway/src/scada_server.rs:1765-1789 (start: sensor_type 'unknown', two points with reference_value None, ignores package/widget config)
  - sens-api-gateway/src/calibration_engine.rs:320-345 (two-point slope/offset from reference vs raw), 422-458 (result only inserted as a log record)
  - sens-api-gateway/src/scada_db.rs:542-545 (get_latest_calibration); grep get_latest_calibration → no caller
  - sens-api-gateway/static/scada-edge.html:1195 (confirm button only rendered when calibState.stable)
- **CALIB-EDGE-01** (OPS-verifier; verdict SELF; severity MEDIUM): Calibration widgets: the builder writes sensors as tag-name strings, the edge HMI expects sensor objects, so the device calibration wizard is unusable
  - Claim: CalibrationWizardConfig and CalibrationStatusConfig store config.sensors as string[] (TagBrowser values). The edge HMI CalibWizardWidget and CalibStatusWidget treat each entry as an object {tag, sensorType, points, method, lastCalibration, nextCalibration}. For a string, s.tag is undefined: the wizard buttons read 'undefined (undefined)', and pressing one sets calibState and sends {type:'calibrate', action:'start'} without a tag. Rust WsClientMessage::Calibrate requires tag:String, so the frame is rejected as an 'error' message that the HMI ignores, and the wizard sits in 'starting' forever. CalibStatus rows show no name and '--'. calibrationWizard and calibrationStatus are among the 16 edge-shippable types.
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/CalibrationWizardConfig.tsx:12-24 and CalibrationStatusConfig.tsx:12-25 (sensors: string[])
  - sens-api-gateway/static/scada-edge.html:1147-1160 (sensors.map(s => s.tag, s.sensorType, s.points, s.method); send calibrate with tag: s.tag), 1228-1245 (status rows use s.tag/s.sensorType/s.lastCalibration)
  - sens-api-gateway/src/scada_types.rs:338-343 (Calibrate { tag: String, action, point_index }); src/scada_server.rs:1354-1365 (parse error → {type:'error'}); scada-edge.html:1623-1720 (no 'error' handler)

</details>

### EDGE-LOW-084

**Securing the edge HMI for LAN use locks the HMI page out, and hostname URLs are rejected**

- Severity: LOW · Domain: EDGE · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 1
- Rule: One tag identity (libs/sensor-contracts TagRef) across builder, cloud runtime and edge

**Claim.** When SUDERRA_SCADA_AUTH_TOKEN is set (the documented hardening for OT-NIC exposure), the WS upgrade requires an Authorization: Bearer header. The browser WebSocket API cannot send headers, and scada-edge.html opens new WebSocket(url) with no token, so the HMI can never connect. The Origin check accepts only 'localhost' or RFC1918 IPv4 literals, so http://edge-01.local:6526 or any DNS name is refused. The default bind is 127.0.0.1, so a tablet on the farm LAN cannot reach the HMI without env changes.

**What the user sees.** With the auth token enabled, the HMI page loads but sits on 'Baglaniyor…' (Connecting…) and then 'Basarisiz' (Failed). Opened via a hostname, the WebSocket is refused (403). From a LAN tablet with the default config, the connection is refused.

**Root cause.** The auth mechanism is incompatible with a browser client, and the origin check is IP-literal only.

**Fix direction.** Use a token in the query string or the Sec-WebSocket-Protocol header, or session-cookie auth issued by /scada. Validate the Origin against the configured bind host and name.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scada_server.rs:1091-1121`
- `sens-api-gateway/static/scada-edge.html:504`
- `sens-api-gateway/src/scada_server.rs:1100-1121`
- `sens-api-gateway/src/scada_server.rs`

<details><summary>Merged audit findings and full evidence</summary>

- **DEP-19** (DEP; verdict CONFIRMED; severity LOW): Securing the HMI for LAN use locks the HMI page out, and hostname URLs are rejected
  - sens-api-gateway/src/scada_server.rs:1091-1121 (Bearer header required when the token is set), 719-743 (origin host must be localhost or an RFC1918 IP literal), 2287-2292 (default bind 127.0.0.1)
  - sens-api-gateway/static/scada-edge.html:504 (new WebSocket(url), no credentials)
  - (verifier) sens-api-gateway/src/scada_server.rs:1100-1121 (Authorization: Bearer required when SUDERRA_SCADA_AUTH_TOKEN is set), 1073-1090 (Origin required, must pass is_private_network_origin), 719-743 (localhost or RFC1918/127 IPv4 literal only), 2276-2280 (default bind 127.0.0.1)
  - (verifier) sens-api-gateway/static/scada-edge.html:504 (new WebSocket(url) — browsers cannot set Authorization)
  - (verifier) repo-wide grep SUDERRA_SCADA_AUTH_TOKEN\|SUDERRA_SCADA_BIND: only scada_server.rs (no installer/systemd/doc sets them)
  - Verifier: Verified. Both env vars are unset by default, so the default install serves only the on-device kiosk on loopback, which works. LAN tablets need manual env changes, and turning on the token hardening locks the HMI out. LOW.

</details>

## D. Runtime rendering parity

### SENSOR-CRITICAL-290

**Cloud operator runtime renders no widgets: the OperatorView registry is never populated, every widget is a "?" box, laid out on a 40x40 grid instead of the builder's 120x100**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 4
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds as stated. Every widget renders through FallbackWidget. That component prints config.widgetType, which is always undefined because widgetType lives on the widget and not in config, so every box shows '?'. Duplicates CONN-02, PLACE-01 and CONN-15.

**What the user sees.** At /sensor/scada/operator/<id> every widget is a grey dashed box with '?' (config.widgetType is undefined). No values, no buttons, no pipes. No button in the app leads to this page. If widgets were registered, they would draw at one third of their width and 40% of their height, overlapping each other.

**Root cause.** The runtime registry pattern was scaffolded but never wired. Self-registration on import was planned, but no widget module calls it. OperatorView also duplicates grid constants instead of importing them.

**Fix direction.** Delete the empty registry. Have OperatorView dispatch through RuntimeWidgetRenderer, or straight to WidgetRenderer with isEditing=false, for every ScadaWidgetType. Add an invariant test asserting every palette type resolves in the operator dispatcher. Import GRID_CELL_W/H from constants/scada-widget-sizes. Add an 'Open operator view' link on the package list and in the builder.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:110-117`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:219-246`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx`
- `web/modules/sensor-module/src/components/scada-operator/index.ts:25`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:77-91`
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeWidgetRenderer.tsx:289-447`
- `web/modules/sensor-module/src/Module.tsx:153`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:156,224,235`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:51-52`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-15`
- `web/modules/sensor-module/src/components/scada-operator/widgets/index.ts:17`
- `web/shell/src/console/nav/pages/sensor.ts:67`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:15,130-133`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:112`
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeWidgetRenderer.tsx`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:161-164`
- `web/modules/sensor-module/src/types/scada-package.types.ts:17-21`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:84-85`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:104-116,219`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:219`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:300-304`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:85`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:156-166`
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeWidgetRenderer.tsx:256-269`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:110`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:164`
- `libs/sensor-contracts/src/index.ts`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:270,288`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:186-189`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:22`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:248-257`

<details><summary>Merged audit findings and full evidence</summary>

- **OPS-01** (OPS; verdict CONFIRMED; severity BLOCKER): Browser operator runtime renders zero widgets: the OperatorView widget registry is never populated
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:110-117 (WIDGET_REGISTRY + registerOperatorWidget)
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:219-246 (registry lookup, FallbackWidget otherwise)
  - grep: registerOperatorWidget is referenced only in OperatorView.tsx and components/scada-operator/index.ts:25 (re-export); zero call sites anywhere in web/
  - web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:77-91 (mounts OperatorBootstrap/OperatorShell/OperatorView)
  - web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeWidgetRenderer.tsx:289-447 (exported only via widgets/index.ts:17, never imported)
  - web/modules/sensor-module/src/Module.tsx:153 (route scada/operator/:packageId); pages/scada/ScadaPackageListPage.tsx:156,224,235 link only to /sensor/scada-builder
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:51-52 hardcodes 40x40 px cells, but constants/scada-widget-sizes.ts:14-15 uses GRID_CELL_W=120 / GRID_CELL_H=100
  - (verifier) web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:110-117 (empty Map + registerOperatorWidget); :219 WIDGET_REGISTRY.get(widgetType); :155-167 FallbackWidget shows String(config.widgetType ?? '?')
  - (verifier) grep over web/: registerOperatorWidget appears only in OperatorView.tsx and the re-export at components/scada-operator/index.ts:25; zero call sites
  - (verifier) grep: RuntimeWidgetRenderer is exported only from components/scada-operator/widgets/index.ts:17; nothing imports it
  - (verifier) OperatorView.tsx:51-52 GRID_CELL_W/H=40 vs constants/scada-widget-sizes.ts:14-15 (120/100)
  - (verifier) pages/scada/ScadaOperatorPage.tsx:77-91 mounts OperatorView; Module.tsx:153 route; the only other reference to the path is web/shell/src/console/nav/pages/sensor.ts:67, a nav-highlight matchPaths entry, not a link
  - Verifier: I looked for any registration path the auditor might have missed: self-registering modules, side-effect imports and a mapper in OperatorShell. There are none. OperatorView itself renders no RuntimeWidgetRenderer. The route exists, but no Link or navigate() targets it.
- **PLACE-01** (PLACE; verdict CONFIRMED; severity BLOCKER): Operator runtime draws every widget as a '?' placeholder box, on a 40x40 px grid instead of the builder's 120x100 px grid
  - Claim: OperatorView looks every widget up in WIDGET_REGISTRY. Nothing in web/ ever calls registerOperatorWidget, so every widget renders as FallbackWidget. That box prints config.widgetType, which is always undefined because widgetType is a top-level ScreenWidget field and loadFromJSON never copies it into config, so every box reads '?'. Geometry uses local 40x40 px cells instead of the builder's 120x100, so x shrinks to 1/3 and y to 0.4. This duplicates OPS-01, CONN-02 and CONN-15.
  - components/scada-operator/OperatorView.tsx:51-52 GRID_CELL_W = 40; GRID_CELL_H = 40 (the comment at L22 wrongly claims these match the builder)
  - constants/scada-widget-sizes.ts:14-15 the builder uses GRID_CELL_W = 120, GRID_CELL_H = 100; engine/views/ScadaViewport.tsx:15,130-133 uses 120x100
  - components/scada-operator/OperatorView.tsx:110-117 WIDGET_REGISTRY and registerOperatorWidget; L219 WIDGET_REGISTRY.get(widgetType); L244-245 FallbackWidget
  - grep for 'registerOperatorWidget(' across src finds only its definition (OperatorView.tsx:112). RuntimeWidgetRenderer (widgets/RuntimeWidgetRenderer.tsx) is exported but OperatorView never uses it
  - components/scada-operator/OperatorView.tsx:161-164 renders String(config.widgetType ?? '?'), but types/scada-package.types.ts:17-21 puts widgetType on ScreenWidget, not in config
  - pages/scada/ScadaOperatorPage.tsx:84-85 mounts <OperatorView screen={activeScreen}/>; Module.tsx:153 routes scada/operator/:packageId to it
  - (verifier) components/scada-operator/OperatorView.tsx:51-52 GRID_CELL_W/H = 40, with the comment at L22 claiming '40x40 px cells' match the builder
  - (verifier) constants/scada-widget-sizes.ts:14-15 GRID_CELL_W=120, GRID_CELL_H=100
  - (verifier) grep 'registerOperatorWidget\|WIDGET_REGISTRY' across web/ finds only OperatorView.tsx:104-116,219 and the re-export in components/scada-operator/index.ts:25; no caller
  - (verifier) OperatorView.tsx:219 WIDGET_REGISTRY.get(widgetType) -> L245 FallbackWidget -> L164 String(config.widgetType ?? '?')
  - (verifier) store/scada/projectSlice.ts:300-304 loadFromJSON puts widgetType top-level and config is w.config verbatim; types/scada-package.types.ts:17-21
  - (verifier) pages/scada/ScadaOperatorPage.tsx:85 <OperatorView screen={activeScreen}/>; Module.tsx:153 route scada/operator/:packageId
  - Verifier: I read both sides: the registry writer has no caller, and the reader falls back on every type. There is no side-effect import that registers widgets: components/scada-operator/widgets/index.ts only re-exports RuntimeWidgetRenderer, and nothing imports it. Nothing maps widgetType into config. The routed operator runtime therefore cannot show any process.
- **CONN-02** (CONN; verdict CONFIRMED; severity BLOCKER): Operator widget registry is never populated, so equipment renders as '?' boxes
  - Claim: Confirmed. WIDGET_REGISTRY is an empty Map. registerOperatorWidget is defined (OperatorView.tsx:112) and re-exported (scada-operator/index.ts:25) but never called. Every widget therefore renders FallbackWidget, which shows String(config.widgetType ?? '?'). No config carries widgetType, so the label is '?'. The fallback has no handlers, so nothing in the operator view can be controlled. Duplicate of OPS-01 and PLACE-01.
  - components/scada-operator/OperatorView.tsx:110-117 defines WIDGET_REGISTRY plus registerOperatorWidget
  - components/scada-operator/OperatorView.tsx:219 `WIDGET_REGISTRY.get(widgetType)`, else :245 <FallbackWidget>
  - components/scada-operator/OperatorView.tsx:156-166 FallbackWidget shows `String(config.widgetType ?? '?')`. widgetType is a top-level field, not part of config, so it shows '?'
  - grep `registerOperatorWidget(`: the only hit is the definition at OperatorView.tsx:112. components/scada-operator/widgets/RuntimeWidgetRenderer.tsx:256-269 handles only runtime\* types and is not used by OperatorView
  - (verifier) components/scada-operator/OperatorView.tsx:110 `const WIDGET_REGISTRY = new Map()`; :112-117 registerOperatorWidget; :219 WIDGET_REGISTRY.get(widgetType); :245 <FallbackWidget>
  - (verifier) OperatorView.tsx:164 `String(config.widgetType ?? '?')`; grep 'config.widgetType' finds only OperatorView.tsx:161-164 and no writer
  - (verifier) grep 'registerOperatorWidget(' across src finds only the definition and an index.ts comment and re-export
  - (verifier) RuntimeWidgetRenderer is not imported by OperatorView (imports at :25-45)
  - Verifier: There is no side-effect import, bootstrap call or index barrel that populates the registry. OperatorBootstrap only wraps data providers. The claim holds on both sides.
- **CONN-15** (CONN; verdict CONFIRMED; severity HIGH): Operator uses a 40x40 grid while the builder uses 120x100, so positions and sizes differ
  - Claim: Confirmed. OperatorView hard-codes 40x40 px cells (the comment at :22 wrongly claims they match the builder), while the builder, and all stored edge geometry, uses the 120x100 cells from constants/scada-widget-sizes. Once CONN-02 is fixed, every operator widget would be drawn at 1/3 the width and 2/5 the height, with a different aspect ratio. Duplicate of the geometry half of PLACE-01.
  - components/scada-operator/OperatorView.tsx:51-52 `GRID_CELL_W = 40; GRID_CELL_H = 40`, with a comment at :22 claiming they match the builder
  - constants/scada-widget-sizes.ts:14-15 `GRID_CELL_W = 120; GRID_CELL_H = 100` used by ScreenCanvas gridToPixel (ScreenCanvas.tsx:270,288)
  - OperatorView.tsx:186-189 px/py/pw/ph computed with the local constants
  - (verifier) components/scada-operator/OperatorView.tsx:22 comment '40×40 px cells'; :51-52 GRID_CELL_W = 40, GRID_CELL_H = 40; :186-189 and :320-321 use them
  - (verifier) constants/scada-widget-sizes.ts:14-15 GRID_CELL_W = 120, GRID_CELL_H = 100; used by ScreenCanvas gridToPixel and onDrop snapping (ScreenCanvas.tsx:248-257, 845-846)
  - Verifier: Both constants were read. There is no shared import or override. This is a layout defect across the whole runtime that survives the registry fix, so it stays HIGH.

</details>

### SENSOR-CRITICAL-291

**Pipes, background image, hidden flag, z-order and transforms exist only in the builder canvas: no runtime (cloud operator, popups, edge HMI) renders screen.edges or applies them**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 4, PARTIAL 3
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** No runtime draws screen.edges. OperatorView (L343-351) and ScadaViewport (L116) map widgets only. On the device the edges never arrive: the Rust Screen struct has no edges field, so serde drops them, and the HMI ScreenRenderer maps widgets only. The equipment symptom on the device is wrong, though. A package that contains any 'equipment' widget is rejected at the cloud publish boundary (EDGE_REJECTED_WIDGET_TYPES includes 'equipment', and transformScadaDocForEdgeDeploy returns ok:false), so the user gets a deploy error (EDGE-02), not 'Bilinmeyen widget: equipment' on the device. The WidgetRouter does lack an equipment branch, but builder equipment cannot reach it. The edge HMI does contain a React-Flow node+edge renderer with an 'equipment' node type, but only inside the processView widget (config.nodes/config.edges, legacy process-editor format). The SCADA builder never produces that format, so it could serve as a reuse base.

**What the user sees.** In the builder the pumps, valves and pipes are connected. In the operator view and on the edge-device HMI, the pipes are gone, and on the device each equipment symbol is replaced by the text 'Bilinmeyen widget: equipment'.

**Root cause.** The edge (pipe) model exists only in the builder's React Flow canvas. The runtime renderers were written against the widget list alone.

**Fix direction.** Introduce one shared screen renderer (widgets plus edges, using the same geometry functions) that the operator, ScadaViewport and edge HMI bundle all consume. Add an 'equipment' route on the edge, or ship the shared symbol bundle there. Add a contract test that every widgetType and the edge layer render in every runtime.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:343-351`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:116`
- `sens-api-gateway/static/scada-edge.html:1404-1432`
- `sens-api-gateway/static/scada-edge.html:1377-1398`
- `sens-api-gateway/src/scada_server.rs:65`
- `sens-api-gateway/src/../static/scada-edge.html`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:260`
- `sens-api-gateway/src/scada_types.rs:56-70`
- `sens-api-gateway/src/scada_server.rs:269`
- `libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:57-65`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-117`
- `sens-api-gateway/static/scada-edge.html:611-620`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:314-331`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:36-39`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:35-40`
- `web/modules/sensor-module/src/pages/SensorScadaPage.tsx`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:239-265`
- `sens-api-gateway/static/scada-edge.html:1404-1431`
- `sens-api-gateway/static/scada-edge.html:1256-1290`
- `libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:58-66`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-118`
- `apps/sensor-service/src/process/services/scada-package.service.ts:886-907`
- `sens-api-gateway/src/scada_types.rs:58-70`
- `sens-api-gateway/src/scada_server.rs:1219-1228`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:252-264`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:116-157`
- `web/modules/sensor-module/src/types/scada-package.types.ts:28-29`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:327,340`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:190-285`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:41-46`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:33-46`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:269`
- `web/modules/sensor-module/src/components/scada-builder/LayersPanel.tsx:126-132`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:181-249`
- `sens-api-gateway/static/scada-edge.html:1420`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:254`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:181-249,343`
- `sens-api-gateway/src/scada_types.rs:102-110`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SvgShapeConfig.tsx:56-63`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:250-252`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:135-155`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:221-247`
- `sens-api-gateway/static/scada-edge.html:1421-1431`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:250-252,474-475`
- `web/modules/sensor-module/src/types/scada-transform.types.ts:38`
- `libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:26-47`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:995-1010`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1024-1033`

<details><summary>Merged audit findings and full evidence</summary>

- **PLACE-02** (PLACE; verdict PARTIAL; severity BLOCKER): Pipes (screen.edges) drawn in the builder appear in no runtime renderer, and the edge HMI cannot render 'equipment' widgets
  - components/scada-operator/OperatorView.tsx:343-351 maps screen.widgets only; grep for 'edges' in components/scada-operator/_.tsx and engine/views/_.tsx returns nothing
  - engine/views/ScadaViewport.tsx:116 maps screen.widgets only
  - sens-api-gateway/static/scada-edge.html:1404-1432 ScreenRenderer maps screen.widgets into CSS-grid cells, with no edge layer
  - sens-api-gateway/static/scada-edge.html:1377-1398 WidgetRouter has no 'equipment' case and falls back to 'Bilinmeyen widget: ' + t
  - sens-api-gateway/src/scada_server.rs:65 include_str!("../static/scada-edge.html") is the page served on the device
  - writer side: store/scada/projectSlice.ts toScadaPackageJSON emits '...(s.edges.length > 0 ? { edges: s.edges } : {})' for each screen
  - (verifier) components/scada-operator/OperatorView.tsx:343-351 screen.widgets.map only; engine/views/ScadaViewport.tsx:116 screen.widgets.map only
  - (verifier) writer: store/scada/projectSlice.ts:260 '...(s.edges.length > 0 ? { edges: s.edges } : {})'
  - (verifier) sens-api-gateway/src/scada_types.rs:56-70 struct Screen {id,name,screen_type,is_default,icon,layout,widgets}, with no edges field; scada_server.rs:269 stores the typed ScadaPackage and re-serializes it with serde_json::to_string
  - (verifier) sens-api-gateway/static/scada-edge.html:1404-1432 ScreenRenderer maps widgets only; L1377-1398 WidgetRouter has no 'equipment' case
  - (verifier) libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:57-65 'equipment' is in EDGE_REJECTED_WIDGET_TYPES; edge-deploy-transform.ts:96-117 reject -> {ok:false}, so the whole doc is refused
  - (verifier) sens-api-gateway/static/scada-edge.html:611-620 nodeTypes.equipment = createScadaNode(AQ.EquipmentNode); L1254-1289 ProcessViewWidget renders config.nodes/config.edges via ReactFlow
  - Verifier: The core defect holds and stays a BLOCKER: a P&ID drawn in the builder shows no pipes in any runtime, and the Rust contract cannot even carry them. The user symptom for the device is wrong, because the cloud transform refuses equipment before deploy. That is EDGE-02, already reported. The processView edge renderer is a counter-observation worth recording: an edge-side node+edge renderer already exists and could be reused.
- **CONN-01** (CONN; verdict CONFIRMED; severity BLOCKER): Operator runtime never draws pipes/connections
  - Claim: Confirmed as stated. OperatorView (the only renderer mounted by /sensor/scada/operator/:packageId) iterates screen.widgets only and has no edge layer. The other runtimes behave the same way: engine/views/ScadaViewport.tsx, the edge HMI, and the device-side Rust Screen struct, which drops edges during deserialization. Pipes are therefore visible only inside the builder's own ScreenCanvas (Edit and Preview). This duplicates PLACE-02 and EDGE-03.
  - writer: store/scada/projectSlice.ts:260 toScadaPackageJSON emits `edges: s.edges` per screen
  - writer: store/scada/projectSlice.ts:314-331 loadFromJSON restores edges with source/target/sourceHandle/targetHandle/type/data
  - reader: pages/scada/ScadaOperatorPage.tsx:36-39 hydrates the store with loadFromJSON, then :85 renders <OperatorView screen={activeScreen}>
  - reader: components/scada-operator/OperatorView.tsx:343-351 maps only `screen.widgets` to <RuntimeWidget>. The file never references screen.edges, ReactFlow or any edge component
  - grep: the only consumers of `.edges` in engine/, hooks/ and components/scada-operator are none. All hits are in builder store slices and ScreenCanvas
  - (verifier) writer: store/scada/projectSlice.ts:260 `...(s.edges.length > 0 ? { edges: s.edges } : {})`; loadFromJSON :314-331 restores edges
  - (verifier) reader: pages/scada/ScadaOperatorPage.tsx:35-40 loadFromJSON, then :85 <OperatorView screen={activeScreen}>
  - (verifier) reader: components/scada-operator/OperatorView.tsx:343-351 maps screen.widgets only. The file has no 'edges' token, and its imports (:25-45) contain no ReactFlow or edge component
  - (verifier) grep 'edges' over components/scada-operator, engine, hooks: the only hits are unrelated (dependencyGraph, useProcess, useSensorReadings)
  - (verifier) pages/SensorScadaPage.tsx (/sensor and /sensor/scada) is the legacy process viewer (scadaViewerStore and process nodes/edges), not a SCADA-package runtime
  - Verifier: I looked for a second reader of screen.edges anywhere in the operator path (another view, a subscriber, a mapper) and found none. Both sides of the seam were read. Pipes are the visual output of the connection feature, and that output fails in every runtime, so BLOCKER stands.
- **CONN-03** (CONN; verdict PARTIAL; severity HIGH): Edge HMI ignores screen.edges and does not know the 'equipment' widget
  - Claim: The reader side holds: the edge HMI ScreenRenderer lays out screen.widgets only, WidgetRouter has no 'equipment' branch, and pipes are drawn only from a processView widget's config.edges. The user symptom is wrong, though. A package that contains any 'equipment' widget never reaches the HMI: the publish-boundary transform classifies 'equipment' as REJECT, and the backend throws BadRequest ('... widget edge runtime'da desteklenmiyor ...'). The user sees a failed deploy, not 'Bilinmeyen widget: equipment' tiles. The 7 process widgets that have ports (mbbr, feeder, cornellDualDrain, ...) are 'strip' class and are silently removed from the payload. Screen edges are dropped a second time on the device, because the Rust Screen struct has no edges field and serde ignores the key. The re-serialized package sent to the HMI over the WebSocket therefore has no edges, and a fixed HMI would still receive none. This overlaps EDGE-02 and EDGE-03.
  - writer: store/scada/projectSlice.ts:239-265 screens carry widgets with widgetType 'equipment' plus `edges`
  - reader: sens-api-gateway/static/scada-edge.html:1404-1431 ScreenRenderer maps only `screen.widgets`
  - reader: scada-edge.html:1377-1398 WidgetRouter handles gauge, numericDisplay, toggleSwitch, ..., processView, pushButton, statusIndicator and tankLevel, and returns 'Bilinmeyen widget: ' + t otherwise (no 'equipment')
  - reader: scada-edge.html:1256-1290 edges are rendered only from `config.edges` of a processView widget
  - (verifier) sens-api-gateway/static/scada-edge.html:1377-1398 WidgetRouter (no 'equipment'; fallback 'Bilinmeyen widget: ' + t); :1404-1431 ScreenRenderer maps screen.widgets only; :1255-1290 ProcessViewWidget reads config.edges
  - (verifier) libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:58-66 EDGE_REJECTED_WIDGET_TYPES includes 'equipment'; :95-99 unknown or other types are 'strip'
  - (verifier) libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-118 rejected -> {ok:false}
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:886-907 transformForEdgeOrThrow throws BadRequestException listing the equipment widgets
  - (verifier) sens-api-gateway/src/scada_types.rs:58-70 `pub struct Screen { id, name, screen_type, is_default, icon, layout, widgets }`, with no edges field
  - (verifier) sens-api-gateway/src/scada_server.rs:1219-1228 sends `setPackage` with the deserialized ScadaPackage struct, so edges are already gone
  - Verifier: I read the HMI reader, the cloud publish transform, the backend deploy path and the Rust deserialization struct. The HMI defect is real. The auditor's chain (deploy, then HMI shows 'unknown equipment') cannot happen because deploy is rejected first, and edges would be lost at the Rust struct even before the HMI. HIGH stays because, on the device, a piped process never shows pipes or equipment.
- **EDGE-03** (OPS; verdict CONFIRMED; severity HIGH): Pipe connections, background image, hidden flag and z-order exist only in the builder
  - Claim: Holds as stated. Duplicates CONN-01, CONN-03, CONN-06, PLACE-02 and PLACE-19.
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:252-264 (edges, visible, zIndex, backgroundImage serialized)
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:343-351 (renders screen.widgets only; no edges, visible, zIndex or background)
  - web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:116-157 (widgets only)
  - sens-api-gateway/src/scada_types.rs:58-70 (Screen has no edges or background), 102-110 (Widget has no visible or zIndex)
  - web/modules/sensor-module/src/types/scada-package.types.ts:28-29 (visible documented as 'hidden on canvas and at runtime')
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:327,340 (flowConfig read); PropertiesPanel.tsx:190-285 (no flow-tag control); store/scada/edgeSlice.ts:41-46 (updateEdgeType drops flowConfig)
  - (verifier) store/scada/projectSlice.ts:252-264 (edges/visible/zIndex/backgroundImage serialized)
  - (verifier) components/scada-operator/OperatorView.tsx:343-351 (maps screen.widgets only; no edges/visible/zIndex/background)
  - (verifier) engine/views/ScadaViewport.tsx:116-157 (widgets only)
  - (verifier) sens-api-gateway/src/scada_types.rs:58-70 (Screen: no edges/background), 102-110 (Widget: no visible/zIndex)
  - (verifier) store/scada/edgeSlice.ts:33-46 (updateEdgeType rebuilds data without flowConfig); grep: flowConfig has no UI writer (only ScreenCanvas.tsx:327,340 readers)
  - Verifier: No runtime draws edges, and the Rust struct drops them silently because serde ignores unknown fields by default.
- **PLACE-19** (PLACE; verdict CONFIRMED; severity MEDIUM): Widgets hidden in the builder are still rendered in every runtime
  - Claim: visible=false is documented as hidden 'on canvas and at runtime'. The builder filters these widgets out, but OperatorView, ScadaViewport and the edge HMI render every widget. On the edge, the Rust Widget struct has no visible field, so the flag is dropped by serde before the HMI sees it. A hidden ship-class control (for example a pushButton or toggleSwitch kept hidden as a draft) is therefore visible and operable on the device. This duplicates part of EDGE-03.
  - types/scada-package.types.ts:28-29 'When false, widget is hidden on canvas and at runtime'
  - builder: components/scada-builder/ScreenCanvas.tsx:269 widgets.filter((w) => w.visible !== false)
  - writers: LayersPanel.tsx:126-132 toggleWidgetVisibility; GeneralPropertiesSection handleVisibleChange; persisted by projectSlice toScadaPackageJSON '...(w.visible != null ? { visible: w.visible } : {})'
  - runtime readers ignore it: components/scada-operator/OperatorView.tsx:181-249 (only the permission check), engine/views/ScadaViewport.tsx:116, sens-api-gateway/static/scada-edge.html:1420
  - (verifier) types/scada-package.types.ts:28-29
  - (verifier) builder: components/scada-builder/ScreenCanvas.tsx:269 filter(w.visible !== false)
  - (verifier) writers: LayersPanel.tsx:126-132 toggleWidgetVisibility; store/scada/projectSlice.ts:254 persists visible
  - (verifier) readers: components/scada-operator/OperatorView.tsx:181-249,343 (permission only); engine/views/ScadaViewport.tsx:116; sens-api-gateway/src/scada_types.rs:102-110 Widget {id, widget_type, position, config}; static/scada-edge.html:1420
  - Verifier: I read both sides. It is a behaviour mismatch with a safety angle (hidden actuators become active on the device), so MEDIUM.
- **PLACE-18** (PLACE; verdict PARTIAL; severity LOW): Widget transforms (rotation, scale, skew) are applied only in the builder canvas
  - Claim: config.transform (rotate/scale/skew) is turned into CSS only by ScadaWidgetNode. ScadaViewport popups and modals render untransformed. In OperatorView the point is moot because every widget is a '?' box (PLACE-01). On the device, the shape, path, image and customSvg widgets that carry TransformConfig are strip-class and are removed from the edge payload entirely. So 'appears unrotated on the device HMI' is wrong: they don't appear at all. No renderer applies config.transform internally.
  - writer: widget-configs/SvgShapeConfig.tsx:56-63 makeTransformOnChange -> onChange({ transform })
  - builder reader: components/scada-builder/nodes/ScadaWidgetNode.tsx:250-252 and 474-475 buildTransformCSS on the container
  - grep 'buildTransformCSS' across src: only ScadaWidgetNode.tsx (plus its definition)
  - engine/views/ScadaViewport.tsx:135-155 wrapper style has left/top/width/height only
  - components/scada-operator/OperatorView.tsx:221-247 wrapper style has left/top/width/height only
  - sens-api-gateway/static/scada-edge.html:1421-1431 grid cell style has no transform
  - (verifier) writer: widget-configs/SvgShapeConfig.tsx:56-63 makeTransformOnChange -> onChange({transform})
  - (verifier) builder reader: components/scada-builder/nodes/ScadaWidgetNode.tsx:250-252,474-475 buildTransformCSS
  - (verifier) grep 'buildTransformCSS': only types/scada-transform.types.ts:38 and ScadaWidgetNode.tsx; grep 'config.transform' in widget-renderers: none
  - (verifier) engine/views/ScadaViewport.tsx:135-155 wrapper left/top/width/height only
  - (verifier) libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:26-47 (svg\*/rasterImage/customSvg are not 'ship', so they are stripped)
  - Verifier: The parity gap is real, but only the overlay views actually show the untransformed content. LOW.
- **PLACE-14** (PLACE; verdict CONFIRMED; severity MEDIUM): The screen background image is painted over the widgets and stays fixed while the canvas pans and zooms
  - Claim: The screen background image is a sibling div rendered after <ReactFlow>, with position:absolute and zIndex:0. The React Flow root is also position:relative with zIndex:0, so DOM order paints the image over all nodes and edges at 30% opacity. It is sized to the container (contain), not to flow space, so it does not pan or zoom. The tracing feature is unusable. LIFE-08 adds that saving with an uploaded image fails.
  - components/scada-builder/ScreenCanvas.tsx:995-1010 background div rendered after the ReactFlow element (L907-973), style { position:'absolute', inset:0, zIndex:0, opacity: backgroundOpacity ?? 0.3, pointerEvents:'none' }
  - @xyflow/react@12.11.0 index.js:3655-3661 wrapperStyle { position:'relative', zIndex:0 }
  - writer: ScreenCanvas.tsx:1024-1033 CanvasSettings onBackgroundImageChange -> updateScreen
  - (verifier) components/scada-builder/ScreenCanvas.tsx:995-1010 background div after the ReactFlow element (L907-973) {position:'absolute', inset:0, zIndex:0, opacity ?? 0.3, pointerEvents:'none'}
  - (verifier) @xyflow/react index.js:3655-3661 wrapperStyle {position:'relative', zIndex:0, overflow:'hidden'}
  - (verifier) writer: ScreenCanvas.tsx:1024-1033 onBackgroundImageChange -> updateScreen
  - Verifier: Two positioned z-index:0 siblings in the same stacking context paint in DOM order, so the image is on top. The feature fails as promised but is off the process critical path, so MEDIUM.

</details>

### SENSOR-CRITICAL-292

**56% of palette entries, including every P&ID equipment symbol and the built-in demo, are reject-class at the publish boundary and make deploy fail; invariant tests enshrine this palette as the contract**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 1, PARTIAL 1
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds. Counts verified: 103 palette entries, 52 equipment. 16 entries ship, 58 reject (52 equipment plus knob, dropdownSelect, scheduler, vfdDrive, vfdMini, vfdGroup) and 29 strip. I ran the real transform on the built-in RAS demo and it rejected 12 widgets (equipment, vfdMini, scheduler, vfdDrive, vfdGroup). Minor: the palette's vfdGroup entry is at line 177.

**What the user sees.** The user drags pumps, valves and tanks, connects them, and clicks Deploy. The deploy fails with a Turkish backend error listing every equipment widget. Loading the built-in RAS demo and deploying it also fails. Decorative widgets, pipes, text, shapes and process tanks vanish silently from the device.

**Root cause.** The builder palette is 6x larger than the edge runtime's closed widget enum. Classification happens only at the publish boundary on the server. The palette, the canvas and the demo template never consult classifyWidgetTypeForEdge.

**Fix direction.** Close the parity gap in the contract: add equipment, and the other control types, to the Rust WidgetType enum and the edge HMI, or render equipment through a generic symbol widget the edge supports. Until then, have the builder consume classifyWidgetTypeForEdge: badge reject/strip palette entries, run a pre-deploy compatibility check in DeployToEdgeDialog, and make the demo template edge-deployable. Add a test that the demo template passes transformScadaDocForEdgeDeploy.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/constants/scada-palette-categories.ts:27-157`
- `libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:26-66`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-118`
- `apps/sensor-service/src/process/services/scada-package.service.ts:886-907`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:314-320`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:98`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:111-115`
- `apps/sensor-service/src/process/services/scada-package.service.ts:886-899`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:313-320`
- `web/modules/sensor-module/src/__tests__/edge-widget-support.invariant.spec.ts`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts`
- `web/modules/sensor-module/src/__tests__/edge-widget-support.invariant.spec.ts:49-56`
- `web/modules/sensor-module/src/__tests__/palette-parity.spec.ts:3,31-37`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:83-118`
- `web/modules/sensor-module/src/components/charts/__tests__/trend-time-range.test.ts`

<details><summary>Merged audit findings and full evidence</summary>

- **EDGE-02** (OPS; verdict CONFIRMED; severity BLOCKER): 56% of palette entries, including every P&ID equipment symbol and the built-in demo, make the deploy fail
  - web/modules/sensor-module/src/constants/scada-palette-categories.ts:27-157 (103 entries; 52 'equipment')
  - libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:26-66 (16 ship, 7 reject)
  - libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-118 (reject → whole doc refused)
  - apps/sensor-service/src/process/services/scada-package.service.ts:886-907 (BadRequestException listing rejected widgets)
  - web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts (widgetType counts: equipment 6, vfdDrive 2, vfdMini 2, vfdGroup 1, scheduler 1)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:314-320 (Load demo), 466-479 (deploy dialog, no compatibility preflight)
  - web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:98+ (59 CONNECTION_POINTS keys, all equipment subtypes or process-equipment strip types)
  - (verifier) web/.../constants/scada-palette-categories.ts: grep counts 103 `type:` entries, 52 'equipment'
  - (verifier) edge-deploy-transform.ts:111-115 (any reject → ok:false); apps/sensor-service/src/process/services/scada-package.service.ts:886-899 (BadRequestException listing every rejected widget)
  - (verifier) pages/scada/ScadaPackageBuilderPage.tsx:313-320 (Load demo), 467-480 (DeployToEdgeDialog with no compatibility preflight); grep: classifyWidgetTypeForEdge is used in web/ only by **tests**/edge-widget-support.invariant.spec.ts
  - (verifier) RAN: transformScadaDocForEdgeDeploy(upcast(AQUACULTURE_RAS_DEMO)) → 'DEMO REJECTED, count= 12 [equipment, vfdMini, scheduler, vfdDrive, vfdGroup]' (scratchpad verify-ops/run2.ts)
  - (verifier) equipment-symbols/types.ts CONNECTION_POINTS keys are all equipment subtypes or strip-class process widgets (cleanWaterTank, feeder, mbbr...)
  - Verifier: No builder-side preflight or badge exists. The only consumer of the classification in web/ is an invariant test.
- **TEST-03** (JOUR; verdict PARTIAL; severity LOW): Invariant tests enshrine the deploy-blocking palette as the contract, and the palette 'parity' guard checks only the builder renderer
  - Claim: The invariant does pin 7 widget types as 'reject' (equipment, knob, dropdownSelect, scheduler, vfdDrive/vfdMini/vfdGroup) and the 16/7 roster sizes. It also pins display equipment (feeder, tanks, MBBR, HEPA, radial filter, Cornell drain) as silently 'strip'. transformScadaDocForEdgeDeploy refuses the whole document on any reject. palette-parity checks palette types only against the builder lazyMap, never the operator registry or the edge HMI. No test asserts that AQUACULTURE_RAS_DEMO deploys. One correction: pinning an explicit edge classification is a legitimate safety contract that stops control widgets from being silently stripped. The defect is EDGE-02 (the edge cannot render these) plus the missing outcome invariants, not the existence of the pin. Indirect impact only.
  - web/modules/sensor-module/src/**tests**/edge-widget-support.invariant.spec.ts:49-56 (reject list), :99-102 (16/7 pinned); libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:96-118 (reject refuses the whole doc, per EDGE-02)
  - web/modules/sensor-module/src/**tests**/palette-parity.spec.ts:3,31-37 (only components/scada-builder/WidgetRenderer lazyMap)
  - web/modules/sensor-module/src/store/scada/templates (demo) has no deployability test (grep AQUACULTURE_RAS_DEMO in tests: none)
  - (verifier) edge-widget-support.invariant.spec.ts:49-56 (reject list), :57-84 (strip incl. feeder/cleanWaterTank/mbbr…), :99-102 (16/7)
  - (verifier) libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:83-118 (reject → {ok:false} for the whole doc)
  - (verifier) palette-parity.spec.ts:3,31-37 (only components/scada-builder/WidgetRenderer lazyMap)
  - (verifier) grep AQUACULTURE_RAS_DEMO in test files: only components/charts/**tests**/trend-time-range.test.ts (not a deploy test)
  - Verifier: The facts are verified. The framing of 'enshrining' a bug is partly a judgment call, and the user impact is indirect, so LOW.

</details>

### SENSOR-HIGH-294

**Several widgets show hard-coded demo data outside edit mode that looks like real readings**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 1
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds for the builder's Preview and Simulation views, which are the only browser surface where these renderers run, because the operator renders '?'. Nuance for the VFD tile: with no reading and no device it shows the offline state, but the frequency, current and speed readouts still show DEMO_PARAMETERS (45 Hz etc.). DataTable also always shows generated rows at runtime; see MULTI-01.

**What the user sees.** In Preview, a trend chart shows smooth plausible curves that are not the plant's data. The alarm list shows 'pH > 8.5 CRITICAL', 'Tank level alarm' and similar entries that never happened. VFD tiles show a running drive at 45 Hz while the VFD is offline or unconfigured.

**Root cause.** Renderers use demo data as the fallback for missing live data, instead of using it only in the edit-mode preview.

**Fix direction.** Show demo data only when isEditing is true. Otherwise bind TrendChart to DataProvider.queryHistory and live values, and AlarmList to the alarm runtime slice. Calibration widgets should query real calibration data. Show an explicit 'no data/offline' state when nothing is available.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx:71-77`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/trendChartUtils.ts:69-83`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/AlarmListRenderer.tsx:11-17,30`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/AlarmListConfig.tsx:8-36`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CalibrationHistoryRenderer.tsx:9-18`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CalibrationStatusRenderer.tsx:19-20`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:215-217`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdMiniWidget.tsx:72-75`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx:72-77`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/AlarmListConfig.tsx`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CalibrationHistoryRenderer.tsx:9,18`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:215-218`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:595`

<details><summary>Merged audit findings and full evidence</summary>

- **FAKE-01** (OPS; verdict CONFIRMED; severity HIGH): Several widgets show hard-coded demo data outside edit mode, looking like real readings
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx:71-77 (isEditing \|\| !simulationMode → generateDemoTraces)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/trendChartUtils.ts:69-83
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/AlarmListRenderer.tsx:11-17,30 (config.alarms ?? DEMO_ALARMS); widget-configs/AlarmListConfig.tsx:8-36 (no alarms key)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/CalibrationHistoryRenderer.tsx:9-18; CalibrationStatusRenderer.tsx:19-20
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:215-217; VfdMiniWidget.tsx:72-75 (!reading → DEMO params)
  - (verifier) widget-renderers/TrendChartRenderer.tsx:72-77 (isEditing \|\| !simulationMode → generateDemoTraces)
  - (verifier) widget-renderers/AlarmListRenderer.tsx:11-17,30 (config.alarms ?? DEMO_ALARMS); widget-configs/AlarmListConfig.tsx writes only title/showActive
  - (verifier) widget-renderers/CalibrationHistoryRenderer.tsx:9,18; CalibrationStatusRenderer.tsx:19-20 (hard-coded 2026-03-01 / 2026-06-01)
  - (verifier) widget-renderers/VfdDriveWidget.tsx:215-218 (isEditing \|\| !reading → DEMO_PARAMETERS), 231-234 (offline flag); VfdMiniWidget.tsx:72-75
  - (verifier) nodes/ScadaWidgetNode.tsx:595 (isEditing = !data.isPreview, so it is false in both Preview and Simulation)
  - Verifier: Plausible fake data appears exactly when the user is trying to verify live bindings in Preview. That is false success on the critical E2E check, so HIGH stands.

</details>

### SENSOR-HIGH-295

**Equipment widgets misrepresent state: "Demo Status" permanently overrides the live tag, 4 valve types can never show open, tanks/feeder show >=90% full, P&ID tanks draw a fixed fill, and clicking analog equipment in simulation overwrites its value with a boolean**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 3, PARTIAL 1
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds as stated. Equipment is reject-class at the edge, so the impact is confined to builder Preview and Simulation, where it masks the tag.

**What the user sees.** A pump set to Demo 'Running' while designing stays green forever, even when the real pump stops. Three-way, pinch, diaphragm and plug valves always look closed, or in no state at all, whatever the tag says.

**Root cause.** The demo override is not gated by isEditing, and there is a hand-maintained valve list that drifted from the palette.

**Fix direction.** Apply demoState only when isEditing is true. Derive valve-ness from the equipment-symbols registry, for example a category field per subtype, instead of a duplicate Set. Add a parity test against the palette.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:42`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:135-136`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:21-31`
- `web/modules/sensor-module/src/constants/scada-palette-categories.ts:110-113`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/ThreeWayValveSymbol.tsx:17`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/PinchValveSymbol.tsx:17`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/DiaphragmValveSymbol.tsx:17`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/PlugValveSymbol.tsx:17`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:131-136`
- `web/modules/sensor-module/src/constants/scada-palette-categories.ts`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/index.ts:30-33`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CleanWaterTankRenderer.tsx:17-28`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/DirtyWaterTankRenderer.tsx:17-28`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CornellDualDrainRenderer.tsx:28-40`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/FeederRenderer.tsx:31-41`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/MbbrRenderer.tsx:60-62`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/HepaFilterRenderer.tsx:29-31`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/RadialFilterRenderer.tsx:28-30`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/FeederConfig.tsx:13-19`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/FeederConfig.tsx:14-20`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:70-77`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/tanks/VerticalTankSymbol.tsx:59-70`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/tanks/HorizontalTankSymbol.tsx:62`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/instruments/LevelTransmitterSymbol.tsx:16-17,102-106`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:96-103`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/tanks/HorizontalTankSymbol.tsx:58-66`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/instruments/LevelTransmitterSymbol.tsx:10-17`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:120-128`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:80-84`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:231-233`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:176-185`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:231-232`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:176-190`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:44-58`

<details><summary>Merged audit findings and full evidence</summary>

- **EQUIP-02** (OPS; verdict CONFIRMED; severity HIGH): Equipment 'Demo Status' permanently overrides the live tag; 4 valve types can never show open
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:42 (if (demoState) return demoState), 75-77 (passes config.demoState unconditionally)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:135-136 (Demo Status writes demoState)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:21-31 (VALVE_TYPES has 9 valves)
  - web/modules/sensor-module/src/constants/scada-palette-categories.ts:110-113 (threeWay/pinch/diaphragm/plug valves)
  - web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/ThreeWayValveSymbol.tsx:17, PinchValveSymbol.tsx:17, DiaphragmValveSymbol.tsx:17, PlugValveSymbol.tsx:17 (isOpen = state==='open')
  - (verifier) widget-renderers/EquipmentRenderer.tsx:42 (if (demoState) return demoState), 75-78 (config.demoState passed regardless of isEditing)
  - (verifier) widget-configs/EquipmentConfig.tsx:131-136 (Demo Status writes demoState)
  - (verifier) EquipmentRenderer.tsx:21-31 (9 valves) vs constants/scada-palette-categories.ts (13 valve subtypes incl. threeWay/pinch/diaphragm/plug)
  - (verifier) equipment-symbols/valves/{ThreeWay,Pinch,Diaphragm,Plug}ValveSymbol.tsx:17 (isOpen = state==='open'); symbolMap includes them (equipment-symbols/index.ts:30-33)
  - Verifier: No isEditing gate exists, and the valve set is hand-maintained and has drifted from the palette.
- **EQUIP-01** (OPS; verdict CONFIRMED; severity HIGH): Process-equipment widgets misrepresent live values: tanks and feeder show at least 90% full; MBBR, HEPA and radial filter treat numeric/boolean status as 'stopped'
  - Claim: Holds. A bound value of 0 also renders the clean or dirty tank at 90%, because status becomes 'running' whenever value !== undefined. The label is shown only in the edit-mode badge (ScadaWidgetNode.tsx:569-574), never inside the renderer.
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/CleanWaterTankRenderer.tsx:17-28
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/DirtyWaterTankRenderer.tsx:17-28
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/CornellDualDrainRenderer.tsx:28-40
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/FeederRenderer.tsx:31-41
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/MbbrRenderer.tsx:60-62, HepaFilterRenderer.tsx:29-31, RadialFilterRenderer.tsx:28-30
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/FeederConfig.tsx:13-19 (single tag field)
  - (verifier) widget-renderers/CleanWaterTankRenderer.tsx:17-28 (status running iff value!==undefined; effectiveLevel = max(level, 90))
  - (verifier) widget-renderers/FeederRenderer.tsx:31-41 (String(0)='0' ≠ 'stopped' → max(feedLevel, 90))
  - (verifier) widget-renderers/MbbrRenderer.tsx:60-62 (String(1)/'true' not in STATUS_COLORS → stopped)
  - (verifier) widget-configs/FeederConfig.tsx:14-20 (single tagName)
  - (verifier) grep: config.label appears 0 times in Clean/DirtyWaterTank, CornellDualDrain, Feeder, Mbbr, HepaFilter and RadialFilter renderers
  - Verifier: Every claimed mapping was reproduced by reading the code. These widgets are strip-class at the edge, so the impact is limited to builder preview, but there they show wrong plant state.
- **SIM-18** (SIM; verdict PARTIAL; severity MEDIUM): Aquaculture process widgets cannot be operated, P&ID tanks draw a fixed fill, and transmitters never show a value
  - Claim: These hold: feeder, MBBR, HEPA, radial filter, clean/dirty water tank and Cornell drain renderers emit no command, so process units such as a feeder or an MBBR blower cannot be started from the HMI in simulation. P&ID tank symbols receive only `state`, and draw a fixed ~60% (vertical) or ~55% (horizontal) fill when 'running' and none otherwise, so a level of 5% and one of 95% look identical. Transmitter symbols never show the measured value. tankLevel and pipeFlow have no command either, but they are indicators and do not need one, so that part is not a defect.
  - grep onCommand count = 0: web/modules/sensor-module/src/components/scada-builder/widget-renderers/{FeederRenderer,MbbrRenderer,HepaFilterRenderer,RadialFilterRenderer,CleanWaterTankRenderer,DirtyWaterTankRenderer,CornellDualDrainRenderer,TankLevelRenderer,PipeFlowRenderer}.tsx
  - web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:70-77 (EquipmentSymbolProps: state/width/height/rotation/label only)
  - web/modules/sensor-module/src/components/scada-builder/equipment-symbols/tanks/VerticalTankSymbol.tsx:59-70 (fill drawn only if state==='running', fixed 60%); tanks/HorizontalTankSymbol.tsx:62 (~55%)
  - web/modules/sensor-module/src/components/scada-builder/equipment-symbols/instruments/LevelTransmitterSymbol.tsx:16-17,102-106 (state only)
  - writer side: EquipmentRenderer.tsx:96-103 passes only state to the symbol
  - (verifier) grep -c onCommand = 0 in web/modules/sensor-module/src/components/scada-builder/widget-renderers/{FeederRenderer,MbbrRenderer,HepaFilterRenderer,RadialFilterRenderer,CleanWaterTankRenderer,DirtyWaterTankRenderer,CornellDualDrainRenderer,TankLevelRenderer,PipeFlowRenderer}.tsx
  - (verifier) web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:70-77 (EquipmentSymbolProps: state/width/height/rotation/showConnectionPoints/label — no value)
  - (verifier) equipment-symbols/tanks/VerticalTankSymbol.tsx:59-70 (fill only when running, fixed 60%); tanks/HorizontalTankSymbol.tsx:58-66 (~55%)
  - (verifier) equipment-symbols/instruments/LevelTransmitterSymbol.tsx:10-17 (state only)
  - (verifier) writer side: widget-renderers/EquipmentRenderer.tsx:120-128 (passes only state/size/rotation/label)
  - Verifier: Verified. Indicators were incorrectly listed as needing commands. The analog-value channel gap is real.
- **SIM-11** (SIM; verdict CONFIRMED; severity MEDIUM): Clicking a tank, transmitter, heat exchanger, check or relief valve in simulation overwrites its analog value with true/false
  - Claim: Holds. EquipmentRenderer's wrapper div calls onCommand('toggle') on click for every subtype in non-edit mode: tanks, transmitters, heat exchangers, check and relief valves. ScadaWidgetNode passes onCommand and isEditing={!isPreview}, and in simulation it writes !simTagValues[tagName]. A level of 95 becomes false. The tank then shows stopped/empty, and the sidebar number row renders 0 for the non-number.
  - writer: web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:80-84 (any subtype → onCommand('toggle'))
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:231-233 (setSimTagValue(tagName, !store.simTagValues[tagName]))
  - reader: web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:176-185 (number row shows 0 when the value is not a number)
  - (verifier) writer: web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:80-84 (handleClick → onCommand('toggle') for any subtype), :110-119 (onClick on wrapper)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:231-232 (setSimTagValue(tagName, !store.simTagValues[tagName])), :595-596
  - (verifier) reader: web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:176-190 (range/number show 0 when typeof value !== 'number'); EquipmentRenderer.tsx:44-58 (false → stopped/closed)
  - Verifier: Both sides read. Nothing filters by operability or subtype.

</details>

### SENSOR-HIGH-298

**E-STOP is unsafe end to end: hold time written in ms but multiplied by 1000 on the edge, edge E-STOP zeroes only "affected tags" (default none) while the dialog promises all outputs, and reset PIN is ignored/accepts any PIN**

- Severity: HIGH · Domain: SENSOR · Plan phase: F1 · Deadline: 2026-11-30
- Verification: CONFIRMED 3
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds when the user edits the field. The palette defaultConfig has no holdDuration, so an untouched E-STOP falls back to 3 s on the edge, and the 2000 shown in the panel is only a display default. Once edited, the value is stored in ms and the edge multiplies it by 1000.

**What the user sees.** On the device panel, an E-STOP whose hold time was set in the builder practically cannot be triggered: the progress ring barely moves. In the browser the same setting has no effect.

**Root cause.** There is no unit in the contract. Two independent implementations read the same key with different units.

**Fix direction.** Put units in the contract, e.g. holdDurationMs in the widget schema, and make the edge HMI read ms. Add a cross-implementation fixture test. Make the browser renderer honour hold-to-activate too.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EmergencyStopConfig.tsx:12-23`
- `sens-api-gateway/static/scada-edge.html:1084`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EmergencyStopRenderer.tsx:9-20`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EmergencyStopConfig.tsx:13-22`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EmergencyStopRenderer.tsx:14-20`
- `sens-api-gateway/src/scada_server.rs:1900-1910`
- `sens-api-gateway/src/scada_server.rs:1882`
- `web/modules/sensor-module/src/store/scada/types.ts:542-546`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:64-66`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:83-87`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:63-68`
- `sens-api-gateway/static/scada-edge.html:1731-1736`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:121-178`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:54-58,426-429`
- `sens-api-gateway/src/scada_types.rs:232-239`
- `sens-api-gateway/src/scada_types.rs:238`
- `sens-api-gateway/src/scada_server.rs:2027-2043`
- `sens-api-gateway/src/scada_server.rs:1894-1912`
- `sens-api-gateway/static/scada-edge.html`
- `apps/sensor-service/src/process/services/scada-package.service.ts:306`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:54-58`

<details><summary>Merged audit findings and full evidence</summary>

- **ESTOP-01** (OPS; verdict CONFIRMED; severity HIGH): E-STOP hold time: the builder writes milliseconds but the edge HMI multiplies by 1000
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/EmergencyStopConfig.tsx:12-23
  - sens-api-gateway/static/scada-edge.html:1084 (× 1000), 1097-1103 (send emergencyStop only when progress ≥ 1)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/EmergencyStopRenderer.tsx:9-20 (browser ignores holdDuration entirely; uses a confirm dialog)
  - (verifier) widget-configs/EmergencyStopConfig.tsx:13-22 ('Hold Duration (ms)', writes Number(value))
  - (verifier) sens-api-gateway/static/scada-edge.html:1084 ((config.holdDuration \|\| 3) \* 1000), 1094-1100 (fires only at progress ≥ 1)
  - (verifier) widget-renderers/EmergencyStopRenderer.tsx:14-20 (browser uses a confirm dialog and ignores holdDuration)
  - Verifier: Safety-critical. A configured E-STOP is practically untriggerable on the device.
- **DEP-21** (DEP; verdict CONFIRMED; severity MEDIUM): Edge E-STOP zeroes only the configured 'affected tags', which default to none, while the dialog promises that all outputs are reset
  - Claim: execute_emergency_stop sends 0 only to controlPermissions.emergencyStop.affectedTags. The builder's default emergencyStop is null, and 'Add' in the Control tab appends '' entries. With no list, E-STOP sets emergency_active, reports success with totalTags 0, and broadcasts 'emergency active', while every output keeps running. The confirm text says 'Tum kontrol cikislari sifirlanacak' ('all control outputs will be reset'). This is on top of DEP-01 (the confirm never parses) and ESTOP-01 (hold time ×1000).
  - sens-api-gateway/src/scada_server.rs:1900-1910 (affected_tags from package, unwrap_or_default), 1981-1999 (success when the list is empty; broadcast active)
  - sens-api-gateway/src/scada_server.rs:1882 (confirm text promises all outputs)
  - web/modules/sensor-module/src/store/scada/types.ts:542-546 (emergencyStop: null)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:64-66 (Add appends '')
  - (verifier) sens-api-gateway/src/scada_server.rs:1900-1910 (affected_tags from package, unwrap_or_default), 1918-1960 (loop over affected_tags only), 1984-1999 (success = failed_tags.is_empty(); totalTags 0 is success; broadcast emergency active)
  - (verifier) sens-api-gateway/src/scada_server.rs:1882 (confirm text promises all control outputs are reset)
  - (verifier) web/modules/sensor-module/src/store/scada/types.ts:542-546 (emergencyStop: null); components/scada-builder/PropertiesPanel.tsx:83-87 (display default affectedTags: [])
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:63-68 (Add appends ''); an '' tag → executor 'Tag '' not found'
  - (verifier) sens-api-gateway/static/scada-edge.html:1731-1736 ('emergency' → toast 'ACIL DURUM AKTIF!'; emergencyStopResult unhandled)
  - Verifier: Verified on both sides. With the default empty list, E-STOP reports success and shows the emergency banner while nothing is zeroed. It is safety-relevant false assurance, but it is reachable only after DEP-01 (and ESTOP-01) are fixed, so MEDIUM.
- **SET-10** (SET; verdict CONFIRMED; severity HIGH): 'PIN required for reset' and the package 'Hold Duration (ms)' are saved but ignored; E-stop reset accepts any PIN
  - Claim: Holds (overlaps sibling DEP-21 for affectedTags and DEP-16/LIFE-10 for PIN). The edge HMI always opens the PIN dialog on reset (scada-edge.html:1121), and the agent resets for any PIN when pin_hash is None, ignoring reset_requires_pin. Reachability caveat: an edge E-stop can currently not be activated at all, because confirmResponse never parses (DEP-01), so the bypass becomes live as soon as DEP-01 is fixed. Note also that hold_duration is a required u32, so a fractional value fails the whole package (DEP-11).
  - web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:121-178 (Hold Duration (ms), Affected Tags, 'PIN required for reset')
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:54-58,426-429 (display default vs stored null)
  - sens-api-gateway/src/scada_types.rs:232-239 (hold_duration, reset_requires_pin fields)
  - grep reset_requires_pin\|resetRequiresPin in sens-api-gateway/src and static: only scada_types.rs:238
  - sens-api-gateway/src/scada_server.rs:2027-2043 (pin_hash None → do_emergency_reset)
  - sens-api-gateway/src/scada_server.rs:1894-1912 (only affected_tags used)
  - sens-api-gateway/static/scada-edge.html:1084 (widget config.holdDuration); grep controlPermissions in scada-edge.html: none
  - grep affectedTags\|emergencyStop in apps/sensor-service/src: only scada-package.service.ts:306 default
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:121-178 Hold Duration (ms), Affected Tags, 'PIN required for reset'
  - (verifier) pages/scada/ScadaPackageBuilderPage.tsx:54-58 DEFAULT_EMERGENCY_STOP; 426-429 display fallback; store/scada/types.ts:542-546 stored emergencyStop: null
  - (verifier) sens-api-gateway/src/scada_types.rs:232-239 hold_duration u32, reset_requires_pin bool; 197 emergency_stop Option
  - (verifier) sens-api-gateway/src/scada_server.rs:2027-2043 pin_hash None → do_emergency_reset; 1894-1912 only affected_tags used
  - (verifier) sens-api-gateway/static/scada-edge.html:1084 widget config.holdDuration ×1000; 1121 reset sends any typed pin
  - Verifier: Both sides were read. The configured safety policy is never consulted, and no UI can set a PIN hash. 'PIN required for reset' is a promised safety control that is silently void, so I kept HIGH even though it is masked today.

</details>

### SENSOR-HIGH-299

**Events, Animations and Permissions are saved in a format no runtime reads; builder animations freeze at mount; a Set Property event wipes the target widget's config and fires while editing; dialog/card overlays are non-interactive; pasted events keep original references**

- Severity: HIGH · Domain: SENSOR · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 4, PARTIAL 1, SELF 1
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds as stated.

**What the user sees.** Role restrictions such as 'only supervisors see this' and 'only operators can press' have no effect anywhere. Click events such as navigate or open dialog and tag-driven animations such as blink, rotate or colour work, partially, only inside the builder's preview. They do nothing on the operator page and on the device HMI.

**Root cause.** The builder and the operator runtime were built against two different type families (engine/events + scada-widget.types vs scada-runtime.types) with no shared contract or upcaster. The edge contract never modelled these fields.

**Fix direction.** Choose one schema for events, animations and permissions, and put it in @platform/sensor-contracts ScadaPackageDocV2 with a validator. Make OperatorView and the edge HMI read widget.events, widget.animations and widget.permissions from that schema, or have the deploy transform map them. Add the fields to the Rust Widget struct. Add round-trip tests: a builder-authored event triggers in the operator.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:184-187`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:126-145`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:256-258`
- `web/modules/sensor-module/src/types/scada-widget.types.ts:170-175`
- `web/modules/sensor-module/src/types/scada-runtime.types.ts:473-478`
- `web/modules/sensor-module/src/engine/events/types.ts:21-47`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:192,204-205`
- `sens-api-gateway/src/scada_types.rs:102-110`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:192`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:185`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:75`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:196-204`
- `web/modules/sensor-module/src/engine/ScadaRuntime.tsx:58-61`
- `web/modules/sensor-module/src/engine/tags/TagValueBus.ts:43-49`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1066-1073`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:208-210,563-564`
- `web/modules/sensor-module/src/engine/events/handlers/NavigateHandler.ts:6-8`
- `web/modules/sensor-module/src/engine/events/handlers/TagWriteHandler.ts:10-16`
- `web/modules/sensor-module/src/engine/ScadaRuntime.tsx:32-44`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EventsPanel.tsx:26-49`
- `web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:47`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:196-199`
- `web/modules/sensor-module/src/engine/animation/useAnimationState.ts:6-13`
- `web/modules/sensor-module/src/engine/ScadaRuntime.tsx:47-51`
- `web/modules/sensor-module/src/engine/events/useWidgetEvents.ts:28-37`
- `web/modules/sensor-module/src/engine/events/handlers/TagWriteHandler.ts:8-17`
- `web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx:34-43`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223`
- `web/modules/sensor-module/src/engine/ScadaRuntime.tsx:32-43`
- `web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts:86-90`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:64-72`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:97-99`
- `web/modules/sensor-module/src/engine/ScadaRuntime.tsx:26,37`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:563-564`
- `web/modules/sensor-module/src/engine/events/useWidgetEvents.ts:11-31`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EventsPanel.tsx:48,428-458`
- `web/modules/sensor-module/src/__tests__/phase9c-anim-events.test.tsx:284-301`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:88-101`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:191,208-210`
- `web/modules/sensor-module/src/engine/events/useWidgetEvents.ts:11-26`
- `web/modules/sensor-module/src/engine/events/WidgetEventBus.ts:14-16`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:115-120`
- `web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts:87-90`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:63-71`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:91-103`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:207-210,563`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:123-127`
- `web/modules/sensor-module/src/engine/ScadaRuntime.tsx:35-36`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:116-157`
- `web/modules/sensor-module/src/engine/views/PopupCard.tsx:22,127-130`
- `web/modules/sensor-module/src/engine/views/ModalDialog.tsx:22,132-135`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:160-176`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:79-88`
- `web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts:90`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:21-62`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:145-199`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:70-120`

<details><summary>Merged audit findings and full evidence</summary>

- **META-01** (OPS; verdict CONFIRMED; severity HIGH): The Events, Animations and Permissions tabs save in a format no runtime reads
  - web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:184-187 (permissions), 299-302 (events), 316-319 (animations)
  - web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:126-145 (updateWidget {events} / {animations})
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:256-258 (serialized top-level)
  - web/modules/sensor-module/src/types/scada-widget.types.ts:170-175 (enableRoles) vs types/scada-runtime.types.ts:473-478 (enabledRoles), 386-401 (WidgetEventBinding shape)
  - web/modules/sensor-module/src/engine/events/types.ts:21-47 (WidgetEventDef shape)
  - web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:192,204-205 (config.permission / config.events / config.actions)
  - sens-api-gateway/src/scada_types.rs:102-110 (Widget = id, widgetType, position, config only)
  - (verifier) store/scada/projectSlice.ts:256-258 (permissions/animations/events serialized top-level)
  - (verifier) types/scada-widget.types.ts:170-175 (showRoles/enableRoles) vs types/scada-runtime.types.ts:473-478 (enabledRoles) and 386-401 (WidgetEventBinding params {type, screenId/tagId})
  - (verifier) engine/events/types.ts:21-47 (WidgetEventDef params targetScreenId/targetTag/toggleTag)
  - (verifier) components/scada-operator/OperatorView.tsx:192 (config.permission), 204-205 (config.events / config.actions)
  - (verifier) sens-api-gateway/src/scada_types.rs:102-110 (Widget = id, widgetType, position, config)
  - (verifier) grep: widget.permissions is read only by PropertiesPanel.tsx:185 and usePropertiesPanelHandlers.ts:75; the canvas never evaluates it
  - Verifier: No upcaster or mapper converts top-level events, animations or permissions into config.events, config.permission or config.actions. The two type families are incompatible in both key names and param shapes.
- **ANIM-01** (OPS; verdict CONFIRMED; severity HIGH): Builder animations are frozen at mount; click events fire while editing; several event actions are no-ops
  - Claim: Holds, and it is worse than stated. The snapshot is taken during the node's first render, before ScadaRuntime's publishBatch effect runs (child render precedes the parent effect), so animation rules evaluate against {} permanently. Edit-mode setProperty clicks do more than mis-fire: they wipe the target widget's config. That is reported separately as SETPROP-01.
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:196-204 (useMemo(() => tagBus.getSnapshot(), [runtimeCtx]))
  - web/modules/sensor-module/src/engine/ScadaRuntime.tsx:58-61 (bus fed only from simTagValues), 72 (memoized context value)
  - web/modules/sensor-module/src/engine/tags/TagValueBus.ts:43-49 (snapshot is a copy)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1066-1073 (ScadaRuntime always mounted, edit mode included)
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:208-210,563-564 (events dispatched; only onClick/onDoubleClick bound)
  - web/modules/sensor-module/src/engine/events/handlers/NavigateHandler.ts:6-8; engine/events/handlers/TagWriteHandler.ts:10-16 (tagBus.publish only)
  - web/modules/sensor-module/src/engine/ScadaRuntime.tsx:32-44 (no runScript/openUrl registration) vs components/scada-builder/widget-configs/EventsPanel.tsx:26-49 (offers all 6 triggers + runScript/openUrl)
  - web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:47 (widgets read simTagValues, not tagBus)
  - (verifier) nodes/ScadaWidgetNode.tsx:196-199 (useMemo(() => tagBus.getSnapshot(), [runtimeCtx])); engine/animation/useAnimationState.ts:6-13 (memo on [rules, tagValues], no subscription)
  - (verifier) engine/ScadaRuntime.tsx:47-51 (bus fed only from simTagValues), 70 (memoized ctx value)
  - (verifier) components/scada-builder/ScreenCanvas.tsx:1066-1073 (ScadaRuntime always wraps the canvas); ScadaWidgetNode.tsx:207-210 (events active whenever runtimeCtx exists), 563-564 (only onClick/onDoubleClick bound although engine/events/useWidgetEvents.ts:28-37 returns 6 handlers)
  - (verifier) engine/events/handlers/TagWriteHandler.ts:8-17 (tagBus.publish only); components/scada-builder/StableModeProvider.tsx:34-43 + ScreenCanvas.tsx:214-223 (widgets read the DataProvider, not the tagBus)
  - (verifier) ScadaRuntime.tsx:32-43 (no runScript/openUrl registration; grep confirms none elsewhere) vs widget-configs/EventsPanel.tsx:26-49
  - Verifier: There is no other subscriber that re-renders nodes on bus changes, and the runtime is not gated by mode. Every sub-claim checked out.
- **EDIT-01** (EDIT; verdict CONFIRMED; severity HIGH): A 'Set Property' click event wipes the target widget's entire config, and it fires when the button is clicked to select it in the editor
  - Claim: DUPLICATE of SETPROP-01 (verdict_OPS_3.json); merge them. The claim holds as stated and is now proven with the real runtime. ScadaRuntime is always mounted (ScreenCanvas.tsx:1066-1073) and registers setProperty against the real store.updateWidget (ScadaRuntime.tsx:26,37). SetPropertyHandler builds {<path>: value} and calls updateWidget(screenId, target, {config: configUpdate}) (SetPropertyHandler.ts:86-90). updateWidget does Object.assign(widget, updates) (widgetSlice.ts:64-72), so widget.config is replaced, not merged. One edit-mode click on the source widget wipes the target's tagName, tagRef, label and range, sets isDirty, and the corrupted config goes into toScadaPackageJSON (projectSlice.ts:249-250). The suggested path 'config.opacity' produces config = {config:{opacity}}. The setProperty target is resolved only on the clicked widget's own screen. canUndo stays false.
  - web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts:86-90 configUpdate = {}; setNestedProperty(configUpdate, path, value); store.updateWidget(event.screenId, targetWidgetId, { config: configUpdate })
  - web/modules/sensor-module/src/store/scada/widgetSlice.ts:64-72 updateWidget -> Object.assign(widget, updates); isDirty = true (top-level replace, no config merge)
  - contrast web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:97-99 (the Properties panel merges {...widget.config, ...updates})
  - web/modules/sensor-module/src/engine/ScadaRuntime.tsx:26,37 registers setProperty with the real store.updateWidget
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1066-1073 ScadaRuntime is mounted in Edit mode too; nodes/ScadaWidgetNode.tsx:563-564 onClick -> eventHandlers.onClick; engine/events/useWidgetEvents.ts:11-31 has no mode check
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/EventsPanel.tsx:48,428-458 offers setProperty, with a free-text Target Widget ID and the placeholder 'fill, config.opacity, etc.'
  - web/modules/sensor-module/src/**tests**/phase9c-anim-events.test.tsx:284-301 uses a vi.fn() updateWidget (masks the replace)
  - RAN scratchpad/editdel/keys-test.tsx [5]: D.config {"tagName":"temp1","label":"Temp","decimals":2,"unit":"C"} -> {"color":"red"}, isDirty true
  - (verifier) writer: web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts:86-90 (configUpdate from path only -> updateWidget({config}))
  - (verifier) reader/mutator: web/modules/sensor-module/src/store/scada/widgetSlice.ts:64-72 (Object.assign(widget, updates); isDirty = true)
  - (verifier) contrast: web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:88-101 (the Properties path merges {...widget.config, ...updates} from fresh getState())
  - (verifier) web/modules/sensor-module/src/engine/ScadaRuntime.tsx:26,37 (registration with the real updateWidget); components/scada-builder/ScreenCanvas.tsx:1066-1073 (runtime always wraps the canvas); nodes/ScadaWidgetNode.tsx:191,208-210 (events pass whenever runtimeCtx exists; the comment at :55 'In builder edit-mode, no events fire' is false), :563 (container onClick dispatches); engine/events/useWidgetEvents.ts:11-26 and WidgetEventBus.ts:14-16 (no mode gate)
  - (verifier) widget.events is written by usePropertiesPanelHandlers.ts:115-120 and read by ScadaWidgetNode.tsx:173-175 (same key, so the event really fires in the builder)
  - (verifier) web/modules/sensor-module/src/**tests**/phase9c-anim-events.test.tsx:284-301 (vi.fn() updateWidget, so the replace is never exercised)
  - (verifier) RAN /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/verify-edit/runtime-click-test.tsx with the real ScadaRuntime, store, useWidgetEvents and keyboard hook: before {"tagName":"temp1","tagRef":"EDGE-01/temp1","label":"Temp","min":0,"max":50}; after one click {"config":{"opacity":0.5}}, isDirty true, canUndo false; toScadaPackageJSON carries {"config":{"opacity":0.5}}
  - (verifier) Re-ran the auditor's editdel/keys-test against current HEAD b2c4ab55 (rebuilt in verify-edit/): [5] {"tagName":"temp1",...} -> {"color":"red"}
  - Verifier: I looked for a merge elsewhere: an immer middleware merge, a config-patch action, or a mode gate in the bus, the hook or the node. There is none. d3-drag suppresses the click only after real pointer movement, so a plain click-to-select fires the event. The defect silently corrupts the saved document and cannot be undone. Events never run in the deployed runtimes (META-01), so this does not block the end-to-end path by itself, but it destroys bindings the path depends on. HIGH stands.
- **SETPROP-01** (OPS-verifier; verdict SELF; severity HIGH): A 'Set Property' event replaces the target widget's whole config and writes runtime state into the saved design, in edit mode too
  - Claim: SetPropertyHandler builds a partial object {<propertyPath>: value} and calls store.updateWidget(screenId, targetWidgetId, { config: configUpdate }). widgetSlice.updateWidget does Object.assign(widget, updates), which REPLACES widget.config instead of merging it. The target widget loses tagName, tagRef, label, min/max and so on, and isDirty is set. Because ScadaRuntime is mounted in every builder mode, plain click-to-select in Edit mode fires the event. The mutation lands in the design document, so the next Save persists the corrupted widget. Even with a correct merge, a runtime action in Preview would still permanently edit the package.
  - web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts:87-90 (configUpdate built from the path only → updateWidget(..., { config: configUpdate }))
  - web/modules/sensor-module/src/store/scada/widgetSlice.ts:63-71 (Object.assign(widget, updates); state.isDirty = true)
  - web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:91-103 (the Properties panel avoids this by spreading {...widget.config, ...updates} before calling updateWidget; the handler does not)
  - web/modules/sensor-module/src/engine/ScadaRuntime.tsx:26,37 (setProperty bound to the store's updateWidget)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1066-1073 (runtime always mounted); nodes/ScadaWidgetNode.tsx:207-210,563 (click dispatches events in every mode)
  - web/modules/sensor-module/src/**tests**/phase9c-anim-events.test.tsx:284-301 (the test mocks updateWidget, so it never exercises the replace semantics)
- **OVERLAY-01** (OPS; verdict PARTIAL; severity MEDIUM): Screens opened as dialogs or cards (openDialog/openCard) are non-interactive snapshots
  - Claim: The non-interactivity holds. The claim that the popup 'shows values' is only half true: PopupCard and ModalDialog feed ScadaViewport with simTagValues only. In Preview (live) mode an opened faceplate therefore shows defaults or zeros, not live values. Animations are ignored (void resolvedAnims), pointerEvents is 'none', and no onCommand is passed.
  - web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:123-127 (animations unused), 136-154 (pointerEvents none, no onCommand)
  - web/modules/sensor-module/src/engine/ScadaRuntime.tsx:35-36 (openCard/openDialog handlers)
  - (verifier) engine/views/ScadaViewport.tsx:116-157 (void resolvedAnims; pointerEvents:'none'; WidgetRenderer without onCommand)
  - (verifier) engine/views/PopupCard.tsx:22,127-130 and ModalDialog.tsx:22,132-135 (tagValues={simTagValues})
  - (verifier) engine/ScadaRuntime.tsx:35-36 (openCard/openDialog handlers)
  - Verifier: The auditor missed the data source. Overlay values come from the simulation store and not from the DataProvider.
- **EDIT-10** (EDIT; verdict CONFIRMED; severity LOW): Paste and duplicate screen do not remap widget references inside events, so copies drive the original widget or nothing
  - Claim: The claim holds. pasteWidgets remaps ids, groupIds and internal edges but deep-clones events unchanged (selectionSlice.ts:160-176). duplicateScreen spreads {...w} with events intact (sceneSlice.ts:79-88). removeWidget never scans events (widgetSlice.ts:21-62). SetPropertyHandler resolves the target only on the source widget's own screen (SetPropertyHandler.ts:90; widgetSlice.ts:66-69 returns when it is not found). A pasted copy on the same screen therefore drives, and destroys (EDIT-01), the original target. Duplicated-screen copies do nothing. Any intentional cross-screen setProperty target can never work either, although the free-text Target Widget ID accepts any id. Sound parts worth keeping: id, groupId and edge remapping in paste and duplicate, and fresh ids on screen import (screenIO.ts:44-74).
  - web/modules/sensor-module/src/store/scada/selectionSlice.ts:160-176 newWidget = deepClone(widget); only id, position and groupId are rewritten
  - web/modules/sensor-module/src/store/scada/sceneSlice.ts:79-88 duplicateScreen new widget = {...w, id, position, config} (events copied verbatim)
  - engine/events/handlers/SetPropertyHandler.ts:90 updateWidget(event.screenId, targetWidgetId, ...) resolves only on the event's screen; store/scada/widgetSlice.ts:21-62 removeWidget never scans events
  - RAN scratchpad/editdel/keys-test.tsx [8]: pasted C setProperty target 'D' (the original); duplicated screen C target 'D', exists on dup screen: false
  - (verifier) web/modules/sensor-module/src/store/scada/selectionSlice.ts:145-199
  - (verifier) web/modules/sensor-module/src/store/scada/sceneSlice.ts:70-120
  - (verifier) engine/events/handlers/SetPropertyHandler.ts:90; store/scada/widgetSlice.ts:64-72
  - (verifier) RAN (rebuilt harness) [8]: pasted C setProperty target 'D' (original); duplicated screen C target 'D', exists on dup screen: false
  - Verifier: Events run only inside the builder (META-01), so the user impact stays inside the builder. LOW.

</details>

### SENSOR-HIGH-300

**ProcessView widget is a static 3-tank placeholder and "create SCADA package from process" imports an empty process**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 1, PARTIAL 1
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds. Because equipment is reject-class, processView is the only edge-shippable carrier for a piped process diagram, and on the device it is always blank.

**What the user sees.** Linking a P&ID process into the SCADA package shows a generic three-tank cartoon titled 'RAS-01'. Entering a Process ID in Properties changes nothing. On the device the process view is blank.

**Root cause.** The widget was left as a mock and the import path never loads process data.

**Fix direction.** Fetch the process (nodes/edges) by processId, both on import and when ProcessViewConfig changes, and store or resolve it. Render it with the process-editor's read-only renderer. Add a test that a processView with nodes renders them.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/ProcessViewRenderer.tsx:9-11,56-78`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ProcessViewConfig.tsx:12-19`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:236-242`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:381-404`
- `sens-api-gateway/static/scada-edge.html:1263-1270`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/ProcessViewRenderer.tsx:9-11`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:235-240`
- `sens-api-gateway/static/scada-edge.html:1252-1275`
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:585-592`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:237-242`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:381-417`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/ProcessViewRenderer.tsx:9-11,61-75`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ProcessViewConfig.tsx:17-18`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/ProcessViewRenderer.tsx:9-11,61-76`
- `web/modules/sensor-module/src/Module.tsx:136-144`
- `web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:204,289,360,415`

<details><summary>Merged audit findings and full evidence</summary>

- **PV-01** (OPS; verdict CONFIRMED; severity HIGH): ProcessView is a static placeholder, and 'create package from process' imports an empty process
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/ProcessViewRenderer.tsx:9-11,56-78
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ProcessViewConfig.tsx:12-19
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:236-242 (nodes: [], edges: [])
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:381-404
  - sens-api-gateway/static/scada-edge.html:1263-1270 (reads config.nodes/edges)
  - (verifier) widget-renderers/ProcessViewRenderer.tsx:9-11 (static placeholder, default 'RAS-01')
  - (verifier) widget-configs/ProcessViewConfig.tsx:12-19 (processId only; no reader)
  - (verifier) pages/scada/ScadaPackageBuilderPage.tsx:235-240 (importProcessAsWidget({nodes: [], edges: []}))
  - (verifier) store/scada/projectSlice.ts:381-404
  - (verifier) sens-api-gateway/static/scada-edge.html:1252-1275 (renders config.nodes/edges; no fetch by processId)
  - Verifier: Neither the builder nor the edge has a fetch-by-processId path. Duplicate of LIFE-04.
- **LIFE-04** (LIFE; verdict PARTIAL; severity LOW): 'SCADA Paketi Olustur' from the Process Editor imports nothing from the process: you get a fake placeholder widget
  - Claim: Duplicate of OPS PV-01. The placeholder import is real (importProcessAsWidget with name 'Process' and empty nodes/edges; the renderer is a static 3-tank SVG). However, the only caller, the 'SCADA Paketi Olustur' button, is on the legacy ProcessEditorPage. That page is no longer linked anywhere in the app: the process list and templates link to /sensor/unified-editor, and Module.tsx keeps /sensor/process/\* for bookmarks only. The user's builder flow (/scada-packages -> /scada-builder/new) never reaches this path.
  - web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:585-592 (navigates to /sensor/scada-builder/new?processId=)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:237-242 (importProcessAsWidget({ id, name: 'Process', nodes: [], edges: [] }))
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:381-417 (widget config gets nodes: [], edges: [])
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/ProcessViewRenderer.tsx:9-11,61-75 (static placeholder; reads only label/processName, default 'RAS-01')
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ProcessViewConfig.tsx:17-18
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:236-242
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-renderers/ProcessViewRenderer.tsx:9-11,61-76
  - (verifier) web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:585-592
  - (verifier) web/modules/sensor-module/src/Module.tsx:136-144 (legacy routes 'kept mounted for ONE release so existing bookmarks ... keep working')
  - (verifier) web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:204,289,360,415 (all links -> unified-editor)
  - (verifier) grep '/sensor/process/' links in web/: none besides ProcessEditorPage's own replaceState
  - Verifier: The code defect is confirmed but reachable only from a bookmark, and it duplicates PV-01, so it is downgraded.

</details>

### SENSOR-MEDIUM-293

**Edge HMI lays screens out as a fixed 12x8 grid of 1fr cells while the builder canvas is unbounded 120x100 px cells, distorting or clipping layouts**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 2
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds. Duplicate of PLACE-20.

**What the user sees.** A process screen that looks right in the builder appears squeezed, stretched or reflowed on the device's panel.

**Root cause.** Two layout models with no shared geometry contract.

**Fix direction.** Either derive layout.cols and rows from the widgets' extent at save time and render the edge with fixed-aspect cells, or switch both to absolute pixel layout with a design resolution and scale-to-fit.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:22`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-22`
- `sens-api-gateway/static/scada-edge.html:1407-1428`
- `web/modules/sensor-module/src/store/scada/types.ts:554`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-15`
- `sens-api-gateway/static/scada-edge.html:1404-1431`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:907-941`
- `sens-api-gateway/static/scada-edge.html:1411-1427`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:83-84`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:320-321`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:83-97`

<details><summary>Merged audit findings and full evidence</summary>

- **EDGE-04** (OPS; verdict CONFIRMED; severity MEDIUM): The edge HMI lays screens out as a 12×8 CSS grid of 1fr cells, while the builder canvas is unbounded 120×100 px cells
  - web/modules/sensor-module/src/store/scada/sceneSlice.ts:22 (DEFAULT_LAYOUT); grep: no UI writer of screen.layout
  - web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-22
  - sens-api-gateway/static/scada-edge.html:1407-1428 (CSS grid, 1fr cells, 12px gaps, padding inside each cell)
  - (verifier) store/scada/types.ts:554 DEFAULT_LAYOUT {type:'grid', cols:12, rows:8}; grep: no UI writer of screen.layout (only sceneSlice/projectSlice/screenIO copies)
  - (verifier) constants/scada-widget-sizes.ts:14-15
  - (verifier) sens-api-gateway/static/scada-edge.html:1404-1431 (repeat(cols,1fr) grid, 12px gap, 16px padding, per-cell padding)
  - Verifier: The two geometry models are irreconcilable.
- **PLACE-20** (PLACE; verdict CONFIRMED; severity MEDIUM): The builder canvas is unbounded, but runtimes use a fixed 12x8 layout and distort or clip anything outside it
  - Claim: The builder canvas is unbounded, with no nodeExtent, translateExtent or frame, and screen.layout stays at DEFAULT_LAYOUT 12x8 because no UI writes it. The edge HMI renders a repeat(cols,1fr) x repeat(rows,1fr) CSS grid with 12 px gaps and card chrome, so widgets beyond column 12 or row 8 fall into auto-sized implicit tracks, and cell aspect follows the device screen. ScadaViewport clips at cols*120 x rows*100 (overflow hidden). This duplicates EDGE-04.
  - components/scada-builder/ScreenCanvas.tsx:907-941 ReactFlow props: no nodeExtent or translateExtent; no frame overlay
  - store/scada/types.ts:554 DEFAULT_LAYOUT { cols: 12, rows: 8 }; the builder never updates layout from the widget extents
  - sens-api-gateway/static/scada-edge.html:1411-1427 gridTemplateColumns repeat(cols, 1fr), gridTemplateRows repeat(rows, 1fr), gap 12px, gridColumn (col+1) / span w
  - engine/views/ScadaViewport.tsx:83-84 and 90-97 canvas size cols\*GRID_CELL_W with overflow:'hidden'
  - components/scada-operator/OperatorView.tsx:320-321 canvas size cols*40 x rows*40
  - (verifier) components/scada-builder/ScreenCanvas.tsx:907-941 no extents
  - (verifier) store/scada/types.ts:554 DEFAULT_LAYOUT {cols:12, rows:8}; sceneSlice.ts:22; grep shows no UI writer of layout
  - (verifier) sens-api-gateway/static/scada-edge.html:1411-1427 grid tracks, gap 12px, gridColumn (col+1)/span w
  - (verifier) engine/views/ScadaViewport.tsx:83-97 overflow:'hidden'
  - Verifier: This is a direct read of both sides. Device layout fidelity is broken for any screen wider than 12 columns, so MEDIUM.

</details>

### SENSOR-MEDIUM-296

**Widget config keys drift from renderers: keys panels write that no renderer reads (and vice versa), expression bindings never evaluated, multi-tag widgets never live, VFD Group unconfigurable, PushButton value stored as string the edge rejects**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 2, PARTIAL 1, SELF 2
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** The pattern holds, with one error. Gauge min and max ARE writable (GaugeConfig.tsx:54,58) and read. The read-but-unwritable set is: warningThreshold and criticalThreshold for Gauge and NumericDisplay; min and max for NumericDisplay only; NumericInput decimals; PushButton color; PipeFlow tag binding, flowWidth, dashLength and dashGap; CalibrationWizard steps/currentStep; CalibrationStatus lastCalibration/nextCalibration. Every written-but-unread key listed was confirmed. A further variant: AlarmList and CalibrationHistory configs write 'title', while the browser renderers read 'label' (the edge reads 'title').

**What the user sees.** Users set gauge colour zones, decimals, ON/OFF captions, slider step and input min/max. None of it changes the widget in the builder, and the device panel looks different from the editor. A pipe-flow widget never animates because it cannot be bound to a tag.

**Root cause.** Each config panel and renderer pair is hand-written, with no per-widget config schema shared by the editor, the browser runtime and the edge.

**Fix direction.** Define a typed config schema per widget type in sensor-contracts. Type config panels and renderers against it so a key written-but-unread or read-but-unwritable fails tsc. Generate a parity test between the schema and edge HMI reads. Add a tag selector to PipeFlowConfig and AlarmBannerConfig.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:14-26,66-67`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/GaugeRenderer.tsx:89-97`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/StatusIndicatorConfig.tsx:102-123`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/StatusIndicatorRenderer.tsx:40-57`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ToggleSwitchConfig.tsx:39-50`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/ToggleSwitchRenderer.tsx:141`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SliderConfig.tsx:57-58`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/SliderRenderer.tsx:9-21`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/NumericInputConfig.tsx:49-68`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/NumericInputRenderer.tsx:9-22,40`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/PushButtonConfig.tsx:50-51`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/PushButtonRenderer.tsx:10-25`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/AlarmBannerConfig.tsx:9-22`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/AlarmBannerRenderer.tsx:20-21`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/AlarmListConfig.tsx:12-30`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/AlarmListRenderer.tsx:28-30`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/CalibrationStatusConfig.tsx:12-24`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CalibrationStatusRenderer.tsx:17-20`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/PipeFlowConfig.tsx:10-45`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/PipeFlowRenderer.tsx:9-16`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/CustomSvgConfig.tsx:189`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CustomSvgRenderer.tsx`
- `sens-api-gateway/static/scada-edge.html:752,772,866,911,1055,1060`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:54,58,68`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/GaugeRenderer.tsx:89-94`
- `sens-api-gateway/static/scada-edge.html:752-756`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:45-49`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ProgressBarConfig.tsx:86`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ExpressionBindingSection.tsx:46-57`
- `web/modules/sensor-module/src/engine/expressions/index.ts:40`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ProgressBarConfig.tsx:86-87`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ExpressionBindingSection.tsx:55-56`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/BarChartRenderer.tsx:89-122`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/PieChartRenderer.tsx:139-154`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/DataTableRenderer.tsx:151-155`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts:104-106`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/VfdDriveWidgetConfig.tsx:97-98`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdGroupWidget.tsx:57-65`
- `web/modules/sensor-module/src/constants/scada-palette-categories.ts:154`
- `web/modules/sensor-module/src/constants/scada-palette-categories.ts:177`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/PushButtonConfig.tsx:46-52`
- `sens-api-gateway/static/scada-edge.html:1305-1307`
- `sens-api-gateway/src/scada_types.rs:318-322`
- `sens-api-gateway/src/scada_server.rs:1354-1365`
- `sens-api-gateway/static/scada-edge.html:1702-1705`

<details><summary>Merged audit findings and full evidence</summary>

- **KEYS-01@OPS** (OPS; verdict PARTIAL; severity MEDIUM): Config keys written by property panels but never read by the browser renderers, and keys renderers need that no panel can write
  - widget-configs/GaugeConfig.tsx:14-26,66-67 vs widget-renderers/GaugeRenderer.tsx:89-97 (all under web/modules/sensor-module/src/components/scada-builder/)
  - widget-configs/StatusIndicatorConfig.tsx:102-123 vs widget-renderers/StatusIndicatorRenderer.tsx:40-57
  - widget-configs/ToggleSwitchConfig.tsx:39-50 vs widget-renderers/ToggleSwitchRenderer.tsx:141
  - widget-configs/SliderConfig.tsx:57-58 vs widget-renderers/SliderRenderer.tsx:9-21
  - widget-configs/NumericInputConfig.tsx:49-68 vs widget-renderers/NumericInputRenderer.tsx:9-22,40
  - widget-configs/PushButtonConfig.tsx:50-51 vs widget-renderers/PushButtonRenderer.tsx:10-25
  - widget-configs/AlarmBannerConfig.tsx:9-22 vs widget-renderers/AlarmBannerRenderer.tsx:20-21
  - widget-configs/AlarmListConfig.tsx:12-30 vs widget-renderers/AlarmListRenderer.tsx:28-30
  - widget-configs/CalibrationStatusConfig.tsx:12-24 vs widget-renderers/CalibrationStatusRenderer.tsx:17-20
  - widget-configs/PipeFlowConfig.tsx:10-45 vs widget-renderers/PipeFlowRenderer.tsx:9-16
  - widget-configs/CustomSvgConfig.tsx:189 vs widget-renderers/CustomSvgRenderer.tsx (no opacity read)
  - sens-api-gateway/static/scada-edge.html:752,772,866,911,1055,1060 (edge reads zones, decimals, onLabel/offLabel, step, showActive, title)
  - (verifier) widget-configs/GaugeConfig.tsx:54,58,68 (min/max/decimals), 13-16 (zones) vs widget-renderers/GaugeRenderer.tsx:89-94 (min/max/warningThreshold/criticalThreshold)
  - (verifier) scripted key diff: StatusIndicator W{onLabel,offLabel,colorRanges} vs R{activeColor,inactiveColor,label}; ToggleSwitch W{onLabel,offLabel} not read; Slider step not read; NumericInput W{min,max,step} vs R{decimals}; PushButton W{value} vs R{color}; AlarmBanner W{scrollInterval} vs R{demoSeverity,message}; PipeFlow R{flowWidth,dashLength,dashGap} not written and no TagBrowser; CustomSvg opacity not read
  - (verifier) widget-renderers/AlarmBannerRenderer.tsx:20-21 (severity from value, message from config.message, which is never written)
  - (verifier) sens-api-gateway/static/scada-edge.html:752-756 (zones), 738-800 (decimals), 1325-1372 (onLabel/offLabel)
  - Verifier: The scripted extraction reproduced the auditor's list except Gauge min/max. The defect class is real, but no single key blocks E2E, so MEDIUM.
- **EXPR-01** (OPS; verdict CONFIRMED; severity MEDIUM): Expression binding (Gauge, Progress Bar) is saved but never evaluated
  - Claim: Holds as stated. The edge HMI also ignores config.expression.
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:45-49; widget-configs/ProgressBarConfig.tsx:86
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ExpressionBindingSection.tsx:46-57
  - web/modules/sensor-module/src/engine/expressions/index.ts:40 (export only); grep: no other useComputedExpression or config.expression consumer
  - (verifier) widget-configs/GaugeConfig.tsx:45-49; ProgressBarConfig.tsx:86-87
  - (verifier) widget-configs/ExpressionBindingSection.tsx:55-56 (promises useComputedExpression)
  - (verifier) engine/expressions/index.ts:40 is the only reference to useComputedExpression outside its own file; grep: no renderer reads config.expression
  - Verifier: The engine is fully dead code.
- **MULTI-01** (OPS-verifier; verdict SELF; severity MEDIUM): Multi-tag widgets (Bar Chart, Pie Chart, Data Table) can never show live data; Data Table always shows generated rows
  - Claim: BarChart and PieChart bind several tags through config.sources, and DataTable through config.columns. The canvas host subscribes to and passes only one primitive value, resolved via getWidgetTagBinding(config). These configs have no tagName or tagRef, so value is undefined. The renderers expect 'a JSON-encoded map from TagValueBus' in value, which nothing produces, so every bar and slice is 0 in Preview and Simulation. DataTableRenderer calls generateDemoRows in BOTH branches of its isEditing ternary, so at runtime it always displays fabricated numbers.
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223 (liveTagIds = getWidgetTagBinding per widget), 271-284 (liveValue = single primitive)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/BarChartRenderer.tsx:89-122 (sources; value must be a JSON string map, else zeros); PieChartRenderer.tsx:139-154 (same)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/DataTableRenderer.tsx:151-155 (isEditing ? generateDemoRows(...) : generateDemoRows(...))
  - scripted key diff: BarChart/PieChart configs write sources but no tagName; grep: no JSON.stringify of tag maps in ScreenCanvas/ScadaWidgetNode/ScadaViewport
- **VFD-01** (OPS; verdict CONFIRMED; severity MEDIUM): VFD Group cannot be configured: it reuses the single-drive config, but its renderer needs a devices[] list
  - Claim: Holds, and it is worse. Even if config.devices were written, VfdGroupWidget renders those static objects as-is (frequency, power, status), with no live reading per device. The palette entry is at line 177.
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts:104-106
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/VfdDriveWidgetConfig.tsx:97-98 (vfdDeviceId only)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdGroupWidget.tsx:57-65 (groupTitle, devices[])
  - web/modules/sensor-module/src/constants/scada-palette-categories.ts:154 (defaultConfig {title})
  - (verifier) widget-configs/index.ts:104-106 (vfdDrive/vfdMini/vfdGroup → VfdDriveWidgetConfig)
  - (verifier) widget-renderers/VfdGroupWidget.tsx:57-65 (groupTitle/label; devices from config.devices or [] outside edit mode; no useVfdRealtimeReadings)
  - (verifier) constants/scada-palette-categories.ts:177 (defaultConfig {title})
  - Verifier: Confirmed by reading both sides.
- **PB-EDGE-01** (OPS-verifier; verdict SELF; severity MEDIUM): PushButton 'Value to Send' is stored as a string, so the edge rejects the command; the HMI hides every rejected frame
  - Claim: PushButtonConfig's 'Value to Send' is a text input that writes config.value = e.target.value (a string). The edge HMI sends {type:'command', tag, value: config.value}. The Rust WsClientMessage::Command requires value: f64, and serde_json does not coerce "1" to f64, so the frame is rejected with {type:'error'}. The HMI only handles commandResult, never type 'error', so the operator gets no feedback. This persists after EDGE-01 is fixed. The edge PushButton also ignores config.mode (momentary/toggle), so a 'Toggle' button always sends the same value.
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/PushButtonConfig.tsx:46-52 (type='text'; onChange({ value: e.target.value })), 38-42 (mode)
  - sens-api-gateway/static/scada-edge.html:1305-1307 (val = config.value ?? 1; send({type:'command', tag, value: val})); grep: config.mode is never read
  - sens-api-gateway/src/scada_types.rs:318-322 (Command { tag: String, value: f64 }); src/scada_server.rs:1354-1365 (deserialize error → {type:'error'})
  - sens-api-gateway/static/scada-edge.html:1702-1705 (only commandResult is toasted; no 'error' branch in the dispatcher 1623-1720)

</details>

### SENSOR-MEDIUM-297

**All 50 FUXA catalog widgets render empty: catalogId is stored but no loader fetches the SVG**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F2 · Deadline: 2026-12-21
- Verification: CONFIRMED 1
- Rule: One versioned document schema and one renderer shared by the editor and every runtime

**Claim.** Holds. fuxaWidget is also strip-class at the edge.

**What the user sees.** A widget chosen from the FUXA library appears as an empty box until the user manually uploads an SVG file in its properties.

**Root cause.** The catalog is index-only and the asset loader was never built.

**Fix direction.** Bundle or serve the catalog SVGs and resolve svgContent from catalogId at add time, or lazily in the renderer. Otherwise hide the catalog browser.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:280-293`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/FuxaWidgetRenderer.tsx:143,163-166`
- `web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/catalog.ts:6-8`
- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:280-296`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/FuxaWidgetRenderer.tsx:143,161-164`
- `web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/types.ts:112`

<details><summary>Merged audit findings and full evidence</summary>

- **FUXA-01** (OPS; verdict CONFIRMED; severity MEDIUM): All 50 FUXA catalog widgets render empty: catalogId is stored but no loader fetches the SVG
  - web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:280-293
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/FuxaWidgetRenderer.tsx:143,163-166 (no srcdoc without svgContent)
  - web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/catalog.ts:6-8 (on-demand loading promised); grep: catalogId has no reader
  - (verifier) components/scada-builder/UnifiedLeftPanel.tsx:280-296 (stores label/catalogId/category only)
  - (verifier) widget-renderers/FuxaWidgetRenderer.tsx:143,161-164 (no srcdoc without svgContent)
  - (verifier) fuxa-bridge/catalog.ts:6-8 (on-demand load promised); grep: catalogId has no reader (only fuxa-bridge/types.ts:112 type and comments)
  - (verifier) no SVG assets exist under fuxa-bridge/ (only .ts files)
  - Verifier: No loader exists.

</details>

## E. Editor canvas mechanics

### SENSOR-HIGH-301

**Undo/Redo can never work in any SCADA editor: nothing ever pushes history, buttons are dead or no-ops, so deleted equipment and pipes cannot be restored**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 5
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** Holds. The only pushHistory callers are unit tests (store/scada/**tests**/scadaStore.test.ts). The store middleware is devtools/subscribeWithSelector/immer, with no temporal or zundo layer. Duplicate of LIFE-09, PLACE-05 and CONN-09.

**What the user sees.** The Undo button is always greyed out. Deleting a widget or screen by mistake cannot be undone, and Ctrl+Z does nothing.

**Root cause.** History was designed as an opt-in call that each mutation must make. No mutation was ever migrated to make it.

**Fix direction.** Make history automatic: wrap the mutating actions (add/remove/update widget, move, edge CRUD, screen CRUD, alarm CRUD, cut/paste, group) in a middleware or helper that records before/after entries. Add a test that every mutating action is undoable.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/historySlice.ts:292-331`
- `web/modules/sensor-module/src/store/scada/historySlice.ts:292`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:13-82`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:102-134`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:35-68`
- `web/modules/sensor-module/src/components/scada-builder/UndoRedoToolbar.tsx:22-31`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:39-51`
- `web/modules/sensor-module/src/store/scada/createScadaStore.ts:2-3,25-27`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:13-71`
- `web/modules/sensor-module/src/components/scada-builder/UndoRedoToolbar.tsx:11-31`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:42`
- `web/modules/sensor-module/src/store/scada/historySlice.ts:292-305`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:13-80`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:39-50`
- `web/modules/sensor-module/src/store/scada/__tests__/scadaStore.test.ts`
- `web/modules/sensor-module/src/store/scada/historySlice.ts:292,374`
- `web/modules/sensor-module/src/store/scada/types.ts:353`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:13-19`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:40-44`
- `web/modules/sensor-module/src/store/scada/historySlice.ts:359`
- `web/modules/sensor-module/src/components/scada-builder/UndoRedoToolbar.tsx:24-31`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:214`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:367-372`
- `web/modules/sensor-module/src/store/scada/createScadaStore.ts:23-48`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:13-83`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:40-50`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:21-62`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:4-21`
- `web/modules/sensor-module/src/store/scada/createScadaStore.ts:23-46`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:833-858`
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:475,485`
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:469-485`
- `web/modules/sensor-module/process-editor-canvas.html:10`

<details><summary>Merged audit findings and full evidence</summary>

- **HIST-01** (OPS; verdict CONFIRMED; severity HIGH): Undo/Redo can never work: nothing ever pushes history
  - web/modules/sensor-module/src/store/scada/historySlice.ts:292-331 (pushHistory)
  - grep: pushHistory referenced only at historySlice.ts:292 and types.ts:353 (no callers)
  - web/modules/sensor-module/src/store/scada/widgetSlice.ts:13-82, selectionSlice.ts:102-134, sceneSlice.ts:35-68 (mutations without history)
  - web/modules/sensor-module/src/components/scada-builder/UndoRedoToolbar.tsx:22-31 (disabled when canUndo() false)
  - web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:39-51
  - (verifier) store/scada/historySlice.ts:292-331
  - (verifier) grep: pushHistory has no non-test caller in web/modules/sensor-module/src
  - (verifier) store/scada/createScadaStore.ts:2-3,25-27 (no history middleware)
  - (verifier) store/scada/widgetSlice.ts:13-71 (mutations without history)
  - (verifier) components/scada-builder/UndoRedoToolbar.tsx:11-31; hooks/useScadaKeyboardShortcuts.ts:42
  - Verifier: No automatic history recording exists anywhere.
- **LIFE-09** (LIFE; verdict CONFIRMED; severity MEDIUM): Undo/Redo never records anything: buttons always disabled, Ctrl+Z is a no-op
  - Claim: Duplicate of OPS HIST-01, PLACE-05 and CONN-09. pushHistory and createCheckpoint have zero production callers, so the undo stack is always empty and Ctrl+Z/Y and the toolbar buttons are no-ops.
  - web/modules/sensor-module/src/store/scada/historySlice.ts:292-305 (pushHistory)
  - grep 'pushHistory(' in sensor-module/src excluding **tests**: 0 call sites
  - web/modules/sensor-module/src/store/scada/widgetSlice.ts:13-80 (add/remove/update with no history)
  - web/modules/sensor-module/src/components/scada-builder/UndoRedoToolbar.tsx:22-31
  - web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:39-50
  - web/modules/sensor-module/src/store/scada/**tests**/scadaStore.test.ts (only caller)
  - (verifier) web/modules/sensor-module/src/store/scada/historySlice.ts:292
  - (verifier) grep 'pushHistory\|createCheckpoint' in sensor-module/src (non-test): only historySlice.ts:292,374 and types.ts:353,360
  - (verifier) web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:39-51
  - Verifier: Confirmed. It is regraded to MEDIUM because missing undo does not stop a process from working end to end. It causes data loss after mistakes.
- **PLACE-05** (PLACE; verdict CONFIRMED; severity HIGH): Undo/Redo is completely inert: nothing ever pushes history
  - Claim: historySlice.pushHistory has no production caller, and the store composition (createScadaStore.ts) adds no temporal or history middleware. undoStack therefore stays empty, canUndo() is always false, Ctrl+Z/Y are no-ops, and the toolbar buttons stay disabled. This duplicates LIFE-09, HIST-01 and CONN-09.
  - grep 'pushHistory' across src (excluding tests) finds only store/scada/historySlice.ts:292 (definition) and store/scada/types.ts:353 (type)
  - store/scada/widgetSlice.ts:13-19 (addWidget), 21-62 (removeWidget), 74-83 (updateWidgetPosition) make no history call
  - hooks/useScadaKeyboardShortcuts.ts:40-44 'if (s.canUndo()) s.undo()' with canUndo = undoStack.length > 0 (historySlice.ts:359)
  - components/scada-builder/UndoRedoToolbar.tsx:24-31 buttons disabled={!canUndo()}, mounted at pages/scada/ScadaBuilderToolbar.tsx:214
  - even with entries, the redo/undo position change would not show because of PLACE-03 (ScreenCanvas.tsx:367-372)
  - (verifier) grep 'pushHistory' (non-test): only store/scada/historySlice.ts:292 (definition) and store/scada/types.ts:353 (type)
  - (verifier) store/scada/createScadaStore.ts:23-48 devtools(subscribeWithSelector(immer(slices))), with no zundo/temporal
  - (verifier) store/scada/widgetSlice.ts:13-83 addWidget/removeWidget/updateWidget/updateWidgetPosition make no history call
  - (verifier) hooks/useScadaKeyboardShortcuts.ts:40-50 'if (s.canUndo()) s.undo()'; components/scada-builder/UndoRedoToolbar.tsx:24-31 disabled={!canUndoNow}
  - Verifier: The writer is absent and the reader gates on an empty stack. The UI promises undo and it never works, and the loss compounds PLACE-04's wrong-widget Delete. Undo is not on the process critical path, so HIGH rather than BLOCKER.
- **CONN-09** (CONN; verdict CONFIRMED; severity HIGH): Undo/redo is dead, so deleted pipes or equipment (with cascaded pipes) cannot be restored
  - Claim: Confirmed against the real store. removeWidget cascades the widget's edges away, undoStack stays at 0, canUndo() is false, and undo() restores nothing. pushHistory is never called by production code, and the store has no history middleware (createScadaStore uses only devtools, subscribeWithSelector and immer). Duplicate of LIFE-09, HIST-01 and PLACE-05.
  - store/scada/historySlice.ts:292-331 pushHistory. :103-109 WIDGET_REMOVE undo would restore removedEdges
  - grep pushHistory: called only in store/scada/**tests**/scadaStore.test.ts, and never in production code
  - store/scada/widgetSlice.ts:21-62 removeWidget filters out edges referencing the widget with no history entry. store/scada/edgeSlice.ts:4-21 addEdge and removeEdge have no history
  - hooks/useScadaKeyboardShortcuts.ts:40-44 Ctrl+Z calls undo only if canUndo(). UndoRedoToolbar.tsx:24-31 disables the button when canUndo() is false
  - (verifier) store/scada/historySlice.ts:292-331 pushHistory; :103-109 WIDGET_REMOVE undo would restore removedEdges
  - (verifier) grep pushHistory in non-test code finds only historySlice.ts:292 and types.ts:353
  - (verifier) store/scada/createScadaStore.ts:23-46 has no temporal or history middleware
  - (verifier) store/scada/widgetSlice.ts:21-62 removeWidget filters edges; edgeSlice.ts:4-21 add/remove without history
  - (verifier) hooks/useScadaKeyboardShortcuts.ts:40-44 undo gated by canUndo(); UndoRedoToolbar.tsx:24-31 disabled={!canUndoNow}
  - (verifier) real store run: 'after removeWidget: widgets 1 edges 0 canUndo false undoStack 0' then 'after undo: widgets 1 edges 0'
  - Verifier: Reproduced with the actual slices. Deleting a piece of equipment silently loses all of its pipes with no recovery short of discarding unsaved work.
- **JRN-05** (JOUR; verdict CONFIRMED; severity MEDIUM): P&ID Undo/Redo buttons (unified editor default mode and ProcessEditorPage) are enabled but do nothing: the canvas iframe has no undo/redo handler
  - Claim: Holds. In ProcessEditorPage the buttons are disabled only on !isCanvasReady (:469-485), and in the unified editor on !isCanvasReady \|\| !isCanvasEditable (true in pid mode, editorModeStore.ts:50).
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:833-858 (onClick sendToCanvas('undo'\|'redo'); disabled only when !isCanvasReady \|\| !isCanvasEditable), :332-333 (comment), :677 (shortcuts detached when mode !== 'hmi')
  - web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:475,485 (same messages)
  - web/modules/sensor-module/canvas/main.jsx:626-903 (message switch: no 'undo'/'redo' case)
  - (verifier) UnifiedEditorPage.tsx:833-858 (sendToCanvas('undo'\|'redo') outside HMI), :332-333 (comment: '(undo-less) P&ID iframe'), :677 (HMI shortcuts detached outside HMI)
  - (verifier) ProcessEditorPage.tsx:469-485
  - (verifier) process-editor-canvas.html:10 loads canvas/main.jsx; main.jsx:626-913 message switch has no 'undo'/'redo' case; grep undo\|redo\|history\|keydown in main.jsx: 0 matches
  - (verifier) @xyflow/react 12 has no built-in history
  - Verifier: I confirmed that the iframe served is main.jsx, that no undo handler exists there, and that nothing else (a ReactFlow built-in or a keydown listener) provides one. Enabled buttons that silently do nothing after a destructive delete match the stated symptom.

</details>

### SENSOR-HIGH-302

**Store-driven position changes (align/distribute, Properties X/Y) never move an existing node on the canvas; the next drag overwrites them**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 2
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** For nodes that already exist, the store-to-local sync copies only data and draggable and keeps the local position. Store-only position writes never move the node: AlignmentToolbar via updateWidgetPosition, and Properties X/Y via updateWidget. The edit is saved, but the canvas still shows the old layout. The next drag of that node recomputes the grid position from the stale local position and overwrites the edit. The canvas resyncs only when CanvasInner remounts (Preview, which swaps the DataProviderRoot child type) or when the node ids change (screen switch, package reload). Properties W/H edits do resize visually, because size flows through data.width/height. Only X/Y is lost. This duplicates CANVAS-01.

**What the user sees.** With several widgets selected, clicking Align Left / Align Top / Distribute does nothing. Typing new X/Y values in Properties does nothing either. On Preview or a screen-tab switch, the widgets suddenly jump to the aligned or typed positions. Dragging one of them before that throws the edit away.

**Root cause.** Two sources of truth for position: local React Flow node state and the zustand store. The sync was written one-way (store wins only for new nodes) to protect drag smoothness.

**Fix direction.** Derive node positions from the store whenever no drag is in progress (compare store and local and take the store unless isDragging), or move the drag-in-progress overlay into the store and render nodes purely from it. Add a component test: updateWidgetPosition on an existing widget changes the rendered node transform.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:367-372`
- `web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:45-53`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:64-77`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:105-112`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:64-72`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:288`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:498-515`
- `web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx:40`
- `web/modules/sensor-module/src/providers/DataProviderContext.tsx:79-110`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:351`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:63-77`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:249`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:356-378`
- `web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:44-53`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:352-378`
- `web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:45-54`

<details><summary>Merged audit findings and full evidence</summary>

- **PLACE-03** (PLACE; verdict CONFIRMED; severity HIGH): Position changes made to the store never move an existing node on the canvas
  - components/scada-builder/ScreenCanvas.tsx:367-372 'if (existing) { return { ...existing, data: sn.data, draggable: sn.draggable }; }', with the comment 'keep local position'
  - writer: components/scada-builder/AlignmentToolbar.tsx:45-53 calls state.updateWidgetPosition() for every aligned widget
  - writer: widget-configs/GeneralPropertiesSection.tsx:64-77 onUpdate({ position: {col,row,w,h} }) -> pages/scada/usePropertiesPanelHandlers.ts:105-112 -> store/scada/widgetSlice.ts:64-72 updateWidget
  - reader: ScreenCanvas.tsx:288 storeNodes carries the new position, but the merge at L367-372 discards it
  - overwrite: ScreenCanvas.tsx:498-515 drag end recomputes the grid position from the local change.position and calls updateWidgetPosition
  - remount: components/scada-builder/StableModeProvider.tsx:40 with providers/DataProviderContext.tsx:79-110 swaps the provider component type for preview, which remounts ScreenCanvas and re-initialises nodes from the store (ScreenCanvas.tsx:351)
  - (verifier) components/scada-builder/ScreenCanvas.tsx:367-372 'if (existing) { return { ...existing, data: sn.data, draggable: sn.draggable }; }'
  - (verifier) writer: components/scada-builder/AlignmentToolbar.tsx:45-53 state.updateWidgetPosition per aligned id
  - (verifier) writer: widget-configs/GeneralPropertiesSection.tsx:63-77 onUpdate({position}) -> pages/scada/usePropertiesPanelHandlers.ts:105-112 -> store/scada/widgetSlice.ts:64-72 updateWidget
  - (verifier) overwrite: ScreenCanvas.tsx:498-515 drag end pixelToGrid(change.position) -> updateWidgetPosition
  - (verifier) remount: components/scada-builder/StableModeProvider.tsx:40 + providers/DataProviderContext.tsx:79-110 (Simulation shares the provider type, so it does NOT resync; only Preview does)
  - (verifier) save: store/scada/projectSlice.ts:249 position: w.position (the store, not the canvas)
  - Verifier: I read the writer, the merge and the save. No other subscriber pushes store positions into React Flow: there is no useEffect on position, and no key on ScreenCanvas (pages/scada/ScadaPackageBuilderPage.tsx:399-401). This is silent divergence between what is shown and what is saved, so HIGH.
- **CANVAS-01** (OPS; verdict CONFIRMED; severity HIGH): Store-driven position changes never move the widget on the canvas
  - Claim: Holds. Size changes do propagate, through the data.width sync in ScadaWidgetNode. Only position is stuck. Duplicate of PLACE-03.
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:356-378 (existing node → { ...existing, data, draggable }; position not synced)
  - web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:44-53 (updateWidgetPosition only)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:64-77 (position via onUpdate → updateWidget)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:249 (store position is what gets saved)
  - (verifier) components/scada-builder/ScreenCanvas.tsx:352-378 (existing node → {...existing, data, draggable}; local position kept)
  - (verifier) components/scada-builder/AlignmentToolbar.tsx:45-54 (updateWidgetPosition only)
  - (verifier) widget-configs/GeneralPropertiesSection.tsx:64-77 (position via onUpdate → updateWidget)
  - (verifier) store/scada/projectSlice.ts:249 (store position is what gets serialized)
  - Verifier: I looked for a counter path: a key on the canvas that remounts nodes, or a second effect that syncs position. Neither exists. Positions refresh only when the screen changes, because the node ids differ.

</details>

### SENSOR-HIGH-303

**Selection split-brain between React Flow and the store: shift-click empties selection, box-select keeps one widget, invisible store-only selections still receive Delete (across screens), locked/hidden widgets deleted, group clicks open the wrong widget**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 5
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** React Flow's node.selected and the store's selectedWidgetIds are never reconciled. (1) Shift-click with no pointer movement: React Flow's pane onPointerDownCapture swallows the pointerdown, then the click reaches the node. handleNodeClick -> addSelectedNodes emits select:true -> onNodesChange -> setSelectedWidget(id) gives [id]. onNodeClick (shift) -> toggleWidgetSelection(id) removes it, giving []. Shift-click with even 1 px of movement: selectionKeyCode 'Shift' gives requiredDistance 0, so a box selection starts, resetSelectedElements deselects every node in React Flow, and onClickCapture swallows the click. The store then keeps the old selection while the canvas shows none. Either way Shift never adds to a selection. (2) A Shift-drag box emits one batch with a select:true per node, and each one calls setSelectedWidget, so the last one wins. (3) storeNodes never sets selected, so selections made only in the store (Ctrl+A, Layers row, paste, drop, Escape, selectGroup) are not shown, while Delete and the context menu act on the store selection. Subset grouping is impossible: only Ctrl+A then Ctrl+G, which groups every widget on the screen.

**What the user sees.** Shift-clicking a second pump clears the Properties panel, and the alignment toolbar never appears. Dragging a box around three widgets selects only one. After Ctrl+A or after clicking a row in Layers, nothing looks selected on the canvas, yet pressing Delete deletes widgets other than the one highlighted. Grouping (Ctrl+G needs 2+ selected) is practically unreachable.

**Root cause.** Selection state is duplicated between the React Flow node 'selected' flag and selectionSlice, with event handlers on both sides writing conflicting values.

**Fix direction.** Make the store the single source: map node.selected = selectedWidgetIds.includes(id) in storeNodes. Handle selection only through onSelectionChange/onNodesChange select batches (accumulate all selected ids), and stop toggling in onNodeClick, or set multiSelectionKeyCode='Shift' and let the batch be authoritative. Add an RTL test for shift-click and box-select.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:543-546`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:701-705`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:14-21`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:928`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:285-307`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:86-92`
- `web/modules/sensor-module/src/components/scada-builder/LayersPanel.tsx:325-330`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:60-67`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:47-58`
- `web/modules/sensor-module/src/components/scada-builder/LayersPanel.tsx:324-329`
- `web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:150-160,182-207`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:131-143`
- `web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:413-417`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:46-54`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:195-197`
- `web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:72`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:78-88`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:27-32`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:14-21,69-74`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:372,446`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:20-24`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:21-62`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:193-197`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:350-373`
- `web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:72-79`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:269`
- `web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:150-160`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:160-189`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:61-79`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:266-269`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:160-182`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:56-59`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:74-83`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/GeneralPropertiesSection.tsx:64-91`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:706-713`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:62-81`

<details><summary>Merged audit findings and full evidence</summary>

- **PLACE-04** (PLACE; verdict CONFIRMED; severity HIGH): Selection split-brain: Shift-click empties the selection, box-select keeps only one widget, and store-only selections are invisible but still receive Delete
  - components/scada-builder/ScreenCanvas.tsx:543-546 select change -> setSelectedWidget(change.id)
  - components/scada-builder/ScreenCanvas.tsx:701-705 shiftKey -> toggleWidgetSelection(node.id)
  - store/scada/selectionSlice.ts:14-21 setSelectedWidget resets to [id]; L32-45 toggle removes an id that is already present
  - @xyflow/react@12.11.0 dist/esm/index.js:2219-2235 onSelectNodeHandler calls handleNodeClick BEFORE the user's onClick; L1631-1646 handleNodeClick calls addSelectedNodes for an unselected node; L3471-3480 without multiSelectionActive it selects only that node; L3248 nodeDragThreshold default 1 makes this path active
  - ScreenCanvas.tsx:928 multiSelectionKeyCode={null}; React Flow's default selectionKeyCode is 'Shift' (index.js:3662), so Shift-drag box-selects
  - ScreenCanvas.tsx:285-307 storeNodes has no 'selected' field; L367-372 the merge keeps existing.selected
  - hooks/useScadaKeyboardShortcuts.ts:86-92 Delete removes s.selectedWidgetIds (the store), regardless of what the canvas highlights
  - components/scada-builder/LayersPanel.tsx:325-330, CanvasContextMenu Select All, and selectionSlice.ts:60-67 / 136-199 all write store selection only
  - selectionSlice.ts:47-58 selectGroup sets selectedWidgetId to groupWidgetIds[0], so context-menu Bring to Front / Lock / Save as Template on a right-clicked group member act on a different member
  - (verifier) components/scada-builder/ScreenCanvas.tsx:543-546 select -> setSelectedWidget(change.id); L701-705 shiftKey -> toggleWidgetSelection; L928 multiSelectionKeyCode={null}
  - (verifier) @xyflow/react 12.11.0 dist/esm/index.js:2219-2235 onSelectNodeHandler -> handleNodeClick before onClick; L1631-1646 addSelectedNodes; L3471-3480 non-multi selection; L3248 nodeDragThreshold 1, L3260 selectNodesOnDrag true; L3662 selectionKeyCode='Shift'
  - (verifier) index.js:1462-1491 Pane onPointerDownCapture, active when selectionKeyPressed, stopPropagation+preventDefault on node targets; L1569-1584 requiredDistance = 0 when the selection key is pressed, then resetSelectedElements(); L1455-1460 onClickCapture swallows the click; L1525-1530 commitUserSelectionRect triggers a batch of select changes
  - (verifier) ScreenCanvas.tsx:285-307 storeNodes has no 'selected'; components/scada-builder/LayersPanel.tsx:324-329 setSelectedWidget only; hooks/useScadaKeyboardShortcuts.ts:86-92 Delete iterates the store selectedWidgetIds
  - (verifier) components/scada-builder/CanvasContextMenu.tsx:150-160,182-207 act on store selectedWidgetId/Ids; selectionSlice.ts:47-58 selectGroup picks groupWidgetIds[0]
  - Verifier: I re-traced the React Flow 12.11.0 source, the version pinned in web/modules/sensor-module/package.json:28 and package-lock.json:19788. The auditor missed the pane capture path for Shift, but it leads to the same or worse outcome, so the claim stands. Because Delete can remove a widget other than the one highlighted on the canvas and undo is dead (PLACE-05), this is silent data loss: HIGH.
- **EDIT-03** (EDIT; verdict CONFIRMED; severity MEDIUM): Selection survives screen switches; Delete on the new screen silently unbinds automation variables of widgets on the previous screen
  - Claim: The claim holds and goes further. setActiveScreen, addScreen, duplicateScreen and removeScreen clear selectedWidgetId but not selectedWidgetIds (sceneSlice.ts:30,65-66,117-118,141-142). The SceneTree import does not touch selection at all (SceneTreePanel.tsx:411-415). Only loadFromJSON, setSelectedWidget, setSelectedEdge, deselectAll and cut reset the list. The Delete handler loops the stale ids against the new activeScreenId (useScadaKeyboardShortcuts.ts:86-92). removeWidget is a no-op for the widget but runs its global binding cleanup and isDirty (widgetSlice.ts:46-61), so the automation variable is unbound although the widget still exists. There is a worse case. After a round trip (select pump on S1, open S2, come back to S1), the canvas shows the pump unselected: the node is rebuilt without `selected` (ScreenCanvas.tsx:362-373), and Properties is empty because selectedWidgetId is null. Delete or Backspace with focus on the tab button still deletes the pump and its pipes. The AlignmentToolbar 'N selected' and Ctrl+D pasting an old clipboard on the new screen are also confirmed.
  - web/modules/sensor-module/src/store/scada/sceneSlice.ts:131-143 setActiveScreen clears selectedWidgetId/selectedEdgeId only; :30 addScreen, :65-66 removeScreen and :117-118 duplicateScreen do the same; components/scada-builder/SceneTreePanel.tsx:413-417 import uses setState without clearing the selection
  - web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:86-92 loops s.selectedWidgetIds -> removeWidget(s.activeScreenId, id); :20-24 only INPUT/TEXTAREA/SELECT/contentEditable are skipped (a tab <button> is not)
  - web/modules/sensor-module/src/store/scada/widgetSlice.ts:46-54 binding cleanup iterates all automationBindings regardless of screenId; :61 isDirty = true
  - components/scada-builder/ScreenTabBar.tsx:195-197 the tab is a <button onClick={() => setActiveScreen(id)}>
  - components/scada-builder/AlignmentToolbar.tsx:72 renders when selectedWidgetIds.length >= 2; store/scada/selectionSlice.ts:78-88 copy returns early, then hook L74-83 pastes the old clipboard
  - RAN scratchpad/editdel/keys-test.tsx [2]: after tab switch selectedWidgetIds=["A"]; Backspace on the tab button leaves S1 widgets [A,B] but binding.boundWidgetId null, boundTag null, isDirty true. [7]: Ctrl+D on S2 pastes the earlier-copied gateValve. misc-test: addScreen keeps 4 stale ids
  - (verifier) web/modules/sensor-module/src/store/scada/sceneSlice.ts:27-32 (addScreen), 65-66 (removeScreen), 116-119 (duplicateScreen), 131-143 (setActiveScreen): selectedWidgetIds is never reset
  - (verifier) web/modules/sensor-module/src/store/scada/selectionSlice.ts:14-21,69-74 (the only resetters are setSelectedWidget/deselectAll); projectSlice.ts:372,446 (loadFromJSON resets)
  - (verifier) web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:20-24 (BUTTON is not filtered), 74-83 (Ctrl+D), 86-92 (Delete loop)
  - (verifier) web/modules/sensor-module/src/store/scada/widgetSlice.ts:21-62 (cleanup iterates every automationBinding regardless of screen; isDirty set unconditionally)
  - (verifier) components/scada-builder/ScreenTabBar.tsx:193-197 (tab is a <button onClick=setActiveScreen>); ScreenCanvas.tsx:350-373 (node merge keeps `selected` only for nodes that survive)
  - (verifier) components/scada-builder/AlignmentToolbar.tsx:72-79 (renders a 'N selected' count from the raw ids)
  - (verifier) RAN (rebuilt auditor harness, HEAD b2c4ab55): [2] after tab switch selectedWidgetIds ["A"]; Backspace on tab -> S1 [A,B] intact, binding.boundWidgetId null, isDirty true; [7] Ctrl+D on S2 pastes equipment:gateValve; misc: addScreen keeps 4 stale ids
  - (verifier) RAN /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/verify-edit/runtime-click-test.tsx: round trip S1->S2->S1 gives selectedWidgetId null, selectedWidgetIds ["A"]; Delete on tab -> S1 widgets [] (A deleted), binding null
  - Verifier: I searched for an activeScreenId subscriber or effect that deselects (ScreenCanvas, page, ScreenTabBar) and found none. Unbound variables only matter to the builder simulation (SimulationSidebar.tsx:452-474), and the round-trip delete needs a Delete or Backspace press without first clicking the canvas, but it is silent and cannot be undone. MEDIUM stands.
- **EDIT-08** (EDIT; verdict CONFIRMED; severity LOW): Multi-selection is inconsistent: Ctrl+A then Delete also deletes hidden and locked widgets, while Lock, z-order, Save as Template and every Properties edit act only on one widget
  - Claim: The claim holds. selectAllWidgets selects every widget on the screen, hidden (not drawn, ScreenCanvas.tsx:269) and locked ones included (selectionSlice.ts:60-67). Keyboard Delete and context-menu Delete loop over all ids with no lock or visibility check. Ctrl+L, context-menu z-order, Lock and Save as Template act on selectedWidgetId only. selectedWidgetId is the FIRST widget in array order, not the right-clicked one, because onNodeContextMenu keeps the multi-selection when the clicked node is in it (ScreenCanvas.tsx:730-736). After Ctrl+A, right-clicking widget C and choosing Lock therefore locks widget A. Properties edits only selectedWidgetId and gives no multi-select hint, while AlignmentToolbar shows 'N selected'. This extends PLACE-21 and PLACE-04.
  - web/modules/sensor-module/src/store/scada/selectionSlice.ts:60-67 selectAllWidgets = all screen.widgets (no visible filter); selectedWidgetId = first
  - components/scada-builder/ScreenCanvas.tsx:269 the canvas hides visible===false widgets
  - hooks/useScadaKeyboardShortcuts.ts:86-92 (Delete: all ids) vs :139-148 (Ctrl+L: selectedWidgetId only)
  - components/scada-builder/CanvasContextMenu.tsx:150-160 (Delete: all ids) vs :180-247 (z-order, lock, template: selectedWidgetId)
  - components/scada-builder/PropertiesPanel.tsx:160-189 and pages/scada/usePropertiesPanelHandlers.ts:61-79 (single selectedWidget)
  - RAN scratchpad/editdel/misc-test.ts: Ctrl+A selects [A,B,H(hidden),K(locked)]; the delete loop leaves []; Ctrl+A + Ctrl+L locks only A
  - (verifier) web/modules/sensor-module/src/store/scada/selectionSlice.ts:60-67
  - (verifier) components/scada-builder/ScreenCanvas.tsx:266-269 (visible===false filtered from canvas), 730-736 (context menu preserves selection)
  - (verifier) hooks/useScadaKeyboardShortcuts.ts:86-92 (all ids) vs 139-148 (selectedWidgetId)
  - (verifier) components/scada-builder/CanvasContextMenu.tsx:150-160 (all ids) vs 180-247 (selectedWidgetId)
  - (verifier) pages/scada/usePropertiesPanelHandlers.ts:61-79 and PropertiesPanel.tsx:160-182 (single selectedWidget); AlignmentToolbar.tsx:72-79
  - (verifier) RAN (rebuilt harness misc-test): Ctrl+A -> [A,B,H(hidden),K(locked)], Properties shows A; delete loop -> []; Ctrl+A+Ctrl+L -> only A toggled
  - Verifier: These are direct reads with a reproduced run. The hidden-widget deletion is silent and cannot be undone, but it needs Ctrl+A, so LOW.
- **PLACE-21** (PLACE; verdict CONFIRMED; severity LOW): Delete leaves stale multi-selection ids, and lock does not prevent deletion or Properties position and size edits
  - Claim: removeWidget clears selectedWidgetId but not selectedWidgetIds. After a multi-delete, the AlignmentToolbar keeps showing 'N selected' for deleted ids. Lock is not enforced on delete (keyboard and context menu) or on Properties position and size edits: updateWidget has no lock check, while updateWidgetPosition does. Properties W/H edits on a locked widget visibly resize it; X/Y edits are saved but not shown (PLACE-03).
  - store/scada/widgetSlice.ts:56-59 only 'if (state.selectedWidgetId === widgetId) state.selectedWidgetId = null'; selectedWidgetIds untouched
  - components/scada-builder/AlignmentToolbar.tsx:72 renders while selectedWidgetIds.length >= 2
  - hooks/useScadaKeyboardShortcuts.ts:86-92 and CanvasContextMenu.tsx:150-160 call removeWidget with no lock check
  - widgetSlice.ts:74-83 updateWidgetPosition returns if locked, but L64-72 updateWidget (used by GeneralPropertiesSection.tsx:64-91) does not check the lock
  - (verifier) store/scada/widgetSlice.ts:56-59 selectedWidgetIds untouched; L64-72 updateWidget has no lock check vs L80 'if (widget.locked) return'
  - (verifier) components/scada-builder/AlignmentToolbar.tsx:72 renders when length >= 2
  - (verifier) hooks/useScadaKeyboardShortcuts.ts:86-92 and CanvasContextMenu.tsx:150-160 removeWidget without a lock check
  - Verifier: This is a direct read. Minor.
- **GROUP-01** (OPS; verdict CONFIRMED; severity MEDIUM): Clicking any member of a group opens the properties of the group's first widget
  - Claim: Holds. ReactFlow's select change fires first (setSelectedWidget(clicked)) and onNodeClick then overwrites it with groupWidgetIds[0].
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:706-713
  - web/modules/sensor-module/src/store/scada/selectionSlice.ts:47-58
  - web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:62-81 (panel shows selectedWidgetId)
  - (verifier) components/scada-builder/ScreenCanvas.tsx:706-713 (selectGroup on click of a grouped widget), 543-545 (select change sets the clicked id first)
  - (verifier) store/scada/selectionSlice.ts:47-58 (selectedWidgetId = groupWidgetIds[0])
  - (verifier) pages/scada/usePropertiesPanelHandlers.ts:61-79 (panel shows selectedWidgetId)
  - Verifier: The clicked id is never passed to selectGroup. The ordering argument rests on xyflow 12 calling onClick after the selection change, which is its documented NodeWrapper behaviour (package.json pins @xyflow/react 12.11.0).

</details>

### SENSOR-HIGH-304

**Equipment geometry makes straight connections impossible: canvas height comes from the SVG aspect ratio (not the stored size) while snapping is 100 px rows, so mating ports of adjacent equipment can never be collinear; sub-cell positions and resizes are silently rounded; ports of process widgets float off the drawing**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 5, PARTIAL 2; re-checked in session
- Severity note: Raised from MEDIUM: it is the user-reported blocker of the core editing task, and the arithmetic proves mating ports can never be collinear.
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** For equipment, ScadaWidgetNode replaces the stored height with width/viewBoxAspect, both for rendering and for handle placement. The stored and saved h is h*100. Examples: pump 2x2 is drawn 240x240 but stored 240x200; verticalTank 3x4 is 360x504 vs 360x400; pressureTransmitter (no subtype size, so 2x2) is 240x300 vs 240x200. Handles sit at offset% of the drawn height, so a pump outlet (row*100+0.5*w*120) and a gate-valve inlet (row*100+0.5*w\*96) line up for exactly one size combination: pump w=4 (480x480) with valve w=5 (600x480), same row. Every default and realistic size leaves a 12-36 px step in the pipe. Alignment, SmartGuides and resize all use the stored h, not the drawn one. Resize limits come from the generic 'equipment' entry (1x1..6x6), not EQUIPMENT_SUBTYPE_SIZES. Correction: builder Preview/Simulation uses the same ScadaWidgetNode, so it looks identical to edit mode, not shorter. The size mismatch is visible only in ScadaViewport popups and modals; OperatorView shows '?' boxes (PLACE-01) and the edge rejects equipment (EDGE-02).

**What the user sees.** Tanks and transmitters overlap the widget below them in the builder but look shorter and letterboxed in preview or runtime. A pipe from a pump outlet to a valve inlet in the same row always has a small step and can never be drawn straight. Moving the valve one row up or down overshoots.

**Root cause.** The aspect-ratio lock was applied as a rendering override in the node instead of being reflected in the stored size. The 120x100 non-square cell makes aspect-correct heights impossible to represent in grid units.

**Fix direction.** Make stored geometry the single truth. Either store pixel or sub-cell geometry for equipment and render exactly that everywhere, or make the default and resize sizes aspect-consistent in grid units and drop the override. Use the subtype constraints. Add a test that rendered node size equals gridToPixel(position) for every palette item.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:272-279`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:8`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:148`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:130-133`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:186-189`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:100-103`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:208-218`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:259-266`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:8,21,35,61`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:148,155,165`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:229-238`
- `web/modules/sensor-module/src/store/scada/alignmentUtils.ts:87-99,119-134`
- `web/modules/sensor-module/src/components/scada-builder/SmartGuides.tsx:55-66`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1066-1073`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:501-515`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:37-49`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:924`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:410-418`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:240-259`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:907-941`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:498-515`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:395-418`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:272-285`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:240-257`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-15,37-48`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:239-258`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:36-48`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:395-403`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:250-256`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:929-930`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:390-404`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:943-948`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-18`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:93-102`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:602-625`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:628-654`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:100-202`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:628-689`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:255-264`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:637-644`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/MbbrRenderer.tsx:66-71`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CornellDualDrainRenderer.tsx:84-90`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/HepaFilterRenderer.tsx:60-61`
- `web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-15`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/CornellDualDrainRenderer.tsx:85-90`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/HepaFilterRenderer.tsx:56-61`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/FeederRenderer.tsx:80-85`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/RadialFilterRenderer.tsx:33-38`

<details><summary>Merged audit findings and full evidence</summary>

- **PLACE-06** (PLACE; verdict PARTIAL; severity MEDIUM): Equipment height on the builder canvas comes from the SVG aspect ratio, not the stored h, so builder and runtime sizes differ and handles can never line up
  - components/scada-builder/nodes/ScadaWidgetNode.tsx:272-279 'if (isEquipment && svgAspectRatio > 0) setSize({ width: data.width, height: Math.round(data.width / svgAspectRatio) })'
  - components/scada-builder/equipment-symbols/types.ts:8 centrifugalPump 100x100, :21 gateValve 100x80, :35 verticalTank 100x140, :61 pressureTransmitter 80x100
  - constants/scada-widget-sizes.ts:148 centrifugalPump 2x2, :155 gateValve 2x2, :165 verticalTank 3x4
  - runtime: engine/views/ScadaViewport.tsx:130-133 and components/scada-operator/OperatorView.tsx:186-189 use position.h \* GRID_CELL_H
  - handle placement: ScadaWidgetNode.tsx:639-644 top = offset\*100% of the node box; equipment-symbols/types.ts:100-103 and gateValve both at offset 0.5
  - constraints: ScadaWidgetNode.tsx:146 WIDGET_SIZE_CONSTRAINTS[data.widgetType] -> constants/scada-widget-sizes.ts:208-218 getWidgetPixelConstraints(widgetType) without the subtype
  - (verifier) components/scada-builder/nodes/ScadaWidgetNode.tsx:259-266 svgAspectRatio from EQUIPMENT_VIEWBOX; L272-279 setSize({ width, height: round(width/aspect) })
  - (verifier) components/scada-builder/equipment-symbols/types.ts:8,21,35,61 viewBoxes; L150-153 gateValve ports at offset 0.5; constants/scada-widget-sizes.ts:148,155,165 subtype sizes
  - (verifier) ScadaWidgetNode.tsx:628-645 handle top = offset\*100% of the drawn container; L76-83 + scada-widget-sizes.ts:229-238 getWidgetPixelConstraints(widgetType) without the subtype
  - (verifier) store/scada/alignmentUtils.ts:87-99,119-134 align bottom/center use stored h; components/scada-builder/SmartGuides.tsx:55-66 use stored w/h
  - (verifier) runtime: engine/views/ScadaViewport.tsx:130-133 h\*GRID_CELL_H; ScreenCanvas.tsx:1066-1073 Preview mounts the same ScadaWidgetNode
  - (verifier) enumerated pump (aspect 1) vs gateValve (aspect 1.25) for w 1..6 and row offsets -8..8: the only aligned combination is (pump w=4, valve w=5, same row)
  - Verifier: The mechanism is correct. 'No integer combination' is overstated by one absurd case. The 'shorter in preview' symptom is wrong for the builder preview and moot for most runtimes. This is a visual and P&ID-fidelity defect and does not block a process from working, so MEDIUM.
- **PLACE-07** (PLACE; verdict CONFIRMED; severity MEDIUM): Sub-cell positions and sizes are shown in the builder but silently rounded or discarded in the saved package
  - Claim: Only the store is saved. Drag end rounds to whole 120x100 cells and clamps negatives to 0, and existing nodes keep their local position anyway (PLACE-03 merge). With Snap off, with 5 px arrow nudges (snap off), or after dragging above or left of the origin, the canvas and the store diverge. Resize is never snapped. Pointer-up rounds w/h, and if the rounded value is unchanged, data.width/height don't change, so the node keeps its unsaved pixel size. The drop path has the same clamp: dropping at negative flow coordinates stores col/row 0, so the widget appears at the origin, possibly off-screen and stacked on other widgets. This duplicates RESIZE-01.
  - components/scada-builder/ScreenCanvas.tsx:501-515 pixelToGrid(change.position...) then syncingFromStore.current = true before updateWidgetPosition; L357-360 skips that sync
  - constants/scada-widget-sizes.ts:37-49 pixelToGrid uses Math.round to cells and Math.max(0, ...) clamping
  - ScreenCanvas.tsx:924 snapToGrid={!isPreview && snapEnabled}, toggled from CanvasSettings at L1014-1016; React Flow arrow-key nudge moves 5 px without snap (@xyflow/react index.js:1711-1712)
  - resize: nodes/ScadaWidgetNode.tsx:410-418 onPointerUp -> ScreenCanvas.tsx:240-259 handleWidgetResize -> pixelToGrid width/height
  - ScadaWidgetNode.tsx:272-285 resize sync effect depends only on [data.width, data.height, ...]
  - no canvas extent: ScreenCanvas.tsx:907-941 sets no nodeExtent or translateExtent, so negative positions are reachable but stored as col/row 0
  - (verifier) components/scada-builder/ScreenCanvas.tsx:498-515 pixelToGrid(change.position) and commit; L367-372 existing nodes keep the local position
  - (verifier) constants/scada-widget-sizes.ts:37-49 Math.round + Math.max(0, ...)
  - (verifier) ScreenCanvas.tsx:924 snapToGrid={!isPreview && snapEnabled}; @xyflow/react index.js:1706-1712 moveSelectedNodes 5 px when snapToGrid is false
  - (verifier) resize: nodes/ScadaWidgetNode.tsx:395-418 local px size -> onResize -> ScreenCanvas.tsx:240-259 pixelToGrid(width,height); ScadaWidgetNode.tsx:272-285 effect deps [data.width, data.height]
  - (verifier) ScreenCanvas.tsx:907-941 no nodeExtent/translateExtent; onDrop L828-847 screenToFlowPosition -> round -> pixelToGrid clamp
  - Verifier: The code holds as described. Snap is on by default, and in that mode drags commit exactly, so the common path is fine. The divergence needs snap off, a small resize, or negative coordinates. It is silent but bounded (under one cell, except for the negative-coordinate collapse). MEDIUM, matching RESIZE-01.
- **RESIZE-01** (OPS; verdict CONFIRMED; severity MEDIUM): Resize and snap-off show sizes and positions that are not what gets saved
  - Claim: Holds. Duplicate of PLACE-07.
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:272-285 (sync only on data.width/height change), 410-417 (onResize with local px)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:240-257 (pixelToGrid on resize), 498-515 (pixelToGrid on drag end), 135,924 (snap toggle affects only RF snapping)
  - web/modules/sensor-module/src/constants/scada-widget-sizes.ts:14-15,37-48 (120x100 rounding)
  - (verifier) nodes/ScadaWidgetNode.tsx:272-285 (sync only on data.width/height change), 400-417 (local px resize → onResize)
  - (verifier) ScreenCanvas.tsx:239-258 (pixelToGrid on resize), 501-515 (pixelToGrid on drag end; syncingFromStore skips the next sync), 924-925 (snap toggle affects only RF snapping)
  - (verifier) constants/scada-widget-sizes.ts:36-48 (Math.round to 120x100 cells)
  - Verifier: No feedback path pushes the rounded store geometry back onto the node.
- **PLACE-08** (PLACE; verdict PARTIAL; severity MEDIUM): Custom resize handles ignore canvas zoom, and the W/N handles grow the opposite edge
  - Claim: Resize uses raw clientX/clientY deltas in screen px but applies them to flow-unit sizes inside a viewport scaled by zoom, and N/W handles never move the origin. The direction of the zoom error is reversed in the claim. At zoom 0.5 the widget's on-screen edge moves only half as far as the cursor (it lags or undershoots). At zoom 2 it moves twice as far (it overshoots). Pulling the W handle leftwards increases w with col unchanged, so the right edge moves right, away from the cursor. The N handle behaves the same way vertically.
  - components/scada-builder/nodes/ScadaWidgetNode.tsx:395-403 'const dx = e.clientX - startX ... if (dir.includes('w')) w = startW - dx; if (dir.includes('n')) h = startH - dy' with no zoom factor and no position change
  - ScadaWidgetNode.tsx:410-418 onPointerUp passes only width and height
  - components/scada-builder/ScreenCanvas.tsx:250-256 handleWidgetResize keeps widget.position.col and row unchanged
  - ScreenCanvas.tsx:929-930 minZoom 0.2 / maxZoom 2
  - (verifier) components/scada-builder/nodes/ScadaWidgetNode.tsx:390-404 dx = e.clientX - startX; w = startW - dx for 'w', h = startH - dy for 'n'; no zoom factor
  - (verifier) ScadaWidgetNode.tsx:420-454 container width/height = size (flow units, inside the React Flow viewport transform scale(zoom))
  - (verifier) ScadaWidgetNode.tsx:410-418 onResize(width,height) only; ScreenCanvas.tsx:240-259 keeps position.col/row
  - Verifier: The defect is real, but the stated zoom direction and the 'zoomed out overshoots wildly' symptom are inverted: on-screen growth = dx\*zoom. N/W behaviour is as claimed. It is annoying with workarounds (zoom 1, use E/S handles), so MEDIUM.
- **PLACE-13** (PLACE; verdict CONFIRMED; severity LOW): The background dot grid is 120x120 px but snapping is 120x100 px
  - Claim: <Background gap={GRID_CELL_W}> gives 120x120 dots while snapping is 120x100 (SNAP_GRID), so the dots drift off snapped rows.
  - components/scada-builder/ScreenCanvas.tsx:943-948 <Background gap={GRID_CELL_W} ...>
  - constants/scada-widget-sizes.ts:14-18 GRID_CELL_W=120, GRID_CELL_H=100, SNAP_GRID=[120,100]
  - @xyflow/react@12.11.0 index.js:4366 gapXY = Array.isArray(gap) ? gap : [gap, gap]
  - (verifier) components/scada-builder/ScreenCanvas.tsx:943-948 gap={GRID_CELL_W}
  - (verifier) constants/scada-widget-sizes.ts:14-18 SNAP_GRID [120,100]
  - (verifier) @xyflow/react index.js:4366 gapXY = Array.isArray(gap) ? gap : [gap, gap]
  - Verifier: This is a direct read of both sides. Cosmetic.
- **CONN-12** (CONN; verdict CONFIRMED; severity MEDIUM): Resize grips sit on top of the side-midpoint ports of a selected widget
  - Claim: Confirmed by reading the CSS of the shipped xyflow version (not run in a browser). With a widget selected, the 6x6 px n/s/e/w resize grips (zIndex 100, pointer-events all, centred about 1 px outside each side midpoint) sit in the same stacking context as the 10x10 px port Handles. xyflow gives handles no z-index and centres them on the side edge (`right:0; transform: translate(50%,-50%)`). The grip covers the central about 6x6 px of a side-midpoint port, so pressing the dot's centre starts a resize (preventDefault plus stopPropagation). Only the outer 2-3 px ring of the dot still starts a connection. This affects every pump and valve inlet and outlet at offset 0.5 and every tank top/bottom port, and only while the node is selected.
  - nodes/ScadaWidgetNode.tsx:93-102 HANDLE_META n/s/e/w at 50% of each side
  - nodes/ScadaWidgetNode.tsx:602-625 grips rendered when `selected && !locked`, zIndex 100, pointerEvents 'all'. :368-389 onPointerDown calls preventDefault and stopPropagation
  - nodes/ScadaWidgetNode.tsx:628-654 ports rendered after the grips at `${offset*100}%` on the same sides
  - equipment-symbols/types.ts:100-202 the inlet and outlet of nearly every pump and valve are left/right at offset 0.5. :204-235 tank inlets and outlets are top/bottom at offset 0.5
  - (verifier) nodes/ScadaWidgetNode.tsx:93-102 HANDLE_META n/s/e/w at 50% with offsets -4; :602-625 grips when `selected && !locked`, zIndex 100, pointerEvents 'all', 6x6 (10x10 corners); :368-389 onPointerDown preventDefault + stopPropagation
  - (verifier) nodes/ScadaWidgetNode.tsx:628-689 Handles rendered after the grips, 10x10, top/left `${offset*100}%`, no zIndex; :445-450 container position relative + zIndex 500+ (one stacking context)
  - (verifier) @xyflow/react 12.11.0 dist/style.css `.react-flow__handle { position:absolute; pointer-events:none; ... }` (no z-index); `.react-flow__handle-right { top:50%; right:0; transform: translate(50%, -50%) }`; `.connectionindicator { pointer-events: all }`
  - (verifier) equipment-symbols/types.ts CONNECTION_POINTS dump: centrifugalPump/gateValve/... inlet left 0.5 and outlet right 0.5; verticalTank inlet top 0.5 and outlet bottom 0.5
  - Verifier: The auditor marked this SUSPECTED because the xyflow CSS was not available. I installed @xyflow/react@12.11.0 in the scratchpad and read its stylesheet. The geometry and z-order support the claim. The resize it triggers also cannot be undone (CONN-09).
- **CONN-14** (CONN; verdict CONFIRMED; severity MEDIUM): Ports on feeder, MBBR, HEPA, radial filter, water tanks and Cornell drain float away from the drawing
  - Claim: Confirmed. Only widgetType 'equipment' is aspect-locked, while the 7 process widgets with ports render an 8 px-padded SVG with xMidYMid meet, and their Handles sit at container-edge percentages. Default-size gaps: MBBR 3x2 (360x200) is height-limited (scale 184/106 = 1.74, drawn width about 243 of 344), leaving about 58 px of empty space on each side before the viewBox edge. Cornell 4x3 leaves about 62 px. The 2x3 widgets (feeder, radialFilter, clean/dirty tank) leave about 8-14 px. Free resizing widens the gaps.
  - nodes/ScadaWidgetNode.tsx:255-264 svgAspectRatio is computed only when widgetType === 'equipment'. :334-366 clamp locks the ratio only for equipment
  - nodes/ScadaWidgetNode.tsx:637-644 handles are at `${offset*100}%` of the container
  - widget-renderers/MbbrRenderer.tsx:66-71 `padding: 8`, viewBox 0 0 140 106, xMidYMid meet. CornellDualDrainRenderer.tsx:84-90 viewBox 200x160. HepaFilterRenderer.tsx:60-61 viewBox 140x86
  - constants/scada-widget-sizes.ts:14-15 GRID 120x100. :91-97 mbbr 3x2, cornellDualDrain 4x3, hepaFilter 3x2, feeder/radialFilter/cleanWaterTank/dirtyWaterTank 2x3
  - (verifier) nodes/ScadaWidgetNode.tsx:255-264 svgAspectRatio only when isEquipment; :334-366 clamp locks the ratio only for equipment; :637-644 handle offsets in % of the node box
  - (verifier) widget-renderers/MbbrRenderer.tsx:66-71 padding 8, viewBox 0 0 140 106, meet; CornellDualDrainRenderer.tsx:85-90 200x160; HepaFilterRenderer.tsx:56-61 140x86; FeederRenderer.tsx:80-85 and RadialFilterRenderer.tsx:33-38 120x160; Clean/DirtyWaterTankRenderer.tsx 120x140
  - (verifier) constants/scada-widget-sizes.ts:14-15 grid 120x100; :91-97 default sizes
  - Verifier: The arithmetic from the read values reproduces the auditor's figures for MBBR. The gaps are smaller for the 2x3 widgets but real.

</details>

### SENSOR-HIGH-305

**Rotating equipment rotates only the artwork; ports and node box stay unrotated, so pipes attach to the wrong side**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 2
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** Confirmed. All 52 equipment symbol files rotate only an inner <g transform=rotate()>. The SVG ConnectionPoints overlay, shown in edit mode via showConnectionPoints={isEditing}, is drawn outside that group, and the ReactFlow Handles come from the static CONNECTION_POINTS side and offset. Width and height are never swapped, and updateNodeInternals is never called. Non-square symbols clip: a gate valve (viewBox 100x80) rotated 90 degrees about (50,40) pushes its pipe stubs to y = -10 and y = 90, outside the viewBox. Worth keeping for the rewrite: the legacy process-editor BaseNode already rotates handle positions (rotatePoint plus getCardinalPosition) and calls updateNodeInternals on rotation. Duplicate of PLACE-09.

**What the user sees.** The user rotates a pump 90 degrees so it discharges upward. The orange outlet dot stays on the right edge, and pipes still leave from the right although the drawing points up. Rotated valves appear cut off.

**Root cause.** Rotation is implemented as a renderer-internal SVG transform rather than a property of the node's port geometry.

**Fix direction.** Derive port side and offset from (CONNECTION_POINTS, rotation) in one function used by both the Handles and the SVG overlay, and swap the node width and height for 90/270. Call updateNodeInternals when rotation changes. Add a unit test that the rotated port map matches the rotated stubs.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:73,109-127`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:124`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/pumps/CentrifugalPumpSymbol.tsx:26`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/GateValveSymbol.tsx:33`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/tanks/VerticalTankSymbol.tsx:26`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/ThreeWayValveSymbol.tsx:27`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:534-544`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:98-373`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:73,118`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:125-126`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/valves/GateValveSymbol.tsx:29`
- `web/modules/sensor-module/src/components/process-editor/nodes/BaseNode.tsx:80-82`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:125`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:121-127`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:534-544,628-689`

<details><summary>Merged audit findings and full evidence</summary>

- **CONN-08** (CONN; verdict CONFIRMED; severity HIGH): Rotating equipment rotates the drawing but not its ports, so pipes attach to the wrong side
  - widget-configs/EquipmentConfig.tsx:73,109-127 writes config.rotation
  - widget-renderers/EquipmentRenderer.tsx:124 passes rotation to the symbol
  - equipment-symbols/pumps/CentrifugalPumpSymbol.tsx:26 `<g transform=rotate(... 50 50)>` closes at :128. ConnectionPoints at :134-139 is outside the group. The same pattern is in GateValveSymbol.tsx:33/101/104, VerticalTankSymbol.tsx:26/172/175 and ThreeWayValveSymbol.tsx:27/82/84
  - nodes/ScadaWidgetNode.tsx:534-544 handles come from CONNECTION_POINTS[subType]. :628-689 Handle position and offset come from pt.side and pt.offset with no use of config.rotation
  - equipment-symbols/types.ts:98-373 CONNECTION_POINTS are static per subtype
  - (verifier) widget-configs/EquipmentConfig.tsx:73,118 onChange({rotation: deg})
  - (verifier) widget-renderers/EquipmentRenderer.tsx:125-126 rotation and showConnectionPoints={isEditing}
  - (verifier) equipment-symbols/pumps/CentrifugalPumpSymbol.tsx:26 <g rotate>, closed before :134-139 <ConnectionPoints>; grep: 52/52 symbol files use `rotate(${rotation`
  - (verifier) equipment-symbols/valves/GateValveSymbol.tsx:29 viewBox 0 0 100 80, :33 rotate(... 50 40), :35-41 stubs x 0..20 and 80..100
  - (verifier) nodes/ScadaWidgetNode.tsx:534-544 and :628-689 use pt.side and pt.offset only; grep 'rotation' in ScadaWidgetNode/ScreenCanvas finds no port use; no useUpdateNodeInternals in scada-builder
  - (verifier) contrast: components/process-editor/nodes/BaseNode.tsx:80-82 updateNodeInternals on rotation; :107-121 rotatePoint for handle placement
  - Verifier: Both sides were read. No mapper rotates ports. The rotation feature fails outright for any connected equipment, and vertical piping runs cannot be drawn correctly, so HIGH stays.
- **PLACE-09** (PLACE; verdict CONFIRMED; severity MEDIUM): Equipment rotation turns only the artwork; ports, connection dots and node box stay unrotated, so pipes attach to the wrong side
  - Claim: EquipmentConfig writes config.rotation (0/90/180/270). Each symbol applies it only to an inner <g rotate()>, and its ConnectionPoints dots are drawn outside that group. ScadaWidgetNode places React Flow Handles from CONNECTION_POINTS side/offset only, never reads rotation, never swaps w/h and never calls updateNodeInternals. Pipes therefore attach to the unrotated sides. Non-square symbols are clipped: a gate valve's 100-unit pipe stubs rotated about (50,40) span y -10..90 inside a 0..80 viewBox. TransformConfig is not offered for equipment. This duplicates CONN-08.
  - writer: components/scada-builder/widget-configs/EquipmentConfig.tsx:73,118 onChange({ rotation: deg })
  - reader: widget-renderers/EquipmentRenderer.tsx:125 rotation={(config.rotation as number) \|\| 0}
  - equipment-symbols/pumps/CentrifugalPumpSymbol.tsx:26 <g transform={`rotate(${rotation} 50 50)`}>; L134-139 <ConnectionPoints> rendered after the group closes (not rotated)
  - equipment-symbols/valves/GateValveSymbol.tsx:29 viewBox 0 0 100 80, L33 rotate(... 50 40)
  - nodes/ScadaWidgetNode.tsx:534-544 and 628-689 Handle position from pt.side and pt.offset only; never reads config.rotation
  - TransformConfig is rendered only by SvgShapeConfig, SvgPathConfig, RasterImageConfig, SvgEllipseConfig and CustomSvgConfig (grep '<TransformConfig'), not EquipmentConfig
  - (verifier) reader: widget-renderers/EquipmentRenderer.tsx:121-127 rotation={config.rotation}, showConnectionPoints={isEditing}
  - (verifier) equipment-symbols/pumps/CentrifugalPumpSymbol.tsx:26 <g rotate(... 50 50)>; L134-139 ConnectionPoints after the group
  - (verifier) equipment-symbols/valves/GateValveSymbol.tsx:29 viewBox 0 0 100 80; L33 rotate(... 50 40); L35-40 stubs x 0..20 and 80..100 at y 40
  - (verifier) nodes/ScadaWidgetNode.tsx:534-544,628-689 Handle position from pt.side/offset; grep 'rotation\|updateNodeInternals' in ScadaWidgetNode/ScreenCanvas: none
  - (verifier) grep '<TransformConfig' -> SvgShapeConfig, SvgPathConfig, RasterImageConfig, SvgEllipseConfig, CustomSvgConfig only
  - Verifier: I read both the writer and the reader. Pipes are drawn only in the builder: no runtime renders them, and the edge rejects equipment. The impact is builder-only drawing fidelity with a workaround (don't rotate), so MEDIUM rather than HIGH.

</details>

### SENSOR-HIGH-306

**Pipe model is geometric, not topological: orthogonal/bezier/polyline routes freeze to absolute bend points and stop following equipment, routing ignores port side, bends stay editable in preview, and line-type clicks erase custom routes**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 7, PARTIAL 1, SELF 2
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** Confirmed empirically, and the freeze happens at MOUNT, not on the first move (PLACE-10's timing is inaccurate). Rendering the real OrthogonalEdge with data {connectionType} (exactly what onConnect stores) writes {bendPoints:[{250,100},{250,200}]} to the store with no user action. After the target moves from (400,200) to (400,500), the path is 'M100,100 H250 V200 H400 V500', still routed through the stale corners. The stored bends never change. The pipe still ends on both ports, so topology is intact, but auto-routing never runs again.

**What the user sees.** The user draws a pipe from pump to tank, then drags the tank. The pipe keeps its old corner positions and draws an odd staircase or back-tracking spike instead of re-routing. Every pipe has to be redrawn after layout changes.

**Root cause.** Auto-computed geometry and user-customised geometry share the same field, and the component persists auto geometry as if the user had edited it.

**Fix direction.** Persist bend points only from explicit user edits (on drag-end, insert or delete), and keep auto-routing derived, never stored. Alternatively, store bends relative to endpoints. Add a component test: mount, move the target node, and the path must have no stale corner.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:131`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:575-587`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:230-237`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:23-31`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:337-341`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:256-261`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:30`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:370`
- `web/modules/sensor-module/src/components/scada-builder/edges/DraggableEdge.tsx:96-106`
- `web/modules/sensor-module/src/components/scada-builder/edges/MultiHandleEdge.tsx:172-178`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:187-197`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:160-176`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:179-190`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:256-261,272`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:74-83`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:160-163`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:55-84`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:225-236`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:204-235,295-298`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:459-479`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:391-400`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:890`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:400`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:460-479`
- `web/modules/sensor-module/src/components/scada-builder/edges/MultiHandleEdge.tsx:329-338`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:889`
- `web/modules/sensor-module/postcss.config.js`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:227`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:143-149`
- `web/modules/sensor-module/src/components/scada-builder/EdgeToolbar.tsx:108`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:783-792`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:33-46`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:260`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:219-237`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:33-47`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:256-262`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:796-864`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:794-803`
- `web/modules/sensor-module/src/pages/scada/usePropertiesPanelHandlers.ts:135-149`
- `web/modules/sensor-module/src/components/scada-builder/edges/DraggableEdge.tsx:224-243`
- `web/modules/sensor-module/src/config/connectionTypes.ts:32`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:656-662`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:932`

<details><summary>Merged audit findings and full evidence</summary>

- **CONN-04** (CONN; verdict CONFIRMED; severity HIGH): Orthogonal pipes (the default) freeze their auto-route and stop following the equipment
  - ScreenCanvas.tsx:131 defaultEdgeType = 'orthogonal'. ScreenCanvas.tsx:575-587 onConnect creates the edge with data {connectionType} only (no bendPoints)
  - OrthogonalEdge.tsx:270-276 the mount and endpoint-move effect calls setBendPoints(calculateOrthogonalPath(...)) (a new array) only when `!data.bendPoints \|\| length===0`
  - OrthogonalEdge.tsx:284-291 the persist effect skips only the first render, then calls updateEdgeData(id,{bendPoints}) on the re-render caused by the mount setBendPoints
  - ScreenCanvas.tsx:230-237 + store/scada/edgeSlice.ts:23-31 Object.assign(edge.data,{bendPoints}), which rfEdges (ScreenCanvas.tsx:337-341) feeds back as data.bendPoints
  - OrthogonalEdge.tsx:101-110 buildOrthogonalPath inserts 'H x V y' steps between the new endpoint and the stale bends
  - (verifier) edges/OrthogonalEdge.tsx:256-261 initialBends; :270-276 recalc only when `!data?.bendPoints \|\| length===0`; :284-291 persist effect skips only the first render
  - (verifier) ScreenCanvas.tsx:131 defaultEdgeType 'orthogonal'; :575-587 onConnect data {connectionType} only; :230-237 edgeStoreValue.updateEdgeData -> store; :324-348 rfEdges feed e.data back
  - (verifier) store/scada/edgeSlice.ts:23-31 Object.assign(edge.data, data)
  - (verifier) harness run (scratchpad/harness/edges-test.tsx, real component under jsdom and React 19.2.7): '[ORTHO] writes after mount (no user action): [{"bendPoints":[{"x":250,"y":100},{"x":250,"y":200}]}]'; 'path after moving target to (400,500): M100,100 H250 V200 H400 V500'
  - Verifier: I tried to find a path that clears data.bendPoints on node move (ScreenCanvas, edgeSlice, a node-drag handler) and found none. The only clear is updateEdgeType. The real component reproduces the freeze. HIGH is kept: the 'automatic orthogonal routing' the component advertises works for exactly one render.
- **PLACE-10** (PLACE; verdict PARTIAL; severity HIGH): Orthogonal pipe bend points freeze after the first endpoint move and then route to stale absolute coordinates
  - Claim: OrthogonalEdge (the default type) auto-routes only while data.bendPoints is empty. A persist effect writes every bendPoints state change to the store. On mount, the recalc effect replaces state with a fresh array, which triggers the persist effect. The auto route is therefore persisted immediately after the pipe is created, with no user action, not 'the first time an attached pump moves'. From then on, every endpoint move draws source -> stale absolute bends -> target, with H/V detours. The route freezes before the first move.
  - components/scada-builder/edges/OrthogonalEdge.tsx:256-261 initial bends; L271-276 'if (!data?.bendPoints \|\| data.bendPoints.length === 0) setBendPoints(calculateOrthogonalPath(...))'
  - OrthogonalEdge.tsx:284-291 persist effect: after the first render, every bendPoints change calls updateEdgeData(id, { bendPoints })
  - bridge: components/scada-builder/ScreenCanvas.tsx:230-237 edgeStoreValue.updateEdgeData -> store; L337-341 rfEdges pass e.data back into the edge
  - OrthogonalEdge.tsx:89-110 buildOrthogonalPath draws source -> each absolute bend -> target
  - ScreenCanvas.tsx:131 defaultEdgeType 'orthogonal'
  - (verifier) components/scada-builder/edges/OrthogonalEdge.tsx:256-261 initialBends; L271-276 recalc only when data.bendPoints is empty; L284-291 persist effect skips only the first render
  - (verifier) ScreenCanvas.tsx:230-237 updateEdgeData bridge to the store; L325-341 rfEdges pass e.data (including bendPoints) back; L131 defaultEdgeType 'orthogonal'
  - (verifier) OrthogonalEdge.tsx:89-110 buildOrthogonalPath through absolute bends
  - (verifier) proof run (scratchpad harness/out/edges-test.cjs, real OrthogonalEdge under React 19 + jsdom): '[ORTHO] writes after mount (no user action): [{bendPoints:[{x:250,y:100},{x:250,y:200}]}]'; after moving the target to (400,500) the path is 'M100,100 H250 V200 H400 V500' and the stored bends are unchanged
  - Verifier: The executed harness confirms the freeze and shows it is earlier than claimed. Connecting and moving equipment is the core P&ID editing loop, and every pipe breaks on the first move and stays broken after save. HIGH for builder usability, even though no runtime renders pipes (PLACE-02).
- **CONN-05** (CONN; verdict CONFIRMED; severity MEDIUM): Bezier and polyline pipes freeze after reload, and opening a package marks it dirty
  - Claim: Confirmed with the real components and the real store. (a) A fresh DraggableEdge (quadratic) persists {controlPoint} on mount. After a reload, userDraggedCP1 is true, the control point stays at Q290,110 after the target moves, and the mount still writes {controlPoint} because controlPoint2 is re-derived. (b) MultiHandleEdge writes on mount (1 write, even with stored points) and once per drag frame (5 writes for 5 frames). Its interior waypoints are fixed from CREATION, not only after a reload: moving the target gives 'L250,200 L400,500', a diagonal last segment. (c) After the real loadFromJSON, isDirty is false, and an updateEdgeData with an identical value sets it to true. Orthogonal edges loaded without stored bends (for example the RAS demo template, whose edges carry routingMode but no bendPoints) also dirty the package on open.
  - DraggableEdge.tsx:96-106 initial state and userDraggedCP refs derived from data.controlPoint/controlPoint2
  - DraggableEdge.tsx:109-122 the mount and endpoint effect creates new controlPoint objects when not user-dragged
  - DraggableEdge.tsx:144-155 the persist effect (deps include controlPoint2) writes {controlPoint} via updateEdgeData
  - MultiHandleEdge.tsx:190-198 the mount and endpoint effect always setPoints(copy). MultiHandleEdge.tsx:206-213 persists points on every change
  - store/scada/edgeSlice.ts:30 updateEdgeData sets state.isDirty = true. projectSlice.ts:370 loadFromJSON sets isDirty=false just before the edges mount
  - (verifier) edges/DraggableEdge.tsx:96-106 refs from data.controlPoint; :109-122 mount effect; :144-155 persist only {controlPoint} for quadratic
  - (verifier) edges/MultiHandleEdge.tsx:172-178 default points computed once; :190-198 sync moves only first and last point; :206-213 persist every change
  - (verifier) store/scada/edgeSlice.ts:30 isDirty=true; store/scada/projectSlice.ts:370 isDirty=false in loadFromJSON
  - (verifier) harness: '[DRAG reload] writes on mount (isDirty trigger): [{"controlPoint":...}]', 'path before move: M100,100 Q290,110 400,200 after move: M100,100 Q290,110 400,600', '[MULTI reload] writes on mount: 1', '[MULTI] writes during 5 drag frames: 5', '[MULTI fresh] after target move: M100,100 L250,100 L250,200 L400,500'
  - (verifier) real store (scratchpad/harness/store-test.ts): 'after loadFromJSON isDirty = false' then 'after a mount-time updateEdgeData (identical value) isDirty = true'
  - (verifier) pages/scada/ScadaPackageBuilderPage.tsx:187-197 beforeunload prompt on isDirty; :300-305 deploy triggers a save when isDirty
  - Verifier: Every sub-claim was reproduced. The spurious dirty flag causes 'unsaved changes' prompts and extra saves, and polyline and Bezier geometry stops following equipment. This is annoying but does not block a process from working, so MEDIUM is right.
- **CONN-11** (CONN; verdict CONFIRMED; severity MEDIUM): Pasted or duplicated pipes keep the original's absolute bend points
  - Claim: Confirmed against the real store. selectAll, copy and paste shift the pasted widget to col+1/row+1, but the pasted edge carries the original's absolute bendPoints unchanged. The same applies to MultiHandle 'points' and Bezier 'controlPoint'. The path is reachable via Ctrl+A then Ctrl+C/V or Ctrl+D, so the multi-select bugs in PLACE-04 do not hide it.
  - store/scada/selectionSlice.ts:160-176 newWidget.position.col += 1, row += 1
  - store/scada/selectionSlice.ts:179-190 `newEdge = deepClone(edge)`, with only id, source and target remapped. data.bendPoints, points and controlPoint are not translated
  - edges/OrthogonalEdge.tsx:256-261,272 the stored bends are used and auto-routing is skipped when they are present
  - hooks/useScadaKeyboardShortcuts.ts:74-83 Ctrl+D runs copy then paste, the same path
  - (verifier) store/scada/selectionSlice.ts:160-163 position.col += 1, row += 1; :179-190 deepClone(edge) with only id, source and target remapped
  - (verifier) edges/OrthogonalEdge.tsx:256-261 stored bends used, :272 no auto-route when present
  - (verifier) hooks/useScadaKeyboardShortcuts.ts:74-83 Ctrl+D; :104-109 Ctrl+A selectAllWidgets
  - (verifier) real store run: 'pasted widget pos: {"col":1,"row":1,...} pasted edge bends: [{"x":360,"y":120},...] orig bends: [{"x":360,"y":120},...]'
  - Verifier: Reproduced with the actual slice. The visual damage is fixable by dragging the always-visible bend squares, so MEDIUM is right.
- **CONN-13** (CONN; verdict CONFIRMED; severity MEDIUM): Pipe routing ignores port side, so pipes enter top/bottom ports sideways or cut through equipment
  - Claim: Confirmed. calculateOrthogonalPath picks horizontal-first or vertical-first from \|dx\| vs \|dy\| (or from data.routingMode, which only the demo template sets) and never uses sourcePosition or targetPosition. The component does not even destructure them, although xyflow passes them. MultiHandleEdge defaults to a horizontal-mid Z. Pipes into top/bottom ports arrive sideways, and routes can backtrack through the source or target body.
  - edges/OrthogonalEdge.tsx:55-84 calculateOrthogonalPath(source,target,mode) with no port direction. 'auto' compares \|dx\| and \|dy\| only
  - edges/OrthogonalEdge.tsx:225-236 sourcePosition and targetPosition are not destructured or used
  - edges/MultiHandleEdge.tsx:172-178 default points use midX at sourceY and targetY
  - equipment-symbols/types.ts:204-235,295-298 many top/bottom ports (tanks, bag filter, submersible pump)
  - (verifier) edges/OrthogonalEdge.tsx:55-84 calculateOrthogonalPath(source,target,mode); :226-236 props destructuring has no sourcePosition/targetPosition
  - (verifier) @xyflow/react dist/esm/index.js:2979 EdgeComponent receives sourcePosition/targetPosition
  - (verifier) edges/MultiHandleEdge.tsx:172-178 default midX at sourceY/targetY
  - (verifier) equipment-symbols/types.ts verticalTank/conicalBottomTank/silo/mixingTank/bagFilter/submersiblePump top/bottom ports
  - Verifier: The code clearly ignores port orientation. The pipe still connects, so the problem is cosmetic and legibility-related. MEDIUM is right.
- **CONN-10** (CONN; verdict CONFIRMED; severity MEDIUM): Orthogonal bend handles are always visible and stay editable in Preview/Simulation, changing the design
  - Claim: Confirmed, and the defect is slightly broader. In Preview and Simulation, xyflow marks edges 'inactive' (pointer-events:none on the <g>). Children with an explicit pointer-events value override the inherited one, so OrthogonalEdge's always-rendered bend rects ([pointer-events:all]) and the hit paths ([pointer-events:stroke]) of OrthogonalEdge AND MultiHandleEdge stay interactive. Dragging a bend square, or double-clicking a pipe (which adds a bend or a waypoint), writes to the store through EdgeStoreContext, which is provided in both modes, and sets isDirty. The bend squares also render on every unselected orthogonal edge.
  - edges/OrthogonalEdge.tsx:459-479 `bendPoints.map(...)` <rect> with onMouseDown/onContextMenu has no `selected` or preview gate (compare MultiHandleEdge.tsx:393 `selected && points.map`)
  - edges/OrthogonalEdge.tsx:391-400 the hit path with onDoubleClick adds a bend
  - ScreenCanvas.tsx:890 EdgeStoreContextProvider wraps the canvas in both modes. :230-237 updateEdgeData writes the store
  - pages/scada/ScadaPackageBuilderPage.tsx:400 `<ScreenCanvas isPreview={mode !== 'edit'} />`
  - (verifier) edges/OrthogonalEdge.tsx:460-479 bend rects with no `selected`/mode gate, class '[pointer-events:all] ...'; :391-400 hit path with onDoubleClick
  - (verifier) edges/MultiHandleEdge.tsx:329-338 hit path with onDoubleClick, not gated (only the circles at :393 are gated by `selected`)
  - (verifier) @xyflow/react 12.11.0 dist/style.css `.react-flow__edge.inactive { pointer-events: none; }`; dist/esm/index.js:2979 `inactive: !isSelectable && !onClick` (ScreenCanvas passes onEdgeClick undefined and elementsSelectable=false in preview, :911-935)
  - (verifier) ScreenCanvas.tsx:889 EdgeStoreContextProvider wraps both modes; pages/scada/ScadaPackageBuilderPage.tsx:400 isPreview={mode !== 'edit'}
  - (verifier) harness: '[ORTHO unselected] bend rects rendered: 2 class: [pointer-events:all] cursor-grab ...'
  - (verifier) web/modules/sensor-module/postcss.config.js uses @tailwindcss/postcss (v4 auto-detects arbitrary-property classes)
  - Verifier: I checked whether xyflow's preview gating blocks these events. It does not, because the explicit pointer-events values override the inherited 'none'. The double-click path on polyline edges is an additional instance.
- **CONN-V-01** (CONN-verifier; verdict SELF; severity LOW): Clicking a pipe's already-active line type silently erases its custom bends, flow binding and routing, while the canvas keeps showing them
  - Claim: Neither the Properties 'Line Type' buttons nor the EdgeToolbar shape buttons guard against choosing the current type. updateEdgeType then unconditionally replaces edge.data with {connectionType,label,animated}, deleting bendPoints, points, controlPoint, flowConfig and routingMode. Because the edge type does not change, the same edge component stays mounted, and its local geometry state is not re-derived from data, so the canvas still draws the old custom route. The next Save writes the package without the geometry, and after a reload, or the next equipment move, the pipe snaps back to the auto route.
  - writer: components/scada-builder/PropertiesPanel.tsx:227 onClick={() => onEdgeTypeChange?.(selectedEdge.id, opt.type)}, with the active type highlighted and still clickable
  - writer: pages/scada/usePropertiesPanelHandlers.ts:143-149 -> updateEdgeType; components/scada-builder/EdgeToolbar.tsx:108 -> ScreenCanvas.tsx:783-792 storeUpdateEdgeType
  - store/scada/edgeSlice.ts:33-46 edge.data = {connectionType,label,animated} with no same-type check
  - reader: edges/OrthogonalEdge.tsx:256-261 and :270-276 local bendPoints are re-derived only on endpoint or routingMode change, not on data change
  - persist: store/scada/projectSlice.ts:260 saves the store edges
  - real store run: updateEdgeType('S','E','orthogonal') on an orthogonal edge -> {"data":{"connectionType":"process-pipe"}} (bendPoints, flowConfig, routingMode gone)
  - harness (scratchpad/harness/sametype-test.tsx): canvas path stays 'M100,100 H150 V400 H350 V200 H400' after the reset while store data is {"connectionType":"process-pipe"}
- **EDIT-09** (EDIT; verdict CONFIRMED; severity LOW): Clicking the already-active line type on a pipe erases its hand-placed bends from the saved document while the canvas keeps showing them
  - Claim: DUPLICATE of CONN-V-01 (verdict_CONN_4.json); merge them. The claim holds. The Properties 'Line Type' buttons (PropertiesPanel.tsx:225-227) and the EdgeToolbar (ScreenCanvas.tsx:783-792) call updateEdgeType with no same-type guard. updateEdgeType replaces edge.data with {connectionType,label,animated} (edgeSlice.ts:33-47). One nuance: if the edge had an explicit routingMode, the change to 'auto' re-triggers OrthogonalEdge's effect (OrthogonalEdge.tsx:270-276), and the canvas visibly re-routes and persists. Only the built-in RAS demo sets routingMode; no UI does. For user-drawn pipes the canvas keeps the old bends while the store has none.
  - web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:219-237 button onClick -> onEdgeTypeChange(id, opt.type) even when selectedEdge.type === opt.type
  - components/scada-builder/ScreenCanvas.tsx:783-792 handleEdgeTypeChange -> storeUpdateEdgeType when an edge is selected
  - web/modules/sensor-module/src/store/scada/edgeSlice.ts:33-47 edge.data = { connectionType, label, animated }
  - components/scada-builder/edges/OrthogonalEdge.tsx:256-262 initialBends useMemo([]); :270-276 recalculated only on endpoint change; :285-291 persisted only when local bendPoints change
  - RAN scratchpad/editdel/misc-test.ts: updateEdgeType(same 'orthogonal') -> data {"connectionType":"process-pipe","label":"L1"} (bendPoints, routingMode gone), isDirty true
  - (verifier) writer: web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:219-237; ScreenCanvas.tsx:783-792
  - (verifier) store: web/modules/sensor-module/src/store/scada/edgeSlice.ts:33-47
  - (verifier) reader: components/scada-builder/edges/OrthogonalEdge.tsx:256-262 (initialBends memo []), 270-276 (re-derived only on endpoint/routingMode change), 285-291 (persist only on local change)
  - (verifier) grep routingMode: set only in store/scada/templates/aquacultureRasDemo.ts:796-864
  - (verifier) RAN (rebuilt harness misc-test): updateEdgeType(same) -> data {"connectionType":"process-pipe","label":"L1"}, isDirty true
  - Verifier: Confirmed as filed earlier as CONN-V-01. LOW.
- **CONN-19** (CONN; verdict CONFIRMED; severity LOW): Editing a selected edge's shape or type also changes the default for new pipes
  - Claim: Confirmed for the EdgeToolbar only. Its handlers always set the canvas-local default before updating the selected edge. The Properties-panel 'Line Type' and 'Connection Type' controls go through usePropertiesPanelHandlers and do not touch the defaults.
  - ScreenCanvas.tsx:783-792 setDefaultEdgeType(type) then storeUpdateEdgeType
  - ScreenCanvas.tsx:794-803 setDefaultConnectionType(type) then storeUpdateEdgeData
  - (verifier) ScreenCanvas.tsx:783-792 handleEdgeTypeChange setDefaultEdgeType(type), then storeUpdateEdgeType; :794-803 handleConnectionTypeChange setDefaultConnectionType(type), then storeUpdateEdgeData
  - (verifier) pages/scada/usePropertiesPanelHandlers.ts:135-149 edge handlers do not touch the defaults
  - Verifier: Read directly. The scope is narrowed to the toolbar.
- **CONN-V-02** (CONN-verifier; verdict SELF; severity LOW): Bezier pipes have no hit area, so only the 1–3 px stroke itself can be clicked to select, edit or delete them
  - Claim: OrthogonalEdge and MultiHandleEdge render a 16 px transparent hit path with pointer-events:stroke. DraggableEdge has none: its only clickable element is the visible path (pointerEvents 'stroke') at the connection type's stroke width (3 px process pipe, 2 px for most signal lines, 1 px capillary), which shrinks further when zoomed out. Its control points render only when the edge is selected, so a curve pipe the user cannot hit can neither be reshaped nor deleted from the properties panel.
  - edges/DraggableEdge.tsx:224-243 the main path is the only interactive element (pointerEvents 'stroke' at :230); there is no transparent hit path anywhere in the file
  - contrast: edges/OrthogonalEdge.tsx:391-400 and edges/MultiHandleEdge.tsx:329-338 hit paths with strokeWidth HIT_AREA_WIDTH (16)
  - config/connectionTypes.ts:32 process-pipe strokeWidth 3; :80 capillary 1; others 2
  - reader: @xyflow/react 12.11.0 EdgeWrapper onClick on the edge <g> (dist/esm/index.js:2979) -> ScreenCanvas.tsx:656-662 onEdgeClick -> setSelectedEdge
  - ScreenCanvas.tsx:932 minZoom 0.2 (a 3 px stroke becomes 0.6 screen px)

</details>

### SENSOR-MEDIUM-307

**Pipe flow animation is a static checkbox, not derived from pump or valve state**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 1, PARTIAL 1
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** The facts hold. The edge panel offers only the static 'Animated flow' checkbox. No UI writes data.flowConfig (only the edge components, ScreenCanvas and the type file reference it). updateEdgeType drops flowConfig and routingMode, which the real store confirms. Nothing derives pipe flow from pump or valve state. The TagValueBus that useEdgeFlowState reads is fed only by simTagValues, AnimationsPanel or Recipe previews, scripts and TagWriteHandler, never by the live data provider. The severity is overstated: pipes are rendered by no runtime (CONN-01), so the misleading always-flowing animation appears only in builder Edit, Preview and Simulation. The separate 'pipeFlow' widget cannot help either, because it has no tag field (already KEYS-01).

**What the user sees.** The user sets 'Animated flow' on the pump discharge pipe. Water keeps flowing in the pipe when the pump is switched OFF or the valve is CLOSED. If animation is off, the pipe never shows flow even with the pump running.

**Root cause.** Connections carry no semantics. Flow animation is a cosmetic flag, and the half-built tag-binding path has no editor and no live data source.

**Fix direction.** Add a flow binding editor on the edge (tag plus condition), or derive flow automatically from the source equipment's state (and from valves along the path). Feed the TagValueBus from the same Layer-B data provider the canvas uses. Preserve flowConfig in updateEdgeType. Test: pump tag 0 means the edge is not animating, and pump tag 1 means it is.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:253-269`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:327,340`
- `web/modules/sensor-module/src/components/scada-builder/edges/useEdgeFlowState.ts`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:784-868`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:345`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:41-45`
- `web/modules/sensor-module/src/components/scada-builder/edges/useEdgeFlowState.ts:90-111`
- `web/modules/sensor-module/src/engine/ScadaRuntime.tsx:48-52`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:37-58`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:190-285`
- `web/modules/sensor-module/src/types/scada-edge.types.ts:56`
- `web/modules/sensor-module/src/store/scada/edgeSlice.ts:33-46`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/AnimationsPanel.tsx:106-109`
- `web/modules/sensor-module/src/components/scada-builder/RecipePanel.tsx:130`
- `web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts:258`
- `web/modules/sensor-module/src/engine/events/handlers/TagWriteHandler.ts:11-14`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:326,342`
- `web/modules/sensor-module/src/config/connectionTypes.ts:143`
- `web/modules/sensor-module/src/config/connectionTypes.ts:33,81`

<details><summary>Merged audit findings and full evidence</summary>

- **CONN-06** (CONN; verdict PARTIAL; severity MEDIUM): Pipe flow animation is a static checkbox, not tied to pump or valve state
  - PropertiesPanel.tsx:253-269 the edge panel exposes only the `animated` checkbox (plus connectionType, line type and label)
  - grep flowConfig: written nowhere in the builder UI. Only read in ScreenCanvas.tsx:327,340, edges/\*.tsx and useEdgeFlowState.ts. The RAS demo template edges (store/scada/templates/aquacultureRasDemo.ts:784-868) use `animated: true` only
  - ScreenCanvas.tsx:345 the static 'animated-flow' CSS class applies whenever data.animated is set and there is no flowConfig.tagName
  - store/scada/edgeSlice.ts:41-45 updateEdgeType resets data to {connectionType,label,animated}, which drops flowConfig and routingMode
  - useEdgeFlowState.ts:90-111 subscribes to runtimeCtx.tagBus only. engine/ScadaRuntime.tsx:48-52 bridges only simTagValues into the TagValueBus (no live data bridge)
  - widget-renderers/EquipmentRenderer.tsx:37-58 equipment state is derived from the widget's own value and never propagated to its edges
  - (verifier) components/scada-builder/PropertiesPanel.tsx:190-285 (Connection Type, Line Type, Label, 'Animated flow' checkbox at :253-269, Delete)
  - (verifier) grep flowConfig: readers only in ScreenCanvas.tsx:327,340, edges/\*.tsx and useEdgeFlowState.ts; type at types/scada-edge.types.ts:56; no writer
  - (verifier) store/scada/edgeSlice.ts:33-46 updateEdgeType resets data to {connectionType,label,animated}; real store output: 'after updateEdgeType(same type): {..."data":{"connectionType":"process-pipe"}}' (flowConfig, routingMode and bendPoints gone)
  - (verifier) engine/ScadaRuntime.tsx:48-52 only simTagValues -> tagBus.publishBatch; grep `.publish(` finds AnimationsPanel.tsx:106-109, RecipePanel.tsx:130, ScriptExecutor.ts:258, TagWriteHandler.ts:11-14 and no live provider
  - (verifier) ScreenCanvas.tsx:345 'animated-flow' class whenever data.animated && !flowConfig.tagName
  - Verifier: The claim is accurate. I downgraded it because the only place the false flow indication is visible is the builder canvas, and the root problem is a missing feature, not something that corrupts a working path.
- **CONN-07** (CONN; verdict CONFIRMED; severity LOW): Tag-driven dash animation is cancelled for solid pipe types by the style spread order
  - Claim: Confirmed (latent, since flowConfig is never written). getEdgeStyle('process-pipe') returns an object with an explicit strokeDasharray key set to undefined. Spreading `...style` last in the edge components replaces the '8 4' flowing dasharray with undefined, so solid pipe types (process-pipe, capillary) would show only the blinking chevron. Dashed types keep their own pattern, which still animates.
  - ScreenCanvas.tsx:326,342 `style = getEdgeStyle(e.data.connectionType)` passed to every edge
  - config/connectionTypes.ts:143 `strokeDasharray: config.strokeDasharray \|\| undefined`, where 'process-pipe' has strokeDasharray ''
  - OrthogonalEdge.tsx:415-425, DraggableEdge.tsx:233-242 and MultiHandleEdge.tsx:352-360 set the flowing dasharray and then `...style` overrides it
  - (verifier) config/connectionTypes.ts:33,81 strokeDasharray '' for process-pipe/capillary; :143 `config.strokeDasharray \|\| undefined`
  - (verifier) harness: "getEdgeStyle(process-pipe): {\"stroke\":...,\"strokeWidth\":3} has key strokeDasharray: true"
  - (verifier) ScreenCanvas.tsx:326,342 style passed to each edge; xyflow EdgeWrapper passes `style: edge.style` (@xyflow/react 12.11.0 dist/esm/index.js:2979 block)
  - (verifier) OrthogonalEdge.tsx:415-425, DraggableEdge.tsx:233-242, MultiHandleEdge.tsx:352-360 override then `...style`
  - Verifier: The mechanism is proven. It is unreachable today because no flowConfig can be authored.

</details>

### SENSOR-MEDIUM-310

**Destructive edits are unsafe: deleting a screen leaves dangling links/events/bindings, one-click destructive actions lack confirmation, and global shortcuts are unscoped (Delete inside dialogs deletes the widget behind)**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 5
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** The claim holds. removeScreen (sceneSlice.ts:35-68) removes the screen, reparents children and fixes the active and default screen. It never scans other widgets' config.targetScreenId or events[].params.targetScreenId, the automationBindings, selectedWidgetIds, or screenHistory (no consumer). ScreenLinkConfig and EventsPanel <select>s fall back to 'Select screen...' for the missing id, while ScreenLinkRenderer still treats the link as configured. Navigating to the deleted id gives the 'Ekran seçin veya yeni ekran ekleyin' empty canvas, through the link in Preview or a navigate event (which also fires in Edit mode). openCard/openDialog give an empty dialog titled 'Unknown' (ModalDialog.tsx:24-26,45). Dangling bindings stay green, and autoBindByTag skips them. The Scene Tree Delete has no confirm. Scope note: no backend or edge code reads targetScreenId and the edge HMI has no screenLink, so the dangling-link effects are builder-only.

**What the user sees.** I delete the 'Process' screen. The 'Go to process' link on Overview still looks configured on the canvas, but its Target Screen box says 'Select screen…', and in Preview clicking it leaves a blank canvas reading 'Ekran seçin veya yeni ekran ekleyin'. The Automation tab still shows green 'Bound' variables pointing at widgets that no longer exist. Deleting the screen from the Scene Tree menu happens instantly, with no prompt.

**Root cause.** References between screens, widgets and bindings are untyped string ids with no ownership or integrity rules, so every delete must hand-code its cascades, and removeScreen has none. The two delete entry points do not share one confirmed command.

**Fix direction.** Introduce a single reference index (screen→referrers, widget→referrers) used by every delete. Either cascade (clear targets and bindings, with a summary in the confirm dialog: 'N links and M bindings will be cleared') or block. Route both delete entry points through one confirmed command. Have the Properties selects show 'missing screen' explicitly rather than falling back silently.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:35-68`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScreenLinkConfig.tsx:27-39`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/ScreenLinkRenderer.tsx:20-32`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:224-226`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:881-887`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EventsPanel.tsx:221-240`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:294-299`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:186-189`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:123-139`
- `web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:323-330`
- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:631-635`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScreenLinkConfig.tsx:27-38`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/ScreenLinkRenderer.tsx:26-31`
- `web/modules/sensor-module/src/engine/events/handlers/NavigateHandler.ts:6-9`
- `web/modules/sensor-module/src/engine/events/handlers/OverlayHandler.ts:22-30`
- `web/modules/sensor-module/src/engine/views/ModalDialog.tsx:24-26`
- `web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:323-330,538-541`
- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:631-634`
- `sens-api-gateway/static/scada-edge.html`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:266-274`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:113-119`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptsPanel.tsx:83-92`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptEditor.tsx:143`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:61-63,104-110`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:86-92`
- `web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:150-160`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:126`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:315`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:93`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:266-273`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EmergencyStopRenderer.tsx:16`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:20-24`
- `web/shared-ui/src/components/Modal/Modal.tsx:158,195`
- `web/shared-ui/src/components/Modal/useDialogBehavior.ts:113-126`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:294-297`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:270-277`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EventsPanel.tsx:432-445`
- `web/shared-ui/src/components/Modal/useDialogBehavior.ts:107-124`
- `web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:11,121`
- `web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx:9,278`
- `web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:21,295`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:270-275`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EventsPanel.tsx:432-443`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:74-83`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:677`
- `web/modules/sensor-module/src/components/unified-editor/ModeTabBar.tsx:31-49`
- `web/modules/sensor-module/src/components/scada-builder/usePanelShortcuts.ts:30-53`
- `web/modules/sensor-module/src/store/editorModeStore.ts:32,43-55,80-81`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:20-37`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-256`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-256,275`

<details><summary>Merged audit findings and full evidence</summary>

- **EDIT-04** (EDIT; verdict CONFIRMED; severity MEDIUM): Deleting a screen leaves dangling screen links, navigate events and automation bindings; Scene Tree deletes it without confirmation
  - web/modules/sensor-module/src/store/scada/sceneSlice.ts:35-68 removeScreen: splice plus reparent/active/default fix-up; no scan of widgets' config/events or of automationBindings
  - components/scada-builder/widget-configs/ScreenLinkConfig.tsx:27-39 <select value={config.targetScreenId}> with options from the current screens only (React selects the first option when nothing matches)
  - components/scada-builder/widget-renderers/ScreenLinkRenderer.tsx:20-32 hasTarget = Boolean(targetScreenId); onCommand('navigate', id)
  - components/scada-builder/nodes/ScadaWidgetNode.tsx:224-226 navigate -> setActiveScreen(value) unconditionally; components/scada-builder/ScreenCanvas.tsx:881-887 renders 'Ekran seçin veya yeni ekran ekleyin' when the active screen is missing
  - components/scada-builder/widget-configs/EventsPanel.tsx:221-240 the Target Screen select has the same fallback
  - components/scada-builder/AutomationBindingPanel.tsx:294-299 shows Check + boundTag whenever boundWidgetId is set; store/scada/projectSlice.ts:186-189 autoBindByTag treats any boundWidgetId as matched
  - components/scada-builder/ScreenTabBar.tsx:123-139 confirm() before removeScreen vs components/scada-builder/SceneTreePanel.tsx:323-330, 538-548 removeScreen with no confirm (reachable via UnifiedLeftPanel.tsx:631-635 Scene tab)
  - RAN scratchpad/editdel/keys-test.tsx [4]: after removeScreen('S1'): L.targetScreenId 'S1', C.events[0].params.targetScreenId 'S1', binding.boundWidgetId 'A', selectedWidgetIds ["A"]
  - (verifier) web/modules/sensor-module/src/store/scada/sceneSlice.ts:35-68 (no reference scan)
  - (verifier) writer/reader mismatch: components/scada-builder/widget-configs/ScreenLinkConfig.tsx:27-38 (select over current screens only) vs widget-renderers/ScreenLinkRenderer.tsx:26-31 (hasTarget = Boolean(id); navigate) -> nodes/ScadaWidgetNode.tsx:224-226 (setActiveScreen unconditionally) -> ScreenCanvas.tsx:881-887 (empty state)
  - (verifier) widget-configs/EventsPanel.tsx:221-240 (same fallback); engine/events/handlers/NavigateHandler.ts:6-9; engine/events/handlers/OverlayHandler.ts:22-30 and engine/views/ModalDialog.tsx:24-26 (screen?.name ?? 'Unknown')
  - (verifier) components/scada-builder/AutomationBindingPanel.tsx:294-299 (Check whenever boundWidgetId is set); store/scada/projectSlice.ts:186-189 (autoBindByTag counts it as matched)
  - (verifier) components/scada-builder/ScreenTabBar.tsx:123-139 (confirm) vs components/scada-builder/SceneTreePanel.tsx:323-330,538-541 (removeScreen directly); UnifiedLeftPanel.tsx:631-634 mounts SceneTreePanel
  - (verifier) grep targetScreenId in apps/sensor-service/src, libs/sensor-contracts/src, sens-api-gateway/src and static/scada-edge.html: no hits
  - (verifier) RAN (rebuilt harness) [4]: after removeScreen('S1') -> L.targetScreenId 'S1', C.events targetScreenId 'S1', binding.boundWidgetId 'A', selectedWidgetIds ["A"]
  - Verifier: I found no cascade, mapper or validator for screen references anywhere, front or back. The impact is limited to the builder, because no runtime consumes screen links or variableBindings. One-click screen deletion with no confirm and dead undo is real data loss, which keeps this at MEDIUM.
- **EDIT-11** (EDIT; verdict CONFIRMED; severity LOW): Several destructive one-click actions have no confirmation and cannot be undone
  - Claim: The claim holds. These actions remove data on one click with no confirm, and the dead undo (LIFE-09) means they cannot be reversed: removeAutomationProgram (AutomationBindingPanel.tsx:266-273 -> projectSlice.ts:113-119), script delete (ScriptsPanel.tsx:83-92, ScriptEditor.tsx:143), alarm-rule remove (PropertiesAlarmTab.tsx:61-63,104-110), widget Delete via key or context menu, and the Scene Tree screen delete (EDIT-04). The only confirms in the builder area are ScreenTabBar.tsx:126, ScadaPackageBuilderPage.tsx:315 (load demo), ScadaPackageListPage.tsx:93 and the E-STOP renderer. No native window.confirm is used either. The only way back is to discard every unsaved change.
  - web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:266-274 onClick={() => removeAutomationProgram(id)}; store/scada/projectSlice.ts:113-119
  - components/scada-builder/widget-configs/ScriptsPanel.tsx:83-92 deleteScript -> onChange(filter) directly; ScriptEditor.tsx:143 onClick={onDelete}
  - components/scada-builder/PropertiesAlarmTab.tsx:61-63,104-110 removeAlarmRule directly
  - hooks/useScadaKeyboardShortcuts.ts:86-92 and CanvasContextMenu.tsx:150-160 delete with no confirm
  - grep useConfirm in scada-builder/pages: only ScreenTabBar.tsx:126, ScadaPackageBuilderPage.tsx:315, ScadaPackageListPage.tsx:93 (and the E-STOP renderer)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:266-273; store/scada/projectSlice.ts:113-119
  - (verifier) components/scada-builder/widget-configs/ScriptsPanel.tsx:83-92; ScriptEditor.tsx:143
  - (verifier) components/scada-builder/PropertiesAlarmTab.tsx:61-63,104-110
  - (verifier) hooks/useScadaKeyboardShortcuts.ts:86-92; CanvasContextMenu.tsx:150-160
  - (verifier) grep useConfirm/confirm( in components/scada-builder, components/unified-editor, pages/scada: only ScreenTabBar.tsx:126, ScadaPackageBuilderPage.tsx:315, ScadaPackageListPage.tsx:93, EmergencyStopRenderer.tsx:16
  - Verifier: This is mainly a consequence of LIFE-09 (dead undo) plus the lack of a confirmation policy. Direct reads only. LOW.
- **EDIT-07** (EDIT; verdict CONFIRMED; severity LOW): Global shortcut handler is not scoped: Delete or Backspace inside an open dialog deletes the widget behind it, and Ctrl+C never copies page text
  - Claim: The claim holds. The document-level keydown handler (useScadaKeyboardShortcuts.ts:151-156) filters only INPUT, TEXTAREA, SELECT and contentEditable targets (:20-24). It is active while the shared-ui Modal-based Deploy (DeployToEdgeDialog), CSV and Export dialogs are open. Those dialogs focus their tabIndex=-1 container (Modal.tsx:158,195; useDialogBehavior.ts:122-124), and their own document listener does not stop propagation (:114-121). Delete or Backspace with focus on the dialog, or on any button, therefore removes the selected widgets or edge behind it. Ctrl+C, Ctrl+X, Ctrl+V and Ctrl+A call preventDefault for every non-input target, even with nothing selected (:53-72,108-113). Text on the page cannot be copied with the keyboard, including the edge 'Source: <id>', the only visible widget id, which setProperty's free-text Target Widget ID needs.
  - web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:20-24 (target filter), 53-58 (Ctrl+C always preventDefault), 85-98 (Delete/Backspace), 151-156 (document listener, gated only by isPreview)
  - web/shared-ui/src/components/Modal/Modal.tsx:158,195 useDialogBehavior + tabIndex={-1}; web/shared-ui/src/components/Modal/useDialogBehavior.ts:113-126 focuses the container; its document keydown listener handles Escape/Tab only
  - pages/scada/ScadaPackageBuilderPage.tsx:294-297 the hook is active in edit mode while the Deploy/CSV/Export dialogs open
  - components/scada-builder/PropertiesPanel.tsx:270-277 edge Source/Target ids shown as text; widget-configs/EventsPanel.tsx:432-445 free-text Target Widget ID
  - RAN scratchpad/editdel/keys-test.tsx [3]: Delete with focus on a tabIndex=-1 container removes widget B and its edge; [6]: Ctrl+C on body with nothing selected gives defaultPrevented true
  - (verifier) web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:20-24, 53-72, 85-98, 108-113, 151-156
  - (verifier) web/shared-ui/src/components/Modal/Modal.tsx:158,195; web/shared-ui/src/components/Modal/useDialogBehavior.ts:107-124 (focuses container; listener handles Escape/trapFocus only)
  - (verifier) web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:11,121; components/scada-builder/CsvTagDialog.tsx:9,278; ExportDialog.tsx:21,295 (all shared-ui Modal); pages/scada/ScadaPackageBuilderPage.tsx:294-297 (hook active whenever mode==='edit')
  - (verifier) components/scada-builder/PropertiesPanel.tsx:270-275 (edge Source/Target ids as text); widget ids are rendered nowhere else (LayersPanel only uses them in data-testid); widget-configs/EventsPanel.tsx:432-443 (free-text Target Widget ID)
  - (verifier) RAN (rebuilt harness) [3]: Delete with focus on tabIndex=-1 container -> S1 widgets [A], edges 0; [6]: Ctrl+C on body, nothing selected -> defaultPrevented true
  - Verifier: There is no dialog-open guard and no focus-scope check. Users rarely press Delete inside a dialog, so this is LOW, but the deletion is silent and cannot be undone.
- **KEYS-01@JOUR** (JOUR; verdict CONFIRMED; severity LOW): Editor shortcuts swallow browser shortcuts in edit mode and disappear in the other modes
  - Claim: Holds, with two corrections. (1) The ID collides with an existing finding, OPS.json KEYS-01 (MEDIUM, config keys written but never read); this one should be renamed, e.g. KEYS-02. (2) The unified editor does not always open in P&ID. editorModeStore is a module singleton reset only on logout or tenant switch, so the page opens in the last-used mode (see new finding JRN-09). The browser-reserved chord behaviour remains SUSPECTED; in Chrome, Ctrl+1..8 is handled by the browser before the page, so the advertised mode shortcuts would switch tabs instead.
  - web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:74-83 (Ctrl+D), :139-148 (Ctrl+L), :151-156 (detached when isPreview)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:294-297 (isPreview = mode !== 'edit'); pages/unified/UnifiedEditorPage.tsx:677 (isPreview = mode !== 'hmi' \|\| simulationMode)
  - web/modules/sensor-module/src/components/unified-editor/ModeTabBar.tsx:31-49 (Ctrl+1..5 on window)
  - web/modules/sensor-module/src/components/scada-builder/usePanelShortcuts.ts:30-53 (metaKey accepted; early return for inputs at :36)
  - (verifier) useScadaKeyboardShortcuts.ts:74-83 (Ctrl+D preventDefault even when nothing selected), :139-148 (Ctrl+L), :151-156 (listener detached when isPreview), :22-24 (early return for inputs)
  - (verifier) ScadaPackageBuilderPage.tsx:294-297; UnifiedEditorPage.tsx:677
  - (verifier) ModeTabBar.tsx:31-49 (Ctrl+1..5 on window with preventDefault)
  - (verifier) usePanelShortcuts.ts:30-53 (metaKey accepted; early return for editable targets at :36)
  - (verifier) editorModeStore.ts:32,43-55,80-81 (no reset on mount)
  - Verifier: The handler code matches every sub-claim. Only real-browser chord interception is unproven here.
- **LIFE-26** (LIFE; verdict CONFIRMED; severity LOW): Ctrl+S is ignored while focus is in any input, and quick double saves are not guarded
  - Claim: The shortcut handler returns before preventDefault for INPUT/TEXTAREA/SELECT/contentEditable targets, so Ctrl+S in the package-name or any property field opens the browser 'Save page' dialog. handleSave has no in-flight guard (only the button is disabled while isSaving), so two quick Ctrl+S presses on a new package issue two creates, because effectivePackageId is still null during the first await.
  - web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:20-37
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-256 (no isSaving check)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-256,275
  - Verifier: Confirmed.

</details>

### SENSOR-LOW-308

**Connection model gaps: no reconnect of a pipe end, "signal lines" without signal ports, unlimited pipes per nozzle**

- Severity: LOW · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 3
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** Confirmed. xyflow renders reconnect anchors only when an onReconnect prop is provided, and ScreenCanvas passes none. The edges' own endpoint circles are pointer-events-none.

**What the user sees.** The user selects a pipe and tries to drag its green or red end dot to a different nozzle. Nothing happens.

**Root cause.** Reconnect is not implemented.

**Fix direction.** Wire onReconnect to a store action that updates source, target and handles in place (and records history), and run isValidConnection on it.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:907-941`
- `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx:481-503`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:906-941`
- `web/modules/sensor-module/src/components/scada-builder/EdgeToolbar.tsx:78`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:283-326`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:534-544`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:593-653`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts`

<details><summary>Merged audit findings and full evidence</summary>

- **CONN-17** (CONN; verdict CONFIRMED; severity LOW): No reconnect: a pipe end cannot be moved to another port
  - ScreenCanvas.tsx:907-941 the ReactFlow props have no onReconnect, onReconnectStart or edgesReconnectable
  - edges/OrthogonalEdge.tsx:481-503 (likewise DraggableEdge.tsx:326-348 and MultiHandleEdge.tsx:416-438) endpoint indicators use className 'pointer-events-none'
  - (verifier) ScreenCanvas.tsx:906-941 ReactFlow props have no onReconnect/onReconnectStart/edgesReconnectable
  - (verifier) @xyflow/react 12.11.0 dist/esm/index.js:2874 `const isReconnectable = typeof onReconnect !== 'undefined' && ...`; anchors at :2859
  - (verifier) edges/OrthogonalEdge.tsx:481-503 endpoint circles className 'pointer-events-none' (same in DraggableEdge and MultiHandleEdge)
  - Verifier: The library source confirms that reconnect is impossible without onReconnect.
- **CONN-16** (CONN; verdict CONFIRMED; severity LOW): 'Signal lines' are offered but there are no signal ports, and VFDs or controls cannot be connected
  - Claim: Confirmed with one nuance. The EdgeToolbar advertises 'Signal Lines' (electrical, pneumatic, instrument, data-link), but the port registry is almost entirely hydraulic. The only non-process inputs are the feeder's 'control' input (right 0.5). Motors expose only shaft/feedback outputs, controlValve has no actuator input, widgets outside CONNECTION_POINTS (VFD, toggle, status, tankLevel, pipeFlow, ...) have no handles, and isValidConnection never checks connectionType against the port.
  - EdgeToolbar.tsx:78 SIGNAL_LINE_IDS electrical/pneumatic/instrument/data-link
  - equipment-symbols/types.ts:283-326 motors have only 'out' shaft/feedback. Instruments have 'signal' out. No signal 'in' on controlValve (:174-177) or motors
  - nodes/ScadaWidgetNode.tsx:534-544 returns null handles for any widgetType not in CONNECTION_POINTS (vfdDrive, toggleSwitch, statusIndicator, tankLevel, pipeFlow ...)
  - ScreenCanvas.tsx:593-653 isValidConnection checks direction only, not connectionType
  - (verifier) components/scada-builder/EdgeToolbar.tsx:78 SIGNAL_LINE_IDS; 'Signal Lines' section in the dropdown (~:127-130 of the file)
  - (verifier) equipment-symbols/types.ts CONNECTION_POINTS: acMotor/vfdMotor shaft out only; servoMotor shaft/feedback out; controlValve inlet/outlet only; instruments 'signal' top out; feeder 'control' right in
  - (verifier) nodes/ScadaWidgetNode.tsx:534-544 returns null for keys not in CONNECTION_POINTS
  - (verifier) ScreenCanvas.tsx:593-653 isValidConnection checks self, duplicate and direction only
  - Verifier: The claim is accurate. The feeder control input is the single exception. LOW.
- **CONN-18** (CONN; verdict CONFIRMED; severity LOW): Unlimited pipes per nozzle are allowed
  - Claim: Confirmed. isValidConnection blocks only self-loops, exact four-tuple duplicates and wrong direction. Any number of pipes can attach to one port.
  - ScreenCanvas.tsx:593-653 duplicate check requires the same source, target, sourceHandle and targetHandle. There is no per-handle occupancy check
  - (verifier) ScreenCanvas.tsx:593-653 duplicate check requires identical source, target, sourceHandle and targetHandle; there is no per-handle occupancy check
  - (verifier) equipment-symbols/types.ts EquipmentConnectionPoint has no cardinality field
  - Verifier: Read directly. Low impact today because nothing propagates flow through the topology.

</details>

### SENSOR-LOW-309

**Layout aids are broken: z-order buttons change nothing, smart guides and rulers ignore pan/zoom, click-to-add/paste stack at (2,2), Focus on Selection does nothing**

- Severity: LOW · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 4, PARTIAL 3, SELF 1
- Rule: The editor document is the single source of truth and every edit is an undoable command

**Claim.** bringForward and sendBackward (context menu, Layers up/down arrows) only swap zIndex. storeNodes never sets node.zIndex, so the React Flow wrapper z is 0 (+1000 while selected). The inner container's 500+zIndex cannot escape the wrapper's stacking context. Paint order is array order: nodeLookup is rebuilt in array order, and every runtime maps in array order. Only bringToFront and sendToBack, which splice the array, have a visible effect. The Layers list (sorted by zIndex descending) then disagrees with what is drawn. It is also inverted by default: for widgets with the default zIndex 0, the stable sort keeps array order, so the bottom-most painted widget is listed at the top, despite the comment 'highest on top, like Figma'.

**What the user sees.** Using 'Bring Forward' to put a label on top of a tank, or the up/down arrows in Layers, moves the row in the Layers list, but the tank still covers the label on the canvas and at runtime.

**Root cause.** Two ordering models (zIndex vs array order) with renderers that honour only array order, and a zIndex applied below the node's stacking context.

**Fix direction.** Pick one ordering model. Either keep the array as the only order (bringForward/sendBackward splice the array) or set node.zIndex in storeNodes and have every runtime sort by zIndex. Add a test that layer order in the Layers list equals paint order.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:145-173`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:427,451`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:285-307`
- `web/modules/sensor-module/src/components/scada-builder/LayersPanel.tsx:142-156`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:343`
- `web/modules/sensor-module/src/engine/views/ScadaViewport.tsx:116`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:145-203`
- `web/modules/sensor-module/src/components/scada-builder/SmartGuides.tsx:126-157`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:996-1010`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:139-195`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:907-973`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:99-195`
- `web/modules/sensor-module/src/components/scada-builder/SmartGuides.tsx:53-66`
- `web/modules/sensor-module/src/components/scada-builder/SmartGuides.tsx:128-130`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:976-982`
- `web/modules/sensor-module/src/components/scada-builder/CanvasRuler.tsx:45-49`
- `web/modules/sensor-module/src/components/scada-builder/CanvasRuler.tsx:61-65`
- `web/modules/sensor-module/src/components/scada-builder/CanvasRuler.tsx:40-49`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:892`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:108-113`
- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:421-439`
- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:280-296`
- `web/modules/sensor-module/src/components/scada-builder/WidgetTemplatePanel.tsx:38-39`
- `web/modules/sensor-module/src/store/scada/templateSlice.ts:29-43`
- `web/modules/sensor-module/src/components/scada-builder/WidgetTemplatePanel.tsx:36-40`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:828-831`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:160-165`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:67-72`
- `web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:145-148`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:157-165`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts:67-83`
- `web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:56-70`
- `web/modules/sensor-module/src/components/scada-builder/AlignmentToolbar.tsx:66`

<details><summary>Merged audit findings and full evidence</summary>

- **PLACE-11** (PLACE; verdict PARTIAL; severity LOW): Bring Forward / Send Backward and the Layers ▲/▼ buttons change nothing on the canvas or at runtime, and the Layers list then disagrees with what is drawn
  - store/scada/widgetSlice.ts:145-173 bringForward swaps zIndex only (no array move) vs L99-121 bringToFront, which also moves the item to the end of the array
  - components/scada-builder/nodes/ScadaWidgetNode.tsx:427,451 zIndex: 500 + widgetZIndex on the inner container
  - components/scada-builder/ScreenCanvas.tsx:285-307 node object has no zIndex
  - @xyflow/react@12.11.0 index.js:2296-2298 node wrapper style { zIndex: internals.z, transform: translate(...) } (a stacking context)
  - components/scada-builder/LayersPanel.tsx:142-156 ▲/▼ call bringForward and sendBackward; L288-290 list sorted by zIndex desc
  - runtime: components/scada-operator/OperatorView.tsx:343 and engine/views/ScadaViewport.tsx:116 render in array order and ignore zIndex
  - (verifier) store/scada/widgetSlice.ts:145-203 forward/backward swap zIndex only; L99-143 to-front/to-back also splice the array
  - (verifier) components/scada-builder/nodes/ScadaWidgetNode.tsx:427,451 zIndex: 500 + widgetZIndex on the inner div; ScreenCanvas.tsx:285-307 no node.zIndex
  - (verifier) @xyflow/system index.js:1602-1631 adoptUserNodes clears and rebuilds nodeLookup in array order; L1702-1707 calculateZ = node.zIndex(0) + selected elevation; @xyflow/react index.js:2296-2298 wrapper style {zIndex: internals.z, transform}
  - (verifier) components/scada-builder/LayersPanel.tsx:142-156 up/down -> bringForward/sendBackward; L284-290 sort by zIndex desc; L302-322,456 rendered without reverse
  - (verifier) runtimes: OperatorView.tsx:343, ScadaViewport.tsx:116 array order
  - Verifier: The claim holds, and I found an extra inversion in the Layers list. bringToFront and sendToBack work as a workaround, and z-order does not affect whether the process runs, so LOW.
- **UI-02** (OPS; verdict CONFIRMED; severity LOW): Smart guides and the background image ignore pan and zoom; bringForward/sendBackward likely have no visual effect
  - Claim: Confirmed for the guides and the background. SmartGuides is rendered as a sibling after </ReactFlow>, with no viewport transform, and uses flow coordinates. The background div is outside the viewport. The z-order part is CONFIRMED by code (Node objects carry no zIndex; only data.zIndex reaches an inner div). Its 'no visual effect' consequence relies on xyflow 12 giving each node wrapper its own z-index stacking context; I could not run it, so that part is PLAUSIBLE. Duplicates PLACE-11, PLACE-12 and PLACE-14.
  - web/modules/sensor-module/src/components/scada-builder/SmartGuides.tsx:126-157
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:996-1010 (background layer), 285-307 (node objects without zIndex)
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:427,451 (inner zIndex)
  - web/modules/sensor-module/src/store/scada/widgetSlice.ts:139-195 (forward/backward = zIndex swap only)
  - (verifier) components/scada-builder/ScreenCanvas.tsx:907-973 (<ReactFlow>…</ReactFlow>) then 977 (<SmartGuides>) outside it; SmartGuides.tsx:126-157 (absolute svg, raw flow coords)
  - (verifier) ScreenCanvas.tsx:996-1010 (background div outside the RF viewport)
  - (verifier) ScreenCanvas.tsx:285-307 (node objects without zIndex; zIndex only in data); nodes/ScadaWidgetNode.tsx:427,451
  - (verifier) store/scada/widgetSlice.ts:99-195 (bringToFront/sendToBack also reorder the array; bringForward/sendBackward swap zIndex only)
  - Verifier: I upgraded this from SUSPECTED on the parts read directly.
- **PLACE-12** (PLACE; verdict PARTIAL; severity LOW): Smart guides are drawn in flow coordinates on a screen-space overlay, so they are misplaced whenever the canvas is panned or zoomed
  - Claim: SmartGuides computes lines in flow px (col*120, row*100, raw dragPosition) and draws them in an absolute SVG over the container with no viewport transform. ScreenCanvas passes no viewport or zoom, so the guides are misplaced after any pan or zoom. They use stored w/h, which differs from the drawn equipment height (PLACE-06). The guides are purely visual: they never snap or move anything, and with Snap on (the default) the grid decides the position.
  - components/scada-builder/SmartGuides.tsx:53-66 dragLeft = dragPosition.x (flow px), wLeft = col \* GRID_CELL_W
  - SmartGuides.tsx:128-130 <svg className='absolute inset-0 ...'> with raw x1/y1 values
  - components/scada-builder/ScreenCanvas.tsx:976-982 <SmartGuides draggingWidgetId dragPosition dragSize/> with no viewport props; viewport is tracked only for the ruler (L687-698)
  - (verifier) components/scada-builder/SmartGuides.tsx:53-66 flow-px math; L128-130 <svg className='absolute inset-0 ...'> raw coordinates
  - (verifier) components/scada-builder/ScreenCanvas.tsx:976-982 <SmartGuides draggingWidgetId dragPosition dragSize/>; the viewport is used only for CanvasRuler (L687-698,986-992)
  - Verifier: The code holds. The impact is a misleading visual aid with no effect on stored data, so it is downgraded to LOW.
- **PLACE-23** (PLACE; verdict CONFIRMED; severity LOW): The canvas ruler drops tick labels when the canvas is zoomed and panned
  - Claim: The CanvasRuler visibility filter uses col*cellW + viewportX*zoom while the drawn x is col*120*zoom + viewportX, so at zoom != 1 with a pan, visible ticks are dropped. Rows behave the same way. The ruler also has a separate 20 px offset (new finding PLACE-V-01).
  - components/scada-builder/CanvasRuler.tsx:45-49 filter 'const x = col _ cellW + viewportX _ zoom' vs pushed 'x: col _ GRID_CELL_W _ zoom + viewportX'
  - the same pattern for rows at CanvasRuler.tsx:61-65
  - (verifier) components/scada-builder/CanvasRuler.tsx:45-49 filter vs push expression; L61-65 rows
  - Verifier: Direct read. For example, at zoom 2 and viewportX -1000, ticks in the leftmost ~760 px are filtered out.
- **PLACE-V-01** (PLACE-verifier; verdict SELF; severity LOW): Ruler ticks are drawn 20 px right/down of the real grid lines, and the rulers cover the top and left 20 px of the canvas
  - Claim: CanvasRuler computes tick x as col*120*zoom + viewportX, relative to the canvas container origin, which is also the React Flow pane origin. It draws the ticks inside a ruler div shifted by marginLeft: thickness (20 px), and the vertical ruler by marginTop: 20. Every column number therefore sits 20 px right of the actual column boundary, and every row number 20 px below the row boundary. The rulers are absolutely positioned over the canvas, which is not offset, so at the default viewport (0,0) they cover the top and left 20 px of any widget at row 0 or col 0, including its type badge (top:4, left:4) and lock icon.
  - components/scada-builder/CanvasRuler.tsx:40-49 x = col*GRID_CELL_W*zoom + viewportX; L74-80 horizontal ruler 'absolute top-0 left-0 right-0 z-30' with marginLeft: thickness; L109-115 vertical ruler with marginTop: thickness
  - components/scada-builder/ScreenCanvas.tsx:892 container 'w-full h-full relative'; L907 <ReactFlow> fills it with no offset; L986-992 CanvasRuler inside the same container
  - components/scada-builder/nodes/ScadaWidgetNode.tsx:108-113 BADGE_STYLE top:4,left:4
- **PLACE-15** (PLACE; verdict PARTIAL; severity LOW): Click-to-add, FUXA library and template insertion always place at grid (2,2), stacking items invisibly and ignoring the visible viewport
  - Claim: Every non-drag insertion hard-codes grid (2,2), with no viewport or collision logic: palette card click/Enter (both the main list and the Recent strip), FUXA browser selection (click only) and template apply (click only, no drag). Repeated clicks stack widgets exactly on top of each other, and after panning the new widget can be off-screen.
  - components/scada-builder/UnifiedLeftPanel.tsx:421-439 onAdd position { col: 2, row: 2, ... }; L230-239 WidgetCard onClick={() => onAdd(w)}
  - UnifiedLeftPanel.tsx:280-296 handleFuxaWidgetSelect position { col: 2, row: 2, w: 2, h: 2 }
  - components/scada-builder/WidgetTemplatePanel.tsx:38-39 applyTemplate(activeScreenId, templateId, { col: 2, row: 2 })
  - store/scada/templateSlice.ts:29-43 pushes at the given position, with no collision or viewport logic
  - (verifier) components/scada-builder/UnifiedLeftPanel.tsx:421-439 onAdd position {col:2,row:2}; L230-239 and L531-538 onClick={() => onAdd(w)}
  - (verifier) UnifiedLeftPanel.tsx:280-296 handleFuxaWidgetSelect {col:2,row:2,w:2,h:2}
  - (verifier) components/scada-builder/WidgetTemplatePanel.tsx:36-40 applyTemplate(..., {col:2,row:2}) (no drag handlers); store/scada/templateSlice.ts:29-43
  - (verifier) drop path is correct: ScreenCanvas.tsx:828-831 screenToFlowPosition
  - Verifier: The claim holds. Drag-and-drop, the primary path, places correctly, and the stacked widgets are recoverable by dragging, so the severity drops to LOW.
- **PLACE-16** (PLACE; verdict CONFIRMED; severity LOW): Repeated paste stacks copies exactly on top of each other
  - Claim: pasteWidgets always offsets the clipboard copy +1/+1 from the clipboard source and never advances the clipboard, so N pastes, or Ctrl+D (copy then paste), stack at the same cell. Context-menu Paste ignores the click location.
  - store/scada/selectionSlice.ts:160-165 newWidget = deepClone(clipboard widget); newWidget.position.col += 1; row += 1 (clipboard unchanged)
  - hooks/useScadaKeyboardShortcuts.ts:67-72 Ctrl+V -> pasteWidgets()
  - components/scada-builder/CanvasContextMenu.tsx:145-148 handlePaste ignores the menu position
  - (verifier) store/scada/selectionSlice.ts:157-165 newWidget.position.col += 1; row += 1; the clipboard is not updated
  - (verifier) hooks/useScadaKeyboardShortcuts.ts:67-83 Ctrl+V / Ctrl+D
  - (verifier) components/scada-builder/CanvasContextMenu.tsx:145-148 handlePaste -> pasteWidgets() with no position
  - Verifier: This is a direct read. Minor and recoverable.
- **PLACE-17** (PLACE; verdict CONFIRMED; severity LOW): 'Focus on Selection' dispatches an event nobody listens to
  - Claim: 'Focus on Selection' dispatches window CustomEvent 'scada-zoom-to-bounds', and nothing listens for it.
  - components/scada-builder/AlignmentToolbar.tsx:56-70 window.dispatchEvent(new CustomEvent('scada-zoom-to-bounds', ...))
  - grep 'scada-zoom-to-bounds' across src finds only AlignmentToolbar.tsx:66
  - (verifier) components/scada-builder/AlignmentToolbar.tsx:56-70 dispatchEvent
  - (verifier) grep 'zoom-to-bounds' across web/: only AlignmentToolbar.tsx:66
  - Verifier: There is no listener anywhere in web/.

</details>

## F. Package lifecycle and persistence

### SENSOR-HIGH-311

**Unsaved SCADA work is silently discarded on in-app navigation (builder has only beforeunload; unified editor has no guard; a singleton store is reset/rehydrated by other pages)**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 2, PARTIAL 1, SELF 1
- Rule: Persistence round-trips without silent data loss

**Claim.** Overlaps OPS SAVE-01. The only guard is beforeunload. The shell uses a declarative BrowserRouter (react-router 7, ConfiguredBrowserRouter), so no navigation blocker exists or could even be used without a data router. Returning to /scada-builder/:id remounts, refetches and calls loadFromJSON, which replaces the store and sets isDirty=false. Returning to /new calls reset(). Opening the unified editor (scadaReset on mount) or the operator page (loadFromJSON into the same singleton store) also wipes builder work.

**What the user sees.** I edit screens, click 'Automation' in the sidebar to write the program, then come back to the package. All my unsaved widget work is gone and no warning appeared. This happens in exactly the build-SCADA → write-program → link workflow.

**Root cause.** Hydration does not check whether the store holds unsaved work for the same package, and leaving the builder in-app is not intercepted.

**Fix direction.** Block in-app navigation while isDirty (react-router useBlocker + confirm). On mount, skip server hydration when the store already holds a dirty doc for the same packageId, or offer restore/discard.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:187-197`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:219-227`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:349-374`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:181-185,219-227`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:351-354`
- `web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:28-40`
- `web/modules/sensor-module/src/store/scada/createScadaStore.ts:52`
- `web/shell/src/bootstrap.tsx:161`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-291`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:109-115`
- `web/modules/sensor-module/src/hooks/useStEditor.ts:539`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:729-733`
- `web/modules/sensor-module/src/hooks/useStEditor.ts:539-540`
- `web/modules/sensor-module/src/components/unified-editor/ScreenManager.tsx:45-51`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1037`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:423-430`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:811-814`
- `web/modules/sensor-module/src/pages/unified/__tests__/UnifiedEditorPage.routeParam.test.tsx:65`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-02** (LIFE; verdict CONFIRMED; severity HIGH): Unsaved builder edits are silently discarded on any in-app navigation and return
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:187-197 (beforeunload only)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:219-227 (load effect unconditionally calls loadFromJSON on fetch)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:349-374 (loadFromJSON overwrites everything, isDirty=false)
  - grep useBlocker/usePrompt-for-navigation in sensor-module/shell: none
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:181-185,219-227
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:349-374 (isDirty=false)
  - (verifier) web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:351-354 (scadaReset on mount)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaOperatorPage.tsx:28-40 (loadFromJSON into the same singleton)
  - (verifier) web/modules/sensor-module/src/store/scada/createScadaStore.ts:52 (module singleton)
  - (verifier) grep useBlocker/unstable_usePrompt in web/: none (shared-ui usePrompt is a text-input dialog); web/shell/src/bootstrap.tsx:161 ConfiguredBrowserRouter
  - Verifier: I checked both sides, and there is no navigation blocker or dirty-check in hydration. The user's workflow (build, go to the Automation page, come back) hits this directly.
- **SAVE-01** (OPS; verdict PARTIAL; severity HIGH): A failed save still opens deploy, and leaving the builder in-app discards unsaved work without a warning
  - Claim: The core holds: handleSave swallows errors, and handleDeployClick opens the deploy dialog regardless, which deploys the server copy by packageId while previewing the local unsaved doc. One sub-claim is wrong. With an empty name on an already-saved package, the dialog DOES open with the stale server version. For a never-saved package it does not render, because effectivePackageId is undefined, but showDeployDialog stays true, so the dialog pops up unexpectedly after the next successful save. Severity is raised to HIGH because saves fail deterministically for some packages (LIFE-08 base64 images, LIFE-23 body size), so deploy then always ships a stale version. Duplicates LIFE-02 and LIFE-07.
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-291 (handleSave swallows errors; early return on empty name), 300-305 (deploy after save regardless), 187-197 (beforeunload only)
  - web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:109-115 (Back Link)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:181-185,219-227 (reset / loadFromJSON on navigation)
  - (verifier) pages/scada/ScadaPackageBuilderPage.tsx:252-291 (early return on empty name; catch without rethrow), 300-305 (setShowDeployDialog(true) unconditionally), 467-479 (renders only when effectivePackageId; onDeploy sends packageId+deviceId; preview uses toScadaPackageJSON())
  - (verifier) ScadaPackageBuilderPage.tsx:187-197 (beforeunload only); ScadaBuilderToolbar.tsx:109-115 (Back Link); :181-185,219-227 (reset/loadFromJSON)
  - Verifier: Reading the render guard corrects the empty-name sub-claim. The E2E impact is higher than MEDIUM.
- **JRN-03** (JOUR; verdict CONFIRMED; severity HIGH): The unified editor (the 'default' editor) has no unsaved-changes guard at all: reload, tab close, Back or any sidebar click discards P&ID and HMI work
  - Claim: Holds. The shell mounts a declarative ConfiguredBrowserRouter, not a data router, so react-router's useBlocker is unavailable. The fix needs a data-router migration or a custom history guard, not just a hook. The PLC-mode ST editor modal has its own beforeunload, but it covers only ST dirty state, never P&ID or HMI.
  - grep beforeunload\|useBlocker in web/modules/sensor-module/src: only pages/scada/ScadaPackageBuilderPage.tsx:187-197 and hooks/useStEditor.ts:539; none in pages/unified/UnifiedEditorPage.tsx or pages/process/ProcessEditorPage.tsx
  - grep beforeunload\|useBlocker in web/shell/src and web/shared-ui/src: none
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:729-733 ('Unsaved' badge), :712-718 (Back Link to /sensor/processes)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:351-354 (scadaReset on mount), :449-495 (process reloaded from server)
  - (verifier) grep beforeunload\|useBlocker\|onbeforeunload across web/\*_/_.{ts,tsx,js,html}: only ScadaPackageBuilderPage.tsx:187-197 and hooks/useStEditor.ts:539-540 (usePrompt hits are dialog prompts, not navigation guards)
  - (verifier) web/shell/src/bootstrap.tsx:161 (ConfiguredBrowserRouter, declarative)
  - (verifier) UnifiedEditorPage.tsx:729-733 ('Unsaved' badge only), :712-718 (Back Link with no guard)
  - (verifier) UnifiedEditorPage.tsx:351-354 (scadaReset on [id] mount), :443-495 (process reloaded from server, or startNewProcess for new)
  - Verifier: I checked for a shell-level or index.html guard, a persisted processStore, and a router blocker. None exist. On return, loadProcess and scadaReset overwrite everything. The unified editor is the target of every 'Proses şeması' link, so this is the main process path: an hour of P&ID and HMI work is lost on F5, tab close or any sidebar click.
- **LIFE-31** (LIFE-verifier; verdict SELF; severity MEDIUM): Unified editor: the default HMI screens for a new process are wiped on mount, so widget drops silently do nothing until '+' is clicked
  - Claim: ScreenManager, a child of UnifiedEditorPage, creates 'Process' and 'Dashboard' screens in a mount-only effect when the store has none. React runs child passive effects before the parent's, so the parent's identity effect then runs scadaReset() (screens=[], activeScreenId=''). ScreenManager's effect never re-runs (empty deps). A new process, or any process without a linked package, therefore opens HMI mode with zero screens. ScreenCanvas.onDrop returns early when activeScreenId is empty, so dragged widgets disappear without feedback, and saving persists screens: [].
  - web/modules/sensor-module/src/components/unified-editor/ScreenManager.tsx:45-51 (mount-only default-screen effect)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:351-354 (scadaReset on [id], parent effect)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1037 (ScreenManager rendered unconditionally in the same commit; no early return before it)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:423-430 (reset clears screens and activeScreenId)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:811-814 (drop returns without activeScreenId)
  - web/modules/sensor-module/src/pages/unified/**tests**/UnifiedEditorPage.routeParam.test.tsx:65 (ScreenManager mocked, so the ordering is untested)

</details>

### SENSOR-HIGH-312

**When a package fails to load, the builder shows the previous package under the new id and Save overwrites the new package with it**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 1
- Rule: Persistence round-trips without silent data loss

**Claim.** useScadaPackageById sets error and scadaPackage=null and loading=false on failure. The builder never reads error and only resets the store on /new. The editor then renders the singleton store, which still holds the last package opened in the builder, unified editor or operator page. effectivePackageId is the route id, and Save is enabled because the stale name is non-empty, so Save calls updateScadaPackage(B, A's name + A's document). If the store was empty, the user sees an empty editor, and typing a name and saving overwrites B with an empty document.

**What the user sees.** I open package B on a flaky connection. The editor appears with package A's name and screens and no error message. If I don't notice and press Save, package B is replaced with A's content.

**Root cause.** The page treats 'not loaded' as 'loaded' and hydrates nothing, while the singleton store keeps another package's document.

**Fix direction.** Render an error/not-found state when error is set or scadaPackage is null for a real id, and disable Save. Reset the store whenever the route packageId differs from store.packageId, before rendering the editor.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:125-136`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:181-185`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:178`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:200-202`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:259-267`
- `apps/sensor-service/src/process/resolvers/process.resolver.ts:264-272`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:178,181-185,200-202`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:294-296`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-03** (LIFE; verdict CONFIRMED; severity HIGH): If loading a package fails, the editor shows the PREVIOUS package under the new id, and Save overwrites the new package with it
  - web/modules/sensor-module/src/hooks/useScadaPackage.ts:125-136 (catch → setError, scadaPackage=null, loading=false)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:181-185 (reset only when 'new')
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:178 (effectivePackageId = route id)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:200-202 (error never destructured), 334-343 (only the loading branch is handled)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:259-267 (update with route id + store content)
  - (verifier) web/modules/sensor-module/src/hooks/useScadaPackage.ts:125-136 (catch -> setError, setScadaPackage(null))
  - (verifier) apps/sensor-service/src/process/resolvers/process.resolver.ts:264-272 (nullable query returns null for unknown id)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:178,181-185,200-202 (error not destructured),334-343 (only loading handled),259-267
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:294-296 (Save disabled only on empty name / isSaving)
  - Verifier: There is no error/not-found branch. The store is a module singleton and is not reset on unmount. The trigger is conditional (a failed fetch or a null result), but the result is a silent overwrite of another package, so HIGH is kept.

</details>

### SENSOR-HIGH-313

**Deploy ships the stale server version when the pre-deploy save fails or is skipped, while the preview shows the unsaved local document**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 1
- Rule: Persistence round-trips without silent data loss

**Claim.** Overlaps OPS SAVE-01. handleSave swallows every error and returns silently on an empty name. handleDeployClick then always sets showDeployDialog. For an existing package the dialog opens, its preview is built from the unsaved local store, and the mutation deploys the persisted DB row. For a new package whose create failed, the dialog is not rendered (effectivePackageId is null) but showDeployDialog stays true, so it pops up unexpectedly after a later successful save.

**What the user sees.** I click Deploy with unsaved changes. The save fails, and a red 'Save failed' flashes for 5s, but the deploy dialog opens anyway and its preview shows my new screens. I deploy and the device receives the OLD saved version.

**Root cause.** The save result is not propagated, so deploy is not gated on a successful persist.

**Fix direction.** Make handleSave return a success boolean or throw, and open the dialog only after a successful save. Disable Deploy while isDirty, as in the unified editor. Build the preview from the persisted doc.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:253,284-287`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:473`
- `apps/sensor-service/src/process/services/scada-package.service.ts:929`
- `docs/reviews/sensor-expert/2026-07-11-unified-scada-editor-audit.md:185-191`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-291`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305,467-479`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-07** (LIFE; verdict CONFIRMED; severity HIGH): Deploy opens and ships the stale server version when the pre-deploy save fails or is skipped; the preview shows the unsaved local doc
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305 (no result check)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:253,284-287 (early return / swallowed error)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:473 (preview from local store)
  - apps/sensor-service/src/process/services/scada-package.service.ts:929 (deploy loads persisted row)
  - docs/reviews/sensor-expert/2026-07-11-unified-scada-editor-audit.md:185-191 (HIGH-044 scoped to UnifiedEditorPage only)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-291 (catch, no rethrow; early return on empty name)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305,467-479 (preview=toScadaPackageJSON())
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:929 (deploy loads the DB row)
  - Verifier: Both sides read. The preview shows content the device will not receive, which is a false-success path.

</details>

### SENSOR-HIGH-314

**Images embedded as base64 (stored twice) and the subgraph body limit make package saves fail**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 2
- Rule: Persistence round-trips without silent data loss

**Claim.** Background images (5 MB client cap, single data URL) and raster images (5 MB cap, the same data URL written to both imageSrc and imageData) are inlined into the package document. The client limit contradicts the 1 MiB service cap and the gateway's 1mb JSON body limit (nginx allows 10M). Any ordinary photo (about 760 KB as a background, about 380 KB as a raster widget) makes every later save fail with the generic message. If LIFE-23 holds (100 kb subgraph body limit), the threshold is about 75 KB for a background and about 37 KB for a raster image.

**What the user sees.** I add a plant photo or P&ID image as a canvas background or image widget. From then on every Save shows 'Save failed. Please try again.' and I can't save anything until I find and remove the image.

**Root cause.** Binary assets are inlined into the package document, and the client limit (5 MB) contradicts the server and gateway limits (1 MB).

**Fix direction.** Upload images to object storage (@platform/storage) and store a URL reference. Until that exists, make the client limit derive from the server cap and surface the size error.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/CanvasSettings.tsx:74-101`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1022-1028`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/RasterImageConfig.tsx:35,70,87,89`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:250,263`
- `apps/sensor-service/src/process/services/scada-package.service.ts:65,76-83`
- `apps/gateway-api/src/main.ts:58`
- `web/modules/sensor-module/src/components/scada-builder/CanvasSettings.tsx:76,88-101`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1024-1028`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/RasterImageConfig.tsx:35,67-71,85-89`
- `apps/gateway-api/src/main.ts:56-59`
- `infrastructure/nginx/droplet.conf:74`
- `apps/sensor-service/src/main.ts:29-70`
- `libs/backend-common/src/bootstrap/create-service-app.ts:739-746,771-775`
- `apps/sensor-service/src/process/services/scada-package.service.ts:65`
- `apps/sensor-service/src/main.ts:29-84`
- `libs/backend-common/src/bootstrap/create-service-app.ts:739-746`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-08** (LIFE; verdict CONFIRMED; severity HIGH): Uploaded background images and raster images (up to 5 MB, base64, stored twice) make every Save fail
  - web/modules/sensor-module/src/components/scada-builder/CanvasSettings.tsx:74-101 (MAX_BG_IMAGE_SIZE 5MB, readAsDataURL)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1022-1028 (updateScreen backgroundImage: dataUrl)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/RasterImageConfig.tsx:35,70,87,89 (5MB; imageSrc AND imageData)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:250,263 (config and backgroundImage serialized verbatim)
  - apps/sensor-service/src/process/services/scada-package.service.ts:65,76-83 (1 MB cap)
  - apps/gateway-api/src/main.ts:58 (json limit 1mb)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/CanvasSettings.tsx:76,88-101
  - (verifier) web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1024-1028
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/RasterImageConfig.tsx:35,67-71,85-89
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:250,263
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:65,76-83
  - (verifier) apps/gateway-api/src/main.ts:56-59
  - (verifier) infrastructure/nginx/droplet.conf:74 (10M server-level; /graphql at 331 has no override)
  - Verifier: Both limits were read, and the arithmetic holds. Saving fails outright as soon as a real image is added.
- **LIFE-23** (LIFE; verdict CONFIRMED; severity MEDIUM): The sensor-service subgraph likely rejects package saves above ~100 KB (default body-parser limit)
  - Claim: sensor-service bootstraps with no body-limit override: no earlyMiddleware json(), no bodyParser options, and no json/bodyParserConfig anywhere in apps/sensor-service/src. NestFactory.create therefore registers Nest's default Express JSON parser (rawBody:true only adds verify), whose limit is body-parser's 100kb. That parser runs before the GraphQL middleware. Only the gateway raises its own limit to 1mb, and Apollo Gateway forwards the packageData variable in full, so a valid package between ~100 KB and 1 MiB would be refused by the subgraph with 413 and the builder would show the generic error. The 100kb default comes from framework knowledge and could not be executed (node_modules absent).
  - apps/sensor-service/src/main.ts:29-70 (no body-limit option)
  - libs/backend-common/src/bootstrap/create-service-app.ts:739-746,771-775 (NestFactory.create default parser; earlyMiddleware only)
  - apps/gateway-api/src/main.ts:56-59 (gateway-only 1mb)
  - apps/sensor-service/src/process/services/scada-package.service.ts:65
  - (verifier) apps/sensor-service/src/main.ts:29-84 (no earlyMiddleware / nestFactoryOptions)
  - (verifier) libs/backend-common/src/bootstrap/create-service-app.ts:739-746 (NestFactory.create with default bodyParser),773-775
  - (verifier) grep 'json({\|bodyParser\|bodyParserConfig' in apps/sensor-service/src: none; only gateway-api and billing set parser options
  - (verifier) apps/gateway-api/src/main.ts:56-59
  - Verifier: The service-side absence of an override is verified. The limit value is a NestJS/Express default that is well known but not executed here. The RAS demo is about 30 KB of JSON (42 widgets), so roughly 140 widgets or one small image reaches the limit.

</details>

### SENSOR-HIGH-315

**Opening a saved package with an empty store appends an empty "Screen 1", switches to it and marks the package dirty**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: SELF 1
- Rule: Persistence round-trips without silent data loss

**Claim.** On /scada-builder/:id the hook starts with loading=true. When the fetch resolves, setScadaPackage(pkg) and setLoading(false) are batched into one render (React 19 createRoot), and in that render the store still has screens=[] when the store was empty (first open after a page load or F5, after visiting the unified editor, which resets the store, or after logout or a tenant switch). In that commit's effects, the load effect (line 219) runs loadFromJSON first. The 'ensure at least one screen' effect (line 245) then re-runs because loadingPackage changed, with its render-time closure screens.length===0, and calls addScreen('dashboard','Screen 1'). addScreen appends a new empty screen, sets activeScreenId to it and sets isDirty=true. The user lands on a blank canvas with the 'unsaved' state on. Because isDirty is now true, Deploy calls handleSave before deploying, persisting the extra screen (version++), and every reload-then-save adds another empty 'Screen 1'.

**What the user sees.** I open my saved package from the list (or press F5 in the builder). Instead of my screen I see an empty canvas on a new tab called 'Screen 1', and the package already says it has unsaved changes. If I click Deploy or Save, an empty 'Screen 1' is added to my package, and a new one appears every time I reload.

**Root cause.** A defaulting effect uses a stale render-time screen count and is not tied to hydration. Hydration happens in an effect, after the render that already dropped the loading gate.

**Fix direction.** Hydrate synchronously as part of the load state, for example by deriving 'loaded doc' state and gating rendering on store.packageId === routeId. Restrict default-screen creation to the /new path, or read get().screens inside the action instead of a closure. Add a page-level test: mount with an empty store, resolve the fetch, assert screens equal the server doc and isDirty is false.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:244-249`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:219-227`
- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:112,125-136`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:13-33`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:351-354`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:239-265`
- `web/shell/src/bootstrap.tsx:157`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-30** (LIFE-verifier; verdict SELF; severity HIGH): Opening a saved package when the editor store is empty appends an empty 'Screen 1', switches to it and marks the package dirty; Deploy then silently saves the junk screen
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:244-249 (effect deps [screens.length, addScreen, loadingPackage]; closure value used)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:219-227 (load effect declared earlier, so it runs first in the same flush)
  - web/modules/sensor-module/src/hooks/useScadaPackage.ts:112,125-136 (initial loading=true; setScadaPackage then finally setLoading(false) in the same continuation)
  - web/modules/sensor-module/src/store/scada/sceneSlice.ts:13-33 (addScreen: isDefault=false when screens exist, activeScreenId=new id, isDirty=true)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:351-354 (scadaReset leaves screens=[] for the next builder open)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:300-305 (Deploy saves when isDirty)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:239-265 (extra screen serialized)
  - web/shell/src/bootstrap.tsx:157 (createRoot, so automatic batching)
  - No test covers ScadaPackageBuilderPage (no pages/scada/**tests**)

</details>

### SENSOR-HIGH-318

**Builder and unified editor create disjoint, mutually unreadable packages for the same plant (P&ID and HMI are unrelated drawings); delete only archives and deleted HMIs are re-adopted**

- Severity: HIGH · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 4, PARTIAL 1
- Rule: Persistence round-trips without silent data loss

**Claim.** Holds as stated, with two additions. (1) The backend update path already accepts processId (scada-package.service.ts:476-498), and the store already serializes meta.processId (projectSlice.ts:233). But no FE caller ever sends processId on update, and the server never derives row.process_id from meta.processId, so a builder package cannot be linked to a process from either editor. (2) Several parts restate established IDs: the deploy divergence is DEP-09 (builder single path never ships programs) and XPORT-02 (bundle path refused in prod); the '0 screens' second package comes from LIFE-31; opening that package in the builder gives an empty name (LIFE-14). New here: the editor topology defect itself. Two editors own the same aggregate, there is no linkage UI, and the unified save always auto-creates the package.

**What the user sees.** I build my HMI under 'SCADA ve proses'. When I open my process under 'Proses şeması' and switch to the HMI tab, it is empty. After I save there, the package list shows a second package '<my process> HMI' with 0 screens next to mine. Nothing tells me which one belongs to the process, and the same package deploys differently depending on which editor I press Deploy in.

**Root cause.** Two editors own the same aggregate. The process↔package link is set only by an unreachable entry point and is never editable, and the unified save treats the 'create if none linked' path as a default instead of an explicit choice.

**Fix direction.** Keep one editor that owns both P&ID and HMI, or make process linkage an explicit field: pick a process in the package editor, or pick an existing package from the process. Never auto-create a package on process save. Show the linked process in the list. Use one deploy mutation for every entry point.

**Evidence (canonical citations).**

- `web/shell/src/console/nav/pages/sensor.ts:60-69`
- `web/shared-ui/src/i18n/locales/tr.ts:1613-1614`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:270-276,324-330`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:65,237-242,270-274`
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:589-592`
- `web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:204,289,360,415`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:52`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ProcessViewConfig.tsx:17-18`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:315-318`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:642-657`
- `apps/sensor-service/src/process/services/scada-package.service.ts:487-503`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:150-253`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:45,207,476-478`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:307,1276`
- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:234-269`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:65`
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:379`
- `web/shell/src/console/nav/pages/sensor.ts:75-76`
- `web/modules/sensor-module/src/pages/process/ProcessTemplatesPage.tsx:90,175`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:239`
- `apps/sensor-service/src/process/services/scada-package.service.ts:445-463`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:313-318`
- `apps/sensor-service/src/process/services/scada-package.service.ts:502`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:207,476-478`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:449-463`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:643`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1004-1009`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1179-1181`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:240`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1055`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1180-1181`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1037`
- `web/modules/sensor-module/src/components/unified-editor/ScreenManager.tsx:84-100`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:381`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:92-99`
- `apps/sensor-service/src/process/services/scada-package.service.ts:692-710`
- `apps/sensor-service/src/process/services/scada-package.service.ts:467-506`
- `apps/sensor-service/src/process/services/scada-package.service.ts:915-921,931,1386`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:315-318,507-516`
- `apps/sensor-service/src/database/migrations/1806000000000-ScadaPackageProcessUnique.ts:41-45`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:56,60-65,92-99`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:315-318,503-516`
- `apps/sensor-service/src/process/entities/scada-package.entity.ts:38-43`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:641-656`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:270-274`
- `apps/sensor-service/src/process/services/scada-package.service.ts:445-464`
- `apps/sensor-service/src/database/migrations/1806000000000-ScadaPackageProcessUnique.ts:42-46`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:503-516`
- `web/modules/sensor-module/src/Module.tsx:136-144`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:650-654`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:232`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:221-225,253`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:296`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:222,319,350`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:232,350`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:294-296`

<details><summary>Merged audit findings and full evidence</summary>

- **JRN-01** (JOUR; verdict CONFIRMED; severity HIGH): Builder and unified editor create disjoint packages for the same plant: a builder package can never be linked to a process, and the unified editor silently creates a second, empty '<process> HMI' package
  - web/shell/src/console/nav/pages/sensor.ts:60-69 ('SCADA & process' → /sensor/scada-packages) and :70-80 ('Process diagram' → /sensor/processes); web/shared-ui/src/i18n/locales/tr.ts:1613-1614
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:270-276,324-330 (New/Create Package → /sensor/scada-builder/new, no processId)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:65,237-242,270-274 (processId only from ?processId=; create sends it), :259-267 (update sends name+packageData only)
  - web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:589-592 is the only emitter of ?processId=; the page has no inbound link (ProcessListPage.tsx:204,289,360,415 all → unified-editor)
  - grep: scada store setProcessId (store/scada/projectSlice.ts:52) is called only by ScadaPackageBuilderPage; no process picker in components/scada-builder (only free-text ProcessViewConfig.tsx:17-18)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:315-318 (linked query filtered by processId), :503-516 (adopt only if pkg.processId === id)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:642-657 (save always update-or-create package `${processName} HMI`, no HMI-dirty check)
  - apps/sensor-service/src/process/services/scada-package.service.ts:487-503 (every update rewrites packageData and does version+1)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:150-253 (columns: name, version, status, screens, updated, actions; no process)
  - Deploy divergence: ScadaPackageBuilderPage.tsx:45,207,476-478 (useDeployScadaPackage → deployScadaPackageToEdge) vs UnifiedEditorPage.tsx:307,1276 (useDeployScadaBundle → deployScadaWithAutomation); hooks/useScadaPackage.ts:234-269
  - (verifier) ScadaPackageBuilderPage.tsx:65 (processId only from ?processId=), :237-242 (import only on /new + processId), :259-266 (update sends {name, packageData} only), :268-274 (create spreads processId)
  - (verifier) ProcessEditorPage.tsx:589-592 is the only emitter of ?processId=; grep for '/sensor/process/' links: only ProcessEditorPage.tsx:379 replaceState plus nav matchPaths (sensor.ts:75-76); ProcessListPage.tsx:204,289,360,415 and ProcessTemplatesPage.tsx:90,175 all link to /sensor/unified-editor
  - (verifier) grep setProcessId: scada store setter is called only at ScadaPackageBuilderPage.tsx:239; useUpdateScadaPackage/useCreateScadaPackage are used only by the builder and UnifiedEditorPage
  - (verifier) Backend: scada-package.service.ts:445-463 (create with ...input), :476-498 (update applies input.processId only when sent); no reader of meta.processId in apps/sensor-service/src/process
  - (verifier) UnifiedEditorPage.tsx:313-318 (linked query by processId, disabled for 'new'), :503-516 (adopt linkedPackages[0] only if pkg.processId === id), :642-657 (if resolvedProcessId: update, or create `${processName} HMI`; no HMI-dirty check, so every P&ID save writes the package)
  - (verifier) scada-package.service.ts:502 (version+1 on every update)
  - (verifier) ScadaPackageListPage.tsx:150-253 (columns: Package Name, Version, Status, Screens, Last Updated, Actions; no process)
  - (verifier) Deploy: ScadaPackageBuilderPage.tsx:207,476-478 (useDeployScadaPackage → deployScadaPackageToEdge) vs UnifiedEditorPage.tsx:307,1276 (useDeployScadaBundle → deployScadaWithAutomation); hooks/useScadaPackage.ts:234-269
  - Verifier: I tried to refute the claim in three ways. Is there another linkage writer? No: grep finds no processId sent on update and no server-side meta.processId→row mapping. Is the ProcessEditorPage reachable? No: no Link or navigate targets /sensor/process/\*. Does the unified hydration have a fallback, such as adopting by name or an unfiltered list? No: the query is processId-scoped and enabled only for a real id. Every claimed seam holds. The user-visible result is real: two disjoint packages, no visible linkage, and two deploy mutations for one entity. HIGH is right: it makes the two natural entry points produce artifacts that never meet.
- **JRN-02** (JOUR; verdict CONFIRMED; severity MEDIUM): In the unified editor the P&ID drawing and the HMI are two unrelated drawings; 'Runtime' shows only the HMI (blank after drawing a P&ID) while the status bar still counts P&ID nodes
  - Claim: Holds. One addition sharpens it: ScreenManager, the HMI screen tab bar, is mounted in every mode, including P&ID. In P&ID mode, clicking an HMI screen tab only moves the P&ID viewport, because setActiveScreen in the iframe hides scadaWidget nodes only. Clicking '+' adds HMI screens and dirties the package. This shows the two drawings are glued together with no mapping.
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:449-463 (P&ID load → processStore + iframe), :614-636 (saved as Process nodes/edges)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:643 (HMI saved from scadaToJSON), :1059-1068 (HMI = ScreenCanvas), :1069-1082 (Runtime = ScreenCanvas isPreview on live provider, iframe hidden at :1055)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1004-1009 (HMI palette UnifiedLeftPanel vs P&ID EquipmentPanel)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1179-1181 (status bar shows canvasNodes/canvasEdges from P&ID in all modes)
  - grep importProcessAsWidget: only ScadaPackageBuilderPage.tsx:240 (nodes: [], edges: []); no other P&ID→HMI mapping in web/modules/sensor-module/src
  - (verifier) UnifiedEditorPage.tsx:449-463 (P&ID load into processStore + iframe), :614-636 (saved as Process nodes/edges), :643 (HMI saved from scadaToJSON)
  - (verifier) UnifiedEditorPage.tsx:1055 (iframe hidden in hmi/runtime), :1059-1068 (HMI = ScreenCanvas), :1069-1082 (Runtime = ScreenCanvas on StableModeProvider mode='preview')
  - (verifier) UnifiedEditorPage.tsx:1004-1009 (HMI palette UnifiedLeftPanel vs P&ID EquipmentPanel)
  - (verifier) UnifiedEditorPage.tsx:1180-1181 (status bar shows canvasNodes/canvasEdges, the P&ID iframe mirror, in every mode)
  - (verifier) UnifiedEditorPage.tsx:1037 (ScreenManager rendered unconditionally); ScreenManager.tsx:84-100; canvas/main.jsx:903-913 (setActiveScreen only toggles scadaWidget nodes)
  - (verifier) grep importProcessAsWidget\|nodesToWidgets\|pidToHmi in sensor-module/src: only projectSlice.ts:381 and the builder caller ScadaPackageBuilderPage.tsx:240 (nodes: [], edges: [])
  - Verifier: I looked for any P&ID→HMI projection: an overlay sync, a store subscriber, or a backend transform. The legacy iframe overlay messages (addOverlayNode etc. in main.jsx:819-853) have no host sender since the HMI moved to ScreenCanvas, as the UnifiedEditorPage comment at :584-585 says. No mapper exists. Runtime therefore renders only the HMI doc, which is empty for a P&ID-only process (zero screens per LIFE-31), while the status bar counts P&ID nodes. MEDIUM is right: the user is confused and must redo work, but the process path is not corrupted.
- **LIFE-06** (LIFE; verdict CONFIRMED; severity MEDIUM): Delete only archives: the package stays in the list, stays editable, and a process's deleted HMI is re-adopted by the unified editor and becomes permanently undeployable
  - Claim: Delete only sets status=ARCHIVED (after a best-effort undeploy). The confirm text says screens and deployment history 'are removed'. The default 'all' filter keeps the row listed (with an honest 'Archived' badge). updateScadaPackage has no status check, so the package stays editable. ARCHIVED is terminal: no path returns it to DRAFT. The unified editor adopts linkedPackages[0] without a status filter and keeps saving into the archived row, and both deploy paths reject it with 'archived (deleted) and cannot be deployed'. For a process-linked HMI this is a permanent trap. Standalone builder packages are only confusing (the user can create a new one).
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:92-99 (confirm text) and 56,60-65 (default 'all' filter)
  - apps/sensor-service/src/process/services/scada-package.service.ts:692-710 (archive, no unlink)
  - apps/sensor-service/src/process/services/scada-package.service.ts:467-506 (update allows ARCHIVED)
  - apps/sensor-service/src/process/services/scada-package.service.ts:915-921,931,1386 (deploy rejects ARCHIVED)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:315-318,507-516 (adopts linkedPackages[0], no status filter)
  - apps/sensor-service/src/database/migrations/1806000000000-ScadaPackageProcessUnique.ts:41-45
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:56,60-65,92-99
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:692-710 (archive, process_id kept)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:467-506 (no status check), 496-503
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:915-921,931,1386
  - (verifier) web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:315-318,503-516
  - (verifier) grep 'ScadaPackageStatus.DRAFT' in sensor-service: only create (line 460), so there is no un-archive
  - Verifier: Every seam is as described. Severity is lowered because the user's main flow uses standalone builder packages, where the effect is confusion rather than a dead end.
- **LIFE-05** (LIFE; verdict PARTIAL; severity LOW): Creating a process-linked package fails for any process that already has a package (including deleted ones), and the Process Editor always links to /new
  - Claim: The partial unique index uq_scada_packages_tenant_process (no status predicate) and the create path without a pre-check are real. A builder create that carries processId fails with the generic 'Save failed' when that process already has a package, archived or not. However, the only builder create that sends processId comes from ?processId=, which only the legacy, unlinked ProcessEditorPage produces (see LIFE-04). Builder packages created from the package list have a NULL process_id and are unconstrained. The reachable in-app trigger is a narrow race in the unified editor: HMI edits made before the linked-package query resolves skip adoption (scadaDirty guard), so save calls createPkg and hits the index. The unified editor at least shows the server message.
  - apps/sensor-service/src/process/entities/scada-package.entity.ts:38-43
  - apps/sensor-service/src/database/migrations/1806000000000-ScadaPackageProcessUnique.ts:41-45 (no status predicate)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:641-656 (createPkg with processId when no linked package)
  - web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:589-592 (always /new)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:270-274 (create sends processId)
  - apps/sensor-service/src/process/services/scada-package.service.ts:445-464 (no existence pre-check)
  - (verifier) apps/sensor-service/src/database/migrations/1806000000000-ScadaPackageProcessUnique.ts:42-46
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:445-464 (no existence check)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:270-274 (processId only from URL)
  - (verifier) web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:503-516 (adoption skipped when scadaDirty), 641-656 (createPkg when no scadaPackageId)
  - (verifier) web/modules/sensor-module/src/Module.tsx:136-144
  - Verifier: The DB invariant and the missing error mapping hold, but the claimed entry point is not reachable through normal in-app navigation.
- **LIFE-14** (LIFE; verdict CONFIRMED; severity LOW): Packages created by the unified editor open in the builder with an empty name and a disabled Save
  - Claim: The unified editor never sets the scada store's packageName (setPackageName is called only by the builder), so its created docs carry meta.packageName '' while row.name is '<process> HMI'. The builder sets row.name and then loadFromJSON overwrites it with meta.packageName\|\|''. The name field is empty, Save is disabled, and Ctrl+S and Deploy's pre-save return silently. Typing a name restores Save.
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:650-654 (row name set, store packageName never set; grep setPackageName: only builder)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:232 (meta.packageName from store), 350 (load overrides name)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:221-225,253
  - web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:296
  - (verifier) web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:650-654
  - (verifier) grep setPackageName: only ScadaPackageBuilderPage.tsx:222,319,350
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:232,350
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:294-296
  - Verifier: Confirmed. It is regraded to LOW because only unified-editor-created packages are affected and the user can type a name to recover.

</details>

### SENSOR-MEDIUM-316

**Save and delete failures discard or hide the server's reason**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 2
- Rule: Persistence round-trips without silent data loss

**Claim.** The builder's catch replaces every GraphQLClientError (which carries the server message) with the literal 'Save failed. Please try again.' for 5 s. The unified editor shows error.message for the same mutations. Note: in production sensor-service's ValidationPipe also collapses DTO errors to 'Bad Request'. The service's specific BadRequest texts (size, V2 schema, scripts) are what the builder discards.

**What the user sees.** Save keeps failing with 'Save failed. Please try again.' and nothing tells me whether my image is too big, a script is too long, or the package already exists.

**Root cause.** The catch block replaces the error with a literal string.

**Fix direction.** Show (err as GraphQLClientError).message, plus a mapped hint for known codes, and keep the error visible until the next save attempt.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:284-287`
- `web/shared-ui/src/utils/api-client.ts:868-898`
- `apps/sensor-service/src/process/services/scada-package.service.ts:76-166`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:665-666`
- `apps/sensor-service/src/main.ts:69-82`
- `apps/sensor-service/src/process/resolvers/process.resolver.ts:363-386`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:104-109`
- `apps/sensor-service/src/process/resolvers/process.resolver.ts:326-327,337-338,363-385`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:104-109,241-247`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-11** (LIFE; verdict CONFIRMED; severity MEDIUM): The save error UX discards the server's reason
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:284-287
  - web/shared-ui/src/utils/api-client.ts:868-898 (throws GraphQLClientError with server message)
  - apps/sensor-service/src/process/services/scada-package.service.ts:76-166 (specific BadRequest messages)
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:665-666 (contrast: shows message)
  - (verifier) web/shared-ui/src/utils/api-client.ts:868-898
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:76-166
  - (verifier) web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:665-666
  - (verifier) apps/sensor-service/src/main.ts:69-82 (prod 'Bad Request' for DTO errors)
  - Verifier: Confirmed. It matters because LIFE-08, LIFE-23 and V2 failures are otherwise undiagnosable.
- **LIFE-17** (LIFE; verdict CONFIRMED; severity LOW): Delete failures are silent
  - Claim: deleteScadaPackage is @Roles(TENANT_ADMIN), while create and update allow MODULE_MANAGER. The Delete action is shown to everyone. A Forbidden error is only console.error'd, and the {success:false,message} envelope and the success message (which names devices the undeploy could not reach) are both ignored.
  - apps/sensor-service/src/process/resolvers/process.resolver.ts:363-386 (Roles TENANT_ADMIN; errors → success:false)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:104-109 (result ignored; console.error)
  - (verifier) apps/sensor-service/src/process/resolvers/process.resolver.ts:326-327,337-338,363-385
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:104-109,241-247
  - Verifier: Both sides were read. It does not affect building a working process.

</details>

### SENSOR-MEDIUM-317

**No optimistic concurrency (last writer wins across tabs, editors and engineers), and edits made during an in-flight save are marked clean without being saved**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 2
- Rule: Persistence round-trips without silent data loss

**Claim.** updateScadaPackage replaces packageData wholesale and increments a plain int version with no expected-version check. Neither the DTO nor the client carries a concurrency token, and meta.version is hard-coded to 1. The service's own backfill comment says save() has no version check. Last writer wins silently across tabs, users, and builder vs unified editor.

**What the user sees.** A colleague and I (or I in two tabs, or the builder and the unified editor) save the same package. One person's screens vanish with no conflict warning.

**Root cause.** version is a counter, not a concurrency token.

**Fix direction.** Add expectedVersion to UpdateScadaPackageInput and do a conditional UPDATE ... WHERE version = :expected (or a TypeORM @VersionColumn). Return a conflict error and let the UI reload or merge.

**Evidence (canonical citations).**

- `apps/sensor-service/src/process/services/scada-package.service.ts:467-506`
- `apps/sensor-service/src/process/dto/scada-package.dto.ts:35-62`
- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:177-196`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:231`
- `apps/sensor-service/src/process/services/scada-package.service.ts:531-536`
- `apps/sensor-service/src/process/entities/scada-package.entity.ts:63-64`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:258`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:81-84`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:258,261-276,281`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-13** (LIFE; verdict CONFIRMED; severity MEDIUM): No optimistic concurrency: the last writer silently overwrites (two tabs, builder vs unified editor, two engineers)
  - apps/sensor-service/src/process/services/scada-package.service.ts:467-506 (version++ at 502, no check)
  - apps/sensor-service/src/process/dto/scada-package.dto.ts:35-62 (no expectedVersion field)
  - web/modules/sensor-module/src/hooks/useScadaPackage.ts:177-196
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:231 (meta.version: 1)
  - apps/sensor-service/src/process/services/scada-package.service.ts:531-536 (comment: no version check)
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:467-506 (version++ at 502)
  - (verifier) apps/sensor-service/src/process/dto/scada-package.dto.ts:35-62
  - (verifier) apps/sensor-service/src/process/entities/scada-package.entity.ts:63-64 (plain @Column, not @VersionColumn)
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:231
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:531-536
  - Verifier: Both sides were read.
- **LIFE-12** (LIFE; verdict CONFIRMED; severity MEDIUM): Edits made while a save is in flight are marked clean without being saved
  - Claim: packageData is snapshotted before the await, and markClean() runs unconditionally afterwards. Edits made during the request become 'clean' without being saved, so Deploy skips its pre-save and beforeunload stops warning. On create, the navigate to /:id remounts the load path and loadFromJSON drops them as well.
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:258 (snapshot), 261-276 (await), 281 (markClean)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:81-84 (markClean unconditional)
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:258,261-276,281
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:81-84
  - Verifier: The code is unambiguous. The window is short but the loss is silent.

</details>

### SENSOR-MEDIUM-320

**Export/import and templates lose data: screen JSON drops most fields, widget templates are memory-only, PDF export is invalid**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 4, PARTIAL 1
- Rule: Persistence round-trips without silent data loss

**Claim.** Holds. Duplicate of LIFE-18.

**What the user sees.** Exporting a screen and importing it into another package loses all click actions, animations, role rules, layer names, locks, hidden flags, stacking order and the background picture. A bad file fails with no message.

**Root cause.** screenIO was written separately from the package serializer.

**Fix direction.** Build exportScreen and importScreen on the same per-screen serializer used by toScadaPackageJSON and loadFromJSON, including the upcast, and surface import errors in the UI.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/screenIO.ts:20-25`
- `web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:392-393`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:251-264`
- `web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:405-418`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:246-264`
- `web/modules/sensor-module/src/store/scada/screenIO.ts:13-38`
- `web/modules/sensor-module/src/store/scada/screenIO.ts:44-88`
- `web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:390-423`
- `web/modules/sensor-module/src/store/scada/screenIO.ts:13-38,44-88`
- `web/modules/sensor-module/src/store/scada/templateSlice.ts:4-41`
- `web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:228-238`
- `web/modules/sensor-module/src/components/scada-builder/WidgetTemplatePanel.tsx:42-53`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:224-281`
- `web/modules/sensor-module/src/store/scada/templateSlice.ts:4-43`
- `web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:237,326`
- `web/modules/sensor-module/src/store/scada/templateSlice.ts:7-22`
- `web/modules/sensor-module/src/store/scada/templateSlice.ts`
- `web/modules/sensor-module/src/components/scada-builder/WidgetTemplatePanel.tsx`
- `web/modules/sensor-module/src/store/scada/selectionSlice.ts:102-134`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:47-55`
- `web/modules/sensor-module/src/store/scada/templateSlice.ts:7-22,29-43`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:224-284`
- `web/modules/sensor-module/src/store/scada/widgetSlice.ts:46-54`
- `apps/sensor-service/src/process/services/scada-package.service.ts:1243,1290-1297`
- `web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:109-114`
- `web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:186-205`
- `web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:268-274`
- `web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:103-115`
- `web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:186-216,262-266`

<details><summary>Merged audit findings and full evidence</summary>

- **SCREENIO-01** (OPS; verdict CONFIRMED; severity MEDIUM): Screen export and import silently drop widget events, animations, permissions, name, lock, visibility, z-order and the screen background
  - web/modules/sensor-module/src/store/scada/screenIO.ts:20-25 (export), 52-62 (import), 76-87 (screen fields)
  - web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:392-393 (download), 405-421 (import, console.error on failure)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:251-264 (the full set the package format keeps)
  - (verifier) store/scada/screenIO.ts:20-25 (export: id/widgetType/position/config only; no background), 48-62 (import rebuilds the same 4 fields), 76-87
  - (verifier) components/scada-builder/SceneTreePanel.tsx:405-418 (import failure → console.error only)
  - (verifier) store/scada/projectSlice.ts:246-264 (full field set)
  - Verifier: The data loss was confirmed by reading both functions.
- **LIFE-18** (LIFE; verdict CONFIRMED; severity LOW): Screen JSON export/import drops most widget and screen fields
  - Claim: Duplicate of OPS SCREENIO-01. exportScreen and importScreen carry only id/widgetType/position/config per widget and drop name/groupId/locked/visible/zIndex/permissions/animations/events and the screen's backgroundImage/backgroundOpacity. Additionally, the imported config keeps the source package's config.tagRef without re-upcasting, so imported widgets inherit a possibly foreign device binding (LIFE-01 class).
  - web/modules/sensor-module/src/store/scada/screenIO.ts:13-38 (export)
  - web/modules/sensor-module/src/store/scada/screenIO.ts:44-88 (import)
  - web/modules/sensor-module/src/components/scada-builder/SceneTreePanel.tsx:390-423 (wiring; console.error on failure)
  - contrast web/modules/sensor-module/src/store/scada/projectSlice.ts:246-264 (package serializer keeps them)
  - (verifier) web/modules/sensor-module/src/store/scada/screenIO.ts:13-38,44-88
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:246-264
  - Verifier: Confirmed. It is a side feature.
- **LIFE-19** (LIFE; verdict CONFIRMED; severity LOW): 'Save as Template' widget templates live only in memory and vanish on reload
  - Claim: Duplicate of OPS UI-01 and PLACE-22. widgetTemplates live only in Zustand state, are not serialized and are lost on reload. They also copy config verbatim, including any stale tagRef.
  - web/modules/sensor-module/src/store/scada/templateSlice.ts:4-41
  - web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:228-238
  - web/modules/sensor-module/src/components/scada-builder/WidgetTemplatePanel.tsx:42-53
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:224-281 (not serialized)
  - (verifier) web/modules/sensor-module/src/store/scada/templateSlice.ts:4-43
  - (verifier) web/modules/sensor-module/src/components/scada-builder/CanvasContextMenu.tsx:237,326
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:224-281
  - Verifier: Confirmed.
- **PLACE-22** (PLACE; verdict CONFIRMED; severity LOW): Saved widget templates are memory-only and drop animations, events and permissions; Cut leaves dangling automation bindings
  - Claim: saveAsTemplate keeps only widgetType, config and w/h, and widgetTemplates is never serialized, so templates lose animations, events and permissions and vanish on reload (duplicates LIFE-19). cutSelectedWidgets removes widgets and edges but leaves automationBindings[].variableBindings[].boundWidgetId pointing at the cut ids. Paste assigns new ids, so the links dangle. The backend check that claims to catch dangling widget ids never runs for builder-written bindings (see the new finding PLACE-V-02).
  - store/scada/templateSlice.ts:7-22 template = { widgetType, config, defaultSize } (no animations, events or permissions); L36-41 applyTemplate recreates only those
  - grep 'widgetTemplates' finds only templateSlice.ts and WidgetTemplatePanel.tsx; projectSlice toScadaPackageJSON does not include it
  - store/scada/selectionSlice.ts:102-134 cutSelectedWidgets, with no automationBindings cleanup, vs store/scada/widgetSlice.ts:47-55 removeWidget, which nulls vb.boundWidgetId and boundTag
  - (verifier) store/scada/templateSlice.ts:7-22,29-43
  - (verifier) store/scada/projectSlice.ts:224-284 toScadaPackageJSON has no widgetTemplates
  - (verifier) store/scada/selectionSlice.ts:102-134 cut, with no binding cleanup, vs widgetSlice.ts:46-54 removeWidget nulls vb.boundWidgetId and boundTag
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:1243,1290-1297 validation reads top-level b.boundWidgetId
  - Verifier: I read both sides. These links are consumed only by the builder's SimulationSidebar (SimulationSidebar.tsx:452-474), so the impact is LOW.
- **LIFE-20** (LIFE; verdict PARTIAL; severity LOW): PDF export produces an invalid PDF; PNG export likely loses layout and styling
  - Claim: PDF is confirmed invalid: object 5 declares /FlateDecode /DeviceRGB raw samples but embeds the whole PNG file (signature + chunks), so zlib decoding fails and readers show an error or a blank page. The PNG claim remains unverified: the clone keeps inline styles (most renderers style inline), but stylesheet/Tailwind rules are not inlined, so fidelity is partial at best.
  - web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:109-114 (obj 5: /FlateDecode /DeviceRGB with raw PNG bytes)
  - web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:186-205 (cloneNode + XMLSerializer, no CSS inlining)
  - web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:268-274
  - (verifier) web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:103-115
  - (verifier) web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx:186-216,262-266
  - Verifier: The PDF part is certain from the byte layout. The PNG part could not be run here.

</details>

### SENSOR-MEDIUM-323

**Simulation state survives Reset All, leaving and re-entering simulation, and leaks into the next package opened**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F5 · Deadline: 2027-03-29
- Verification: CONFIRMED 2
- Rule: Persistence round-trips without silent data loss

**Claim.** Holds, with one clarification. The `if (val && …)` guard in useRealtimeData tests the TagValueChange wrapper, not the value, so false and 0 do propagate. Only cleared tags are lost, because SimulationDataProvider.getTagValue returns null for undefined/null and the poller ignores null, keeping the old entry in pendingRef. Re-subscription merges the new seed into the old pendingRef. Edit and Simulation share the 'simulation' provider type, so ScreenCanvas is not remounted. Therefore Reset All and Edit→Simulation both keep showing the previous session's values on the canvas while the store is empty. Preview switches the provider type and remounts the canvas, so stale values do not leak into Preview.

**What the user sees.** I click Reset All and the pump stays green. I stop and restart Simulation, the sidebar shows empty values, and the canvas still shows the old ones.

**Root cause.** The data-plane contract has no 'value removed / no data' event. Absence is indistinguishable from 'no update yet'.

**Fix direction.** Make tag values a stream of {value | noData, quality} changes (push, not poll) and have useRealtimeData replace rather than merge. Reset the snapshot when the session id changes.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/simulationSlice.ts:14-22`
- `web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:80-83`
- `web/modules/sensor-module/src/hooks/useRealtimeData.ts:75`
- `web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx`
- `web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:80-82`
- `web/modules/sensor-module/src/hooks/useRealtimeData.ts:66-76`
- `web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx:36-44`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:423-454`
- `web/modules/sensor-module/src/store/scada/simulationSlice.ts:10-22`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:50-69`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:71`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:51-69`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:229-243`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:71,307-311`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-13** (SIM; verdict CONFIRMED; severity MEDIUM): 'Reset All' and leaving/re-entering simulation keep showing the previous values on the canvas
  - writer: web/modules/sensor-module/src/store/scada/simulationSlice.ts:14-22 (setSimulationMode(false) clears), :39-42 (clearSimTagValues)
  - web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:80-83 (cleared → null)
  - reader: web/modules/sensor-module/src/hooks/useRealtimeData.ts:75 (pendingRef merge on resubscribe), :86-92 (null ignored)
  - web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx (edit and simulation → same 'simulation' provider; canvas not remounted)
  - RAN: scratchpad/sim/stale-test.tsx → '2. sidebar "Reset All" -> widget shows true \| store undefined'; '4. back to Simulation (fresh session) -> widget shows true \| store undefined'
  - (verifier) web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:80-82 (undefined/null → null)
  - (verifier) reader: web/modules/sensor-module/src/hooks/useRealtimeData.ts:66-76 (seed merged into existing pendingRef), :85-94 (null ignored; old value kept)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/StableModeProvider.tsx:36-44 (edit + simulation → 'simulation'; preview → 'live' remounts)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223 (liveTagIds only while isPreview; the hook instance persists across edit⇄simulation)
  - Verifier: I read both sides of the seam and they confirm the mechanism. The auditor's wording about 'truthy values' is imprecise, but the conclusion is right.
- **LIFE-28** (LIFE; verdict CONFIRMED; severity LOW): Simulation state leaks into the next package that is opened
  - Claim: reset() and loadFromJSON never touch simulationMode, simTagValues or simAlarms, and the builder has no unmount cleanup (its mode is local state that restarts at 'edit'). After leaving during a simulation, the next package opens with store.simulationMode=true: GlobalAlarmBanner shows the old simAlarms, TrendChartRenderer plots stale sim values, and ScadaWidgetNode routes clicks into sim tag writes.
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:423-454 (reset omits the simulation slice)
  - web/modules/sensor-module/src/store/scada/simulationSlice.ts:10-22
  - web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:50-69
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:71 (mode is component-local)
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:423-454
  - (verifier) web/modules/sensor-module/src/store/scada/simulationSlice.ts:14-22
  - (verifier) web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:51-69
  - (verifier) web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:229-243
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:71,307-311
  - Verifier: Confirmed. The impact is narrower than the user symptom suggests.

</details>

### SENSOR-LOW-319

**Package list silently shows only the 20 most recent packages, and search replaces the page with a spinner**

- Severity: LOW · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 1, SELF 1
- Rule: Persistence round-trips without silent data loss

**Claim.** useScadaPackages never sends pagination, so the service defaults to limit 20 ordered by updatedAt DESC. The list page ignores total/hasNextPage and has no paging. Packages beyond the 20 most recent are invisible except through search. The unified editor auto-creates one package per process save, which speeds up the accumulation.

**What the user sees.** Once I have more than 20 packages, older ones disappear from /sensor/scada-packages, though search can still find them.

**Root cause.** Paginated API consumed as if unpaginated.

**Fix direction.** Add page state + pagination controls (or infinite scroll) using total/hasNextPage.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:66-69`
- `apps/sensor-service/src/process/services/scada-package.service.ts:615-617`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:67,333-341`
- `web/modules/sensor-module/src/graphql/scada-package.queries.ts:26-40`
- `apps/sensor-service/src/process/services/scada-package.service.ts:615-617,633-638`
- `web/modules/sensor-module/src/hooks/useScadaPackage.ts:61-63,96-97`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:115-128`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-16** (LIFE; verdict CONFIRMED; severity LOW): The package list silently shows only the 20 most recently updated packages
  - web/modules/sensor-module/src/hooks/useScadaPackage.ts:66-69
  - apps/sensor-service/src/process/services/scada-package.service.ts:615-617
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:67,333-341
  - (verifier) web/modules/sensor-module/src/graphql/scada-package.queries.ts:26-40
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:615-617,633-638
  - Verifier: Confirmed. It is unlikely to matter to a user who has not yet shipped a first process.
- **LIFE-33** (LIFE-verifier; verdict SELF; severity LOW): Typing in the package-list search replaces the whole page with a spinner and drops focus from the search box
  - Claim: Each debounced search calls fetchPackages, which sets loading=true. The list page early-returns a full-page spinner while loading, which unmounts the search input and status filter. When results arrive the input is re-created without focus, so typing stops after every 300 ms pause.
  - web/modules/sensor-module/src/hooks/useScadaPackage.ts:61-63,96-97 (setLoading(true) on every debounced fetch)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:115-128 (loading early return) and 283-294 (search input rendered only after it)

</details>

### SENSOR-LOW-321

**Unreachable or no-op builder features presented as working (Recipe/Translations/DAQ/TagWatch panels never mounted, Publish to Cloud, status bar always Draft v1, placeholder unified-editor modes)**

- Severity: LOW · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: CONFIRMED 5, PARTIAL 2
- Rule: Persistence round-trips without silent data loss

**Claim.** Holds as dead code: TranslationsPanel, RecipePanel, DaqConfigPanel and TagWatchPanel have no importers, and WidgetPalette is referenced only in comments. No UI promises these features, so nothing appears to work and then fails silently. The rewrite should simply delete or relocate them. LOW, not MEDIUM.

**What the user sees.** Multi-language labels, recipes, DAQ logging configuration and a live tag watch list cannot be found anywhere in the SCADA builder.

**Root cause.** Components were built without being mounted, and no reachability test exists.

**Fix direction.** Mount these panels, for example as Package-scoped tabs in PropertiesPanel, or delete them. Delete WidgetPalette.tsx. Add an invariant test that every components/scada-builder/\*Panel.tsx is imported by a routed page.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:69-75`
- `web/modules/sensor-module/src/constants/scada-palette-categories.ts`
- `web/modules/sensor-module/src/components/scada-operator/widgets/index.ts:17`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:5,805`
- `web/modules/sensor-module/src/components/scada-builder/FuxaWidgetBrowser.tsx:8`
- `web/modules/sensor-module/src/components/scada-builder/UnifiedLeftPanel.tsx:4,193`
- `web/modules/sensor-module/src/components/scada-builder/__tests__/phase9e-platform.test.tsx`
- `web/modules/sensor-module/src/store/scada/types.ts:173-189`
- `web/modules/sensor-module/src/store/scada/types.ts`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:378-380`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:441-445`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderStatusBar.tsx:40-41`
- `web/modules/sensor-module/src/store/scada/templateSlice.ts:4-22`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:224-281`
- `apps/sensor-service/src/process/dto/scada-package.dto.ts:19-22,45-48`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:160-162`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:86-89,406-412`
- `web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:221-224`
- `web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:218-224`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:459-464`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:150-166`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:52,174`
- `web/modules/sensor-module/src/store/scada/sceneUtils.ts:26-44`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:150-168,174`
- `web/modules/sensor-module/src/store/scada/sceneUtils.ts:27-44`
- `web/modules/sensor-module/src/components/unified-editor/ModeTabBar.tsx:19-25`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1010-1030`
- `web/modules/sensor-module/src/components/unified-editor/UnifiedPropertiesPanel.tsx:376-439`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1211-1222`
- `web/shared-ui/src/components/Modal/Modal.tsx:185`
- `web/modules/sensor-module/src/components/unified-editor/UnifiedPropertiesPanel.tsx:376-438`

<details><summary>Merged audit findings and full evidence</summary>

- **DEAD-01** (OPS; verdict PARTIAL; severity LOW): Builder features that exist in code are unreachable from the UI
  - grep: TranslationsPanel/RecipePanel/DaqConfigPanel/TagWatchPanel have no importers outside their own files (web/modules/sensor-module/src/components/scada-builder/)
  - grep: WidgetPalette has no importer; components/scada-builder/UnifiedLeftPanel.tsx:69-75 imports constants/scada-palette-categories.ts
  - web/modules/sensor-module/src/components/scada-operator/widgets/index.ts:17 (only re-export of RuntimeWidgetRenderer)
  - (verifier) grep: each \*Panel name appears only in its own file under components/scada-builder/
  - (verifier) grep: 'WidgetPalette' in ScreenCanvas.tsx:5,805, FuxaWidgetBrowser.tsx:8 and UnifiedLeftPanel.tsx:4,193 is only in comments
  - Verifier: The finding is accurate, but it has no impact on the E2E flow.
- **LIFE-21** (LIFE; verdict CONFIRMED; severity LOW): The Recipe, Translations, DAQ-config and Tag-Watch panels are never mounted and have nowhere to persist
  - Claim: Duplicate of OPS DEAD-01. RecipePanel, TranslationsPanel, DaqConfigPanel and TagWatchPanel are imported only by their own files and phase9e-platform.test.tsx, and ScadaPackageJSON has no fields for them.
  - grep TranslationsPanel\|RecipePanel\|DaqConfigPanel\|TagWatchPanel in sensor-module/src: only their own files + components/scada-builder/**tests**/phase9e-platform.test.tsx
  - web/modules/sensor-module/src/store/scada/types.ts:173-189 (ScadaPackageJSON fields)
  - (verifier) grep: only components/scada-builder/{DaqConfigPanel,RecipePanel,TranslationsPanel,TagWatchPanel}.tsx + **tests**/phase9e-platform.test.tsx
  - (verifier) web/modules/sensor-module/src/store/scada/types.ts (no recipes/translations/daq fields)
  - Verifier: Confirmed.
- **UI-01** (OPS; verdict CONFIRMED; severity LOW): No-op or false toolbar items: 'Publish to Cloud', 'Test script', a status bar always saying 'Draft v1', and in-memory-only templates
  - Claim: Holds as stated. Duplicates LIFE-24, LIFE-27 and LIFE-19.
  - web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:378-380
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:441-445
  - web/modules/sensor-module/src/pages/scada/ScadaBuilderStatusBar.tsx:40-41
  - web/modules/sensor-module/src/store/scada/templateSlice.ts:4-22 (not in projectSlice.toScadaPackageJSON:224-281)
  - (verifier) pages/scada/ScadaBuilderToolbar.tsx:378-380 ('Publish to Cloud' only closes the menu)
  - (verifier) pages/scada/ScadaPackageBuilderPage.tsx:441-445 (console.log)
  - (verifier) pages/scada/ScadaBuilderStatusBar.tsx:40-41 (hard-coded 'Status: Draft', 'v1')
  - (verifier) store/scada/projectSlice.ts:224-281 (no templates in serialization)
  - Verifier: Confirmed by reading.
- **LIFE-29** (LIFE; verdict CONFIRMED; severity LOW): Package description cannot be set, and the 'Package Settings' rail icon opens nothing package-specific
  - Claim: description exists in the DTO, entity and list, but the builder has no field for it. The 'Package Settings' rail icon is passed without onRailIconClick, so clicking it only expands the Properties panel.
  - apps/sensor-service/src/process/dto/scada-package.dto.ts:19-22,45-48
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:160-162
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:86-89,406-412 (no onRailIconClick)
  - web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:221-224
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:86-89,406-412
  - (verifier) web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:218-224
  - Verifier: Confirmed.
- **LIFE-24** (LIFE; verdict CONFIRMED; severity LOW): The status bar always shows 'Status: Draft' and 'v1'; archived or published state is never shown
  - Claim: Duplicate of OPS UI-01. ScadaBuilderStatusBar renders the literals 'Status: Draft' and 'v1', and the builder passes neither status nor version.
  - web/modules/sensor-module/src/pages/scada/ScadaBuilderStatusBar.tsx:40-41
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:459-464
  - Verifier: Confirmed.
- **LIFE-25** (LIFE; verdict CONFIRMED; severity LOW): Dragging screen tabs to reorder has no visible effect in the tab bar
  - Claim: handleReorder only writes sortOrder (marking the package dirty), while ScreenTabBar maps state.screens in array order, so the tabs do not move. The scene tree sorts by sortOrder, so the two views disagree.
  - web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:150-166 (updates sortOrder only)
  - web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:52,174 (renders unsorted)
  - web/modules/sensor-module/src/store/scada/sceneUtils.ts:26-44 (tree sorts)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:150-168,174
  - (verifier) web/modules/sensor-module/src/store/scada/sceneUtils.ts:27-44
  - Verifier: Confirmed.
- **JRN-06** (JOUR; verdict PARTIAL; severity LOW): Two of the unified editor's five modes and most of 'Runtime' are placeholders presented as features
  - Claim: Debug mode is entirely placeholder: both side panels are static text. Runtime's right panel is placeholder text, and its left 'Live Tags' panel lists registry name, FQN and unit without values. The Output drawer is static. PLC mode, however, is NOT a placeholder. Entering it opens a full-page modal running the real StEditorPanel (ST authoring, persisted as AutomationProgram), and the 'coming soon' PLC side panels sit behind that modal's backdrop, where they are effectively invisible. The Runtime canvas itself is a real ScreenCanvas on the live provider; its lack of values is DEP-05/LINK-01, not a placeholder. So one mode (Debug) plus the Runtime side panels are placeholders, not 'two modes'.
  - web/modules/sensor-module/src/components/unified-editor/ModeTabBar.tsx:19-25
  - web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1010-1030 (PLC/Debug left placeholders), :1087-1121 (Output static text), :103-173 (LiveTagsPanel: name/fqn/engUnit, no value)
  - web/modules/sensor-module/src/components/unified-editor/UnifiedPropertiesPanel.tsx:376-439 (PlcPanel/RuntimePanel/DebugPanel static text), :502-508 (mounted for those modes)
  - (verifier) ModeTabBar.tsx:19-25
  - (verifier) UnifiedEditorPage.tsx:1010-1030 (PLC/Debug left placeholders), :1096-1110 (Output static), :103-173 (LiveTagsPanel without values)
  - (verifier) UnifiedEditorPage.tsx:1211-1222 (Modal isOpen={mode==='plc'} with <StEditorPanel floating>), shared-ui Modal.tsx:185 (fixed inset-0 backdrop)
  - (verifier) UnifiedPropertiesPanel.tsx:376-438 (PlcPanel/RuntimePanel/DebugPanel static), :496-503
  - Verifier: The placeholder text is real, but the PLC claim is refuted by the modal ST editor that covers the page in PLC mode. The impact is a misleading UI, not a broken pipeline step, so LOW.

</details>

### SENSOR-LOW-322

**The saved target device is ignored by the Deploy dialog**

- Severity: LOW · Domain: SENSOR · Plan phase: F4 · Deadline: 2027-03-01
- Verification: PARTIAL 1
- Rule: Persistence round-trips without silent data loss

**Claim.** DeployToEdgeDialog takes no default device and resets selectedDeviceId to null on every open, so the saved meta.edgeDeviceId (the toolbar target) is ignored and any device can be picked with no mismatch warning. Corrected consequence: deploying to another device does not make the edge use the old device's tags, because the edge reads config.tag (EDGE-01) and the deploy tag gate prefixes the DEPLOY device's code onto tagName. Only the persisted tagRef keeps the stale device code (LIFE-01), which affects cloud PIN tag keys and registry identity.

**What the user sees.** I chose 'Edge-01' as the target in the toolbar, but the Deploy dialog has nothing selected and lists every device. Deploying to another device gives widgets bound to Edge-01's tags.

**Root cause.** The two device selections are independent with no defaulting or mismatch check.

**Fix direction.** Pass targetDeviceId as the default and warn or block when the deploy device differs from meta.edgeDeviceId (or re-resolve bindings for that device).

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/projectSlice.ts:234,352`
- `apps/sensor-service/src/process/services/scada-package.service.ts:156-160`
- `web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:61-91`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:467-479`
- `web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:47-62`
- `apps/sensor-service/src/process/services/scada-package.service.ts:957-976`

<details><summary>Merged audit findings and full evidence</summary>

- **LIFE-15** (LIFE; verdict PARTIAL; severity LOW): The saved target device is ignored by the Deploy dialog
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:234,352
  - apps/sensor-service/src/process/services/scada-package.service.ts:156-160
  - web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:61-91 (no default device prop; reset to null)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:467-479
  - (verifier) web/modules/sensor-module/src/components/deploy/DeployToEdgeDialog.tsx:47-62 (no device prop), 83-91
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:957-976 (upcast with deploy device; tag gate uses tagName + deploy deviceCode)
  - Verifier: The UX gap holds. The stated binding consequence is overstated.

</details>

## G. Simulation

### SENSOR-CRITICAL-324

**Builder simulation "Run" feeds the program identifier (programCode) to the ST parser instead of the source, so no linked automation program ever runs in simulation and nothing tells the user**

- Severity: CRITICAL · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: CONFIRMED 2
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** Holds as stated. The binding stores the backend identifier programCode (max 30 chars). The builder UI itself shows it as the program's monospace ID label. SimulationSidebar.handleStartProgram passes that identifier to useSimulation.load(). parseST fails, the interpreter stays null, getVariableSnapshot() returns [], and the handler returns before any visible state changes. simulation.error is set, but the sidebar never renders it. addAutomationProgram has one caller (AutomationBindingPanel), and no other path fills programCode with ST source. This duplicates LINK-09 from the sibling LINK audit, which graded it HIGH. It is BLOCKER here because builder automation simulation fails outright for every linked program.

**What the user sees.** In Simulation, I open 'Automation Programs' and click Run on my linked program. Nothing happens: the button stays 'Run', no cycle counter appears, no error is shown, and no equipment ever reacts to the program.

**Root cause.** The binding record holds a copy of the program's code identifier, not a reference to the executable artifact. One field name, programCode, means 'identifier' in the backend and 'ST source' in the simulation design.

**Fix direction.** The binding stores only programId (and a version). The simulation resolves the executable at Run time: fetch structuredTextCode, or better a compiled artifact, by programId + version. Make the field type-distinct, e.g. a branded ProgramIdentifier vs StSource, so the identifier cannot be passed to load(). Surface every load/parse error in the sidebar. Test: link a real program and Run, expect cycles > 0.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:374-379`
- `web/modules/sensor-module/src/hooks/useAutomationPrograms.ts:44-62`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:90-110`
- `apps/sensor-service/src/automation/dto/automation.dto.ts:73-77`
- `apps/sensor-service/src/automation/entities/automation-program.entity.ts:154`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:499`
- `web/modules/sensor-module/src/simulation/useSimulation.ts:113-121`
- `docs/SCADA_SIMULATION_MODE.md:230`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:372-379`
- `web/modules/sensor-module/src/types/scada-package.types.ts:135-140`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:259-261`
- `apps/sensor-service/src/automation/entities/automation-program.entity.ts:153-155`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:374`
- `web/modules/sensor-module/src/simulation/useSimulation.ts:105-115`
- `web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:373-378`
- `web/modules/sensor-module/src/hooks/useAutomationPrograms.ts:46-63`
- `web/modules/sensor-module/src/simulation/useSimulation.ts:99-115`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1827`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:496-508`
- `web/modules/sensor-module/src/simulation/useSimulation.ts:99-120`
- `apps/sensor-service/src/automation/entities/automation-program.entity.ts:153-155,184-186`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-01** (SIM; verdict CONFIRMED; severity BLOCKER): Builder simulation 'Run' loads the program identifier (programCode), not the ST source, so no linked automation program ever runs, and nothing tells the user
  - writer: web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:374-379 (addAutomationProgram(..., automationProgram.programCode, programVariables))
  - web/modules/sensor-module/src/hooks/useAutomationPrograms.ts:44-62 (PROGRAM_VARIABLES_QUERY selects id/programCode/programName/status only; no structuredTextCode)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:90-110 (binding.programCode stored verbatim)
  - apps/sensor-service/src/automation/dto/automation.dto.ts:73-77 (programCode MaxLength(30)); apps/sensor-service/src/automation/entities/automation-program.entity.ts:154 (program_code length 30) vs :185 (structured_text_code text = the source)
  - reader: web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:499 (simulation.load(binding.programCode)), :505-508 (vars.length===0 → return, no message), :743 (only automationError rendered)
  - web/modules/sensor-module/src/simulation/useSimulation.ts:113-121 (parse errors go to hook state 'error', never displayed by the sidebar)
  - docs/SCADA_SIMULATION_MODE.md:230 (doc example: programCode: "PROGRAM DosingPump\n VAR_INPUT ...")
  - RAN: /tmp/claude-0/-home-user-aquaculture-platform/05d60680-766d-5d1e-875b-a482a9545584/scratchpad/sim/sidebar-test.tsx → '[RUN with programCode] Stop button visible: false \| "Program stopped" error shown: false \| Cycle text: none \| PUMP tag = undefined'; sim/run.ts → parseST('PUMP_CTRL_01') errors ["Unexpected token 'PUMP_CTRL_01'"]
  - (verifier) writer: web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:372-379 (addAutomationProgram(automationProgram.id, programName, automationProgram.programCode, programVariables))
  - (verifier) web/modules/sensor-module/src/types/scada-package.types.ts:135-140 (AutomationBinding.programCode: string); AutomationBindingPanel.tsx:259-261 renders binding.programCode as the font-mono ID label under the program name
  - (verifier) apps/sensor-service/src/automation/entities/automation-program.entity.ts:153-155 (program_code length 30) vs :183-186 (structured_text_code text); apps/sensor-service/src/automation/dto/automation.dto.ts:73-77 (MaxLength 30)
  - (verifier) grep addAutomationProgram in sensor-module/src: only AutomationBindingPanel.tsx:374 calls it
  - (verifier) reader: web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:499 (simulation.load(binding.programCode)), :504-508 (vars.length===0 → return; no setAutomationError), :743-751 (only automationError rendered; simulation.error never referenced in the file)
  - (verifier) web/modules/sensor-module/src/simulation/useSimulation.ts:105-115 (parse errors → setState('error')/setError, interpreterRef=null)
  - (verifier) RAN (rebuilt from current source): scratchpad/verify-sim/run.cjs → parseST('PUMP_CTRL_01') errors ["Unexpected token 'PUMP_CTRL_01'"], ast empty; parseST('RAS_LOOP') same
  - Verifier: I read both sides of the seam and found no mapper, re-fetch or upcaster that replaces programCode with source. The backend uses programCode only as a unique identifier (automation.service.ts:159, 288, 316). The design doc example puts ST source in this field, which contradicts the code. The probe reproduced the parse failure against the current code. The early return sets no user-visible state, so the Run button simply stays.
- **LINK-09** (BIND; verdict CONFIRMED; severity HIGH): 'Run' on a linked program in Simulation mode silently does nothing: it feeds the program code identifier to the ST parser
  - Claim: Holds. handleStartProgram calls simulation.load(binding.programCode). programCode is the identifier column, not ST source, and PROGRAM_VARIABLES_QUERY never fetches structuredTextCode. load() sets an error state, getVariableSnapshot() is empty, and the handler returns without setting activeProgram or automationError, so nothing is shown. Sibling SIM-01 reports the same defect (graded BLOCKER there). It stays HIGH here because the program editor's own simulator works.
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:499 (simulation.load(binding.programCode)), 501-508 (silent return when vars empty)
  - web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:373-378 (programCode from automationProgram.programCode)
  - web/modules/sensor-module/src/hooks/useAutomationPrograms.ts:46-63 (no structuredTextCode requested)
  - apps/sensor-service/src/automation/entities/automation-program.entity.ts:153-155 (program_code length 30), 184-186 (structured_text_code)
  - web/modules/sensor-module/src/simulation/useSimulation.ts:99-115 (parse errors -> error state)
  - web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1827 (editor passes stCode, works)
  - RUN: scratchpad/link/st-test.ts '"PUMP_CTRL_01" => errors: 1 [ "Unexpected token 'PUMP_CTRL_01'" ] ast programs: 0'
  - (verifier) web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:496-508 (load(programCode); silent return when vars are empty)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/AutomationBindingPanel.tsx:373-378 (programCode stored from automationProgram.programCode)
  - (verifier) web/modules/sensor-module/src/hooks/useAutomationPrograms.ts:46-63 (no structuredTextCode)
  - (verifier) web/modules/sensor-module/src/simulation/useSimulation.ts:99-120 (parse errors -> state 'error')
  - (verifier) apps/sensor-service/src/automation/entities/automation-program.entity.ts:153-155,184-186
  - Verifier: The cited lines were read. No other code path fetches the source before Run.

</details>

### SENSOR-HIGH-325

**No builder alarm can fire in simulation (Alarm tab writes >,<,== while the evaluator knows gt/lt/eq), and the alarm banner shows configured rule counts as active alarms**

- Severity: HIGH · Domain: SENSOR · Plan phase: F5 · Deadline: 2027-03-29
- Verification: CONFIRMED 3, PARTIAL 1
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** Holds. The Alarm tab writes the symbols > < >= <= == != and defaults to '>'. The package loader also defaults a missing condition to '>'. The save path passes the condition through unchanged. Nothing maps symbols to gt/lt, so useAlarmEvaluation skips every builder-authored rule (`if (!condFn) continue`). All 12 rules in the RAS demo (9 '>' and 3 '<') are skipped too. The canonical engine (crates/alarm-core) uses the symbol set. This duplicates SET-04 from the sibling SET audit.

**What the user sees.** I add 'Level > 80, critical' and drag the level to 95 in Simulation. The Active Alarms section keeps saying 'No alarms triggered'. The demo's low-DO alarm never fires either.

**Root cause.** The alarm condition is an untyped string with two hand-written vocabularies, and the simulation reimplements alarm logic instead of using the shared alarm core.

**Fix direction.** Make the condition a closed union exported from @platform/sensor-contracts (the symbol set the edge uses). Have the simulation evaluate through libs/alarm-core (the wasm build of crates/alarm-core), so browser, NestJS and edge share one decision function. Add a parity test that runs every PropertiesAlarmTab option through both evaluators.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:34`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:1148-1258`
- `web/modules/sensor-module/src/hooks/useAlarmEvaluation.ts:29-36`
- `crates/alarm-core/src/lib.rs:82-91`
- `sens-api-gateway/src/alarm_engine.rs:17,107`
- `docs/SCADA_SIMULATION_MODE.md:173`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:266-270`
- `web/modules/sensor-module/src/store/scada/types.ts:99-108`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:1148,1158,1168,1178,1188`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:396-409`
- `crates/alarm-core/src/lib.rs:82-89`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:338-347`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:253-268`
- `crates/alarm-core/src/lib.rs:82-90`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:57`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:399-409`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:55-71`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:690-696`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:73-93`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:96-105`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:57-71`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:388`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-02** (SIM; verdict CONFIRMED; severity HIGH): No alarm made in the builder (or in the built-in RAS demo) can ever fire in simulation: the Alarm tab writes '>' '<' '==' but the simulation evaluator only knows gt/lt/eq
  - writer: web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:34 (CONDITIONS = ['>','<','>=','<=','==','!=']), :49 (default '>'), :121-130 (select)
  - web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:1148-1258 (12 rules, condition '<' / '>')
  - reader: web/modules/sensor-module/src/hooks/useAlarmEvaluation.ts:29-36 (CONDITION_FNS gt/lt/eq/ne/gte/lte), :86-87 (if (!condFn) continue)
  - canonical vocabulary: crates/alarm-core/src/lib.rs:82-91 (evaluate_condition matches '<' '>' '<=' '>=' '==' '!='); sens-api-gateway/src/alarm_engine.rs:17,107
  - docs/SCADA_SIMULATION_MODE.md:173 (doc lists gt/lt/... as the operators)
  - RAN: scratchpad/sim/sidebar-test.tsx → '[ALARM ">" rule, LEVEL=95] Active Alarms: No alarms triggered \| store.simAlarms = 0' vs '[ALARM "gt" rule, LEVEL=95] ... ALARM SHOWN \| store.simAlarms = 1'
  - (verifier) writer: web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:34 (CONDITIONS symbols), :46-53 (new rule condition '>')
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:266-270 (save passes r.condition through), :338-342 (load defaults condition to '>') — no translation layer
  - (verifier) web/modules/sensor-module/src/store/scada/types.ts:99-108 (AlarmRuleDef.condition: string, untyped)
  - (verifier) web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts: grep condition → 9 × '>' and 3 × '<'
  - (verifier) reader: web/modules/sensor-module/src/hooks/useAlarmEvaluation.ts:29-36 (gt/lt/eq/ne/gte/lte only), :86-87 (if (!condFn) continue), :100-122 (deadband switch also only on gt/lt words)
  - (verifier) grep "'gt'" in sensor-module/src: only fuxa-bridge, AlertRulesPage, useAlertRules (an unrelated alert-rule feature); no mapper for SCADA alarm rules
  - (verifier) crates/alarm-core/src/lib.rs:82-91 (evaluate_condition matches '<' '>' '<=' '>=' '==' '!=')
  - (verifier) No unit test covers useAlarmEvaluation (grep finds no test importing it), so the mismatch is undetected
  - Verifier: I looked for a mapper anywhere between the property panel, the store, serialization and the evaluator, and found none. The store's own load default '>' proves the symbol vocabulary is canonical, and the evaluator is the only outlier. The auditor's jsdom run (">" gives 0 alarms, "gt" gives 1) agrees with the code.
- **SET-04** (SET; verdict CONFIRMED; severity HIGH): Simulation can never trigger an alarm: the evaluator expects 'gt/lt/eq', the Alarm tab writes '>', '<', '=='
  - Claim: Core claim holds (duplicates SIM-02). loadFromJSON (projectSlice.ts:338-347) does not normalize condition, and AlarmRuleDef.condition is a plain string, so '>' etc. reach CONDITION_FNS, miss, and the rule is skipped. Simulation tag keys (config.tagName) do match local-name rules, so the vocabulary is the only break. Sub-claim overstated: for >/< the simulation's 'threshold − deadband' hysteresis is the same as alarm-core is_outside_deadband apart from boundary inclusivity. eq/ne do differ, and the 'ne' branch's Math.max(0.001, 0.001 − deadband) makes deadband a no-op.
  - web/modules/sensor-module/src/hooks/useAlarmEvaluation.ts:29-36 (keys gt/lt/eq/ne/gte/lte), 86-87 (if (!condFn) continue), 100-123 (deadband switch on 'gt'/'lt')
  - web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:34 (CONDITIONS = ['>','<','>=','<=','==','!='])
  - web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:1148,1158,1168,1178,1188 (conditions '<' and '>')
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:396-409 (feeds simAlarms), 694-695 ('No alarms triggered')
  - crates/alarm-core/src/lib.rs:82-89 (canonical operators '<','>','<=','>=','==','!=')
  - grep useAlarmEvaluation: no test file
  - (verifier) web/modules/sensor-module/src/hooks/useAlarmEvaluation.ts:29-36 keys gt/lt/eq/ne/gte/lte; 86-87 if (!condFn) continue; 100-123 deadband switch
  - (verifier) PropertiesAlarmTab.tsx:34 CONDITIONS ['>','<','>=','<=','==','!='], default '>' at 49
  - (verifier) store/scada/projectSlice.ts:338-347 condition: r.condition \|\| '>' (no normalization); store/scada/types.ts:99-108 condition: string
  - (verifier) components/scada-builder/SimulationSidebar.tsx:253-268 sim tags keyed by config.tagName; 395-397 feeds alarmRules; 399-408 setSimAlarms
  - (verifier) crates/alarm-core/src/lib.rs:82-90 symbol operators; 108-123 is_outside_deadband
  - Verifier: I looked for a translation layer between the Alarm tab and the evaluator (loadFromJSON, store type, SimulationSidebar) and found none. Every rule from the tab or the demo is skipped, so simulation alarms never fire.
- **SIM-15** (SIM; verdict PARTIAL; severity LOW): The alarm banner shows configured rules as if they were active alarms, red-pulsing when nothing is in alarm
  - Claim: Holds. In simulation with no fired alarms (simAlarms empty), GlobalAlarmBanner falls back to counting alarm rules by severity. One critical rule therefore gives a red pulsing 'Alarms (SIM)' bar with '1 Critical' and no alarm active. The right badge always says 'N rule(s)'. The sidebar's Active Alarms section correctly says 'No alarms triggered', so the true state is visible one panel away. This duplicates SET-05. Display-only, so LOW.
  - web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:57 (sim branch only if simAlarms.length>0), :75-91 (fallback counts rules), :102-105 (red pulse when counts.critical>0), :165 ('{total} rule(s)')
  - writer: SimulationSidebar.tsx:399-409 (setSimAlarms)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:55-71 (sim branch only if simAlarms.length > 0), :73-94 (fallback counts rules), :96-105 (red pulse when counts.critical > 0), :158-171 ('{total} rule(s)')
  - (verifier) web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:690-696 (Active Alarms shows the correct 'No alarms triggered')
  - Verifier: The code matches the claim. Severity lowered because it is a misleading indicator and the correct information is shown in the sidebar.
- **SET-05** (SET; verdict CONFIRMED; severity LOW): The builder alarm banner presents rule counts as active alarms (red, pulsing '1 Critical')
  - Claim: Holds (duplicates SIM-15). Outside simulation the label is 'Alarms', not 'Alarms (SIM)'. A single critical rule makes the bar red and pulsing with a ShieldAlert icon and '1 Critical'. It is misleading but does not block or corrupt anything.
  - web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:55-71 (simulation branch only when simAlarms.length > 0)
  - web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:73-93 (counts alarmRules by severity)
  - web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:96-105 (hasCritical → bg-error-600 animate-pulse), 111-117 (ShieldAlert, 'Alarms (SIM)')
  - (verifier) web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:57-71 fired-alarm branch only when simulationMode && simAlarms.length > 0
  - (verifier) GlobalAlarmBanner.tsx:73-93 counts alarmRules by severity
  - (verifier) GlobalAlarmBanner.tsx:96-105 hasCritical → bg-error-600 animate-pulse; 111-117 ShieldAlert and 'Alarms (SIM)' only when simulationMode
  - (verifier) mounted at pages/scada/ScadaPackageBuilderPage.tsx:388
  - Verifier: The code matches the claim. I downgraded it because it is a presentation defect that affects no data or runtime path.

</details>

### SENSOR-HIGH-326

**Browser ST interpreter silently diverges from the edge: TON/TOF/TP, R_TRIG/F_TRIG, counters and TIME literals do nothing; INT division, divide-by-zero, CONTINUE and casts behave differently; valid programs are rejected or the wrong POU runs**

- Severity: HIGH · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: PARTIAL 3
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** The browser half holds. In st-interpreter, an FB instance call goes to evalFunctionCall, which returns 0 with a console.warn. t1.Q and t1.ET read flat keys that never exist, so they read 0. TIME literals evaluate to 0. TON, TOF and R_TRIG programs silently do nothing in both the builder sidebar and the automation editor's Simulation tab. The edge half is wrong. The edge has TON/TOF/TP/R_TRIG/F_TRIG/CTU function-block structs, but the only edge path that runs ST source (bytecode_deploy → parse_st → compile_program) cannot compile them. It rejects `t1 : TON` / `rt : R_TRIG` declarations (Unsupported: only BOOL/INT/REAL), rejects every TIME literal, and types FB outputs as REAL, so `IF t1.Q` / `pump := t1.Q` fails with TypeMismatch. On the device the same program does not 'behave differently'. It is refused at deploy. No runtime in the platform can execute an IEC timer written in ST. The fix direction 'run the edge VM in wasm' would not bring timers to simulation either, unless compile_program gains FB-instance and TIME support (see new finding SIMV-02).

**What the user sees.** A 'start the pump 5 s after the level is low' or 'count each button press' program never switches anything, in either Simulation view. On the edge the same program would behave differently.

**Root cause.** The browser runs a second, partial ST runtime, a TypeScript tree-walker, instead of the platform's real VM.

**Fix direction.** Run the edge VM in the browser: compile sens-api-gateway's st_validator::parse_st + scripting::bytecode_compiler + bytecode_vm + function_blocks to wasm, following crates/protocol-codec-wasm and crates/alarm-core-wasm. Use ScanCycle timer mode under simulation time. Delete st-interpreter/st-parser-lite. Add a parity test with golden programs (timers, edges, counters) on native and wasm.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/simulation/st-interpreter.ts:693-717`
- `web/modules/sensor-module/src/components/unified-editor/providers/st-snippets.ts:68-70`
- `sens-api-gateway/src/scripting/function_blocks/timers.rs:67,163`
- `sens-api-gateway/src/scripting/function_blocks/edge_triggers.rs:32`
- `apps/sensor-service/src/automation/compiler/analyzer/symbol-table.ts:401-450`
- `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1825-1828`
- `web/modules/sensor-module/src/simulation/SimulationPanel.tsx:318-345`
- `web/modules/sensor-module/src/simulation/st-interpreter.ts:578-579`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs:1638-1647`
- `sens-api-gateway/src/scripting/bytecode_deploy.rs:358-394`
- `web/modules/sensor-module/src/simulation/st-interpreter.ts:627-637`
- `sens-api-gateway/src/scripting/bytecode_vm.rs:725-731`
- `sens-api-gateway/src/st_validator.rs:976`
- `web/modules/sensor-module/src/simulation/st-interpreter.ts:626-637`
- `sens-api-gateway/src/scripting/bytecode_vm.rs:724-731`
- `web/modules/sensor-module/src/simulation/st-parser-lite.ts:129-151`
- `web/modules/sensor-module/src/simulation/useSimulation.ts:127`
- `apps/sensor-service/src/automation/compiler/lexer/st-keywords.ts:35`
- `web/modules/sensor-module/src/simulation/SimulationPanel.tsx:50`
- `web/modules/sensor-module/src/simulation/SimulationPanel.tsx:505-512`
- `apps/sensor-service/src/automation/compiler/parser/st-parser.ts:147`
- `sens-api-gateway/src/st_validator.rs:3019-3043`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-04** (SIM; verdict PARTIAL; severity HIGH): TON/TOF/TP timers, R_TRIG/F_TRIG, counters and TIME literals silently do nothing in the browser interpreter
  - reader (lite): web/modules/sensor-module/src/simulation/st-interpreter.ts:693-717 (unknown function → 0 + console.warn), :729-733 (member access → ?? 0), :578-579 (timeLiteral → 0), :68-117 (builtins: math, min/max/limit/sel, 4 conversions; no FBs)
  - writer (editor snippets): web/modules/sensor-module/src/components/unified-editor/providers/st-snippets.ts:68-70 (TON), :120-121 (R_TRIG), :130-132 (TOF)
  - edge: sens-api-gateway/src/scripting/function_blocks/timers.rs:67,163 (TON), :362 (TOF), :542 (TP), :8-11 (WallClock/ScanCycle); sens-api-gateway/src/scripting/function_blocks/edge_triggers.rs:32 (R_TRIG), :157 (F_TRIG)
  - backend analyzer knows them: apps/sensor-service/src/automation/compiler/analyzer/symbol-table.ts:401-450
  - same engine in the automation editor: web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1825-1828 → simulation/SimulationPanel.tsx:318-345 (useSimulation + load(code))
  - RAN: scratchpad/sim/run.ts → 'TON 1s timer, 50 cycles: pump(VAR_OUTPUT)=0 elapsed=0' (50× 'Unknown function t1'); 'R_TRIG + counter: cnt=0 edge=0'; 'TOF: fan=0'
  - (verifier) browser: web/modules/sensor-module/src/simulation/st-interpreter.ts:578-579 (timeLiteral → 0), :693-717 (unknown function → 0 + warn), :720-733 (member/array access → ?? 0), :68-117 (no FB builtins)
  - (verifier) web/modules/sensor-module/src/components/unified-editor/providers/st-snippets.ts:68-70 (TON), :120-121 (R_TRIG), :130-132 (TOF), :146 (RAMP), :151 (BLINK), :196 (PumpControl template with LIMITALARM/RAMP)
  - (verifier) RAN (rebuilt): scratchpad/verify-sim/run.cjs → 'TON 1s, 50 cycles: pump=0 elapsed=0'; 'R_TRIG + counter: cnt=0 edge=0'; 'TOF: fan=0'
  - (verifier) edge (counter-evidence to the parity claim): sens-api-gateway/src/scripting/bytecode_compiler.rs:1638-1647 (any VAR of non BOOL/INT/REAL type → CompileError::Unsupported), :1711-1729 (data_type_to_st_type: UserDefined → None), :362-366 (TimeLiteral → Unsupported), :371-390 (FB member access inferred as Real); insert_fb_inputs/insert_fb_outputs are called only from tests (:3234-3395)
  - (verifier) sens-api-gateway/src/scripting/bytecode_deploy.rs:358-394 (the edge's only ST-source path: parse_st then compile_program)
  - (verifier) RAN: scratchpad/verify-sim/edgec (path-includes the real st_validator.rs/bytecode.rs/bytecode_compiler.rs) → 'TON instance: Unsupported variable t1 of type UserDefined("TON")'; 'TIME literal: Unsupported string / time literals'; 'R_TRIG: Unsupported'; 'undeclared FB, IF t1.Q: TypeMismatch if-condition Bool vs Real'
  - Verifier: The browser defect reproduced against the current source. To test the parity claim, I compiled the edge's real parser and compiler files into a scratch binary and ran the same programs. The function blocks exist on the edge, but its ST compiler cannot reach them. The severity stays HIGH because timers and edge detection are basic to aquaculture control, and the simulation silently accepts what the device rejects.
- **SIM-10** (SIM; verdict PARTIAL; severity MEDIUM): Arithmetic and control flow silently diverge from the edge: INT division, divide-by-zero, CONTINUE, string '=', 2-D arrays, MIN/MAX arity, REAL→INT
  - Claim: Confirmed divergences against the edge VM: INT 7/2 gives 3.5 in the browser and 3 on the edge (DivInt). REAL x/0 gives Infinity in the browser, while the edge faults with VmError::DivideByZero. CONTINUE is ignored in the browser (sum = 6), while the edge honours it (sum = 4). The following are browser-only silent wrong results, where the edge refuses to compile instead of computing a different value: 'AUTO' = 'MANUAL' is TRUE (edge: STRING variables Unsupported); 2-D arrays share a cell (edge: arrays Unsupported); MAX(1,5,9) = 5 (edge: 'MAX expects 2 args' compile error); REAL_TO_INT truncates (edge: unknown stdlib function); assigning 7.5 to an INT keeps 7.5 (edge: assignment TypeMismatch). The named-argument example is wrong. LIMIT(IN:=x, MN:=0, MX:=10) evaluates correctly (x=15 gives 10, x=-5 gives 0), because only MN and IN are swapped and max() is commutative. Out-of-order names that move MX do break it: LIMIT(MX:=10, IN:=5, MN:=0) gives 0. There is an additional divergence the auditor missed. The browser honours declared initial values and typed zero-init, while the edge ignores initial values and faults on the first read (SIMV-01).
  - web/modules/sensor-module/src/simulation/st-interpreter.ts:627-637 ('/' float, x/0 → Infinity, 0/0 → 0), :643 ('=' compares toNum of both sides), :405-425 and :720-725 (only indices[0]), :96-97 (min/max 2 args), :112 (real_to_int = trunc), :700-706 (named args appended), :395-400 (no type coercion on store)
  - edge: sens-api-gateway/src/scripting/bytecode_vm.rs:725-731 (DivInt wrapping_div, b==0 → DivideByZero), :742-749 (DivReal b==0 → DivideByZero), :1036-1047; sens-api-gateway/src/st_validator.rs:976 (CONTINUE keyword)
  - RAN: scratchpad/sim/run.ts → 'q := a / b' = 3.5; 'same := s1 = s2' ('AUTO' vs 'MANUAL') = true; CONTINUE loop s=6; 'q := 2.5 \* 3' into INT = 7.5; REAL_TO_INT(2.7)=2
  - (verifier) web/modules/sensor-module/src/simulation/st-interpreter.ts:626-637 ('/' float, x/0 → ±Infinity, 0/0 → 0), :643 ('=' on toNum), :405-425 and :720-725 (indices[0] only), :96-97 (min/max 2 args), :112 (real_to_int trunc), :693-706 (named args appended in source order), :395-400 (no store coercion)
  - (verifier) sens-api-gateway/src/scripting/bytecode_vm.rs:724-731 (DivInt b==0 → error), :741-750 (DivReal b==0 → DivideByZero)
  - (verifier) RAN: scratchpad/verify-sim/probe2.cjs → MAX(1,5,9) q=5; LIMIT(IN:=x,MN:=0,MX:=10) x=15 → 10, x=-5 → 0; LIMIT(MX:=10,IN:=x,MN:=0) x=5 → 0; x/0.0 → Infinity (JSON null)
  - (verifier) RAN: scratchpad/verify-sim/edgec → 'INT div assigned' locals [7,2,3]; 'REAL div by zero' VM ERROR DivideByZero DivReal; 'CONTINUE' locals [s=4,i=4]; 'STRING compare' Unsupported String; 'ARRAY' Unsupported Array; 'MAX 3 args' 'stdlib MAX expects 2 arg(s), got 3'; 'REAL_TO_INT' 'unknown stdlib function'; 'REAL assigned to INT' TypeMismatch assignment
  - Verifier: I executed every sub-claim in both runtimes. Three are true value divergences. Five are browser-silent versus edge-compile-error. The LIMIT example is refuted. The finding stands as MEDIUM, with a corrected claim.
- **SIM-09** (SIM; verdict PARTIAL; severity LOW): Programs the backend accepts are rejected by the browser parser, or the wrong POU is executed
  - Claim: The browser parser does reject VAR_TEMP, TYPE/STRUCT, AT %I/%Q, typed literals (INT#5) and SHL(x,n), and it instantiates ast[0], so an FB placed before the PROGRAM runs instead of it. The edge, which is the actual target runtime, behaves the same way. Its parser rejects VAR_TEMP (E110), TYPE (E110), AT % (E001) and INT#5 (E120). Its compiler rejects SHL() as an unknown stdlib function. Its parse_st also parses only the first program unit, so an FB placed first is what compiles. The only component that accepts these constructs is the cloud TS compiler (st-keywords.ts / st-parser.ts), so the real divergence is backend-validator versus both runtimes. The browser is not the outlier. The automation editor's Simulation tab does show the messages ('Hata: <parse errors>' banner), not only 'Hata'. Remaining real defects: the builder sidebar hides the error (SIM-01), and FBs/FUNCTIONs in the same source are never callable in either runtime.
  - web/modules/sensor-module/src/simulation/st-parser-lite.ts:129-151 (keyword map lacks VAR_TEMP/TYPE/AT/TOD/CONTINUE), :438-440 (VAR_BLOCK_STARTS), :458-466 (top level: only PROGRAM/FUNCTION_BLOCK/FUNCTION)
  - web/modules/sensor-module/src/simulation/useSimulation.ts:127 (new StInterpreter(ast[0]))
  - backend: apps/sensor-service/src/automation/compiler/lexer/st-keywords.ts:35 (VAR_TEMP), :41 (AT), :66 (TYPE), :94 (TOD); edge: sens-api-gateway/src/st_validator.rs:976 (CONTINUE)
  - web/modules/sensor-module/src/simulation/SimulationPanel.tsx:50 (lists a VAR_TEMP section the parser can never produce)
  - RAN: scratchpad/sim/run.ts → VAR_TEMP, TYPE STRUCT, AT %IW0, INT#5 and SHL(1,3) all give parse errors; 'FB defined before PROGRAM' runs Helper (vars i,o) instead of Main
  - (verifier) web/modules/sensor-module/src/simulation/st-parser-lite.ts:129-151 (keywords), :438-440 (VAR_BLOCK_STARTS), :458-466 (top-level POUs)
  - (verifier) web/modules/sensor-module/src/simulation/SimulationPanel.tsx:505-512 (error banner renders 'Hata:' followed by the full error text)
  - (verifier) backend accepts: apps/sensor-service/src/automation/compiler/parser/st-parser.ts:147 (VAR_TEMP), :420/:705 (TYPE), :829 (AT)
  - (verifier) edge: sens-api-gateway/src/st_validator.rs:3019-3043 (parse_st → parse_program_unit, a single unit)
  - (verifier) RAN: scratchpad/verify-sim/edgec → VAR_TEMP 'Unexpected token in statement: Colon E110'; TYPE STRUCT 'Unexpected token in statement: Type E110'; AT %IW0 "Unexpected character: '%' E001"; INT#5 'Expected expression, found KwInt E120'; SHL(1,3) 'unknown stdlib function SHL'; 'FB before PROGRAM' compiles Helper's body (LoadLocal 0 \* 2 → StoreLocal 1)
  - (verifier) RAN: scratchpad/verify-sim/run.cjs → browser gives the same rejections, and runs Helper (vars i,o)
  - Verifier: Running the real edge parser and compiler on the same inputs refutes the implication that the browser parser is the divergent one. For these constructs, the simulation agrees with the device. The error-display sub-claim about the editor tab is wrong. Downgraded to LOW.

</details>

### SENSOR-HIGH-327

**Simulation and the edge VM use opposite variable-to-tag models, so a program that works in one silently does nothing in the other; only one program can run at a time**

- Severity: HIGH · Domain: SENSOR · Plan phase: F3 · Deadline: 2027-01-18
- Verification: CONFIRMED 2
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** Holds, and it is worse on the edge than stated. The builder simulation binds only declared VAR_INPUT/VAR_IN_OUT/VAR_OUTPUT variables. Undeclared identifiers read 0, and assignments to them create hidden keys that getVariableInfo() never reports. The edge compiler puts process-image tags into the symbol table first. It compiles bare tag names to LoadTag/WriteTag and every declared VAR/VAR_INPUT/VAR_OUTPUT to a local slot. A simulation-style program (VAR_INPUT level : REAL; VAR_OUTPUT pump : BOOL) therefore never touches a tag on the edge. Because uninitialised edge locals are Bool(false) (SIMV-01), it also faults at its first scan reading `level`.

**What the user sees.** Either the program runs in Simulation and does nothing on the device, or it is written for the device and the Simulation Run button does nothing.

**Root cause.** No single I/O binding contract shared by the program, the HMI and the runtime. Each runtime invented its own.

**Fix direction.** Define one contract in @platform/sensor-contracts: a program declares its I/O symbols, each mapped to a TagRef via ioTagName/ioConfigId. Feed the same mapping to the edge compile (TagDescriptor[]) and to the browser VM, so simulation and edge resolve identical names. Add a contract test: the same program and binding give the same tag writes in the wasm VM and the native VM.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:450-476`
- `web/modules/sensor-module/src/simulation/useSimulation.ts:252-259`
- `web/modules/sensor-module/src/simulation/st-interpreter.ts:604-610`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs:1619-1660`
- `web/modules/sensor-module/src/simulation/useSimulation.ts:237-244`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:94-106`
- `sens-api-gateway/src/scripting/bytecode_compiler.rs:1629-1656`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:412-418`
- `sens-api-gateway/src/scripting/task_scheduler.rs`
- `sens-api-gateway/src/scripting/task_scheduler.rs:157`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-05** (SIM; verdict CONFIRMED; severity HIGH): The simulation and the edge VM use opposite variable-to-tag models, so a program that works in one silently does nothing in the other
  - sim reader/writer: web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:450-476 (INPUT/INOUT fed via setInputDirect; OUTPUT/INOUT read from snapshot)
  - web/modules/sensor-module/src/simulation/useSimulation.ts:252-259 (setInputDirect refuses names that are not VAR_INPUT/VAR_IN_OUT)
  - web/modules/sensor-module/src/simulation/st-interpreter.ts:604-610 (unknown identifier → 0), :395-400 (assignment creates key), :190-205 (getVariableInfo lists only declared vars)
  - edge: sens-api-gateway/src/scripting/bytecode_compiler.rs:1619-1660 (tags inserted first; every var_block declaration becomes SymbolEntry::local), :335 (SymbolKind::Tag → LoadTag)
  - RAN: scratchpad/sim/run.ts 'direct tag reference (edge style)': getVariableInfo()=[]; internal keys [["pump_01_run",true]] (written but not exported)
  - (verifier) sim: web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:450-476; web/modules/sensor-module/src/simulation/useSimulation.ts:237-244 (setInputDirect refuses non-input names); st-interpreter.ts:604-610 (unknown identifier → 0), :395-400 (assignment creates key), :190-205 (getVariableInfo only lists declared vars)
  - (verifier) web/modules/sensor-module/src/store/scada/projectSlice.ts:94-106 (only INPUT/OUTPUT/INOUT scopes become bindable variables)
  - (verifier) edge: sens-api-gateway/src/scripting/bytecode_compiler.rs:1629-1656 (tags inserted first, then every var_block declaration → SymbolEntry::local), :329-337 (Tag → LoadTag)
  - (verifier) RAN: scratchpad/verify-sim/run.cjs 'direct tag reference (edge style)': getVariableInfo()=[] while internal keys [["pump_01_run",true]]
  - (verifier) RAN: scratchpad/verify-sim/edgec → 'VAR_OUTPUT pump (sim style)': [LoadLocal 0, PushConst Real(30.0), LtReal, StoreLocal 1] (no tag op); 'direct tags (edge style)': [LoadTag TANK_LEVEL, …, WriteTag PUMP_01_RUN]; 'sim-style VAR_INPUT REAL read': VM ERROR TypeMismatch LtReal expected Real got Bool
  - Verifier: I ran the same two program styles through both the browser interpreter and the real edge compiler and VM. Each runtime's I/O model is the inverse of the other's, exactly as claimed.
- **SIM-17** (SIM; verdict CONFIRMED; severity MEDIUM): Only one linked program can run at a time
  - Claim: Holds. SimulationSidebar has one useSimulation instance, one activeProgram and one interval. handleStartProgram clears the running interval and calls simulation.stop() before loading the next program, so starting a second linked program silently stops the first. The edge has a multi-task scheduler. This is latent behind SIM-01.
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:412-418 (single simulation + activeProgram), :484-494 (Run stops the previously running program)
  - sens-api-gateway/src/scripting/task_scheduler.rs (multi-task scheduler on the edge)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:412-418 (single simulation/activeProgram/interval), :489-494 (stop previous before Run), :754-799 (Run buttons per binding, one isActive)
  - (verifier) sens-api-gateway/src/scripting/task_scheduler.rs:157 (TaskConfig), :373 (TaskScheduler)
  - Verifier: Verified directly in the code.

</details>

### SENSOR-HIGH-329

**Interactive closed-loop simulation is impossible: no plant model (valve/pump/VFD actions never change flow or level), equipment has a single tag (no command vs feedback, fault/maintenance never from data), VFD widgets ignore the simulation plane and offer no frequency setpoint**

- Severity: HIGH · Domain: SENSOR · Plan phase: F5 · Deadline: 2027-03-29
- Verification: PARTIAL 3, SELF 1
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** It is true that no plant or process model exists. simTagValues changes only through manual sidebar edits, scenario batches, widget toggle/press/writeTag and program outputs. There is no random walk, and queryHistory returns []. The 'broken promise' framing is wrong. The doc defines closed loop as 'program outputs fed back into the simulation tag values' (docs/SCADA_SIMULATION_MODE.md:24, :213-215). That loop exists in code, though SIM-01 currently breaks it. Process dynamics (pump/valve → flow → level) were never promised. This is a missing capability for the interactive simulation the user wants and a key input to the rewrite, not a regression.

**What the user sees.** I start the pump in Simulation and the tank level never moves. Closing the outlet valve does not raise the level. Lowering the VFD frequency changes no flow. Nothing reacts unless I drag every value myself.

**Root cause.** The simulation was built as a tag-injection panel. The process graph the user draws (equipment + pipes) carries no physical semantics.

**Fix direction.** Add a plant-model layer that runs in the same simulation clock as the VM. Derive it from the drawn graph: pumps (on/frequency → flow via affinity law), valves (open % → Cv), tanks (integrate in/out flows → level), sensors (read model state + noise/fault), with per-equipment parameters in the equipment schema. Per tick: VM outputs → actuators → model step → sensor tags → VM inputs.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/store/scada/simulationSlice.ts:10-46`
- `web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:117-130`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:1-9`
- `docs/SCADA_SIMULATION_MODE.md:213-215`
- `web/modules/sensor-module/src/store/scada/simulationSlice.ts:9-46`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:81`
- `web/modules/sensor-module/src/components/scada-builder/RecipePanel.tsx:81`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SchedulerConfig.tsx:45`
- `docs/SCADA_SIMULATION_MODE.md:24`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:87-95`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:37-59`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:213,232-233`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:468-476`
- `web/modules/sensor-module/src/types/scada-widget.types.ts:130`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:81-88`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/pumps/CentrifugalPumpSymbol.tsx:130`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/filters/BagFilterSymbol.tsx`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/animated/AnimatedGearSymbol.tsx:128`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/animated/AnimatedConveyorSymbol.tsx:193`
- `web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:80-87`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:183-189`
- `web/modules/sensor-module/src/hooks/useVfdReadings.ts:142-170`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdMiniWidget.tsx:71`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:223-245`
- `web/modules/sensor-module/src/hooks/useVfdReadings.ts:142-175`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:221-245`
- `sens-api-gateway/src/process_image.rs:129-137`
- `sens-api-gateway/src/scripting/process_image_tagio.rs:322-339`
- `sens-api-gateway/src/commands/force_commands.rs:193-199`
- `sens-api-gateway/src/opc_ua_server.rs:873`
- `sens-api-gateway/src/main.rs:5703-5705`
- `sens-api-gateway/src/commands/io_config.rs:239-243`
- `sens-api-gateway/src/process_image.rs:48-61`
- `sens-api-gateway/src/scada_server.rs:620-641`
- `sens-api-gateway/src/scada_types.rs:272-281`
- `sens-api-gateway/src/io_poll.rs:33-38`
- `sens-api-gateway/static/scada-edge.html:1676-1685`
- `web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:1083`
- `web/modules/sensor-module/src/hooks/useEdgeIoSocket.ts:30-34`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-07** (SIM; verdict PARTIAL; severity MEDIUM): There is no plant model: valve, pump and VFD actions never change flows or levels, so the 'closed loop' never closes
  - web/modules/sensor-module/src/store/scada/simulationSlice.ts:10-46 (only set/clear actions; no dynamics)
  - web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:117-130 (queryHistory → empty)
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:1-9 ('D. Automation — run ST programs in closed-loop simulation'); docs/SCADA_SIMULATION_MODE.md:213-215
  - grep 'Math.random\|plantModel\|processModel\|physics' in sensor-module/src: only id generators
  - related: CONN-06 (pipe flow not tied to pump/valve)
  - (verifier) web/modules/sensor-module/src/store/scada/simulationSlice.ts:9-46 (only set/batch/clear actions)
  - (verifier) web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:117-130 (queryHistory → empty arrays), :90-94 (quality 'good')
  - (verifier) grep Math.random in sensor-module/src (non-test): only id/key generators (ScreenCanvas.tsx:81, RecipePanel.tsx:81, st-\* providers, SchedulerConfig.tsx:45, SensorWidget gradient id)
  - (verifier) docs/SCADA_SIMULATION_MODE.md:24 ('run IEC 61131-3 Structured Text programs in a closed feedback loop'), :213-215 ('feeds their outputs back into the simulation tag values')
  - (verifier) SimulationSidebar.tsx:1-9 (header 'run ST programs in closed-loop simulation')
  - Verifier: The absence of any dynamics is confirmed. The design doc's own definition of 'closed loop' is program I/O feedback, which the code implements, so the UI does not misrepresent itself. I downgraded this to MEDIUM as a capability gap.
- **SIM-06** (SIM; verdict PARTIAL; severity MEDIUM): Equipment has a single tag, so the closed loop (click → program → equipment) cannot be modelled; fault and maintenance can never come from data
  - Claim: The facts hold. EquipmentConfig exposes one Tag (config.tagName). No config key for command, feedback, fault or mode exists anywhere in sensor-module. deriveState yields only running/stopped or open/closed from data, so 'fault' and 'maintenance' come only from demoState. A string status such as 'RUN' or 'FAULT' gives Number('RUN') = NaN and shows stopped. FaultOverlay/MaintenanceOverlay are mounted in only 4 of 52 symbols, although the 'fault' state colour (error red) exists in EQUIPMENT_STATE_COLORS for all symbols. Overstated: 'the closed loop cannot be modelled'. A loop can be built with separate operator widgets (push button/toggle bound to a program INPUT) and the equipment symbol used as an indicator bound to an OUTPUT. The collision only appears when the user clicks the indicator itself (see SIM-11). What is truly impossible is data-driven fault/maintenance display and a command-versus-feedback distinction (fail-to-start).
  - writer: web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:87-95 (single TagBrowser → {tagName}), :129-145 (Demo Status)
  - reader: web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:37-59 (deriveState: no fault/maintenance path), :80-84 (click → onCommand('toggle'))
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:213,232-233 (toggle writes simTagValues[tagName])
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:468-476 (program writes OUTPUT tag every scan → overwrites the click)
  - web/modules/sensor-module/src/types/scada-widget.types.ts:130 (EquipmentState has 6 states); components/scada-builder/equipment-symbols/types.ts:81-88 (distinct colours), :392,426 (overlays); grep: <FaultOverlay> only in pumps/CentrifugalPumpSymbol.tsx:130, filters/BagFilterSymbol.tsx, animated/AnimatedGearSymbol.tsx:128, animated/AnimatedConveyorSymbol.tsx:193
  - (verifier) writer: web/modules/sensor-module/src/components/scada-builder/widget-configs/EquipmentConfig.tsx:87-95 (single TagBrowser → {tagName}), :129-146 (Demo Status)
  - (verifier) reader: web/modules/sensor-module/src/components/scada-builder/widget-renderers/EquipmentRenderer.tsx:37-59 (deriveState: demoState first; truthy test incl. Number(value)>0; no fault/maintenance branch), :80-84 (click → toggle), :118-129 (symbol receives only state)
  - (verifier) grep faultTag\|feedbackTag\|commandTag\|statusTag\|runFeedback in sensor-module/src: no results
  - (verifier) web/modules/sensor-module/src/components/scada-builder/equipment-symbols/types.ts:80-87 (6 distinct state colours incl. fault/maintenance); grep '<FaultOverlay\|<MaintenanceOverlay': only pumps/CentrifugalPumpSymbol, animated/AnimatedGearSymbol, animated/AnimatedConveyorSymbol, filters/BagFilterSymbol (52 \*Symbol.tsx files)
  - (verifier) SimulationSidebar.tsx:468-476 (program writes the OUTPUT tag every scan → overrides a click on the same tag)
  - Verifier: Every factual sub-claim checks out. The headline that the closed loop cannot be modelled is too strong, because separate operator widgets bound to inputs provide the command path. The real gap is the missing device signal model (fault, feedback, mode), which hurts realism but does not block a working process. MEDIUM.
- **SIM-08** (SIM; verdict PARTIAL; severity MEDIUM): VFD widgets ignore the simulation plane, poll real cloud readings during simulation, and offer no frequency setpoint
  - Claim: Holds. VfdDriveWidget does not destructure `value`. Outside edit mode (simulation included, because ScreenCanvas passes isEditing = !isPreview) it polls vfdLatestReading every 2 s for config.vfdDeviceId, so Simulation shows the real drive's numbers. With no device it shows DEMO*PARAMETERS with an 'offline' state. It has no setpoint input, and its vfd:* commands have no handler. Two parts are already reported: the demo-parameter display is FAKE-01 and the dropped vfd:\_ commands are CMD-01. The new defect is that the VFD tile is wired to the device API instead of the tag plane, so it can be neither simulated nor driven by a program. MEDIUM because of the overlap.
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:183-189 (props without value), :210-213 (useVfdRealtimeReadings enabled when !isEditing), :215-218 (no reading → DEMO_PARAMETERS), :259-269 (vfd:start/stop/program)
  - web/modules/sensor-module/src/hooks/useVfdReadings.ts:142-170 (graphqlFetch GET_VFD_LATEST_READING_QUERY polling)
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdMiniWidget.tsx:71 (same hook), :91 (vfd:navigate)
  - web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:223-245 (no vfd:\* or setValue branch; see CMD-01)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdDriveWidget.tsx:183-189 (props: config,width,height,isEditing,onCommand — no value), :210-218 (useVfdRealtimeReadings when !isEditing; DEMO_PARAMETERS when no reading), :231-234 (offline when no device), :258-269 (vfd:start/stop/program)
  - (verifier) web/modules/sensor-module/src/hooks/useVfdReadings.ts:142-175 (graphqlFetch GET_VFD_LATEST_READING_QUERY polling)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:221-245 (only navigate/toggle/press/writeTag), :595-596 (isEditing={!data.isPreview})
  - (verifier) related prior: FAKE-01 (VFD demo params), CMD-01 (vfd:\* dropped)
  - Verifier: The code matches the claim. Severity reduced because two of its three symptoms are already-confirmed findings. The remaining new fact (no tag plane, production polling during simulation) is a real but contained gap.
- **OUT-05** (GAP2; verdict SELF; severity HIGH): Nothing models 'commanded' vs 'confirmed': every writer stamps quality Good, the wire formats drop the source, and both the device HMI and the cloud render a commanded value as the actual state
  - Claim: TagValue holds one value, one quality and one source. commit_pending_writes always writes TagQuality::Good. Force and OPC UA writes do the same, and the HMI executor and set_output write Good with the hardware source after a write that has no readback. The quality enum knows Simulated, but has no Commanded, Unconfirmed or Mismatch state. At the wire boundary the source is dropped as well: allTags TagInfo carries only tag_name/value/quality/unit/io_type(None)/timestamp, and io_data IoTagData carries value/quality/simulated. Both readers decide ON/OFF from value alone and show a fault only when quality != 'good': the edge HMI StatusIndicatorWidget and the cloud EdgeDeviceDetailPage 'Canli Deger' column. So a widget bound to an output, or to a program variable written through a tag, cannot show an actuation that did not happen, because the information is gone before it reaches the UI.
  - writer: process_image.rs:129-137 (TagValue {value, quality, timestamp, raw_value, source}); process_image_tagio.rs:322-339 (always Good); force_commands.rs:193-199 (Good); opc_ua_server.rs:873 (Good); main.rs:5703-5705 and io_config.rs:239-243 (Good after an unverified write)
  - process_image.rs:48-61 (quality states: Good/Uncertain/Bad/CommFailure/NotInitialized/Simulated; none for commanded/unconfirmed)
  - wire: scada_server.rs:620-641 + scada_types.rs:272-281 (allTags TagInfo, no source); io_poll.rs:33-38 and 418-433 (io_data, DO -> bool, quality string, no source)
  - reader (edge): sens-api-gateway/static/scada-edge.html:1676-1685 (allTags -> tagStore value/quality), 1329-1338 (isOn = value > 0; isFault only if quality !== 'good'; 'ACIK' green LED)
  - reader (cloud): web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:1083 (useEdgeIoSocket), 1309-1325 (ON/OFF from live.value, QualityDot from quality); hooks/useEdgeIoSocket.ts:30-34 (IoTagValue has no source/feedback field)
  - RAN probe_b/probe_c: committed values come back as quality Good, source Script; the source never leaves the agent

</details>

### SENSOR-HIGH-331

**Package scripts never execute in any runtime: the production CSP blocks the client sandbox, the edge drops scripts, server and browser sandbox APIs differ, and the Test button only logs to the console**

- Severity: HIGH · Domain: SENSOR · Plan phase: F5 · Deadline: 2027-03-29
- Verification: CONFIRMED 4, PARTIAL 1
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** Holds. This also refutes the sibling DEP-18 statement that scripts 'run only in the cloud runtime': the scheduler filters out every builder-authored script because mode and scheduling are never written. The builder ScadaScript type does declare mode and scheduling as optional fields (engine/events/types.ts:83-84), but no UI writes them.

**What the user sees.** The script card shows a green 'Enabled' dot and a 'Timer' or 'Tag' badge. After save, deploy and opening the operator view, the script never runs: no tag changes, no console output, and no error anywhere.

**Root cause.** The builder's ScadaScript (engine/events/types.ts) and the runtime ScadaScript (types/scada-runtime.types.ts) are two schemas. The trigger model (trigger/triggerTag/triggerInterval) and the scheduling model (mode/scheduling.intervalSec/cron) were never reconciled, and the client engine was never mounted.

**Fix direction.** Define one script contract in sensor-contracts with an explicit execution target (cloud server, browser, or edge) and a single trigger union, validated at save. Mount a single executor per target that consumes exactly that contract. Make the edge either support the contract or have the deploy refuse scripts it cannot run, with a visible message.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptsPanel.tsx:61-69`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptTriggerConfig.tsx:56-71`
- `apps/sensor-service/src/scada-runtime/services/scheduler.service.ts:440-443`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:172-173,189`
- `web/modules/sensor-module/src/engine/scripting/useScriptEngine.ts:148-197`
- `web/modules/sensor-module/src/engine/scripting/index.ts:28`
- `web/modules/sensor-module/src/hooks/useWidgetEvents.ts:115-130`
- `sens-api-gateway/src/scada_types.rs:16-27`
- `web/modules/sensor-module/src/types/scada-runtime.types.ts:612`
- `web/modules/sensor-module/src/engine/events/types.ts:84`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:279`
- `apps/sensor-service/src/process/services/scada-package.service.ts:111-144`
- `apps/sensor-service/src/scada-runtime/services/scheduler.service.ts:659`
- `web/modules/sensor-module/src/engine/scripting/useScriptEngine.ts`
- `web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts:161-166`
- `web/modules/sensor-module/src/engine/scripting/workerScript.ts:282-288`
- `infrastructure/nginx/droplet.conf:161`
- `web/modules/sensor-module/src/hooks/useClientScript.ts:114`
- `web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts:161-167`
- `web/modules/sensor-module/src/hooks/useWidgetEvents.ts:115-128`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptEditor.tsx:37-48`
- `web/modules/sensor-module/src/engine/scripting/workerScript.ts:76-80`
- `apps/sensor-service/src/scada-runtime/services/script-engine.service.ts:28-38`
- `web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts:146-153`
- `apps/sensor-service/src/scada-runtime/services/quickjs-sandbox.ts:181-234`
- `sens-api-gateway/src/scada_server.rs:501-505`
- `sens-api-gateway/static/scada-edge.html:1775`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:165-167`
- `sens-api-gateway/src/scada_types.rs`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:441-445`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptsPanel.tsx`

<details><summary>Merged audit findings and full evidence</summary>

- **SET-07** (SET; verdict CONFIRMED; severity HIGH): Package scripts never execute in any runtime
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptsPanel.tsx:61-69 (new script: id,name,code,trigger:'event',enabled; no mode/scheduling)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptTriggerConfig.tsx:56-71 (writes trigger/triggerTag/triggerInterval only)
  - apps/sensor-service/src/scada-runtime/services/scheduler.service.ts:440-443 (filter mode==='server' && enabled && scheduling), 480-482
  - grep "mode: 'server'\|scheduling:" in web/modules/sensor-module/src (non-test): none; grep triggerTag\|triggerInterval in apps/sensor-service/src and sens-api-gateway/src: none
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:172-173,189 (all scripts handed to scheduler, which drops them)
  - web/modules/sensor-module/src/engine/scripting/useScriptEngine.ts:148-197 (trigger implementation); only importer is engine/scripting/index.ts:28 re-export
  - web/modules/sensor-module/src/hooks/useWidgetEvents.ts:115-130 (window.**scadaScripts** lookup); grep **scadaScripts**: no writer
  - sens-api-gateway/src/scada_types.rs:16-27 (ScadaPackage: meta, screens, alarmRules, controlPermissions, trendConfig only)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptsPanel.tsx:61-69 new script {id,name,code,trigger:'event',enabled}
  - (verifier) widget-configs/ScriptTriggerConfig.tsx:56-71 writes trigger/triggerTag/triggerInterval only
  - (verifier) grep 'scheduling\|mode: .server.' in sensor-module/src (non-test): only type declarations (scada-runtime.types.ts:612, engine/events/types.ts:84)
  - (verifier) store/scada/projectSlice.ts:279 scripts serialized verbatim; scada-package.service.ts:111-144 validateScripts does not map trigger → mode/scheduling
  - (verifier) apps/sensor-service/src/scada-runtime/services/scheduler.service.ts:440-443 filter mode==='server' && enabled && scheduling; 480 addScript same gate; only runScript caller is scheduler.service.ts:659
  - (verifier) grep triggerTag\|triggerInterval in apps/sensor-service/src and sens-api-gateway/src: none
  - (verifier) engine/scripting/useScriptEngine.ts: only importer is engine/scripting/index.ts:28 re-export
  - (verifier) hooks/useWidgetEvents.ts:115-130 window.**scadaScripts** lookup; no writer anywhere in web/
  - (verifier) sens-api-gateway/src/scada_types.rs:16-27 ScadaPackage has no scripts field
  - Verifier: I looked for any executor that consumes trigger, triggerTag or triggerInterval (backend, edge, builder event handlers in engine/events/handlers) and found none. The only server executor requires fields the builder never writes. Scripts are dead in every runtime.
- **SIM-19** (SIM; verdict CONFIRMED; severity MEDIUM): Production CSP blocks the client-script sandbox: the blob worker runs user code with new Function, but script-src has no 'unsafe-eval'
  - Claim: Holds and is latent. ScriptExecutor creates a classic Worker from a Blob URL, and the worker runs user code through `new Function(...)`. The app.suderra.com server block sets script-src 'self' https://cdn.jsdelivr.net without 'unsafe-eval'. The nginx comment documents its removal (D14-SC-02). `location /` adds no headers of its own, so the server-level CSP applies to the shell document, and a blob: worker inherits its creator's policy. It is latent twice over: useWidgetEvents' runScript resolves scripts from window.**scadaScripts**, which nothing populates, and package scripts never run anywhere (SET-07).
  - web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts:161-166 (Blob URL), :186 (new Worker(blobUrl))
  - web/modules/sensor-module/src/engine/scripting/workerScript.ts:282-288 (new Function(..., code))
  - infrastructure/nginx/droplet.conf:161 (server_name app.suderra.com), :197 (CSP script-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:)
  - consumer: web/modules/sensor-module/src/hooks/useClientScript.ts:114 (operator runtime executor)
  - (verifier) web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts:161-167 (Blob URL), :184 (new Worker(blobUrl, {type:'classic'}))
  - (verifier) infrastructure/nginx/droplet.conf:161 (server_name app.suderra.com), :195-197 (comment 'unsafe-eval removed from script-src'; CSP script-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:), :574-588 (location / has no add_header, so it inherits the server CSP)
  - (verifier) consumers: web/modules/sensor-module/src/hooks/useClientScript.ts:114; web/modules/sensor-module/src/hooks/useWidgetEvents.ts:115-128 (runScript reads window.**scadaScripts**, which no code assigns)
  - Verifier: I read both the worker and the production CSP, and the policy-inheritance behaviour for blob workers is standard. The severity stays MEDIUM as a latent production-only trap.
- **SET-08** (SET; verdict CONFIRMED; severity MEDIUM): The editor's 'Sandbox API Reference' describes the browser worker API, and the server sandbox has different names and return types
  - Claim: Holds. The QuickJS host registers only the functions listed in script-engine.service.ts plus console and params, so $log, $navigate, $openCard, $openUrl, $setProperty, $getProperty, $closeDialog and $setAlarm are undefined there. The symptoms are latent today because no script ever executes (SET-07).
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptEditor.tsx:37-48 (API_REFERENCE)
  - web/modules/sensor-module/src/engine/scripting/workerScript.ts:76-80 ($getTag returns value or 0), 84-95, 236-247 ($setAlarm levels)
  - apps/sensor-service/src/scada-runtime/services/script-engine.service.ts:28-38 (server API list), 316-323 ($getTag returns TagValueChange\|null), 325-333
  - web/modules/sensor-module/src/hooks/useClientScript.ts:114 (new ScriptExecutor(tagBus, eventBus), no callbacks)
  - web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts:146-153 (callbacks optional), 352-372 ($setAlarm → callbacks.onAlarm)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptEditor.tsx:37-48 API_REFERENCE
  - (verifier) engine/scripting/workerScript.ts:76-80 $getTag returns value or 0; 236-247 $setAlarm levels info/warning/critical/emergency
  - (verifier) apps/sensor-service/src/scada-runtime/services/script-engine.service.ts:28-38 server API list; 316-323 $getTag returns TagValueChange\|null
  - (verifier) services/quickjs-sandbox.ts:181-234 only sync/async host functions + console are set on the global
  - (verifier) hooks/useClientScript.ts:114 new ScriptExecutor(tagBus, eventBus) without callbacks
  - Verifier: Both sandboxes were read. The API names, return shapes and severity vocabulary diverge, and nothing generates the editor reference from either. Impact is real once scripts run, so it stays MEDIUM.
- **DEP-18** (DEP; verdict PARTIAL; severity LOW): The edge silently drops package scripts, the package name and the screen hierarchy, so scripts never run on the device
  - Claim: The Rust ScadaPackage, PackageMeta and Screen structs have no scripts, packageName or parentId fields. serde drops them, and setPackage rebroadcasts the narrowed struct, so scripts never reach the device and screen hierarchy is flattened. Two corrections. (1) Scripts do not run 'only in the cloud' either. The cloud SchedulerService.loadScripts keeps only scripts with mode==='server' && enabled && scheduling, which the builder never writes (SET-07). So the edge drop matters only after SET-07 is fixed. (2) The header shows 'Suderra SCADA' because the HMI reads package\_.name. The document never had that key: it is meta.packageName, which the edge also drops. Both sides would need fixing.
  - sens-api-gateway/src/scada_types.rs:16-27 (ScadaPackage fields), 37-50 (PackageMeta), 56-70 (Screen: no parentId)
  - sens-api-gateway/src/scada_server.rs:501-505 (setPackage = re-serialized struct)
  - sens-api-gateway/static/scada-edge.html:1775 (header uses package\_.name)
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:165-167 (scripts loaded only by the cloud)
  - PROBE: re-serialized setPackage for a builder-shaped doc contains no scripts, edges, packageName or widget name/visible
  - (verifier) sens-api-gateway/src/scada_types.rs:16-27, 37-50, 56-70 (no scripts/packageName/parentId)
  - (verifier) sens-api-gateway/static/scada-edge.html:1775 (package\_.name)
  - (verifier) apps/sensor-service/src/scada-runtime/services/scheduler.service.ts:440-443 (filter mode==='server' && enabled && scheduling)
  - (verifier) PROBE (my crate against the real scada_types.rs): a builder-shaped doc re-serializes without scripts, packageName, automationBindings, screen parentId/edges, or widget name/visible/zIndex
  - Verifier: The edge drop is verified by probe. The parenthetical that the cloud runs the scripts is refuted by the scheduler filter. The remaining effects are cosmetic (header) or dominated by SET-07, META-01 and EDGE-03, so LOW.
- **LIFE-27** (LIFE; verdict CONFIRMED; severity LOW): The 'Test' button in the Scripts tab only writes to the browser console
  - Claim: Duplicate of OPS UI-01. onTestScript only runs console.log.
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:441-445
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ScriptsPanel.tsx (Test wired through onTestScript)
  - Verifier: Confirmed.

</details>

### SENSOR-MEDIUM-328

**Operator input in simulation restarts the scan timer (0 cycles while dragging, push-buttons never seen) and collapsing the right panel stops the program**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F5 · Deadline: 2027-03-29
- Verification: CONFIRMED 1, PARTIAL 1
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** The mechanism holds. useSimulation returns a new object literal on every render. The restart effect (deps [scanInterval, activeProgram, simulation, runClosedLoopTick]) therefore clears and recreates the scan interval on every SimulationSidebar render. Anything that re-renders the sidebar pushes the next scan out: any simTagValues change, the 500 ms highlight-clear timer, or the 500 ms cycle-count flush. At the default 100 ms scan, 10 of 10 momentary presses are seen. At 250 ms and above, 0 of 10 are seen. A continuous drag faster than the scan period (the sidebar range input fires per step) gives 0 cycles while dragging, and the program catches up after release. The scan period is also stretched in general, e.g. 9 cycles in 5 s at 500 ms. This is latent behind SIM-01, because no linked program can run in the builder today. The default setting works for push buttons. MEDIUM, not HIGH.

**What the user sees.** Once a program runs: pressing START on a push button does nothing at the 250/500/1000 ms scan settings. While I move a slider, the program freezes and the equipment stops reacting until I let go.

**Root cause.** The scan clock lives in a React effect tied to render identity, and inputs are sampled by polling a store snapshot instead of being latched events.

**Fix direction.** Move the scan loop out of React into a simulation engine object (Worker or class) with its own monotonic clock. The UI only posts input events to it. Latch momentary inputs until the next scan consumes them, or model push buttons as press/release (pointerdown/up) instead of a fixed 200 ms pulse. Test: N presses at every scan setting give N rising edges.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/simulation/useSimulation.ts:310-332`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:539-566`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:210-230`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:234-240`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:450-457`
- `web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:233-239`
- `web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:229-239`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:405-414`
- `web/modules/sensor-module/src/components/scada-builder/usePanelShortcuts.ts:43-45`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:577-584`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:50-58`
- `web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:230-243`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:404-414`
- `web/modules/sensor-module/src/components/scada-builder/usePanelShortcuts.ts:31-33`
- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:397-409`
- `web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:51-57`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-03** (SIM; verdict PARTIAL; severity MEDIUM): Any operator input restarts the program's scan timer: while the user drags a slider the program executes 0 cycles, and push-button presses are never seen at scan times of 250 ms or more
  - web/modules/sensor-module/src/simulation/useSimulation.ts:310-332 (return { ... } new object each render, not memoized)
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:539-566 (effect clears/recreates interval; deps [scanInterval, activeProgram, simulation, runClosedLoopTick])
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:210-230 (sidebar subscribes to simTagValues)
  - writer of pulse: web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:234-240 (press = true, reset to false after 200 ms)
  - reader: SimulationSidebar.tsx:450-457 (inputs sampled only at tick time)
  - RAN: scratchpad/sim/starve-test.tsx → 'scan=500ms idle 5 s: cycles=9'; 'slider drag every 150ms for 5 s scan=500ms: cycles=0'; 'push-button scan=250ms: presses sent=10 seen=0'; 'push-button scan=100ms: sent=10 seen=10'; sidebar-test.tsx → '200ms pulse, 500ms scan: presses sent=10, seen=0'
  - (verifier) web/modules/sensor-module/src/simulation/useSimulation.ts:310-332 (unmemoized return object)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:539-566 (restart effect deps include simulation and runClosedLoopTick, whose deps are [simulation] at :481)
  - (verifier) SimulationSidebar.tsx:210-230 (subscribes to simTagValues), :236-250 (setChangedTags + 500 ms clear → extra renders), :568-575 (flushCycleCount every 500 ms → setCycleCount re-render)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx:233-239 (press: true, then false after 200 ms)
  - (verifier) RAN (rebuilt from current source): scratchpad/verify-sim/out-starve.cjs → 'push-button scan=100ms cycles=60 presses sent=10 seen=10'; 'push-button scan=250ms cycles=20 sent=10 seen=0'; 'idle 5 s scan=500ms cycles=9'; 'slider drag every 150ms for 5 s scan=500ms cycles=0'
  - Verifier: I re-ran the starvation harness against the current code and got the auditor's numbers exactly. The defect is real, but it cannot be reached until SIM-01 is fixed, and the default 100 ms scan does register push-button presses. I downgraded it to MEDIUM for that reason.
- **SIM-12** (SIM; verdict CONFIRMED; severity MEDIUM): Collapsing the right panel (button or Ctrl+]) silently stops the running program and freezes the alarm state
  - Claim: Holds. CollapsiblePanel renders children only when expanded, and the right panel holds SimulationSidebar in simulation mode. Collapsing it (button, rail, or Ctrl/Cmd+]) unmounts the sidebar. The unmount clears the scan interval and drops the useSimulation interpreter and useAlarmEvaluation state. simAlarms is not cleared, so GlobalAlarmBanner freezes. If the panel was already collapsed when Simulation was entered, no alarm evaluation or program runs at all until it is expanded.
  - web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:229-239 ({!collapsed && <div>{children}</div>})
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:405-414 (SimulationSidebar inside the right CollapsiblePanel); components/scada-builder/usePanelShortcuts.ts:43-45 (Ctrl+] toggles right)
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:577-584 (unmount clears interval only), :397-409 (alarm evaluation owned by the sidebar)
  - web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:50-58 (reads simAlarms from the store)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/CollapsiblePanel.tsx:230-243 ({!collapsed && <div>{children}</div>})
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:404-414 (SimulationSidebar inside right CollapsiblePanel)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/usePanelShortcuts.ts:31-33 (Ctrl/Cmd required), :43-45 (']' toggles right)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:397-409 (alarm evaluation + setSimAlarms owned by sidebar), :577-584 (unmount clears interval only)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/GlobalAlarmBanner.tsx:51-57 (reads simAlarms from store)
  - Verifier: The lifetime coupling is verified by reading the mount site, the conditional render and the unmount cleanup.

</details>

### SENSOR-LOW-330

**Scenario tooling is static snapshots (no ramps, steps, fault injection, time acceleration, record/replay) and trends use a third read path in simulation**

- Severity: LOW · Domain: SENSOR · Plan phase: F5 · Deadline: 2027-03-29
- Verification: CONFIRMED 1, PARTIAL 1
- Rule: Simulation executes the same logic artifact that is deployed to the edge

**Claim.** The concrete defects hold. inferDataHint's boolean list names types that do not exist ('indicator', 'statusLight'; also 'textDisplay'/'label' for strings) and misses statusIndicator, equipment and emergencyStop, so pumps and valves get a 0–100 slider. 'Pump Fault' only appears when a toggle or push-button tag contains 'pump', and it just writes false (no symbol can show a fault, per SIM-06). The doc's 'emergency stop' preset is 'All Stop' in code. Custom scenarios go to tenant-scoped localStorage, not to the package, and saveCustomScenarios is not wrapped in try/catch. Quality is always 'good' and the connection always 'connected'. The rest (no ramps, noise, time acceleration or replay) describes features that were never built, not broken ones. These matter for the rewrite but not for getting a process working, so LOW.

**What the user sees.** I cannot make the DO level drift down over 10 minutes, inject a sensor failure, speed time up, or replay yesterday's data. 'Pump Fault' just turns the pump off. My saved scenarios show up in other packages and are lost on another computer.

**Root cause.** Scenarios were designed as value presets, not as time-based stimulus scripts bound to a package.

**Fix direction.** Make a scenario a package-stored timeline of typed stimuli (set, ramp, step, noise, quality=bad, equipment fault, replay of historian data), executed by the simulation clock with a speed factor. Infer data hints from tag type metadata, not widget-type lists.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:69-74`
- `web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx:53,59,67`
- `web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:29,90-94`
- `docs/SCADA_SIMULATION_MODE.md:27`
- `web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx`
- `web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:28`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx:49-51`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223`

<details><summary>Merged audit findings and full evidence</summary>

- **SIM-16** (SIM; verdict PARTIAL; severity LOW): Scenario tooling is static snapshots with name-guessing presets: no ramps, steps, fault or quality injection, time acceleration, or record/replay
  - web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:69-74 (inferDataHint lists), :83-104 (tenant-scoped localStorage), :282-360 (heuristic presets), :362-367 (apply = setSimTagValuesBatch)
  - web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx:53,59,67 (real type names statusIndicator/emergencyStop/equipment)
  - web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:29,90-94 (connected, quality 'good' always)
  - docs/SCADA_SIMULATION_MODE.md:27 (promises 'emergency stop' scenario)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/SimulationSidebar.tsx:69-74 (inferDataHint lists), :83-104 (tenant-scoped localStorage; setItem unguarded at :103), :283-363 (name-heuristic presets), :365-370 (apply = setSimTagValuesBatch)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx registry keys: statusIndicator, emergencyStop, equipment, staticText (no indicator/statusLight/textDisplay/label)
  - (verifier) web/modules/sensor-module/src/providers/SimulationDataProvider.tsx:28, :90-95 (connected; quality 'good')
  - (verifier) docs/SCADA_SIMULATION_MODE.md:27 (promises an 'emergency stop' preset)
  - Verifier: The sub-claims are accurate. Most of the finding is a feature gap rather than a defect that blocks an end-to-end process, so I downgraded it to LOW.
- **SIM-20** (SIM; verdict CONFIRMED; severity LOW): In simulation, TrendChart is a third read path: demo traces until the first numeric value, booleans dropped, samples taken only when some tag changes
  - Claim: Holds. In simulation, TrendChartRenderer reads store.simTagValues directly. It draws generateDemoTraces until a numeric value exists, keeps only typeof number values (so BOOL pump and program outputs never plot), and appends a sample only when the simTagValues reference changes.
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx:49-51 (store read), :75-78 and :98-101 (demo traces fallback), :82-89 (number only), :91-95 (push on recompute; deps simTagValues)
  - compare canvas path: components/scada-builder/ScreenCanvas.tsx:214-223 (useRealtimeData via IDataProvider)
  - related: FAKE-01
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx:49-51 (store read), :73-77 and :98-100 (demo traces fallback), :79-88 (number only), :90-95 (push inside useMemo keyed on simTagValues)
  - (verifier) compare: web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:214-223 (other widgets read via useRealtimeData/IDataProvider)
  - Verifier: Verified by reading the code.

</details>

## H. Alarms, trends, control security and scheduling

### SENSOR-HIGH-332

**Alarms are inconsistent across runtimes: cloud alarm status is written to one store and read from two others, the rule tag means deviceCode/localName in the cloud but localName on the edge, cloud latches until an impossible ACK while the edge auto-clears, and rules from all packages merge by id**

- Severity: HIGH · Domain: SENSOR · Plan phase: F6 · Deadline: 2027-04-19
- Verification: CONFIRMED 5, SELF 1
- Rule: ISA-18.2 alarm semantics, trends and server-enforced control security are identical across runtimes

**Claim.** Holds as stated. useScadaPackageStore (createScadaStore.ts:40 merges alarmRuntimeSlice) receives ALARM_STATUS, and no component reads activeAlarms, alarmStatusSummary or pendingActions from that store. The mounted tray (OperatorShell) reads the standalone useAlarmRuntimeStore. That store is fed only by useAlarmRuntime, whose consumers AlarmPanel.tsx and AlarmSummaryBar.tsx are never mounted. The header badge casts useOperatorStore to a shape it does not have. ALARM_HISTORY_QUERY has no server handler.

**What the user sees.** On /sensor/scada/operator/:id the alarm tray always says 'No active alarms', the header bell shows no count, and there is no way to acknowledge. If the full AlarmPanel were mounted, the History tab would spin for 15 s and stay empty.

**Root cause.** Three parallel alarm-runtime stores (scada store slice, standalone useAlarmRuntimeStore, operator store) with no single source of truth, plus a second socket client that does not reuse the ScadaSocketService transport.

**Fix direction.** Keep one alarm-runtime store, fed by one transport: the ScadaSocketService singleton with path /scada-ws/. Delete the socketFactory-based /scada client. Add a backend ALARM_HISTORY_QUERY handler backed by AlarmStorageService.getAlarmHistory. Add a test that boots OperatorShell, emits ALARM_STATUS on the real service and asserts that the tray and badge render it.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-operator/OperatorBootstrap.tsx:182,194-199`
- `web/modules/sensor-module/src/components/scada-operator/OperatorShell.tsx:88`
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeTable.tsx:429`
- `web/modules/sensor-module/src/hooks/useAlarmRuntime.ts:103-104`
- `web/modules/sensor-module/src/components/scada-operator/OperatorShell.tsx:78-90,130`
- `web/modules/sensor-module/src/hooks/useAlarmRuntime.ts:48-52`
- `web/modules/sensor-module/src/hooks/socketFactory.ts:91-95`
- `web/modules/sensor-module/src/services/ScadaSocketService.ts:146-151`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:149-153`
- `infrastructure/nginx/droplet.conf:282-284`
- `web/modules/sensor-module/src/components/scada-operator/AlarmPanel.tsx:183-184`
- `web/modules/sensor-module/src/components/scada-operator/AlarmSummaryBar.tsx:100,240`
- `web/modules/sensor-module/src/components/scada-operator/OperatorHeader.tsx:178-190`
- `web/modules/sensor-module/src/store/scada/operatorStore.ts:24-33`
- `web/modules/sensor-module/src/types/scada-runtime.types.ts:116-117`
- `web/modules/sensor-module/src/hooks/useAlarmRuntime.ts:202-207`
- `web/modules/sensor-module/src/components/scada-operator/OperatorBootstrap.tsx:182,196-199,243`
- `web/modules/sensor-module/src/store/scada/alarmRuntimeSlice.ts:67-74`
- `web/modules/sensor-module/src/hooks/socketFactory.ts:37-43,91-95`
- `web/modules/sensor-module/src/components/scada-operator/AlarmSummaryBar.tsx:23`
- `web/modules/sensor-module/src/store/scada/operatorStore.ts:16,24-31`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:114-120`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts:94-113`
- `apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123-127,151`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:333-334`
- `apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:233-237,289-291`
- `sens-api-gateway/src/alarm_engine.rs:101-105`
- `sens-api-gateway/src/process_image.rs:299,396-399`
- `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:68-85`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:176-182`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx:331`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:70-76,120-121`
- `apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:97-115`
- `apps/sensor-service/src/process/services/unified-tag.service.ts:102-118`
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:233-237`
- `sens-api-gateway/src/process_image.rs:390-398`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:1147-1257`
- `sens-api-gateway/src/alarm_engine.rs:102`
- `apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123,151`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:333`
- `sens-api-gateway/src/alarm_engine.rs:98-105`
- `apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123-128,151`
- `libs/sensor-contracts/src/scada-package-doc/upcast.ts`
- `libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:69-75`
- `sens-api-gateway/src/scada_server.rs:447-453`
- `sens-api-gateway/src/alarm_engine.rs:98-102`
- `apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123-126,151`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:332-334`
- `apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:141-144`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:391-401`
- `sens-api-gateway/src/alarm_engine.rs:176-207`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:14-23`
- `web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:1146,1156,1166`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:338-340`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:318`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:165-171`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:220-229`

<details><summary>Merged audit findings and full evidence</summary>

- **SET-02** (SET; verdict CONFIRMED; severity HIGH): Cloud alarm status is written to one store and read from two others, so the operator never sees an alarm
  - web/modules/sensor-module/src/components/scada-operator/OperatorBootstrap.tsx:182,194-199 (ALARM_STATUS → useScadaPackageStore.updateAlarmStatus)
  - grep 's.activeAlarms\|s.alarmStatusSummary' in sensor-module/src: readers are only useAlarmRuntimeStore (OperatorShell.tsx:88, RuntimeTable.tsx:429, useAlarmRuntime.ts:103-104)
  - web/modules/sensor-module/src/components/scada-operator/OperatorShell.tsx:78-90,130 (local tray reads useAlarmRuntimeStore, shows 'No active alarms', no ACK button)
  - web/modules/sensor-module/src/hooks/useAlarmRuntime.ts:48-52 (standalone store), 55-67 (URL '/scada'), 117,171,182,194 (getSocket(SCADA_WS_URL) with no path option)
  - web/modules/sensor-module/src/hooks/socketFactory.ts:91-95 (io(url, {...DEFAULT_OPTIONS}) default path)
  - web/modules/sensor-module/src/services/ScadaSocketService.ts:146-151 (the correct client uses path '/scada-ws/')
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:149-153 (namespace '/scada', path '/scada-ws/')
  - infrastructure/nginx/droplet.conf:282-284 (/socket.io/ → gateway-api), 311-313 (/scada-ws/ → sensor-service)
  - web/modules/sensor-module/src/components/scada-operator/AlarmPanel.tsx:183-184 (useAlarmRuntime); AlarmSummaryBar.tsx:100,240 (only mount point); grep '<AlarmSummaryBar': none
  - web/modules/sensor-module/src/components/scada-operator/OperatorHeader.tsx:178-190 (reads alarmStatusSummary from useOperatorStore); store/scada/operatorStore.ts:24-33 (OperatorSlice only)
  - web/modules/sensor-module/src/types/scada-runtime.types.ts:116-117 (ALARM_HISTORY_QUERY/RESULT); grep ALARM_HISTORY in apps/sensor-service/src: no handler; useAlarmRuntime.ts:202-207 (15 s timeout)
  - (verifier) web/modules/sensor-module/src/components/scada-operator/OperatorBootstrap.tsx:182,196-199,243 (ALARM_STATUS → useScadaPackageStore.updateAlarmStatus)
  - (verifier) web/modules/sensor-module/src/store/scada/alarmRuntimeSlice.ts:67-74 (writes activeAlarms/alarmStatusSummary/pendingActions); grep over sensor-module/src shows no reader of these fields on useScadaPackageStore
  - (verifier) OperatorShell.tsx:88 useAlarmRuntimeStore((s)=>s.activeAlarms); 127-131 'No active alarms'; 308 mount; no ACK control
  - (verifier) hooks/useAlarmRuntime.ts:48-52 standalone store; 55-67 URL '/scada'; 117 getSocket(SCADA_WS_URL) with no path; socketFactory.ts:37-43,91-95 DEFAULT_OPTIONS has no path, so the default /socket.io/ is used
  - (verifier) infrastructure/nginx/droplet.conf:282-284 /socket.io/ → gateway-api; 311-313 /scada-ws/ → sensor-service; gateway.ts:149-153 path '/scada-ws/'
  - (verifier) grep '<AlarmSummaryBar' → none; AlarmPanel imported only by AlarmSummaryBar.tsx:23
  - (verifier) OperatorHeader.tsx:178-190 reads alarmStatusSummary through an `as unknown as` cast on useOperatorStore; operatorStore.ts:16,24-31 contains OperatorSlice only
  - (verifier) scada-runtime.types.ts:116-117 ALARM_HISTORY_QUERY/RESULT; grep ALARM_HISTORY\|alarm:history in apps/sensor-service/src → none
  - Verifier: I searched for every ALARM_STATUS listener: only OperatorBootstrap (real socket) and useAlarmRuntime (unmounted, wrong path). I checked whether any component reads alarm state from useScadaPackageStore under another name (pendingActions, alarmHistory, getState()); none does. The writer and the readers never meet, so cloud alarm display is dead even when the engine fires.
- **SET-03** (SET; verdict CONFIRMED; severity HIGH): An alarm rule's tag cannot match in both runtimes: the cloud looks up 'deviceCode/localName', the edge looks up 'localName'
  - Claim: Holds. Duplicates sibling findings DEP-07 and LINK-13. Addition: even a rule written as the full registry fqn fires in the cloud only for SENSOR-fed tags whose registry row carries source.sensorId (fan-out resolves fqns by sensor source; edge I/O never reaches the cache, per LINK-02/DEP-05). The claim's 'same split applies to trendConfig.tags' does not hold for the cloud, because the cloud never reads trendConfig at all (SET-09). The edge-deploy transform also leaves rule.tag untouched, so nothing translates between the two namespaces.
  - web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:114-120 (plain <Input placeholder='Tag'>)
  - libs/sensor-contracts/src/scada-package-doc/upcast.ts:94-113 (only screens/widgets upcast; alarmRules untouched)
  - apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123-127,151 (tagId = String(r.tag), no canonicalisation)
  - apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:333-334 (getTagValue(tenantId, rule.tagId); return if missing)
  - apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115 (cache keys are registry fqns)
  - apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts:233-237,289-291 (tenant-qualified fqn cache)
  - sens-api-gateway/src/alarm_engine.rs:101-105 (tags.get(&rule.tag))
  - sens-api-gateway/src/process_image.rs:299,396-399 (process image keyed by local tag name)
  - web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx:68-85 (emits tag.name)
  - web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts (alarm tags 'DO_tank1', 'pH_biofilter', 'temp_tank1')
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:176-182 (dropped rules only logged)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:114-120 free-text <Input placeholder='Tag'>; mounted at PropertiesPanel.tsx:331
  - (verifier) libs/sensor-contracts/src/scada-package-doc/upcast.ts:94-113 upcasts only meta and screens
  - (verifier) libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:70-76,120-121 transformAlarmRule only normalizes severity and message; tag unchanged
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123-127,151 tagId = String(r.tag).trim()
  - (verifier) alarm-engine.service.ts:333-334 getTagValue(tenantId, rule.tagId); return if null
  - (verifier) tag-value-fanout.service.ts:97-115 values tagId = fqn from unified-tag.service.ts:102-118 findFqnsBySensorSource (requires source.sensorId)
  - (verifier) tag-manager.service.ts:233-237 cache key tenantTagKey(tenantId, change.tagId); gateway.ts:764-768 only producer path
  - (verifier) sens-api-gateway/src/alarm_engine.rs:101-105 tags.get(&rule.tag); process_image.rs:390-398 map keyed by local tag name
  - (verifier) store/scada/templates/aquacultureRasDemo.ts:1147-1257 tags 'DO_tank1','pH_biofilter','temp_tank1', … (local names)
  - (verifier) scada-activation.service.ts:176-182 dropped rules only logged
  - Verifier: I checked every place that could reconcile the namespaces: the upcaster, the edge-deploy transform, the mapper normalizeCondition (condition only) and the TagManager cache producer. None maps local name to fqn or the reverse. The cloud and edge engines key the same string differently, so a rule can fire in at most one runtime.
- **DEP-07** (DEP; verdict CONFIRMED; severity HIGH): The alarm rule's 'Tag' field means different things to the edge and cloud runtimes, so a rule can fire in at most one of them
  - Claim: The Alarms tab's 'Tag' is free text. The edge engine looks it up in the process image by local tag name (tags.get(&rule.tag)). The cloud engine maps rule.tag → tagId and reads tagManager.getTagValue(tenant, tagId). That cache is filled only by the fan-out, keyed by registry FQN ('DEV/pH_1'). A local name never fires in the cloud; an FQN never fires on the edge.
  - web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:114-120 (free-text 'Tag')
  - sens-api-gateway/src/alarm_engine.rs:102 (tags.get(&rule.tag) over process-image names)
  - apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123,151 (tagId = rule.tag)
  - apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:333 (getTagValue(tenantId, rule.tagId))
  - apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115 (cache keyed by fqn)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:114-120 (free-text Tag input)
  - (verifier) sens-api-gateway/src/alarm_engine.rs:98-105 (tags.get(&rule.tag) over process-image names; missing → skip)
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123-128,151 (tagId = rule.tag verbatim)
  - (verifier) apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115 (cache keyed by fqn); libs/sensor-contracts/src/scada-package-doc/upcast.ts has no alarmRules handling; edge-deploy-transform.ts:69-75 only normalizes severity/message
  - Verifier: I looked for an upcaster or transform that rewrites alarm-rule tags at save, deploy or activation. There is none. A local name matches only on the edge, and an FQN only in the cloud cache. The cloud side is also starved for edge I/O tags (DEP-05, LINK-02), which makes things worse but does not refute the claim. It duplicates siblings LINK-13 and SET-03.
- **LINK-13** (BIND; verdict CONFIRMED; severity MEDIUM): Alarm rule tag is free text, and the edge and cloud alarm engines key it differently, so one value can work in at most one runtime
  - Claim: Holds. The alarm tag is a free-text Input. The edge evaluates tags.get(&rule.tag) against the bare-name process image, while the cloud mapper copies rule.tag verbatim into tagId and the engine reads getTagValue(tenant, rule.tagId) from the fqn-keyed cache. Because of LINK-02, cloud rules for edge-device tags never receive values in either form. Siblings DEP-07 and SET-03 report the same defect.
  - web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:114-120
  - sens-api-gateway/src/scada_server.rs:447-453; sens-api-gateway/src/alarm_engine.rs:98-102
  - apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123,151
  - apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:333
  - apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:109-115
  - (verifier) sens-api-gateway/src/scada_server.rs:447-453 (tag: r.tag.clone()); sens-api-gateway/src/alarm_engine.rs:98-102 (tags.get(&rule.tag))
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:123-126,151
  - (verifier) apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:332-334
  - Verifier: Both runtimes were read. The mapper does not normalise the key.
- **SET-12** (SET; verdict CONFIRMED; severity MEDIUM): The same rule behaves differently in the cloud and on the edge: the cloud latches until ACK (which is impossible), the edge auto-clears
  - Claim: Holds. The cloud mapper also never copies `actions` into AlarmRuleRuntime, so the engine's action branch never runs for package rules. Cloud: a non-float alarm goes to 'cleared' and stays until ACK, which SET-01 makes impossible. Edge: the alarm is removed as soon as the value is outside the deadband.
  - apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:141-144 (default 'ackActive'), 158-161
  - apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:391-401 (only float auto-resolves), 484-492 (non-float → 'cleared'), 734-740 (runScript stub)
  - sens-api-gateway/src/alarm_engine.rs:176-207 (clears on deadband exit regardless of ack)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:14-23 (no ackMode/group/actions/enabled)
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:141-144 default 'ackActive'; 146-163 no actions field
  - (verifier) alarm-engine.service.ts:391-401 only float auto-resolves; 484-492 non-float → 'cleared'; 734-740 runScript stub
  - (verifier) sens-api-gateway/src/alarm_engine.rs:176-207 clears on deadband exit regardless of ack
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesAlarmTab.tsx:14-23 no ackMode/group/actions/enabled
  - Verifier: Both engines were read. The defaults diverge and no authoring field exists to align them. Impact appears once the cloud path fires.
- **SET-V-02** (SET-verifier; verdict SELF; severity LOW): Cloud alarm engine merges every published package's rules by id, and packages built from the RAS demo share fixed rule ids, so their alarm state collides
  - Claim: loadAndApply concatenates alarmRules from all published packages of a tenant into one list. The engine keeps per-rule evaluation state in a Map keyed by rule.id. The built-in RAS demo template ships fixed ids ('alarm-do-critical', 'alarm-do-warning', 'alarm-ph-low', …), and loadFromJSON keeps incoming ids (id: r.id \|\| generateId()). Two packages created from the demo therefore carry identical rule ids. If both are published and one threshold is edited, the two rules share one state object, and the alarm activates and clears on alternate evaluations of the same tick. Tenant-wide merging also loses which package or device a rule belongs to, which compounds SET-03.
  - web/modules/sensor-module/src/store/scada/templates/aquacultureRasDemo.ts:1146,1156,1166 (fixed rule ids)
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:338-340 (id: r.id \|\| generateId(); ids preserved on load)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:318 (loadFromJSON(AQUACULTURE_RAS_DEMO))
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:165-171 (all published rows' rules pushed into one array)
  - apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:220-229 (state.rules = rules), 350-353 (evalState keyed by rule.id)

</details>

### EDGE-HIGH-086

**Trends are permanently empty: edge trend history query mixes ms and s, only Trends-tab tags are recorded, and the cloud ignores trendConfig**

- Severity: HIGH · Domain: EDGE · Plan phase: F6 · Deadline: 2027-04-19
- Verification: CONFIRMED 2
- Rule: ISA-18.2 alarm semantics, trends and server-enforced control security are identical across runtimes

**Claim.** Holds (duplicates sibling DEP-04 (b)(c); DEP-04 adds an HMI re-render break). Edge retention cleanup uses ms consistently with storage, so only the HMI query/display units are wrong. The builder offers a '30d' default range that the edge HMI does not know: rangeMs lookup falls back to 6h.

**What the user sees.** On the edge HMI, the trend chart's 1h/6h/24h/7d buttons never show past data, only nothing or live points. In the cloud, changing 'Retention Period (days)' or 'Sampling Interval' has no effect.

**Root cause.** Inconsistent time units across the edge trend store, query and HMI. Two unlinked trend tag lists (package and widget). The cloud DAQ was built independently of the package trend contract.

**Fix direction.** Use one time unit end to end (ms) with a typed TrendPoint contract shared with the HMI. Derive recorded tags from the union of trendConfig.tags and every TrendChart widget's tags at deploy. Either have the cloud DAQ honour the package trendConfig or remove those fields from the builder.

**Evidence (canonical citations).**

- `sens-api-gateway/src/trend_engine.rs:89`
- `sens-api-gateway/static/scada-edge.html:937-946`
- `sens-api-gateway/src/scada_db.rs:317-327`
- `sens-api-gateway/src/scada_server.rs:478-492`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/TrendChartConfig.tsx:18-33`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesTrendsTab.tsx:53-75`
- `apps/sensor-service/src/scada-runtime/services/daq-storage.service.ts:143-163`
- `apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:125-127`
- `sens-api-gateway/src/trend_engine.rs:85-101`
- `sens-api-gateway/static/scada-edge.html:940-946`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/trendChartUtils.ts:22`
- `sens-api-gateway/static/scada-edge.html:941`
- `sens-api-gateway/static/scada-edge.html:1584-1585`
- `sens-api-gateway/static/scada-edge.html:939-947`
- `sens-api-gateway/src/trend_engine.rs:85-99`
- `sens-api-gateway/src/scada_db.rs:317-325`
- `sens-api-gateway/src/scada_server.rs:1822-1849`
- `web/modules/sensor-module/src/store/scada/types.ts:548-552`
- `sens-api-gateway/static/scada-edge.html:945`
- `sens-api-gateway/src/scada_server.rs:478-490`

<details><summary>Merged audit findings and full evidence</summary>

- **SET-09** (SET; verdict CONFIRMED; severity HIGH): Edge trend history always comes back empty (ms vs s), only the Trends-tab tags are recorded, and the cloud ignores trendConfig
  - sens-api-gateway/src/trend_engine.rs:89 (Utc::now().timestamp_millis()), 85-101 (records only config.tags)
  - sens-api-gateway/static/scada-edge.html:937-946 (requestTrend from/to = Math.floor(ms/1000)), 958-963 (p.timestamp \* 1000)
  - sens-api-gateway/src/scada_db.rs:317-327 (WHERE timestamp BETWEEN ?2 AND ?3)
  - sens-api-gateway/src/scada_server.rs:478-492 (TrendConfig from package.trend_config.tags only), 1822-1848 (query passes from/to unchanged)
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/TrendChartConfig.tsx:18-33 (widget config.tags, separate list)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesTrendsTab.tsx:53-75 (package trendConfig)
  - grep trendConfig\|retentionDays\|sampleIntervalSec in apps/sensor-service/src: no reader (only daq-storage env retention at daq-storage.service.ts:143-163)
  - apps/sensor-service/src/scada-runtime/services/tag-value-fanout.service.ts:125-127 (records all mapped values regardless of trendConfig)
  - (verifier) sens-api-gateway/src/trend_engine.rs:85-101 records only config.tags, timestamp_millis(); 136-143 query passes from/to unchanged
  - (verifier) sens-api-gateway/static/scada-edge.html:940-946 from/to = Math.floor(ms/1000); 958-963 p.timestamp \* 1000
  - (verifier) sens-api-gateway/src/scada_db.rs:317-327 WHERE timestamp BETWEEN ?2 AND ?3; 367-372 cleanup cutoff in ms
  - (verifier) sens-api-gateway/src/scada_server.rs:478-492 TrendConfig tags from package.trend_config.tags only; 1822-1848 handle_request_trend
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/TrendChartConfig.tsx:18-33 widget config.tags (separate list)
  - (verifier) grep trendConfig\|retentionDays\|sampleIntervalSec in apps/sensor-service/src: only daq-storage env retention (daq-storage.service.ts:143-163)
  - (verifier) widget-renderers/trendChartUtils.ts:22 presets include '30d'; scada-edge.html:941 rangeMs lacks '30d'
  - Verifier: The edge stores ms and queries with a seconds window, so the BETWEEN can never match. The widget's own tags are never recorded. The cloud ignores trendConfig. Edge trend history fails outright, so HIGH stays.
- **DEP-04** (DEP; verdict CONFIRMED; severity HIGH): Edge trend charts are permanently empty
  - Claim: Three independent breaks: (a) The HMI never re-renders on trend data. scheduledTrendUpdate calls itself inside requestAnimationFrame instead of calling setTrendTick, and setTrendTick has no caller. tick stays 0, so TrendChartWidget's history-merge and live-append effects run only on mount (and on a range click). (b) Units mismatch. The agent stores trend timestamps with timestamp_millis(), but the HMI sends from/to in epoch SECONDS and multiplies returned timestamps by 1000. query_trend's BETWEEN therefore never matches. (c) The agent records only package-level trendConfig.tags (Trends tab, default []) and returns early when that list is empty. The trendChart widget's own config.tags are never added to recording.
  - sens-api-gateway/static/scada-edge.html:1584-1585 (trendTick state), 1598-1607 (scheduledTrendUpdate recursion, no setState), 1793 (tick passed down); grep setTrendTick → declaration only
  - sens-api-gateway/static/scada-edge.html:939-947 (from/to = ms/1000), 962 (p.timestamp\*1000), 973-985 (live append keyed on [props.tick])
  - sens-api-gateway/src/trend_engine.rs:85-99 (empty tags → return; only config.tags), 89 (timestamp_millis)
  - sens-api-gateway/src/scada_db.rs:317-325 (WHERE timestamp BETWEEN ?2 AND ?3)
  - sens-api-gateway/src/scada_server.rs:1822-1849 (from/to passed through unchanged)
  - web/modules/sensor-module/src/store/scada/types.ts:548-552 (DEFAULT_TREND_CONFIG.tags = [])
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/TrendChartConfig.tsx:18-33 (writes widget config.tags only)
  - (verifier) sens-api-gateway/static/scada-edge.html:1584-1585 (trendTick state), 1598-1607 (scheduledTrendUpdate recurses into itself, never calls setTrendTick); grep setTrendTick → declaration only; 1793 (tick: trendTick passed down)
  - (verifier) sens-api-gateway/static/scada-edge.html:939-947 (history fetch only on [range]), 949-971 (merge on [props.tick, range]), 973-985 (live append on [props.tick]); WidgetRouter 1380-1400 uses stable component identities, so no remount re-runs effects
  - (verifier) sens-api-gateway/static/scada-edge.html:945 (from/to = ms/1000), 962 (timestamp\*1000)
  - (verifier) sens-api-gateway/src/trend_engine.rs:85-99 (empty config.tags → return; ts = timestamp_millis), 136-143 (query passes from/to through)
  - (verifier) sens-api-gateway/src/scada_db.rs:317-325 (BETWEEN ?2 AND ?3 on ms column); scada_server.rs:1822-1849 (no unit conversion)
  - (verifier) sens-api-gateway/src/scada_server.rs:478-490 (trend engine gets only package.trend_config.tags)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/TrendChartConfig.tsx:18-33 (writes widget config.tags only); grep trendConfig in libs/sensor-contracts + sensor-service: no derivation from widgets
  - Verifier: All three independent breaks are verified. The App re-renders on every frame, but the widget's effects depend only on tick (constant 0) and range, so data never enters chartData after mount. I found no unit conversion anywhere between the HMI and SQLite. Sibling SET-09 covers (b) and (c); (a), the render scheduler, is additional.

</details>

### SENSOR-HIGH-334

**Control security is not enforced: no PIN can be set and hash formats disagree, widget role permissions are client-only with a self-selected operator role, the edge PIN accepts anything, and editors do not gate by role**

- Severity: HIGH · Domain: SENSOR · Plan phase: F6 · Deadline: 2027-04-19
- Verification: CONFIRMED 2, PARTIAL 3
- Rule: ISA-18.2 alarm semantics, trends and server-enforced control security are identical across runtimes

**Claim.** Holds, with additions. (1) On the edge HMI, per-widget security='pin' is cosmetic. PinDialog calls onSuccess(pin), and the widget's doSend discards the PIN and sends a plain command. The server then applies only package-level securityLevels, so any PIN 'works'. (2) A tag added under Control → 'PIN Required' gets a server pinRequest, but pin_hash is always None because nothing in the builder writes pinHash or config.pin. The server answers 'PIN authentication not configured', so that tag becomes permanently uncommandable on the device. (3) Unlisted tags default to Confirm on the server, so a widget set to 'confirm' gets two confirmation dialogs. Overlaps LIFE-10.

**What the user sees.** Choosing 'PIN Required' or 'Confirmation Required' on a toggle has no effect in the browser. Nowhere in the builder lets the user enter the PIN. Tags typed into Control → 'PIN Required' are enforced on the device but not by the cloud gateway, which expects widget IDs.

**Root cause.** Three places own security semantics (widget config, controlPermissions, backend and edge enforcement) and they have no shared schema.

**Fix direction.** Define one control-security model in the contract: per-widget level plus a package PIN set through a write-only field that is hashed at the save boundary. Make the backend and edge key by the same identity (tagRef). Map widget security to securityLevels at save, or drop the per-widget select. Add a PIN entry to the Control tab.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ToggleSwitchConfig.tsx:55-68`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SliderConfig.tsx:74-85`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/NumericInputConfig.tsx:74-85`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/PushButtonConfig.tsx:57-68`
- `sens-api-gateway/static/scada-edge.html:815,847,896,1311`
- `apps/sensor-service/src/process/services/scada-package.service.ts:375-401`
- `sens-api-gateway/src/scada_server.rs:747-758`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:86-118`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/ToggleSwitchConfig.tsx:57-68`
- `apps/sensor-service/src/process/services/scada-package.service.ts:384-410`
- `sens-api-gateway/static/scada-edge.html:815-820`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:83-118`
- `web/modules/sensor-module/src/store/scada/types.ts:112,544`
- `web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:86-110`
- `apps/sensor-service/src/process/services/scada-package.service.ts:313-339`
- `apps/sensor-service/src/process/services/scada-package.service.ts:386-401`
- `apps/sensor-service/src/process/services/pin-hash.util.ts:13-32`
- `sens-api-gateway/src/scada_server.rs:810-834`
- `apps/sensor-service/src/process/services/scada-package.service.ts:313-339,386-405`
- `apps/sensor-service/src/process/services/pin-hash.util.ts:13-33`
- `sens-api-gateway/src/scada_types.rs:188-197`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/WidgetPermissionsSection.tsx:38-43`
- `web/modules/sensor-module/src/components/scada-operator/OperatorHeader.tsx:55`
- `web/modules/sensor-module/src/store/scada/operatorSlice.ts:76`
- `web/modules/sensor-module/src/hooks/useOperatorPermission.ts:38-63`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:429-530`
- `web/modules/sensor-module/src/hooks/useOperatorPermission.ts:41-74`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx:192-193`
- `sens-api-gateway/static/scada-edge.html:852-854`
- `sens-api-gateway/static/scada-edge.html:1753-1755`
- `sens-api-gateway/static/scada-edge.html:814-819`
- `sens-api-gateway/static/scada-edge.html:1752-1755`
- `sens-api-gateway/src/scada_server.rs:747-760`
- `apps/sensor-service/src/process/resolvers/process.resolver.ts:326-328`
- `apps/sensor-service/src/app.module.ts:520-526`
- `libs/backend-common/src/guards/roles.guard.ts:88-96`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-291`
- `web/modules/sensor-module/src/pages/scada/ScadaBuilderToolbar.tsx:294-305`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:241-246`
- `web/modules/sensor-module/src/pages/DevicesPage.tsx:367`
- `web/modules/sensor-module/src/pages/commands/CommandLogRoute.tsx:22`
- `web/shell/src/console/nav/pageAccess.ts:32`
- `web/shell/src/console/nav/pages/sensor.ts:46-51,60-80`
- `apps/sensor-service/src/process/resolvers/process.resolver.ts:100-101,126-127`
- `apps/sensor-service/src/app.module.ts:518-522`
- `libs/backend-common/src/guards/roles.guard.ts:66-96`
- `libs/backend-common/src/decorators/roles.decorator.ts:82-95`
- `web/shared-ui/src/utils/api-client.ts:869-897`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:283-287`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:665-667`
- `web/shell/src/App.tsx:142-144`
- `web/shell/src/console/nav/pageAccess.ts:26-39`
- `web/shell/src/console/nav/pages/sensor.ts:46-80`
- `web/modules/sensor-module/src/pages/DevicesPage.tsx:366-367`

<details><summary>Merged audit findings and full evidence</summary>

- **SEC-01** (OPS; verdict CONFIRMED; severity HIGH): Control security cannot be configured: the per-widget 'Security Level' is dead in browser and backend, no PIN can be set, and the Control tab lists mean different things to backend and edge
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/ToggleSwitchConfig.tsx:55-68 (also SliderConfig.tsx:74-85, NumericInputConfig.tsx:74-85, PushButtonConfig.tsx:57-68)
  - grep: config.security has no reader in web/modules/sensor-module/src outside widget-configs; only scada-edge.html:815,847,896,1311
  - apps/sensor-service/src/process/services/scada-package.service.ts:375-401 (securityLevels.pin as widget IDs, requirePin, pin)
  - sens-api-gateway/src/scada_server.rs:747-758 (security_levels lists matched against tag names)
  - web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:86-118 (placeholder 'tag.name'), 125-176 (no PIN field)
  - grep: no writer of pinHash or config.pin in web/modules/sensor-module/src
  - (verifier) widget-configs/ToggleSwitchConfig.tsx:57-68 (+ Slider/NumericInput/PushButton) write config.security; grep shows no browser or backend reader
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:384-410 (securityLevels.pin treated as widget ids, requirePin, pin)
  - (verifier) sens-api-gateway/src/scada_server.rs:747-758 (security_levels matched against tag names; default Confirm), 1424-1478 (Confirm/Pin flows), 1646-1668 (pin_hash None → 'PIN authentication not configured')
  - (verifier) sens-api-gateway/static/scada-edge.html:815-820, 1745-1755 (onPin → onSuccess(pin); doSend ignores pin)
  - (verifier) components/scada-builder/PropertiesControlTab.tsx:83-118 (placeholder 'tag.name', no PIN input); grep: pinHash appears only in types/defaults (store/scada/types.ts:112,544)
  - Verifier: I read all three enforcement points (browser, backend, Rust and HMI). They key differently, and none can obtain a PIN from the builder.
- **LIFE-10** (LIFE; verdict PARTIAL; severity MEDIUM): 'PIN Required' control security cannot work: no way to set a PIN, contradictory meaning of securityLevels.pin, incompatible hash formats
  - Claim: Parts (a) and (b) duplicate OPS SEC-01. No builder field writes controlPermissions.pinHash or config.pin. The Control tab lists TAG names, which the edge matches as tags, while the cloud getPinProtectedTagKeys treats securityLevels.pin entries as WIDGET ids, so tags typed there are not PIN-protected in the cloud. Part (c) is new and confirmed: cloud hashes are 'scrypt$salt$hash', and the edge verify_pin accepts only '$argon2id$' or hex SHA-256 (the camelCase pinHash does reach the edge struct), so a cloud-set PIN can never verify on the edge. Corrected symptom: 'random UUIDs appear in my PIN list after save' requires a plaintext widget config.pin, which no builder UI can write, so it happens only for legacy rows.
  - web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:86-110 (levels list tag names, placeholder 'tag.name')
  - grep pinHash/config.pin writers in components/scada-builder: none
  - apps/sensor-service/src/process/services/scada-package.service.ts:313-339 (writes widget ids into securityLevels.pin; pinHash only from plaintext widget pin)
  - apps/sensor-service/src/process/services/scada-package.service.ts:386-401 (pin entries matched against widget.id)
  - sens-api-gateway/src/scada_server.rs:747-758 (pin entries matched against tag)
  - apps/sensor-service/src/process/services/pin-hash.util.ts:13-32 (scrypt$ format)
  - sens-api-gateway/src/scada_server.rs:810-834 (argon2id or sha256 only), 1646-1666 ('PIN authentication not configured' when null)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/PropertiesControlTab.tsx:86-110 (placeholder 'tag.name')
  - (verifier) grep pinHash/config.pin writers in components/scada-builder + pages/scada: none
  - (verifier) apps/sensor-service/src/process/services/scada-package.service.ts:313-339,386-405
  - (verifier) sens-api-gateway/src/scada_server.rs:747-758 (tag-name match; unknown tag -> Confirm)
  - (verifier) apps/sensor-service/src/process/services/pin-hash.util.ts:13-33 (scrypt$ format)
  - (verifier) sens-api-gateway/src/scada_server.rs:810-834 (argon2id or sha256 only)
  - (verifier) sens-api-gateway/src/scada_types.rs:188-197 (camelCase pinHash deserialized)
  - Verifier: All three contracts are mismatched as claimed. One symptom is not reachable from the builder. It blocks only PIN-protected controls, because unlisted tags default to Confirm on the edge, so it is regraded to MEDIUM.
- **SET-11** (SET; verdict CONFIRMED; severity HIGH): Widget role permissions are client-only, and the operator picks their own role from a header menu
  - Claim: Holds. The role menu (UserRoleMenu, mounted at OperatorHeader.tsx:433) lets anyone pick 'admin'. useOperatorPermission grants admin full access, and the server never checks per-widget permissions. Today the restrictions are already void, because the operator reads config.permission while the builder writes widget.permissions (META-01). The default 'viewer' role with no permission object is fully enabled, and consumers ignore requiresPin/requiresConfirm (OperatorView.tsx:193 destructures only visible/enabled).
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/WidgetPermissionsSection.tsx:38-43 (role list)
  - web/modules/sensor-module/src/components/scada-operator/OperatorHeader.tsx:55 (ALL_ROLES incl. 'admin'), 255-330 (UserRoleMenu → setCurrentUserRole)
  - web/modules/sensor-module/src/store/scada/operatorSlice.ts:76 (currentUserRole: 'viewer'); grep setCurrentUserRole: only OperatorHeader
  - web/modules/sensor-module/src/hooks/useOperatorPermission.ts:38-63 (gating on self-selected role; admin bypass)
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:429-530 (no widget-permission check in handleTagWrite)
  - (verifier) web/modules/sensor-module/src/components/scada-builder/widget-configs/WidgetPermissionsSection.tsx:38-43 role list
  - (verifier) components/scada-operator/OperatorHeader.tsx:55 ALL_ROLES includes 'admin'; 255-330 UserRoleMenu → setCurrentUserRole; 433 mounted
  - (verifier) store/scada/operatorSlice.ts:76 currentUserRole 'viewer'; grep setCurrentUserRole: only OperatorHeader
  - (verifier) hooks/useOperatorPermission.ts:41-74 gating on self-selected role, admin bypass
  - (verifier) components/scada-operator/OperatorView.tsx:192-193 reads config.permission and uses only visible/enabled
  - (verifier) apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:429-530 handleTagWrite has no widget-permission check
  - Verifier: No code derives currentUserRole from the session or JWT, and the server has no per-widget enforcement. The permission model is cosmetic and self-elevatable, which is a security defect that holds independently of META-01.
- **DEP-16** (DEP; verdict PARTIAL; severity MEDIUM): The edge HMI's widget-level 'PIN Required' accepts any PIN
  - Claim: For config.security === 'pin', the toggle, numeric input, slider and push-button widgets open the PinDialog and send {type:'command', tag, value} on submit. The typed PIN is never verified or transmitted. Any PIN of at least 4 digits passes. An empty PIN does not, because PinDialog enables submit only when pin.length >= 4. The agent then applies only its own securityLevels lookup: default Confirm, which is broken by DEP-01, or direct execution for tags listed under 'No Security'.
  - sens-api-gateway/static/scada-edge.html:852-854 (toggle: onPin → onSuccess sends command), 818-819 (numeric input same)
  - sens-api-gateway/static/scada-edge.html:1753-1755 (handlePinSubmit → showPin.onSuccess(pin) → argument unused)
  - (verifier) sens-api-gateway/static/scada-edge.html:814-819 (numeric input), 847-856 (toggle), 895 (slider), 1307 (push button): onPin({onSuccess: send command}) without the PIN
  - (verifier) sens-api-gateway/static/scada-edge.html:1752-1755 (handlePinSubmit → onSuccess(pin); argument unused), 1512 & 1533 (submit requires pin.length >= 4)
  - (verifier) sens-api-gateway/src/scada_server.rs:747-760 (agent gate is by package securityLevels, not by widget config.security)
  - Verifier: The UI-only PIN is verified. The 'even an empty PIN' detail is refuted by the 4-digit minimum. Today the command lacks a tag anyway (EDGE-01), which masks the bypass. It is adjacent to SEC-01 and LIFE-10 but distinct: client-side theatre on the edge.
- **PERM-01** (JOUR; verdict PARTIAL; severity MEDIUM): No role gating in the SCADA editors: MODULE_USER can design for hours and every Save/Deploy is rejected with a generic 'Save failed'; MODULE_MANAGER sees a Delete that the backend always refuses, and nothing happens
  - Claim: The FE has no role gating on the SCADA, process or automation entries or editors, and the backend enforces TENANT_ADMIN or MODULE_MANAGER for create, update and deploy, and TENANT_ADMIN only for delete. A MODULE_USER can therefore design but never save or deploy. In the builder the Forbidden error becomes 'Save failed. Please try again.' In the unified editor the raw server text 'Access denied' does appear in the error chip: handleSave sets error.message, and the process leg returns result.message. A MODULE_MANAGER's Delete fails silently, which is the defect already reported as LIFE-17. The generic builder message is LIFE-11. The net new defect is the missing client-side capability gating. It affects only non-admin roles, not a tenant admin building the plant.
  - apps/sensor-service/src/process/resolvers/process.resolver.ts:326-328 (createScadaPackage), :337-339 (update), :363-365 (deleteScadaPackage TENANT_ADMIN only), :387-389 (deployScadaPackageToEdge), :439-441 (deployScadaWithAutomation)
  - apps/sensor-service/src/app.module.ts:520-526 (RolesGuard as APP_GUARD); libs/backend-common/src/guards/roles.guard.ts:88-96 (ForbiddenException 'Access denied')
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:252-291 (no role check; catch → 'Save failed. Please try again.' at :284-287), ScadaBuilderToolbar.tsx:294-305 (Save enabled for everyone)
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:241-246 (Delete shown to all), :104-109 (catch → console.error only)
  - Pattern exists but unused here: pages/DevicesPage.tsx:367 (hasAnyRole), pages/commands/CommandLogRoute.tsx:22 (RequireRole); web/shell/src/console/nav/pageAccess.ts:32 (requiredRoles honoured) vs nav/pages/sensor.ts:46-51,60-80 (no requiredRoles)
  - (verifier) process.resolver.ts:100-101,126-127 (process create/update), :326-327, :337-338, :363-364 (deleteScadaPackage TENANT_ADMIN), :387-388, :439-440
  - (verifier) app.module.ts:518-522 (RolesGuard APP_GUARD); roles.guard.ts:66-96 (ForbiddenException 'Access denied'); roles.decorator.ts:82-95 (hierarchy: MODULE_MANAGER does not include TENANT_ADMIN)
  - (verifier) shared-ui api-client.ts:869-897 ('Access denied' is not a session-auth message, so it throws GraphQLClientError without a global toast)
  - (verifier) ScadaPackageBuilderPage.tsx:283-287 (catch → 'Save failed. Please try again.'); UnifiedEditorPage.tsx:665-667 (catch → error.message shown at :955-962)
  - (verifier) ScadaPackageListPage.tsx:241-246 (Delete for all), :104-109 (console.error only)
  - (verifier) web/shell/src/App.tsx:142-144 (ProtectedRoute requiredModule='sensor' only); pageAccess.ts:26-39; sensor.ts:46-80 (no requiredRoles on automation/scada/processes); DevicesPage.tsx:366-367 and CommandLogRoute.tsx:22 show that the gating pattern exists
  - Verifier: The core claim holds: no FE role check, and the server rejects. The claim overstates the error mapping, though: the unified editor shows 'Access denied'. The Delete silence and the generic message duplicate LIFE-17 and LIFE-11. The impact on the stated user's end-to-end journey depends on their role; a tenant admin is unaffected. So MEDIUM, not HIGH.

</details>

### SENSOR-MEDIUM-333

**Cloud alarm evaluation, persistence and timer scripts run only while an operator view is open; alarm notifications cannot be configured and never send; active alarms are not restored after restart**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F6 · Deadline: 2027-04-19
- Verification: CONFIRMED 1, SELF 1
- Rule: ISA-18.2 alarm semantics, trends and server-enforced control security are identical across runtimes

**Claim.** The only way a tenant's cloud alarm engine and scheduler get rules is the first /scada socket connecting (SCADA_TENANT_OPERATOR_CONNECTED). With no socket connected, the tenant is evicted after 15 minutes. From then on no alarm rule is evaluated, nothing is written to scada_alarms or scada_alarm_chronicle, and no server script runs until a browser connects again. Nothing loads published packages at boot or on a schedule. This is the documented ADR-045 D4 trade-off. Its effect is that the cloud 'alarm system' only covers periods when someone is watching: alarm history has silent gaps, and any notification or timer-script feature built on it can never fire unattended.

**What the user sees.** An excursion that happens overnight, while no operator page is open, leaves no cloud alarm record. When the user opens the operator view in the morning, only conditions that are still true appear, as brand-new alarms.

**Root cause.** The cloud runtime was scoped as a per-viewer session for memory reasons, not as a continuously running alarm authority, and nothing in the product says which runtime (edge or cloud) is the 24/7 alarm owner.

**Fix direction.** Decide on a single alarm authority. Either have the edge alarm engine (which runs continuously) report alarms to the cloud as events, so the cloud only stores and displays them, or run cloud evaluation for every tenant with a deployed package, independent of viewers. Remove the duplicate cloud evaluation if the edge is the owner.

**Evidence (canonical citations).**

- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:9-18`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:99-105`
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:249-253`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:320-334`
- `web/modules/sensor-module/src/store/scada/notificationSlice.ts:15-61`
- `web/modules/sensor-module/src/store/scada/projectSlice.ts:224-281`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:186-188`
- `apps/sensor-service/src/scada-runtime/services/notification.service.ts:104-105`
- `web/modules/sensor-module/src/store/scada/createScadaStore.ts:41`
- `apps/sensor-service/src/scada-runtime/services/alarm-storage.service.ts:332,463`

<details><summary>Merged audit findings and full evidence</summary>

- **SET-V-01** (SET-verifier; verdict SELF; severity MEDIUM): Cloud alarm evaluation, alarm persistence and timer scripts exist only while someone has an operator or Preview tab open
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:9-18 (lazy activation and eviction by design)
  - scada-activation.service.ts:99-105 (activation only on operator connect), 207-218 (evict when no connected operator for 15 min), 50 IDLE_EVICTION_MS
  - apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:249-253 (CONNECTED emitted on the first socket only)
  - grep activateTenant\|setAlarmRules( in apps/sensor-service/src: only scada-activation.service.ts (no boot or cron loader)
  - alarm-engine.service.ts:320-334 (evaluation iterates only active tenants' rules)
- **SET-14** (SET; verdict CONFIRMED; severity LOW): Alarm email/webhook notifications cannot be configured and never send; active alarms are not restored after a restart; chronicle retention never runs
  - Claim: Holds. cleanupHistory (alarm-storage.service.ts:463-480) would purge scada_alarm_chronicle, but it has no caller. AlarmStorageService.getActiveAlarms has no caller, so the in-memory state is never restored. A still-true condition after restart creates a fresh instance (randomUUID at alarm-engine.service.ts:418).
  - web/modules/sensor-module/src/store/scada/notificationSlice.ts:15-61; grep addNotification\|s.notifications: no consumer
  - web/modules/sensor-module/src/store/scada/projectSlice.ts:224-281 (no notifications in JSON)
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:186-188 (setNotificationConfigs(tenantId, []))
  - apps/sensor-service/src/scada-runtime/services/notification.service.ts:104-105 (early return)
  - grep 'storage.getActiveAlarms\|cleanupHistory(' in apps/sensor-service/src: no callers
  - (verifier) web/modules/sensor-module/src/store/scada/notificationSlice.ts:15-61; only createScadaStore.ts:41 composes it; no UI consumer
  - (verifier) store/scada/projectSlice.ts:224-281 toScadaPackageJSON has no notifications
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:186-188 setNotificationConfigs(tenantId, [])
  - (verifier) services/notification.service.ts:104-105 early return on empty configs
  - (verifier) grep 'storage.getActiveAlarms\|cleanupHistory(' in apps/sensor-service/src: only definitions (alarm-storage.service.ts:332,463)
  - Verifier: Every seam was read. The UI does not promise notifications, so LOW is the right grade.

</details>

### SENSOR-MEDIUM-335

**Scheduler widget entries (day, hour range, tag, value) are never executed anywhere**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F6 · Deadline: 2027-04-19
- Verification: CONFIRMED 1
- Rule: ISA-18.2 alarm semantics, trends and server-enforced control security are identical across runtimes

**Claim.** Holds as stated.

**What the user sees.** The user schedules 'Aerator ON Mon 08-10'. It shows on the timeline but never switches anything, and adding the widget blocks edge deploy.

**Root cause.** This is a display-only mock of a control feature.

**Fix direction.** Compile scheduler entries into the backend or edge scheduler at activation and deploy, as cron jobs writing the tag. Otherwise relabel the widget as display-only and remove the tag fields.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SchedulerConfig.tsx:4-13,56-75`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/SchedulerRenderer.tsx:19-22`
- `apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:189`
- `libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:58`
- `web/modules/sensor-module/src/components/scada-builder/widget-configs/SchedulerConfig.tsx`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/SchedulerRenderer.tsx`

<details><summary>Merged audit findings and full evidence</summary>

- **SCHED-01** (OPS; verdict CONFIRMED; severity MEDIUM): Scheduler widget entries (day, hour range, tagName, tagValue) are never executed anywhere
  - web/modules/sensor-module/src/components/scada-builder/widget-configs/SchedulerConfig.tsx:4-13,56-75
  - web/modules/sensor-module/src/components/scada-builder/widget-renderers/SchedulerRenderer.tsx:19-22
  - apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:189 (scheduler.loadScripts only)
  - libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts:58 (scheduler rejected)
  - grep: 'startHour' has no reader outside SchedulerConfig/SchedulerRenderer
  - (verifier) widget-configs/SchedulerConfig.tsx (entries with tagName/tagValue)
  - (verifier) grep across apps/, libs/, sens-api-gateway/src and the sensor-module: startHour/endHour are read only in SchedulerConfig.tsx and SchedulerRenderer.tsx (other hits are hr-service)
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-activation.service.ts:189 (scheduler.loadScripts(scripts) only)
  - Verifier: The widget is display-only, and adding it blocks the deploy.

</details>

### EDGE-MEDIUM-087

**Edge schedule triggers evaluate cron fields in UTC with no site time zone, so local-time schedules fire offset by the UTC difference**

- Severity: MEDIUM · Domain: EDGE · Plan phase: F6 · Deadline: 2027-04-19
- Verification: SELF 1; re-checked in session
- Rule: ISA-18.2 alarm semantics, trends and server-enforced control security are identical across runtimes

**Claim.** check_schedule_static matches the cron minute/hour/day/month fields against Utc::now(); there is no time-zone setting on the trigger, the device or the site, so a schedule written as local time fires offset by the UTC difference (three hours early-or-late in Turkey).

**What the user sees.** A pump or light scheduled for 06:00 runs at 09:00 local time.

**Root cause.** Schedules carry no time-zone identity.

**Fix direction.** Store an IANA time zone per site/device, evaluate schedules in that zone (DST-aware), and show the zone in every schedule editor.

**Evidence (canonical citations).**

- `sens-api-gateway/src/scripting/triggers.rs:9`
- `sens-api-gateway/src/scripting/triggers.rs:239`
- `sens-api-gateway/src/scripting/triggers.rs:257-260`

<details><summary>Merged audit findings and full evidence</summary>

- **TZ-01** (session; verdict SELF; severity MEDIUM): Edge schedule triggers evaluate cron fields in UTC with no site time zone
  - sens-api-gateway/src/scripting/triggers.rs:9 (use chrono::Utc)
  - sens-api-gateway/src/scripting/triggers.rs:239 (let now = Utc::now())
  - sens-api-gateway/src/scripting/triggers.rs:257-260 (cron fields matched against now.minute/hour/day/month)

</details>

## I. Journey and test confidence

### SENSOR-HIGH-337

**Tests give false confidence across the SCADA path: no page-level or E2E coverage, round-trip and cross-runtime tests replace the real seam with stand-ins, contract fixtures are hand-written, and a gate claims behaviour it does not test**

- Severity: HIGH · Domain: SENSOR · Plan phase: F0 · Deadline: 2026-11-02
- Verification: CONFIRMED 1, PARTIAL 2, SELF 2
- Severity note: Raised from MEDIUM: every CRITICAL finding in this audit shipped with a green suite.
- Rule: A test is a gate only if it exercises the production seams (CLAUDE.md Test Rules)

**Claim.** The facts hold. No test renders ScadaPackageBuilderPage, ScadaPackageListPage, ScadaOperatorPage, OperatorShell, OperatorBootstrap, SimulationSidebar, AutomationBindingPanel or SensorScadaPage; OperatorView appears only in a comment of the parity spec. Playwright defines only a 'security' project, no e2e spec mentions SCADA, and SENSOR-HIGH-006 is RESOLVED while its notes list the Playwright smoke as still open. The backend does have service-level unit specs for scada-package (create/update/backfill/delete), but no contract or E2E test spans the builder doc, the backend and the operator/edge render. The auditor's scratch JSON shows 1253 passed and 0 failed, with 2 suites failing to import. This is a process gap with no direct user-visible defect, so it is graded MEDIUM. It explains why BLOCKERs ship green.

**What the user sees.** CI is green on every PR, yet nobody has ever built a package, saved, reloaded, opened the operator view and deployed in a browser, so regressions in exactly that flow ship unnoticed.

**Root cause.** The tests were written per component and per store slice. The end-to-end contract (builder doc → backend → operator/edge render) was never made an executable gate, and the finding that required it was closed without it.

**Fix direction.** For the rewrite, start with one Playwright journey against a seeded tenant: create package, bind a tag, save, reload, open the operator view and see the widget (not '?'), deploy, and see the device acknowledge with a fake agent. Make it a required check. Reopen SENSOR-HIGH-006.

**Evidence (canonical citations).**

- `e2e/playwright.config.ts:17-40`
- `web/modules/sensor-module/src/engine/tags/__tests__/builder-operator-parity.spec.tsx:11-15`
- `web/modules/sensor-module/src/engine/tags/__tests__/builder-operator-parity.spec.tsx`
- `web/modules/sensor-module/src/engine/tags/__tests__/builder-operator-parity.spec.tsx:33-44`
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx`
- `web/modules/sensor-module/src/store/scada/__tests__/scadaStore.test.ts:556-627`
- `web/modules/sensor-module/src/store/scada/historySlice.ts:292`
- `web/modules/sensor-module/src/store/scada/__tests__/scadaPackageRoundtrip.test.ts:51-58`
- `apps/sensor-service/src/process/services/scada-package.service.ts:492`
- `web/modules/sensor-module/src/pages/unified/__tests__/UnifiedEditorPage.deploy.test.tsx:93-98`
- `web/modules/sensor-module/src/components/scada-builder/__tests__/phase9e-platform.test.tsx:27-31,47-85`
- `web/modules/sensor-module/src/store/scada/__tests__/scadaStore.test.ts`
- `apps/sensor-service/src/process/services/scada-package.service.ts:442,492`
- `web/modules/sensor-module/src/components/scada-builder/__tests__/phase9e-platform.test.tsx:27-31`
- `sens-api-gateway/src/contract_fixtures_tests.rs:226-277`
- `sens-api-gateway/tests/invariants/two_person_integrity_gate.rs:136-157`
- `sens-api-gateway/src/commands/mod.rs:39`
- `tools/gates/sens-enterprise-validation.ts:1071-1111`
- `sens-api-gateway/src/commands/io_config.rs`
- `sens-api-gateway/src/main.rs`
- `tools/gates/sens-enterprise-claims.json`
- `sens-api-gateway/src/commands/io_config.rs:510-523`
- `apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts`
- `sens-api-gateway/src/contract_fixtures_tests.rs:31-36`
- `libs/sensor-contracts/src/__tests__/contract-fixtures.spec.ts:36`
- `libs/sensor-contracts/fixtures/deploy-scada-package.json`
- `crates/alarm-core/src/lib.rs:82-92`
- `apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:41-63`
- `.github/workflows/sens-api-gateway-ci.yml:285`

<details><summary>Merged audit findings and full evidence</summary>

- **TEST-01** (JOUR; verdict PARTIAL; severity MEDIUM): There is no page-level or E2E coverage of the SCADA journey, so a fully green suite coexists with BLOCKER defects
  - vitest run (scratch copy, reporter=json): 73 files, 1253 passed, 0 failed (2 VFD files failed to import only because the partial install omitted root devDependency @testing-library/user-event)
  - grep over web/modules/sensor-module/src test files: ScadaPackageBuilderPage, ScadaPackageListPage, ScadaOperatorPage, OperatorShell, OperatorBootstrap, AutomationBindingPanel, SimulationSidebar all have 0 referencing tests
  - e2e/playwright.config.ts:17-40 (testDir ./tests, only project 'security'); grep -ril scada e2e/tests → no matches; e2e/tests/modules/sensor/\*.spec.ts (data-channels, edge-device, sensor-crud, sensor-readings, sensor-types, vfd-device)
  - web/modules/sensor-module/src/engine/tags/**tests**/builder-operator-parity.spec.tsx:11-15 ('no browser UI e2e harness')
  - docs/reviews/\_registry/findings.jsonl:684 (SENSOR-HIGH-006 state RESOLVED; notes: 'STILL OPEN … add the Playwright smoke')
  - (verifier) grep over web/modules/sensor-module/src test files: 0 references for ScadaPackageBuilderPage/ScadaPackageListPage/ScadaOperatorPage/OperatorShell/OperatorBootstrap/AutomationBindingPanel/SimulationSidebar/SensorScadaPage; OperatorView only in engine/tags/**tests**/builder-operator-parity.spec.tsx (comment)
  - (verifier) pages/scada has no **tests** directory (ls)
  - (verifier) e2e/playwright.config.ts:17-40 (only project 'security'); grep -ril scada e2e/tests: none; e2e/tests/modules/sensor/: data-channels, edge-device, sensor-crud, sensor-readings, sensor-types, vfd-device
  - (verifier) builder-operator-parity.spec.tsx:11-15
  - (verifier) docs/reviews/\_registry/findings.jsonl:684 (state RESOLVED; notes 'STILL OPEN … add the Playwright smoke')
  - (verifier) apps/sensor-service/src/process/services/**tests**/scada-package-\*.spec.ts (unit, not E2E)
  - (verifier) scratchpad/vitest-scada.json: numPassedTests 1253, numFailedTests 0, numFailedTestSuites 2
  - Verifier: Every factual sub-claim survived my checks. The grading rule says to rank by user impact on a working end-to-end process. A missing test causes none by itself, so it is not HIGH.
- **TEST-02** (JOUR; verdict PARTIAL; severity MEDIUM): Tests that claim a cross-runtime or round-trip property replace the real seam with a stand-in, so they pass on the known-broken behaviour
  - Claim: All five sub-claims hold. (a) The parity spec renders a test-local Widget on DataProviderRoot type='simulation'. (b) The only undo tests call pushHistory directly, and pushHistory has no production caller. (c) The round-trip uses createScadaStore only. (d) The unified deploy test mocks ScreenManager, ScreenCanvas, StableModeProvider, DeployToEdgeDialog and the data hooks, and test (b) is titled 'useDeployScadaPackage' while the mock is useDeployScadaBundle. (e) phase9e tests unmounted panels, and ExportDialog only for labels. Graded MEDIUM: it is test-quality debt, not a runtime defect.
  - web/modules/sensor-module/src/engine/tags/**tests**/builder-operator-parity.spec.tsx:33-44 (test-local Widget), :63-70 (DataProviderRoot type='simulation'); reader in prod: components/scada-operator/OperatorView.tsx (registry lookup, OPS-01)
  - web/modules/sensor-module/src/store/scada/**tests**/scadaStore.test.ts:556-627 (pushHistory called by the test); writer side: store/scada/historySlice.ts:292 has no production caller (grep)
  - web/modules/sensor-module/src/store/scada/**tests**/scadaPackageRoundtrip.test.ts:51-58 (createScadaStore only); backend upcast at apps/sensor-service/src/process/services/scada-package.service.ts:492 not exercised
  - web/modules/sensor-module/src/pages/unified/**tests**/UnifiedEditorPage.deploy.test.tsx:93-98 (data hooks mocked), :125-141 (ScreenManager/ScreenCanvas/StableModeProvider stubs), :154-190 (deploy dialog stub), :268 (title says useDeployScadaPackage) vs :97 (mock is useDeployScadaBundle); routeParam.test.tsx:65-68
  - web/modules/sensor-module/src/components/scada-builder/**tests**/phase9e-platform.test.tsx:27-31,47-85 (unmounted panels; ExportDialog renders labels only)
  - (verifier) builder-operator-parity.spec.tsx:33-44 (local Widget), :63-70 (type='simulation')
  - (verifier) scadaStore.test.ts:556-627 (pushHistory called by tests); grep pushHistory outside tests: only historySlice.ts:292 and types.ts:353; grep '.undo()\|canUndo' in tests: only scadaStore.test.ts
  - (verifier) scadaPackageRoundtrip.test.ts:51-58 (createScadaStore); backend upcast at scada-package.service.ts:442,492 not exercised
  - (verifier) UnifiedEditorPage.deploy.test.tsx:93-98 (useScadaPackage mocked with useDeployScadaBundle at :97), :125-141, :154-190, :268 (title says useDeployScadaPackage)
  - (verifier) phase9e-platform.test.tsx:27-31 imports TagWatchPanel/RecipePanel/DaqConfigPanel; grep for <TagWatchPanel\|<RecipePanel\|<DaqConfigPanel outside tests: none; ExportDialog tests at :47-85 assert labels only
  - Verifier: I read each test and the production side of each seam. The claims are accurate. The severity is lowered because there is no direct user symptom.
- **XPORT-07** (AUTO/XPORT; verdict SELF; severity MEDIUM): Tests skip the broken transport seam
  - Claim: DeployBundleDispatcherService untested; Rust bundle tests call verify_bundle directly, never execute_command; TS fixture spec checks a hand-written fixture; command_acceptance.rs not live.
  - apps/sensor-service/src/release-bundle/**tests**
  - sens-api-gateway/src/contract_fixtures_tests.rs:226-277
  - sens-api-gateway/tests/invariants/two_person_integrity_gate.rs:136-157
  - sens-api-gateway/src/commands/mod.rs:39
- **IOP-08** (GAP1; verdict SELF; severity MEDIUM): A gate that claims 'I/O config strict schema and restart readback are behaviorally proven' checks for code that does not exist, and no claim ever runs it
  - Claim: tools/gates/sens-enterprise-validation.ts defines strict_io_config_restart_readback. It requires strings such as 'struct AgentIoConfigV2', '#[serde(deny_unknown_fields)]', 'hydrate_process_image_from_persisted_io_config', 'file.sync_all()', 'fsync_parent_dir(config_dir)', 'canonical_tag_configs(&persisted_value)?' and a Rust test that reads the golden fixture, plus 'persisted I/O config readback failed' in main.rs. None of these strings exist in io_config.rs or main.rs. The check would fail, but sens-enterprise-claims.json references it from no claim, so evaluateClaim never runs it and the CI job stays green. The intended design (strict v2 parser, atomic fsync'd persist, boot hydrate, cross-language golden fixture) was specified and never implemented. The live parser is lenient: legacy grouped arrays are still accepted, unknown fields are ignored, and in the legacy shape a missing pin or register defaults to 0 and a missing tag name becomes 'unknown'.
  - tools/gates/sens-enterprise-validation.ts:1071-1111 (check definition), 118 (IO_CONFIG path)
  - grep -cF of each required string: 0 hits in sens-api-gateway/src/commands/io_config.rs and src/main.rs (only 'schemaVersion' exists)
  - grep strict_io_config_restart_readback tools/gates/sens-enterprise-claims.json: 0
  - git log -S hydrate_process_image_from_persisted_io_config: only 395a6078, a bulk import (540 files, additions only)
  - sens-api-gateway/src/commands/io_config.rs:510-523 (v2 or bare tags[]), 527-575 and 577-660 (lenient legacy parsing with unwrap_or defaults)
  - apps/sensor-service/src/edge-device/**tests**/agent-io-config-v2.spec.ts (only the TS side uses the golden fixture)
- **DEP-20** (DEP; verdict CONFIRMED; severity LOW): TS and Rust do test the same fixture bytes, but the fixture is hand-written and the Rust side checks only struct fields, so the real failures pass CI
  - Claim: contract_fixtures_tests.rs reads ../libs/sensor-contracts/fixtures (the same files as contract-fixtures.spec.ts), so the bytes are shared. But deploy-scada-package.json is authored by hand, not produced by toScadaPackageJSON → upcast → transform. The Rust test asserts only meta, screen and widget counts, enum parsing, securityLevels and retentionDays. Nothing exercises scada-edge.html's config.tag reads (EDGE-01), the HMI's WS client messages (DEP-01), integer constraints (DEP-11), or alarm semantics. The fixture's alarm uses condition 'gt'. The cloud mapper accepts that alias, but the edge's alarm_core matches only symbols, so on the device the rule is permanently false. The gate stays green.
  - sens-api-gateway/src/contract_fixtures_tests.rs:31-36 (fixture path = ../libs/sensor-contracts/fixtures), 148-185 (assertions)
  - libs/sensor-contracts/src/**tests**/contract-fixtures.spec.ts:36, 91-105 (same directory; schema validation only)
  - libs/sensor-contracts/fixtures/deploy-scada-package.json (condition 'gt'; configs carry only tagRef/tagName)
  - crates/alarm-core/src/lib.rs:82-92 (only '<','>','<=','>=','==','!=')
  - apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:41-63 (cloud accepts 'gt' alias)
  - (verifier) sens-api-gateway/src/contract_fixtures_tests.rs:31-36 (../libs/sensor-contracts/fixtures), 146-185 (asserts counts, enums, securityLevels, retentionDays only)
  - (verifier) libs/sensor-contracts/fixtures/deploy-scada-package.json (alarm condition 'gt'; widget configs carry tagRef/tagName, never 'tag')
  - (verifier) crates/alarm-core/src/lib.rs:82-92 (only symbol operators; 'gt' → false)
  - (verifier) apps/sensor-service/src/scada-runtime/services/scada-package-alarm-rule.mapper.ts:41-63 (cloud accepts 'gt')
  - (verifier) .github/workflows/sens-api-gateway-ci.yml:285 (curated-features cargo test does run these, so the gate is live but green)
  - Verifier: Verified. The shared-bytes mechanism works, but the fixture is idealized and the consumer assertions are structural. This is a test gap that explains the green CI, not a user-facing defect, so LOW. The builder writes symbol conditions, so 'gt' affects only fixtures and imports.

</details>

### SENSOR-MEDIUM-336

**No coherent SCADA journey: /sensor lands on a deprecated viewer, the operator view has no entry point, empty-tenant links are dead, process activation always fails, and editor modes/zoom leak between processes**

- Severity: MEDIUM · Domain: SENSOR · Plan phase: F7 · Deadline: 2027-05-03
- Verification: CONFIRMED 5, SELF 2
- Rule: A test is a gate only if it exercises the production seams (CLAUDE.md Test Rules)

**Claim.** Holds, and is slightly worse than stated. Delete archives the row and save() bumps updatedAt, and the list is ordered updatedAt DESC with a server default of limit 20. A just-deleted process is therefore the FIRST row, and it is auto-selected on a fresh visit. The same broken hook also feeds ProcessListPage, so deleted processes stay in 'Proses şeması' too (see new finding JRN-08). Caveat: scadaViewerStore is a module singleton. If the user visited /sensor/dashboard earlier in the session, stale readings and lastUpdate from that page persist, but nothing on /sensor ever refreshes them.

**What the user sees.** I click 'Sensör panosu'. It shows a process diagram with a green, pulsing 'Canlı' badge, but no equipment ever shows a value and the clock stays at '-'. A process I deleted is still in the drop-down and is sometimes the one that opens.

**Root cause.** A retired viewer was left as the index route behind a default-on flag, without the data hook that fed it, and with an enum-case mismatch in its archived filter.

**Fix direction.** Point the index route at the real runtime (package list or operator view) and delete the legacy viewer and scadaViewerStore. If it stays, mount the readings feed and compare status case-insensitively, or better, use typed enums from the generated GraphQL types.

**Evidence (canonical citations).**

- `web/modules/sensor-module/src/Module.tsx:90-91`
- `web/shell/src/console/nav/pages/sensor.ts:22-27`
- `web/modules/sensor-module/src/config/featureFlags.ts:32-37`
- `web/modules/sensor-module/src/components/scada/ScadaViewer.tsx:111-116`
- `web/modules/sensor-module/src/hooks/useSensorReadings.ts:256,288`
- `web/modules/sensor-module/src/pages/SensorDashboardPage.tsx:87`
- `web/modules/sensor-module/src/pages/SensorScadaPage.tsx:103`
- `web/modules/sensor-module/src/store/scadaViewerStore.ts:110`
- `apps/sensor-service/src/process/entities/process.entity.ts:21-31`
- `web/modules/sensor-module/src/pages/SensorScadaPage.tsx:69`
- `web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:72`
- `web/modules/sensor-module/src/hooks/useProcess.ts:518-521`
- `web/modules/sensor-module/src/pages/SensorScadaPage.tsx:78-81`
- `apps/sensor-service/src/process/services/process.service.ts:252-263`
- `web/shell/src/console/nav/workspaces/ctl.ts:36`
- `web/modules/sensor-module/src/config/featureFlags.ts`
- `web/modules/sensor-module/public/scada-viewer-canvas.html:527-543`
- `web/modules/sensor-module/src/components/scada/SensorPanel.tsx:40`
- `web/shared-ui/src/generated/graphql-types.ts:15069-15073`
- `apps/sensor-service/src/process/services/process.service.ts:210-215`
- `web/modules/sensor-module/src/Module.tsx:153`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:26,221-248`
- `web/shell/src/console/nav/pages/sensor.ts:63-67`
- `web/shell/src/console/nav/pages/sensor.ts:60-68`
- `web/modules/sensor-module/src/pages/SensorDashboardPage.tsx:163`
- `web/modules/sensor-module/src/Module.tsx:109`
- `web/modules/sensor-module/src/pages/DeviceDetailPage.tsx:266,370-380`
- `web/modules/sensor-module/src/pages/DeviceDetailPage.tsx:421`
- `web/modules/sensor-module/src/Module.tsx:107-112`
- `web/modules/sensor-module/src/Module.tsx:181`
- `web/modules/sensor-module/src/Module.tsx:143-144`
- `web/modules/sensor-module/src/pages/SensorDashboardPage.tsx:162-168`
- `web/modules/sensor-module/src/pages/DeviceDetailPage.tsx:369-389`
- `web/modules/sensor-module/src/pages/DeviceDetailPage.tsx:416-421`
- `web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:141-162`
- `web/modules/sensor-module/src/hooks/useProcess.ts:6`
- `apps/sensor-service/src/process/dto/process.dto.ts:81-84`
- `web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:109-137`
- `web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:63`
- `web/modules/sensor-module/src/store/editorModeStore.ts:31-40`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:190-198`
- `web/modules/sensor-module/src/components/unified-editor/ScreenManager.tsx:63-92`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:380-395`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:153-159`
- `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:381-395`
- `web/modules/sensor-module/src/store/scada/sceneSlice.ts:153-160`
- `web/shared-ui/src/components/Layout/DesktopOnlyNotice.tsx:28-36`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:368,371`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx`
- `web/modules/sensor-module/src/pages/process/ProcessEditorPage.tsx:438,618`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:368`
- `web/modules/sensor-module/src/pages/unified/UnifiedEditorPage.tsx:1008`

<details><summary>Merged audit findings and full evidence</summary>

- **JRN-04** (JOUR; verdict CONFIRMED; severity MEDIUM): The 'Sensor dashboard' landing page (/sensor) is the deprecated P&ID iframe viewer: it shows a green pulsing 'Canlı' (Live) state but nothing on that page feeds values, and deleted (archived) processes are listed and auto-selected
  - web/modules/sensor-module/src/Module.tsx:90-91; web/shell/src/console/nav/pages/sensor.ts:22-27 ('Sensor dashboard' → /sensor)
  - web/modules/sensor-module/src/config/featureFlags.ts:32-37 (default true); grep VITE_SENSOR_LEGACY_SCADA_VIEWER: no workflow, compose, Dockerfile or bake setting
  - web/modules/sensor-module/src/components/scada/ScadaViewer.tsx:111-116 (reader: sendToCanvas('updateAllSensorData', sensorReadings))
  - web/modules/sensor-module/src/hooks/useSensorReadings.ts:256,288 (only writers) used only by pages/SensorDashboardPage.tsx:87, not by SensorScadaPage
  - web/modules/sensor-module/src/pages/SensorScadaPage.tsx:103 (lastUpdate '-'), :112-131 and :254-263 (Canlı/live indicators), store/scadaViewerStore.ts:110 (isLiveMode true)
  - apps/sensor-service/src/process/entities/process.entity.ts:21-31 (enum ARCHIVED='archived' registered → wire value 'ARCHIVED'); FE lower-cases it at SensorScadaPage.tsx:69 and ProcessListPage.tsx:72
  - web/modules/sensor-module/src/hooks/useProcess.ts:518-521 (filter compares to lowercase 'archived'); SensorScadaPage.tsx:78-81 (auto-select first); apps/sensor-service/src/process/services/process.service.ts:252-263 (delete = archive)
  - (verifier) Module.tsx:90-91 (index and scada → SensorScadaPage); sensor.ts:22-27; ctl.ts:36 (first entry of the SCADA area)
  - (verifier) featureFlags.ts:32-37 (default true); grep VITE_SENSOR_LEGACY_SCADA_VIEWER across repo (excl. node_modules): only featureFlags.ts and review docs, no .env\*, compose, workflow or Dockerfile
  - (verifier) ScadaViewer.tsx:111-116 (reader posts sensorReadings to the iframe); public/scada-viewer-canvas.html:527-543 (consumer has no fetch or socket of its own)
  - (verifier) useSensorReadings.ts:256,288 (only writers); only caller is SensorDashboardPage.tsx:87; SensorPanel.tsx:40 reads the same store
  - (verifier) SensorScadaPage.tsx:103 ('-'), :112-131 and :254-263 (Canlı + pulsing dot), scadaViewerStore.ts:110 (isLiveMode true)
  - (verifier) Wire value: process.entity.ts:21-31 registerEnumType; generated graphql-types.ts:15069-15073 ('ARCHIVED'); scratch graphql-js proof that serializing 'archived' yields 'ARCHIVED' (scratchpad/jrnproof/enum.cjs)
  - (verifier) useProcess.ts:518-521 (compares to lowercase 'archived'); SensorScadaPage.tsx:78-81 (auto-select first); process.service.ts:210-215 (order updatedAt DESC, limit 20), :252-263 (delete = archive via save)
  - Verifier: Both sides of the readings seam were read, the flag has no setter anywhere, and I proved the enum-case mismatch by executing graphql-js with the same enum shape. The page claims liveness that does not exist. It does not block the SCADA builder journey, so MEDIUM.
- **LIFE-22** (LIFE; verdict CONFIRMED; severity LOW): The operator view has no in-app entry point
  - Claim: Overlaps OPS DEAD-01 and OPS-01. /sensor/scada/operator/:packageId is routed, but nothing links to it (the list has Edit/Deploy/Delete and imports Monitor without using it; the builder has no link). The shell nav lists it only in matchPaths. The page renders '?' boxes anyway (OPS-01).
  - web/modules/sensor-module/src/Module.tsx:153
  - web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:26,221-248 (actions: Edit, Deploy, Delete only)
  - web/shell/src/console/nav/pages/sensor.ts:63-67
  - grep 'scada/operator' navigate/Link: none
  - (verifier) web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:26,221-248
  - (verifier) web/shell/src/console/nav/pages/sensor.ts:60-68
  - (verifier) grep 'scada/operator' in web/ navigate/Link: none
  - Verifier: Confirmed.
- **NAV-01** (JOUR; verdict CONFIRMED; severity LOW): Dead in-app links on the empty-tenant path: 'Sensör Kaydet' opens a 'Sensor bulunamadi' error and 'Düzenle' bounces to /sensor
  - Claim: Holds. The second line of the error card may show the GraphQL error text for id 'register' instead of 'Sensor bulunamadi', but the error card appears either way.
  - web/modules/sensor-module/src/pages/SensorDashboardPage.tsx:163 → Module.tsx:109 (devices/:deviceId) → pages/DeviceDetailPage.tsx:266,370-380 ('Sensör yüklenemedi' / 'Sensor bulunamadi')
  - web/modules/sensor-module/src/pages/DeviceDetailPage.tsx:421 → no 'devices/:id/edit' route in Module.tsx:107-112 → Module.tsx:181 (Navigate to /sensor)
  - web/modules/sensor-module/src/Module.tsx:143-144 (process/new\|:id) with no inbound Link/navigate (grep '/sensor/process/' outside nav matchPaths: none)
  - (verifier) SensorDashboardPage.tsx:162-168 (Link to /sensor/devices/register) → Module.tsx:109 (devices/:deviceId) → DeviceDetailPage.tsx:369-389 (error card)
  - (verifier) DeviceDetailPage.tsx:416-421 (Link to /sensor/devices/:id/edit) → no such route in Module.tsx:107-112 → Module.tsx:181 (Navigate to /sensor)
  - (verifier) Module.tsx:143-144 (process/new\|:id) with no inbound link (grep)
  - Verifier: Both link targets were resolved against the route table. This is outside the SCADA core path, so LOW.
- **JRN-08** (JOUR-verifier; verdict SELF; severity LOW): Process list: Activate/Deactivate always fail silently (lowercase enum sent to an uppercase GraphQL enum), and Delete leaves the row in place as 'Archived'
  - Claim: The FE models ProcessStatus as lowercase ('draft'\|'active'\|'inactive'\|'archived'), but the GraphQL enum names are uppercase. NestJS registerEnumType maps the internal value 'active' to the name ACTIVE. The process list's Activate and Deactivate send updateProcess({status:'active'\|'inactive'}), which GraphQL rejects during variable coercion. useProcess turns the throw into {success:false}, and the page only console.errors it. Delete soft-archives the process, and the 'non-archived' filter in useActiveProcesses compares against lowercase 'archived', so it never matches. The 'deleted' row stays in the list with an Archived badge, still openable through Edit in the unified editor. The confirm dialog said 'The process and its diagram are removed.'
  - FE writer: pages/process/ProcessListPage.tsx:141-162 (handleStatusChange → updateProcess({status: newStatus}) with 'active'\|'inactive'), :153 (console.error only); hooks/useProcess.ts:6 (lowercase union), :427-441 (catch → {success:false, message})
  - BE reader: apps/sensor-service/src/process/dto/process.dto.ts:81-84 (@Field(() => ProcessStatus) status); process.entity.ts:21-31 (enum values lowercase, registerEnumType → GraphQL names uppercase); web/shared-ui/src/generated/graphql-types.ts:15069-15073 (wire values 'ACTIVE'\|'ARCHIVED'\|'DRAFT'\|'INACTIVE')
  - Executed proof (scratchpad/jrnproof/enum.cjs with graphql-js): variable {status:'inactive'} → error 'Value "inactive" does not exist in "ProcessStatus" enum. Did you mean the enum value "INACTIVE"'; uppercase works; serializing 'archived' yields 'ARCHIVED'
  - Delete: ProcessListPage.tsx:109-137 (confirm text 'removed', then refetch); process.service.ts:252-263 (archive only); useProcess.ts:518-521 (p.status !== 'archived' never true for 'ARCHIVED'); ProcessListPage.tsx:63 uses useActiveProcesses, :219 lowercases for badge, :289 Edit link still offered
- **JRN-09** (JOUR-verifier; verdict SELF; severity LOW): The unified editor reopens every process in the last-used mode: leaving it in PLC pops the ST modal on the next process, and leaving it in HMI or Runtime hides the P&ID
  - Claim: editorModeStore is a module-level zustand singleton that is reset only on logout or tenant switch. UnifiedEditorPage reads mode from it and never resets it on mount; its identity effect resets only the SCADA store. Opening any process, or a new one, therefore starts in whatever mode the user last left. In PLC mode the full-page ST editor modal opens immediately. In HMI or Runtime the P&ID iframe is hidden, and a new process shows an empty HMI canvas (zero screens per LIFE-31) instead of the P&ID drawing surface the 'new process' flow implies. The bottom panel's open state, auto-opened by PLC, also persists.
  - store/editorModeStore.ts:31-40 (initial mode 'pid'), :43-55 (setMode), :78-81 (reset only via registerLogoutCleanup/onTenantChange); grep for other reset callers: none
  - pages/unified/UnifiedEditorPage.tsx:190-198 (reads mode/panels from the singleton), :351-354 (mount effect resets only scadaReset), :1055 (iframe hidden in hmi/runtime), :1211-1222 (PLC modal isOpen={mode==='plc'})
- **JRN-07** (JOUR; verdict CONFIRMED; severity LOW): Unified editor: switching HMI screen tabs stores the hidden P&ID iframe's pan and zoom as the HMI screen's viewport
  - Claim: Holds. In HMI mode, ScreenManager (an earlier sibling) posts getViewport to the hidden iframe and registers a listener. ScreenCanvas then saves the HMI viewport for the previous screen in the same commit. The iframe's viewportState reply arrives in a later task and overwrites that entry in the single screenViewports map. The listener stays alive up to 1s, since its effect deps are stable.
  - web/modules/sensor-module/src/components/unified-editor/ScreenManager.tsx:63-92 (getViewport → async saveScreenViewport(prevId, iframe vp); setViewport to iframe)
  - web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:380-395 (same map saved/restored for HMI)
  - web/modules/sensor-module/src/store/scada/sceneSlice.ts:153-159 (single screenViewports map)
  - (verifier) ScreenManager.tsx:63-92 (getViewport → async saveScreenViewport(prevId, iframe vp); setViewport to iframe)
  - (verifier) ScreenCanvas.tsx:381-395 (sync save/restore of the same map)
  - (verifier) sceneSlice.ts:153-160 (single screenViewports map)
  - (verifier) canvas/main.jsx:890-901 (getViewport replies with the P&ID viewport; setViewport applies the HMI one to P&ID)
  - Verifier: The writer and reader sides plus the async ordering were all verified in code; isCanvasReady stays true because the iframe stays mounted while hidden. Cosmetic, so LOW.
- **DESK-01** (JOUR; verdict CONFIRMED; severity LOW): The desktop-only notice disagrees with the builder's real minimum width, and the unified editor has neither
  - Claim: Holds. With the shell sidebar, even a 1024 px landscape tablet gives the builder row less than its 64rem minimum width.
  - web/shared-ui/src/components/Layout/DesktopOnlyNotice.tsx:28-36 (md:hidden; text '768 px')
  - web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:368,371 (notice + min-w-[64rem])
  - grep DesktopOnlyNotice\|min-w-[ in pages/unified/UnifiedEditorPage.tsx: 0 matches (present only in builder and the retired ProcessEditorPage.tsx:438,618)
  - (verifier) DesktopOnlyNotice.tsx:28-36 (md:hidden; text says 768 px)
  - (verifier) ScadaPackageBuilderPage.tsx:368 (notice), :371 (min-w-[64rem])
  - (verifier) grep DesktopOnlyNotice\|min-w-[ in UnifiedEditorPage.tsx: 0 matches; present in ProcessEditorPage.tsx:438,618
  - (verifier) UnifiedEditorPage.tsx:1008 (w-64 left) and :1123 (w-72 right) fixed widths beside flex-1 center
  - Verifier: Verified in source. A layout-only issue, so LOW.

</details>
