// Nueva implementación simplificada para la API de notificaciones:
// POST { chat, message } -> `${REACT_APP_NOTIFY_URL}whatsapp/send-text`
// Aliases válidos (según backend): pruebas | traspasos | pedidos
// Si el alias es desconocido, el backend responde:
// { "detail": "Alias desconocido: X. Use: traspasos|pedidos|pruebas" }

import { getEnv, getBuildEnv } from './env';

function baseUrl(){
  // runtime (puede ser '/notify') y build (el .env real con https)
  const runtimeVal = (getEnv('REACT_APP_NOTIFY_URL','')||'').trim();
  const buildVal = (getBuildEnv('REACT_APP_NOTIFY_URL','')||'').trim();
  let chosen = runtimeVal || buildVal;
  // Si runtime es relativo (/notify) pero build es absoluto https, usar build para evitar 404 en backend real
  if(/^\//.test(runtimeVal) && /^https?:\/\//i.test(buildVal)) chosen = buildVal;
  // Normalizar
  if(!chosen) return '';
  const finalUrl = chosen.endsWith('/') ? chosen : chosen + '/';
  if(typeof window !== 'undefined'){
    const prev = window.__LAST_NOTIFY_BASE;
    if(prev !== finalUrl){
      window.__LAST_NOTIFY_BASE = finalUrl;
      console.info('[notify] base seleccionada:', { runtimeVal, buildVal, finalUrl });
    }
  }
  return finalUrl;
}

function fetchWithTimeout(url, opts={}, timeoutMs=10000){
  const ctrl = new AbortController();
  const t = setTimeout(()=> ctrl.abort('timeout'), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(()=> clearTimeout(t));
}

async function safeJson(res){ try { return await res.json(); } catch { return null; } }
async function safeText(res){ try { return await res.text(); } catch { return ''; } }

export const CHAT_PRUEBAS = 'pruebas';
export const CHAT_TRASPASOS = 'traspasos';
export const CHAT_PEDIDOS = 'pedidos';
export const VALID_CHATS = [CHAT_TRASPASOS, CHAT_PEDIDOS, CHAT_PRUEBAS];

function validateInput({ chat, message }){
  if(!chat || typeof chat !== 'string') return 'Falta chat';
  if(!message || !String(message).trim()) return 'Mensaje vacío';
  return null;
}

export async function sendChatMessage({ chat, message, timeoutMs = 10000 }){
  const err = validateInput({ chat, message });
  if(err) return { ok:false, error: err };
  // Protección simple anti-duplicados inmediatos: mismo chat+mensaje en < WINDOW_MS
  const WINDOW_MS = 3000;
  if(typeof window !== 'undefined'){
    window.__LAST_CHAT_SENDS = window.__LAST_CHAT_SENDS || [];
    const now = Date.now();
    // limpiar expirados
    window.__LAST_CHAT_SENDS = window.__LAST_CHAT_SENDS.filter(r=> (now - r.at) < WINDOW_MS);
    const key = chat + '|' + message;
    if(window.__LAST_CHAT_SENDS.some(r=> r.key === key)){
      console.info('[notify] duplicado evitado', { chat, suppressed: true });
      return { ok:false, duplicate:true, error:'duplicado_rapido' };
    }
    window.__LAST_CHAT_SENDS.push({ key, at: now });
  }
  const root = baseUrl();
  if(!root) return { ok:false, error: 'REACT_APP_NOTIFY_URL no definida' };
  // Si el root ya parece apuntar directamente a un endpoint final, no concatenar.
  // Casos manejados:
  //  - Ya termina en whatsapp/send-text
  //  - Es un endpoint legacy message/sendText/{alias}
  let url;
  if(/whatsapp\/send-text\/?$/i.test(root)) {
    url = root; // Ya es el endpoint correcto
  } else if(/message\/sendText\//i.test(root)) {
    // Endpoint viejo detectado: avisar y usarlo tal cual (para no romper mientras corriges la variable)
    console.warn('[notify] REACT_APP_NOTIFY_URL parece legacy (message/sendText). Ajusta la variable a la base nueva (ej: https://wpp-api.chinatownlogistic.com/)');
    url = root; // No añadimos sufijo para evitar 404 doble
  } else {
    url = root + 'whatsapp/send-text';
  }
  // Anti-cache fuerte (cliente/proxy) para evitar payloads viejos.
  const cacheBust = `_t=${Date.now()}`;
  url = url.includes('?') ? `${url}&${cacheBust}` : `${url}?${cacheBust}`;
  const body = JSON.stringify({ chat, message });
  try {
    console.info('[notify] enviando chat', { chat, len: message.length, url });
    const res = await fetchWithTimeout(url, {
      method:'POST',
      cache:'no-store',
      headers: {
        'Content-Type':'application/json',
        'accept':'application/json',
        'Cache-Control':'no-store, no-cache, max-age=0, must-revalidate',
        'Pragma':'no-cache',
      },
      body
    }, timeoutMs);
    const data = await safeJson(res);
    if(res.ok){
      console.info('[notify] enviado', { chat });
      return { ok:true, data };
    }
    const text = data?.detail || (await safeText(res));
    return { ok:false, status: res.status, error: text || 'Error desconocido' };
  } catch(e){
    return { ok:false, error: e?.message || 'Error de red' };
  }
}

// Limpia caches del navegador para forzar datos/asset frescos y reinicia cache interno de notify.
export async function clearNotifyLocalCache(){
  try {
    if(typeof window !== 'undefined'){
      window.__LAST_CHAT_SENDS = [];
      delete window.__LAST_NOTIFY_BASE;
      try { localStorage.removeItem('app:view'); } catch(_){}
    }
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations?.();
      await Promise.all((regs || []).map((r)=> r.unregister()));
    }
    if (typeof caches !== 'undefined' && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k)=> caches.delete(k)));
    }
    return { ok:true };
  } catch(e){
    return { ok:false, error: e?.message || 'No se pudo limpiar cache local' };
  }
}

