import type { ReactElement } from 'react';
import type { NodeProps, Node } from 'reactflow';
import { Handle, Position, useReactFlow } from 'reactflow';
import { icons } from '@/icons';

//
// 1) Data shape that comes from your nodes
//
export interface GenericNodeData {
  svgName: string;
  width?: number;
  height?: number;
  // …any other per-node data your SVG component expects
}

//
// 2) Props passed into each SVG “icon” component
//
interface IconProps {
  id: string;
  data: GenericNodeData;
  setNodes: React.Dispatch<React.SetStateAction<Node<GenericNodeData>[]>>;
  width: number;
  height: number;
}

//
// 3) GenericNode component itself
//
export default function GenericNode(
  props: NodeProps<GenericNodeData>
): ReactElement {
  const { id, data } = props;
  const { setNodes } = useReactFlow();

  // Lookup the SVG component by name
  const IconComponent = icons[data.svgName] as React.FC<IconProps>;
  if (!IconComponent) {
    return (
      <div style={{ padding: 8, color: 'red' }}>
        Unknown node: <strong>{data.svgName}</strong>
      </div>
    );
  }

  const width  = data.width  ?? 200;
  const height = data.height ?? 100;

  return (
    <div style={{ position: 'relative', width, height }}>
      {/* SVG-based node UI */}
      <IconComponent
        id={id}
        data={data}
        setNodes={setNodes}
        width={width}
        height={height}
      />

      {/* Top target handle */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: '#555' }}
      />
      {/* Bottom source handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: '#555' }}
      />
    </div>
  );
}
