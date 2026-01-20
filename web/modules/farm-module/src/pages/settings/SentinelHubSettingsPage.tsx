/**
 * Sentinel Hub Settings Page
 *
 * Tenant'ın Copernicus Data Space hesap bilgilerini yönettiği sayfa.
 * Client ID ve Client Secret bilgileri backend'de şifrelenerek saklanır.
 */

import React, { useState, useEffect } from 'react';
import { Card, Button, Input, Alert } from '@aquaculture/shared-ui';

// GraphQL queries/mutations
const SENTINEL_HUB_STATUS_QUERY = `
  query SentinelHubStatus {
    sentinelHubStatus {
      isConfigured
      clientIdMasked
      instanceIdMasked
      lastUsed
      usageCount
    }
  }
`;

const SAVE_SENTINEL_HUB_SETTINGS = `
  mutation SaveSentinelHubSettings($clientId: String!, $clientSecret: String!, $instanceId: String) {
    saveSentinelHubSettings(clientId: $clientId, clientSecret: $clientSecret, instanceId: $instanceId)
  }
`;

const DELETE_SENTINEL_HUB_SETTINGS = `
  mutation DeleteSentinelHubSettings {
    deleteSentinelHubSettings
  }
`;

interface SettingsStatus {
  isConfigured: boolean;
  clientIdMasked: string | null;
  instanceIdMasked: string | null;
  lastUsed: string | null;
  usageCount: number;
}

