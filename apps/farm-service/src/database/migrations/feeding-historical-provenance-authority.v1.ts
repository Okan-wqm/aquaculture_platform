/**
 * GENERATED FILE. DO NOT EDIT.
 * Source: libs/feeding-contracts/src/feeding-historical-provenance.catalog.ts
 * Generator: tools/scripts/generate-feeding-historical-provenance.ts
 */
// prettier-ignore
export const FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_V1 = {
  "schemaVersion": "feeding-historical-provenance/v1",
  "journal": {
    "relation": "feeding_historical_provenance_events",
    "columns": [
      {
        "name": "eventId",
        "type": "uuid",
        "nullable": false,
        "defaultExpression": "gen_random_uuid()"
      },
      {
        "name": "tenantId",
        "type": "uuid",
        "nullable": false
      },
      {
        "name": "subjectKind",
        "type": "varchar(32)",
        "nullable": false
      },
      {
        "name": "subjectId",
        "type": "uuid",
        "nullable": false
      },
      {
        "name": "sequence",
        "type": "bigint",
        "nullable": false
      },
      {
        "name": "prevDigest",
        "type": "varchar(64)",
        "nullable": false
      },
      {
        "name": "eventKind",
        "type": "varchar(48)",
        "nullable": false
      },
      {
        "name": "payload",
        "type": "jsonb",
        "nullable": false
      },
      {
        "name": "payloadCanonical",
        "type": "text",
        "nullable": false
      },
      {
        "name": "operationId",
        "type": "varchar(200)",
        "nullable": false
      },
      {
        "name": "idempotencyKey",
        "type": "varchar(240)",
        "nullable": false
      },
      {
        "name": "recordedAt",
        "type": "timestamptz",
        "nullable": false
      },
      {
        "name": "recordedBy",
        "type": "varchar(200)",
        "nullable": false
      },
      {
        "name": "schemaVersion",
        "type": "varchar(80)",
        "nullable": false
      },
      {
        "name": "catalogDigest",
        "type": "varchar(64)",
        "nullable": false
      },
      {
        "name": "eventDigest",
        "type": "varchar(64)",
        "nullable": false
      }
    ],
    "appendFunction": "append_feeding_historical_provenance_v1",
    "digestFunction": "feeding_historical_event_digest_v1",
    "tenantIsolation": {
      "contextGuc": "app.current_tenant",
      "policyName": "feeding_historical_provenance_tenant_v1",
      "forceRowLevelSecurity": true,
      "securityInvokerProjections": true
    },
    "hashDomain": "aquaculture.feeding-historical-provenance-event",
    "digestAlgorithm": "sha256",
    "rootDigest": "0000000000000000000000000000000000000000000000000000000000000000",
    "maxPayloadBytes": 65536
  },
  "projections": {
    "currentEvent": "feeding_historical_current_events_v1",
    "recordAttribution": "feeding_historical_record_attribution_v1",
    "qualifiedRecords": "feeding_historical_qualified_records_v1",
    "dayPlanGrowth": "feeding_historical_day_plan_growth_v1"
  },
  "projectionSchemas": {
    "currentEvent": {
      "columns": [
        "tenantId",
        "subjectKind",
        "subjectId",
        "sequence",
        "eventKind",
        "payload",
        "eventDigest",
        "recordedAt"
      ]
    },
    "recordAttribution": {
      "columns": [
        "tenantId",
        "feedingRecordId",
        "sequence",
        "eventDigest",
        "recordedAt",
        "status",
        "reasonCode",
        "batchId",
        "batchLocationId",
        "equipmentId",
        "locationType",
        "sourceExecutionId",
        "payload"
      ]
    },
    "qualifiedRecords": {
      "columnSourceRelation": "feeding_records"
    },
    "dayPlanGrowth": {
      "columns": [
        "tenantId",
        "dayPlanId",
        "status",
        "policyEventDigest",
        "reasonCode",
        "policyVersion",
        "growthApplicationMode",
        "expectedFcr",
        "totalAppliedFeedKg",
        "totalAppliedGrowthKg",
        "dailyAppliedFeedKg",
        "dailyAppliedGrowthKg",
        "lastAppliedAt"
      ]
    }
  },
  "subjectKinds": [
    "FEEDING_RECORD",
    "DAY_PLAN"
  ],
  "eventDefinitions": [
    {
      "eventKind": "ATTRIBUTION_ASSERTED",
      "subjectKind": "FEEDING_RECORD",
      "payloadKeys": [
        "batchId",
        "batchLocationId",
        "completedAt",
        "equipmentId",
        "locationType",
        "originalRecordDigest",
        "schemaVersion",
        "sourceExecutionId",
        "sourceKind"
      ]
    },
    {
      "eventKind": "ATTRIBUTION_QUARANTINED",
      "subjectKind": "FEEDING_RECORD",
      "payloadKeys": [
        "candidateSnapshot",
        "observedAt",
        "originalRecordDigest",
        "originalSnapshot",
        "reasonCode",
        "schemaVersion",
        "sourceExecutionId",
        "sourceKind"
      ]
    },
    {
      "eventKind": "ATTRIBUTION_RESOLVED",
      "subjectKind": "FEEDING_RECORD",
      "payloadKeys": [
        "batchId",
        "batchLocationId",
        "completedAt",
        "equipmentId",
        "locationType",
        "originalRecordDigest",
        "resolutionNote",
        "resolvesEventDigest",
        "schemaVersion",
        "sourceExecutionId",
        "sourceKind"
      ]
    },
    {
      "eventKind": "GROWTH_POLICY_ASSERTED",
      "subjectKind": "DAY_PLAN",
      "payloadKeys": [
        "expectedFcr",
        "growthApplicationMode",
        "policyVersion",
        "proofAt",
        "proofKind",
        "resolutionNote",
        "resolvesEventDigest",
        "schemaVersion"
      ]
    },
    {
      "eventKind": "GROWTH_POLICY_QUARANTINED",
      "subjectKind": "DAY_PLAN",
      "payloadKeys": [
        "observedAt",
        "originalSnapshot",
        "protocolId",
        "reasonCode",
        "rollupAppliedAt",
        "schemaVersion"
      ]
    },
    {
      "eventKind": "GROWTH_POLICY_RESOLVED",
      "subjectKind": "DAY_PLAN",
      "payloadKeys": [
        "expectedFcr",
        "growthApplicationMode",
        "policyVersion",
        "proofAt",
        "proofKind",
        "resolutionNote",
        "resolvesEventDigest",
        "schemaVersion"
      ]
    },
    {
      "eventKind": "GROWTH_APPLIED",
      "subjectKind": "DAY_PLAN",
      "payloadKeys": [
        "applicationMode",
        "appliedAt",
        "expectedFcr",
        "feedDeltaKg",
        "growthDeltaKg",
        "schemaVersion",
        "sourceRef"
      ]
    }
  ],
  "transitionGraph": {
    "rootState": "ROOT",
    "subjects": [
      {
        "subjectKind": "FEEDING_RECORD",
        "transitions": [
          {
            "predecessorEventKind": null,
            "eventKind": "ATTRIBUTION_ASSERTED",
            "predecessorDigestPayloadKey": null,
            "continuityPayloadKeys": []
          },
          {
            "predecessorEventKind": null,
            "eventKind": "ATTRIBUTION_QUARANTINED",
            "predecessorDigestPayloadKey": null,
            "continuityPayloadKeys": []
          },
          {
            "predecessorEventKind": "ATTRIBUTION_QUARANTINED",
            "eventKind": "ATTRIBUTION_RESOLVED",
            "predecessorDigestPayloadKey": "resolvesEventDigest",
            "continuityPayloadKeys": [
              "originalRecordDigest"
            ]
          }
        ]
      },
      {
        "subjectKind": "DAY_PLAN",
        "transitions": [
          {
            "predecessorEventKind": null,
            "eventKind": "GROWTH_POLICY_ASSERTED",
            "predecessorDigestPayloadKey": null,
            "continuityPayloadKeys": []
          },
          {
            "predecessorEventKind": null,
            "eventKind": "GROWTH_POLICY_QUARANTINED",
            "predecessorDigestPayloadKey": null,
            "continuityPayloadKeys": []
          },
          {
            "predecessorEventKind": "GROWTH_POLICY_QUARANTINED",
            "eventKind": "GROWTH_POLICY_RESOLVED",
            "predecessorDigestPayloadKey": "resolvesEventDigest",
            "continuityPayloadKeys": []
          },
          {
            "predecessorEventKind": "GROWTH_POLICY_ASSERTED",
            "eventKind": "GROWTH_APPLIED",
            "predecessorDigestPayloadKey": null,
            "continuityPayloadKeys": []
          },
          {
            "predecessorEventKind": "GROWTH_POLICY_RESOLVED",
            "eventKind": "GROWTH_APPLIED",
            "predecessorDigestPayloadKey": null,
            "continuityPayloadKeys": []
          },
          {
            "predecessorEventKind": "GROWTH_APPLIED",
            "eventKind": "GROWTH_APPLIED",
            "predecessorDigestPayloadKey": null,
            "continuityPayloadKeys": []
          }
        ]
      }
    ]
  },
  "vocabularies": {
    "sourceKinds": [
      "LEGACY_EXECUTION"
    ],
    "locationTypes": [
      "tank",
      "pond"
    ],
    "growthApplicationModes": [
      "daily",
      "per_meal"
    ],
    "growthEventApplicationModes": [
      "DAILY_ROLLUP",
      "MEAL_FINALIZATION",
      "MEAL_CORRECTION",
      "UNPLANNED_FEED",
      "UNPLANNED_CORRECTION"
    ],
    "attributionQuarantineReasons": [
      "MISSING_SOURCE_EXECUTION",
      "NULL_COMPLETION_TIME",
      "UNSUPPORTED_EQUIPMENT_TYPE",
      "MISSING_OCCUPANCY_INTERVAL",
      "OVERLAPPING_OCCUPANCY_INTERVALS"
    ],
    "growthQuarantineReasons": [
      "UNSTAMPED_HISTORICAL_PLAN",
      "INVALID_EXPECTED_FCR",
      "MALFORMED_POUR_LEDGER",
      "POUR_ACTUAL_MISMATCH",
      "MULTIPLE_POST_STAMP_CORRECTIONS"
    ],
    "growthPolicyProofKinds": [
      "LEGACY_ROLLUP_STAMP",
      "LIVE_PROTOCOL_RESOLUTION"
    ]
  },
  "decimalScales": {
    "feedKg": 3,
    "growthKg": 3,
    "expectedFcr": 6
  }
} as const;

export const FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1 =
  'e770e83b10850103a9f344d196faeeb20774a07c51800b59ca320b687605a6bc';
