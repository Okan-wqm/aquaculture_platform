# Research: Hydroponics PID Controller Stability, Anti-Windup & Nutrient Ion Balance

**Topic:** PID (Kp/Ki/Kd) tuning and stability analysis for pH/EC control in hydroponic dosing, integrator anti-windup, saturation handling, ion balance (cation-anion sum-to-zero) validation, and fertilizer allocation math
**Date:** 2026-04-08
**Agent:** platform-services

## Sources
- [Caltech AM08 - Chapter 10 PID Control (Åström & Murray)](https://www.cds.caltech.edu/~murray/books/AM08/pdf/am06-pid_16Sep06.pdf)
- [Ziegler-Nichols Tuning Rules for PID (MStarLabs)](https://mstarlabs.com/control/znrule.html)
- [Scilab - PID Anti-Windup Schemes](https://www.scilab.org/pid-anti-windup-schemes)
- [MDPI Sensors 2021 - Making PI and PID Tuning Inspired by Ziegler-Nichols Precise and Reliable](https://www.mdpi.com/1424-8220/21/18/6157)
- [TU Eindhoven - Tuning of PID-type controllers](https://pure.tue.nl/ws/files/4286492/625529.pdf)
- [Penn State Extension - Hydroponics Systems: Calculating Nutrient Solution Concentrations](https://extension.psu.edu/hydroponics-systems-calculating-nutrient-solution-concentrations-using-the-two-basic-equations)
- [Eurofins - Nutrient Solutions for Greenhouse Crops (manual)](https://cdnmedia.eurofins.com/corporate-eurofins/media/12142795/160825_manual_nutrient_solutions_digital_en.pdf)
- [Cropaia - How to calculate a nutrient solution formula](https://cropaia.com/blog/how-to-calculate-a-nutrient-solution-formula/)
- [e-GRO E305 - Fertilizer Calculation Basics for Hydroponics](https://e-gro.org/pdf/E305.pdf)
- [Oklahoma State Extension - Electrical Conductivity and pH Guide for Hydroponics](https://extension.okstate.edu/fact-sheets/electrical-conductivity-and-ph-guide-for-hydroponics)
- [MDPI AgriEngineering 2025 - Automated Hydroponic Nutrient Dosing: Scoping Review of pH and EC Frameworks](https://www.mdpi.com/2624-7402/7/2/43)
- [Science in Hydroponics - HydroBuddy open-source nutrient calculator](https://scienceinhydroponics.com/2016/03/the-first-free-hydroponic-nutrient-calculator-program-o.html)

## Key Findings

1. **PID control law.** Continuous form: `u(t) = Kp·e(t) + Ki·∫e(τ)dτ + Kd·de/dt`, where `e = setpoint - measurement`. Discrete (difference) form for a hydroponic dosing controller sampling every `T` seconds:
   ```
   u[k] = Kp·e[k] + Ki·T·Σe[i] + (Kd/T)·(e[k] - e[k-1])
   ```
   For hydroponic dosing, `u` is the dosing pump command (mL of acid/base/stock solution), `e` is the pH or EC error. Sampling rate `T` depends on the tank volume and pump rate — typically 10-60 seconds. Faster than 10s invites oscillation (sensor noise dominates); slower than 60s misses fast disturbances.
2. **Stability bounds — the Routh-Hurwitz / root-locus perspective.** For a first-order plant `G(s) = K/(τs+1)` (a reasonable approximation for a well-mixed hydroponic tank), the closed-loop characteristic equation with PI control is `τs² + (1+Kp·K)s + Ki·K = 0`. For stability:
   - `Kp > -1/K` (non-negative for positive gains)
   - `Ki > 0`
   - Damping ratio `ζ = (1+Kp·K) / (2·sqrt(τ·Ki·K))` — target `ζ ≈ 0.7` for well-damped response.
   A common bug is over-aggressive `Kd` on noisy measurements — differentiating noise amplifies high frequencies. For pH/EC sensors with ±0.05 pH noise, `Kd = 0` is often the safest choice (a PI controller, not PID).
3. **Ziegler-Nichols closed-loop method** (the default tuning heuristic in many frameworks):
   - Set `Ki = Kd = 0`.
   - Increase `Kp` until sustained oscillation — this is the ultimate gain `Ku`.
   - Measure the oscillation period `Pu`.
   - **Classic PID:** `Kp = 0.6·Ku`, `Ki = 1.2·Ku/Pu`, `Kd = 0.075·Ku·Pu`.
   - **PI only:** `Kp = 0.45·Ku`, `Ki = 0.54·Ku/Pu`.
   - **P only:** `Kp = 0.5·Ku`.
   Ziegler-Nichols targets a ~25% overshoot step response, which is acceptable for hydroponic pH where a 0.2 pH overshoot is recoverable. For EC where overshoot costs nutrients and risks plant burn, prefer tuning for lower overshoot (Tyreus-Luyben or Skogestad IMC rules).
4. **Integrator windup — the most common PID bug in dosing systems.** Windup occurs when the actuator saturates (e.g., dosing pump runs at max flow) while the error persists. The integral term keeps accumulating despite the unchanging output. When the setpoint is finally reached, the integrator has to "unwind" — producing huge overshoot on the opposite side. For a hydroponic tank, this surfaces as: acid overdosed → pH crashes below setpoint → base overdose to recover → oscillation for hours.
5. **Anti-windup schemes (Scilab / Åström & Murray classification):**
   - **Conditional integration (integrator clamping):** stop updating the integral term while the output is saturated. Simple, effective for most cases.
   - **Back-calculation:** compute `u_sat - u_unsat` (the saturation delta) and subtract a scaled version from the integrator: `I[k] = I[k-1] + Ki·T·e[k] + Kt·(u_sat - u_unsat)` where `Kt` is the anti-windup gain (typically `Kt ≈ 1/Ti`, where `Ti = Kp/Ki`).
   - **Tracking mode:** during saturation, the integrator "tracks" a value that would produce exactly the saturation output. On leaving saturation, the integrator starts from a consistent state.
   For a hydroponic dosing controller, conditional integration is the pragmatic choice — implement as:
   ```
   if (abs(u_unsat) < u_max) {
     integral += e * T;
   }
   ```
   Back-calculation gives better performance near saturation boundaries but requires `Kt` tuning.
6. **Dosing pump saturation bounds are physical, not virtual.** A pump cannot run "more than 100% on" or "less than 0% on". A dosing pump that only dispenses acid cannot raise pH — its output is *unipolar*. This means the PID controller must map its bipolar output `u` to an asymmetric actuator choice: `u > 0` drives the acid pump, `u < 0` drives the base pump (or triggers alert if no base pump exists). Fail-safe: if both pumps are unavailable (maintenance, empty tank), the controller must refuse to run and emit a `DosingUnavailable` alert.
7. **Derivative kick (setpoint change bumps).** When the operator changes the setpoint (e.g., from pH 6.0 to pH 5.8), the error changes instantly and the derivative term `de/dt` produces a huge momentary output. Fix: compute the derivative on the *measurement* (`-d(measurement)/dt`), not on the error. Mathematically equivalent for disturbance rejection, smooth on setpoint change.
8. **Sampling, filtering, and aliasing.** Hydroponic pH/EC sensors are noisy (electrode drift, temperature compensation error, bubble artifacts). Raw samples fed to the PID produce erratic output. Apply a first-order low-pass filter before the derivative: `y_filtered = α·y_raw + (1-α)·y_prev`, with `α ≈ 0.1-0.3`. Over-filtering introduces lag and hurts control; under-filtering amplifies noise via `Kd`.
9. **Ion balance — cation-anion sum-to-zero rule.** A nutrient solution must be electrically neutral. The sum of cation equivalents (charge × molar concentration) must equal the sum of anion equivalents. Per Eurofins manual:
   - Cations: NH4⁺ (+1), K⁺ (+1), Ca²⁺ (+2), Mg²⁺ (+2), Na⁺ (+1), Fe²⁺/³⁺, Mn²⁺, Zn²⁺, Cu²⁺
   - Anions: NO3⁻ (−1), H2PO4⁻ (−1 at typical pH), SO4²⁻ (−2), Cl⁻ (−1), HCO3⁻ (−1)
   - Equation: `Σ (cation_mmol/L × charge) = Σ (anion_mmol/L × |charge|)`
   - Acceptable tolerance: ±0.5 meq/L (per Cropaia and PSU Extension). Outside this, the solution formula is wrong and will produce unexpected pH drift or precipitation.
10. **Fertilizer allocation math (the "two basic equations" per PSU Extension):**
    - Target: known ppm (or mmol/L) of each nutrient element.
    - Source: stock fertilizer with known element composition (e.g., calcium nitrate Ca(NO3)2·4H2O provides Ca²⁺ and NO3⁻ in fixed ratio).
    - Equation 1 (mass balance per element): `sum over fertilizers (fertilizer_mass_per_L × element_fraction) = target_element_ppm`
    - Equation 2 (molar balance for anions via nitrate): net nitrate contribution constrained by target N.
    - Result: a system of linear equations. For N elements and M fertilizers, an underdetermined or overdetermined system; typically solved by linear least squares or by a fixed recipe book (the "HydroBuddy" approach).
11. **pH drift causes.** Plants uptake cations and anions at different rates; the imbalance drives pH. If a crop prefers NH4⁺ over K⁺, pH falls (plant exchanges H⁺ for NH4⁺); if it prefers NO3⁻ over H2PO4⁻, pH rises (plant exchanges OH⁻ for NO3⁻). Per OSU Extension, adjusting the NH4⁺:NO3⁻ ratio in the recipe is the root-cause fix for chronic pH drift — not piling on acid/base dosing.
12. **EC set-point vs actual nutrient delivery.** EC (electrical conductivity) is a *proxy* for total dissolved salts, not a measurement of any specific nutrient. Adding NaCl raises EC but delivers zero nutrients. The controller must not conflate "EC at target" with "nutrients correct" — it must also track individual element depletion via periodic lab/ISE measurements or drain-sample analysis. An EC-only control loop will fail when the solution composition drifts away from the recipe (e.g., after multiple top-ups replenish only water, leaving nutrient-rich residue).
13. **Life-safety / plant-safety bounds.** Hard limits (non-PID, acted on by an interlock):
    - pH < 4.0 or pH > 7.5 → stop dosing, raise CRITICAL alert (root damage)
    - EC > 3.5 mS/cm for leafy greens or > 4.5 mS/cm for fruiting crops → stop dosing (salt stress)
    - Temperature > 28°C → warn (root zone oxygen deprivation)
    - Simultaneous acid + base command → software interlock, this is a controller bug or a stuck sensor
    These interlocks run *outside* the PID loop and cannot be disabled by setpoint changes or tuning.

## Security Concerns

- **LIFE-SAFETY / CRITICAL:** PID controller without anti-windup → integrator saturates → wild pH swings → plant kill. Economic loss, recovery time measured in days.
- **LIFE-SAFETY / CRITICAL:** Hard interlocks (pH < 4.0, EC > 4.5) bypassed by tuning parameters. Interlocks must be in a separate code path that the PID cannot override.
- **LIFE-SAFETY / CRITICAL:** Simultaneous acid + base dosing command (software bug) → chemical reaction in the dosing manifold, heat, possible chlorine release if hypochlorite is involved. Software interlock required.
- **CRITICAL:** Ion balance validation missing → operator submits a recipe with |cation - anion| > 2 meq/L → system dispenses an impossible formula → pH crashes, nutrient precipitation.
- **CRITICAL:** Tuning parameters (Kp, Ki, Kd) writable via unauthenticated GraphQL/REST → attacker sets Kp=1000, destroys crop.
- **HIGH:** Derivative computed on error rather than measurement → setpoint change causes derivative kick → momentary overshoot.
- **HIGH:** Controller runs without a measurement (sensor offline, stale value) → PID acts on stale error → continues dosing into a tank it cannot measure. Sensor timeout must pause the controller.
- **HIGH:** Fertilizer allocation math uses JS `number` → floating-point drift in sub-ppm concentrations → recipe is wrong by a consistent bias.
- **HIGH:** EC-only control without element-level tracking → long-term nutrient imbalance despite EC being on target.
- **MEDIUM:** No logging of PID internal state (integral term, last error, saturation status) → impossible to debug oscillation.
- **MEDIUM:** No rate limit on setpoint changes → rapid operator toggles cause derivative kicks even with derivative-on-measurement if the filter is too light.

## Performance Concerns

- PID runs at 10-60s sampling — CPU cost is negligible. The cost is in sensor I/O and DB writes (per-sample logging).
- Ion balance validation is a simple sum over ~10 elements — constant-time, run on every recipe save.
- Fertilizer allocation (linear system solve) is O(N³) for N fertilizers; at N ≤ 10, runs in <1ms. Cache solved recipes keyed on a hash of the target profile.
- PID internal state (integral, last error) persists across controller restarts by checkpointing every 60s to DB. On boot, resume from checkpoint; stale checkpoint (>10min) resets to zero.

## Architectural Implications for platform-services reviews

- The `web/modules/hydroponics-module/src/lib/calculator/` code must contain pure functions, unit-tested against published nutrient recipes (Penn State, Eurofins, HydroBuddy). The PID simulator in the same module must be a pure state-machine — no DOM access, no React hooks inside the control loop.
- All nutrient math must use a `Decimal` (decimal.js) or a fixed-point representation (integer micromoles). Native JS `number` is not acceptable for sub-ppm concentrations with cumulative rounding over 10+ elements.
- The PID controller implementation must expose:
  - `Kp`, `Ki`, `Kd` as validated numeric fields with bounds (`0 ≤ Kp ≤ 10`, `0 ≤ Ki ≤ 1`, `0 ≤ Kd ≤ 1` — tenant-tunable but capped by a hard-coded safety limit)
  - Anti-windup method (`conditional` | `back-calculation`) with `Kt` for back-calc
  - Saturation bounds `u_min`, `u_max` (mL/min dosing pump flow)
  - Sampling period `T`
  - Derivative-on-measurement flag (default `true`)
  - Low-pass filter coefficient `α` for measurement
  - Sensor timeout threshold (default 300s — pause PID on stale data)
- Hard interlocks (`pHSafetyInterlock`, `ECSafetyInterlock`, `DualDoseInterlock`) live in a separate module, executed every cycle before the PID output is applied to the actuator. Interlocks read the hard limits from a config-service `secret`-typed value that requires `HYDROPONICS_SAFETY_WRITE` permission to modify.
- Ion balance validation is a mandatory step in `SaveNutrientRecipeCommand` — the handler computes cation/anion sums and rejects the command if |Σ cations − Σ anions| > 0.5 meq/L, returning a structured error listing the imbalance.
- PID internal state (`integral`, `lastError`, `lastMeasurement`, `saturatedAt`) is persisted to the `PidControllerState` entity every cycle. This enables debug (operator can see why the integrator is 50 units high) and clean restart.
- Setpoint changes emit a `PidSetpointChanged` audit event. A command handler rejects setpoint changes faster than 1 per 10 seconds (rate limit to prevent oscillation-induced thrash).
- Integration / simulator tests must cover: (a) step response, measure overshoot < 25%, settling time < 10·T, (b) sustained saturation for 5 minutes then release → no windup-induced overshoot > 10%, (c) sensor dropout → controller pauses, resumes on recovery, (d) ion balance -0.3 meq/L → accepted, (e) -1.0 meq/L → rejected, (f) hard interlock fires at pH 3.9 → dosing stops and alert emitted, (g) dual-dose command → software interlock fires.

## Domain Rule Additions for platform-services (Hydroponics Calculations subsection)

- **[LIFE-SAFETY / CRITICAL]** PID controller MUST implement anti-windup (conditional integration or back-calculation). Raw `integral += error*T` without saturation awareness is a blocking review failure.
- **[LIFE-SAFETY / CRITICAL]** Hard safety interlocks (pH 4.0-7.5 bounds, EC upper bound, dual-dose prevention) MUST run in a separate code path from the PID loop and MUST NOT be disable-able via setpoint or tuning changes.
- **[LIFE-SAFETY / CRITICAL]** PID controller MUST pause on sensor timeout (> 300s stale measurement) and emit an alert. Running the PID on stale data is a blocking review failure.
- **[LIFE-SAFETY / CRITICAL]** Kp / Ki / Kd tuning changes MUST be permission-gated (`HYDROPONICS_TUNING_WRITE`) and audited. Bounds: `0 ≤ Kp ≤ 10`, `0 ≤ Ki ≤ 1`, `0 ≤ Kd ≤ 1` (tenant-configurable within hardcoded caps).
- **[CRITICAL]** All nutrient math MUST use Decimal (decimal.js) or fixed-point integer representations. Native JS `number` for sub-ppm concentrations is a blocking review failure.
- **[CRITICAL]** Ion balance validation MUST run on every nutrient recipe save: `|Σ (cation_mmol × charge) − Σ (anion_mmol × |charge|)| ≤ 0.5 meq/L`. Recipes outside tolerance are rejected with a structured error.
- **[CRITICAL]** Derivative term MUST be computed on the measurement (`-d(measurement)/dt`), not on the error. Derivative-on-error causes setpoint-change kicks and is a blocking review failure.
- **[CRITICAL]** Sensor measurements MUST pass through a low-pass filter before entering the PID loop. Raw-noise-fed PID with `Kd > 0` is a blocking review failure.
- **[HIGH]** PID internal state (`integral`, `lastError`, `lastMeasurement`, `saturatedAt`) MUST be persisted to `PidControllerState` every cycle for restart continuity and debug visibility.
- **[HIGH]** Setpoint changes MUST be rate-limited (max 1 per 10 seconds) and MUST emit a `PidSetpointChanged` audit event.
- **[HIGH]** EC-only control is insufficient for long-term recipes. The system MUST track element-level depletion via periodic drain-sample analysis or ISE sensors, and alert on recipe drift.
- **[HIGH]** Unipolar actuators (acid-only pump, base-only pump) MUST be declared in the controller config and the PID output mapped asymmetrically. Commanding a non-existent base pump is a blocking review failure.
- **[MEDIUM]** Ziegler-Nichols tuning values MUST be treated as a *starting point*, not a final configuration. Tuning must be revalidated after any physical change (tank volume, pump flow rate, sensor replacement).
- **[MEDIUM]** Recommended default tuning: PI controller with `Kd = 0` for pH, aggressive jitter suppression via α = 0.2 low-pass. Fruiting crops prefer lower-overshoot tuning (Tyreus-Luyben, Skogestad IMC).
- **[MEDIUM]** Unit tests MUST cover step response overshoot, sustained saturation anti-windup, sensor dropout pause, ion balance acceptance/rejection, and hard interlock firing.

Research: `docs/research/platform-services/2026-04-08-hydroponics-pid-controller-stability-ion-balance.md`
