import React from 'react';
import { useAuth } from '../context/AuthContext';
import { clearNotifyLocalCache, clearNotifyServerCache } from '../lib/notify';

export default function SessionBanner() {
  const { auth } = useAuth();
  const [clearingLocal, setClearingLocal] = React.useState(false);
  const [clearingServer, setClearingServer] = React.useState(false);

  async function handleClearLocal(){
    if(clearingLocal) return;
    setClearingLocal(true);
    try {
      const res = await clearNotifyLocalCache();
      if(!res.ok){
        window.alert(`No se pudo limpiar cache local: ${res.error || 'error'}`);
        return;
      }
      const base = `${window.location.origin}${window.location.pathname}`;
      const next = `${base}?refresh=${Date.now()}${window.location.hash || ''}`;
      window.location.replace(next);
    } finally {
      setClearingLocal(false);
    }
  }

  async function handleClearServer(){
    if(clearingServer) return;
    setClearingServer(true);
    try {
      const res = await clearNotifyServerCache();
      if(!res.ok){
        window.alert(`No se pudo limpiar cache global: ${res.error || 'endpoint no disponible'}`);
        return;
      }
      window.alert(`Cache global limpiado en backend: ${res.endpoint}`);
    } finally {
      setClearingServer(false);
    }
  }

  if (!auth) return null;
  return (
    <div className="mb-3 text-[var(--text-secondary-color)] flex items-center gap-2 flex-wrap">
      <span className="material-symbols-outlined">verified_user</span>
      <span className="kbd">{auth.name}</span>
      <span className="opacity-60">·</span>
      <span className="kbd">DB {auth.db}</span>
      <span className="opacity-60">· UID</span>
      <span className="kbd">{auth.uid}</span>
      <span className="opacity-40">|</span>
      <button
        type="button"
        onClick={handleClearLocal}
        disabled={clearingLocal}
        className="px-2 py-1 rounded border border-[var(--border-color)] text-[10px] hover:bg-[var(--dark-color)] disabled:opacity-60"
        title="Limpia cache local de la app y recarga"
      >
        {clearingLocal ? 'Limpiando local...' : 'Limpiar cache local'}
      </button>
      <button
        type="button"
        onClick={handleClearServer}
        disabled={clearingServer}
        className="px-2 py-1 rounded border border-[var(--border-color)] text-[10px] hover:bg-[var(--dark-color)] disabled:opacity-60"
        title="Intenta limpiar cache global del backend de notify"
      >
        {clearingServer ? 'Limpiando global...' : 'Limpiar cache global'}
      </button>
  {/* Botón de salir removido (ya está en el navbar) */}
    </div>
  );
}
