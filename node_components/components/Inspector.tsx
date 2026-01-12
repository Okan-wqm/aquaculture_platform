// src/components/Inspector.tsx

import React, { useState, useMemo, ChangeEvent } from 'react';
import type { Node, Edge } from 'reactflow';
import { normalizeHandleKey } from '@/utils/normalizeHandleKey';
import './Inspector.css';

import type { FlowNodeData, FlowEdgeData } from './Flow/types';

type FormChangeEvent = ChangeEvent<HTMLInputElement | HTMLSelectElement>;

interface InspectorProps {
  editingNode: Node<FlowNodeData> | null;
  edges:       Edge<FlowEdgeData>[];
  setNodes:    React.Dispatch<React.SetStateAction<Node<FlowNodeData>[]>>;
  createWidgetForSensor: (node: Node<FlowNodeData>) => void;
}

export default function Inspector({
  editingNode,
  edges,
  setNodes,
  createWidgetForSensor,
}: InspectorProps) {
  const [open, setOpen] = useState(true);

  const distribution = useMemo<Record<string, number>>(
    () => editingNode?.data.outflowDistribution ?? {},
    [editingNode?.data.outflowDistribution]
  );

  const allSourceKeys = useMemo<string[]>(() => {
    if (!editingNode) return [];
    const keys = new Set<string>();
    Object.entries(editingNode.data).forEach(([k, v]) => {
      if (v === 'source') keys.add(k);
    });
    Object.keys(distribution).forEach((k) => keys.add(k));
    edges.forEach((e) => {
      if (e.source !== editingNode.id) return;
      const k = normalizeHandleKey(editingNode.type, e.sourceHandle);
      if (k) keys.add(k);
    });
    return Array.from(keys);
  }, [editingNode, edges, distribution]);

  const setDist = (key: string, val: number) => {
    if (!editingNode) return;
    setNodes((ns) =>
      ns.map((n) =>
        n.id === editingNode.id
          ? {
              ...n,
              data: {
                ...n.data,
                outflowDistribution: {
                  ...distribution,
                  [key]: val,
                },
              },
            }
          : n
      )
    );
  };

  if (!editingNode) {
    return (
      <aside className={`inspector-panel ${open ? '' : 'collapsed'}`}>
        <div className="inspector-header">
          {open && <h4>Inspector</h4>}
          <button onClick={() => setOpen((o) => !o)}>
            {open ? '»' : '«'}
          </button>
        </div>
        {open && <div className="inspector-body"><em>Seçili node yok</em></div>}
      </aside>
    );
  }

  return (
    <aside className={`inspector-panel ${open ? '' : 'collapsed'}`}>
      <div className="inspector-header">
        {open && <h4>Inspector</h4>}
        <button onClick={() => setOpen((o) => !o)}>
          {open ? '»' : '«'}
        </button>
      </div>

      {open && (
        <div className="inspector-body">
          {editingNode.type === 'sensorWidget' && (
            <>
              {/* Broker URL */}
              <div className="form-group">
                <label>Broker URL</label>
                <input
                  type="text"
                  value={editingNode.data.mqttUrl ?? ''}
                  onChange={(e: FormChangeEvent) =>
                    setNodes((ns) =>
                      ns.map((n) =>
                        n.id === editingNode.id
                          ? { ...n, data: { ...n.data, mqttUrl: e.target.value } }
                          : n
                      )
                    )
                  }
                />
              </div>

              {/* MQTT Topic */}
              <div className="form-group">
                <label>MQTT Topic</label>
                <input
                  type="text"
                  value={editingNode.data.mqttTopic ?? ''}
                  onChange={(e: FormChangeEvent) =>
                    setNodes((ns) =>
                      ns.map((n) =>
                        n.id === editingNode.id
                          ? { ...n, data: { ...n.data, mqttTopic: e.target.value } }
                          : n
                      )
                    )
                  }
                />
              </div>

              {/* Mode */}
              <div className="form-group">
                <label>Mode</label>
                <select
                  value={editingNode.data.mode ?? 'push'}
                  onChange={(e: FormChangeEvent) => {
                    const newMode = e.target.value as FlowNodeData['mode'];
                    setNodes((ns) =>
                      ns.map((n) =>
                        n.id === editingNode.id
                          ? { ...n, data: { ...n.data, mode: newMode } }
                          : n
                      )
                    );
                  }}
                >
                  <option value="push">MQTT Push</option>
                  <option value="poll">HTTP Poll</option>
                  <option value="onChange">On Change</option>
                </select>
              </div>

              {/* HTTP URL */}
              {editingNode.data.mode !== 'push' && (
                <div className="form-group">
                  <label>HTTP URL</label>
                  <input
                    type="text"
                    value={editingNode.data.httpUrl ?? ''}
                    onChange={(e: FormChangeEvent) =>
                      setNodes((ns) =>
                        ns.map((n) =>
                          n.id === editingNode.id
                            ? { ...n, data: { ...n.data, httpUrl: e.target.value } }
                            : n
                        )
                      )
                    }
                  />
                </div>
              )}

              {/* Poll Interval */}
              {editingNode.data.mode === 'poll' && (
                <div className="form-group">
                  <label>Poll Interval (s)</label>
                  <input
                    type="number"
                    value={String(editingNode.data.pollInterval ?? 5)}
                    onChange={(e: FormChangeEvent) =>
                      setNodes((ns) =>
                        ns.map((n) =>
                          n.id === editingNode.id
                            ? {
                                ...n,
                                data: {
                                  ...n.data,
                                  pollInterval: parseInt(e.target.value, 10) || 5,
                                },
                              }
                            : n
                        )
                      )
                    }
                  />
                </div>
              )}

              {/* Unit */}
              <div className="form-group">
                <label>Unit</label>
                <input
                  type="text"
                  value={editingNode.data.unit ?? ''}
                  onChange={(e: FormChangeEvent) =>
                    setNodes((ns) =>
                      ns.map((n) =>
                        n.id === editingNode.id
                          ? { ...n, data: { ...n.data, unit: e.target.value } }
                          : n
                      )
                    )
                  }
                />
              </div>

              <button
                className="btn-create-widget"
                onClick={() => createWidgetForSensor(editingNode)}
              >
                Widget Oluştur
              </button>
            </>
          )}

          {/* Başlık */}
          <div className="form-group">
            <label>Başlık</label>
            <input
              type="text"
              value={editingNode.data.label ?? ''}
              onChange={(e: FormChangeEvent) =>
                setNodes((ns) =>
                  ns.map((n) =>
                    n.id === editingNode.id
                      ? { ...n, data: { ...n.data, label: e.target.value } }
                      : n
                  )
                )
              }
            />
          </div>

          {/* Alt Başlık */}
          <div className="form-group">
            <label>Alt Başlık</label>
            <input
              type="text"
              value={editingNode.data.subtitle ?? ''}
              onChange={(e: FormChangeEvent) =>
                setNodes((ns) =>
                  ns.map((n) =>
                    n.id === editingNode.id
                      ? { ...n, data: { ...n.data, subtitle: e.target.value } }
                      : n
                  )
                )
              }
            />
          </div>

          {/* Water Source */}
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={Boolean(editingNode.data.isWaterSource)}
                onChange={(e) =>
                  setNodes((ns) =>
                    ns.map((n) =>
                      n.id === editingNode.id
                        ? { ...n, data: { ...n.data, isWaterSource: e.target.checked } }
                        : n
                    )
                  )
                }
              />{' '}
              Is Water Source?
            </label>
          </div>
          {/* Flow Rate */}
          {editingNode.data.isWaterSource && (
            <div className="form-group">
              <label>Flow Rate</label>
              <input
                type="number"
                value={String(editingNode.data.flowRate ?? 0)}
                onChange={(e) =>
                  setNodes((ns) =>
                    ns.map((n) =>
                      n.id === editingNode.id
                        ? { ...n, data: { ...n.data, flowRate: parseFloat(e.target.value) || 0 } }
                        : n
                    )
                  )
                }
              />
            </div>
          )}

          {/* Air Source */}
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={Boolean(editingNode.data.isAirSource)}
                onChange={(e) =>
                  setNodes((ns) =>
                    ns.map((n) =>
                      n.id === editingNode.id
                        ? { ...n, data: { ...n.data, isAirSource: e.target.checked } }
                        : n
                    )
                  )
                }
              />{' '}
              Is Air Source?
            </label>
          </div>
          {/* Air Flow Rate */}
          {editingNode.data.isAirSource && (
            <div className="form-group">
              <label>Air Flow Rate</label>
              <input
                type="number"
                value={String(editingNode.data.airFlowRate ?? 0)}
                onChange={(e) =>
                  setNodes((ns) =>
                    ns.map((n) =>
                      n.id === editingNode.id
                        ? { ...n, data: { ...n.data, airFlowRate: parseFloat(e.target.value) || 0 } }
                        : n
                    )
                  )
                }
              />
            </div>
          )}

          {/* Computed flows */}
          {typeof editingNode.data.calculatedFlow === 'number' && (
            <div className="computed">
              <strong>Water:</strong> {editingNode.data.calculatedFlow}
            </div>
          )}
          {typeof editingNode.data.calculatedAirFlow === 'number' && (
            <div className="computed">
              <strong>Air:</strong> {editingNode.data.calculatedAirFlow}
            </div>
          )}

          <hr />
          <h5>Dağıtım Yüzdeleri</h5>
          {allSourceKeys.length === 0 && (
            <div className="no-selection">Dağıtım noktası yok</div>
          )}
          {allSourceKeys.map((key) => (
            <div className="form-group" key={key}>
              <label>{`${key} (%)`}</label>
              <input
                type="number"
                value={String(distribution[key] ?? 0)}
                onChange={(e) => setDist(key, parseFloat(e.target.value) || 0)}
              />
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
