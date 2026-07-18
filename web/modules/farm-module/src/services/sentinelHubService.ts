/**
 * Sentinel layer metadata for the farm map UI.
 *
 * Su kalitesi analizi katmanları:
 * - TRUE-COLOR: Gerçek renk görüntüsü
 * - CHLOROPHYLL: Klorofil-a (fitoplankton)
 * - CYANOBACTERIA: Siyanobakteri (mavi-yeşil alg)
 * - TURBIDITY: Bulanıklık
 * - CDOM: Çözünmüş organik madde
 * - TSS: Askıda katı madde
 * - NDVI: Bitki indeksi
 * - MOISTURE: Nem indeksi
 */

export type LayerType =
  | 'TRUE-COLOR'
  | 'CHLOROPHYLL'
  | 'CYANOBACTERIA'
  | 'TURBIDITY'
  | 'CDOM'
  | 'TSS'
  | 'NDWI'
  | 'SECCHI'
  | 'NDVI'
  | 'MOISTURE';

export interface LayerInfo {
  id: LayerType;
  name: string;
  nameEn: string;
  icon: string;
  category: 'base' | 'water' | 'analysis';
  description: string;
}

// Available layers
export const SENTINEL_LAYERS: LayerInfo[] = [
  // Base layers
  {
    id: 'TRUE-COLOR',
    name: 'Gerçek Renk',
    nameEn: 'True Color',
    icon: '🌍',
    category: 'base',
    description: 'RGB görüntü - B04, B03, B02 bantları',
  },

  // Water quality layers (Aquaculture için kritik!)
  {
    id: 'CHLOROPHYLL',
    name: 'Klorofil-a',
    nameEn: 'Chlorophyll-a',
    icon: '🌿',
    category: 'water',
    description: 'Fitoplankton yoğunluğu göstergesi (mg/m³)',
  },
  {
    id: 'TURBIDITY',
    name: 'Bulanıklık',
    nameEn: 'Turbidity',
    icon: '🌫️',
    category: 'water',
    description: 'Su berraklığı ölçümü (NTU)',
  },
  {
    id: 'NDWI',
    name: 'Su İndeksi',
    nameEn: 'NDWI',
    icon: '💧',
    category: 'water',
    description: 'Normalized Difference Water Index - Su kütlesi tespiti',
  },
];

/**
 * Get layer legend info
 */
export function getLayerLegend(layer: LayerType): { color: string; label: string }[] {
  const legends: Record<LayerType, { color: string; label: string }[]> = {
    'TRUE-COLOR': [],
    'CHLOROPHYLL': [
      { color: 'rgb(26, 77, 204)', label: '< 5 mg/m³ (Düşük)' },
      { color: 'rgb(51, 153, 204)', label: '5-10 mg/m³' },
      { color: 'rgb(77, 204, 77)', label: '10-20 mg/m³' },
      { color: 'rgb(204, 204, 51)', label: '20-50 mg/m³' },
      { color: 'rgb(230, 128, 26)', label: '50-100 mg/m³' },
      { color: 'rgb(230, 51, 51)', label: '> 100 mg/m³ (Bloom!)' },
    ],
    'CYANOBACTERIA': [
      { color: 'rgb(26, 102, 204)', label: '< 10K cells/ml (Güvenli)' },
      { color: 'rgb(77, 179, 102)', label: '10K-50K cells/ml' },
      { color: 'rgb(230, 230, 51)', label: '50K-100K cells/ml (Dikkat)' },
      { color: 'rgb(230, 128, 26)', label: '100K-500K cells/ml (Uyarı)' },
      { color: 'rgb(230, 26, 26)', label: '> 500K cells/ml (TEHLİKE!)' },
    ],
    'TURBIDITY': [
      { color: 'rgb(26, 128, 230)', label: '< 5 NTU (Berrak)' },
      { color: 'rgb(77, 179, 204)', label: '5-10 NTU' },
      { color: 'rgb(128, 204, 128)', label: '10-25 NTU' },
      { color: 'rgb(204, 179, 77)', label: '25-50 NTU' },
      { color: 'rgb(204, 128, 51)', label: '50-100 NTU' },
      { color: 'rgb(153, 102, 77)', label: '> 100 NTU (Çok Bulanık)' },
    ],
    'CDOM': [
      { color: 'rgb(51, 153, 230)', label: '< 0.1 (Düşük)' },
      { color: 'rgb(102, 179, 153)', label: '0.1-0.3' },
      { color: 'rgb(153, 153, 77)', label: '0.3-0.5' },
      { color: 'rgb(128, 77, 26)', label: '> 0.5 (Yüksek)' },
    ],
    'TSS': [
      { color: 'rgb(26, 102, 204)', label: '< 10 mg/L (Temiz)' },
      { color: 'rgb(77, 153, 179)', label: '10-25 mg/L' },
      { color: 'rgb(128, 179, 102)', label: '25-50 mg/L' },
      { color: 'rgb(179, 153, 77)', label: '50-100 mg/L' },
      { color: 'rgb(153, 102, 51)', label: '> 100 mg/L (Yüksek)' },
    ],
    'NDWI': [
      { color: 'rgb(0, 51, 204)', label: '> 0.5 (Derin Su)' },
      { color: 'rgb(26, 102, 230)', label: '0.3-0.5 (Su)' },
      { color: 'rgb(77, 153, 230)', label: '0.1-0.3 (Sığ Su)' },
      { color: 'rgb(128, 204, 230)', label: '0-0.1 (Su Kenarı)' },
      { color: 'rgb(204, 230, 179)', label: '-0.2-0 (Nemli)' },
      { color: 'rgb(153, 128, 102)', label: '< -0.2 (Kara)' },
    ],
    'SECCHI': [
      { color: 'rgb(0, 77, 230)', label: '> 10m (Çok Berrak)' },
      { color: 'rgb(26, 128, 230)', label: '5-10m (Berrak)' },
      { color: 'rgb(77, 179, 204)', label: '2-5m (Orta)' },
      { color: 'rgb(128, 204, 128)', label: '1-2m (Düşük)' },
      { color: 'rgb(204, 179, 77)', label: '0.5-1m (Bulanık)' },
      { color: 'rgb(153, 102, 51)', label: '< 0.5m (Çok Bulanık)' },
    ],
    'NDVI': [
      { color: 'rgb(128, 0, 0)', label: '< 0 (Su/Çıplak)' },
      { color: 'rgb(204, 102, 51)', label: '0-0.2' },
      { color: 'rgb(255, 204, 0)', label: '0.2-0.4' },
      { color: 'rgb(153, 230, 51)', label: '0.4-0.6' },
      { color: 'rgb(26, 153, 26)', label: '> 0.6 (Yoğun Bitki)' },
    ],
    'MOISTURE': [
      { color: 'rgb(204, 51, 51)', label: '< -0.4 (Çok Kuru)' },
      { color: 'rgb(230, 153, 77)', label: '-0.4 - 0' },
      { color: 'rgb(255, 230, 128)', label: '0 - 0.2' },
      { color: 'rgb(128, 204, 128)', label: '0.2 - 0.4' },
      { color: 'rgb(51, 102, 204)', label: '> 0.4 (Çok Nemli)' },
    ],
  };

  return legends[layer] || [];
}
