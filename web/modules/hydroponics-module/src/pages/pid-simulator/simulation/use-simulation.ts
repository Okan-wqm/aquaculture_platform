/**
 * Dosing Simulator Hook
 *
 * Range-based control with freshwater mixing and CO₂ equilibration:
 * 1. Aeration: CO₂ exchange with atmosphere (Henry's law) - every tick
 * 2. Plant disturbances: root H⁺ extrusion, nutrient uptake - every tick
 * 3. If EC out of range → dose nutrients or dilute with freshwater
 * 4. After dilution → CO2_WAIT: track CO₂ rate of change, wait until stable
 * 5. If pH out of range (and CO₂ stable) → calculate exact acid/base dose
 * 6. Recalculate pH from thermodynamics
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import {
  SimConfig,
  SimState,
  SimSnapshot,
  SimStateName,
  DEFAULT_SIM_CONFIG,
  ACID_PUMP_MAX,
  BASE_PUMP_MAX,
  NUT_PUMP_MAX,
  DIL_PUMP_MAX,
  ACID_CONC,
  BASE_CONC,
  CO2_EQ_MMOL,
} from './types';
import {
  calcDicOfAlk,
  calcCo2OfDic,
  co2MmToMg,
  calcAlkOfDicPh,
  calcPhForAlkDic,
} from '../engine/carbonate-chemistry';
import { HYDRO_REAGENTS, reagentDeltas } from '../engine/reagents';

const HNO3 = HYDRO_REAGENTS.find(r => r.name === 'Nitric Acid')!;
const KOH = HYDRO_REAGENTS.find(r => r.name === 'Potassium Hydroxide')!;

const HISTORY_MAX = 500;
const TRAIL_MAX = 100;
const INTERVAL_MS = 40; // 25 fps

// EC model constants
const EC_PER_ML_PER_L = 0.00015;        // mS/cm per mL nutrient per L tank
const NUT_ALK_PER_ML_PER_L = -0.00002;  // meq/L per mL nutrient per L tank (acidic effect)

// CO₂ stability threshold: if rate of change < this, CO₂ is stable
const CO2_STABLE_RATE = 0.05;  // mg/L per second

function createInitialState(config: SimConfig): SimState {
  const DIC = calcDicOfAlk(config.initialAlkMeq, config.initialPH, config.tempC, config.salinity);
  const co2mm = calcCo2OfDic(DIC, config.initialPH, config.tempC, config.salinity);

  return {
    tick: 0,
    DIC,
    ALK: config.initialAlkMeq,
    pH: config.initialPH,
    EC: config.initialEC,
    co2: co2MmToMg(co2mm),
    acidPump: 0,
    basePump: 0,
    nutPump: 0,
    dilPump: 0,
    state: 'IDLE',
    acidTotalGrams: 0,
    baseTotalGrams: 0,
    nutTotalML: 0,
    co2Eq: co2MmToMg(CO2_EQ_MMOL),
  };
}

// ============================================================================
// Dosing calculations
// ============================================================================

/**
 * Calculate grams of acid or base needed to bring pH to target.
 * Uses carbonate chemistry: target ALK = f(DIC, targetPH) → deltaALK → grams.
 */
function calcPhDose(
  state: SimState,
  targetPH: number,
  config: SimConfig,
): { acidGrams: number; baseGrams: number } {
  const targetALK = calcAlkOfDicPh(state.DIC, targetPH, config.tempC, config.salinity);
  const deltaALK = targetALK - state.ALK;

  if (Math.abs(deltaALK) < 0.001) return { acidGrams: 0, baseGrams: 0 };

  if (deltaALK < 0) {
    const grams = Math.abs(deltaALK) * HNO3.mw * config.volumeL / (HNO3.meqPerMol * 1000);
    return { acidGrams: grams, baseGrams: 0 };
  } else {
    const grams = deltaALK * KOH.mw * config.volumeL / (KOH.meqPerMol * 1000);
    return { acidGrams: 0, baseGrams: grams };
  }
}

function calcEcDose(currentEC: number, targetEC: number, volumeL: number): number {
  const deltaEC = targetEC - currentEC;
  if (deltaEC <= 0) return 0;
  const ecPerML = EC_PER_ML_PER_L * volumeL;
  if (ecPerML <= 0) return 0;
  return deltaEC / ecPerML;
}

// ============================================================================
// Pump conversions
// ============================================================================

function pumpML(percent: number, maxMLMin: number, dt: number): number {
  return (percent / 100) * maxMLMin * (dt / 60);
}

function pumpGrams(percent: number, maxMLMin: number, concGL: number, dt: number): number {
  return pumpML(percent, maxMLMin, dt) * concGL / 1000;
}

