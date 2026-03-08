/**
 * Dosing Pump End-to-End Simulation Tests
 *
 * Bu test dosyası, dozaj pompası ST programının tam yaşam döngüsünü doğrular:
 *   parse → interpreter oluştur → farklı input kombinasyonlarıyla çalıştır → output'ları kontrol et
 *
 * Kapsamlı edge case analizi:
 *   - Boundary değerleri (error = 0.5, error = 0.1)
 *   - Mid-simulation setpoint değişikliği
 *   - Alarm latch davranışı
 *   - Multi-program izolasyonu
 *   - Fan coil unit (sıcaklık kontrollü fan) senaryosu
 */

import { parseST } from '../st-parser-lite';
import { StInterpreter } from '../st-interpreter';

// ── Dozaj pompası ST kodu ────────────────────────────────────────────────

const DOSING_PUMP_CODE = `
PROGRAM DosingPump
VAR_INPUT
  start_command : BOOL;
  ph_value : REAL;
  ph_setpoint : REAL := 7.0;
END_VAR
VAR_OUTPUT
  pump_active : BOOL;
  valve_open : BOOL;
  alarm : BOOL;
END_VAR
VAR
  error : REAL;
  dose_timer : INT := 0;
  max_dose_time : INT := 300;
END_VAR
  error := ph_setpoint - ph_value;

  IF NOT start_command THEN
    pump_active := FALSE;
    valve_open := FALSE;
    dose_timer := 0;
  ELSIF error > 0.5 THEN
    pump_active := TRUE;
    valve_open := TRUE;
    dose_timer := dose_timer + 1;
  ELSIF error > 0.1 THEN
    pump_active := TRUE;
    valve_open := FALSE;
    dose_timer := dose_timer + 1;
  ELSE
    pump_active := FALSE;
    valve_open := FALSE;
    dose_timer := 0;
  END_IF;

  IF dose_timer > max_dose_time THEN
    alarm := TRUE;
    pump_active := FALSE;
    valve_open := FALSE;
  END_IF;
END_PROGRAM`;

// ── Fan coil unit ST kodu ────────────────────────────────────────────────

const FAN_COIL_UNIT_CODE = `
PROGRAM FanCoilUnit
VAR_INPUT
  room_temp : REAL;
  setpoint : REAL := 22.0;
  enable : BOOL;
END_VAR
VAR_OUTPUT
  fan_speed : INT;
  valve_pos : REAL;
END_VAR
VAR
  error : REAL;
END_VAR
  IF NOT enable THEN
    fan_speed := 0;
    valve_pos := 0.0;
  ELSE
    error := room_temp - setpoint;
    IF error > 3.0 THEN
      fan_speed := 3;
      valve_pos := 100.0;
    ELSIF error > 1.5 THEN
      fan_speed := 2;
      valve_pos := 70.0;
    ELSIF error > 0.5 THEN
      fan_speed := 1;
      valve_pos := 40.0;
    ELSE
      fan_speed := 0;
      valve_pos := 0.0;
    END_IF;
  END_IF;
END_PROGRAM`;

// ── Helper: Farklı bir ST programı (multi-program testi için) ────────────

const SIMPLE_COUNTER_CODE = `
PROGRAM SimpleCounter
VAR_INPUT
  enable : BOOL;
END_VAR
VAR_OUTPUT
  count : INT;
END_VAR
VAR
  internal : INT := 0;
END_VAR
  IF enable THEN
    internal := internal + 1;
    count := internal;
  ELSE
    count := 0;
  END_IF;
END_PROGRAM`;

// ═════════════════════════════════════════════════════════════════════════
// Test Suite
// ═════════════════════════════════════════════════════════════════════════

