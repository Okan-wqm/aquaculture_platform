/**
 * AlgaeBagNode Component
 * Algae cultivation bag with triangular stand
 * Supports three color variants: red (Rhodomonas), green (Chlorella), yellow (Dunaliella)
 */

import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals, NodeProps, Position, type Node } from '@xyflow/react';
import { useProcessStore } from '../../../store/processStore';
import { colors as themeColors } from '@aquaculture/shared-ui';

type HandleType = 'source' | 'target';

/**
 * Node data keys that can be updated for handles
 */
type HandleDataKey =
  | 'top1Type'
  | 'top2Type'
  | 'top3Type'
  | 'top4Type'
  | 'leftType'
  | 'rightType'
  | 'bottomType';

interface AlgaeBagNodeData extends Record<string, unknown> {
  color?: 'red' | 'green' | 'yellow';
  label?: string;
  top1Type?: HandleType;
  top2Type?: HandleType;
  top3Type?: HandleType;
  top4Type?: HandleType;
  leftType?: HandleType;
  rightType?: HandleType;
  bottomType?: HandleType;
}

const WIDTH = 150;
const HEIGHT = 350;

// Color configurations for different algae types
const colorConfigs = {
  red: {
    gradient1: themeColors.accent[200],
    gradient2: themeColors.accent[400],
    surface: themeColors.accent[400],
    label: 'Rhodomonas Bag',
  },
  green: {
    gradient1: themeColors.secondary[200],
    gradient2: themeColors.success[500],
    surface: themeColors.success[500],
    label: 'Chlorella Bag',
  },
  yellow: {
    gradient1: themeColors.warning[500],
    gradient2: themeColors.warning[500],
    surface: themeColors.warning[500],
    label: 'Dunaliella Bag',
  },
};

