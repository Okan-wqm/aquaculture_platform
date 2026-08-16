/**
 * GENERATED — DO NOT EDIT.
 *
 * Backend-only request decoder graph compiled from every Nest route parameter.
 * The bootstrap guard is the single runtime consumer; ValidationPipe runs after
 * this graph and remains authoritative for class-validator metadata.
 */
import {
  adminResponse,
  createAdminRequestContract,
  createAdminRouteAuthorizationV1,
  type AdminServerRouteAuthorizationCatalogV1,
  type AdminServerRequestContractCatalogV1,
} from '@platform/admin-http-contracts';

export const ADMIN_SERVER_REQUEST_RUNTIME_PROJECTION = Object.freeze({
  schemaVersion: "admin-server-route-runtime-projection.v3",
  digest: "91e98384438f787763bd553e2a4c5d63d6f93f3e2825c48f50b7afb0ddcc6614",
  routeCount: 509,
  sqlIdentifierCatalogDigest: "afcaf0afa464b6ece76c42555a6790ddac60563fe632f84a185a4a2b02daa9c8",
} as const);

const adminRequestSchema_448e1650cad16f6e389b39a16147292992a6eb101b9776eed036a98f464b4b32 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3f9552a7e84ea47b3341063004cb0e0e82d113d6a2e6e689c959bef660b34d23 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
  "noteId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_a365927253bd76b330e52db909dc050b987c244e4fa87ff370b718037702de42 = createAdminRequestContract(adminResponse.object({
  "planId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_ac69ce6de8d3541ed427b9133bfa9b55430839aaf471bb6899b6669418c08cec = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
  "schema": adminResponse.string(),
  "table": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_b2ff4f9001cba7f3213025b46ad7bcc5dc3c3023485429bf18d6f6b88d5b44eb = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({
  "confirmToken": adminResponse.optional(adminResponse.string()),
  "hardDelete": adminResponse.optional(adminResponse.string()),
}), {"confirmToken":"scalar","hardDelete":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_9ea419c9fad51c6ed67b71af8d12771214d2642ee01736417bc65e59729ee6da = createAdminRequestContract(adminResponse.object({
  "key": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_903de4abe5255899ee08f84ad24e9abd9ce825ce21d5855c67c9487013d9ca9e = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({
  "tenantId": adminResponse.string(),
}), {"tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_cd1a3dc6c06113fdfe40f6071da4a555eb5c146d577ee2394d20a097fee442d5 = createAdminRequestContract(adminResponse.object({
  "moduleId": adminResponse.string(),
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_0bd3e1be0356e597cb0cc9f76d0cb6b8cdf84cd9e4bd32f05a0b29520a18d3c6 = createAdminRequestContract(adminResponse.object({
  "ruleType": adminResponse.union([
    adminResponse.literal("whitelist"),
    adminResponse.literal("blacklist"),
  ] as const),
}), adminResponse.object({
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_4a683a4eb11dab0c5af40feddb049984bb5b14d4964dfc2b855ec02381df6bac = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "country": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "plan": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("trial"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
  ] as const)),
  "search": adminResponse.optional(adminResponse.string()),
  "sortBy": adminResponse.optional(adminResponse.union([
    adminResponse.literal("maxUsers"),
    adminResponse.literal("name"),
    adminResponse.literal("plan"),
    adminResponse.literal("createdAt"),
    adminResponse.literal("status"),
    adminResponse.literal("updatedAt"),
  ] as const)),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("PENDING"),
    adminResponse.literal("PROVISIONING"),
    adminResponse.literal("PROVISIONING_FAILED"),
    adminResponse.literal("ACTIVE"),
    adminResponse.literal("SUSPENDED"),
    adminResponse.literal("DEACTIVATED"),
    adminResponse.literal("CANCELLED"),
    adminResponse.literal("ARCHIVED"),
    adminResponse.literal("PURGED"),
  ] as const)),
  "tier": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("trial"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
  ] as const)),
}), {"country":"scalar","limit":"scalar","page":"scalar","plan":"scalar","search":"scalar","sortBy":"scalar","sortOrder":"scalar","status":"scalar","tier":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_4b1fd9035edceb53626a0550c6f99a16849082093fcd6c34989eff53fb8ca86b = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
}), {"limit":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_b7eee7d118778772b39b6b35b1a842e799a0b38bf29f69776a1b9f3d2de9a744 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.string()),
}), {"category":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_0eda03448a9ca9755fcbad94f894f8687fed8fa0889f2feaac10bfeffcfabfaf = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "threshold": adminResponse.optional(adminResponse.number()),
}), {"threshold":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_a32fd66968ad7a4fd468668afeea9b79d7bcee9df9945e849ffc8266cbc7b830 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "withinDays": adminResponse.optional(adminResponse.number()),
}), {"withinDays":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_1dd8ef284c1af89f24c17b4cb33ede854c6135f04a10cadfad09dc9232bb7e48 = createAdminRequestContract(adminResponse.object({
  "slug": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_6df33742690b17e662423d9c2cf248ef9cd0069b8564414f046698899d82d087 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "q": adminResponse.string(),
}), {"limit":"scalar","q":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_78ad5410fd286b82c961c591c61e2105617d271a549f41b1edf7d409140309a8 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "dataPoints": adminResponse.optional(adminResponse.number()),
  "period": adminResponse.optional(adminResponse.string()),
}), {"dataPoints":"scalar","period":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_56ed6dbcda7d0695cab5f4555c9b333c0cbd5b23573b4862333008cc7d689eea = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "granularity": adminResponse.optional(adminResponse.string()),
  "range": adminResponse.optional(adminResponse.string()),
}), {"granularity":"scalar","range":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_05f74d54350de39762d61994d0570e439446b1163e6df97fc8d731349a9d5096 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.union([
    adminResponse.literal("user"),
    adminResponse.literal("system"),
    adminResponse.literal("usage"),
    adminResponse.literal("financial"),
    adminResponse.literal("tenant"),
  ] as const),
  "endDate": adminResponse.string(),
  "snapshotType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("monthly"),
    adminResponse.literal("daily"),
    adminResponse.literal("weekly"),
    adminResponse.literal("yearly"),
  ] as const)),
  "startDate": adminResponse.string(),
}), {"category":"scalar","endDate":"scalar","snapshotType":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3ffaed319c58bf888346148f47bfe34d0c3f66b73d1caf473096f53e7f11fd53 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "dataPoints": adminResponse.optional(adminResponse.number()),
  "period": adminResponse.optional(adminResponse.union([
    adminResponse.literal("day"),
    adminResponse.literal("year"),
    adminResponse.literal("week"),
    adminResponse.literal("month"),
  ] as const)),
}), {"dataPoints":"scalar","period":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_20dcc3c0249c0bf00ed21ebc5e1d1bd92c28a224f596a24ea85087233effeb13 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "action": adminResponse.optional(adminResponse.string()),
  "endDate": adminResponse.optional(adminResponse.string()),
  "entityId": adminResponse.optional(adminResponse.string()),
  "entityType": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "performedBy": adminResponse.optional(adminResponse.string()),
  "search": adminResponse.optional(adminResponse.string()),
  "severity": adminResponse.optional(adminResponse.string()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "startDate": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"action":"scalar","endDate":"scalar","entityId":"scalar","entityType":"scalar","limit":"scalar","page":"scalar","performedBy":"scalar","search":"scalar","severity":"scalar","sortBy":"scalar","sortOrder":"scalar","startDate":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_e2057a84a7c1cff8c3765158177120af59eb910c108c4c7e28f590410b08cf79 = createAdminRequestContract(adminResponse.object({
  "entityId": adminResponse.string(),
  "entityType": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_e1fa7d56d5fe3790482a7b7a4626c019754d274d507e49714264e3da0463508d = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_b937950170e8bd2c9bef06f597ed648571f4c97fdac4db610158cc922d90d194 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","startDate":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_5b0c824b59eafad4a2dcd358ac94b60cca394ef9cfcca71472d968bd50ca1592 = createAdminRequestContract(adminResponse.object({
  "userId": adminResponse.string(),
}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","limit":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_72f33a4514d2e9fcd44635b816b91566402b83e4bbcd24767894ee685ecf5a4e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "search": adminResponse.optional(adminResponse.string()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("draft"),
    adminResponse.literal("pending_approval"),
    adminResponse.literal("approved"),
    adminResponse.literal("active"),
    adminResponse.literal("expired"),
    adminResponse.literal("rejected"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "tier": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
    adminResponse.literal("custom"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","search":"scalar","sortBy":"scalar","sortOrder":"scalar","status":"scalar","tenantId":"scalar","tier":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_bf558373a07771286d54219449af2279c6c4ad9f5e5bc8ee47f1bfcdc5404e8e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "campaignId": adminResponse.optional(adminResponse.string()),
  "includeExpired": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
}), {"campaignId":"scalar","includeExpired":"scalar","isActive":"scalar","limit":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_8a61a99bd935a7b3f050777adf9ec23dc033ad8d38326737bbb46fd868c6491f = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "offset": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","offset":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_36b38f33427eb27eaa1145d72e3cad809b618e60f40c5ce0e66a790fad01bf9d = createAdminRequestContract(adminResponse.object({
  "code": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_79583eca57175c69bc90ab4ca07655593b5370db531b5010710137749d255895 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "dateFrom": adminResponse.optional(adminResponse.string()),
  "dateTo": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "maxAmount": adminResponse.optional(adminResponse.string()),
  "minAmount": adminResponse.optional(adminResponse.string()),
  "offset": adminResponse.optional(adminResponse.string()),
  "overdueOnly": adminResponse.optional(adminResponse.string()),
  "search": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"dateFrom":"scalar","dateTo":"scalar","limit":"scalar","maxAmount":"scalar","minAmount":"scalar","offset":"scalar","overdueOnly":"scalar","search":"scalar","status":"comma-separated","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_5199e6879fdf996d033911867215c6ca38930edd9b420e06cf29e6966b91408c = createAdminRequestContract(adminResponse.object({
  "invoiceId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_42479910c2a000662b442ecdf492d774ed3a124803e792768b8b5f0f0d02498f = createAdminRequestContract(adminResponse.object({
  "moduleId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_b7c9c87bf420e4ac136846db6cc45bf0ab6fba54f87109f7d5cd8e8d46295eb3 = createAdminRequestContract(adminResponse.object({
  "moduleId": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","sortBy":"scalar","sortOrder":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_57bccdc755254f2bb410d832729994716cfd183cf3ab716135202b183bd858d3 = createAdminRequestContract(adminResponse.object({
  "moduleCode": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_927abe6cd225235f1aa324b3f66c41d499491cf64b298a3ad2e9ef5060e32743 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "dateFrom": adminResponse.optional(adminResponse.string()),
  "dateTo": adminResponse.optional(adminResponse.string()),
  "invoiceId": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "offset": adminResponse.optional(adminResponse.string()),
  "search": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"dateFrom":"scalar","dateTo":"scalar","invoiceId":"scalar","limit":"scalar","offset":"scalar","search":"scalar","status":"comma-separated","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_cf9cde7f79541b752ede11251c154be5e35ed0eff386898317550d8ca0b56840 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "includeInactive": adminResponse.optional(adminResponse.string()),
}), {"includeInactive":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_ca3f4ea5e8d51e4045baaf127709c4527def96c4397d4ae8b93f68532e9b2120 = createAdminRequestContract(adminResponse.object({
  "tier": adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
    adminResponse.literal("custom"),
  ] as const),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_411001fbb69303e0ae66b94b59fb1caa0a19bdbc310ec3b686d486966b5436dc = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "autoRenew": adminResponse.optional(adminResponse.string()),
  "billingCycle": adminResponse.optional(adminResponse.string()),
  "expiringWithinDays": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "offset": adminResponse.optional(adminResponse.string()),
  "pastDueOnly": adminResponse.optional(adminResponse.string()),
  "planTier": adminResponse.optional(adminResponse.string()),
  "search": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.string()),
}), {"autoRenew":"scalar","billingCycle":"comma-separated","expiringWithinDays":"scalar","limit":"scalar","offset":"scalar","pastDueOnly":"scalar","planTier":"comma-separated","search":"scalar","status":"comma-separated"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_f9c6c1a16281e502114540ab3868c2ac4d6c52963f638f1df9ffb2e4e4d0fab1 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","sortBy":"scalar","sortOrder":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_dbbd1506318afd8d9327f8ae6c39e36b79394f1e8976ba573b631839eb569af1 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "dateFrom": adminResponse.optional(adminResponse.string()),
  "dateTo": adminResponse.optional(adminResponse.string()),
  "period": adminResponse.optional(adminResponse.union([
    adminResponse.literal("hourly"),
    adminResponse.literal("daily"),
    adminResponse.literal("weekly"),
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("yearly"),
  ] as const)),
}), {"dateFrom":"scalar","dateTo":"scalar","period":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_5eb41e2d7d6c4094bab8f1aed733600739b96013bf8f58b61362eb940525c52c = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({
  "dateFrom": adminResponse.optional(adminResponse.string()),
  "dateTo": adminResponse.optional(adminResponse.string()),
  "period": adminResponse.optional(adminResponse.union([
    adminResponse.literal("hourly"),
    adminResponse.literal("daily"),
    adminResponse.literal("weekly"),
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("yearly"),
  ] as const)),
}), {"dateFrom":"scalar","dateTo":"scalar","period":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_a3c9f79614a31a2c0eef5beb73a0f1dd8f07a6293297835237e0ff8116274c28 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "dateFrom": adminResponse.optional(adminResponse.string()),
  "dateTo": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "offset": adminResponse.optional(adminResponse.string()),
  "period": adminResponse.optional(adminResponse.union([
    adminResponse.literal("hourly"),
    adminResponse.literal("daily"),
    adminResponse.literal("weekly"),
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("yearly"),
  ] as const)),
}), {"dateFrom":"scalar","dateTo":"scalar","limit":"scalar","offset":"scalar","period":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_8e13eb8eaecbc631b42a8d67143bdfc07ae42da277c7dca42b48b8622bda34d8 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "dateFrom": adminResponse.optional(adminResponse.string()),
  "dateTo": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "meterType": adminResponse.union([
    adminResponse.literal("api_calls"),
    adminResponse.literal("data_storage"),
    adminResponse.literal("sensor_readings"),
    adminResponse.literal("alerts_sent"),
    adminResponse.literal("reports_generated"),
    adminResponse.literal("users_active"),
    adminResponse.literal("farms_active"),
    adminResponse.literal("ponds_active"),
    adminResponse.literal("sensors_active"),
    adminResponse.literal("data_export"),
    adminResponse.literal("integrations"),
    adminResponse.literal("custom"),
  ] as const),
  "period": adminResponse.optional(adminResponse.union([
    adminResponse.literal("hourly"),
    adminResponse.literal("daily"),
    adminResponse.literal("weekly"),
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("yearly"),
  ] as const)),
}), {"dateFrom":"scalar","dateTo":"scalar","limit":"scalar","meterType":"scalar","period":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_ad41237ac77744091f183b39d283b08083efd89c7f01abdc8c4b212339de8b20 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "meterType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("api_calls"),
    adminResponse.literal("data_storage"),
    adminResponse.literal("sensor_readings"),
    adminResponse.literal("alerts_sent"),
    adminResponse.literal("reports_generated"),
    adminResponse.literal("users_active"),
    adminResponse.literal("farms_active"),
    adminResponse.literal("ponds_active"),
    adminResponse.literal("sensors_active"),
    adminResponse.literal("data_export"),
    adminResponse.literal("integrations"),
    adminResponse.literal("custom"),
  ] as const)),
  "numPeriods": adminResponse.optional(adminResponse.string()),
  "period": adminResponse.optional(adminResponse.union([
    adminResponse.literal("hourly"),
    adminResponse.literal("daily"),
    adminResponse.literal("weekly"),
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("yearly"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"meterType":"scalar","numPeriods":"scalar","period":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_2df7963d87203d178b1ecf1aaeceb1a5120faadeaf238b0afaf3a89098a45174 = createAdminRequestContract(adminResponse.object({
  "schema": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_013090361a554db251729207f173ceb752a762fd47a859497e3733eee5b75211 = createAdminRequestContract(adminResponse.object({
  "schema": adminResponse.string(),
  "table": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "orderBy": adminResponse.optional(adminResponse.string()),
  "orderDirection": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "page": adminResponse.optional(adminResponse.number()),
}), {"limit":"scalar","orderBy":"scalar","orderDirection":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_64a4fb31626029891df9628e08f55a66855fe9994d011bea35427f6ec4f8449f = createAdminRequestContract(adminResponse.object({
  "schema": adminResponse.string(),
  "table": adminResponse.string(),
}), adminResponse.object({
  "format": adminResponse.optional(adminResponse.union([
    adminResponse.literal("json"),
    adminResponse.literal("csv"),
  ] as const)),
  "limit": adminResponse.optional(adminResponse.number()),
  "orderBy": adminResponse.optional(adminResponse.string()),
  "orderDirection": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
}), {"format":"scalar","limit":"scalar","orderBy":"scalar","orderDirection":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_2982a30fc3ac821d8ce0bddd420e845ef7a733c8e3e094c002bda617560b87d3 = createAdminRequestContract(adminResponse.object({
  "schema": adminResponse.string(),
  "table": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_1c7fc8e5c46a26dd84286b3cb7690dfb710461a7c410c01e2010786753167ca0 = createAdminRequestContract(adminResponse.object({
  "table": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "orderBy": adminResponse.optional(adminResponse.string()),
  "orderDirection": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "page": adminResponse.optional(adminResponse.number()),
}), {"limit":"scalar","orderBy":"scalar","orderDirection":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_82b01cdc64e101877b43962ca9d1931a3a78191191e08a2a11f2ce07ae69e239 = createAdminRequestContract(adminResponse.object({
  "version": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_44858763ce4ab72120ae7a1b081c53dc1a10429eb6875cab42ad74eddc954e58 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("failed"),
    adminResponse.literal("pending"),
    adminResponse.literal("rolled_back"),
    adminResponse.literal("completed"),
    adminResponse.literal("running"),
  ] as const)),
  "version": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","page":"scalar","status":"scalar","version":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_2cb75252cbee08a3b2d2737c14812d0c981ad05f30d393f3b2e0cf59c988c1d7 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "schemaName": adminResponse.optional(adminResponse.string()),
}), {"schemaName":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_a866095c6be028e7a39e710636d86a25a06ec366c3985b254c59d20902cc7f9d = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "hours": adminResponse.optional(adminResponse.string()),
  "metricType": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"hours":"scalar","metricType":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_f3841c40904c55741f4c6c49a090e92b17213afe9b6ff4cf6bedd826fa0066cb = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "grouped": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "minTime": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"grouped":"scalar","limit":"scalar","minTime":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_efc6a8329e12e1bd9bd2b64ff888dae995520b3c2e4db16d51113a2f7c065b24 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_be0591788912e8f82a28ece110e4c53e7097d8cf3e4053380e384c4d96230bc9 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "debugSessionId": adminResponse.optional(adminResponse.string()),
  "endDate": adminResponse.optional(adminResponse.string()),
  "endpoint": adminResponse.optional(adminResponse.string()),
  "hasError": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "method": adminResponse.optional(adminResponse.string()),
  "minDuration": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "statusCode": adminResponse.optional(adminResponse.number()),
  "tenantId": adminResponse.string(),
}), {"debugSessionId":"scalar","endDate":"scalar","endpoint":"scalar","hasError":"scalar","limit":"scalar","method":"scalar","minDuration":"scalar","page":"scalar","startDate":"scalar","statusCode":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_0a6a42ad6d501ab2a16fad81a1922f0128f229fe26afe61391723bb02dd9f1d1 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "period": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
}), {"period":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_f66088aa589174bacd2cc590d34fea4a1980352c6383656740cdcade30c153d2 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "keyPattern": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
}), {"keyPattern":"scalar","limit":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_638b8685f6bd41d51724f7f993e6166f8767e18ed2bb26bda4c3b57c8b47d10c = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_18164249607b5324f954c15e02454fe6e8ae9f28f540ac0389e005404680aa80 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "featureKey": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"featureKey":"scalar","isActive":"scalar","limit":"scalar","page":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_61ff3fa3a1101a192d324633fa594d73bbaa542ce6096f848ae50c6df7a6924a = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "defaultValue": adminResponse.string(),
  "featureKey": adminResponse.string(),
  "tenantId": adminResponse.string(),
}), {"defaultValue":"scalar","featureKey":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_faf9abdfa630569eb03613f80e422ddc4f56e16110de2c5660fd0f4ae707016d = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "debugSessionId": adminResponse.optional(adminResponse.string()),
  "endDate": adminResponse.optional(adminResponse.string()),
  "hasError": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "minDuration": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "queryType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("select"),
    adminResponse.literal("insert"),
    adminResponse.literal("update"),
    adminResponse.literal("delete"),
    adminResponse.literal("transaction"),
    adminResponse.literal("schema"),
  ] as const)),
  "startDate": adminResponse.optional(adminResponse.string()),
  "tableName": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
}), {"debugSessionId":"scalar","endDate":"scalar","hasError":"scalar","limit":"scalar","minDuration":"scalar","page":"scalar","queryType":"scalar","startDate":"scalar","tableName":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_f387d4a99b9b02566566b3a79c6f6256b296ee54fdbfbaa3d08ecc7dc08d6bae = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_9b99c61db347bb3e5cab78ee19bf81083cd468aa94545653ea87d2f6948ec87a = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "tenantId": adminResponse.string(),
  "threshold": adminResponse.optional(adminResponse.number()),
}), {"tenantId":"scalar","threshold":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_6d6cbca2c0c980de91ba6b213cf4ed1bd500a6d3413711d7cc2357b902f5155e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "isActive": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "sessionType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("query_inspection"),
    adminResponse.literal("api_log_viewing"),
    adminResponse.literal("cache_inspection"),
    adminResponse.literal("feature_flag_override"),
    adminResponse.literal("performance_profiling"),
    adminResponse.literal("error_debugging"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"isActive":"scalar","limit":"scalar","page":"scalar","sessionType":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_6737692698704fa4a7bd7fc717c356fd1e2cc537c33ce43a01ed8916ac27cd75 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_4ee5dab8ad8bb77c003c43964565f5874e69ac165686aa7004cb8d5d5af0fb97 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_515322b27287ac807633e9394b15c7d3ee49f8ab40307cada507f609c203714b = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_80b437d3fc3a585fbddabf2413831aac145e5dd134ce699fbe8270d885f0ced2 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "isActive": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"isActive":"scalar","limit":"scalar","page":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_9a29fe46143ea7c68c283142e02090ab32321c0a6c8e2dd3102f539261ed7be7 = createAdminRequestContract(adminResponse.object({
  "superAdminId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_79fa7f1ffc9e7f12750671e021d73a73ab388410a23cddd315a927812ee75868 = createAdminRequestContract(adminResponse.object({
  "superAdminId": adminResponse.string(),
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_22f3ed7cef7713b4f99a89ec08d13117365979f6af3f3653894f0ad0626a156e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "reason": adminResponse.optional(adminResponse.union([
    adminResponse.literal("support_request"),
    adminResponse.literal("debugging"),
    adminResponse.literal("configuration"),
    adminResponse.literal("onboarding_assistance"),
    adminResponse.literal("security_investigation"),
    adminResponse.literal("data_verification"),
    adminResponse.literal("other"),
  ] as const)),
  "search": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("active"),
    adminResponse.literal("ended"),
    adminResponse.literal("expired"),
    adminResponse.literal("terminated"),
  ] as const)),
  "superAdminId": adminResponse.optional(adminResponse.string()),
  "targetTenantId": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","limit":"scalar","page":"scalar","reason":"scalar","search":"scalar","startDate":"scalar","status":"scalar","superAdminId":"scalar","targetTenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_8f53508ea7ca51d42f736367409cd200d45bf42f9ec6a1182a66daabcfe79637 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "action": adminResponse.optional(adminResponse.string()),
  "cursor": adminResponse.optional(adminResponse.string()),
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "resourceType": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
  "userId": adminResponse.optional(adminResponse.string()),
}), {"action":"scalar","cursor":"scalar","endDate":"scalar","limit":"scalar","resourceType":"scalar","startDate":"scalar","tenantId":"scalar","userId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_c9c57cc8f8a8e1892df6cafbb49a75d76c9f68afc81442b8f30ad60add394edd = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "tenantId": adminResponse.string(),
}), {"tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_d78143a3a932ce522c556ac909993333813653917a084667148021f476e91a1e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "isActive": adminResponse.optional(adminResponse.string()),
  "isCore": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
  "search": adminResponse.optional(adminResponse.string()),
}), {"isActive":"scalar","isCore":"scalar","limit":"scalar","page":"scalar","search":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_21d72656a09014561d399f5cbacddfd49112629e83001d4574e036c2c145ab98 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_2dcbed4f62ac5e86c4267d50bb390faad12b31bb1297c54c9c8ec418adb7512a = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "moduleId": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","moduleId":"scalar","page":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3be87943c63777248c23f523bae7be17fcf52d753aafd1169f3e42d8ade5fb95 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("draft"),
    adminResponse.literal("active"),
    adminResponse.literal("inactive"),
  ] as const)),
  "type": adminResponse.optional(adminResponse.union([
    adminResponse.literal("tenant_overview"),
    adminResponse.literal("tenant_churn"),
    adminResponse.literal("financial_revenue"),
    adminResponse.literal("financial_payments"),
    adminResponse.literal("usage_modules"),
    adminResponse.literal("usage_features"),
    adminResponse.literal("system_performance"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","status":"scalar","type":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_894d6533da04f5f5682f535e972d0da5392a71be47ed83bc96aeba5374f7e04a = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "definitionId": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "reportType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("tenant_overview"),
    adminResponse.literal("tenant_churn"),
    adminResponse.literal("financial_revenue"),
    adminResponse.literal("financial_payments"),
    adminResponse.literal("usage_modules"),
    adminResponse.literal("usage_features"),
    adminResponse.literal("system_performance"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("failed"),
    adminResponse.literal("pending"),
    adminResponse.literal("completed"),
    adminResponse.literal("running"),
    adminResponse.literal("unavailable"),
  ] as const)),
}), {"definitionId":"scalar","limit":"scalar","page":"scalar","reportType":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_23d34fb4349c832b01c5c1e2a54adfa9b6a5698ae7e85a518fdf8deadbcb408e = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_5233fc6a347af75dd8063cccae0466277b2a546b6daca5766212d8b382a2cfb6 = createAdminRequestContract(adminResponse.object({
  "framework": adminResponse.union([
    adminResponse.literal("gdpr"),
    adminResponse.literal("ccpa"),
    adminResponse.literal("hipaa"),
    adminResponse.literal("pci_dss"),
    adminResponse.literal("sox"),
    adminResponse.literal("iso27001"),
  ] as const),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_7c35f1b8077023290eba973e5d61e23dcde170582531ed08497acc3ad6d09bad = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "complianceFramework": adminResponse.optional(adminResponse.union([
    adminResponse.literal("gdpr"),
    adminResponse.literal("ccpa"),
    adminResponse.literal("hipaa"),
    adminResponse.literal("pci_dss"),
    adminResponse.literal("sox"),
    adminResponse.literal("iso27001"),
  ] as const)),
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "overdue": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "page": adminResponse.optional(adminResponse.number()),
  "requestType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("access"),
    adminResponse.literal("deletion"),
    adminResponse.literal("portability"),
    adminResponse.literal("rectification"),
    adminResponse.literal("restriction"),
  ] as const)),
  "startDate": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("rejected"),
    adminResponse.literal("pending"),
    adminResponse.literal("completed"),
    adminResponse.literal("expired"),
    adminResponse.literal("in_progress"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"complianceFramework":"scalar","endDate":"scalar","limit":"scalar","overdue":"scalar","page":"scalar","requestType":"scalar","startDate":"scalar","status":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_27757dca1aa148fb25e576d327656061518651027350066903d3ef5a0225fe7d = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","startDate":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_031359f8879ec46096e7003338a362b2aa0a8c894cbe9e4096a0c99ac9991f47 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "complianceType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("gdpr"),
    adminResponse.literal("ccpa"),
    adminResponse.literal("hipaa"),
    adminResponse.literal("pci_dss"),
    adminResponse.literal("sox"),
    adminResponse.literal("iso27001"),
  ] as const)),
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"complianceType":"scalar","endDate":"scalar","limit":"scalar","page":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_21049ec4cfb2f8dd7d9e20a531775ad9df0e758e7cf8a635bd3ef4607bd4aabe = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
}), {"limit":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3518371b8da3b87a87c517218bd4887ca6f151b5ed5149c5da324ad7b0b32e78 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "eventType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("rate_limit_exceeded"),
    adminResponse.literal("suspicious_activity"),
    adminResponse.literal("failed_login"),
    adminResponse.literal("brute_force_attempt"),
    adminResponse.literal("unauthorized_access"),
    adminResponse.literal("privilege_escalation"),
    adminResponse.literal("data_exfiltration"),
    adminResponse.literal("malware_detected"),
    adminResponse.literal("api_abuse"),
    adminResponse.literal("sql_injection_attempt"),
    adminResponse.literal("xss_attempt"),
    adminResponse.literal("csrf_attempt"),
    adminResponse.literal("account_lockout"),
    adminResponse.literal("password_spray"),
    adminResponse.literal("credential_stuffing"),
    adminResponse.literal("session_hijacking"),
    adminResponse.literal("ip_blacklisted"),
    adminResponse.literal("geo_anomaly"),
    adminResponse.literal("device_anomaly"),
    adminResponse.literal("time_anomaly"),
  ] as const)),
  "ipAddress": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "searchQuery": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("confirmed"),
    adminResponse.literal("detected"),
    adminResponse.literal("investigating"),
    adminResponse.literal("mitigated"),
    adminResponse.literal("false_positive"),
    adminResponse.literal("escalated"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "threatLevel": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","eventType":"scalar","ipAddress":"scalar","limit":"scalar","page":"scalar","searchQuery":"scalar","startDate":"scalar","status":"scalar","tenantId":"scalar","threatLevel":"comma-separated","userId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_152fb40b6020098f101742012b74500983de2481478f5f485ee2dabfa4462ffc = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "severity": adminResponse.optional(adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const)),
  "startDate": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
    adminResponse.literal("investigating"),
    adminResponse.literal("contained"),
    adminResponse.literal("eradicated"),
    adminResponse.literal("recovered"),
  ] as const)),
}), {"endDate":"scalar","limit":"scalar","page":"scalar","severity":"scalar","startDate":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_d36c527176f16b3bb2be4f0a68d4637a06f0e2e5a4ef66f85e5c0a4efde7aba9 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "indicatorType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("domain"),
    adminResponse.literal("email"),
    adminResponse.literal("cidr"),
    adminResponse.literal("url"),
    adminResponse.literal("ip"),
    adminResponse.literal("hash"),
    adminResponse.literal("user_agent"),
  ] as const)),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "searchQuery": adminResponse.optional(adminResponse.string()),
  "threatLevel": adminResponse.optional(adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const)),
}), {"indicatorType":"scalar","isActive":"scalar","limit":"scalar","page":"scalar","searchQuery":"scalar","threatLevel":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_52f6c8a406da7d0a2ebccd0763bb4449b7d456cbaef2528c616690719a3090ca = createAdminRequestContract(adminResponse.object({
  "ip": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_0a80548496142769fa8faeb288dd0a27494e9112e5cf2eb27ccf7c5422b66876 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "includePrivate": adminResponse.optional(adminResponse.string()),
}), {"includePrivate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_f32689b645e41d5740702a04e76bccbdec1cca118bce1ca939084128a5c6b78b = createAdminRequestContract(adminResponse.object({
  "category": adminResponse.union([
    adminResponse.literal("general"),
    adminResponse.literal("security"),
    adminResponse.literal("email"),
    adminResponse.literal("sms"),
    adminResponse.literal("billing"),
    adminResponse.literal("rate_limit"),
    adminResponse.literal("storage"),
    adminResponse.literal("integration"),
    adminResponse.literal("notification"),
    adminResponse.literal("feature_flag"),
    adminResponse.literal("maintenance"),
  ] as const),
}), adminResponse.object({
  "includePrivate": adminResponse.optional(adminResponse.string()),
}), {"includePrivate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_624b7678488b2e0a6cee5b8a53563b4d20fae35fda0ef57f2047d2da28155a73 = createAdminRequestContract(adminResponse.object({
  "category": adminResponse.string(),
}), adminResponse.object({
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_01ebd6b5b38f2540166367e27cb9bad0f6d5cb42d1f8e7241919b31dea7cdf02 = createAdminRequestContract(adminResponse.object({
  "code": adminResponse.string(),
}), adminResponse.object({
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_54aff9e9f1b87c8415501f5c1c6bc2fe94e0ce189cb5ee69310a6ba853a4c805 = createAdminRequestContract(adminResponse.object({
  "featureKey": adminResponse.string(),
}), adminResponse.object({
  "default": adminResponse.optional(adminResponse.string()),
}), {"default":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_40daf38884b6bcfba0589ae7447afa54a5d4789b37081c45c2d4923fd2f3b06b = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","page":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_1cfe0f2e26da97c6d578aac8560ac0dab46b83be7fffb425ef4748dcabd1df19 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("draft"),
    adminResponse.literal("cancelled"),
    adminResponse.literal("expired"),
    adminResponse.literal("scheduled"),
    adminResponse.literal("published"),
  ] as const)),
  "type": adminResponse.optional(adminResponse.union([
    adminResponse.literal("maintenance"),
    adminResponse.literal("warning"),
    adminResponse.literal("critical"),
    adminResponse.literal("info"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","status":"scalar","type":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_ea3d96988cb0d8224c3648623bd345b9eb6f2aa0c264ca164651a47e83213ed6 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({
  "userId": adminResponse.string(),
}), {"userId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_65a36bd53d785f69bc74a481787efa8eb95176b55f9becc9c68befed60041daa = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "hasUnread": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("all"),
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
  ] as const)),
}), {"hasUnread":"scalar","limit":"scalar","page":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_7486ff01fde2b5442894d296e224451d32ca509382dca998a95dcc050e24abc6 = createAdminRequestContract(adminResponse.object({
  "threadId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_533e134a99ba27237a67a4abdfe8fbc1bc1b0bae702bbc3b8f3c583330cc5851 = createAdminRequestContract(adminResponse.object({
  "threadId": adminResponse.string(),
}), adminResponse.object({
  "includeInternal": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
}), {"includeInternal":"scalar","limit":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_514d8c08e7e0ffcc7533a22f1c5f41b4304f1c1220a4fb57bfbc57b83929a229 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("skipped"),
    adminResponse.literal("completed"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("not_started"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_21ddedd46e9e27b43b91559fc989ca4fcaaae947c851af2bb04453238ef39e93 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.string()),
}), {"category":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_32266ddf4c187699d7586d61f81421fb22304a84a35ffa19b257423ab20c2c63 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "assignedTo": adminResponse.optional(adminResponse.string()),
  "category": adminResponse.optional(adminResponse.union([
    adminResponse.literal("billing"),
    adminResponse.literal("general"),
    adminResponse.literal("technical"),
    adminResponse.literal("feature_request"),
    adminResponse.literal("bug_report"),
    adminResponse.literal("account"),
  ] as const)),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "priority": adminResponse.optional(adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const)),
  "search": adminResponse.optional(adminResponse.string()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("waiting_customer"),
    adminResponse.literal("resolved"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"assignedTo":"scalar","category":"scalar","limit":"scalar","page":"scalar","priority":"scalar","search":"scalar","sortBy":"scalar","sortOrder":"scalar","status":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_5c40189315b1733f87644300435039fd8dcca6241e9622dab5cba47e125d6607 = createAdminRequestContract(adminResponse.object({
  "userId": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("waiting_customer"),
    adminResponse.literal("resolved"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","sortBy":"scalar","sortOrder":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_d6a391e377be6c84f3e4c28aa4294854d291f428b1ed70e6b702632e7e568e9c = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({
  "includeInternal": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
}), {"includeInternal":"scalar","limit":"scalar","page":"scalar","sortBy":"scalar","sortOrder":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_8b5bf7548ec3b97002ed2847f8b78e94fe30bff3951f4a4f3f22cf3cf7286426 = createAdminRequestContract(adminResponse.object({
  "ticketNumber": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_aa933b9078bc9d64b35338a4f27b404df3d72d397b96c3eee5432dc82c36dec2 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("waiting_customer"),
    adminResponse.literal("resolved"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","sortBy":"scalar","sortOrder":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_461a802e20f5a848d9212b2806f88745aed5d32427fb0aa730a8f78e4e46c13e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "sortBy": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","sortBy":"scalar","sortOrder":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_372f1f8b5c8d735b6525a9dc261f45afeb2def909d10ff4de163933bf5cfea99 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "service": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","service":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_882da80d143ffa7ded60baff6d7bf0573123a2db9e12a30d8bab8b351139e9c7 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "assignedTo": adminResponse.optional(adminResponse.string()),
  "isRegression": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "search": adminResponse.optional(adminResponse.string()),
  "service": adminResponse.optional(adminResponse.string()),
  "severity": adminResponse.optional(adminResponse.union([
    adminResponse.literal("debug"),
    adminResponse.literal("info"),
    adminResponse.literal("warning"),
    adminResponse.literal("error"),
    adminResponse.literal("critical"),
    adminResponse.literal("fatal"),
  ] as const)),
  "sortBy": adminResponse.optional(adminResponse.union([
    adminResponse.literal("lastSeenAt"),
    adminResponse.literal("firstSeenAt"),
    adminResponse.literal("occurrenceCount"),
    adminResponse.literal("userCount"),
  ] as const)),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("new"),
    adminResponse.literal("acknowledged"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("resolved"),
    adminResponse.literal("ignored"),
    adminResponse.literal("recurring"),
  ] as const)),
}), {"assignedTo":"scalar","isRegression":"scalar","limit":"scalar","page":"scalar","search":"scalar","service":"scalar","severity":"scalar","sortBy":"scalar","sortOrder":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_73bbe26b6265e3e1464f379e05dc33a4f246606f1c95a55760dd2874dc3c6a03 = createAdminRequestContract(adminResponse.object({
  "groupId": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
}), {"limit":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_e57119e9d9633fd1dfb561de73b2d371ac8600c309323917a197c32942e27458 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "environment": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "service": adminResponse.optional(adminResponse.string()),
  "severity": adminResponse.optional(adminResponse.union([
    adminResponse.literal("debug"),
    adminResponse.literal("info"),
    adminResponse.literal("warning"),
    adminResponse.literal("error"),
    adminResponse.literal("critical"),
    adminResponse.literal("fatal"),
  ] as const)),
  "startDate": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","environment":"scalar","limit":"scalar","page":"scalar","service":"scalar","severity":"scalar","startDate":"scalar","tenantId":"scalar","userId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_0d0a936448ffd432b1ec27e4a19cf2e57c67acb1423f6b9f74fbbe8a2d2da82f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "groupBy": adminResponse.union([
    adminResponse.literal("service"),
    adminResponse.literal("severity"),
    adminResponse.literal("tenant"),
    adminResponse.literal("errorType"),
  ] as const),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","groupBy":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3664c794c8aae8fbc976b70fa93d2eda9fd9267b8a041e9c7a4f028fbae31f8a = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "jobType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("immediate"),
    adminResponse.literal("recurring"),
    adminResponse.literal("delayed"),
    adminResponse.literal("triggered"),
  ] as const)),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "queueName": adminResponse.optional(adminResponse.string()),
  "search": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("pending"),
    adminResponse.literal("scheduled"),
    adminResponse.literal("running"),
    adminResponse.literal("completed"),
    adminResponse.literal("failed"),
    adminResponse.literal("cancelled"),
    adminResponse.literal("retrying"),
    adminResponse.literal("paused"),
  ] as const)),
  "tags": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"jobType":"scalar","limit":"scalar","page":"scalar","queueName":"scalar","search":"scalar","status":"scalar","tags":"comma-separated","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_7490355613f828c8d44b973584f6e8896eb0b0c9e4a8ce5e05f682fcf917847b = createAdminRequestContract(adminResponse.object({
  "name": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_fb8fc0be6308b2ea28be994d059708d1614e1d7e8c5557ae0f8739e4de3ffceb = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "interval": adminResponse.optional(adminResponse.union([
    adminResponse.literal("7d"),
    adminResponse.literal("30d"),
    adminResponse.literal("1h"),
    adminResponse.literal("24h"),
  ] as const)),
  "metric": adminResponse.string(),
}), {"interval":"scalar","metric":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_47ba80857f9a5912a48d15d2826ec3bf17d5d343cb47998ea7f2633e7366140f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "service": adminResponse.optional(adminResponse.string()),
}), {"service":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_e6ec4d330b250fff119d64e7fd73ec0be57079bde9303e439bbbc28d4481452f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "satisfiedThreshold": adminResponse.optional(adminResponse.number()),
  "service": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "toleratedThreshold": adminResponse.optional(adminResponse.number()),
}), {"endDate":"scalar","satisfiedThreshold":"scalar","service":"scalar","startDate":"scalar","toleratedThreshold":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_f8030d9d673ea4debc64d00ae3131d473620c129dc59b8c09873135f0326e20c = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "database": adminResponse.optional(adminResponse.string()),
  "endDate": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"database":"scalar","endDate":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_8e875f445366a69fba4332e5b938004d384398eccdfffdbab3b185ac14e95485 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "threshold": adminResponse.optional(adminResponse.number()),
}), {"endDate":"scalar","limit":"scalar","startDate":"scalar","threshold":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_0fcb7488bf2bc5084f89d94080a37b3547309e55f59687684262643115b2b5b8 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "intervalMinutes": adminResponse.optional(adminResponse.number()),
  "metricType": adminResponse.union([
    adminResponse.literal("response_time"),
    adminResponse.literal("throughput"),
    adminResponse.literal("error_rate"),
    adminResponse.literal("apdex"),
    adminResponse.literal("active_users"),
    adminResponse.literal("request_count"),
    adminResponse.literal("db_connection_pool"),
    adminResponse.literal("db_query_time"),
    adminResponse.literal("db_cache_hit_ratio"),
    adminResponse.literal("db_deadlocks"),
    adminResponse.literal("db_active_connections"),
    adminResponse.literal("db_slow_queries"),
    adminResponse.literal("cpu_usage"),
    adminResponse.literal("memory_usage"),
    adminResponse.literal("disk_usage"),
    adminResponse.literal("network_latency"),
    adminResponse.literal("container_health"),
    adminResponse.literal("pod_restarts"),
    adminResponse.literal("custom"),
  ] as const),
  "service": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","intervalMinutes":"scalar","metricType":"scalar","service":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_fc49ed76f7185731f2b31d07d952eb92e9c48753c05ed08e6ab1b9ca09875858 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "host": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","host":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_e5c36b850c767851633c9306a4ce44c296288d8f6ba8c2f152bfaf495e74c622 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3e64e8432e7932841ebed7b045c26bc67b2683091b9295d1645c459ca5f1c7c5 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "service": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
}), {"endDate":"scalar","limit":"scalar","service":"scalar","startDate":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_1bd689002aa64ca84677733e6043ade5b91965d90d4a14932f1f404e1204b620 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.union([
    adminResponse.literal("api"),
    adminResponse.literal("database"),
    adminResponse.literal("cache"),
    adminResponse.literal("security"),
    adminResponse.literal("email"),
    adminResponse.literal("storage"),
    adminResponse.literal("integration"),
    adminResponse.literal("notification"),
    adminResponse.literal("performance"),
    adminResponse.literal("feature"),
    adminResponse.literal("system"),
    adminResponse.literal("provisioning"),
  ] as const)),
  "isSecret": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "search": adminResponse.optional(adminResponse.string()),
}), {"category":"scalar","isSecret":"scalar","limit":"scalar","page":"scalar","search":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_cd014e6dac014b2ca9197f6761bc53b5c3d91d0796fe6c2fd95f39f84726c7ca = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "scope": adminResponse.optional(adminResponse.union([
    adminResponse.literal("global"),
    adminResponse.literal("tenant"),
    adminResponse.literal("user"),
    adminResponse.literal("environment"),
  ] as const)),
  "search": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("enabled"),
    adminResponse.literal("disabled"),
    adminResponse.literal("percentage_rollout"),
    adminResponse.literal("scheduled"),
  ] as const)),
}), {"category":"scalar","limit":"scalar","page":"scalar","scope":"scalar","search":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_6b052275e78fc0cfac8e8953e86b4b9530f6609ae679e920350be85f330beee7 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "endDate": adminResponse.optional(adminResponse.string()),
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "scope": adminResponse.optional(adminResponse.union([
    adminResponse.literal("global"),
    adminResponse.literal("tenant"),
    adminResponse.literal("service"),
    adminResponse.literal("region"),
  ] as const)),
  "startDate": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("completed"),
    adminResponse.literal("cancelled"),
    adminResponse.literal("extended"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "type": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("emergency"),
    adminResponse.literal("rolling_update"),
    adminResponse.literal("database_migration"),
    adminResponse.literal("security_patch"),
  ] as const)),
}), {"endDate":"scalar","limit":"scalar","page":"scalar","scope":"scalar","startDate":"scalar","status":"scalar","tenantId":"scalar","type":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_07fe2d53b54859c9388e3f15b93a60ff76deef6b8684c7cccce64f29b4777b6e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "ipAddress": adminResponse.optional(adminResponse.string()),
  "isSuperAdmin": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
}), {"ipAddress":"scalar","isSuperAdmin":"scalar","tenantId":"scalar","userId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3a060de84e937b980738a1dcfb413eeb47b6d1efbb4a73e8fe8419bb444cf913 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "releaseType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("major"),
    adminResponse.literal("minor"),
    adminResponse.literal("patch"),
    adminResponse.literal("hotfix"),
    adminResponse.literal("security"),
    adminResponse.literal("beta"),
    adminResponse.literal("alpha"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("draft"),
    adminResponse.literal("staged"),
    adminResponse.literal("deploying"),
    adminResponse.literal("deployed"),
    adminResponse.literal("rolled_back"),
    adminResponse.literal("deprecated"),
  ] as const)),
}), {"limit":"scalar","page":"scalar","releaseType":"scalar","status":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_561545df276ed710a1d9a506f67832376aa9e7796d019538777353536dfe0dc1 = createAdminRequestContract(adminResponse.object({
  "operationId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3152a075e65ce6bc8a7239576296492f9b926b742283bfd15c4871d57e8e41cf = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.number()),
  "page": adminResponse.optional(adminResponse.number()),
  "role": adminResponse.optional(adminResponse.union([
    adminResponse.literal("SUPER_ADMIN"),
    adminResponse.literal("TENANT_ADMIN"),
    adminResponse.literal("MODULE_MANAGER"),
    adminResponse.literal("MODULE_USER"),
  ] as const)),
  "search": adminResponse.optional(adminResponse.string()),
  "sortBy": adminResponse.optional(adminResponse.union([
    adminResponse.literal("email"),
    adminResponse.literal("createdAt"),
    adminResponse.literal("role"),
    adminResponse.literal("updatedAt"),
    adminResponse.literal("firstName"),
    adminResponse.literal("lastName"),
  ] as const)),
  "sortOrder": adminResponse.optional(adminResponse.union([
    adminResponse.literal("ASC"),
    adminResponse.literal("DESC"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("all"),
    adminResponse.literal("active"),
    adminResponse.literal("inactive"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","page":"scalar","role":"scalar","search":"scalar","sortBy":"scalar","sortOrder":"scalar","status":"scalar","tenantId":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_bc1fab1ad239be509e872873d23061924f005af9c5cc05fc599e0fc13c05eee9 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_ac4d6c8c4e88e4c8e74dcb82535979b8429009c5c218468fe2cdff7b9aefcc92 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
  "page": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar","page":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_56b954e4b81c024a641592e3b559a6a9daeedcadb821a3ff2ab6c4872ec3d6f2 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "limit": adminResponse.optional(adminResponse.string()),
}), {"limit":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_8f437a7bfded24c0d1cf77e05ce8c2513f1dbd0d1e347dc48d7acd6caf781d1a = createAdminRequestContract(adminResponse.object({
  "roleCode": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_daced7bee50e6208c6f46abea97f5ee17e33dd4c085d690d98800c5990325064 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "assignerRole": adminResponse.string(),
  "targetRole": adminResponse.string(),
}), {"assignerRole":"scalar","targetRole":"scalar"}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_e1f451be13022ba785a6ba31d2cda367ebfafffb76986d0f460cf238abb440bc = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.string(),
}), "application/json");

const adminRequestSchema_ade60327c4d29eeb5822e71915c9ca7a962d9f9ca8001fafe091f5300cb4a43c = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
  "noteId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.union([
    adminResponse.literal("compliance"),
    adminResponse.literal("billing"),
    adminResponse.literal("support"),
    adminResponse.literal("general"),
    adminResponse.literal("technical"),
  ] as const)),
  "content": adminResponse.optional(adminResponse.string()),
  "isPinned": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
}), "application/json");

