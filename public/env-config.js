// Archivo de configuración runtime.
// Se carga antes del bundle (ver index.html) y permite ajustar variables sin reconstruir.
// En producción puedes sobrescribir este archivo al montar el contenedor.
// IMPORTANTE: No coloques aquí llaves secretas reales si el archivo se sirve públicamente.

window.__RUNTIME_CONFIG__ = {
  // Forzar uso de proxy local /notify para evitar CORS en dev.
  // notify.js resolverá a '/notify' si este valor es '/notify' o está vacío.
  REACT_APP_NOTIFY_URL: '/notify'
  // TIP: Si quieres sobreescribir variables específicas en runtime, puedes agregarlas aquí.
  // Omitir claves que ya funcionan desde process.env para no pisarlas.
  // Ejemplos (descomentando y ajustando):
  // REACT_APP_NOTIFY_APIKEY: 'tu_api_key',
  // REACT_APP_NOTIFY_NUMBER_TRASPASOS: '57XXXXXXXXXX',
  // REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD: '57XXXXXXXXXX'
};
