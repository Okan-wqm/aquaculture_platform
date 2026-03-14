# Grup F: QueryEditor Field Mismatch Fix (C13)

## Bulgu
- **ID**: C13
- **Seviye**: Kritik
- **Kaynak**: 03-contract-map.md, FIELD_MISMATCH #1

## Sorun
`QueryEditor.tsx` satir 82'de `executeQuery` fonksiyonu POST body olarak `{ schema, query }` gonderiyordu.
Backend `ExecuteQueryDto` (explorer.controller.ts satir 179-186) `{ sql, params }` bekliyor.

`main.ts`'teki `whitelist: true + forbidNonWhitelisted: true` ayari nedeniyle:
- `query` field'i bilinmeyen field olarak reddediliyor
- `schema` field'i bilinmeyen field olarak reddediliyor
- `sql` zorunlu field eksik oldugu icin validation hatasi

Sonuc: **400 Bad Request** -- SQL sorgu motoru tamamen calismiyordu.

## Uygulanan Duzeltme

### Dosya: `web/modules/admin-panel/src/components/database/QueryEditor.tsx`

**Degisiklik 1**: `executeQuery` fonksiyonunun body parametresi duzeltildi.

- `{ schema, query }` --> `{ sql: query }`
- `schema` parametresi `_schema` olarak yeniden adlandirildi (kullanilmadigini belirtmek icin)
- Yorum eklendi: `// Fix: C13 -- backend ExecuteQueryDto.sql ile uyumlu`

**Neden `schema` kaldirildi?**
Backend `ExecuteQueryDto` DTO'sunda `schema` field'i yok. `forbidNonWhitelisted: true` nedeniyle bu field de reject edilirdi. Backend'in `executeQuery` endpoint'i schema bilgisini kullanmiyor -- SQL dogrudan calistiriliyor.

### Degismeyen Kisimlar
- Fonksiyon imzasi korundu: `executeQuery(schema: string, query: string)` -> `executeQuery(_schema: string, query: string)`
- Caller tarafinda degisiklik yok: `executeQuery(selectedSchema, trimmedQuery)` ayni kaliyor
- Backend'te degisiklik yok

## Guvenlik Dogrulamasi
SQL guvenlik fix'leri (C1-C5, C11, C12, H25) onceden uygulanmis durumda:
- C1: Multi-statement SQL bypass engeli (`;` kontrolu) -- MEVCUT
- C2/C3: SET/DO/PERFORM/COPY bypass engeli -- MEVCUT
- C4: Fail-closed raw SQL korumasi (ENABLE_RAW_SQL_EXPLORER flag) -- MEVCUT
- C5: CRUD production korumasi (ENABLE_DB_EXPLORER_WRITES flag) -- MEVCUT
- C11: System catalog erisim engeli (pg_catalog, information_schema) -- MEVCUT
- C12: Sensitive data maskeleme -- MEVCUT
- H25: set_config/pg_sleep/current_setting bypass engeli -- MEVCUT

## TypeScript Dogrulama
`npx tsc --noEmit` ile kontrol edildi. QueryEditor.tsx'te yeni hata yok.

## Test Plani
1. QueryEditor'da bir SELECT sorgusu calistir
2. Request body'nin `{ sql: "SELECT ..." }` formatinda gittigini dogrula (Network tab)
3. Backend'in 400 yerine basarili yanit dondugunu dogrula
4. Schema seciminin UI'da hala goruntulendigini dogrula (kullanici deneyimi korunur)
