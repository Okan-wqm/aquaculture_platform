/**
 * Process Templates Page
 * Predefined process templates for quick setup
 */

import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Droplets,
  Wind,
  Utensils,
  Thermometer,
  AlertTriangle,
  Cog,
} from 'lucide-react';

interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: React.FC<{ className?: string }>;
  nodeCount: number;
  complexity: 'simple' | 'medium' | 'complex';
}

const templates: Template[] = [
  {
    id: 'water-recirculation',
    name: 'Water Recirculation System',
    description:
      'Complete RAS setup with tanks, pumps, biofilter, and drum filter connected in a closed loop.',
    category: 'Water Management',
    icon: Droplets,
    nodeCount: 8,
    complexity: 'complex',
  },
  {
    id: 'aeration-system',
    name: 'Aeration System',
    description:
      'Blower and aerator setup for maintaining optimal dissolved oxygen levels across multiple tanks.',
    category: 'Aeration',
    icon: Wind,
    nodeCount: 5,
    complexity: 'simple',
  },
  {
    id: 'auto-feeding',
    name: 'Automated Feeding',
    description:
      'Auto-feeder network with sensor monitoring for optimized feeding schedules.',
    category: 'Feeding',
    icon: Utensils,
    nodeCount: 4,
    complexity: 'simple',
  },
  {
    id: 'temperature-control',
    name: 'Temperature Control',
    description:
      'Heat exchanger and chiller setup with temperature sensors for precise thermal management.',
    category: 'Climate Control',
    icon: Thermometer,
    nodeCount: 6,
    complexity: 'medium',
  },
  {
    id: 'emergency-response',
    name: 'Emergency Response',
    description:
      'Backup systems and alert triggers for critical parameter deviations.',
    category: 'Safety',
    icon: AlertTriangle,
    nodeCount: 7,
    complexity: 'medium',
  },
  {
    id: 'water-treatment',
    name: 'Water Treatment',
    description:
      'UV sterilizer and ozone generator setup for pathogen control and water quality.',
    category: 'Water Treatment',
    icon: Cog,
    nodeCount: 5,
    complexity: 'medium',
  },
];

const complexityColors = {
  simple: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  complex: 'bg-red-100 text-red-700',
};

const ProcessTemplatesPage: React.FC = () => {
  const navigate = useNavigate();

  const handleUseTemplate = (templateId: string) => {
    // Navigate to editor with template query param
    navigate(`/sensor/processes/new?template=${templateId}`);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <Link
          to="/sensor/processes"
          className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Processes
        </Link>

        <h1 className="text-2xl font-bold text-gray-900">Process Templates</h1>
        <p className="text-gray-500 mt-1">
          Start with a pre-built template and customize it for your needs
        </p>
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {templates.map((template) => {
          const IconComponent = template.icon;

          return (
            <div
              key={template.id}
              className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
            >
              {/* Template Header */}
              <div className="p-5 border-b border-gray-100">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <IconComponent className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900 truncate">
                      {template.name}
                    </h3>
                    <p className="text-sm text-gray-500 mt-1">{template.category}</p>
                  </div>
                </div>
              </div>

              {/* Template Body */}
              <div className="p-5">
                <p className="text-sm text-gray-600 line-clamp-3 mb-4">
                  {template.description}
                </p>

                <div className="flex items-center gap-4 text-sm">
                  <span className="text-gray-500">
                    {template.nodeCount} components
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      complexityColors[template.complexity]
                    }`}
                  >
                    {template.complexity.charAt(0).toUpperCase() +
                      template.complexity.slice(1)}
                  </span>
                </div>
              </div>

              {/* Template Footer */}
              <div className="px-5 py-4 bg-gray-50 border-t border-gray-100">
                <button
                  onClick={() => handleUseTemplate(template.id)}
                  className="w-full px-4 py-2 text-sm font-medium text-blue-600 bg-white border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
                >
                  Use This Template
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty State / Custom */}
      <div className="mt-8 p-6 bg-gray-50 rounded-lg border border-gray-200 text-center">
        <Cog className="w-10 h-10 mx-auto text-gray-400 mb-3" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          Need something different?
        </h3>
        <p className="text-gray-500 mb-4">
          Start from scratch and build your own custom process diagram
        </p>
        <Link
          to="/sensor/processes/new"
          className="inline-flex items-center gap-2 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Create Custom Process
        </Link>
      </div>
    </div>
  );
};

export default ProcessTemplatesPage;
