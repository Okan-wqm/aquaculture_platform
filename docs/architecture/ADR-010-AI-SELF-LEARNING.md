# ADR-010: AI Self-Learning Architecture for Aquaculture Platform

| Field            | Value                                          |
|------------------|------------------------------------------------|
| **Status**       | Proposed                                       |
| **Date**         | 2026-03-24                                     |
| **Decision Makers** | Platform Architecture Team                  |
| **Scope**        | All microservices, MCP layer, frontend MFEs    |
| **Supersedes**   | N/A                                            |
| **Related ADRs** | ADR-003 (Data Architecture), ADR-007 (Security)|

---

## Table of Contents

1. [Context & Problem Statement](#1-context--problem-statement)
2. [Decision](#2-decision)
3. [Architecture Overview](#3-architecture-overview)
   - 3.1 MCP vs Normal Backend Responsibilities
   - 3.2 Five AI Capability Layers
   - 3.3 Tenant-Isolated Learning Architecture
   - 3.4 Closed-Loop Learning Pipeline
   - 3.5 Mandatory Feedback System
   - 3.6 Active Follow-Up (AI as Investigator)
   - 3.7 Confidence Score Model
4. [Data Sources (22 Data Points)](#4-data-sources-22-data-points)
5. [AI Decision Types (8 Categories)](#5-ai-decision-types-8-categories)
6. [New MCP Tools Required](#6-new-mcp-tools-required)
7. [Database Schema (Per-Tenant)](#7-database-schema-per-tenant)
8. [Implementation Phases](#8-implementation-phases)
9. [Notification UX](#9-notification-ux)
10. [Success Metrics](#10-success-metrics)
11. [Risks & Mitigations](#11-risks--mitigations)
12. [References](#12-references)

---

## 1. Context & Problem Statement

### 1.1 Current Limitations

The Aquaculture Platform currently serves multiple tenants, each operating fish farms with fundamentally different characteristics. The existing alerting and decision-support infrastructure relies on **static, threshold-based rules** that are identical across all tenants. This approach has reached its practical ceiling for the following reasons:

**Species Diversity**: Each tenant raises different species (Atlantic Salmon, Sea Bass, Sea Bream, Tilapia, Shrimp, etc.) under different conditions. A dissolved oxygen level of 6.0 mg/L may be perfectly safe for Tilapia but critically dangerous for Atlantic Salmon. Static thresholds cannot accommodate species-specific, stage-specific, and density-specific nuances without an unmanageable explosion of configuration parameters.

**Environmental Variability**: Every farm operates in a unique environmental context. A coastal farm in the Aegean faces different seasonal temperature profiles, salinity fluctuations, and weather patterns than an inland recirculating aquaculture system (RAS) in Central Anatolia. One-size-fits-all alerting generates excessive false positives for some farms while missing genuine anomalies in others.

**Equipment & Infrastructure Differences**: Tenants use different sensor brands, different feeding systems (manual, semi-automatic, fully automated), different aeration equipment, and different water treatment configurations. The relationship between equipment behavior and water quality parameters varies significantly across installations.

**Cross-Domain Correlations Are Invisible to Humans**: The most valuable insights in aquaculture come from correlating data across domains that are traditionally managed in silos. Examples include:

- Feeding rate changes 3 days ago correlating with a dissolved oxygen drop today
- A specific staff member's shift pattern correlating with slightly higher mortality in certain tanks
- Weather forecast for the next 48 hours combined with current stock density suggesting preemptive aeration increase
- Chemical treatment 5 days ago explaining a temporary FCR (Feed Conversion Ratio) spike

These cross-domain correlations are practically impossible for human operators to detect consistently, especially at scale across dozens of tanks and thousands of daily data points.

**Farm-Specific Behavioral Patterns**: Every farm develops its own "normal." For example, Tank 5 at Farm A may experience a dissolved oxygen dip every Friday afternoon because that is when the adjacent processing facility increases its water intake. This is a completely normal, harmless pattern for this specific farm — but a generic threshold-based system would trigger an alert every single Friday, leading to alert fatigue and eventual desensitization to genuine warnings.

### 1.2 The Core Problem

> How can the platform deliver intelligent, farm-specific, continuously-improving decision support that learns from each tenant's unique operational patterns — without leaking knowledge between tenants, without requiring data science expertise from operators, and without generating alarm fatigue from irrelevant or incorrect predictions?

### 1.3 Why Now

- The platform's sensor data pipeline is mature and reliable (sensor-service handles multi-source ingestion)
- Farm management CRUD operations are stable (farm-service, stock tracking, feeding protocols)
- MCP Farm Intelligence Server is deployed and operational with 13 existing tools
- The user base is growing, and the competitive differentiation from AI-driven insights is now a market requirement
- Sufficient historical data exists (6+ months) for early tenants to begin meaningful pattern extraction

---

## 2. Decision

We will implement a **Tenant-Isolated Self-Learning AI System** with the following foundational principles:

### 2.1 Core Architectural Decisions

1. **MCP Farm Intelligence Server as Computation Engine**: All AI reasoning, pattern matching, and recommendation generation will be executed through the existing MCP (Model Context Protocol) server. This leverages the established tool-based architecture and avoids introducing a separate ML inference service.

2. **Tenant-Isolated Learning**: Each tenant's learned patterns, trajectories, and recommendation history are stored exclusively within their tenant schema (`tenant_{id}`). There is zero cross-tenant data sharing for learned patterns. A shared, read-only species knowledge base provides the baseline.

3. **Closed-Loop Learning with Mandatory User Feedback**: Every AI recommendation requires explicit user feedback. The system never silently updates its models. Every pattern adjustment is traceable, auditable, and reversible. This is inspired by ruflo's ReasoningBank approach to accountable AI decision-making.

4. **Five-Layer Capability Architecture**: AI capabilities are organized into five distinct layers, each with clear boundaries, enabling progressive rollout and independent scaling.

5. **Confidence-Gated Recommendations**: All AI outputs carry explicit confidence scores. Recommendations below tenant-specific confidence thresholds are suppressed or downgraded to informational notices. Confidence scores evolve independently per tenant per pattern.

6. **Human-in-the-Loop as a Design Constraint**: The AI system is explicitly designed as a decision-support tool, never as an autonomous decision-maker. Every actionable recommendation requires human acknowledgment before execution.

### 2.2 What We Are NOT Building

- **Not a general-purpose ML platform**: We are not deploying TensorFlow/PyTorch models. The intelligence comes from structured reasoning over domain data via MCP tools.
- **Not a real-time control system**: The AI does not directly control actuators, feeders, or equipment. It recommends; humans execute.
- **Not a shared learning system**: Tenant A's learned patterns never influence Tenant B's recommendations (unless explicitly contributed to the shared species knowledge base by platform administrators).
- **Not a replacement for existing alerts**: Static threshold alerts remain as a safety net. AI adds a layer of intelligent analysis on top.

---

## 3. Architecture Overview

### 3.1 What MCP Does vs What Normal Backend Does

A clear separation of concerns is essential to avoid scope creep and maintain system reliability. The backend services handle deterministic, rule-based operations. The MCP AI layer handles probabilistic, pattern-based reasoning.

#### Normal Backend Services (Deterministic)

| Responsibility | Service | Description |
|---|---|---|
| **Threshold Alerts** | sensor-service | "DO dropped below 5.0 mg/L" — simple value comparison against configured min/max |
| **Stock Counting** | farm-service | Current biomass, mortality counts, transfer records — pure CRUD arithmetic |
| **Compliance Checks** | farm-service | Stocking density vs. regulatory limits — predefined rules per jurisdiction |
| **Density Calculation** | farm-service | Biomass / volume — deterministic formula |
| **Feed Calculation** | farm-service | Body weight % feeding tables — species-specific lookup tables |
| **Chemical Dosing** | farm-service | Volume-based dosing calculations — deterministic formulas |
| **Equipment Scheduling** | farm-service | Maintenance intervals based on hours/days — simple countdown |
| **Report Generation** | all services | Aggregation of historical data into tabular/chart formats |

#### MCP AI Layer (Probabilistic / Learned)

| Responsibility | MCP Tool(s) | Description |
|---|---|---|
| **Cross-Domain Correlation** | `evaluate_tank_health` | "DO dropped AND feeding was increased 2 days ago AND temperature is trending up — these are related" |
| **Predictive Modeling** | `predict_disease_risk` | "Based on the last 3 times this temperature-salinity-density combination occurred, a Vibrio outbreak followed within 5 days" |
| **Root Cause Analysis** | `evaluate_tank_health` | "The mortality spike in Tank 7 is likely caused by the pH fluctuation from Tuesday's water treatment, not the feeding change" |
| **Multi-Variable Optimization** | `optimize_feeding_plan` | "Given current temperature trajectory, growth stage, DO levels, and cost constraints, the optimal feeding schedule for tomorrow is..." |
| **Anomaly Pattern Learning** | Closed-loop pipeline | "Tank 5 always shows DO dip on Fridays — this is learned as normal for this tenant" |
| **Inventory Forecasting** | `check_inventory_sufficiency` | "At current consumption rates and projected growth, feed stock X will be depleted in 12 days, but the next delivery is in 15 days" |
| **Action Planning** | `generate_action_items` | "Based on tomorrow's weather forecast and current tank conditions, here are 5 recommended actions prioritized by urgency" |
| **Regulatory Risk Assessment** | `calculate_compliance_status` | "Current growth trajectory will exceed permitted density in Tank 3 within 18 days unless a harvest or transfer is planned" |

#### Decision Boundary

```
 SENSOR DATA ARRIVES
        |
        v
 +------------------+
 | Backend Services  |  <-- Deterministic: threshold check, CRUD update
 | (Always runs)     |      If threshold breached: immediate alert
 +------------------+
        |
        | (data also flows to)
        v
 +------------------+
 | MCP AI Layer      |  <-- Probabilistic: pattern matching, prediction
 | (Async analysis)  |      If pattern detected: AI recommendation
 +------------------+
        |
        v
 +------------------+
 | User Interface    |  <-- Human reviews AI recommendation
 | (Decision point)  |      Takes action (or rejects/modifies)
 +------------------+
        |
        v
 +------------------+
 | Feedback Loop     |  <-- Outcome tracked, pattern confidence updated
 | (Learning)        |
 +------------------+
```

> **Critical Rule**: The backend threshold alert system NEVER depends on MCP availability. If the MCP server is down, all deterministic alerts continue to function normally. AI recommendations are degraded gracefully — the system shows "AI analysis temporarily unavailable" rather than failing silently.

### 3.2 Five AI Capability Layers

The AI system is organized into five capability layers, each building on the previous one. This enables incremental deployment, independent testing, and clear rollback boundaries.

```
 Layer 5: Decision Support          [Phase B + F]
   |   Harvest planning, transfer optimization, long-term strategy
   |
 Layer 4: Conversational AI          [Phase E]
   |   Natural language queries: "Why did Tank 3 mortality spike?"
   |
 Layer 3: Feeding Optimization       [Phase C]
   |   Daily AI-generated feeding plans, cost optimization
   |
 Layer 2: Proactive Alerts           [Phase D]
   |   Event-driven anomaly detection, predictive warnings
   |
 Layer 1: Passive Intelligence       [DONE - Existing MCP Tools]
      User asks, AI answers (get_tank_conditions, analyze_feeding_efficiency, etc.)
```

#### Layer 1: Passive Intelligence (DONE)

**Status**: Operational via existing MCP Farm Intelligence Server (13 tools deployed).

The user explicitly asks the AI a question, and the AI retrieves relevant data and provides an analysis. This is purely reactive — the AI does nothing unless prompted.

**Existing Tools**:
1. `get_tank_conditions` — Current sensor readings + species optimum comparison
2. `analyze_feeding_efficiency` — FCR, SGR, feed waste analysis
3. `get_stock_summary` — Biomass, count, density per tank
4. `get_mortality_analysis` — Mortality trends, cause distribution
5. `get_species_requirements` — Optimal parameter ranges from knowledge base
6. `analyze_water_quality_trends` — Time-series trend analysis for sensor data
7. `get_growth_performance` — Growth tracking vs. expected curves
8. `get_task_summary` — Pending/overdue task analysis
9. `analyze_feeding_schedule` — Feeding protocol adherence and optimization
10. `get_chemical_treatments` — Treatment history and scheduling
11. `get_harvest_readiness` — Market weight proximity analysis
12. `get_equipment_status` — Equipment health and maintenance needs
13. `get_farm_overview` — High-level multi-tank dashboard data

#### Layer 2: Proactive Alerts

**Trigger**: Event-driven (new sensor reading, stock change, weather update, task completion).

The AI monitors incoming events in the background and generates proactive notifications when it detects patterns that warrant attention. This is the first layer where the AI acts without being asked.

**Key Behaviors**:
- Listens to NATS events for sensor data, stock changes, feeding events
- Runs pattern matching against the tenant's learned pattern database
- Generates notifications only when confidence exceeds the tenant's configured threshold
- Respects quiet hours and notification preferences
- De-duplicates similar alerts within a configurable cooldown window (default: 4 hours)

**Example Proactive Alerts**:
- "Temperature in Tank 3 has been rising 0.2C/hour for the last 6 hours. At this rate, it will exceed the optimal range for Sea Bass in approximately 8 hours."
- "DO levels in Tanks 7 and 8 are both dropping simultaneously. This is unusual and may indicate an aeration system issue rather than a biological event."
- "Feeding in Tank 2 was skipped today. Based on this tank's current growth stage, a 24-hour feeding gap will not impact FCR significantly, but a second missed feeding would."

#### Layer 3: Feeding Optimization

**Trigger**: Daily scheduled job (configurable time, default 05:00 local time).

The AI generates a comprehensive daily feeding plan for all active tanks, taking into account 22 data sources to optimize feed quantity, timing, and type.

**Key Behaviors**:
- Runs every morning before the first feeding
- Produces a per-tank feeding plan with specific quantities, times, and feed types
- Highlights any tanks where it recommends deviating from the standard feeding protocol (with explanation)
- Calculates projected feed inventory impact
- Accounts for weather forecast (temperature affects metabolism and feed intake)
- Considers staff availability (simpler plans on understaffed days)
- Produces a cost-optimized alternative if multiple feed options are available

**Output Format**:
```
DAILY FEEDING PLAN — Farm: Aegean Sea Bass Unit — Date: 2026-03-25
Generated at: 05:00 — Confidence: 0.78 — Based on: 142 historical feeding events

Tank 1 (Sea Bass, 450g avg, 12,000 fish):
  06:00 — Feed A (3mm pellet) — 42 kg — Reason: Standard morning ration
  12:00 — Feed A (3mm pellet) — 38 kg — Reason: Reduced by 10% due to
           forecasted 28C water temp (metabolism adjustment)
  18:00 — Feed A (3mm pellet) — 35 kg — Reason: Evening reduction,
           DO typically drops after 17:00 in this tank

  DEVIATION FROM PROTOCOL: Standard protocol calls for 120kg/day total.
  AI recommends 115kg/day (-4.2%) based on yesterday's observed feed
  waste (camera/visual) and current temperature trend.

[... additional tanks ...]

INVENTORY IMPACT: Today's plan uses 892 kg total. Current stock: 12,400 kg.
Projected depletion at current rate: 13.9 days. Next delivery: 15 days.
WARNING: Feed stock may be insufficient. Consider placing order.
```

#### Layer 4: Conversational AI

**Trigger**: User initiates a natural language conversation through the chat interface.

The AI engages in multi-turn conversations about farm operations, explaining its reasoning, answering "why" questions, and providing contextual information.

**Key Behaviors**:
- Maintains conversation context across multiple messages
- References specific data points and timestamps in responses
- Explains confidence levels and reasoning transparently
- Can drill down from summary to detail on user request
- Supports follow-up questions ("What about Tank 5?" after discussing Tank 3)
- Multilingual support (Turkish and English for initial deployment)

**Example Conversation**:
```
User: "Tank 7'de son 3 gundur mortalite neden yukseliyor?"

AI: "Tank 7'de son 3 gunde toplam 47 olum kaydedildi (normal: ~8/3gun).
     Analiz sonuclari:
     1. Su kalitesi: pH 3 gun once 7.8'den 8.4'e yukseldi (su degisimi sonrasi)
     2. Zamanlama: Mortalite artisi pH yukselmesinden 36 saat sonra basladi
     3. Benzer pattern: Bu ciftlikte 2025-Ekim'de ayni durum yasandi
        (pH spike -> 36h delay -> mortalite artisi, o zaman 5 gunde normalize oldu)
     4. Hastalik riski: Dusuk (semptomlar pH stresiyle uyumlu, enfeksiyon belirtisi yok)

     Onerim (Guven: 0.74): Su degisim protokolunu yavaslatmak (partial water
     changes over 3 days instead of full change). Mortalite 2 gun icinde
     normalize olmasi bekleniyor."

User: "Ekim'deki olayda ne yapmistik?"

AI: "2025-10-14 olayinda: pH spike 8.6'ya kadar cikti. Ekip %50 su degisimi
     yapti ve 3 gunde normale dondu. Toplam kayip: 62 balik. Bu sefer erken
     yakaladik (pH 8.4), dolayisiyla daha az kayip bekliyorum."
```

#### Layer 5: Decision Support

**Trigger**: User-initiated analysis request OR scheduled strategic assessment (weekly/monthly).

The AI provides high-level strategic recommendations for harvest timing, stock transfers, capacity planning, and long-term optimization.

**Key Behaviors**:
- Harvest timing optimization (market price data + growth curves + density limits)
- Transfer recommendations between tanks (balance density, optimize growth conditions)
- Capacity planning for new stock arrivals
- Seasonal preparation suggestions (winter/summer protocol adjustments)
- Cost-benefit analysis for equipment upgrades (e.g., "Upgrading the aerator in Tank 3 would reduce your emergency DO events by an estimated 80%, saving approximately X TL/month in mortality losses")
- Regulatory compliance forecasting ("At current growth rates, Tank 5 will exceed the permitted 25 kg/m3 density by April 15")

### 3.3 Tenant-Isolated Learning Architecture

Data isolation is a non-negotiable requirement. Each tenant's AI knowledge evolves independently, and there must be zero possibility of cross-tenant data leakage.

```
+=========================================================+
|                SHARED (Read-Only)                        |
|                                                          |
|  species_knowledge_base                                  |
|  +---------------------------------------------------+  |
|  | species_id | parameter | optimal_min | optimal_max |  |
|  | sea_bass   | DO        | 6.0         | 8.5         |  |
|  | sea_bass   | temp      | 18.0        | 24.0        |  |
|  | sea_bass   | pH        | 7.5         | 8.3         |  |
|  | tilapia    | DO        | 4.0         | 7.5         |  |
|  | ...        | ...       | ...         | ...         |  |
|  +---------------------------------------------------+  |
|                                                          |
|  This is academic/reference data maintained by platform  |
|  administrators. Tenants cannot modify it.               |
+=========================================================+

+===========================+    +===========================+
|  TENANT SCHEMA: tenant_1  |    |  TENANT SCHEMA: tenant_2  |
|                           |    |                           |
|  ai_trajectories          |    |  ai_trajectories          |
|  +---------------------+  |    |  +---------------------+  |
|  | Event tracking       |  |    |  | Event tracking       |  |
|  | Per-tank timelines   |  |    |  | Per-tank timelines   |  |
|  | Sensor snapshots     |  |    |  | Sensor snapshots     |  |
|  +---------------------+  |    |  +---------------------+  |
|                           |    |                           |
|  ai_patterns              |    |  ai_patterns              |
|  +---------------------+  |    |  +---------------------+  |
|  | Learned patterns     |  |    |  | Learned patterns     |  |
|  | Confidence scores    |  |    |  | Confidence scores    |  |
|  | Activation status    |  |    |  | Activation status    |  |
|  +---------------------+  |    |  +---------------------+  |
|                           |    |                           |
|  ai_recommendations       |    |  ai_recommendations       |
|  +---------------------+  |    |  +---------------------+  |
|  | Recommendations      |  |    |  | Recommendations      |  |
|  | User feedback         |  |    |  | User feedback         |  |
|  | Outcome tracking     |  |    |  | Outcome tracking     |  |
|  +---------------------+  |    |  +---------------------+  |
|                           |    |                           |
|  Confidence scores are    |    |  Completely independent   |
|  specific to THIS tenant  |    |  learning trajectory      |
+===========================+    +===========================+
```

#### Isolation Guarantees

1. **Schema-Level Isolation**: AI tables reside in the tenant's schema (`tenant_{id}.ai_trajectories`, etc.). PostgreSQL's schema isolation combined with the platform's existing row-level security ensures no cross-tenant access.

2. **MCP Context Injection**: When the MCP server processes a request, the tenant ID is extracted from the authenticated session and injected into every database query. The MCP server never has access to data outside the requesting tenant's schema.

3. **Audit Logging**: Every AI data access (read or write to AI tables) is logged with tenant ID, user ID, timestamp, and operation type. These audit logs are stored in the platform's central audit schema and are available for compliance review.

4. **Pattern Portability (Admin-Only)**: Platform administrators can optionally promote a tenant's pattern to the shared species knowledge base (with the tenant's explicit consent). This is a manual, audited process — never automatic.

### 3.4 Closed-Loop Learning Pipeline

The learning pipeline is inspired by ruflo's ReasoningBank architecture, adapted for the aquaculture domain. Every AI reasoning cycle follows four explicit, auditable steps.

```
+------------------------------------------------------------------+
|                    CLOSED-LOOP LEARNING PIPELINE                  |
|                                                                   |
|  +-----------+    +--------+    +-----------+    +-------------+  |
|  |           |    |        |    |           |    |             |  |
|  | 1.RETRIEVE|--->|2.JUDGE |--->|3.RECOMMEND|--->|4.VERIFY &   |  |
|  |           |    |        |    |           |    |  LEARN      |  |
|  +-----------+    +--------+    +-----------+    +-------------+  |
|       ^                                                |          |
|       |                                                |          |
|       +------------------------------------------------+          |
|                     Feedback Loop                                 |
+------------------------------------------------------------------+
```

#### Step 1: RETRIEVE — Context Assembly

When an AI analysis is triggered (either by user request, event, or schedule), the first step is to retrieve all relevant context.

**Data Retrieved**:
- Current sensor readings for the affected tank(s)
- Historical sensor data for the relevant time window (default: 7 days)
- Species optimum parameters from the shared knowledge base
- Similar past patterns from this tenant's `ai_patterns` table (cosine similarity on parameter vectors)
- Recent recommendations and their outcomes from `ai_recommendations`
- Related data from other domains (feeding, stock, chemical treatments, weather, tasks)

**Pattern Matching Query** (conceptual):
```sql
SELECT p.pattern_id, p.description, p.confidence_score,
       p.last_triggered_at, p.total_occurrences,
       p.correct_predictions, p.false_positives
FROM tenant_{id}.ai_patterns p
WHERE p.is_active = true
  AND p.pattern_type = :detected_pattern_type
  AND p.species_id = :current_species
  AND p.confidence_score >= :minimum_confidence
ORDER BY similarity(p.parameter_vector, :current_vector) DESC
LIMIT 5;
```

#### Step 2: JUDGE — Situation Assessment

The MCP server evaluates the current situation against retrieved patterns and knowledge.

**Assessment Criteria**:
- Does the current parameter combination match any known pattern?
- If yes, what was the outcome when this pattern occurred before?
- How confident are we in this pattern? (based on historical accuracy for this tenant)
- Are there contradictory patterns? (e.g., one pattern suggests "normal" while another suggests "risk")
- What is the novelty score? (how different is this situation from anything seen before?)

**Conflict Resolution Rules**:
1. If multiple patterns match with conflicting recommendations, the highest-confidence pattern wins
2. If confidence scores are within 0.05 of each other, both are presented to the user
3. If no pattern matches (novelty score > 0.8), fall back to species knowledge base
4. If species knowledge base also has no guidance, the AI explicitly states "insufficient data for recommendation" rather than guessing

#### Step 3: RECOMMEND — Actionable Output

The AI generates a structured recommendation with full transparency.

**Recommendation Structure**:
```json
{
  "recommendation_id": "uuid",
  "tenant_id": "tenant_1",
  "created_at": "2026-03-24T10:30:00Z",
  "urgency": "HIGH",
  "category": "FEEDING_ADJUSTMENT",
  "confidence_score": 0.76,
  "summary": "Reduce feeding in Tank 3 by 15% for the next 48 hours",
  "detailed_reasoning": [
    "Water temperature has dropped 2.1C in 24 hours (from 22.3 to 20.2)",
    "Historical pattern P-0047 shows that temperature drops of >1.5C correlate with 20-30% reduction in feed intake for Sea Bass",
    "Pattern P-0047 has been correct 8 out of 11 times in your farm (confidence: 0.73)",
    "Current feeding rate is at 100% protocol. Predicted waste if unchanged: 12-18%"
  ],
  "recommended_actions": [
    {
      "action": "Reduce morning feeding from 42kg to 36kg",
      "tank_id": "tank_3",
      "timing": "Next feeding (06:00 tomorrow)"
    },
    {
      "action": "Reduce afternoon feeding from 38kg to 32kg",
      "tank_id": "tank_3",
      "timing": "12:00 tomorrow"
    }
  ],
  "expected_outcome": "Feed waste reduction, FCR improvement of ~0.05 over 48h",
  "pattern_references": ["P-0047"],
  "data_sources_used": ["sensor_readings", "feeding_protocol", "weather_forecast", "historical_patterns"],
  "requires_feedback": true,
  "feedback_deadline": "2026-03-26T10:30:00Z"
}
```

#### Step 4: VERIFY & LEARN — Outcome Tracking

After the user responds (feedback) and sufficient time passes (outcome window), the system verifies the result and updates pattern confidence.

**Verification Process**:
1. User provides feedback (applied/rejected/modified/deferred)
2. System records the feedback with timestamp and details
3. After the outcome window (configurable, default 48 hours):
   - If recommendation was applied: compare predicted outcome with actual outcome
   - If recommendation was rejected: observe what actually happened
   - If user applied an alternative: observe alternative's outcome
4. Update pattern confidence score based on outcome accuracy
5. If a new, previously unseen pattern is detected: create a new entry in `ai_patterns` with initial confidence 0.50
6. Log the complete trajectory in `ai_trajectories`

**Learning Update Rules**:
```
IF recommendation was applied AND outcome matched prediction:
    pattern.confidence += 0.02
    pattern.correct_predictions += 1

IF recommendation was applied AND outcome did NOT match:
    pattern.confidence -= 0.05
    pattern.false_positives += 1

IF recommendation was rejected AND problem resolved without action:
    pattern.confidence -= 0.05 (false alarm)
    pattern.false_positives += 1

IF recommendation was rejected AND problem worsened:
    pattern.confidence += 0.03 (user should have listened)
    Log escalation event

IF user applied alternative AND it worked better:
    Create new pattern from user's alternative
    Old pattern confidence -= 0.02
```

### 3.5 Mandatory Feedback System

Every AI recommendation requires explicit user feedback. This is not optional — it is the fuel for the learning pipeline. Without feedback, the system cannot improve and will stagnate at species knowledge base accuracy.

#### Feedback Options

| Option | Icon | Required Fields | Purpose |
|---|---|---|---|
| **Applied** | Checkmark | Which specific actions were taken | Confirms the recommendation was followed, enables outcome tracking |
| **Rejected** | Cross | Reason category (dropdown) + optional free text | Teaches the AI what was wrong about its recommendation |
| **Modified** | Pencil | What was done instead (free text) | Teaches the AI alternative approaches that the operator prefers |
| **Deferred** | Clock | Expected action date | Acknowledges the recommendation but delays action |

#### Rejection Reason Categories (Dropdown)

1. **Not applicable** — "This doesn't apply to my situation"
2. **Already handled** — "I already took care of this before your recommendation"
3. **Cost prohibitive** — "The recommended action is too expensive right now"
4. **Staffing unavailable** — "We don't have the staff to execute this now"
5. **Disagree with analysis** — "I think your reasoning is incorrect" (triggers detailed feedback form)
6. **Known issue** — "I know about this and it's expected/acceptable"
7. **Other** — Free text explanation

#### Deferral Rules

- Maximum 2 deferrals per recommendation
- Each deferral extends the feedback deadline by 48 hours
- After 2 deferrals (total 96 hours from original recommendation), the recommendation auto-times out
- Timed-out recommendations are recorded as "NO_RESPONSE" in the learning pipeline
- Three consecutive NO_RESPONSE events trigger a notification to the farm manager:
  *"AI recommendations have been going unanswered. The system learns from your feedback — without it, prediction accuracy cannot improve."*

#### Feedback UX Design

```
+----------------------------------------------------------+
|  AI RECOMMENDATION                            HIGH URGENCY |
|  -------------------------------------------------------- |
|  Reduce feeding in Tank 3 by 15% for 48 hours            |
|                                                            |
|  Confidence: 76%  |  Based on: 11 similar events          |
|                                                            |
|  [View Full Analysis]                                      |
|                                                            |
|  +----------+ +----------+ +----------+ +----------+      |
|  | Applied  | | Rejected | | Modified | | Defer    |      |
|  +----------+ +----------+ +----------+ +----------+      |
|                                                            |
|  Response required by: Mar 26, 10:30                       |
+----------------------------------------------------------+
```

### 3.6 Active Follow-Up (AI as Investigator)

The AI does not simply fire-and-forget recommendations. It actively follows up to verify outcomes and close the learning loop, even in cases where the user did not interact with the recommendation.

#### Follow-Up Timeline

```
T+0h:  Recommendation generated and delivered to user
       |
T+2h:  (If no response) Gentle reminder notification
       |
T+48h: AUTOMATIC SENSOR VERIFICATION
       |
       +-- Scenario A: Problem resolved + user applied recommendation
       |   -> Log: correct prediction, confidence += 0.02
       |
       +-- Scenario B: Problem resolved WITHOUT user action
       |   -> AI asks: "The issue in Tank 3 seems to have resolved on its
       |      own. Can you tell me what happened? This helps me learn."
       |   -> Options: "It was temporary", "Someone else handled it",
       |      "Environmental change", "I don't know"
       |
       +-- Scenario C: Problem persists + user rejected recommendation
       |   -> Escalation: "The issue in Tank 3 is still present 48 hours
       |      after my recommendation was declined. Current status: [data].
       |      Would you like to reconsider?"
       |
       +-- Scenario D: Problem worsened + user rejected recommendation
       |   -> Escalation (elevated): "Conditions in Tank 3 have worsened.
       |      [Current vs 48h ago comparison]. Recommend immediate review."
       |   -> Notify farm manager if original user was not the manager
       |
       +-- Scenario E: User applied alternative that worked
       |   -> AI asks: "Your approach worked well. Can you briefly describe
       |      what you did? I'll learn this for future similar situations."
       |   -> Create new pattern from user's approach
       |
T+96h: If still no feedback: auto-timeout, log as NO_RESPONSE
       |
T+168h (1 week): Long-term outcome assessment for slow-developing issues
       (e.g., growth rate changes, FCR trends)
```

#### "What Happened?" Dialog

When the AI detects that a situation resolved without tracked user intervention, it presents a brief investigation dialog:

```
+----------------------------------------------------------+
|  AI FOLLOW-UP                                   Tank 3    |
|  -------------------------------------------------------- |
|  48 hours ago, I flagged a rising temperature trend.      |
|  The temperature has now stabilized at 21.8C.             |
|                                                            |
|  I didn't see any recorded actions. What happened?        |
|                                                            |
|  ( ) Weather changed naturally                             |
|  ( ) Someone adjusted the system (not recorded in app)     |
|  ( ) It was a sensor glitch                                |
|  ( ) I don't know                                          |
|  ( ) Other: [free text]                                    |
|                                                            |
|  [Submit]    [Skip - I'm busy]                             |
+----------------------------------------------------------+
```

This dialog serves two purposes:
1. It helps the AI learn whether its alert was a true positive or false positive
2. It gently encourages users to record actions in the system (improving data quality over time)

### 3.7 Confidence Score Model

Confidence scores are the gatekeeper for AI recommendation quality. They evolve independently per pattern per tenant, ensuring that the AI's self-assessment accurately reflects its track record for each specific farm.

#### Confidence Score Lifecycle

```
PHASE              TIMELINE        SCORE RANGE    DATA POINTS
-----------------------------------------------------------------
Initial            Day 0           0.50           0 events
(Species KB only)                                 (pure academic data)

Early Learning     0-3 months      0.50 - 0.65    1-10 events
                                                   (learning farm patterns)

Growing            3-6 months      0.65 - 0.80    10-50 events
Confidence                                         (patterns stabilizing)

Mature             6-12 months     0.80 - 0.92    50-200 events
                                                   (reliable predictions)

Expert             12+ months      0.85 - 0.95    200+ events
                                                   (highly tuned to farm)
```

#### Confidence Update Rules

| Event | Score Change | Rationale |
|---|---|---|
| Correct prediction (applied, outcome matched) | +0.02 | Slow growth prevents overconfidence |
| Correct prediction (rejected, problem worsened as predicted) | +0.03 | Stronger signal — AI was right, user was wrong |
| Wrong prediction (applied, outcome did NOT match) | -0.05 | Fast decay to quickly suppress bad patterns |
| False positive (alert triggered, nothing actually wrong) | -0.05 | Fast decay for false alarms |
| User alternative worked better | -0.02 | Mild penalty — AI's approach wasn't wrong, just suboptimal |
| No feedback received | -0.01 | Tiny decay to gradually suppress ignored recommendations |

#### Confidence Thresholds

| Threshold | Behavior |
|---|---|
| >= 0.80 | Full recommendation with prominent notification |
| 0.65 - 0.79 | Standard recommendation |
| 0.50 - 0.64 | Informational notice (lower prominence in UI) |
| < 0.50 | Pattern suppressed — not shown to user |
| 3 consecutive false positives | Pattern automatically disabled for this tenant |

#### Pattern Disability and Recovery

When a pattern is disabled (3 consecutive false positives), it enters a "quarantine" state:

1. Pattern is marked `is_active = false` with `disabled_reason = 'consecutive_false_positives'`
2. Pattern remains in the database (not deleted) for audit purposes
3. After 30 days, the system can attempt a single "probe" — if the pattern would have triggered, it runs silently (no user notification) and checks the outcome
4. If the silent probe is correct, the pattern is re-enabled at confidence 0.50 (fresh start)
5. If the silent probe is wrong, the quarantine period resets to 30 days
6. Platform administrators can manually re-enable or permanently disable any pattern

---

## 4. Data Sources (22 Data Points)

The AI system ingests data from 22 distinct sources, organized into four domains. Each data source has a defined refresh rate, source service, and relevance weight.

### Domain A: Biological Parameters (6 sources)

| # | Data Source | Source Service | Refresh Rate | Description |
|---|---|---|---|---|
| 1 | **Species Optimum Parameters** | farm-service (knowledge base) | Static | Temperature, DO, pH, salinity, ammonia optimal ranges per species per life stage |
| 2 | **Tank Density (Current)** | farm-service (stock) | On stock change | Current biomass (kg) / tank volume (m3) — critical for stress assessment |
| 3 | **Mortality Trend** | farm-service (mortality) | On event | Daily/weekly mortality counts, cause distribution, trend direction |
| 4 | **SGR (Specific Growth Rate)** | farm-service (sampling) | On sampling | Actual growth rate vs. expected growth curve — early indicator of stress |
| 5 | **FCR (Feed Conversion Ratio)** | farm-service (feeding + sampling) | On sampling | Feed efficiency — rising FCR often indicates health or environmental issues |
| 6 | **Disease Profile** | farm-service (health) | On event | Active disease diagnoses, treatment history, recovery timeline |

### Domain B: Environmental Parameters (6 sources)

| # | Data Source | Source Service | Refresh Rate | Description |
|---|---|---|---|---|
| 7 | **Sensor Readings (Real-time)** | sensor-service | Continuous (1-15 min) | Temperature, DO, pH, salinity, ammonia, turbidity, ORP from all sensors |
| 8 | **Weather Forecast** | External API (via config-service) | Every 6 hours | 48h weather forecast: air temperature, precipitation, wind, barometric pressure |
| 9 | **Oxygen Budget** | Calculated (sensor + stock) | Hourly | Available oxygen vs. biological oxygen demand per tank — critical safety metric |
| 10 | **Water Treatment Schedule** | farm-service (treatments) | On event | Upcoming and recent water changes, chemical additions, UV treatments |
| 11 | **Neighbor Tank Effect** | sensor-service (multi-tank) | On sensor reading | Cross-tank environmental influence: shared water intake, adjacent tank conditions |
| 12 | **Equipment Status** | farm-service (equipment) | On event + scheduled | Aerator runtime, pump status, filter condition, generator availability |

### Domain C: Operational Parameters (6 sources)

| # | Data Source | Source Service | Refresh Rate | Description |
|---|---|---|---|---|
| 13 | **Feeding Protocol (Active)** | farm-service (feeding) | On change | Current feeding schedule: times, quantities, feed types per tank |
| 14 | **Feed Impact Analysis** | farm-service (feeding + sensor) | Post-feeding | Sensor response to feeding events: DO dip after feeding, ammonia spike timing |
| 15 | **Weekly Feed Stock** | farm-service (inventory) | Daily | Available feed by type, consumption rate, projected depletion date |
| 16 | **Chemical Stock** | farm-service (inventory) | On usage | Available treatment chemicals, usage rate, minimum stock thresholds |
| 17 | **Medicine Stock** | farm-service (inventory) | On usage | Available medicines, dosing requirements for active treatments |
| 18 | **Staff Availability** | hr-service | Daily | Shift schedules, leave calendar, qualified staff per task type |

### Domain D: Strategic Parameters (4 sources)

| # | Data Source | Source Service | Refresh Rate | Description |
|---|---|---|---|---|
| 19 | **Task Backlog** | farm-service (tasks) | On change | Pending and overdue tasks, priority distribution, assignment status |
| 20 | **Harvest Plan Proximity** | farm-service (harvest) | Weekly | Days until planned harvest per tank, market weight targets, readiness percentage |
| 21 | **Cost Optimization Data** | billing-service | Monthly | Feed costs, chemical costs, energy costs, labor costs per tank per kg produced |
| 22 | **Regulatory Compliance** | farm-service (compliance) | On change | Current compliance status, upcoming inspections, maximum permitted density/chemical levels |

### Data Source Priority Matrix

When computing recommendations, data sources are weighted by relevance to the decision type:

```
                   Emergency  Feeding  Stock   Growth  Disease  Task   Cost   Compliance
Species Optimum    HIGH       HIGH     MED     HIGH    HIGH     LOW    LOW    MED
Sensor Readings    CRITICAL   HIGH     MED     MED     HIGH     LOW    LOW    MED
Density            HIGH       HIGH     CRIT    HIGH    MED      LOW    MED    HIGH
Mortality          HIGH       LOW      HIGH    MED     CRIT     MED    MED    MED
FCR/SGR            LOW        HIGH     MED     CRIT    MED      LOW    HIGH   LOW
Weather            MED        HIGH     LOW     MED     MED      MED    LOW    LOW
Feed Stock         LOW        CRIT     HIGH    LOW     LOW      HIGH   HIGH   LOW
Staff              LOW        MED      LOW     LOW     LOW      HIGH   LOW    MED
Harvest Plan       LOW        MED      HIGH    HIGH    LOW      MED    HIGH   MED
```

---

## 5. AI Decision Types (8 Categories)

Each AI recommendation falls into one of eight mutually exclusive categories. The category determines notification urgency, required response time, and which users are notified.

### Category Definitions

| # | Category | Icon | Urgency | Response Deadline | Notify |
|---|---|---|---|---|---|
| 1 | **Emergency Intervention** | Red Circle | CRITICAL | 1 hour | All farm staff + manager + SMS |
| 2 | **Feeding Adjustment** | Yellow Circle | HIGH | 4 hours (before next feeding) | Feeding staff + manager |
| 3 | **Stock Warning** | Green Circle | MEDIUM | 24 hours | Manager + stock team |
| 4 | **Growth Prediction** | Blue Circle | LOW | 48 hours | Manager |
| 5 | **Disease Risk** | Orange Circle | HIGH | 4 hours | Health team + manager |
| 6 | **Task Suggestion** | White Circle | LOW | 48 hours | Relevant assignee |
| 7 | **Cost Optimization** | Money | LOW | 1 week | Manager + finance |
| 8 | **Compliance Warning** | Balance | MEDIUM-HIGH | 24 hours | Manager + compliance officer |

### Detailed Category Descriptions

#### 1. Emergency Intervention (CRITICAL)

Situations requiring immediate human attention to prevent stock loss or equipment damage.

**Triggers**:
- DO predicted to drop below critical threshold within 2 hours
- Multiple sensors in the same zone showing simultaneous anomalies (equipment failure indicator)
- Rapid temperature change (>2C/hour) detected
- Ammonia spike above emergency threshold with rising trend
- Power failure detected with backup generator not responding

**Example**: *"EMERGENCY: DO in Tank 3 has dropped to 4.2 mg/L and is falling at 0.3 mg/L per hour. At this rate, it will reach the lethal threshold (3.0 mg/L) for Sea Bass in approximately 4 hours. The aerator in Zone B appears to be underperforming (current output 30% below normal). Recommended immediate action: activate backup aerator and inspect Zone B primary aerator."*

#### 2. Feeding Adjustment (HIGH)

Recommendations to modify feeding quantities, timing, or feed type based on current conditions.

**Triggers**:
- Temperature change affecting metabolism
- Post-treatment feeding modification needed
- Feed waste detected (uneaten feed, elevated ammonia post-feeding)
- Growth stage transition requiring protocol update
- Weather forecast indicating metabolism change

**Example**: *"Water temperature in Tank 5 has dropped from 22C to 19C over the last 3 days. Based on 8 similar events at your farm, Sea Bass feeding should be reduced by approximately 20% until temperature stabilizes. Recommended: reduce from 120kg/day to 96kg/day."*

#### 3. Stock Warning (MEDIUM)

Alerts about stock density, biomass changes, or transfer/harvest timing.

**Triggers**:
- Density approaching regulatory limit
- Significant unreported biomass change detected (sensor-based estimation vs records)
- Transfer recommended to balance tank utilization
- Incoming stock requiring preparation

**Example**: *"Tank 2 density is currently 22.3 kg/m3. At the current growth rate (SGR 1.2%), it will exceed the permitted 25 kg/m3 in approximately 16 days. Recommend scheduling a partial harvest or transfer of 2,000 fish to Tank 9 (currently at 14 kg/m3)."*

#### 4. Growth Prediction (LOW)

Informational predictions about growth trajectories and market readiness.

**Triggers**:
- Weekly growth assessment
- Market weight proximity update
- Growth rate deviation from expected curve

**Example**: *"Based on current SGR and environmental conditions, Tank 1 fish are projected to reach market weight (400g) by approximately May 12 — 8 days ahead of the original plan. This is likely due to the consistently optimal temperatures this month."*

#### 5. Disease Risk (HIGH)

Predictive alerts about potential disease outbreaks based on environmental and behavioral patterns.

**Triggers**:
- Environmental conditions matching historical disease outbreak patterns
- Mortality pattern resembling early-stage disease
- Post-treatment relapse indicators
- Neighboring farm disease reports (if integrated)

**Example**: *"Environmental conditions in Tanks 6-8 (temperature 24.2C, salinity dropping, high density) match the pattern seen before the September 2025 Vibriosis outbreak at your farm. Current risk assessment: 35% probability within 7 days. Recommend: prophylactic water quality improvement (partial water change) and increased monitoring frequency."*

#### 6. Task Suggestion (LOW)

Proactive suggestions for tasks that should be scheduled based on conditions and timing.

**Triggers**:
- Overdue maintenance detected
- Optimal sampling window identified
- Pre-harvest preparation timeline
- Seasonal protocol change needed

**Example**: *"Tank 4 has not been sampled in 21 days (protocol recommends every 14 days). Given the recent feeding adjustment, a growth check would be valuable to verify the current SGR estimate. Suggested: schedule sampling for this week."*

#### 7. Cost Optimization (LOW)

Suggestions to reduce operational costs without compromising fish welfare.

**Triggers**:
- Feed cost comparison across available products
- Energy optimization opportunities
- Inventory ordering optimization
- Labor scheduling efficiency

**Example**: *"Switching from Feed Brand A (3.2 TL/kg) to Feed Brand B (2.8 TL/kg) for Tanks 1-4 could save approximately 1,200 TL/month. Based on your FCR data, both brands perform similarly for Sea Bass at this growth stage. Note: Brand B has slightly lower protein content (42% vs 44%) — monitor SGR for the first 2 weeks after switching."*

#### 8. Compliance Warning (MEDIUM-HIGH)

Alerts about current or upcoming regulatory compliance issues.

**Triggers**:
- Density limit approach
- Chemical usage limit approach
- Reporting deadline approaching
- Environmental discharge parameter deviation

**Example**: *"Upcoming regulatory inspection scheduled for April 5. Current status: 7 of 8 compliance parameters are within limits. Issue: Tank 3 copper treatment from March 15 is still within the 30-day discharge restriction period. Ensure discharge valve for Tank 3 remains closed until April 14."*

---

## 6. New MCP Tools Required

Six new MCP tools are required to support the AI capability layers. These tools extend the existing 13-tool MCP Farm Intelligence Server.

### Tool 14: `evaluate_tank_health`

**Purpose**: Comprehensive multi-parameter health assessment combining all 22 data sources for a given tank or set of tanks.

**Input Parameters**:
```typescript
interface EvaluateTankHealthInput {
  tankIds: string[];            // One or more tank IDs (empty = all active tanks)
  depth: 'quick' | 'standard' | 'deep';  // Analysis depth
  timeWindow?: string;          // Lookback period (default: '7d')
  includeNeighborAnalysis?: boolean;      // Include adjacent tank correlation
}
```

**Output**:
```typescript
interface TankHealthReport {
  tankId: string;
  overallScore: number;              // 0-100 health score
  category: 'EXCELLENT' | 'GOOD' | 'ATTENTION' | 'WARNING' | 'CRITICAL';
  parameterScores: {
    waterQuality: number;
    stockHealth: number;
    feedingEfficiency: number;
    environmentalStability: number;
  };
  anomalies: Anomaly[];
  correlations: CrossDomainCorrelation[];
  comparisonToBaseline: BaselineComparison;
  recommendations: ActionItem[];
}
```

**When Used**: Layer 2 (proactive monitoring), Layer 5 (strategic assessment), and on-demand via Layer 4 (chat).

### Tool 15: `predict_disease_risk`

**Purpose**: Assess the probability of disease outbreak based on current conditions, historical patterns, and known disease triggers.

**Input Parameters**:
```typescript
interface PredictDiseaseRiskInput {
  tankIds: string[];
  speciesId: string;
  timeHorizon: '48h' | '7d' | '14d' | '30d';
  includeHistoricalOutbreaks?: boolean;
}
```

**Output**:
```typescript
interface DiseaseRiskReport {
  tankId: string;
  overallRisk: number;                // 0.0 - 1.0
  riskLevel: 'NEGLIGIBLE' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  diseaseRisks: {
    diseaseName: string;
    probability: number;
    triggerFactors: string[];
    historicalOccurrences: number;
    lastOccurrence: Date | null;
    preventiveActions: string[];
  }[];
  environmentalRiskFactors: {
    factor: string;
    currentValue: number;
    riskThreshold: number;
    trend: 'IMPROVING' | 'STABLE' | 'WORSENING';
  }[];
  recommendedMonitoring: {
    parameter: string;
    currentFrequency: string;
    recommendedFrequency: string;
    reason: string;
  }[];
}
```

**When Used**: Layer 2 (event-driven disease monitoring), Layer 5 (periodic health assessment).

### Tool 16: `optimize_feeding_plan`

**Purpose**: Generate an optimized daily feeding plan for all active tanks, considering current conditions, growth targets, inventory constraints, and cost optimization.

**Input Parameters**:
```typescript
interface OptimizeFeedingPlanInput {
  date: string;                      // Target date (ISO format)
  farmId: string;
  optimizationGoal: 'GROWTH' | 'FCR' | 'COST' | 'BALANCED';
  constraints?: {
    maxBudgetPerDay?: number;        // TL
    availableFeedTypes?: string[];
    staffAvailable?: number;         // Number of feeding staff
    weatherConsideration?: boolean;
  };
}
```

**Output**:
```typescript
interface FeedingPlan {
  date: string;
  farmId: string;
  confidence: number;
  totalFeedKg: number;
  totalCost: number;
  tankPlans: {
    tankId: string;
    speciesId: string;
    currentAvgWeight: number;
    feedings: {
      time: string;
      feedType: string;
      quantityKg: number;
      reason: string;
      deviationFromProtocol: string | null;
    }[];
    dailyTotal: number;
    protocolTotal: number;
    deviationPercent: number;
    expectedWaste: number;
  }[];
  inventoryImpact: {
    feedType: string;
    currentStock: number;
    usageToday: number;
    projectedDepletionDays: number;
    reorderNeeded: boolean;
  }[];
  costComparison: {
    protocolCost: number;
    optimizedCost: number;
    savings: number;
    savingsPercent: number;
  };
}
```

**When Used**: Layer 3 (daily scheduled feeding optimization).

### Tool 17: `check_inventory_sufficiency`

**Purpose**: Analyze current inventory levels (feed, chemicals, medicines) against projected consumption and generate procurement recommendations.

**Input Parameters**:
```typescript
interface CheckInventorySufficiencyInput {
  farmId: string;
  forecastDays: number;             // How far ahead to project (default: 30)
  categories?: ('FEED' | 'CHEMICAL' | 'MEDICINE' | 'EQUIPMENT_PARTS')[];
}
```

**Output**:
```typescript
interface InventorySufficiencyReport {
  farmId: string;
  assessmentDate: string;
  forecastDays: number;
  items: {
    itemId: string;
    itemName: string;
    category: string;
    currentStock: number;
    unit: string;
    dailyConsumptionRate: number;
    projectedDepletionDate: string;
    daysRemaining: number;
    minimumStockThreshold: number;
    status: 'SUFFICIENT' | 'LOW' | 'CRITICAL' | 'OUT_OF_STOCK';
    reorderRecommendation: {
      orderBy: string;          // Date to place order (accounting for lead time)
      quantity: number;
      estimatedCost: number;
      leadTimeDays: number;
    } | null;
  }[];
  alerts: {
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    message: string;
    relatedItems: string[];
  }[];
}
```

**When Used**: Layer 3 (inventory impact of feeding plans), Layer 5 (strategic procurement planning).

### Tool 18: `generate_action_items`

**Purpose**: Produce a prioritized list of recommended actions for the next 24-48 hours based on comprehensive analysis of all data sources.

**Input Parameters**:
```typescript
interface GenerateActionItemsInput {
  farmId: string;
  timeHorizon: '24h' | '48h' | '7d';
  includeRoutine?: boolean;          // Include routine tasks (default: false)
  maxItems?: number;                 // Maximum action items to generate (default: 10)
  focusAreas?: ('WATER_QUALITY' | 'FEEDING' | 'STOCK' | 'EQUIPMENT' | 'COMPLIANCE')[];
}
```

**Output**:
```typescript
interface ActionItemList {
  farmId: string;
  generatedAt: string;
  timeHorizon: string;
  confidence: number;
  items: {
    rank: number;
    category: string;               // One of the 8 AI decision types
    urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    description: string;
    reasoning: string[];
    affectedTanks: string[];
    estimatedTime: string;          // "15 min", "1 hour", etc.
    assigneeSuggestion: string;     // Role-based suggestion
    deadline: string;
    dependencies: string[];         // Other action items that should be done first
    relatedRecommendationId: string | null;
  }[];
  summary: {
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    estimatedTotalTime: string;
    staffRequired: number;
  };
}
```

**When Used**: Layer 2 (proactive daily briefing), Layer 4 (chat: "What should we focus on today?"), Layer 5 (strategic planning).

### Tool 19: `calculate_compliance_status`

**Purpose**: Assess current regulatory compliance status across all parameters and predict future compliance risks.

**Input Parameters**:
```typescript
interface CalculateComplianceStatusInput {
  farmId: string;
  jurisdictionId?: string;          // Regulatory jurisdiction (default: farm's registered jurisdiction)
  forecastDays?: number;            // How far ahead to predict compliance risks (default: 30)
  includeReportingDeadlines?: boolean;
}
```

**Output**:
```typescript
interface ComplianceStatusReport {
  farmId: string;
  jurisdiction: string;
  assessmentDate: string;
  overallStatus: 'COMPLIANT' | 'AT_RISK' | 'NON_COMPLIANT';
  parameters: {
    parameterName: string;
    currentValue: number | string;
    permittedLimit: number | string;
    status: 'COMPLIANT' | 'WARNING' | 'VIOLATION';
    marginPercent: number;            // How close to the limit (negative = over limit)
    trend: 'IMPROVING' | 'STABLE' | 'WORSENING';
    predictedViolationDate: string | null;
    affectedTanks: string[];
    remediationSuggestion: string | null;
  }[];
  upcomingDeadlines: {
    deadline: string;
    description: string;
    status: 'ON_TRACK' | 'AT_RISK' | 'OVERDUE';
    requiredActions: string[];
  }[];
  auditReadiness: {
    score: number;                    // 0-100
    missingDocuments: string[];
    expiredCertifications: string[];
    recommendedPreparations: string[];
  };
}
```

**When Used**: Layer 2 (compliance monitoring), Layer 5 (audit preparation).

---

## 7. Database Schema (Per-Tenant)

Three new tables are introduced in each tenant's schema to support the self-learning pipeline. These tables follow the existing TypeORM entity conventions (camelCase column names, UUID primary keys, automatic timestamps).

### Table 1: `ai_trajectories`

Tracks every AI analysis event from trigger through outcome. This is the complete audit trail of AI reasoning.

```sql
-- Created in each tenant schema: tenant_{id}.ai_trajectories

CREATE TABLE ai_trajectories (
    "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId"              UUID NOT NULL,
    "tankId"                UUID,                          -- NULL for farm-level analysis
    "farmId"                UUID NOT NULL,
    "triggerType"           VARCHAR(50) NOT NULL,          -- 'SENSOR_EVENT', 'SCHEDULE', 'USER_REQUEST', 'FOLLOW_UP'
    "triggerSource"         VARCHAR(100) NOT NULL,         -- e.g., 'sensor:DO:tank_3', 'cron:daily_feeding', 'user:chat'
    "triggerPayload"        JSONB,                         -- Raw trigger data snapshot
    "analysisType"          VARCHAR(50) NOT NULL,          -- 'HEALTH_CHECK', 'FEEDING_OPT', 'DISEASE_RISK', etc.
    "dataSourcesUsed"       TEXT[] NOT NULL,               -- Array of data source identifiers
    "sensorSnapshot"        JSONB NOT NULL,                -- Sensor readings at time of analysis
    "contextSnapshot"       JSONB,                         -- Additional context (stock, feeding, weather, etc.)
    "patternsMatched"       UUID[],                        -- Array of ai_patterns.id that matched
    "patternsConsidered"    INTEGER NOT NULL DEFAULT 0,    -- How many patterns were evaluated
    "noveltyScore"          DECIMAL(4,3),                  -- 0.000-1.000 how novel this situation is
    "reasoningChain"        JSONB NOT NULL,                -- Step-by-step reasoning log
    "recommendationId"      UUID,                          -- FK to ai_recommendations (NULL if no recommendation generated)
    "outcome"               VARCHAR(30),                   -- 'CORRECT', 'INCORRECT', 'PARTIALLY_CORRECT', 'INCONCLUSIVE', 'PENDING'
    "outcomeDetails"        JSONB,                         -- Detailed outcome data
    "outcomeVerifiedAt"     TIMESTAMPTZ,                   -- When outcome was assessed
    "processingTimeMs"      INTEGER,                       -- How long the analysis took
    "mcpToolsInvoked"       TEXT[],                        -- Which MCP tools were called
    "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX "IDX_ai_trajectories_tankId" ON ai_trajectories("tankId");
CREATE INDEX "IDX_ai_trajectories_farmId" ON ai_trajectories("farmId");
CREATE INDEX "IDX_ai_trajectories_triggerType" ON ai_trajectories("triggerType");
CREATE INDEX "IDX_ai_trajectories_analysisType" ON ai_trajectories("analysisType");
CREATE INDEX "IDX_ai_trajectories_outcome" ON ai_trajectories("outcome");
CREATE INDEX "IDX_ai_trajectories_createdAt" ON ai_trajectories("createdAt");
CREATE INDEX "IDX_ai_trajectories_patternsMatched" ON ai_trajectories USING GIN("patternsMatched");
```

### Table 2: `ai_patterns`

Stores learned patterns with per-tenant confidence scores. This is the core of the self-learning system — the "memory" that makes the AI smarter over time for each specific farm.

```sql
-- Created in each tenant schema: tenant_{id}.ai_patterns

CREATE TABLE ai_patterns (
    "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId"              UUID NOT NULL,
    "farmId"                UUID NOT NULL,
    "speciesId"             UUID,                          -- NULL for species-independent patterns
    "patternType"           VARCHAR(50) NOT NULL,          -- 'ENVIRONMENTAL', 'FEEDING', 'DISEASE', 'MORTALITY', 'EQUIPMENT', 'SEASONAL', 'BEHAVIORAL'
    "patternSubtype"        VARCHAR(100),                  -- e.g., 'FRIDAY_DO_DIP', 'POST_TREATMENT_FCR_SPIKE'
    "description"           TEXT NOT NULL,                  -- Human-readable description
    "triggerConditions"     JSONB NOT NULL,                -- Machine-readable trigger conditions
    "parameterVector"       VECTOR(32),                    -- Embedding for similarity search (pgvector)
    "expectedOutcome"       JSONB NOT NULL,                -- What this pattern predicts will happen
    "recommendedAction"     JSONB,                         -- What the AI recommends when this pattern triggers
    "confidenceScore"       DECIMAL(4,3) NOT NULL DEFAULT 0.500,  -- 0.000-1.000
    "totalOccurrences"      INTEGER NOT NULL DEFAULT 0,
    "correctPredictions"    INTEGER NOT NULL DEFAULT 0,
    "falsePositives"        INTEGER NOT NULL DEFAULT 0,
    "consecutiveFalsePos"   INTEGER NOT NULL DEFAULT 0,    -- Reset on correct prediction
    "isActive"              BOOLEAN NOT NULL DEFAULT TRUE,
    "disabledReason"        VARCHAR(100),                  -- 'CONSECUTIVE_FALSE_POSITIVES', 'ADMIN_DISABLED', 'CONFIDENCE_DECAY'
    "disabledAt"            TIMESTAMPTZ,
    "quarantineUntil"       TIMESTAMPTZ,                   -- For disabled patterns: when to attempt silent probe
    "source"                VARCHAR(30) NOT NULL DEFAULT 'LEARNED',  -- 'SPECIES_KB', 'LEARNED', 'USER_TAUGHT', 'ADMIN_PROMOTED'
    "sourcePatternId"       UUID,                          -- If derived from species KB or another pattern
    "lastTriggeredAt"       TIMESTAMPTZ,
    "lastCorrectAt"         TIMESTAMPTZ,
    "lastFalsePositiveAt"   TIMESTAMPTZ,
    "applicableTanks"       UUID[],                        -- NULL = all tanks, or specific tank IDs
    "seasonalRelevance"     VARCHAR(20)[],                 -- ['WINTER', 'SPRING', 'SUMMER', 'FALL'] or NULL for all
    "metadata"              JSONB,                         -- Additional pattern metadata
    "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for pattern matching
CREATE INDEX "IDX_ai_patterns_farmId" ON ai_patterns("farmId");
CREATE INDEX "IDX_ai_patterns_speciesId" ON ai_patterns("speciesId");
CREATE INDEX "IDX_ai_patterns_patternType" ON ai_patterns("patternType");
CREATE INDEX "IDX_ai_patterns_isActive" ON ai_patterns("isActive");
CREATE INDEX "IDX_ai_patterns_confidenceScore" ON ai_patterns("confidenceScore");
CREATE INDEX "IDX_ai_patterns_source" ON ai_patterns("source");
CREATE INDEX "IDX_ai_patterns_parameterVector" ON ai_patterns USING ivfflat("parameterVector" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX "IDX_ai_patterns_triggerConditions" ON ai_patterns USING GIN("triggerConditions");
CREATE INDEX "IDX_ai_patterns_applicableTanks" ON ai_patterns USING GIN("applicableTanks");
```

### Table 3: `ai_recommendations`

Stores every recommendation generated by the AI, along with user feedback and outcome tracking. This table is the primary feedback loop data store.

```sql
-- Created in each tenant schema: tenant_{id}.ai_recommendations

CREATE TABLE ai_recommendations (
    "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId"              UUID NOT NULL,
    "farmId"                UUID NOT NULL,
    "tankId"                UUID,                          -- NULL for farm-level recommendations
    "trajectoryId"          UUID NOT NULL REFERENCES ai_trajectories("id"),
    "category"              VARCHAR(30) NOT NULL,          -- 'EMERGENCY', 'FEEDING_ADJUSTMENT', 'STOCK_WARNING', 'GROWTH_PREDICTION', 'DISEASE_RISK', 'TASK_SUGGESTION', 'COST_OPTIMIZATION', 'COMPLIANCE_WARNING'
    "urgency"               VARCHAR(15) NOT NULL,          -- 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
    "confidenceScore"       DECIMAL(4,3) NOT NULL,
    "summary"               TEXT NOT NULL,                  -- Short summary for notification
    "detailedReasoning"     JSONB NOT NULL,                -- Array of reasoning steps
    "recommendedActions"    JSONB NOT NULL,                -- Array of structured actions
    "expectedOutcome"       TEXT,                          -- What should happen if recommendation is followed
    "patternReferences"     UUID[],                        -- ai_patterns.id references
    "dataSourcesUsed"       TEXT[],                        -- Which of the 22 data sources contributed

    -- Notification tracking
    "notifiedAt"            TIMESTAMPTZ,                   -- When notification was sent
    "notificationChannels"  TEXT[],                        -- 'PUSH', 'SMS', 'EMAIL', 'IN_APP'
    "notifiedUsers"         UUID[],                        -- User IDs who received notification
    "readAt"                TIMESTAMPTZ,                   -- When first user opened it
    "readByUserId"          UUID,                          -- Who opened it first

    -- Feedback
    "feedbackStatus"        VARCHAR(20) NOT NULL DEFAULT 'PENDING',  -- 'PENDING', 'APPLIED', 'REJECTED', 'MODIFIED', 'DEFERRED', 'TIMED_OUT', 'NO_RESPONSE'
    "feedbackAt"            TIMESTAMPTZ,
    "feedbackByUserId"      UUID,
    "feedbackCategory"      VARCHAR(30),                   -- For rejections: reason category
    "feedbackDetails"       TEXT,                          -- Free text feedback
    "feedbackActions"       JSONB,                         -- For 'APPLIED'/'MODIFIED': what actions were taken
    "deferralCount"         INTEGER NOT NULL DEFAULT 0,
    "feedbackDeadline"      TIMESTAMPTZ NOT NULL,          -- When feedback is required by

    -- Outcome tracking
    "outcomeStatus"         VARCHAR(25),                   -- 'CORRECT', 'INCORRECT', 'PARTIALLY_CORRECT', 'INCONCLUSIVE', 'PENDING'
    "outcomeVerifiedAt"     TIMESTAMPTZ,
    "outcomeData"           JSONB,                         -- Actual outcome data for comparison
    "outcomeNotes"          TEXT,                          -- AI-generated outcome summary

    -- Follow-up tracking
    "followUpScheduled"     BOOLEAN NOT NULL DEFAULT FALSE,
    "followUpAt"            TIMESTAMPTZ,                   -- Scheduled follow-up time (T+48h)
    "followUpCompleted"     BOOLEAN NOT NULL DEFAULT FALSE,
    "followUpResult"        JSONB,                         -- Follow-up analysis result
    "escalated"             BOOLEAN NOT NULL DEFAULT FALSE,
    "escalatedAt"           TIMESTAMPTZ,
    "escalationReason"      TEXT,

    -- Pattern learning
    "patternUpdated"        BOOLEAN NOT NULL DEFAULT FALSE,
    "confidenceChange"      DECIMAL(5,3),                  -- e.g., +0.020, -0.050
    "newPatternCreated"     UUID,                          -- If user's alternative created a new pattern

    "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for recommendation management
CREATE INDEX "IDX_ai_recommendations_farmId" ON ai_recommendations("farmId");
CREATE INDEX "IDX_ai_recommendations_tankId" ON ai_recommendations("tankId");
CREATE INDEX "IDX_ai_recommendations_category" ON ai_recommendations("category");
CREATE INDEX "IDX_ai_recommendations_urgency" ON ai_recommendations("urgency");
CREATE INDEX "IDX_ai_recommendations_feedbackStatus" ON ai_recommendations("feedbackStatus");
CREATE INDEX "IDX_ai_recommendations_feedbackDeadline" ON ai_recommendations("feedbackDeadline");
CREATE INDEX "IDX_ai_recommendations_outcomeStatus" ON ai_recommendations("outcomeStatus");
CREATE INDEX "IDX_ai_recommendations_followUpAt" ON ai_recommendations("followUpAt") WHERE "followUpCompleted" = FALSE;
CREATE INDEX "IDX_ai_recommendations_createdAt" ON ai_recommendations("createdAt");
CREATE INDEX "IDX_ai_recommendations_trajectoryId" ON ai_recommendations("trajectoryId");
```

### Schema Migration Strategy

These tables will be created via TypeORM migrations that run per-tenant:

1. **Migration naming**: `{timestamp}-AddAiSelfLearningTables`
2. **pgvector extension**: Must be enabled at the database level (`CREATE EXTENSION IF NOT EXISTS vector`) before the migration runs
3. **Per-tenant execution**: The migration runner iterates over all tenant schemas and creates the tables in each
4. **Rollback**: Drop tables in reverse order (ai_recommendations -> ai_patterns -> ai_trajectories) due to FK constraints
5. **Data retention**: ai_trajectories older than 2 years are archived to cold storage; ai_patterns and ai_recommendations are retained indefinitely

---

## 8. Implementation Phases

The implementation is divided into seven phases (A through G), each building on the previous one. Each phase has clear deliverables, acceptance criteria, and rollback procedures.

### Phase A: Docker Deploy + Feature Gate (Week 1-2)

**Objective**: Deploy MCP Farm Intelligence Server as a Docker container with feature-gated activation.

**Deliverables**:
- Docker container `aqua-mcp` added to docker-compose
- Environment variable `MCP_ENABLED=true|false` controlling activation
- Health check endpoint for MCP server
- NATS integration for event consumption
- Configuration in `aqua-config` service for per-tenant AI settings
- Monitoring and logging integration

**Technical Tasks**:
1. Create `Dockerfile` for MCP server (Node.js + TypeScript)
2. Add service to `docker-compose.yml` with dependencies on `aqua-postgres`, `aqua-nats`, `aqua-redis`
3. Implement feature gate middleware that checks `MCP_ENABLED` and tenant-level `aiEnabled` flag
4. Set up NATS subscriptions for sensor events, stock changes, feeding events
5. Create health check endpoint `/health` returning MCP tool availability status
6. Add Prometheus metrics endpoint `/metrics` for monitoring

**Acceptance Criteria**:
- [ ] `docker compose up aqua-mcp` starts successfully
- [ ] Health endpoint returns 200 with tool inventory
- [ ] Setting `MCP_ENABLED=false` disables all AI endpoints
- [ ] NATS events are received and logged (no processing yet)
- [ ] No impact on existing services when MCP container is stopped

### Phase B: Decision Support Panel (Week 3-5)

**Objective**: Add AI analysis panels to existing farm management forms/pages.

**Deliverables**:
- AI insights panel component in `aqua-farm-module` MFE
- Tank health score display on tank detail page
- "Ask AI" button on key pages (tank detail, feeding, stock)
- AI recommendation card component with feedback buttons
- Database tables created (ai_trajectories, ai_patterns, ai_recommendations)
- Species knowledge base seeded with initial data

**Technical Tasks**:
1. Run database migration for all three AI tables (per-tenant)
2. Seed species knowledge base with academic data for supported species
3. Implement `evaluate_tank_health` and `generate_action_items` MCP tools
4. Create React components: `AiInsightPanel`, `AiRecommendationCard`, `AiFeedbackDialog`
5. Integrate panels into existing tank detail, farm overview, and feeding pages
6. Implement feedback submission API and storage
7. Create admin UI for AI configuration (confidence thresholds, notification preferences)

**Acceptance Criteria**:
- [ ] Tank detail page shows AI health score
- [ ] "Ask AI" triggers analysis and displays results within 5 seconds
- [ ] Feedback buttons work and store responses correctly
- [ ] AI tables are created in all tenant schemas
- [ ] Species knowledge base contains data for at least 5 species

### Phase C: Feeding Scheduler (Week 6-8)

**Objective**: Implement daily AI-generated feeding plans.

**Deliverables**:
- `optimize_feeding_plan` MCP tool fully operational
- `check_inventory_sufficiency` MCP tool fully operational
- Daily cron job generating feeding plans
- Feeding plan UI with comparison to standard protocol
- Inventory alert integration

**Technical Tasks**:
1. Implement `optimize_feeding_plan` tool with all 22 data source integrations
2. Implement `check_inventory_sufficiency` tool
3. Create cron job (configurable time per tenant, default 05:00 local)
4. Build feeding plan review UI (daily plan with per-tank breakdown)
5. Implement protocol deviation highlighting and explanation
6. Connect inventory alerts to procurement workflow
7. Add cost comparison view (AI-optimized vs. standard protocol)

**Acceptance Criteria**:
- [ ] Daily feeding plan generated before first feeding
- [ ] Plan accounts for temperature, density, growth stage, and weather
- [ ] Inventory depletion warnings are generated when projected
- [ ] Cost savings are calculated and displayed
- [ ] Feeding staff can approve/modify the plan via mobile

### Phase D: Proactive Alerts (Week 9-12)

**Objective**: Implement event-driven AI monitoring with proactive notifications.

**Deliverables**:
- `predict_disease_risk` MCP tool operational
- Event-driven analysis pipeline (NATS -> MCP -> Notification)
- Push notification integration (FCM for mobile, WebSocket for web)
- Alert de-duplication and quiet hours logic
- Escalation workflow

**Technical Tasks**:
1. Implement `predict_disease_risk` tool
2. Build event processor that filters NATS events and triggers AI analysis
3. Implement notification service integration (push, SMS, in-app)
4. Build alert de-duplication logic (cooldown window per pattern per tank)
5. Implement quiet hours configuration per tenant
6. Build escalation workflow (unacknowledged alerts -> manager notification)
7. Implement notification preference management UI

**Acceptance Criteria**:
- [ ] AI generates proactive alert within 5 minutes of anomalous sensor reading
- [ ] No duplicate alerts within configured cooldown window
- [ ] Quiet hours are respected (alerts queued, not suppressed)
- [ ] Escalation triggers after configured timeout
- [ ] False positive rate < 25% in initial deployment (target improves over time)

### Phase E: Chat Interface (Week 13-16)

**Objective**: Deploy conversational AI interface for natural language interaction.

**Deliverables**:
- Chat UI component integrated into farm management MFE
- Multi-turn conversation support with context retention
- Turkish and English language support
- Chat history storage and retrieval
- Integration with all 19 MCP tools

**Technical Tasks**:
1. Build chat UI component with message thread display
2. Implement conversation context manager (session-based, 30-minute timeout)
3. Build natural language to MCP tool mapping layer
4. Implement multi-turn context: follow-up questions reference previous context
5. Add language detection and response localization (TR/EN)
6. Store chat history in tenant schema for audit and reference
7. Implement "share insight" feature (send chat response as notification to colleagues)

**Acceptance Criteria**:
- [ ] User can ask questions in Turkish or English and receive appropriate language response
- [ ] Follow-up questions maintain context ("What about Tank 5?" works after discussing Tank 3)
- [ ] Response time < 8 seconds for standard queries
- [ ] Chat history is searchable and persistable
- [ ] All 19 MCP tools are accessible via natural language

### Phase F: Self-Learning Pipeline (Week 17-22)

**Objective**: Implement the complete closed-loop learning system with trajectory tracking, pattern discovery, and confidence evolution.

**Deliverables**:
- Complete RETRIEVE-JUDGE-RECOMMEND-VERIFY pipeline
- Automatic pattern discovery from repeated events
- Confidence score evolution system
- Pattern management admin UI
- pgvector similarity search for pattern matching

**Technical Tasks**:
1. Implement trajectory recording for every AI analysis
2. Build pattern matching engine with pgvector similarity search
3. Implement confidence score update logic (all rules from Section 3.7)
4. Build pattern discovery heuristic (detect repeated similar events -> propose new pattern)
5. Implement pattern quarantine and recovery logic
6. Build admin UI for pattern management (view, enable/disable, promote to species KB)
7. Implement pattern versioning (track how patterns evolve over time)
8. Create dashboard for AI learning metrics (confidence trends, accuracy rates)

**Acceptance Criteria**:
- [ ] Every AI analysis creates a trajectory record
- [ ] Pattern confidence scores update correctly based on outcomes
- [ ] New patterns are discovered from repeated events
- [ ] 3 consecutive false positives disable a pattern
- [ ] Disabled patterns can recover via silent probe after quarantine
- [ ] Admin can view and manage all patterns per tenant

### Phase G: Active Follow-Up (Week 23-26)

**Objective**: Implement the AI investigator follow-up system that tracks outcomes and closes the learning loop automatically.

**Deliverables**:
- 48-hour automatic follow-up scheduler
- "What happened?" dialog UI
- Escalation workflow for worsened conditions
- Long-term outcome assessment (weekly)
- Complete learning loop closure

**Technical Tasks**:
1. Build follow-up scheduler (triggers at T+2h, T+48h, T+96h, T+168h)
2. Implement automatic sensor verification at follow-up time
3. Build "What happened?" dialog component
4. Implement escalation logic (rejected + worsened -> escalate)
5. Build weekly long-term outcome assessor for slow-developing predictions
6. Implement feedback timeout handling (auto-classify NO_RESPONSE)
7. Connect follow-up outcomes to pattern confidence updates
8. Build learning loop dashboard (recommendations -> feedback -> outcome -> pattern update visualization)

**Acceptance Criteria**:
- [ ] Follow-up fires automatically 48 hours after recommendation
- [ ] Self-resolved situations trigger "What happened?" dialog
- [ ] Worsened conditions after rejection trigger escalation
- [ ] User alternatives are captured and can create new patterns
- [ ] NO_RESPONSE timeout works correctly after 2 deferrals
- [ ] Complete learning loop is visible in admin dashboard

---

## 9. Notification UX

### 9.1 AI Personality Tone

The AI's communication tone varies based on the situation's urgency and the AI's confidence level. This creates a more natural, less robotic interaction experience.

#### Tone Spectrum

| Tone | When Used | Example (English) | Example (Turkish) |
|---|---|---|---|
| **Neutral** | Informational, routine | "Daily feeding plan is ready for review." | "Gunluk yemleme plani incelemenize hazir." |
| **Concerned** | Warning, potential issue | "I noticed an unusual pattern in Tank 3 that deserves attention." | "Tank 3'te dikkat gerektiren olagan disi bir durum fark ettim." |
| **Urgent** | Emergency, immediate action needed | "Tank 7 requires immediate attention — DO levels are critically low." | "Tank 7 acil mudahale gerektiriyor — DO seviyeleri kritik duzeyde dusuk." |
| **Curious** | Follow-up, learning | "The issue resolved on its own — I'd love to understand what happened so I can learn." | "Sorun kendilginden cozulmus — ne oldugunu anlarsam ogrenebilirim." |
| **Thankful** | After feedback received | "Thanks for the feedback. I've updated my understanding of this pattern." | "Geri bildiriminiz icin tesekkurler. Bu paterne dair anlayisimi guncelledim." |
| **Humble** | Low confidence, unsure | "I'm not very confident about this, but it might be worth checking..." | "Cok emin degilim, ama kontrol etmeye deger olabilir..." |

### 9.2 Mobile Push Notification Templates

#### Emergency (CRITICAL)

```
Title: ACIL — Tank 7 DO Kritik
Body:  DO 4.2 mg/L ve dusuyor. Tahmini 4 saat icinde tehlikeli seviyeye ulasacak.
       [Detayi Gor] [Acil Eylem]
Sound: alarm_urgent.wav
Vibration: continuous for 3 seconds
Priority: HIGH (bypasses Do Not Disturb)
```

#### Feeding Adjustment (HIGH)

```
Title: Yemleme Onerisi — Tank 3
Body:  Sicaklik dususu nedeniyle yemlemeyi %15 azaltmayi oneriyorum.
       Guven: %76 | Yanit bekleniyor: 4 saat
       [Onayla] [Detay] [Reddet]
Sound: notification_important.wav
Priority: DEFAULT
```

#### Growth Prediction (LOW)

```
Title: Buyume Tahmini — Tank 1
Body:  Baliklar tahminen 12 Mayis'ta pazar agirligina ulasacak (plandan 8 gun once).
       [Detayi Gor]
Sound: notification_soft.wav
Priority: LOW
```

#### Follow-Up (NEUTRAL)

```
Title: AI Takip — Tank 3
Body:  48 saat onceki uyarim hakkinda: Durum kendilginden duzelmis gorunuyor.
       Ne oldugunu bana anlatir misiniz?
       [Yanit Ver] [Mesgulum]
Sound: notification_soft.wav
Priority: LOW
```

### 9.3 Escalation Levels

```
Level 0: IN-APP NOTIFICATION
  Target: Assigned user
  Timing: Immediate
  Channel: In-app badge + WebSocket push

Level 1: MOBILE PUSH
  Target: Assigned user + shift lead
  Timing: If Level 0 unread after 30 minutes
  Channel: Push notification (FCM)

Level 2: SMS
  Target: Farm manager + assigned user
  Timing: If Level 1 unread after 2 hours (or immediate for CRITICAL)
  Channel: SMS gateway

Level 3: PHONE CALL (CRITICAL only)
  Target: Farm manager + on-call staff
  Timing: If Level 2 unacknowledged after 30 minutes
  Channel: Voice call via telephony integration

Level 4: EXECUTIVE ALERT
  Target: Tenant admin + farm manager
  Timing: If Level 3 unacknowledged after 1 hour
  Channel: SMS + Email + Dashboard alert
```

---

## 10. Success Metrics

### 10.1 Key Performance Indicators

| Metric | Target (3 months) | Target (6 months) | Target (12 months) | Measurement Method |
|---|---|---|---|---|
| **Prediction Accuracy** | > 60% | > 80% | > 90% | Correct predictions / total predictions per tenant |
| **User Engagement Rate** | > 50% | > 70% | > 85% | Recommendations with feedback / total recommendations |
| **False Positive Rate** | < 25% | < 15% | < 8% | False positives / total alerts per tenant |
| **Time to First Useful Pattern** | 45 days | 30 days (new tenants) | 21 days (new tenants) | Days from activation to first pattern with confidence > 0.65 |
| **Mean Response Time** | < 8 hours | < 4 hours | < 2 hours | Average time from recommendation to user feedback |
| **Cost Savings (Feed)** | 3% | 7% | 12% | (Protocol cost - actual cost) / protocol cost per month |
| **Mortality Reduction** | 5% | 10% | 18% | Compared to pre-AI monthly mortality rate |
| **AI Utilization Rate** | 30% | 60% | 85% | Active AI users / total users per tenant |

### 10.2 Learning Velocity Metrics

| Metric | Description | Target |
|---|---|---|
| **Pattern Discovery Rate** | New patterns created per month per tenant | 5-15 initially, stabilizing at 2-5 |
| **Pattern Maturation Time** | Days from pattern creation to confidence > 0.70 | < 60 days |
| **Pattern Churn Rate** | Patterns disabled / total patterns per quarter | < 10% |
| **Confidence Convergence** | Standard deviation of confidence scores across mature patterns | < 0.15 |
| **Cross-Pattern Accuracy** | Accuracy when multiple patterns contribute to a recommendation | > 75% |

### 10.3 System Health Metrics

| Metric | Description | Target |
|---|---|---|
| **MCP Response Time (P95)** | 95th percentile AI analysis duration | < 5 seconds |
| **MCP Availability** | Uptime of the MCP Farm Intelligence Server | > 99.5% |
| **Trajectory Storage Growth** | Database growth rate per tenant per month | < 500 MB |
| **Pattern Database Size** | Average patterns per tenant after 12 months | 50-200 |
| **Feedback Loop Closure Rate** | Recommendations with complete outcome tracking | > 90% |

### 10.4 Business Impact Metrics

| Metric | Description | Measurement |
|---|---|---|
| **Net Promoter Score (AI Feature)** | User satisfaction with AI recommendations | Quarterly survey |
| **Churn Prevention** | Tenants retained due to AI differentiator | Annual cohort analysis |
| **Support Ticket Reduction** | Decrease in "how to" support tickets | Monthly comparison |
| **Decision Speed** | Time from issue detection to resolution | Before/after comparison |
| **Regulatory Compliance Score** | Compliance violations per quarter | Before/after comparison |

---

## 11. Risks & Mitigations

### Risk Matrix

| # | Risk | Probability | Impact | Severity | Mitigation Strategy |
|---|---|---|---|---|---|
| R1 | Insufficient data in early months | HIGH | MEDIUM | HIGH | Species knowledge base provides baseline; explicit communication of "learning phase" to users |
| R2 | User ignores feedback requests | MEDIUM | HIGH | HIGH | Simplified quick-response UI; escalation chain; gamification of engagement; NO_RESPONSE tracking |
| R3 | Wrong pattern learned | MEDIUM | HIGH | HIGH | Confidence decay on errors; 3-false-positive auto-disable; admin override capability; pattern versioning |
| R4 | Cross-tenant data leak | LOW | CRITICAL | HIGH | PostgreSQL schema isolation; tenant ID in every query; audit logging; penetration testing |
| R5 | Alert fatigue from AI | MEDIUM | MEDIUM | MEDIUM | Confidence thresholds; de-duplication; quiet hours; escalation only for genuine urgency |
| R6 | MCP server downtime | LOW | MEDIUM | LOW | Graceful degradation; backend threshold alerts unaffected; auto-restart; health monitoring |
| R7 | Overfitting to noise | MEDIUM | MEDIUM | MEDIUM | Minimum occurrence threshold for patterns; novelty score filtering; seasonal adjustment |
| R8 | User trusts AI blindly | LOW | HIGH | MEDIUM | Confidence scores always visible; disclaimers on low-confidence recommendations; periodic accuracy reports |
| R9 | Regulatory liability | LOW | HIGH | MEDIUM | Clear "decision support, not decision making" positioning; audit trail; human-in-the-loop mandatory |
| R10 | Storage growth | MEDIUM | LOW | LOW | Trajectory archival after 2 years; configurable retention; cold storage tier |

### Detailed Mitigation Plans

#### R1: Insufficient Data in Early Months

**Problem**: New tenants have zero historical data. The AI has nothing to learn from and may produce irrelevant or obvious recommendations.

**Mitigation**:
1. **Species Knowledge Base Fallback**: All initial recommendations are based on academic/industry data. Confidence scores clearly communicate "this is general knowledge, not specific to your farm."
2. **Onboarding Data Import**: Offer a guided workflow to import historical data from spreadsheets, other systems, or manual entry of key events.
3. **Learning Phase Communication**: UI clearly indicates "AI is in learning mode — accuracy will improve as it observes your farm's unique patterns over the next 30-90 days."
4. **Quick Wins**: Focus early recommendations on obvious, high-confidence areas (feeding optimization based on temperature, basic inventory forecasting) where species knowledge base alone provides value.
5. **Accelerated Learning**: Encourage frequent feedback during early months with prompts like "Your feedback is especially valuable right now — the AI is calibrating to your farm."

#### R2: User Ignores Feedback Requests

**Problem**: Without feedback, the learning pipeline stalls. The AI cannot improve if it never learns whether its recommendations were correct.

**Mitigation**:
1. **One-Tap Response**: Mobile notifications include inline "Applied" / "Not Needed" buttons — no need to open the app.
2. **Smart Defaults**: For low-urgency items, offer "Looks good, I'll follow this" as the default pre-selected option.
3. **Batch Feedback**: At end of day, present a summary of unanswered recommendations for quick batch response.
4. **Manager Visibility**: Farm managers see a dashboard of unanswered recommendations and can nudge staff.
5. **Progressive Disclosure**: Show users how their feedback improves accuracy over time ("Your feedback this month improved prediction accuracy by 8%").
6. **Graceful Degradation**: If a tenant consistently provides < 30% feedback rate, the system reduces recommendation frequency to match engagement level rather than contributing to notification overload.

#### R3: Wrong Pattern Learned

**Problem**: The AI learns an incorrect correlation (e.g., "high mortality follows feeding changes" when the real cause was a coincidental disease) and makes bad recommendations based on it.

**Mitigation**:
1. **Fast Confidence Decay**: Wrong predictions cause 2.5x the confidence change compared to correct ones (-0.05 vs +0.02), ensuring bad patterns are quickly suppressed.
2. **Auto-Disable**: 3 consecutive false positives immediately disable the pattern.
3. **Minimum Sample Size**: Patterns require at least 3 occurrences before being used in recommendations (below 3, they are tracked but not acted upon).
4. **Admin Override**: Farm managers and platform admins can manually disable, modify, or delete any pattern.
5. **Pattern Audit Log**: Every confidence change is logged, making it easy to trace when and why a pattern went wrong.
6. **Contradictory Pattern Detection**: If two patterns consistently produce conflicting recommendations, both are flagged for human review.

#### R4: Cross-Tenant Data Leak

**Problem**: One tenant's learned patterns or operational data becomes visible to another tenant through the AI system.

**Mitigation**:
1. **Schema Isolation**: All AI tables reside in tenant-specific schemas. No shared AI tables exist.
2. **Query Enforcement**: Every database query in the MCP server includes the tenant schema prefix. This is enforced at the ORM level, not just the application level.
3. **Audit Logging**: Every AI data access is logged with tenant ID, user ID, and accessed data identifiers.
4. **No Shared Learning**: The system explicitly does not perform cross-tenant learning. Pattern promotion to the species knowledge base is a manual, admin-only process.
5. **Penetration Testing**: Quarterly security assessments specifically targeting cross-tenant data access in the AI layer.
6. **Code Review Policy**: All MCP tool implementations require security review with specific attention to tenant isolation.

---

## 12. References

### Internal References

| Reference | Location | Description |
|---|---|---|
| MCP Farm Intelligence Server | `mcp/farm-management/` | Existing MCP server with 13 tools |
| AI Insights Module | `apps/farm-service/src/ai-insights/` | Current AI integration in farm service |
| Sensor Service | `apps/sensor-service/` | Real-time sensor data pipeline |
| Farm Service | `apps/farm-service/` | Core farm management CRUD |
| Data Architecture ADR | `docs/architecture/data-architecture.md` | Database design decisions |
| Security Architecture ADR | `docs/architecture/security-architecture.md` | Security patterns and tenant isolation |
| Microservices Design | `docs/architecture/microservices-design.md` | Service decomposition principles |
| Docker Compose | `docker-compose.yml` | Container orchestration configuration |

### External References

| Reference | URL | Relevance |
|---|---|---|
| ruflo ReasoningBank | https://github.com/ruvnet/ruflo | Inspiration for closed-loop reasoning pipeline (RETRIEVE-JUDGE-RECOMMEND-VERIFY) |
| Model Context Protocol | https://modelcontextprotocol.io | MCP specification for tool-based AI interaction |
| pgvector | https://github.com/pgvector/pgvector | PostgreSQL extension for vector similarity search (pattern matching) |
| Aquaculture Best Practices (FAO) | https://www.fao.org/fishery/ | Academic baseline for species knowledge base |

### Technical Standards

| Standard | Application |
|---|---|
| TypeORM Entity Conventions | camelCase column naming, UUID primary keys, automatic timestamp management |
| NATS Event Schema | Standardized event envelopes for sensor, stock, feeding, and task events |
| MCP Tool Interface | JSON-RPC 2.0 over stdio with typed input/output schemas |
| REST API Conventions | Platform-standard pagination, filtering, error handling (see ADR-009) |

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **Confidence Score** | A decimal value (0.000-1.000) representing the AI's estimated probability that a pattern or prediction is correct for a specific tenant |
| **False Positive** | An AI alert or recommendation that turned out to be unnecessary (the predicted problem did not occur) |
| **Novelty Score** | A decimal value (0.000-1.000) representing how different a current situation is from any previously observed pattern |
| **Pattern** | A learned association between a set of conditions and an expected outcome, specific to a tenant |
| **Quarantine** | A state where a disabled pattern waits for a recovery period before attempting a silent probe |
| **Silent Probe** | An evaluation where the AI tests a quarantined pattern without notifying the user, to determine if the pattern should be re-enabled |
| **Species Knowledge Base** | A shared, read-only database of academic/industry optimal parameters for aquaculture species |
| **Trajectory** | A complete record of an AI analysis event, from trigger through reasoning to outcome |

## Appendix B: Configuration Parameters

| Parameter | Default | Scope | Description |
|---|---|---|---|
| `MCP_ENABLED` | `false` | Platform | Global feature gate for AI functionality |
| `ai.enabled` | `false` | Tenant | Per-tenant AI activation |
| `ai.confidenceThreshold.notification` | `0.65` | Tenant | Minimum confidence for sending notifications |
| `ai.confidenceThreshold.display` | `0.50` | Tenant | Minimum confidence for displaying in UI |
| `ai.feedingPlan.cronTime` | `05:00` | Tenant | Daily feeding plan generation time (local) |
| `ai.feedingPlan.optimizationGoal` | `BALANCED` | Tenant | Default optimization goal |
| `ai.alerts.cooldownMinutes` | `240` | Tenant | De-duplication cooldown window |
| `ai.alerts.quietHoursStart` | `22:00` | Tenant | Quiet hours start (local) |
| `ai.alerts.quietHoursEnd` | `06:00` | Tenant | Quiet hours end (local) |
| `ai.feedback.deadlineHours` | `48` | Tenant | Default feedback response deadline |
| `ai.feedback.maxDeferrals` | `2` | Tenant | Maximum deferrals per recommendation |
| `ai.followUp.delayHours` | `48` | Tenant | Hours before automatic follow-up |
| `ai.patterns.minOccurrences` | `3` | Tenant | Minimum events before pattern is used in recommendations |
| `ai.patterns.falsePositiveLimit` | `3` | Tenant | Consecutive false positives to disable pattern |
| `ai.patterns.quarantineDays` | `30` | Tenant | Quarantine period for disabled patterns |
| `ai.trajectories.retentionMonths` | `24` | Tenant | Trajectory data retention period |
| `ai.language` | `tr` | Tenant | AI response language preference |

---

*Document Version: 1.0*
*Last Updated: 2026-03-24*
*Author: Platform Architecture Team*
*Review Status: Pending Review*