const AlgaeBagNode: React.FC<NodeProps<Node<AlgaeBagNodeData>>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useProcessStore((state) => state.updateNodeData);

  const color = data?.color || 'red';
  const config = colorConfigs[color];

  const [top1Type, setTop1Type] = useState<HandleType>(data?.top1Type || 'target');
  const [top2Type, setTop2Type] = useState<HandleType>(data?.top2Type || 'target');
  const [top3Type, setTop3Type] = useState<HandleType>(data?.top3Type || 'target');
  const [top4Type, setTop4Type] = useState<HandleType>(data?.top4Type || 'target');
  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');
  const [bottomType, setBottomType] = useState<HandleType>(data?.bottomType || 'source');

  const getColor = (type: HandleType) =>
    type === 'source' ? themeColors.success[500] : themeColors.info[500];

  const toggleHandle = (
    e: React.MouseEvent,
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: HandleDataKey,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const newVal: HandleType = current === 'source' ? 'target' : 'source';
    setFunc(newVal);
    updateNodeData(id, { [key]: newVal } as Partial<AlgaeBagNodeData>);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [
    id,
    top1Type,
    top2Type,
    top3Type,
    top4Type,
    leftType,
    rightType,
    bottomType,
    updateNodeInternals,
  ]);

  const gradientId = `algaeGradient-${id}`;

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        position: 'relative',
        pointerEvents: 'none',
        border: selected ? `2px solid ${themeColors.info[500]}` : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox="0 0 150 350"
        xmlns="http://www.w3.org/2000/svg"
        className="pointer-events-auto"
      >
        <defs>
          {/* Algae gradient */}
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style={{ stopColor: config.gradient1, stopOpacity: 0.9 }} />
            <stop offset="50%" style={{ stopColor: config.gradient2, stopOpacity: 0.85 }} />
            <stop offset="100%" style={{ stopColor: config.gradient1, stopOpacity: 0.9 }} />
          </linearGradient>

          {/* Metal gradient */}
          <linearGradient id={`metalGradient-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style={{ stopColor: themeColors.gray[400] }} />
            <stop offset="50%" style={{ stopColor: themeColors.neutral[300] }} />
            <stop offset="100%" style={{ stopColor: themeColors.gray[400] }} />
          </linearGradient>

          {/* Plastic sheen */}
          <linearGradient id={`plasticSheen-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style={{ stopColor: themeColors.white, stopOpacity: 0.35 }} />
            <stop offset="30%" style={{ stopColor: themeColors.white, stopOpacity: 0.1 }} />
            <stop offset="100%" style={{ stopColor: themeColors.white, stopOpacity: 0.05 }} />
          </linearGradient>

          {/* Bubble gradient */}
          <radialGradient id={`bubbleGradient-${id}`} cx="30%" cy="30%">
            <stop offset="0%" style={{ stopColor: themeColors.white, stopOpacity: 0.8 }} />
            <stop offset="100%" style={{ stopColor: themeColors.white, stopOpacity: 0.2 }} />
          </radialGradient>

          {/* Bag clip path */}
          <clipPath id={`bagClip-${id}`}>
            <path d="M 30 25 Q 12 30, 15 60 Q 10 100, 15 140 L 12 220 Q 8 260, 18 285 Q 35 310, 75 310 Q 115 310, 132 285 Q 142 260, 138 220 L 135 140 Q 140 100, 135 60 Q 138 30, 120 25 Q 100 20, 75 20 Q 50 20, 30 25 Z" />
          </clipPath>

          {/* Stand mask */}
          <mask id={`standMask-${id}`}>
            <rect x="0" y="0" width="150" height="350" fill="white" />
            <path
              d="M 30 25 Q 12 30, 15 60 Q 10 100, 15 140 L 12 220 Q 8 260, 18 285 Q 35 310, 75 310 Q 115 310, 132 285 Q 142 260, 138 220 L 135 140 Q 140 100, 135 60 Q 138 30, 120 25 Q 100 20, 75 20 Q 50 20, 30 25 Z"
              fill="black"
            />
          </mask>
        </defs>

        {/* Triangular stand (masked - only visible outside bag) */}
        <g mask={`url(#standMask-${id})`}>
          <line
            x1="10"
            y1="340"
            x2="75"
            y2="20"
            stroke={themeColors.neutral[600]}
            strokeWidth="6"
            strokeLinecap="round"
          />
          <line
            x1="140"
            y1="340"
            x2="75"
            y2="20"
            stroke={themeColors.neutral[600]}
            strokeWidth="6"
            strokeLinecap="round"
          />
          <line
            x1="10"
            y1="340"
            x2="140"
            y2="340"
            stroke={themeColors.neutral[600]}
            strokeWidth="6"
            strokeLinecap="round"
          />
        </g>

        {/* Bag body */}
        <path
          d="M 30 25 Q 12 30, 15 60 Q 10 100, 15 140 L 12 220 Q 8 260, 18 285 Q 35 310, 75 310 Q 115 310, 132 285 Q 142 260, 138 220 L 135 140 Q 140 100, 135 60 Q 138 30, 120 25 Q 100 20, 75 20 Q 50 20, 30 25 Z"
          fill={themeColors.neutral[100]}
          fillOpacity="0.4"
          stroke={themeColors.neutral[400]}
          strokeWidth="1.5"
        />

        {/* 70% algae liquid */}
        <g clipPath={`url(#bagClip-${id})`}>
          <rect x="0" y="110" width="150" height="210" fill={`url(#${gradientId})`} />

          {/* Liquid surface */}
          <path
            d="M 10 110 Q 30 102, 50 110 Q 70 118, 95 110 Q 115 102, 140 110 L 140 120 Q 115 112, 95 120 Q 70 128, 50 120 Q 30 112, 10 120 Z"
            fill={config.surface}
            fillOpacity="0.5"
          />
        </g>

        {/* Bubbles */}
        <circle cx="50" cy="260" r="3" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="65" cy="280" r="2.5" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="80" cy="290" r="3" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="95" cy="265" r="4" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="110" cy="285" r="2.5" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="60" cy="220" r="2" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="100" cy="230" r="2.5" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="75" cy="180" r="2" fill={`url(#bubbleGradient-${id})`} />
        <circle cx="85" cy="150" r="1.5" fill={`url(#bubbleGradient-${id})`} />

        {/* Plastic sheen */}
        <path
          d="M 30 25 Q 12 30, 15 60 Q 10 100, 15 140 L 12 220 Q 8 260, 18 285 Q 35 310, 75 310 Q 115 310, 132 285 Q 142 260, 138 220 L 135 140 Q 140 100, 135 60 Q 138 30, 120 25 Q 100 20, 75 20 Q 50 20, 30 25 Z"
          fill={`url(#plasticSheen-${id})`}
          stroke="none"
        />

        {/* Left highlight line */}
        <path
          d="M 25 35 Q 18 70, 18 120 L 15 200 Q 14 250, 22 280"
          stroke={themeColors.white}
          strokeWidth="2"
          strokeOpacity="0.5"
          fill="none"
          strokeLinecap="round"
        />

        {/* Label */}
        <text x="75" y="345" textAnchor="middle" fontSize="10" fill={themeColors.neutral[700]}>
          {data?.label || config.label}
        </text>
      </svg>

      {/* Top Handle 1 (left) */}
      <div
        className="absolute left-[35px] top-6 w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => toggleHandle(e, top1Type, setTop1Type, 'top1Type')}
      >
        <Handle
          id="algae-top1"
          type={top1Type}
          position={Position.Top}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(top1Type),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Top Handle 2 (left-center) */}
      <div
        className="absolute left-15 top-[21px] w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => toggleHandle(e, top2Type, setTop2Type, 'top2Type')}
      >
        <Handle
          id="algae-top2"
          type={top2Type}
          position={Position.Top}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(top2Type),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Top Handle 3 (right-center) */}
      <div
        className="absolute left-[90px] top-[21px] w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => toggleHandle(e, top3Type, setTop3Type, 'top3Type')}
      >
        <Handle
          id="algae-top3"
          type={top3Type}
          position={Position.Top}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(top3Type),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Top Handle 4 (right) */}
      <div
        className="absolute left-[115px] top-6 w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => toggleHandle(e, top4Type, setTop4Type, 'top4Type')}
      >
        <Handle
          id="algae-top4"
          type={top4Type}
          position={Position.Top}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(top4Type),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Left Handle */}
      <div
        className="absolute left-4 top-[240px] w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => toggleHandle(e, leftType, setLeftType, 'leftType')}
      >
        <Handle
          id="algae-left"
          type={leftType}
          position={Position.Top}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(leftType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Right Handle */}
      <div
        className="absolute left-[134px] top-[240px] w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => toggleHandle(e, rightType, setRightType, 'rightType')}
      >
        <Handle
          id="algae-right"
          type={rightType}
          position={Position.Top}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(rightType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Bottom Handle (aeration) */}
      <div
        className="absolute left-[75px] top-[308px] w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => toggleHandle(e, bottomType, setBottomType, 'bottomType')}
      >
        <Handle
          id="algae-bottom"
          type={bottomType}
          position={Position.Top}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(bottomType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>
    </div>
  );
};

// Wrapper components for different colors
export const AlgaeBagRedNode: React.FC<NodeProps<Node<AlgaeBagNodeData>>> = (props) => (
  <AlgaeBagNode {...props} data={{ ...props.data, color: 'red' }} />
);

export const AlgaeBagGreenNode: React.FC<NodeProps<Node<AlgaeBagNodeData>>> = (props) => (
  <AlgaeBagNode {...props} data={{ ...props.data, color: 'green' }} />
);

export const AlgaeBagYellowNode: React.FC<NodeProps<Node<AlgaeBagNodeData>>> = (props) => (
  <AlgaeBagNode {...props} data={{ ...props.data, color: 'yellow' }} />
);

export default AlgaeBagNode;
