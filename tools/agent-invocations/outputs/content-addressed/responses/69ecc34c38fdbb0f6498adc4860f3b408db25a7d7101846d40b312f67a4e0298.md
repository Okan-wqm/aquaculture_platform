{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38815040469",
  "claim_id": "claim_b549052a65e088ce",
  "details": {
    "adjudication": {
      "rationale": "Adjudication requires repository ground truth for the finding subject, and none is admissible in this record. The only evidence ref, human-required:consensus-7bd163a192e26b86, is the escalation record itself \u2014 an ARIA process artifact, which the evidence-judge contract excludes as proof. To clear the judge_disagreement on 'security-source-without-test:web/modules/farm-module/src/hooks/useEquipment.ts' (tool test-gap-adapter, run 56789ee9-5836-4950-9a42-2413f190bb5f), one of two repository facts at snapshot 99689e46bd86eb980ca2bad74df3c6b072eb4e90 would have to be shown: (a) a colocated or module-level test covering useEquipment.ts, establishing false_positive, or (b) the hook's security-relevant source with no covering test anywhere in web/modules/farm-module, establishing true_positive. This request carries no excerpt of useEquipment.ts, no test file, and no judge verdict payloads; the repository map is labeled a projection, not evidence, and lists no path for the finding subject. Cause and effect: a resolve verdict here would mark the disagreement as cleared with zero repository facts checked, letting an unverified disposition flow into the human-required ledger and the consensus-fed fitness scoring downstream; insufficient_evidence instead blocks resolution until an operator with repository access inspects web/modules/farm-module/src/hooks/ and its test tree. Per the escalation contract, blocking is the correct outcome when the record establishes neither direction, so the adjudication is insufficient_evidence at confidence 0.9.",
      "verdict": "insufficient_evidence"
    },
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:2ad20b3d0a1503d84565189547c861352788304209e58a6f44c481f494581d40",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-evidence-judge",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-evidence-judge-ed58c2c46a89\",\n  \"claim_id\": \"AIR-aria-evidence-judge-ed58c2c46a89\",\n  \"agent_id\": \"aria-evidence-judge\",\n  \"role\": \"human_required_adjudication\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-human_required_adjudication-AIR-aria-evidence-judge-ed58c2c46a89.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"adjudicate-consensus-7bd163a192e26b86\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"Returned details.adjudication.verdict=insufficient_evidence \u2014 a member of the required set resolve/refuse/insufficient_evidence \u2014 with a rationale citing the evidence consulted: the escalation record human-required:consensus-7bd163a192e26b86, which contains no repository content for the finding subject, so the escalation cannot be cleared on this record alone. No disposition is emitted because the verdict is not resolve and this is not a lease_lifecycle escalation.\",\n      \"evidence_refs\": [\"human-required:consensus-7bd163a192e26b86\"]\n    }\n  ],\n  \"evidence_refs\": [\"human-required:consensus-7bd163a192e26b86\"],\n  \"details\": {\n    \"adjudication\": {\n      \"verdict\": \"insufficient_evidence\",\n      \"rationale\": \"Adjudication requires repository ground truth for the finding subject, and none is admissible in this record. The only evidence ref, human-required:consensus-7bd163a192e26b86, is the escalation record itself \u2014 an ARIA process artifact, which the evidence-judge contract excludes as proof. To clear the judge_disagreement on 'security-source-without-test:web/modules/farm-module/src/hooks/useEquipment.ts' (tool test-gap-adapter, run 56789ee9-5836-4950-9a42-2413f190bb5f), one of two repository facts at snapshot 99689e46bd86eb980ca2bad74df3c6b072eb4e90 would have to be shown: (a) a colocated or module-level test covering useEquipment.ts, establishing false_positive, or (b) the hook's security-relevant source with no covering test anywhere in web/modules/farm-module, establishing true_positive. This request carries no excerpt of useEquipment.ts, no test file, and no judge verdict payloads; the repository map is labeled a projection, not evidence, and lists no path for the finding subject. Cause and effect: a resolve verdict here would mark the disagreement as cleared with zero repository facts checked, letting an unverified disposition flow into the human-required ledger and the consensus-fed fitness scoring downstream; insufficient_evidence instead blocks resolution until an operator with repository access inspects web/modules/farm-module/src/hooks/ and its test tree. Per the escalation contract, blocking is the correct outcome when the record establishes neither direction, so the adjudication is insufficient_evidence at confidence 0.9.\"\n    },\n    \"confidence\": 0.9\n  }\n}\n```",
    "confidence": 0.9,
    "runtime_attempt_ledger_hash": "sha256:0375cfbe3bc72781e9d03163075454fd215935cdc06fd044f5cc647578cffb92"
  },
  "evidence_refs": [
    "human-required:consensus-7bd163a192e26b86"
  ],
  "request_id": "AIR-aria-evidence-judge-ed58c2c46a89",
  "role": "human_required_adjudication",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "human-required:consensus-7bd163a192e26b86"
      ],
      "id": "adjudicate-consensus-7bd163a192e26b86",
      "note": "Returned details.adjudication.verdict=insufficient_evidence \u2014 a member of the required set resolve/refuse/insufficient_evidence \u2014 with a rationale citing the evidence consulted: the escalation record human-required:consensus-7bd163a192e26b86, which contains no repository content for the finding subject, so the escalation cannot be cleared on this record alone. No disposition is emitted because the verdict is not resolve and this is not a lease_lifecycle escalation.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
