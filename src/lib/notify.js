// Utilidad para enviar mensajes de WhatsApp usando variables de entorno
// Requiere definir en .env (prefijo REACT_APP_) para que CRA las exponga en cliente.

const URL = process.env.REACT_APP_NOTIFY_URL;
const APIKEY = process.env.REACT_APP_NOTIFY_APIKEY;
export const NUMBER_TRASPASOS = process.env.REACT_APP_NOTIFY_NUMBER_TRASPASOS;
export const NUMBER_PEDIDOS_BOD = process.env.REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD;

export async function sendWhatsAppMessage({ number, text }) {
  if(!URL || !APIKEY) return { ok:false, error:'Notify config missing' };
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'apikey': APIKEY
      },
      body: JSON.stringify({ number, text })
    });
    if(!res.ok) return { ok:false, status:res.status, error: await safeText(res) };
    return { ok:true };
  } catch(e){
    return { ok:false, error:e.message };
  }
}

async function safeText(r){ try { return await r.text(); } catch{ return 'error'; } }

// Helpers para formatear bloques de texto
export function formatLinesBullet(lines){
  return lines.map(l=> `• ${l}`).join('\n');
}

export function bold(t){ return `*${t}*`; }
