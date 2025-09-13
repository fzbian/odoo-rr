import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authenticate as odooAuth, getSessionInfo, executeKw as odooExecuteKw, destroySession } from '../lib/odoo';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(null); // modos: user-password o employee-pin
  const [hydrated, setHydrated] = useState(false);
  const [service, setService] = useState(null); // sesión de servicio REACT_APP_* { db, uid, password }
  const [pending, setPending] = useState(0); // contador de peticiones activas
  const [activity, setActivity] = useState(''); // etiqueta de actividad actual
  const batchDepthRef = React.useRef(0);
  const batchPendingRef = React.useRef(0);

  const startBatch = useCallback(()=> { batchDepthRef.current +=1; }, []);
  const endBatch = useCallback(()=> { batchDepthRef.current = Math.max(0, batchDepthRef.current-1); if(batchDepthRef.current===0 && batchPendingRef.current>0){ // flush pending grouped count as single increment cycle already reflected
    batchPendingRef.current = 0; }
  }, []);

  const REACT_DB = process.env.REACT_APP_ODOO_DB;
  const REACT_USER = process.env.REACT_APP_ODOO_USER;
  const REACT_PASS = process.env.REACT_APP_ODOO_PASSWORD;

  const ensureService = useCallback(async () => {
    if (service) return service;
    if (!REACT_DB || !REACT_USER || !REACT_PASS) throw new Error('Faltan variables REACT_APP_* para sesión de servicio');
    setPending(p => p + 1);
    try {
      const result = await odooAuth({ db: REACT_DB, login: REACT_USER, password: REACT_PASS });
    if (!result?.uid) throw new Error('No se pudo autenticar sesión de servicio');
    const s = { db: REACT_DB, uid: result.uid, password: REACT_PASS, login: REACT_USER };
    setService(s);
    return s;
    } finally { setPending(p => p - 1); }
  }, [service, REACT_DB, REACT_USER, REACT_PASS]);

  const login = useCallback(async ({ db, login, password }) => {
    setPending(p => p + 1);
    setActivity('Autenticando...');
    try {
      const result = await odooAuth({ db, login, password });
      if (!result || !result.uid) throw new Error('Credenciales inválidas');
      const session = await getSessionInfo();
    const next = {
      mode: 'user-password',
      db,
      login,
      uid: result.uid,
      password,
      partnerId: session.partner_id,
      name: session.username || login,
    };
    setAuth(next);
    return next;
  } finally { setPending(p => p - 1); setActivity(''); }
  }, []);

  const loginByEmployeePin = useCallback(async ({ pin, employeeId }) => {
    setPending(p => p + 1);
    setActivity('Validando PIN...');
    try {
      const svc = await ensureService();
      const domain = employeeId ? [["id", "=", employeeId], ["pin", "=", pin]] : [["pin", "=", pin]];
      const fields = ["name", "pin", "department_id", "work_email", "user_id"];
      const matches = await odooExecuteKw({ db: svc.db, uid: svc.uid, password: svc.password, model: 'hr.employee', method: 'search_read', params: [domain, fields], kwargs: { limit: 2 } });
      if (!matches || matches.length === 0) throw new Error('PIN inválido');
      const emp = matches[0];
      const next = {
        mode: 'employee-pin',
        db: svc.db,
        employee: emp,
        name: emp.name,
        isDeveloper: (Array.isArray(emp.department_id) ? emp.department_id[1] : '') === 'Administration',
      };
      setAuth(next);
      return next;
  } finally { setPending(p => p - 1); setActivity(''); }
  }, [ensureService]);

  const logout = useCallback(async () => {
    try { await destroySession(); } catch (e) { /* ignore in dev */ }
    setAuth(null);
  }, []);

  const executeKw = useCallback(async ({ model, method, params = [], kwargs = {}, activity: act }) => {
    if (!auth) throw new Error('No autenticado');
    const batched = batchDepthRef.current>0;
    if(!batched) setPending(p => p + 1); else batchPendingRef.current +=1;
    if (act && !batched) setActivity(act);
    try {
      if (auth.mode === 'employee-pin') {
        const svc = await ensureService();
        return await odooExecuteKw({ db: svc.db, uid: svc.uid, password: svc.password, model, method, params, kwargs });
      }
      return await odooExecuteKw({ db: auth.db, uid: auth.uid, password: auth.password, model, method, params, kwargs });
    } finally {
      if(!batched) setPending(p => p - 1);
      if (act && !batched) setActivity('');
    }
  }, [auth, ensureService]);

  // Variante silenciosa: no altera pending ni activity (para pequeños fetch parciales en UI)
  const executeKwSilent = useCallback(async ({ model, method, params = [], kwargs = {} }) => {
    if (!auth) throw new Error('No autenticado');
    const batched = batchDepthRef.current>0;
    if(!batched) { /* no pending increment desired for silent */ }
    if (auth.mode === 'employee-pin') {
      const svc = await ensureService();
      return await odooExecuteKw({ db: svc.db, uid: svc.uid, password: svc.password, model, method, params, kwargs });
    }
    return await odooExecuteKw({ db: auth.db, uid: auth.uid, password: auth.password, model, method, params, kwargs });
  }, [auth, ensureService]);

  // Helper genérico con timeout y reintentos
  const executeRpc = useCallback(async ({ model, method, params = [], kwargs = {}, retries=1, timeoutMs=12000 }) => {
    let attempt = 0; let lastErr;
    while (attempt <= retries) {
      attempt += 1;
      try {
        const res = await Promise.race([
          executeKwSilent({ model, method, params, kwargs }),
          new Promise((_,rej)=> setTimeout(()=> rej(new Error('Timeout RPC '+model+'.'+method)), timeoutMs))
        ]);
        return res;
      } catch(e){
        lastErr = e;
        if (attempt > retries) throw e;
        const currentAttempt = attempt; // capturar para closure estable
        await new Promise(r=> setTimeout(r, 350*currentAttempt));
      }
    }
    throw lastErr;
  }, [executeKwSilent]);

  // Persistencia en localStorage (solo dev)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('auth');
      if (raw) {
        const parsed = JSON.parse(raw);
        setAuth(parsed);
      }
    } catch (_) { /* noop */ }
    setHydrated(true);
    // Nota: no restauramos sesión de servicio aquí; se crea on-demand
  }, []);

  useEffect(() => {
    try {
      if (auth) localStorage.setItem('auth', JSON.stringify(auth));
      else localStorage.removeItem('auth');
    } catch (_) { /* noop */ }
  }, [auth]);

  const loading = pending > 0;
  const value = useMemo(() => ({ auth, hydrated, loading, activity, login, loginByEmployeePin, logout, executeKw, executeKwSilent, executeRpc, startBatch, endBatch }), [auth, hydrated, loading, activity, login, loginByEmployeePin, logout, executeKw, executeKwSilent, executeRpc, startBatch, endBatch]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
}
