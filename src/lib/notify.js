// Utilidad para enviar mensajes de WhatsApp usando variables de entorno
// Requiere definir en .env (prefijo REACT_APP_) para que CRA las exponga en cliente.

import { getEnv, getBuildEnv } from './env';
// Estrategia actual:
// - Si la variable es https://... se usa directamente (tanto en dev como prod) -> sin proxy.
// - Si es http://... y la página está en https, se usa /notify (proxy Nginx) para evitar Mixed Content.
// - Si está vacía, se usa /notify como fallback.
// Resolver URL base de envío respetando HTTPS/Mixed Content
function resolveNotifyUrl(){
  const RAW_URL = getEnv('REACT_APP_NOTIFY_URL');
  const PAGE_HTTPS = (typeof window !== 'undefined' && window.location.protocol === 'https:');
  let url = '/notify';
  if (RAW_URL) {
    if (/^https:\/\//i.test(RAW_URL)) url = RAW_URL; else if (/^http:\/\//i.test(RAW_URL)) url = PAGE_HTTPS ? '/notify' : RAW_URL; else if (RAW_URL.startsWith('/')) url = RAW_URL;
  }
  return url;
}

// Construir URL de envío usando base + instancia si están definidas
function getSendUrl(){
  const base = getEnv('REACT_APP_NOTIFY_URL');
  const inst = getEnv('REACT_APP_NOTIFY_INSTANCE');
  if (base && /^https?:\/\//i.test(base) && inst) {
    return base.replace(/\/$/, '') + '/message/sendText/' + inst;
  }
  return resolveNotifyUrl();
}

function getApiKey(){ return getEnv('REACT_APP_NOTIFY_APIKEY'); }

function debugEndpoint(url){
  if (typeof window !== 'undefined'){ const prev = window.__LAST_NOTIFY_URL; if(prev !== url){ window.__LAST_NOTIFY_URL = url; console.info('[notify] endpoint activo:', url); } }
}
export const NUMBER_TRASPASOS = getEnv('REACT_APP_NOTIFY_NUMBER_TRASPASOS');
export const NUMBER_PEDIDOS_BOD = getEnv('REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD');

// Helpers de validación y robustez
function normalizeNumber(input){
  if(!input) return '';
  const s = String(input).trim();
  if(s.includes('@')) return s;
  let digits = s.replace(/\D+/g,'');
  const cc = getEnv('REACT_APP_NOTIFY_CC','');
  if(digits.length===10 && cc && !digits.startsWith(cc)) digits = cc + digits;
  return digits;
}

// Asegurar remoteJid válido para verificación (solo añade dominio si no existe)
function ensureRemoteJid(num){
  const s = String(num||'').trim();
  if(!s) return '';
  return s.includes('@') ? s : `${s}@s.whatsapp.net`;
}

function validatePayload(num, txt){
  if(!num) return 'Falta número destino';
  if(!num.includes('@') && num.length < 8) return 'Número destino inválido';
  if(!txt || !String(txt).trim()) return 'Mensaje vacío';
  return null;
}

function fetchWithTimeout(url, opts={}, timeoutMs=8000){
  const ctrl = new AbortController();
  const t = setTimeout(()=> ctrl.abort('timeout'), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(()=> clearTimeout(t));
}

function unique(arr){ return Array.from(new Set(arr.filter(Boolean))); }

function buildEndpointCandidates(primary){
  const candidates = [primary];
  // Si el primario es https directo, probamos /notify como fallback
  if(/^https:\/\//i.test(primary)) candidates.push('/notify');
  // Si el primario es /notify y existe un https en env, probarlo también
  const raw = getEnv('REACT_APP_NOTIFY_URL');
  const inst = getEnv('REACT_APP_NOTIFY_INSTANCE');
  if(primary === '/notify' && raw && /^https:\/\//i.test(raw) && inst) {
    candidates.push(raw.replace(/\/$/, '') + '/message/sendText/' + inst);
  }
  return unique(candidates);
}

function parseApiFromUrl(urlStr){
  try {
    // Leer preferentemente del build para obtener la base absoluta aunque el runtime fuerce '/notify'
    const baseEnv = getBuildEnv('REACT_APP_NOTIFY_URL') || getEnv('REACT_APP_NOTIFY_URL');
    const instEnv = getBuildEnv('REACT_APP_NOTIFY_INSTANCE') || getEnv('REACT_APP_NOTIFY_INSTANCE');
    // Usar SIEMPRE la base absoluta e instancia del .env si existen
    if (baseEnv && /^https?:\/\//i.test(baseEnv) && instEnv) {
      const u = new URL(baseEnv);
      return { baseOrigin: u.origin, instance: instEnv };
    }
    // Fallback: si no hay base en .env pero urlStr es absoluta, usar su origen con la instancia del .env si existe
    if (urlStr && /^https?:\/\//i.test(urlStr) && instEnv) {
      const u = new URL(urlStr);
      return { baseOrigin: u.origin, instance: instEnv };
    }
    return null;
  } catch { return null; }
}


async function safeJson(r){
  try { return await r.json(); } catch { return null; }
}

async function verifyMessageDelivery({ baseOrigin, instance, apiKey, remoteJid, messageId, attempts=3, intervalMs=300, viaProxy=false }){
  if(!instance || !apiKey || !remoteJid || !messageId){
    console.warn('[notify.verify] parámetros faltantes', { hasBase: !!baseOrigin, viaProxy, hasInstance: !!instance, hasKey: !!apiKey, hasJid: !!remoteJid, hasMsgId: !!messageId });
    return { verified:false, reason:'missing-params' };
  }
  // Construir candidatos: absoluto (si hay base) y proxy /notify como fallback (para evitar CORS)
  const urls = [];
  if(baseOrigin) urls.push(`${baseOrigin}/chat/findMessages/${instance}`);
  urls.push(`/notify/chat/findMessages/${instance}`);

  const headers = { 'Content-Type':'application/json', 'apikey': apiKey, 'x-api-key': apiKey };
  const body = JSON.stringify({ where: { 'key.remoteJid': remoteJid } });

  for(let i=1;i<=attempts;i++){
    for(const url of urls){
      try {
        console.info('[notify.verify] consultando mensajes', { attempt: i, url, remoteJid });
        const res = await fetchWithTimeout(url, { method:'POST', headers, body }, 8000);
        if(!res.ok){
          console.warn('[notify.verify] HTTP no OK', { status: res.status, attempt: i, url });
          continue; // intenta siguiente URL en este intento
        }
        const data = await safeJson(res);
        const recs = (data?.messages?.records || data?.records || data?.messages || data?.data?.messages || []);
        console.info('[notify.verify] respuesta recibida', { attempt: i, url, count: Array.isArray(recs) ? recs.length : -1 });
        const found = Array.isArray(recs) && recs.find(r => (r?.key?.id === messageId) || (r?.id === messageId) || (r?.message?.key?.id === messageId));
        if(found) return { verified:true, record: found };
      } catch(e){
        console.warn('[notify.verify] error consultando', { attempt: i, url, error: e?.message || 'error' });
        // probar siguiente URL en este mismo intento
        continue;
      }
    }
    await new Promise(r=> setTimeout(r, intervalMs));
  }
  return { verified:false };
}

export async function sendWhatsAppMessage({ number, text, retries=2, timeoutMs=8000 }) {
  // Normalización y validación
  const normalized = normalizeNumber(number);
  const vErr = validatePayload(normalized, text);
  if(vErr){ console.warn('[notify] payload inválido:', vErr, { number, normalized }); return { ok:false, error:vErr }; }

  const PRIMARY_URL = getSendUrl();
  const APIKEY = getApiKey();
  debugEndpoint(PRIMARY_URL);
  console.info('[notify] preparando envío', { to: normalized, textLen: String(text ?? '').length });

  const urls = buildEndpointCandidates(PRIMARY_URL);
  const payload = { number: normalized, text };
  let lastError = null;

  for(const url of urls){
    for(let attempt=1; attempt<=Math.max(1,retries); attempt++){
      try {
        const headers = { 'Content-Type':'application/json' };
        if(APIKEY){ headers['apikey'] = APIKEY; headers['x-api-key'] = APIKEY; }
        console.info('[notify] intentando enviar', { to: normalized, url, attempt });
        const res = await fetchWithTimeout(url, { method:'POST', headers, body: JSON.stringify(payload) }, timeoutMs);
        if(res.ok){
          // Parsear respuesta para extraer ID del mensaje
          const data = await safeJson(res);
          const msgId = data?.key?.id || data?.message?.key?.id || data?.data?.key?.id || data?.id || data?.messageId || null;
          const respJid = data?.key?.remoteJid || data?.message?.key?.remoteJid || data?.data?.key?.remoteJid || data?.remoteJid || null;
          const remoteJid = ensureRemoteJid(respJid || normalized);
          console.info('[notify] enviado OK', { to: remoteJid, url, attempt, messageId: msgId });
          // Intentar verificar mediante chat/findMessages
          const apiMeta = parseApiFromUrl(url);
          let verification = { verified:false };
          let verifyAttempted = false;
          if(apiMeta){
            verifyAttempted = true;
            try {
              verification = await verifyMessageDelivery({ baseOrigin: apiMeta.baseOrigin, instance: apiMeta.instance, apiKey: APIKEY, remoteJid, messageId: msgId, attempts: 6, intervalMs: 500, viaProxy: !!apiMeta.viaProxy });
            } catch(_){ /* ignore */ }
          } else {
            console.warn('[notify] verificación omitida: no se pudo derivar instancia/base del endpoint');
          }
          const result = { ok:true, endpoint:url, attempt, messageId: msgId, remoteJid, verified: verification.verified, verifyRecord: verification.record, verifyAttempted };
          console.info('[notify] verificación', { to: remoteJid, verified: result.verified, hasRecord: !!result.verifyRecord });
          return result;
        }
        const status = res.status;
        const errTxt = await safeText(res);
        console.warn('[notify] fallo HTTP', status, errTxt, { url, attempt });
        // Reintentar en 429/5xx; en 4xx distintos normalmente no ayuda reintentar
        if(status===429 || (status>=500 && status<600)){
          // backoff exponencial simple
          await new Promise(r=> setTimeout(r, 300 * attempt));
          continue;
        } else {
          lastError = `${status} ${errTxt || ''}`.trim();
          break; // probar siguiente URL
        }
      } catch(e){
        lastError = e?.message || 'Error de red';
        console.warn('[notify] exception', lastError, { url, attempt });
        // backoff corto y reintentar
        await new Promise(r=> setTimeout(r, 200 * attempt));
        continue;
      }
    }
  }

  return { ok:false, error: lastError || 'No se pudo enviar mensaje' };
}

async function safeText(r){ try { return await r.text(); } catch{ return 'error'; } }

// Helpers para formatear bloques de texto
export function formatLinesBullet(lines){
  return lines.map(l=> `• ${l}`).join('\n');
}

export function bold(t){ return `*${t}*`; }

// Reintentador: envía y vuelve a enviar hasta que la verificación sea positiva (o se alcance el máximo)
// - maxSends: cuántos envíos como máximo (no confundir con retries internos por endpoint)
// - perSendRetries: reintentos internos por envío (pasado a sendWhatsAppMessage)
// - baseDelayMs: backoff base entre envíos (aumenta linealmente, con tope y jitter)
// - maxTotalMs: límite de tiempo total (opcional). Si se excede, devuelve el último resultado.
export async function sendWhatsAppMessageUntilVerified({ number, text, maxSends = 10, perSendRetries = 2, baseDelayMs = 800, maxTotalMs }){
  const start = Date.now();
  let lastRes = null;
  for(let sendAttempt = 1; sendAttempt <= Math.max(1, maxSends); sendAttempt++){
    lastRes = await sendWhatsAppMessage({ number, text, retries: perSendRetries });
    if(lastRes?.ok && lastRes?.verified){
      console.info('[notify] enviado correctamente', { to: number, messageId: lastRes.messageId, sendAttempt });
      return lastRes;
    }
    // Siempre que el envío fue OK pero no se ha verificado aún, reintentar verificación (sin re-enviar) varias veces usando el endpoint absoluto del .env.
    if(lastRes?.ok && !lastRes?.verified && lastRes?.remoteJid && lastRes?.messageId){
      const baseEnv = getBuildEnv('REACT_APP_NOTIFY_URL') || getEnv('REACT_APP_NOTIFY_URL');
      const instEnv = getBuildEnv('REACT_APP_NOTIFY_INSTANCE') || getEnv('REACT_APP_NOTIFY_INSTANCE');
      const apiKey = getApiKey();
      if(baseEnv && /^https?:\/\//i.test(baseEnv) && instEnv){
        const u = new URL(baseEnv);
        const extraChecks = 8; // ~4-6s de ventana para que el backend indexe el mensaje
        console.info('[notify] verificación adicional post-envío antes de re-enviar', { to: number, messageId: lastRes.messageId, checks: extraChecks });
        for(let i=1;i<=extraChecks;i++){
          const ver = await verifyMessageDelivery({ baseOrigin: u.origin, instance: instEnv, apiKey, remoteJid: lastRes.remoteJid, messageId: lastRes.messageId, attempts: 1, intervalMs: 450, viaProxy: false });
          if(ver.verified){
            console.info('[notify] enviado correctamente (verificado tras espera)', { to: number, messageId: lastRes.messageId, sendAttempt, verifyCheck: i });
            return { ...lastRes, verified: true, verifyRecord: ver.record };
          }
          await new Promise(r=> setTimeout(r, 550));
        }
      } else {
        console.warn('[notify] no hay base/instancia en .env para verificación adicional; se procederá al reenvío si aplica');
      }
    }
    // Salidas por tiempo total
    if(typeof maxTotalMs === 'number' && maxTotalMs > 0 && (Date.now() - start) >= maxTotalMs){
      console.warn('[notify] se alcanzó el límite de tiempo total sin verificación positiva', { to: number, elapsedMs: Date.now() - start });
      return lastRes || { ok:false, error: 'timeout-total' };
    }
    if(sendAttempt < maxSends){
      const jitter = Math.floor(Math.random() * 200);
      const delay = Math.min(baseDelayMs * sendAttempt, 5000) + jitter;
      console.info('[notify] reintentando envío tras espera', { to: number, nextAttempt: sendAttempt+1, delayMs: delay });
      await new Promise(r=> setTimeout(r, delay));
    }
  }
  console.warn('[notify] no se logró verificar el envío tras múltiples intentos', { to: number, attempts: maxSends });
  return lastRes || { ok:false, error:'no-verified' };
}
