// Helper para crear traspasos internos en Odoo vía JSON-RPC
// Replica la lógica del script legacy (xmlrpc) adaptada a executeKw del frontend.

export const TRANSFER_STEPS = [
  { key: 'findType', label: 'Encontrando tipo de operación' },
  { key: 'createPicking', label: 'Creando picking' },
  { key: 'readProducts', label: 'Leyendo productos' },
  { key: 'createMoves', label: 'Creando movimientos' },
  { key: 'confirm', label: 'Confirmando' },
  { key: 'assign', label: 'Asignando' },
  { key: 'prepareLines', label: 'Preparando líneas' },
  { key: 'adjustLines', label: 'Ajustando líneas' },
  { key: 'validate', label: 'Validando' },
  { key: 'finalState', label: 'Leyendo estado final' },
];

/**
 * Crea un traslado interno con moves y lo intenta validar.
 * onProgress(stepKey) se dispara antes de cada fase (keys en TRANSFER_STEPS).
 * @param {Function} executeKw
 * @param {Object} opts
 * @param {number} originLocationId
 * @param {number} destLocationId
 * @param {Array<{productId:number, quantity:number, name?:string}>} lines
 * @param {string} [originLabel]
 * @param {string} [destLabel]
 * @param {(stepKey:string)=>void} [onProgress]
 * @returns {Promise<{pickingId:number, pickingName:string, state:string, warning?:string}>}
 */
