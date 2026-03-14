/**
 * StOutlineTree - Recursive tree view for ST code structure
 *
 * Shows PROGRAM, FUNCTION_BLOCK, FUNCTION, VAR blocks, variables, control structures.
 * Click a node to navigate Monaco editor to that line.
 */

import React, { useState, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Code2,
  Variable,
  Braces,
  FunctionSquare,
  Box,
  Layers,
  Hash,
  List,
  type LucideIcon,
} from 'lucide-react';

export interface OutlineNode {
  name: string;
  kind:
    | 'program'
    | 'functionBlock'
    | 'function'
    | 'method'
    | 'property'
    | 'varBlock'
    | 'variable'
    | 'type'
    | 'struct'
    | 'enum';
  line: number;
  endLine?: number;
  children?: OutlineNode[];
  detail?: string; // e.g., ": REAL" for variables
}

interface StOutlineTreeProps {
  outline: OutlineNode[];
  onNavigate: (line: number) => void;
  activeLineNumber?: number;
}

const KIND_CONFIG: Record<OutlineNode['kind'], { icon: LucideIcon; color: string }> = {
  program: { icon: Code2, color: 'text-cyan-400' },
  functionBlock: { icon: FunctionSquare, color: 'text-purple-400' },
  function: { icon: FunctionSquare, color: 'text-blue-400' },
  method: { icon: FunctionSquare, color: 'text-blue-300' },
  property: { icon: Variable, color: 'text-green-300' },
  varBlock: { icon: Braces, color: 'text-yellow-400' },
  variable: { icon: Variable, color: 'text-green-400' },
  type: { icon: Box, color: 'text-orange-400' },
  struct: { icon: Layers, color: 'text-orange-300' },
  enum: { icon: List, color: 'text-pink-400' },
};

const StOutlineTree: React.FC<StOutlineTreeProps> = ({
  outline,
  onNavigate,
  activeLineNumber,
}) => {
  if (outline.length === 0) {
    return (
      <div className="px-2 py-4 text-xs text-gray-600 text-center">
        No outline available
      </div>
    );
  }

  return (
    <div className="py-1 select-none text-xs">
      {outline.map((node, i) => (
        <OutlineNodeItem
          key={`${node.kind}-${node.name}-${node.line}-${i}`}
          node={node}
          depth={0}
          onNavigate={onNavigate}
          activeLineNumber={activeLineNumber}
        />
      ))}
    </div>
  );
};

interface OutlineNodeItemProps {
  node: OutlineNode;
  depth: number;
  onNavigate: (line: number) => void;
  activeLineNumber?: number;
}

const OutlineNodeItem: React.FC<OutlineNodeItemProps> = ({
  node,
  depth,
  onNavigate,
  activeLineNumber,
}) => {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;

  const config = KIND_CONFIG[node.kind] ?? { icon: Hash, color: 'text-gray-500' };
  const Icon = config.icon;

  const isActive =
    activeLineNumber !== undefined &&
    activeLineNumber >= node.line &&
    (node.endLine === undefined || activeLineNumber <= node.endLine);

  const handleClick = useCallback(() => {
    onNavigate(node.line);
  }, [onNavigate, node.line]);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setExpanded((prev) => !prev);
    },
    [],
  );

  return (
    <>
      <div
        onClick={handleClick}
        className={`flex items-center gap-1 py-0.5 pr-2 cursor-pointer hover:bg-gray-800 ${
          isActive ? 'bg-gray-800/60 text-white' : 'text-gray-500'
        }`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <button
            onClick={handleToggle}
            className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-gray-500 hover:text-gray-500"
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        ) : (
          <span className="w-4 h-4 flex-shrink-0" />
        )}

        {/* Icon */}
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${config.color}`} />

        {/* Name */}
        <span className="truncate flex-1">{node.name}</span>

        {/* Detail (type annotation) */}
        {node.detail && (
          <span className="text-gray-500 text-[10px] ml-1 flex-shrink-0 truncate max-w-[80px]">
            {node.detail}
          </span>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div>
          {node.children!.map((child, i) => (
            <OutlineNodeItem
              key={`${child.kind}-${child.name}-${child.line}-${i}`}
              node={child}
              depth={depth + 1}
              onNavigate={onNavigate}
              activeLineNumber={activeLineNumber}
            />
          ))}
        </div>
      )}
    </>
  );
};

export default StOutlineTree;
