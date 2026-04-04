---
name: Zero any policy
description: Enterprise-grade app'te any tipi kesinlikle kullanılmamalı. TypeScript strict mode + noImplicitAny zorunlu.
type: feedback
---

Enterprise-grade app'te `any` tipi ASLA kullanılmaz. Bu kural:

1. Production kodu: `any` yerine proper type, `unknown`, veya generic kullan
2. Test kodu: `any` yerine `jest.Mocked<Type>`, `Partial<Type>`, veya explicit mock interface kullan
3. Mock objects: `as any` yerine `as unknown as Type` veya proper mock factory kullan
4. Error catches: `catch (error: unknown)` kullan, `catch (e)` veya `catch (e: any)` değil

**Why:** `any` TypeScript'in type safety'sini tamamen bypass eder. Bir enterprise app'te bu kabul edilemez — runtime hataları, güvenlik açıkları ve bakım zorluğu yaratır.

**How to apply:** Her agent prompt'una ekle:
- "any tipi ASLA kullanma — TypeScript strict mode zorunlu"
- "Test mock'larında bile proper typing kullan"
- "as any cast'ı güvenlik açığıdır — her kullanımı justify et ve alternatif ara"