export async function createInternalTransfer(executeKw, { originLocationId, destLocationId, lines, originLabel='', destLabel='', onProgress, note }) {
  if (!originLocationId || !destLocationId) throw new Error('Ubicaciones inválidas');
  if (originLocationId === destLocationId) throw new Error('Origen y destino no pueden ser iguales');
  const filtered = (lines||[]).filter(l => l.productId && l.quantity>0);
  if (!filtered.length) throw new Error('No hay líneas válidas');

  const progress = (k) => { try { onProgress && onProgress(k); } catch(_){} };

  progress('findType');
  // 1. Obtener picking_type interno que coincida source
  const pickingTypes = await executeKw({ model:'stock.picking.type', method:'search_read', params:[[['code','=','internal'], ['default_location_src_id','=', originLocationId]], ['id']], kwargs:{ limit:1 }, activity:'Buscando tipo de operación...' });
  let pickingTypeId = pickingTypes[0]?.id;
  if(!pickingTypeId){
    const fallback = await executeKw({ model:'stock.picking.type', method:'search_read', params:[[['code','=','internal']], ['id']], kwargs:{ limit:1 }, activity:'Tipo de operación fallback...' });
    if(!fallback.length) throw new Error('No se encontró un tipo de operación interno');
    pickingTypeId = fallback[0].id;
  }

  progress('createPicking');
  // 2. Crear picking
  const pickingVals = {
    location_id: originLocationId,
    location_dest_id: destLocationId,
    picking_type_id: pickingTypeId,
    origin: `Transferencia ${originLabel||originLocationId} -> ${destLabel||destLocationId}`,
    note: note ? `Creado por: ${note}` : undefined
  };
  const pickingId = await executeKw({ model:'stock.picking', method:'create', params:[pickingVals], kwargs:{}, activity:'Creando picking...' });

  progress('readProducts');
  // 3. Leer UoM de productos en batch
  const prodInfo = await executeKw({ model:'product.product', method:'read', params:[filtered.map(l=>l.productId), ['uom_id','default_code','name']], kwargs:{}, activity:'Leyendo productos...' });
  const uomMap = new Map(prodInfo.map(p=>[p.id, Array.isArray(p.uom_id)?p.uom_id[0]:p.uom_id]));
  const codeMap = new Map(prodInfo.map(p=>[p.id, p.default_code]));

  progress('createMoves');
  // 4. Crear moves
  for(const l of filtered){
    const uomId = uomMap.get(l.productId);
    if(!uomId) throw new Error(`Producto ${l.productId} sin UoM`);
    const mvVals = {
      name: `Traspaso ${codeMap.get(l.productId)||l.productId}`,
      product_id: l.productId,
      product_uom: uomId,
      product_uom_qty: l.quantity,
      picking_id: pickingId,
      location_id: originLocationId,
      location_dest_id: destLocationId
    };
    await executeKw({ model:'stock.move', method:'create', params:[mvVals], kwargs:{}, activity:'Creando movimientos...' });
  }

  progress('confirm');
  // 5. Confirmar y asignar
  try { await executeKw({ model:'stock.picking', method:'action_confirm', params:[pickingId], kwargs:{}, activity:'Confirmando...' }); } catch(_){}
  progress('assign');
  try { await executeKw({ model:'stock.picking', method:'action_assign', params:[pickingId], kwargs:{}, activity:'Asignando...' }); } catch(_){}

  progress('prepareLines');
  // 6. Crear líneas si faltan
  const pickData = await executeKw({ model:'stock.picking', method:'read', params:[[pickingId], ['move_line_ids','move_ids_without_package']], kwargs:{}, activity:'Leyendo picking...' });
  const moveLineIds = pickData[0].move_line_ids || [];
  const moveIds = pickData[0].move_ids_without_package || [];
  if(!moveLineIds.length && moveIds.length){
    // Crear move lines con qty_done = product_uom_qty
    for(const mvId of moveIds){
      const mv = await executeKw({ model:'stock.move', method:'read', params:[[mvId], ['product_id','product_uom_qty','product_uom']], kwargs:{}, activity:'Preparando líneas...' });
      await executeKw({ model:'stock.move.line', method:'create', params:[{
        move_id: mvId,
        product_id: mv[0].product_id[0],
        product_uom_id: mv[0].product_uom[0],
        location_id: originLocationId,
        location_dest_id: destLocationId,
        picking_id: pickingId,
        qty_done: mv[0].product_uom_qty
      }], kwargs:{}, activity:'Creando move lines...' });
    }
  } else if(moveLineIds.length){
    progress('adjustLines');
    // Asegurar qty_done = cantidad solicitada
    for(const lineId of moveLineIds){
      const ln = await executeKw({ model:'stock.move.line', method:'read', params:[[lineId], ['move_id','qty_done','product_id']], kwargs:{}, activity:'Revisando líneas...' });
      const mvId = Array.isArray(ln[0].move_id)?ln[0].move_id[0]:ln[0].move_id;
      const mv = await executeKw({ model:'stock.move', method:'read', params:[[mvId], ['product_uom_qty','product_id']], kwargs:{}, activity:'Leyendo movimiento...' });
      const desired = mv[0].product_uom_qty;
      if(ln[0].qty_done !== desired){
        await executeKw({ model:'stock.move.line', method:'write', params:[[lineId], { qty_done: desired }], kwargs:{}, activity:'Ajustando qty...' });
      }
    }
  }

  progress('validate');
  // 7. Validar
  let stateWarning = '';
  try { await executeKw({ model:'stock.picking', method:'action_done', params:[pickingId], kwargs:{}, activity:'Validando...' }); }
  catch(err){
    try { await executeKw({ model:'stock.picking', method:'button_validate', params:[pickingId], kwargs:{}, activity:'Validando...' }); }
    catch(e){ stateWarning = e.message || 'Validación parcial'; }
  }

  progress('finalState');
  // 8. Leer estado final
  const finalInfo = await executeKw({ model:'stock.picking', method:'read', params:[[pickingId], ['name','state']], kwargs:{}, activity:'Estado final...' });
  const pickingName = finalInfo[0].name;
  const state = finalInfo[0].state;
  let warning = stateWarning;
  if(state !== 'done' && !warning){
    const label = {draft:'Borrador',waiting:'Esperando',confirmed:'En espera',assigned:'Preparado',done:'Hecho',cancel:'Cancelado'}[state] || state;
    warning = `Transferencia creada pero quedó en estado ${label}`;
  }
  return { pickingId, pickingName, state, warning };
}
