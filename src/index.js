import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';
import { AuthProvider } from './context/AuthContext';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();

// Mitigar clientes atascados en una versión vieja: desregistrar SW y limpiar caches.
// Esto ayuda si en despliegues anteriores se registró un Service Worker (CRA antiguo) o
// si quedaron caches de Workbox. No afecta si nunca hubo SW.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations?.().then((regs) => {
    regs.forEach((r) => r.unregister());
    if (regs.length) {
      console.info('[app] Service Workers desregistrados:', regs.length);
    }
  }).catch(() => {});
}

// Limpia caches de la app (scope del origen actual) para forzar a traer assets nuevos tras un deploy.
// Nota: esto no borra almacenamiento de otras apps; solo caches del mismo origen.
if (typeof caches !== 'undefined' && caches.keys) {
  caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then((res) => {
    if (Array.isArray(res) && res.some(Boolean)) {
      console.info('[app] Caches limpiadas');
    }
  }).catch(() => {});
}
