# 04 - Water Chemistry Tools

All 7 water chemistry tools use the `@platform/aquaculture-engines` shared library for pure-TypeScript thermodynamic calculations. They are `runtime: 'both'` tools (no external service calls, can run on cloud or edge) and are registered via `WaterChemistryToolsModule` using the `TOOL_PROVIDERS` multi-provider token.

## Architecture

Each tool:
- Extends `BaseTool<TInput, TOutput>` from `apps/ai-service/src/tools/core/base-tool.ts`
- Is decorated with `@Tool()` metadata (name, description, inputSchema sent to Claude)
- Implements `validate()` for input boundary checks
- Implements `run()` with the actual engine computation
- Is cacheable with a 60-second TTL (except `get_reagent_list` at 1 hour)

## 1. calculate_ammonia_toxicity

Calculates un-ionized ammonia (NH3) toxicity at current water conditions.

**Inputs:**
| Field                    | Type   | Unit  | Description                     |
|--------------------------|--------|-------|---------------------------------|
| totalAmmoniacalNitrogen  | number | mg/L  | Total Ammonia Nitrogen (TAN)    |
| pH                       | number | NBS   | Current pH                      |
| temperature              | number | C     | Water temperature               |
| salinity                 | number | ppt   | Salinity                        |

**Outputs:**
| Field       | Type   | Unit  | Description                          |
|-------------|--------|-------|--------------------------------------|
| nh3_mgL     | number | mg/L  | Un-ionized NH3-N concentration       |
| nh4_mgL     | number | mg/L  | Ionized NH4+ concentration           |
| fractionNH3 | number | 0-1   | NH3 fraction of TAN                  |
| safeTAN     | number | mg/L  | Max safe TAN at current conditions   |
| status      | string | -     | 'safe' / 'alert' / 'danger'         |
| criticalPH  | number | NBS   | pH where NH3 reaches 0.02 mg/L limit|

**Engine functions:** `fractionNH3`, `calcNH3`, `calcNH4`, `calcSafeTAN`, `criticalPHforNH3`, `uiaStatus`

---

## 2. calculate_h2s_toxicity

Calculates hydrogen sulfide toxicity at current water conditions.

**Inputs:**
| Field         | Type   | Unit  | Description                     |
|---------------|--------|-------|---------------------------------|
| totalSulfide  | number | ug/L  | Total sulfide concentration     |
| pH            | number | NBS   | Current pH                      |
| temperature   | number | C     | Water temperature               |
| salinity      | number | ppt   | Salinity                        |

**Outputs:**
| Field            | Type   | Unit  | Description                     |
|------------------|--------|-------|---------------------------------|
| h2s_ugL          | number | ug/L  | H2S concentration               |
| fractionH2S      | number | 0-1   | H2S fraction of total sulfide   |
| safeTotalSulfide | number | ug/L  | Max safe total sulfide          |
| status           | string | -     | 'safe' / 'alert' / 'danger'    |
| criticalPH       | number | NBS   | pH where H2S reaches 2 ug/L limit |

**Engine functions:** `fractionH2S`, `calcH2S`, `calcSafeTotalSulfide`, `criticalPHforH2S`, `h2sStatus`

---

## 3. calculate_co2_level

Calculates dissolved CO2 from alkalinity and pH.

**Inputs:**
| Field      | Type   | Unit          | Description            |
|------------|--------|---------------|------------------------|
| alkalinity | number | mg/L CaCO3    | Total alkalinity       |
| pH         | number | NBS           | Current pH             |
| temperature| number | C             | Water temperature      |
| salinity   | number | ppt           | Salinity               |

**Outputs:**
| Field         | Type   | Unit  | Description                               |
|---------------|--------|-------|-------------------------------------------|
| co2_mgL       | number | mg/L  | Dissolved CO2 concentration               |
| status        | string | -     | 'safe' (<20) / 'warning' (20-40) / 'danger' (>40) |
| statusMessage | string | -     | Human-readable status explanation         |

**Engine functions:** `co2Level`, `alkMgToMeq`

---

## 4. calculate_carbonate_chemistry

Full carbonate system analysis including DIC, species distribution, and saturation indices.

**Inputs:**
| Field       | Type   | Unit          | Description            |
|-------------|--------|---------------|------------------------|
| alkalinity  | number | mg/L CaCO3    | Total alkalinity       |
| pH          | number | NBS           | Current pH             |
| temperature | number | C             | Water temperature      |
| salinity    | number | ppt           | Salinity               |
| calciumMgL  | number | mg/L          | Ca2+ (optional, estimated from salinity) |

