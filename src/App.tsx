import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import LiveTrading from './pages/LiveTrading';
import Sessions from './pages/Sessions';
import History from './pages/History';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<LiveTrading />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="history" element={<History />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
