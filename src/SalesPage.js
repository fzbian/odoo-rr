import React, { useCallback, useEffect, useState } from 'react';
import { applyPageMeta } from './lib/meta';
import { useAuth } from './context/AuthContext';
import { useProducts } from './hooks/useProducts';

function formatQty(n){
  if(!Number.isFinite(n)) return '—';
  const v = Number(n);
  const isInt = Math.abs(v - Math.round(v)) < 1e-9;
  return new Intl.NumberFormat('es-ES', { minimumFractionDigits:0, maximumFractionDigits: isInt?0:2 }).format(v);
}

// Página de Reportes (antes Movimientos / Ventas): filtra rango de fechas, almacén y producto, mostrando totales y movimientos.
export default function SalesPage(){
  useEffect(()=> { applyPageMeta({ title: 'Reportes Ventas', favicon: '/logo192.png' }); }, []);
  const { executeKw } = useAuth();
  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [productOpts, setProductOpts] = useState([]); // opciones visibles filtradas
  const [productId, setProductId] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const { loading: productsLoading, loaded: productsLoaded, filter: filterProducts } = useProducts();
  const [from, setFrom] = useState(()=> new Date(new Date().setHours(0,0,0,0)).toISOString().slice(0,10));
  const [to, setTo] = useState(()=> new Date().toISOString().slice(0,10));
  const [loading, setLoading] = useState(false);
  const [searchingProd, setSearchingProd] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null); // {soldQty,inQty,outQty}
  const [moves, setMoves] = useState([]);
  const [showMoves, setShowMoves] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'
  const orderedMoves = React.useMemo(()=>{
    if(!moves || moves.length===0) return moves;
    if(sortOrder==='asc') return [...moves].sort((a,b)=> a.date.localeCompare(b.date));
    return [...moves].sort((a,b)=> b.date.localeCompare(a.date));
  },[moves, sortOrder]);

  // Cargar almacenes una sola vez al montar
  useEffect(()=>{ (async()=>{
    try {
      const ws = await executeKw({ model:'stock.warehouse', method:'search_read', params:[[], ['name']], kwargs:{ limit:50 }, activity:'Almacenes...' });
      setWarehouses(ws);
      if(ws.length) setWarehouseId(ws[0].id);
    } catch(e){ setError(e.message);} })(); },[executeKw]);

  // Filtrar localmente productos precargados
  useEffect(()=>{
    const term = productQuery.trim();
    if(term.length<2){ setProductOpts([]); return; }
    setSearchingProd(true);
    const res = filterProducts(term).map(p=> ({ id:p.id, name:p.name, default_code:p.default_code }));
    setProductOpts(res);
    setSearchingProd(false);
  },[productQuery, filterProducts]);

  const canGenerate = warehouseId && productId && from && to && !loading;

  const generate = useCallback(async ()=>{
    if(!canGenerate) return; setLoading(true); setError(''); setSummary(null); setMoves([]); setHasGenerated(false);
    try {
      // Rangos de fecha: incluir todo el día final -> añadir 23:59:59
      const dateFrom = from + ' 00:00:00';
      const dateTo = to + ' 23:59:59';
      // Obtener ubicaciones internas del almacén (lot_stock + hijos) simplificado: solo lot_stock
      const wh = await executeKw({ model:'stock.warehouse', method:'read', params:[[Number(warehouseId)], ['lot_stock_id']], activity:'Leyendo almacén...' });
      const lotStockId = Array.isArray(wh[0].lot_stock_id)? wh[0].lot_stock_id[0]: wh[0].lot_stock_id;

      // Buscar move lines SOLO donde el almacén participa (origen o destino)
      const domain = [
        '&', ['product_id','=', Number(productId)],
        '&', ['date','>=', dateFrom], ['date','<=', dateTo],
        '|', ['location_id','=', lotStockId], ['location_dest_id','=', lotStockId]
      ];
      const fields = ['id','date','reference','qty_done','location_id','location_dest_id','state'];
      const lines = await executeKw({ model:'stock.move.line', method:'search_read', params:[domain, fields], kwargs:{ limit:5000 }, activity:'Movimientos...' });

      // Recolectar IDs de ubicaciones para leer su uso (usage) y clasificar.
      const locIdsSet = new Set();
      lines.forEach(l=>{ const f=l.location_id; const t=l.location_dest_id; if(Array.isArray(f)) locIdsSet.add(f[0]); else locIdsSet.add(f); if(Array.isArray(t)) locIdsSet.add(t[0]); else locIdsSet.add(t); });
      locIdsSet.delete(false); locIdsSet.delete(null); locIdsSet.delete(undefined);
      const locIds = [...locIdsSet];
      const locUsageMap = new Map();
      if(locIds.length){
        const locRecs = await executeKw({ model:'stock.location', method:'read', params:[locIds, ['usage']], activity:'Usos ubicaciones...' });
        locRecs.forEach(r=> locUsageMap.set(r.id, r.usage));
      }

      function movementType(fromId, toId){
        const fromUsage = locUsageMap.get(fromId) || 'internal';
        const toUsage = locUsageMap.get(toId) || 'internal';
        if(fromId === lotStockId && toId === lotStockId) return 'internal';
        // Ventas: destino cliente
        if(fromId === lotStockId && toUsage === 'customer') return 'sale';
        // Entradas compra: origen supplier
        if(toId === lotStockId && fromUsage === 'supplier') return 'purchase';
        // Ajuste inventario
        if(fromUsage === 'inventory' || toUsage === 'inventory') return 'inventory';
        // Devolución cliente (cliente -> almacén)
        if(toId === lotStockId && fromUsage === 'customer') return 'customer_return';
        // Transfer interno (uno de los lados internal y el otro internal)
        if((fromUsage === 'internal' || fromId===lotStockId) && (toUsage === 'internal' || toId===lotStockId)) return 'internal';
        return 'other';
      }

  let inQty=0,outQtyRaw=0,soldQty=0; const detailed=[];
      for(const ln of lines){
        const locFrom = Array.isArray(ln.location_id)? ln.location_id[0]: ln.location_id;
        const locTo = Array.isArray(ln.location_dest_id)? ln.location_dest_id[0]: ln.location_dest_id;
        const qty = Number(ln.qty_done)||0;
        const type = movementType(locFrom, locTo);
        const isInbound = locTo === lotStockId && locFrom !== lotStockId;
        const isOutbound = locFrom === lotStockId && locTo !== lotStockId;
  if(isInbound && !isOutbound) inQty += qty; else if(isOutbound && !isInbound) outQtyRaw += qty;
  if(type==='sale') soldQty += qty; // vendido solo salidas a cliente
        detailed.push({
          id: ln.id,
          date: ln.date,
          reference: ln.reference,
          qty,
          direction: isInbound ? 'in' : (isOutbound ? 'out':'internal'),
          type,
        });
      }
  const outQty = Math.max(outQtyRaw - soldQty,0); // salidas netas excluyendo ventas finales
  setSummary({ soldQty, inQty, outQty });
  // Guardamos crudo y ordenamos solo en memo orderedMoves
  setMoves(detailed);
      setShowMoves(true);
      setHasGenerated(true);
    } catch(e){ setError(e.message);} finally { setLoading(false);} 
  },[canGenerate, executeKw, warehouseId, productId, from, to]);

  // Limpiar resultados si cambian filtros clave después de generar
  useEffect(()=>{
    setSummary(null); setMoves([]); setShowMoves(false); setHasGenerated(false);
  }, [warehouseId, productId, from, to]);

  // Formato: lunes, 2 de sept del 2025 a las 5:00 AM
  const formatMovementDate = (iso)=>{
    try {
      const d = new Date(iso);
      if(isNaN(d)) return iso;
      d.setHours(d.getHours()-5); // ajuste horario
      const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sept','oct','nov','dic'];
      const diaSemana = dias[d.getDay()];
      const diaNum = d.getDate();
      const mes = meses[d.getMonth()];
      const year = d.getFullYear();
      let h24 = d.getHours();
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      let h12 = h24 % 12; if(h12===0) h12=12;
      const mm = String(d.getMinutes()).padStart(2,'0');
      return `${diaSemana}, ${diaNum} de ${mes} del ${year} a las ${h12}:${mm} ${ampm}`;
    } catch { return iso; }
  };

  const formatMovementDay = (iso)=>{
    try {
      const d = new Date(iso);
      if(isNaN(d)) return iso;
      d.setHours(d.getHours()-5);
      const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sept','oct','nov','dic'];
      const dia = String(d.getDate()).padStart(2,'0');
      const mes = meses[d.getMonth()];
      const year = d.getFullYear();
      return `${dia} ${mes} ${year}`;
    } catch { return iso; }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
  <h1 className="m-0 font-heading font-extrabold text-xl tracking-tight flex items-center gap-2 mb-6"><span className="material-symbols-outlined text-[var(--primary-color)]">trending_up</span>Reportes</h1>

      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--card-color)] p-4 mb-6">
        <div className="grid sm:grid-cols-5 gap-4 text-xs">
          <div className="flex flex-col gap-1">
            <label className="font-semibold">Desde</label>
            <input type="date" value={from} onChange={e=>setFrom(e.target.value)} className="bg-[var(--dark-color)] border border-[var(--border-color)] rounded px-2 py-1" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-semibold">Hasta</label>
            <input type="date" value={to} onChange={e=>setTo(e.target.value)} className="bg-[var(--dark-color)] border border-[var(--border-color)] rounded px-2 py-1" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-semibold">Almacén</label>
            <select value={warehouseId} onChange={e=>setWarehouseId(e.target.value)} className="bg-[var(--dark-color)] border border-[var(--border-color)] rounded px-2 py-1">
              {warehouses.map(w=> <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="font-semibold">Producto</label>
      {productId && selectedProduct ? (
              <div className="flex items-center gap-2 border border-[var(--border-color)] rounded px-2 py-1 bg-[var(--dark-color)]">
        <span className="truncate flex-1 text-[10px]">{selectedProduct.name}{selectedProduct.default_code ? ` (${selectedProduct.default_code})`:''}</span>
                <button onClick={()=>{ setProductId(null); setSelectedProduct(null); setProductQuery(''); setProductOpts([]); }} className="text-[10px] px-2 py-0.5 border border-[var(--border-color)] rounded">Cambiar</button>
              </div>
            ) : (
              <div className="relative">
                <input value={productQuery} onChange={e=>{ setProductQuery(e.target.value); }} placeholder={productsLoading? 'Cargando productos...' : 'Buscar (mín 2)'} className="w-full bg-[var(--dark-color)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] pr-7 disabled:opacity-60" disabled={!productsLoaded || productsLoading} />
                {(searchingProd || productsLoading) && <span className="material-symbols-outlined absolute right-2 top-1.5 text-[14px] animate-spin">progress_activity</span>}
                {productOpts.length>0 && productQuery.trim().length>=2 && (
                  <div className="absolute z-20 mt-1 left-0 right-0 max-h-60 overflow-auto bg-[var(--card-color)] border border-[var(--border-color)] rounded shadow-soft">
                    {productOpts.map(p=> <button key={p.id} type="button" onClick={()=>{ setProductId(p.id); setSelectedProduct(p); setProductOpts([]); }} className="w-full text-left px-3 py-2 text-[10px] flex items-center gap-2 hover:bg-[var(--dark-color)]">
                      <span className="material-symbols-outlined text-[var(--primary-color)] text-sm">inventory_2</span>
                      <span className="truncate flex-1 font-semibold">{p.name}</span>
                      {p.default_code && <span className="kbd">{p.default_code}</span>}
                    </button>)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button disabled={!canGenerate} onClick={generate} className="px-4 py-2 rounded-[var(--radius)] bg-[var(--primary-color)] text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1"><span className="material-symbols-outlined text-sm">play_arrow</span>{hasGenerated? 'Actualizar':'Generar'}</button>
        </div>
      </div>

      {error && <div className="mb-4 p-3 rounded border border-[var(--danger-color)] text-[var(--danger-color)] text-xs flex items-center gap-2"><span className="material-symbols-outlined">error</span>{error}</div>}

  {hasGenerated && summary && (
        <>
          <div className="mb-2 grid sm:grid-cols-3 gap-4 text-xs">
            <StatCard label="Entradas" value={summary.inQty} color="var(--success-color)" icon="arrow_downward" />
            <StatCard label="Salidas (no venta)" value={summary.outQty} color="var(--danger-color)" icon="arrow_upward" />
            <StatCard label="Ventas (cliente)" value={summary.soldQty} color="var(--primary-color)" icon="sell" />
          </div>
          <p className="text-[10px] opacity-60 mb-6">Salidas excluye ventas (cliente). Ventas (cliente) muestra solo salidas a cliente.</p>
        </>
      )}

  {hasGenerated && moves.length>0 && (
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--card-color)]">
          <button onClick={()=>setShowMoves(s=>!s)} className="w-full text-left px-4 py-3 flex items-center gap-2 text-xs font-semibold border-b border-[var(--border-color)]">
            <span className="material-symbols-outlined text-[var(--primary-color)]">list_alt</span>
            Reportes ({moves.length})
    <span className="ml-auto material-symbols-outlined text-sm">{showMoves? 'expand_less':'expand_more'}</span>
          </button>
          {showMoves && (
            <div className="px-4 py-2 flex items-center gap-3 text-[10px] border-b border-[var(--border-color)] bg-[var(--dark-color)]/50">
              <span className="uppercase tracking-wide opacity-60">Orden</span>
              <div className="inline-flex rounded overflow-hidden border border-[var(--border-color)]">
                <button type="button" onClick={()=>setSortOrder('desc')} className={`px-2 py-1 flex items-center gap-1 ${sortOrder==='desc'? 'bg-[var(--primary-color)] text-white':'bg-[var(--dark-color)]'}`}><span className="material-symbols-outlined text-[12px]">south</span>Reciente</button>
                <button type="button" onClick={()=>setSortOrder('asc')} className={`px-2 py-1 flex items-center gap-1 ${sortOrder==='asc'? 'bg-[var(--primary-color)] text-white':'bg-[var(--dark-color)]'}`}><span className="material-symbols-outlined text-[12px]">north</span>Antiguo</button>
              </div>
            </div>
          )}
          {showMoves && (
            <div className="divide-y divide-[var(--border-color)]">
              {(() => {
                let lastDay = null;
                const blocks = [];
                const list = orderedMoves || [];
                for(const m of list){
                  const day = formatMovementDay(m.date);
                  if(day !== lastDay){
                    lastDay = day;
                    blocks.push(
                      <div key={`head-${day}`} className="px-3 py-2 bg-[var(--dark-color)]/50 backdrop-blur flex items-center gap-2 text-[9px] font-semibold tracking-wide uppercase text-[var(--text-secondary-color)] border-b border-[var(--border-color)]">
                        <span className="material-symbols-outlined text-[12px] opacity-70">calendar_month</span>{day}
                      </div>
                    );
                  }
                  const isIn = m.direction==='in';
                  const typeMap = { sale:'Venta', purchase:'Compra', inventory:'Inventario', internal:'Interno', customer_return:'Devolución', other:'Otro' };
                  const tipo = typeMap[m.type] || 'Otro';
                  const arrow = isIn? 'arrow_downward':'arrow_upward';
                  blocks.push(
                    <div key={m.id} className="p-3 flex items-start gap-3 text-[11px]">
                      <div className={`flex-shrink-0 w-8 h-8 rounded-full border border-[var(--border-color)] flex items-center justify-center relative overflow-hidden ${isIn? 'bg-[var(--success-color)]/10':'bg-[var(--danger-color)]/10'}`}> 
                        <span className={`material-symbols-outlined text-[16px] ${isIn? 'text-[var(--success-color)]':'text-[var(--danger-color)]'}`}>{arrow}</span>
                      </div>
                      <div className="flex-1 flex flex-col">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-base font-bold leading-none">{formatQty(m.qty)}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-medium tracking-wide ${isIn? 'bg-[var(--success-color)]/15 text-[var(--success-color)]':'bg-[var(--danger-color)]/15 text-[var(--danger-color)]'}`}>{isIn? 'Entrada':'Salida'}</span>
                          <span className="px-2 py-0.5 rounded-full text-[9px] font-medium tracking-wide bg-[var(--dark-color)] border border-[var(--border-color)]">{tipo}</span>
                        </div>
                        <span className="text-[9px] opacity-60 leading-tight">{formatMovementDate(m.date)}</span>
                      </div>
                    </div>
                  );
                }
                return blocks;
              })()}
            </div>
          )}
        </div>
      )}

      {loading && <div className="mt-6 text-[10px] flex items-center gap-2 text-[var(--text-secondary-color)]"><span className="material-symbols-outlined animate-spin text-[var(--primary-color)]">progress_activity</span>Procesando...</div>}
    </div>
  );
}

function StatCard({ label, value, color, icon }){
  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide opacity-70"><span className={`material-symbols-outlined text-base`} style={{ color }}>{icon}</span>{label}</div>
  <div className="text-xl font-bold" style={{ color }}>{formatQty(value||0)}</div>
    </div>
  );
}
