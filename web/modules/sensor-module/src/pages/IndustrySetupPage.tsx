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

const IndustrySetupPage: React.FC = () => {
  const navigate = useNavigate();

  const handleTemplateApplied = () => {
    navigate('/sensor/devices');
  };

  const handleSkip = () => {
    navigate('/sensor/devices');
  };

  return (
    <div className="min-h-[calc(100vh-64px)] bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-cyan-50">
              <Layers className="w-6 h-6 text-cyan-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Sektor Secimi</h1>
          </div>
          <p className="text-gray-500 ml-14">
            Sensor modulunu sektorunuze gore yapilandirin. Bir sablon secerek
            uygun sensor tipleri ve alarm esikleri otomatik olarak olusturulur.
          </p>
        </div>

        {/* Template Selector */}
        <IndustryTemplateSelector onTemplateApplied={handleTemplateApplied} />

        {/* Skip link */}
        <div className="mt-6 flex justify-center">
          <button
            onClick={handleSkip}
            className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-600 transition-colors"
          >
            Atla
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default IndustrySetupPage;
