import React from 'react';

const SetupPage: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-8 text-center" style={{ background: 'linear-gradient(135deg, #22C55E 0%, #16A34A 100%)' }}>
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm mb-4">
            <span className="text-3xl">🌱</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Hydroponics Management</h1>
          <p className="text-green-100 mt-2 max-w-md mx-auto">
            Hydroponic system management, nutrient solutions, growing beds, climate control and harvest tracking
          </p>
        </div>

        {/* Content */}
        <div className="px-6 py-8">
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-50 text-green-700 text-sm font-medium mb-6">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Coming Soon
            </div>

            <h2 className="text-xl font-semibold text-gray-900 mb-3">
              Module Setup
            </h2>
            <p className="text-gray-500 max-w-lg mx-auto mb-8">
              The Hydroponics module is being configured for your tenant.
              Full features including system management, nutrient monitoring, and harvest tracking will be available soon.
            </p>

            {/* Feature Preview */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-2xl mx-auto">
              {[
                { icon: '🔧', title: 'System Management', desc: 'Configure hydroponic systems' },
                { icon: '🧪', title: 'Nutrient Solutions', desc: 'Monitor and manage nutrients' },
                { icon: '🌿', title: 'Growing Beds', desc: 'Track growing beds and channels' },
                { icon: '🌡️', title: 'Climate Control', desc: 'Temperature and humidity' },
                { icon: '📦', title: 'Harvest Tracking', desc: 'Plan and record harvests' },
                { icon: '📊', title: 'Analytics', desc: 'Performance insights' },
              ].map((feature, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-3 p-4 rounded-lg bg-gray-50 text-left"
                >
                  <span className="text-xl">{feature.icon}</span>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{feature.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{feature.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SetupPage;
