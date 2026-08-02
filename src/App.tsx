import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import CommandCenter from './pages/CommandCenter';
import Sessions from './pages/Sessions';
import BrokerSafety from './pages/BrokerSafety';
import Journal from './pages/Journal';
import Versions from './pages/Versions';
import Pipeline from './pages/Pipeline';
import Diagnostics from './pages/Diagnostics';
import ReplayLab from './pages/ReplayLab';
import Logs from './pages/Logs';
import Principles from './pages/Principles';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<CommandCenter />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="safety" element={<BrokerSafety />} />
          <Route path="journal" element={<Journal />} />
          <Route path="versions" element={<Versions />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="diagnostics" element={<Diagnostics />} />
          <Route path="replay" element={<ReplayLab />} />
          <Route path="logs" element={<Logs />} />
          <Route path="principles" element={<Principles />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
