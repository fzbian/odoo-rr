import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authenticate, executeKw } from '../lib/odoo';
import '../index.css';
import { getEnv } from '../lib/env';

const DB = getEnv('REACT_APP_ODOO_DB');
const USER = getEnv('REACT_APP_ODOO_USER');
const PASS = getEnv('REACT_APP_ODOO_PASSWORD');

export default function LoginView() {
  const nav = useNavigate();
  const { loginByEmployeePin, auth, hydrated } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [pin, setPin] = useState('');
  const [localLoading, setLocalLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchEmployees = useCallback(async () => {
    let localCancelled = false;
  setLocalLoading(true);
    setError('');
    try {
      const authSvc = await authenticate({ db: DB, login: USER, password: PASS });
      if (!authSvc?.uid) throw new Error('Autenticación de servicio falló');
      const fields = ['name', 'pin', 'department_id'];
      const res = await executeKw({ db: DB, uid: authSvc.uid, password: PASS, model: 'hr.employee', method: 'search_read', params: [[['active', '=', true]], fields], kwargs: { limit: 300 } });
      if (!localCancelled) setEmployees(res);
    } catch (e) {
      if (!localCancelled) setError(e.message || 'No se pudieron cargar empleados');
    } finally {
  if (!localCancelled) setLocalLoading(false);
    }
    return () => { localCancelled = true; };
  }, []);

  useEffect(() => {
    if (hydrated && auth) {
      nav('/traspasos', { replace: true });
      return;
    }
    if (!auth) fetchEmployees();
  }, [auth, hydrated, nav, fetchEmployees]);


  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!employeeId || !pin) {
      setError('Selecciona un empleado e ingresa su PIN');
      return;
    }
  setLocalLoading(true);
    try {
      await loginByEmployeePin({ employeeId: Number(employeeId), pin });
      nav('/traspasos');
    } catch (err) {
      setError(err.message || 'No se pudo iniciar sesión');
    } finally {
  setLocalLoading(false);
    }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--background-color)', color: 'var(--text-color)' }}>
      <div className="max-w-md mx-auto p-6">
        <section className="flex items-center gap-5 p-6 border border-[var(--border-color)] rounded-2xl shadow-soft mb-6"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }}>
          <img src="/logo192.png" alt="Logo" className="h-14 w-auto" />
          <div>
            <h1 className="m-0 font-heading font-extrabold text-2xl tracking-tight">ATM Ricky Rich</h1>
            <p className="m-0 mt-1 text-[var(--text-secondary-color)]">Login con Empleado + PIN</p>
          </div>
        </section>

  {localLoading && employees.length === 0 ? (
          <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-10 shadow-soft flex flex-col items-center justify-center gap-4 text-center">
            <span className="material-symbols-outlined animate-spin text-5xl text-[var(--primary-color)]">progress_activity</span>
            <div className="font-semibold">Conectando con el servidor...</div>
            <div className="text-xs text-[var(--text-secondary-color)]">Cargando empleados</div>
            {error && <div className="text-[var(--danger-color)] text-sm mt-2">{error}</div>}
            {error && <button type="button" onClick={fetchEmployees} className="inline-flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] border border-[var(--primary-color)] text-[var(--primary-color)] font-semibold">Reintentar</button>}
          </div>
        ) : (
        <form onSubmit={submit} className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-5 shadow-soft grid gap-3">
          <div>
            <label className="text-xs text-[var(--text-secondary-color)]">Empleado</label>
            <select className="w-full bg-[var(--dark-color)] text-[var(--text-color)] border border-[var(--border-color)] rounded-[var(--radius)] px-4 py-3 text-base" value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
              <option value="">Selecciona empleado</option>
              {employees.map(e => {
                const dep = Array.isArray(e.department_id) ? e.department_id[1] : '';
                const isAdmin = dep === 'Administration';
                const label = isAdmin ? e.name : (dep ? `${e.name} · ${dep}` : e.name);
                return (
                  <option key={e.id} value={e.id}>{label}</option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="text-xs text-[var(--text-secondary-color)]">PIN</label>
            <input type="password" inputMode="numeric" className="w-full bg-[var(--dark-color)] text-[var(--text-color)] border border-[var(--border-color)] rounded-[var(--radius)] px-4 py-3 text-base" value={pin} onChange={e => setPin(e.target.value)} />
          </div>

          {error && <div className="text-[var(--danger-color)] text-sm">{error}</div>}

           <button type="submit" disabled={localLoading} className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 font-semibold rounded-[var(--radius)] bg-[var(--primary-color)] text-white shadow-soft disabled:opacity-70">
            <span className="material-symbols-outlined">login</span>
             {localLoading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
        )}

  <p className="text-center text-xs text-[var(--text-secondary-color)] mt-6">Solo desarrollo: credenciales de servicio del .env</p>
      </div>
    </div>
  );
}
