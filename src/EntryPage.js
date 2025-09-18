import React, { useCallback, useEffect, useState } from 'react';
import { applyPageMeta } from './lib/meta';
import { useAuth } from './context/AuthContext';
import { sendChatMessage, CHAT_TRASPASOS, bold } from './lib/notify';
import { useProducts } from './hooks/useProducts';

function formatQty(n){
  if(!Number.isFinite(n)) return '—';
  const v = Number(n);
  const isInt = Math.abs(v - Math.round(v)) < 1e-9;
  return new Intl.NumberFormat('es-ES',{minimumFractionDigits:0, maximumFractionDigits:isInt?0:2}).format(v);
}

// Página de creación de entradas (picking incoming) con promedio de costos
export default function EntryPage(){
  useEffect(()=> { applyPageMeta({ title: 'Entradas', favicon: '/logo192.png' }); }, []);
  const { auth, executeKw } = useAuth();
  const canEntry = auth?.employee && auth?.isDeveloper; // Department Administration

  const [warehouseId, setWarehouseId] = useState('');
  const [warehouseName, setWarehouseName] = useState('');
  const [items, setItems] = useState([{ id: Date.now(), productId:null, name:'', code:'', qty:'', cost:'', loading:false }]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [step, setStep] = useState('');
  const { loading: productsLoading, loaded: productsLoaded, filter: filterHook } = useProducts();
  // Estados para confirmación
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [confirmData, setConfirmData] = useState([]); // [{productId,name,code,uomId,currentQty,currentCost,incomingQty,incomingCost,newQty,newCost}]

  const addRow = ()=> setItems(ls=>[...ls,{ id:Date.now()+Math.random(), productId:null, name:'', code:'', qty:'', cost:'', loading:false }]);
  const updateRow = (id, patch)=> setItems(ls=> ls.map(r=> r.id===id? {...r,...patch}:r));
  const removeRow = (id)=> setItems(ls=> ls.length===1? ls : ls.filter(r=> r.id!==id));

  const validRows = items.filter(r=> r.productId && Number(r.qty)>0 && Number(r.cost)>0);
  const canSubmit = canEntry && warehouseId && validRows.length>0 && !loading;
  const formatMoney = (v)=> '$'+ Number(v||0).toLocaleString('es-CO',{minimumFractionDigits:0, maximumFractionDigits:0});

  // Cargar almacén fijo "Bodega"
  useEffect(()=>{ if(!auth) return; (async()=>{
    setLoading(true); setError(''); setStep('cargando almacén');
    try {
      const ws = await executeKw({ model:'stock.warehouse', method:'search_read', params:[[['name','=','Bodega']], ['name','lot_stock_id']], kwargs:{ limit:1 }, activity:'Almacén Bodega...' });
      if(!ws.length) throw new Error('Almacén "Bodega" no encontrado');
      setWarehouseId(ws[0].id); setWarehouseName(ws[0].name);
    } catch(e){ setError(e.message);} finally { setLoading(false); setStep(''); }
  })(); },[auth, executeKw]);

  // Eliminado prefetch local: ahora centralizado en useProducts
  useEffect(()=>{ if(productsLoading) setStep(s=> s || 'cargando productos'); else setStep(s=> s==='cargando productos'? '' : s); },[productsLoading]);

  const filterProducts = useCallback((term)=> filterHook(term),[filterHook]);

  const processEntry = useCallback(async ()=>{
    if(!canSubmit) return;
    setLoading(true); setError(''); setResult(null); setMessage(''); setStep('preparando');
    try {
      setStep('picking type');
      const pickingTypes = await executeKw({ model:'stock.picking.type', method:'search_read', params:[[['warehouse_id','=', Number(warehouseId)], ['code','=','incoming']], ['id']], kwargs:{ limit:1 }, activity:'Tipo entrada...' });
      if(!pickingTypes.length) throw new Error('No se encontró picking type de entrada');
      const pickingTypeId = pickingTypes[0].id;

      setStep('leer almacén');
      const whRead = await executeKw({ model:'stock.warehouse', method:'read', params:[[Number(warehouseId)], ['lot_stock_id']], activity:'Leyendo almacén...' });
      const wh = Array.isArray(whRead)? whRead[0]: whRead;
      const lotStockId = Array.isArray(wh.lot_stock_id)? wh.lot_stock_id[0]: wh.lot_stock_id; // aseguramos ID
      if(!lotStockId) throw new Error('Almacén sin lot_stock');

      setStep('ubicación proveedor');
      const supplierLocs = await executeKw({ model:'stock.location', method:'search_read', params:[[['usage','=','supplier']], ['id']], kwargs:{ limit:1 }, activity:'Ubicación proveedor...' });
      const supplierLocId = supplierLocs[0]?.id || 1;

  // Crear picking sin movimientos primero (sanitizar id)
  setStep('creando picking');
  const pickingCreated = await executeKw({ model:'stock.picking', method:'create', params:[[{ picking_type_id: pickingTypeId, location_id: supplierLocId, location_dest_id: lotStockId }]], activity:'Creando entrada...' });
  const pickingId = Array.isArray(pickingCreated)? pickingCreated[0]: pickingCreated;
  if(!Number.isInteger(pickingId)) throw new Error('Picking ID inválido');

      // Crear movimientos uno por uno (evita comandos masivos que provocan error en algunos casos)
      const moveIds = [];
      const toId = v=> Array.isArray(v)? v[0]: v;
      for(const row of confirmData){
        setStep(`producto ${row.code||row.name}`);
        setStep(`actualizando costo ${row.code||row.productId}`);
        await executeKw({ model:'product.product', method:'write', params:[[row.productId], { standard_price: row.newCost }], activity:'Actualizando costo...' });
        setStep(`creando movimiento ${row.code||row.productId}`);
        const moveCreated = await executeKw({ model:'stock.move', method:'create', params:[[{ 
          name: row.name,
          product_id: row.productId,
          product_uom: row.uomId ? toId(row.uomId): undefined,
          product_uom_qty: row.incomingQty,
          location_id: supplierLocId,
          location_dest_id: lotStockId,
          picking_id: pickingId,
          price_unit: row.incomingCost,
        }]], activity:'Creando movimiento...' });
        const moveId = toId(moveCreated);
        if(Number.isInteger(moveId)) moveIds.push(moveId);
      }

      // Confirmar picking
      setStep('confirmando');
      try {
        await executeKw({ model:'stock.picking', method:'action_confirm', params:[[pickingId]], activity:'Confirmando...' });
      } catch(err){
        // Reintento alternativo: confirmar cada move (en versiones antiguas) antes
        setStep('confirmando movimientos');
        for(const id of moveIds){
          try { await executeKw({ model:'stock.move', method:'_action_confirm', params:[[id]], activity:'Confirmando movimiento...' }); } catch(_){}
        }
        // Intentar confirmar de nuevo
        await executeKw({ model:'stock.picking', method:'action_confirm', params:[[pickingId]], activity:'Confirmando (retry)...' });
      }
      setStep('asignando');
      await executeKw({ model:'stock.picking', method:'action_assign', params:[[pickingId]], activity:'Asignando...' });
      setStep('validando');
      // Establecer quantity_done en move lines (stock.move.line) igual a demandado
      try {
        const moves = await executeKw({ model:'stock.move', method:'read', params:[moveIds, ['move_line_ids','product_uom_qty','product_id','product_uom']], activity:'Leyendo movimientos...' });
        for(const mv of moves){
          const mll = Array.isArray(mv.move_line_ids)? mv.move_line_ids:[];
          const mvProdId = toId(mv.product_id);
          const mvUomId = toId(mv.product_uom);
          if(mll.length===0){
            await executeKw({ model:'stock.move.line', method:'create', params:[[{ 
              move_id: mv.id,
              picking_id: pickingId,
              product_id: mvProdId,
              product_uom_id: mvUomId,
              qty_done: mv.product_uom_qty,
              location_id: supplierLocId,
              location_dest_id: lotStockId,
            }]], activity:'Creando move line...' });
          } else {
            await executeKw({ model:'stock.move.line', method:'write', params:[mll, { qty_done: mv.product_uom_qty }], activity:'Actualizando move lines...' });
          }
        }
      } catch(_){}
      await executeKw({ model:'stock.picking', method:'button_validate', params:[[pickingId]], activity:'Validando...' });
  setResult({ pickingId, lines: confirmData.map(l=> ({ code:l.code, name:l.name, newQty:l.newQty, newCost:l.newCost })) });
      // Notificación Entrada
      try {
        const prodLines = confirmData.map(l=> `• ${l.name} (+${formatQty(l.incomingQty)})`).join('\n');
        const msg = [
          '📦 *Entrada creada*',
          `${bold('Entrada a')}: ${warehouseName || 'Bodega'}`,
          '',
          bold('Productos'),
          prodLines
        ].join('\n');
  sendChatMessage({ chat: CHAT_TRASPASOS, message: msg });
      } catch(_){ }
      setMessage('Entrada realizada correctamente ✅');
      setItems([{ id: Date.now(), productId:null, name:'', code:'', qty:'', cost:'', loading:false }]);
      setStep('');
      setConfirmData([]); setConfirmOpen(false);
    } catch(e){
      setError(e.message || String(e));
    } finally { setLoading(false); }
  },[canSubmit, executeKw, warehouseId, confirmData, warehouseName]);

  const prepareConfirm = useCallback(async ()=>{
    if(!canSubmit) return;
    setConfirmLoading(true); setError(''); setConfirmData([]);
    try {
      const ids = validRows.map(r=> r.productId);
      const uniqueIds = Array.from(new Set(ids));
      const prods = await executeKw({ model:'product.product', method:'read', params:[uniqueIds, ['name','default_code','qty_available','standard_price','uom_id']], activity:'Leyendo productos para confirmación...' });
      const prodMap = new Map(prods.map(p=> [p.id, p]));
      const rows = validRows.map(r=>{
        const p = prodMap.get(r.productId) || {};
        const currentQty = Math.max(p.qty_available||0,0);
        const currentCost = Number(p.standard_price||0);
        const incomingQty = Number(r.qty);
        const incomingCost = Number(r.cost);
        const newQty = currentQty + incomingQty;
        const newCost = newQty>0 ? ((currentQty*currentCost)+(incomingQty*incomingCost))/newQty : incomingCost;
        return {
          productId: r.productId,
          name: p.name || r.name,
          code: p.default_code || r.code,
          uomId: p.uom_id,
          currentQty, currentCost, incomingQty, incomingCost, newQty, newCost
        };
      });
      setConfirmData(rows);
      setConfirmOpen(true);
    } catch(e){ setError(e.message||String(e)); }
    finally { setConfirmLoading(false); }
  },[canSubmit, executeKw, validRows]);

  if(!canEntry){
    return (
      <div className="p-6 max-w-xl mx-auto">
        <div className="p-8 rounded-2xl border border-[var(--border-color)] bg-[var(--card-color)] text-center shadow-soft">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--danger-color)]/15 border border-[var(--danger-color)] mb-4">
            <span className="material-symbols-outlined text-[32px] text-[var(--danger-color)]">block</span>
          </div>
            <h1 className="m-0 text-xl font-heading font-extrabold tracking-tight">Acceso restringido</h1>
            <p className="mt-2 mb-5 text-sm leading-relaxed text-[var(--text-secondary-color)]">No tienes permiso para hacer esto.</p>
            <div className="flex justify-center">
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary-color)]">Contacta a un administrador si crees que es un error.</span>
            </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <h1 className="m-0 font-heading font-extrabold text-lg sm:text-xl tracking-tight flex items-center gap-2 mb-4 sm:mb-6"><span className="material-symbols-outlined text-[var(--primary-color)]">login</span>Nueva entrada</h1>
      <div className="mb-4 sm:mb-6 text-[10px] sm:text-xs text-[var(--text-secondary-color)] flex items-center gap-2">
        <span className="material-symbols-outlined text-[var(--primary-color)] text-base">store</span>
        Almacén destino fijo: <span className="kbd">{warehouseName || (loading? 'Cargando…':'Bodega')}</span>
      </div>
      <div className="grid gap-3 sm:gap-4">
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--card-color)]">
          <div className="hidden sm:flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)] text-[10px] uppercase tracking-wide text-[var(--text-secondary-color)]">
            <div className="flex-1">Producto</div>
            <div className="w-24 text-right">Cantidad</div>
            <div className="w-28 text-right">Costo unit.</div>
            <div className="w-16" />
          </div>
          <div className="divide-y divide-[var(--border-color)]">
            {items.map(r=>{
              const qtyInvalid = !(Number(r.qty)>0);
              const costInvalid = !(Number(r.cost)>0);
              return (
                <div key={r.id} className="p-2 sm:p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 text-xs sm:text-sm">
                  <div className="flex-1 min-w-0 order-1">
                    {r.productId ? (
                      <div className="flex items-center gap-2">
                        <span className="font-semibold truncate text-xs sm:text-sm">{r.name}</span>
                        {r.code && <span className="kbd">{r.code}</span>}
                        <button onClick={()=>updateRow(r.id,{productId:null,name:'',code:''})} className="ml-auto text-[10px] px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary-color)] hover:text-[var(--text-color)]">Cambiar</button>
                      </div>
                    ) : (
                      <ProductSearchRow onSelect={(prod)=> updateRow(r.id,{ productId:prod.id, name:prod.name, code:prod.default_code })} filterProducts={filterProducts} allLoaded={productsLoaded} productsLoading={productsLoading} />
                    )}
                  </div>
                  <div className="flex items-center gap-2 sm:gap-3 order-3 sm:order-2">
                    <div className="flex flex-col w-1/2 sm:w-24">
                      <label className="sm:hidden text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)] mb-0.5">Cantidad</label>
                      <input value={r.qty} onChange={e=>updateRow(r.id,{qty:e.target.value})} placeholder="0" inputMode="decimal" className={`w-full sm:w-24 text-right bg-[var(--dark-color)] border ${qtyInvalid && r.qty!==''? 'border-[var(--danger-color)]':'border-[var(--border-color)]'} rounded px-2 py-1.5 text-xs sm:text-sm`} />
                    </div>
                    <div className="flex flex-col w-1/2 sm:w-28">
                      <label className="sm:hidden text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)] mb-0.5">Costo</label>
                      <input value={r.cost} onChange={e=>updateRow(r.id,{cost:e.target.value})} placeholder="0" inputMode="decimal" className={`w-full sm:w-28 text-right bg-[var(--dark-color)] border ${costInvalid && r.cost!==''? 'border-[var(--danger-color)]':'border-[var(--border-color)]'} rounded px-2 py-1.5 text-xs sm:text-sm`} />
                    </div>
                  </div>
                  <div className="flex justify-end order-2 sm:order-3 sm:w-16">
                    {items.length>1 && (
                      <button onClick={()=>removeRow(r.id)} className="px-2 py-1 rounded border border-[var(--danger-color)] text-[var(--danger-color)] text-[10px] sm:text-[11px] flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">delete</span></button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="p-2 sm:p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
            <div className="flex gap-2">
              <button onClick={addRow} className="flex-1 sm:flex-none px-3 py-2 rounded-[var(--radius)] border border-[var(--primary-color)] text-[var(--primary-color)] text-[11px] sm:text-xs font-medium flex items-center justify-center gap-1"><span className="material-symbols-outlined text-sm">add</span>Línea</button>
              <button disabled={!canSubmit || confirmLoading} onClick={prepareConfirm} className="flex-1 sm:hidden px-3 py-2 rounded-[var(--radius)] bg-[var(--primary-color)] text-white text-[11px] font-semibold disabled:opacity-50 flex items-center justify-center gap-1"><span className="material-symbols-outlined text-sm">check_circle</span>Procesar</button>
            </div>
            <div className="sm:ml-auto hidden sm:flex items-center gap-3">
              <button disabled={!canSubmit || confirmLoading} onClick={prepareConfirm} className="px-4 py-2 rounded-[var(--radius)] bg-[var(--primary-color)] text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1"><span className="material-symbols-outlined text-sm">check_circle</span>Procesar entrada</button>
            </div>
          </div>
        </div>
      </div>
      {error && <div className="mt-4 p-3 rounded border border-[var(--danger-color)] text-[var(--danger-color)] text-sm flex items-center gap-2"><span className="material-symbols-outlined">error</span>{error}{step && <span className='opacity-60'> · paso: {step}</span>}</div>}
      {message && <div className="mt-4 p-3 rounded border border-[var(--success-color)] text-[var(--success-color)] text-sm flex items-center gap-2"><span className="material-symbols-outlined">task_alt</span>{message}</div>}
      {result && (
        <div className="mt-4 p-3 rounded border border-[var(--border-color)] text-[var(--text-secondary-color)] text-xs flex flex-col gap-2">
          <div className="flex items-center gap-2"><span className="material-symbols-outlined text-[var(--primary-color)]">inventory_2</span>Picking ID {result.pickingId}</div>
          {result.lines && result.lines.length>0 && (
            <div className="mt-1 border-t border-[var(--border-color)] pt-2 grid gap-1">
              {result.lines.map(l=> (
                <div key={l.code||l.name} className="flex items-center gap-2 text-[11px]">
                  {l.code && <span className="kbd">{l.code}</span>}
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="text-[var(--text-secondary-color)]">Nuevo stock: <span className="text-[var(--text-color)] font-semibold">{formatQty(l.newQty)}</span></span>
                  <span className="text-[var(--text-secondary-color)]">Costo: <span className="text-[var(--text-color)] font-semibold">{formatMoney(l.newCost)}</span></span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {loading && <div className="mt-4 text-xs text-[var(--text-secondary-color)] flex items-center gap-2"><span className="material-symbols-outlined animate-spin text-[var(--primary-color)]">progress_activity</span>Procesando… {step && <span className='opacity-70'>{step}</span>}</div>}
      {!loading && productsLoading && <div className="mt-4 text-xs text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined animate-spin text-[var(--primary-color)]">progress_activity</span> Precargando productos…</div>}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4">
          <div className="w-full sm:max-w-4xl bg-[var(--card-color)] rounded-t-lg sm:rounded-lg border border-[var(--border-color)] shadow-lg flex flex-col max-h-[90vh] sm:max-h-[85vh]">
            <div className="p-4 flex items-center gap-2 border-b border-[var(--border-color)]">
              <span className="material-symbols-outlined text-[var(--primary-color)]">playlist_add_check</span>
              <h2 className="m-0 text-sm font-semibold flex-1">Confirmar entrada</h2>
              <div className="text-[10px] text-[var(--text-secondary-color)]">{confirmData.length} {confirmData.length===1? 'Producto':'Productos'}</div>
            </div>
            <div className="overflow-auto px-3 sm:px-4 py-3 text-[10px] sm:text-[11px]">
              <div className="hidden sm:grid grid-cols-12 gap-2 font-semibold mb-2">
                <div className="col-span-3">Producto</div>
                <div className="col-span-1 text-right">Stock</div>
                <div className="col-span-1 text-right">Costo</div>
                <div className="col-span-1 text-right">Entr.</div>
                <div className="col-span-1 text-right">Costo Ent.</div>
                <div className="col-span-1 text-right">Nuevo Qty</div>
                <div className="col-span-1 text-right">Nuevo Costo</div>
                <div className="col-span-3" />
              </div>
              <div className="space-y-2 sm:space-y-0">
              {confirmData.map(r=> (
                <div key={r.productId} className="sm:grid sm:grid-cols-12 sm:gap-2 py-2 sm:py-1 border border-[var(--border-color)] sm:border-none sm:border-b sm:border-[var(--border-color)]/40 rounded sm:rounded-none px-3 sm:px-0">
                  <div className="sm:col-span-3 flex items-center gap-1 truncate mb-1 sm:mb-0 text-xs sm:text-[11px]">{r.code && <span className="kbd shrink-0">{r.code}</span>}<span className="truncate font-medium">{r.name}</span></div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] sm:hidden mb-1">
                    <span>Stock: <strong>{formatQty(r.currentQty)}</strong></span>
                    <span>Costo: <strong>{formatMoney(r.currentCost)}</strong></span>
                    <span>Entr.: <strong className="text-[var(--success-color)]">{r.incomingQty}</strong></span>
                    <span>Costo Ent.: <strong>{formatMoney(r.incomingCost)}</strong></span>
                    <span>Nuevo Qty: <strong>{formatQty(r.newQty)}</strong></span>
                    <span>Nuevo Costo: <strong>{formatMoney(r.newCost)}</strong></span>
                  </div>
                  <div className="hidden sm:col-span-1 sm:block text-right">{formatQty(r.currentQty)}</div>
                  <div className="hidden sm:col-span-1 sm:block text-right">{formatMoney(r.currentCost)}</div>
                  <div className="hidden sm:col-span-1 sm:block text-right font-semibold text-[var(--success-color)]">{r.incomingQty}</div>
                  <div className="hidden sm:col-span-1 sm:block text-right">{formatMoney(r.incomingCost)}</div>
                  <div className="hidden sm:col-span-1 sm:block text-right font-semibold">{formatQty(r.newQty)}</div>
                  <div className="hidden sm:col-span-1 sm:block text-right font-semibold">{formatMoney(r.newCost)}</div>
                  <div className="sm:col-span-3 text-[var(--text-secondary-color)] truncate text-[10px] hidden sm:block">Prom: (({r.currentQty}*{r.currentCost.toFixed(2)})+({r.incomingQty}*{r.incomingCost.toFixed(2)}))/{r.newQty}</div>
                </div>
              ))}
              </div>
            </div>
            <div className="p-3 sm:p-4 flex flex-col sm:flex-row items-center gap-2 sm:gap-3 border-t border-[var(--border-color)]">
              <button disabled={loading} onClick={()=>{ setConfirmOpen(false); setConfirmData([]); }} className="w-full sm:w-auto px-3 py-2 rounded-[var(--radius)] border border-[var(--border-color)] text-[11px] sm:text-xs flex items-center justify-center gap-1"><span className="material-symbols-outlined text-sm">close</span>Cancelar</button>
              <button disabled={loading || confirmLoading} onClick={processEntry} className="w-full sm:w-auto ml-0 sm:ml-auto px-4 py-2 rounded-[var(--radius)] bg-[var(--primary-color)] text-white text-[11px] sm:text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-50"><span className="material-symbols-outlined text-sm">done_all</span>{loading? 'Procesando...' : 'Confirmar'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProductSearchRow({ onSelect, filterProducts, allLoaded, productsLoading }){
  const [q,setQ]=useState('');
  const [opts,setOpts]=useState([]);
  const [open,setOpen]=useState(false);
  useEffect(()=>{ if(!allLoaded) return; const res = filterProducts(q); setOpts(res); },[q, allLoaded, filterProducts]);
  return (
    <div className="relative">
      <input value={q} onFocus={()=>{ setOpen(true); }} onChange={e=>setQ(e.target.value)} placeholder={allLoaded? 'Buscar producto':'Cargando productos…'} disabled={!allLoaded} className="w-full bg-[var(--dark-color)] border border-[var(--border-color)] rounded px-2 py-1.5 text-sm pr-8 disabled:opacity-60" />
      {(!allLoaded || productsLoading) && <span className="material-symbols-outlined absolute right-2 top-2.5 text-[14px] animate-spin">progress_activity</span>}
      {open && opts.length>0 && (
        <div className="absolute z-10 mt-1 left-0 right-0 bg-[var(--card-color)] border border-[var(--border-color)] rounded shadow-soft max-h-56 overflow-auto">
          {opts.map(o=> <button key={o.id} type="button" onClick={()=>{ onSelect(o); setQ(''); setOpts([]); setOpen(false); }} className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--dark-color)]">
            <span className="material-symbols-outlined text-[var(--primary-color)] text-sm">inventory_2</span>
            <span className="font-semibold truncate flex-1">{o.name}</span>
            {o.default_code && <span className="kbd">{o.default_code}</span>}
          </button>) }
          {opts.length===0 && <div className="px-3 py-2 text-[10px] text-[var(--text-secondary-color)]">Sin resultados</div>}
        </div>
      )}
    </div>
  );
}