const adminRequestSchema_0d8271dbb00648bce92a985a3797b5da8ddbac03767ad72888defe5b1b665da6 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "newPassword": adminResponse.string(),
}), "application/json");

const adminRequestSchema_2b1447c00c2f6dd54bd4ec9f6bf3b85b7d14fc86f82dfd710cded27a553e537d = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "dryRun": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "reason": adminResponse.string(),
}), "application/json");

const adminRequestSchema_1559820e3c5aab5344e83a8f1666c21e68741bd30eedb06c4d5e1100a60fcd10 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.union([
    adminResponse.literal("compliance"),
    adminResponse.literal("billing"),
    adminResponse.literal("support"),
    adminResponse.literal("general"),
    adminResponse.literal("technical"),
  ] as const)),
  "content": adminResponse.string(),
  "isPinned": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
}), "application/json");

const adminRequestSchema_6af5545537e45688884a98cca8632397c3eff3866d5e3566d2375efc8e724999 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "tenantIds": adminResponse.array(adminResponse.string()),
}), "application/json");

const adminRequestSchema_aa6760ccad2f89a8706e78895a337920b73a5141cfe12f5d5e8352a7bc8663fa = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.string(),
  "tenantIds": adminResponse.array(adminResponse.string()),
}), "application/json");

const adminRequestSchema_15158e216fc62a34c94236e7b9cc53d89be0cc6da6fb5251777930a7ba56e14f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "action": adminResponse.optional(adminResponse.string()),
  "endDate": adminResponse.optional(adminResponse.string()),
  "entityId": adminResponse.optional(adminResponse.string()),
  "entityType": adminResponse.optional(adminResponse.string()),
  "performedBy": adminResponse.optional(adminResponse.string()),
  "search": adminResponse.optional(adminResponse.string()),
  "severity": adminResponse.optional(adminResponse.string()),
  "startDate": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_027de36a75b45a26143f0a3cd56a8ebbbeb00b06e0a09e29f14c402fc331805e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "email": adminResponse.string(),
}), "application/json");

const adminRequestSchema_d4a3ae820534e76d693c3314d3f4140a7edad2fd397c3d5589c7ef39bfd94820 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "newPassword": adminResponse.string(),
  "token": adminResponse.string(),
}), "application/json");

const adminRequestSchema_212cb83b6a442d23e2f72a85d0f8292b02d0e4d7ef407a4056f6fc0ea59b5f44 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "basePlanId": adminResponse.optional(adminResponse.string()),
  "billingCycle": adminResponse.optional(adminResponse.union([
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("semi_annual"),
    adminResponse.literal("annual"),
  ] as const)),
  "createdBy": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "discountAmount": adminResponse.optional(adminResponse.number()),
  "discountPercent": adminResponse.optional(adminResponse.number()),
  "discountReason": adminResponse.optional(adminResponse.string()),
  "modules": adminResponse.array(adminResponse.object({
    "moduleCode": adminResponse.string(),
    "moduleId": adminResponse.string(),
    "moduleName": adminResponse.string(),
    "quantities": adminResponse.object({
      "alerts": adminResponse.optional(adminResponse.number()),
      "apiCalls": adminResponse.optional(adminResponse.number()),
      "devices": adminResponse.optional(adminResponse.number()),
      "employees": adminResponse.optional(adminResponse.number()),
      "farms": adminResponse.optional(adminResponse.number()),
      "integrations": adminResponse.optional(adminResponse.number()),
      "ponds": adminResponse.optional(adminResponse.number()),
      "reports": adminResponse.optional(adminResponse.number()),
      "sensors": adminResponse.optional(adminResponse.number()),
      "storageGb": adminResponse.optional(adminResponse.number()),
      "users": adminResponse.optional(adminResponse.number()),
      "workflows": adminResponse.optional(adminResponse.number()),
    }),
  })),
  "name": adminResponse.string(),
  "notes": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
  "tier": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
    adminResponse.literal("custom"),
  ] as const)),
  "validFrom": adminResponse.dateString(),
  "validTo": adminResponse.optional(adminResponse.dateString()),
}), "application/json");

const adminRequestSchema_0cfe82a35e2ec78a61c48e874a46b86d18a660fb08c8750f71712efcee331841 = createAdminRequestContract(adminResponse.object({
  "planId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_f2675bf2b0eaa3cdf687e7c61ff431058270384a203d4aec2d05b20c711d145d = createAdminRequestContract(adminResponse.object({
  "planId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "newTenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_be551d85bf15d75fd4fbe47067169f0229a4367e04e1bef6aa915fcb6d686b03 = createAdminRequestContract(adminResponse.object({
  "planId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.string(),
}), "application/json");

const adminRequestSchema_35a8c8f45def0b6ef50abe3f1af82053f0631651d82c5a24b5d894010fcb678f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "applicablePlanIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "appliesTo": adminResponse.optional(adminResponse.union([
    adminResponse.literal("all_plans"),
    adminResponse.literal("specific_plans"),
    adminResponse.literal("upgrades_only"),
    adminResponse.literal("new_subscriptions_only"),
  ] as const)),
  "campaignId": adminResponse.optional(adminResponse.string()),
  "campaignName": adminResponse.optional(adminResponse.string()),
  "code": adminResponse.string(),
  "description": adminResponse.optional(adminResponse.string()),
  "discountType": adminResponse.union([
    adminResponse.literal("percentage"),
    adminResponse.literal("fixed_amount"),
    adminResponse.literal("free_trial_extension"),
    adminResponse.literal("free_months"),
  ] as const),
  "discountValue": adminResponse.number(),
  "duration": adminResponse.optional(adminResponse.union([
    adminResponse.literal("once"),
    adminResponse.literal("repeating"),
    adminResponse.literal("forever"),
  ] as const)),
  "durationInMonths": adminResponse.optional(adminResponse.number()),
  "isReferralCode": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "maxRedemptions": adminResponse.optional(adminResponse.number()),
  "maxRedemptionsPerTenant": adminResponse.optional(adminResponse.number()),
  "metadata": adminResponse.optional(adminResponse.record(adminResponse.json("extension-metadata"))),
  "minimumOrderAmount": adminResponse.optional(adminResponse.number()),
  "name": adminResponse.string(),
  "referrerId": adminResponse.optional(adminResponse.string()),
  "validFrom": adminResponse.optional(adminResponse.dateString()),
  "validUntil": adminResponse.optional(adminResponse.dateString()),
}), "application/json");

const adminRequestSchema_8b9ba80b0cf3ad11ba8c5999a4e5960017c84a3c0372310f58777a424a01a3d7 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_8c685ef310b896c60cc2426dec6db3f2f1a45f4c62d22651ec6f46737e24f2af = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "code": adminResponse.string(),
  "invoiceId": adminResponse.optional(adminResponse.string()),
  "originalAmount": adminResponse.number(),
  "planId": adminResponse.optional(adminResponse.string()),
  "subscriptionId": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_153727ce1318f1334a077b241b90f83e6921663590c1dd2d27a3cff196840b81 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "codePrefix": adminResponse.optional(adminResponse.string()),
  "count": adminResponse.number(),
  "template": adminResponse.object({
    "applicablePlanIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "appliesTo": adminResponse.optional(adminResponse.union([
      adminResponse.literal("all_plans"),
      adminResponse.literal("specific_plans"),
      adminResponse.literal("upgrades_only"),
      adminResponse.literal("new_subscriptions_only"),
    ] as const)),
    "campaignId": adminResponse.optional(adminResponse.string()),
    "campaignName": adminResponse.optional(adminResponse.string()),
    "description": adminResponse.optional(adminResponse.string()),
    "discountType": adminResponse.union([
      adminResponse.literal("percentage"),
      adminResponse.literal("fixed_amount"),
      adminResponse.literal("free_trial_extension"),
      adminResponse.literal("free_months"),
    ] as const),
    "discountValue": adminResponse.number(),
    "duration": adminResponse.optional(adminResponse.union([
      adminResponse.literal("once"),
      adminResponse.literal("repeating"),
      adminResponse.literal("forever"),
    ] as const)),
    "durationInMonths": adminResponse.optional(adminResponse.number()),
    "isReferralCode": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "maxRedemptions": adminResponse.optional(adminResponse.number()),
    "maxRedemptionsPerTenant": adminResponse.optional(adminResponse.number()),
    "metadata": adminResponse.optional(adminResponse.record(adminResponse.json("extension-metadata"))),
    "minimumOrderAmount": adminResponse.optional(adminResponse.number()),
    "name": adminResponse.string(),
    "referrerId": adminResponse.optional(adminResponse.string()),
    "validFrom": adminResponse.optional(adminResponse.dateString()),
    "validUntil": adminResponse.optional(adminResponse.dateString()),
  }),
}), "application/json");

const adminRequestSchema_78aebad93bf2da39b29723937290e59b257566862554ea6d24f6dd20251522cd = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "length": adminResponse.optional(adminResponse.number()),
  "prefix": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_40aed25e272f9f9d8b9da59e5863027095d121c248cdca0d4810735a337fa83f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "code": adminResponse.string(),
  "orderAmount": adminResponse.optional(adminResponse.number()),
  "planId": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_d1c4ff23e8e3a5f644f5eff0a7444e907dc2c81c9528625c3b016598c2dce01f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "billingAddress": adminResponse.object({
    "attention": adminResponse.optional(adminResponse.string()),
    "city": adminResponse.string(),
    "companyName": adminResponse.string(),
    "country": adminResponse.string(),
    "postalCode": adminResponse.string(),
    "state": adminResponse.string(),
    "street": adminResponse.string(),
    "taxId": adminResponse.optional(adminResponse.string()),
  }),
  "currency": adminResponse.optional(adminResponse.string()),
  "discount": adminResponse.optional(adminResponse.number()),
  "discountCode": adminResponse.optional(adminResponse.string()),
  "dueDate": adminResponse.string(),
  "lineItems": adminResponse.array(adminResponse.object({
    "description": adminResponse.string(),
    "productCode": adminResponse.optional(adminResponse.string()),
    "quantity": adminResponse.number(),
    "unitPrice": adminResponse.number(),
  })),
  "notes": adminResponse.optional(adminResponse.string()),
  "periodEnd": adminResponse.string(),
  "periodStart": adminResponse.string(),
  "subscriptionId": adminResponse.optional(adminResponse.string()),
  "tax": adminResponse.optional(adminResponse.object({
    "taxId": adminResponse.optional(adminResponse.string()),
    "taxName": adminResponse.optional(adminResponse.string()),
    "taxRate": adminResponse.number(),
  })),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_46013c9f70000bf48a5cc443865877bfa5d79cb56c8b2459d9e3cc7ccbccf030 = createAdminRequestContract(adminResponse.object({
  "invoiceId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "amount": adminResponse.number(),
}), "application/json");

const adminRequestSchema_f821d8efd5b7d7dcdecf7a87971824c6d7258f0cd3d8b9f6bcad9d3eb390f0aa = createAdminRequestContract(adminResponse.object({
  "invoiceId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.string(),
}), "application/json");

const adminRequestSchema_fa1e71cd5b051ec1fbb03079529a5c129e19cb28ca6a2beb8dc80f37896463c3 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "currency": adminResponse.optional(adminResponse.string()),
  "effectiveFrom": adminResponse.optional(adminResponse.dateString()),
  "effectiveTo": adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  "moduleCode": adminResponse.string(),
  "moduleId": adminResponse.string(),
  "notes": adminResponse.optional(adminResponse.string()),
  "pricingMetrics": adminResponse.array(adminResponse.object({
    "currency": adminResponse.string(),
    "description": adminResponse.optional(adminResponse.string()),
    "includedQuantity": adminResponse.optional(adminResponse.number()),
    "maxQuantity": adminResponse.optional(adminResponse.number()),
    "minQuantity": adminResponse.optional(adminResponse.number()),
    "price": adminResponse.number(),
    "type": adminResponse.union([
      adminResponse.literal("base_price"),
      adminResponse.literal("per_user"),
      adminResponse.literal("per_farm"),
      adminResponse.literal("per_pond"),
      adminResponse.literal("per_sensor"),
      adminResponse.literal("per_device"),
      adminResponse.literal("per_gb_storage"),
      adminResponse.literal("per_gb_transfer"),
      adminResponse.literal("per_api_call"),
      adminResponse.literal("per_alert"),
      adminResponse.literal("per_report"),
      adminResponse.literal("per_sms"),
      adminResponse.literal("per_email"),
      adminResponse.literal("per_integration"),
      adminResponse.literal("per_workflow"),
    ] as const),
  })),
  "tierMultipliers": adminResponse.optional(adminResponse.object({
    "custom": adminResponse.optional(adminResponse.number()),
    "enterprise": adminResponse.optional(adminResponse.number()),
    "free": adminResponse.optional(adminResponse.number()),
    "professional": adminResponse.optional(adminResponse.number()),
    "starter": adminResponse.optional(adminResponse.number()),
  })),
}), "application/json");

const adminRequestSchema_c09246dc3dc6c46e0818af571cda5408bddaf3348e52ab97285d57851e811c37 = createAdminRequestContract(adminResponse.object({
  "pricingId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_2b9671fb2eb263f420d0479108e797a3f7fc2aea56d28a92408299f5b949b29e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "moduleIdMap": adminResponse.record(adminResponse.string()),
}), "application/json");

const adminRequestSchema_9f0d8bd210ffb9e3c8b6866e4c860638212b7485a301f4e6ce522731ef3adee1 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "amount": adminResponse.number(),
  "currency": adminResponse.optional(adminResponse.string()),
  "invoiceId": adminResponse.string(),
  "notes": adminResponse.optional(adminResponse.string()),
  "paymentDate": adminResponse.optional(adminResponse.string()),
  "paymentMethod": adminResponse.string(),
}), "application/json");

const adminRequestSchema_9ce3dd28fc6fa6ec4554dd5de308ec4a019f73c46cbeb6229114b7d74bb5a885 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "amount": adminResponse.number(),
  "paymentId": adminResponse.string(),
  "reason": adminResponse.string(),
}), "application/json");

const adminRequestSchema_d07f47b502766c38bd95cbdf93877c7a583c8a62e49625e83280629e510e2e02 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "badge": adminResponse.optional(adminResponse.string()),
  "code": adminResponse.string(),
  "color": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "downgradeWarning": adminResponse.optional(adminResponse.string()),
  "features": adminResponse.object({
    "addOns": adminResponse.array(adminResponse.object({
      "billingCycle": adminResponse.union([
        adminResponse.literal("monthly"),
        adminResponse.literal("quarterly"),
        adminResponse.literal("semi_annual"),
        adminResponse.literal("annual"),
      ] as const),
      "code": adminResponse.string(),
      "description": adminResponse.string(),
      "name": adminResponse.string(),
      "price": adminResponse.number(),
    })),
    "advancedFeatures": adminResponse.array(adminResponse.string()),
    "coreFeatures": adminResponse.array(adminResponse.string()),
    "premiumFeatures": adminResponse.array(adminResponse.string()),
  }),
  "gracePeriodDays": adminResponse.optional(adminResponse.number()),
  "icon": adminResponse.optional(adminResponse.string()),
  "isRecommended": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "limits": adminResponse.object({
    "alertsEnabled": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "apiAccessEnabled": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "apiRateLimit": adminResponse.number(),
    "auditLogEnabled": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "customBrandingEnabled": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "customIntegrationsEnabled": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "dataRetentionDays": adminResponse.number(),
    "dedicatedAccountManager": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "maxFarms": adminResponse.number(),
    "maxModules": adminResponse.number(),
    "maxPonds": adminResponse.number(),
    "maxSensors": adminResponse.number(),
    "maxUsers": adminResponse.number(),
    "prioritySupport": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "reportsEnabled": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "ssoEnabled": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "storageGB": adminResponse.number(),
  }),
  "name": adminResponse.string(),
  "pricing": adminResponse.object({
    "annual": adminResponse.object({
      "basePrice": adminResponse.number(),
      "discountPercent": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    }),
    "currency": adminResponse.string(),
    "monthly": adminResponse.object({
      "basePrice": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    }),
    "quarterly": adminResponse.object({
      "basePrice": adminResponse.number(),
      "discountPercent": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    }),
    "semiAnnual": adminResponse.object({
      "basePrice": adminResponse.number(),
      "discountPercent": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    }),
  }),
  "shortDescription": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.number()),
  "tier": adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
    adminResponse.literal("custom"),
  ] as const),
  "trialDays": adminResponse.optional(adminResponse.number()),
  "upgradeMessage": adminResponse.optional(adminResponse.string()),
  "visibility": adminResponse.optional(adminResponse.union([
    adminResponse.literal("public"),
    adminResponse.literal("private"),
    adminResponse.literal("deprecated"),
  ] as const)),
}), "application/json");

const adminRequestSchema_96830556a81bdaf725e4e4d28808b1502598489b9c0830ca7b1c9a16421b3dac = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "currentPlanId": adminResponse.string(),
  "newPlanId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_7f83b55ea74d8261da5f7e8635dbb394c4c690847f1bb2b1eea359fd5109b4f2 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_b293323c6278c5d85eac848825484ef92191ba213dc528ba17c3b320d93d16ac = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "billingCycle": adminResponse.union([
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("semi_annual"),
    adminResponse.literal("annual"),
  ] as const),
  "discountCode": adminResponse.optional(adminResponse.string()),
  "modules": adminResponse.array(adminResponse.object({
    "moduleCode": adminResponse.string(),
    "moduleId": adminResponse.string(),
    "moduleName": adminResponse.optional(adminResponse.string()),
    "quantities": adminResponse.object({
      "alerts": adminResponse.optional(adminResponse.number()),
      "apiCalls": adminResponse.optional(adminResponse.number()),
      "devices": adminResponse.optional(adminResponse.number()),
      "employees": adminResponse.optional(adminResponse.number()),
      "farms": adminResponse.optional(adminResponse.number()),
      "integrations": adminResponse.optional(adminResponse.number()),
      "ponds": adminResponse.optional(adminResponse.number()),
      "reports": adminResponse.optional(adminResponse.number()),
      "sensors": adminResponse.optional(adminResponse.number()),
      "storageGb": adminResponse.optional(adminResponse.number()),
      "users": adminResponse.optional(adminResponse.number()),
      "workflows": adminResponse.optional(adminResponse.number()),
    }),
  })),
  "taxRate": adminResponse.optional(adminResponse.number()),
  "tier": adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
    adminResponse.literal("custom"),
  ] as const),
}), "application/json");

