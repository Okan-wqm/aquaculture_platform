/**
 * IP Access Rules Page
 *
 * IP whitelist ve blacklist yönetimi için sayfa.
 */

import React, { useState, useEffect } from 'react';
import {
  Card,
  Button,
  Badge,
  Input,
  Modal
} from '@aquaculture/shared-ui';
import { settingsApi, IpAccessRule } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface IpAccessStats {
  totalRules: number;
  whitelistCount: number;
  blacklistCount: number;
  activeRules: number;
  expiredRules: number;
  totalHits: number;
}

// ============================================================================
// Component
// ============================================================================

const IpAccessRulesPage: React.FC = () => {
  const [rules, setRules] = useState<IpAccessRule[]>([]);
  const [stats, setStats] = useState<IpAccessStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'whitelist' | 'blacklist'>('whitelist');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [newRule, setNewRule] = useState<Partial<IpAccessRule>>({
    ruleType: 'whitelist',
    isActive: true,
  });
  const [bulkIps, setBulkIps] = useState('');
  const [checkIp, setCheckIp] = useState('');
  const [checkResult, setCheckResult] = useState<{ allowed: boolean; reason: string } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await settingsApi.getIpAccessRules({ limit: 100 });
      const rulesData = [...result.items];
      setRules(rulesData);

      // Calculate stats from loaded data
      const calculatedStats: IpAccessStats = {
        totalRules: rulesData.length,
        whitelistCount: rulesData.filter(r => r.ruleType === 'whitelist').length,
        blacklistCount: rulesData.filter(r => r.ruleType === 'blacklist').length,
        activeRules: rulesData.filter(r => r.isActive).length,
        expiredRules: rulesData.filter(r => r.expiresAt && new Date(r.expiresAt) < new Date()).length,
        totalHits: rulesData.reduce((sum, r) => sum + (r.hitCount || 0), 0),
      };
      setStats(calculatedStats);
    } catch (err) {
      console.error('Failed to load data:', err);
      setRules([]);
      setStats(null);
      setError('Failed to load IP access rules. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleAddRule = async () => {
    if (!newRule.ipAddress) {
      setError('IP address is required');
      return;
    }
    try {
      await settingsApi.createIpAccessRule({
        ipAddress: newRule.ipAddress,
        ruleType: newRule.ruleType || 'whitelist',
        description: newRule.description,
        isActive: newRule.isActive ?? true,
        expiresAt: newRule.expiresAt,
      });
      setShowAddModal(false);
      setNewRule({ ruleType: activeTab, isActive: true });
      loadData();
      setSuccessMessage('Rule added successfully.');
    } catch (err) {
      console.error('Failed to add rule:', err);
      setError(err instanceof Error ? err.message : 'Failed to add rule');
    }
  };

  const handleBulkAdd = async () => {
    const ips = bulkIps.split('\n').filter(ip => ip.trim());
    if (ips.length === 0) {
      setError('Please enter at least one IP address.');
      return;
    }
    try {
      // Add each IP rule
      for (const ip of ips) {
        await settingsApi.createIpAccessRule({
          ipAddress: ip.trim(),
          ruleType: newRule.ruleType || 'whitelist',
          isActive: true,
        });
      }
      setShowBulkModal(false);
      setBulkIps('');
      loadData();
      setSuccessMessage(`${ips.length} rule(s) added successfully.`);
    } catch (err) {
      console.error('Failed to bulk add rules:', err);
      setError(err instanceof Error ? err.message : 'Failed to add rules');
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this rule?')) return;
    try {
      await settingsApi.deleteIpAccessRule(id);
      setRules(rules.filter(r => r.id !== id));
    } catch (err) {
      console.error('Failed to delete rule:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete rule');
    }
  };

  const handleToggleRule = async (rule: IpAccessRule) => {
    try {
      await settingsApi.updateIpAccessRule(rule.id, { isActive: !rule.isActive });
      setRules(rules.map(r =>
        r.id === rule.id ? { ...r, isActive: !r.isActive } : r
      ));
    } catch (err) {
      console.error('Failed to toggle rule:', err);
      setError(err instanceof Error ? err.message : 'Failed to update rule status');
    }
  };

  const handleCheckIp = async () => {
    if (!checkIp.trim()) return;
    try {
      const result = await settingsApi.checkIpAccess(checkIp.trim());
      if (result.allowed) {
        setCheckResult({
          allowed: true,
          reason: result.matchedRule ? 'Matched whitelist rule' : 'No restrictions'
        });
      } else {
        setCheckResult({
          allowed: false,
          reason: result.matchedRule ? 'Blocked by blacklist rule' : 'IP blocked'
        });
      }
    } catch (err) {
      console.error('Failed to check IP:', err);
      setError('Failed to check IP address. Please try again.');
    }
  };

  const filteredRules = rules.filter(r => r.ruleType === activeTab);

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
          <h1 className="text-2xl font-bold text-gray-900">IP Access Rules</h1>
          <p className="text-gray-500 mt-1">Whitelist and blacklist management</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setShowBulkModal(true)}>
            Bulk Add
          </Button>
          <Button variant="primary" onClick={() => {
            setNewRule({ ruleType: activeTab, isActive: true });
            setShowAddModal(true);
          }}>
            Add Rule
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
          <span className="text-red-700">{error}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={loadData}>
              Retry
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Success */}
      {successMessage && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center justify-between">
          <span className="text-green-700">{successMessage}</span>
          <Button variant="secondary" size="sm" onClick={() => setSuccessMessage(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card className="text-center">
            <p className="text-2xl font-bold text-gray-900">{stats.totalRules}</p>
            <p className="text-sm text-gray-500">Total Rules</p>
          </Card>
          <Card className="text-center">
            <p className="text-2xl font-bold text-green-600">{stats.whitelistCount}</p>
            <p className="text-sm text-gray-500">Whitelist</p>
          </Card>
          <Card className="text-center">
            <p className="text-2xl font-bold text-red-600">{stats.blacklistCount}</p>
            <p className="text-sm text-gray-500">Blacklist</p>
          </Card>
          <Card className="text-center">
            <p className="text-2xl font-bold text-blue-600">{stats.activeRules}</p>
            <p className="text-sm text-gray-500">Active Rules</p>
          </Card>
          <Card className="text-center">
            <p className="text-2xl font-bold text-orange-600">{stats.expiredRules}</p>
            <p className="text-sm text-gray-500">Expired</p>
          </Card>
          <Card className="text-center">
            <p className="text-2xl font-bold text-purple-600">{stats.totalHits.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Total Hits</p>
          </Card>
        </div>
      )}

      {/* IP Check Tool */}
      <Card title="IP Check">
        <div className="flex gap-4 items-end">
          <div className="flex-1 max-w-xs">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              IP Address
            </label>
            <Input
              type="text"
              value={checkIp}
              onChange={(e) => setCheckIp(e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>
          <Button variant="primary" onClick={handleCheckIp}>
            Check
          </Button>
          {checkResult && (
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              checkResult.allowed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
            }`}>
              <span className={`w-3 h-3 rounded-full ${checkResult.allowed ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="font-medium">{checkResult.allowed ? 'Allowed' : 'Blocked'}</span>
              <span className="text-sm">- {checkResult.reason}</span>
            </div>
          )}
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex gap-4 border-b">
        <button
          onClick={() => setActiveTab('whitelist')}
          className={`px-4 py-3 font-medium border-b-2 transition-colors ${
            activeTab === 'whitelist'
              ? 'border-green-600 text-green-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Whitelist ({rules.filter(r => r.ruleType === 'whitelist').length})
        </button>
        <button
          onClick={() => setActiveTab('blacklist')}
          className={`px-4 py-3 font-medium border-b-2 transition-colors ${
            activeTab === 'blacklist'
              ? 'border-red-600 text-red-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Blacklist ({rules.filter(r => r.ruleType === 'blacklist').length})
        </button>
      </div>

      {/* Rules Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">IP Address</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Hit Count</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Son Hit</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expires</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredRules.map((rule) => (
                <tr key={rule.id} className={!rule.isActive ? 'bg-gray-50' : ''}>
                  <td className="px-4 py-3">
                    <span className="font-mono text-sm">{rule.ipAddress}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {rule.description || '-'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={rule.isActive ? 'success' : 'default'}>
                      {rule.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">
                    {rule.hitCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {rule.lastHitAt
                      ? new Date(rule.lastHitAt).toLocaleString('en-US')
                      : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {rule.expiresAt
                      ? new Date(rule.expiresAt).toLocaleDateString('en-US')
                      : 'No Expiry'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggleRule(rule)}
                      >
                        {rule.isActive ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600"
                        onClick={() => handleDeleteRule(rule.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filteredRules.length === 0 && (
          <div className="text-center py-8">
            <p className="text-gray-500">
              {activeTab === 'whitelist' ? 'Whitelist is empty' : 'Blacklist is empty'}
            </p>
          </div>
        )}
      </Card>

      {/* Add Rule Modal */}
      {showAddModal && (
        <Modal
          isOpen={showAddModal}
          onClose={() => setShowAddModal(false)}
          title="New IP Rule"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Rule Type
              </label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="ruleType"
                    checked={newRule.ruleType === 'whitelist'}
                    onChange={() => setNewRule({ ...newRule, ruleType: 'whitelist' })}
                    className="h-4 w-4 text-blue-600"
                  />
                  <span className="ml-2">Whitelist</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="ruleType"
                    checked={newRule.ruleType === 'blacklist'}
                    onChange={() => setNewRule({ ...newRule, ruleType: 'blacklist' })}
                    className="h-4 w-4 text-blue-600"
                  />
                  <span className="ml-2">Blacklist</span>
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                IP Address (CIDR supported)
              </label>
              <Input
                type="text"
                value={newRule.ipAddress || ''}
                onChange={(e) => setNewRule({ ...newRule, ipAddress: e.target.value })}
                placeholder="192.168.1.0/24 or 10.0.0.1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Description
              </label>
              <Input
                type="text"
                value={newRule.description || ''}
                onChange={(e) => setNewRule({ ...newRule, description: e.target.value })}
                placeholder="Office network"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Expiry Date (optional)
              </label>
              <Input
                type="date"
                value={newRule.expiresAt || ''}
                onChange={(e) => setNewRule({ ...newRule, expiresAt: e.target.value })}
              />
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowAddModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleAddRule}>
                Add
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Bulk Add Modal */}
      {showBulkModal && (
        <Modal
          isOpen={showBulkModal}
          onClose={() => setShowBulkModal(false)}
          title="Bulk IP Import"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Rule Type
              </label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="bulkRuleType"
                    checked={newRule.ruleType === 'whitelist'}
                    onChange={() => setNewRule({ ...newRule, ruleType: 'whitelist' })}
                    className="h-4 w-4 text-blue-600"
                  />
                  <span className="ml-2">Whitelist</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="bulkRuleType"
                    checked={newRule.ruleType === 'blacklist'}
                    onChange={() => setNewRule({ ...newRule, ruleType: 'blacklist' })}
                    className="h-4 w-4 text-blue-600"
                  />
                  <span className="ml-2">Blacklist</span>
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                IP Addresses (one per line)
              </label>
              <textarea
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                rows={10}
                value={bulkIps}
                onChange={(e) => setBulkIps(e.target.value)}
                placeholder="192.168.1.1&#10;192.168.1.0/24&#10;10.0.0.0/8"
              />
              <p className="text-xs text-gray-500 mt-1">
                {bulkIps.split('\n').filter(ip => ip.trim()).length} IP address(es)
              </p>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowBulkModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleBulkAdd}>
                Add
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default IpAccessRulesPage;
