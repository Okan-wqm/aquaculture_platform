// // src/components/FlowEditor.tsx
// import React, { useCallback, useEffect, useState } from 'react';
// import ReactFlow, { Node, Edge, OnNodesChange, OnEdgesChange } from 'reactflow';
// import 'reactflow/dist/style.css';
// import { api } from '../lib/api';
//
// export const FlowEditor: React.FC = () => {
//   const [nodes, setNodes] = useState<Node[]>([]);
//   const [edges, setEdges] = useState<Edge[]>([]);
//
//   // 1) Başlangıçta yükle
//   useEffect(() => {
//     api.get<{ nodes: Node[]; edges: Edge[] }>('/flow')
//       .then(res => {
//         setNodes(res.data.nodes);
//         setEdges(res.data.edges);
//       })
//       .catch(console.error);
//   }, []);
//
//   // 2) Değişiklikleri kaydet
//   const onNodesChange: OnNodesChange = useCallback(
//     (changes) => {
//       setNodes(nds => applyNodeChanges(changes, nds));
//       saveFlow();
//     },
//     []
//   );
//   const onEdgesChange: OnEdgesChange = useCallback(
//     (changes) => {
//       setEdges(eds => applyEdgeChanges(changes, eds));
//       saveFlow();
//     },
//     []
//   );
//
//   const saveFlow = useCallback(() => {
//     api.post('/flow', { nodes, edges })
//       .catch(console.error);
//   }, [nodes, edges]);
//
//   return (
//     <div style={{ width: '100%', height: '100%' }}>
//       <ReactFlow
//         nodes={nodes}
//         edges={edges}
//         onNodesChange={onNodesChange}
//         onEdgesChange={onEdgesChange}
//         fitView
//       />
//     </div>
//   );
// };
