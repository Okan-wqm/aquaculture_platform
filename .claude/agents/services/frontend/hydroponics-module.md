---
name: hydroponics-module
description: Knowledge base for the Hydroponics Module frontend
---

# Hydroponics Module Knowledge Base

## Overview

The Hydroponics Module is a Module Federation remote at `/hydroponics/*`. It provides a nutrient solution calculator for hydroponic farming. The module handles setup (nutrient profile management, species/stage configuration) and a multi-tab solution calculation workflow supporting multiple NS types (new solution, adjusting/readjustment, drip, closed system). All calculation logic runs entirely client-side.

## Directory Structure

```
web/modules/hydroponics-module/src/
  Module.tsx              # Two routes: /setup and /solution/*
  main.tsx
  pages/
    SetupPage.tsx                     # /hydroponics/setup — nutrient profile manager
    setup/
      NutrientProfileManager.tsx      # Nutrient profile CRUD UI
    solution/
      SolutionPage.tsx                # /hydroponics/solution/* — tab container
      tabs/
        GeneralOptionsTab.tsx         # General options tab
        WaterAnalysisTab.tsx          # Water analysis input tab
        UserOptionsTab.tsx            # User preferences tab
        ResultTab.tsx                 # Calculation results tab
        DrainageCompositionTab.tsx    # Drainage composition (adjusting mode)
        PreviousDrainageTab.tsx       # Previous drainage data (adjusting mode)
        CurrentNsFormulaTab.tsx       # Current NS formula (adjusting mode)
        ReadjustmentSettingsTab.tsx   # Readjustment parameters (adjusting mode)
  components/
    solution/
      SectionCard.tsx                 # Collapsible section card
      ParameterRow.tsx                # Label + input row for parameters
      DynamicTankTable.tsx            # Table for multi-tank calculations
      FertilizerOptionRow.tsx         # Fertilizer selection and amount row
  context/
    SolutionContext.tsx               # useReducer context for all solution state
  hooks/
    useNutrientProfiles.ts            # Nutrient profile data (React Query or REST)
    useSpeciesStages.ts               # Species + growth stage data
    useLookupValues.ts                # Lookup tables (substrate types, etc.)
    useFieldVisibility.ts             # Field show/hide based on mode state
    useVisibleTabs.ts                 # Which tabs to show based on NS type
    useCalculation.ts                 # Triggers and returns calculation result
  lib/
    units.ts                          # Unit conversion utilities
    calculator/
      types.ts                        # Calculator input/output types
      index.ts                        # Main calculator entry point
      balance.ts                      # Ion balance calculation
      drip-solution.ts                # Drip irrigation solution calc
      subtract-water.ts               # Subtract water ions from target
      closed-system.ts                # Closed system recirculation calc
      adjusting.ts                    # Adjusting/readjustment calc
      fertilizer-allocation.ts        # Fertilizer allocation optimization
  data/
    nutrient-defaults.ts              # Default nutrient target values
  types/
    solution.types.ts                 # SolutionSettings, GeneralOptions, WaterAnalysis, UserOptions
    modes.types.ts                    # NsType, SystemType, ModeState, DrainageComposition, CurrentNsFormula, ReadjustmentSettings
```

## Pages / Components

### SetupPage (`/hydroponics/setup`)
- Nutrient profile management (CRUD)
- `NutrientProfileManager` — list, create, edit, delete named nutrient profiles
- Species/stage configuration
- Profile can be loaded into the solution calculator

### SolutionPage (`/hydroponics/solution/*`)
Multi-tab solution calculator:
- **GeneralOptionsTab**: NS type selection (new/adjusting/drip/closed), system type, cultivation stage (starter/vegetative/etc.), tank count, tank volume
- **WaterAnalysisTab**: Water source ion concentrations (EC, pH, Ca, Mg, Na, K, NO3, SO4, HCO3, etc.)
- **UserOptionsTab**: Target ion concentrations based on nutrient profile + stage
- **ResultTab**: Calculated fertilizer quantities, EC, pH, and mixing instructions
- **DrainageCompositionTab** (adjusting mode only): Drainage EC, pH, ion composition
- **PreviousDrainageTab** (adjusting mode only): Previous drainage measurements
- **CurrentNsFormulaTab** (adjusting mode only): Current NS formula being used
- **ReadjustmentSettingsTab** (adjusting mode only): Substrate type, emitter flow, irrigation duration, etc.

Visible tabs controlled by `useVisibleTabs` based on `mode.nsType`. Adjusting mode shows 4 extra tabs.

### Component Details

- `SectionCard`: Collapsible card for grouping related inputs within a tab
- `ParameterRow`: Label + unit + input field row, used throughout parameter tabs
- `DynamicTankTable`: Table showing per-tank calculations when multiple tanks configured
- `FertilizerOptionRow`: Row for selecting a fertilizer product and showing calculated dosage

## State Management

### SolutionContext (useReducer)
All solution settings live in a single `SolutionContext` with `useReducer`:

**State shape (`SolutionState`)**:
```typescript
{
  settings: SolutionSettings {  // Full calculator input
    generalOptions: GeneralOptions
    waterAnalysis: WaterAnalysis
    userOptions: UserOptions
    drainageComposition?: DrainageComposition   // adjusting mode
    previousDrainage?: DrainageComposition      // adjusting mode
    currentNsFormula?: CurrentNsFormula         // adjusting mode
    readjustmentSettings?: ReadjustmentSettings // adjusting mode
  }
  isDirty: boolean
}
```

**Actions**: `SET_GENERAL`, `SET_WATER`, `SET_USER`, `SET_FIELD`, `SET_DRAINAGE`, `SET_PREVIOUS_DRAINAGE`, `SET_NS_FORMULA`, `SET_READJUSTMENT`, `SET_NS_TYPE`, `RESET`, `LOAD`, `MARK_SAVED`

**Exposed via `useSolution()`**:
- `settings`, `isDirty`, `mode: ModeState`
- `setGeneral`, `setWater`, `setUser`, `setField`, `setDrainage`, `setPreviousDrainage`, `setNsFormula`, `setReadjustment`, `setNsType`
- `reset()`, `load(settings)`, `save()` — save() is currently console.log only (TODO: backend call)

**`mode: ModeState`** computed from settings:
```typescript
{
  nsType: 'new' | 'adjusting' | 'drip' | 'closedSystem'
  systemType: 'drip' | 'ebb_flow' | 'nft' | 'dwc' | 'aquaponics'
  isStarter: boolean  // cultivationStage === 'starter'
}
```

### Hooks
- `useFieldVisibility(mode)`: Returns `{ showField: (fieldName) => boolean }` for conditional field display
- `useVisibleTabs(mode)`: Returns array of tab keys to render
- `useCalculation(settings, mode)`: Runs the client-side calculator, returns results
- `useNutrientProfiles()`: Fetches saved nutrient profiles (React Query or direct fetch)
- `useSpeciesStages()`: Fetches species + growth stages for the dropdown

## GraphQL Operations

The hydroponics module has minimal backend integration — most operations are client-side calculation. Potential backend queries:

```graphql
query NutrientProfiles { nutrientProfiles { id name species stage targetIons { ... } } }
mutation SaveNutrientProfile($input) { saveNutrientProfile { id name } }
mutation DeleteNutrientProfile($id) { deleteNutrientProfile { success } }
query SpeciesStages { speciesStages { species stages { name code } } }
query LookupValues($type) { lookupValues(type: $type) { code label } }
```

**Note**: The `save()` function in `SolutionContext` is a TODO — currently only logs to console. Backend integration for saving solution results is not implemented.

## Routing

```
/hydroponics             -> Navigate to /hydroponics/setup
/hydroponics/setup       -> SetupPage (NutrientProfileManager)
/hydroponics/solution/*  -> SolutionPage (multi-tab)
/hydroponics/solution/general_options  -> GeneralOptionsTab
/hydroponics/solution/water_analysis   -> WaterAnalysisTab
/hydroponics/solution/user_options     -> UserOptionsTab
/hydroponics/solution/result           -> ResultTab
```

Navigation links in Shell's `MainLayout` for hydroponics:
```
/hydroponics/setup
/hydroponics/solution/general_options
/hydroponics/solution/water_analysis
/hydroponics/solution/user_options
/hydroponics/solution/result
```

## Key Dependencies

- `@aquaculture/shared-ui` — shared components, graphqlClient (if/when wired)
- Vite + Module Federation
- Tailwind CSS
- Client-side calculator library (entirely local in `lib/calculator/`)

## Known Gotchas

- **Save is not implemented**: `SolutionContext.save()` only logs to console. Settings are lost on page refresh.
- The calculator runs entirely **client-side** — no API call for calculation. The `lib/calculator/` modules perform all math locally.
- NS type `adjusting` unlocks 4 additional tabs. `useVisibleTabs` controls this dynamically — ensure all tabs check `mode.nsType` before rendering.
- `SET_NS_TYPE` action in the reducer auto-initializes `drainageComposition`, `previousDrainage`, `currentNsFormula`, and `readjustmentSettings` with defaults when switching to `adjusting` mode.
- `data/nutrient-defaults.ts` contains default ion targets — used to pre-populate `userOptions` when no profile is loaded.
- `DynamicTankTable` requires `tankCount` from `generalOptions.serviceDefinition` to know how many columns to render.
- Fertilizer allocation (`fertilizer-allocation.ts`) performs optimization — may be slow for large tank counts.
- `useSolution()` throws if called outside `SolutionProvider` — ensure all solution tabs are children of the provider.

## Related Backend Services

- **farm-service** — species/stage data (if integrated)
- **gateway-api** (port 3000) — GraphQL endpoint
- Currently minimal backend dependency — this module is largely self-contained calculation tool
