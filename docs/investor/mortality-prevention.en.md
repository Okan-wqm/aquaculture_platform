# AquaPlatform — Mortality Reduction Mechanisms

> A non-technical reference document prepared for investors, partners and decision-makers. The system's capacity to reduce fish mortality is described through modules currently in production and modules in the roadmap.

---

## 1. Context

In aquaculture, mortality is the primary variable that determines the operational profitability of a farm. The industry average is in the range of 15–40 % per year. Investments in biomass, feed, labour and energy are irrecoverably written off together with the fish that die.

AquaPlatform is a SaaS solution that breaks the mortality chain at multiple points. The platform is designed so that a single operational organisation can manage several independent sites, locations and regions under a shared operations centre, with consolidated mortality control and isolated data. The sections below describe the system's capacity in operational terms; technical references are kept to a minimum.

---

## 2. Core Capabilities

### 2.1 Water Chemistry Dosing Engine

The system computes the concentration of unionised ammonia (NH₃), carbon dioxide and hydrogen sulphide using reference equations from the scientific literature, based on temperature, pH, alkalinity, salinity and total ammonia nitrogen. The result is presented to the operator not as raw data but as a concrete dosing recipe:

> *"Tank A requires 12.4 kg of sodium bicarbonate. Result: pH 7.2 → 7.4, NH₃ remains within safe limits, CO₂ exits the critical zone."*

The dosing engine recalculates toxicity thresholds in real time when temperature, pH and salinity change concurrently.

### 2.2 Combined Phase Diagram

The toxicity zones for NH₃, CO₂ and H₂S are plotted on a single canvas along the alkalinity–DIC axes:

- Green zone: safe operating range
- Red zones: regions where toxicity thresholds are exceeded
- Blue point: the tank's current state
- Target point: the desired water chemistry
- Direction vectors: the direction in which a candidate reagent will move the tank when added

Instead of mentally combining five separate parameter charts, the operator reads the tank's distance from the safe zone from a single visual.

### 2.3 Optimum Zone Management

The system aims to keep the tank within the safe phase zone. When a deviation begins, it generates a recovery plan with multiple reagent options; for each option the quantity is given in grams, together with an applicability note and a risk score. The operator selects the most appropriate path.

The recipe is not applied in a single operation, but in steps:

1. The system divides the recipe into sub-steps and shows the predicted result of each step in advance.
2. The operator applies the first step.
3. A new water sample is measured and entered into the system.
4. The system compares the prediction with the actual measurement; if a deviation is detected, the remaining steps are recalculated.
5. The cycle continues until the procedure is complete.

This working pattern structurally rules out the pH or alkalinity shock that may otherwise arise from a single overdose.

### 2.4 Equipment Attribution

Every recipe the system recommends is delivered with a list of the required equipment (CO₂ cylinder, dosing line, degassing unit, dosing pump and so on). In addition, the equipment that has caused the deviation (for example, an offline degassing unit or a stopped aerator) is reported to the operator. The time required to locate the faulty equipment is reduced by virtue of this attribution.

### 2.5 Satellite-Based Environmental Monitoring (Sea-Cage Farms)

Two separate satellite sources are integrated into the system:

- **Sentinel-2 / Copernicus Data Space Ecosystem (optical):** actual imagery of the coastal water at the farm coordinates; chlorophyll concentration, indicators of algal bloom and water-colour anomalies.
- **Copernicus Marine CMEMS (model-based):** Sea Surface Temperature (SST), salinity and current forecasts.

The optical source provides the present state, while the model-based source provides the forecast. Approaching harmful algal blooms or temperature anomalies are flagged 48–72 hours in advance; cage operations (net depth, harvest timing) can be adjusted accordingly.

### 2.6 Lot-Level Traceability

Feed and chemical lots are tracked from intake to consumption with minute-level precision. When two distinct lots are mixed in a single silo, the event is marked as "MIX-LOT1-LOT2". After a mortality event, the source can be traced back in line with the EU food-safety standard for two-hour traceability. The blast radius of a defective or expired lot across the farm is contained.

### 2.7 Disease Early Warning Based on Scientific Evidence

