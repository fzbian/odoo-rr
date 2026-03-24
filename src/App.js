import './App.css';
import React, { useCallback, useEffect, useState } from 'react';
import TransferPage from './TransferPage';
import DamagedPage from './DamagedPage';
import StockPage from './StockPage';
import EntryPage from './EntryPage';
import SalesPage from './SalesPage';
import BodegaPage from './BodegaPage';
import { useAuth } from './context/AuthContext';
import { getEnv } from './lib/env';
import MobileNavbar from './components/MobileNavbar';

const RELEASE_KEY = 'app:release-id';

async function fetchLatestReleaseId() {
  try {
    const res = await fetch(`/env-config.js?_t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return '';
    const text = await res.text();
    const match = text.match(/"REACT_APP_RELEASE_ID"\s*:\s*"([^"]*)"/);
    return match?.[1] ? String(match[1]).trim() : '';
  } catch (_) {
    return '';
  }
}

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
  const runtimeReleaseId = String(getEnv('REACT_APP_RELEASE_ID', '') || '').trim();

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const hardReload = (releaseId) => {
      try { localStorage.setItem(RELEASE_KEY, releaseId); } catch (_) {}
      const base = `${window.location.origin}${window.location.pathname}`;
      const next = `${base}?refresh=${Date.now()}${window.location.hash || ''}`;
      window.location.replace(next);
    };

    const syncStoredRelease = (releaseId) => {
      if (!releaseId) return false;
      try {
        const prev = localStorage.getItem(RELEASE_KEY) || '';
        if (prev && prev !== releaseId) {
          hardReload(releaseId);
          return true;
        }
        if (!prev) localStorage.setItem(RELEASE_KEY, releaseId);
      } catch (_) {}
      return false;
    };

    // Primera validación contra runtime config inyectada por servidor.
    if (syncStoredRelease(runtimeReleaseId)) return undefined;

    let stopped = false;
    const checkRemoteRelease = async () => {
      if (stopped) return;
      const remoteReleaseId = await fetchLatestReleaseId();
      if (!remoteReleaseId) return;
      syncStoredRelease(remoteReleaseId);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') checkRemoteRelease();
    };

    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(checkRemoteRelease, 2 * 60 * 1000);
    checkRemoteRelease();

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [runtimeReleaseId]);

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
