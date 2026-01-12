//src/components/nodes/RadialSettler.tsx

import React, { useState, useEffect } from 'react';
import { Handle, Position } from 'reactflow';
import styles from './RadialSettler.module.css';

interface RadialSettlerProps {
  id: string;
  data: any;
  setNodes: React.Dispatch<React.SetStateAction<any[]>>;
}

const RadialSettler: React.FC<RadialSettlerProps> = ({ id, data, setNodes }) => {
  const [leftType, setLeftType] = useState(data?.leftType || 'source');
  const [rightType, setRightType] = useState(data?.rightType || 'source');
  const [bottomType, setBottomType] = useState(data?.bottomType || 'target');

  useEffect(() => {
    // Node içeriğini güncelleme işlemleri
  }, [leftType, rightType, bottomType]);

  return (
    <div className={styles.node}>
      <svg width={120} height={160}>
        {/* SVG içeriği */}
      </svg>

      {/* Handle bileşenleri */}
      <Handle
        id={`left-${leftType}`}
        type={leftType}
        position={Position.Left}
        style={{ top: '50%' }}
      />
      <Handle
        id={`right-${rightType}`}
        type={rightType}
        position={Position.Right}
        style={{ top: '50%' }}
      />
      <Handle
        id={`bottom-${bottomType}`}
        type={bottomType}
        position={Position.Bottom}
        style={{ left: '50%' }}
      />
    </div>
  );
};

export default RadialSettler;
