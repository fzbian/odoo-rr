import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function SessionBanner() {
  const { auth } = useAuth();
  if (!auth) return null;
  return (
    <div className="mb-3 text-[var(--text-secondary-color)] flex items-center gap-2">
      <span className="material-symbols-outlined">verified_user</span>
      <span className="kbd">{auth.name}</span>
      <span className="opacity-60">·</span>
      <span className="kbd">DB {auth.db}</span>
      <span className="opacity-60">· UID</span>
      <span className="kbd">{auth.uid}</span>
  {/* Botón de salir removido (ya está en el navbar) */}
    </div>
  );
}
