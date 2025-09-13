import './App.css';
import React, { useCallback, useState } from 'react';
import TransferPage from './TransferPage';
import DamagedPage from './DamagedPage';
import StockPage from './StockPage';
import EntryPage from './EntryPage';
import SalesPage from './SalesPage';
import BodegaPage from './BodegaPage';
import { useAuth } from './context/AuthContext';
import MobileNavbar from './components/MobileNavbar';

function App() {
  const { auth, hydrated } = useAuth();
  const [view, setView] = useState(()=> {
    try {
      const stored = localStorage.getItem('app:view');
      const initial = stored || 'transfer';
      return initial;
    } catch(_) { return 'transfer'; }
  });
  const change = useCallback(v => { setView(v); localStorage.setItem('app:view', v); }, []);

  if(!hydrated) return null;
  if(!auth) return null; // App envuelta en rutas maneja login

  // Forzar fallback si usuario no es Administration y vista restringida
  const isAdmin = auth?.isDeveloper;
  const restricted = ['bodega','entry','damaged'];
  if(!isAdmin && restricted.includes(view)){
    if(view !== 'transfer') setView('transfer');
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-color)] text-[var(--text-color)]">
  <MobileNavbar current={view} onChange={change} />
      <div className="flex-1">
  {view === 'stock' ? <StockPage /> : view === 'entry' ? <EntryPage /> : view === 'sales' ? <SalesPage /> : view === 'damaged' ? <DamagedPage /> : view === 'bodega' ? <BodegaPage /> : <TransferPage />}
      </div>
  {/* GlobalLoader eliminado: ahora sólo se usa el loader de pasos dentro de BodegaPage */}
    </div>
  );
}

export default App;
