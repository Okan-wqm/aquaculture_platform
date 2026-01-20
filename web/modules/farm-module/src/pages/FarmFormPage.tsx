/**
 * Farm Form Page
 *
 * Çiftlik ekleme ve düzenleme formu.
 */

import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Card,
  Button,
  Input,
  Textarea,
  Select,
  Alert,
  required,
  minLength,
  validateField,
} from '@aquaculture/shared-ui';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface FarmFormData {
  name: string;
  type: 'tank' | 'cage' | 'pond' | '';
  location: string;
  latitude: string;
  longitude: string;
  capacity: string;
  species: string;
  description: string;
}

// ============================================================================
// Farm Form Page
// ============================================================================

const FarmFormPage: React.FC = () => {
  const { farmId } = useParams<{ farmId: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(farmId);

  const [formData, setFormData] = useState<FarmFormData>({
    name: '',
    type: '',
    location: '',
    latitude: '',
    longitude: '',
    capacity: '',
    species: '',
    description: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: '' }));
    setSubmitError(null);
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // İsim validasyonu
    const nameResult = validateField(formData.name, [required(), minLength(3)]);
    if (!nameResult.valid) newErrors.name = nameResult.error || '';

    // Tip validasyonu
    if (!formData.type) newErrors.type = 'Çiftlik tipi seçiniz';

    // Konum validasyonu
    const locationResult = validateField(formData.location, [required()]);
    if (!locationResult.valid) newErrors.location = locationResult.error || '';

    // Kapasite validasyonu
    if (!formData.capacity || isNaN(Number(formData.capacity))) {
      newErrors.capacity = 'Geçerli bir kapasite giriniz';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // API çağrısı simülasyonu
      await new Promise((resolve) => setTimeout(resolve, 1000));

      console.log('Form gönderildi:', formData);
      navigate('/sites');
    } catch (error) {
      setSubmitError('Çiftlik kaydedilirken bir hata oluştu. Lütfen tekrar deneyin.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Sayfa Başlığı */}
      <div className="mb-6">
        <div className="flex items-center space-x-3">
          <Link to="/sites" className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">
            {isEdit ? 'Çiftliği Düzenle' : 'Yeni Çiftlik Ekle'}
          </h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {isEdit ? 'Çiftlik bilgilerini güncelleyin' : 'Yeni bir çiftlik oluşturun'}
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit}>
        <Card>
          <div className="p-6 space-y-6">
            {submitError && (
              <Alert type="error" dismissible onDismiss={() => setSubmitError(null)}>
                {submitError}
              </Alert>
            )}

            {/* Temel Bilgiler */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">Temel Bilgiler</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Input
                    label="Çiftlik Adı"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="Örn: Çiftlik A - Tank Sistemi"
                    error={errors.name}
                    required
                  />
                </div>

                <Select
                  label="Çiftlik Tipi"
                  name="type"
                  value={formData.type}
                  onChange={handleChange}
                  error={errors.type}
                  required
                  options={[
                    { value: '', label: 'Seçiniz' },
                    { value: 'tank', label: 'Tank Sistemi' },
                    { value: 'cage', label: 'Kafes Sistemi' },
                    { value: 'pond', label: 'Havuz Sistemi' },
                  ]}
                />

                <Select
                  label="Yetiştirilen Tür"
                  name="species"
                  value={formData.species}
                  onChange={handleChange}
                  options={[
                    { value: '', label: 'Seçiniz' },
                    { value: 'levrek', label: 'Levrek' },
                    { value: 'cipura', label: 'Çipura' },
                    { value: 'alabalik', label: 'Alabalık' },
                    { value: 'somon', label: 'Somon' },
                    { value: 'karides', label: 'Karides' },
                  ]}
                />

                <Input
                  label="Kapasite (adet)"
                  name="capacity"
                  type="number"
                  value={formData.capacity}
                  onChange={handleChange}
                  placeholder="50000"
                  error={errors.capacity}
                  required
                />
              </div>
            </div>

            {/* Konum Bilgileri */}
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Konum Bilgileri</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Input
                    label="Adres"
                    name="location"
                    value={formData.location}
                    onChange={handleChange}
                    placeholder="İzmir, Türkiye"
                    error={errors.location}
                    required
                  />
                </div>

                <Input
                  label="Enlem"
                  name="latitude"
                  type="number"
                  step="any"
                  value={formData.latitude}
                  onChange={handleChange}
                  placeholder="38.4192"
                />

                <Input
                  label="Boylam"
                  name="longitude"
                  type="number"
                  step="any"
                  value={formData.longitude}
                  onChange={handleChange}
                  placeholder="27.1287"
                />
              </div>
            </div>

            {/* Açıklama */}
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Ek Bilgiler</h3>
              <Textarea
                label="Açıklama"
                name="description"
                value={formData.description}
                onChange={handleChange}
                placeholder="Çiftlik hakkında ek bilgiler..."
                rows={4}
              />
            </div>
          </div>

          {/* Form Actions */}
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex items-center justify-end space-x-3">
            <Link to="/sites">
              <Button variant="outline" type="button">
                İptal
              </Button>
            </Link>
            <Button type="submit" loading={isSubmitting}>
              {isEdit ? 'Güncelle' : 'Oluştur'}
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
};

export default FarmFormPage;
