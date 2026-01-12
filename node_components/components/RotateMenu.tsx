// src/components/RotateMenu.tsx
import React from 'react';
import { useReactFlow, Node } from 'reactflow';

interface RotateMenuProps {
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  selectedNodeIds: string[];
}

export default function RotateMenu({ setNodes, selectedNodeIds }: RotateMenuProps) {
  const { getNodes } = useReactFlow();

  const rotateSelectedNodes = () => {
    const currentNodes = getNodes();
    setNodes(
      currentNodes.map((n) =>
        selectedNodeIds.includes(n.id)
          ? {
              ...n,
              data: {
                ...n.data,
                rotation: ((n.data?.rotation || 0) + 90) % 360,
              },
            }
          : n
      )
    );
  };

  return (
    <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 10 }}>
      <button onClick={rotateSelectedNodes}>↻ Rotate</button>
    </div>
  );
}
