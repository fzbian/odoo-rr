/* Express backend para traspasos Odoo y notificaciones */
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.BACKEND_PORT || 5000;

// Env
const ODOO_URL = process.env.ODOO_URL || 'http://137.184.137.192:8069/';
const ODOO_DB = process.env.ODOO_DB || 'odoo';
const ODOO_USER = process.env.ODOO_USER || 'rickyrichpos2023@gmail.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD || 'david12';

const NOTIFY_URL = process.env.NOTIFY_URL || 'http://evo-y4ogkos8wc4kks0wow4so8ks.143.198.70.11.sslip.io/message/sendText/david';
const NOTIFY_APIKEY = process.env.NOTIFY_APIKEY || 'fabian@7167C';
const NOTIFY_NUMBER = process.env.NOTIFY_NUMBER || '120363419795940402@g.us';

// Util: llamar JSON-RPC al endpoint /jsonrpc de Odoo
async function odooJsonRpc(service, method, args) {
  const url = new URL('/jsonrpc', ODOO_URL).toString();
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: { service, method, args },
    id: Date.now(),
  };
  const { data } = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
  if (data.error) throw new Error(data.error.data ? data.error.data.message : (data.error.message || 'Odoo RPC error'));
  return data.result;
}

async function odooAuthenticate() {
  const uid = await odooJsonRpc('common', 'login', [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
  if (!uid) throw new Error('Autenticación Odoo fallida');
  return uid;
}

async function odooExecuteKw(model, method, params = [], kwargs = {}) {
  const uid = await odooAuthenticate();
  const url = new URL('/jsonrpc', ODOO_URL).toString();
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        model,
        method,
  params,
  kwargs || {},
      ],
    },
    id: Date.now(),
  };
  const { data } = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
  if (data.error) throw new Error(data.error.data ? data.error.data.message : (data.error.message || 'Odoo execute_kw error'));
  return data.result;
}

// Helpers de negocio
async function listInternalLocations() {
  // filtra ubicaciones internas y visibles
  const fields = ['name', 'complete_name', 'location_id', 'usage'];
  const domain = [["usage", "=", "internal"]];
  const locations = await odooExecuteKw('stock.location', 'search_read', [domain], { fields, limit: 1000 });
  return locations;
}

async function searchProducts(query) {
  const fields = ['name', 'default_code', 'uom_id'];
  const domain = query ? [["name", "ilike", query]] : [];
  const products = await odooExecuteKw('product.product', 'search_read', [domain], { fields, limit: 50 });
  return products;
}

