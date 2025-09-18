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
  const root = baseUrl();
  if(!root) return { ok:false, error: 'REACT_APP_NOTIFY_URL no definida' };
  const url = root + 'whatsapp/send-text';
  const body = JSON.stringify({ chat, message });
  try {
    console.info('[notify] enviando chat', { chat, len: message.length, url });
    const res = await fetchWithTimeout(url, { method:'POST', headers: { 'Content-Type':'application/json', 'accept':'application/json' }, body }, timeoutMs);
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

