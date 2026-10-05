{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37289441131",
  "claim_id": "claim_5d712cb569cb386c",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:b54c4a6ccd4ed9b787737a3d4382bc09b93c836064fac3dbbbbd8e81c4b46f6b",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-evidence-judge",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-evidence-judge-69c9de123a1a\",\n  \"claim_id\": \"AIR-aria-evidence-judge-69c9de123a1a\",\n  \"agent_id\": \"aria-evidence-judge\",\n  \"role\": \"evidence_judgment\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-evidence_judgment-AIR-aria-evidence-judge-69c9de123a1a.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"verdict\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"true_positive. The cited coordinates resolve exactly: web/apps/aquamobil/src/i18n/I18nProvider.tsx:84 column 29 begins `new RegExp(`\\\\\\\\{${varName}\\\\\\\\}`, 'g')` inside interpolate() (declared at :80), so the rule's assertion of a non-literal argument to the RegExp constructor is present verbatim at the reported line:col. The interpolated segment is a caller-supplied object key from Object.entries(vars) at :83, and vars is typed Record<string, string | number> at :29 / :106 / :125 \u2014 every string is an admissible key and nothing escapes it before the regex compiler sees it.\",\n      \"evidence_refs\": [\n        \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:29\",\n        \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:80\",\n        \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:83\",\n        \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:84\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:29\",\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:80\",\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:83\",\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:84\",\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:105\",\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:107\",\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:125\",\n    \"web/apps/aquamobil/src/i18n/I18nProvider.tsx:126\"\n  ],\n  \"details\": {\n    \"verdict\": {\n      \"tool_id\": \"lint-rules\",\n      \"run_id\": null,\n      \"finding_id\": \"lint-rules:security/detect-non-literal-regexp:web/apps/aquamobil/src/i18n/I18nProvider.tsx:84:29\",\n      \"verdict\": \"true_positive\",\n      \"judge_id\": \"aria-evidence-judge\",\n      \"model\": \"claude-opus-5\",\n      \"prompt_hash\": \"request_id:AIR-aria-evidence-judge-69c9de123a1a\",\n      \"confidence\": 0.86,\n      \"judgment_group_id\": \"AIR-aria-evidence-judge-69c9de123a1a\",\n      \"rationale\": \"WHAT WAS CHECKED. The finding claims a non-literal RegExp constructor argument at web/apps/aquamobil/src/i18n/I18nProvider.tsx:84:29. The pinned excerpt (content_hash sha256:59f464c1..., lines 1-131) places interpolate() at :80 and, at :84, the statement `result = result.replace(new RegExp(`\\\\\\\\{${varName}\\\\\\\\}`, 'g'), String(value));`. Column 29 is where `new` starts on that line (4 indent + `result = result.replace(` = 28 characters). The pattern the rule reports exists verbatim at the reported line and column, so the finding is not stale and not a coordinate mismatch. WHY IT MATTERS. The dynamic fragment `${varName}` is a key enumerated from Object.entries(vars) at :83, and vars is declared Record<string, string | number> at :29, :106 and :125 \u2014 the key space is every string, and no escape or allowlist sits between the caller and the regex compiler. Two concrete behaviours follow, not merely a style objection: (a) a key carrying a regex metacharacter changes the compiled pattern (`.`, `*`, `|`) or fails to compile at all (`[`, `(`), and `new RegExp` throws SyntaxError in that case; (b) interpolate() is reached from the t() callback at :105-:107 and from the provider-less fallback t at :125-:126, both of which execute during React render, so a throw there tears down the rendering subtree of a Vite PWA rather than degrading one label. The construct also recompiles one regex per variable per call. WHAT BREAKS IF SKIPPED. Leaving the dynamic constructor keeps the compile step reachable by data, so the day a key arrives from merged or user-shaped data the failure surfaces ...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 33175,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 33175,
      "cache_read_input_tokens": 4862,
      "inference_geo": "not_available",
      "input_tokens": 2,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 33175,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 33175,
          "cache_read_input_tokens": 4862,
          "input_tokens": 2,
          "output_tokens": 11222,
          "type": "message"
        }
      ],
      "output_tokens": 11222,
      "output_tokens_details": {
        "thinking_tokens": 8588
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "runtime_attempt_ledger_hash": "sha256:308cc137bfd0bfd95be0a831a179fb2c86177299ef3b4a70d0612bb85ec81fcc",
    "verdict": {
      "confidence": 0.86,
      "evidence_refs": [
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:29",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:80",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:83",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:84",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:105",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:107",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:125",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:126"
      ],
      "finding_id": "lint-rules:security/detect-non-literal-regexp:web/apps/aquamobil/src/i18n/I18nProvider.tsx:84:29",
      "judge_id": "aria-evidence-judge",
      "judgment_group_id": "AIR-aria-evidence-judge-69c9de123a1a",
      "model": "claude-opus-5",
      "prompt_hash": "request_id:AIR-aria-evidence-judge-69c9de123a1a",
      "rationale": "WHAT WAS CHECKED. The finding claims a non-literal RegExp constructor argument at web/apps/aquamobil/src/i18n/I18nProvider.tsx:84:29. The pinned excerpt (content_hash sha256:59f464c1..., lines 1-131) places interpolate() at :80 and, at :84, the statement `result = result.replace(new RegExp(`\\\\{${varName}\\\\}`, 'g'), String(value));`. Column 29 is where `new` starts on that line (4 indent + `result = result.replace(` = 28 characters). The pattern the rule reports exists verbatim at the reported line and column, so the finding is not stale and not a coordinate mismatch. WHY IT MATTERS. The dynamic fragment `${varName}` is a key enumerated from Object.entries(vars) at :83, and vars is declared Record<string, string | number> at :29, :106 and :125 \u2014 the key space is every string, and no escape or allowlist sits between the caller and the regex compiler. Two concrete behaviours follow, not merely a style objection: (a) a key carrying a regex metacharacter changes the compiled pattern (`.`, `*`, `|`) or fails to compile at all (`[`, `(`), and `new RegExp` throws SyntaxError in that case; (b) interpolate() is reached from the t() callback at :105-:107 and from the provider-less fallback t at :125-:126, both of which execute during React render, so a throw there tears down the rendering subtree of a Vite PWA rather than degrading one label. The construct also recompiles one regex per variable per call. WHAT BREAKS IF SKIPPED. Leaving the dynamic constructor keeps the compile step reachable by data, so the day a key arrives from merged or user-shaped data the failure surfaces as a blank mobile screen or a silently wrong substitution instead of a compile-time or lint-time error. DOWNSTREAM SURFACE. Project web-apps-aquamobil, every screen under the I18nProvider, because t() is the single message path. ROOT-CAUSE PATH (not suppression). Replace the per-key dynamic constructor with one module-level literal pattern plus a replacer function, e.g. `const TOKEN = /\\{(\\w+)\\}/g;` and `message.replace(TOKEN, (match, name) => name in vars ? String(vars[name]) : match)`. That removes the data-controlled compile step structurally and also closes the companion defect at :84, where String(value) is passed as a replacement STRING, so `$&`, `$'` and `$1` sequences inside a value are expanded by String.prototype.replace; a replacer function returns the value literally. Disabling the rule with an eslint-disable comment or casting the argument would leave both behaviours intact and teach the next copy of this helper the wrong contract. CONFIDENCE GAP, STATED PLAINLY. The unescaped construct, the unconstrained key type, and the render-path reachability are all proved by the cited lines. The declared severity 'high' additionally presumes attacker influence over a vars key, which would have to be shown at a call site; no call site outside this file is among the admissible refs, so exploitability is unproven here while the defect itself is proven. The file header at :4-:7 states in prose that this provider is a hand copy of a shared-ui provider; that is file text treated as data, and no shared-ui path was cited, so whether the sibling copy carries the same construct is unverified and is the follow-up check an owner should run.",
      "run_id": null,
      "tool_id": "lint-rules",
      "verdict": "true_positive"
    }
  },
  "evidence_refs": [
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:29",
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:80",
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:83",
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:84",
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:105",
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:107",
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:125",
    "web/apps/aquamobil/src/i18n/I18nProvider.tsx:126"
  ],
  "request_id": "AIR-aria-evidence-judge-69c9de123a1a",
  "role": "evidence_judgment",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:29",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:80",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:83",
        "web/apps/aquamobil/src/i18n/I18nProvider.tsx:84"
      ],
      "id": "verdict",
      "note": "true_positive. The cited coordinates resolve exactly: web/apps/aquamobil/src/i18n/I18nProvider.tsx:84 column 29 begins `new RegExp(`\\\\{${varName}\\\\}`, 'g')` inside interpolate() (declared at :80), so the rule's assertion of a non-literal argument to the RegExp constructor is present verbatim at the reported line:col. The interpolated segment is a caller-supplied object key from Object.entries(vars) at :83, and vars is typed Record<string, string | number> at :29 / :106 / :125 \u2014 every string is an admissible key and nothing escapes it before the regex compiler sees it.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
