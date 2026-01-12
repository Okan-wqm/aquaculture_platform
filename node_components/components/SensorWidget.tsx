import { useState, useEffect, useRef } from 'react';
import mqtt from 'mqtt';
import type { ReactElement } from 'react';
import type { NodeProps } from 'reactflow';

export interface SensorWidgetData {
  label?:        string;
  widgetName?:   string;
  subtitle?:     string;
  unit?:         string;
  value?:        number | string;
  scaleMax?:     number;
  lowThreshold?: number;
  highThreshold?: number;
  mode?:         'push' | 'poll' | 'onChange';
  mqttUrl?:      string;
  mqttTopic?:    string;
  httpUrl?:      string;
  pollInterval?: number;
}

export default function SensorWidget(
  props: NodeProps<SensorWidgetData>
): ReactElement {
  const { data } = props;
  const [value, setValue] = useState<number>(Number(data.value) || 0);
  const etagRef = useRef<string>('');

  /* MQTT Push */
  useEffect(() => {
    if (data.mode !== 'push' || !data.mqttUrl || !data.mqttTopic) return;
    const client = mqtt.connect(data.mqttUrl, {
      protocol: 'ws',
      reconnectPeriod: 2000
    });
    client.on('connect', () => client.subscribe(data.mqttTopic!));
    client.on('message', (_, msg) => {
      const num = parseFloat(msg.toString());
      setValue(isNaN(num) ? 0 : num);
    });
    return () => { client.end(); };
  }, [data.mode, data.mqttUrl, data.mqttTopic]);

  /* HTTP Poll */
  useEffect(() => {
    if (data.mode !== 'poll' || !data.httpUrl) return;
    let cancelled = false;
    const fetchIt = async () => {
      try {
        const res = await fetch(data.httpUrl!);
        const j   = await res.json();
        const raw = j.field1 ?? j.value ?? j;
        const num = typeof raw === 'number'
          ? raw
          : parseFloat(String(raw));
        if (!cancelled) setValue(isNaN(num) ? 0 : num);
      } catch (e) {
        console.error(e);
      }
    };
    fetchIt();
    const id = setInterval(fetchIt, (data.pollInterval ?? 5) * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [data.mode, data.httpUrl, data.pollInterval]);

  /* HTTP OnChange */
  useEffect(() => {
    if (data.mode !== 'onChange' || !data.httpUrl) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(data.httpUrl!, {
          headers: etagRef.current
            ? { 'If-None-Match': etagRef.current }
            : {}
        });
        if (res.status === 304) return;
        etagRef.current = res.headers.get('ETag') ?? etagRef.current;
        const j   = await res.json();
        const raw = j.field1 ?? j.value ?? j;
        const num = typeof raw === 'number'
          ? raw
          : parseFloat(String(raw));
        if (!cancelled) setValue(isNaN(num) ? 0 : num);
      } catch (e) {
        console.error(e);
      }
    };
    check();
    const id = setInterval(check, (data.pollInterval ?? 10) * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [data.mode, data.httpUrl, data.pollInterval]);

  /* Görsel */
  const W       = 300,
        H       = 200,
        BW      = 160,
        barX    = (W - BW) / 2,
        barY    = 140,
        pct     = Math.min(100, Math.max(0, (value / (data.scaleMax ?? 100)) * 100)),
        fillW   = (BW * pct) / 100,
        lowX    = barX + BW * ((data.lowThreshold  ?? 25) / 100),
        highX   = barX + BW * ((data.highThreshold ?? 75) / 100),
        display = value.toFixed(2),
        title   = data.label || '— Başlık Yok —';

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* …defs ve önceki sürümle aynı… */}
      <text x="50%" y="40"  textAnchor="middle" className="title">{title}</text>
      <text x="50%" y="100" textAnchor="middle" className="value">{display}</text>
      <text x="50%" y="120" textAnchor="middle" className="unit">{data.unit}</text>
      <rect x={barX} y={barY} width={BW} height="12" className="bar-bg" />
      <rect x={barX} y={barY} width={fillW} height="12" className="bar-fill" />
      <line x1={lowX} y1={barY} x2={lowX} y2={barY + 12} className="threshold" />
      <line x1={highX} y1={barY} x2={highX} y2={barY + 12} className="threshold" />
      <text x="50%" y="185" textAnchor="middle" className="subtitle">
        {data.subtitle?.trim() || 'Scale'}
      </text>
    </svg>
  );
}
