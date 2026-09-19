/**
 * Industry Setup Page
 *
 * Sektore gore sensor modulu yapilandirma sayfasi.
 * Kullanici bir sektor sablonu secebilir veya atlayarak cihazlar sayfasina gidebilir.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, ArrowRight } from 'lucide-react';
import IndustryTemplateSelector from '../components/templates/IndustryTemplateSelector';
import { PageHeader, Button } from '@aquaculture/shared-ui';

const IndustrySetupPage: React.FC = () => {
  const navigate = useNavigate();

  const handleTemplateApplied = () => {
    navigate('/sensor/devices');
  };

  const handleSkip = () => {
    navigate('/sensor/devices');
  };

  return (
    <div className="min-h-[calc(100vh-64px)] bg-gray-50 dark:bg-gray-800">
      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <PageHeader
          title="Sektor Secimi"
          description={
            <>
              Sensor modulunu sektorunuze gore yapilandirin. Bir sablon secerek uygun sensor tipleri
              ve alarm esikleri otomatik olarak olusturulur.
            </>
          }
          leading={
            <div className="p-2 rounded-lg bg-info-50 dark:bg-info-900/20">
              <Layers className="w-6 h-6 text-info-600 dark:text-info-400" />
            </div>
          }
          className="mb-8"
        />

        {/* Template Selector */}
        <IndustryTemplateSelector onTemplateApplied={handleTemplateApplied} />

        {/* Skip link */}
        <div className="mt-6 flex justify-center">
          <Button
            variant="ghost"
            rightIcon={<ArrowRight className="w-4 h-4" />}
            onClick={handleSkip}
          >
            Atla
          </Button>
        </div>
      </div>
    </div>
  );
};

export default IndustrySetupPage;
