# 01 - Shared Engine Extraction: Water Chemistry

## Motivation

The water chemistry engine is pure TypeScript math (thermodynamic calculations, bisection solvers, reagent dosing geometry). It has **zero browser API dependencies** - no DOM, no React, no fetch. This makes it an ideal candidate for extraction into a shared library that both the web frontend and the new `ai-service` can consume.

## Source Location

```
web/modules/farm-module/src/pages/water-chemistry/engine/
  types.ts
  water-quality.ts
  ammonia-calc.ts
  co2-calc.ts
  reagents.ts
  deffeyes-data.ts
```

## Target Location

```
libs/aquaculture-engines/
  package.json                    # @platform/aquaculture-engines
  tsconfig.json                   # extends ../../tsconfig.base.json
  src/
    index.ts                      # re-exports from water-chemistry/
    water-chemistry/
      index.ts                    # re-exports all 6 modules
      types.ts
      water-quality.ts
      ammonia-calc.ts
      co2-calc.ts
      reagents.ts
      deffeyes-data.ts
```

## tsconfig.base.json Change

Added path alias so any service/app can import via:

```typescript
import { co2Level, fractionNH3 } from '@platform/aquaculture-engines';
```

```json
"@platform/aquaculture-engines": ["libs/aquaculture-engines/src/index.ts"]
```

## Import Dependency Graph

```
types.ts (leaf - no imports)
   ^
   |
water-quality.ts (imports tempCToK from types)
   ^            ^
   |            |
ammonia-calc.ts |  co2-calc.ts
(imports from   |  (imports from water-quality)
 water-quality) |
   ^            ^
   |            |
deffeyes-data.ts
(imports from types, water-quality, ammonia-calc, co2-calc)

reagents.ts
(imports from types, water-quality) -- independent of ammonia/co2/deffeyes
```

## Exported Functions Per File

### types.ts
- `alkMgToMeq(mgPerL)` - Convert alkalinity mg/L CaCO3 to meq/L
- `alkMeqToMg(meqPerL)` - Convert alkalinity meq/L to mg/L CaCO3
- `tempCToK(tempC)` - Celsius to Kelvin
- Types/interfaces: `WaterParams`, `TargetParams`, `ToxicLimits`, `SystemParams`, `FishType`, `FishSize`, `ReagentInfo`, `DosingResult`, `DosingRecipe`, `OperatingPoint`, `SafeZone`, `PHIsoline`, `ToxicZone`, `OmegaIsopleth`, `DosingVisualization`, `DeffeyesChartData`, `CalculatedOutputs`, `OnDemandStep`, `OnDemandInput`

### water-quality.ts
- `totalBoron(S)`, `totalSulfate(S)`, `totalFluoride(S)` - Seawater composition
- `getK1(tempC, S)`, `getK2(tempC, S)` - Carbonic acid dissociation (Millero 2010)
- `calcKw(tempC, S)`, `calcKB(tempC, S)`, `calcKS(tempC, S)`, `calcKF(tempC, S)` - Equilibrium constants
- `getKNH4(tempC, S)`, `getKH2S(tempC, S)` - Ammonium/sulfide constants
- `calcIonicStrength(S)` - Ionic strength from salinity
- `molalToMolin(S)`, `ahSwsToNbsFactor(tempC, S)` - pH scale helpers
- `phNbsToFree(pHnbs, tempC, S)`, `phFreeToNbs(pHfree, tempC, S)` - pH scale conversions
- `calcActivityCoefficientH(tempC, S)`, `ahFreeToSwsFactor(tempC, S)`, `ahFreeToTotFactor(tempC, S)` - Activity coefficients
- `swsToFree(K, tempC, S)`, `totToFree(K, tempC, S)` - Scale conversions for constants
- `alphaZero(pHfree, tempC, S)`, `alphaOne(pHfree, tempC, S)`, `alphaTwo(pHfree, tempC, S)` - Carbonate alpha fractions
- `phLineSlope(pHfree, tempC, S)`, `phLineIntercept(pHfree, tempC, S)` - Deffeyes diagram functions
- `calcDicOfAlk(alkMeq, pHnbs, tempC, S)`, `calcCo2OfDic(dicMM, pHnbs, tempC, S)` - DIC/ALK/CO2 conversions
- `co2MmToMg(co2Mm)`, `co2MgToMm(co2Mg)` - CO2 unit conversions
- `calcAlkOfDicPh(dicMM, pHnbs, tempC, S)`, `calcPhForCritCO2(dicMM, co2CritMg, tempC, S)`, `calcPhForAlkDic(alkMeq, dicMM, tempC, S)` - Inverse calculations
- `calcRhoFW(tempC)`, `calcRhoSW(tempC, S)` - Seawater density (UNESCO 1983)
- `calcKspCalcite(tempC, S)`, `calcKspAragonite(tempC, S)` - Solubility products (Mucci 1983)
- `calcCO3(dicMM, pHnbs, tempC, S)` - Carbonate concentration
- `calcOmegaCalcite(dicMM, caMolKg, pHnbs, tempC, S)`, `calcOmegaAragonite(dicMM, caMolKg, pHnbs, tempC, S)` - Saturation indices

