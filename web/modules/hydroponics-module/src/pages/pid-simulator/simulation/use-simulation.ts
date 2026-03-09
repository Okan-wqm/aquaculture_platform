/**
 * Dosing Simulator Hook
 *
 * Equilibrium-pH based control with freshwater mixing:
 * 1. Aeration: CO₂ exchange with atmosphere (Henry's law) - every tick
 * 2. Plant disturbances: root H⁺ extrusion, nutrient uptake - every tick
 * 3. If EC out of range → dose nutrients or dilute with freshwater
 * 4. If equilibrium pH out of range → calculate exact acid/base dose
 * 5. Recalculate pH from thermodynamics
 *
 * Key insight: dose based on equilibrium pH (what pH will be when CO₂
 * equilibrates with atmosphere), not instantaneous pH. This prevents
 * wasting acid during aeration-driven CO₂ degassing.
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
  CO2_EQ_MMOL,
} from './types';
import {
  calcDicOfAlk,
  calcCo2OfDic,
  co2MmToMg,
  calcPhForAlkDic,
  calcEquilibriumPH,
} from '../engine/carbonate-chemistry';
import { HYDRO_REAGENTS, HydroReagent, reagentDeltas } from '../engine/reagents';

const HISTORY_MAX = 500;
const TRAIL_MAX = 100;
const INTERVAL_MS = 40; // 25 fps

// EC model constants
const EC_PER_ML_PER_L = 0.00015;
const NUT_ALK_PER_ML_PER_L = -0.00002;

function findReagent(name: string): HydroReagent {
  return HYDRO_REAGENTS.find(r => r.name === name) || HYDRO_REAGENTS[0];
}

function createInitialState(config: SimConfig): SimState {
  const DIC = calcDicOfAlk(config.initialAlkMeq, config.initialPH, config.tempC, config.salinity);
  const co2mm = calcCo2OfDic(DIC, config.initialPH, config.tempC, config.salinity);
  const eqPH = calcEquilibriumPH(config.initialAlkMeq, CO2_EQ_MMOL, config.tempC, config.salinity);

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
    eqPH,
  };
}

// ============================================================================
// Dosing calculation - works with any reagent (vertical or diagonal)
// ============================================================================

/**
 * Calculate grams of reagent needed to move equilibrium pH to target.
 * Uses bisection: find grams where calcEquilibriumPH(ALK + dALK) = targetEqPH.
 * Only ALK matters for eq pH (CO₂ equilibrates to atmospheric constant).
 */
