# Hydroponics PID Simulator - Technical Documentation

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Carbonate Chemistry Engine](#carbonate-chemistry-engine)
4. [Reagent System](#reagent-system)
5. [Deffeyes Diagram](#deffeyes-diagram)
6. [PID Controller](#pid-controller)
7. [Thermodynamic Plant Model](#thermodynamic-plant-model)
8. [State Machine (FSM)](#state-machine-fsm)
9. [Safety Systems](#safety-systems)
10. [Gain Scheduling](#gain-scheduling)
11. [Simulation Loop](#simulation-loop)
12. [UI Components](#ui-components)
13. [File Structure](#file-structure)
14. [Default Parameters](#default-parameters)

---

## Overview

Hydroponics PID Simulator, hidroponik sistemlerde pH ve EC (Electrical Conductivity) kontrolunu gercek termodinamik hesaplamalarla simule eden bir egitim ve tuning aracidir. V8-final simulatorun basitlestirilmis H+ domain modeli yerine, **Millero denklemleri** (K1, K2, Kw) kullanilarak fizik-temelli bir plant model calistirir.

**Temel Farklar (v8-final'e gore):**
- Basit H+ domain modeli yerine gercek karbonat kimyasi (DIC/ALK state variables)
- pH = f(ALK, DIC, T, S) bisection cozumu ile hesaplanir
- Deffeyes diyagraminda gercek zamanli operating point takibi
- Reagent etkileri termodinamik olarak dogru (HNO3 = ALK azaltir, DIC degistirmez)
- Sicaklik ve tuzluluk degisimlerinin pH izolinlerine etkisi canli olarak gorulur

**Erisim:** `/hydroponics/pid-simulator`

---

## Architecture

Modul **tamamen bagimsizdir** - water chemistry engine'den import yoktur. Benzer fonksiyonlar modul icinde yeniden olusturulmustur. Bu, farm-module'un kendi engine kopyasini tutma pattern'ine uygundur.

```
PidSimulatorPage.tsx (orchestration)
    |
    +-- useSimulation() hook
    |       |
    |       +-- simTick() [her 40ms cagrilir]
    |       |       |
    |       |       +-- fsmStep()         -- State Machine
    |       |       +-- pidStep()         -- pH PID Controller
    |       |       +-- ecPidStep()       -- EC PID Controller
    |       |       +-- pumpToGrams()     -- Pump -> gram donusumu
    |       |       +-- plantStep()       -- Termodinamik plant model
    |       |       +-- safetyCheck()     -- Guvenlik kontrolleri
    |       |
    |       +-- history[] (500 snapshot)
    |       +-- trail[] (100 operating point)
    |
    +-- SimDeffeyesChart     -- Deffeyes diyagrami
    +-- ControlPanel         -- Parametreler & kontroller
    +-- PumpBars             -- Pompa ciktilari
    +-- TimeSeriesCharts     -- pH, EC, pompa, DIC/ALK grafikleri
    +-- StateIndicator       -- FSM durumu & alarm
```

---

## Carbonate Chemistry Engine

**Dosya:** `engine/carbonate-chemistry.ts`

### Termodinamik Sabitler

Uc temel denge sabiti Millero (2010) denklemlerinden hesaplanir:

#### K1 - Birinci karbonik asit dissosiyasyon sabiti (SWS scale)
```
H2CO3 <-> H+ + HCO3-
pK1 = -43.6977 - 0.0129037*S + 1.364e-4*S^2 + 2885.378/T + 7.045159*ln(T)
K1 = 10^(-pK1)
```
Gecerli aralik: S = 0-50 ppt, T = 1-50 C

#### K2 - Ikinci karbonik asit dissosiyasyon sabiti (SWS scale)
```
HCO3- <-> H+ + CO3^2-
pK2 = -452.094 + 13.142162*S - 8.101e-4*S^2 + 21263.61/T + 68.483143*ln(T)
      + (-581.4428*S + 0.259601*S^2)/T + (-1.967035*S)*ln(T)
K2 = 10^(-pK2)
```

#### Kw - Su iyonizasyon carpimi (Total scale)
```
H2O <-> H+ + OH-
ln(Kw) = 148.9652 - 13847.26/T - 23.6521*ln(T)
         + (-5.977 + 118.67/T + 1.0495*ln(T))*sqrt(S) - 0.01615*S
```

### pH Scale Donusumleri

Tum ic hesaplamalar **Free pH scale** uzerinde yapilir. Kullaniciya gosterilen degerler **NBS scale** uzerindedir.

```
pHfree = pHnbs + log10(ahSwsToNbs) + log10(ahFreeToSws)
```

**S = 0 (tatli su) icin:** Tum donusum faktorleri 1.0'a esittir, dolayisiyla pHfree = pHnbs. Bu fiziksel olarak dorudur: saf suda tum pH scale'leri aynidir.

### Alpha Fraksiyonlari

Karbonat turlerinin DIC'e orani:

```
alpha0 = [CO2]/DIC  = H^2 / (H^2 + H*K1 + K1*K2)
alpha1 = [HCO3-]/DIC = H*K1 / (H^2 + H*K1 + K1*K2)
alpha2 = [CO3^2-]/DIC = K1*K2 / (H^2 + H*K1 + K1*K2)
```

Burada K1, K2 SWS scale'den Free scale'e donusturulmustur. `alpha0 + alpha1 + alpha2 = 1` her zaman gecerlidir.

### DIC/ALK/pH Donusumleri

#### pH'dan ALK hesaplama (DIC bilinen)
```
ALK = DIC * (alpha1 + 2*alpha2) + ([OH-] - [H+] + [B(OH)4-]) * 1000
    = DIC * slope + intercept
```
Burada slope = dALK/dDIC (Deffeyes egrisi egimi), intercept karbon-bagimsiz alkalinite katkisi.

#### ALK + DIC'den pH hesaplama (Bisection)
```
calcPhForAlkDic(alkMeq, dicMM, tempC, S):
  Aralik: [2.0, 12.0]  (orijinal [4.0, 12.0]'dan genis - asit dozlama icin)
  Iterasyon: 100 (tolerans 1e-8)
  Monotonik: ALK, sabit DIC'te pH ile artar (termodinamik garanti)
```

Bu fonksiyon **plant modelin kalbidir**. Her tick'te DIC ve ALK guncellendikten sonra pH bu fonksiyonla yeniden hesaplanir.

---

## Reagent System

**Dosya:** `engine/reagents.ts`

### Hidroponik Kimyasallar

| Reagent | Formula | MW (g/mol) | meq/mol | Slope | Radians | Deffeyes Yonu |
|---------|---------|------------|---------|-------|---------|---------------|
| Nitric Acid | HNO3 | 63.012 | 1 | Inf | 3pi/2 | Dikey ASAGI |
| Phosphoric Acid | H3PO4 | 97.994 | 1 | Inf | 3pi/2 | Dikey ASAGI |
| Potassium Hydroxide | KOH | 56.106 | 1 | Inf | pi/2 | Dikey YUKARI |
| Sodium Bicarbonate | NaHCO3 | 84.007 | 1 | 1 | pi/4 | 45 derece |
| Add CO2 | CO2 | 44.010 | 0 | 0 | 0 | Yatay SAGA |
| De-gas CO2 | -CO2 | 44.010 | 0 | 0 | pi | Yatay SOLA |

### Reagent Delta Hesaplama

```typescript
reagentDeltas(reagent, amountGrams, volumeL) -> { deltaDIC, deltaALK }
```

**Mantik:**
- **Guclu asitler (HNO3, H3PO4):** radians = 3pi/2 > pi -> sign = -1
  - deltaDIC = 0 (karbon icermez)
  - deltaALK = -1 * meqPerMol * (moles*1000/volumeL) (alkalinite AZALIR)

- **Guclu bazlar (KOH):** radians = pi/2 < pi -> sign = +1
  - deltaDIC = 0 (karbon icermez)
  - deltaALK = +1 * meqPerMol * (moles*1000/volumeL) (alkalinite ARTAR)

- **CO2 ekleme:** radians ~= 0 -> sign = +1
  - deltaDIC = +concMmolL (DIC ARTAR)
  - deltaALK = 0 (alkaliniteyi degistirmez)

- **NaHCO3:** finite slope = 1
  - deltaDIC = +concMmolL
  - deltaALK = +meqPerMol * concMmolL (her ikisi de esit artar)

### H3PO4 meqPerMol = 1 Aciklamasi

Fosforik asidin 3 pKa degeri vardir: pKa1=2.15, pKa2=7.20, pKa3=12.35. Hidroponik calisma pH'si ~5.8'de sadece 1. proton tam dissosiye olmustur (pH >> pKa1), 2. proton hemen hemen hic dissosiye olmamistir (pH << pKa2). Bu nedenle etkili olarak mol basina 1 meq alkalinite tuketir.

---

## Deffeyes Diagram

**Dosya:** `engine/deffeyes-calc.ts`

Deffeyes diyagrami, ALK (meq/L) vs DIC (mmol/L) koordinat duzleminde su kalitesini gorsellestiren bir aractir.

### pH Izolinleri

Her pH degeri icin Deffeyes duzleminde bir dogru cizilir:
```
AT = CT * slope + intercept
slope = alpha1(pH) + 2*alpha2(pH)     -- DIC'e bagli alkalinite degisim hizi
intercept = ([OH-] - [H+] + [B(OH)4-]) * 1000  -- karbon-bagimsiz alkalinite
```

**Aralik:** pH 4.0 - 9.0, adim 0.25 (hidroponik odakli)
**Renk kodlama:** Kirmizi (dusuk pH) -> Yesil (notr) -> Mor (yuksek pH)

### Operating Point

Mevcut (pH, ALK) degerlerinden Deffeyes koordinati hesaplanir:
```
DIC = (ALK - intercept) / slope    -- calcDicOfAlk fonksiyonu
Point = (DIC, ALK)
```

### Reagent Yon Cizgileri

Her reagent icin operating point'ten baslayan yon cizgisi cizilir:
- **HNO3/H3PO4:** Dikey asagi (DIC sabit, ALK azalir)
- **KOH:** Dikey yukari (DIC sabit, ALK artar)
- **NaHCO3:** 45 derece yukari saga
- **CO2:** Yatay saga (DIC artar, ALK sabit)

Bu yonler, her kimyasalin Deffeyes duzleminde operating point'i nasil hareket ettirdigini gosterir.

### Operating Point Trail

Son 100 operating point saklanir ve azalan opacity ile cizilir. Bu, dozlama sirasinda noktanin Deffeyes duzleminde nasil hareket ettigini gosterir. HNO3 dozlamada noktanin **dikey asagi** hareket etmesi beklenir (DIC degismez, ALK azalir).

---

## PID Controller

**Dosya:** `simulation/pid-controller.ts`

### Algoritma Ozellikleri

1. **Derivative-on-PV (Process Variable uzerinde turev)**
   - Klasik PID turevinde d(error)/dt kullanilir, bu setpoint degisimlerinde "kick" yaratir
   - Burada d(PV)/dt kullanilir: `D = -Kd * d(pH)/dt`
   - Setpoint aniden degistiginde turev terimi etkilenmez

2. **Filtrelenmis Turev (1. derece alc gecirim)**
   ```
   alpha = dt * N / (1 + dt * N)       -- N=5, dt=0.1 icin alpha=0.333
   filteredDeriv = alpha * rawDeriv + (1-alpha) * prevDeriv
   ```
   Bu, yuksek frekanslı gurultuyu filtreler. N buyuk -> az filtreleme, N kucuk -> cok filtreleme.

3. **Back-calculation Anti-windup**
   - Cikis saturasyona ulastiginda integral terimi duzeltilir:
   ```
   if (clampedOutput != rawOutput):
     integral += (1/Kp) * (clampedOutput - rawOutput)
   ```
   - Bu, integral birikiminin cikis limitlerini asmaya devam etmesini onler

4. **Kosullu Integrasyon**
   - |error| > 1.0 pH oldugunda integral dondurulur
   - Buyuk gecislerde integral birikimini onler

5. **Hiz Sinirlamasi (Rate Limiting)**
   ```
   maxChange = rateMax * dt     -- 50 * 0.1 = 5 birim/tick
   delta = clamp(rawOutput - prevOutput, -maxChange, +maxChange)
   ```

### Split-Range Cikis

PID cikisi [-100, +100] araligindadir:
- **Negatif cikis -> Asit pompasi** (pH cok yuksek, asitleme gerekli)
  - `acidPercent = -clampedOutput` (0-100)
- **Pozitif cikis -> Baz pompasi** (pH cok dusuk, baz gerekli)
  - `basePercent = clampedOutput` (0-100)

**Ornek:** pH = 6.8, SP = 5.8 -> error = 5.8 - 6.8 = -1.0 -> P = -8.0 -> cikis negatif -> asit pompasi calisir.

### EC PID

EC kontrolu tek yonludur: sadece besin pompasi (0-100). EC cok yuksek oldugunda DILUTE state'i devreye girer (FSM tarafindan yonetilir).

---

## Thermodynamic Plant Model

**Dosya:** `simulation/plant-model.ts`

### Tick Sirasi

Her simulasyon tick'inde su adimlar uygulanir:

```
1. HNO3 dozlama    -> reagentDeltas(HNO3, gram, vol) -> DIC += 0, ALK -= delta
2. KOH dozlama     -> reagentDeltas(KOH, gram, vol)  -> DIC += 0, ALK += delta
3. Cevre bozunumlari:
   - Atmosferik CO2 emilimi: DIC += 0.001 * (dt/60) mmol/L/dakika
   - Bitki kok H+ ekstruzyonu: ALK -= 0.0005 * (dt/60) meq/L/dakika
   - Bitki besin alimi: EC -= 0.002 * (dt/60) mS/cm/dakika
4. Fiziksel sinirlar: DIC >= 0.001, ALK >= -2.0
5. pH = calcPhForAlkDic(ALK, DIC, T, S)   -- GERCEK TERMODINAMIK
6. CO2 = DIC * alpha0 * 44.0096           -- mg/L cinsinden
7. EC modeli: EC += nutDose * 0.015 mS/cm/mL
8. Seyreltme: EC, ALK, DIC orantisal azalir
9. Gain scheduling guncelleme
```

### Pompa -> Gram Donusumu

```
flowRate_mL = (pumpPercent / 100) * maxFlowRate_mL_min * (dt / 60)
grams = flowRate_mL * concentration_g_L / 1000
```

Boyut analizi: `[mL/min] * [min] = [mL]`, `[mL] * [g/L] / [1000 mL/L] = [g]`

### Seyreltme Modeli

Seyreltme sadece DILUTE state'inde aktiftir (sabit %80 pompa cikisi):
```
dilML = (dilPercent/100) * 500 mL/min * (dt/60)
dilFraction = dilML / (volumeL * 1000)
EC *= (1 - dilFraction)
ALK *= (1 - dilFraction)
DIC *= (1 - dilFraction)
```
Seyreltme sonrasi pH ve CO2 yeniden hesaplanir.

---

## State Machine (FSM)

**Dosya:** `simulation/state-machine.ts`

### 8 Durum

```
+-------+     |ecErr|>0.08     +----+    |ecErr|<=0.06    +---------+
| IDLE  |--------------------->| EC |-------------------->| EC_WAIT |
+-------+                     +----+                     +---------+
  |  ^                                                     |    |
  |  |  timer>=300                     |ecErr|>0.08        |    |
  |  +-----+------+<------------------------------------------+
  |        |      |                    timer>=300
  |     +--------+|                      |
  |     |PH_WAIT ||               +---------+
  |     +--------+|               | CHEM_DT |  (20s dead time)
  |        ^      |               +---------+
  |        |      |                      |
  |  |phErr|<=0.06|               timer>=200
  |        |      v                      |
  |     +----+                    +------v---+
  |     | PH |<-------------------| pH PID   |
  |     +----+                    | integral  |
  |                               | reset     |
  |                               +----------+
  |  ecErr<-0.3
  v
+---------+   ecErr>=-0.1   +-------+
| DILUTE  |---------------->| IDLE  |
+---------+                 +-------+

  ANY STATE + alarm -> ALARM (latching, ACK required)
```

### Durum Aciklamalari

| Durum | Aktif Pompalar | Aciklama |
|-------|---------------|----------|
| **IDLE** | Hicbiri | Tum degerler hedefte, bekleme |
| **EC** | Besin pompasi | EC PID aktif, besin dozlama |
| **EC_WAIT** | Hicbiri | EC hedefte, 30s bekleme (kararlilasma) |
| **CHEM_DT** | Hicbiri | 20s kimyasal olu zaman (EC dozlama sonrasi pH dengesi) |
| **PH** | Asit/Baz pompasi | pH PID aktif, split-range dozlama |
| **PH_WAIT** | Hicbiri | pH hedefte, 30s bekleme |
| **DILUTE** | Seyreltme pompasi | EC cok yuksek, %80 sabit seyreltme |
| **ALARM** | Hicbiri | Guvenlik alarmi, ACK bekleniyor |

### Histerezis

Giris ve cikis esikleri farklıdır (chattering onleme):

| Parametre | Giris Esigi | Cikis Esigi |
|-----------|-------------|-------------|
| EC | 0.08 mS/cm | 0.06 mS/cm |
| pH | 0.12 pH | 0.06 pH |
| DILUTE giris | ecErr < -0.3 | -- |
| DILUTE cikis | -- | ecErr >= -0.1 |

### Oncelik Sirasi

IDLE'dan cikis onceligi: **DILUTE > EC > pH**

Mantik: Seyreltme acil durumdur (yuksek EC bitkileri oldurur). EC dozlama pH'yi etkiler, bu nedenle once EC duzeltilir, sonra pH. CHEM_DT (kimyasal olu zaman) EC dozlama sonrasi kimyanin dengelenemesini saglar.

### CHEM_DT'de Integral Reset

EC dozlama pH'yi bozar. CHEM_DT -> PH gecisinde pH PID integral terimi sifirlanir (`createInitialPIDState(state.pH)`). prevPV mevcut pH'ya set edilir -> **derivative kick onlenir**.

### Post-Alarm Cooldown

Alarm ACK sonrasi `stateTimer = -300` set edilir. FSM IDLE'da `stateTimer < 0` kontrolu yapar ve negatifken hicbir state'e gecis yapmaz. Timer her tick'te +1 artar, 30 saniye sonra normal operasyona doner.

---

## Safety Systems

**Dosya:** `simulation/safety.ts`

### Kontrol Sirasi (Oncelik)

```
1. Watchdog           -- Simulasyon dongusu durmami?
2. Sensor history     -- Her durumda guncellenir (erken return'den etkilenmez)
3. pH range           -- pH < 3.0 veya pH > 10.0
4. Dose limits        -- Saatlik dozaj limitleri
5. Stuck sensor       -- Donmus sensor tespiti
6. Drift detector     -- Anormal pH kaymasi tespiti
```

### 1. Watchdog Timer

```
ticksSinceLastCheck = currentTick - lastSafetyTick
if (ticksSinceLastCheck > 100 && currentTick > 100):
    ALARM: WATCHDOG
```
Simulasyon dongusunun beklenmedik sekilde durmasini tespit eder. Ilk 100 tick'te devre disi (startup grace period).

### 2. Stuck Sensor Tespiti

```
Son 50 ornekte stddev hesapla (Bessel duzetmesi ile)
Eger stddev < 0.001 VE pompa aktif olarak dozlama yapiyorsa:
    ALARM: STUCK_PH veya STUCK_EC
```

**Pompa aktivite esigi:** Pompanin %5'ten fazla calismasi gerekir. Bu, IDLE durumunda stabil olan (ve gercekten dogru olan) sensorden yanlis alarm onler.

**Pencere boyutu:** 50 ornek * 0.1s = 5 saniye. Tamamen donmus bir ADC icin yeterli.

### 3. Drift Detector

```
50 orneklik pencereyi iki yariya bol (her biri 25 ornek)
meanShift = |mean(ikinciYari) - mean(ilkYari)|
timeSpan = 25 * 0.1 = 2.5 saniye
driftRate = meanShift / timeSpan    -- pH/s cinsinde gercek hiz
Eger driftRate > 0.1 pH/s VE localStddev < 0.05:
    ALARM: DRIFT
```

**Sadece IDLE/WAIT state'lerinde kontrol edilir.** Aktif dozlama sirasinda pH kasitli olarak degisir, bu yanlis alarm tetiklerdi.

**Dusuk varyans koşulu (< 0.05):** Monoton kaymayi (drift) stokastik salınımdan ayirir. Yuksek varyans = normal calkalama, dusuk varyans + yuksek mean shift = sistematik kayma.

### 4. Dose Limits

| Parametre | Limit | Periyod |
|-----------|-------|---------|
| Asit (HNO3) | 500 g | 1 saat (36000 tick) |
| Baz (KOH) | 500 g | 1 saat |
| Besin solüsyonu | 2000 mL | 1 saat |

Saatlik sayaclar `HOURLY_TICKS` aralikla sifirlanir.

### 5. pH Range

pH < 3.0 veya pH > 10.0 oldugunda aninda alarm. Bu degerler ekipman hasari/insan guvenligi icin kritiktir.

### 6. Alarm Yonetimi

- **Latching:** Alarm bir kez tetiklendiginde, tum pompalar kapanir ve ACK beklenir
- **ACK sonrasi:**
  - PID integral/turev state'leri sifirlanir (prevPV = mevcut deger)
  - Sensor history temizlenir (stale drift/stuck alarm onleme)
  - 30 saniye cooldown (stateTimer = -300)
  - Tum pompalar kapalı kalir cooldown boyunca

---

## Gain Scheduling

**Dosya:** `simulation/plant-model.ts`

### Problem

pH kontrol, son derece **nonlineer** bir prosestir. Tampon kapasitesi (buffer capacity) calisma noktasina gore dramatik olarak degisir:
- pH 5.8 civarinda (tipik hidroponik): Orta tampon kapasitesi, makul proses gain
- pH 4.0 civarinda: Cok dusuk tampon kapasitesi, kucuk ALK degisimi buyuk pH degisimi yapar
- pH 7.5 civarinda: Yuksek tampon kapasitesi, buyuk ALK degisimi kucuk pH degisimi yapar

Sabit PID kazanclari kullanirsaniz: dusuk tampon kapasitesinde salıním, yuksek tampon kapasitesinde yavas yanit.

### Cozum: Adaptif Kazanc

```
1. Mevcut noktada proses gain hesapla:
   deltaALK = 0.01 meq/L
   pH_new = calcPhForAlkDic(ALK + deltaALK, DIC, T, S)
   processGain = |pH_new - pH| / deltaALK    -- dpH/dALK

2. Buffer capacity = 1 / processGain

3. Gain schedule = referenceGain / processGain
   - referenceGain = 0.5 (pH 5.8'deki tipik deger)
   - Sinirlar: [0.1, 5.0]

4. Efektif PID kazanclari:
   Kp_eff = Kp * gainSchedule
   Ki_eff = Ki * gainSchedule
   Kd_eff = Kd * gainSchedule
```

**Temel ilke:** Controller gain * Process gain = sabit. Proses gain yuksekse (dusuk tampon), controller gain azaltilir; proses gain dusukse (yuksek tampon), controller gain artirilir.

---

## Simulation Loop

**Dosya:** `simulation/use-simulation.ts`

### Zamanlama

```
Interval: 40ms (25 fps render)
Tick suresi (dt): 0.1 saniye simulasyon zamani
Speed multiplier: 1x, 5x, 20x, 60x
```

Her interval'da `speedMultiplier` kadar tick calistirilir. 60x hizda: 60 tick * 0.1s = 6 saniye simulasyon zamani / 40ms gercek zaman.

### Veri Yapilari

- **history[]:** Son 500 SimSnapshot (pH, EC, pompa ciktilari, DIC, ALK vs.)
- **trail[]:** Son 100 (DIC, ALK) operating point (Deffeyes trail icin)
- **stateRef:** Mutable SimState (useRef ile, gereksiz re-render onleme)
- **renderCount:** useState counter, her interval'da +1 (UI render tetikleyici)

### Tick Sirasi

```
1. FSM step       -> Hangi pompalarin aktif oldugunu belirle
2. pH PID step    -> (sadece PH state'inde) asit/baz pompa ciktisi
3. EC PID step    -> (sadece EC state'inde) besin pompa ciktisi
4. Pump -> gram   -> Pompa %'sini fiziksel miktara donustur
5. Plant step     -> Termodinamik hesaplama, pH/EC/CO2 guncelle
6. Safety check   -> Alarm kontrolu
```

### Disturbance (Bozunum) Uygulama

Kullanici butonlari ile anlik bozunumlar uygulanabilir:
- pH UP: ALK += 0.5 meq/L (baz eklenmis gibi)
- pH DN: ALK -= 0.5 meq/L (asit eklenmis gibi)
- EC UP: EC += 0.3 mS/cm
- EC DN: EC -= 0.3 mS/cm

---

## UI Components

### PidSimulatorPage.tsx

Grid layout: Sol panel (280px) + Sag icerlik (esnek genislik)

```
+--------------------------------------------------+
| PID Simulator - Hydroponics pH/EC Control         |
+----------+----------------------------------------+
| Control  |  Deffeyes Diagram       | Pumps        |
| Panel    |  (pH izolinleri,        | (4 bar)      |
| (280px)  |   reagent yonleri,      |              |
|          |   operating point       | State        |
| Tank     |   trail, target)        | Machine      |
| Values   |                         | + Alarm      |
|          +----------------------------------------+
| Setpoints|  pH Chart (zaman serisi)               |
|          +----------------------------------------+
| System   |  EC Chart (zaman serisi)               |
|          +----------------------------------------+
| pH PID   |  Pump Chart (4 pompa zaman serisi)     |
| Tuning   +----------------------------------------+
|          |  DIC/ALK Chart (zaman serisi)           |
| EC PID   |                                        |
| Tuning   |                                        |
|          |                                        |
| Disturb. |                                        |
| Speed    |                                        |
| START    |                                        |
+----------+----------------------------------------+
```

### SimDeffeyesChart.tsx

Recharts `ComposedChart` ile:
- 21 pH izolini (major 0.5 step, minor 0.25 step)
- Target pH izolini (kalin, yesil, kesikli)
- 6 reagent yon cizgisi (ok uclariyla)
- Operating point trail (son 100 nokta, azalan opacity)
- Current operating point (pulsing mavi daire, animasyonlu)
- Target operating point (siyah X)
- pH isoline etiketleri

**Performans:** Izolinler `useMemo` ile sadece T/S degistiginde yeniden hesaplanir. `isAnimationActive={false}` Recharts animasyonunu devre disi birakir.

### ControlPanel.tsx

- **Tank degerleri:** pH (buyuk), EC (buyuk), DIC, ALK, CO2
- **Set points:** pH slider (4.0-8.0), EC slider (0.5-4.0)
- **Sistem:** Volume, Temperature, Salinity
- **pH PID:** Kp, Ki, Kd slider'lari + gain schedule/buffer bilgisi
- **EC PID:** Kp, Ki, Kd slider'lari
- **Disturbance:** pH UP/DN, EC UP/DN butonlari
- **Hiz:** 1x, 5x, 20x, 60x secici
- **Kontrol:** START/STOP/RESET butonlari
- **Tick counter:** Tick sayisi ve simulasyon zamani

### PumpBars.tsx

4 yatay bar (div-based, SVG yok):
- ACID (kirmizi), BASE (yesil), NUTRIENT (turuncu), DILUTE (mavi)
- On/off gostergesi (renkli nokta) + % deger
- Transition animasyonu (100ms)

### TimeSeriesCharts.tsx

4 ayri Recharts `LineChart` (her biri 110px):
1. pH vs zaman + target pH referans cizgisi (yesil kesikli)
2. EC vs zaman + target EC referans cizgisi
3. Pompa ciktilari vs zaman (4 cizgi: acid, base, nutrient, dilute)
4. DIC & ALK vs zaman (2 cizgi: mor ve cyan)

### StateIndicator.tsx

8 durum kutusu (aktif olan vurgulanir) + alarm gostergesi + ACK butonu.

---

## File Structure

```
web/modules/hydroponics-module/src/pages/pid-simulator/
|-- PidSimulatorPage.tsx              # Ana sayfa - layout + orchestration
|-- engine/
|   |-- carbonate-chemistry.ts        # Millero K1/K2/Kw, alpha, pH donusumleri
|   |-- deffeyes-calc.ts              # pH izolinleri, operating point
|   +-- reagents.ts                   # HNO3, KOH, reagentDeltas
|-- simulation/
|   |-- types.ts                      # SimConfig, SimState, PIDParams, defaults
|   |-- pid-controller.ts             # PID: derivative-on-PV, anti-windup
|   |-- plant-model.ts                # Termodinamik plant + gain scheduling
|   |-- state-machine.ts              # 8-state FSM
|   |-- safety.ts                     # Watchdog, stuck sensor, drift, dose limits
|   +-- use-simulation.ts             # React hook: sim loop, history
+-- components/
    |-- SimDeffeyesChart.tsx           # Deffeyes diyagrami
    |-- ControlPanel.tsx              # Parametre paneli
    |-- PumpBars.tsx                   # Pompa barlari
    |-- TimeSeriesCharts.tsx           # Zaman serisi grafikleri
    +-- StateIndicator.tsx            # FSM durumu + alarm
```

**Degistirilen dosyalar:**
- `web/modules/hydroponics-module/src/Module.tsx` - Route ekleme
- `web/shell/src/layouts/MainLayout.tsx` - Sidebar ekleme
- `web/modules/hydroponics-module/package.json` - recharts dependency

---

## Default Parameters

### Simulasyon

| Parametre | Varsayilan | Aciklama |
|-----------|-----------|----------|
| Volume | 100 L | Tank hacmi |
| Temperature | 22 C | Su sicakligi |
| Salinity | 0 ppt | Tatli su |
| Initial pH | 6.5 | Baslangic pH |
| Initial ALK | 2.0 meq/L | Baslangic alkalinite |
| Initial EC | 1.3 mS/cm | Baslangic EC |
| Target pH | 5.8 | Hedef pH |
| Target EC | 1.8 mS/cm | Hedef EC |
| dt | 0.1 s | Tick suresi |

### pH PID

| Parametre | Varsayilan |
|-----------|-----------|
| Kp | 8.0 |
| Ki | 0.3 |
| Kd | 1.5 |
| N (filter) | 5 |
| Rate max | 50 %/s |

### EC PID

| Parametre | Varsayilan |
|-----------|-----------|
| Kp | 15.0 |
| Ki | 1.0 |
| Kd | 0.5 |
| N (filter) | 5 |
| Rate max | 50 %/s |

### Pompalar

| Pompa | Max Flow | Konsantrasyon |
|-------|----------|---------------|
| Acid (HNO3) | 50 mL/min | 100 g/L (~%10) |
| Base (KOH) | 50 mL/min | 100 g/L (~%10) |
| Nutrient | 100 mL/min | 200 g/L |
| Dilute | 500 mL/min | -- (saf su) |

### Guvenlik Limitleri

| Parametre | Deger |
|-----------|-------|
| pH min | 3.0 |
| pH max | 10.0 |
| Max acid/hour | 500 g |
| Max base/hour | 500 g |
| Max nutrient/hour | 2000 mL |
| Stuck sensor window | 50 sample (5s) |
| Stuck sensor stddev | < 0.001 |
| Drift rate threshold | 0.1 pH/s |
| Watchdog limit | 100 ticks |
| Post-alarm cooldown | 300 ticks (30s) |