const adminRequestSchema_b13bb7de7e39ed2bc0c9faa98b093c8983917aec7c8bf0d5f9cd93893434bbca = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "config1": adminResponse.object({
    "billingCycle": adminResponse.union([
      adminResponse.literal("monthly"),
      adminResponse.literal("quarterly"),
      adminResponse.literal("semi_annual"),
      adminResponse.literal("annual"),
    ] as const),
    "discountCode": adminResponse.optional(adminResponse.string()),
    "modules": adminResponse.array(adminResponse.object({
      "moduleCode": adminResponse.string(),
      "moduleId": adminResponse.string(),
      "moduleName": adminResponse.optional(adminResponse.string()),
      "quantities": adminResponse.object({
        "alerts": adminResponse.optional(adminResponse.number()),
        "apiCalls": adminResponse.optional(adminResponse.number()),
        "devices": adminResponse.optional(adminResponse.number()),
        "employees": adminResponse.optional(adminResponse.number()),
        "farms": adminResponse.optional(adminResponse.number()),
        "integrations": adminResponse.optional(adminResponse.number()),
        "ponds": adminResponse.optional(adminResponse.number()),
        "reports": adminResponse.optional(adminResponse.number()),
        "sensors": adminResponse.optional(adminResponse.number()),
        "storageGb": adminResponse.optional(adminResponse.number()),
        "users": adminResponse.optional(adminResponse.number()),
        "workflows": adminResponse.optional(adminResponse.number()),
      }),
    })),
    "taxRate": adminResponse.optional(adminResponse.number()),
    "tier": adminResponse.union([
      adminResponse.literal("free"),
      adminResponse.literal("starter"),
      adminResponse.literal("professional"),
      adminResponse.literal("enterprise"),
      adminResponse.literal("custom"),
    ] as const),
  }),
  "config2": adminResponse.object({
    "billingCycle": adminResponse.union([
      adminResponse.literal("monthly"),
      adminResponse.literal("quarterly"),
      adminResponse.literal("semi_annual"),
      adminResponse.literal("annual"),
    ] as const),
    "discountCode": adminResponse.optional(adminResponse.string()),
    "modules": adminResponse.array(adminResponse.object({
      "moduleCode": adminResponse.string(),
      "moduleId": adminResponse.string(),
      "moduleName": adminResponse.optional(adminResponse.string()),
      "quantities": adminResponse.object({
        "alerts": adminResponse.optional(adminResponse.number()),
        "apiCalls": adminResponse.optional(adminResponse.number()),
        "devices": adminResponse.optional(adminResponse.number()),
        "employees": adminResponse.optional(adminResponse.number()),
        "farms": adminResponse.optional(adminResponse.number()),
        "integrations": adminResponse.optional(adminResponse.number()),
        "ponds": adminResponse.optional(adminResponse.number()),
        "reports": adminResponse.optional(adminResponse.number()),
        "sensors": adminResponse.optional(adminResponse.number()),
        "storageGb": adminResponse.optional(adminResponse.number()),
        "users": adminResponse.optional(adminResponse.number()),
        "workflows": adminResponse.optional(adminResponse.number()),
      }),
    })),
    "taxRate": adminResponse.optional(adminResponse.number()),
    "tier": adminResponse.union([
      adminResponse.literal("free"),
      adminResponse.literal("starter"),
      adminResponse.literal("professional"),
      adminResponse.literal("enterprise"),
      adminResponse.literal("custom"),
    ] as const),
  }),
}), "application/json");

const adminRequestSchema_b015e78dbd75d5dabe153baf403a06e182e0c65a05eb3690f2cfb197e045e5c2 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "moduleCodes": adminResponse.array(adminResponse.string()),
  "quantities": adminResponse.optional(adminResponse.object({
    "farms": adminResponse.optional(adminResponse.number()),
    "ponds": adminResponse.optional(adminResponse.number()),
    "sensors": adminResponse.optional(adminResponse.number()),
    "users": adminResponse.optional(adminResponse.number()),
  })),
  "tier": adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
    adminResponse.literal("custom"),
  ] as const),
}), "application/json");

const adminRequestSchema_6ea0a2fd66e20917b02a5f6407b5cff7ae63126dba2258c11f01ed9b99d4edcd = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "currentPlanId": adminResponse.string(),
  "discountCode": adminResponse.optional(adminResponse.string()),
  "effectiveImmediately": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "newBillingCycle": adminResponse.optional(adminResponse.union([
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("semi_annual"),
    adminResponse.literal("annual"),
  ] as const)),
  "newPlanId": adminResponse.string(),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_bcad9a5a0fa65a9823ab6e43819cf407341eba1ad6eea8b1678deffd02d139ff = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "cancelImmediately": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "reason": adminResponse.string(),
}), "application/json");

const adminRequestSchema_aa85ef383791d6d9d1ff7c183e116b8bb74b82e45a93dc5dc13e751068739b53 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "additionalDays": adminResponse.number(),
}), "application/json");

const adminRequestSchema_a1f1dd2463f5775c5f804373a91406da9de01046f3eac214d8bb9ef20872f6c9 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_2008eae165423e607e1feafd2c3326e58fb9e014f2a57cf6a9b89038e76b6c91 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "params": adminResponse.optional(adminResponse.array(adminResponse.json("database-record"))),
  "sql": adminResponse.string(),
}), "application/json");

const adminRequestSchema_4a7fd0f9caccbe426ccc47b2c55528d3343164106a3c110cf2ca6ec6c7fbbcd8 = createAdminRequestContract(adminResponse.object({
  "schema": adminResponse.string(),
  "table": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "data": adminResponse.record(adminResponse.json("database-record")),
}), "application/json");

const adminRequestSchema_c1aa4d27fe82cf0cfcd7118743eae8431d38c7fb415e3a36e031701daa800ebc = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "executedBy": adminResponse.optional(adminResponse.string()),
  "isDryRun": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "version": adminResponse.string(),
}), "application/json");

const adminRequestSchema_c71505ce7514070bc75dffcadd9b4c4ec52313aa3046470b8451832374ae9896 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "executedBy": adminResponse.optional(adminResponse.string()),
  "version": adminResponse.string(),
}), "application/json");

const adminRequestSchema_8215349d0b480d096dea5d9ef70bc5fbe0921ef9fc0621e6a5eef0f624d6dc45 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "executedBy": adminResponse.optional(adminResponse.string()),
  "isDryRun": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "version": adminResponse.string(),
}), "application/json");

const adminRequestSchema_adecfce314ad3c74119fcca4d18c40708b07269d99b1d62831abe2e820c40ea6 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "query": adminResponse.string(),
  "schemaName": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_7ae764aab621bdce87ff4c14c771aa7479799c383a63624856febc9606415613 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_ee6de03aa42f7bce4ccebd273e03edcbd124c540a07cd2a82a600ca1c49af772 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "modules": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_0223111232796b1a235403fe159a507e53227ff20a2f85ae80cce601ef13daac = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "clientIp": adminResponse.optional(adminResponse.string()),
  "correlationId": adminResponse.optional(adminResponse.string()),
  "durationMs": adminResponse.number(),
  "endpoint": adminResponse.string(),
  "errorMessage": adminResponse.optional(adminResponse.string()),
  "fullUrl": adminResponse.optional(adminResponse.string()),
  "hasError": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "method": adminResponse.string(),
  "queryParams": adminResponse.optional(adminResponse.record(adminResponse.string())),
  "requestBody": adminResponse.optional(adminResponse.json("debug-observation")),
  "requestHeaders": adminResponse.optional(adminResponse.record(adminResponse.string())),
  "responseBody": adminResponse.optional(adminResponse.json("debug-observation")),
  "responseHeaders": adminResponse.optional(adminResponse.record(adminResponse.string())),
  "responseStatus": adminResponse.number(),
  "tenantId": adminResponse.string(),
  "userAgent": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_da09d1595d98ea5036c42edc7fb304b1f92cb6740bd5f4b0d856ce5c316cbd36 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "pattern": adminResponse.string(),
}), "application/json");

const adminRequestSchema_c39d71809815835b7f5bbe222511d2ea03bc9f2500f4be4e98587a515bbe0890 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "expiresAt": adminResponse.optional(adminResponse.string()),
  "featureKey": adminResponse.string(),
  "originalValue": adminResponse.json("debug-observation"),
  "overrideValue": adminResponse.json("operator-configuration"),
  "reason": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_b7614b237f3a3720d09429129aacbab7138aecab1b5c2fbf40acba8aefeaf351 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_a2b2be5f3eb533ed1ac603d412ab9c900b3eeac12b40b6b8f03f9eddb5b675d8 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "connectionSource": adminResponse.optional(adminResponse.string()),
  "durationMs": adminResponse.number(),
  "errorMessage": adminResponse.optional(adminResponse.string()),
  "explainPlan": adminResponse.optional(adminResponse.record(adminResponse.json("debug-observation"))),
  "hasError": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "parameters": adminResponse.optional(adminResponse.array(adminResponse.json("debug-observation"))),
  "query": adminResponse.string(),
  "queryType": adminResponse.union([
    adminResponse.literal("select"),
    adminResponse.literal("insert"),
    adminResponse.literal("update"),
    adminResponse.literal("delete"),
    adminResponse.literal("transaction"),
    adminResponse.literal("schema"),
  ] as const),
  "rowsAffected": adminResponse.optional(adminResponse.number()),
  "rowsReturned": adminResponse.optional(adminResponse.number()),
  "stackTrace": adminResponse.optional(adminResponse.string()),
  "tableName": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_113ecc81bd4c3e2a25e7b1453252ae7c5157bc49aaeefb4a37c7d52e0078b4dd = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "configuration": adminResponse.optional(adminResponse.record(adminResponse.json("debug-observation"))),
  "durationMinutes": adminResponse.optional(adminResponse.number()),
  "filters": adminResponse.optional(adminResponse.object({
    "apiEndpoints": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "cacheKeys": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "endTime": adminResponse.optional(adminResponse.string()),
    "includeErrors": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "minDuration": adminResponse.optional(adminResponse.number()),
    "queryTypes": adminResponse.optional(adminResponse.array(adminResponse.union([
      adminResponse.literal("select"),
      adminResponse.literal("insert"),
      adminResponse.literal("update"),
      adminResponse.literal("delete"),
      adminResponse.literal("transaction"),
      adminResponse.literal("schema"),
    ] as const))),
    "startTime": adminResponse.optional(adminResponse.string()),
    "userId": adminResponse.optional(adminResponse.string()),
  })),
  "maxResults": adminResponse.optional(adminResponse.number()),
  "sessionType": adminResponse.union([
    adminResponse.literal("query_inspection"),
    adminResponse.literal("api_log_viewing"),
    adminResponse.literal("cache_inspection"),
    adminResponse.literal("feature_flag_override"),
    adminResponse.literal("performance_profiling"),
    adminResponse.literal("error_debugging"),
  ] as const),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_931f41b53b28ba303047b40267e352ec661024a5313c349e4ee4c56aed5c66c5 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "allowedTenants": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "defaultPermissions": adminResponse.optional(adminResponse.object({
    "allowedModules": adminResponse.optional(adminResponse.array(adminResponse.union([
      adminResponse.literal("farm"),
      adminResponse.literal("hr"),
      adminResponse.literal("messaging"),
      adminResponse.literal("ai"),
      adminResponse.literal("auth"),
      adminResponse.literal("sensor"),
      adminResponse.literal("alert"),
      adminResponse.literal("hydroponics"),
      adminResponse.literal("billing"),
      adminResponse.literal("notification"),
      adminResponse.literal("config"),
    ] as const))),
    "canAccessSettings": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "canExportData": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "canManageUsers": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "canModifyData": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "canViewBilling": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "canViewData": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "restrictedModules": adminResponse.optional(adminResponse.array(adminResponse.union([
      adminResponse.literal("farm"),
      adminResponse.literal("hr"),
      adminResponse.literal("messaging"),
      adminResponse.literal("ai"),
      adminResponse.literal("auth"),
      adminResponse.literal("sensor"),
      adminResponse.literal("alert"),
      adminResponse.literal("hydroponics"),
      adminResponse.literal("billing"),
      adminResponse.literal("notification"),
      adminResponse.literal("config"),
    ] as const))),
  })),
  "expiresAt": adminResponse.optional(adminResponse.string()),
  "maxConcurrentSessions": adminResponse.optional(adminResponse.number()),
  "maxSessionDurationMinutes": adminResponse.optional(adminResponse.number()),
  "notes": adminResponse.optional(adminResponse.string()),
  "notifyTenantAdmin": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "requireReason": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "requireTicketReference": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "restrictedTenants": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "superAdminEmail": adminResponse.optional(adminResponse.string()),
  "superAdminId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_e30810b7a07561f416c59cc887050f9a097f1b66c53ea0050b26b43ab8567504 = createAdminRequestContract(adminResponse.object({
  "superAdminId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3dcdc010b043115303502cff423a9c86212384075a1fcf15a2cb4c288dc864b1 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_fe7e7ae91eca2f0488d86094a2eeff08a29b930c8a9e2cb3132011e70eb84bb1 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "additionalMinutes": adminResponse.number(),
}), "application/json");

const adminRequestSchema_a9b7da086f4f002825dcfa5729accea43ced85d813c9e5f82f2390ea20efcbfc = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.string(),
}), "application/json");

const adminRequestSchema_73010adb2e55607bdb8dac67fe66f55c2139e55e5ecec0c9b6b96318de0a79a5 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({
  "x-impersonation-token": adminResponse.string(),
}), adminResponse.object({
  "authorizationReceiptId": adminResponse.string(),
  "bodyHash": adminResponse.string(),
  "effectiveTenantId": adminResponse.string(),
  "method": adminResponse.union([
    adminResponse.literal("GET"),
    adminResponse.literal("POST"),
    adminResponse.literal("DELETE"),
    adminResponse.literal("HEAD"),
    adminResponse.literal("OPTIONS"),
    adminResponse.literal("PATCH"),
    adminResponse.literal("PUT"),
  ] as const),
  "normalizedPath": adminResponse.string(),
  "normalizedQueryHash": adminResponse.string(),
  "requestDigest": adminResponse.string(),
  "schemaVersion": adminResponse.literal("impersonation-authorization-receipt/v1"),
  "sessionId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_f21be8cb725a5cadff1044c699f765922ff743b06a897e025d20fffb416759a2 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({
  "x-impersonation-token": adminResponse.string(),
}), adminResponse.object({
  "authorizationReceiptId": adminResponse.string(),
  "bodyHash": adminResponse.string(),
  "effectiveTenantId": adminResponse.string(),
  "method": adminResponse.union([
    adminResponse.literal("GET"),
    adminResponse.literal("POST"),
    adminResponse.literal("DELETE"),
    adminResponse.literal("HEAD"),
    adminResponse.literal("OPTIONS"),
    adminResponse.literal("PATCH"),
    adminResponse.literal("PUT"),
  ] as const),
  "normalizedPath": adminResponse.string(),
  "normalizedQueryHash": adminResponse.string(),
  "operationSetDigest": adminResponse.string(),
  "operations": adminResponse.array(adminResponse.object({
    "authority": adminResponse.union([
      adminResponse.literal("export"),
      adminResponse.literal("data.read"),
      adminResponse.literal("data.write"),
      adminResponse.literal("billing.read"),
      adminResponse.literal("billing.write"),
      adminResponse.literal("users.read"),
      adminResponse.literal("users.write"),
      adminResponse.literal("settings.read"),
      adminResponse.literal("settings.write"),
    ] as const),
    "module": adminResponse.union([
      adminResponse.literal("farm"),
      adminResponse.literal("hr"),
      adminResponse.literal("messaging"),
      adminResponse.literal("ai"),
      adminResponse.literal("auth"),
      adminResponse.literal("sensor"),
      adminResponse.literal("alert"),
      adminResponse.literal("hydroponics"),
      adminResponse.literal("billing"),
      adminResponse.literal("notification"),
      adminResponse.literal("config"),
    ] as const),
    "operation": adminResponse.string(),
  })),
  "requestDigest": adminResponse.string(),
  "schemaVersion": adminResponse.literal("impersonation-authorization-receipt/v1"),
  "sessionId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_b46d55dd657c0081ebfd4189d1695472e82a9169f0d8df9f8d4902311f5ba376 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "durationMinutes": adminResponse.optional(adminResponse.number()),
  "permissions": adminResponse.optional(adminResponse.object({
    "allowedModules": adminResponse.optional(adminResponse.array(adminResponse.union([
      adminResponse.literal("farm"),
      adminResponse.literal("hr"),
      adminResponse.literal("messaging"),
      adminResponse.literal("ai"),
      adminResponse.literal("auth"),
      adminResponse.literal("sensor"),
      adminResponse.literal("alert"),
      adminResponse.literal("hydroponics"),
      adminResponse.literal("billing"),
      adminResponse.literal("notification"),
      adminResponse.literal("config"),
    ] as const))),
    "canAccessSettings": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "canExportData": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "canManageUsers": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "canModifyData": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "canViewBilling": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "canViewData": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "restrictedModules": adminResponse.optional(adminResponse.array(adminResponse.union([
      adminResponse.literal("farm"),
      adminResponse.literal("hr"),
      adminResponse.literal("messaging"),
      adminResponse.literal("ai"),
      adminResponse.literal("auth"),
      adminResponse.literal("sensor"),
      adminResponse.literal("alert"),
      adminResponse.literal("hydroponics"),
      adminResponse.literal("billing"),
      adminResponse.literal("notification"),
      adminResponse.literal("config"),
    ] as const))),
  })),
  "reason": adminResponse.union([
    adminResponse.literal("support_request"),
    adminResponse.literal("debugging"),
    adminResponse.literal("configuration"),
    adminResponse.literal("onboarding_assistance"),
    adminResponse.literal("security_investigation"),
    adminResponse.literal("data_verification"),
    adminResponse.literal("other"),
  ] as const),
  "reasonDetails": adminResponse.optional(adminResponse.string()),
  "targetTenantId": adminResponse.string(),
  "targetTenantName": adminResponse.optional(adminResponse.string()),
  "targetUserEmail": adminResponse.optional(adminResponse.string()),
  "targetUserId": adminResponse.optional(adminResponse.string()),
  "ticketReference": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_7172305de68aa1711b903bf5fad364664c15edc030f62bca6e54573d7474034d = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "channelId": adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  "expiresAt": adminResponse.optional(adminResponse.string()),
  "legalMatterDescription": adminResponse.optional(adminResponse.string()),
  "legalMatterId": adminResponse.string(),
  "reason": adminResponse.string(),
  "requestedBy": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_6660ed2015fee005506790c103c688c4fe9b952718be5c444691f174a9e63f59 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "format": adminResponse.optional(adminResponse.union([
    adminResponse.literal("json"),
    adminResponse.literal("csv"),
  ] as const)),
}), "application/json");

const adminRequestSchema_e191bab04684cd10c56fae223c5fca99d4a9fda565541825f1816db8c53b7da1 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "code": adminResponse.string(),
  "defaultRoute": adminResponse.string(),
  "description": adminResponse.optional(adminResponse.string()),
  "icon": adminResponse.optional(adminResponse.string()),
  "isCore": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "name": adminResponse.string(),
}), "application/json");

const adminRequestSchema_4ed0cfed5b64b800c606ba07d01722ff33fcb372bd55926904074e808cc23b69 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "configuration": adminResponse.optional(adminResponse.record(adminResponse.json("operator-configuration"))),
  "expiresAt": adminResponse.optional(adminResponse.dateString()),
  "moduleId": adminResponse.string(),
  "quantities": adminResponse.optional(adminResponse.object({
    "alerts": adminResponse.optional(adminResponse.number()),
    "apiCalls": adminResponse.optional(adminResponse.number()),
    "devices": adminResponse.optional(adminResponse.number()),
    "employees": adminResponse.optional(adminResponse.number()),
    "farms": adminResponse.optional(adminResponse.number()),
    "integrations": adminResponse.optional(adminResponse.number()),
    "ponds": adminResponse.optional(adminResponse.number()),
    "reports": adminResponse.optional(adminResponse.number()),
    "sensors": adminResponse.optional(adminResponse.number()),
    "storageGb": adminResponse.optional(adminResponse.number()),
    "users": adminResponse.optional(adminResponse.number()),
    "workflows": adminResponse.optional(adminResponse.number()),
  })),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_9dc2847760913eaa9b015a0e5f15eaa1bc7291bbd200c6444ddead029a92a1c9 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "defaultFilters": adminResponse.optional(adminResponse.record(adminResponse.json("report-dataset"))),
  "defaultFormat": adminResponse.optional(adminResponse.union([
    adminResponse.literal("json"),
    adminResponse.literal("csv"),
    adminResponse.literal("pdf"),
  ] as const)),
  "description": adminResponse.optional(adminResponse.string()),
  "name": adminResponse.string(),
  "type": adminResponse.union([
    adminResponse.literal("tenant_overview"),
    adminResponse.literal("tenant_churn"),
    adminResponse.literal("financial_revenue"),
    adminResponse.literal("financial_payments"),
    adminResponse.literal("usage_modules"),
    adminResponse.literal("usage_features"),
    adminResponse.literal("system_performance"),
  ] as const),
}), "application/json");

const adminRequestSchema_06b408b99b54da899e46f6b4651b5542233a97d63b353d93153a7498f30fc385 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "definitionId": adminResponse.optional(adminResponse.string()),
  "endDate": adminResponse.optional(adminResponse.string()),
  "filters": adminResponse.optional(adminResponse.record(adminResponse.json("report-dataset"))),
  "format": adminResponse.union([
    adminResponse.literal("json"),
    adminResponse.literal("csv"),
    adminResponse.literal("pdf"),
  ] as const),
  "reportName": adminResponse.optional(adminResponse.string()),
  "reportType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("tenant_overview"),
    adminResponse.literal("tenant_churn"),
    adminResponse.literal("financial_revenue"),
    adminResponse.literal("financial_payments"),
    adminResponse.literal("usage_modules"),
    adminResponse.literal("usage_features"),
    adminResponse.literal("system_performance"),
  ] as const)),
  "startDate": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_993fb544e2db99df1bea992f9856daab73a66324850595dc0b293a98cd570935 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "complianceFramework": adminResponse.union([
    adminResponse.literal("gdpr"),
    adminResponse.literal("ccpa"),
    adminResponse.literal("hipaa"),
    adminResponse.literal("pci_dss"),
    adminResponse.literal("sox"),
    adminResponse.literal("iso27001"),
  ] as const),
  "dataCategories": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "description": adminResponse.string(),
  "requestType": adminResponse.union([
    adminResponse.literal("access"),
    adminResponse.literal("deletion"),
    adminResponse.literal("portability"),
    adminResponse.literal("rectification"),
    adminResponse.literal("restriction"),
  ] as const),
  "requesterEmail": adminResponse.string(),
  "requesterName": adminResponse.string(),
  "specificData": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
  "tenantName": adminResponse.string(),
}), "application/json");

const adminRequestSchema_6feef65ef2f2db79dbd3e4f0257063b20cf3c9974e5bfbb5f95b16496cf44e2e = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "completionNotes": adminResponse.string(),
  "deliveryFormat": adminResponse.optional(adminResponse.union([
    adminResponse.literal("json"),
    adminResponse.literal("xml"),
    adminResponse.literal("csv"),
    adminResponse.literal("pdf"),
  ] as const)),
  "downloadExpiresAt": adminResponse.optional(adminResponse.string()),
  "downloadUrl": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_4d6a89747cca763c31f33c20ccd1815316861beb0c4bc2e986fbf1faeb678624 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "verificationMethod": adminResponse.string(),
}), "application/json");

const adminRequestSchema_ef792c2a470a835f1d4913b40e8b2772cd1aaee72eaf4e75a3d6aba296a760bf = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "complianceType": adminResponse.union([
    adminResponse.literal("gdpr"),
    adminResponse.literal("ccpa"),
    adminResponse.literal("hipaa"),
    adminResponse.literal("pci_dss"),
    adminResponse.literal("sox"),
    adminResponse.literal("iso27001"),
  ] as const),
  "includedTenants": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "reportPeriodEnd": adminResponse.string(),
  "reportPeriodStart": adminResponse.string(),
}), "application/json");

const adminRequestSchema_c37ac458f17a05b90b5219e3ef76e260c0ba05c310e26e245c68f5d1e163faa3 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "email": adminResponse.string(),
  "geoLocation": adminResponse.optional(adminResponse.object({
    "city": adminResponse.string(),
    "country": adminResponse.string(),
    "countryCode": adminResponse.string(),
    "latitude": adminResponse.number(),
    "longitude": adminResponse.number(),
    "region": adminResponse.string(),
    "timezone": adminResponse.string(),
  })),
  "ipAddress": adminResponse.string(),
  "success": adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_362422a849f6e21b580ab2b6881cb9d647d4f97dd181c156b7b38c8e15eef249 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "confidenceScore": adminResponse.optional(adminResponse.number()),
  "description": adminResponse.string(),
  "detectionSource": adminResponse.string(),
  "eventType": adminResponse.union([
    adminResponse.literal("rate_limit_exceeded"),
    adminResponse.literal("suspicious_activity"),
    adminResponse.literal("failed_login"),
    adminResponse.literal("brute_force_attempt"),
    adminResponse.literal("unauthorized_access"),
    adminResponse.literal("privilege_escalation"),
    adminResponse.literal("data_exfiltration"),
    adminResponse.literal("malware_detected"),
    adminResponse.literal("api_abuse"),
    adminResponse.literal("sql_injection_attempt"),
    adminResponse.literal("xss_attempt"),
    adminResponse.literal("csrf_attempt"),
    adminResponse.literal("account_lockout"),
    adminResponse.literal("password_spray"),
    adminResponse.literal("credential_stuffing"),
    adminResponse.literal("session_hijacking"),
    adminResponse.literal("ip_blacklisted"),
    adminResponse.literal("geo_anomaly"),
    adminResponse.literal("device_anomaly"),
    adminResponse.literal("time_anomaly"),
  ] as const),
  "geoLocation": adminResponse.optional(adminResponse.object({
    "city": adminResponse.string(),
    "country": adminResponse.string(),
    "countryCode": adminResponse.string(),
    "latitude": adminResponse.number(),
    "longitude": adminResponse.number(),
    "region": adminResponse.string(),
    "timezone": adminResponse.string(),
  })),
  "ipAddress": adminResponse.string(),
  "rawData": adminResponse.optional(adminResponse.record(adminResponse.json("external-system-record"))),
  "targetEndpoint": adminResponse.optional(adminResponse.string()),
  "targetResource": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "threatLevel": adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const),
  "title": adminResponse.string(),
  "userId": adminResponse.optional(adminResponse.string()),
  "userName": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_439c81b4493ed187d6a161ca0e6dfcfc6b578ef2130608851d9a4eecca1a00f9 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "description": adminResponse.optional(adminResponse.string()),
  "indicatorType": adminResponse.union([
    adminResponse.literal("domain"),
    adminResponse.literal("email"),
    adminResponse.literal("cidr"),
    adminResponse.literal("url"),
    adminResponse.literal("ip"),
    adminResponse.literal("hash"),
    adminResponse.literal("user_agent"),
  ] as const),
  "source": adminResponse.string(),
  "threatLevel": adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const),
  "threatTypes": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "validUntil": adminResponse.optional(adminResponse.string()),
  "value": adminResponse.string(),
}), "application/json");

const adminRequestSchema_c7a1c8fddf0c9e4ce1ecf88c0c3a95384c9d867292e124e8f53c7160ad710baa = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "to": adminResponse.string(),
}), "application/json");

const adminRequestSchema_5a43b0e4a0f3ae3e55bdc5728b9ff41c0627bf8f01491a5250dd45ea8d6c27e8 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "bodyHtml": adminResponse.string(),
  "bodyText": adminResponse.optional(adminResponse.string()),
  "category": adminResponse.string(),
  "code": adminResponse.string(),
  "description": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "name": adminResponse.string(),
  "subject": adminResponse.string(),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "variables": adminResponse.optional(adminResponse.array(adminResponse.object({
    "defaultValue": adminResponse.optional(adminResponse.string()),
    "description": adminResponse.string(),
    "name": adminResponse.string(),
    "required": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
  }))),
}), "application/json");

const adminRequestSchema_b4e54680ff764f70bc2ccc39c80573d47bab7de9a1262298a5ff04ecdd1f5d74 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "recipientEmail": adminResponse.string(),
  "variables": adminResponse.record(adminResponse.string()),
}), "application/json");

const adminRequestSchema_29799466bd33e631820b417de27b8b1d18e91b9ab6935ab42009675791dee64c = createAdminRequestContract(adminResponse.object({
  "code": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "bodyHtml": adminResponse.optional(adminResponse.string()),
  "bodyText": adminResponse.optional(adminResponse.string()),
  "subject": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.string(),
  "variables": adminResponse.optional(adminResponse.array(adminResponse.object({
    "defaultValue": adminResponse.optional(adminResponse.string()),
    "description": adminResponse.string(),
    "name": adminResponse.string(),
    "required": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
  }))),
}), "application/json");

const adminRequestSchema_70dd2156a6e9a87de8a50098f7d36cdaf87f5c4d3b4dc5d07d5c559cd7ce873a = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "templateCode": adminResponse.string(),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "variables": adminResponse.record(adminResponse.string()),
}), "application/json");

const adminRequestSchema_1ba3644a9ce613ec9fd09d3cb8c49c39d25eb0d181abc1417e12073d4fe021f8 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "bodyHtml": adminResponse.string(),
  "variables": adminResponse.array(adminResponse.object({
    "defaultValue": adminResponse.optional(adminResponse.string()),
    "description": adminResponse.string(),
    "name": adminResponse.string(),
    "required": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
  })),
}), "application/json");

const adminRequestSchema_8ff0b76742913749f7b83cac8847c3261bf19faaa88ff546ab6efb8aecdf0176 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "data": adminResponse.record(adminResponse.json("operator-configuration")),
}), "application/json");

const adminRequestSchema_6597b22a47e0249580be0e75acfd60b8f58b24a0d1a4c029e99d9a4827f78acf = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "createdBy": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "expiresAt": adminResponse.optional(adminResponse.dateString()),
  "ipAddress": adminResponse.string(),
  "ruleType": adminResponse.union([
    adminResponse.literal("whitelist"),
    adminResponse.literal("blacklist"),
  ] as const),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_c28c521d1db5f40e8c45177503d6a547c51572f87510739b58746fa352c953d3 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "ips": adminResponse.array(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_cb09fa9febac261043ff55a91f67caf946feb665e216b4bae33c39c2a7b58486 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "ip": adminResponse.string(),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_0e10caf6a0ca6721dc12b3be8f00da3d4482a725c335ff09ade6e5a8c2a02a38 = createAdminRequestContract(adminResponse.object({
  "key": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_a0698b0c864322d30f2cdbc12f18db31fb8270eff3f4e159b6456174a2148712 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "content": adminResponse.string(),
  "expiresAt": adminResponse.optional(adminResponse.string()),
  "isGlobal": adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  "publishAt": adminResponse.optional(adminResponse.string()),
  "requiresAcknowledgment": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "targetCriteria": adminResponse.optional(adminResponse.object({
    "excludeTenantIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "includeInactive": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "modules": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "plans": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "regions": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "tenantIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "tenantStatuses": adminResponse.optional(adminResponse.array(adminResponse.string())),
  })),
  "title": adminResponse.string(),
  "type": adminResponse.union([
    adminResponse.literal("maintenance"),
    adminResponse.literal("warning"),
    adminResponse.literal("critical"),
    adminResponse.literal("info"),
  ] as const),
}), "application/json");

const adminRequestSchema_86f9ca7beb177ab710b93b934819e4b2a92a7813b0a38dab7896a2ee58cd77c5 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "tenantId": adminResponse.string(),
  "userId": adminResponse.string(),
  "userName": adminResponse.string(),
}), "application/json");

const adminRequestSchema_f5f35d8082b17bfea9277173136d03d1e7a7d07934d7590ed98dc1a307d1a70e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "content": adminResponse.string(),
  "sendEmail": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "subject": adminResponse.string(),
  "targetCriteria": adminResponse.optional(adminResponse.object({
    "excludeTenantIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "includeInactive": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "modules": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "plans": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "regions": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "tenantIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "tenantStatuses": adminResponse.optional(adminResponse.array(adminResponse.string())),
  })),
  "tenantIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
}), "application/json");

