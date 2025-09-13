import React from 'react';
import '../index.css';

export default function GlobalLoader({ show, text = 'Cargando...' }) {
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--dark-color)]/70 backdrop-blur-sm pointer-events-auto">
      <div className="flex flex-col items-center gap-4 p-6 rounded-2xl bg-[var(--card-color)] border border-[var(--border-color)] shadow-soft min-w-[220px]">
        <span className="material-symbols-outlined animate-spin text-4xl text-[var(--primary-color)]">progress_activity</span>
        <div className="font-semibold text-sm tracking-wide text-[var(--text-secondary-color)]">{text}</div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary-color)] opacity-70">Esperando respuesta de Odoo</div>
      </div>
    </div>
  );
}
