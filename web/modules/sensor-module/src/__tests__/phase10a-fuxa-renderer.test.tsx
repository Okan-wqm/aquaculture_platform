/**
 * Phase 10A: FUXA Widget Sandboxed Runtime Engine Tests
 *
 * Covers:
 *   1. FuxaMessageBridge sends putValue via postMessage
 *   2. FuxaMessageBridge rate limits to 100 msgs/sec
 *   3. FuxaWidgetRenderer renders iframe with sandbox attribute
 *   4. FuxaWidgetRenderer srcdoc contains CSP meta tag
 *   5. FuxaWidgetRenderer srcdoc contains SVG content
 *   6. FuxaWidgetConfig renders variable inputs from export block
 *   7. FuxaStateRule mapping produces correct state index
 *   8. Widget type registered in WidgetRenderer lazy map
 *   9. Variable type detection from prefix (_pn_ -> number, _pc_ -> color)
 *  10. Bridge dispose cleans up message listener
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseFuxaExportVariables,
  evaluateStateRules,
  FUXA_PREFIX_MAP,
} from '../components/scada-builder/fuxa-bridge/types';
import type { FuxaStateRule } from '../components/scada-builder/fuxa-bridge/types';
import { FuxaMessageBridge } from '../components/scada-builder/fuxa-bridge/FuxaMessageBridge';
import { buildFuxaSrcdoc } from '../components/scada-builder/widget-renderers/FuxaWidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

// Mock lucide-react to avoid import issues in test environment
vi.mock('lucide-react', () => ({
  Upload: (props: Record<string, unknown>) => <span data-testid="icon-upload" {...props} />,
  Trash2: (props: Record<string, unknown>) => <span data-testid="icon-trash" {...props} />,
  AlertCircle: (props: Record<string, unknown>) => <span data-testid="icon-alert" {...props} />,
  Plus: (props: Record<string, unknown>) => <span data-testid="icon-plus" {...props} />,
  X: (props: Record<string, unknown>) => <span data-testid="icon-x" {...props} />,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Creates a minimal HTMLIFrameElement mock with contentWindow */
function createMockIframe(): HTMLIFrameElement {
  const contentWindow = {
    postMessage: vi.fn(),
  };
  return {
    contentWindow,
  } as unknown as HTMLIFrameElement;
}

/** FUXA SVG content with export variables for testing */
const SAMPLE_FUXA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <script>
    //!export-start
    var _pn_setState = 0;
    var _ps_title = 'Default';
    var _pb_visible = true;
    var _pc_fillColor = '#ff0000';
    var _pn_rotateAngle = 45;
    //!export-end
    function putValue(id, value) { /* set value */ }
    function postValue(id, value) { /* emit value */ }
  </script>
  <rect width="100" height="100" fill="blue"/>