const adminRequestSchema_096bbf444f04cdfe04c8a2f6898f341e6d874fb3bdf4b0df39a3b6daa889f778 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "content": adminResponse.string(),
  "senderName": adminResponse.optional(adminResponse.string()),
  "subject": adminResponse.string(),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_b90f94c019a5b1687c4b620e5c3f8bdc84df17b80e9338d692341cafa481fa16 = createAdminRequestContract(adminResponse.object({
  "threadId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "attachments": adminResponse.optional(adminResponse.array(adminResponse.object({
    "fileName": adminResponse.string(),
    "fileSize": adminResponse.number(),
    "id": adminResponse.string(),
    "mimeType": adminResponse.string(),
    "uploadedAt": adminResponse.string(),
    "url": adminResponse.string(),
  }))),
  "content": adminResponse.string(),
  "isInternal": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "senderName": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_2577423d147a79632a016b05cdba7ae04ea3e8e68121898c6744a0f1dee3bc20 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "guideId": adminResponse.string(),
  "guideName": adminResponse.string(),
}), "application/json");

const adminRequestSchema_00b22780b8ef33813987e16ee48ff0b67414924c7d1f12d345b195ae4965fee6 = createAdminRequestContract(adminResponse.object({
  "stepId": adminResponse.string(),
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_3d155c8437ec4ff7f77fbcec657f365b70d457860500677df0e9a3327ef5b4cf = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "duration": adminResponse.number(),
  "meetingUrl": adminResponse.optional(adminResponse.string()),
  "scheduledAt": adminResponse.string(),
  "title": adminResponse.string(),
  "trainer": adminResponse.string(),
  "type": adminResponse.union([
    adminResponse.literal("video_call"),
    adminResponse.literal("webinar"),
    adminResponse.literal("in_person"),
  ] as const),
}), "application/json");

const adminRequestSchema_6f6d027ed325b1c1223119cc9b0bdb10657da37bf9f06d83e790c942ceb20c0f = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
  "tutorialId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.void(), null);

const adminRequestSchema_5bac640dd0f9a6c8f01b0f79c60141f5a8f1afaca2b0703338f335328a12b118 = createAdminRequestContract(adminResponse.object({
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "recipientEmail": adminResponse.string(),
  "recipientName": adminResponse.string(),
}), "application/json");

const adminRequestSchema_e0bd6cde657eea584e84f58d0ca13086bfd24692a31d3223cdb9827138cbfb09 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "tenantId": adminResponse.string(),
  "tenantName": adminResponse.string(),
}), "application/json");

const adminRequestSchema_3ddabc2bb960515297cc38cc15fcafe1ecb8c3ce91cf05f8c4f3886abe30fdda = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.union([
    adminResponse.literal("billing"),
    adminResponse.literal("general"),
    adminResponse.literal("technical"),
    adminResponse.literal("feature_request"),
    adminResponse.literal("bug_report"),
    adminResponse.literal("account"),
  ] as const)),
  "description": adminResponse.string(),
  "priority": adminResponse.optional(adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const)),
  "subject": adminResponse.string(),
  "tags": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "tenantId": adminResponse.string(),
  "tenantName": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_5912849a4c4f1b2119259aea509b5162ea8c371db1225037213a2005a5554295 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "assignedTo": adminResponse.string(),
  "assignedToName": adminResponse.string(),
}), "application/json");

const adminRequestSchema_9039c49645dda7636ebd7f0e3711930e193457e1713f060f264e5e81cec1988c = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "changedByName": adminResponse.optional(adminResponse.string()),
  "priority": adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const),
}), "application/json");

const adminRequestSchema_fcdd9f2846c58a3956fa3433e8704d7f6dae4573b348f0b492b93ab8aeb78377 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "feedback": adminResponse.optional(adminResponse.string()),
  "rating": adminResponse.number(),
}), "application/json");

const adminRequestSchema_346153b49daf0fa03d3d988c0de2c5ecbf47724c20700bfd585540a169062a1d = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "changedByName": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.union([
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("waiting_customer"),
    adminResponse.literal("resolved"),
  ] as const),
}), "application/json");

const adminRequestSchema_77d9a81ccada4bcc677d7ae25ab4b1825d73ac8e33fd1f01f18bdced6bea88b8 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "attachments": adminResponse.optional(adminResponse.array(adminResponse.object({
    "fileName": adminResponse.string(),
    "fileSize": adminResponse.number(),
    "id": adminResponse.string(),
    "mimeType": adminResponse.string(),
    "uploadedAt": adminResponse.string(),
    "url": adminResponse.string(),
  }))),
  "authorName": adminResponse.optional(adminResponse.string()),
  "content": adminResponse.string(),
  "isInternal": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
}), "application/json");

const adminRequestSchema_99676024cd8b51ba005bc662fdb612535f93d6ae2e8d473ca39414a59b29c22c = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "actions": adminResponse.array(adminResponse.object({
    "config": adminResponse.record(adminResponse.json("operator-configuration")),
    "type": adminResponse.union([
      adminResponse.literal("email"),
      adminResponse.literal("sms"),
      adminResponse.literal("webhook"),
      adminResponse.literal("slack"),
      adminResponse.literal("pagerduty"),
    ] as const),
  })),
  "conditions": adminResponse.object({
    "errorType": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "messagePattern": adminResponse.optional(adminResponse.string()),
    "occurrenceThreshold": adminResponse.optional(adminResponse.number()),
    "service": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "severity": adminResponse.optional(adminResponse.array(adminResponse.union([
      adminResponse.literal("debug"),
      adminResponse.literal("info"),
      adminResponse.literal("warning"),
      adminResponse.literal("error"),
      adminResponse.literal("critical"),
      adminResponse.literal("fatal"),
    ] as const))),
    "timeWindowMinutes": adminResponse.optional(adminResponse.number()),
    "userCountThreshold": adminResponse.optional(adminResponse.number()),
  }),
  "cooldownMinutes": adminResponse.optional(adminResponse.number()),
  "description": adminResponse.optional(adminResponse.string()),
  "name": adminResponse.string(),
}), "application/json");

const adminRequestSchema_8576a8b1148b2a2dfd9fbba2da7a544d654477cbe2b9f827514d36dbae061946 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "assigneeId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_552969562e6b1ea3f11fdeacbcc4ae6014f41e6e16ec48d73683c583a018683a = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "notes": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_99404c5893c448e18567f1e833ff16e734249b4d79862a3e95ee2bf2f3ac672b = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "sourceIds": adminResponse.array(adminResponse.string()),
  "targetId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_86b5855024e2dcb097744e7c977c96e55b4de1e6feb7eb4d2367b64291aa768c = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "context": adminResponse.optional(adminResponse.object({
    "breadcrumbs": adminResponse.optional(adminResponse.array(adminResponse.object({
      "category": adminResponse.string(),
      "data": adminResponse.optional(adminResponse.record(adminResponse.json("debug-observation"))),
      "message": adminResponse.string(),
      "timestamp": adminResponse.dateString(),
      "type": adminResponse.string(),
    }))),
    "extra": adminResponse.optional(adminResponse.record(adminResponse.json("debug-observation"))),
    "request": adminResponse.optional(adminResponse.object({
      "body": adminResponse.optional(adminResponse.json("debug-observation")),
      "headers": adminResponse.optional(adminResponse.record(adminResponse.string())),
      "method": adminResponse.string(),
      "queryParams": adminResponse.optional(adminResponse.record(adminResponse.string())),
      "url": adminResponse.string(),
    })),
    "response": adminResponse.optional(adminResponse.object({
      "body": adminResponse.optional(adminResponse.json("debug-observation")),
      "statusCode": adminResponse.number(),
    })),
    "tags": adminResponse.optional(adminResponse.record(adminResponse.string())),
    "user": adminResponse.optional(adminResponse.object({
      "email": adminResponse.optional(adminResponse.string()),
      "id": adminResponse.string(),
      "tenantId": adminResponse.optional(adminResponse.string()),
    })),
  })),
  "environment": adminResponse.optional(adminResponse.string()),
  "errorType": adminResponse.optional(adminResponse.string()),
  "ipAddress": adminResponse.optional(adminResponse.string()),
  "message": adminResponse.string(),
  "metadata": adminResponse.optional(adminResponse.record(adminResponse.json("debug-observation"))),
  "release": adminResponse.optional(adminResponse.string()),
  "service": adminResponse.optional(adminResponse.string()),
  "severity": adminResponse.optional(adminResponse.union([
    adminResponse.literal("debug"),
    adminResponse.literal("info"),
    adminResponse.literal("warning"),
    adminResponse.literal("error"),
    adminResponse.literal("critical"),
    adminResponse.literal("fatal"),
  ] as const)),
  "stackTrace": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "userAgent": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_cb64f366f118b8a9f812547d8b598780693b1ac7df38a479142fc8600605822b = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "cronExpression": adminResponse.optional(adminResponse.string()),
  "dependencies": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "jobType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("immediate"),
    adminResponse.literal("recurring"),
    adminResponse.literal("delayed"),
    adminResponse.literal("triggered"),
  ] as const)),
  "maxAttempts": adminResponse.optional(adminResponse.number()),
  "metadata": adminResponse.optional(adminResponse.record(adminResponse.json("job-payload"))),
  "name": adminResponse.string(),
  "payload": adminResponse.optional(adminResponse.record(adminResponse.json("job-payload"))),
  "priority": adminResponse.optional(adminResponse.number()),
  "queueName": adminResponse.string(),
  "retryPolicy": adminResponse.optional(adminResponse.object({
    "backoffMultiplier": adminResponse.optional(adminResponse.number()),
    "exponentialBackoff": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "maxDelay": adminResponse.optional(adminResponse.number()),
    "maxRetries": adminResponse.number(),
    "retryDelay": adminResponse.number(),
  })),
  "scheduledAt": adminResponse.optional(adminResponse.string()),
  "tags": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "timeoutMs": adminResponse.optional(adminResponse.number()),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_f3cbaa5e595cfd749488f6581130f7be437cb36aad0f57c71fa1289e2ede9fb6 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "olderThanDays": adminResponse.optional(adminResponse.number()),
}), "application/json");

const adminRequestSchema_28561d85c539d6e6d46b48dac49bd03d599792efedcfded75f6f256c3555c31d = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "concurrency": adminResponse.optional(adminResponse.number()),
  "defaultMaxRetries": adminResponse.optional(adminResponse.number()),
  "defaultTimeoutMs": adminResponse.optional(adminResponse.number()),
  "description": adminResponse.optional(adminResponse.string()),
  "maxJobsPerSecond": adminResponse.optional(adminResponse.number()),
  "name": adminResponse.string(),
  "retryPolicy": adminResponse.optional(adminResponse.object({
    "backoffMultiplier": adminResponse.optional(adminResponse.number()),
    "exponentialBackoff": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "maxDelay": adminResponse.optional(adminResponse.number()),
    "maxRetries": adminResponse.number(),
    "retryDelay": adminResponse.number(),
  })),
}), "application/json");

const adminRequestSchema_0c8845f93d4d46cc756f477d8ee3eacc5c985e804eaf9423460be821ee5ad4e6 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "cronExpression": adminResponse.string(),
  "dependencies": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "jobType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("immediate"),
    adminResponse.literal("recurring"),
    adminResponse.literal("delayed"),
    adminResponse.literal("triggered"),
  ] as const)),
  "maxAttempts": adminResponse.optional(adminResponse.number()),
  "metadata": adminResponse.optional(adminResponse.record(adminResponse.json("job-payload"))),
  "name": adminResponse.string(),
  "payload": adminResponse.optional(adminResponse.record(adminResponse.json("job-payload"))),
  "priority": adminResponse.optional(adminResponse.number()),
  "queueName": adminResponse.string(),
  "retryPolicy": adminResponse.optional(adminResponse.object({
    "backoffMultiplier": adminResponse.optional(adminResponse.number()),
    "exponentialBackoff": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "maxDelay": adminResponse.optional(adminResponse.number()),
    "maxRetries": adminResponse.number(),
    "retryDelay": adminResponse.number(),
  })),
  "tags": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "timeoutMs": adminResponse.optional(adminResponse.number()),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_703b52e6ec1fa18881be1d0f194cdb9556d0c337b2bb0b125295b34ada6d4a1f = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "queueName": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_841a28e2ef78cdec539d2223ee34eb1e6d0acd8f5b5cf75e32538cdb2332ae6c = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "dependencies": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "jobType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("immediate"),
    adminResponse.literal("recurring"),
    adminResponse.literal("delayed"),
    adminResponse.literal("triggered"),
  ] as const)),
  "maxAttempts": adminResponse.optional(adminResponse.number()),
  "metadata": adminResponse.optional(adminResponse.record(adminResponse.json("job-payload"))),
  "name": adminResponse.string(),
  "payload": adminResponse.optional(adminResponse.record(adminResponse.json("job-payload"))),
  "priority": adminResponse.optional(adminResponse.number()),
  "queueName": adminResponse.string(),
  "retryPolicy": adminResponse.optional(adminResponse.object({
    "backoffMultiplier": adminResponse.optional(adminResponse.number()),
    "exponentialBackoff": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "maxDelay": adminResponse.optional(adminResponse.number()),
    "maxRetries": adminResponse.number(),
    "retryDelay": adminResponse.number(),
  })),
  "scheduledAt": adminResponse.string(),
  "tags": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "timeoutMs": adminResponse.optional(adminResponse.number()),
  "userId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_d3d93d39b1cc94dc42767ffc7cf50e1101793b1225ea7e964dc814e7fed7ad76 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "dimensions": adminResponse.optional(adminResponse.record(adminResponse.optional(adminResponse.string()))),
  "metricType": adminResponse.union([
    adminResponse.literal("response_time"),
    adminResponse.literal("throughput"),
    adminResponse.literal("error_rate"),
    adminResponse.literal("apdex"),
    adminResponse.literal("active_users"),
    adminResponse.literal("request_count"),
    adminResponse.literal("db_connection_pool"),
    adminResponse.literal("db_query_time"),
    adminResponse.literal("db_cache_hit_ratio"),
    adminResponse.literal("db_deadlocks"),
    adminResponse.literal("db_active_connections"),
    adminResponse.literal("db_slow_queries"),
    adminResponse.literal("cpu_usage"),
    adminResponse.literal("memory_usage"),
    adminResponse.literal("disk_usage"),
    adminResponse.literal("network_latency"),
    adminResponse.literal("container_health"),
    adminResponse.literal("pod_restarts"),
    adminResponse.literal("custom"),
  ] as const),
  "name": adminResponse.string(),
  "percentiles": adminResponse.optional(adminResponse.object({
    "p50": adminResponse.optional(adminResponse.number()),
    "p90": adminResponse.optional(adminResponse.number()),
    "p95": adminResponse.optional(adminResponse.number()),
    "p99": adminResponse.optional(adminResponse.number()),
  })),
  "sampleCount": adminResponse.optional(adminResponse.number()),
  "service": adminResponse.optional(adminResponse.string()),
  "unit": adminResponse.optional(adminResponse.string()),
  "value": adminResponse.number(),
}), "application/json");

const adminRequestSchema_8e8e6211d18f18a472e289ac0e67a9b2a9b310b868068c65478eadfdfc101d36 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "durationMs": adminResponse.number(),
  "endpoint": adminResponse.string(),
  "isError": adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  "method": adminResponse.string(),
  "service": adminResponse.string(),
}), "application/json");

const adminRequestSchema_42c6066dd165fab3a667e84557957f6ce4eb09895868682d2ff64125e238839e = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "thresholds": adminResponse.array(adminResponse.object({
    "comparison": adminResponse.union([
      adminResponse.literal("gt"),
      adminResponse.literal("gte"),
      adminResponse.literal("lt"),
      adminResponse.literal("lte"),
    ] as const),
    "criticalThreshold": adminResponse.number(),
    "metric": adminResponse.union([
      adminResponse.literal("response_time"),
      adminResponse.literal("throughput"),
      adminResponse.literal("error_rate"),
      adminResponse.literal("apdex"),
      adminResponse.literal("active_users"),
      adminResponse.literal("request_count"),
      adminResponse.literal("db_connection_pool"),
      adminResponse.literal("db_query_time"),
      adminResponse.literal("db_cache_hit_ratio"),
      adminResponse.literal("db_deadlocks"),
      adminResponse.literal("db_active_connections"),
      adminResponse.literal("db_slow_queries"),
      adminResponse.literal("cpu_usage"),
      adminResponse.literal("memory_usage"),
      adminResponse.literal("disk_usage"),
      adminResponse.literal("network_latency"),
      adminResponse.literal("container_health"),
      adminResponse.literal("pod_restarts"),
      adminResponse.literal("custom"),
    ] as const),
    "warningThreshold": adminResponse.number(),
  })),
}), "application/json");

const adminRequestSchema_bda46cd583cb9c4c8f21addf979135c8202cdcb2db16f19bcbcc546f60a34096 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.union([
    adminResponse.literal("api"),
    adminResponse.literal("database"),
    adminResponse.literal("cache"),
    adminResponse.literal("security"),
    adminResponse.literal("email"),
    adminResponse.literal("storage"),
    adminResponse.literal("integration"),
    adminResponse.literal("notification"),
    adminResponse.literal("performance"),
    adminResponse.literal("feature"),
    adminResponse.literal("system"),
    adminResponse.literal("provisioning"),
  ] as const)),
  "defaultValue": adminResponse.optional(adminResponse.json("operator-configuration")),
  "description": adminResponse.optional(adminResponse.string()),
  "helpText": adminResponse.optional(adminResponse.string()),
  "isReadOnly": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "isSecret": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "key": adminResponse.string(),
  "name": adminResponse.string(),
  "requiresRestart": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "validation": adminResponse.optional(adminResponse.object({
    "allowedValues": adminResponse.optional(adminResponse.array(adminResponse.json("operator-configuration"))),
    "max": adminResponse.optional(adminResponse.number()),
    "maxLength": adminResponse.optional(adminResponse.number()),
    "min": adminResponse.optional(adminResponse.number()),
    "minLength": adminResponse.optional(adminResponse.number()),
    "pattern": adminResponse.optional(adminResponse.string()),
    "required": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
  })),
  "value": adminResponse.json("operator-configuration"),
  "valueType": adminResponse.optional(adminResponse.union([
    adminResponse.literal("string"),
    adminResponse.literal("number"),
    adminResponse.literal("boolean"),
    adminResponse.literal("json"),
    adminResponse.literal("array"),
    adminResponse.literal("secret"),
    adminResponse.literal("url"),
    adminResponse.literal("email"),
    adminResponse.literal("duration"),
  ] as const)),
}), "application/json");

const adminRequestSchema_89f64abf6627f9911cc957d073ceacd33df1162aa162496b0b83391ff06b84ee = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "updates": adminResponse.array(adminResponse.object({
    "key": adminResponse.string(),
    "value": adminResponse.json("operator-configuration"),
  })),
}), "application/json");

const adminRequestSchema_9802da8cd3fc28a6c6aa37fc901421c343547d906ae5aa10b036c4ba35bab977 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.string()),
  "conditions": adminResponse.optional(adminResponse.array(adminResponse.object({
    "operator": adminResponse.union([
      adminResponse.literal("in"),
      adminResponse.literal("equals"),
      adminResponse.literal("not_equals"),
      adminResponse.literal("contains"),
      adminResponse.literal("not_in"),
      adminResponse.literal("regex"),
    ] as const),
    "type": adminResponse.union([
      adminResponse.literal("custom"),
      adminResponse.literal("region"),
      adminResponse.literal("tenant_id"),
      adminResponse.literal("user_role"),
      adminResponse.literal("plan_type"),
    ] as const),
    "value": adminResponse.union([
      adminResponse.string(),
      adminResponse.array(adminResponse.string()),
    ] as const),
  }))),
  "defaultValue": adminResponse.optional(adminResponse.json("operator-configuration")),
  "description": adminResponse.optional(adminResponse.string()),
  "isExperimental": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "key": adminResponse.string(),
  "name": adminResponse.string(),
  "requiresRestart": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "rolloutPercentage": adminResponse.optional(adminResponse.number()),
  "scope": adminResponse.optional(adminResponse.union([
    adminResponse.literal("global"),
    adminResponse.literal("tenant"),
    adminResponse.literal("user"),
    adminResponse.literal("environment"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("enabled"),
    adminResponse.literal("disabled"),
    adminResponse.literal("percentage_rollout"),
    adminResponse.literal("scheduled"),
  ] as const)),
  "variants": adminResponse.optional(adminResponse.array(adminResponse.object({
    "description": adminResponse.optional(adminResponse.string()),
    "key": adminResponse.string(),
    "value": adminResponse.json("operator-configuration"),
    "weight": adminResponse.number(),
  }))),
}), "application/json");

const adminRequestSchema_64339ec871761c2c6fa65362cc7893eee5046420163aa556fc7c227bdc4954b0 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({
  "key": adminResponse.string(),
}), {"key":"scalar"}, adminResponse.object({

}), adminResponse.object({
  "custom": adminResponse.optional(adminResponse.record(adminResponse.string())),
  "planType": adminResponse.optional(adminResponse.string()),
  "region": adminResponse.optional(adminResponse.string()),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "userId": adminResponse.optional(adminResponse.string()),
  "userRole": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_3ee4cfef5e469f16a2970c7ae2510af8a73c26f18f5f4a1bd862e75c9244cea6 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "affectedServices": adminResponse.optional(adminResponse.array(adminResponse.object({
    "message": adminResponse.optional(adminResponse.string()),
    "name": adminResponse.string(),
    "status": adminResponse.union([
      adminResponse.literal("unavailable"),
      adminResponse.literal("degraded"),
      adminResponse.literal("read_only"),
    ] as const),
  }))),
  "affectedTenants": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "allowReadOnlyAccess": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "bypassForSuperAdmins": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "description": adminResponse.string(),
  "estimatedDurationMinutes": adminResponse.optional(adminResponse.number()),
  "scheduledEnd": adminResponse.optional(adminResponse.dateString()),
  "scheduledStart": adminResponse.dateString(),
  "scope": adminResponse.optional(adminResponse.union([
    adminResponse.literal("global"),
    adminResponse.literal("tenant"),
    adminResponse.literal("service"),
    adminResponse.literal("region"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "title": adminResponse.string(),
  "type": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("emergency"),
    adminResponse.literal("rolling_update"),
    adminResponse.literal("database_migration"),
    adminResponse.literal("security_patch"),
  ] as const)),
  "userMessage": adminResponse.optional(adminResponse.string()),
  "whitelistedIPs": adminResponse.optional(adminResponse.array(adminResponse.string())),
}), "application/json");

const adminRequestSchema_aa5a200f97b787bb93a97446a85f5172df2935ac33b2dc07395992d68d3405da = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "additionalMinutes": adminResponse.number(),
}), "application/json");

const adminRequestSchema_cb67a1a1ea2aa037315fc4d96ca1e11d5c370a4cc95ed9e66382a2b9ea88adee = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "breakingChanges": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "changelog": adminResponse.optional(adminResponse.array(adminResponse.object({
    "affectedModules": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "description": adminResponse.string(),
    "pullRequestId": adminResponse.optional(adminResponse.string()),
    "ticketId": adminResponse.optional(adminResponse.string()),
    "title": adminResponse.string(),
    "type": adminResponse.union([
      adminResponse.literal("security"),
      adminResponse.literal("breaking"),
      adminResponse.literal("feature"),
      adminResponse.literal("deprecated"),
      adminResponse.literal("improvement"),
      adminResponse.literal("bugfix"),
    ] as const),
  }))),
  "deprecations": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "newFeatures": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "releaseNotes": adminResponse.optional(adminResponse.string()),
  "releaseType": adminResponse.union([
    adminResponse.literal("major"),
    adminResponse.literal("minor"),
    adminResponse.literal("patch"),
    adminResponse.literal("hotfix"),
    adminResponse.literal("security"),
    adminResponse.literal("beta"),
    adminResponse.literal("alpha"),
  ] as const),
  "summary": adminResponse.optional(adminResponse.string()),
  "title": adminResponse.string(),
  "upgradeGuide": adminResponse.optional(adminResponse.string()),
  "version": adminResponse.string(),
}), "application/json");

const adminRequestSchema_e6e95b43e8ab44f9896a9ca426b7ff69d029c8db5a612e602ec8778490a8b0fb = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "deployedBy": adminResponse.string(),
}), "application/json");

const adminRequestSchema_96644a3376b06abd19060ed21fb7eab0ca34e014d28e14244c410faf34a6e44e = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.string(),
  "rolledBackBy": adminResponse.string(),
}), "application/json");

const adminRequestSchema_e3a742d6a1d1e531c9b43394243dde0d43839502f14b6b3740160d0f29ae76cf = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({
  "idempotency-key": adminResponse.string(),
}), adminResponse.object({
  "billingContact": adminResponse.optional(adminResponse.object({
    "email": adminResponse.string(),
    "name": adminResponse.string(),
    "phone": adminResponse.optional(adminResponse.string()),
    "role": adminResponse.optional(adminResponse.string()),
  })),
  "billingCycle": adminResponse.optional(adminResponse.union([
    adminResponse.literal("monthly"),
    adminResponse.literal("quarterly"),
    adminResponse.literal("semi_annual"),
    adminResponse.literal("annual"),
  ] as const)),
  "billingEmail": adminResponse.optional(adminResponse.string()),
  "catalogVersionId": adminResponse.optional(adminResponse.string()),
  "contactEmail": adminResponse.optional(adminResponse.string()),
  "contactPhone": adminResponse.optional(adminResponse.string()),
  "country": adminResponse.optional(adminResponse.string()),
  "customPlanId": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "domain": adminResponse.optional(adminResponse.string()),
  "limits": adminResponse.optional(adminResponse.object({
    "apiRateLimit": adminResponse.optional(adminResponse.number()),
    "dataRetentionDays": adminResponse.optional(adminResponse.number()),
    "maxAlertRules": adminResponse.optional(adminResponse.number()),
    "maxFarms": adminResponse.optional(adminResponse.number()),
    "maxPonds": adminResponse.optional(adminResponse.number()),
    "maxSensors": adminResponse.optional(adminResponse.number()),
    "maxUsers": adminResponse.optional(adminResponse.number()),
    "storageGb": adminResponse.optional(adminResponse.number()),
  })),
  "maxStorage": adminResponse.optional(adminResponse.number()),
  "maxUsers": adminResponse.optional(adminResponse.number()),
  "moduleIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "moduleQuantities": adminResponse.optional(adminResponse.array(adminResponse.object({
    "alerts": adminResponse.optional(adminResponse.number()),
    "apiCalls": adminResponse.optional(adminResponse.number()),
    "devices": adminResponse.optional(adminResponse.number()),
    "employees": adminResponse.optional(adminResponse.number()),
    "farms": adminResponse.optional(adminResponse.number()),
    "integrations": adminResponse.optional(adminResponse.number()),
    "moduleId": adminResponse.string(),
    "ponds": adminResponse.optional(adminResponse.number()),
    "reports": adminResponse.optional(adminResponse.number()),
    "sensors": adminResponse.optional(adminResponse.number()),
    "storageGb": adminResponse.optional(adminResponse.number()),
    "users": adminResponse.optional(adminResponse.number()),
  }))),
  "name": adminResponse.string(),
  "plan": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("trial"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
  ] as const)),
  "primaryContact": adminResponse.optional(adminResponse.object({
    "email": adminResponse.string(),
    "name": adminResponse.string(),
    "phone": adminResponse.optional(adminResponse.string()),
    "role": adminResponse.optional(adminResponse.string()),
  })),
  "quoteId": adminResponse.optional(adminResponse.string()),
  "region": adminResponse.optional(adminResponse.string()),
  "settings": adminResponse.optional(adminResponse.object({
    "currency": adminResponse.optional(adminResponse.string()),
    "dateFormat": adminResponse.optional(adminResponse.string()),
    "features": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "locale": adminResponse.optional(adminResponse.string()),
    "measurementSystem": adminResponse.optional(adminResponse.union([
      adminResponse.literal("metric"),
      adminResponse.literal("imperial"),
    ] as const)),
    "notificationPreferences": adminResponse.optional(adminResponse.object({
      "email": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
      "push": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
      "slack": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
      "sms": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
    })),
    "timezone": adminResponse.optional(adminResponse.string()),
  })),
  "slug": adminResponse.optional(adminResponse.string()),
  "tier": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("trial"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
  ] as const)),
  "trialDays": adminResponse.optional(adminResponse.number()),
}), "application/json");

const adminRequestSchema_7818840deffc5cbb5c546918a3e8473c983815428522b0a4d29eeaaffc743f71 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "email": adminResponse.string(),
  "firstName": adminResponse.string(),
  "lastName": adminResponse.string(),
  "password": adminResponse.string(),
  "role": adminResponse.union([
    adminResponse.literal("SUPER_ADMIN"),
    adminResponse.literal("TENANT_ADMIN"),
    adminResponse.literal("MODULE_MANAGER"),
    adminResponse.literal("MODULE_USER"),
  ] as const),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_814fccccbd9e85b0ef5c9237a1cec6c9983824cc026dad60db223d9419b8eab6 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "email": adminResponse.string(),
  "firstName": adminResponse.optional(adminResponse.string()),
  "lastName": adminResponse.optional(adminResponse.string()),
  "message": adminResponse.optional(adminResponse.string()),
  "moduleIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "primaryModuleId": adminResponse.optional(adminResponse.string()),
  "role": adminResponse.union([
    adminResponse.literal("TENANT_ADMIN"),
    adminResponse.literal("MODULE_MANAGER"),
    adminResponse.literal("MODULE_USER"),
  ] as const),
  "tenantId": adminResponse.string(),
}), "application/json");

const adminRequestSchema_ba6bcd6ca163181026aeca5b031fefac9a44d977039c4c0e34f9b0eae02218b4 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "billingContact": adminResponse.optional(adminResponse.object({
    "email": adminResponse.string(),
    "name": adminResponse.string(),
    "phone": adminResponse.optional(adminResponse.string()),
    "role": adminResponse.optional(adminResponse.string()),
  })),
  "billingEmail": adminResponse.optional(adminResponse.string()),
  "country": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "domain": adminResponse.optional(adminResponse.string()),
  "limits": adminResponse.optional(adminResponse.object({
    "apiRateLimit": adminResponse.optional(adminResponse.number()),
    "dataRetentionDays": adminResponse.optional(adminResponse.number()),
    "maxAlertRules": adminResponse.optional(adminResponse.number()),
    "maxFarms": adminResponse.optional(adminResponse.number()),
    "maxPonds": adminResponse.optional(adminResponse.number()),
    "maxSensors": adminResponse.optional(adminResponse.number()),
    "maxUsers": adminResponse.optional(adminResponse.number()),
    "storageGb": adminResponse.optional(adminResponse.number()),
  })),
  "maxUsers": adminResponse.optional(adminResponse.number()),
  "name": adminResponse.optional(adminResponse.string()),
  "plan": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("trial"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
  ] as const)),
  "primaryContact": adminResponse.optional(adminResponse.object({
    "email": adminResponse.string(),
    "name": adminResponse.string(),
    "phone": adminResponse.optional(adminResponse.string()),
    "role": adminResponse.optional(adminResponse.string()),
  })),
  "region": adminResponse.optional(adminResponse.string()),
  "settings": adminResponse.optional(adminResponse.object({
    "currency": adminResponse.optional(adminResponse.string()),
    "dateFormat": adminResponse.optional(adminResponse.string()),
    "features": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "locale": adminResponse.optional(adminResponse.string()),
    "measurementSystem": adminResponse.optional(adminResponse.union([
      adminResponse.literal("metric"),
      adminResponse.literal("imperial"),
    ] as const)),
    "notificationPreferences": adminResponse.optional(adminResponse.object({
      "email": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
      "push": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
      "slack": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
      "sms": adminResponse.optional(adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const)),
    })),
    "timezone": adminResponse.optional(adminResponse.string()),
  })),
  "tier": adminResponse.optional(adminResponse.union([
    adminResponse.literal("free"),
    adminResponse.literal("trial"),
    adminResponse.literal("starter"),
    adminResponse.literal("professional"),
    adminResponse.literal("enterprise"),
  ] as const)),
}), "application/json");

const adminRequestSchema_f3e8f5720e5b636d0007484f8c61da908b704199bec0d709e257ae45b021ee3f = createAdminRequestContract(adminResponse.object({
  "planId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "description": adminResponse.optional(adminResponse.string()),
  "discountAmount": adminResponse.optional(adminResponse.number()),
  "discountPercent": adminResponse.optional(adminResponse.number()),
  "discountReason": adminResponse.optional(adminResponse.string()),
  "modules": adminResponse.optional(adminResponse.array(adminResponse.object({
    "moduleCode": adminResponse.string(),
    "moduleId": adminResponse.string(),
    "moduleName": adminResponse.string(),
    "quantities": adminResponse.object({
      "alerts": adminResponse.optional(adminResponse.number()),
      "apiCalls": adminResponse.optional(adminResponse.number()),
      "devices": adminResponse.optional(adminResponse.number()),
      "employees": adminResponse.optional(adminResponse.number()),
      "farms": adminResponse.optional(adminResponse.number()),
      "integrations": adminResponse.optional(adminResponse.number()),
      "ponds": adminResponse.optional(adminResponse.number()),
      "reports": adminResponse.optional(adminResponse.number()),
      "sensors": adminResponse.optional(adminResponse.number()),
      "storageGb": adminResponse.optional(adminResponse.number()),
      "users": adminResponse.optional(adminResponse.number()),
      "workflows": adminResponse.optional(adminResponse.number()),
    }),
  }))),
  "name": adminResponse.optional(adminResponse.string()),
  "notes": adminResponse.optional(adminResponse.string()),
  "updatedBy": adminResponse.optional(adminResponse.string()),
  "validFrom": adminResponse.optional(adminResponse.dateString()),
  "validTo": adminResponse.optional(adminResponse.dateString()),
}), "application/json");