async function createAndValidateInternalTransfer({ originLocationId, destLocationId, lines, notes }) {
  if (!originLocationId || !destLocationId || !Array.isArray(lines) || lines.length === 0) {
    const e = new Error('Datos inválidos: origen, destino y líneas son requeridos');
    e.status = 400;
    throw e;
  }

  // 1. Crear picking tipo interno (picking_type_id de inventario interno)
  // Buscar picking type: stock.picking.type con code='internal'
  const pickingTypes = await odooExecuteKw('stock.picking.type', 'search_read', [[['code', '=', 'internal']]], { fields: ['id', 'name', 'sequence_code'], limit: 1 });
  if (!pickingTypes || pickingTypes.length === 0) throw new Error('No se encontró picking type interno');
  const pickingType = pickingTypes[0];

  const move_lines = lines.map(l => ({
    name: l.name || 'Transferencia',
    product_id: l.productId,
    product_uom: l.uomId || false,
    product_uom_qty: l.quantity,
    location_id: originLocationId,
    location_dest_id: destLocationId,
  }));

  const pickingVals = {
    picking_type_id: pickingType.id,
    location_id: originLocationId,
    location_dest_id: destLocationId,
    origin: 'App Traspasos',
    note: notes || '',
    move_lines,
  };

  // En Odoo moderno, se crean moves vía one2many commands en stock.picking con move_ids_without_package
  // Para compatibilidad, usaremos create en stock.picking con move_lines (legacy) y si falla, fallback a move_ids_without_package
  let pickingId;
  try {
    pickingId = await odooExecuteKw('stock.picking', 'create', [pickingVals]);
  } catch (err) {
    // fallback
    const moveCmds = lines.map(l => [0, 0, {
      name: l.name || 'Transferencia',
      product_id: l.productId,
      product_uom: l.uomId || false,
      product_uom_qty: l.quantity,
      location_id: originLocationId,
      location_dest_id: destLocationId,
    }]);
    pickingId = await odooExecuteKw('stock.picking', 'create', [{
      picking_type_id: pickingType.id,
      location_id: originLocationId,
      location_dest_id: destLocationId,
      origin: 'App Traspasos',
      note: notes || '',
      move_ids_without_package: moveCmds,
    }]);
  }

  // Confirmar picking (action_confirm)
  await odooExecuteKw('stock.picking', 'action_confirm', [[pickingId]]);

  // Asignar (action_assign)
  try { await odooExecuteKw('stock.picking', 'action_assign', [[pickingId]]); } catch (_) {}

  // Establecer quantity_done en los move_line_ids
  const moveLines = await odooExecuteKw('stock.move.line', 'search_read', [[['picking_id', '=', pickingId]]], { fields: ['id', 'qty_done', 'product_uom_qty'] });
  if (moveLines.length === 0) {
    // crear move lines desde los moves si no existen
    const moves = await odooExecuteKw('stock.move', 'search_read', [[['picking_id', '=', pickingId]]], { fields: ['id', 'product_uom', 'product_uom_qty', 'product_id', 'location_id', 'location_dest_id'] });
    for (const m of moves) {
      await odooExecuteKw('stock.move.line', 'create', [[{
        picking_id: pickingId,
        move_id: m.id,
        product_id: Array.isArray(m.product_id) ? m.product_id[0] : m.product_id,
        product_uom_id: Array.isArray(m.product_uom) ? m.product_uom[0] : m.product_uom,
        qty_done: m.product_uom_qty,
        location_id: Array.isArray(m.location_id) ? m.location_id[0] : m.location_id,
        location_dest_id: Array.isArray(m.location_dest_id) ? m.location_dest_id[0] : m.location_dest_id,
      }]]);
    }
  } else {
    // set qty_done = product_uom_qty
    for (const ml of moveLines) {
      await odooExecuteKw('stock.move.line', 'write', [[[ml.id], { qty_done: ml.product_uom_qty || ml.qty_done || 0 }]]);
    }
  }

  // Validar (button_validate)
  let result;
  try {
    result = await odooExecuteKw('stock.picking', 'button_validate', [[pickingId]]);
  } catch (err) {
    // Si requiere wizard immediate_transfer_wizard, resolverlo
    // Buscar wizard con picking_id = pickingId
    const wiz = await odooExecuteKw('stock.immediate.transfer', 'create', [[{ pick_ids: [[6, 0, [pickingId]]] }]]);
    await odooExecuteKw('stock.immediate.transfer', 'process', [[wiz]]);
  }

  // Obtener datos del picking para notificar
  const picking = (await odooExecuteKw('stock.picking', 'read', [[pickingId], ['name', 'state', 'origin', 'location_id', 'location_dest_id', 'move_ids_without_package']]))[0];

  return { pickingId, picking, result };
}

async function sendWhatsappNotification(text) {
  try {
    const { data } = await axios.post(
      NOTIFY_URL,
      { number: NOTIFY_NUMBER, options: { delay: 1200, presence: 'composing' }, text },
      { headers: { 'x-api-key': NOTIFY_APIKEY, 'Content-Type': 'application/json' } }
    );
    return data;
  } catch (err) {
    return { error: true, message: err.message };
  }
}

// Rutas API
app.get('/api/locations', async (req, res) => {
  try {
    const locs = await listInternalLocations();
    res.json(locs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const q = req.query.q || '';
    const prods = await searchProducts(q);
    res.json(prods);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/transfer', async (req, res) => {
  try {
    const { originLocationId, destLocationId, lines, notes } = req.body;
    const { pickingId, picking } = await createAndValidateInternalTransfer({ originLocationId, destLocationId, lines, notes });

    const originName = Array.isArray(picking.location_id) ? picking.location_id[1] : picking.location_id;
    const destName = Array.isArray(picking.location_dest_id) ? picking.location_dest_id[1] : picking.location_dest_id;

    const text = `✅ Traspaso confirmado\n• Picking: ${picking.name}\n• De: ${originName}\n• A: ${destName}\n• Líneas: ${lines.length}\n• Nota: ${notes || '-'}\n\nATM Ricky Rich`;
    const notify = await sendWhatsappNotification(text);

    res.json({ ok: true, pickingId, picking, notify });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Ruta raíz informativa
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'ATM Ricky Rich Traspasos API',
    health: '/api/health',
    endpoints: ['/api/locations', '/api/products?q=', 'POST /api/transfer']
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
