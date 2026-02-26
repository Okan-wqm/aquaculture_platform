/**
 * EquipmentNodeOverlay — Canlı I/O Değer Gösterimi (Kemik Yapı — Faz B)
 * -----------------------------------------------------------------------
 * Equipment node'unun üzerine overlay olarak I/O durumlarını render eder.
 *
 * NASIL ÇALIŞIR:
 *   1. ioBindings prop'u üzerinden node'a bağlı I/O tag'lerini alır
 *   2. WebSocket (useSensorSocket) veya polling ile canlı değer günceller
 *   3. DI/DO tag'leri → yeşil/kırmızı LED ikonu (boolean)
 *   4. AI/AO tag'leri → numerik değer badge'i (float)
 *
 * NEDEN AYRI COMPONENT:
 *   - EquipmentNode memo'lu, overlay'in re-render'ı node'u etkilememeli
 *   - Lightweight: sadece badge render, ağır computation yok
 *   - Test edilebilirlik: izole component kolay test edilir
 *
 * BAĞIMLILIKLAR:
 *   - IoBinding interface (processStore.ts'den)
 *   - Şimdilik statik render, WebSocket entegrasyonu Faz F sonrası aktif olacak
 * -----------------------------------------------------------------------
 */

import React, { useState } from 'react';
import { IoBinding } from '../../../store/processStore';

interface EquipmentNodeOverlayProps {
  ioBindings: IoBinding[];
  edgeDeviceCode?: string;
}

/**
 * Tek bir I/O tag'inin canlı değerini gösteren badge component.
 * DI/DO → LED ikonu (yeşil=ON, kırmızı=OFF)
 * AI/AO → numerik değer gösterimi
 *
 * Tailwind sınıfları kullanılır — inline style yerine tutarlılık için.
 * Renk paleti: green-500/red-500 (LED), green-100/red-100 (bg)
 */
const IoBadge: React.FC<{
  binding: IoBinding;
  liveValue?: number | boolean | null;
}> = ({ binding, liveValue }) => {
  const isDigital = binding.ioType === 'DI' || binding.ioType === 'DO';
  const isOutput = binding.ioType === 'DO' || binding.ioType === 'AO';

  if (isDigital) {
    // Boolean tag → LED ikonu
    const isOn = liveValue === true || liveValue === 1;
    return (
      <div
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
          isOn ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
        }`}
        title={`${binding.tagName} (${binding.ioType}): ${isOn ? 'ON' : 'OFF'}`}
      >
        {/* LED ikonu — dolu daire: ON, boş daire: OFF
            Aktif output'larda Tailwind animate-pulse kullanılır */}
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            isOn ? 'bg-green-500' : 'bg-red-500'
          } ${isOn && isOutput ? 'animate-pulse' : ''}`}
        />
        <span className="truncate max-w-[50px]">{binding.tagName}</span>
      </div>
    );
  }

  // Analog tag → numerik değer
  const displayValue =
    liveValue != null
      ? typeof liveValue === 'number'
        ? liveValue.toFixed(1)
        : String(liveValue)
      : '—';

  return (
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-800"
      title={`${binding.tagName} (${binding.ioType}): ${displayValue}`}
    >
      <span className="truncate max-w-[40px]">{binding.tagName}</span>
      <span className="font-mono">{displayValue}</span>
    </div>
  );
};

/**
 * Equipment node'u üzerine I/O tag badge'lerini render eden overlay.
 * Node'un alt kısmında yatay olarak dizilir.
 */
export const EquipmentNodeOverlay: React.FC<EquipmentNodeOverlayProps> = ({
  ioBindings,
  edgeDeviceCode,
}) => {
  // -----------------------------------------------------------------------
  // Canlı I/O değerleri state'i
  // Şimdilik boş başlatıyoruz — WebSocket entegrasyonu Faz F'den sonra
  // aktif olacak. Edge agent'ın gönderdiği 'EdgeDeviceIoData' event'leri
  // bu state'i güncelleyecek.
  // -----------------------------------------------------------------------
  const [liveValues] = useState<Record<string, number | boolean | null>>({});

  // TODO (Faz F sonrası): WebSocket'ten gelen EdgeDeviceIoData event'lerini dinle
  // useEffect(() => {
  //   if (!edgeDeviceCode) return;
  //   // Socket.IO veya EventSource ile dinleme
  //   // event.tags → { tagName: { value, quality } }
  // }, [edgeDeviceCode]);

  // Maksimum 4 badge göster (node küçük olduğu için)
  const visibleBindings = ioBindings.slice(0, 4);
  const hiddenCount = ioBindings.length - visibleBindings.length;

  return (
    <div className="mt-1 flex flex-wrap gap-0.5 justify-center">
      {visibleBindings.map((binding) => (
        <IoBadge
          key={binding.ioConfigId}
          binding={binding}
          liveValue={liveValues[binding.tagName] ?? null}
        />
      ))}
      {/* Gizlenen tag sayısını göster */}
      {hiddenCount > 0 && (
        <span className="text-[9px] text-gray-400 self-center">
          +{hiddenCount}
        </span>
      )}
    </div>
  );
};

export default EquipmentNodeOverlay;
