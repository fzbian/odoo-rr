import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyPageMeta } from './lib/meta';
import { useAuth } from './context/AuthContext';
import { parseOdooDate } from './utils/dates';

function formatQty(n){
  if(!Number.isFinite(n)) return '—';
  const v=Number(n);
  const isInt=Math.abs(v-Math.round(v))<1e-9;
  return new Intl.NumberFormat('es-ES',{minimumFractionDigits:0,maximumFractionDigits:isInt?0:2}).format(v);
}

function compareProductByCode(a,b){
  const ca = a.code || '';
  const cb = b.code || '';
  if (ca && cb) {
    const as = ca.split('.');
    const bs = cb.split('.');
    const len = Math.max(as.length, bs.length);
    for (let i=0;i<len;i++){
      const av = as[i];
      const bv = bs[i];
      if (av == null) return -1; // a más corto primero
      if (bv == null) return 1;
      const aNum = /^\d+$/.test(av);
      const bNum = /^\d+$/.test(bv);
      if (aNum && bNum){
        const ai = Number(av); const bi = Number(bv);
        if (ai !== bi) return ai - bi;
      } else if (aNum !== bNum){
        return aNum ? -1 : 1; // num antes que texto
      } else {
        const cmp = av.localeCompare(bv, 'es', { numeric:true, sensitivity:'base' });
        if (cmp !== 0) return cmp;
      }
    }
    // Si todos los segmentos iguales, ordenar por longitud (más corto primero)
    if (as.length !== bs.length) return as.length - bs.length;
    return 0;
  }
  if (ca && !cb) return -1;
  if (!ca && cb) return 1;
  return a.name.localeCompare(b.name, 'es', { numeric:true, sensitivity:'base' });
}

// Formato requerido: "08 de sept. del 2025 a las 01:12 PM" (aplica parseOdooDate que ya resta 5h)
function formatMovementDate(isoStr){
  const d = parseOdooDate(isoStr);
  if(!d) return isoStr || '';
  const day = String(d.getDate()).padStart(2,'0');
  const months = ['ene.','feb.','mar.','abr.','may.','jun.','jul.','ago.','sept.','oct.','nov.','dic.'];
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  let h24 = d.getHours();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12; if(h12 === 0) h12 = 12;
  const hh = String(h12).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${day} de ${month} del ${year} a las ${hh}:${mm} ${ampm}`;
}

function formatMovementDay(isoStr){
  const d = parseOdooDate(isoStr);
  if(!d) return isoStr || '';
  const day = String(d.getDate()).padStart(2,'0');
  const months = ['ene.','feb.','mar.','abr.','may.','jun.','jul.','ago.','sept.','oct.','nov.','dic.'];
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day} de ${month} ${year}`;
}

