{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37925359084",
  "claim_id": "claim_014ed863c45f8d34",
  "details": {
    "adjudication": {
      "escalation_id": "consensus-4e6b3ca70c1773b4",
      "rationale": "The single admissible ref in this envelope is the escalation row pointer human-required:consensus-4e6b3ca70c1773b4, and it arrives with no excerpt: the row's content \u2014 the two independent judge verdicts, their confidence values, and the evidence chain each judge read \u2014 is reproduced nowhere in this request. Clearing a judge_disagreement escalation needs one of exactly two things. (a) The recorded verdicts themselves, showing the disagreement rests on an evidence chain that is inadmissible or stale so one side falls away and the gate's agreement condition is met. (b) Admissible repository refs establishing whether a test exercises apps/farm-service/src/harvest/resolvers/harvest.resolver.ts, which would settle the security-source-without-test claim raised by test-gap-adapter run 85752406-ba00-4431-a980-abfd3f63d728 on its own merits. Neither is present. No judge verdict rows were supplied, and the resolver plus any candidate spec file are not cited as evidence_refs and lie outside the single-entry allowed_scope, so reading them would manufacture evidence this verdict is forbidden to cite. The decision-memory line recording this escalation as open, and the sibling test-gap-adapter escalations listed beside it, are mint-time projections rather than evidence; a shared shape across sibling rows does not establish the state of this finding, and recorded support counts do not corroborate. On the record as delivered the escalation is not established in either direction, so resolution stays blocked and the row stands open for operator adjudication.",
      "verdict": "insufficient_evidence"
    },
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:b54c4a6ccd4ed9b787737a3d4382bc09b93c836064fac3dbbbbd8e81c4b46f6b",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-evidence-judge",
    "agent_text": "{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-evidence-judge-e74388eee564\",\n  \"claim_id\": \"AIR-aria-evidence-judge-e74388eee564\",\n  \"agent_id\": \"aria-evidence-judge\",\n  \"role\": \"human_required_adjudication\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-human_required_adjudication-AIR-aria-evidence-judge-e74388eee564.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"adjudicate-consensus-4e6b3ca70c1773b4\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"details.adjudication carries verdict=insufficient_evidence with a non-empty rationale naming the one admissible ref it relied on (the escalation row pointer) and naming precisely what that ref does not contain. No disposition is emitted: disposition is admissible only with verdict=resolve on an anchor_stale or lease_lifecycle escalation, and this row is neither.\",\n      \"evidence_refs\": [\n        \"human-required:consensus-4e6b3ca70c1773b4\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"human-required:consensus-4e6b3ca70c1773b4\"\n  ],\n  \"details\": {\n    \"adjudication\": {\n      \"verdict\": \"insufficient_evidence\",\n      \"rationale\": \"The single admissible ref in this envelope is the escalation row pointer human-required:consensus-4e6b3ca70c1773b4, and it arrives with no excerpt: the row's content \u2014 the two independent judge verdicts, their confidence values, and the evidence chain each judge read \u2014 is reproduced nowhere in this request. Clearing a judge_disagreement escalation needs one of exactly two things. (a) The recorded verdicts themselves, showing the disagreement rests on an evidence chain that is inadmissible or stale so one side falls away and the gate's agreement condition is met. (b) Admissible repository refs establishing whether a test exercises apps/farm-service/src/harvest/resolvers/harvest.resolver.ts, which would settle the security-source-without-test claim raised by test-gap-adapter run 85752406-ba00-4431-a980-abfd3f63d728 on its own merits. Neither is present. No judge verdict rows were supplied, and the resolver plus any candidate spec file are not cited as evidence_refs and lie outside the single-entry allowed_scope, so reading them would manufacture evidence this verdict is forbidden to cite. The decision-memory line recording this escalation as open, and the sibling test-gap-adapter escalations listed beside it, are mint-time projections rather than evidence; a shared shape across sibling rows does not establish the state of this finding, and recorded support counts do not corroborate. On the record as delivered the escalation is not established in either direction, so resolution stays blocked and the row stands open for operator adjudication.\",\n      \"escalation_id\": \"consensus-4e6b3ca70c1773b4\"\n    },\n    \"escalation_context\": {\n      \"escalation_id\": \"consensus-4e6b3ca70c1773b4\",\n      \"escalation_reason_class\": \"judge_disagreement\",\n      \"finding_id\": \"security-source-without-test:apps/farm-service/src/harvest/resolvers/harvest.resolver.ts\",\n      \"tool_id\": \"test-gap-adapter\",\n      \"run_id\": \"85752406-ba00-4431-a980-abfd3f63d728\",\n      \"note\": \"Identifiers echoed from the request header and escalation reason text; they are request data, not independent evidence.\"\n    },\n    \"explanation\": {\n      \"what_must_be_done\": \"Adjudicate the escalation row against its own record: read what the row carries, decide whether that content clears the disagreement, and name the evidence that does the clearing. Resolution is an evidence claim, not a disposition of the queue \u2014 resolve is admissible only when a specific ref can be pointed at; insufficient_evidence is the correct answer when the record settles nothing.\",\n      \"why_it_matters\": \"HUMAN_REQUIRED is the fail-closed sink for findings the consensus gate could not settle (two unique judges, verdict agreement, mean confidence at or above 0.80). The queu...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 32393,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 32393,
      "cache_read_input_tokens": 4866,
      "inference_geo": "global",
      "input_tokens": 2,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 32393,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 32393,
          "cache_read_input_tokens": 4866,
          "input_tokens": 2,
          "output_tokens": 9756,
          "type": "message"
        }
      ],
      "output_tokens": 9756,
      "output_tokens_details": {
        "thinking_tokens": 7698
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "escalation_context": {
      "escalation_id": "consensus-4e6b3ca70c1773b4",
      "escalation_reason_class": "judge_disagreement",
      "finding_id": "security-source-without-test:apps/farm-service/src/harvest/resolvers/harvest.resolver.ts",
      "note": "Identifiers echoed from the request header and escalation reason text; they are request data, not independent evidence.",
      "run_id": "85752406-ba00-4431-a980-abfd3f63d728",
      "tool_id": "test-gap-adapter"
    },
    "explanation": {
      "downstream_surface_affected": "The human-required queue row itself, and through it the consensus and calibration path for tool test-gap-adapter plus any plan minted from this finding.",
      "scope_discipline_applied": "No repository search was run against apps/farm-service/**: the allowed_scope holds exactly one entry and it is the escalation pointer. Evidence gathered outside that scope would be uncitable here, so gathering it would have produced an unsupportable resolve rather than a usable answer.",
      "what_breaks_if_skipped_or_answered_wrongly": "Left unanswered, the row never clears and the cycle makes no progress on this finding. Answered as resolve without a ref, an unverified claim re-enters the stream: generate_ai_consensus consumes it, the true/false-positive calibration for test-gap-adapter shifts on a verdict no evidence backs, and any plan minted from the finding inherits the unverified premise. That failure is silent \u2014 it surfaces only under retrospective audit, by which point several cycles of calibration have drifted.",
      "what_evidence_would_prove_the_result": "Either the row's recorded judge verdicts with confidences and evidence chains, or repository refs at the snapshot SHA for the resolver and the spec that covers it, admitted as evidence_refs and inside allowed_scope. Nothing in the delivered envelope supplies either, which is why this adjudication names the gap. Confidence that the delivered record does not establish the escalation in either direction is high; confidence about the underlying finding's truth is not asserted at all, because no admissible ref bears on it.",
      "what_must_be_done": "Adjudicate the escalation row against its own record: read what the row carries, decide whether that content clears the disagreement, and name the evidence that does the clearing. Resolution is an evidence claim, not a disposition of the queue \u2014 resolve is admissible only when a specific ref can be pointed at; insufficient_evidence is the correct answer when the record settles nothing.",
      "why_it_matters": "HUMAN_REQUIRED is the fail-closed sink for findings the consensus gate could not settle (two unique judges, verdict agreement, mean confidence at or above 0.80). The queue is the only thing standing between an unsettled finding and the confirmed-finding stream."
    },
    "runtime_attempt_ledger_hash": "sha256:4c71782f170454255c31833c85988312ddab8f74871cacb72c83cd05e15c5036"
  },
  "evidence_refs": [
    "human-required:consensus-4e6b3ca70c1773b4"
  ],
  "request_id": "AIR-aria-evidence-judge-e74388eee564",
  "role": "human_required_adjudication",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "human-required:consensus-4e6b3ca70c1773b4"
      ],
      "id": "adjudicate-consensus-4e6b3ca70c1773b4",
      "note": "details.adjudication carries verdict=insufficient_evidence with a non-empty rationale naming the one admissible ref it relied on (the escalation row pointer) and naming precisely what that ref does not contain. No disposition is emitted: disposition is admissible only with verdict=resolve on an anchor_stale or lease_lifecycle escalation, and this row is neither.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
