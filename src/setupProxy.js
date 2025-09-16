// Proxy de desarrollo para Create React App.
// Permite usar la ruta relativa /notify y evitar problemas de CORS apuntando al gateway real.
// Ajusta la URL target (NOTIFY_TARGET) según sea necesario.
// Puedes definir LOCAL_NOTIFY_TARGET en tu entorno shell antes de `npm start` para sobreescribir.

const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  const notifyTarget = process.env.LOCAL_NOTIFY_TARGET || process.env.REACT_APP_NOTIFY_PROXY_TARGET || 'https://wpp-api.chinatownlogistic.com/message/sendText/daniela';

  // WhatsApp notify
  app.use(
    '/notify',
    createProxyMiddleware({
      target: notifyTarget,
      changeOrigin: true,
      pathRewrite: { '^/notify': '' },
      logLevel: 'warn'
    })
  );

  const odooTarget = process.env.LOCAL_ODOO_TARGET || 'http://137.184.137.192:8069';
  // Odoo JSON-RPC
  app.use(
    '/jsonrpc',
    createProxyMiddleware({
      target: odooTarget,
      changeOrigin: true,
      logLevel: 'warn'
    })
  );

  // Odoo Web Session
  app.use(
    '/web/session',
    createProxyMiddleware({
      target: odooTarget,
      changeOrigin: true,
      logLevel: 'warn'
    })
  );
};
