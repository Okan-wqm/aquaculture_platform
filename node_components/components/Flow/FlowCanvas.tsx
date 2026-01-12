// import React from 'react';
// import ReactFlow, {
//   Background,
//   Controls,
//   ConnectionMode,
//   BackgroundVariant,
//   type ReactFlowProps,
//   type Node,
//   type Edge,
// } from 'reactflow';
// // import 'reactflow/dist/style.css';
//
// interface Handlers {
//   onNodesChange: ReactFlowProps['onNodesChange'];
//   onEdgesChange: ReactFlowProps['onEdgesChange'];
//   onConnect: ReactFlowProps['onConnect'];
//   onNodeDragStop: ReactFlowProps['onNodeDragStop'];
//   onSelectionChange: ReactFlowProps['onSelectionChange'];
//   onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
// }
//
// interface FlowCanvasProps {
//   displayNodes: Node[];
//   displayEdges: Edge[];
//   handlers: Handlers;
//   showGrid: boolean;
// }
//
// export default function FlowCanvas({
//   displayNodes,
//   displayEdges,
//   handlers,
//   showGrid,
// }: FlowCanvasProps) {
//   const {
//     onNodesChange,
//     onEdgesChange,
//     onConnect,
//     onNodeDragStop,
//     onSelectionChange,
//     onKeyDown,
//   } = handlers;
//
//   return (
//     <div
//       style={{ width: '100%', height: '100%' }}
//       onKeyDown={onKeyDown}
//       tabIndex={0}
//     >
//       <ReactFlow
//         nodes={displayNodes}
//         edges={displayEdges}
//         onNodesChange={onNodesChange}
//         onEdgesChange={onEdgesChange}
//         onConnect={onConnect}
//         onNodeDragStop={onNodeDragStop}
//         onSelectionChange={onSelectionChange}
//         fitView
//         style={{ backgroundColor: 'black' }}
//         connectionMode={ConnectionMode.Strict}
//       >
//         {showGrid && (
//           <Background variant={BackgroundVariant.Lines} gap={10} />
//         )}
//         <Controls />
//       </ReactFlow>
//     </div>
//   );
// }
//
