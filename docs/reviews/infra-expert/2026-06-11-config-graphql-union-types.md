# config-service GraphQL union-tip reflection review (2026-06-11)

Reviewer: infra-expert (production açılış serisi — gateway compose zinciri)
Scope: `apps/config-service/src/configuration/entities/configuration.entity.ts`

## INFRA-HIGH-009 — Soft-delete alanlarında bare @Field + null-union: şema runtime'da inşa edilemiyor; CI hiçbir yerde bu subgraph'ın şemasını KURMUYOR

**Severity:** HIGH (config-service production'da boot-loop; gateway supergraph compose config'i beklediği için API katmanı bloke)

**Gözlem:** `Configuration` entity'sinin 4 soft-delete alanı (`deletedAt/deletedBy/deleteReason/retentionUntil`)
`T | null` union tipli ve bare `@Field({nullable:true})` taşıyordu. NestJS GraphQL design:type
reflection union çözemez → bootstrap'ta "Undefined type error". #375 treniyle gelmiş; bugüne dek
fark edilmedi çünkü CI'da HİÇBİR iş bu subgraph'ın şemasını inşa etmiyor (derleme+lint+unit hepsi
geçer; hata yalnız runtime şema-inşasında). Bugünkü ilk gerçek production boot'u yüzeye çıkardı.

**Fix:** 4 alana explicit tip thunk'ı (`@Field(() => Date|String, {nullable:true})`) + repo-geneli
süpürme (başka örnek YOK — desen-tarama script'iyle doğrulandı) + **kalıcı tier-3 kapanış:**
`graphql-schema-build.spec.ts` — GraphQLSchemaFactory ile resolver'lardan şemayı GERÇEKTEN kuran
smoke spec; reflection-çözülemez her alan artık CI'da kırmızı.

**Sınıf-notu:** Bugün üçüncü "CI yapısal olarak göremez" örneği (008 boş-şema, partition e2e-hardening'siz,
şimdi şema-build). Diğer subgraph'lara aynı smoke spec'in yayılması küme-7/C-4 kapsamına eklendi.
