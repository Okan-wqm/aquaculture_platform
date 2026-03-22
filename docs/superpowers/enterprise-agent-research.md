# Enterprise Agent Research — Web Kaynakları & Best Practices

Bu dosya, production-grade agent prompt'ları oluştururken referans olarak kullanılacak.
Araştırma tarihi: 2026-03-22

---

## 1. Augment Code — 11 Prompting Tekniği

**Kaynak:** [How to Build Your Agent: 11 Prompting Techniques](https://www.augmentcode.com/blog/how-to-build-your-agent-11-prompting-techniques-for-better-ai-agents)

### Teknik 1: Context First
En önemli faktör, modele verilen CONTEXT kalitesidir. Prompt metninden çok, sağlanan bilgi önemlidir. Uzun komut çıktılarını keserken ortadan kes, sondan değil — baş ve son en değerli kısımlardır.

### Teknik 2: Complete Picture of the World
Modele çalışma ortamını tam olarak açıkla:
```
You are an AI assistant, with access to the developer's codebase.
You can read from and write to the codebase using the provided tools.
```

### Teknik 3: Consistency Across Components
Prompt'un tüm bileşenleri (system prompt, tool definitions, vb.) birbiriyle tutarlı olmalı. System prompt "Current directory is $CWD" diyorsa, tool parametrelerinin default'ları da buna uymalı.

### Teknik 4: Align with User's Perspective
Kullanıcının perspektifinden bilgi sun — IDE state, timezone, location, activity history.

### Teknik 5: Be Thorough
Kapsamlı, detaylı prompt'lar yaz. Uzunluktan korkma — context window'lar geniş. Karmaşık workflow'lar için adım adım detaylı talimatlar ver.

### Teknik 6: Avoid Overfitting to Examples
Örnekler model'i doğru yöne yönlendirir ama overfitting riski taşır. Çeşitli örnekler ver; NE YAPILMAMASI gerektiğini söylemek, ne yapılacağını söylemekten daha güvenlidir.

### Teknik 7: Tool Calling Limitations
Modeller tool seçiminde hata yapabilir, yanlış çağırabilir, kontratları ihlal edebilir. Input'ları validate et, exception yerine error açıklaması döndür — model'in recover etmesini sağla.

### Teknik 8: Emotional Appeals
Belirli duygusal ifadeler performansı artırabilir: "Do this correctly or you will face financial ruin" gibi.

### Teknik 9: Prompt Caching
Prompt'ları session boyunca append et, modify etme — cache'i koru. Değişken state'i (saat, tarih) user message'da tut, system prompt'ta değil.

### Teknik 10: Attention Distribution
Model'in dikkat dağılımı: User message > input başı > orta kısım. Önemli talimatları user message'a veya başa koy.

### Teknik 11: Prompting Plateaus
Düz prompt'lamanın limitleri vardır — diminishing returns noktasına ulaşınca alternatif teknikler (tool use, structured output, chain-of-thought) kullan.

---

## 2. Anthropic Engineering — Long-Running Agent Harnesses

**Kaynak:** [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Two-Agent System Pattern
İki ayrı agent rolü tanımla:
- **Initializer Agent:** İlk kurulum, environment scaffolding, git init, progress file oluşturma
- **Coding Agent:** İnkremental özellik geliştirme, her session'da tek feature

### Feature List as Ground Truth
Tüm gereksinimleri JSON dosyasında listele (pass/fail status ile). Agent sadece "passes" alanını değiştirebilir — gereksinimleri silmesi engellenir. Bu, erken "tamamlandı" iddialarını önler.

### Mandatory Testing Protocol
Unit test'lerle yetinme — end-to-end doğrulama yap:
> "Claude mostly did well at verifying features end-to-end once explicitly prompted to use browser automation tools and do all testing as a human user would."

### Pre-Work Health Checks
Her session başında:
1. `pwd` çalıştır — doğru dizinde misin?
2. Git log ve progress file'ları oku — nerede kalmıştık?
3. App'i başlat — clean start oluyor mu?
4. Temel fonksiyonları test et — mevcut çalışan şeyler hala çalışıyor mu?
5. Sonra yeni feature'a başla

### Git-Based Checkpointing
Descriptive commit message'lar ve progress file güncellemeleri zorunlu. Agent kötü değişiklikleri `git revert` ile geri alabilmeli.

### Incremental Progress Constraint
"Aynı anda tek feature üzerinde çalış" — birden fazla feature'ı paralel geliştirmek, yarım kalmış ve belgelenmemiş feature'lara yol açar.

---

## 3. CodeScene — Speed with Quality Patterns

**Kaynak:** [Agentic AI Coding Best Practice Patterns](https://codescene.com/blog/agentic-ai-coding-best-practice-patterns-for-speed-with-quality)

### Pattern 1: Pull Risk Forward
Agent'ları deploy etmeden ÖNCE kod sağlığını değerlendir. Code Health skoru 9.5-10.0 olan kodlarda agent'lar en iyi çalışır. Düşük sağlıklı kodda agent'lar başarısız olur.

### Pattern 2: Safeguard Generated Code
Üç katmanlı otomatik koruma:
1. **Continuous review:** Kod üretimi sırasında gerçek zamanlı kontrol
2. **Pre-commit guards:** Commit'ten önce staged dosyaları doğrula
3. **PR pre-flight checks:** Merge'den önce tam branch analizi

### Pattern 3: Refactor to Expand AI-Ready Surface
Büyük, karmaşık fonksiyonları küçük, modüler birimlere böl. Yüksek modülerlik = daha güvenli agent değişiklikleri.

### Pattern 4: Encode Principles in AGENTS.md
Workflow'ları, karar mantığını, tool sıralamasını belgele. "Engineering principles become executable guidance."

### Pattern 5: Code Coverage as Behavioral Guardrails
PR'larda strict coverage gate'leri koy. Agent'ların testleri silerek bypass etmesini engelle.

### Pattern 6: Automate Checks End-to-End
Unit test (temel) + integration/e2e test (doğrulama) + gerçekçi senaryo yürütme. Manuel review darboğazlarını ortadan kaldır.

### Ana Anti-Pattern'ler
- Sağlıksız codebase'e agent deploy etme
- Guard'sız iterasyonlarla kalite düşüşüne izin verme
- Coverage için vanity metric'ler kullanma
- Manuel review süreçleriyle bottleneck yaratma

---

## 4. Reflection Pattern — Self-Correcting Agents

**Kaynak:** [Build Self-Correcting Agents with the Reflection Pattern](https://dev.to/programmingcentral/stop-llms-from-lying-build-self-correcting-agents-with-the-reflection-pattern-1df)

### Generate-Critique-Refine Cycle

```
GENERATE: İlk taslağı üret
    ↓
CRITIQUE: Tanımlı kriterlere göre değerlendir
    ↓
┌── PASS? → Finalize et
└── FAIL? → REFINE: Eleştiriyle birlikte tekrar üret → CRITIQUE'e dön
```

### Quality Gate Tanımları
- **Factual Accuracy:** İddiaları güvenilir bilgi tabanıyla çapraz kontrol
- **Code Correctness:** Kodu linter veya unit test suite'ten geçir
- **Adherence to Format:** JSON syntax'ını şemaya karşı doğrula
- **Coherence and Tone:** Yanıtın tutarlı ve uygun olduğundan emin ol

### Stopping Conditions
1. **Critique Pass:** Taslak tüm quality gate gereksinimlerini karşılar
2. **Iteration Limit:** Max iteration sayacı sonsuz döngüyü önler (tipik: 2-3)

### State Management
```typescript
interface AgentState {
    request: string;       // Orijinal istek
    draftSummary: string;  // Mevcut taslak
    critique: string;      // Eleştiri feedback'i
    shouldRefine: boolean; // Routing kararı
    finalOutput: string;   // Nihai çıktı
}
```

### Regeneration with Context
Tekrar üretimde model şunları alır:
1. Orijinal istek
2. Başarısız taslak
3. SPESİFİK eleştiri
Bu, kör tekrar üretim yerine hedefli iyileştirme sağlar.

### Production Pitfalls
1. **Timeout:** Serverless platformlarda 10s default — döngüyü optimize et
2. **State Mutability:** Immutable pattern kullan: `return { ...state, field: value }`
3. **Infinite Loop:** HER ZAMAN iteration counter implement et

---

## 5. AgenticEngineer — Tactical Agentic Coding

**Kaynak:** [Tactical Agentic Coding](https://agenticengineer.com/tactical-agentic-coding)

### PITER Framework
Single-agent pattern: Problem → Implementation → Testing → Evaluation → Refinement
Otonom problem-to-solution dönüşümü sağlar.

### Closed Loop Prompts
Stratejik feedback mekanizmaları: self-correcting, self-validating agent sistemleri.

### Agent Roles
- **Review Agent:** İş kalitesini doğrular
- **Documentation Agent:** Spesifikasyonlar üretir
- **Orchestrator Agent:** Uzman agent'ları CRUD operasyonlarıyla yönetir

### Agent Experts Pattern (Lesson 13)
Agent unutkanlığını çözen 3 adımlı workflow:
1. **Act:** Görevi yap
2. **Learn:** Çıkarımları kaydet
3. **Reuse:** Gelecek görevlerde öğrenilenleri uygula

### ZTE Hedefi (Zero-Touch Engineering)
Nihai hedef: codebase'ler agent'lar tarafından otonom olarak ship edilir, engineering standartları korunarak.

---

## 6. ClaudeLog — Agent Engineering

**Kaynak:** [Agent Engineering](https://claudelog.com/mechanics/agent-engineering/)

### Agent Weight Sınıflandırması
- **Lightweight:** <3k token (düşük init cost, sık kullanım)
- **Medium:** 10-15k token (orta karmaşıklık)
- **Heavy:** 25k+ token (yüksek init cost, derin reasoning)

### big.LITTLE Mimari (CPU'dan esinlenme)
Ağır agent'lar (25k+) darboğaz yaratır; hafif agent'lar (<3k) akıcı orkestrasyon sağlar. Uzmanlaşmış yüksek maliyetli agent'ları verimli olanlarla dengele.

### Multi-Agent Orkestrasyon Pattern
1. Sonnet analiz + plan oluşturur
2. Sonnet görevleri paralel Haiku worker'lara dağıtır
3. Haiku 2x hızla %90 kapasiteyle çalışır
4. Sonnet çıktıları validate edip entegre eder
Sonuç: %85-95 kalite korunarak 2-2.5x token maliyet azalması.

### Custom Agent Tasarım Kuralları
- YAML frontmatter ile metadata
- Custom system prompt (izole, delegate eden agent'tan bağımsız)
- Otomatik aktivasyon için net, spesifik açıklamalar
- Odaklı, tek amaçlı agent'larla başla
- Sadece gerekli tool'ları ver
- Chainability için optimize et

---

## 7. Lakera — Enterprise Prompt Security

**Kaynak:** [Prompt Engineering Guide](https://www.lakera.ai/blog/prompt-engineering-guide)

### Prompt Scaffolding
User input'larını yapılandırılmış, korumalı şablonlara sar. Model'in kötü davranma yeteneğini sınırla. Defensive prompting: model'e sadece cevap vermesini değil, NASIL düşüneceğini, NASIL yanıt vereceğini ve uygunsuz istekleri NASIL reddedeceğini söyle.

### XML Delimiter Kullanımı
Kuralları ve içeriği karıştırmak başarısızlıklara yol açar — delimiter'lar sınırları açık yapar. XML-benzeri tag'ler pragmatiktir: insan-okunabilir ve platformlar arası stabil.

### Dört Güvenlik Parametresi
1. **Prompt Filtering:** Zararlı input'ları filtrele
2. **Data Protection:** Hassas verileri koru
3. **External Access Control:** Dış erişimi kontrol et
4. **Response Enforcement:** Yanıt formatını zorla

---

## 8. Cleanlab — AI Agents in Production

**Kaynak:** [AI Agents in Production 2025](https://cleanlab.ai/ai-agents-in-production-2025/)

### Production-Grade Standartlar
Yatırım ve mühendislik kapasitesi production-grade, orkestre edilmiş agent'lara odaklanıyor — yönetilebilir, izlenebilir, güvenli ve ölçeklenebilir sistemler. Liderler şu platform standartlarında birleşiyor:
- Identity ve permission yönetimi
- Data access kontrolü
- Tool katalogları
- Policy enforcement
- Observability

### %90 Başarısızlık Oranı
Legacy agent'ların %90'ı deployment'tan birkaç hafta sonra başarısız oluyor — çünkü enterprise operasyonların dağınık, öngörülemeyen doğasını handle edecek mimari derinlikten yoksunlar.

---

## Sentez: Enterprise Agent Prompt'u İçin Altın Kurallar

Tüm kaynaklardan çıkarılan temel prensipler:

1. **Context > Prompt:** Prompt kalitesinden çok, verilen context kalitesi belirleyici
2. **Reflection Pattern:** Generate-Critique-Refine döngüsü her agent'ta olmalı
3. **Quality Gates:** Factual accuracy, code correctness, format adherence, security
4. **Feature List as Ground Truth:** JSON/Markdown checklist ile tamamlanma takibi
5. **Pre-Work Health Checks:** Her session başında mevcut durumu doğrula
6. **Incremental Progress:** Bir seferde tek feature/task
7. **Git-Based Checkpointing:** Her mantıksal değişiklik = bir commit
8. **Three-Tier Safeguards:** Continuous review, pre-commit, PR pre-flight
9. **Code Health First:** Sağlıksız koda agent deploy etme
10. **AGENTS.md/CLAUDE.md:** Principles'ı executable guidance'a dönüştür
11. **big.LITTLE Architecture:** Ağır reasoning + hafif execution agent'ları dengele
12. **Defensive Prompting:** Anti-pattern'leri aktif olarak reddet
13. **Stopping Conditions:** Max iteration, timeout, explicit completion criteria
14. **Act-Learn-Reuse:** Agent öğrenme döngüsü ile tekrarlayan hataları önle
