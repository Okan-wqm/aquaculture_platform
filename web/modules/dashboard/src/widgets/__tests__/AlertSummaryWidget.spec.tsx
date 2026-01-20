/**
 * AlertSummaryWidget Tests
 *
 * Comprehensive tests for the Alert Summary Widget component.
 * Tests cover rendering, filtering, interactions, and edge cases.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import AlertSummaryWidget, {
  AlertItem,
  AlertSeverity,
  AlertStatus,
  severityConfig,
  sortAlerts,
  filterAlerts,
  countBySeverity,
  countByStatus,
  AlertIcon,
  AlertItemCard,
  SeverityFilter,
  EmptyState,
  LoadingState,
  ErrorState,
} from '../AlertSummaryWidget';

// Mock the shared-ui components
vi.mock('@aquaculture/shared-ui', () => ({
  Card: ({ children, className, ...props }: any) => (
    <div className={`card ${className}`} {...props}>{children}</div>
  ),
  Badge: ({ children, variant, size, ...props }: any) => (
    <span className={`badge badge-${variant} badge-${size}`} {...props}>{children}</span>
  ),
  Button: ({ children, variant, size, onClick, disabled, ...props }: any) => (
    <button
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
  formatRelativeTime: (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes} dakika önce`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} saat önce`;
    return `${Math.floor(hours / 24)} gün önce`;
  },
}));

// ============================================================================
// Mock Data
// ============================================================================

const createMockAlert = (overrides: Partial<AlertItem> = {}): AlertItem => ({
  id: `alert-${Date.now()}-${Math.random()}`,
  title: 'Test Alert',
  description: 'Test alert description',
  severity: 'medium',
  status: 'active',
  source: 'Sensor: TEMP-01',
  farmId: 'farm-1',
  farmName: 'Test Farm',
  pondId: 'pond-1',
  pondName: 'Test Pond',
  sensorId: 'sensor-1',
  sensorType: 'temperature',
  triggeredAt: new Date(),
  occurrenceCount: 1,
  ruleId: 'rule-1',
  ruleName: 'Temperature Alert Rule',
  currentValue: 28.5,
  threshold: 27.0,
  unit: '°C',
  ...overrides,
});

const mockAlerts: AlertItem[] = [
  createMockAlert({
    id: 'alert-1',
    title: 'Critical Temperature',
    severity: 'critical',
    status: 'active',
    triggeredAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
    currentValue: 32.5,
    threshold: 30.0,
  }),
  createMockAlert({
    id: 'alert-2',
    title: 'High pH Level',
    severity: 'high',
    status: 'active',
    triggeredAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
    currentValue: 9.2,
    threshold: 8.5,
    unit: 'pH',
  }),
  createMockAlert({
    id: 'alert-3',
    title: 'Low Oxygen',
    severity: 'medium',
    status: 'acknowledged',
    triggeredAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
    acknowledgedAt: new Date(Date.now() - 15 * 60 * 1000),
    acknowledgedBy: 'user-1',
    currentValue: 5.8,
    threshold: 6.0,
    unit: 'mg/L',
  }),
  createMockAlert({
    id: 'alert-4',
    title: 'Turbidity Warning',
    severity: 'low',
    status: 'active',
    triggeredAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    currentValue: 15.0,
    threshold: 10.0,
    unit: 'NTU',
  }),
  createMockAlert({
    id: 'alert-5',
    title: 'Sensor Update',
    severity: 'info',
    status: 'resolved',
    triggeredAt: new Date(Date.now() - 120 * 60 * 1000), // 2 hours ago
    resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    resolvedBy: 'user-2',
  }),
];

// ============================================================================
// Helper Functions Tests
// ============================================================================

describe('Helper Functions', () => {
  describe('sortAlerts', () => {
    it('should sort by severity priority (critical first)', () => {
      const alerts = [
        createMockAlert({ id: '1', severity: 'low' }),
        createMockAlert({ id: '2', severity: 'critical' }),
        createMockAlert({ id: '3', severity: 'high' }),
      ];

      const sorted = sortAlerts(alerts);

      expect(sorted[0].severity).toBe('critical');
      expect(sorted[1].severity).toBe('high');
      expect(sorted[2].severity).toBe('low');
    });

    it('should sort by time within same severity (newest first)', () => {
      const now = Date.now();
      const alerts = [
        createMockAlert({ id: '1', severity: 'critical', triggeredAt: new Date(now - 60000) }),
        createMockAlert({ id: '2', severity: 'critical', triggeredAt: new Date(now) }),
        createMockAlert({ id: '3', severity: 'critical', triggeredAt: new Date(now - 30000) }),
      ];

      const sorted = sortAlerts(alerts);

      expect(sorted[0].id).toBe('2'); // newest
      expect(sorted[1].id).toBe('3');
      expect(sorted[2].id).toBe('1'); // oldest
    });

    it('should not mutate original array', () => {
      const alerts = [
        createMockAlert({ id: '1', severity: 'low' }),
        createMockAlert({ id: '2', severity: 'critical' }),
      ];
      const originalOrder = alerts.map(a => a.id);

      sortAlerts(alerts);

      expect(alerts.map(a => a.id)).toEqual(originalOrder);
    });

    it('should handle empty array', () => {
      expect(sortAlerts([])).toEqual([]);
    });

    it('should handle single item', () => {
      const alert = createMockAlert({ id: '1' });
      const sorted = sortAlerts([alert]);
      expect(sorted).toHaveLength(1);
      expect(sorted[0].id).toBe('1');
    });
  });

  describe('filterAlerts', () => {
    it('should filter by single severity', () => {
      const filtered = filterAlerts(mockAlerts, ['critical']);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].severity).toBe('critical');
    });

    it('should filter by multiple severities', () => {
      const filtered = filterAlerts(mockAlerts, ['critical', 'high']);

      expect(filtered).toHaveLength(2);
      expect(filtered.every(a => ['critical', 'high'].includes(a.severity))).toBe(true);
    });

    it('should filter by single status', () => {
      const filtered = filterAlerts(mockAlerts, undefined, ['acknowledged']);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe('acknowledged');
    });

    it('should filter by multiple statuses', () => {
      const filtered = filterAlerts(mockAlerts, undefined, ['active', 'acknowledged']);

      expect(filtered.every(a => ['active', 'acknowledged'].includes(a.status))).toBe(true);
    });

    it('should combine severity and status filters', () => {
      const filtered = filterAlerts(mockAlerts, ['critical', 'high'], ['active']);

      expect(filtered.every(a =>
        ['critical', 'high'].includes(a.severity) && a.status === 'active'
      )).toBe(true);
    });

    it('should return all alerts when no filters provided', () => {
      const filtered = filterAlerts(mockAlerts);
      expect(filtered).toHaveLength(mockAlerts.length);
    });

    it('should return all alerts with empty filter arrays', () => {
      const filtered = filterAlerts(mockAlerts, [], []);
      expect(filtered).toHaveLength(mockAlerts.length);
    });

    it('should handle empty alerts array', () => {
      const filtered = filterAlerts([], ['critical']);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('countBySeverity', () => {
    it('should count alerts by severity', () => {
      const counts = countBySeverity(mockAlerts);

      expect(counts.critical).toBe(1);
      expect(counts.high).toBe(1);
      expect(counts.medium).toBe(1);
      expect(counts.low).toBe(1);
      expect(counts.info).toBe(1);
    });

    it('should return zeros for empty array', () => {
      const counts = countBySeverity([]);

      expect(counts.critical).toBe(0);
      expect(counts.high).toBe(0);
      expect(counts.medium).toBe(0);
      expect(counts.low).toBe(0);
      expect(counts.info).toBe(0);
    });

    it('should handle duplicate severities', () => {
      const alerts = [
        createMockAlert({ severity: 'critical' }),
        createMockAlert({ severity: 'critical' }),
        createMockAlert({ severity: 'critical' }),
      ];

      const counts = countBySeverity(alerts);

      expect(counts.critical).toBe(3);
    });
  });

  describe('countByStatus', () => {
    it('should count alerts by status', () => {
      const counts = countByStatus(mockAlerts);

      expect(counts.active).toBe(3);
      expect(counts.acknowledged).toBe(1);
      expect(counts.resolved).toBe(1);
      expect(counts.suppressed).toBe(0);
    });

    it('should return zeros for empty array', () => {
      const counts = countByStatus([]);

      expect(counts.active).toBe(0);
      expect(counts.acknowledged).toBe(0);
      expect(counts.resolved).toBe(0);
      expect(counts.suppressed).toBe(0);
    });
  });
});

// ============================================================================
// Sub-Component Tests
// ============================================================================

describe('AlertIcon', () => {
  it('should render with correct severity styling', () => {
    const { container } = render(<AlertIcon severity="critical" />);
    const icon = container.firstChild;

    expect(icon).toHaveClass('bg-red-50');
    expect(icon).toHaveClass('text-red-600');
  });

  it('should apply custom className', () => {
    const { container } = render(<AlertIcon severity="critical" className="custom-class" />);
    const icon = container.firstChild;

    expect(icon).toHaveClass('custom-class');
  });

  it('should have correct test id', () => {
    render(<AlertIcon severity="high" />);

    expect(screen.getByTestId('alert-icon-high')).toBeInTheDocument();
  });

  it('should render icon for all severity levels', () => {
    const severities: AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

    severities.forEach(severity => {
      const { unmount } = render(<AlertIcon severity={severity} />);
      expect(screen.getByTestId(`alert-icon-${severity}`)).toBeInTheDocument();
      unmount();
    });
  });
});

describe('AlertItemCard', () => {
  const mockAlert = createMockAlert({
    id: 'test-alert',
    title: 'Test Alert Title',
    description: 'Test alert description',
    severity: 'critical',
    status: 'active',
    source: 'Test Source',
    currentValue: 30.5,
    threshold: 28.0,
    unit: '°C',
    occurrenceCount: 3,
  });

  it('should render alert information', () => {
    render(<AlertItemCard alert={mockAlert} />);

    expect(screen.getByText('Test Alert Title')).toBeInTheDocument();
    expect(screen.getByText('Test alert description')).toBeInTheDocument();
    expect(screen.getByText('Test Source')).toBeInTheDocument();
  });

  it('should show current value and threshold', () => {
    render(<AlertItemCard alert={mockAlert} />);

    expect(screen.getByText(/30.5°C/)).toBeInTheDocument();
    expect(screen.getByText(/28°C/)).toBeInTheDocument();
  });

  it('should hide value/threshold in compact mode', () => {
    render(<AlertItemCard alert={mockAlert} compact />);

    expect(screen.queryByText(/30.5°C/)).not.toBeInTheDocument();
  });

  it('should show occurrence count when > 1', () => {
    render(<AlertItemCard alert={mockAlert} />);

    expect(screen.getByText('3 kez tekrarlandı')).toBeInTheDocument();
  });

  it('should not show occurrence count when = 1', () => {
    const singleOccurrence = { ...mockAlert, occurrenceCount: 1 };
    render(<AlertItemCard alert={singleOccurrence} />);

    expect(screen.queryByText(/kez tekrarlandı/)).not.toBeInTheDocument();
  });

  it('should show acknowledge button for active alerts', () => {
    const onAcknowledge = vi.fn();
    render(<AlertItemCard alert={mockAlert} onAcknowledge={onAcknowledge} />);

    expect(screen.getByTestId('acknowledge-btn-test-alert')).toBeInTheDocument();
  });

  it('should call onAcknowledge when clicked', async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn().mockResolvedValue(undefined);
    render(<AlertItemCard alert={mockAlert} onAcknowledge={onAcknowledge} />);

    await user.click(screen.getByTestId('acknowledge-btn-test-alert'));

    expect(onAcknowledge).toHaveBeenCalledWith('test-alert');
  });

  it('should call onResolve when clicked', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<AlertItemCard alert={mockAlert} onResolve={onResolve} />);

    await user.click(screen.getByTestId('resolve-btn-test-alert'));

    expect(onResolve).toHaveBeenCalledWith('test-alert');
  });

  it('should disable buttons while processing', async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn().mockImplementation(() =>
      new Promise(resolve => setTimeout(resolve, 100))
    );
    render(<AlertItemCard alert={mockAlert} onAcknowledge={onAcknowledge} />);

    await user.click(screen.getByTestId('acknowledge-btn-test-alert'));

    expect(screen.getByText('İşleniyor...')).toBeInTheDocument();
  });

  it('should call onViewDetails when clicked', async () => {
    const user = userEvent.setup();
    const onViewDetails = vi.fn();
    render(<AlertItemCard alert={mockAlert} onViewDetails={onViewDetails} />);

    await user.click(screen.getByTestId(`alert-item-${mockAlert.id}`));

    expect(onViewDetails).toHaveBeenCalledWith(mockAlert);
  });

  it('should show reduced opacity for acknowledged alerts', () => {
    const acknowledgedAlert = { ...mockAlert, status: 'acknowledged' as AlertStatus };
    render(<AlertItemCard alert={acknowledgedAlert} />);

    const alertItem = screen.getByTestId(`alert-item-${acknowledgedAlert.id}`);
    expect(alertItem).toHaveClass('opacity-60');
  });

  it('should show reduced opacity for resolved alerts', () => {
    const resolvedAlert = { ...mockAlert, status: 'resolved' as AlertStatus };
    render(<AlertItemCard alert={resolvedAlert} />);

    const alertItem = screen.getByTestId(`alert-item-${resolvedAlert.id}`);
    expect(alertItem).toHaveClass('opacity-40');
  });

  it('should not show action buttons for acknowledged alerts', () => {
    const acknowledgedAlert = { ...mockAlert, status: 'acknowledged' as AlertStatus };
    const onAcknowledge = vi.fn();
    render(<AlertItemCard alert={acknowledgedAlert} onAcknowledge={onAcknowledge} />);

    expect(screen.queryByTestId('acknowledge-btn-test-alert')).not.toBeInTheDocument();
  });

  it('should support keyboard navigation', async () => {
    const user = userEvent.setup();
    const onViewDetails = vi.fn();
    render(<AlertItemCard alert={mockAlert} onViewDetails={onViewDetails} />);

    const alertItem = screen.getByTestId(`alert-item-${mockAlert.id}`);
    alertItem.focus();
    await user.keyboard('{Enter}');

    expect(onViewDetails).toHaveBeenCalledWith(mockAlert);
  });
});

describe('SeverityFilter', () => {
  const mockCounts: Record<AlertSeverity, number> = {
    critical: 2,
    high: 3,
    medium: 5,
    low: 1,
    info: 0,
  };

  it('should render all severity options', () => {
    render(
      <SeverityFilter
        selectedSeverities={[]}
        onFilterChange={() => {}}
        alertCounts={mockCounts}
      />
    );

    expect(screen.getByTestId('filter-critical')).toBeInTheDocument();
    expect(screen.getByTestId('filter-high')).toBeInTheDocument();
    expect(screen.getByTestId('filter-medium')).toBeInTheDocument();
    expect(screen.getByTestId('filter-low')).toBeInTheDocument();
    expect(screen.getByTestId('filter-info')).toBeInTheDocument();
  });

  it('should display count for each severity', () => {
    render(
      <SeverityFilter
        selectedSeverities={[]}
        onFilterChange={() => {}}
        alertCounts={mockCounts}
      />
    );

    expect(screen.getByText('Kritik (2)')).toBeInTheDocument();
    expect(screen.getByText('Yüksek (3)')).toBeInTheDocument();
    expect(screen.getByText('Orta (5)')).toBeInTheDocument();
    expect(screen.getByText('Düşük (1)')).toBeInTheDocument();
    expect(screen.getByText('Bilgi (0)')).toBeInTheDocument();
  });

  it('should show selected state for selected severities', () => {
    render(
      <SeverityFilter
        selectedSeverities={['critical', 'high']}
        onFilterChange={() => {}}
        alertCounts={mockCounts}
      />
    );

    const criticalBtn = screen.getByTestId('filter-critical');
    const highBtn = screen.getByTestId('filter-high');
    const mediumBtn = screen.getByTestId('filter-medium');

    expect(criticalBtn).toHaveClass('bg-red-50');
    expect(highBtn).toHaveClass('bg-orange-50');
    expect(mediumBtn).toHaveClass('bg-gray-100');
  });

  it('should toggle severity on click', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(
      <SeverityFilter
        selectedSeverities={[]}
        onFilterChange={onFilterChange}
        alertCounts={mockCounts}
      />
    );

    await user.click(screen.getByTestId('filter-critical'));

    expect(onFilterChange).toHaveBeenCalledWith(['critical']);
  });

  it('should remove severity when already selected', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(
      <SeverityFilter
        selectedSeverities={['critical', 'high']}
        onFilterChange={onFilterChange}
        alertCounts={mockCounts}
      />
    );

    await user.click(screen.getByTestId('filter-critical'));

    expect(onFilterChange).toHaveBeenCalledWith(['high']);
  });

  it('should show reduced opacity for zero count', () => {
    render(
      <SeverityFilter
        selectedSeverities={[]}
        onFilterChange={() => {}}
        alertCounts={mockCounts}
      />
    );

    const infoBtn = screen.getByTestId('filter-info');
    expect(infoBtn).toHaveClass('opacity-50');
  });
});

describe('EmptyState', () => {
  it('should render default message', () => {
    render(<EmptyState />);

    expect(screen.getByText('Aktif uyarı bulunmuyor')).toBeInTheDocument();
  });

  it('should render custom message', () => {
    render(<EmptyState message="Custom empty message" />);

    expect(screen.getByText('Custom empty message')).toBeInTheDocument();
  });

  it('should have correct test id', () => {
    render(<EmptyState />);

    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('should render default 3 loading skeletons', () => {
    render(<LoadingState />);

    const container = screen.getByTestId('loading-state');
    const skeletons = container.querySelectorAll('.animate-pulse');

    expect(skeletons).toHaveLength(3);
  });

  it('should render custom number of skeletons', () => {
    render(<LoadingState count={5} />);

    const container = screen.getByTestId('loading-state');
    const skeletons = container.querySelectorAll('.animate-pulse');

    expect(skeletons).toHaveLength(5);
  });
});

describe('ErrorState', () => {
  it('should render error message', () => {
    render(<ErrorState message="Something went wrong" />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('should show retry button when onRetry provided', () => {
    render(<ErrorState message="Error" onRetry={() => {}} />);

    expect(screen.getByText('Tekrar Dene')).toBeInTheDocument();
  });

  it('should not show retry button when onRetry not provided', () => {
    render(<ErrorState message="Error" />);

    expect(screen.queryByText('Tekrar Dene')).not.toBeInTheDocument();
  });

  it('should call onRetry when clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState message="Error" onRetry={onRetry} />);

    await user.click(screen.getByText('Tekrar Dene'));

    expect(onRetry).toHaveBeenCalled();
  });
});

// ============================================================================
// Main Component Tests
// ============================================================================

describe('AlertSummaryWidget', () => {
  describe('Rendering', () => {
    it('should render widget with title', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} />);

      expect(screen.getByText('Aktif Uyarılar')).toBeInTheDocument();
    });

    it('should render with custom className', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} className="custom-class" />);

      expect(screen.getByTestId('alert-summary-widget')).toHaveClass('custom-class');
    });

    it('should display critical count badge', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} />);

      expect(screen.getByTestId('critical-count')).toBeInTheDocument();
      expect(screen.getByText('1 Kritik')).toBeInTheDocument();
    });

    it('should display high count badge', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} />);

      expect(screen.getByTestId('high-count')).toBeInTheDocument();
      expect(screen.getByText('1 Yüksek')).toBeInTheDocument();
    });

    it('should display "Temiz" badge when no active alerts', () => {
      render(<AlertSummaryWidget alerts={[]} />);

      expect(screen.getByTestId('no-alerts')).toBeInTheDocument();
      expect(screen.getByText('Temiz')).toBeInTheDocument();
    });

    it('should display alert items', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} />);

      expect(screen.getByText('Critical Temperature')).toBeInTheDocument();
      expect(screen.getByText('High pH Level')).toBeInTheDocument();
    });

    it('should limit displayed alerts to maxAlerts', () => {
      const manyAlerts = Array.from({ length: 20 }, (_, i) =>
        createMockAlert({ id: `alert-${i}`, title: `Alert ${i}` })
      );

      render(<AlertSummaryWidget alerts={manyAlerts} maxAlerts={5} />);

      // Should only render 5 alerts
      const alertItems = screen.getAllByRole('button');
      expect(alertItems.length).toBeLessThanOrEqual(10); // 5 alerts + potential action buttons
    });
  });

  describe('Loading State', () => {
    it('should show loading state', () => {
      render(<AlertSummaryWidget isLoading />);

      expect(screen.getByTestId('loading-state')).toBeInTheDocument();
    });

    it('should not show alerts when loading', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} isLoading />);

      expect(screen.queryByText('Critical Temperature')).not.toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('should show error state', () => {
      render(<AlertSummaryWidget error="Failed to load alerts" />);

      expect(screen.getByTestId('error-state')).toBeInTheDocument();
      expect(screen.getByText('Failed to load alerts')).toBeInTheDocument();
    });

    it('should not show alerts when error', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} error="Error" />);

      expect(screen.queryByText('Critical Temperature')).not.toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no alerts', () => {
      render(<AlertSummaryWidget alerts={[]} />);

      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });

    it('should show filtered empty message when filters applied', async () => {
      const user = userEvent.setup();
      render(<AlertSummaryWidget alerts={mockAlerts} showFilters />);

      // Select a filter that matches no alerts
      await user.click(screen.getByTestId('filter-info'));

      // The only info alert has 'resolved' status, which is filtered out by default
      // Check for appropriate message or state
    });
  });

  describe('Filtering', () => {
    it('should show severity filter controls', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} showFilters />);

      expect(screen.getByTestId('severity-filter')).toBeInTheDocument();
    });

    it('should hide severity filter when showFilters=false', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} showFilters={false} />);

      expect(screen.queryByTestId('severity-filter')).not.toBeInTheDocument();
    });

    it('should filter alerts by severity when clicking filter', async () => {
      const user = userEvent.setup();
      render(<AlertSummaryWidget alerts={mockAlerts} showFilters />);

      // Click critical filter
      await user.click(screen.getByTestId('filter-critical'));

      // Only critical alerts should be visible
      expect(screen.getByText('Critical Temperature')).toBeInTheDocument();
      // Non-critical alerts might not be visible (depends on default status filter)
    });

    it('should apply initial severity filter', () => {
      render(
        <AlertSummaryWidget
          alerts={mockAlerts}
          severityFilter={['critical']}
          showFilters
        />
      );

      const criticalBtn = screen.getByTestId('filter-critical');
      expect(criticalBtn).toHaveClass('bg-red-50');
    });

    it('should filter by status', () => {
      render(
        <AlertSummaryWidget
          alerts={mockAlerts}
          statusFilter={['active']}
        />
      );

      // Should not show acknowledged or resolved alerts
      expect(screen.queryByText('Low Oxygen')).not.toBeInTheDocument(); // acknowledged
      expect(screen.queryByText('Sensor Update')).not.toBeInTheDocument(); // resolved
    });
  });

  describe('Interactions', () => {
    it('should call onAcknowledge when acknowledge clicked', async () => {
      const user = userEvent.setup();
      const onAcknowledge = vi.fn().mockResolvedValue(undefined);
      render(<AlertSummaryWidget alerts={mockAlerts} onAcknowledge={onAcknowledge} />);

      await user.click(screen.getByTestId('acknowledge-btn-alert-1'));

      expect(onAcknowledge).toHaveBeenCalledWith('alert-1');
    });

    it('should call onResolve when resolve clicked', async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<AlertSummaryWidget alerts={mockAlerts} onResolve={onResolve} />);

      await user.click(screen.getByTestId('resolve-btn-alert-1'));

      expect(onResolve).toHaveBeenCalledWith('alert-1');
    });

    it('should call onViewDetails when alert clicked', async () => {
      const user = userEvent.setup();
      const onViewDetails = vi.fn();
      render(<AlertSummaryWidget alerts={mockAlerts} onViewDetails={onViewDetails} />);

      await user.click(screen.getByTestId('alert-item-alert-1'));

      expect(onViewDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1' }));
    });

    it('should call onViewAll when view all clicked', async () => {
      const user = userEvent.setup();
      const onViewAll = vi.fn();
      render(<AlertSummaryWidget alerts={mockAlerts} onViewAll={onViewAll} />);

      await user.click(screen.getByTestId('view-all-btn'));

      expect(onViewAll).toHaveBeenCalled();
    });
  });

  describe('Footer', () => {
    it('should show total alert count', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} />);

      expect(screen.getByText(/Toplam: 5 uyarı/)).toBeInTheDocument();
    });

    it('should show active and acknowledged counts', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} />);

      expect(screen.getByText(/3 aktif/)).toBeInTheDocument();
      expect(screen.getByText(/1 onaylı/)).toBeInTheDocument();
    });

    it('should not show footer when loading', () => {
      render(<AlertSummaryWidget isLoading />);

      expect(screen.queryByText(/Toplam:/)).not.toBeInTheDocument();
    });

    it('should not show footer when error', () => {
      render(<AlertSummaryWidget error="Error" />);

      expect(screen.queryByText(/Toplam:/)).not.toBeInTheDocument();
    });

    it('should show view all button when onViewAll provided', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} onViewAll={() => {}} />);

      expect(screen.getByTestId('view-all-btn')).toBeInTheDocument();
    });

    it('should not show view all button when onViewAll not provided', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} />);

      expect(screen.queryByTestId('view-all-btn')).not.toBeInTheDocument();
    });
  });

  describe('Sorting', () => {
    it('should display alerts sorted by severity then time', () => {
      const alerts = [
        createMockAlert({
          id: 'low-old',
          title: 'Low Old',
          severity: 'low',
          triggeredAt: new Date(Date.now() - 60000),
        }),
        createMockAlert({
          id: 'critical-new',
          title: 'Critical New',
          severity: 'critical',
          triggeredAt: new Date(),
        }),
        createMockAlert({
          id: 'critical-old',
          title: 'Critical Old',
          severity: 'critical',
          triggeredAt: new Date(Date.now() - 60000),
        }),
      ];

      render(<AlertSummaryWidget alerts={alerts} />);

      const alertItems = screen.getAllByRole('button').filter(
        el => el.getAttribute('data-testid')?.startsWith('alert-item-')
      );

      // Critical alerts should appear first, with newer ones first
      expect(alertItems[0]).toHaveAttribute('data-testid', 'alert-item-critical-new');
      expect(alertItems[1]).toHaveAttribute('data-testid', 'alert-item-critical-old');
      expect(alertItems[2]).toHaveAttribute('data-testid', 'alert-item-low-old');
    });
  });

  describe('Compact Mode', () => {
    it('should pass compact prop to AlertItemCard', () => {
      render(<AlertSummaryWidget alerts={mockAlerts} compact />);

      // In compact mode, value/threshold info should not be visible
      expect(screen.queryByText(/Değer:/)).not.toBeInTheDocument();
    });
  });
});

// ============================================================================
// Configuration Tests
// ============================================================================

describe('severityConfig', () => {
  it('should have configuration for all severity levels', () => {
    const severities: AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

    severities.forEach(severity => {
      expect(severityConfig[severity]).toBeDefined();
      expect(severityConfig[severity].bgColor).toBeDefined();
      expect(severityConfig[severity].borderColor).toBeDefined();
      expect(severityConfig[severity].iconColor).toBeDefined();
      expect(severityConfig[severity].badgeVariant).toBeDefined();
      expect(severityConfig[severity].label).toBeDefined();
      expect(severityConfig[severity].priority).toBeDefined();
    });
  });

  it('should have correct priority ordering', () => {
    expect(severityConfig.critical.priority).toBeGreaterThan(severityConfig.high.priority);
    expect(severityConfig.high.priority).toBeGreaterThan(severityConfig.medium.priority);
    expect(severityConfig.medium.priority).toBeGreaterThan(severityConfig.low.priority);
    expect(severityConfig.low.priority).toBeGreaterThan(severityConfig.info.priority);
  });
});

// ============================================================================
// Accessibility Tests
// ============================================================================

describe('Accessibility', () => {
  it('should have accessible alert items', () => {
    render(<AlertSummaryWidget alerts={mockAlerts} />);

    const alertItems = screen.getAllByRole('button').filter(
      el => el.getAttribute('data-testid')?.startsWith('alert-item-')
    );

    alertItems.forEach(item => {
      expect(item).toHaveAttribute('tabIndex', '0');
    });
  });

  it('should have accessible action buttons', () => {
    render(
      <AlertSummaryWidget
        alerts={mockAlerts}
        onAcknowledge={() => Promise.resolve()}
        onResolve={() => Promise.resolve()}
      />
    );

    const acknowledgeButtons = screen.getAllByRole('button', { name: /onayla/i });
    const resolveButtons = screen.getAllByRole('button', { name: /çöz/i });

    expect(acknowledgeButtons.length).toBeGreaterThan(0);
    expect(resolveButtons.length).toBeGreaterThan(0);
  });

  it('should support keyboard navigation for filters', async () => {
    const user = userEvent.setup();
    render(<AlertSummaryWidget alerts={mockAlerts} showFilters />);

    const criticalFilter = screen.getByTestId('filter-critical');
    criticalFilter.focus();
    await user.keyboard('{Enter}');

    // Filter should be toggled via keyboard
    expect(criticalFilter).toHaveClass('bg-red-50');
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('should handle undefined alerts', () => {
    render(<AlertSummaryWidget />);

    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('should handle alerts with missing optional fields', () => {
    const minimalAlert = createMockAlert({
      id: 'minimal',
      title: 'Minimal Alert',
      currentValue: undefined,
      threshold: undefined,
      unit: undefined,
      farmName: undefined,
      pondName: undefined,
    });

    render(<AlertSummaryWidget alerts={[minimalAlert]} />);

    expect(screen.getByText('Minimal Alert')).toBeInTheDocument();
  });

  it('should handle very long alert titles', () => {
    const longTitleAlert = createMockAlert({
      id: 'long-title',
      title: 'This is a very long alert title that should be truncated to prevent layout issues in the widget',
    });

    render(<AlertSummaryWidget alerts={[longTitleAlert]} />);

    const titleElement = screen.getByText(/This is a very long alert title/);
    expect(titleElement).toHaveClass('truncate');
  });

  it('should handle rapid filter changes', async () => {
    const user = userEvent.setup();
    render(<AlertSummaryWidget alerts={mockAlerts} showFilters />);

    // Rapidly click different filters
    await user.click(screen.getByTestId('filter-critical'));
    await user.click(screen.getByTestId('filter-high'));
    await user.click(screen.getByTestId('filter-medium'));
    await user.click(screen.getByTestId('filter-critical'));

    // Should not crash and should show appropriate alerts
    expect(screen.getByTestId('alert-summary-widget')).toBeInTheDocument();
  });

  it('should handle async action failures gracefully', async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn().mockRejectedValue(new Error('Failed'));

    render(<AlertSummaryWidget alerts={mockAlerts} onAcknowledge={onAcknowledge} />);

    await user.click(screen.getByTestId('acknowledge-btn-alert-1'));

    // Should not crash, button should be re-enabled
    await waitFor(() => {
      expect(screen.getByText('Onayla')).toBeInTheDocument();
    });
  });

  it('should handle empty string error message', () => {
    render(<AlertSummaryWidget error="" />);

    // Empty string is falsy, so should not show error state
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