function friendlyLocationName(raw){
  if(!raw) return raw;
  // Normalizaciones específicas
  if(/Partners\/Customers/i.test(raw)) return 'Cliente final';
  if(/Virtual Locations\/Inventory adjustment/i.test(raw)) return 'Ajuste inventario';
  // Ejemplos de códigos abreviados -> nombres comerciales
  if(/^BLO\//.test(raw) || /BLO\/Stock/i.test(raw)) return 'Burbuja Lo Nuestro';
  if(/^LON\//.test(raw)) return 'London';
  // Quitar sufijo /Stock para limpieza visual
  return raw.replace(/\/Stock$/,'');
}

export default function StockPage(){
  useEffect(()=> { applyPageMeta({ title: 'Inventario', favicon: '/logo192.png' }); }, []);
  const { auth, executeKw } = useAuth();
  const [locations, setLocations] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [selectedLoc, setSelectedLoc] = useState('');
  const [hasGenerated, setHasGenerated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [products, setProducts] = useState([]);
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const [error, setError] = useState('');
  const [openHistory, setOpenHistory] = useState(null); // product id
  const [movesCache, setMovesCache] = useState({}); // productId -> { [periodKey]: { lines, afterStock } }
  const [movesLoading, setMovesLoading] = useState(false);
  const [productSortOrder, setProductSortOrder] = useState('desc'); // 'asc' | 'desc'
  const now = new Date();
  const defaultMonth = now.getMonth()+1; // fallback para periodo inicial por producto
  const defaultYear = now.getFullYear();
  const [productPeriods, setProductPeriods] = useState({}); // productId -> {month, year}

  // focus inicial
  useEffect(()=>{ inputRef.current?.focus(); }, []);

  const locationById = useMemo(()=>{ const m=new Map(); locations.forEach(l=>m.set(l.id,l)); return m; },[locations]);

  const lotStockMap = useMemo(()=>{ const m=new Map(); warehouses.forEach(w=>{ const id=Array.isArray(w.lot_stock_id)?w.lot_stock_id[0]:w.lot_stock_id; if(id) m.set(id,w.name); }); return m; },[warehouses]);
  const viewLocMap = useMemo(()=>{ const m=new Map(); warehouses.forEach(w=>{ const id=Array.isArray(w.view_location_id)?w.view_location_id[0]:w.view_location_id; if(id) m.set(id,w.name); }); return m; },[warehouses]);
  function resolveWarehouseName(loc){ if(!loc) return null; const direct=lotStockMap.get(loc.id); if(direct) return direct; let cur=loc; const seen=new Set(); for(let i=0;i<15 && cur && !seen.has(cur.id);i++){ seen.add(cur.id); if(lotStockMap.has(cur.id)) return lotStockMap.get(cur.id); if(viewLocMap.has(cur.id)) return viewLocMap.get(cur.id); const parentId=Array.isArray(cur.location_id)?cur.location_id[0]:cur.location_id; if(!parentId) break; cur=locationById.get(parentId); } return null; }
  function getLocationLabel(loc){ const nm=(loc?.name||'').trim(); const wh=resolveWarehouseName(loc); const isLot=loc && lotStockMap.has(loc.id); if(wh && isLot) return wh; if(wh) return `${wh} · ${nm}`; return nm || loc?.id; }

  const fetchMeta = useCallback(async ()=>{
    if(!auth) return;
    setLoading(true); setError('');
    try {
      const [locs, whs] = await Promise.all([
        executeKw({ model:'stock.location', method:'search_read', params:[[['usage','=','internal']], ['name','complete_name','location_id']], kwargs:{ limit:600 }, activity:'Ubicaciones...' }),
        executeKw({ model:'stock.warehouse', method:'search_read', params:[[], ['name','lot_stock_id','view_location_id']], kwargs:{ limit:200 }, activity:'Almacenes...' }),
      ]);
      setLocations(locs); setWarehouses(whs);
    } catch(e){ setError(e.message); }
    finally { setLoading(false); }
  },[auth, executeKw]);
  useEffect(()=>{ fetchMeta(); },[fetchMeta]);

  const allValidInternalIds = useMemo(()=>{
    return locations
      .filter(l => {
        const nm = (l.name||'').toLowerCase();
        return !(/averiados/i.test(nm) || /prueba/i.test(nm));
      })
      .map(l=>l.id);
  }, [locations]);

  const fetchStock = useCallback(async ()=>{
    if(!auth || !selectedLoc) return;
    setLoading(true); setError('');
    try {
      let domain;
      if (selectedLoc === 'ALL') {
        if (!allValidInternalIds.length) { setProducts([]); setLoading(false); return; }
        domain = [['location_id','in', allValidInternalIds], ['quantity','>',0]];
      } else {
        domain = [['location_id','=', Number(selectedLoc)], ['quantity','>',0]];
      }
      const quantFields = ['product_id','quantity'];
      const quants = await executeKw({ model:'stock.quant', method:'search_read', params:[domain, quantFields], kwargs:{ limit: 500 }, activity:'Stock...' });
      const agg = new Map();
      quants.forEach(qt=>{ const pid = Array.isArray(qt.product_id)? qt.product_id[0]:qt.product_id; agg.set(pid, (agg.get(pid)||0)+qt.quantity); });
      const productIds=[...agg.keys()];
      let details=[];
      if(productIds.length){
        const pFields=['name','default_code','uom_id'];
        details = await executeKw({ model:'product.product', method:'read', params:[productIds, pFields], activity:'Productos...' });
      }
  const rows = details.map(d=>({ id:d.id, name:d.name, code:d.default_code, uom: Array.isArray(d.uom_id)? d.uom_id[1]:d.uom_id, qty: agg.get(d.id) }));
  rows.sort(compareProductByCode);
      setProducts(rows);
      setHasGenerated(true);
    } catch(e){ setError(e.message); }
    finally { setLoading(false); }
  },[auth, selectedLoc, executeKw, allValidInternalIds]);
  // Ya no auto-fetch al cambiar ubicación; solo manual.

  // Limpiar productos al cambiar ubicación
  useEffect(()=>{ setProducts([]); setOpenHistory(null); setHasGenerated(false); }, [selectedLoc]);
  // (Temporal) ya no reinicia todo al cambiar mes/año; se controlará dentro del historial
  // useEffect(()=>{ setMovesCache({}); setOpenHistory(null); }, [filterMonth, filterYear]);

  const filtered = useMemo(()=>{
    const term = q.trim().toLowerCase();
    if(!term) return products;
    return products.filter(p=> p.name.toLowerCase().includes(term) || (p.code||'').toLowerCase().includes(term));
  },[q, products]);

  const fetchMoves = useCallback(async (productId, currentQty, periodOverride)=>{
    if(!auth) return null;
    setMovesLoading(true);
    try {
      // Determinar periodo
      const per = periodOverride || productPeriods[productId] || { month: defaultMonth, year: defaultYear };
      const start = new Date(per.year, per.month-1, 1, 0,0,0);
      const end = new Date(per.year, per.month, 0, 23,59,59);
      const startStr = start.toISOString().slice(0,19).replace('T',' ');
      const endStr = end.toISOString().slice(0,19).replace('T',' ');
      // Dominio movimientos del periodo
      let domain;
      if(selectedLoc === 'ALL') {
        if(!allValidInternalIds.length) return null;
        domain = ['&','&',['product_id','=', productId], ['date','>=', startStr], ['date','<=', endStr], '|', ['location_id','in', allValidInternalIds], ['location_dest_id','in', allValidInternalIds]];
      } else {
        const locId = Number(selectedLoc);
        domain = ['&','&',['product_id','=', productId], ['date','>=', startStr], ['date','<=', endStr], '|', ['location_id','=', locId], ['location_dest_id','=', locId]];
      }
      const fields = ['date','qty_done','product_uom_id','location_id','location_dest_id','reference','picking_id'];
      const periodLines = await executeKw({ model:'stock.move.line', method:'search_read', params:[domain, fields], kwargs:{ limit: 1200, order: 'date asc' }, activity:'Movimientos periodo...' });
      // Recolectar pickings para leer notas y extraer creador
      const pickingIds = [...new Set(periodLines.map(l=> Array.isArray(l.picking_id)? l.picking_id[0]:null).filter(Boolean))];
      let pickingNotes = new Map();
      if(pickingIds.length){
        try {
          const pData = await executeKw({ model:'stock.picking', method:'read', params:[pickingIds, ['note']], kwargs:{}, activity:'Notas movimientos...' });
          pData.forEach(p=> pickingNotes.set(p.id, p.note||''));
        } catch(_){}
      }
      function extractCreator(note){
        if(!note) return '';
        const m = note.match(/Creado por:\s*([^\n]+)/i);
        if(m){
          // quitar etiquetas html sencillas y entidades comunes
          const raw = m[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').trim();
          return raw.replace(/\s+/g,' ');
        }
        return '';
      }
      const mapped = periodLines.map(l=>{
        const pid = Array.isArray(l.picking_id)? l.picking_id[0]:null;
        const note = pid? pickingNotes.get(pid):'';
        return {
          id:l.id,
          date:l.date,
          qty:l.qty_done,
          uom: Array.isArray(l.product_uom_id)?l.product_uom_id[1]:l.product_uom_id,
          from: Array.isArray(l.location_id)?l.location_id[1]:l.location_id,
          fromId: Array.isArray(l.location_id)?l.location_id[0]:l.location_id,
          to: Array.isArray(l.location_dest_id)?l.location_dest_id[1]:l.location_dest_id,
          toId: Array.isArray(l.location_dest_id)?l.location_dest_id[0]:l.location_dest_id,
          ref: l.reference || (Array.isArray(l.picking_id)? l.picking_id[1]:''),
          creator: extractCreator(note)
        };});
      // Calcular afterStock (stock justo DESPUÉS del último movimiento del periodo)
      let afterStock = currentQty;
      const nowDate = new Date();
      const sameMonth = (nowDate.getMonth()+1) === per.month && nowDate.getFullYear() === per.year;
      if(!sameMonth && selectedLoc !== 'ALL') {
        // Necesitamos restar el efecto de movimientos posteriores a fin de periodo para retroceder
        const endPlus = new Date(end.getTime()+1000);
        const endPlusStr = endPlus.toISOString().slice(0,19).replace('T',' ');
        const nowStr = nowDate.toISOString().slice(0,19).replace('T',' ');
        let afterDomain;
        if(selectedLoc === 'ALL') {
          afterDomain = ['&','&',['product_id','=', productId], ['date','>=', endPlusStr], ['date','<=', nowStr], '|', ['location_id','in', allValidInternalIds], ['location_dest_id','in', allValidInternalIds]];
        } else {
          const locId = Number(selectedLoc);
          afterDomain = ['&','&',['product_id','=', productId], ['date','>=', endPlusStr], ['date','<=', nowStr], '|', ['location_id','=', locId], ['location_dest_id','=', locId]];
        }
        const futureLines = await executeKw({ model:'stock.move.line', method:'search_read', params:[afterDomain, fields], kwargs:{ limit: 2000, order: 'date asc' }, activity:'Movimientos posteriores...' });
        let netFuture = 0;
        if(selectedLoc !== 'ALL'){
          const locId = Number(selectedLoc);
          futureLines.forEach(l=>{
            const fromId = Array.isArray(l.location_id)?l.location_id[0]:l.location_id;
            const toId = Array.isArray(l.location_dest_id)?l.location_dest_id[0]:l.location_dest_id;
            let inbound;
            if(toId === locId) inbound = true; else if(fromId === locId) inbound = false; else inbound = l.qty_done > 0;
            const delta = l.qty_done === 0 ? 0 : (inbound? l.qty_done : -l.qty_done);
            netFuture += delta;
          });
          afterStock = currentQty - netFuture; // rollback
        }
      }
      return { lines: mapped, afterStock, period: per };
    } finally { setMovesLoading(false); }
  },[auth, executeKw, selectedLoc, allValidInternalIds, productPeriods, defaultMonth, defaultYear]);

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-6">
      <h1 className="m-0 font-heading font-extrabold text-lg sm:text-xl tracking-tight flex items-center gap-2 mb-3"><span className="material-symbols-outlined text-[var(--primary-color)]">inventory_2</span>Stock por ubicación</h1>
      <div className="grid gap-3 mb-3 sm:mb-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Ubicación</label>
          <select className="bg-[var(--dark-color)] border border-[var(--border-color)] rounded-[var(--radius)] px-3 py-2.5 text-sm" value={selectedLoc} onChange={e=>setSelectedLoc(e.target.value)} disabled={!locations.length || loading}>
            <option value="">Selecciona ubicación interna</option>
            <option value="ALL">Todos los puntos</option>
            {locations.map(l=> <option key={l.id} value={l.id}>{getLocationLabel(l)}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Buscar producto</label>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2 top-2.5 opacity-60 text-sm">search</span>
            <input ref={inputRef} className="w-full bg-[var(--dark-color)] border border-[var(--border-color)] rounded-[var(--radius)] pl-8 pr-3 py-2.5 text-sm" placeholder="Nombre o código" value={q} onChange={e=>setQ(e.target.value)} disabled={loading || !hasGenerated} />
          </div>
        </div>
      </div>
  {/* filtros mes/año removidos del nivel global */}
      <div className="mb-3 sm:mb-4 flex items-center gap-2">
  <button disabled={!selectedLoc || loading} onClick={fetchStock} className="btn btn-primary btn-sm"><span className="material-symbols-outlined text-sm">play_arrow</span>{hasGenerated? 'Actualizar' : 'Generar'}</button>
        {hasGenerated && !loading && <span className="text-[10px] text-[var(--text-secondary-color)]">{products.length} productos cargados</span>}
      </div>
      {error && <div className="mb-3 sm:mb-4 p-3 rounded-lg border border-[var(--danger-color)] text-[var(--danger-color)] text-sm flex items-center gap-2"><span className="material-symbols-outlined">error</span>{error}</div>}
      {hasGenerated && (
        <div className="text-[9px] sm:text-[10px] uppercase tracking-wide font-medium text-[var(--text-secondary-color)] mb-2 flex items-center gap-1 sm:gap-2"><span className="material-symbols-outlined text-[14px] sm:text-[14px]">list</span>{filtered.length} productos</div>
      )}
  <div className="flex flex-col gap-2">
        {filtered.map(p=> {
          const isOpen = openHistory === p.id;
          const per = productPeriods[p.id] || { month: defaultMonth, year: defaultYear };
          const periodKey = `${per.year}-${String(per.month).padStart(2,'0')}`;
          const cacheEntry = movesCache[p.id]?.[periodKey];
          const baseMovesAsc = cacheEntry? [...cacheEntry.lines].sort((a,b)=> a.date.localeCompare(b.date)) : [];
          const moves = productSortOrder==='asc'? baseMovesAsc : [...baseMovesAsc].reverse();
          // Cálculo de stock antes/después por movimiento (solo si abierto)
          let beforeAfterMap = null;
          if(isOpen && baseMovesAsc.length && cacheEntry){
            beforeAfterMap = new Map();
            let runningAfter = cacheEntry.afterStock; // estado después del último movimiento del periodo
            const baseLoc = Number(selectedLoc);
            const isAll = selectedLoc === 'ALL';
            const desc = [...baseMovesAsc].reverse(); // más reciente primero
            for(const mv of desc){
              // Determinar impacto para la ubicación seleccionada
              let inbound;
              if(isAll){
                // Para 'ALL' la noción de antes/después consolidado no es consistente; omitimos cálculo
                inbound = true; // se tratará como entrada para mantener números crecientes
              } else {
                if(mv.toId === baseLoc) inbound = true; else if(mv.fromId === baseLoc) inbound = false; else inbound = mv.qty > 0;
              }
              const delta = mv.qty === 0 ? 0 : (inbound ? mv.qty : -mv.qty); // efecto real del movimiento
              const after = runningAfter;      // stock tras aplicar este movimiento
              const before = after - delta;    // stock inmediatamente antes del movimiento
              beforeAfterMap.set(mv.id,{before, after});
              runningAfter = before;           // retrocedemos para el siguiente (anterior en el tiempo)
            }
            if(selectedLoc === 'ALL') beforeAfterMap = null;
          }
          return (
            <div key={p.id} className="rounded-lg border border-[var(--border-color)] bg-[var(--card-color)] text-xs sm:text-sm">
              <div className="p-2 sm:p-3 flex items-center gap-2 sm:gap-3">
                <span className="material-symbols-outlined text-[var(--primary-color)] text-base sm:text-[20px]">inventory_2</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate leading-tight">{p.name}</div>
                  <div className="text-[9px] sm:text-[10px] text-[var(--text-secondary-color)] flex items-center gap-1 sm:gap-2">{p.code && <span className="kbd">{p.code}</span>}{p.uom && <span>{p.uom}</span>}</div>
                </div>
                <div className="flex flex-col items-end mr-1 sm:mr-2">
                  <span className="font-heading font-bold text-sm sm:text-base leading-none">{formatQty(p.qty)}</span>
                  <span className="text-[8px] sm:text-[10px] text-[var(--text-secondary-color)]">Stock</span>
                </div>
                {/* Etiqueta de periodo eliminada según solicitud */}
                <button
                  onClick={async ()=>{
                    if(isOpen){ setOpenHistory(null); return; }
                    setOpenHistory(p.id);
                    if(!movesCache[p.id]?.[periodKey]){
                      const data = await fetchMoves(p.id, p.qty);
                      if(data){
                        setMovesCache(prev=>({
                          ...prev,
                          [p.id]: { ...(prev[p.id]||{}), [periodKey]: data }
                        }));
                      }
                    }
                  }}
                  className={`btn btn-sm ${isOpen ? 'btn-primary' : 'btn-outline'} `}
                >
                  <span className="material-symbols-outlined text-sm">history</span>
                  {isOpen? 'Cerrar' : 'Movimientos'}
                </button>
              </div>
              {isOpen && (
                <div className="border-t border-[var(--border-color)] bg-[var(--dark-color)]/40">
                  {(() => { const per = productPeriods[p.id] || {month:defaultMonth, year:defaultYear}; const periodKey = `${per.year}-${String(per.month).padStart(2,'0')}`; return (
                  <div className="px-2 sm:px-3 pt-2 flex flex-wrap items-center gap-2 text-[9px] sm:text-[10px] text-[var(--text-secondary-color)]">
                    <div className="flex items-center gap-1">
                      <span className="uppercase tracking-wide opacity-70">Orden</span>
                      <div className="inline-flex rounded overflow-hidden border border-[var(--border-color)]">
                        <button type="button" onClick={()=>setProductSortOrder('desc')} className={`px-1.5 sm:px-2 py-1 flex items-center gap-1 ${productSortOrder==='desc'? 'bg-[var(--primary-color)] text-white':'bg-[var(--dark-color)]'}`}><span className="material-symbols-outlined text-[12px]">south</span>Reciente</button>
                        <button type="button" onClick={()=>setProductSortOrder('asc')} className={`px-1.5 sm:px-2 py-1 flex items-center gap-1 ${productSortOrder==='asc'? 'bg-[var(--primary-color)] text-white':'bg-[var(--dark-color)]'}`}><span className="material-symbols-outlined text-[12px]">north</span>Antiguo</button>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="uppercase tracking-wide opacity-70">Mes</span>
                      <select className="bg-[var(--dark-color)] border border-[var(--border-color)] rounded px-1.5 py-1 text-[10px]" value={per.month} onChange={async e=> {
                        const month = Number(e.target.value);
                        const newPer = { month, year: per.year };
                        setProductPeriods(prev=>({...prev, [p.id]: newPer}));
                        const newKey = `${newPer.year}-${String(newPer.month).padStart(2,'0')}`;
                        const data = await fetchMoves(p.id, p.qty, newPer);
                        if(data){
                          setMovesCache(prev=>({
                            ...prev,
                            [p.id]: { ...(prev[p.id]||{}), [newKey]: data }
                          }));
                        }
                      }}>
                        {[1,2,3,4,5,6,7,8,9,10,11,12].map(m=> <option key={m} value={m}>{['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][m-1]}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="uppercase tracking-wide opacity-70">Año</span>
                      <select className="bg-[var(--dark-color)] border border-[var(--border-color)] rounded px-1.5 py-1 text-[10px]" value={per.year} onChange={async e=> {
                        const year = Number(e.target.value);
                        const newPer = { month: per.month, year };
                        setProductPeriods(prev=>({...prev, [p.id]: newPer}));
                        const newKey = `${newPer.year}-${String(newPer.month).padStart(2,'0')}`;
                        const data = await fetchMoves(p.id, p.qty, newPer);
                        if(data){
                          setMovesCache(prev=>({
                            ...prev,
                            [p.id]: { ...(prev[p.id]||{}), [newKey]: data }
                          }));
                        }
                      }}>
                        {Array.from({length:5}).map((_,i)=> now.getFullYear()-i).map(y=> <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-1 opacity-70">
                      <span className="material-symbols-outlined text-[12px]">calendar_month</span>
                      <span>{['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'][per.month-1]} {per.year}{!movesCache[p.id]?.[periodKey]?' · …':''}</span>
                    </div>
                  </div> )})()}
                  {movesLoading && !moves.length && (
                    <div className="p-3 sm:p-4 text-[10px] sm:text-xs flex items-center gap-2 text-[var(--text-secondary-color)]"><span className="material-symbols-outlined animate-spin text-[var(--primary-color)]">progress_activity</span>Cargando movimientos…</div>
                  )}
                  {!movesLoading && moves.length===0 && (
                    <div className="p-3 sm:p-4 text-[10px] sm:text-xs text-[var(--text-secondary-color)]">Sin movimientos recientes</div>
                  )}
                  {!!moves.length && (
                    <ul className="max-h-64 sm:max-h-72 overflow-auto divide-y divide-[var(--border-color)] text-[10px] sm:text-xs">
                      {(() => {
                        let lastDay = null;
                        const elements = [];
                        for(const m of moves){
                          const currentDay = formatMovementDay(m.date);
                          if(currentDay !== lastDay){
                            lastDay = currentDay;
                            elements.push(
                              <li key={`day-${currentDay}`} className="sticky top-0 z-10 bg-[var(--dark-color)]/80 backdrop-blur px-2 sm:px-3 py-1 flex items-center gap-2 border-b border-[var(--border-color)]">
                                <span className="material-symbols-outlined text-[12px] opacity-60">calendar_month</span>
                                <span className="text-[10px] sm:text-[11px] font-semibold tracking-wide text-[var(--text-secondary-color)] uppercase">{currentDay}</span>
                              </li>
                            );
                          }
                          elements.push(
                            // movimiento individual original
                            (function(){
                              const qtyFmt = formatQty(m.qty);
                              const dateStr = formatMovementDate(m.date);
                              const uomLabel = (m.uom === 'Units' || m.uom === 'Unit') ? 'Unidades' : m.uom;
                              const ba = beforeAfterMap?.get(m.id);
                              const beforeFmt = ba? formatQty(ba.before): '—';
                              const afterFmt = ba? formatQty(ba.after): '—';
                              let seg = '';
                              if(m.ref && m.ref.includes('/')) {
                                const parts = m.ref.split('/');
                                if(parts.length >=3) seg = parts[1];
                              }
                              const isAll = selectedLoc === 'ALL';
                              let inbound = false;
                              if(isAll){
                                inbound = m.qty > 0;
                              } else {
                                const baseLoc = Number(selectedLoc);
                                if(m.toId === baseLoc) inbound = true; else if(m.fromId === baseLoc) inbound = false; else inbound = m.qty > 0;
                              }
                              let icon; let dirColor;
                              if(m.qty === 0){ icon='arrow_forward'; dirColor='text-amber-500'; }
                              else if(inbound){ icon='arrow_upward'; dirColor='text-[var(--success-color)]'; }
                              else { icon='arrow_downward'; dirColor='text-[var(--danger-color)]'; }
                              const rawFromLoc = locationById.get(m.fromId);
                              const rawToLoc = locationById.get(m.toId);
                              const fromLabel = rawFromLoc ? friendlyLocationName(getLocationLabel(rawFromLoc)) : friendlyLocationName(m.from);
                              const toLabel = rawToLoc ? friendlyLocationName(getLocationLabel(rawToLoc)) : friendlyLocationName(m.to);
                              const manualAdjust = /Virtual Locations\/Inventory adjustment/i.test(m.from) || /Virtual Locations\/Inventory adjustment/i.test(m.to);
                              const isScrap = (/\bSP\//.test(m.ref||'')) && (/Virtual Locations\/Scrap/i.test(m.from) || /Virtual Locations\/Scrap/i.test(m.to));
                              return (
                                <li key={m.id} className="p-2 sm:p-3 flex items-start gap-2 sm:gap-3">
                                  <span className={`material-symbols-outlined text-sm sm:text-base mt-0.5 ${dirColor}`}>{icon}</span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                                      <span className="font-semibold text-[11px] sm:text-[13px]">{qtyFmt}</span>
                                      <span className="text-[var(--text-secondary-color)] text-[10px] sm:text-[11px]">{uomLabel}</span>
                                      {m.ref && !isScrap && (()=>{
                                        let label = m.ref;
                                        if(seg === 'POS') label = 'Venta';
                                        else if(seg === 'INT') label = inbound ? 'entrada' : 'salida';
                                        const badgeClass = seg==='POS'? 'border-[var(--danger-color)] text-[var(--danger-color)]' : seg==='INT'? (inbound? 'border-[var(--success-color)] text-[var(--success-color)]':'border-[var(--danger-color)] text-[var(--danger-color)]') : 'border-[var(--border-color)] text-[var(--text-secondary-color)]';
                                        return <span className={`px-1.5 py-0.5 rounded border text-[8px] sm:text-[10px] tracking-wide capitalize ${badgeClass}`}>{label}</span>;
                                      })()}
                                      {isScrap && (
                                        <span className="px-1.5 py-0.5 rounded border border-fuchsia-500 text-fuchsia-400 bg-fuchsia-500/10 text-[8px] sm:text-[10px] tracking-wide">Salida manual</span>
                                      )}
                                      {manualAdjust && <span className="px-1.5 py-0.5 rounded border border-amber-500 text-amber-500 bg-amber-500/10 text-[8px] sm:text-[10px] tracking-wide">Inventario</span>}
                                    </div>
                                    <div className="text-[9px] sm:text-[10px] mt-0.5 sm:mt-1 text-[var(--text-secondary-color)] truncate">{fromLabel} → {toLabel}</div>
                                    {m.creator && <div className="mt-0.5 text-[8px] sm:text-[10px] text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[12px] opacity-60">person</span>{m.creator}</div>}
                                  </div>
                                  <div className="text-[9px] sm:text-[10px] text-right text-[var(--text-secondary-color)] flex flex-col items-end gap-0 min-w-[96px] sm:min-w-[120px]">
                                    <span className="whitespace-nowrap">{dateStr}</span>
                                    {ba && (
                                      <span className="whitespace-nowrap opacity-70 text-[8px] sm:text-[10px] mt-0.5 sm:mt-0">antes {beforeFmt} → después {afterFmt}</span>
                                    )}
                                  </div>
                                </li>
                              );
                            })()
                          );
                        }
                        return elements;
                      })()}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {hasGenerated && selectedLoc && !loading && filtered.length===0 && (
          <div className="p-3 sm:p-4 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] text-center text-xs sm:text-sm text-[var(--text-secondary-color)]">Sin resultados</div>
        )}
        {!hasGenerated && selectedLoc && !loading && (
          <div className="p-3 sm:p-4 rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--dark-color)] text-center text-xs sm:text-sm text-[var(--text-secondary-color)]">Pulsa Generar para cargar stock</div>
        )}
        {!selectedLoc && (
          <div className="p-3 sm:p-4 rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--dark-color)] text-center text-xs sm:text-sm text-[var(--text-secondary-color)]">Selecciona una ubicación</div>
        )}
      </div>
      {loading && (
        <div className="mt-3 sm:mt-4 text-[10px] sm:text-xs text-[var(--text-secondary-color)] flex items-center gap-2"><span className="material-symbols-outlined animate-spin text-[var(--primary-color)]">progress_activity</span>Cargando…</div>
      )}
    </div>
  );
}
