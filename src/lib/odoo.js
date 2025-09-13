// Cliente Odoo JSON-RPC desde el navegador (solo desarrollo)
// Requiere que package.json tenga "proxy" apuntando al servidor de Odoo.

const JSONRPC_URL = '/jsonrpc';
const AUTH_URL = '/web/session/authenticate';
const SESSION_INFO_URL = '/web/session/get_session_info';
const SESSION_DESTROY_URL = '/web/session/destroy';

export async function authenticate({ db, login, password }) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: { db, login, password },
    id: Date.now(),
  };
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Error autenticando');
  return data.result; // {uid, ...}
}

export async function getSessionInfo() {
  const payload = { jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() };
  const res = await fetch(SESSION_INFO_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Error de sesión');
  return data.result;
}

export async function destroySession() {
  const payload = { jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() };
  const res = await fetch(SESSION_DESTROY_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Error cerrando sesión');
  return data.result;
}

export async function executeKw({ db, uid, password, model, method, params = [], kwargs = {} }) {
  // Nota: Mantener password en memoria solo para desarrollo; en producción usar proxy backend.
  const payload = {
    jsonrpc: '2.0', method: 'call',
    params: {
      service: 'object', method: 'execute_kw',
      args: [db, uid, password, model, method, params, kwargs]
    }, id: Date.now()
  };
  const res = await fetch(JSONRPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Error RPC');
  return data.result;
}