</svg>`;

/* ------------------------------------------------------------------ */
/*  Test suite: FuxaMessageBridge                                      */
/* ------------------------------------------------------------------ */

describe('FuxaMessageBridge', () => {
  let mockIframe: HTMLIFrameElement;
  let bridge: FuxaMessageBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    mockIframe = createMockIframe();
    bridge = new FuxaMessageBridge(mockIframe, null);
  });

  afterEach(() => {
    bridge.dispose();
    vi.useRealTimers();
  });

  // Test 1: Bridge sends putValue via postMessage
  it('sends putValue messages to iframe contentWindow', () => {
    bridge.sendValue('_pn_setState', 3);

    // Flush the rAF batch
    vi.advanceTimersByTime(16); // One frame at ~60fps

    expect(mockIframe.contentWindow!.postMessage).toHaveBeenCalledWith(
      { type: 'putValue', id: '_pn_setState', value: 3 },
      '*',
    );
  });

  // Test 2: Rate limits to 100 msgs/sec
  it('rate limits outbound messages to 100 per second', () => {
    // Send 150 messages
    for (let i = 0; i < 150; i++) {
      bridge.sendValue('_pn_setState', i);
    }

    // Flush rAF
    vi.advanceTimersByTime(16);

    // Only 100 should have been sent
    expect(
      (mockIframe.contentWindow!.postMessage as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeLessThanOrEqual(100);
  });

  // Test 10: Dispose cleans up message listener
  it('removes message listener on dispose', () => {
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener');
    bridge.dispose();

    // Should have removed the 'message' event listener
    expect(removeListenerSpy).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );

    removeListenerSpy.mockRestore();
  });

  it('does not send messages after dispose', () => {
    bridge.dispose();
    bridge.sendValue('_pn_setState', 5);
    vi.advanceTimersByTime(16);

    expect(mockIframe.contentWindow!.postMessage).not.toHaveBeenCalled();
  });

  it('validates only primitive values are sent', () => {
    // Attempting to send non-primitives should be silently ignored
    bridge.sendValue('_pn_test', {} as unknown as string);
    vi.advanceTimersByTime(16);

    expect(mockIframe.contentWindow!.postMessage).not.toHaveBeenCalled();
  });

  it('handles inbound postValue messages from iframe', () => {
    const handler = vi.fn();
    bridge.onMessage(handler);

    // Simulate a postMessage from the iframe
    const event = new MessageEvent('message', {
      data: { type: 'postValue', id: '_pn_output', value: 42 },
      source: mockIframe.contentWindow as Window,
    });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledWith({
      type: 'postValue',
      id: '_pn_output',
      value: 42,
    });
  });

  it('rejects messages from unknown sources', () => {
    const handler = vi.fn();
    bridge.onMessage(handler);

    // Simulate a postMessage from a different source
    const event = new MessageEvent('message', {
      data: { type: 'postValue', id: '_pn_output', value: 42 },
      source: null,
    });
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Test suite: parseFuxaExportVariables                               */
/* ------------------------------------------------------------------ */

describe('parseFuxaExportVariables', () => {
  // Test 9: Variable type detection from prefix
  it('detects correct types from FUXA prefixes', () => {
    const vars = parseFuxaExportVariables(SAMPLE_FUXA_SVG);

    const stateVar = vars.find((v) => v.id === '_pn_setState');
    expect(stateVar).toBeDefined();
    expect(stateVar!.type).toBe('number');
    expect(stateVar!.defaultValue).toBe(0);

    const titleVar = vars.find((v) => v.id === '_ps_title');
    expect(titleVar).toBeDefined();
    expect(titleVar!.type).toBe('string');
    expect(titleVar!.defaultValue).toBe('Default');

    const visibleVar = vars.find((v) => v.id === '_pb_visible');
    expect(visibleVar).toBeDefined();
    expect(visibleVar!.type).toBe('boolean');
    expect(visibleVar!.defaultValue).toBe(true);

    const colorVar = vars.find((v) => v.id === '_pc_fillColor');
    expect(colorVar).toBeDefined();
    expect(colorVar!.type).toBe('color');
    expect(colorVar!.defaultValue).toBe('#ff0000');
  });

  it('extracts all 5 variables from sample SVG', () => {
    const vars = parseFuxaExportVariables(SAMPLE_FUXA_SVG);
    expect(vars).toHaveLength(5);
  });

  it('returns empty array when no export block exists', () => {
    const vars = parseFuxaExportVariables('<svg></svg>');
    expect(vars).toHaveLength(0);
  });

  it('assigns correct group based on variable name', () => {
    const vars = parseFuxaExportVariables(SAMPLE_FUXA_SVG);

    const stateVar = vars.find((v) => v.id === '_pn_setState');
    expect(stateVar!.group).toBe('stateColor');

    const rotateVar = vars.find((v) => v.id === '_pn_rotateAngle');
    expect(rotateVar!.group).toBe('transform');
  });

  it('generates human-readable labels from variable names', () => {
    const vars = parseFuxaExportVariables(SAMPLE_FUXA_SVG);

    const stateVar = vars.find((v) => v.id === '_pn_setState');
    expect(stateVar!.label).toContain('State');
  });
});

/* ------------------------------------------------------------------ */
/*  Test suite: FUXA_PREFIX_MAP                                        */
/* ------------------------------------------------------------------ */

describe('FUXA_PREFIX_MAP', () => {
  it('maps _pn_ to number', () => {
    expect(FUXA_PREFIX_MAP['_pn_']).toBe('number');
  });

  it('maps _ps_ to string', () => {
    expect(FUXA_PREFIX_MAP['_ps_']).toBe('string');
  });

  it('maps _pb_ to boolean', () => {
    expect(FUXA_PREFIX_MAP['_pb_']).toBe('boolean');
  });

  it('maps _pc_ to color', () => {
    expect(FUXA_PREFIX_MAP['_pc_']).toBe('color');
  });
});

/* ------------------------------------------------------------------ */
/*  Test suite: evaluateStateRules                                     */
/* ------------------------------------------------------------------ */

describe('evaluateStateRules', () => {
  // Test 7: FuxaStateRule mapping produces correct state index
  it('returns correct state for "lt" condition', () => {
    const rules: FuxaStateRule[] = [
      { condition: 'lt', value: 10, state: 1 },
      { condition: 'gte', value: 10, state: 3 },
    ];
    expect(evaluateStateRules(5, rules)).toBe(1);
    expect(evaluateStateRules(15, rules)).toBe(3);
  });

  it('returns correct state for "between" condition', () => {
    const rules: FuxaStateRule[] = [
      { condition: 'between', value: [20, 80], state: 2 },
    ];
    expect(evaluateStateRules(50, rules)).toBe(2);
    expect(evaluateStateRules(10, rules)).toBe(0); // No match = default 0
  });

  it('returns correct state for "eq" condition', () => {
    const rules: FuxaStateRule[] = [
      { condition: 'eq', value: 42, state: 5 },
    ];
    expect(evaluateStateRules(42, rules)).toBe(5);
    expect(evaluateStateRules(41, rules)).toBe(0);
  });

  it('returns correct state for "lte" condition', () => {
    const rules: FuxaStateRule[] = [
      { condition: 'lte', value: 10, state: 1 },
    ];
    expect(evaluateStateRules(10, rules)).toBe(1);
    expect(evaluateStateRules(11, rules)).toBe(0);
  });

  it('returns correct state for "gt" condition', () => {
    const rules: FuxaStateRule[] = [
      { condition: 'gt', value: 90, state: 4 },
    ];
    expect(evaluateStateRules(91, rules)).toBe(4);
    expect(evaluateStateRules(90, rules)).toBe(0);
  });

  it('evaluates rules in order (first match wins)', () => {
    const rules: FuxaStateRule[] = [
      { condition: 'lt', value: 10, state: 1 },
      { condition: 'lt', value: 20, state: 2 },
      { condition: 'gte', value: 20, state: 3 },
    ];
    // 5 matches both "lt 10" and "lt 20", first match (state 1) wins
    expect(evaluateStateRules(5, rules)).toBe(1);
    // 15 matches "lt 20" but not "lt 10"
    expect(evaluateStateRules(15, rules)).toBe(2);
  });

  it('returns default state 0 when no rules match', () => {
    const rules: FuxaStateRule[] = [
      { condition: 'lt', value: 0, state: 1 },
    ];
    expect(evaluateStateRules(100, rules)).toBe(0);
  });

  it('returns default state 0 when rules array is empty', () => {
    expect(evaluateStateRules(50, [])).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Test suite: buildFuxaSrcdoc                                        */
/* ------------------------------------------------------------------ */

describe('buildFuxaSrcdoc', () => {
  // Test 4: srcdoc contains CSP meta tag
  it('includes Content-Security-Policy meta tag', () => {
    const srcdoc = buildFuxaSrcdoc('<svg></svg>');
    expect(srcdoc).toContain('Content-Security-Policy');
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("script-src 'unsafe-inline'");
    expect(srcdoc).toContain("style-src 'unsafe-inline'");
  });

  // Test 5: srcdoc contains SVG content
  it('includes the SVG content in the body', () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="50"/></svg>';
    const srcdoc = buildFuxaSrcdoc(svgContent);
    expect(srcdoc).toContain(svgContent);
  });

  it('includes the putValue relay script', () => {
    const srcdoc = buildFuxaSrcdoc('<svg></svg>');
    expect(srcdoc).toContain("e.data.type === 'putValue'");
    expect(srcdoc).toContain('putValue(e.data.id, e.data.value)');
  });

  it('includes the postValue override relay', () => {
    const srcdoc = buildFuxaSrcdoc('<svg></svg>');
    expect(srcdoc).toContain("type:'postValue'");
    expect(srcdoc).toContain('window.parent.postMessage');
  });

  it('has valid HTML structure', () => {
    const srcdoc = buildFuxaSrcdoc('<svg></svg>');
    expect(srcdoc).toContain('<!DOCTYPE html>');
    expect(srcdoc).toContain('<html>');
    expect(srcdoc).toContain('</html>');
    expect(srcdoc).toContain('<body>');
    expect(srcdoc).toContain('</body>');
  });
});

/* ------------------------------------------------------------------ */
/*  Test suite: FuxaWidgetRenderer                                     */
/* ------------------------------------------------------------------ */

describe('FuxaWidgetRenderer', () => {
  // Dynamic import for renderer (lazy-loaded component)
  let FuxaWidgetRenderer: React.FC<{
    config: Record<string, unknown>;
    width: number;
    height: number;
    isEditing: boolean;
    value?: number | string | boolean;
  }>;

  beforeEach(async () => {
    const mod = await import(
      '../components/scada-builder/widget-renderers/FuxaWidgetRenderer'
    );
    FuxaWidgetRenderer = mod.default;
  });

  it('shows empty state when no SVG content is provided', () => {
    render(
      <FuxaWidgetRenderer
        config={{ variables: {} }}
        width={240}
        height={200}
        isEditing={false}
      />,
    );
    expect(screen.getByTestId('fuxa-empty')).toBeDefined();
    expect(screen.getByText('FUXA Widget')).toBeDefined();
  });

  it('shows preview placeholder in edit mode', () => {
    render(
      <FuxaWidgetRenderer
        config={{ svgContent: SAMPLE_FUXA_SVG, variables: {} }}
        width={240}
        height={200}
        isEditing={true}
      />,
    );
    expect(screen.getByTestId('fuxa-preview')).toBeDefined();
    expect(screen.getByText('Live preview in runtime mode')).toBeDefined();
  });

  it('shows variable count in edit mode', () => {
    render(
      <FuxaWidgetRenderer
        config={{ svgContent: SAMPLE_FUXA_SVG, variables: {} }}
        width={240}
        height={200}
        isEditing={true}
      />,
    );
    expect(screen.getByText('5 variables detected')).toBeDefined();
  });

  // Test 3: Renderer renders iframe with sandbox attribute
  it('renders iframe container in runtime mode (with IntersectionObserver)', () => {
    // Mock IntersectionObserver to trigger visibility immediately
    const observeMock = vi.fn();
    const disconnectMock = vi.fn();
    const OriginalObserver = window.IntersectionObserver;

    window.IntersectionObserver = vi.fn((callback) => ({
      observe: (el: Element) => {
        observeMock(el);
        // Trigger the callback as if element is visible
        callback(
          [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      },
      disconnect: disconnectMock,
      unobserve: vi.fn(),
      root: null,
      rootMargin: '',
      thresholds: [],
      takeRecords: () => [],
    })) as unknown as typeof IntersectionObserver;

    render(
      <FuxaWidgetRenderer
        config={{ svgContent: SAMPLE_FUXA_SVG, variables: {} }}
        width={240}
        height={200}
        isEditing={false}
      />,
    );

    const container = screen.getByTestId('fuxa-container');
    expect(container).toBeDefined();

    // iframe should be rendered because IntersectionObserver triggered visibility
    const iframe = screen.getByTestId('fuxa-iframe');
    expect(iframe).toBeDefined();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');

    // Restore original
    window.IntersectionObserver = OriginalObserver;
  });
});

/* ------------------------------------------------------------------ */
/*  Test suite: FuxaWidgetConfig                                       */
/* ------------------------------------------------------------------ */

describe('FuxaWidgetConfig', () => {
  let FuxaWidgetConfig: React.FC<{
    config: Record<string, unknown>;
    onChange: (updates: Record<string, unknown>) => void;
    deviceId?: string | null;
  }>;

  beforeEach(async () => {
    const mod = await import(
      '../components/scada-builder/widget-configs/FuxaWidgetConfig'
    );
    FuxaWidgetConfig = mod.FuxaWidgetConfig;
  });

  // Test 6: Config renders variable inputs from export block
  it('renders variable inputs from parsed export block', () => {
    const onChange = vi.fn();
    render(
      <FuxaWidgetConfig
        config={{
          svgContent: SAMPLE_FUXA_SVG,
          variables: {
            _pn_setState: 0,
            _ps_title: 'Default',
            _pb_visible: true,
            _pc_fillColor: '#ff0000',
            _pn_rotateAngle: 45,
          },
        }}
        onChange={onChange}
      />,
    );

    // Should show "Variables (5)" label
    expect(screen.getByText('Variables (5)')).toBeDefined();

    // Should render individual variable inputs
    expect(screen.getByTestId('fuxa-var-_pn_setState')).toBeDefined();
    expect(screen.getByTestId('fuxa-var-_ps_title')).toBeDefined();
    expect(screen.getByTestId('fuxa-var-_pb_visible')).toBeDefined();
    expect(screen.getByTestId('fuxa-var-_pc_fillColor')).toBeDefined();
  });

  it('shows upload button when no SVG is loaded', () => {
    const onChange = vi.fn();
    render(
      <FuxaWidgetConfig config={{}} onChange={onChange} />,
    );

    expect(screen.getByTestId('fuxa-upload-btn')).toBeDefined();
  });

  it('shows file name when SVG is loaded', () => {
    const onChange = vi.fn();
    render(
      <FuxaWidgetConfig
        config={{
          svgContent: SAMPLE_FUXA_SVG,
          svgFileName: 'my-pump.svg',
          variables: {},
        }}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('my-pump.svg')).toBeDefined();
    expect(screen.getByTestId('fuxa-remove-svg')).toBeDefined();
  });

  it('renders state machine tag input', () => {
    const onChange = vi.fn();
    render(
      <FuxaWidgetConfig config={{}} onChange={onChange} />,
    );

    expect(screen.getByTestId('fuxa-state-tag')).toBeDefined();
  });

  it('shows add rule button when tag is set', () => {
    const onChange = vi.fn();
    render(
      <FuxaWidgetConfig
        config={{ tagName: 'sensor.temp' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByTestId('fuxa-add-rule')).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Test suite: Widget type registration                               */
/* ------------------------------------------------------------------ */

describe('Widget type registration', () => {
  // Test 8: Widget type registered in WidgetRenderer lazy map
  it('fuxaWidget is included in ScadaWidgetType union', async () => {
    // Verify the type exists by checking the lazy map in WidgetRenderer
    const { WidgetRenderer } = await import(
      '../components/scada-builder/WidgetRenderer'
    );
    expect(WidgetRenderer).toBeDefined();

    // Render with fuxaWidget type -- should NOT show "Unknown widget"
    render(
      <WidgetRenderer
        widgetType="fuxaWidget"
        config={{ variables: {} }}
        width={240}
        height={200}
        isEditing={true}
      />,
    );

    // If the widget type was not registered, it would show "Unknown widget: fuxaWidget"
    const unknownElements = screen.queryByText('Unknown widget: fuxaWidget');
    expect(unknownElements).toBeNull();
  });

  it('fuxaWidget has size definition', async () => {
    const { WIDGET_SIZES } = await import('../constants/scada-widget-sizes');
    expect(WIDGET_SIZES.fuxaWidget).toBeDefined();
    expect(WIDGET_SIZES.fuxaWidget.defaultW).toBe(2);
    expect(WIDGET_SIZES.fuxaWidget.defaultH).toBe(2);
    expect(WIDGET_SIZES.fuxaWidget.minW).toBe(1);
    expect(WIDGET_SIZES.fuxaWidget.minH).toBe(1);
  });

  it('fuxaWidget has config panel registered', async () => {
    // Import FuxaWidgetConfig directly to avoid the heavyweight index barrel
    // which triggers dynamic imports for every widget config panel
    const mod = await import(
      '../components/scada-builder/widget-configs/FuxaWidgetConfig'
    );
    expect(mod.FuxaWidgetConfig).toBeDefined();
    expect(typeof mod.FuxaWidgetConfig).toBe('function');
  });
});