Fish diseases are largely linked to environmental triggers. Examples:

- A prolonged period of low water temperature increases the risk of Bacterial Cold Water Disease (BCWD) and Infectious Pancreatic Necrosis (IPN) in salmon.
- Temperatures above 18 °C elevate the risk of vibriosis in sea bass and sea bream.
- The combination of low oxygen and high ammonia weakens the immune response.
- Salinity shocks may favour fungal infections.

AquaPlatform aims to deliver scientifically grounded warnings to the farm manager when environmental parameters enter such risk patterns:

> *"In Tank 7, water temperature has remained below 8 °C for five days. The species cultured is Atlantic salmon. The available literature (Holt 1972, Starliper 2011) documents an increased risk of BCWD under these conditions."*

Each warning is delivered with a source citation; the information communicated thus rests on a traceable scientific basis.

**Treatment Package:**

In addition to risk warnings, the system aggregates the corresponding treatment information on the same screen:

- Recommended medications and doses (species-, weight- and disease-specific)
- Withdrawal period (mandatory under food-safety regulations)
- Drug-drug and drug-water-quality interaction warnings
- Directory of authorised fish veterinarians with direct contact
- Supplier integration for medication procurement
- Treatment schedule (dose intervals, follow-up observations)

**Knowledge Base Architecture:**

The system is built on an architecture in which scientific articles can be uploaded into the knowledge base. Species-specific disease–condition relationships, environmental trigger thresholds, growth curves and treatment protocols are added over time. When a new study is uploaded, the protection level for all tenants is updated simultaneously.

**Modules in Production and Planned Modules:**

| Module | Status |
|---|---|
| Disease event log (symptom categories) | In production |
| Treatment record, medication name, start and end date | In production |
| Withdrawal-period tracking | In production |
| Harvest and transfer blocks for diseased tanks | In production |
| Environmental parameter tracking | In production |
| Cross-domain correlation engine | In production |
| Scientifically backed disease–condition library | Planned |
| Automated predictive disease warning | Planned |
| Species-specific disease risk scoring | Planned |
| Medication and dose recommendation library | Planned |
| Drug-drug and drug-water-quality interaction | Planned |
| Authorised veterinarian directory | Planned |
| Supplier integration | Planned |
| Treatment schedule automation | Planned |

### 2.8 Management of Multiple Independent Sites

AquaPlatform is built on a multi-tenant architecture. A single operational organisation — a farming group, a regional office or a corporate parent — can administer multiple geographically independent sites, locations and regions through the same platform, while data between sites is kept isolated at the database level.

In practice, this means the following:

- Each site keeps its own tanks, species, sensors, personnel and reports.
- Group-level management can view all sites in a single consolidated dashboard; risk scores, mortality figures, feeding deviations and maintenance status are aggregated across sites in parallel.
- A dosing recipe, disease alert or maintenance procedure deployed at one site can be propagated as a template to other sites.
- On-call personnel can monitor multiple sites under a shared escalation ladder within a single shift.
- Knowledge-base updates (new disease articles, revised thresholds) take effect simultaneously across all sites under the organisation.

The result is that the same mortality control and operational discipline can be sustained across an entire portfolio without requiring each site to establish its own separate management structure.

---

## 3. Artificial Intelligence Architecture

In this system, artificial intelligence does not produce chemistry calculations or dosing quantities by itself. All numerical computations are carried out by deterministic tools built on bisection algorithms, Millero (1995, 2010) dissociation constants and carbonate-system equations. The artificial intelligence calls these tools and relays the result without modification.

This architecture has two consequences:

1. The numbers produced are identical for the same inputs; they are reproducible and verifiable.
2. The hallucination risk inherent in language models is not transferred to dosing decisions that are critical for fish survival.

Artificial intelligence is used in the roles of daily operations briefing, root-cause analysis, anomaly detection and operator assistance. In these roles, deterministic tools always run underneath.

---

## 4. Operator and Field Components

### 4.1 Mobile Application (AquaMobil)

