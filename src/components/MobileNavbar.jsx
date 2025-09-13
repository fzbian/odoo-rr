import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Navbar mobile-first con menú hamburguesa. En pantallas >= 640px muestra barra horizontal clásica.
export default function MobileNavbar({ current, onChange }) {
  const { logout, auth } = useAuth();
  const isAdmin = auth?.isDeveloper;
  const [open, setOpen] = useState(false);

  const toggle = ()=> setOpen(o=>!o);
  const close = ()=> setOpen(false);

  const handleKey = useCallback((e)=>{ if(e.key==='Escape') close(); },[]);
  useEffect(()=>{ if(open) { document.addEventListener('keydown', handleKey); } else { document.removeEventListener('keydown', handleKey); } return ()=> document.removeEventListener('keydown', handleKey); },[open, handleKey]);

  // Evitar scroll de fondo cuando menú abierto (mobile)
  useEffect(()=>{ if(open){ document.body.style.overflow='hidden'; } else { document.body.style.overflow=''; } },[open]);

  const linkCls = (id)=> `flex items-center gap-2 px-4 py-3 rounded-[var(--radius)] text-sm font-medium ${current===id? 'bg-[var(--primary-color)] text-white shadow-soft':'text-[var(--text-secondary-color)] hover:text-[var(--text-color)] hover:bg-[var(--dark-color)]'}`;

  const go = (id)=>{ onChange(id); close(); };

  return (
    <header className="sticky top-0 z-50">
      <nav className="bg-[var(--card-color)] border-b border-[var(--border-color)] px-3 py-3 flex items-center gap-3 shadow-soft sm:px-4">
        <button aria-label={open? 'Cerrar menú':'Abrir menú'} onClick={toggle} className="sm:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] active:scale-95 transition">
          <span className="material-symbols-outlined text-[20px]">{open? 'close':'menu'}</span>
        </button>
        <div className="flex items-center gap-2 font-heading font-bold tracking-tight text-sm select-none">
          <span className="material-symbols-outlined text-[var(--primary-color)]">sync_alt</span>
          Traspasos
        </div>
        <div className="ml-auto hidden sm:flex items-center gap-1 text-xs">
          <button onClick={()=>onChange('transfer')} className={linkCls('transfer')}><span className="material-symbols-outlined text-sm">swap_horiz</span>Transferir</button>
          <button onClick={()=>onChange('stock')} className={linkCls('stock')}><span className="material-symbols-outlined text-sm">inventory_2</span>Stock</button>
          <button onClick={()=>onChange('sales')} className={linkCls('sales')}><span className="material-symbols-outlined text-sm">trending_up</span>Reportes</button>
          {isAdmin && <button onClick={()=>onChange('bodega')} className={linkCls('bodega')}><span className="material-symbols-outlined text-sm">warehouse</span>Bodega</button>}
          {isAdmin && <button onClick={()=>onChange('damaged')} className={linkCls('damaged')}><span className="material-symbols-outlined text-sm">report</span>Averiados</button>}
          {isAdmin && <button onClick={()=>onChange('entry')} className={linkCls('entry')}><span className="material-symbols-outlined text-sm">login</span>Entrada</button>}
          <div className="w-px h-5 mx-1 bg-[var(--border-color)]" />
          <button onClick={logout} className="px-3 py-2 rounded-[var(--radius)] font-medium flex items-center gap-1 text-[var(--danger-color)] hover:bg-[var(--danger-color)]/10"><span className="material-symbols-outlined text-sm">logout</span>Salir</button>
        </div>
      </nav>

      {/* Overlay + Drawer mobile */}
      <div className={`sm:hidden fixed inset-0 z-40 transition ${open? 'pointer-events-auto':'pointer-events-none'}`}>        
        <div onClick={close} className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity ${open? 'opacity-100':'opacity-0'}`}/>
        <aside className={`absolute top-0 left-0 h-full w-[82%] max-w-[320px] bg-[var(--card-color)] border-r border-[var(--border-color)] shadow-2xl transform transition-transform duration-300 flex flex-col ${open? 'translate-x-0':'-translate-x-full'}`}>
          <div className="px-4 pt-4 pb-3 flex items-center gap-2 border-b border-[var(--border-color)]">
            <span className="material-symbols-outlined text-[var(--primary-color)]">sync_alt</span>
            <span className="font-heading font-bold tracking-tight">Traspasos</span>
          </div>
          <div className="p-3 flex flex-col gap-1 overflow-y-auto text-xs flex-1">
            <button onClick={()=>go('transfer')} className={linkCls('transfer')}><span className="material-symbols-outlined text-base">swap_horiz</span>Transferencias</button>
            <button onClick={()=>go('stock')} className={linkCls('stock')}><span className="material-symbols-outlined text-base">inventory_2</span>Stock</button>
            <button onClick={()=>go('sales')} className={linkCls('sales')}><span className="material-symbols-outlined text-base">trending_up</span>Reportes</button>
            {isAdmin && <button onClick={()=>go('bodega')} className={linkCls('bodega')}><span className="material-symbols-outlined text-base">warehouse</span>Bodega</button>}
            {isAdmin && <button onClick={()=>go('damaged')} className={linkCls('damaged')}><span className="material-symbols-outlined text-base">report</span>Averiados</button>}
            {isAdmin && <button onClick={()=>go('entry')} className={linkCls('entry')}><span className="material-symbols-outlined text-base">login</span>Entrada</button>}
            <div className="mt-3 pt-3 border-t border-[var(--border-color)] flex flex-col gap-1">
              <button onClick={logout} className="flex items-center gap-2 px-4 py-3 rounded-[var(--radius)] text-sm font-medium text-[var(--danger-color)] hover:bg-[var(--danger-color)]/10"><span className="material-symbols-outlined text-base">logout</span>Salir</button>
            </div>
            <div className="mt-auto pt-4 pb-6 text-[9px] opacity-40 text-center select-none">v1.0</div>
          </div>
        </aside>
      </div>
    </header>
  );
}