export const SentinelHubSettingsPage: React.FC = () => {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch current status on mount
  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    setIsStatusLoading(true);
    try {
      const token = localStorage.getItem('access_token');
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: SENTINEL_HUB_STATUS_QUERY }),
      });
      const result = await response.json();
      if (result.data?.sentinelHubStatus) {
        setStatus(result.data.sentinelHubStatus);
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
    } finally {
      setIsStatusLoading(false);
    }
  };

  const handleSave = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Lutfen Client ID ve Client Secret alanlarini doldurun');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const token = localStorage.getItem('access_token');
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: SAVE_SENTINEL_HUB_SETTINGS,
          variables: {
            clientId: clientId.trim(),
            clientSecret: clientSecret.trim(),
            instanceId: instanceId.trim() || null,
          },
        }),
      });

      const result = await response.json();
      if (result.errors) {
        throw new Error(result.errors[0].message);
      }

      setSuccess('Sentinel Hub ayarlari basariyla kaydedildi');
      setClientId('');
      setClientSecret('');
      setInstanceId('');
      fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydetme hatasi');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Sentinel Hub ayarlarini silmek istediginize emin misiniz?')) {
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const token = localStorage.getItem('access_token');
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: DELETE_SENTINEL_HUB_SETTINGS }),
      });

      const result = await response.json();
      if (result.errors) {
        throw new Error(result.errors[0].message);
      }

      setSuccess('Ayarlar silindi');
      fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Silme hatasi');
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Hic';
    return new Date(dateStr).toLocaleString('tr-TR');
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Sentinel Hub Ayarlari</h1>

      {/* Info Card */}
      <Card className="mb-6 p-4 bg-blue-50 border-blue-200">
        <h3 className="font-medium text-blue-900 mb-2">Sentinel Hub Nedir?</h3>
        <p className="text-sm text-blue-700 mb-3">
          Sentinel Hub, Copernicus uydu goruntulerine erisim saglayan bir API'dir.
          Harita uzerinde uydu goruntuleri, su kalitesi analizi ve diger katmanlari
          gorebilmek icin bir Copernicus Data Space hesabi gereklidir.
        </p>
        <a
          href="https://dataspace.copernicus.eu/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          <span>Copernicus Data Space'e kaydol (ucretsiz)</span>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </Card>

      {/* Current Status */}
      <Card className="mb-6 p-4">
        <h3 className="font-medium text-gray-900 mb-4">Mevcut Durum</h3>

        {isStatusLoading ? (
          <div className="flex items-center gap-2 text-gray-500">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Yukleniyor...</span>
          </div>
        ) : status?.isConfigured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-green-500"></span>
              <span className="text-sm font-medium text-green-700">Yapilandirildi</span>
            </div>
            <div className="text-sm text-gray-600 space-y-1">
              <p>
                <span className="text-gray-500">Client ID: </span>
                <code className="bg-gray-100 px-1.5 py-0.5 rounded">{status.clientIdMasked}</code>
              </p>
              <p>
                <span className="text-gray-500">Instance ID (WMTS): </span>
                {status.instanceIdMasked ? (
                  <code className="bg-green-100 text-green-800 px-1.5 py-0.5 rounded">{status.instanceIdMasked}</code>
                ) : (
                  <span className="text-yellow-600">Yapilandirilmadi</span>
                )}
              </p>
              <p>
                <span className="text-gray-500">Son Kullanim: </span>
                {formatDate(status.lastUsed)}
              </p>
              <p>
                <span className="text-gray-500">Toplam Istek: </span>
                {status.usageCount.toLocaleString()}
              </p>
            </div>
            {!status.instanceIdMasked && (
              <div className="p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
                Hizli uydu goruntuleri icin Instance ID gerekli. Asagidaki WMTS kurulum adimlarini izleyin.
              </div>
            )}
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={isLoading}
              className="mt-2"
            >
              Ayarlari Sil
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-gray-400"></span>
            <span className="text-sm text-gray-500">Yapilandirilmadi</span>
          </div>
        )}
      </Card>

      {/* Settings Form */}
      <Card className="p-4">
        <h3 className="font-medium text-gray-900 mb-4">
          {status?.isConfigured ? 'Ayarlari Guncelle' : 'Yeni Ayar Ekle'}
        </h3>

        {error && (
          <Alert type="error" className="mb-4">
            {error}
          </Alert>
        )}
        {success && (
          <Alert type="success" className="mb-4">
            {success}
          </Alert>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Client ID
            </label>
            <Input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Client Secret
            </label>
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="••••••••••••••••"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Instance ID (WMTS) <span className="text-gray-400 font-normal">- Opsiyonel</span>
            </label>
            <Input
              type="text"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="font-mono"
            />
            <p className="mt-1 text-xs text-gray-500">
              Hizli uydu yukleme icin. Sentinel Hub Dashboard'dan Configuration Instance olusturun.
            </p>
          </div>

          <Button onClick={handleSave} disabled={isLoading} className="w-full sm:w-auto">
            {isLoading ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Kaydediliyor...
              </span>
            ) : (
              'Kaydet'
            )}
          </Button>
        </div>

        <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
          <p className="text-xs text-yellow-800">
            <strong>Guvenlik:</strong> Bilgileriniz sifreli olarak saklanir.
            Ucretsiz hesap aylik 10.000 PU (Processing Unit) kotasi sunar.
          </p>
        </div>
      </Card>

      {/* Setup Guide */}
      <Card className="mt-6 p-4">
        <h3 className="font-medium text-gray-900 mb-4">Nasil Yapilandirilir?</h3>
        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-600">
          <li>
            <a
              href="https://dataspace.copernicus.eu/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-600 hover:underline"
            >
              dataspace.copernicus.eu
            </a>{' '}
            adresine gidin
          </li>
          <li>Ucretsiz hesap olusturun veya giris yapin</li>
          <li>Sag ust koseden profil menusune tiklayin</li>
          <li>
            <strong>User Settings</strong> sayfasina gidin
          </li>
          <li>
            <strong>OAuth clients</strong> bolumune gecin
          </li>
          <li>
            <strong>+ Create new</strong> butonuna tiklayin
          </li>
          <li>Client ID ve Client Secret'i kopyalayin</li>
          <li>Yukaridaki forma yapistirin ve kaydedin</li>
        </ol>

        <div className="mt-4 p-3 bg-gray-50 rounded-md">
          <p className="text-xs text-gray-600">
            <strong>Onemli:</strong> Her tenant kendi Copernicus hesabindan sorumludur.
            Aylik 10.000 PU kotasi genellikle yeterlidir (yaklasik 10.000 goruntu istegi).
          </p>
        </div>
      </Card>

      {/* WMTS Setup Guide */}
      <Card className="mt-6 p-4 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
        <h3 className="font-medium text-blue-900 mb-4 flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          WMTS Kurulumu (Hizli Uydu Goruntusu)
        </h3>
        <p className="text-sm text-blue-800 mb-4">
          WMTS ile uydu goruntusu yukleme suresi <strong>2-5 saniyeden 100-200 milisaniyeye</strong> duser.
          Bu ozellik icin Configuration Instance olusturmaniz gerekir.
        </p>
        <ol className="list-decimal list-inside space-y-2 text-sm text-blue-700">
          <li>
            <a
              href="https://shapps.dataspace.copernicus.eu/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline font-medium"
            >
              shapps.dataspace.copernicus.eu
            </a>{' '}
            adresine gidin
          </li>
          <li>Copernicus hesabinizla giris yapin</li>
          <li><strong>Configuration</strong> bolumune gidin</li>
          <li><strong>New Configuration</strong> butonuna tiklayin</li>
          <li>Isim verin (ornegin: "Aquaculture")</li>
          <li>Katmanlari ekleyin:
            <ul className="list-disc list-inside ml-4 mt-1 text-blue-600">
              <li>TRUE-COLOR (Gercek Renk)</li>
              <li>CHLOROPHYLL (Klorofil)</li>
              <li>TURBIDITY (Bulaniklik)</li>
              <li>NDVI, MOISTURE vb.</li>
            </ul>
          </li>
          <li>Kaydedin ve <strong>Instance ID</strong>'yi kopyalayin (UUID formatinda)</li>
          <li>Yukaridaki Instance ID alanina yapistirin</li>
        </ol>

        <div className="mt-4 p-3 bg-white/50 rounded-md">
          <p className="text-xs text-blue-800">
            <strong>Not:</strong> Her katman icin evalscript tanimlamaniz gerekir.
            Varsayilan evalscript'ler icin{' '}
            <a
              href="https://docs.sentinel-hub.com/api/latest/evalscript/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Sentinel Hub Dokumantasyonu
            </a>'na bakin.
          </p>
        </div>
      </Card>

      {/* PU Usage Info */}
      <Card className="mt-6 p-4">
        <h3 className="font-medium text-gray-900 mb-4">PU Kullanim Bilgisi</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="pb-2 text-gray-500">Islem</th>
              <th className="pb-2 text-gray-500">PU/Istek</th>
            </tr>
          </thead>
          <tbody className="text-gray-600">
            <tr className="border-b">
              <td className="py-2">Site uydu goruntusu (512x512)</td>
              <td className="py-2">~1 PU</td>
            </tr>
            <tr className="border-b">
              <td className="py-2">Su kalitesi analizi</td>
              <td className="py-2">~1-2 PU</td>
            </tr>
            <tr className="border-b">
              <td className="py-2">NDVI/Nem analizi</td>
              <td className="py-2">~1-2 PU</td>
            </tr>
            <tr>
              <td className="py-2 font-medium">Aylik ucretsiz kota</td>
              <td className="py-2 font-medium text-green-600">10.000 PU</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default SentinelHubSettingsPage;