**Outputs:**
| Field          | Type   | Unit    | Description                        |
|----------------|--------|---------|------------------------------------|
| dic_mmolL      | number | mmol/L  | Dissolved Inorganic Carbon         |
| co2_mgL        | number | mg/L    | CO2 concentration                  |
| co3_mmolL      | number | mmol/L  | Carbonate ion concentration        |
| fractionCO2    | number | 0-1     | CO2 fraction of DIC                |
| fractionHCO3   | number | 0-1     | HCO3- fraction of DIC              |
| fractionCO3    | number | 0-1     | CO32- fraction of DIC              |
| omegaCalcite   | number | -       | Calcite saturation state           |
| omegaAragonite | number | -       | Aragonite saturation state         |

**Engine functions:** `calcDicOfAlk`, `alphaZero`, `alphaOne`, `alphaTwo`, `calcOmegaCalcite`, `calcOmegaAragonite`, `calcCO3`, `co2Level`, `phNbsToFree`, `alkMgToMeq`

---

## 5. calculate_reagent_dosing

Calculates dosing recipes to move from current to target water conditions.

**Inputs:**
| Field            | Type     | Unit          | Description                  |
|------------------|----------|---------------|------------------------------|
| currentAlkalinity| number   | mg/L CaCO3    | Current alkalinity           |
| currentPH        | number   | NBS           | Current pH                   |
| targetAlkalinity | number   | mg/L CaCO3    | Target alkalinity            |
| targetPH         | number   | NBS           | Target pH                    |
| temperature      | number   | C             | Water temperature            |
| salinity         | number   | ppt           | Salinity                     |
| volumeLiters     | number   | L             | System volume                |
| selectedReagents | string[] | -             | Reagent names (optional, default: all) |

**Outputs:**
| Field      | Type           | Description                              |
|------------|----------------|------------------------------------------|
| recipes    | DosingRecipe[] | Array of dosing recipes with amounts (kg/g), reagent names, delta ALK/DIC per step |
| currentDIC | number         | Current DIC in mmol/L                    |
| targetDIC  | number         | Target DIC in mmol/L                     |

Internally converts alkalinity from mg/L CaCO3 to meq/L and volume from liters to m3 before calling the engine.

**Engine functions:** `calcDicOfAlk`, `calculateDosingRecipes`, `alkMgToMeq`, `REAGENTS`

---

## 6. get_reagent_list

Returns the full list of available chemical reagents and their properties.

**Inputs:** None (empty object)

**Outputs:**
| Field    | Type    | Description                             |
|----------|---------|-----------------------------------------|
| reagents | Array   | Objects with name, formula, molecularWeight, meqPerMol |

The 9 reagents:
1. Sodium Bicarbonate (NaHCO3) - MW 84.007
2. Sodium Carbonate (Na2CO3) - MW 105.988
3. Sodium Hydroxide (NaOH) - MW 39.997
4. Calcium Carbonate (CaCO3) - MW 100.087
5. Calcium Hydroxide (Ca(OH)2) - MW 74.093
6. Calcium Oxide (CaO) - MW 56.077
7. Add CO2 (CO2) - MW 44.010
8. De-gas CO2 (-CO2) - MW 44.010
9. Muriatic Acid (HCl) - MW 36.461

**Engine functions:** `REAGENTS` constant

---

## 7. simulate_dosing_effect

Simulates the effect of adding a specific reagent amount to the system (forward dosing).

**Inputs:**
| Field            | Type   | Unit          | Description                     |
|------------------|--------|---------------|---------------------------------|
| currentAlkalinity| number | mg/L CaCO3    | Current alkalinity              |
| currentPH        | number | NBS           | Current pH                      |
| temperature      | number | C             | Water temperature               |
| salinity         | number | ppt           | Salinity                        |
| reagentName      | string | -             | Reagent name                    |
| doseGrams        | number | g             | Amount to add                   |
| volumeLiters     | number | L             | System volume                   |

**Outputs:**
| Field                    | Type           | Description                              |
|--------------------------|----------------|------------------------------------------|
| steps                    | OnDemandStep[] | Start and final states (DIC, ALK, pH, CO2) |
| predictedPH              | number         | Final predicted pH                       |
| predictedAlkalinity_meqL | number         | Final predicted alkalinity (meq/L)       |
| predictedCO2_mgL         | number         | Final predicted CO2 (mg/L)               |

**Engine functions:** `calcDicOfAlk`, `calcForwardDosing`, `alkMgToMeq`

---

## Module Registration

`WaterChemistryToolsModule` registers all 7 tools as both NestJS providers and `TOOL_PROVIDERS` multi-providers, making them discoverable by the `ToolRegistryService`.

```
apps/ai-service/src/tools/water-chemistry/
  calculate-ammonia-toxicity.tool.ts
  calculate-h2s-toxicity.tool.ts
  calculate-co2-level.tool.ts
  calculate-carbonate-chemistry.tool.ts
  calculate-reagent-dosing.tool.ts
  get-reagent-list.tool.ts
  simulate-dosing-effect.tool.ts
  water-chemistry-tools.module.ts
```