describe('Dozaj Pompası E2E Simülasyonu', () => {
  let interp: StInterpreter;

  beforeEach(() => {
    const { ast, errors } = parseST(DOSING_PUMP_CODE);
    expect(errors).toHaveLength(0);
    expect(ast).toHaveLength(1);
    expect(ast[0].kind).toBe('program');
    interp = new StInterpreter(ast[0]);
  });

  // ── Senaryo 1: Sistem idle — pompa kapalı ──────────────────────────────

  it('Senaryo 1: Sistem idle iken tüm çıkışlar kapalı olmalı', () => {
    interp.setVariable('start_command', false);
    interp.setVariable('ph_value', 6.0);
    interp.runCycle();

    // Pozitif: start_command=false → her şey kapalı
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('alarm')).toBe(false);
    expect(interp.getVariable('dose_timer')).toBe(0);

    // Negatif: pompa hiçbir koşulda açılmamalı
    expect(interp.getVariable('pump_active')).not.toBe(true);
    expect(interp.getVariable('valve_open')).not.toBe(true);
  });

  // ── Senaryo 2: Start + düşük pH → pompa + valf AÇIK ───────────────────

  it('Senaryo 2: Start komutu ve düşük pH ile pompa ve valf açılmalı', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.0); // error = 7.0 - 6.0 = 1.0 > 0.5
    interp.runCycle();

    // Pozitif: error > 0.5 → pompa ve valf açık
    expect(interp.getVariable('pump_active')).toBe(true);
    expect(interp.getVariable('valve_open')).toBe(true);
    expect(interp.getVariable('error')).toBeCloseTo(1.0);
    expect(interp.getVariable('dose_timer')).toBe(1);

    // Negatif: alarm tetiklenmemeli (henüz 1 cycle)
    expect(interp.getVariable('alarm')).toBe(false);
  });

  // ── Senaryo 3: Start + hafif düşük pH → pompa AÇIK, valf KAPALI ───────

  it('Senaryo 3: Start komutu ve hafif düşük pH ile pompa açık ama valf kapalı olmalı', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.7); // error = 7.0 - 6.7 = 0.3, 0.1 < 0.3 < 0.5
    interp.runCycle();

    // Pozitif: 0.1 < error < 0.5 → pompa açık, valf kapalı
    expect(interp.getVariable('pump_active')).toBe(true);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('error')).toBeCloseTo(0.3);
    expect(interp.getVariable('dose_timer')).toBe(1);

    // Negatif: valf açık olmamalı
    expect(interp.getVariable('valve_open')).not.toBe(true);
  });

  // ── Senaryo 4: pH setpoint'te → pompa KAPALI ──────────────────────────

  it('Senaryo 4: pH setpoint değerinde iken pompa kapalı olmalı', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 7.0); // error = 0.0 ≤ 0.1
    interp.runCycle();

    // Pozitif: error ≤ 0.1 → ELSE dalı, her şey kapalı
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('error')).toBeCloseTo(0.0);
    expect(interp.getVariable('dose_timer')).toBe(0);

    // Negatif: pompa çalışmamalı
    expect(interp.getVariable('pump_active')).not.toBe(true);
  });

  // ── Senaryo 5: Overdose alarm (301 cycle sonra) ────────────────────────

  it('Senaryo 5: 301 cycle sonra overdose alarmı tetiklenmeli', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.0); // error = 1.0, sürekli dozlama

    // 300 cycle: dose_timer = 300, alarm yok
    for (let i = 0; i < 300; i++) {
      interp.runCycle();
    }

    // 300. cycle'da dose_timer = 300, max_dose_time = 300
    // dose_timer > max_dose_time → 300 > 300 = FALSE → alarm henüz yok
    expect(interp.getVariable('dose_timer')).toBe(300);
    expect(interp.getVariable('alarm')).toBe(false);

    // 301. cycle: dose_timer = 301, 301 > 300 = TRUE → alarm!
    interp.runCycle();
    expect(interp.getVariable('alarm')).toBe(true);
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('dose_timer')).toBe(301);

    // Negatif: 300. cycle'da alarm olmamalıydı (yukarıda kontrol edildi)
  });

  // ── Senaryo 6: Stop komutu timer'ı sıfırlar ───────────────────────────

  it('Senaryo 6: Stop komutu dose_timer\'ı sıfırlamalı ve pompayı kapatmalı', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.0);

    // 50 cycle çalıştır
    for (let i = 0; i < 50; i++) {
      interp.runCycle();
    }
    // Pozitif: 50 cycle sonra timer = 50
    expect(interp.getVariable('dose_timer')).toBe(50);
    expect(interp.getVariable('pump_active')).toBe(true);

    // Stop komutu ver
    interp.setVariable('start_command', false);
    interp.runCycle();

    // Pozitif: timer sıfırlanmalı
    expect(interp.getVariable('dose_timer')).toBe(0);
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);

    // Negatif: alarm olmamalı (max_dose_time'a ulaşılmadı)
    expect(interp.getVariable('alarm')).toBe(false);
  });

  // ── Senaryo 7: Variable info doğru metadata döner ─────────────────────

  it('Senaryo 7: getVariableInfo doğru scope, tip ve değer bilgisi dönmeli', () => {
    const info = interp.getVariableInfo();

    // Toplam 9 değişken olmalı (3 input + 3 output + 3 lokal)
    expect(info).toHaveLength(9);

    // VAR_INPUT kontrolü
    const inputs = info.filter(v => v.scope === 'VAR_INPUT');
    expect(inputs).toHaveLength(3);
    expect(inputs.map(v => v.name)).toEqual(
      expect.arrayContaining(['start_command', 'ph_value', 'ph_setpoint']),
    );

    const startCmdInfo = inputs.find(v => v.name === 'start_command');
    expect(startCmdInfo?.dataType).toBe('BOOL');
    expect(startCmdInfo?.value).toBe(false); // default

    const phSetpointInfo = inputs.find(v => v.name === 'ph_setpoint');
    expect(phSetpointInfo?.dataType).toBe('REAL');
    expect(phSetpointInfo?.value).toBeCloseTo(7.0); // initial value

    // VAR_OUTPUT kontrolü
    const outputs = info.filter(v => v.scope === 'VAR_OUTPUT');
    expect(outputs).toHaveLength(3);
    expect(outputs.map(v => v.name)).toEqual(
      expect.arrayContaining(['pump_active', 'valve_open', 'alarm']),
    );

    // VAR kontrolü
    const locals = info.filter(v => v.scope === 'VAR');
    expect(locals).toHaveLength(3);
    expect(locals.map(v => v.name)).toEqual(
      expect.arrayContaining(['error', 'dose_timer', 'max_dose_time']),
    );

    const maxDoseInfo = locals.find(v => v.name === 'max_dose_time');
    expect(maxDoseInfo?.dataType).toBe('INT');
    expect(maxDoseInfo?.value).toBe(300);

    // Negatif: VAR_IN_OUT veya VAR_GLOBAL olmamalı
    const inouts = info.filter(v => v.scope === 'VAR_IN_OUT');
    expect(inouts).toHaveLength(0);
    const globals = info.filter(v => v.scope === 'VAR_GLOBAL');
    expect(globals).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Ekstra Senaryolar (Edge Cases)
  // ═══════════════════════════════════════════════════════════════════════

  // ── Senaryo 8: pH setpoint değişikliği mid-simulation ──────────────────

  it('Senaryo 8: Simülasyon ortasında ph_setpoint değiştiğinde pompa davranışı güncellenmeli', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.8);
    interp.setVariable('ph_setpoint', 7.0);

    // İlk 10 cycle: error = 7.0 - 6.8 = 0.2, 0.1 < 0.2 < 0.5
    // → pump_active=TRUE, valve_open=FALSE
    for (let i = 0; i < 10; i++) {
      interp.runCycle();
    }

    expect(interp.getVariable('pump_active')).toBe(true);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('error')).toBeCloseTo(0.2);
    expect(interp.getVariable('dose_timer')).toBe(10);

    // Setpoint'i 8.0'e yükselt → error = 8.0 - 6.8 = 1.2 > 0.5
    // → pump_active=TRUE, valve_open=TRUE (valf de açılmalı)
    interp.setVariable('ph_setpoint', 8.0);
    interp.runCycle();

    expect(interp.getVariable('error')).toBeCloseTo(1.2);
    expect(interp.getVariable('pump_active')).toBe(true);
    expect(interp.getVariable('valve_open')).toBe(true);
    expect(interp.getVariable('dose_timer')).toBe(11); // timer devam ediyor

    // Negatif: Setpoint düşürülünce error küçülmeli
    interp.setVariable('ph_setpoint', 6.85);
    interp.runCycle();

    // error = 6.85 - 6.8 = 0.05 < 0.1 → ELSE dalı, pompa kapanmalı
    expect(interp.getVariable('error')).toBeCloseTo(0.05);
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('dose_timer')).toBe(0); // sıfırlanmalı
  });

  // ── Senaryo 9: Sınır değer — error tam 0.5 ────────────────────────────

  it('Senaryo 9: error tam 0.5 olduğunda > 0.5 FALSE, > 0.1 TRUE olmalı → pompa açık, valf kapalı', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.5);    // error = 7.0 - 6.5 = 0.5
    interp.setVariable('ph_setpoint', 7.0);
    interp.runCycle();

    // error = 0.5: "error > 0.5" → FALSE (0.5 > 0.5 yanlış)
    // "error > 0.1" → TRUE (0.5 > 0.1 doğru)
    // → ELSIF ikinci dal: pump_active=TRUE, valve_open=FALSE
    expect(interp.getVariable('error')).toBeCloseTo(0.5);
    expect(interp.getVariable('pump_active')).toBe(true);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('dose_timer')).toBe(1);

    // Negatif: valf açık OLMAMALI (boundary'de)
    expect(interp.getVariable('valve_open')).not.toBe(true);

    // Pozitif kontrol: 0.5'in hemen üstü (0.50001) valf açmalı
    const { ast: ast2 } = parseST(DOSING_PUMP_CODE);
    const interp2 = new StInterpreter(ast2[0]);
    interp2.setVariable('start_command', true);
    interp2.setVariable('ph_value', 6.49999); // error = 7.0 - 6.49999 = 0.50001
    interp2.setVariable('ph_setpoint', 7.0);
    interp2.runCycle();

    expect(interp2.getVariable('error')).toBeCloseTo(0.50001, 4);
    expect(interp2.getVariable('pump_active')).toBe(true);
    expect(interp2.getVariable('valve_open')).toBe(true); // > 0.5 TRUE
  });

  // ── Senaryo 10: Sınır değer — error tam 0.1 ───────────────────────────

  it('Senaryo 10: error tam 0.1 olduğunda > 0.1 FALSE olmalı → pompa kapalı', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.9);    // error = 7.0 - 6.9 = 0.1
    interp.setVariable('ph_setpoint', 7.0);
    interp.runCycle();

    // error = 0.1: "error > 0.5" → FALSE
    //              "error > 0.1" → FALSE (0.1 > 0.1 yanlış)
    // → ELSE dalı: pump_active=FALSE, valve_open=FALSE
    expect(interp.getVariable('error')).toBeCloseTo(0.1);
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('dose_timer')).toBe(0);

    // Negatif: pompa kapalı olmalı
    expect(interp.getVariable('pump_active')).not.toBe(true);

    // Pozitif kontrol: 0.1'in hemen üstü (0.10001) pompa açmalı
    const { ast: ast2 } = parseST(DOSING_PUMP_CODE);
    const interp2 = new StInterpreter(ast2[0]);
    interp2.setVariable('start_command', true);
    interp2.setVariable('ph_value', 6.89999); // error = 7.0 - 6.89999 = 0.10001
    interp2.setVariable('ph_setpoint', 7.0);
    interp2.runCycle();

    expect(interp2.getVariable('error')).toBeCloseTo(0.10001, 4);
    expect(interp2.getVariable('pump_active')).toBe(true);
    expect(interp2.getVariable('valve_open')).toBe(false); // 0.10001 > 0.1 ama ≤ 0.5
  });

  // ── Senaryo 11: Alarm sonrası reset — alarm latch ──────────────────────

  it('Senaryo 11: 301 cycle sonra alarm latch\'lenmeli, stop sonrası timer sıfırlansa da alarm TRUE kalmalı', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.0); // error = 1.0 > 0.5

    // 301 cycle çalıştır → alarm tetiklenir
    for (let i = 0; i < 301; i++) {
      interp.runCycle();
    }
    expect(interp.getVariable('alarm')).toBe(true);
    expect(interp.getVariable('dose_timer')).toBe(301);

    // Stop komutu ver → timer sıfırlanır ama alarm TRUE kalmalı
    // (çünkü programda alarm'ı FALSE yapan bir mekanizma yok)
    interp.setVariable('start_command', false);
    interp.runCycle();

    // Pozitif: dose_timer = 0 (stop tarafından sıfırlandı)
    expect(interp.getVariable('dose_timer')).toBe(0);
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);

    // Pozitif: alarm TRUE kalmalı — latch davranışı
    // ST programında alarm'ı FALSE yapan bir satır yok,
    // alarm sadece "dose_timer > max_dose_time" olduğunda TRUE'ya çekilir
    // dose_timer 0'a düştüğünde "dose_timer > max_dose_time" FALSE olur
    // ama alarm := TRUE satırı çalışmaz, alarm eski değerini korur
    expect(interp.getVariable('alarm')).toBe(true);

    // Birkaç cycle daha stop ile çalıştır, alarm hala TRUE
    for (let i = 0; i < 5; i++) {
      interp.runCycle();
    }
    expect(interp.getVariable('alarm')).toBe(true);
    expect(interp.getVariable('dose_timer')).toBe(0);

    // Negatif: alarm asla kendiliğinden FALSE olmaz
    expect(interp.getVariable('alarm')).not.toBe(false);
  });

  // ── Senaryo 12: Multi-program — bağımsız interpreter izolasyonu ────────

  it('Senaryo 12: İki farklı program parse edildiğinde state birbirinden bağımsız olmalı', () => {
    // Program 1: DosingPump
    const { ast: ast1, errors: errors1 } = parseST(DOSING_PUMP_CODE);
    expect(errors1).toHaveLength(0);
    const interp1 = new StInterpreter(ast1[0]);

    // Program 2: SimpleCounter
    const { ast: ast2, errors: errors2 } = parseST(SIMPLE_COUNTER_CODE);
    expect(errors2).toHaveLength(0);
    const interp2 = new StInterpreter(ast2[0]);

    // Program 1 çalıştır
    interp1.setVariable('start_command', true);
    interp1.setVariable('ph_value', 6.0);
    interp1.runCycle();

    // Program 2 çalıştır
    interp2.setVariable('enable', true);
    interp2.runCycle();

    // Program 1 çıkışları doğru olmalı
    expect(interp1.getVariable('pump_active')).toBe(true);
    expect(interp1.getVariable('valve_open')).toBe(true);
    expect(interp1.getVariable('dose_timer')).toBe(1);

    // Program 2 çıkışları doğru olmalı
    expect(interp2.getVariable('count')).toBe(1);
    expect(interp2.getVariable('internal')).toBe(1);

    // Negatif: Program 1'in değişkenleri Program 2'de olmamalı
    expect(interp2.getVariable('pump_active')).toBeUndefined();
    expect(interp2.getVariable('ph_value')).toBeUndefined();

    // Negatif: Program 2'nin değişkenleri Program 1'de olmamalı
    expect(interp1.getVariable('count')).toBeUndefined();
    expect(interp1.getVariable('enable')).toBeUndefined();

    // 5 cycle daha çalıştır — birbirini etkilememeliler
    for (let i = 0; i < 5; i++) {
      interp1.runCycle();
      interp2.runCycle();
    }

    // Program 1: 6 cycle total → dose_timer = 6
    expect(interp1.getVariable('dose_timer')).toBe(6);

    // Program 2: 6 cycle total → count = 6
    expect(interp2.getVariable('count')).toBe(6);
    expect(interp2.getVariable('internal')).toBe(6);

    // Pozitif: reset() sadece kendi state'ini etkiler
    interp1.reset();
    expect(interp1.getVariable('dose_timer')).toBe(0);
    expect(interp1.getVariable('pump_active')).toBe(false);

    // Program 2 etkilenmemeli
    expect(interp2.getVariable('count')).toBe(6);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// BONUS: Fan Coil Unit Testi
// ═════════════════════════════════════════════════════════════════════════

describe('Fan Coil Unit E2E Simülasyonu (BONUS)', () => {
  let interp: StInterpreter;

  beforeEach(() => {
    const { ast, errors } = parseST(FAN_COIL_UNIT_CODE);
    expect(errors).toHaveLength(0);
    expect(ast).toHaveLength(1);
    expect(ast[0].kind).toBe('program');
    interp = new StInterpreter(ast[0]);
  });

  it('enable=false iken fan ve valf kapalı olmalı', () => {
    interp.setVariable('enable', false);
    interp.setVariable('room_temp', 30.0);
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    // Pozitif: enable=false → fan_speed=0, valve_pos=0
    expect(interp.getVariable('fan_speed')).toBe(0);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(0.0);

    // Negatif: sıcaklık yüksek olsa bile enable false ise çıkışlar 0
    expect(interp.getVariable('fan_speed')).not.toBe(3);
  });

  it('enable=true, yüksek sıcaklık (error > 3.0) → fan_speed=3, valve_pos=100.0', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 26.0);  // error = 26.0 - 22.0 = 4.0 > 3.0
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    // Pozitif: error > 3.0 → max fan ve max valf
    expect(interp.getVariable('fan_speed')).toBe(3);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(100.0);
    expect(interp.getVariable('error')).toBeCloseTo(4.0);
  });

  it('enable=true, orta sıcaklık (error > 1.5) → fan_speed=2, valve_pos=70.0', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 24.0);  // error = 24.0 - 22.0 = 2.0 > 1.5
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    expect(interp.getVariable('fan_speed')).toBe(2);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(70.0);
    expect(interp.getVariable('error')).toBeCloseTo(2.0);

    // Negatif: max fan olmamalı
    expect(interp.getVariable('fan_speed')).not.toBe(3);
  });

  it('enable=true, hafif sıcaklık (error > 0.5) → fan_speed=1, valve_pos=40.0', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 23.0);  // error = 23.0 - 22.0 = 1.0 > 0.5
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    expect(interp.getVariable('fan_speed')).toBe(1);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(40.0);
    expect(interp.getVariable('error')).toBeCloseTo(1.0);

    // Negatif: medium fan olmamalı
    expect(interp.getVariable('fan_speed')).not.toBe(2);
  });

  it('enable=true, sıcaklık setpoint\'te (error ≤ 0.5) → fan ve valf kapalı', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 22.3);  // error = 22.3 - 22.0 = 0.3 ≤ 0.5
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    expect(interp.getVariable('fan_speed')).toBe(0);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(0.0);
    expect(interp.getVariable('error')).toBeCloseTo(0.3);

    // Negatif: fan çalışmamalı
    expect(interp.getVariable('fan_speed')).not.toBe(1);
  });

  it('Sınır değer: error tam 3.0 → fan_speed=2 (> 3.0 FALSE, > 1.5 TRUE)', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 25.0);  // error = 25.0 - 22.0 = 3.0
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    // error = 3.0: "error > 3.0" → FALSE (3.0 > 3.0 yanlış)
    // "error > 1.5" → TRUE
    expect(interp.getVariable('error')).toBeCloseTo(3.0);
    expect(interp.getVariable('fan_speed')).toBe(2);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(70.0);

    // Negatif: fan_speed 3 olmamalı (tam boundary'de)
    expect(interp.getVariable('fan_speed')).not.toBe(3);
  });

  it('Sınır değer: error tam 1.5 → fan_speed=1 (> 1.5 FALSE, > 0.5 TRUE)', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 23.5);  // error = 23.5 - 22.0 = 1.5
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    expect(interp.getVariable('error')).toBeCloseTo(1.5);
    expect(interp.getVariable('fan_speed')).toBe(1);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(40.0);

    // Negatif: fan_speed 2 olmamalı
    expect(interp.getVariable('fan_speed')).not.toBe(2);
  });

  it('Sınır değer: error tam 0.5 → fan_speed=0 (> 0.5 FALSE)', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 22.5);  // error = 22.5 - 22.0 = 0.5
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    // error = 0.5: "error > 0.5" → FALSE → ELSE → fan kapalı
    expect(interp.getVariable('error')).toBeCloseTo(0.5);
    expect(interp.getVariable('fan_speed')).toBe(0);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(0.0);
  });

  it('Negatif error (oda serin) → fan ve valf kapalı', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 20.0);  // error = 20.0 - 22.0 = -2.0 ≤ 0.5
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    expect(interp.getVariable('error')).toBeCloseTo(-2.0);
    expect(interp.getVariable('fan_speed')).toBe(0);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(0.0);
  });

  it('Setpoint mid-simulation değişikliği → fan hızı güncellenmeli', () => {
    interp.setVariable('enable', true);
    interp.setVariable('room_temp', 26.0);
    interp.setVariable('setpoint', 22.0);
    interp.runCycle();

    // error = 4.0 > 3.0 → fan_speed=3
    expect(interp.getVariable('fan_speed')).toBe(3);

    // Setpoint'i 25.0'e yükselt → error = 26.0 - 25.0 = 1.0
    interp.setVariable('setpoint', 25.0);
    interp.runCycle();

    // error = 1.0 > 0.5 → fan_speed=1
    expect(interp.getVariable('error')).toBeCloseTo(1.0);
    expect(interp.getVariable('fan_speed')).toBe(1);
    expect(interp.getVariable('valve_pos')).toBeCloseTo(40.0);
  });

  it('Variable info doğru metadata dönmeli', () => {
    const info = interp.getVariableInfo();

    // 6 değişken: 3 input + 2 output + 1 lokal
    expect(info).toHaveLength(6);

    const inputs = info.filter(v => v.scope === 'VAR_INPUT');
    expect(inputs).toHaveLength(3);
    expect(inputs.map(v => v.name)).toEqual(
      expect.arrayContaining(['room_temp', 'setpoint', 'enable']),
    );

    const outputs = info.filter(v => v.scope === 'VAR_OUTPUT');
    expect(outputs).toHaveLength(2);
    expect(outputs.map(v => v.name)).toEqual(
      expect.arrayContaining(['fan_speed', 'valve_pos']),
    );

    const locals = info.filter(v => v.scope === 'VAR');
    expect(locals).toHaveLength(1);
    expect(locals[0].name).toBe('error');
    expect(locals[0].dataType).toBe('REAL');

    // Setpoint varsayılan değeri kontrol et
    const spInfo = inputs.find(v => v.name === 'setpoint');
    expect(spInfo?.value).toBeCloseTo(22.0);
  });
});