function gramsToPumpPercent(grams: number, maxMLMin: number, concGL: number, dt: number): number {
  if (grams <= 0) return 0;
  const maxGramsPerTick = maxMLMin * (dt / 60) * concGL / 1000;
  if (maxGramsPerTick <= 0) return 0;
  return Math.min(100, (grams / maxGramsPerTick) * 100);
}

function mlToPumpPercent(ml: number, maxMLMin: number, dt: number): number {
  if (ml <= 0) return 0;
  const maxMLPerTick = maxMLMin * (dt / 60);
  if (maxMLPerTick <= 0) return 0;
  return Math.min(100, (ml / maxMLPerTick) * 100);
}

// ============================================================================
// Hook
// ============================================================================

export function useSimulation() {
  const [config, setConfig] = useState<SimConfig>({ ...DEFAULT_SIM_CONFIG });
  const [running, setRunning] = useState(false);
  const [renderCount, setRenderCount] = useState(0);

  const stateRef = useRef<SimState>(createInitialState(config));
  const historyRef = useRef<SimSnapshot[]>([]);
  const trailRef = useRef<Array<{ CT: number; AT: number }>>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const configRef = useRef(config);
  configRef.current = config;

  const simTick = useCallback(() => {
    const state = stateRef.current;
    const cfg = configRef.current;
    const dt = cfg.dt;
    const prevCo2 = state.co2;

    // ── 1. Aeration: CO₂ exchange with atmosphere (Henry's law) ──
    // CO₂ moves toward atmospheric equilibrium. Rate depends on aerationRate.
    // CO₂ (as DIC fraction) = alpha0 * DIC. Gas exchange changes DIC, not ALK.
    const co2Now = calcCo2OfDic(state.DIC, state.pH, cfg.tempC, cfg.salinity);
    const dDIC = cfg.aerationRate * (dt / 60) * (CO2_EQ_MMOL - co2Now);
    state.DIC += dDIC;

    // ── 2. Plant disturbances ──
    // Root H⁺ extrusion → ALK decreases
    state.ALK -= 0.0005 * (dt / 60);
    // Plant nutrient uptake → EC decreases
    state.EC -= 0.002 * (dt / 60);
    state.EC = Math.max(0.1, state.EC);

    // ── 3. Determine what to dose ──
    const ecMid = (cfg.ecMin + cfg.ecMax) / 2;
    const phMid = (cfg.phMin + cfg.phMax) / 2;
    let acidPump = 0;
    let basePump = 0;
    let nutPump = 0;
    let dilPump = 0;
    let newState: SimStateName = state.state;

    const ecInRange = state.EC >= cfg.ecMin && state.EC <= cfg.ecMax;

    if (state.state === 'CO2_WAIT') {
      // Waiting for CO₂ to stabilize after dilution.
      // Track rate of change: |dCO₂/dt| in mg/L per second.
      // Recalculate current co2 after aeration adjustment
      state.DIC = Math.max(0.001, state.DIC);
      state.pH = calcPhForAlkDic(state.ALK, state.DIC, cfg.tempC, cfg.salinity);
      const co2AfterMg = co2MmToMg(calcCo2OfDic(state.DIC, state.pH, cfg.tempC, cfg.salinity));
      const co2Rate = Math.abs(co2AfterMg - prevCo2) / dt; // mg/L per second

      state.co2 = co2AfterMg;
      state.co2Eq = co2MmToMg(CO2_EQ_MMOL);

      if (co2Rate < CO2_STABLE_RATE) {
        // CO₂ stabilized → back to IDLE
        newState = 'IDLE';
      }
      // All pumps off during CO2_WAIT
    } else if (!ecInRange) {
      if (state.EC < cfg.ecMin) {
        const mlNeeded = calcEcDose(state.EC, ecMid, cfg.volumeL);
        nutPump = mlToPumpPercent(mlNeeded, NUT_PUMP_MAX, dt);
        newState = 'DOSING_EC';
      } else {
        // EC too high → dilute with freshwater
        dilPump = 80;
        newState = 'DILUTE';
      }
    } else if (state.state === 'DILUTE') {
      // EC just came back into range after dilution → wait for CO₂ to stabilize
      newState = 'CO2_WAIT';
    } else if (state.pH < cfg.phMin || state.pH > cfg.phMax) {
      // EC in range, CO₂ stable → correct pH
      const { acidGrams, baseGrams } = calcPhDose(state, phMid, cfg);
      acidPump = gramsToPumpPercent(acidGrams, ACID_PUMP_MAX, ACID_CONC, dt);
      basePump = gramsToPumpPercent(baseGrams, BASE_PUMP_MAX, BASE_CONC, dt);
      newState = 'DOSING_PH';
    } else {
      newState = 'IDLE';
    }

    state.acidPump = acidPump;
    state.basePump = basePump;
    state.nutPump = nutPump;
    state.dilPump = dilPump;
    state.state = newState;

    // ── 4. Apply doses ──
    const acidG = pumpGrams(acidPump, ACID_PUMP_MAX, ACID_CONC, dt);
    const baseG = pumpGrams(basePump, BASE_PUMP_MAX, BASE_CONC, dt);
    const nutML = pumpML(nutPump, NUT_PUMP_MAX, dt);
    const dilML = pumpML(dilPump, DIL_PUMP_MAX, dt);

    if (acidG > 0) {
      const d = reagentDeltas(HNO3, acidG, cfg.volumeL);
      state.DIC += d.deltaDIC;
      state.ALK += d.deltaALK;
      state.acidTotalGrams += acidG;
    }

    if (baseG > 0) {
      const d = reagentDeltas(KOH, baseG, cfg.volumeL);
      state.DIC += d.deltaDIC;
      state.ALK += d.deltaALK;
      state.baseTotalGrams += baseG;
    }

    if (nutML > 0) {
      state.EC += nutML * EC_PER_ML_PER_L * cfg.volumeL;
      state.ALK += nutML * NUT_ALK_PER_ML_PER_L * cfg.volumeL;
      state.nutTotalML += nutML;
    }

    // Dilution: mix tank water with freshwater
    if (dilML > 0) {
      const f = dilML / (cfg.volumeL * 1000); // mixing fraction
      // Freshwater DIC from its ALK + pH
      const fwDIC = calcDicOfAlk(cfg.freshwaterALK, cfg.freshwaterPH, cfg.tempC, cfg.salinity);
      // Mix: tank * (1-f) + freshwater * f
      state.ALK = state.ALK * (1 - f) + cfg.freshwaterALK * f;
      state.DIC = state.DIC * (1 - f) + fwDIC * f;
      state.EC *= (1 - f); // freshwater has ~0 EC
    }

    // ── 5. Recalculate pH from thermodynamics ──
    state.DIC = Math.max(0.001, state.DIC);
    state.ALK = Math.max(-2.0, state.ALK);
    state.pH = calcPhForAlkDic(state.ALK, state.DIC, cfg.tempC, cfg.salinity);
    state.co2 = co2MmToMg(calcCo2OfDic(state.DIC, state.pH, cfg.tempC, cfg.salinity));
    state.co2Eq = co2MmToMg(CO2_EQ_MMOL);

    state.tick++;
  }, []);

  const runInterval = useCallback(() => {
    const ticksPerInterval = Math.max(1, Math.round(configRef.current.speedMultiplier));

    for (let i = 0; i < ticksPerInterval; i++) {
      simTick();
    }

    const s = stateRef.current;
    historyRef.current.push({
      tick: s.tick,
      DIC: s.DIC,
      ALK: s.ALK,
      pH: s.pH,
      EC: s.EC,
      co2: s.co2,
      acidPump: s.acidPump,
      basePump: s.basePump,
      nutPump: s.nutPump,
      dilPump: s.dilPump,
      state: s.state,
    });
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift();

    trailRef.current.push({ CT: s.DIC, AT: s.ALK });
    if (trailRef.current.length > TRAIL_MAX) trailRef.current.shift();

    setRenderCount(c => c + 1);
  }, [simTick]);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(runInterval, INTERVAL_MS);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [running, runInterval]);

  const start = useCallback(() => setRunning(true), []);
  const stop = useCallback(() => setRunning(false), []);

  const reset = useCallback(() => {
    setRunning(false);
    stateRef.current = createInitialState(configRef.current);
    historyRef.current = [];
    trailRef.current = [];
    setRenderCount(c => c + 1);
  }, []);

  const applyDisturbance = useCallback((type: 'phUp' | 'phDown' | 'ecUp' | 'ecDown') => {
    const s = stateRef.current;
    const cfg = configRef.current;
    switch (type) {
      case 'phUp': s.ALK += 0.5; break;
      case 'phDown': s.ALK -= 0.5; break;
      case 'ecUp': s.EC += 0.3; break;
      case 'ecDown': s.EC -= 0.3; s.EC = Math.max(0.1, s.EC); break;
    }
    s.pH = calcPhForAlkDic(s.ALK, s.DIC, cfg.tempC, cfg.salinity);
    s.co2 = co2MmToMg(calcCo2OfDic(s.DIC, s.pH, cfg.tempC, cfg.salinity));
    setRenderCount(c => c + 1);
  }, []);

  return {
    state: stateRef.current,
    history: historyRef.current,
    trail: trailRef.current,
    running,
    renderCount,
    config,
    setConfig,
    start,
    stop,
    reset,
    applyDisturbance,
  };
}