function calcDoseGramsForEqPH(
  currentALK: number,
  targetEqPH: number,
  reagent: HydroReagent,
  config: SimConfig,
): number {
  const currentEqPH = calcEquilibriumPH(currentALK, CO2_EQ_MMOL, config.tempC, config.salinity);
  if (Math.abs(currentEqPH - targetEqPH) < 0.01) return 0;

  const isBase = reagent.radians < Math.PI;

  if (isBase && currentEqPH >= targetEqPH) return 0;
  if (!isBase && currentEqPH <= targetEqPH) return 0;

  let lo = 0;
  let hi = 500;

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const { deltaALK } = reagentDeltas(reagent, mid, config.volumeL);
    const newEqPH = calcEquilibriumPH(
      currentALK + deltaALK,
      CO2_EQ_MMOL,
      config.tempC,
      config.salinity,
    );

    if (isBase) {
      if (newEqPH < targetEqPH) lo = mid;
      else hi = mid;
    } else {
      if (newEqPH > targetEqPH) lo = mid;
      else hi = mid;
    }

    if (hi - lo < 0.0001) break;
  }

  return (lo + hi) / 2;
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

    // Resolve selected reagents
    const acidReagent = findReagent(cfg.acidReagent);
    const baseReagent = findReagent(cfg.baseReagent);

    // ── 1. Aeration: CO₂ exchange with atmosphere (Henry's law) ──
    const co2Now = calcCo2OfDic(state.DIC, state.pH, cfg.tempC, cfg.salinity);
    const dDIC = cfg.aerationRate * (dt / 60) * (CO2_EQ_MMOL - co2Now);
    state.DIC += dDIC;

    // ── 2. Plant disturbances ──
    state.ALK -= 0.0005 * (dt / 60);
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

    // Calculate equilibrium pH (pH when CO₂ reaches atmospheric equilibrium)
    const eqPH = calcEquilibriumPH(state.ALK, CO2_EQ_MMOL, cfg.tempC, cfg.salinity);

    if (!ecInRange) {
      if (state.EC < cfg.ecMin) {
        const mlNeeded = calcEcDose(state.EC, ecMid, cfg.volumeL);
        nutPump = mlToPumpPercent(mlNeeded, NUT_PUMP_MAX, dt);
        newState = 'DOSING_EC';
      } else {
        dilPump = 80;
        newState = 'DILUTE';
      }
    } else if (state.state === 'DILUTE') {
      // After dilution → go directly to IDLE (no CO2_WAIT needed with eq pH dosing)
      newState = 'IDLE';
    } else if (eqPH < cfg.phMin || eqPH > cfg.phMax) {
      // Equilibrium pH out of range → calculate dose based on eq pH
      if (eqPH > cfg.phMax) {
        // eq pH too high → need acid
        const grams = calcDoseGramsForEqPH(state.ALK, phMid, acidReagent, cfg);
        acidPump = gramsToPumpPercent(grams, ACID_PUMP_MAX, cfg.acidConc, dt);
      } else {
        // eq pH too low → need base
        const grams = calcDoseGramsForEqPH(state.ALK, phMid, baseReagent, cfg);
        basePump = gramsToPumpPercent(grams, BASE_PUMP_MAX, cfg.baseConc, dt);
      }
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
    const acidG = pumpGrams(acidPump, ACID_PUMP_MAX, cfg.acidConc, dt);
    const baseG = pumpGrams(basePump, BASE_PUMP_MAX, cfg.baseConc, dt);
    const nutML = pumpML(nutPump, NUT_PUMP_MAX, dt);
    const dilML = pumpML(dilPump, DIL_PUMP_MAX, dt);

    if (acidG > 0) {
      const d = reagentDeltas(acidReagent, acidG, cfg.volumeL);
      state.DIC += d.deltaDIC;
      state.ALK += d.deltaALK;
      state.acidTotalGrams += acidG;
    }

    if (baseG > 0) {
      const d = reagentDeltas(baseReagent, baseG, cfg.volumeL);
      state.DIC += d.deltaDIC;
      state.ALK += d.deltaALK;
      state.baseTotalGrams += baseG;
    }

    if (nutML > 0) {
      state.EC += nutML * EC_PER_ML_PER_L * cfg.volumeL;
      state.ALK += nutML * NUT_ALK_PER_ML_PER_L * cfg.volumeL;
      state.nutTotalML += nutML;
    }

    if (dilML > 0) {
      const f = dilML / (cfg.volumeL * 1000);
      const fwDIC = calcDicOfAlk(cfg.freshwaterALK, cfg.freshwaterPH, cfg.tempC, cfg.salinity);
      state.ALK = state.ALK * (1 - f) + cfg.freshwaterALK * f;
      state.DIC = state.DIC * (1 - f) + fwDIC * f;
      state.EC *= (1 - f);
    }

    // ── 5. Recalculate pH from thermodynamics ──
    state.DIC = Math.max(0.001, state.DIC);
    state.ALK = Math.max(-2.0, state.ALK);
    state.pH = calcPhForAlkDic(state.ALK, state.DIC, cfg.tempC, cfg.salinity);
    state.co2 = co2MmToMg(calcCo2OfDic(state.DIC, state.pH, cfg.tempC, cfg.salinity));
    state.co2Eq = co2MmToMg(CO2_EQ_MMOL);
    state.eqPH = calcEquilibriumPH(state.ALK, CO2_EQ_MMOL, cfg.tempC, cfg.salinity);

    state.tick++;
  }, []);

  const runInterval = useCallback(() => {
    const ticksPerInterval = Math.max(1, Math.round(configRef.current.speedMultiplier));

    for (let i = 0; i < ticksPerInterval; i++) {
      simTick();
    }

    const s = stateRef.current;
    historyRef.current.push({
      tick: s.tick, DIC: s.DIC, ALK: s.ALK, pH: s.pH, EC: s.EC, co2: s.co2,
      acidPump: s.acidPump, basePump: s.basePump, nutPump: s.nutPump, dilPump: s.dilPump,
      eqPH: s.eqPH, state: s.state,
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
    s.eqPH = calcEquilibriumPH(s.ALK, CO2_EQ_MMOL, cfg.tempC, cfg.salinity);
    setRenderCount(c => c + 1);
  }, []);

  return {
    state: stateRef.current,
    history: historyRef.current,
    trail: trailRef.current,
    running, renderCount,
    config, setConfig,
    start, stop, reset,
    applyDisturbance,
  };
}
