# Platform Kernel Review

**Date:** 2026-04-10
**Mode:** Static review only
**Model:** `gpt-5.4`
**Scope:**
- [command-bus.ts](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts)
- [rate-limit.config.ts](/var/aqua-saas/platform/configs/rate-limit.config.ts)

## Findings

### HIGH-001
Shared command dispatch kontrati runtime class name'e bagli; kalici bir kernel identity kontrati yok. Handler registry `Map<string, ...>` olarak tutuluyor ([command-bus.ts:14](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L14)), execution `command.constructor.name` ile lookup yapiyor ([command-bus.ts:29](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L29)), registration da isim uzerinden yapiliyor ([command-bus.ts:72](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L72), [command-bus.ts:83](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L83), [cqrs.module.ts:85](/var/aqua-saas/platform/libs/cqrs/src/cqrs.module.ts#L85)). Bu, shared-layer ownership acisindan zayif bir temel: refactor, proxying, cross-process dispatch veya explicit command envelope ihtiyacinda bus stable metadata yerine runtime isimlere bagli kaliyor; ustelik consumer tarafinda tanimli explicit command identity bile fiilen yok sayiliyor ([create-farm.command.ts:16](/var/aqua-saas/apps/farm-service/src/farm/commands/create-farm.command.ts#L16)).

### HIGH-002
CQRS kernel, tenant/correlation/actor/tracing metadata icin first-class propagation kontrati sunmuyor. `execute` yalnizca `ICommand` aliyor ve command nesnesini oldugu gibi handler'a iletiyor ([command-bus.ts:26](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L26), [command-bus.ts:47](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L47)); shared contract tarafinda `ICommand` bos ([command.interface.ts:7](/var/aqua-saas/platform/libs/cqrs/src/command/command.interface.ts#L7)) ve yalnizca tenant-odakli opsiyonel bir subtype var ([command.interface.ts:12](/var/aqua-saas/platform/libs/cqrs/src/command/command.interface.ts#L12)). Bunun pratik sonucu su: servisler tenant ve actor bilgisini command payload'ina tek tek gommek zorunda kaliyor ([farm.resolver.ts:143](/var/aqua-saas/apps/farm-service/src/farm/resolvers/farm.resolver.ts#L143), [create-farm.command.ts:21](/var/aqua-saas/apps/farm-service/src/farm/commands/create-farm.command.ts#L21), [create-farm.command.ts:22](/var/aqua-saas/apps/farm-service/src/farm/commands/create-farm.command.ts#L22)); correlation ve trace context icin ise kernel seviyesinde hicbir standart yol yok. Bu enterprise-grade shared abstraction icin ownership boslugu.

### HIGH-003
[rate-limit.config.ts](/var/aqua-saas/platform/configs/rate-limit.config.ts) bos bir placeholder; schema, validation, secure default ve fail-fast boot davranisi yok. Rate limiting security-sensitive bir shared contract olmasina ragmen platform katmani burada hicbir sey enforce etmiyor. Sonuc olarak gercek rate-limit ownership servis-lokal koda kaymis durumda; gateway kendi config'ini ve fallback davranisini tasiyor ([apps/gateway-api/src/config/rate-limit.config.ts:7](/var/aqua-saas/apps/gateway-api/src/config/rate-limit.config.ts#L7), [apps/gateway-api/src/guards/rate-limit.guard.ts:201](/var/aqua-saas/apps/gateway-api/src/guards/rate-limit.guard.ts#L201), [apps/gateway-api/src/guards/rate-limit.guard.ts:238](/var/aqua-saas/apps/gateway-api/src/guards/rate-limit.guard.ts#L238)). Bu dogrudan shared-layer ownership ve fail-fast config eksigi; platform kontrati ownerless kalmis.

### MEDIUM-004
Handler resolution module boundary'lerini gevsetiyor ve wiring hatalarini maskeleyebiliyor. Bus, handler'i `moduleRef.get(..., { strict: false })` ile cekiyor ([command-bus.ts:42](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L42)); `CqrsModule` ise discovery uzerinden tum provider graph'ini tarayip side-effect registration yapiyor ([cqrs.module.ts:68](/var/aqua-saas/platform/libs/cqrs/src/cqrs.module.ts#L68), [cqrs.module.ts:79](/var/aqua-saas/platform/libs/cqrs/src/cqrs.module.ts#L79)). Bu tasarim bugun calissa bile enterprise olcekte determinism problemleri uretir: yanlis export/provider scope hatalari local degil global davranis olarak ortaya cikar.

### LOW-005
`COMMAND_HANDLER_METADATA` import ediliyor ama `CommandBus` icinde kullanilmiyor ([command-bus.ts:4](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L4)). Tek basina kritik degil, fakat bus ile module-level registration modeli arasinda kavramsal drift oldugunu gosteriyor.

## Blast Radius

- `@platform/cqrs` aktif olarak servis runtime'inda kullaniliyor; ornegin `farm-service` bunu root module seviyesinde yukluyor ([app.module.ts:351](/var/aqua-saas/apps/farm-service/src/app.module.ts#L351)) ve resolver write/read path'leri bus uzerinden calisiyor ([farm.resolver.ts:12](/var/aqua-saas/apps/farm-service/src/farm/resolvers/farm.resolver.ts#L12), [farm.resolver.ts:143](/var/aqua-saas/apps/farm-service/src/farm/resolvers/farm.resolver.ts#L143)).
- Rate-limit tarafinda shared platform config bos kaldigi icin policy standardizasyonu simdiden servis-lokal ownership'e kaymis; gateway bunun somut kaniti ([apps/gateway-api/src/config/rate-limit.config.ts:7](/var/aqua-saas/apps/gateway-api/src/config/rate-limit.config.ts#L7)).

## Verdict

Bu slice enterprise-grade degil. `platform/libs/cqrs` calisiyor gorunuyor ama stable shared contract, metadata propagation ve deterministic ownership acisindan zayif; `platform/configs/rate-limit.config.ts` ise fiilen yok. En buyuk risk local bug degil, shared kernel'in fleet genelinde standardizasyonu sahiplenememesi.