const adminRequestSchema_9027bde44e89b674101c723b6c154f1cbd6058d99182610c7e8a894530e7f595 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "description": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "maxRedemptions": adminResponse.optional(adminResponse.number()),
  "maxRedemptionsPerTenant": adminResponse.optional(adminResponse.number()),
  "metadata": adminResponse.optional(adminResponse.record(adminResponse.json("extension-metadata"))),
  "name": adminResponse.optional(adminResponse.string()),
  "validFrom": adminResponse.optional(adminResponse.dateString()),
  "validUntil": adminResponse.optional(adminResponse.dateString()),
}), "application/json");

const adminRequestSchema_6c7541a1e92462e3057c9d0891fbabdad47c28482a999080ddcc818b99be372d = createAdminRequestContract(adminResponse.object({
  "pricingId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "currency": adminResponse.optional(adminResponse.string()),
  "effectiveFrom": adminResponse.optional(adminResponse.dateString()),
  "effectiveTo": adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  "moduleCode": adminResponse.optional(adminResponse.string()),
  "moduleId": adminResponse.optional(adminResponse.string()),
  "notes": adminResponse.optional(adminResponse.string()),
  "pricingMetrics": adminResponse.optional(adminResponse.array(adminResponse.object({
    "currency": adminResponse.string(),
    "description": adminResponse.optional(adminResponse.string()),
    "includedQuantity": adminResponse.optional(adminResponse.number()),
    "maxQuantity": adminResponse.optional(adminResponse.number()),
    "minQuantity": adminResponse.optional(adminResponse.number()),
    "price": adminResponse.number(),
    "type": adminResponse.union([
      adminResponse.literal("base_price"),
      adminResponse.literal("per_user"),
      adminResponse.literal("per_farm"),
      adminResponse.literal("per_pond"),
      adminResponse.literal("per_sensor"),
      adminResponse.literal("per_device"),
      adminResponse.literal("per_gb_storage"),
      adminResponse.literal("per_gb_transfer"),
      adminResponse.literal("per_api_call"),
      adminResponse.literal("per_alert"),
      adminResponse.literal("per_report"),
      adminResponse.literal("per_sms"),
      adminResponse.literal("per_email"),
      adminResponse.literal("per_integration"),
      adminResponse.literal("per_workflow"),
    ] as const),
  }))),
  "tierMultipliers": adminResponse.optional(adminResponse.object({
    "custom": adminResponse.optional(adminResponse.number()),
    "enterprise": adminResponse.optional(adminResponse.number()),
    "free": adminResponse.optional(adminResponse.number()),
    "professional": adminResponse.optional(adminResponse.number()),
    "starter": adminResponse.optional(adminResponse.number()),
  })),
}), "application/json");

const adminRequestSchema_abda90902e6b3b80aa43f09ba92ec4dcde0edef83283cccf6608e71814d9cc01 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "badge": adminResponse.optional(adminResponse.string()),
  "color": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "downgradeWarning": adminResponse.optional(adminResponse.string()),
  "features": adminResponse.optional(adminResponse.object({
    "addOns": adminResponse.optional(adminResponse.array(adminResponse.object({
      "billingCycle": adminResponse.union([
        adminResponse.literal("monthly"),
        adminResponse.literal("quarterly"),
        adminResponse.literal("semi_annual"),
        adminResponse.literal("annual"),
      ] as const),
      "code": adminResponse.string(),
      "description": adminResponse.string(),
      "name": adminResponse.string(),
      "price": adminResponse.number(),
    }))),
    "advancedFeatures": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "coreFeatures": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "premiumFeatures": adminResponse.optional(adminResponse.array(adminResponse.string())),
  })),
  "gracePeriodDays": adminResponse.optional(adminResponse.number()),
  "icon": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "isRecommended": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "limits": adminResponse.optional(adminResponse.object({
    "alertsEnabled": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "apiAccessEnabled": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "apiRateLimit": adminResponse.optional(adminResponse.number()),
    "auditLogEnabled": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "customBrandingEnabled": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "customIntegrationsEnabled": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "dataRetentionDays": adminResponse.optional(adminResponse.number()),
    "dedicatedAccountManager": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "maxFarms": adminResponse.optional(adminResponse.number()),
    "maxModules": adminResponse.optional(adminResponse.number()),
    "maxPonds": adminResponse.optional(adminResponse.number()),
    "maxSensors": adminResponse.optional(adminResponse.number()),
    "maxUsers": adminResponse.optional(adminResponse.number()),
    "prioritySupport": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "reportsEnabled": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "ssoEnabled": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "storageGB": adminResponse.optional(adminResponse.number()),
  })),
  "name": adminResponse.optional(adminResponse.string()),
  "pricing": adminResponse.optional(adminResponse.object({
    "annual": adminResponse.optional(adminResponse.object({
      "basePrice": adminResponse.number(),
      "discountPercent": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    })),
    "currency": adminResponse.optional(adminResponse.string()),
    "monthly": adminResponse.optional(adminResponse.object({
      "basePrice": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    })),
    "quarterly": adminResponse.optional(adminResponse.object({
      "basePrice": adminResponse.number(),
      "discountPercent": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    })),
    "semiAnnual": adminResponse.optional(adminResponse.object({
      "basePrice": adminResponse.number(),
      "discountPercent": adminResponse.number(),
      "perFarmPrice": adminResponse.number(),
      "perModulePrice": adminResponse.number(),
      "perUserPrice": adminResponse.number(),
    })),
  })),
  "shortDescription": adminResponse.optional(adminResponse.string()),
  "sortOrder": adminResponse.optional(adminResponse.number()),
  "trialDays": adminResponse.optional(adminResponse.number()),
  "upgradeMessage": adminResponse.optional(adminResponse.string()),
  "visibility": adminResponse.optional(adminResponse.union([
    adminResponse.literal("public"),
    adminResponse.literal("private"),
    adminResponse.literal("deprecated"),
  ] as const)),
}), "application/json");

const adminRequestSchema_efe103a03f7e0f3f4a2f50568a5acbcf0a15463ecd4ef7acb2fe989f5a5c7caf = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
  "schema": adminResponse.string(),
  "table": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "data": adminResponse.record(adminResponse.json("database-record")),
}), "application/json");

const adminRequestSchema_2c6acb3956b05a982af52d243a3c339013414813dbb943f2816d73ac310c56fe = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "channelId": adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  "retentionDays": adminResponse.number(),
}), "application/json");

const adminRequestSchema_21ff0343940dba0e0a16a1147a95b3302c557ef2ba9c2aa99704badf4325804c = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "defaultRoute": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "icon": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "name": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_c1ed67582bddadc0999a881c222dc9afaa1eb457896460d5bd10b86e120fad4c = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "defaultFilters": adminResponse.optional(adminResponse.record(adminResponse.json("report-dataset"))),
  "defaultFormat": adminResponse.optional(adminResponse.union([
    adminResponse.literal("json"),
    adminResponse.literal("csv"),
    adminResponse.literal("pdf"),
  ] as const)),
  "description": adminResponse.optional(adminResponse.string()),
  "name": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("draft"),
    adminResponse.literal("active"),
    adminResponse.literal("inactive"),
  ] as const)),
}), "application/json");

const adminRequestSchema_489f6512c7d648d17cf7fc9d12bb0d921458523c03ee237419edfee611fa3f92 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "assignedTo": adminResponse.optional(adminResponse.string()),
  "assignedToName": adminResponse.optional(adminResponse.string()),
  "completionNotes": adminResponse.optional(adminResponse.string()),
  "rejectionReason": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("rejected"),
    adminResponse.literal("pending"),
    adminResponse.literal("completed"),
    adminResponse.literal("expired"),
    adminResponse.literal("in_progress"),
  ] as const)),
}), "application/json");

const adminRequestSchema_cdaccde84df87a8d2a420ee08174ccc5ee4de3fb1239ccf9ae066ed4f81f68c6 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "assignedTo": adminResponse.optional(adminResponse.string()),
  "assignedToName": adminResponse.optional(adminResponse.string()),
  "investigationNotes": adminResponse.optional(adminResponse.string()),
  "resolution": adminResponse.optional(adminResponse.string()),
  "resolvedBy": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.union([
    adminResponse.literal("confirmed"),
    adminResponse.literal("detected"),
    adminResponse.literal("investigating"),
    adminResponse.literal("mitigated"),
    adminResponse.literal("false_positive"),
    adminResponse.literal("escalated"),
  ] as const),
}), "application/json");

const adminRequestSchema_65501a4697384c561891d1963208409d841f8921887b0241d59d70df798a4014 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "containmentActions": adminResponse.optional(adminResponse.string()),
  "eradicationSteps": adminResponse.optional(adminResponse.string()),
  "impactDescription": adminResponse.optional(adminResponse.string()),
  "leadInvestigator": adminResponse.optional(adminResponse.string()),
  "leadInvestigatorName": adminResponse.optional(adminResponse.string()),
  "lessonsLearned": adminResponse.optional(adminResponse.string()),
  "recoveryPlan": adminResponse.optional(adminResponse.string()),
  "rootCauseAnalysis": adminResponse.optional(adminResponse.string()),
  "severity": adminResponse.optional(adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
    adminResponse.literal("investigating"),
    adminResponse.literal("contained"),
    adminResponse.literal("eradicated"),
    adminResponse.literal("recovered"),
  ] as const)),
}), "application/json");

const adminRequestSchema_39c526920c5c302f81b67264d3e4cf81fb735ebf8c3eeeefdbc1825da936d928 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "updates": adminResponse.array(adminResponse.object({
    "key": adminResponse.string(),
    "value": adminResponse.string(),
  })),
}), "application/json");

const adminRequestSchema_373e4870ace05af7451c5c2be77b4810fd57fef6f36477cf0487eefab4380846 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "defaultCurrency": adminResponse.optional(adminResponse.string()),
  "invoiceDueDays": adminResponse.optional(adminResponse.number()),
  "stripeEnabled": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "taxRate": adminResponse.optional(adminResponse.number()),
}), "application/json");

const adminRequestSchema_0866463cf4f9720852f39d751fe87ebd2b16aebd62461f154269a91c8fd9fbc3 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "fromAddress": adminResponse.optional(adminResponse.string()),
  "fromName": adminResponse.optional(adminResponse.string()),
  "smtpHost": adminResponse.optional(adminResponse.string()),
  "smtpPassword": adminResponse.optional(adminResponse.string()),
  "smtpPort": adminResponse.optional(adminResponse.number()),
  "smtpSecure": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "smtpUsername": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_93b3ed5fdb9f6a6d0b3d5b23dbac8bc4cf35009b541c07f69177f52c7d3b57a7 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "allowedIps": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "enabled": adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  "message": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_c146db2001e748da53dd0dbdbc1c1ca5b0de65558ee06c6de6451f302649a000 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "apiKeyRpm": adminResponse.optional(adminResponse.number()),
  "globalRpm": adminResponse.optional(adminResponse.number()),
  "perTenantRpm": adminResponse.optional(adminResponse.number()),
  "perUserRpm": adminResponse.optional(adminResponse.number()),
}), "application/json");

const adminRequestSchema_7aa973140c52b191e421d122913b56deffe615721d3a63d6f8d48550c584af74 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "enforceHttps": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "lockoutDurationMinutes": adminResponse.optional(adminResponse.number()),
  "maxLoginAttempts": adminResponse.optional(adminResponse.number()),
  "mfaEnabled": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "passwordMinLength": adminResponse.optional(adminResponse.number()),
  "passwordRequireNumbers": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "passwordRequireSymbols": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "passwordRequireUppercase": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "sessionTimeoutMinutes": adminResponse.optional(adminResponse.number()),
}), "application/json");

const adminRequestSchema_a7c6fba337315b36af0f0e2ea7c7417d82cd0b2d86b5e7229902169edda5910a = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "bodyHtml": adminResponse.optional(adminResponse.string()),
  "bodyText": adminResponse.optional(adminResponse.string()),
  "category": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "name": adminResponse.optional(adminResponse.string()),
  "subject": adminResponse.optional(adminResponse.string()),
  "updatedBy": adminResponse.optional(adminResponse.string()),
  "variables": adminResponse.optional(adminResponse.array(adminResponse.object({
    "defaultValue": adminResponse.optional(adminResponse.string()),
    "description": adminResponse.string(),
    "name": adminResponse.string(),
    "required": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
  }))),
}), "application/json");

const adminRequestSchema_7af0802ab16949fdafa39a971351754276096007b2bd364e2435ce2bff4deec9 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "description": adminResponse.optional(adminResponse.string()),
  "expiresAt": adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  "ipAddress": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
}), "application/json");

const adminRequestSchema_49565aae0bf958f3d66692608a777d40450dcd52cc6a2a1266b1062333406e47 = createAdminRequestContract(adminResponse.object({
  "key": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "description": adminResponse.optional(adminResponse.string()),
  "displayName": adminResponse.optional(adminResponse.string()),
  "isPublic": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "requiresRestart": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "sortOrder": adminResponse.optional(adminResponse.number()),
  "updatedBy": adminResponse.optional(adminResponse.string()),
  "value": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_619c9abe4219425ad74773a045227817868d3938d4b5e9620be49bd984758da1 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "content": adminResponse.optional(adminResponse.string()),
  "expiresAt": adminResponse.optional(adminResponse.string()),
  "isGlobal": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "publishAt": adminResponse.optional(adminResponse.string()),
  "requiresAcknowledgment": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "targetCriteria": adminResponse.optional(adminResponse.object({
    "excludeTenantIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "includeInactive": adminResponse.optional(adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const)),
    "modules": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "plans": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "regions": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "tenantIds": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "tenantStatuses": adminResponse.optional(adminResponse.array(adminResponse.string())),
  })),
  "title": adminResponse.optional(adminResponse.string()),
  "type": adminResponse.optional(adminResponse.union([
    adminResponse.literal("maintenance"),
    adminResponse.literal("warning"),
    adminResponse.literal("critical"),
    adminResponse.literal("info"),
  ] as const)),
}), "application/json");

const adminRequestSchema_d6f35f40d9d457e069306eee4d674788f49d53456cd66a87de20d1e8b42e6b5b = createAdminRequestContract(adminResponse.object({
  "sessionId": adminResponse.string(),
  "tenantId": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "notes": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.union([
    adminResponse.literal("cancelled"),
    adminResponse.literal("completed"),
  ] as const),
}), "application/json");

const adminRequestSchema_1882943d1ecbe7d83e13566118f7ab169507c69caf6c982c0306abb0c48bce9e = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.union([
    adminResponse.literal("billing"),
    adminResponse.literal("general"),
    adminResponse.literal("technical"),
    adminResponse.literal("feature_request"),
    adminResponse.literal("bug_report"),
    adminResponse.literal("account"),
  ] as const)),
  "description": adminResponse.optional(adminResponse.string()),
  "dueAt": adminResponse.optional(adminResponse.string()),
  "priority": adminResponse.optional(adminResponse.union([
    adminResponse.literal("critical"),
    adminResponse.literal("high"),
    adminResponse.literal("low"),
    adminResponse.literal("medium"),
  ] as const)),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("open"),
    adminResponse.literal("closed"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("waiting_customer"),
    adminResponse.literal("resolved"),
  ] as const)),
  "subject": adminResponse.optional(adminResponse.string()),
  "tags": adminResponse.optional(adminResponse.array(adminResponse.string())),
}), "application/json");

const adminRequestSchema_ec3a5528b31f3ac482e005a76f711cb8c2391e4c4ce557ec57ccc99a6d434da2 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "actions": adminResponse.optional(adminResponse.array(adminResponse.object({
    "config": adminResponse.record(adminResponse.json("operator-configuration")),
    "type": adminResponse.union([
      adminResponse.literal("email"),
      adminResponse.literal("sms"),
      adminResponse.literal("webhook"),
      adminResponse.literal("slack"),
      adminResponse.literal("pagerduty"),
    ] as const),
  }))),
  "conditions": adminResponse.optional(adminResponse.object({
    "errorType": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "messagePattern": adminResponse.optional(adminResponse.string()),
    "occurrenceThreshold": adminResponse.optional(adminResponse.number()),
    "service": adminResponse.optional(adminResponse.array(adminResponse.string())),
    "severity": adminResponse.optional(adminResponse.array(adminResponse.union([
      adminResponse.literal("debug"),
      adminResponse.literal("info"),
      adminResponse.literal("warning"),
      adminResponse.literal("error"),
      adminResponse.literal("critical"),
      adminResponse.literal("fatal"),
    ] as const))),
    "timeWindowMinutes": adminResponse.optional(adminResponse.number()),
    "userCountThreshold": adminResponse.optional(adminResponse.number()),
  })),
  "cooldownMinutes": adminResponse.optional(adminResponse.number()),
  "description": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "name": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRequestSchema_fcd5d2d6dbb076235cbdb3fcca74c7ea181c50fbd041eb7215073ffe1c2fa31c = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "assignedTo": adminResponse.optional(adminResponse.string()),
  "linkedTicketUrl": adminResponse.optional(adminResponse.string()),
  "notes": adminResponse.optional(adminResponse.string()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("new"),
    adminResponse.literal("acknowledged"),
    adminResponse.literal("in_progress"),
    adminResponse.literal("resolved"),
    adminResponse.literal("ignored"),
    adminResponse.literal("recurring"),
  ] as const)),
}), "application/json");

const adminRequestSchema_9c08fdcb554fa18dd43d04b97aebbe3388432071b4ef549e5cd11c4bece444f3 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "checkpoint": adminResponse.optional(adminResponse.json("job-payload")),
  "current": adminResponse.number(),
  "message": adminResponse.optional(adminResponse.string()),
  "percentage": adminResponse.number(),
  "total": adminResponse.number(),
}), "application/json");

const adminRequestSchema_fe29e29b8964bdb98923749593fe62718aad2f835251c11be46e077c2bbedbb7 = createAdminRequestContract(adminResponse.object({
  "name": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "concurrency": adminResponse.optional(adminResponse.number()),
  "defaultMaxRetries": adminResponse.optional(adminResponse.number()),
  "defaultTimeoutMs": adminResponse.optional(adminResponse.number()),
  "description": adminResponse.optional(adminResponse.string()),
  "maxJobsPerSecond": adminResponse.optional(adminResponse.number()),
  "retryPolicy": adminResponse.optional(adminResponse.object({
    "backoffMultiplier": adminResponse.optional(adminResponse.number()),
    "exponentialBackoff": adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    "maxDelay": adminResponse.optional(adminResponse.number()),
    "maxRetries": adminResponse.number(),
    "retryDelay": adminResponse.number(),
  })),
}), "application/json");

const adminRequestSchema_e7640be5331f068f4e0aa873385c308fa1d16f4837b06af688bf7575aa621d7e = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "reason": adminResponse.optional(adminResponse.string()),
  "value": adminResponse.json("operator-configuration"),
}), "application/json");

const adminRequestSchema_efe3c81306449594bccc769b3b95fa947e3bfa3357a7ea2b7602ce001c8f7e88 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "category": adminResponse.optional(adminResponse.string()),
  "conditions": adminResponse.optional(adminResponse.array(adminResponse.object({
    "operator": adminResponse.union([
      adminResponse.literal("in"),
      adminResponse.literal("equals"),
      adminResponse.literal("not_equals"),
      adminResponse.literal("contains"),
      adminResponse.literal("not_in"),
      adminResponse.literal("regex"),
    ] as const),
    "type": adminResponse.union([
      adminResponse.literal("custom"),
      adminResponse.literal("region"),
      adminResponse.literal("tenant_id"),
      adminResponse.literal("user_role"),
      adminResponse.literal("plan_type"),
    ] as const),
    "value": adminResponse.union([
      adminResponse.string(),
      adminResponse.array(adminResponse.string()),
    ] as const),
  }))),
  "defaultValue": adminResponse.optional(adminResponse.json("operator-configuration")),
  "deprecatedAt": adminResponse.optional(adminResponse.dateString()),
  "deprecationMessage": adminResponse.optional(adminResponse.string()),
  "description": adminResponse.optional(adminResponse.string()),
  "disabledTenants": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "enabledTenants": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "name": adminResponse.optional(adminResponse.string()),
  "rolloutPercentage": adminResponse.optional(adminResponse.number()),
  "status": adminResponse.optional(adminResponse.union([
    adminResponse.literal("enabled"),
    adminResponse.literal("disabled"),
    adminResponse.literal("percentage_rollout"),
    adminResponse.literal("scheduled"),
  ] as const)),
  "variants": adminResponse.optional(adminResponse.array(adminResponse.object({
    "description": adminResponse.optional(adminResponse.string()),
    "key": adminResponse.string(),
    "value": adminResponse.json("operator-configuration"),
    "weight": adminResponse.number(),
  }))),
}), "application/json");

