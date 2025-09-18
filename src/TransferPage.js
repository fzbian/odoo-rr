import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { applyPageMeta } from './lib/meta';
import { useProducts } from './hooks/useProducts';
import { createInternalTransfer } from './lib/transfers';
import { useAuth } from './context/AuthContext';
import './index.css';
import './App.css';
import { sendChatMessage, CHAT_TRASPASOS, bold } from './lib/notify';
import SessionBanner from './components/SessionBanner';
import { parseOdooDate, formatDateTime } from './utils/dates';

function formatTransferDate(iso){
  const d = parseOdooDate(iso);
  if(!d) return iso || '';
  return formatDateTime(d);
}

function formatDMY(iso){
  const d = parseOdooDate(iso);
  if(!d) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatTime12(iso){
  const d = parseOdooDate(iso);
  if(!d) return '';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if(h === 0) h = 12;
  const hh = String(h).padStart(2,'0');
  return `${hh}:${m} ${ampm}`;
}

function useDebounced(value, delay) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

function formatQty(n){
  if(!Number.isFinite(n)) return '—';
  const v=Number(n); const isInt=Math.abs(v-Math.round(v))<1e-9;
  return new Intl.NumberFormat('es-ES',{minimumFractionDigits:0,maximumFractionDigits:isInt?0:2}).format(v);
}

function formatUom(u){
  const s = (u==null? '': String(u)).trim();
  if(!s) return '';
  return /^units?$/i.test(s) ? 'Unidades' : s;
}


// Editor de una línea de traspaso
function LineEditor({ index, line, onChange, onRemove, disabled, filterProducts, productsLoaded, productsLoading }) {
  const [q, setQ] = useState(line.productId ? line.name : '');
  const deb = useDebounced(q, 250);
  const productOptions = useMemo(()=>{
    const term = deb.trim().toLowerCase();
    if(term.length < 2) return [];
    return filterProducts(term).slice(0,15);
  },[deb, filterProducts]);

  // Si se limpia manualmente y había producto seleccionado, permitir re-selección
  useEffect(()=> {
    if(!line.productId && q!=='' && q===line.name){
      // no-op
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.productId]);

  function pickProduct(p){
    onChange(index, { productId: p.id, name: p.name, uomId: Array.isArray(p.uom_id)? p.uom_id[0]:p.uom_id || null, stock: undefined, destStock: undefined, stockLoading: true, quantity: line.quantity || 1 });
    setQ(p.name);
  }

  // Permitir edición libre de cantidad usando un buffer de texto
  function handleQtyChange(raw){
    if(raw === ''){
      onChange(index, { qtyInput: '' });
      return;
    }
    const norm = String(raw).replace(',', '.');
    const n = parseFloat(norm);
    if(!Number.isFinite(n)){
      // Ignorar caracteres no numéricos adicionales
      return;
    }
    if(n < 0){
      // No permitir negativos
      return;
    }
    onChange(index, { quantity: n, qtyInput: raw });
  }

  function handleQtyBlur(){
    if(line.qtyInput === '' || !Number.isFinite(line.quantity) || line.quantity <= 0){
      // Restaurar a 1 para evitar cantidad inválida
      onChange(index, { quantity: 1, qtyInput: undefined });
      return;
    }
    onChange(index, { qtyInput: undefined });
  }

  return (
    <div className="p-3 rounded-[var(--radius)] border border-[var(--border-color)] bg-[var(--dark-color)] flex flex-col gap-2 relative">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <label className="text-[9px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Producto</label>
          <input
            className="form-field mt-1 pr-8"
            placeholder="Buscar (mín 2)"
            value={q}
            disabled={disabled}
            onChange={e=> { setQ(e.target.value); if(line.productId) onChange(index,{ productId:null, name:'', uomId:null, stock:undefined, destStock:undefined }); }}
          />
          {line.productId && <span className="absolute right-4 top-5 text-[10px] opacity-60">ID {line.productId}</span>}
          {productOptions.length>0 && !line.productId && q.trim().length>=2 && (
            <div className="absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-auto bg-[var(--card-color)] border border-[var(--border-color)] rounded shadow-soft">
              {productOptions.map(p=> (
                <button key={p.id} type="button" className="w-full text-left px-3 py-2 text-[10px] flex items-center gap-2 hover:bg-[var(--dark-color)]" onClick={()=> pickProduct(p)}>
                  <span className="material-symbols-outlined text-[var(--primary-color)] text-sm">inventory_2</span>
                  <span className="truncate flex-1 font-semibold">{p.name}</span>
                  {p.default_code && <span className="kbd">{p.default_code}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="w-24">
          <label className="text-[9px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Cant.</label>
          <input
            type="number"
            min={0}
            step={0.01}
            className="form-field mt-1"
            disabled={disabled || !line.productId}
            value={line.qtyInput !== undefined ? line.qtyInput : (Number.isFinite(line.quantity) ? String(line.quantity) : '')}
            onChange={e=> handleQtyChange(e.target.value)}
            onBlur={handleQtyBlur}
            inputMode="decimal"
          />
        </div>
        <div className="pt-5">
          <button type="button" className="btn-icon btn-danger" disabled={disabled} onClick={()=> onRemove(index)} title="Eliminar línea">
            <span className="material-symbols-outlined text-sm">delete</span>
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-[10px]">
        <div className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[var(--primary-color)] text-xs">warehouse</span>
          <span className="opacity-70">Origen:</span>
          {line.stockLoading && <span className="material-symbols-outlined animate-spin text-[var(--primary-color)] text-xs">progress_activity</span>}
          {!line.stockLoading && <span className="font-semibold">{formatQty(line.stock)}</span>}
        </div>
        <div className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[var(--success-color)] text-xs">inventory</span>
          <span className="opacity-70">Destino:</span>
          {line.stockLoading && <span className="material-symbols-outlined animate-spin text-[var(--primary-color)] text-xs">progress_activity</span>}
          {!line.stockLoading && <span className="font-semibold">{formatQty(line.destStock)}</span>}
        </div>
      </div>
      {!productsLoaded && productsLoading && (
        <div className="text-[9px] text-[var(--text-secondary-color)] flex items-center gap-1">
          <span className="material-symbols-outlined animate-spin text-[var(--primary-color)] text-xs">progress_activity</span>Cargando catálogo…
        </div>
      )}
      {line.productId && Number.isFinite(line.stock) && line.quantity > line.stock && (
        <div className="text-[10px] text-[var(--danger-color)] font-semibold">Cantidad excede stock disponible</div>
      )}
    </div>
  );
}

export default function TransferPage() {
  useEffect(()=> { applyPageMeta({ title: 'Traspasos', favicon: '/logo192.png' }); },[]);
  const { auth, executeKwSilent } = useAuth();
  const { filter: filterProducts, loaded: productsLoaded, loading: productsLoading } = useProducts();
  const [activeTab, setActiveTab] = useState('view'); // 'view' | 'create'
  // Filtros aplicados (afectan búsqueda movimientos)
  const [mvOrigin, setMvOrigin] = useState('');
  const [mvDest, setMvDest] = useState('');
  const [mvProductId, setMvProductId] = useState(null);
  const [mvLimit, setMvLimit] = useState(50);
  const [mvFrom, setMvFrom] = useState('');
  const [mvTo, setMvTo] = useState('');
  // Búsqueda producto movimientos (autocomplete)
  const [mvProductQ, setMvProductQ] = useState('');
  const mvProductQDeb = useDebounced(mvProductQ, 300);
  const [showMvFilters, setShowMvFilters] = useState(false);
  const [movementLines, setMovementLines] = useState([]);
  const [movementPicks, setMovementPicks] = useState([]); // agrupados por picking
  const [expandedPick, setExpandedPick] = useState(null); // id picking expandido
  const [loadingMovements, setLoadingMovements] = useState(false);
  const [locations, setLocations] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [origin, setOrigin] = useState('');
  const [dest, setDest] = useState('');
  function newLine(){
    return { uid: Math.random().toString(36).slice(2), productId: null, name: '', uomId: null, quantity: 1, stock: undefined, destStock: undefined, stockLoading: false };
  }
  const [lines, setLines] = useState([newLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const resultRef = useRef(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [lineErrors, setLineErrors] = useState([]); // array de mensajes
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // confirmStage: null | 'review' | 'processing'
  const [confirmStage, setConfirmStage] = useState(null);
  const [progressStep, setProgressStep] = useState(null); // paso actual dentro del procesamiento
  // Clave para dependencias de productos (evita expresión compleja en useEffect)
  const productIdsKey = useMemo(() => lines.map(l => l.productId || '').join(','), [lines]);

  // Construye mapas para resolver el nombre del almacén correspondiente a una ubicación
  const locationById = useMemo(() => {
    const m = new Map();
    locations.forEach(l => m.set(l.id, l));
    return m;
  }, [locations]);

  const lotStockMap = useMemo(() => {
    const m = new Map(); // location_id -> warehouse.name
    warehouses.forEach(w => {
      const locId = Array.isArray(w.lot_stock_id) ? w.lot_stock_id[0] : w.lot_stock_id;
      if (locId) m.set(locId, w.name);
    });
    return m;
  }, [warehouses]);

  const viewLocMap = useMemo(() => {
    const m = new Map(); // view_location_id -> warehouse.name
    warehouses.forEach(w => {
      const vId = Array.isArray(w.view_location_id) ? w.view_location_id[0] : w.view_location_id;
      if (vId) m.set(vId, w.name);
    });
    return m;
  }, [warehouses]);

  function resolveWarehouseName(loc) {
    if (!loc) return null;
    // Direct match con lot_stock_id
    const direct = lotStockMap.get(loc.id);
    if (direct) return direct;
    // Recorrer padres hasta encontrar un lot_stock_id o view_location_id
    const visited = new Set();
    let cur = loc;
    for (let i = 0; i < 20 && cur && !visited.has(cur.id); i++) {
      visited.add(cur.id);
      const curId = cur.id;
      if (lotStockMap.has(curId)) return lotStockMap.get(curId);
      if (viewLocMap.has(curId)) return viewLocMap.get(curId);
      const parentId = Array.isArray(cur.location_id) ? cur.location_id[0] : cur.location_id;
      if (!parentId) break;
      cur = locationById.get(parentId);
    }
    return null;
  }

  function getLocationLabel(loc) {
    const nm = (loc?.name || '').trim();
    const whName = resolveWarehouseName(loc);
    // Si la ubicación es el Stock principal del almacén, mostrar solo el nombre del punto
    const isLotStock = loc && lotStockMap.has(loc.id);
    if (whName && isLotStock) return whName;
    if (whName) return `${whName} · ${nm || loc?.id}`;
    return nm || String(loc?.id || '');
  }

  // Eliminada búsqueda remota por tecla: se usa hook de productos precargados


  const fetchLocations = useCallback(async () => {
    if (!auth) return;
    setLoadError('');
    setInitialLoading(true);
    let cancelled = false;
    try {
      const domain = [["usage","=","internal"]];
      const fields = ["name", "complete_name", "location_id"];
      const [locs, whs] = await Promise.all([
        executeKwSilent({ model: 'stock.location', method: 'search_read', params: [domain, fields], kwargs: { limit: 500 } }),
        executeKwSilent({ model: 'stock.warehouse', method: 'search_read', params: [[], ["name","lot_stock_id","view_location_id"]], kwargs: { limit: 200 } }),
      ]);
      if (cancelled) return;
      setLocations(locs);
      setWarehouses(whs);
    } catch (e) {
      if (!cancelled) setLoadError(e.message);
    } finally {
      if (!cancelled) setInitialLoading(false);
    }
    return () => { cancelled = true; };
  }, [auth, executeKwSilent]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  const valid = useMemo(() => {
    return origin && dest && origin !== dest && lines.length > 0 && lines.every(l => l.productId && l.quantity > 0 && Number.isFinite(l.stock) && l.quantity <= l.stock);
  }, [origin, dest, lines]);
  const sameLocation = origin && dest && origin === dest;

  const addLine = () => setLines(ls => [...ls, newLine()]);
  const updateLine = (i, patch) => setLines(ls => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const removeLine = (i) => setLines(ls => ls.filter((_, idx) => idx !== i));

  function validateLinesForSubmit() {
    const errs = [];
    const seen = new Set();
    lines.forEach((l, idx) => {
      if (!l.productId) errs.push(`Línea ${idx+1}: falta producto`);
      if (l.quantity <= 0) errs.push(`Línea ${idx+1}: cantidad debe ser > 0`);
      if (Number.isFinite(l.stock) && l.quantity > l.stock) errs.push(`Línea ${idx+1}: cantidad supera stock (${l.stock})`);
      const key = l.productId;
      if (key && seen.has(key)) errs.push(`Producto repetido en línea ${idx+1}`); else if(key) seen.add(key);
    });
    if (!origin) errs.push('Falta Origen');
    if (!dest) errs.push('Falta Destino');
    if (origin && dest && origin === dest) errs.push('Origen y Destino no pueden ser iguales');
    return errs;
  }

  async function submit() {
    setSubmitting(true);
    setError('');
    setResult(null);
    setLineErrors([]);
    const errs = validateLinesForSubmit();
    if (errs.length) {
      setLineErrors(errs);
      setSubmitting(false);
      return;
    }
    // Mostrar overlay de revisión antes de ejecutar
    setConfirmStage('review');
    setSubmitting(false);
  }

  async function confirmTransfer() {
    if (confirmStage !== 'processing') setConfirmStage('processing');
    setProgressStep('findType');
    setSubmitting(true);
    setError('');
    try {
      const originLoc = locations.find(l => String(l.id) === String(origin));
      const destLoc = locations.find(l => String(l.id) === String(dest));
  const res = await createInternalTransfer(executeKwSilent, {
        originLocationId: Number(origin),
        destLocationId: Number(dest),
        lines: lines.map(l => ({ productId: l.productId, quantity: l.quantity, name: l.name })),
        originLabel: originLoc?.name,
        destLabel: destLoc?.name,
        onProgress: (k) => setProgressStep(k),
        note: auth?.name || ''
      });
      // Enriquecer resultado con resumen de líneas (antes / después)
      const enriched = {
        ...res,
        originLabel: originLoc ? getLocationLabel(originLoc) : origin,
        destLabel: destLoc ? getLocationLabel(destLoc) : dest,
        lines: lines.filter(l=>l.productId).map(l=>({
          productId: l.productId,
          name: l.name,
            quantity: l.quantity,
            originBefore: l.stock,
            destBefore: l.destStock,
            originAfter: Number.isFinite(l.stock)? l.stock - l.quantity : null,
            destAfter: (Number.isFinite(l.destStock)? l.destStock:0) + l.quantity
        }))
      };
  setResult(enriched);
      // Notificación WhatsApp (no bloquear flujo)
      try {
        const linesTxt = enriched.lines.map(l=> `- ${l.name}: ${formatQty(l.quantity)}`).join('\n');
        const msg = [
          '🚚 *Traspaso interno creado*',
          `${bold('Origen')}: ${enriched.originLabel}`,
          `${bold('Destino')}: ${enriched.destLabel}`,
          `${bold('Hecho por')}: ${auth?.name || 'Desconocido'}`,
          '',
          bold('Productos'),
          linesTxt
        ].join('\n');
        // Enviar notificación al chat de traspasos (no bloqueante)
        sendChatMessage({ chat: CHAT_TRASPASOS, message: msg });
      } catch(_){ /* ignorar */ }
      if (res.warning) setInfo(res.warning);
      // Reset de selección y líneas para nuevo traspaso
      setOrigin('');
      setDest('');
  setLines([newLine()]);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
      setConfirmStage(null);
    }
  }

  // Buscar movimiento líneas según filtros
  const fetchMovementLines = useCallback(async ()=> {
    if(!auth) return;
    setLoadingMovements(true);
    try {
      // Dominio dinámico
      const domain = [['picking_id.picking_type_id.code','=','internal']];
      if(mvOrigin) domain.push(['location_id','=', Number(mvOrigin)]);
      if(mvDest) domain.push(['location_dest_id','=', Number(mvDest)]);
      if(mvProductId) domain.push(['product_id','=', mvProductId]);
      if(mvFrom){
        // Fecha desde (inicio día)
        domain.push(['date','>=', mvFrom + ' 00:00:00']);
      }
      if(mvTo){
        // Fecha hasta (fin día)
        domain.push(['date','<=', mvTo + ' 23:59:59']);
      }
      const fields = ['date','qty_done','product_uom_id','location_id','location_dest_id','reference','picking_id','product_id'];
      const lines = await executeKwSilent({ model:'stock.move.line', method:'search_read', params:[domain, fields], kwargs:{ limit: mvLimit, order:'date desc' } });
      // Leer notas de los pickings para extraer creador
      const pickingIds=[...new Set(lines.map(l=> Array.isArray(l.picking_id)? l.picking_id[0]:null).filter(Boolean))];
      let pickingNotes=new Map();
      if(pickingIds.length){
        try {
          const pData = await executeKwSilent({ model:'stock.picking', method:'read', params:[pickingIds, ['note']], kwargs:{} });
          pData.forEach(p=> pickingNotes.set(p.id, p.note||''));
        } catch(_){}
      }
      function extractCreator(note){
        if(!note) return '';
        const m = note.match(/Creado por:\s*([^\n]+)/i);
        if(m){
          const raw = m[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').trim();
          return raw.replace(/\s+/g,' ');
        }
        return '';
      }
      const mapped = lines.map(l=>{
        const pid = Array.isArray(l.picking_id)? l.picking_id[0]:null;
        const note = pid? pickingNotes.get(pid):'';
        return {
          id:l.id,
          date:l.date,
          qty:l.qty_done,
          uom:Array.isArray(l.product_uom_id)? l.product_uom_id[1]:l.product_uom_id,
          from:Array.isArray(l.location_id)? l.location_id[1]:l.location_id,
          fromId:Array.isArray(l.location_id)? l.location_id[0]:l.location_id,
          to:Array.isArray(l.location_dest_id)? l.location_dest_id[1]:l.location_dest_id,
          toId:Array.isArray(l.location_dest_id)? l.location_dest_id[0]:l.location_dest_id,
          ref:l.reference || (Array.isArray(l.picking_id)? l.picking_id[1]:''),
          productId:Array.isArray(l.product_id)? l.product_id[0]:l.product_id,
          productName:Array.isArray(l.product_id)? l.product_id[1]:'',
          creator: extractCreator(note)
        };
      });
      const isExcludedLocation = (s)=> {
        const t = String(s||'').trim().toLowerCase();
        if(!t) return false;
        // Excluir si menciona el nombre de almacén 'Prueba' o el código/ruta 'PRB/Stock'
        return t.includes('prueba') || t.startsWith('prb/') || t === 'prb' || t === 'prb/stock' || t.endsWith('/prueba');
      };
      const mappedFiltered = mapped.filter(l=> !isExcludedLocation(l.from) && !isExcludedLocation(l.to));
      setMovementLines(mappedFiltered);

      // Construir agrupación por picking. Si se filtró por producto, traer todas las líneas de esos pickings.
      let fullLines = lines;
      if (mvProductId && pickingIds.length) {
        try {
          const all = await executeKwSilent({ model:'stock.move.line', method:'search_read', params:[[ ['picking_id','in', pickingIds] ], fields], kwargs:{ limit: 5000 } });
          all.sort((a,b)=> (a.date>b.date? -1: a.date<b.date? 1: 0));
          fullLines = all;
        } catch(_) { /* mantener lines si falla */ }
      }
      const baseLines = (mvProductId ? fullLines : lines);
      const mappedFull = baseLines.map(l=>{
        const pid = Array.isArray(l.picking_id)? l.picking_id[0]:null;
        const note = pid? pickingNotes.get(pid):'';
        return {
          id:l.id,
          date:l.date,
          qty:l.qty_done,
          uom:Array.isArray(l.product_uom_id)? l.product_uom_id[1]:l.product_uom_id,
          from:Array.isArray(l.location_id)? l.location_id[1]:l.location_id,
          fromId:Array.isArray(l.location_id)? l.location_id[0]:l.location_id,
          to:Array.isArray(l.location_dest_id)? l.location_dest_id[1]:l.location_dest_id,
          toId:Array.isArray(l.location_dest_id)? l.location_dest_id[0]:l.location_dest_id,
          ref:l.reference || (Array.isArray(l.picking_id)? l.picking_id[1]:''),
          productId:Array.isArray(l.product_id)? l.product_id[0]:l.product_id,
          productName:Array.isArray(l.product_id)? l.product_id[1]:'',
          pickId: Array.isArray(l.picking_id)? l.picking_id[0]:null,
          creator: extractCreator(note)
        };
      });
  const mappedFullFiltered = mappedFull.filter(ml => !isExcludedLocation(ml.from) && !isExcludedLocation(ml.to));
      const pmap = new Map();
      for (const ml of mappedFullFiltered) {
        const key = ml.pickId || `ref:${ml.ref}:${ml.date?.slice(0,10)||''}`;
        if(!pmap.has(key)){
          pmap.set(key, {
            id: key,
            pickId: ml.pickId,
            ref: ml.ref,
            date: ml.date,
            fromId: ml.fromId,
            from: ml.from,
            toId: ml.toId,
            to: ml.to,
            creator: ml.creator,
            items: []
          });
        }
        const p = pmap.get(key);
        if(ml.date && (!p.date || ml.date > p.date)) p.date = ml.date;
        p.items.push(ml);
      }
      const picksArr = Array.from(pmap.values()).filter(g => g.items.length > 0).sort((a,b)=> (a.date>b.date? -1: a.date<b.date? 1: 0));
      setMovementPicks(picksArr);
      setExpandedPick(null);
    } catch(e) { /* ignore */ }
    finally { setLoadingMovements(false); }
  },[auth, executeKwSilent, mvOrigin, mvDest, mvProductId, mvLimit, mvFrom, mvTo]);

  // Autocomplete producto en visor (usa productos locales)
  const mvProductOptions = useMemo(()=> {
    const term = mvProductQDeb.trim().toLowerCase();
    if(term.length < 2) return [];
    return filterProducts(term).slice(0,20);
  },[mvProductQDeb, filterProducts]);
  useEffect(()=>{ if(activeTab==='view' && movementLines.length===0) fetchMovementLines(); },[activeTab, fetchMovementLines, movementLines.length]);

  const activeFilterCount = useMemo(()=> {
    let c=0; if(mvOrigin) c++; if(mvDest) c++; if(mvProductId) c++; if(mvFrom) c++; if(mvTo) c++; return c;
  },[mvOrigin,mvDest,mvProductId,mvFrom,mvTo]);

  // Refresco batch de stock origen y destino
  const refreshStocks = useCallback(async () => {
    if (!origin && !dest) return;
    const productIds = lines.filter(l => l.productId).map(l => l.productId);
    if (!productIds.length) return;
    setLines(ls => ls.map(l => l.productId ? { ...l, stockLoading: true, stock: undefined, destStock: undefined } : l));
    try {
      let originMap = new Map();
      let destMap = new Map();
      if (origin) {
        const contextO = { location: Number(origin), compute_child: true };
        const resO = await executeKwSilent({ model: 'product.product', method: 'read', params: [productIds, ['qty_available']], kwargs: { context: contextO } });
        originMap = new Map(resO.map(r => [r.id, r.qty_available]));
      }
      if (dest) {
        const contextD = { location: Number(dest), compute_child: true };
        const resD = await executeKwSilent({ model: 'product.product', method: 'read', params: [productIds, ['qty_available']], kwargs: { context: contextD } });
        destMap = new Map(resD.map(r => [r.id, r.qty_available]));
      }
      setLines(ls => ls.map(l => l.productId ? {
        ...l,
        stock: Number((originMap.get(l.productId) || 0).toFixed(2)),
        destStock: Number((destMap.get(l.productId) || 0).toFixed(2)),
        stockLoading: false
      } : l));
    } catch (e) {
      setInfo(`Error obteniendo stock: ${e.message}`);
      setLines(ls => ls.map(l => l.productId ? { ...l, stockLoading: false } : l));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, dest, productIdsKey, executeKwSilent]);

  useEffect(() => { refreshStocks(); }, [refreshStocks]);

  // Enfocar card de resultado cuando aparece
  useEffect(() => {
    if (result && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // pequeño foco para accesibilidad
      try { resultRef.current.focus({ preventScroll: true }); } catch {}
    }
  }, [result]);

  return (
    <div className="container mx-auto max-w-6xl px-3 sm:px-4 pb-10">
      <SessionBanner />
      {confirmStage === 'review' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur" onClick={()=> setConfirmStage(null)} />
          <div className="relative w-full max-w-2xl rounded-2xl border border-[var(--border-color)] bg-[var(--card-color)] shadow-2xl p-6 sm:p-7 flex flex-col gap-5">
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <h2 className="m-0 font-heading font-extrabold text-lg tracking-tight flex items-center gap-2"><span className="material-symbols-outlined text-[var(--primary-color)]">playlist_add_check</span>Confirmar traspaso</h2>
                <p className="m-0 mt-1 text-[10px] text-[var(--text-secondary-color)]">Revisa los datos antes de ejecutar. Esta acción moverá stock entre ubicaciones.</p>
              </div>
              <button onClick={()=> setConfirmStage(null)} className="p-2 rounded-lg border border-[var(--border-color)] hover:bg-[var(--dark-color)]"><span className="material-symbols-outlined text-sm">close</span></button>
            </div>
            <div className="grid sm:grid-cols-2 gap-4 text-[11px]">
              <div className="p-3 rounded-xl bg-[var(--dark-color)] border border-[var(--border-color)]">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-base text-[var(--primary-color)]">store</span>Origen</div>
                <div className="mt-1 font-semibold text-xs break-words">{getLocationLabel(locations.find(l=> String(l.id)===String(origin))||{})||'—'}</div>
              </div>
              <div className="p-3 rounded-xl bg-[var(--dark-color)] border border-[var(--border-color)]">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-base text-[var(--success-color)]">inventory</span>Destino</div>
                <div className="mt-1 font-semibold text-xs break-words">{getLocationLabel(locations.find(l=> String(l.id)===String(dest))||{})||'—'}</div>
              </div>
            </div>
            <div>
              <h4 className="m-0 mb-2 font-heading font-bold text-xs uppercase tracking-wider text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">deployed_code</span>Productos</h4>
              <div className="max-h-72 overflow-auto pr-1 flex flex-col gap-2">
                {lines.filter(l=>l.productId).map((l,i)=>{
                  const originAfter = Number.isFinite(l.stock)? l.stock - l.quantity : null;
                  const destAfter = (Number.isFinite(l.destStock)? l.destStock:0) + l.quantity;
                  return (
                    <div key={l.uid} className="p-3 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] flex flex-col gap-1 text-[11px]">
                      <div className="flex items-center gap-2"><span className="material-symbols-outlined text-[var(--primary-color)] text-sm">inventory_2</span><span className="font-semibold leading-snug break-words flex-1">{l.name}</span><span className="px-2 py-0.5 rounded-full bg-[var(--primary-color)]/15 text-[var(--primary-color)] text-[10px] font-semibold">{formatQty(l.quantity)}</span></div>
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4 font-mono text-[10px] text-[var(--text-secondary-color)]">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="uppercase text-[8px] tracking-wide opacity-70 flex-shrink-0">Origen</span>
                          {Number.isFinite(l.stock)? <span className="whitespace-nowrap"><span className="text-[var(--text-color)] font-semibold">{formatQty(l.stock)}</span> → <span className="text-[var(--danger-color)] font-semibold">{formatQty(originAfter)}</span></span> : '—'}
                        </div>
                        <span className="material-symbols-outlined mx-auto text-[var(--text-secondary-color)] opacity-60 text-sm">sync_alt</span>
                        <div className="flex items-center gap-1 justify-end min-w-0">
                          <span className="uppercase text-[8px] tracking-wide opacity-70 flex-shrink-0">Destino</span>
                          {Number.isFinite(l.destStock)? <span className="whitespace-nowrap text-right"><span className="text-[var(--text-color)] font-semibold">{formatQty(l.destStock)}</span> → <span className="text-[var(--success-color)] font-semibold">{formatQty(destAfter)}</span></span> : '—'}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {lines.filter(l=>l.productId).length===0 && <div className="text-[10px] text-[var(--text-secondary-color)]">Sin productos válidos.</div>}
              </div>
            </div>
            {auth?.name && <div className="text-[10px] text-[var(--text-secondary-color)]"><span className="font-semibold">Creado por: </span>{auth.name}</div>}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
              <button onClick={()=> setConfirmStage(null)} className="px-4 py-2 rounded-[var(--radius)] border border-[var(--border-color)] bg-[var(--dark-color)] text-xs font-semibold flex items-center gap-1"><span className="material-symbols-outlined text-sm">arrow_back</span>Editar</button>
              <button onClick={()=> { setConfirmStage('processing'); setTimeout(()=>confirmTransfer(),0); }} className="px-5 py-2 rounded-[var(--radius)] bg-[var(--primary-color)] text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-50"><span className="material-symbols-outlined text-sm">check_circle</span>Confirmar y ejecutar</button>
            </div>
          </div>
        </div>
      )}
  <section className="flex items-center gap-5 p-6 border border-[var(--border-color)] rounded-2xl shadow-soft mb-4"
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }}>
        <img src="/logo192.png" alt="Logo" className="h-14 w-auto" />
        <div>
          <h1 className="m-0 font-heading font-extrabold text-2xl tracking-tight">Traspasos entre locales</h1>
          <p className="m-0 mt-1 text-[var(--text-secondary-color)]">Es indispensable que apenas se haga el traspaso físico se realice en el sistema</p>
        </div>
      </section>

      {/* Tabs */}
      <div className="mb-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-2 w-full">
  <button className={`btn btn-lg w-full sm:w-auto ${activeTab==='view'?'btn-primary':'btn-outline'}`} onClick={()=> setActiveTab('view')}>Ver movimientos</button>
        <button className={`btn btn-lg w-full sm:w-auto ${activeTab==='create'?'btn-primary':'btn-outline'}`} onClick={()=> setActiveTab('create')}>Crear traspaso</button>
      </div>

      {/* Resultado reciente arriba */}
      {result && !error && (
        <div ref={resultRef} tabIndex={-1} className="outline-none mb-8 bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-6 sm:p-7 shadow-soft relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none opacity-[0.04] bg-[radial-gradient(circle_at_35%_25%,var(--primary-color),transparent_65%)]" />
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex flex-col gap-1">
                <h2 className="m-0 font-heading font-extrabold text-lg tracking-tight flex items-center gap-2">Traspaso creado
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[10px] font-medium text-[var(--text-secondary-color)]">OK</span>
                </h2>
                <div className="flex flex-wrap gap-3 text-[10px] text-[var(--text-secondary-color)]">
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-[14px] opacity-70">receipt_long</span>Picking <span className="kbd">{result.pickingName}</span></span>
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-[14px] opacity-70">tag</span>ID <span className="kbd">{result.pickingId}</span></span>
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-[14px] opacity-70">flag</span>Estado <span className="kbd">{result.state}</span></span>
        </div>
      </div>
            <div className="grid grid-cols-2 gap-3 w-full sm:w-auto">
              <div className="p-3 rounded-xl bg-[var(--dark-color)] border border-[var(--border-color)] flex flex-col gap-1 min-w-[140px]">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-base text-[var(--primary-color)]">store</span>Origen</div>
                <div className="text-xs font-semibold break-words">{result.originLabel}</div>
              </div>
              <div className="p-3 rounded-xl bg-[var(--dark-color)] border border-[var(--border-color)] flex flex-col gap-1 min-w-[140px]">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-base text-[var(--success-color)]">inventory</span>Destino</div>
                <div className="text-xs font-semibold break-words">{result.destLabel}</div>
              </div>
            </div>
          </div>
          {/* Líneas */}
          <div className="mt-6">
            <h4 className="m-0 mb-3 font-heading font-bold text-xs uppercase tracking-wider text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">move_group</span>Líneas movidas</h4>
            <div className="flex flex-col gap-3">
              {result.lines?.map((ln,i)=>{
                const originDelta = Number.isFinite(ln.originBefore) && Number.isFinite(ln.originAfter)? ln.originAfter - ln.originBefore : null;
                const destDelta = Number.isFinite(ln.destBefore) && Number.isFinite(ln.destAfter)? ln.destAfter - ln.destBefore : null;
                return (
                  <div key={i} className="group relative rounded-xl border border-[var(--border-color)] bg-[var(--dark-color)] p-4 overflow-hidden">
                    <div className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition bg-[radial-gradient(circle_at_85%_20%,var(--primary-color)/0.15,transparent_70%)]" />
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="material-symbols-outlined text-[var(--primary-color)]">deployed_code</span>
                        <span className="font-semibold text-sm break-words leading-snug line-clamp-2">{ln.name}</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-[13px] opacity-70">swap_horiz</span><span className="kbd">{formatQty(ln.quantity)}</span></div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] sm:text-xs">
                      <div className="rounded-lg border border-[var(--border-color)] p-3 flex flex-col gap-1 bg-black/10">
                        <div className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-[var(--text-secondary-color)] uppercase"><span className="material-symbols-outlined text-base text-[var(--primary-color)]">store</span>Origen</div>
                        <div className="flex items-center gap-2 font-mono text-[12px]">
                          <span className="text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[12px] opacity-60">history</span>{formatQty(ln.originBefore)}</span>
                          <span className="material-symbols-outlined text-[14px] opacity-60">trending_flat</span>
                          <span className={originDelta<0? 'text-[var(--danger-color)] font-semibold':'font-semibold'}>{formatQty(ln.originAfter)}</span>
                        </div>
                        {originDelta!==0 && originDelta!==null && (
                          <div className="text-[10px] flex items-center gap-1 text-[var(--danger-color)]"><span className="material-symbols-outlined text-[12px]">south</span>-{formatQty(Math.abs(originDelta))}</div>
                        )}
                      </div>
                      <div className="rounded-lg border border-[var(--border-color)] p-3 flex flex-col gap-1 bg-black/10">
                        <div className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-[var(--text-secondary-color)] uppercase"><span className="material-symbols-outlined text-base text-[var(--success-color)]">inventory</span>Destino</div>
                        <div className="flex items-center gap-2 font-mono text-[12px]">
                          <span className="text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[12px] opacity-60">history</span>{formatQty(ln.destBefore)}</span>
                          <span className="material-symbols-outlined text-[14px] opacity-60">trending_flat</span>
                          <span className={destDelta>0? 'text-[var(--success-color)] font-semibold':'font-semibold'}>{formatQty(ln.destAfter)}</span>
                        </div>
                        {destDelta!==0 && destDelta!==null && (
                          <div className="text-[10px] flex items-center gap-1 text-[var(--success-color)]"><span className="material-symbols-outlined text-[12px]">north</span>+{formatQty(Math.abs(destDelta))}</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {result.warning && <div className="mt-5 p-4 rounded-xl border border-[var(--warning-color)] text-[var(--warning-color)] text-xs flex items-center gap-2 bg-[var(--warning-color)]/5"><span className="material-symbols-outlined">warning</span>{result.warning}</div>}
        </div>
      )}

  {activeTab==='create' && (
  <div className="grid gap-4 md:grid-cols-2">
        <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-4 shadow-soft">
          <h2 className="m-0 mb-2 font-heading font-bold text-sm uppercase tracking-wider text-[var(--text-secondary-color)]">Origen y Destino</h2>
          <div className="grid gap-3">
            <div>
              <label className="text-xs text-[var(--text-secondary-color)]">Origen</label>
              <select className={`form-field ${sameLocation ? 'error' : ''}`}
                disabled={!locations.length}
                value={origin} onChange={e => setOrigin(e.target.value)}>
                <option value="">Selecciona ubicación</option>
                {locations.map(l => (
                  <option key={l.id} value={l.id}>{getLocationLabel(l)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--text-secondary-color)]">Destino</label>
              <select className={`form-field ${sameLocation ? 'error' : ''}`}
                disabled={!locations.length}
                value={dest} onChange={e => setDest(e.target.value)}>
                <option value="">Selecciona ubicación</option>
                {locations.map(l => (
                  <option key={l.id} value={l.id}>{getLocationLabel(l)}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-4 shadow-soft">
          <h2 className="m-0 mb-2 font-heading font-bold text-sm uppercase tracking-wider text-[var(--text-secondary-color)]">Líneas</h2>
          {sameLocation && (
            <div className="mb-3 p-3 rounded-[var(--radius)] border border-[var(--danger-color)] bg-[var(--dark-color)] text-[var(--danger-color)] font-semibold">
              El Origen y el Destino no pueden ser iguales. Cambia uno de ellos.
            </div>
          )}
          <div className="grid gap-2">
      {lines.map((line, idx) => (
        <LineEditor
          key={line.uid || idx}
          index={idx}
          line={line}
          onChange={(i, patch) => updateLine(i, patch)}
          onRemove={removeLine}
          disabled={!origin || !dest}
          filterProducts={filterProducts}
          productsLoaded={productsLoaded}
          productsLoading={productsLoading}
        />
      ))}
          </div>
          <div className="mt-3 flex flex-col gap-2 md:flex-row md:justify-between">
            <button className="w-full md:w-auto btn btn-outline"
              disabled={!origin || !dest}
              onClick={addLine}><span className="material-symbols-outlined text-sm">add</span>Agregar línea</button>
            <button className="w-full md:w-auto btn btn-primary"
              disabled={!valid || submitting} onClick={submit}>
              <span className="material-symbols-outlined text-sm">swap_horiz</span>
              {submitting ? 'Procesando...' : 'Crear traspaso'}
            </button>
          </div>
        </div>
      </div>)}

      {activeTab==='view' && (
        <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-4 sm:p-5 shadow-soft">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="m-0 font-heading font-bold text-sm uppercase tracking-wider text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[16px] opacity-70">filter_list</span>Movimientos</h2>
            <div className="flex items-center gap-2">
              {activeFilterCount>0 && !showMvFilters && (
                <div className="flex flex-wrap gap-1">
                  {mvOrigin && <span className="px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[9px]">Origen</span>}
                  {mvDest && <span className="px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[9px]">Destino</span>}
                  {mvProductId && <span className="px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[9px]">Producto</span>}
                  {mvFrom && <span className="px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[9px]">Desde</span>}
                  {mvTo && <span className="px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[9px]">Hasta</span>}
                </div>
              )}
              <button onClick={()=> setShowMvFilters(s=>!s)} className="btn btn-soft btn-sm inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">{showMvFilters? 'expand_less':'expand_more'}</span>
                {showMvFilters? 'Ocultar filtros' : `Mostrar filtros${activeFilterCount? ' ('+activeFilterCount+')':''}`}
              </button>
            </div>
          </div>
          {showMvFilters && (
          <div className="grid gap-3 mb-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            <div className="flex flex-col">
              <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Origen</label>
              <select value={mvOrigin} onChange={e=> setMvOrigin(e.target.value)} className="form-field mt-1">
                <option value="">(Todos)</option>
                {locations.map(l=> <option key={l.id} value={l.id}>{getLocationLabel(l)}</option>)}
              </select>
            </div>
            <div className="flex flex-col">
              <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Destino</label>
              <select value={mvDest} onChange={e=> setMvDest(e.target.value)} className="form-field mt-1">
                <option value="">(Todos)</option>
                {locations.map(l=> <option key={l.id} value={l.id}>{getLocationLabel(l)}</option>)}
              </select>
            </div>
            <div className="flex flex-col relative">
              <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Producto</label>
              <input value={mvProductQ} onChange={e=> { setMvProductQ(e.target.value); setMvProductId(null); }} placeholder="Nombre o código (mín 2)" className="form-field mt-1 pr-8" />
              {mvProductId && <span className="absolute right-2 top-6 text-[10px] kbd">ID {mvProductId}</span>}
              {mvProductOptions.length>0 && !mvProductId && (
                <div className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-auto bg-[var(--card-color)] border border-[var(--border-color)] rounded shadow-soft">
                  {mvProductOptions.map(p=> (
                    <button key={p.id} type="button" className="w-full text-left px-3 py-2 text-[10px] flex items-center gap-2 hover:bg-[var(--dark-color)]" onClick={()=> { setMvProductId(p.id); setMvProductQ(p.name); }}>
                      <span className="material-symbols-outlined text-[var(--primary-color)] text-sm">inventory_2</span>
                      <span className="truncate flex-1 font-semibold">{p.name}</span>
                      {p.default_code && <span className="kbd">{p.default_code}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col">
              <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Límite</label>
              <select value={mvLimit} onChange={e=> setMvLimit(Number(e.target.value))} className="form-field mt-1">
                {[50,100,200,500].map(n=> <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="flex flex-col">
              <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Desde</label>
              <input type="date" value={mvFrom} onChange={e=> setMvFrom(e.target.value)} className="form-field mt-1" />
            </div>
            <div className="flex flex-col">
              <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Hasta</label>
              <input type="date" value={mvTo} onChange={e=> setMvTo(e.target.value)} className="form-field mt-1" />
            </div>
            <div className="flex flex-col sm:flex-row sm:items-end gap-2 col-span-full sm:col-span-2 lg:col-span-2 xl:col-span-2">
              <button onClick={fetchMovementLines} className="btn btn-primary btn-sm w-full sm:w-auto">Aplicar</button>
              <button onClick={()=> { setMvFrom(''); setMvTo(''); }} disabled={!mvFrom && !mvTo} className="btn btn-soft btn-sm w-full sm:w-auto">Limpiar</button>
            </div>
          </div> )}
          {/* Lista agrupada */}
          {loadingMovements && <div className="text-[10px] text-[var(--text-secondary-color)] flex items-center gap-2"><span className="material-symbols-outlined animate-spin text-[var(--primary-color)]">progress_activity</span>Cargando…</div>}
          {!loadingMovements && movementLines.length===0 && <div className="text-[10px] text-[var(--text-secondary-color)]">Sin resultados</div>}
          {!loadingMovements && movementPicks.length===0 && <div className="text-[10px] text-[var(--text-secondary-color)]">Sin resultados</div>}
          {!!movementPicks.length && (()=>{
            // Agrupar por día
            const groups=[]; const dayMap=new Map();
            movementPicks.forEach(p=> { const d=parseOdooDate(p.date); if(!d) return; const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); if(!dayMap.has(key)){ dayMap.set(key,{key,date:d,items:[]}); groups.push(dayMap.get(key)); } dayMap.get(key).items.push(p); });
            groups.sort((a,b)=> b.date.getTime()-a.date.getTime());
            return (
              <div className="space-y-4">
                {groups.map(g=> {
                  const header = formatTransferDate(g.items[0].date);
                  return (
                    <div key={g.key} className="rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)]/40">
                      <div className="sticky top-0 px-3 py-2 flex items-center gap-2 text-[10px] font-semibold tracking-wide uppercase text-[var(--text-secondary-color)] bg-[var(--dark-color)]/70 backdrop-blur rounded-t-lg">
                        <span className="material-symbols-outlined text-[14px] opacity-70">calendar_month</span>
                        <span className="normal-case font-normal text-[11px] truncate">{header.split('. ')[0]}</span>
                      </div>
                      <ul className="divide-y divide-[var(--border-color)]">
                        {g.items.map(p=>{
                          const dateDMY = formatDMY(p.date);
                          const time12 = formatTime12(p.date);
                          const isOpen = expandedPick===p.id;
                          const anyQty = p.items.reduce((s,it)=> s + Math.abs(Number(it.qty)||0), 0);
                          // dirección inferida del primer item
                          const first = p.items[0];
                          const inbound = mvDest ? first?.toId===Number(mvDest) : (first?.qty>0);
                          let icon; let dirColor;
                          if(!first || first.qty===0){ icon='arrow_forward'; dirColor='text-amber-500'; }
                          else if(inbound){ icon='arrow_upward'; dirColor='text-[var(--success-color)]'; }
                          else { icon='arrow_downward'; dirColor='text-[var(--danger-color)]'; }
                          return (
                            <li key={p.id} className="p-3 flex flex-col gap-2 sm:gap-1 text-[10px] sm:text-[11px]">
                              <button onClick={()=> setExpandedPick(prev=> prev===p.id? null:p.id)} className="flex w-full flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between text-left">
                                <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-1 sm:gap-2">
                                  <div className="flex items-center gap-1 flex-wrap">
                                    <span className="px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[9px] font-mono">{p.ref || '—'}</span>
                                    {dateDMY && <span className="px-2 py-0.5 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[9px]">{dateDMY}</span>}
                                  </div>
                                  <div className="flex items-center gap-1 text-[var(--text-secondary-color)] flex-wrap">
                                    <span className={`material-symbols-outlined text-[14px] opacity-60 ${dirColor}`}>{icon}</span>
                                    <span className="truncate max-w-[240px] sm:max-w-[260px]">{getLocationLabel(locations.find(l=> l.id===p.fromId) || { name: p.from })}</span>
                                    <span className="material-symbols-outlined text-[14px] opacity-60">trending_flat</span>
                                    <span className="truncate max-w-[240px] sm:max-w-[260px]">{getLocationLabel(locations.find(l=> l.id===p.toId) || { name: p.to })}</span>
                                  </div>
                                </div>
                                <div className="w-full sm:w-auto ml-0 sm:ml-auto flex flex-wrap items-center gap-2 text-[var(--text-secondary-color)]">
                                  <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[14px] opacity-60">inventory_2</span>{p.items.length} {p.items.length===1? 'Producto':'Productos'}</span>
                                  <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[14px] opacity-60">counter_1</span>{formatQty(anyQty)} Unidades</span>
                                  <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[14px] opacity-60">schedule</span>{time12}</span>
                                  <span className="material-symbols-outlined text-[16px] opacity-70 ml-auto sm:ml-0">{isOpen? 'expand_less':'expand_more'}</span>
                                </div>
                              </button>
                              {isOpen && (
                                <div className="mt-2 p-2 rounded-md border border-[var(--border-color)] bg-[var(--card-color)]">
                                  <div className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)] mb-1">Productos</div>
                                  <div className="flex flex-col divide-y divide-[var(--border-color)]">
                                    {p.items.map((it,idx)=> (
                                      <div key={it.id} className={`py-1.5 px-2 grid grid-cols-[1fr_auto] items-center gap-2 ${idx%2? 'bg-[var(--dark-color)]/20':''}`}>
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span className="material-symbols-outlined text-[12px] opacity-60">inventory_2</span>
                                          <span className="truncate max-w-[220px] sm:max-w-[420px] font-medium">{it.productName}</span>
                                        </div>
                                        <div className="flex items-center gap-2 justify-end text-[var(--text-secondary-color)]">
                                          <span className="kbd">{formatQty(it.qty)}</span>
                                          <span className="opacity-70">{formatUom(it.uom)}</span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  {p.creator && <div className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border-color)] bg-[var(--dark-color)] text-[9px] text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-[12px] opacity-60">person</span>{p.creator}</div>}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

  {(error || (info && !initialLoading) || lineErrors.length>0) && (
        <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-4 shadow-soft mt-4">
          <h2 className="m-0 mb-2 font-heading font-bold text-sm uppercase tracking-wider text-[var(--text-secondary-color)]">Error</h2>
      {error && <div className="text-[var(--text-secondary-color)]">{error}</div>}
      {info && !initialLoading && <div className="text-[var(--text-secondary-color)]">{info}</div>}
      {lineErrors.length>0 && (
        <ul className="mt-2 list-disc pl-5 text-[var(--danger-color)] text-sm space-y-1">
          {lineErrors.map((e,i)=><li key={i}>{e}</li>)}
        </ul>
      )}
        </div>
      )}

  {/* Bloque resultado anterior eliminado (reemplazado arriba) */}

  {/* Visor de movimientos sustituye recientes */}

  <p className="text-center text-xs text-[var(--text-secondary-color)] mt-8">ATM Ricky Rich · Traspasos internos{auth ? ` · ${auth.name} (${auth.db})` : ''}</p>
    {initialLoading && (
      <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-black/75">
        {/* Capa opcional si quieres un ligero blur: <div className="absolute inset-0 backdrop-blur-sm" /> */}
        <div className="relative flex flex-col items-center gap-6 px-6">
          <div className="relative w-28 h-28">
            <div className="absolute inset-0 rounded-full border-4 border-[var(--border-color)]" />
            <div className="absolute inset-0 rounded-full border-t-4 border-[var(--primary-color)] animate-spin" style={{ animationDuration:'1.4s' }} />
            <div className="absolute inset-3 rounded-xl bg-[var(--card-color)] flex items-center justify-center shadow-soft">
              <img src="/logo192.png" alt="Logo" className="w-12 h-12 opacity-90" />
            </div>
          </div>
          {!loadError && (
            <div className="text-center space-y-2">
              <p className="m-0 font-heading font-bold text-lg tracking-tight">Preparando entorno</p>
              <p className="m-0 text-xs text-[var(--text-secondary-color)]">Cargando ubicaciones y almacenes…</p>
              <div className="h-1 w-52 rounded-full overflow-hidden bg-[var(--dark-color)]">
                <div className="h-full w-full bg-[var(--primary-color)] animate-[shimmer_1.8s_ease_infinite] origin-left" style={{ transformOrigin:'0 50%' }} />
              </div>
            </div>
          )}
          {loadError && (
            <div className="text-center space-y-4 max-w-xs">
              <p className="m-0 font-semibold text-sm text-[var(--danger-color)]">No se pudieron cargar las ubicaciones.</p>
              <p className="m-0 text-xs text-[var(--text-secondary-color)] break-words">{loadError}</p>
              <button onClick={fetchLocations} className="inline-flex items-center gap-2 px-5 py-3 rounded-[var(--radius)] bg-[var(--primary-color)] text-white font-semibold shadow-soft hover:brightness-110 transition">
                <span className="material-symbols-outlined">refresh</span>Reintentar
              </button>
            </div>
          )}
        </div>
      </div>
    )}

    {confirmStage === 'processing' && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm bg-black/70">
        <div className="w-full max-w-md bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl shadow-soft p-6 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.06] pointer-events-none bg-[radial-gradient(circle_at_30%_20%,var(--primary-color),transparent_60%)]" />
          <div className="flex items-center gap-3 mb-5">
            <span className="material-symbols-outlined text-[var(--primary-color)] animate-spin-slow">progress_activity</span>
            <h4 className="m-0 font-heading text-lg font-bold tracking-tight">Procesando traspaso</h4>
          </div>
          <div className="relative mb-5 h-2 rounded-full bg-[var(--dark-color)] overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-[var(--primary-color)] transition-all duration-500" style={{ width: `${(() => { const order=['findType','createPicking','readProducts','createMoves','confirm','assign','prepareLines','adjustLines','validate','finalState']; const idx = order.indexOf(progressStep); return ((idx+1)/order.length)*100 })()}%` }} />
          </div>
          <ul className="text-xs space-y-1 mb-4 max-h-48 overflow-auto pr-1">
            {['findType','createPicking','readProducts','createMoves','confirm','assign','prepareLines','adjustLines','validate','finalState'].map(k=>{
              const labels={
                findType:'Buscando tipo de operación',
                createPicking:'Creando picking',
                readProducts:'Leyendo productos',
                createMoves:'Creando movimientos',
                confirm:'Confirmando',
                assign:'Asignando',
                prepareLines:'Preparando líneas',
                adjustLines:'Ajustando líneas',
                validate:'Validando',
                finalState:'Leyendo estado final'
              };
              const order=['findType','createPicking','readProducts','createMoves','confirm','assign','prepareLines','adjustLines','validate','finalState'];
              const curIndex=order.indexOf(progressStep);
              const myIndex=order.indexOf(k);
              const state = myIndex<curIndex? 'done': (myIndex===curIndex? 'active':'pending');
              return (
                <li key={k} className={`flex items-center gap-2 rounded px-2 py-1 ${state==='done'? 'text-[var(--success-color)] bg-[var(--success-color)]/10': state==='active'? 'text-[var(--primary-color)] bg-[var(--primary-color)]/10 animate-pulse':'text-[var(--text-secondary-color)]'}`}>
                  <span className="material-symbols-outlined text-base">
                    {state==='done'? 'check_circle': state==='active'? 'progress_activity':'radio_button_unchecked'}
                  </span>
                  <span>{labels[k]}</span>
                </li>
              );
            })}
          </ul>
          <p className="m-0 text-[10px] text-[var(--text-secondary-color)] text-center">No cierres esta ventana…</p>
        </div>
      </div>
    )}
    </div>
  );
}
