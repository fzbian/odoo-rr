// Utilidad para enviar mensajes de WhatsApp usando variables de entorno
// Requiere definir en .env (prefijo REACT_APP_) para que CRA las exponga en cliente.

import { getEnv } from './env';
const URL = getEnv('REACT_APP_NOTIFY_URL');
const APIKEY = getEnv('REACT_APP_NOTIFY_APIKEY');
export const NUMBER_TRASPASOS = getEnv('REACT_APP_NOTIFY_NUMBER_TRASPASOS');
export const NUMBER_PEDIDOS_BOD = getEnv('REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD');

export async function sendWhatsAppMessage({ number, text }) {
  if(!URL || !APIKEY) return { ok:false, error:'Notify config missing' };
  try {
    const payload = { number, text };
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        // Algunos gateways usan 'x-api-key'; mantenemos ambos por compatibilidad
        'apikey': APIKEY,
        'x-api-key': APIKEY
      },
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      const errTxt = await safeText(res);
      // Log detallado para diagnósticos (solo consola cliente)
      // No lanzar excepción: devolvemos estructura para que el caller decida.
      console.warn('[notify] fallo HTTP', res.status, errTxt, { url: URL, payload });
      return { ok:false, status:res.status, error: errTxt };
    }
    return { ok:true };
  } catch(e){
    console.warn('[notify] exception', e.message);
    return { ok:false, error:e.message };
  }
}

async function safeText(r){ try { return await r.text(); } catch{ return 'error'; } }

// Helpers para formatear bloques de texto
export function formatLinesBullet(lines){
  return lines.map(l=> `• ${l}`).join('\n');
}

export function bold(t){ return `*${t}*`; }
