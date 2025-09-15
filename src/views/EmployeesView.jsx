import React, { useEffect, useMemo, useState } from 'react';
import { applyPageMeta } from '../lib/meta';
import { authenticate, executeKw } from '../lib/odoo';
import { useAuth } from '../context/AuthContext';
import { getEnv } from '../lib/env';
import { useNavigate } from 'react-router-dom';

const DB = getEnv('REACT_APP_ODOO_DB');
const USER = getEnv('REACT_APP_ODOO_USER');
const PASS = getEnv('REACT_APP_ODOO_PASSWORD');

export default function EmployeesView() {
  const nav = useNavigate();
  const { loginByEmployeePin } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [employees, setEmployees] = useState([]);
  const [q, setQ] = useState('');
  const [signing, setSigning] = useState({}); // map emp.id -> loading

  useEffect(() => {
    applyPageMeta({ title: 'Empleados', favicon: '/logo192.png' });
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError('');
      try {
        // Autenticación con credenciales del .env (inyectadas como REACT_APP_*)
        const auth = await authenticate({ db: DB, login: USER, password: PASS });
        if (!auth?.uid) throw new Error('Autenticación fallida');
        // Traer empleados activos con campos clave
        const fields = ['name', 'pin', 'work_email', 'job_title', 'department_id'];
        const res = await executeKw({ db: DB, uid: auth.uid, password: PASS, model: 'hr.employee', method: 'search_read', params: [[['active', '=', true]], fields], kwargs: { limit: 200 } });
        if (cancelled) return;
        setEmployees(res);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Error listando empleados');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return employees;
    return employees.filter(e => {
      const dep = Array.isArray(e.department_id) ? e.department_id[1] : '';
      return (
        String(e.name || '').toLowerCase().includes(qq) ||
        String(e.pin || '').toLowerCase().includes(qq) ||
        String(e.job_title || '').toLowerCase().includes(qq) ||
        String(dep || '').toLowerCase().includes(qq) ||
        String(e.work_email || '').toLowerCase().includes(qq)
      );
    });
  }, [q, employees]);

  return (
    <div className="max-w-5xl mx-auto p-6">
      <section className="flex items-center gap-5 p-6 border border-[var(--border-color)] rounded-2xl shadow-soft mb-4"
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }}>
        <img src="/logo192.png" alt="Logo" className="h-14 w-auto" />
        <div>
          <h1 className="m-0 font-heading font-extrabold text-2xl tracking-tight">Empleados · PIN</h1>
          <p className="m-0 mt-1 text-[var(--text-secondary-color)]">Leído en vivo desde Odoo (solo desarrollo, autenticación via .env)</p>
        </div>
      </section>

      <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-4 shadow-soft mb-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-2 top-2.5 opacity-70">search</span>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Buscar por nombre, PIN, puesto, departamento o email"
              className="w-full bg-[var(--dark-color)] text-[var(--text-color)] border border-[var(--border-color)] rounded-[var(--radius)] pl-9 pr-3 py-2.5"
            />
          </div>
          <a href="/traspasos" className="inline-flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] border border-[var(--primary-color)] text-[var(--primary-color)]">
            <span className="material-symbols-outlined">swap_horiz</span> Traspasos
          </a>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-4 shadow-soft mb-4">
          <div className="text-[var(--danger-color)]">{error}</div>
        </div>
      )}

      <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-2 shadow-soft overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--text-secondary-color)]">
              <th className="p-2">Empleado</th>
              <th className="p-2">PIN</th>
              <th className="p-2">Puesto</th>
              <th className="p-2">Departamento</th>
              <th className="p-2">Email</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="p-3 text-[var(--text-secondary-color)]" colSpan={5}>Cargando empleados...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td className="p-3 text-[var(--text-secondary-color)]" colSpan={5}>Sin resultados</td></tr>
            ) : (
              filtered.map(emp => {
                const dep = Array.isArray(emp.department_id) ? emp.department_id[1] : '';
                return (
                  <tr key={emp.id} className="border-t border-[var(--border-color)]">
                    <td className="p-2 font-medium">{emp.name}</td>
                    <td className="p-2"><span className="kbd">{emp.pin || '—'}</span></td>
                    <td className="p-2">{emp.job_title || '—'}</td>
                    <td className="p-2">{dep || '—'}</td>
                    <td className="p-2 flex items-center gap-2">
                      <span>{emp.work_email || '—'}</span>
                      {emp.pin ? (
                        <button
                          className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius)] bg-[var(--primary-color)] text-white"
                          disabled={!!signing[emp.id]}
                          onClick={async () => {
                            setError('');
                            setSigning(s => ({ ...s, [emp.id]: true }));
                            try {
                              await loginByEmployeePin({ pin: emp.pin, employeeId: emp.id });
                              nav('/traspasos');
                            } catch (e) {
                              setError(e.message || 'No se pudo iniciar sesión con PIN');
                            } finally {
                              setSigning(s => ({ ...s, [emp.id]: false }));
                            }
                          }}
                        >
                          <span className="material-symbols-outlined">login</span>
                          {signing[emp.id] ? 'Ingresando...' : 'Ingresar'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-center text-xs text-[var(--text-secondary-color)] mt-6">ATM Ricky Rich · Empleados</p>
    </div>
  );
}
