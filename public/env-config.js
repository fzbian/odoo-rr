// Archivo de configuración runtime.
// Se carga antes del bundle (ver index.html) y permite ajustar variables sin reconstruir.
// En producción puedes sobrescribir este archivo al montar el contenedor.
// IMPORTANTE: No coloques aquí llaves secretas reales si el archivo se sirve públicamente.

window.__RUNTIME_CONFIG__ = {
  // REACT_APP_NOTIFY_URL: '/notify' // (Deshabilitado) Usar solo el valor de build (.env)
  // Agrega overrides aquí SOLO si necesitas cambiar algo sin reconstruir.
};
