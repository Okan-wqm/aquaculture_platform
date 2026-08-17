#!/bin/bash
# ARIA restart doğrulama — Y-serisi kapanışlarının canlı-defter kanıtı.
# Kullanım: cycle+executor koşumları bittikten sonra çalıştır.
S=/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store
python3 - <<'PY'
import json
from collections import Counter
S="/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store"
def rows(p):
    try: return [json.loads(l) for l in open(f"{S}/{p}") if l.strip()]
    except FileNotFoundError: return []
today="2026-08-17"
claims=rows("tools/agent-invocations/claims.jsonl")
reqs=rows("tools/agent-invocations/requests.jsonl")
print("== Y1: bugünkü lease_expired requeue:",
      sum(1 for r in claims if r.get("event")=="requeued" and r.get("reason")=="lease_expired" and str(r.get("at","")).startswith(today)))
print("== Y1: yeni harness release'ler:",
      Counter(r.get("reason") for r in claims if r.get("event")=="released" and str(r.get("released_at","")).startswith(today) and str(r.get("reason","")).startswith("planner_dispatch")))
print("== Y3/Y7: remint_of taşıyan istekler:", sum(1 for r in reqs if r.get("remint_of")))
print("== Y2: bugün mint edilen judge zarfı:",
      sum(1 for r in reqs if r.get("role") in ("evidence_judgment","adversarial_judgment") and str(r.get("created_at","")).startswith(today)))
fb=rows("tools/operator-feedback.jsonl")
print("== Y5: ai_judge hüküm satırları (toplam):", sum(1 for r in fb if r.get("source_type")=="ai_judge" or r.get("judge_id")))
cal=rows("tools/calibration/judge-calibration.jsonl")
org=[r for r in cal if r.get("cycle_id")]
print("== Y5/kalibrasyon: son organik judged_judges:", org[-1].get("judged_judges") if org else "yok")
hr_dir=f"{S}/tools/human-required"
import os, glob
recs=[json.load(open(p)) for p in glob.glob(f"{hr_dir}/*.json")] if os.path.isdir(hr_dir) else []
print("== Y7: panel_disposition dağılımı:", Counter(r.get("panel_disposition") for r in recs))
print("== Y8: genesis_candidate kayıtları:", sum(1 for r in recs if (r.get("context") or {}).get("kind")=="genesis_candidate"))
gov=rows("tools/governance.jsonl")
kinds=Counter(r.get("kind") for r in gov if str(r.get("ts","")).startswith(today))
for k in ("human_required_remint_exhausted","human_required_dropped_with_reason","human_required_escalated_to_operator","genesis_candidate_refused","genesis_panel_execution_failed","executor_drain_completed"):
    if kinds.get(k): print(f"   governance {k}: {kinds[k]}")
met=rows("tools/observability/cycle-metrics.jsonl")
if met:
    last=met[-1]
    print("== X3/E25/E24: son metrics cycle:", last.get("cycle_id"))
    pd=(last.get("phase_digests") or {})
    print("   digests:", {k:v for k,v in pd.items()})
PY