### ammonia-calc.ts
- `fractionNH3(pHnbs, tempC, S)` - Un-ionized NH3 fraction
- `calcNH3(tan, pHnbs, tempC, S)` - NH3-N concentration from TAN
- `calcNH4(tan, pHnbs, tempC, S)` - NH4+ concentration from TAN
- `percentNH3(pHnbs, tempC, S)` - UIA-N percentage
- `criticalPHforNH3(tan, nh3Limit, tempC, S)` - Critical pH for NH3 toxicity
- `calcSafeTAN(pHnbs, nh3Limit, tempC, S)` - Max safe TAN
- `uiaStatus(currentPH, criticalPH)` - Safety status (safe/alert/danger)
- `generateUIAvsPHData(tempC, S, tan, nh3Limit, ...)` - Chart data
- `generateNH3vsPHData(tempC, S, tan, ...)` - Chart data
- `fractionH2S(pHnbs, tempC, S)` - H2S fraction
- `calcH2S(totalSulfide, pHnbs, tempC, S)` - H2S concentration
- `calcTotalSulfide(h2sMeasured, pHnbs, tempC, S)` - Total sulfide from measurement
- `criticalPHforH2S(h2sMeasured, currentPH, h2sLimit, tempC, S)` - Critical pH for H2S
- `calcSafeTotalSulfide(pHnbs, h2sLimit, tempC, S)` - Max safe total sulfide
- `h2sStatus(currentPH, criticalPH)` - Safety status
- `generateH2SvsPHData(tempC, S, h2sMeasured, currentPH, h2sLimit, ...)` - Chart data

### co2-calc.ts
- `co2Level(alkMeq, pHnbs, tempC, S)` - CO2 in mg/L from alkalinity and pH
- `criticalPHforCO2(alkMeq, co2CritMg, tempC, S)` - Critical pH for CO2 toxicity
- `generateCarbonateVsPHData(tempC, S, dicMM, ...)` - CO2/HCO3/CO3 distribution chart data
- `generateSaturationVsPHData(tempC, S, dicMM, caMgL, ...)` - Calcite/aragonite SI chart data

### reagents.ts
- `REAGENTS` - Array of 9 `ReagentInfo` objects (NaHCO3, Na2CO3, NaOH, CaCO3, Ca(OH)2, CaO, CO2, -CO2, HCl)
- `calculateDosingRecipes(currentDIC, currentAlk, targetDIC, targetAlk, volumeM3, selectedReagents)` - Two-reagent dosing
- `reagentDirectionLine(startDIC, startAlk, reagent, length)` - Direction line for Deffeyes diagram
- `calcDosingVisualization(currentDIC, currentAlk, targetDIC, targetAlk, reagent1Name, reagent2Name)` - Dosing visualization data
- `calcForwardDosing(current, volumeM3, steps)` - Forward/on-demand dosing calculator

### deffeyes-data.ts
- `generatePHIsolines(tempC, S, maxDIC, step)` - pH isolines for Deffeyes diagram
- `generateNH3ToxicZone(tempC, S, tan, nh3Limit, alkMin, alkMax, maxDIC)` - NH3 toxic boundary
- `generateCO2ToxicZone(tempC, S, alkMeq, co2CritMg, maxDIC)` - CO2 toxic boundary
- `generateSafeZone(tempC, S, tan, nh3Limit, co2CritMg, alkMinMeq, alkMaxMeq)` - Safe operating zone
- `calcOperatingPoint(pHnbs, alkMeq, tempC, S)` - Current operating point
- `calcTargetPoint(targetpH, targetAlkMeq, tempC, S)` - Target operating point
- `generateCalciteIsopleth(tempC, S, caMgL, maxDIC)` - Calcite Omega=1 line
- `generateAragoniteIsopleth(tempC, S, caMgL, maxDIC)` - Aragonite Omega=1 line
- `generateDeffeyesChartData(params, target, limits, alkMinMeq, alkMaxMeq, caMgL, showTarget)` - Full chart data assembly
