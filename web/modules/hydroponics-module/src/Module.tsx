import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import SetupPage from './pages/SetupPage';

const HydroponicsModule: React.FC = () => (
  <Routes>
    <Route index element={<Navigate to="setup" replace />} />
    <Route path="setup" element={<SetupPage />} />
    <Route path="*" element={<Navigate to="/hydroponics/setup" replace />} />
  </Routes>
);

export default HydroponicsModule;
