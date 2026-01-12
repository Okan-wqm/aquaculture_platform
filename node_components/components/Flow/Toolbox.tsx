import React, { ChangeEvent } from 'react';
import { loadNodeTypes } from '@/utils/loadNodeTypes';

const nodeTypes = loadNodeTypes();
const iconNames = Object.keys(nodeTypes);



export interface Project { id: string; name: string }

interface ToolboxProps {
  isOpen: boolean;
  toggleOpen: () => void;
  projects: Project[];
  selectedProjectId: string;
  projectName: string;
  setSelectedProjectId: (id: string) => void;
  setProjectName: (name: string) => void;
  loadProject: (id: string) => void;
  saveProject: () => void;
  deleteProject: () => void;
  onRunFlow: () => void;
  iconNames: string[];
  selectedNodeType: string;
  setSelectedNodeType: (t: string) => void;
  selectedEdgeType: 'multiHandle' | 'draggable';
  setSelectedEdgeType: (t: 'multiHandle' | 'draggable') => void;
  addNode: () => void;
  showGrid: boolean;
  setShowGrid: (v: boolean) => void;
}

export default function Toolbox({
  isOpen,
  toggleOpen,
  projects,
  selectedProjectId,
  projectName,
  setSelectedProjectId,
  setProjectName,
  loadProject,
  saveProject,
  deleteProject,
  onRunFlow,
  iconNames,
  selectedNodeType,
  setSelectedNodeType,
  selectedEdgeType,
  setSelectedEdgeType,
  addNode,
  showGrid,
  setShowGrid,
}: ToolboxProps) {
  return (
    <aside
      className={`react-sidebar ${isOpen ? '' : 'collapsed'}`}
      style={{ width: isOpen ? 200 : 50 }}
    >
      <div className="react-sidebar-header">
        <button
          className="sidebar-toggle"
          onClick={toggleOpen}
          aria-label={isOpen ? 'Kapat' : 'Aç'}
        >
          {isOpen ? '«' : '»'}
        </button>
        {isOpen && <h4 className="sidebar-title">Project Settings</h4>}
      </div>

      {isOpen && (
        <div className="react-sidebar-body">
          <div className="field">
            <label>Proje Seç</label>
            <select
              value={selectedProjectId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                setSelectedProjectId(e.target.value);
                loadProject(e.target.value);
              }}
            >
              <option value="">(Yeni Proje)</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Proje Adı</label>
            <input
              type="text"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
            />
          </div>

          <div className="field node-type-field">
            <label>Node Tipi</label>
            <div className="node-type-inputs">
              <select
                  value={selectedNodeType}
                  onChange={(e) => setSelectedNodeType(e.target.value)}
              >
                {iconNames.length === 0 && <option>(ikon yok)</option>}
                {iconNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                ))}
              </select>

              <button onClick={addNode} disabled={iconNames.length === 0}>
                + Ekle
              </button>
            </div>
          </div>

          <div className="field">
            <label>Edge Tipi</label>
            <select
                value={selectedEdgeType}
                onChange={e =>
                setSelectedEdgeType(e.target.value as 'multiHandle' | 'draggable')
              }
            >
              <option value="multiHandle">MultiHandle</option>
              <option value="draggable">Draggable</option>
            </select>
          </div>

          <div className="field">
            <label>Grid Göster</label>
            <input
              type="checkbox"
              checked={showGrid}
              onChange={e => setShowGrid(e.target.checked)}
            />
          </div>

          <div className="actions">
            <button onClick={saveProject}>Kaydet</button>
            <button onClick={deleteProject}>Sil</button>
            <button onClick={onRunFlow}>Run Flow</button>
          </div>
        </div>
      )}
    </aside>
  );
}