// Limpieza global best-effort: intenta endpoint de backend si existe.
export async function clearNotifyServerCache({ timeoutMs = 8000 } = {}){
  const root = baseUrl();
  if(!root) return { ok:false, error:'REACT_APP_NOTIFY_URL no definida' };
  const candidates = [];
  if(/whatsapp\/send-text\/?$/i.test(root)){
    candidates.push(root.replace(/whatsapp\/send-text\/?$/i, 'whatsapp/clear-cache'));
  } else {
    candidates.push(root + 'whatsapp/clear-cache');
  }
  candidates.push(root + 'notify/clear-cache');
  candidates.push(root + 'cache/clear');

  for(const endpoint of candidates){
    try {
      const url = endpoint.includes('?') ? `${endpoint}&_t=${Date.now()}` : `${endpoint}?_t=${Date.now()}`;
      const res = await fetchWithTimeout(url, {
        method:'POST',
        cache:'no-store',
        headers:{
          'accept':'application/json',
          'Cache-Control':'no-store, no-cache, max-age=0, must-revalidate',
          'Pragma':'no-cache',
        },
      }, timeoutMs);
      if(res.ok) return { ok:true, endpoint };
    } catch(_){ /* continuar */ }
  }
  return { ok:false, error:'No existe endpoint de limpieza global en el backend notify' };
}

// Helpers de formato conservados del módulo anterior
export function formatLinesBullet(lines){
  return lines.map(l=> `• ${l}`).join('\n');
}
export function bold(t){ return `*${t}*`; }

// Helpers de dominio para componer mensajes específicos
export function buildTransferMessage({ reference, from, to, items }){
  const header = bold('Nuevo Traspaso');
  const ref = reference ? `Ref: ${reference}` : '';
  const lines = (items||[]).map(it => `${it.qty} x ${it.name}`);
  const body = formatLinesBullet(lines);
  return `${header}\n${ref}\nDe: ${from}\nA: ${to}\n${body}`.trim();
}

export function buildPedidoMessage({ reference, cliente, items }){
  const header = bold('Nuevo Pedido');
  const ref = reference ? `Ref: ${reference}` : '';
  const lines = (items||[]).map(it => `${it.qty} x ${it.name}`);
  const body = formatLinesBullet(lines);
  return `${header}\n${ref}\nCliente: ${cliente}\n${body}`.trim();
}