const adminRequestSchema_16b53b034219e0353e5094b14836c149b53c0cbdd9c7b0e0eb2dec5aee01ac71 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "affectedServices": adminResponse.optional(adminResponse.array(adminResponse.object({
    "message": adminResponse.optional(adminResponse.string()),
    "name": adminResponse.string(),
    "status": adminResponse.union([
      adminResponse.literal("unavailable"),
      adminResponse.literal("degraded"),
      adminResponse.literal("read_only"),
    ] as const),
  }))),
  "affectedTenants": adminResponse.optional(adminResponse.array(adminResponse.string())),
  "allowReadOnlyAccess": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "bypassForSuperAdmins": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "description": adminResponse.optional(adminResponse.string()),
  "estimatedDurationMinutes": adminResponse.optional(adminResponse.number()),
  "scheduledEnd": adminResponse.optional(adminResponse.dateString()),
  "scheduledStart": adminResponse.optional(adminResponse.dateString()),
  "scope": adminResponse.optional(adminResponse.union([
    adminResponse.literal("global"),
    adminResponse.literal("tenant"),
    adminResponse.literal("service"),
    adminResponse.literal("region"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
  "title": adminResponse.optional(adminResponse.string()),
  "type": adminResponse.optional(adminResponse.union([
    adminResponse.literal("scheduled"),
    adminResponse.literal("emergency"),
    adminResponse.literal("rolling_update"),
    adminResponse.literal("database_migration"),
    adminResponse.literal("security_patch"),
  ] as const)),
  "userMessage": adminResponse.optional(adminResponse.string()),
  "whitelistedIPs": adminResponse.optional(adminResponse.array(adminResponse.string())),
}), "application/json");

const adminRequestSchema_d08450b2c55e546ff1b160ae1f4bcc49e4e090c5c9fef62084f15505263bf782 = createAdminRequestContract(adminResponse.object({

}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.record(adminResponse.string()), "application/json");

const adminRequestSchema_84bf54901b7e34dfed4771c6cf3f05bdb88d6f72461c7fc08bad5c7dd1e15034 = createAdminRequestContract(adminResponse.object({
  "id": adminResponse.string(),
}), adminResponse.object({

}), {}, adminResponse.object({

}), adminResponse.object({
  "firstName": adminResponse.optional(adminResponse.string()),
  "isActive": adminResponse.optional(adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const)),
  "lastName": adminResponse.optional(adminResponse.string()),
  "role": adminResponse.optional(adminResponse.union([
    adminResponse.literal("SUPER_ADMIN"),
    adminResponse.literal("TENANT_ADMIN"),
    adminResponse.literal("MODULE_MANAGER"),
    adminResponse.literal("MODULE_USER"),
  ] as const)),
  "tenantId": adminResponse.optional(adminResponse.string()),
}), "application/json");

const adminRouteAuthorization_30bfffb7cd8536dbfbd488375317b936aeebd8d23da041bb79ffde4eed44e7a0 = createAdminRouteAuthorizationV1("public", [], [])
const adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76 = createAdminRouteAuthorizationV1("bearer-session", ["SUPER_ADMIN"], [])

export const ADMIN_SERVER_REQUEST_CONTRACTS: AdminServerRequestContractCatalogV1 = Object.freeze({
  "DELETE /admin/tenants/:id": adminRequestSchema_448e1650cad16f6e389b39a16147292992a6eb101b9776eed036a98f464b4b32,
  "DELETE /admin/tenants/:id/notes/:noteId": adminRequestSchema_3f9552a7e84ea47b3341063004cb0e0e82d113d6a2e6e689c959bef660b34d23,
  "DELETE /billing/custom-plans/:planId": adminRequestSchema_a365927253bd76b330e52db909dc050b987c244e4fa87ff370b718037702de42,
  "DELETE /database/explorer/schemas/:schema/tables/:table/rows/:id": adminRequestSchema_ac69ce6de8d3541ed427b9133bfa9b55430839aaf471bb6899b6669418c08cec,
  "DELETE /database/schemas/:tenantId": adminRequestSchema_b2ff4f9001cba7f3213025b46ad7bcc5dc3c3023485429bf18d6f6b88d5b44eb,
  "DELETE /debug/cache/:key": adminRequestSchema_9ea419c9fad51c6ed67b71af8d12771214d2642ee01736417bc65e59729ee6da,
  "DELETE /messaging/compliance/legal-holds/:id": adminRequestSchema_903de4abe5255899ee08f84ad24e9abd9ce825ce21d5855c67c9487013d9ca9e,
  "DELETE /modules/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "DELETE /modules/assignments/:tenantId/:moduleId": adminRequestSchema_cd1a3dc6c06113fdfe40f6071da4a555eb5c146d577ee2394d20a097fee442d5,
  "DELETE /reports/definitions/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "DELETE /settings/email-templates/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "DELETE /settings/ip-access/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "DELETE /settings/ip-access/type/:ruleType/clear": adminRequestSchema_0bd3e1be0356e597cb0cc9f76d0cb6b8cdf84cd9e4bd32f05a0b29520a18d3c6,
  "DELETE /support/announcements/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "DELETE /system/errors/alert-rules/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "DELETE /system/settings/feature-toggles/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "DELETE /users/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /admin/tenants": adminRequestSchema_4a683a4eb11dab0c5af40feddb049984bb5b14d4964dfc2b855ec02381df6bac,
  "GET /admin/tenants/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /admin/tenants/:id/activities": adminRequestSchema_4b1fd9035edceb53626a0550c6f99a16849082093fcd6c34989eff53fb8ca86b,
  "GET /admin/tenants/:id/detail": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /admin/tenants/:id/notes": adminRequestSchema_b7eee7d118778772b39b6b35b1a842e799a0b38bf29f69776a1b9f3d2de9a744,
  "GET /admin/tenants/:id/usage": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /admin/tenants/approaching-limits": adminRequestSchema_0eda03448a9ca9755fcbad94f894f8687fed8fa0889f2feaac10bfeffcfabfaf,
  "GET /admin/tenants/expiring-trials": adminRequestSchema_a32fd66968ad7a4fd468668afeea9b79d7bcee9df9945e849ffc8266cbc7b830,
  "GET /admin/tenants/lookup/slug/:slug": adminRequestSchema_1dd8ef284c1af89f24c17b4cb33ede854c6135f04a10cadfad09dc9232bb7e48,
  "GET /admin/tenants/search": adminRequestSchema_6df33742690b17e662423d9c2cf248ef9cd0069b8564414f046698899d82d087,
  "GET /admin/tenants/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/dashboard": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/financial": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/financial/by-plan": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/financial/revenue": adminRequestSchema_78ad5410fd286b82c961c591c61e2105617d271a549f41b1edf7d409140309a8,
  "GET /analytics/kpi-comparisons": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/revenue": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/revenue/by-plan": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/revenue/trend": adminRequestSchema_56ed6dbcda7d0695cab5f4555c9b333c0cbd5b23573b4862333008cc7d689eea,
  "GET /analytics/snapshots": adminRequestSchema_05f74d54350de39762d61994d0570e439446b1163e6df97fc8d731349a9d5096,
  "GET /analytics/system": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/system/api-calls": adminRequestSchema_3ffaed319c58bf888346148f47bfe34d0c3f66b73d1caf473096f53e7f11fd53,
  "GET /analytics/system/errors": adminRequestSchema_3ffaed319c58bf888346148f47bfe34d0c3f66b73d1caf473096f53e7f11fd53,
  "GET /analytics/tenants": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/tenants/churn": adminRequestSchema_78ad5410fd286b82c961c591c61e2105617d271a549f41b1edf7d409140309a8,
  "GET /analytics/tenants/growth": adminRequestSchema_56ed6dbcda7d0695cab5f4555c9b333c0cbd5b23573b4862333008cc7d689eea,
  "GET /analytics/usage": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/usage/features": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/usage/modules": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/users": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /analytics/users/activity": adminRequestSchema_56ed6dbcda7d0695cab5f4555c9b333c0cbd5b23573b4862333008cc7d689eea,
  "GET /analytics/users/heatmap": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /audit-logs": adminRequestSchema_20dcc3c0249c0bf00ed21ebc5e1d1bd92c28a224f596a24ea85087233effeb13,
  "GET /audit-logs/entity/:entityType/:entityId": adminRequestSchema_e2057a84a7c1cff8c3765158177120af59eb910c108c4c7e28f590410b08cf79,
  "GET /audit-logs/security": adminRequestSchema_e1fa7d56d5fe3790482a7b7a4626c019754d274d507e49714264e3da0463508d,
  "GET /audit-logs/statistics": adminRequestSchema_b937950170e8bd2c9bef06f597ed648571f4c97fdac4db610158cc922d90d194,
  "GET /audit-logs/user/:userId": adminRequestSchema_5b0c824b59eafad4a2dcd358ac94b60cca394ef9cfcca71472d968bd50ca1592,
  "GET /billing/custom-plans": adminRequestSchema_72f33a4514d2e9fcd44635b816b91566402b83e4bbcd24767894ee685ecf5a4e,
  "GET /billing/custom-plans/:planId": adminRequestSchema_a365927253bd76b330e52db909dc050b987c244e4fa87ff370b718037702de42,
  "GET /billing/custom-plans/tenant/:tenantId": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /billing/discounts": adminRequestSchema_bf558373a07771286d54219449af2279c6c4ad9f5e5bc8ee47f1bfcdc5404e8e,
  "GET /billing/discounts/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /billing/discounts/:id/redemptions": adminRequestSchema_8a61a99bd935a7b3f050777adf9ec23dc033ad8d38326737bbb46fd868c6491f,
  "GET /billing/discounts/lookup/code/:code": adminRequestSchema_36b38f33427eb27eaa1145d72e3cad809b618e60f40c5ce0e66a790fad01bf9d,
  "GET /billing/discounts/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/invoices": adminRequestSchema_79583eca57175c69bc90ab4ca07655593b5370db531b5010710137749d255895,
  "GET /billing/invoices/:invoiceId": adminRequestSchema_5199e6879fdf996d033911867215c6ca38930edd9b420e06cf29e6966b91408c,
  "GET /billing/invoices/overdue": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/invoices/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/invoices/tenant/:tenantId": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /billing/module-pricing": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/module-pricing/:moduleId": adminRequestSchema_42479910c2a000662b442ecdf492d774ed3a124803e792768b8b5f0f0d02498f,
  "GET /billing/module-pricing/:moduleId/history": adminRequestSchema_b7c9c87bf420e4ac136846db6cc45bf0ab6fba54f87109f7d5cd8e8d46295eb3,
  "GET /billing/module-pricing/lookup/code/:moduleCode": adminRequestSchema_57bccdc755254f2bb410d832729994716cfd183cf3ab716135202b183bd858d3,
  "GET /billing/module-pricing/with-modules": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/payments": adminRequestSchema_927abe6cd225235f1aa324b3f66c41d499491cf64b298a3ad2e9ef5060e32743,
  "GET /billing/plans": adminRequestSchema_cf9cde7f79541b752ede11251c154be5e35ed0eff386898317550d8ca0b56840,
  "GET /billing/plans/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /billing/plans/code/:code": adminRequestSchema_36b38f33427eb27eaa1145d72e3cad809b618e60f40c5ce0e66a790fad01bf9d,
  "GET /billing/plans/defaults/:tier": adminRequestSchema_ca3f4ea5e8d51e4045baaf127709c4527def96c4397d4ae8b93f68532e9b2120,
  "GET /billing/plans/public": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/plans/tier/:tier": adminRequestSchema_ca3f4ea5e8d51e4045baaf127709c4527def96c4397d4ae8b93f68532e9b2120,
  "GET /billing/subscriptions": adminRequestSchema_411001fbb69303e0ae66b94b59fb1caa0a19bdbc310ec3b686d486966b5436dc,
  "GET /billing/subscriptions/reminders": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/subscriptions/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /billing/subscriptions/tenant/:tenantId": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /billing/tenant/:tenantId/redemptions": adminRequestSchema_f9c6c1a16281e502114540ab3868c2ac4d6c52963f638f1df9ffb2e4e4d0fab1,
  "GET /billing/usage/summary": adminRequestSchema_dbbd1506318afd8d9327f8ae6c39e36b79394f1e8976ba573b631839eb569af1,
  "GET /billing/usage/tenant/:tenantId": adminRequestSchema_5eb41e2d7d6c4094bab8f1aed733600739b96013bf8f58b61362eb940525c52c,
  "GET /billing/usage/tenants": adminRequestSchema_a3c9f79614a31a2c0eef5beb73a0f1dd8f07a6293297835237e0ff8116274c28,
  "GET /billing/usage/top-tenants": adminRequestSchema_8e13eb8eaecbc631b42a8d67143bdfc07ae42da277c7dca42b48b8622bda34d8,
  "GET /billing/usage/trends": adminRequestSchema_ad41237ac77744091f183b39d283b08083efd89c7f01abdc8c4b212339de8b20,
  "GET /database/explorer/schemas": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/explorer/schemas/:schema/tables": adminRequestSchema_2df7963d87203d178b1ecf1aaeceb1a5120faadeaf238b0afaf3a89098a45174,
  "GET /database/explorer/schemas/:schema/tables/:table/data": adminRequestSchema_013090361a554db251729207f173ceb752a762fd47a859497e3733eee5b75211,
  "GET /database/explorer/schemas/:schema/tables/:table/export": adminRequestSchema_64a4fb31626029891df9628e08f55a66855fe9994d011bea35427f6ec4f8449f,
  "GET /database/explorer/schemas/:schema/tables/:table/structure": adminRequestSchema_2982a30fc3ac821d8ce0bddd420e845ef7a733c8e3e094c002bda617560b87d3,
  "GET /database/explorer/tables": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/explorer/tables/:table/data": adminRequestSchema_1c7fc8e5c46a26dd84286b3cb7690dfb710461a7c410c01e2010786753167ca0,
  "GET /database/migrations/available": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/migrations/batch/:version/status": adminRequestSchema_82b01cdc64e101877b43962ca9d1931a3a78191191e08a2a11f2ce07ae69e239,
  "GET /database/migrations/history": adminRequestSchema_44858763ce4ab72120ae7a1b081c53dc1a10429eb6875cab42ad74eddc954e58,
  "GET /database/migrations/summary": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/migrations/tenant/:tenantId/history": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /database/migrations/tenant/:tenantId/pending": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /database/monitoring/connections": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/monitoring/connections/by-tenant": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/monitoring/health": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/monitoring/index-recommendations": adminRequestSchema_2cb75252cbee08a3b2d2737c14812d0c981ad05f30d393f3b2e0cf59c988c1d7,
  "GET /database/monitoring/metrics": adminRequestSchema_a866095c6be028e7a39e710636d86a25a06ec366c3985b254c59d20902cc7f9d,
  "GET /database/monitoring/query-performance": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/monitoring/slow-queries": adminRequestSchema_f3841c40904c55741f4c6c49a090e92b17213afe9b6ff4cf6bedd826fa0066cb,
  "GET /database/monitoring/storage": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/monitoring/storage/by-tenant": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/schemas": adminRequestSchema_efc6a8329e12e1bd9bd2b64ff888dae995520b3c2e4db16d51113a2f7c065b24,
  "GET /database/schemas/:tenantId": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /database/schemas/:tenantId/info": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /database/schemas/:tenantId/validate": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /database/schemas/connections/by-tenant": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/schemas/connections/pool": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /database/schemas/summary": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /debug/api-calls": adminRequestSchema_be0591788912e8f82a28ece110e4c53e7097d8cf3e4053380e384c4d96230bc9,
  "GET /debug/api-calls/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /debug/api-calls/summary": adminRequestSchema_0a6a42ad6d501ab2a16fad81a1922f0128f229fe26afe61391723bb02dd9f1d1,
  "GET /debug/cache": adminRequestSchema_f66088aa589174bacd2cc590d34fea4a1980352c6383656740cdcade30c153d2,
  "GET /debug/cache/:key": adminRequestSchema_9ea419c9fad51c6ed67b71af8d12771214d2642ee01736417bc65e59729ee6da,
  "GET /debug/cache/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /debug/dashboard": adminRequestSchema_638b8685f6bd41d51724f7f993e6166f8767e18ed2bb26bda4c3b57c8b47d10c,
  "GET /debug/feature-overrides": adminRequestSchema_18164249607b5324f954c15e02454fe6e8ae9f28f540ac0389e005404680aa80,
  "GET /debug/feature-overrides/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /debug/feature-overrides/tenant/:tenantId": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /debug/feature-overrides/tenant/:tenantId/active": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /debug/feature-overrides/value": adminRequestSchema_61ff3fa3a1101a192d324633fa594d73bbaa542ce6096f848ae50c6df7a6924a,
  "GET /debug/queries": adminRequestSchema_faf9abdfa630569eb03613f80e422ddc4f56e16110de2c5660fd0f4ae707016d,
  "GET /debug/queries/:id/explain": adminRequestSchema_f387d4a99b9b02566566b3a79c6f6256b296ee54fdbfbaa3d08ecc7dc08d6bae,
  "GET /debug/queries/slow-analysis": adminRequestSchema_9b99c61db347bb3e5cab78ee19bf81083cd468aa94545653ea87d2f6948ec87a,
  "GET /debug/sessions": adminRequestSchema_6d6cbca2c0c980de91ba6b213cf4ed1bd500a6d3413711d7cc2357b902f5155e,
  "GET /debug/sessions/:id": adminRequestSchema_6737692698704fa4a7bd7fc717c356fd1e2cc537c33ce43a01ed8916ac27cd75,
  "GET /debug/sessions/tenant/:tenantId": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /health": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /health/circuit-breakers": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /health/live": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /health/metrics": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /health/ready": adminRequestSchema_4ee5dab8ad8bb77c003c43964565f5874e69ac165686aa7004cb8d5d5af0fb97,
  "GET /health/startup": adminRequestSchema_4ee5dab8ad8bb77c003c43964565f5874e69ac165686aa7004cb8d5d5af0fb97,
  "GET /impersonation/audit/summary": adminRequestSchema_515322b27287ac807633e9394b15c7d3ee49f8ab40307cada507f609c203714b,
  "GET /impersonation/permissions": adminRequestSchema_80b437d3fc3a585fbddabf2413831aac145e5dd134ce699fbe8270d885f0ced2,
  "GET /impersonation/permissions/:superAdminId": adminRequestSchema_9a29fe46143ea7c68c283142e02090ab32321c0a6c8e2dd3102f539261ed7be7,
  "GET /impersonation/permissions/:superAdminId/check/:tenantId": adminRequestSchema_79fa7f1ffc9e7f12750671e021d73a73ab388410a23cddd315a927812ee75868,
  "GET /impersonation/sessions": adminRequestSchema_22f3ed7cef7713b4f99a89ec08d13117365979f6af3f3653894f0ad0626a156e,
  "GET /impersonation/sessions/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /impersonation/sessions/active": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /impersonation/sessions/active/count": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /impersonation/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /messaging/audit": adminRequestSchema_8f53508ea7ca51d42f736367409cd200d45bf42f9ec6a1182a66daabcfe79637,
  "GET /messaging/compliance/legal-holds": adminRequestSchema_c9c57cc8f8a8e1892df6cafbb49a75d76c9f68afc81442b8f30ad60add394edd,
  "GET /messaging/compliance/stats": adminRequestSchema_c9c57cc8f8a8e1892df6cafbb49a75d76c9f68afc81442b8f30ad60add394edd,
  "GET /messaging/monitoring/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /messaging/personas": adminRequestSchema_c9c57cc8f8a8e1892df6cafbb49a75d76c9f68afc81442b8f30ad60add394edd,
  "GET /messaging/retention/policies": adminRequestSchema_c9c57cc8f8a8e1892df6cafbb49a75d76c9f68afc81442b8f30ad60add394edd,
  "GET /messaging/tenants": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /modules": adminRequestSchema_d78143a3a932ce522c556ac909993333813653917a084667148021f476e91a1e,
  "GET /modules/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /modules/:id/tenants": adminRequestSchema_21d72656a09014561d399f5cbacddfd49112629e83001d4574e036c2c145ab98,
  "GET /modules/assignments": adminRequestSchema_2dcbed4f62ac5e86c4267d50bb390faad12b31bb1297c54c9c8ec418adb7512a,
  "GET /modules/lookup/code/:code": adminRequestSchema_36b38f33427eb27eaa1145d72e3cad809b618e60f40c5ce0e66a790fad01bf9d,
  "GET /modules/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /reports/capabilities": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /reports/definitions": adminRequestSchema_3be87943c63777248c23f523bae7be17fcf52d753aafd1169f3e42d8ade5fb95,
  "GET /reports/definitions/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /reports/executions": adminRequestSchema_894d6533da04f5f5682f535e972d0da5392a71be47ed83bc96aeba5374f7e04a,
  "GET /reports/executions/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /reports/executions/:id/download": adminRequestSchema_23d34fb4349c832b01c5c1e2a54adfa9b6a5698ae7e85a518fdf8deadbcb408e,
  "GET /security/compliance/checks/:framework": adminRequestSchema_5233fc6a347af75dd8063cccae0466277b2a546b6daca5766212d8b382a2cfb6,
  "GET /security/compliance/data-inventory": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /security/compliance/data-requests": adminRequestSchema_7c35f1b8077023290eba973e5d61e23dcde170582531ed08497acc3ad6d09bad,
  "GET /security/compliance/data-requests/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /security/compliance/data-requests/stats": adminRequestSchema_27757dca1aa148fb25e576d327656061518651027350066903d3ef5a0225fe7d,
  "GET /security/compliance/data-requests/status/overdue": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /security/compliance/reports": adminRequestSchema_031359f8879ec46096e7003338a362b2aa0a8c894cbe9e4096a0c99ac9991f47,
  "GET /security/compliance/reports/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /security/compliance/requirements/:framework": adminRequestSchema_5233fc6a347af75dd8063cccae0466277b2a546b6daca5766212d8b382a2cfb6,
  "GET /security/monitoring/alerts/realtime": adminRequestSchema_21049ec4cfb2f8dd7d9e20a531775ad9df0e758e7cf8a635bd3ef4607bd4aabe,
  "GET /security/monitoring/config/anomaly-detection": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /security/monitoring/dashboard": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /security/monitoring/events": adminRequestSchema_3518371b8da3b87a87c517218bd4887ca6f151b5ed5149c5da324ad7b0b32e78,
  "GET /security/monitoring/events/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /security/monitoring/events/stats/summary": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /security/monitoring/health-score": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /security/monitoring/incidents": adminRequestSchema_152fb40b6020098f101742012b74500983de2481478f5f485ee2dabfa4462ffc,
  "GET /security/monitoring/incidents/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /security/monitoring/incidents/stats/summary": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /security/monitoring/threat-intelligence": adminRequestSchema_d36c527176f16b3bb2be4f0a68d4637a06f0e2e5a4ef66f85e5c0a4efde7aba9,
  "GET /security/monitoring/threat-intelligence/check/:ip": adminRequestSchema_52f6c8a406da7d0a2ebccd0763bb4449b7d456cbaef2528c616690719a3090ca,
  "GET /security/monitoring/threat-intelligence/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings": adminRequestSchema_0a80548496142769fa8faeb288dd0a27494e9112e5cf2eb27ccf7c5422b66876,
  "GET /settings/category/:category": adminRequestSchema_f32689b645e41d5740702a04e76bccbdec1cca118bce1ca939084128a5c6b78b,
  "GET /settings/config/billing": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings/config/email": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings/config/maintenance": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings/config/rate-limits": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings/config/security": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings/email-templates": adminRequestSchema_638b8685f6bd41d51724f7f993e6166f8767e18ed2bb26bda4c3b57c8b47d10c,
  "GET /settings/email-templates/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /settings/email-templates/by-id/:id/preview": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /settings/email-templates/categories": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings/email-templates/category/:category": adminRequestSchema_624b7678488b2e0a6cee5b8a53563b4d20fae35fda0ef57f2047d2da28155a73,
  "GET /settings/email-templates/code/:code": adminRequestSchema_01ebd6b5b38f2540166367e27cb9bad0f6d5cb42d1f8e7241919b31dea7cdf02,
  "GET /settings/export": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /settings/features/:featureKey": adminRequestSchema_54aff9e9f1b87c8415501f5c1c6bc2fe94e0ce189cb5ee69310a6ba853a4c805,
  "GET /settings/ip-access": adminRequestSchema_40daf38884b6bcfba0589ae7447afa54a5d4789b37081c45c2d4923fd2f3b06b,
  "GET /settings/ip-access/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /settings/ip-access/stats": adminRequestSchema_638b8685f6bd41d51724f7f993e6166f8767e18ed2bb26bda4c3b57c8b47d10c,
  "GET /settings/ip-access/type/:ruleType": adminRequestSchema_0bd3e1be0356e597cb0cc9f76d0cb6b8cdf84cd9e4bd32f05a0b29520a18d3c6,
  "GET /settings/key/:key": adminRequestSchema_9ea419c9fad51c6ed67b71af8d12771214d2642ee01736417bc65e59729ee6da,
  "GET /settings/system/info": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/announcements": adminRequestSchema_1cfe0f2e26da97c6d578aac8560ac0dab46b83be7fffb425ef4748dcabd1df19,
  "GET /support/announcements/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /support/announcements/:id/acknowledgments": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /support/announcements/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/announcements/tenant/:tenantId/active": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /support/announcements/tenant/:tenantId/pending": adminRequestSchema_ea3d96988cb0d8224c3648623bd345b9eb6f2aa0c264ca164651a47e83213ed6,
  "GET /support/messages/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/messages/tenants/:tenantId/threads": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /support/messages/threads": adminRequestSchema_65a36bd53d785f69bc74a481787efa8eb95176b55f9becc9c68befed60041daa,
  "GET /support/messages/threads/:threadId": adminRequestSchema_7486ff01fde2b5442894d296e224451d32ca509382dca998a95dcc050e24abc6,
  "GET /support/messages/threads/:threadId/messages": adminRequestSchema_533e134a99ba27237a67a4abdfe8fbc1bc1b0bae702bbc3b8f3c583330cc5851,
  "GET /support/messages/unread-count": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/onboarding": adminRequestSchema_514d8c08e7e0ffcc7533a22f1c5f41b4304f1c1220a4fb57bfbc57b83929a229,
  "GET /support/onboarding/:tenantId": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "GET /support/onboarding/needs-attention": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/onboarding/resources/all": adminRequestSchema_21ddedd46e9e27b43b91559fc989ca4fcaaae947c851af2bb04453238ef39e93,
  "GET /support/onboarding/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/onboarding/steps": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/tickets": adminRequestSchema_32266ddf4c187699d7586d61f81421fb22304a84a35ffa19b257423ab20c2c63,
  "GET /support/tickets/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /support/tickets/assigned/:userId": adminRequestSchema_5c40189315b1733f87644300435039fd8dcca6241e9622dab5cba47e125d6607,
  "GET /support/tickets/by-id/:id/comments": adminRequestSchema_d6a391e377be6c84f3e4c28aa4294854d291f428b1ed70e6b702632e7e568e9c,
  "GET /support/tickets/number/:ticketNumber": adminRequestSchema_8b5bf7548ec3b97002ed2847f8b78e94fe30bff3951f4a4f3f22cf3cf7286426,
  "GET /support/tickets/sla-risk": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/tickets/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/tickets/stats/by-category": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/tickets/stats/by-priority": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/tickets/team": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /support/tickets/tenant/:tenantId": adminRequestSchema_aa933b9078bc9d64b35338a4f27b404df3d72d397b96c3eee5432dc82c36dec2,
  "GET /support/tickets/unassigned": adminRequestSchema_461a802e20f5a848d9212b2806f88745aed5d32427fb0aa730a8f78e4e46c13e,
  "GET /system/errors/alert-rules": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/errors/dashboard": adminRequestSchema_372f1f8b5c8d735b6525a9dc261f45afeb2def909d10ff4de163933bf5cfea99,
  "GET /system/errors/groups": adminRequestSchema_882da80d143ffa7ded60baff6d7bf0573123a2db9e12a30d8bab8b351139e9c7,
  "GET /system/errors/groups/:groupId/occurrences": adminRequestSchema_73bbe26b6265e3e1464f379e05dc33a4f246606f1c95a55760dd2874dc3c6a03,
  "GET /system/errors/groups/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /system/errors/occurrences": adminRequestSchema_e57119e9d9633fd1dfb561de73b2d371ac8600c309323917a197c32942e27458,
  "GET /system/errors/occurrences/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /system/errors/stats": adminRequestSchema_0d0a936448ffd432b1ec27e4a19cf2e57c67acb1423f6b9f74fbbe8a2d2da82f,
  "GET /system/jobs": adminRequestSchema_3664c794c8aae8fbc976b70fa93d2eda9fd9267b8a041e9c7a4f028fbae31f8a,
  "GET /system/jobs/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /system/jobs/by-id/:id/logs": adminRequestSchema_4b1fd9035edceb53626a0550c6f99a16849082093fcd6c34989eff53fb8ca86b,
  "GET /system/jobs/dashboard": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/jobs/queues": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/jobs/queues/:name": adminRequestSchema_7490355613f828c8d44b973584f6e8896eb0b0c9e4a8ce5e05f682fcf917847b,
  "GET /system/jobs/queues/:name/stats": adminRequestSchema_7490355613f828c8d44b973584f6e8896eb0b0c9e4a8ce5e05f682fcf917847b,
  "GET /system/metrics": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/metrics/database": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/metrics/platform": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/metrics/resources": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/metrics/trends": adminRequestSchema_fb8fc0be6308b2ea28be994d059708d1614e1d7e8c5557ae0f8739e4de3ffceb,
  "GET /system/performance/alerts": adminRequestSchema_47ba80857f9a5912a48d15d2826ec3bf17d5d343cb47998ea7f2633e7366140f,
  "GET /system/performance/application": adminRequestSchema_372f1f8b5c8d735b6525a9dc261f45afeb2def909d10ff4de163933bf5cfea99,
  "GET /system/performance/application/apdex": adminRequestSchema_e6ec4d330b250fff119d64e7fd73ec0be57079bde9303e439bbbc28d4481452f,
  "GET /system/performance/dashboard": adminRequestSchema_372f1f8b5c8d735b6525a9dc261f45afeb2def909d10ff4de163933bf5cfea99,
  "GET /system/performance/database": adminRequestSchema_f8030d9d673ea4debc64d00ae3131d473620c129dc59b8c09873135f0326e20c,
  "GET /system/performance/database/slow-queries": adminRequestSchema_8e875f445366a69fba4332e5b938004d384398eccdfffdbab3b185ac14e95485,
  "GET /system/performance/history": adminRequestSchema_0fcb7488bf2bc5084f89d94080a37b3547309e55f59687684262643115b2b5b8,
  "GET /system/performance/infrastructure": adminRequestSchema_fc49ed76f7185731f2b31d07d952eb92e9c48753c05ed08e6ab1b9ca09875858,
  "GET /system/performance/services": adminRequestSchema_e5c36b850c767851633c9306a4ce44c296288d8f6ba8c2f152bfaf495e74c622,
  "GET /system/performance/snapshots": adminRequestSchema_3e64e8432e7932841ebed7b045c26bc67b2683091b9295d1645c459ca5f1c7c5,
  "GET /system/performance/thresholds": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/services/health": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/settings/configs": adminRequestSchema_1bd689002aa64ca84677733e6043ade5b91965d90d4a14932f1f404e1204b620,
  "GET /system/settings/configs/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /system/settings/feature-toggles": adminRequestSchema_cd014e6dac014b2ca9197f6761bc53b5c3d91d0796fe6c2fd95f39f84726c7ca,
  "GET /system/settings/feature-toggles/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /system/settings/maintenance": adminRequestSchema_6b052275e78fc0cfac8e8953e86b4b9530f6609ae679e920350be85f330beee7,
  "GET /system/settings/maintenance/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /system/settings/maintenance/check": adminRequestSchema_07fe2d53b54859c9388e3f15b93a60ff76deef6b8684c7cccce64f29b4777b6e,
  "GET /system/settings/provisioning-config": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/settings/status": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /system/settings/versions": adminRequestSchema_3a060de84e937b980738a1dcfb413eeb47b6d1efbb4a73e8fe8419bb444cf913,
  "GET /system/settings/versions/current": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /tenants/provisioning/:operationId": adminRequestSchema_561545df276ed710a1d9a506f67832376aa9e7796d019538777353536dfe0dc1,
  "GET /users": adminRequestSchema_3152a075e65ce6bc8a7239576296492f9b926b742283bfd15c4871d57e8e41cf,
  "GET /users/:id": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /users/:id/activity": adminRequestSchema_bc1fab1ad239be509e872873d23061924f005af9c5cc05fc599e0fc13c05eee9,
  "GET /users/:id/sessions": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "GET /users/lookup/tenant/:tenantId": adminRequestSchema_ac4d6c8c4e88e4c8e74dcb82535979b8429009c5c218468fe2cdff7b9aefcc92,
  "GET /users/recent-activity": adminRequestSchema_56b954e4b81c024a641592e3b559a6a9daeedcadb821a3ff2ab6c4872ec3d6f2,
  "GET /users/roles/:roleCode/permissions": adminRequestSchema_8f437a7bfded24c0d1cf77e05ce8c2513f1dbd0d1e347dc48d7acd6caf781d1a,
  "GET /users/roles/can-assign": adminRequestSchema_daced7bee50e6208c6f46abea97f5ee17e33dd4c085d690d98800c5990325064,
  "GET /users/roles/hierarchy": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /users/roles/lookup/:roleCode/assignable": adminRequestSchema_8f437a7bfded24c0d1cf77e05ce8c2513f1dbd0d1e347dc48d7acd6caf781d1a,
  "GET /users/roles/permissions": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /users/roles/permissions/grouped": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /users/roles/templates": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /users/stats": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "GET /users/tenant/:tenantId/limit": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "PATCH /admin/tenants/:id/activate": adminRequestSchema_448e1650cad16f6e389b39a16147292992a6eb101b9776eed036a98f464b4b32,
  "PATCH /admin/tenants/:id/deactivate": adminRequestSchema_e1f451be13022ba785a6ba31d2cda367ebfafffb76986d0f460cf238abb440bc,
  "PATCH /admin/tenants/:id/notes/:noteId": adminRequestSchema_ade60327c4d29eeb5822e71915c9ca7a962d9f9ca8001fafe091f5300cb4a43c,
  "PATCH /admin/tenants/:id/suspend": adminRequestSchema_e1f451be13022ba785a6ba31d2cda367ebfafffb76986d0f460cf238abb440bc,
  "PATCH /modules/:id/activate": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "PATCH /modules/:id/deactivate": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "PATCH /users/:id/activate": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "PATCH /users/:id/deactivate": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "PATCH /users/:id/force-logout": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "PATCH /users/:id/reset-password": adminRequestSchema_0d8271dbb00648bce92a985a3797b5da8ddbac03767ad72888defe5b1b665da6,
  "POST /admin/tenants/:id/erasure": adminRequestSchema_2b1447c00c2f6dd54bd4ec9f6bf3b85b7d14fc86f82dfd710cded27a553e537d,
  "POST /admin/tenants/:id/notes": adminRequestSchema_1559820e3c5aab5344e83a8f1666c21e68741bd30eedb06c4d5e1100a60fcd10,
  "POST /admin/tenants/:id/reconcile-subscription": adminRequestSchema_448e1650cad16f6e389b39a16147292992a6eb101b9776eed036a98f464b4b32,
  "POST /admin/tenants/bulk/activate": adminRequestSchema_6af5545537e45688884a98cca8632397c3eff3866d5e3566d2375efc8e724999,
  "POST /admin/tenants/bulk/suspend": adminRequestSchema_aa6760ccad2f89a8706e78895a337920b73a5141cfe12f5d5e8352a7bc8663fa,
  "POST /audit-logs/export": adminRequestSchema_15158e216fc62a34c94236e7b9cc53d89be0cc6da6fb5251777930a7ba56e14f,
  "POST /auth/forgot-password": adminRequestSchema_027de36a75b45a26143f0a3cd56a8ebbbeb00b06e0a09e29f14c402fc331805e,
  "POST /auth/reset-password": adminRequestSchema_d4a3ae820534e76d693c3314d3f4140a7edad2fd397c3d5589c7ef39bfd94820,
  "POST /billing/custom-plans": adminRequestSchema_212cb83b6a442d23e2f72a85d0f8292b02d0e4d7ef407a4056f6fc0ea59b5f44,
  "POST /billing/custom-plans/:planId/activate": adminRequestSchema_a365927253bd76b330e52db909dc050b987c244e4fa87ff370b718037702de42,
  "POST /billing/custom-plans/:planId/approve": adminRequestSchema_0cfe82a35e2ec78a61c48e874a46b86d18a660fb08c8750f71712efcee331841,
  "POST /billing/custom-plans/:planId/clone": adminRequestSchema_f2675bf2b0eaa3cdf687e7c61ff431058270384a203d4aec2d05b20c711d145d,
  "POST /billing/custom-plans/:planId/reject": adminRequestSchema_be551d85bf15d75fd4fbe47067169f0229a4367e04e1bef6aa915fcb6d686b03,
  "POST /billing/custom-plans/:planId/submit": adminRequestSchema_a365927253bd76b330e52db909dc050b987c244e4fa87ff370b718037702de42,
  "POST /billing/discounts": adminRequestSchema_35a8c8f45def0b6ef50abe3f1af82053f0631651d82c5a24b5d894010fcb678f,
  "POST /billing/discounts/:id/deactivate": adminRequestSchema_8b9ba80b0cf3ad11ba8c5999a4e5960017c84a3c0372310f58777a424a01a3d7,
  "POST /billing/discounts/apply": adminRequestSchema_8c685ef310b896c60cc2426dec6db3f2f1a45f4c62d22651ec6f46737e24f2af,
  "POST /billing/discounts/bulk-create": adminRequestSchema_153727ce1318f1334a077b241b90f83e6921663590c1dd2d27a3cff196840b81,
  "POST /billing/discounts/generate-code": adminRequestSchema_78aebad93bf2da39b29723937290e59b257566862554ea6d24f6dd20251522cd,
  "POST /billing/discounts/validate": adminRequestSchema_40aed25e272f9f9d8b9da59e5863027095d121c248cdca0d4810735a337fa83f,
  "POST /billing/invoices": adminRequestSchema_d1c4ff23e8e3a5f644f5eff0a7444e907dc2c81c9528625c3b016598c2dce01f,
  "POST /billing/invoices/:invoiceId/mark-paid": adminRequestSchema_46013c9f70000bf48a5cc443865877bfa5d79cb56c8b2459d9e3cc7ccbccf030,
  "POST /billing/invoices/:invoiceId/void": adminRequestSchema_f821d8efd5b7d7dcdecf7a87971824c6d7258f0cd3d8b9f6bcad9d3eb390f0aa,
  "POST /billing/invoices/update-overdue": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "POST /billing/module-pricing": adminRequestSchema_fa1e71cd5b051ec1fbb03079529a5c129e19cb28ca6a2beb8dc80f37896463c3,
  "POST /billing/module-pricing/:pricingId/deactivate": adminRequestSchema_c09246dc3dc6c46e0818af571cda5408bddaf3348e52ab97285d57851e811c37,
  "POST /billing/module-pricing/seed": adminRequestSchema_2b9671fb2eb263f420d0479108e797a3f7fc2aea56d28a92408299f5b949b29e,
  "POST /billing/payments": adminRequestSchema_9f0d8bd210ffb9e3c8b6866e4c860638212b7485a301f4e6ce522731ef3adee1,
  "POST /billing/payments/refund": adminRequestSchema_9ce3dd28fc6fa6ec4554dd5de308ec4a019f73c46cbeb6229114b7d74bb5a885,
  "POST /billing/plans": adminRequestSchema_d07f47b502766c38bd95cbdf93877c7a583c8a62e49625e83280629e510e2e02,
  "POST /billing/plans/:id/deprecate": adminRequestSchema_8b9ba80b0cf3ad11ba8c5999a4e5960017c84a3c0372310f58777a424a01a3d7,
  "POST /billing/plans/compare": adminRequestSchema_96830556a81bdaf725e4e4d28808b1502598489b9c0830ca7b1c9a16421b3dac,
  "POST /billing/plans/seed": adminRequestSchema_7f83b55ea74d8261da5f7e8635dbb394c4c690847f1bb2b1eea359fd5109b4f2,
  "POST /billing/pricing/calculate": adminRequestSchema_b293323c6278c5d85eac848825484ef92191ba213dc528ba17c3b320d93d16ac,
  "POST /billing/pricing/compare": adminRequestSchema_b13bb7de7e39ed2bc0c9faa98b093c8983917aec7c8bf0d5f9cd93893434bbca,
  "POST /billing/pricing/quick-estimate": adminRequestSchema_b015e78dbd75d5dabe153baf403a06e182e0c65a05eb3690f2cfb197e045e5c2,
  "POST /billing/subscriptions": adminRequestSchema_7f83b55ea74d8261da5f7e8635dbb394c4c690847f1bb2b1eea359fd5109b4f2,
  "POST /billing/subscriptions/change-plan": adminRequestSchema_6ea0a2fd66e20917b02a5f6407b5cff7ae63126dba2258c11f01ed9b99d4edcd,
  "POST /billing/subscriptions/process-renewals": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "POST /billing/subscriptions/tenant/:tenantId/cancel": adminRequestSchema_bcad9a5a0fa65a9823ab6e43819cf407341eba1ad6eea8b1678deffd02d139ff,
  "POST /billing/subscriptions/tenant/:tenantId/extend-trial": adminRequestSchema_aa85ef383791d6d9d1ff7c183e116b8bb74b82e45a93dc5dc13e751068739b53,
  "POST /billing/subscriptions/tenant/:tenantId/reactivate": adminRequestSchema_a1f1dd2463f5775c5f804373a91406da9de01046f3eac214d8bb9ef20872f6c9,
  "POST /database/explorer/query": adminRequestSchema_2008eae165423e607e1feafd2c3326e58fb9e014f2a57cf6a9b89038e76b6c91,
  "POST /database/explorer/schemas/:schema/tables/:table/rows": adminRequestSchema_4a7fd0f9caccbe426ccc47b2c55528d3343164106a3c110cf2ca6ec6c7fbbcd8,
  "POST /database/migrations/batch/run": adminRequestSchema_c1aa4d27fe82cf0cfcd7118743eae8431d38c7fb415e3a36e031701daa800ebc,
  "POST /database/migrations/tenant/:tenantId/rollback": adminRequestSchema_c71505ce7514070bc75dffcadd9b4c4ec52313aa3046470b8451832374ae9896,
  "POST /database/migrations/tenant/:tenantId/run": adminRequestSchema_8215349d0b480d096dea5d9ef70bc5fbe0921ef9fc0621e6a5eef0f624d6dc45,
  "POST /database/monitoring/analyze-query": adminRequestSchema_adecfce314ad3c74119fcca4d18c40708b07269d99b1d62831abe2e820c40ea6,
  "POST /database/schemas": adminRequestSchema_7ae764aab621bdce87ff4c14c771aa7479799c383a63624856febc9606415613,
  "POST /database/schemas/:tenantId/activate": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "POST /database/schemas/:tenantId/refresh-stats": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "POST /database/schemas/:tenantId/suspend": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "POST /database/schemas/backfill-tracking": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "POST /database/schemas/sync": adminRequestSchema_ee6de03aa42f7bce4ccebd273e03edcbd124c540a07cd2a82a600ca1c49af772,
  "POST /debug/api-calls/capture": adminRequestSchema_0223111232796b1a235403fe159a507e53227ff20a2f85ae80cce601ef13daac,
  "POST /debug/cache/invalidate": adminRequestSchema_da09d1595d98ea5036c42edc7fb304b1f92cb6740bd5f4b0d856ce5c316cbd36,
  "POST /debug/feature-overrides": adminRequestSchema_c39d71809815835b7f5bbe222511d2ea03bc9f2500f4be4e98587a515bbe0890,
  "POST /debug/feature-overrides/:id/revert": adminRequestSchema_b7614b237f3a3720d09429129aacbab7138aecab1b5c2fbf40acba8aefeaf351,
  "POST /debug/queries/capture": adminRequestSchema_a2b2be5f3eb533ed1ac603d412ab9c900b3eeac12b40b6b8f03f9eddb5b675d8,
  "POST /debug/sessions": adminRequestSchema_113ecc81bd4c3e2a25e7b1453252ae7c5157bc49aaeefb4a37c7d52e0078b4dd,
  "POST /debug/sessions/:id/end": adminRequestSchema_6737692698704fa4a7bd7fc717c356fd1e2cc537c33ce43a01ed8916ac27cd75,
  "POST /health/circuit-breakers/:name/reset": adminRequestSchema_7490355613f828c8d44b973584f6e8896eb0b0c9e4a8ce5e05f682fcf917847b,
  "POST /impersonation/permissions": adminRequestSchema_931f41b53b28ba303047b40267e352ec661024a5313c349e4ee4c56aed5c66c5,
  "POST /impersonation/permissions/:superAdminId/revoke": adminRequestSchema_e30810b7a07561f416c59cc887050f9a097f1b66c53ea0050b26b43ab8567504,
  "POST /impersonation/sessions/:id/end": adminRequestSchema_3dcdc010b043115303502cff423a9c86212384075a1fcf15a2cb4c288dc864b1,
  "POST /impersonation/sessions/:id/extend": adminRequestSchema_fe7e7ae91eca2f0488d86094a2eeff08a29b930c8a9e2cb3132011e70eb84bb1,
  "POST /impersonation/sessions/:id/terminate": adminRequestSchema_a9b7da086f4f002825dcfa5729accea43ced85d813c9e5f82f2390ea20efcbfc,
  "POST /impersonation/sessions/authorization-context": adminRequestSchema_73010adb2e55607bdb8dac67fe66f55c2139e55e5ecec0c9b6b96318de0a79a5,
  "POST /impersonation/sessions/authorization-receipts": adminRequestSchema_f21be8cb725a5cadff1044c699f765922ff743b06a897e025d20fffb416759a2,
  "POST /impersonation/sessions/start": adminRequestSchema_b46d55dd657c0081ebfd4189d1695472e82a9169f0d8df9f8d4902311f5ba376,
  "POST /messaging/compliance/legal-holds": adminRequestSchema_7172305de68aa1711b903bf5fad364664c15edc030f62bca6e54573d7474034d,
  "POST /messaging/tenants/:id/export": adminRequestSchema_6660ed2015fee005506790c103c688c4fe9b952718be5c444691f174a9e63f59,
  "POST /modules": adminRequestSchema_e191bab04684cd10c56fae223c5fca99d4a9fda565541825f1816db8c53b7da1,
  "POST /modules/assignments": adminRequestSchema_4ed0cfed5b64b800c606ba07d01722ff33fcb372bd55926904074e808cc23b69,
  "POST /reports/definitions": adminRequestSchema_9dc2847760913eaa9b015a0e5f15eaa1bc7291bbd200c6444ddead029a92a1c9,
  "POST /reports/executions": adminRequestSchema_06b408b99b54da899e46f6b4651b5542233a97d63b353d93153a7498f30fc385,
  "POST /security/compliance/data-requests": adminRequestSchema_993fb544e2db99df1bea992f9856daab73a66324850595dc0b293a98cd570935,
  "POST /security/compliance/data-requests/:id/complete": adminRequestSchema_6feef65ef2f2db79dbd3e4f0257063b20cf3c9974e5bfbb5f95b16496cf44e2e,
  "POST /security/compliance/data-requests/:id/download": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /security/compliance/data-requests/:id/verify": adminRequestSchema_4d6a89747cca763c31f33c20ccd1815316861beb0c4bc2e986fbf1faeb678624,
  "POST /security/compliance/reports": adminRequestSchema_ef792c2a470a835f1d4913b40e8b2772cd1aaee72eaf4e75a3d6aba296a760bf,
  "POST /security/monitoring/analyze/login": adminRequestSchema_c37ac458f17a05b90b5219e3ef76e260c0ba05c310e26e245c68f5d1e163faa3,
  "POST /security/monitoring/events": adminRequestSchema_362422a849f6e21b580ab2b6881cb9d647d4f97dd181c156b7b38c8e15eef249,
  "POST /security/monitoring/threat-intelligence": adminRequestSchema_439c81b4493ed187d6a161ca0e6dfcfc6b578ef2130608851d9a4eecca1a00f9,
  "POST /settings/config/email/test": adminRequestSchema_c7a1c8fddf0c9e4ce1ecf88c0c3a95384c9d867292e124e8f53c7160ad710baa,
  "POST /settings/email-templates": adminRequestSchema_5a43b0e4a0f3ae3e55bdc5728b9ff41c0627bf8f01491a5250dd45ea8d6c27e8,
  "POST /settings/email-templates/:id/test": adminRequestSchema_b4e54680ff764f70bc2ccc39c80573d47bab7de9a1262298a5ff04ecdd1f5d74,
  "POST /settings/email-templates/code/:code/override": adminRequestSchema_29799466bd33e631820b417de27b8b1d18e91b9ab6935ab42009675791dee64c,
  "POST /settings/email-templates/render": adminRequestSchema_70dd2156a6e9a87de8a50098f7d36cdaf87f5c4d3b4dc5d07d5c559cd7ce873a,
  "POST /settings/email-templates/validate": adminRequestSchema_1ba3644a9ce613ec9fd09d3cb8c49c39d25eb0d181abc1417e12073d4fe021f8,
  "POST /settings/import": adminRequestSchema_8ff0b76742913749f7b83cac8847c3261bf19faaa88ff546ab6efb8aecdf0176,
  "POST /settings/ip-access": adminRequestSchema_6597b22a47e0249580be0e75acfd60b8f58b24a0d1a4c029e99d9a4827f78acf,
  "POST /settings/ip-access/blacklist/bulk": adminRequestSchema_c28c521d1db5f40e8c45177503d6a547c51572f87510739b58746fa352c953d3,
  "POST /settings/ip-access/check": adminRequestSchema_cb09fa9febac261043ff55a91f67caf946feb665e216b4bae33c39c2a7b58486,
  "POST /settings/ip-access/cleanup": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "POST /settings/ip-access/whitelist/bulk": adminRequestSchema_c28c521d1db5f40e8c45177503d6a547c51572f87510739b58746fa352c953d3,
  "POST /settings/key/:key/reset": adminRequestSchema_0e10caf6a0ca6721dc12b3be8f00da3d4482a725c335ff09ade6e5a8c2a02a38,
  "POST /support/announcements": adminRequestSchema_a0698b0c864322d30f2cdbc12f18db31fb8270eff3f4e159b6456174a2148712,
  "POST /support/announcements/:id/acknowledge": adminRequestSchema_86f9ca7beb177ab710b93b934819e4b2a92a7813b0a38dab7896a2ee58cd77c5,
  "POST /support/announcements/:id/cancel": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /support/announcements/:id/publish": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /support/announcements/:id/view": adminRequestSchema_86f9ca7beb177ab710b93b934819e4b2a92a7813b0a38dab7896a2ee58cd77c5,
  "POST /support/messages/bulk": adminRequestSchema_f5f35d8082b17bfea9277173136d03d1e7a7d07934d7590ed98dc1a307d1a70e,
  "POST /support/messages/threads": adminRequestSchema_096bbf444f04cdfe04c8a2f6898f341e6d874fb3bdf4b0df39a3b6daa889f778,
  "POST /support/messages/threads/:threadId/archive": adminRequestSchema_7486ff01fde2b5442894d296e224451d32ca509382dca998a95dcc050e24abc6,
  "POST /support/messages/threads/:threadId/close": adminRequestSchema_7486ff01fde2b5442894d296e224451d32ca509382dca998a95dcc050e24abc6,
  "POST /support/messages/threads/:threadId/messages": adminRequestSchema_b90f94c019a5b1687c4b620e5c3f8bdc84df17b80e9338d692341cafa481fa16,
  "POST /support/messages/threads/:threadId/read": adminRequestSchema_7486ff01fde2b5442894d296e224451d32ca509382dca998a95dcc050e24abc6,
  "POST /support/messages/threads/:threadId/reopen": adminRequestSchema_7486ff01fde2b5442894d296e224451d32ca509382dca998a95dcc050e24abc6,
  "POST /support/onboarding/:tenantId/assign-guide": adminRequestSchema_2577423d147a79632a016b05cdba7ae04ea3e8e68121898c6744a0f1dee3bc20,
  "POST /support/onboarding/:tenantId/getting-started/view": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "POST /support/onboarding/:tenantId/skip": adminRequestSchema_ea14d5d002a956639d2ae1bd3063fa82e055db537819d3fe53349162e2e87a4b,
  "POST /support/onboarding/:tenantId/step/:stepId/complete": adminRequestSchema_00b22780b8ef33813987e16ee48ff0b67414924c7d1f12d345b195ae4965fee6,
  "POST /support/onboarding/:tenantId/step/:stepId/skip": adminRequestSchema_00b22780b8ef33813987e16ee48ff0b67414924c7d1f12d345b195ae4965fee6,
  "POST /support/onboarding/:tenantId/training": adminRequestSchema_3d155c8437ec4ff7f77fbcec657f365b70d457860500677df0e9a3327ef5b4cf,
  "POST /support/onboarding/:tenantId/tutorials/:tutorialId/view": adminRequestSchema_6f6d027ed325b1c1223119cc9b0bdb10657da37bf9f06d83e790c942ceb20c0f,
  "POST /support/onboarding/:tenantId/welcome-email": adminRequestSchema_5bac640dd0f9a6c8f01b0f79c60141f5a8f1afaca2b0703338f335328a12b118,
  "POST /support/onboarding/initialize": adminRequestSchema_e0bd6cde657eea584e84f58d0ca13086bfd24692a31d3223cdb9827138cbfb09,
  "POST /support/tickets": adminRequestSchema_3ddabc2bb960515297cc38cc15fcafe1ecb8c3ce91cf05f8c4f3886abe30fdda,
  "POST /support/tickets/:id/assign": adminRequestSchema_5912849a4c4f1b2119259aea509b5162ea8c371db1225037213a2005a5554295,
  "POST /support/tickets/:id/priority": adminRequestSchema_9039c49645dda7636ebd7f0e3711930e193457e1713f060f264e5e81cec1988c,
  "POST /support/tickets/:id/satisfaction": adminRequestSchema_fcdd9f2846c58a3956fa3433e8704d7f6dae4573b348f0b492b93ab8aeb78377,
  "POST /support/tickets/:id/status": adminRequestSchema_346153b49daf0fa03d3d988c0de2c5ecbf47724c20700bfd585540a169062a1d,
  "POST /support/tickets/by-id/:id/comments": adminRequestSchema_77d9a81ccada4bcc677d7ae25ab4b1825d73ac8e33fd1f01f18bdced6bea88b8,
  "POST /system/errors/alert-rules": adminRequestSchema_99676024cd8b51ba005bc662fdb612535f93d6ae2e8d473ca39414a59b29c22c,
  "POST /system/errors/groups/:id/acknowledge": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/errors/groups/:id/assign": adminRequestSchema_8576a8b1148b2a2dfd9fbba2da7a544d654477cbe2b9f827514d36dbae061946,
  "POST /system/errors/groups/:id/ignore": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/errors/groups/:id/resolve": adminRequestSchema_552969562e6b1ea3f11fdeacbcc4ae6014f41e6e16ec48d73683c583a018683a,
  "POST /system/errors/groups/merge": adminRequestSchema_99404c5893c448e18567f1e833ff16e734249b4d79862a3e95ee2bf2f3ac672b,
  "POST /system/errors/report": adminRequestSchema_86b5855024e2dcb097744e7c977c96e55b4de1e6feb7eb4d2367b64291aa768c,
  "POST /system/jobs": adminRequestSchema_cb64f366f118b8a9f812547d8b598780693b1ac7df38a479142fc8600605822b,
  "POST /system/jobs/:id/cancel": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/jobs/:id/pause": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/jobs/:id/resume": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/jobs/:id/retry": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/jobs/purge-completed": adminRequestSchema_f3cbaa5e595cfd749488f6581130f7be437cb36aad0f57c71fa1289e2ede9fb6,
  "POST /system/jobs/queues": adminRequestSchema_28561d85c539d6e6d46b48dac49bd03d599792efedcfded75f6f256c3555c31d,
  "POST /system/jobs/queues/:name/pause": adminRequestSchema_7490355613f828c8d44b973584f6e8896eb0b0c9e4a8ce5e05f682fcf917847b,
  "POST /system/jobs/queues/:name/resume": adminRequestSchema_7490355613f828c8d44b973584f6e8896eb0b0c9e4a8ce5e05f682fcf917847b,
  "POST /system/jobs/recurring": adminRequestSchema_0c8845f93d4d46cc756f477d8ee3eacc5c985e804eaf9423460be821ee5ad4e6,
  "POST /system/jobs/retry-failed": adminRequestSchema_703b52e6ec1fa18881be1d0f194cdb9556d0c337b2bb0b125295b34ada6d4a1f,
  "POST /system/jobs/schedule": adminRequestSchema_841a28e2ef78cdec539d2223ee34eb1e6d0acd8f5b5cf75e32538cdb2332ae6c,
  "POST /system/performance/metrics": adminRequestSchema_d3d93d39b1cc94dc42767ffc7cf50e1101793b1225ea7e964dc814e7fed7ad76,
  "POST /system/performance/metrics/flush": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "POST /system/performance/metrics/request": adminRequestSchema_8e8e6211d18f18a472e289ac0e67a9b2a9b310b868068c65478eadfdfc101d36,
  "POST /system/performance/thresholds": adminRequestSchema_42c6066dd165fab3a667e84557957f6ce4eb09895868682d2ff64125e238839e,
  "POST /system/settings/configs": adminRequestSchema_bda46cd583cb9c4c8f21addf979135c8202cdcb2db16f19bcbcc546f60a34096,
  "POST /system/settings/configs/bulk-update": adminRequestSchema_89f64abf6627f9911cc957d073ceacd33df1162aa162496b0b83391ff06b84ee,
  "POST /system/settings/feature-toggles": adminRequestSchema_9802da8cd3fc28a6c6aa37fc901421c343547d906ae5aa10b036c4ba35bab977,
  "POST /system/settings/feature-toggles/evaluate": adminRequestSchema_64339ec871761c2c6fa65362cc7893eee5046420163aa556fc7c227bdc4954b0,
  "POST /system/settings/feature-toggles/refresh-cache": adminRequestSchema_0cfa4867bc5615c9aff852beb827387a89cca4e8a69387072f82985c6a021a2b,
  "POST /system/settings/maintenance": adminRequestSchema_3ee4cfef5e469f16a2970c7ae2510af8a73c26f18f5f4a1bd862e75c9244cea6,
  "POST /system/settings/maintenance/:id/cancel": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/settings/maintenance/:id/end": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/settings/maintenance/:id/extend": adminRequestSchema_aa5a200f97b787bb93a97446a85f5172df2935ac33b2dc07395992d68d3405da,
  "POST /system/settings/maintenance/:id/start": adminRequestSchema_00727400e1534d3b1023d39d44b13da7df536a62a437aada80dcdae162230ddf,
  "POST /system/settings/versions": adminRequestSchema_cb67a1a1ea2aa037315fc4d96ca1e11d5c370a4cc95ed9e66382a2b9ea88adee,
  "POST /system/settings/versions/:id/deploy": adminRequestSchema_e6e95b43e8ab44f9896a9ca426b7ff69d029c8db5a612e602ec8778490a8b0fb,
  "POST /system/settings/versions/:id/rollback": adminRequestSchema_96644a3376b06abd19060ed21fb7eab0ca34e014d28e14244c410faf34a6e44e,
  "POST /tenants": adminRequestSchema_e3a742d6a1d1e531c9b43394243dde0d43839502f14b6b3740160d0f29ae76cf,
  "POST /tenants/provisioning/:operationId/retry": adminRequestSchema_561545df276ed710a1d9a506f67832376aa9e7796d019538777353536dfe0dc1,
  "POST /users": adminRequestSchema_7818840deffc5cbb5c546918a3e8473c983815428522b0a4d29eeaaffc743f71,
  "POST /users/invite": adminRequestSchema_814fccccbd9e85b0ef5c9237a1cec6c9983824cc026dad60db223d9419b8eab6,
  "PUT /admin/tenants/:id": adminRequestSchema_ba6bcd6ca163181026aeca5b031fefac9a44d977039c4c0e34f9b0eae02218b4,
  "PUT /billing/custom-plans/:planId": adminRequestSchema_f3e8f5720e5b636d0007484f8c61da908b704199bec0d709e257ae45b021ee3f,
  "PUT /billing/discounts/:id": adminRequestSchema_9027bde44e89b674101c723b6c154f1cbd6058d99182610c7e8a894530e7f595,
  "PUT /billing/module-pricing/:pricingId": adminRequestSchema_6c7541a1e92462e3057c9d0891fbabdad47c28482a999080ddcc818b99be372d,
  "PUT /billing/plans/:id": adminRequestSchema_abda90902e6b3b80aa43f09ba92ec4dcde0edef83283cccf6608e71814d9cc01,
  "PUT /database/explorer/schemas/:schema/tables/:table/rows/:id": adminRequestSchema_efe103a03f7e0f3f4a2f50568a5acbcf0a15463ecd4ef7acb2fe989f5a5c7caf,
  "PUT /messaging/retention/policies/:id": adminRequestSchema_2c6acb3956b05a982af52d243a3c339013414813dbb943f2816d73ac310c56fe,
  "PUT /modules/:id": adminRequestSchema_21ff0343940dba0e0a16a1147a95b3302c557ef2ba9c2aa99704badf4325804c,
  "PUT /reports/definitions/:id": adminRequestSchema_c1ed67582bddadc0999a881c222dc9afaa1eb457896460d5bd10b86e120fad4c,
  "PUT /security/compliance/data-requests/:id": adminRequestSchema_489f6512c7d648d17cf7fc9d12bb0d921458523c03ee237419edfee611fa3f92,
  "PUT /security/monitoring/events/:id/status": adminRequestSchema_cdaccde84df87a8d2a420ee08174ccc5ee4de3fb1239ccf9ae066ed4f81f68c6,
  "PUT /security/monitoring/incidents/:id": adminRequestSchema_65501a4697384c561891d1963208409d841f8921887b0241d59d70df798a4014,
  "PUT /settings/bulk": adminRequestSchema_39c526920c5c302f81b67264d3e4cf81fb735ebf8c3eeeefdbc1825da936d928,
  "PUT /settings/config/billing": adminRequestSchema_373e4870ace05af7451c5c2be77b4810fd57fef6f36477cf0487eefab4380846,
  "PUT /settings/config/email": adminRequestSchema_0866463cf4f9720852f39d751fe87ebd2b16aebd62461f154269a91c8fd9fbc3,
  "PUT /settings/config/maintenance": adminRequestSchema_93b3ed5fdb9f6a6d0b3d5b23dbac8bc4cf35009b541c07f69177f52c7d3b57a7,
  "PUT /settings/config/rate-limits": adminRequestSchema_c146db2001e748da53dd0dbdbc1c1ca5b0de65558ee06c6de6451f302649a000,
  "PUT /settings/config/security": adminRequestSchema_7aa973140c52b191e421d122913b56deffe615721d3a63d6f8d48550c584af74,
  "PUT /settings/email-templates/:id": adminRequestSchema_a7c6fba337315b36af0f0e2ea7c7417d82cd0b2d86b5e7229902169edda5910a,
  "PUT /settings/ip-access/:id": adminRequestSchema_7af0802ab16949fdafa39a971351754276096007b2bd364e2435ce2bff4deec9,
  "PUT /settings/key/:key": adminRequestSchema_49565aae0bf958f3d66692608a777d40450dcd52cc6a2a1266b1062333406e47,
  "PUT /support/announcements/:id": adminRequestSchema_619c9abe4219425ad74773a045227817868d3938d4b5e9620be49bd984758da1,
  "PUT /support/onboarding/:tenantId/training/:sessionId": adminRequestSchema_d6f35f40d9d457e069306eee4d674788f49d53456cd66a87de20d1e8b42e6b5b,
  "PUT /support/tickets/:id": adminRequestSchema_1882943d1ecbe7d83e13566118f7ab169507c69caf6c982c0306abb0c48bce9e,
  "PUT /system/errors/alert-rules/:id": adminRequestSchema_ec3a5528b31f3ac482e005a76f711cb8c2391e4c4ce557ec57ccc99a6d434da2,
  "PUT /system/errors/groups/:id": adminRequestSchema_fcd5d2d6dbb076235cbdb3fcca74c7ea181c50fbd041eb7215073ffe1c2fa31c,
  "PUT /system/jobs/by-id/:id/progress": adminRequestSchema_9c08fdcb554fa18dd43d04b97aebbe3388432071b4ef549e5cd11c4bece444f3,
  "PUT /system/jobs/queues/:name": adminRequestSchema_fe29e29b8964bdb98923749593fe62718aad2f835251c11be46e077c2bbedbb7,
  "PUT /system/settings/configs/:id": adminRequestSchema_e7640be5331f068f4e0aa873385c308fa1d16f4837b06af688bf7575aa621d7e,
  "PUT /system/settings/feature-toggles/:id": adminRequestSchema_efe3c81306449594bccc769b3b95fa947e3bfa3357a7ea2b7602ce001c8f7e88,
  "PUT /system/settings/maintenance/:id": adminRequestSchema_16b53b034219e0353e5094b14836c149b53c0cbdd9c7b0e0eb2dec5aee01ac71,
  "PUT /system/settings/provisioning-config": adminRequestSchema_d08450b2c55e546ff1b160ae1f4bcc49e4e090c5c9fef62084f15505263bf782,
  "PUT /users/:id": adminRequestSchema_84bf54901b7e34dfed4771c6cf3f05bdb88d6f72461c7fc08bad5c7dd1e15034,
});

export const ADMIN_SERVER_ROUTE_AUTHORIZATION: AdminServerRouteAuthorizationCatalogV1 =
  Object.freeze({
  "DELETE /admin/tenants/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /admin/tenants/:id/notes/:noteId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /billing/custom-plans/:planId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /database/explorer/schemas/:schema/tables/:table/rows/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /database/schemas/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /debug/cache/:key": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /messaging/compliance/legal-holds/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /modules/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /modules/assignments/:tenantId/:moduleId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /reports/definitions/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /settings/email-templates/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /settings/ip-access/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /settings/ip-access/type/:ruleType/clear": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /support/announcements/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /system/errors/alert-rules/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /system/settings/feature-toggles/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "DELETE /users/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/:id/activities": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/:id/detail": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/:id/notes": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/:id/usage": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/approaching-limits": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/expiring-trials": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/lookup/slug/:slug": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/search": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /admin/tenants/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/dashboard": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/financial": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/financial/by-plan": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/financial/revenue": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/kpi-comparisons": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/revenue": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/revenue/by-plan": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/revenue/trend": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/snapshots": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/system": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/system/api-calls": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/system/errors": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/tenants": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/tenants/churn": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/tenants/growth": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/usage": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/usage/features": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/usage/modules": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/users": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/users/activity": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /analytics/users/heatmap": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /audit-logs": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /audit-logs/entity/:entityType/:entityId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /audit-logs/security": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /audit-logs/statistics": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /audit-logs/user/:userId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/custom-plans": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/custom-plans/:planId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/custom-plans/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/discounts": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/discounts/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/discounts/:id/redemptions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/discounts/lookup/code/:code": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/discounts/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/invoices": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/invoices/:invoiceId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/invoices/overdue": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/invoices/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/invoices/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/module-pricing": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/module-pricing/:moduleId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/module-pricing/:moduleId/history": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/module-pricing/lookup/code/:moduleCode": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/module-pricing/with-modules": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/payments": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/plans": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/plans/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/plans/code/:code": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/plans/defaults/:tier": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/plans/public": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/plans/tier/:tier": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/subscriptions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/subscriptions/reminders": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/subscriptions/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/subscriptions/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/tenant/:tenantId/redemptions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/usage/summary": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/usage/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/usage/tenants": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/usage/top-tenants": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /billing/usage/trends": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/explorer/schemas": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/explorer/schemas/:schema/tables": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/explorer/schemas/:schema/tables/:table/data": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/explorer/schemas/:schema/tables/:table/export": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/explorer/schemas/:schema/tables/:table/structure": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/explorer/tables": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/explorer/tables/:table/data": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/migrations/available": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/migrations/batch/:version/status": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/migrations/history": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/migrations/summary": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/migrations/tenant/:tenantId/history": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/migrations/tenant/:tenantId/pending": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/connections": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/connections/by-tenant": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/health": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/index-recommendations": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/metrics": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/query-performance": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/slow-queries": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/storage": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/monitoring/storage/by-tenant": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/schemas": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/schemas/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/schemas/:tenantId/info": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/schemas/:tenantId/validate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/schemas/connections/by-tenant": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/schemas/connections/pool": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /database/schemas/summary": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/api-calls": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/api-calls/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/api-calls/summary": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/cache": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/cache/:key": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/cache/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/dashboard": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/feature-overrides": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/feature-overrides/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/feature-overrides/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/feature-overrides/tenant/:tenantId/active": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/feature-overrides/value": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/queries": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/queries/:id/explain": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/queries/slow-analysis": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/sessions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/sessions/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /debug/sessions/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /health": adminRouteAuthorization_30bfffb7cd8536dbfbd488375317b936aeebd8d23da041bb79ffde4eed44e7a0,
  "GET /health/circuit-breakers": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /health/live": adminRouteAuthorization_30bfffb7cd8536dbfbd488375317b936aeebd8d23da041bb79ffde4eed44e7a0,
  "GET /health/metrics": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /health/ready": adminRouteAuthorization_30bfffb7cd8536dbfbd488375317b936aeebd8d23da041bb79ffde4eed44e7a0,
  "GET /health/startup": adminRouteAuthorization_30bfffb7cd8536dbfbd488375317b936aeebd8d23da041bb79ffde4eed44e7a0,
  "GET /impersonation/audit/summary": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/permissions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/permissions/:superAdminId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/permissions/:superAdminId/check/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/sessions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/sessions/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/sessions/active": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/sessions/active/count": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /impersonation/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /messaging/audit": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /messaging/compliance/legal-holds": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /messaging/compliance/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /messaging/monitoring/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /messaging/personas": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /messaging/retention/policies": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /messaging/tenants": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /modules": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /modules/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /modules/:id/tenants": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /modules/assignments": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /modules/lookup/code/:code": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /modules/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /reports/capabilities": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /reports/definitions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /reports/definitions/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /reports/executions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /reports/executions/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /reports/executions/:id/download": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/checks/:framework": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/data-inventory": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/data-requests": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/data-requests/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/data-requests/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/data-requests/status/overdue": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/reports": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/reports/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/compliance/requirements/:framework": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/alerts/realtime": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/config/anomaly-detection": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/dashboard": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/events": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/events/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/events/stats/summary": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/health-score": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/incidents": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/incidents/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/incidents/stats/summary": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/threat-intelligence": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/threat-intelligence/check/:ip": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /security/monitoring/threat-intelligence/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/category/:category": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/config/billing": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/config/email": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/config/maintenance": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/config/rate-limits": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/config/security": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/email-templates": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/email-templates/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/email-templates/by-id/:id/preview": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/email-templates/categories": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/email-templates/category/:category": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/email-templates/code/:code": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/export": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/features/:featureKey": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/ip-access": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/ip-access/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/ip-access/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/ip-access/type/:ruleType": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/key/:key": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /settings/system/info": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/announcements": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/announcements/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/announcements/:id/acknowledgments": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/announcements/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/announcements/tenant/:tenantId/active": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/announcements/tenant/:tenantId/pending": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/messages/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/messages/tenants/:tenantId/threads": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/messages/threads": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/messages/threads/:threadId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/messages/threads/:threadId/messages": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/messages/unread-count": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/onboarding": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/onboarding/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/onboarding/needs-attention": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/onboarding/resources/all": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/onboarding/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/onboarding/steps": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/assigned/:userId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/by-id/:id/comments": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/number/:ticketNumber": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/sla-risk": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/stats/by-category": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/stats/by-priority": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/team": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /support/tickets/unassigned": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/alert-rules": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/dashboard": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/groups": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/groups/:groupId/occurrences": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/groups/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/occurrences": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/occurrences/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/errors/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/jobs": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/jobs/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/jobs/by-id/:id/logs": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/jobs/dashboard": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/jobs/queues": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/jobs/queues/:name": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/jobs/queues/:name/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/metrics": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/metrics/database": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/metrics/platform": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/metrics/resources": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/metrics/trends": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/alerts": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/application": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/application/apdex": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/dashboard": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/database": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/database/slow-queries": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/history": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/infrastructure": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/services": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/snapshots": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/performance/thresholds": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/services/health": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/configs": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/configs/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/feature-toggles": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/feature-toggles/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/maintenance": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/maintenance/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/maintenance/check": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/provisioning-config": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/status": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/versions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /system/settings/versions/current": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /tenants/provisioning/:operationId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/:id/activity": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/:id/sessions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/lookup/tenant/:tenantId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/recent-activity": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/roles/:roleCode/permissions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/roles/can-assign": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/roles/hierarchy": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/roles/lookup/:roleCode/assignable": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/roles/permissions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/roles/permissions/grouped": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/roles/templates": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "GET /users/tenant/:tenantId/limit": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /admin/tenants/:id/activate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /admin/tenants/:id/deactivate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /admin/tenants/:id/notes/:noteId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /admin/tenants/:id/suspend": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /modules/:id/activate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /modules/:id/deactivate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /users/:id/activate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /users/:id/deactivate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /users/:id/force-logout": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PATCH /users/:id/reset-password": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /admin/tenants/:id/erasure": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /admin/tenants/:id/notes": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /admin/tenants/:id/reconcile-subscription": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /admin/tenants/bulk/activate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /admin/tenants/bulk/suspend": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /audit-logs/export": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /auth/forgot-password": adminRouteAuthorization_30bfffb7cd8536dbfbd488375317b936aeebd8d23da041bb79ffde4eed44e7a0,
  "POST /auth/reset-password": adminRouteAuthorization_30bfffb7cd8536dbfbd488375317b936aeebd8d23da041bb79ffde4eed44e7a0,
  "POST /billing/custom-plans": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/custom-plans/:planId/activate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/custom-plans/:planId/approve": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/custom-plans/:planId/clone": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/custom-plans/:planId/reject": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/custom-plans/:planId/submit": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/discounts": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/discounts/:id/deactivate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/discounts/apply": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/discounts/bulk-create": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/discounts/generate-code": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/discounts/validate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/invoices": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/invoices/:invoiceId/mark-paid": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/invoices/:invoiceId/void": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/invoices/update-overdue": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/module-pricing": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/module-pricing/:pricingId/deactivate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/module-pricing/seed": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/payments": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/payments/refund": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/plans": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/plans/:id/deprecate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/plans/compare": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/plans/seed": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/pricing/calculate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/pricing/compare": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/pricing/quick-estimate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/subscriptions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/subscriptions/change-plan": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/subscriptions/process-renewals": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/subscriptions/tenant/:tenantId/cancel": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/subscriptions/tenant/:tenantId/extend-trial": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /billing/subscriptions/tenant/:tenantId/reactivate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/explorer/query": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/explorer/schemas/:schema/tables/:table/rows": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/migrations/batch/run": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/migrations/tenant/:tenantId/rollback": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/migrations/tenant/:tenantId/run": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/monitoring/analyze-query": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/schemas": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/schemas/:tenantId/activate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/schemas/:tenantId/refresh-stats": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/schemas/:tenantId/suspend": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/schemas/backfill-tracking": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /database/schemas/sync": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /debug/api-calls/capture": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /debug/cache/invalidate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /debug/feature-overrides": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /debug/feature-overrides/:id/revert": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /debug/queries/capture": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /debug/sessions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /debug/sessions/:id/end": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /health/circuit-breakers/:name/reset": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/permissions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/permissions/:superAdminId/revoke": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/sessions/:id/end": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/sessions/:id/extend": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/sessions/:id/terminate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/sessions/authorization-context": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/sessions/authorization-receipts": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /impersonation/sessions/start": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /messaging/compliance/legal-holds": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /messaging/tenants/:id/export": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /modules": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /modules/assignments": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /reports/definitions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /reports/executions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/compliance/data-requests": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/compliance/data-requests/:id/complete": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/compliance/data-requests/:id/download": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/compliance/data-requests/:id/verify": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/compliance/reports": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/monitoring/analyze/login": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/monitoring/events": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /security/monitoring/threat-intelligence": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/config/email/test": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/email-templates": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/email-templates/:id/test": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/email-templates/code/:code/override": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/email-templates/render": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/email-templates/validate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/import": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/ip-access": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/ip-access/blacklist/bulk": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/ip-access/check": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/ip-access/cleanup": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/ip-access/whitelist/bulk": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /settings/key/:key/reset": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/announcements": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/announcements/:id/acknowledge": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/announcements/:id/cancel": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/announcements/:id/publish": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/announcements/:id/view": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/messages/bulk": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/messages/threads": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/messages/threads/:threadId/archive": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/messages/threads/:threadId/close": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/messages/threads/:threadId/messages": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/messages/threads/:threadId/read": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/messages/threads/:threadId/reopen": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/assign-guide": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/getting-started/view": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/skip": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/step/:stepId/complete": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/step/:stepId/skip": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/training": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/tutorials/:tutorialId/view": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/:tenantId/welcome-email": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/onboarding/initialize": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/tickets": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/tickets/:id/assign": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/tickets/:id/priority": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/tickets/:id/satisfaction": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/tickets/:id/status": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /support/tickets/by-id/:id/comments": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/errors/alert-rules": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/errors/groups/:id/acknowledge": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/errors/groups/:id/assign": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/errors/groups/:id/ignore": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/errors/groups/:id/resolve": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/errors/groups/merge": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/errors/report": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/:id/cancel": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/:id/pause": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/:id/resume": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/:id/retry": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/purge-completed": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/queues": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/queues/:name/pause": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/queues/:name/resume": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/recurring": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/retry-failed": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/jobs/schedule": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/performance/metrics": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/performance/metrics/flush": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/performance/metrics/request": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/performance/thresholds": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/configs": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/configs/bulk-update": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/feature-toggles": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/feature-toggles/evaluate": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/feature-toggles/refresh-cache": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/maintenance": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/maintenance/:id/cancel": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/maintenance/:id/end": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/maintenance/:id/extend": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/maintenance/:id/start": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/versions": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/versions/:id/deploy": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /system/settings/versions/:id/rollback": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /tenants": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /tenants/provisioning/:operationId/retry": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /users": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "POST /users/invite": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /admin/tenants/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /billing/custom-plans/:planId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /billing/discounts/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /billing/module-pricing/:pricingId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /billing/plans/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /database/explorer/schemas/:schema/tables/:table/rows/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /messaging/retention/policies/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /modules/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /reports/definitions/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /security/compliance/data-requests/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /security/monitoring/events/:id/status": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /security/monitoring/incidents/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/bulk": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/config/billing": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/config/email": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/config/maintenance": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/config/rate-limits": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/config/security": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/email-templates/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/ip-access/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /settings/key/:key": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /support/announcements/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /support/onboarding/:tenantId/training/:sessionId": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /support/tickets/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/errors/alert-rules/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/errors/groups/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/jobs/by-id/:id/progress": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/jobs/queues/:name": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/settings/configs/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/settings/feature-toggles/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/settings/maintenance/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /system/settings/provisioning-config": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  "PUT /users/:id": adminRouteAuthorization_de2a1d116ba7de9e0bd8ef1f5a0d09760487df709ff23beedad7b29a36214e76,
  });

export const ADMIN_SERVER_ROUTE_LIFECYCLE = Object.freeze({
  "DELETE /admin/tenants/:id": "ACTIVE",
  "DELETE /admin/tenants/:id/notes/:noteId": "ACTIVE",
  "DELETE /billing/custom-plans/:planId": "ACTIVE",
  "DELETE /database/explorer/schemas/:schema/tables/:table/rows/:id": "ACTIVE",
  "DELETE /database/schemas/:tenantId": "ACTIVE",
  "DELETE /debug/cache/:key": "ACTIVE",
  "DELETE /messaging/compliance/legal-holds/:id": "ACTIVE",
  "DELETE /modules/:id": "ACTIVE",
  "DELETE /modules/assignments/:tenantId/:moduleId": "ACTIVE",
  "DELETE /reports/definitions/:id": "ACTIVE",
  "DELETE /settings/email-templates/:id": "ACTIVE",
  "DELETE /settings/ip-access/:id": "ACTIVE",
  "DELETE /settings/ip-access/type/:ruleType/clear": "ACTIVE",
  "DELETE /support/announcements/:id": "ACTIVE",
  "DELETE /system/errors/alert-rules/:id": "ACTIVE",
  "DELETE /system/settings/feature-toggles/:id": "ACTIVE",
  "DELETE /users/:id": "ACTIVE",
  "GET /admin/tenants": "ACTIVE",
  "GET /admin/tenants/:id": "ACTIVE",
  "GET /admin/tenants/:id/activities": "ACTIVE",
  "GET /admin/tenants/:id/detail": "ACTIVE",
  "GET /admin/tenants/:id/notes": "ACTIVE",
  "GET /admin/tenants/:id/usage": "ACTIVE",
  "GET /admin/tenants/approaching-limits": "ACTIVE",
  "GET /admin/tenants/expiring-trials": "ACTIVE",
  "GET /admin/tenants/lookup/slug/:slug": "ACTIVE",
  "GET /admin/tenants/search": "ACTIVE",
  "GET /admin/tenants/stats": "ACTIVE",
  "GET /analytics/dashboard": "ACTIVE",
  "GET /analytics/financial": "ACTIVE",
  "GET /analytics/financial/by-plan": "ACTIVE",
  "GET /analytics/financial/revenue": "ACTIVE",
  "GET /analytics/kpi-comparisons": "ACTIVE",
  "GET /analytics/revenue": "ACTIVE",
  "GET /analytics/revenue/by-plan": "ACTIVE",
  "GET /analytics/revenue/trend": "ACTIVE",
  "GET /analytics/snapshots": "ACTIVE",
  "GET /analytics/system": "ACTIVE",
  "GET /analytics/system/api-calls": "ACTIVE",
  "GET /analytics/system/errors": "ACTIVE",
  "GET /analytics/tenants": "ACTIVE",
  "GET /analytics/tenants/churn": "ACTIVE",
  "GET /analytics/tenants/growth": "ACTIVE",
  "GET /analytics/usage": "ACTIVE",
  "GET /analytics/usage/features": "ACTIVE",
  "GET /analytics/usage/modules": "ACTIVE",
  "GET /analytics/users": "ACTIVE",
  "GET /analytics/users/activity": "ACTIVE",
  "GET /analytics/users/heatmap": "ACTIVE",
  "GET /audit-logs": "ACTIVE",
  "GET /audit-logs/entity/:entityType/:entityId": "ACTIVE",
  "GET /audit-logs/security": "ACTIVE",
  "GET /audit-logs/statistics": "ACTIVE",
  "GET /audit-logs/user/:userId": "ACTIVE",
  "GET /billing/custom-plans": "ACTIVE",
  "GET /billing/custom-plans/:planId": "ACTIVE",
  "GET /billing/custom-plans/tenant/:tenantId": "ACTIVE",
  "GET /billing/discounts": "ACTIVE",
  "GET /billing/discounts/:id": "ACTIVE",
  "GET /billing/discounts/:id/redemptions": "ACTIVE",
  "GET /billing/discounts/lookup/code/:code": "ACTIVE",
  "GET /billing/discounts/stats": "ACTIVE",
  "GET /billing/invoices": "ACTIVE",
  "GET /billing/invoices/:invoiceId": "ACTIVE",
  "GET /billing/invoices/overdue": "ACTIVE",
  "GET /billing/invoices/stats": "ACTIVE",
  "GET /billing/invoices/tenant/:tenantId": "ACTIVE",
  "GET /billing/module-pricing": "ACTIVE",
  "GET /billing/module-pricing/:moduleId": "ACTIVE",
  "GET /billing/module-pricing/:moduleId/history": "ACTIVE",
  "GET /billing/module-pricing/lookup/code/:moduleCode": "ACTIVE",
  "GET /billing/module-pricing/with-modules": "ACTIVE",
  "GET /billing/payments": "ACTIVE",
  "GET /billing/plans": "ACTIVE",
  "GET /billing/plans/:id": "ACTIVE",
  "GET /billing/plans/code/:code": "ACTIVE",
  "GET /billing/plans/defaults/:tier": "ACTIVE",
  "GET /billing/plans/public": "ACTIVE",
  "GET /billing/plans/tier/:tier": "ACTIVE",
  "GET /billing/subscriptions": "ACTIVE",
  "GET /billing/subscriptions/reminders": "ACTIVE",
  "GET /billing/subscriptions/stats": "ACTIVE",
  "GET /billing/subscriptions/tenant/:tenantId": "ACTIVE",
  "GET /billing/tenant/:tenantId/redemptions": "ACTIVE",
  "GET /billing/usage/summary": "ACTIVE",
  "GET /billing/usage/tenant/:tenantId": "ACTIVE",
  "GET /billing/usage/tenants": "ACTIVE",
  "GET /billing/usage/top-tenants": "ACTIVE",
  "GET /billing/usage/trends": "ACTIVE",
  "GET /database/explorer/schemas": "ACTIVE",
  "GET /database/explorer/schemas/:schema/tables": "ACTIVE",
  "GET /database/explorer/schemas/:schema/tables/:table/data": "ACTIVE",
  "GET /database/explorer/schemas/:schema/tables/:table/export": "ACTIVE",
  "GET /database/explorer/schemas/:schema/tables/:table/structure": "ACTIVE",
  "GET /database/explorer/tables": "ACTIVE",
  "GET /database/explorer/tables/:table/data": "ACTIVE",
  "GET /database/migrations/available": "ACTIVE",
  "GET /database/migrations/batch/:version/status": "ACTIVE",
  "GET /database/migrations/history": "ACTIVE",
  "GET /database/migrations/summary": "ACTIVE",
  "GET /database/migrations/tenant/:tenantId/history": "ACTIVE",
  "GET /database/migrations/tenant/:tenantId/pending": "ACTIVE",
  "GET /database/monitoring/connections": "ACTIVE",
  "GET /database/monitoring/connections/by-tenant": "ACTIVE",
  "GET /database/monitoring/health": "ACTIVE",
  "GET /database/monitoring/index-recommendations": "ACTIVE",
  "GET /database/monitoring/metrics": "ACTIVE",
  "GET /database/monitoring/query-performance": "ACTIVE",
  "GET /database/monitoring/slow-queries": "ACTIVE",
  "GET /database/monitoring/storage": "ACTIVE",
  "GET /database/monitoring/storage/by-tenant": "ACTIVE",
  "GET /database/schemas": "ACTIVE",
  "GET /database/schemas/:tenantId": "ACTIVE",
  "GET /database/schemas/:tenantId/info": "ACTIVE",
  "GET /database/schemas/:tenantId/validate": "ACTIVE",
  "GET /database/schemas/connections/by-tenant": "ACTIVE",
  "GET /database/schemas/connections/pool": "ACTIVE",
  "GET /database/schemas/summary": "ACTIVE",
  "GET /debug/api-calls": "ACTIVE",
  "GET /debug/api-calls/:id": "ACTIVE",
  "GET /debug/api-calls/summary": "ACTIVE",
  "GET /debug/cache": "ACTIVE",
  "GET /debug/cache/:key": "ACTIVE",
  "GET /debug/cache/stats": "ACTIVE",
  "GET /debug/dashboard": "ACTIVE",
  "GET /debug/feature-overrides": "ACTIVE",
  "GET /debug/feature-overrides/:id": "ACTIVE",
  "GET /debug/feature-overrides/tenant/:tenantId": "ACTIVE",
  "GET /debug/feature-overrides/tenant/:tenantId/active": "ACTIVE",
  "GET /debug/feature-overrides/value": "ACTIVE",
  "GET /debug/queries": "ACTIVE",
  "GET /debug/queries/:id/explain": "ACTIVE",
  "GET /debug/queries/slow-analysis": "ACTIVE",
  "GET /debug/sessions": "ACTIVE",
  "GET /debug/sessions/:id": "ACTIVE",
  "GET /debug/sessions/tenant/:tenantId": "ACTIVE",
  "GET /health": "ACTIVE",
  "GET /health/circuit-breakers": "ACTIVE",
  "GET /health/live": "ACTIVE",
  "GET /health/metrics": "ACTIVE",
  "GET /health/ready": "ACTIVE",
  "GET /health/startup": "ACTIVE",
  "GET /impersonation/audit/summary": "ACTIVE",
  "GET /impersonation/permissions": "ACTIVE",
  "GET /impersonation/permissions/:superAdminId": "ACTIVE",
  "GET /impersonation/permissions/:superAdminId/check/:tenantId": "ACTIVE",
  "GET /impersonation/sessions": "ACTIVE",
  "GET /impersonation/sessions/:id": "ACTIVE",
  "GET /impersonation/sessions/active": "ACTIVE",
  "GET /impersonation/sessions/active/count": "ACTIVE",
  "GET /impersonation/stats": "ACTIVE",
  "GET /messaging/audit": "ACTIVE",
  "GET /messaging/compliance/legal-holds": "ACTIVE",
  "GET /messaging/compliance/stats": "ACTIVE",
  "GET /messaging/monitoring/stats": "ACTIVE",
  "GET /messaging/personas": "ACTIVE",
  "GET /messaging/retention/policies": "ACTIVE",
  "GET /messaging/tenants": "ACTIVE",
  "GET /modules": "ACTIVE",
  "GET /modules/:id": "ACTIVE",
  "GET /modules/:id/tenants": "ACTIVE",
  "GET /modules/assignments": "ACTIVE",
  "GET /modules/lookup/code/:code": "ACTIVE",
  "GET /modules/stats": "ACTIVE",
  "GET /reports/capabilities": "ACTIVE",
  "GET /reports/definitions": "ACTIVE",
  "GET /reports/definitions/:id": "ACTIVE",
  "GET /reports/executions": "ACTIVE",
  "GET /reports/executions/:id": "ACTIVE",
  "GET /reports/executions/:id/download": "ACTIVE",
  "GET /security/compliance/checks/:framework": "ACTIVE",
  "GET /security/compliance/data-inventory": "ACTIVE",
  "GET /security/compliance/data-requests": "ACTIVE",
  "GET /security/compliance/data-requests/:id": "ACTIVE",
  "GET /security/compliance/data-requests/stats": "ACTIVE",
  "GET /security/compliance/data-requests/status/overdue": "ACTIVE",
  "GET /security/compliance/reports": "ACTIVE",
  "GET /security/compliance/reports/:id": "ACTIVE",
  "GET /security/compliance/requirements/:framework": "ACTIVE",
  "GET /security/monitoring/alerts/realtime": "ACTIVE",
  "GET /security/monitoring/config/anomaly-detection": "ACTIVE",
  "GET /security/monitoring/dashboard": "ACTIVE",
  "GET /security/monitoring/events": "ACTIVE",
  "GET /security/monitoring/events/:id": "ACTIVE",
  "GET /security/monitoring/events/stats/summary": "ACTIVE",
  "GET /security/monitoring/health-score": "ACTIVE",
  "GET /security/monitoring/incidents": "ACTIVE",
  "GET /security/monitoring/incidents/:id": "ACTIVE",
  "GET /security/monitoring/incidents/stats/summary": "ACTIVE",
  "GET /security/monitoring/threat-intelligence": "ACTIVE",
  "GET /security/monitoring/threat-intelligence/check/:ip": "ACTIVE",
  "GET /security/monitoring/threat-intelligence/stats": "ACTIVE",
  "GET /settings": "ACTIVE",
  "GET /settings/category/:category": "ACTIVE",
  "GET /settings/config/billing": "ACTIVE",
  "GET /settings/config/email": "ACTIVE",
  "GET /settings/config/maintenance": "ACTIVE",
  "GET /settings/config/rate-limits": "ACTIVE",
  "GET /settings/config/security": "ACTIVE",
  "GET /settings/email-templates": "ACTIVE",
  "GET /settings/email-templates/:id": "ACTIVE",
  "GET /settings/email-templates/by-id/:id/preview": "ACTIVE",
  "GET /settings/email-templates/categories": "ACTIVE",
  "GET /settings/email-templates/category/:category": "ACTIVE",
  "GET /settings/email-templates/code/:code": "ACTIVE",
  "GET /settings/export": "ACTIVE",
  "GET /settings/features/:featureKey": "ACTIVE",
  "GET /settings/ip-access": "ACTIVE",
  "GET /settings/ip-access/:id": "ACTIVE",
  "GET /settings/ip-access/stats": "ACTIVE",
  "GET /settings/ip-access/type/:ruleType": "ACTIVE",
  "GET /settings/key/:key": "ACTIVE",
  "GET /settings/system/info": "ACTIVE",
  "GET /support/announcements": "ACTIVE",
  "GET /support/announcements/:id": "ACTIVE",
  "GET /support/announcements/:id/acknowledgments": "ACTIVE",
  "GET /support/announcements/stats": "ACTIVE",
  "GET /support/announcements/tenant/:tenantId/active": "ACTIVE",
  "GET /support/announcements/tenant/:tenantId/pending": "ACTIVE",
  "GET /support/messages/stats": "ACTIVE",
  "GET /support/messages/tenants/:tenantId/threads": "ACTIVE",
  "GET /support/messages/threads": "ACTIVE",
  "GET /support/messages/threads/:threadId": "ACTIVE",
  "GET /support/messages/threads/:threadId/messages": "ACTIVE",
  "GET /support/messages/unread-count": "ACTIVE",
  "GET /support/onboarding": "ACTIVE",
  "GET /support/onboarding/:tenantId": "ACTIVE",
  "GET /support/onboarding/needs-attention": "ACTIVE",
  "GET /support/onboarding/resources/all": "ACTIVE",
  "GET /support/onboarding/stats": "ACTIVE",
  "GET /support/onboarding/steps": "ACTIVE",
  "GET /support/tickets": "ACTIVE",
  "GET /support/tickets/:id": "ACTIVE",
  "GET /support/tickets/assigned/:userId": "ACTIVE",
  "GET /support/tickets/by-id/:id/comments": "ACTIVE",
  "GET /support/tickets/number/:ticketNumber": "ACTIVE",
  "GET /support/tickets/sla-risk": "ACTIVE",
  "GET /support/tickets/stats": "ACTIVE",
  "GET /support/tickets/stats/by-category": "ACTIVE",
  "GET /support/tickets/stats/by-priority": "ACTIVE",
  "GET /support/tickets/team": "ACTIVE",
  "GET /support/tickets/tenant/:tenantId": "ACTIVE",
  "GET /support/tickets/unassigned": "ACTIVE",
  "GET /system/errors/alert-rules": "ACTIVE",
  "GET /system/errors/dashboard": "ACTIVE",
  "GET /system/errors/groups": "ACTIVE",
  "GET /system/errors/groups/:groupId/occurrences": "ACTIVE",
  "GET /system/errors/groups/:id": "ACTIVE",
  "GET /system/errors/occurrences": "ACTIVE",
  "GET /system/errors/occurrences/:id": "ACTIVE",
  "GET /system/errors/stats": "ACTIVE",
  "GET /system/jobs": "ACTIVE",
  "GET /system/jobs/:id": "ACTIVE",
  "GET /system/jobs/by-id/:id/logs": "ACTIVE",
  "GET /system/jobs/dashboard": "ACTIVE",
  "GET /system/jobs/queues": "ACTIVE",
  "GET /system/jobs/queues/:name": "ACTIVE",
  "GET /system/jobs/queues/:name/stats": "ACTIVE",
  "GET /system/metrics": "ACTIVE",
  "GET /system/metrics/database": "ACTIVE",
  "GET /system/metrics/platform": "ACTIVE",
  "GET /system/metrics/resources": "ACTIVE",
  "GET /system/metrics/trends": "ACTIVE",
  "GET /system/performance/alerts": "ACTIVE",
  "GET /system/performance/application": "ACTIVE",
  "GET /system/performance/application/apdex": "ACTIVE",
  "GET /system/performance/dashboard": "ACTIVE",
  "GET /system/performance/database": "ACTIVE",
  "GET /system/performance/database/slow-queries": "ACTIVE",
  "GET /system/performance/history": "ACTIVE",
  "GET /system/performance/infrastructure": "ACTIVE",
  "GET /system/performance/services": "ACTIVE",
  "GET /system/performance/snapshots": "ACTIVE",
  "GET /system/performance/thresholds": "ACTIVE",
  "GET /system/services/health": "ACTIVE",
  "GET /system/settings/configs": "ACTIVE",
  "GET /system/settings/configs/:id": "ACTIVE",
  "GET /system/settings/feature-toggles": "ACTIVE",
  "GET /system/settings/feature-toggles/:id": "ACTIVE",
  "GET /system/settings/maintenance": "ACTIVE",
  "GET /system/settings/maintenance/:id": "ACTIVE",
  "GET /system/settings/maintenance/check": "ACTIVE",
  "GET /system/settings/provisioning-config": "ACTIVE",
  "GET /system/settings/status": "ACTIVE",
  "GET /system/settings/versions": "ACTIVE",
  "GET /system/settings/versions/current": "ACTIVE",
  "GET /tenants/provisioning/:operationId": "ACTIVE",
  "GET /users": "ACTIVE",
  "GET /users/:id": "ACTIVE",
  "GET /users/:id/activity": "ACTIVE",
  "GET /users/:id/sessions": "ACTIVE",
  "GET /users/lookup/tenant/:tenantId": "ACTIVE",
  "GET /users/recent-activity": "ACTIVE",
  "GET /users/roles/:roleCode/permissions": "ACTIVE",
  "GET /users/roles/can-assign": "ACTIVE",
  "GET /users/roles/hierarchy": "ACTIVE",
  "GET /users/roles/lookup/:roleCode/assignable": "ACTIVE",
  "GET /users/roles/permissions": "ACTIVE",
  "GET /users/roles/permissions/grouped": "ACTIVE",
  "GET /users/roles/templates": "ACTIVE",
  "GET /users/stats": "ACTIVE",
  "GET /users/tenant/:tenantId/limit": "ACTIVE",
  "PATCH /admin/tenants/:id/activate": "ACTIVE",
  "PATCH /admin/tenants/:id/deactivate": "ACTIVE",
  "PATCH /admin/tenants/:id/notes/:noteId": "ACTIVE",
  "PATCH /admin/tenants/:id/suspend": "ACTIVE",
  "PATCH /modules/:id/activate": "ACTIVE",
  "PATCH /modules/:id/deactivate": "ACTIVE",
  "PATCH /users/:id/activate": "ACTIVE",
  "PATCH /users/:id/deactivate": "ACTIVE",
  "PATCH /users/:id/force-logout": "ACTIVE",
  "PATCH /users/:id/reset-password": "ACTIVE",
  "POST /admin/tenants/:id/erasure": "ACTIVE",
  "POST /admin/tenants/:id/notes": "ACTIVE",
  "POST /admin/tenants/:id/reconcile-subscription": "ACTIVE",
  "POST /admin/tenants/bulk/activate": "ACTIVE",
  "POST /admin/tenants/bulk/suspend": "ACTIVE",
  "POST /audit-logs/export": "ACTIVE",
  "POST /auth/forgot-password": "ACTIVE",
  "POST /auth/reset-password": "ACTIVE",
  "POST /billing/custom-plans": "ACTIVE",
  "POST /billing/custom-plans/:planId/activate": "ACTIVE",
  "POST /billing/custom-plans/:planId/approve": "ACTIVE",
  "POST /billing/custom-plans/:planId/clone": "ACTIVE",
  "POST /billing/custom-plans/:planId/reject": "ACTIVE",
  "POST /billing/custom-plans/:planId/submit": "ACTIVE",
  "POST /billing/discounts": "ACTIVE",
  "POST /billing/discounts/:id/deactivate": "ACTIVE",
  "POST /billing/discounts/apply": "ACTIVE",
  "POST /billing/discounts/bulk-create": "ACTIVE",
  "POST /billing/discounts/generate-code": "ACTIVE",
  "POST /billing/discounts/validate": "ACTIVE",
  "POST /billing/invoices": "ACTIVE",
  "POST /billing/invoices/:invoiceId/mark-paid": "ACTIVE",
  "POST /billing/invoices/:invoiceId/void": "ACTIVE",
  "POST /billing/invoices/update-overdue": "ACTIVE",
  "POST /billing/module-pricing": "ACTIVE",
  "POST /billing/module-pricing/:pricingId/deactivate": "ACTIVE",
  "POST /billing/module-pricing/seed": "ACTIVE",
  "POST /billing/payments": "ACTIVE",
  "POST /billing/payments/refund": "ACTIVE",
  "POST /billing/plans": "ACTIVE",
  "POST /billing/plans/:id/deprecate": "ACTIVE",
  "POST /billing/plans/compare": "ACTIVE",
  "POST /billing/plans/seed": "ACTIVE",
  "POST /billing/pricing/calculate": "ACTIVE",
  "POST /billing/pricing/compare": "ACTIVE",
  "POST /billing/pricing/quick-estimate": "ACTIVE",
  "POST /billing/subscriptions": "ACTIVE",
  "POST /billing/subscriptions/change-plan": "ACTIVE",
  "POST /billing/subscriptions/process-renewals": "ACTIVE",
  "POST /billing/subscriptions/tenant/:tenantId/cancel": "ACTIVE",
  "POST /billing/subscriptions/tenant/:tenantId/extend-trial": "ACTIVE",
  "POST /billing/subscriptions/tenant/:tenantId/reactivate": "ACTIVE",
  "POST /database/explorer/query": "ACTIVE",
  "POST /database/explorer/schemas/:schema/tables/:table/rows": "ACTIVE",
  "POST /database/migrations/batch/run": "ACTIVE",
  "POST /database/migrations/tenant/:tenantId/rollback": "ACTIVE",
  "POST /database/migrations/tenant/:tenantId/run": "ACTIVE",
  "POST /database/monitoring/analyze-query": "ACTIVE",
  "POST /database/schemas": "ACTIVE",
  "POST /database/schemas/:tenantId/activate": "ACTIVE",
  "POST /database/schemas/:tenantId/refresh-stats": "ACTIVE",
  "POST /database/schemas/:tenantId/suspend": "ACTIVE",
  "POST /database/schemas/backfill-tracking": "ACTIVE",
  "POST /database/schemas/sync": "ACTIVE",
  "POST /debug/api-calls/capture": "ACTIVE",
  "POST /debug/cache/invalidate": "ACTIVE",
  "POST /debug/feature-overrides": "ACTIVE",
  "POST /debug/feature-overrides/:id/revert": "ACTIVE",
  "POST /debug/queries/capture": "ACTIVE",
  "POST /debug/sessions": "ACTIVE",
  "POST /debug/sessions/:id/end": "ACTIVE",
  "POST /health/circuit-breakers/:name/reset": "ACTIVE",
  "POST /impersonation/permissions": "ACTIVE",
  "POST /impersonation/permissions/:superAdminId/revoke": "ACTIVE",
  "POST /impersonation/sessions/:id/end": "ACTIVE",
  "POST /impersonation/sessions/:id/extend": "ACTIVE",
  "POST /impersonation/sessions/:id/terminate": "ACTIVE",
  "POST /impersonation/sessions/authorization-context": "INTERNAL_GATEWAY_ONLY",
  "POST /impersonation/sessions/authorization-receipts": "INTERNAL_GATEWAY_ONLY",
  "POST /impersonation/sessions/start": "ACTIVE",
  "POST /messaging/compliance/legal-holds": "ACTIVE",
  "POST /messaging/tenants/:id/export": "ACTIVE",
  "POST /modules": "ACTIVE",
  "POST /modules/assignments": "ACTIVE",
  "POST /reports/definitions": "ACTIVE",
  "POST /reports/executions": "ACTIVE",
  "POST /security/compliance/data-requests": "ACTIVE",
  "POST /security/compliance/data-requests/:id/complete": "ACTIVE",
  "POST /security/compliance/data-requests/:id/download": "ACTIVE",
  "POST /security/compliance/data-requests/:id/verify": "ACTIVE",
  "POST /security/compliance/reports": "ACTIVE",
  "POST /security/monitoring/analyze/login": "ACTIVE",
  "POST /security/monitoring/events": "ACTIVE",
  "POST /security/monitoring/threat-intelligence": "ACTIVE",
  "POST /settings/config/email/test": "ACTIVE",
  "POST /settings/email-templates": "ACTIVE",
  "POST /settings/email-templates/:id/test": "ACTIVE",
  "POST /settings/email-templates/code/:code/override": "ACTIVE",
  "POST /settings/email-templates/render": "ACTIVE",
  "POST /settings/email-templates/validate": "ACTIVE",
  "POST /settings/import": "ACTIVE",
  "POST /settings/ip-access": "ACTIVE",
  "POST /settings/ip-access/blacklist/bulk": "ACTIVE",
  "POST /settings/ip-access/check": "ACTIVE",
  "POST /settings/ip-access/cleanup": "ACTIVE",
  "POST /settings/ip-access/whitelist/bulk": "ACTIVE",
  "POST /settings/key/:key/reset": "ACTIVE",
  "POST /support/announcements": "ACTIVE",
  "POST /support/announcements/:id/acknowledge": "ACTIVE",
  "POST /support/announcements/:id/cancel": "ACTIVE",
  "POST /support/announcements/:id/publish": "ACTIVE",
  "POST /support/announcements/:id/view": "ACTIVE",
  "POST /support/messages/bulk": "ACTIVE",
  "POST /support/messages/threads": "ACTIVE",
  "POST /support/messages/threads/:threadId/archive": "ACTIVE",
  "POST /support/messages/threads/:threadId/close": "ACTIVE",
  "POST /support/messages/threads/:threadId/messages": "ACTIVE",
  "POST /support/messages/threads/:threadId/read": "ACTIVE",
  "POST /support/messages/threads/:threadId/reopen": "ACTIVE",
  "POST /support/onboarding/:tenantId/assign-guide": "ACTIVE",
  "POST /support/onboarding/:tenantId/getting-started/view": "ACTIVE",
  "POST /support/onboarding/:tenantId/skip": "ACTIVE",
  "POST /support/onboarding/:tenantId/step/:stepId/complete": "ACTIVE",
  "POST /support/onboarding/:tenantId/step/:stepId/skip": "ACTIVE",
  "POST /support/onboarding/:tenantId/training": "ACTIVE",
  "POST /support/onboarding/:tenantId/tutorials/:tutorialId/view": "ACTIVE",
  "POST /support/onboarding/:tenantId/welcome-email": "ACTIVE",
  "POST /support/onboarding/initialize": "ACTIVE",
  "POST /support/tickets": "ACTIVE",
  "POST /support/tickets/:id/assign": "ACTIVE",
  "POST /support/tickets/:id/priority": "ACTIVE",
  "POST /support/tickets/:id/satisfaction": "ACTIVE",
  "POST /support/tickets/:id/status": "ACTIVE",
  "POST /support/tickets/by-id/:id/comments": "ACTIVE",
  "POST /system/errors/alert-rules": "ACTIVE",
  "POST /system/errors/groups/:id/acknowledge": "ACTIVE",
  "POST /system/errors/groups/:id/assign": "ACTIVE",
  "POST /system/errors/groups/:id/ignore": "ACTIVE",
  "POST /system/errors/groups/:id/resolve": "ACTIVE",
  "POST /system/errors/groups/merge": "ACTIVE",
  "POST /system/errors/report": "ACTIVE",
  "POST /system/jobs": "ACTIVE",
  "POST /system/jobs/:id/cancel": "ACTIVE",
  "POST /system/jobs/:id/pause": "ACTIVE",
  "POST /system/jobs/:id/resume": "ACTIVE",
  "POST /system/jobs/:id/retry": "ACTIVE",
  "POST /system/jobs/purge-completed": "ACTIVE",
  "POST /system/jobs/queues": "ACTIVE",
  "POST /system/jobs/queues/:name/pause": "ACTIVE",
  "POST /system/jobs/queues/:name/resume": "ACTIVE",
  "POST /system/jobs/recurring": "ACTIVE",
  "POST /system/jobs/retry-failed": "ACTIVE",
  "POST /system/jobs/schedule": "ACTIVE",
  "POST /system/performance/metrics": "ACTIVE",
  "POST /system/performance/metrics/flush": "ACTIVE",
  "POST /system/performance/metrics/request": "ACTIVE",
  "POST /system/performance/thresholds": "ACTIVE",
  "POST /system/settings/configs": "ACTIVE",
  "POST /system/settings/configs/bulk-update": "ACTIVE",
  "POST /system/settings/feature-toggles": "ACTIVE",
  "POST /system/settings/feature-toggles/evaluate": "ACTIVE",
  "POST /system/settings/feature-toggles/refresh-cache": "ACTIVE",
  "POST /system/settings/maintenance": "ACTIVE",
  "POST /system/settings/maintenance/:id/cancel": "ACTIVE",
  "POST /system/settings/maintenance/:id/end": "ACTIVE",
  "POST /system/settings/maintenance/:id/extend": "ACTIVE",
  "POST /system/settings/maintenance/:id/start": "ACTIVE",
  "POST /system/settings/versions": "ACTIVE",
  "POST /system/settings/versions/:id/deploy": "ACTIVE",
  "POST /system/settings/versions/:id/rollback": "ACTIVE",
  "POST /tenants": "ACTIVE",
  "POST /tenants/provisioning/:operationId/retry": "ACTIVE",
  "POST /users": "ACTIVE",
  "POST /users/invite": "ACTIVE",
  "PUT /admin/tenants/:id": "ACTIVE",
  "PUT /billing/custom-plans/:planId": "ACTIVE",
  "PUT /billing/discounts/:id": "ACTIVE",
  "PUT /billing/module-pricing/:pricingId": "ACTIVE",
  "PUT /billing/plans/:id": "ACTIVE",
  "PUT /database/explorer/schemas/:schema/tables/:table/rows/:id": "ACTIVE",
  "PUT /messaging/retention/policies/:id": "ACTIVE",
  "PUT /modules/:id": "ACTIVE",
  "PUT /reports/definitions/:id": "ACTIVE",
  "PUT /security/compliance/data-requests/:id": "ACTIVE",
  "PUT /security/monitoring/events/:id/status": "ACTIVE",
  "PUT /security/monitoring/incidents/:id": "ACTIVE",
  "PUT /settings/bulk": "ACTIVE",
  "PUT /settings/config/billing": "ACTIVE",
  "PUT /settings/config/email": "ACTIVE",
  "PUT /settings/config/maintenance": "ACTIVE",
  "PUT /settings/config/rate-limits": "ACTIVE",
  "PUT /settings/config/security": "ACTIVE",
  "PUT /settings/email-templates/:id": "ACTIVE",
  "PUT /settings/ip-access/:id": "ACTIVE",
  "PUT /settings/key/:key": "ACTIVE",
  "PUT /support/announcements/:id": "ACTIVE",
  "PUT /support/onboarding/:tenantId/training/:sessionId": "ACTIVE",
  "PUT /support/tickets/:id": "ACTIVE",
  "PUT /system/errors/alert-rules/:id": "ACTIVE",
  "PUT /system/errors/groups/:id": "ACTIVE",
  "PUT /system/jobs/by-id/:id/progress": "ACTIVE",
  "PUT /system/jobs/queues/:name": "ACTIVE",
  "PUT /system/settings/configs/:id": "ACTIVE",
  "PUT /system/settings/feature-toggles/:id": "ACTIVE",
  "PUT /system/settings/maintenance/:id": "ACTIVE",
  "PUT /system/settings/provisioning-config": "ACTIVE",
  "PUT /users/:id": "ACTIVE",
} as const);
