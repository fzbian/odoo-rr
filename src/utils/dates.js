// Utilidades de fechas para Odoo: siempre restar 5 horas a timestamps devueltos por el backend
// Assumption: backend entrega ISO en UTC o local sin offset claro; ajustamos -5h para llevar a hora local negocio.

export function parseOdooDate(value) {
  if(!value) return null;
  try {
    const d = new Date(value);
    if(isNaN(d)) return null;
    // Resta fija de 5 horas
    d.setHours(d.getHours() - 5);
    return d;
  } catch { return null; }
}

export function formatDateTime(d) {
  if(!d) return '';
  const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sept','oct','nov','dic'];
  const now = new Date();
  const strip = x=> new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const today = strip(now);
  const yesterday = new Date(today.getTime() - 86400000);
  const target = strip(d);
  let prefix='';
  if(target.getTime()===today.getTime()) prefix='hoy ';
  else if(target.getTime()===yesterday.getTime()) prefix='ayer ';
  const dayName = days[d.getDay()];
  const dayNum = d.getDate();
  const monthName = months[d.getMonth()];
  const year = d.getFullYear();
  let h = d.getHours();
  const ampm = h>=12? 'PM':'AM';
  let h12 = h%12; if(h12===0) h12 = 12;
  const mm = String(d.getMinutes()).padStart(2,'0');
  return prefix + `${dayName}, ${dayNum} de ${monthName} del ${year}. ${String(h12).padStart(2,'0')}:${mm} ${ampm}`;
}

export function parseAndFormatOdoo(value){
  return formatDateTime(parseOdooDate(value));
}
