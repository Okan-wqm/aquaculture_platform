/**
 * Email Templates Page
 *
 * Page for managing email templates.
 * View, edit, preview, and test templates.
 */

import React, { useState, useEffect } from 'react';
import {
  Card,
  Button,
  Badge,
  Input,
  Modal
} from '@aquaculture/shared-ui';
import { settingsApi, EmailTemplate } from '../services/adminApi';

// ============================================================================
// Component
// ============================================================================

const EmailTemplatesPage: React.FC = () => {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const categories = ['all', 'auth', 'billing', 'notification', 'marketing', 'system'];

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await settingsApi.getEmailTemplates();
      setTemplates(data);
    } catch (err) {
      console.error('Failed to load templates:', err);
      setTemplates([]);
      setError('Failed to load email templates. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async (template: EmailTemplate) => {
    setSelectedTemplate(template);
    // Replace variables with sample values
    let html = template.bodyHtml;
    template.variables.forEach(v => {
      const value = v.defaultValue || `[${v.name}]`;
      html = html.replace(new RegExp(`{{${v.name}}}`, 'g'), value);
    });
    setPreviewHtml(html);
    setShowPreviewModal(true);
  };

  const handleEdit = (template: EmailTemplate) => {
    setSelectedTemplate(template);
    setShowEditModal(true);
  };

  const handleSaveTemplate = async () => {
    if (!selectedTemplate) return;
    try {
      if (selectedTemplate.id) {
        await settingsApi.updateEmailTemplate(selectedTemplate.id, selectedTemplate);
      } else {
        await settingsApi.createEmailTemplate(selectedTemplate);
      }
      setShowEditModal(false);
      loadTemplates();
      setSuccessMessage('Template saved successfully.');
    } catch (err) {
      console.error('Failed to save template:', err);
      setError('Failed to save template. Please try again.');
    }
  };

  const handleToggleActive = async (template: EmailTemplate) => {
    try {
      await settingsApi.updateEmailTemplate(template.id, { isActive: !template.isActive });
      setTemplates(templates.map(t =>
        t.id === template.id ? { ...t, isActive: !t.isActive } : t
      ));
    } catch (err) {
      console.error('Failed to toggle template status:', err);
    }
  };

  const filteredTemplates = templates.filter(t => {
    const matchesCategory = activeCategory === 'all' || t.category === activeCategory;
    const matchesSearch = !searchQuery ||
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.code.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const getCategoryLabel = (category: string) => {
    const labels: Record<string, string> = {
      all: 'All',
      auth: 'Authentication',
      billing: 'Billing',
      notification: 'Notification',
      marketing: 'Marketing',
      system: 'System',
    };
    return labels[category] || category;
  };

  const getCategoryColor = (category: string): 'default' | 'success' | 'warning' | 'error' | 'info' => {
    const colors: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
      auth: 'info',
      billing: 'success',
      notification: 'warning',
      marketing: 'default',
      system: 'error',
    };
    return colors[category] || 'default';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Email Templates</h1>
          <p className="text-gray-500 mt-1">Manage system and custom email templates</p>
        </div>
        <Button variant="primary" onClick={() => {
          setSelectedTemplate(null);
          setShowEditModal(true);
        }}>
          New Template
        </Button>
      </div>

      {/* Success message */}
      {successMessage && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center justify-between">
          <span className="text-green-700">{successMessage}</span>
          <button onClick={() => setSuccessMessage(null)} className="text-green-400 hover:text-green-600 ml-4">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
          <span className="text-red-700">{error}</span>
          <Button variant="secondary" size="sm" onClick={loadTemplates}>
            Retry
          </Button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Category Tabs */}
        <div className="flex flex-wrap gap-2">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeCategory === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {getCategoryLabel(cat)}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 max-w-xs">
          <Input
            type="text"
            placeholder="Search templates..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredTemplates.map(template => (
          <Card key={template.id} className="hover:shadow-lg transition-shadow">
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="font-semibold text-gray-900">{template.name}</h3>
                <p className="text-sm text-gray-500 font-mono">{template.code}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={getCategoryColor(template.category)}>
                  {getCategoryLabel(template.category)}
                </Badge>
                {template.isSystem && (
                  <Badge variant="default">System</Badge>
                )}
              </div>
            </div>

            <p className="text-sm text-gray-600 mb-4 line-clamp-2">
              {template.description || 'No description'}
            </p>

            <div className="text-sm text-gray-500 mb-4">
              <p><strong>Subject:</strong> {template.subject}</p>
              <p className="mt-1">
                <strong>Variables:</strong> {template.variables.length}
              </p>
            </div>

            <div className="flex items-center justify-between pt-4 border-t">
              <div className="flex items-center">
                <span className={`w-2 h-2 rounded-full mr-2 ${template.isActive ? 'bg-green-500' : 'bg-gray-400'}`} />
                <span className="text-sm text-gray-500">
                  {template.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => handlePreview(template)}>
                  Preview
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleEdit(template)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleActive(template)}
                >
                  {template.isActive ? 'Disable' : 'Enable'}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {filteredTemplates.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">No templates found in this category</p>
        </div>
      )}

      {/* Preview Modal */}
      {showPreviewModal && selectedTemplate && (
        <Modal
          isOpen={showPreviewModal}
          onClose={() => setShowPreviewModal(false)}
          title={`Preview: ${selectedTemplate.name}`}
          size="lg"
        >
          <div className="space-y-4">
            {/* Subject Preview */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Konu
              </label>
              <div className="p-3 bg-gray-50 rounded-lg text-sm">
                {selectedTemplate.subject.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
                  const variable = selectedTemplate.variables.find(v => v.name === key);
                  return variable?.defaultValue || `[${key}]`;
                })}
              </div>
            </div>

            {/* Variables */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Variables
              </label>
              <div className="flex flex-wrap gap-2">
                {selectedTemplate.variables.map(v => (
                  <span
                    key={v.name}
                    className="inline-flex items-center px-2 py-1 rounded text-xs bg-blue-100 text-blue-800"
                  >
                    {`{{${v.name}}}`}
                    {v.required && <span className="ml-1 text-red-500">*</span>}
                  </span>
                ))}
              </div>
            </div>

            {/* HTML Preview */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Content Preview
              </label>
              <div className="border rounded-lg overflow-hidden">
                <iframe
                  srcDoc={previewHtml}
                  className="w-full h-96 bg-white"
                  title="Email Preview"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowPreviewModal(false)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => {
                setShowPreviewModal(false);
                handleEdit(selectedTemplate);
              }}>
                Edit
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit Modal */}
      {showEditModal && (
        <Modal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          title={selectedTemplate ? `Edit: ${selectedTemplate.name}` : 'New Template'}
          size="xl"
        >
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Template Code
                </label>
                <Input
                  type="text"
                  value={selectedTemplate?.code || ''}
                  onChange={(e) => setSelectedTemplate(prev => prev ? { ...prev, code: e.target.value } : null)}
                  placeholder="welcome_email"
                  disabled={selectedTemplate?.isSystem}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Template Name
                </label>
                <Input
                  type="text"
                  value={selectedTemplate?.name || ''}
                  onChange={(e) => setSelectedTemplate(prev => prev ? { ...prev, name: e.target.value } : null)}
                  placeholder="Welcome Email"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Category
                </label>
                <select
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  value={selectedTemplate?.category || 'notification'}
                  onChange={(e) => setSelectedTemplate(prev => prev ? { ...prev, category: e.target.value } : null)}
                >
                  {categories.filter(c => c !== 'all').map(cat => (
                    <option key={cat} value={cat}>{getCategoryLabel(cat)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Description
                </label>
                <Input
                  type="text"
                  value={selectedTemplate?.description || ''}
                  onChange={(e) => setSelectedTemplate(prev => prev ? { ...prev, description: e.target.value } : null)}
                  placeholder="Template description..."
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email Subject
              </label>
              <Input
                type="text"
                value={selectedTemplate?.subject || ''}
                onChange={(e) => setSelectedTemplate(prev => prev ? { ...prev, subject: e.target.value } : null)}
                placeholder="{{platform_name}} - Welcome!"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                HTML Content
              </label>
              <textarea
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                rows={12}
                value={selectedTemplate?.bodyHtml || ''}
                onChange={(e) => setSelectedTemplate(prev => prev ? { ...prev, bodyHtml: e.target.value } : null)}
                placeholder="<html>...</html>"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Variables
              </label>
              <div className="space-y-2">
                {selectedTemplate?.variables.map((variable, index) => (
                  <div key={index} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                    <Input
                      type="text"
                      value={variable.name}
                      placeholder="Variable name"
                      className="flex-1"
                      onChange={(e) => {
                        const newVars = [...(selectedTemplate?.variables || [])];
                        newVars[index] = { ...variable, name: e.target.value };
                        setSelectedTemplate(prev => prev ? { ...prev, variables: newVars } : null);
                      }}
                    />
                    <Input
                      type="text"
                      value={variable.description}
                      placeholder="Description"
                      className="flex-1"
                      onChange={(e) => {
                        const newVars = [...(selectedTemplate?.variables || [])];
                        newVars[index] = { ...variable, description: e.target.value };
                        setSelectedTemplate(prev => prev ? { ...prev, variables: newVars } : null);
                      }}
                    />
                    <Input
                      type="text"
                      value={variable.defaultValue || ''}
                      placeholder="Default"
                      className="flex-1"
                      onChange={(e) => {
                        const newVars = [...(selectedTemplate?.variables || [])];
                        newVars[index] = { ...variable, defaultValue: e.target.value };
                        setSelectedTemplate(prev => prev ? { ...prev, variables: newVars } : null);
                      }}
                    />
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={variable.required}
                        onChange={(e) => {
                          const newVars = [...(selectedTemplate?.variables || [])];
                          newVars[index] = { ...variable, required: e.target.checked };
                          setSelectedTemplate(prev => prev ? { ...prev, variables: newVars } : null);
                        }}
                        className="h-4 w-4 text-blue-600 rounded"
                      />
                      <span className="ml-1 text-xs">Required</span>
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500"
                      onClick={() => {
                        const newVars = selectedTemplate?.variables.filter((_, i) => i !== index) || [];
                        setSelectedTemplate(prev => prev ? { ...prev, variables: newVars } : null);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const newVars = [
                      ...(selectedTemplate?.variables || []),
                      { name: '', description: '', required: false },
                    ];
                    setSelectedTemplate(prev => prev ? { ...prev, variables: newVars } : null);
                  }}
                >
                  + Add Variable
                </Button>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowEditModal(false)}>
                Cancel
              </Button>
              <Button variant="ghost" onClick={() => selectedTemplate && handlePreview(selectedTemplate)}>
                Preview
              </Button>
              <Button variant="primary" onClick={handleSaveTemplate}>
                Save
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default EmailTemplatesPage;
