import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function Navbar({ current, onChange }) {
  const { logout, auth } = useAuth();
  const isAdmin = auth?.isDeveloper; // Departamento Administration
  return (
    <nav className="w-full sticky top-0 z-40 bg-[var(--card-color)] border-b border-[var(--border-color)] px-4 py-3 flex items-center gap-4 shadow-soft">
      <div className="font-heading font-bold tracking-tight text-sm flex items-center gap-2">
        <span className="material-symbols-outlined text-[var(--primary-color)]">sync_alt</span>
        Traspasos
      </div>
      <div className="ml-auto flex items-center gap-1 text-xs">
  <button onClick={()=>onChange('transfer')} className={`px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 ${current==='transfer'?'bg-[var(--primary-color)] text-white':'text-[var(--text-secondary-color)] hover:text-[var(--text-color)]'}`}>
          <span className="material-symbols-outlined text-sm">swap_horiz</span>
          Transferir
        </button>
  <button onClick={()=>onChange('stock')} className={`px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 ${current==='stock'?'bg-[var(--primary-color)] text-white':'text-[var(--text-secondary-color)] hover:text-[var(--text-color)]'}`}>
          <span className="material-symbols-outlined text-sm">inventory_2</span>
          Stock
        </button>
        <button onClick={()=>onChange('sales')} className={`px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 ${current==='sales'?'bg-[var(--primary-color)] text-white':'text-[var(--text-secondary-color)] hover:text-[var(--text-color)]'}`}>
          <span className="material-symbols-outlined text-sm">trending_up</span>
          Reportes
        </button>
        {isAdmin && (
          <>
            <button onClick={()=>onChange('bodega')} className={`px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 ${current==='bodega'?'bg-[var(--primary-color)] text-white':'text-[var(--text-secondary-color)] hover:text-[var(--text-color)]'}`}>
              <span className="material-symbols-outlined text-sm">warehouse</span>
              Bodega
            </button>
            <button onClick={()=>onChange('damaged')} className={`px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 ${current==='damaged'?'bg-[var(--primary-color)] text-white':'text-[var(--text-secondary-color)] hover:text-[var(--text-color)]'}`}>
              <span className="material-symbols-outlined text-sm">report</span>
              Averiados
            </button>
            <button onClick={()=>onChange('entry')} className={`px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 ${current==='entry'?'bg-[var(--primary-color)] text-white':'text-[var(--text-secondary-color)] hover:text-[var(--text-color)]'}`}>
              <span className="material-symbols-outlined text-sm">login</span>
              Entrada
            </button>
          </>
        )}
        <div className="w-px h-5 mx-1 bg-[var(--border-color)]" />
        <button onClick={logout} className="px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 text-[var(--danger-color)] hover:bg-[var(--danger-color)]/10">
          <span className="material-symbols-outlined text-sm">logout</span>
          Salir
        </button>
      </div>
    </nav>
  );
}
