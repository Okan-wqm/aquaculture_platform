import React from 'react';
import {
  AutoRule,
  CATEGORY_CONFIG,
  PRIORITY_CONFIG,
  TRIGGER_CONFIG,
} from '../types/task.types';

interface AutoRulesTabProps {
  rules: AutoRule[];
  onToggleActive: (ruleId: string) => void;
}

export const AutoRulesTab: React.FC<AutoRulesTabProps> = ({ rules, onToggleActive }) => {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <p className="text-sm text-gray-500">
            Koşul bazlı otomatik görev oluşturma kuralları. Koşul sağlandığında ilgili görev otomatik oluşturulur.
          </p>
        </div>
        <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium whitespace-nowrap">
          + Yeni Kural
        </button>
      </div>

      {/* Rules List */}
      <div className="space-y-3">
        {rules.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
            <p className="text-gray-500">Otomatik kural bulunmuyor.</p>
          </div>
        ) : (
          rules.map(rule => {
            const trigger = TRIGGER_CONFIG[rule.trigger];
            const cat = CATEGORY_CONFIG[rule.taskCategory];
            const pri = PRIORITY_CONFIG[rule.taskPriority];

            return (
              <div
                key={rule.id}
                className={`bg-white rounded-lg border border-gray-200 p-5 ${!rule.isActive ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-sm font-semibold text-gray-900">{rule.name}</h3>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${trigger.bg} ${trigger.color}`}>
                        {trigger.label}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 mb-3">{rule.description}</p>

                    {/* Trigger -> Action Flow */}
                    <div className="flex items-center gap-3 bg-gray-50 rounded-lg p-3">
                      <div className="flex-1">
                        <p className="text-xs font-medium text-gray-500 uppercase mb-1">Tetikleyici Koşul</p>
                        <p className="text-sm text-gray-700 font-medium">{rule.triggerCondition}</p>
                      </div>
                      <div className="flex-shrink-0">
                        <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                      </div>
                      <div className="flex-1">
                        <p className="text-xs font-medium text-gray-500 uppercase mb-1">Oluşturulacak Görev</p>
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-gray-700 font-medium">{rule.taskTitle}</p>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cat.bg} ${cat.color}`}>
                            {cat.label}
                          </span>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${pri.bg} ${pri.color}`}>
                            {pri.label}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                      <span>Tetiklenme: {rule.triggerCount} kez</span>
                      {rule.lastTriggered && (
                        <span>Son: {new Date(rule.lastTriggered).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                    </div>
                  </div>

                  {/* Toggle */}
                  <button
                    onClick={() => onToggleActive(rule.id)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ml-4 flex-shrink-0 ${
                      rule.isActive ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        rule.isActive ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
