import React, { useEffect } from 'react';
import { applyPageMeta } from './lib/meta';
import { isRouteErrorResponse, useRouteError, Link } from 'react-router-dom';
import './index.css';

export default function ErrorPage() {
  useEffect(()=> { applyPageMeta({ title: 'Error', favicon: '/logo192.png' }); }, []);
  const error = useRouteError();
  let title = 'Ha ocurrido un error';
  let detail = 'Intenta volver al inicio o recarga la página.';
  let code = '';

  if (isRouteErrorResponse(error)) {
    code = error.status;
    title = error.statusText || title;
    detail = error.data || detail;
  } else if (error instanceof Error) {
    detail = error.message || detail;
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--background-color)', color: 'var(--text-color)' }}>
      <div className="max-w-xl mx-auto p-6">
        <header className="flex items-center gap-4 p-5 border border-[var(--border-color)] rounded-2xl shadow-soft mb-6"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }}>
          <img src="/logo192.png" alt="Logo" className="h-12 w-auto" />
          <div>
            <h1 className="m-0 font-heading font-extrabold text-xl tracking-tight">ATM Ricky Rich</h1>
            <p className="m-0 mt-1 text-[var(--text-secondary-color)]">Identidad consistente · UX/UI</p>
          </div>
        </header>

        <main className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center gap-3 mb-3">
            <span className="material-symbols-outlined" style={{ color: 'var(--danger-color)' }}>error</span>
            <h2 className="m-0 font-heading font-bold text-lg">{title}{code ? ` · ${code}` : ''}</h2>
          </div>
          <p className="text-[var(--text-secondary-color)] mb-4">{String(detail)}</p>
          <div className="flex gap-2">
            <Link to="/" className="inline-flex items-center gap-2 px-4 py-2 font-semibold rounded-[var(--radius)] bg-[var(--primary-color)] text-white shadow-soft">
              <span className="material-symbols-outlined">home</span> Ir al inicio
            </Link>
            <button onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 font-semibold rounded-[var(--radius)] border border-[var(--primary-color)] text-[var(--primary-color)] shadow-soft">
              <span className="material-symbols-outlined">refresh</span> Recargar
            </button>
          </div>
        </main>

        <p className="text-center text-xs text-[var(--text-secondary-color)] mt-6">ATM Ricky Rich · Página de error</p>
      </div>
    </div>
  );
}