- Critical alerts reach the operator's device within seconds via the push notification infrastructure.
- Field water-quality measurements are entered at the tank; the system validates the values immediately and flags out-of-range entries.
- Mortality records are captured through thirteen predefined categories; structured data is collected instead of free text.
- A deviation of ±20 % from the feeding plan automatically triggers an alert.
- When internet connectivity is unavailable, data are stored locally on the device and synchronised when the connection is restored.
- In the field, the operator may request concrete instructions from the AI assistant.
- Mobile work orders are closed with photographic evidence.

### 4.2 HR and Authorisation

- Personnel with expired certifications are not assigned to critical tasks within the system.
- Shift management operates jointly with an escalation ladder: if an alert is not handled by the operator in time, it is escalated to the farm manager.
- Personnel competency is tracked through the training and certification service.

### 4.3 Equipment Maintenance

- Recurring maintenance schedules for pumps, aerators and filters automatically generate work orders.
- The maintenance outcome is documented with photographic evidence.

---

## 5. Nineteen Mechanisms with a Direct Effect on Mortality

The items below summarise, in operational terms, the system's capacity to directly reduce fish mortality.

1. The system continuously measures the tank's water and issues a warning the moment values begin to deteriorate.
2. The system evaluates toxic substances in the water jointly with temperature, pH and salinity values.
3. The system computes, in grams, how much of which chemical reagent should be added.
4. The system offers multiple reagent options for the same problem and marks the safest one.
5. The system divides the recipe into controlled sub-steps rather than a single operation.
6. The system shows the predicted outcome of each step in advance.
7. The system compares predictions against the post-dose measurement and recalculates the recipe in case of deviation.
8. The system consolidates the status of all toxic substances in a single chart.
9. The system draws the safe operating zone and warns when the tank begins to drift outside the zone.
10. The system informs the operator of the equipment that has caused the deviation.
11. The system applies species-specific limits automatically.
12. The system does not permit stocking above the tank's biomass capacity.
13. The system can remotely trigger the activation and deactivation of aerators.
14. The system stores critical alerts in a durable queue against loss.
15. The system blocks the transfer of fish from a diseased tank to another tank.
16. The system delivers critical alerts to the operator's device within seconds.
17. The system validates field-entered measurement values immediately.
18. The system continues to record data even when internet connectivity is unavailable.
19. The system flags feeding deviations automatically with an alert.

---

## 6. Seventeen Mechanisms with an Indirect Effect on Mortality

The items below are mechanisms that prevent mortality by reducing operator error or delayed decisions.

20. The system retrospectively analyses the cause of a mortality event.
21. The system delivers a farm-wide risk and anomaly report to the manager every morning.
22. The system provides the operator with expert-level action recommendations in the field.
23. The system does not produce numerical errors from artificial intelligence; all computations originate from deterministic tools.
24. The system tracks feed inventory levels and issues a reorder warning before stock is depleted.
25. The system can isolate expired or spoiled feed lots from the consumption flow.
26. The system manages the equipment maintenance schedule automatically.
27. The system does not assign critical tasks to personnel with expired certifications.
28. The system enforces escalation rules so that no alert is left unattended.
29. The system performs satellite-based environmental risk monitoring for sea-cage farms.
30. The system integrates weather data into operational planning.
31. The system records mortality events through thirteen predefined categories; data quality is preserved.
32. The system closes maintenance work orders with photographic evidence.
33. The system flags small environmental deviations early through anomaly detection.
34. The system produces a 48-hour risk score for every tank.
35. The system reduces the manager's data-collection workload through a unified dashboard.
36. The system enables the management of multiple independent sites under shared operational discipline and mortality control, with site data kept isolated.

---

## 7. Transparency Note

This document distinguishes the system's current capacity from the modules in the roadmap. Modules listed as "In production" are operational today; modules listed as "Planned" are under active development.

The quantitative impact on mortality (percentage reduction, payback period and similar figures) is determined through farm-specific pilot measurements; this document does not commit to general numerical guarantees. The measurement methodology and pilot process are documented separately.

The mechanisms through which the system reduces fish mortality, and the areas that are still under development, are summarised objectively above. Operational users may contact the product team for detailed technical documentation on the inner workings of any specific module.
