import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { applyPageMeta } from './lib/meta';
import { useAuth } from './context/AuthContext';
import { parseOdooDate } from './utils/dates';
import { sendWhatsAppMessage, NUMBER_PEDIDOS_BOD, bold } from './lib/notify';
// Debug helpers (after all imports)
const __DBG = true; // toggle to false to silence
const dbg = (...a)=> { if(__DBG) { try { console.debug('[BODEGA]', ...a); if(typeof window!=='undefined'){ if(!window.__BODEGA_LOGS) window.__BODEGA_LOGS=[]; window.__BODEGA_LOGS.push(a); } } catch(_){} } };
if(typeof window!=='undefined'){ console.log('[BODEGA] módulo cargado'); }
// Hora corta para logs
const tms = ()=> new Date().toISOString().split('T')[1].replace('Z','');

// Asegura que exista una sesión abierta para la config que contenga 'bodega'. Si no, la crea y abre.
async function ensureBodegaSession(executeKwSilent){
  dbg('ensureBodegaSession:start');
  // 1. Buscar config 'bodega'
  let configIds=[]; try { configIds = await executeKwSilent({ model:'pos.config', method:'search', params:[[ ['name','ilike','bodega'] ]], kwargs:{ limit:1 } }); dbg('configIds', configIds);} catch(e){ dbg('config search error', e); }
  if(!configIds || !configIds.length) return null;
  const configId = configIds[0];
  // 2. Buscar sesión abierta u opening_control
  let sessionIds=[]; try { sessionIds = await executeKwSilent({ model:'pos.session', method:'search', params:[[ ['config_id','=',configId], ['state','in',['opened','opening_control']] ]], kwargs:{ limit:1 } }); dbg('sessionIds', sessionIds);} catch(e){ dbg('session search error', e);} 
  let sessionId = sessionIds && sessionIds[0];
  if(!sessionId){
    // Crear sesión nueva
    try {
      dbg('creating session for config', configId);
      sessionId = await executeKwSilent({ model:'pos.session', method:'create', params:[{ config_id: configId }], kwargs:{} });
      // Abrir
      try { await executeKwSilent({ model:'pos.session', method:'action_pos_session_open', params:[[sessionId]], kwargs:{} }); dbg('opened new session', sessionId);} catch(e){ dbg('open new session error', e); }
    } catch(e){ console.warn('No se pudo crear sesión POS', e); return null; }
  } else {
    // Si está en opening_control intentar abrir
    try {
      const sessState = await executeKwSilent({ model:'pos.session', method:'read', params:[[sessionId], ['state']], kwargs:{} });
      dbg('sessState', sessState);
      if(Array.isArray(sessState) && sessState[0]?.state==='opening_control'){
        try { await executeKwSilent({ model:'pos.session', method:'action_pos_session_open', params:[[sessionId]], kwargs:{} }); dbg('opened existing session', sessionId);} catch(e){ dbg('open existing error', e); }
      }
    } catch(e){ console.warn('No se pudo leer estado de la sesión', e); }
  }
  // 3. Leer datos básicos de sesión + config (pricelist/payment methods) + currency/company
  let session=null; let config=null;
  try {
    const sData = await executeKwSilent({ model:'pos.session', method:'read', params:[[sessionId], ['id','name','start_at','config_id','currency_id','company_id']], kwargs:{} }); dbg('session read', sData);
    session = sData && sData[0];
  } catch(e){ console.warn('No se pudo leer la sesión', e); }
  try {
    const cData = await executeKwSilent({ model:'pos.config', method:'read', params:[[configId], ['pricelist_id','company_id','payment_method_ids']], kwargs:{} }); dbg('config read', cData);
    config = cData && cData[0];
  } catch(e){ console.warn('No se pudo leer config', e); }
  dbg('ensureBodegaSession:done', { sessionId, hasSession: !!session });
  if(session){
    return {
      id: session.id,
      name: session.name,
      start_at: session.start_at,
      config_id: session.config_id, // Mismo formato que before (array [id,name])
      currency_id: Array.isArray(session.currency_id)? session.currency_id[0]: session.currency_id || null,
      company_id: Array.isArray(session.company_id)? session.company_id[0]: session.company_id || null,
      _configCache: config || null,
    };
  }
  return null;
}
// Fin componente
// export default ya declarado arriba en la definición de la función

// Asegurar export (ya export default al definir la función)
async function fetchPaymentMethods(executeKwSilent){
  const all = await executeKwSilent({ model:'pos.payment.method', method:'search_read', params:[[], ['id','name']], kwargs:{ limit:50 } });
  const allow = ['efectivo','transferencia','cartera'];
  return all.filter(m=> allow.includes((m.name||'').toLowerCase()));
}
// Creación manual controlada del pedido (sin create_from_ui) para asegurar campos
async function createPosOrderFromForm(executeKwSilent,{ sessionMeta, formLines, clientName, payments, onStage, userId, posReferenceOverride }){
  const sessionId = sessionMeta?.id; if(!sessionId) throw new Error('Sin sesión');
  const stage = (m)=> { if(onStage) onStage(m); dbg('ORDER_STAGE', m); };
  stage('Validando líneas');
  const productIds = [...new Set(formLines.map(l=> l.productId).filter(Boolean))];
  if(!productIds.length) throw new Error('Sin productos');
  const existingIds = await executeKwSilent({ model:'product.product', method:'search', params:[[ ['id','in',productIds] ]], kwargs:{} });
  const validSet = new Set(existingIds);
  const uiLines = formLines.filter(l=> validSet.has(l.productId) && l.qty>0 && !isNaN(l.price));
  if(!uiLines.length) throw new Error('Líneas inválidas');
  stage('Leyendo productos');
  const prodData = await executeKwSilent({ model:'product.product', method:'read', params:[productIds, ['id','taxes_id','display_name','uom_id','lst_price']], kwargs:{} });
  const taxIds = [...new Set(prodData.flatMap(p=> p.taxes_id||[]))];
  let taxMap={};
  if(taxIds.length){
    stage('Leyendo impuestos');
    const taxRecs = await executeKwSilent({ model:'account.tax', method:'read', params:[taxIds, ['id','amount','price_include','type_tax_use']], kwargs:{} });
    taxMap = Object.fromEntries(taxRecs.map(t=> [t.id,t]));
  }
  stage('Calculando importes');
  let amount_tax=0; let amount_total=0; const linePayloads=[];
  for(const ln of uiLines){
    const prod = prodData.find(p=> p.id===ln.productId);
    const taxes = (prod?.taxes_id||[]).map(t=> Number(t));
    let qty = ln.qty;
    let price_unit = ln.price; // editable por usuario
    let baseSubtotal = price_unit * qty; // asumimos precio sin impuestos salvo taxes price_include
    let lineTaxAmount = 0;
    // replicar lógica secuencial similar al script
    for(const tid of taxes){
      const tax = taxMap[tid];
      if(!tax) continue;
      if(tax.type_tax_use && tax.type_tax_use!=='sale') continue; // ignorar otros usos
      const rate = (tax.amount||0)/100;
      if(tax.price_include){
        const base = baseSubtotal / (1 + rate);
        const included = baseSubtotal - base;
        lineTaxAmount += included;
        baseSubtotal = base; // para siguientes impuestos incluidos
      } else {
        const add = baseSubtotal * rate;
        lineTaxAmount += add;
      }
    }
    const line_price_subtotal = round2(baseSubtotal);
    const line_price_subtotal_incl = round2(baseSubtotal + lineTaxAmount);
    amount_tax += round2(lineTaxAmount);
    amount_total += line_price_subtotal_incl;
    linePayloads.push([0,0,{
      product_id: ln.productId,
      qty,
      price_unit, // Odoo recalculará si hay pricelist distinta
      discount: 0,
      tax_ids_after_fiscal_position: taxes, // igual al script
      price_subtotal: line_price_subtotal,
      price_subtotal_incl: line_price_subtotal_incl,
      product_uom_id: Array.isArray(prod?.uom_id)? prod.uom_id[0]: prod?.uom_id || false,
      full_product_name: prod?.display_name || '',
      pack_lot_ids: [],
    }]);
  }
  amount_tax = round2(amount_tax);
  amount_total = round2(amount_total);
  const amount_paid = payments.reduce((s,p)=> s + (p.amount>0? p.amount:0), 0);
  const amount_return = amount_paid>amount_total? round2(amount_paid - amount_total): 0;
  // pos_reference controlado externamente (solo número) si se pasa override
  const pos_reference = (posReferenceOverride && String(posReferenceOverride).trim()!=='' ? String(posReferenceOverride) : `BODEGA/${Date.now()}`);
  const creation_date = new Date().toISOString().slice(0,19).replace('T',' ');
  const pricelist_id = sessionMeta._configCache?.pricelist_id ? (Array.isArray(sessionMeta._configCache.pricelist_id)? sessionMeta._configCache.pricelist_id[0]: sessionMeta._configCache.pricelist_id) : false;
  const configId = Array.isArray(sessionMeta.config_id)? sessionMeta.config_id[0]: sessionMeta.config_id;
  const orderUid = String(Date.now());
  const sequence_number = Number(orderUid.slice(-5)) % 100000;
  stage('Construyendo payload create_from_ui');
  const statement_ids = payments.filter(p=> p.methodId && p.amount>0).map(p=> [0,0,{
    amount: p.amount,
    payment_method_id: p.methodId,
    name: creation_date,
    payment_date: creation_date,
  }]);
  const ui_order = {
    uid: orderUid,
    name: pos_reference, // placeholder; backend renombra
    sequence_number,
    pos_session_id: sessionId,
    config_id: configId,
    creation_date,
    fiscal_position_id: false,
    pricelist_id: pricelist_id || false,
    partner_id: false,
    employee_id: false,
    user_id: userId || false,
    to_invoice: false,
    currency_id: sessionMeta.currency_id || false,
    company_id: sessionMeta.company_id || false,
    amount_paid: round2(amount_paid),
    amount_total: amount_total,
    amount_tax: amount_tax,
    amount_return,
    is_tipped: false,
    tip_amount: 0.0,
    lines: linePayloads,
    statement_ids,
    pos_reference,
    note: clientName? `Cliente: ${clientName}`: 'Cliente: (sin nombre)',
  };
  const payload = [{ data: ui_order }];
  stage('Enviando a Odoo (create_from_ui)');
  let resp;
  try {
    resp = await executeKwSilent({ model:'pos.order', method:'create_from_ui', params:[payload], kwargs:{} });
  } catch(e){
    dbg('create_from_ui error', e?.message, e);
    throw e;
  }
  stage('Procesando respuesta');
  let orderId=null; let respObj = resp;
  if(Array.isArray(respObj)){
    if(respObj.length){
      if(typeof respObj[0]==='number') orderId=respObj[0];
      else if(typeof respObj[0]==='object') orderId=respObj[0].id || respObj[0].order_id || respObj[0].orderID;
    }
  } else if(respObj && typeof respObj==='object'){
    orderId = respObj.id || respObj.order_id || null;
  }
  if(!orderId) throw new Error('Respuesta inesperada create_from_ui');
  stage('Listo');
  return orderId;
}

// Obtiene el siguiente consecutivo numérico basado en el mayor pos_reference existente que sea número puro
async function getNextBodegaPosReference(executeKwSilent, sessionMeta){
  try {
    if(!sessionMeta) return 1;
    const configId = Array.isArray(sessionMeta.config_id)? sessionMeta.config_id[0]: sessionMeta.config_id;
    // Dominio: pedidos de la misma configuración POS y que tengan pos_reference
    const domain = [ ['config_id','=',configId], ['pos_reference','!=',false] ];
    // Obtener últimos 10 (por seguridad si algunos no son numéricos)
    const ids = await executeKwSilent({ model:'pos.order', method:'search', params:[domain], kwargs:{ limit:10, order:'id desc' } });
    if(!ids.length) return 1;
    const recs = await executeKwSilent({ model:'pos.order', method:'read', params:[ids, ['id','pos_reference']], kwargs:{} });
    let maxNum = 0;
    for(const r of recs){
      const pr = r.pos_reference;
      if(pr==null) continue;
      if(/^\d+$/.test(String(pr).trim())){
        const n = parseInt(pr,10); if(n>maxNum) maxNum = n;
      }
    }
    return maxNum + 1 || 1;
  } catch(e){
    console.warn('No se pudo calcular next pos_reference, fallback a timestamp', e);
    return null;
  }
}

function round2(v){ return Math.round((v + Number.EPSILON) * 100)/100; }

function formatCurrency(v){
  if(v == null || isNaN(v)) v = 0;
  const neg = v < 0; const n = Math.round(Math.abs(v));
  const s = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.');
  return `${neg?'-':''}$${s}`;
}

export default function BodegaPage(){
  useEffect(()=> { applyPageMeta({ title: 'Bodega POS', favicon: '/logo192.png' }); }, []);
  dbg('COMPONENT fn invoked');
  const { executeKwSilent: baseExec, executeRpc, auth, hydrated, startBatch, endBatch } = useAuth();
  const isAdmin = auth?.isDeveloper;
  const effectiveRpc = executeRpc || baseExec; // fallback si contexto aún no expone executeRpc
  const executeKwSilent = useCallback(async (opts)=> {
    const { model, method } = opts || {}; const id = Math.random().toString(36).slice(2,8); const start = performance.now();
    dbg('RPC:start', tms(), id, model, method);
    if(typeof window!=='undefined'){ if(!window.__BODEGA_RPC_LOGS) window.__BODEGA_RPC_LOGS=[]; window.__BODEGA_RPC_LOGS.push({phase:'start', id, at:Date.now(), model, method, params: opts?.params}); }
    try {
      const res = await baseExec(opts);
      const dur = (performance.now()-start).toFixed(1)+'ms';
      dbg('RPC:done', tms(), id, model, method, dur);
      if(typeof window!=='undefined') window.__BODEGA_RPC_LOGS.push({phase:'done', id, at:Date.now(), model, method, dur});
      return res;
    } catch(e){
      const dur = (performance.now()-start).toFixed(1)+'ms';
      dbg('RPC:err', tms(), id, model, method, dur, e?.message);
      if(typeof window!=='undefined') window.__BODEGA_RPC_LOGS.push({phase:'err', id, at:Date.now(), model, method, dur, error: e?.message});
      throw e;
    }
  }, [baseExec]);
  const [session,setSession] = useState(null); // sessionMeta enriquecida
  // Loader unificado: initialLoading controla todo el arranque (sesión + métodos + pedidos)
  const [initialLoading,setInitialLoading] = useState(true);
  const [paymentMethods,setPaymentMethods] = useState([]);
  const [userId,setUserId] = useState(null);
  // Progreso detallado de inicialización
  const initStepsRef = useRef([
    { key:'auth', label:'Autenticando' },
    { key:'session', label:'Abriendo sesión POS' },
    { key:'payment_methods', label:'Cargando métodos de pago' },
    { key:'orders', label:'Cargando pedidos' },
    { key:'details', label:'Cargando líneas y pagos' },
    { key:'finalizing', label:'Preparando interfaz' },
  ]);
  const [stepStatus,setStepStatus] = useState(()=> Object.fromEntries(initStepsRef.current.map(s=> [s.key,'pending'])));
  const [stepError,setStepError] = useState(null);
  const markStep = useCallback((key,status,err)=> {
    setStepStatus(st=> ({ ...st, [key]:status }));
    if(err) setStepError(err); else if(status==='error') setStepError('Error');
  },[]);

  const [client,setClient] = useState('');
  const [productQ,setProductQ] = useState('');
  // (multi-selección removida) 
  // Wizard steps: 1 Datos & Productos, 2 Pagos, 3 Stock & Confirmar
  const [orderStep,setOrderStep] = useState(1);
  const [stockPreview,setStockPreview] = useState(null); // [{ productId,name,lineQty,stockBefore,stockAfter }]
  const [products,setProducts] = useState([]);
  const [lines,setLines] = useState([]);
  const [payments,setPayments] = useState([]);
  const clientRef = useRef(null);

  // Toasts (mover arriba para que pushToast esté disponible en callbacks posteriores)
  const [toasts,setToasts] = useState([]); // {id,type,message,expires}
  const pushToast = useCallback((message, type='info', ttl=3500)=>{
    setToasts(ts=> [...ts, { id:Date.now()+Math.random(), type, message, expires: Date.now()+ttl }]);
  },[]);
  useEffect(()=>{
    if(!toasts.length) return; const id = setInterval(()=>{
      const now = Date.now();
      setToasts(ts=> ts.filter(t=> t.expires>now));
    },1000); return ()=> clearInterval(id);
  },[toasts]);

  // Totales (antes de callbacks que los usan)
  const total = useMemo(()=> lines.reduce((a,l)=> a + l.qty*l.price, 0), [lines]);
  const paid = useMemo(()=> payments.reduce((a,p)=> a + (Number(p.amount)||0),0),[payments]);
  const remaining = useMemo(()=> Math.max(0, total - paid), [total, paid]);
  const overPaid = paid > total;
  // Shortage: alguna línea quedaría con stock negativo
  const stockShortage = useMemo(()=> Array.isArray(stockPreview) && stockPreview.some(r=> r.stockAfter < 0), [stockPreview]);

  // Registrar pago sin limitar (permitir sobrepago visual)
  const setPaymentAmount = useCallback((index, val)=> {
    setPayments(curr=> curr.map((p,i)=> {
      if(i!==index) return p;
      if(val==='') return { ...p, amount:'' };
      const num = parseFloat(val);
      return { ...p, amount: isNaN(num)? 0 : num };
    }));
  },[]);
  const [submitting,setSubmitting] = useState(false);
  const [error,setError] = useState('');
  const [info,setInfo] = useState('');
  const [fieldErrors,setFieldErrors] = useState({});
  const [shakePaymentsBox,setShakePaymentsBox] = useState(false);
  const [createdOrderId,setCreatedOrderId] = useState(null);
  const [createdOrderData,setCreatedOrderData] = useState(null);
  const [createdOrderLines,setCreatedOrderLines] = useState(null);
  // Al modificar cualquier pago, limpiar estado de faltante y detener shake para que el usuario reciba feedback inmediato
  useEffect(()=>{
    if(fieldErrors.payments_missing){
      setFieldErrors(fe=> {
        if(!fe.payments_missing) return fe;
        const { payments_missing, ...rest } = fe; return rest;
      });
      setShakePaymentsBox(false);
    }
    if(fieldErrors.payments_over && !overPaid){
      setFieldErrors(fe=> { const { payments_over, ...rest } = fe; return rest; });
    }
  },[payments, fieldErrors.payments_missing, fieldErrors.payments_over, overPaid]);

  const [orders,setOrders] = useState([]);
  const [ordersLoading,setOrdersLoading] = useState(false);
  const [orderDetails,setOrderDetails] = useState({});
  const [expanded,setExpanded] = useState(null);

  // Batch data (para filtros sin abrir cada pedido)
  const [allLines,setAllLines] = useState({}); // orderId -> array lines
  const [allPayments,setAllPayments] = useState({}); // orderId -> array payments

  // Filtros
  const [fNota,setFNota] = useState('');
  const [fProductoIds,setFProductoIds] = useState([]); // array de ids
  const [fProductoSearch,setFProductoSearch] = useState('');
  const [fMetodoId,setFMetodoId] = useState('');
  const [fTotal,setFTotal] = useState('');
  const [productsFilter,setProductsFilter] = useState([]); // productos para selector
  const [fDesde,setFDesde] = useState(''); // yyyy-mm-dd
  const [fHasta,setFHasta] = useState('');
  const [showFilters,setShowFilters] = useState(false);
  // Estados de filtros aplicados (se actualizan al pulsar Aplicar)
  const [apFNota,setApFNota] = useState('');
  const [apFProductoIds,setApFProductoIds] = useState([]);
  const [apFMetodoId,setApFMetodoId] = useState('');
  const [apFTotal,setApFTotal] = useState('');
  const [apFDesde,setApFDesde] = useState('');
  const [apFHasta,setApFHasta] = useState('');
  // Filtros Año / Mes
  const now = new Date();
  const defaultYear = String(now.getFullYear());
  const defaultMonth = String(now.getMonth()+1).padStart(2,'0');
  const [fYear,setFYear] = useState(defaultYear);
  const [fMonth,setFMonth] = useState(defaultMonth); // '' para todos los meses si se desea
  const [apFYear,setApFYear] = useState(defaultYear);
  const [apFMonth,setApFMonth] = useState(defaultMonth);
  // Toasts
  // Toasts (render)
      <div className="fixed top-2 right-2 z-[500] flex flex-col gap-2 max-w-xs">
        {toasts.map(t=> (
          <div key={t.id} className={`px-3 py-2 rounded-md text-[11px] shadow-lg border flex items-start gap-2 animate-fade-in backdrop-blur bg-[var(--card-color)]/95 ${t.type==='warning'? 'border-[var(--warning-color)] text-[var(--warning-color)]': t.type==='error'? 'border-[var(--danger-color)] text-[var(--danger-color)]': 'border-[var(--border-color)] text-[var(--text-color)]'}`}> 
            <span className="material-symbols-outlined text-[16px] leading-none mt-0.5">{t.type==='warning'? 'warning': t.type==='error'? 'error':'info'}</span>
            <span className="flex-1 whitespace-pre-wrap break-words">{t.message}</span>
            <button onClick={()=> setToasts(ts=> ts.filter(x=> x.id!==t.id))} className="opacity-60 hover:opacity-100">
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>
        ))}
      </div>
  // Dropdowns personalizados
  // Eliminado dropdown antiguo de métodos de pago (chips ahora) -> estado removido
  const [openFiltroMetodo,setOpenFiltroMetodo] = useState(false); // dropdown filtro método
  const [openFiltroProductos,setOpenFiltroProductos] = useState(false); // dropdown productos
  const prodDropdownRef = useRef(null);
  // Años disponibles (según pedidos existentes)
  const [yearOptions,setYearOptions] = useState([]);
  useEffect(()=>{ (async()=>{
    if(!session) return;
    try {
      const groups = await executeKwSilent({ model:'pos.order', method:'read_group', params:[[ ['session_id','!=',0] ], ['id'], ['date_order:year']], kwargs:{ lazy:false } });
      if(!Array.isArray(groups)) return;
      const years = groups.map(g=> g['date_order:year']).filter(Boolean).map(String).filter((v,i,a)=> a.indexOf(v)===i).sort((a,b)=> Number(b)-Number(a));
      setYearOptions(years);
      if(years.length && !years.includes(fYear)) setFYear(years[0]);
    } catch(e){ dbg('years load error', e?.message); }
  })(); },[session, executeKwSilent, fYear]);
  useEffect(()=>{
    function handleClick(e){
      if(prodDropdownRef.current && !prodDropdownRef.current.contains(e.target)) setOpenFiltroProductos(false);
    }
    if(openFiltroProductos) document.addEventListener('mousedown', handleClick);
    return ()=> document.removeEventListener('mousedown', handleClick);
  },[openFiltroProductos]);

  const activeFilters = useMemo(()=>{
    const arr=[];
    if(apFNota) arr.push({k:'fNota', label:'Cliente', value:apFNota});
    if(apFYear) arr.push({k:'fYear', label:'Año', value:apFYear});
    if(apFYear && apFMonth){
      const monthNames=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      const idx=Number(apFMonth)-1; if(idx>=0&&idx<12) arr.push({k:'fMonth', label:'Mes', value:monthNames[idx]});
    }
    if(apFProductoIds.length){
      apFProductoIds.forEach(pid=> {
        const prod = productsFilter.find(p=> p.id===Number(pid));
        arr.push({k:'fProductoIds', sub:pid, label:'Producto', value: prod? prod.name: pid});
      });
    }
    if(apFMetodoId){
      const met = paymentMethods.find(m=> m.id===Number(apFMetodoId));
      arr.push({k:'fMetodoId', label:'Método', value: met? met.name: apFMetodoId});
    }
    if(apFTotal) arr.push({k:'fTotal', label:'Total', value:apFTotal});
    if(apFDesde) arr.push({k:'fDesde', label:'Desde', value:apFDesde});
    if(apFHasta) arr.push({k:'fHasta', label:'Hasta', value:apFHasta});
    return arr;
  },[apFNota,apFProductoIds,apFMetodoId,apFTotal,apFDesde,apFHasta,productsFilter,paymentMethods,apFYear,apFMonth]);

  // Eliminado auto-open de panel de filtros: debe permanecer cerrado hasta acción del usuario
  
    // Cargar productos para selector de filtros cuando se abre panel si vacío
    useEffect(()=>{
      let act=true;
      if(showFilters && productsFilter.length===0){
        (async()=>{
          try {
            const res = await executeKwSilent({ model:'product.product', method:'search_read', params:[[], ['id','name']], kwargs:{ limit:500 } });
            if(act) setProductsFilter(res);
          } catch(e){ console.error('Error cargando productos filtro', e); }
        })();
      }
      return ()=>{ act=false; };
    },[showFilters, productsFilter.length, executeKwSilent]);


  // Colocar refreshOrders antes de usarlo en el useEffect inicial
  const refreshOrders = useCallback(async (sessOverride, opts={})=>{
    const sessObj = sessOverride || session;
    if(!sessObj) return;
    try {
      setOrdersLoading(true);
      const configId = Array.isArray(sessObj.config_id)? sessObj.config_id[0]: sessObj.config_id;
      const domain=[[ 'config_id','=',configId ]];
      // Rango año/mes aplicados
      let fromDate=null,toDate=null;
      if(apFYear){
        if(apFMonth){ fromDate=new Date(Number(apFYear),Number(apFMonth)-1,1); toDate=new Date(Number(apFYear),Number(apFMonth),1); }
        else { fromDate=new Date(Number(apFYear),0,1); toDate=new Date(Number(apFYear)+1,0,1);} }
      if(fromDate && toDate){
        const pad=n=> String(n).padStart(2,'0');
        const fd=`${fromDate.getFullYear()}-${pad(fromDate.getMonth()+1)}-${pad(fromDate.getDate())}`;
        const td=`${toDate.getFullYear()}-${pad(toDate.getMonth()+1)}-${pad(toDate.getDate())}`;
        domain.push(['date_order','>=',fd]);
        domain.push(['date_order','<',td]);
      }
      // Optimizamos: una sola llamada limitada (últimos más recientes). Si hay año/mes, ampliamos límite.
  const fields=['id','name','pos_reference','date_order','amount_total','amount_paid','note'];
  const orderLimit = apFYear ? 800 : 400; // tunable
  opts.progressCb && opts.progressCb('orders:start');
  const all = await executeKwSilent({ model:'pos.order', method:'search_read', params:[domain, fields], kwargs:{ limit:orderLimit, order:'id desc' } });
  setOrders(all);
  opts.progressCb && opts.progressCb('orders:done');
      if(all.length){
        const ids = all.map(o=> o.id);
        const linesMap = {}; const payMap = {};
        opts.progressCb && opts.progressCb('details:start');
        const fetchChunked = async (model, fieldOrder, idField, targetMap)=>{
          // si pocos ids una sola llamada; si muchos chunk
          const CHUNK=800;
            if(ids.length<=CHUNK){
              const recs = await executeKwSilent({ model, method:'search_read', params:[[ [fieldOrder,'in',ids] ], ['id',fieldOrder, ...(model==='pos.order.line'? ['product_id','qty','price_unit']: ['payment_method_id','amount']) ]], kwargs:{ limit:10000 } });
              recs.forEach(r=> { const oid = Array.isArray(r[fieldOrder])? r[fieldOrder][0]: r[fieldOrder]; (targetMap[oid] ||= []).push(r); });
            } else {
              for(let i=0;i<ids.length;i+=CHUNK){
                const slice = ids.slice(i,i+CHUNK);
                const recs = await executeKwSilent({ model, method:'search_read', params:[[ [fieldOrder,'in',slice] ], ['id',fieldOrder, ...(model==='pos.order.line'? ['product_id','qty','price_unit']: ['payment_method_id','amount']) ]], kwargs:{ limit:10000 } });
                recs.forEach(r=> { const oid = Array.isArray(r[fieldOrder])? r[fieldOrder][0]: r[fieldOrder]; (targetMap[oid] ||= []).push(r); });
              }
            }
        };
        try { await fetchChunked('pos.order.line','order_id','order_id', linesMap); } catch(e){ console.error('Prefetch líneas falló', e); }
        try { await fetchChunked('pos.payment','pos_order_id','pos_order_id', payMap); } catch(e){ console.error('Prefetch pagos falló', e); }
        setAllLines(linesMap); setAllPayments(payMap);
        opts.progressCb && opts.progressCb('details:done');
      }
    } catch(e){ console.error(e); }
    finally { setOrdersLoading(false); }
  },[executeKwSilent, session, apFYear, apFMonth]);

  const filteredOrders = useMemo(()=>{
    return orders.filter(o=> {
      if(apFNota.trim()){
        const note = (o.note||'').toString().toLowerCase();
        if(!note.includes(apFNota.toLowerCase())) return false;
      }
      if(apFTotal){ if(o.amount_total !== Number(apFTotal)) return false; }
      if(apFDesde){ if(!o.date_order || o.date_order.slice(0,10) < apFDesde) return false; }
      if(apFHasta){ if(!o.date_order || o.date_order.slice(0,10) > apFHasta) return false; }
      if(apFProductoIds.length){
        const lns = allLines[o.id]||[];
        const prodIdsInOrder = new Set(lns.map(l=> Number(Array.isArray(l.product_id)? l.product_id[0]: l.product_id)));
        const any = apFProductoIds.some(pid=> prodIdsInOrder.has(Number(pid)));
        if(!any) return false;
      }
      if(apFMetodoId){
        const pays = allPayments[o.id]||[];
        const hit = pays.some(p=> {
          const mid = Array.isArray(p.payment_method_id)? p.payment_method_id[0]: p.payment_method_id; return Number(mid)===Number(apFMetodoId);
        });
        if(!hit) return false;
      }
      return true;
    });
  },[orders, apFNota, apFTotal, apFDesde, apFHasta, apFProductoIds, apFMetodoId, allLines, allPayments]);

  // Visibilidad incremental de pedidos (20 por defecto, mostrar más)
  const [visibleCount,setVisibleCount] = useState(20);
  // Resetear al cambiar filtros aplicados u órdenes
  useEffect(()=> { setVisibleCount(20); }, [orders, apFNota, apFTotal, apFDesde, apFHasta, apFProductoIds, apFMetodoId, apFYear, apFMonth]);

  const visibleOrders = useMemo(()=> filteredOrders.slice(0, visibleCount), [filteredOrders, visibleCount]);
  // Agrupar por fecha (YYYY-MM-DD)
  const groupedVisibleOrders = useMemo(()=> {
    const groups = [];
    const map = new Map();
    for(const o of visibleOrders){
      const day = (o.date_order||'').slice(0,10) || 'Sin fecha';
      if(!map.has(day)) { const arr=[]; map.set(day, arr); groups.push({ day, orders: arr }); }
      map.get(day).push(o);
    }
    return groups; // Mantiene orden según aparición (ya vienen ordenados desc por id)
  }, [visibleOrders]);

  // Auto-refresco cuando cambian los filtros de Año / Mes aplicados (solo esos se auto-aplican)
  useEffect(()=> {
    if(!session) return;
    // Evitar llamar antes de que runInit haya completado: esperar a que initialLoading false
    if(initialLoading) return;
    refreshOrders();
  }, [apFYear, apFMonth, session, initialLoading, refreshOrders]);

  const hasInitRef = useRef(false);
  const [initError,setInitError] = useState(null);
  const initAttemptsRef = useRef(0);
  const runInit = useCallback(async ()=>{
    initAttemptsRef.current +=1; const attempt = initAttemptsRef.current;
    setInitError(null); setStepError(null);
    setStepStatus(Object.fromEntries(initStepsRef.current.map(s=> [s.key,'pending'])));
    setInitialLoading(true); dbg('init attempt', attempt);
    startBatch();
    try {
      markStep('auth','done');
      markStep('session','running');
      const sess = await ensureBodegaSession(async ({model,method,params,kwargs})=> effectiveRpc({ model, method, params, kwargs, retries:1, timeoutMs:8000 }).catch(err=> { throw err; }));
      if(!sess){ markStep('session','error','No se pudo abrir sesión POS'); setSession(null); setInitError('No se pudo abrir sesión POS'); return; }
      setSession(sess); markStep('session','done');
      markStep('payment_methods','running');
      try {
        const pm = await fetchPaymentMethods(executeKwSilent);
        if(pm) setPaymentMethods(pm);
        markStep('payment_methods','done');
      } catch(e){ markStep('payment_methods','error', e.message||'Error'); setInitError('Error cargando métodos de pago'); return; }
      markStep('orders','running');
      await refreshOrders(sess, { progressCb:(ph)=> {
        if(ph==='orders:start') markStep('orders','running');
        if(ph==='orders:done') markStep('orders','done');
        if(ph==='details:start') markStep('details','running');
        if(ph==='details:done') markStep('details','done');
      }});
      if(stepStatus.details!=='done') markStep('details','done');
      const login = process.env.REACT_APP_ODOO_USER || process.env.ODOO_USER;
      if(login){
        try { const usr = await executeKwSilent({ model:'res.users', method:'search_read', params:[[ ['login','=',login] ], ['id','login']], kwargs:{ limit:1 } }); if(usr && usr[0]) setUserId(usr[0].id); } catch(e){ dbg('user load error', e?.message); }
      }
      markStep('finalizing','running');
      await new Promise(r=> setTimeout(r,150));
      markStep('finalizing','done');
    } catch(e){ setInitError(e.message || 'Error inicializando'); if(!stepError) markStep('finalizing','error', e.message); }
    finally { endBatch(); setInitialLoading(false); }
  }, [effectiveRpc, executeKwSilent, refreshOrders, startBatch, endBatch, markStep, stepStatus.details, stepError]);
  useEffect(()=> { if(!auth || !hydrated) return; if(hasInitRef.current) return; hasInitRef.current=true; runInit(); }, [auth, hydrated, runInit]);
  const retryInit = useCallback(()=> { hasInitRef.current=false; runInit(); }, [runInit]);
  // Quitar efecto separado de refreshOrders por session; ya incluido en batch

  // Debounced búsqueda productos
  useEffect(()=> { let active=true; const term = productQ.trim(); if(term.length<2){ setProducts([]); return;} const h=setTimeout(async()=>{ try { const res=await executeKwSilent({ model:'product.product', method:'search_read', params:[[ ['name','ilike',term] ], ['id','name','list_price']], kwargs:{ limit:20 } }); if(active) setProducts(res);} catch(e){ console.error(e); } }, 300); return ()=> { active=false; clearTimeout(h); }; }, [productQ, executeKwSilent]);

  function addProduct(p){ 
    setLines(ls=> {
      const next = [...ls,{ uid:Date.now()+Math.random(), productId:p.id, name:p.name, price:p.list_price, qty:1 }];
      // ordenar por nombre (case-insensitive)
      next.sort((a,b)=> a.name.localeCompare(b.name,'es',{ sensitivity:'base'}));
      return next;
    });
    setProductQ(''); setProducts([]); 
  }
  function updateLine(uid,changes){ setLines(ls=> ls.map(l=> l.uid===uid? { ...l,...changes }:l)); if(orderStep>1){ setOrderStep(1); setStockPreview(null); } }
  // Permitir edición libre de cantidad (pudiendo borrar el 1) usando un campo temporal qtyInput
  function handleQtyChange(uid, raw){
    setLines(ls=> ls.map(l=> {
      if(l.uid!==uid) return l;
      // permitir vacío
      if(raw==='') return { ...l, qtyInput:'' };
      const num = parseInt(raw,10);
      if(isNaN(num)) return l; // ignora caracteres no numéricos
      return { ...l, qty: Math.max(1,num), qtyInput: String(num) };
    }));
  }
  function handleQtyBlur(uid){
    setLines(ls=> ls.map(l=> {
      if(l.uid!==uid) return l;
      if(l.qtyInput===''|| l.qty<=0){ return { ...l, qty:1, qtyInput:undefined }; }
      return { ...l, qtyInput:undefined };
    }));
  }
  function removeLine(uid){ setLines(ls=> ls.filter(l=> l.uid!==uid)); if(orderStep>1){ setOrderStep(1); setStockPreview(null); } }

  const [creatingStage,setCreatingStage] = useState('');
  const [preloadingStock,setPreloadingStock] = useState(false); // fase 1 loader
  const [stageHistory,setStageHistory] = useState([]); // etapas durante creación final
  // Etapas esperadas para mostrar progreso visual consistente (en orden)
  const expectedStages = useRef([
    'Validando líneas',
    'Leyendo productos',
    'Leyendo impuestos',
    'Calculando importes',
    'Construyendo payload create_from_ui',
    'Enviando a Odoo (create_from_ui)',
    'Procesando respuesta',
    'Listo'
  ]);
  async function doCreateOrder(){
    try {
      setSubmitting(true);
      setOrderStep(4); // paso procesamiento
      setStageHistory([]);
  // Calcular consecutivo numérico para pos_reference
  let nextPosRef = await getNextBodegaPosReference(executeKwSilent, session);
  const orderId = await createPosOrderFromForm(executeKwSilent,{ sessionMeta:session, formLines:lines, clientName:client.trim(), payments: payments.map(p=> ({ methodId:p.methodId, amount:Number(p.amount)||0 })), onStage:(st)=> { setCreatingStage(st); setStageHistory(h=> h[h.length-1]===st? h: [...h, st]); }, userId, posReferenceOverride: nextPosRef });
        // Notificación pedido POS Bodega
        try {
          const total = lines.reduce((s,l)=> s + (l.qty * l.price),0);
          const prodLines = lines.map(l=> `• ${l.name}: ${l.qty} a $${Number(l.price).toLocaleString('es-CO')}c/u = $${Number(l.qty*l.price).toLocaleString('es-CO')}`).join('\n');
          const payLines = payments.filter(p=> p.methodId && p.amount>0).map(p=> {
            const m = paymentMethods.find(pm=> pm.id===Number(p.methodId));
            const name = m? m.name : 'Pago';
            return `• ${name}: $${Number(p.amount).toLocaleString('es-CO')}`;
          }).join('\n') || '• (Sin pagos)';
          const msg = [
            '🧾 *Pedido Bodega creado*',
            `${bold('OP')}: ${nextPosRef ?? 'N/D'}`,
            `${bold('Cliente')}: ${client.trim()||'Consumidor Final'}`,
            '',
            bold('Productos'),
            prodLines,
            '',
            bold('Pagos'),
            payLines,
            '',
            `${bold('Total')}: $${Number(total).toLocaleString('es-CO')}`
          ].join('\n');
          if(NUMBER_PEDIDOS_BOD){
            const wRes = await sendWhatsAppMessage({ number: NUMBER_PEDIDOS_BOD, text: msg });
            if(!wRes.ok){
              console.warn('[BODEGA] Notificación WhatsApp falló', wRes);
              pushToast('No se pudo enviar notificación WhatsApp','warning');
            }
          }
        } catch(_){ }
  setCreatedOrderId(orderId);
  // Post-creación: escribir nota con nombre cliente
  try {
    const noteVal = client.trim()? `Cliente: ${client.trim()}` : 'Cliente: (sin nombre)';
    await executeKwSilent({ model:'pos.order', method:'write', params:[[orderId], { note: noteVal }], kwargs:{} });
  } catch(e){ console.warn('No se pudo actualizar nota post-creación', e); }
  // Eliminado setInfo para no mostrar mensaje inferior duplicado
      // Fetch detalles del pedido recién creado
      try {
        const [od] = await executeKwSilent({ model:'pos.order', method:'read', params:[[orderId], ['id','name','pos_reference','amount_total','amount_paid','state']], kwargs:{} });
        setCreatedOrderData(od||null);
        const lineIds = await executeKwSilent({ model:'pos.order.line', method:'search', params:[[ ['order_id','=',orderId] ]], kwargs:{} });
        if(lineIds.length){
          const ldata = await executeKwSilent({ model:'pos.order.line', method:'read', params:[lineIds, ['id','product_id','qty','price_subtotal','price_subtotal_incl','full_product_name']], kwargs:{} });
          setCreatedOrderLines(ldata);
        }
      } catch(err){ console.warn('No se pudo leer detalles pedido', err); }
      // Inserción optimista en lista de pedidos recientes (al inicio)
      try {
        setOrders(cur=> {
          // Evitar duplicar si ya está
            if(cur.some(o=> o.id===orderId)) return cur;
            const newOrder = {
              id: orderId,
              name: createdOrderData?.name || createdOrderData?.pos_reference || String(nextPosRef || orderId),
              pos_reference: createdOrderData?.pos_reference ?? (nextPosRef || null),
              date_order: new Date().toISOString().slice(0,19).replace('T',' '),
              amount_total: createdOrderData?.amount_total ?? total,
              amount_paid: createdOrderData?.amount_paid ?? paid,
              note: client.trim()? `Cliente: ${client.trim()}` : 'Cliente: (sin nombre)'
            };
            return [newOrder, ...cur];
        });
      } catch(_){}
      // Limpiar formulario pero no regresar de paso hasta que usuario decida
      setClient(''); setLines([]); setPayments([]); setExpanded(null); setOrderDetails({}); setStockPreview(null);
      // Refetch real (sin pasar session.id; la función espera objeto o usa estado interno)
      refreshOrders();
    } catch(e){ console.error(e); setError('Error creando pedido'); } finally { setSubmitting(false); }
  }

  async function submit(){
    setError(''); setInfo('');
    if(!session) { pushToast('Sin sesión POS','error'); return; }
    if(orderStep===1){
      const errs={};
      if(!client.trim()) errs.client=true;
      if(lines.length===0) errs.lines=true;
      setFieldErrors(errs);
      if(errs.client && clientRef.current){ try { clientRef.current.focus(); } catch(_){} }
      if(Object.keys(errs).length){ pushToast('Completa los campos requeridos','warning'); return; }
      setFieldErrors({});
      setOrderStep(2); return;
    }
  if(orderStep===2){
      const errs={};
      payments.forEach((p,i)=> { if(!p.methodId) errs['payment_method_'+i]=true; if(!(Number(p.amount)||0) || Number(p.amount)<0) errs['payment_amount_'+i]=true; });
      if(remaining>0) errs.payments_missing=true;
      if(overPaid) errs.payments_over=true;
      setFieldErrors(errs);
      if(Object.keys(errs).length){
        if(errs.payments_missing){
          // Reinicia animación shake
          setShakePaymentsBox(false);
          requestAnimationFrame(()=> setShakePaymentsBox(true));
        }
        pushToast('Revisa los pagos','warning');
        return;
      }
      setFieldErrors({});
      try {
        setPreloadingStock(true);
        const ids = [...new Set(lines.map(l=> l.productId))];
        const BODEGA_COMPLETE_NAME = 'BOD/Stock';
        let locationId = null;
        try {
          const locs = await executeKwSilent({ model:'stock.location', method:'search_read', params:[[ ['complete_name','=',BODEGA_COMPLETE_NAME] ], ['id','complete_name']], kwargs:{ limit:1 } });
          if(locs && locs[0]) locationId = locs[0].id;
        } catch(e){ console.warn('No se encontró ubicación BOD/Stock', e); }
        let prods=[];
        if(locationId){
          prods = await executeKwSilent({ model:'product.product', method:'search_read', params:[[ ['id','in',ids] ], ['id','qty_available']], kwargs:{ limit: ids.length, context:{ location: locationId } } });
        } else {
          prods = await executeKwSilent({ model:'product.product', method:'search_read', params:[[ ['id','in',ids] ], ['id','qty_available']], kwargs:{ limit: ids.length } });
        }
        const stockMap = Object.fromEntries(prods.map(p=> [p.id, p.qty_available]));
        const preview = lines.map(l=> {
          const before = stockMap[l.productId] ?? 0;
          return { productId:l.productId, name:l.name, lineQty:l.qty, stockBefore:before, stockAfter: before - l.qty };
        }).sort((a,b)=> a.name.localeCompare(b.name,'es',{sensitivity:'base'}));
        setStockPreview(preview); setOrderStep(3);
      } catch(e){
        console.error(e);
        pushToast('No se pudo obtener stock (usando vista simplificada)','warning');
        // Fallback: continuar igualmente mostrando cantidades solicitadas sin stock previo
        const preview = lines.map(l=> ({ productId:l.productId, name:l.name, lineQty:l.qty, stockBefore:'?', stockAfter:'?' }));
        setStockPreview(preview);
        setOrderStep(3);
      }
      finally { setPreloadingStock(false); }
      return;
    }
  if(orderStep===3){
      await doCreateOrder();
    }
  }


  async function loadDetails(orderId){
    setOrderDetails(od=> ({ ...od, [orderId]: { loading:true, lines:[], payments:[], error:null } }));
    try {
      const lines = await executeKwSilent({ model:'pos.order.line', method:'search_read', params:[[ ['order_id','=',orderId] ], ['id','product_id','qty','price_unit']], kwargs:{ limit:200 } });
      const pays = await executeKwSilent({ model:'pos.payment', method:'search_read', params:[[ ['pos_order_id','=',orderId] ], ['id','payment_method_id','amount']], kwargs:{ limit:200 } });
      setOrderDetails(od=> ({ ...od, [orderId]: { loading:false, lines, payments:pays, error:null } }));
    } catch(e){ setOrderDetails(od=> ({ ...od, [orderId]: { loading:false, lines:[], payments:[], error:'Error detalles' } })); }
  }

  function toggleExpand(o){ setExpanded(prev=> prev===o.id? null:o.id); if(!orderDetails[o.id]) loadDetails(o.id); }

  const [methodPickerIndex,setMethodPickerIndex] = useState(null); // índice del pago que está eligiendo método
  const [methodSearch,setMethodSearch] = useState('');

  if(initialLoading){
    return (
      <div className="p-4 max-w-md mx-auto flex flex-col gap-4">
        <h1 className="m-0 font-heading font-bold text-lg">Bodega POS</h1>
        <div className="p-5 rounded-2xl border border-[var(--border-color)] bg-[var(--card-color)] flex flex-col gap-4 shadow-soft relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none opacity-[0.04] bg-[radial-gradient(circle_at_30%_20%,var(--primary-color),transparent_60%)]" />
          <div className="text-xs font-semibold text-[var(--text-secondary-color)] tracking-wide flex items-center gap-2">
            <span className="relative inline-flex w-6 h-6 items-center justify-center">
              <span className="absolute inset-0 rounded-full bg-[var(--primary-color)]/25 animate-pulse-slow" />
              <span className="material-symbols-outlined text-[16px] text-[var(--primary-color)]">bolt</span>
            </span>
            Inicializando entorno…
          </div>
          <ul className="m-0 p-0 list-none flex flex-col gap-2">
            {initStepsRef.current.map((s,idx)=> {
              const st = stepStatus[s.key];
              const isRunning = st==='running';
              const isDone = st==='done';
              const isError = st==='error';
              const icon = isDone? 'check_circle': isError? 'error': isRunning? 'progress_activity':'radio_button_unchecked';
              const baseColor = isDone? 'var(--success-color)': isError? 'var(--danger-color)': isRunning? 'var(--primary-color)':'var(--text-secondary-color)';
              return (
                <li key={s.key} className={`group flex items-stretch gap-3 text-[11px] rounded-lg px-2 py-1.5 border border-[var(--border-color)] ${isDone? 'bg-[var(--success-color)]/10': isError? 'bg-[var(--danger-color)]/10': isRunning? 'bg-[var(--primary-color)]/5':'bg-[var(--dark-color)]/40'} transition-colors`}> 
                  <div className="relative flex items-center justify-center w-5 h-5">
                    {isRunning && (
                      <span className="absolute inset-0 rounded-full border-2 border-[var(--primary-color)]/30 border-t-[var(--primary-color)] animate-spin-fast" />
                    )}
                    {isDone && (
                      <span className="absolute inset-0 rounded-full bg-[var(--success-color)]/20 animate-pop-in" />
                    )}
                    {isError && (
                      <span className="absolute inset-0 rounded-full bg-[var(--danger-color)]/20 animate-pop-in" />
                    )}
                    <span className={`material-symbols-outlined text-[18px]`} style={{ color: baseColor }}>{icon}</span>
                  </div>
                  <div className="flex-1 flex flex-col min-w-0">
                    <div className={`leading-tight ${isError? 'text-[var(--danger-color)]': isDone? 'text-[var(--success-color)]': isRunning? 'text-[var(--primary-color)]':'text-[var(--text-secondary-color)]'}`}>{s.label}</div>
                    <div className="h-1 mt-1 rounded bg-[var(--dark-color)]/40 overflow-hidden">
                      <div className={`h-full transition-all ${isDone? 'bg-[var(--success-color)] w-full': isError? 'bg-[var(--danger-color)] w-full': isRunning? 'bg-[var(--primary-color)] w-[65%] animate-pulse-bar':'bg-transparent w-0'}`} />
                    </div>
                  </div>
                  {isDone && <span className="material-symbols-outlined text-[16px] text-[var(--success-color)] animate-bounce-once">done</span>}
                  {isError && <button onClick={retryInit} className="ml-auto btn btn-2xs btn-danger">Reintentar</button>}
                </li>
              );
            })}
          </ul>
          {initError && !Object.values(stepStatus).some(v=> v==='running') && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--danger-color)]">
              <span className="material-symbols-outlined text-[16px]">warning</span>
              <span>{initError}</span>
            </div>
          )}
          {!initError && <div className="h-1 w-full bg-[var(--dark-color)] rounded overflow-hidden">
            <div className="h-full bg-gradient-to-r from-[var(--primary-color)] via-[var(--success-color)] to-[var(--primary-color)] bg-[length:200%_100%] animate-progress-shimmer" style={{ width: `${(Object.values(stepStatus).filter(v=> v==='done').length / initStepsRef.current.length)*100}%` }} />
          </div>}
          <div className="text-[9px] text-[var(--text-secondary-color)] opacity-70 tracking-wide">
            {Object.values(stepStatus).every(v=> v==='done')? 'Listo.' : 'Optimizando peticiones y precargando datos…'}
          </div>
        </div>
        <style>{`
          .animate-spin-slow{animation: spin 1.2s linear infinite;}
          .animate-spin-fast{animation: spin 0.8s linear infinite;}
          @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
          .animate-pop-in{animation: pop-in 0.45s cubic-bezier(.26,1.12,.48,1.11);}
          @keyframes pop-in{0%{transform:scale(.4);opacity:0;}60%{transform:scale(1.15);opacity:1;}100%{transform:scale(1);} }
          .animate-bounce-once{animation: bounce-once .6s ease;}
          @keyframes bounce-once{0%{transform:translateY(-4px);opacity:0;}40%{transform:translateY(2px);opacity:1;}70%{transform:translateY(-2px);}100%{transform:translateY(0);} }
          .animate-pulse-slow{animation:pulse-slow 3s ease-in-out infinite;}
          @keyframes pulse-slow{0%,100%{opacity:.35;transform:scale(.9);}50%{opacity:.65;transform:scale(1);} }
          .animate-progress-shimmer{animation: progress-shimmer 3s linear infinite;}
          @keyframes progress-shimmer{0%{background-position:0% 50%;}100%{background-position:200% 50%;}}
          .animate-pulse-bar{animation: pulse-bar 1.3s ease-in-out infinite;}
          @keyframes pulse-bar{0%,100%{transform:translateX(-5%);}50%{transform:translateX(5%);} }
        `}</style>
      </div>
    );
  }

  if(!isAdmin){
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
    <div className="p-4 max-w-5xl mx-auto flex flex-col gap-6 relative">
      <h1 className="m-0 font-heading font-bold text-lg">Bodega POS</h1>
      {initError && <div className="mt-1 text-xs text-red-400 flex items-center gap-2">{initError}<button onClick={retryInit} className="btn btn-2xs btn-outline">Reintentar</button></div>}
      {!session && <div className="p-4 rounded-lg border border-[var(--border-color)] bg-[var(--card-color)] text-[11px]">No hay sesión POS abierta para Bodega.</div>}
  {/* Overlay eliminado (sin blur) */}

  {!!session && (
        <div className="flex flex-col gap-6">
          {/* Nuevo pedido */}
          <div className="p-4 rounded-xl border border-[var(--border-color)] bg-[var(--card-color)]">
            <div className="flex flex-col items-center text-center mb-3 sm:mb-4">
              <h2 className="m-0 font-heading font-bold text-sm sm:text-base uppercase tracking-wide sm:tracking-wider text-[var(--text-secondary-color)]">Nuevo pedido</h2>
              <div className="mt-3 sm:mt-4 w-full flex flex-col items-center gap-2 sm:gap-3">
                <div className="flex items-center justify-center gap-3 sm:gap-6 flex-wrap">
                  {[1,2,3].map(s=> { const active=s===orderStep; const done=s<orderStep; const label=s===1?'Datos & Productos': s===2?'Pagos':'Stock & Confirmar'; return (
                    <div key={s} className="flex flex-col items-center gap-1.5 sm:gap-2 min-w-[70px] sm:min-w-[90px]">
                      <div className={`relative flex items-center justify-center w-9 h-9 sm:w-12 sm:h-12 rounded-full border text-xs sm:text-sm font-bold transition-all ${active? 'bg-[var(--primary-color)] border-[var(--primary-color)] text-white sm:scale-105': done? 'bg-[var(--success-color)]/15 border-[var(--success-color)] text-[var(--success-color)]':'bg-[var(--dark-color)] border-[var(--border-color)] text-[var(--text-secondary-color)]'}`}>{done && !active? <span className="material-symbols-outlined text-[18px] sm:text-[24px]">check</span>: s}</div>
                      <div className={`text-[9px] sm:text-[10px] leading-tight px-1.5 sm:px-2 ${active? 'text-[var(--primary-color)] font-semibold':'text-[var(--text-secondary-color)]'}`}>{label}</div>
                    </div>
                  ); })}
                </div>
                <div className="hidden xs:block text-[10px] sm:text-[11px] text-[var(--text-secondary-color)] font-medium">
                  {orderStep===1 && 'Paso 1: Ingresa cliente y agrega productos.'}
                  {orderStep===2 && 'Paso 2: Registra los pagos hasta completar el total.'}
                  {orderStep===3 && 'Paso 3: Revisa stock previsto y confirma el pedido.'}
                </div>
              </div>
            </div>
            {(orderStep===1 || orderStep===2) && (
              <div className="mt-2 sm:mt-3 flex justify-center">
                <div className="inline-flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-[var(--dark-color)] border border-[var(--border-color)] shadow-sm">
                  <span className="text-[9px] sm:text-[10px] uppercase tracking-wide text-[var(--text-secondary-color)] font-medium">Total factura</span>
                  <span className="text-xl sm:text-2xl font-extrabold tabular-nums text-[var(--primary-color)] leading-none">{formatCurrency(total)}</span>
                </div>
              </div>
            )}
            <div className="grid gap-4">
              {orderStep===1 && (
              <>
                <div>
                  <label className={`text-[10px] font-medium uppercase tracking-wide ${fieldErrors.client? 'text-[var(--danger-color)]':'text-[var(--text-secondary-color)]'}`}>Cliente</label>
                  <input ref={clientRef} aria-invalid={fieldErrors.client? 'true':'false'} value={client} onChange={e=> { setClient(e.target.value); if(fieldErrors.client) setFieldErrors(fe=> { const {client,...r}=fe; return r; }); }} placeholder="Nombre del cliente" className={`form-field mt-1 ${fieldErrors.client? 'border-[var(--danger-color)] focus:ring-[var(--danger-color)]':''}`} />
                  {fieldErrors.client && <div className="mt-1 text-[10px] text-[var(--danger-color)]">Requerido</div>}
                </div>
                <div>
                  <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Agregar producto</label>
                  <input value={productQ} onChange={e=> { setProductQ(e.target.value); }} placeholder="Buscar (mín 2)" className="form-field mt-1" />
                  {products.length>0 && productQ.trim().length>=2 && (
                    <div className="mt-1 border border-[var(--border-color)] rounded-lg bg-[var(--card-color)] max-h-60 overflow-auto flex flex-col">
                      {products.map(p=> (
                        <button key={p.id} type="button" onClick={()=> addProduct(p)} className="px-3 py-2 text-[11px] flex items-center gap-2 hover:bg-[var(--dark-color)] cursor-pointer text-left">
                          <span className="material-symbols-outlined text-[var(--primary-color)] text-sm">inventory_2</span>
                          <span className="flex-1 font-semibold break-words whitespace-pre-wrap leading-snug">{p.name}</span>
                          <span className="kbd">{formatCurrency(p.list_price)}</span>
                          <span className="material-symbols-outlined text-[16px] opacity-70">add</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>) }
              {orderStep===1 && (
                <div className="flex flex-col gap-2">
                  {lines.length===0 && <div className={`text-[10px] ${fieldErrors.lines? 'text-[var(--danger-color)]':'text-[var(--text-secondary-color)]'}`}>Sin productos añadidos.</div>}
                  {lines.slice().sort((a,b)=> a.name.localeCompare(b.name,'es',{sensitivity:'base'})).map(ln=> (
                    <div key={ln.uid} className="p-2 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] flex flex-col gap-2">
                      <div className="flex gap-2 items-start">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-[11px] leading-snug break-words whitespace-pre-wrap">{ln.name}</div>
                          <div className="text-[9px] text-[var(--text-secondary-color)]">{formatCurrency(ln.price)} c/u</div>
                        </div>
                        <button className="btn btn-sm btn-danger self-start" onClick={()=> removeLine(ln.uid)}><span className="material-symbols-outlined text-sm">delete</span></button>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex flex-col gap-1">
                          <span className="text-[8px] uppercase tracking-wide text-[var(--text-secondary-color)] font-medium">Cantidad</span>
                          <div className="flex items-center gap-1">
                            <button className="btn btn-sm btn-soft" onClick={()=> updateLine(ln.uid,{ qty: Math.max(1, ln.qty-1) })}>-</button>
                            <input value={ln.qtyInput!==undefined? ln.qtyInput: ln.qty} onChange={e=> handleQtyChange(ln.uid,e.target.value)} onBlur={()=> handleQtyBlur(ln.uid)} className="w-12 text-center bg-[var(--dark-color)] border border-[var(--border-color)] rounded py-1 text-[11px]" />
                            <button className="btn btn-sm btn-soft" onClick={()=> updateLine(ln.uid,{ qty: ln.qty+1 })}>+</button>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-[8px] uppercase tracking-wide text-[var(--text-secondary-color)] font-medium">Precio unitario</span>
                          <input value={ln.price} onChange={e=>{ const v=parseFloat(e.target.value)||0; updateLine(ln.uid,{ price:v }); }} className="w-24 text-right bg-[var(--dark-color)] border border-[var(--border-color)] rounded py-1 px-1 text-[11px]" />
                        </div>
                        <div className="ml-auto flex flex-col items-end gap-1">
                          <span className="text-[8px] uppercase tracking-wide text-[var(--text-secondary-color)] font-medium">Subtotal</span>
                          <div className="text-[11px] font-semibold">{formatCurrency(ln.qty*ln.price)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid gap-3">
                {orderStep===1 && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[var(--text-secondary-color)]">Total</span>
                  <span className="font-semibold">{formatCurrency(total)}</span>
                </div>
                )}
                {orderStep===2 && (
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-medium text-[var(--text-secondary-color)] uppercase tracking-wide">Pagos</label>
                  {payments.map((p,i)=> {
                    const sel = paymentMethods.find(m=> m.id===Number(p.methodId));
                    const methodIcon = (name='')=> {
                      const n = name.toLowerCase();
                      if(n==='efectivo') return 'payments';
                      if(n==='transferencia') return 'account_balance';
                      if(n==='cartera') return 'account_balance_wallet';
                      return 'payment';
                    };
                    return (
                      <div key={i} className="w-full">
                        <div className={`rounded-lg border ${fieldErrors['payment_method_'+i]? 'border-[var(--danger-color)]':'border-[var(--border-color)]'} bg-[var(--dark-color)] p-2 flex flex-col gap-2 shadow-sm`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-secondary-color)]">
                              <span className="material-symbols-outlined text-[14px] text-[var(--primary-color)]">payments</span>
                              Pago {i+1}
                            </div>
                            <button className="btn btn-xs btn-danger" onClick={()=> setPayments(ps=> ps.filter((_,idx)=> idx!==i))}><span className="material-symbols-outlined text-[14px]">close</span></button>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <button type="button" onClick={()=> { setMethodPickerIndex(i); setMethodSearch(''); }} className={`flex items-center justify-between w-full sm:w-52 gap-2 px-2 h-10 rounded-md border text-left ${sel? 'border-[var(--primary-color)] bg-[var(--primary-color)]/10':'border-[var(--border-color)] bg-[var(--dark-color)]'} ${fieldErrors['payment_method_'+i]? 'border-[var(--danger-color)]':''}`}> 
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="material-symbols-outlined text-[20px] opacity-80">{methodIcon(sel? sel.name:'')}</span>
                                <span className={`truncate text-[11px] font-medium ${sel? 'text-[var(--text-color)]':'text-[var(--text-secondary-color)]'}`}>{sel? sel.name:'Seleccionar método'}</span>
                              </div>
                              <span className="material-symbols-outlined text-[18px] opacity-60">expand_more</span>
                            </button>
                            <input inputMode="decimal" type="text" pattern="[0-9]*[.,]?[0-9]*" step="0.01" value={p.amount} onChange={e=> { const raw=e.target.value.replace(',', '.'); setPaymentAmount(i, raw=== ''? '': raw); if(fieldErrors['payment_amount_'+i]) setFieldErrors(fe=> { const { ['payment_amount_'+i]:_, ...r}=fe; return r; }); }} onBlur={e=> { if(e.target.value==='') setPaymentAmount(i, 0); }} className={`form-field h-10 w-full sm:w-32 ${fieldErrors['payment_amount_'+i]? 'border-[var(--danger-color)] focus:ring-[var(--danger-color)]':''}`} placeholder="Monto" />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <button className="btn btn-sm btn-outline self-start" onClick={()=> setPayments(ps=> [...ps, { methodId:'', amount:0 }])}><span className="material-symbols-outlined text-sm">add</span>Agregar pago</button>
                  <div className="grid grid-cols-2 gap-2 w-full max-w-xs sm:max-w-sm">
                    <div className={`p-2 rounded-lg border bg-[var(--dark-color)] flex flex-col gap-1 shadow-sm relative overflow-hidden ${(overPaid||fieldErrors.payments_over)? 'border-[var(--danger-color)]':'border-[var(--border-color)]'}`}> 
                      <div className={`absolute inset-0 opacity-10 bg-gradient-to-br pointer-events-none ${overPaid? 'from-[var(--danger-color)]/40':'from-[var(--success-color)]/40'} to-transparent`} />
                      <div className={`flex items-center gap-1 text-[8px] uppercase tracking-wide font-semibold ${overPaid? 'text-[var(--danger-color)]':'text-[var(--text-secondary-color)]'}`}> 
                        <span className={`material-symbols-outlined text-[14px] ${overPaid? 'text-[var(--danger-color)]':'text-[var(--success-color)]'}`}>attach_money</span>
                        Pagado
                      </div>
                      <div className={`text-[12px] font-bold tabular-nums ${overPaid? 'text-[var(--danger-color)]':'text-[var(--success-color)]'}`}>{formatCurrency(paid)}</div>
                      <div className={`text-[9px] ${overPaid? 'text-[var(--danger-color)]':'text-[var(--text-secondary-color)]'}`}>{overPaid? 'Sobra dinero': paid===total? 'Completo':'Parcial'}</div>
                    </div>
                    <div className={`p-2 rounded-lg border ${(fieldErrors.payments_missing)? 'border-[var(--warning-color)]': 'border-[var(--border-color)]'} ${shakePaymentsBox && fieldErrors.payments_missing? 'animate-shake-soft':''} bg-[var(--dark-color)] flex flex-col gap-1 shadow-sm relative overflow-hidden`}>
                      <div className="absolute inset-0 opacity-10 bg-gradient-to-br from-[var(--danger-color)]/40 to-transparent pointer-events-none" />
                      <div className="flex items-center gap-1 text-[8px] uppercase tracking-wide text-[var(--text-secondary-color)] font-semibold">
                        <span className="material-symbols-outlined text-[14px] text-[var(--danger-color)]">hourglass_top</span>
                        Falta
                      </div>
                      <div className={`text-[12px] font-bold tabular-nums ${remaining<=0? 'text-[var(--success-color)]': fieldErrors.payments_missing? 'text-[var(--warning-color)]':'text-[var(--danger-color)]'}`}>{formatCurrency(Math.max(0,remaining))}</div>
                      <div className={`text-[9px] ${remaining<=0? 'text-[var(--text-secondary-color)]': fieldErrors.payments_missing? 'text-[var(--warning-color)]':'text-[var(--text-secondary-color)]'}`}>{remaining<=0? 'OK': fieldErrors.payments_missing? 'Falta':'Pendiente'}</div>
                    </div>
                  </div>
                </div>
                )}
              </div>
              <div>
                {orderStep<3 && (
                  <div className="flex gap-2 flex-wrap">
                    {orderStep>1 && <button type="button" onClick={()=> setOrderStep(orderStep-1)} className="btn btn-soft btn-sm"><span className="material-symbols-outlined text-sm">arrow_back</span>Volver</button>}
                    <button onClick={submit} disabled={preloadingStock || (orderStep===1 && lines.length===0) || (orderStep===2 && overPaid)} className="btn btn-primary btn-sm relative">
                      {preloadingStock? (
                        <span className="flex items-center gap-2">
                          <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                          <span>{orderStep===2? 'Cargando stock':'Procesando'}</span>
                        </span>
                      ): (
                        <span className="flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">{orderStep===1? 'navigate_next': 'navigate_next'}</span>
                          {orderStep===1? 'Continuar': (orderStep===2 && overPaid? 'Ajusta pagos':'Continuar')}
                        </span>
                      )}
                    </button>
                  </div>
                )}
                {orderStep===3 && (
                  <div className="flex flex-col gap-3">
                    <div className="p-2 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] max-h-60 overflow-auto custom-scroll">
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-secondary-color)] mb-1 flex items-center gap-1"><span className="material-symbols-outlined text-[14px] text-[var(--primary-color)]">inventory_2</span>Confirmar stock</div>
                      <table className="w-full text-[10px]">
                        <thead className="text-[var(--text-secondary-color)] text-[9px]">
                          <tr className="text-left">
                            <th className="font-medium py-1 pr-2">Producto</th>
                            <th className="font-medium py-1 pr-2 text-right">Antes</th>
                            <th className="font-medium py-1 pr-2 text-right">Cant</th>
                            <th className="font-medium py-1 pr-2 text-right">Después</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stockPreview?.map(r=> (
                            <tr key={r.productId} className="border-t border-[var(--border-color)]">
                              <td className="py-1 pr-2 max-w-[170px] truncate" title={r.name}>{r.name}</td>
                              <td className="py-1 pr-2 text-right tabular-nums">{r.stockBefore}</td>
                              <td className="py-1 pr-2 text-right tabular-nums">{r.lineQty}</td>
                              <td className={`py-1 pr-2 text-right tabular-nums ${r.stockAfter<0? 'text-[var(--danger-color)] font-semibold':''}`}>{r.stockAfter}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="mt-2 text-[9px] text-[var(--text-secondary-color)]">Revisa cantidades. Si hay negativos se marcarán en rojo.</div>
                    </div>
                    <div className="flex gap-2 flex-wrap items-center">
                      <button type="button" onClick={()=> { if(!submitting){ setOrderStep(2); setStockPreview(null); setCreatingStage(''); } }} className="btn btn-sm btn-soft" disabled={submitting}>
                        <span className="material-symbols-outlined text-sm">arrow_back</span>Volver
                      </button>
            <button type="button" onClick={submit} disabled={submitting || stockShortage} className="btn btn-sm btn-primary relative">
                        {submitting && <span className="absolute inset-0 flex items-center justify-center"><span className="loader-xs" /></span>}
                        <span className={`flex items-center gap-1 ${submitting? 'opacity-0':''}`}>
                          <span className="material-symbols-outlined text-sm">add_shopping_cart</span>
              {submitting? 'Creando...' : 'Confirmar pedido'}
                        </span>
                      </button>
                      {stockShortage && !submitting && (
                        <div className="flex items-center gap-1 text-[10px] text-[var(--danger-color)] mt-1">
                          <span className="material-symbols-outlined text-[14px]">error</span>
                          <span>No se puede confirmar: cantidad supera stock disponible.</span>
                        </div>
                      )}
                      {submitting && (
                        <span className="text-[9px] text-[var(--text-secondary-color)] truncate max-w-[160px]" title={creatingStage}>{creatingStage}</span>
                      )}
                    </div>
                  </div>
                )}
                {orderStep===4 && (
                  <div className="flex flex-col items-center gap-4 sm:gap-6 py-6">
                    {!createdOrderId && (
                      <>
                        <div className="flex flex-col items-center gap-3 w-full">
                          <div className="text-[11px] sm:text-[13px] font-semibold tracking-wide uppercase text-[var(--text-secondary-color)] flex items-center gap-2">
                            <span className="material-symbols-outlined text-[18px] text-[var(--primary-color)]">bolt</span>
                            Creando pedido…
                          </div>
                          <ul className="w-full max-w-xs sm:max-w-sm flex flex-col gap-1 m-0 p-0">
                            {expectedStages.current.map((label,idx)=> {
                              const done = stageHistory.includes(label) && stageHistory[stageHistory.length-1] !== label;
                              const active = stageHistory[stageHistory.length-1] === label;
                              const pending = !done && !active && !stageHistory.includes(label);
                              let icon='radio_button_unchecked';
                              let color='var(--text-secondary-color)';
                              if(done){ icon='check_circle'; color='var(--success-color)'; }
                              else if(active){ icon='progress_activity'; color='var(--primary-color)'; }
                              return (
                                <li key={label} className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-[9px] sm:text-[10px] border ${active? 'border-[var(--primary-color)] bg-[var(--primary-color)]/10': done? 'border-[var(--success-color)] bg-[var(--success-color)]/10':'border-[var(--border-color)] bg-[var(--dark-color)]/40'}`}> 
                                  <span className={`material-symbols-outlined text-[14px] sm:text-[15px] ${active? 'animate-spin-slow':''}`} style={{color}}>{icon}</span>
                                  <span className={`flex-1 leading-snug ${active? 'text-[var(--primary-color)] font-semibold': done? 'text-[var(--success-color)]':'text-[var(--text-secondary-color)]'}`}>{label}</span>
                                  {pending && idx===0 && stageHistory.length===0 && (
                                    <span className="text-[8px] text-[var(--text-secondary-color)]">Esperando…</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      </>
                    )}
                    {createdOrderId && (
                      <div className="flex flex-col items-center gap-4 animate-fade-in">
                        <div className="success-icon-wrapper relative w-20 h-20 sm:w-28 sm:h-28">
                          <div className="absolute inset-0 rounded-full bg-[var(--success-color)]/15 border-2 border-[var(--success-color)]" />
                          <div className="absolute inset-[6px] sm:inset-[10px] rounded-full bg-gradient-to-br from-[var(--success-color)]/20 to-transparent" />
                          <svg viewBox="0 0 64 64" className="relative w-full h-full text-[var(--success-color)]" role="img" aria-label="Pedido creado con éxito">
                            <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="175" className="success-circle" />
                            <path d="M20 33.5 L28 41 L46 23" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="success-check" />
                          </svg>
                        </div>
                        <div className="text-center flex flex-col gap-2">
                          <div className="text-[14px] sm:text-[18px] font-bold text-[var(--success-color)]">Pedido creado</div>
                          <div className="text-[10px] sm:text-[11px] text-[var(--text-secondary-color)] break-words">ID Odoo: {createdOrderId}</div>
                        </div>
                        <div className="w-full max-w-lg border border-[var(--border-color)] rounded-xl bg-[var(--dark-color)] p-4 flex flex-col gap-3 text-[11px] sm:text-[12px] shadow-inner">
                          {!createdOrderData && <div className="flex items-center gap-2 text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span><span>Cargando datos del pedido…</span></div>}
                          {createdOrderData && (
                            <>
                              <div className="flex items-center gap-2 text-[12px] sm:text-[13px] font-semibold text-[var(--text-secondary-color)] uppercase tracking-wide"><span className="material-symbols-outlined text-[18px] text-[var(--primary-color)]">receipt_long</span>Resumen</div>
                              <div className="metric-cards grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                                <div className="metric-card ref-card">
                                  <div className="metric-icon ref"><span className="material-symbols-outlined">tag</span></div>
                                  <div className="metric-label">Referencia</div>
                                  <div className="metric-value break-all leading-snug">{createdOrderData.pos_reference}</div>
                                </div>
                                <div className="metric-card">
                                  <div className="metric-icon total"><span className="material-symbols-outlined">attach_money</span></div>
                                  <div className="metric-label">Total</div>
                                  <div className="metric-value text-[var(--success-color)]">{formatCurrency(createdOrderData.amount_total||0)}</div>
                                </div>
                                <div className="metric-card">
                                  <div className="metric-icon paid"><span className="material-symbols-outlined">payments</span></div>
                                  <div className="metric-label">Pagado</div>
                                  <div className="metric-value">{formatCurrency(createdOrderData.amount_paid||0)}</div>
                                </div>
                                <div className="metric-card">
                                  <div className="metric-icon state"><span className="material-symbols-outlined">verified</span></div>
                                  <div className="metric-label">Estado</div>
                                  <div className="metric-value capitalize">{createdOrderData.state||'?'}</div>
                                </div>
                              </div>
                              {createdOrderLines && createdOrderLines.length>0 && (
                                <div className="flex flex-col gap-2 mt-2">
                                  <div className="text-[12px] font-semibold text-[var(--text-secondary-color)] uppercase tracking-wide flex items-center gap-1"><span className="material-symbols-outlined text-[18px] text-[var(--primary-color)]">list</span>Líneas</div>
                                  {/* Vista mobile: cards */}
                                  <div className="flex flex-col gap-2 sm:hidden">
                                    {createdOrderLines.map(l=> (
                                      <div key={l.id} className="p-2 rounded-lg border border-[var(--border-color)] bg-[var(--card-color)] flex flex-col gap-1">
                                        <div className="text-[11px] font-medium leading-snug break-words">{l.full_product_name || l.product_id?.[1]}</div>
                                        <div className="flex items-center justify-between text-[10px]">
                                          <span className="opacity-70">Cant: <span className="font-semibold tabular-nums">{l.qty}</span></span>
                                          <span className="font-semibold tabular-nums">{formatCurrency(l.price_subtotal_incl||l.price_subtotal||0)}</span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  {/* Vista desktop: tabla */}
                                  <div className="hidden sm:block max-h-56 overflow-auto custom-scroll border border-[var(--border-color)] rounded">
                                    <table className="w-full text-[10px]">
                                      <thead className="bg-[var(--card-color)] text-[var(--text-secondary-color)]">
                                        <tr className="text-left">
                                          <th className="py-1.5 px-2 font-medium">Producto</th>
                                          <th className="py-1.5 px-2 font-medium text-right">Cant</th>
                                          <th className="py-1.5 px-2 font-medium text-right">Subtotal</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {createdOrderLines.map(l=> (
                                          <tr key={l.id} className="border-t border-[var(--border-color)]">
                                            <td className="py-1 px-2 max-w-[220px] truncate" title={l.full_product_name || l.product_id?.[1]}>{l.full_product_name || l.product_id?.[1]}</td>
                                            <td className="py-1 px-2 text-right tabular-nums">{l.qty}</td>
                                            <td className="py-1 px-2 text-right tabular-nums">{formatCurrency(l.price_subtotal_incl||l.price_subtotal||0)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        <div className="flex gap-2 pt-2">
                          <button className="btn btn-sm btn-primary" onClick={()=> { // reset wizard
                            setLines([]); setPayments([]); setClient(''); setOrderStep(1); setStageHistory([]); setCreatingStage(''); setCreatedOrderId(null); setCreatedOrderData(null); setCreatedOrderLines(null); setStockPreview(null); pushToast('Listo para nuevo pedido','info');
                          }}>Nuevo pedido</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Bottom sheet métodos de pago */}
                {methodPickerIndex!==null && orderStep===2 && (
                  <div className="pay-sheet-backdrop" onClick={(e)=> { if(e.target===e.currentTarget) setMethodPickerIndex(null); }}>
                    <div className="pay-sheet" role="dialog" aria-modal="true">
                      <div className="pay-sheet-header">
                        <div className="pay-sheet-drag" />
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-[18px] text-[var(--primary-color)]">payments</span>
                          <span className="text-[12px] font-semibold tracking-wide uppercase text-[var(--text-secondary-color)]">Métodos de pago</span>
                          <button className="ml-auto btn btn-xs btn-soft" onClick={()=> setMethodPickerIndex(null)}>
                            <span className="material-symbols-outlined text-[16px]">close</span>
                          </button>
                        </div>
                        <div className="pay-sheet-search">
                          <span className="material-symbols-outlined text-[18px] opacity-60">search</span>
                          <input autoFocus value={methodSearch} onChange={e=> setMethodSearch(e.target.value)} placeholder="Buscar" className="bg-transparent outline-none text-[12px] flex-1" />
                          {methodSearch && <button onClick={()=> setMethodSearch('')} className="text-[10px] opacity-70 hover:opacity-100">Limpiar</button>}
                        </div>
                      </div>
                      <div className="pay-sheet-list custom-scroll">
                        {paymentMethods.filter(m=> m.name.toLowerCase().includes(methodSearch.toLowerCase())).map(m=> {
                          const active = payments[methodPickerIndex]?.methodId===m.id;
                          const icon = (()=> { const n=m.name.toLowerCase(); if(n.includes('efec')||n.includes('cash')) return 'payments'; if(n.includes('tarj')||n.includes('card')||n.includes('deb')) return 'credit_card'; if(n.includes('trans')||n.includes('tran')||n.includes('dep')||n.includes('bank')) return 'account_balance'; if(n.includes('zelle')||n.includes('paypal')) return 'account_balance_wallet'; if(n.includes('mercado')||n.includes('mp')||n.includes('qr')) return 'qr_code_2'; return 'payments'; })();
                          return (
                            <div key={m.id} className={`pay-method-item ${active? 'active':''}`} onClick={()=> { setPayments(ps=> ps.map((pp,idx)=> idx===methodPickerIndex? { ...pp, methodId:m.id }:pp)); if(fieldErrors['payment_method_'+methodPickerIndex]) setFieldErrors(fe=> { const { ['payment_method_'+methodPickerIndex]:_, ...r}=fe; return r; }); setMethodPickerIndex(null); }}>
                              <span className="material-symbols-outlined icon">{icon}</span>
                              <span className="pay-method-name">{m.name}</span>
                              {active && <span className="material-symbols-outlined text-[18px]">check</span>}
                            </div>
                          );
                        })}
                        {paymentMethods.length===0 && <div className="text-[11px] text-[var(--text-secondary-color)] py-4 text-center">Sin métodos configurados</div>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {error && <div className="text-[var(--danger-color)] text-[10px]">{error}</div>}
              {info && <div className="text-[var(--success-color)] text-[10px]">{info}</div>}
            </div>
          </div>

          {/* Pedidos recientes */}
          <div className="p-4 rounded-xl border border-[var(--border-color)] bg-[var(--card-color)]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="m-0 font-heading font-bold text-sm uppercase tracking-wider text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-base text-[var(--primary-color)]">view_list</span>Pedidos recientes</h2>
              <button onClick={()=> refreshOrders()} className="btn btn-sm btn-soft"><span className="material-symbols-outlined text-sm">refresh</span></button>
            </div>
            {/* Filtros mobile-first */}
            <div className="mb-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* Año / Mes siempre visibles y separados */}
                <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-[var(--dark-color)] border border-[var(--border-color)]">
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)]">Año</span>
                    <select value={fYear} onChange={e=> { const val=e.target.value; if(!val){ pushToast('Debe haber un año.','warning'); return;} setFYear(val); setApFYear(val); }} className="bg-transparent text-[11px] outline-none">
                      {yearOptions.length===0 && <option value={fYear}>{fYear}</option>}
                      {yearOptions.map(y=> <option key={y} value={y}>{y}</option>)}
                    </select>
                  </div>
                  <div className="h-4 w-px bg-[var(--border-color)]" />
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)]">Mes</span>
                    <select value={fMonth} onChange={e=> { const val=e.target.value; if(!val){ pushToast('Debe elegir un mes.','warning'); return;} setFMonth(val); setApFMonth(val); }} className="bg-transparent text-[11px] outline-none">
                      {[
                        ['01','Ene'],['02','Feb'],['03','Mar'],['04','Abr'],['05','May'],['06','Jun'],['07','Jul'],['08','Ago'],['09','Sep'],['10','Oct'],['11','Nov'],['12','Dic']
                      ].map(m=> <option key={m[0]} value={m[0]}>{m[1]}</option>)}
                    </select>
                  </div>
                </div>
                <button type="button" onClick={()=> setShowFilters(o=>!o)} className="btn btn-xs btn-soft inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">{showFilters? 'expand_less':'filter_list'}</span>
                  Más filtros {activeFilters.filter(f=> f.k!=='fYear' && f.k!=='fMonth').length>0 && (
                    <span className="ml-1 px-1 rounded bg-[var(--primary-color)] text-white text-[10px] leading-none">{activeFilters.filter(f=> f.k!=='fYear' && f.k!=='fMonth').length}</span>
                  )}
                </button>
                {activeFilters.filter(f=> f.k!=='fYear' && f.k!=='fMonth').map(f=> (
                  <span key={f.k + (f.sub||'')} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--dark-color)] border border-[var(--border-color)] text-[10px]">
                    <span className="opacity-70">{f.label}:</span><span className="font-semibold truncate max-w-[80px]">{f.value}</span>
                    <button onClick={()=>{
                      // Limpiar filtro en edición y aplicado
                      if(f.k==='fNota'){ setFNota(''); setApFNota(''); }
                      if(f.k==='fProductoIds'){
                        setFProductoIds(ids=> ids.filter(id=> id!==f.sub));
                        setApFProductoIds(ids=> ids.filter(id=> id!==f.sub));
                      }
                      if(f.k==='fMetodoId'){ setFMetodoId(''); setApFMetodoId(''); }
                      if(f.k==='fTotal'){ setFTotal(''); setApFTotal(''); }
                      if(f.k==='fDesde'){ setFDesde(''); setApFDesde(''); }
                      if(f.k==='fHasta'){ setFHasta(''); setApFHasta(''); }
                      // Refrescar pedidos luego de limpiar
                      setTimeout(()=> { try { refreshOrders(); } catch(_){} }, 0);
                    }} className="ml-0.5 text-[var(--text-secondary-color)] hover:text-[var(--danger-color)]">
                      <span className="material-symbols-outlined text-[13px] leading-none">close</span>
                    </button>
                  </span>
                ))}
              </div>
              {showFilters && (
                <div className="p-3 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] flex flex-col gap-4 animate-fade-in">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                    {/* Año y Mes removidos de este panel */}
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)]">Cliente</label>
                      <input value={fNota} onChange={e=> setFNota(e.target.value)} placeholder="Nombre cliente" className="form-field h-8 text-[11px]" />
                    </div>
                    <div className="flex flex-col gap-1 relative" ref={prodDropdownRef}>
                      <label className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)]">Productos (multi)</label>
                      <button type="button" onClick={()=> setOpenFiltroProductos(o=> { const nv=!o; if(nv){ setOpenFiltroMetodo(false);} return nv; })} className={`form-field h-8 text-[11px] flex items-center justify-between px-2 border border-[var(--border-color)] ${fProductoIds.length? 'text-[var(--text-color)]':'text-[var(--text-secondary-color)]'}`}> 
                        <span className="truncate">
                          {fProductoIds.length===0 && 'Seleccionar'}
                          {fProductoIds.length===1 && (productsFilter.find(p=> p.id===fProductoIds[0])?.name || '1 seleccionado')}
                          {fProductoIds.length>1 && `${fProductoIds.length} seleccionados`}
                        </span>
                        <span className="material-symbols-outlined text-[16px] opacity-60">expand_more</span>
                      </button>
                      {openFiltroProductos && (
                        <div className="absolute z-40 left-0 top-full mt-1 w-64 max-w-[80vw] border border-[var(--border-color)] rounded-md bg-[var(--card-color)] shadow-soft text-[11px] flex flex-col">
                          <div className="p-1 border-b border-[var(--border-color)] bg-[var(--dark-color)] sticky top-0">
                            <input autoFocus value={fProductoSearch} onChange={e=> setFProductoSearch(e.target.value)} placeholder="Buscar..." className="w-full bg-transparent outline-none px-2 py-1 rounded text-[11px] border border-[var(--border-color)]" />
                          </div>
                          <div className="max-h-52 overflow-auto custom-scroll divide-y divide-[var(--border-color)]">
                            {productsFilter.filter(p=> !fProductoSearch.trim() || p.name.toLowerCase().includes(fProductoSearch.toLowerCase())).map(p=> {
                              const checked = fProductoIds.includes(p.id);
                              return (
                                <button key={p.id} onClick={()=> setFProductoIds(ids=> checked? ids.filter(id=> id!==p.id): [...ids,p.id])} className={`w-full text-left px-2 py-1 flex items-center gap-2 hover:bg-[var(--dark-color)] ${checked? 'bg-[var(--primary-color)]/15':''}`}>
                                  <span className={`material-symbols-outlined text-[16px] ${checked? 'text-[var(--primary-color)]':'opacity-0'}`}>check</span>
                                  <span className="truncate flex-1">{p.name}</span>
                                </button>
                              );
                            })}
                            {productsFilter.length===0 && <div className="px-2 py-2 text-[10px] text-[var(--text-secondary-color)]">Cargando…</div>}
                            {productsFilter.length>0 && productsFilter.filter(p=> !fProductoSearch.trim() || p.name.toLowerCase().includes(fProductoSearch.toLowerCase())).length===0 && (
                              <div className="px-2 py-2 text-[10px] text-[var(--text-secondary-color)]">Sin coincidencias</div>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2 p-1 border-t border-[var(--border-color)] bg-[var(--dark-color)]">
                            <button onClick={()=> { setFProductoIds([]); }} className="btn btn-xs btn-soft"><span className="material-symbols-outlined text-[14px]">close</span>Limpiar</button>
                            <button onClick={()=> setOpenFiltroProductos(false)} className="btn btn-xs btn-primary"><span className="material-symbols-outlined text-[14px]">check</span>Ok</button>
                          </div>
                        </div>
                      )}
                      {fProductoIds.length>0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {fProductoIds.map(pid=> {
                            const prod = productsFilter.find(p=> p.id===pid);
                            return (
                              <span key={pid} className="px-1.5 py-0.5 bg-[var(--primary-color)]/15 text-[9px] rounded flex items-center gap-1 border border-[var(--border-color)]">
                                <span className="truncate max-w-[70px]">{prod? prod.name: pid}</span>
                                <button onClick={()=> setFProductoIds(ids=> ids.filter(id=> id!==pid))} className="text-[var(--primary-color)] hover:text-[var(--danger-color)]">
                                  <span className="material-symbols-outlined text-[12px] leading-none">close</span>
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 relative">
                      <label className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)]">Método de pago</label>
                      <button type="button" onClick={()=> setOpenFiltroMetodo(o=> { const nv=!o; if(nv){ setOpenFiltroProductos(false);} return nv; })} className={`form-field h-8 text-[11px] flex items-center justify-between px-2 border border-[var(--border-color)] ${fMetodoId? 'text-[var(--text-color)]':'text-[var(--text-secondary-color)]'}`}> 
                        <span className="truncate">{fMetodoId? (paymentMethods.find(m=> m.id===Number(fMetodoId))?.name || fMetodoId): 'Todos'}</span>
                        <span className="material-symbols-outlined text-[16px] opacity-60">expand_more</span>
                      </button>
                      {openFiltroMetodo && (
                        <div className="absolute z-40 left-0 top-full mt-1 w-full max-h-56 overflow-auto border border-[var(--border-color)] rounded-md bg-[var(--card-color)] shadow-soft text-[11px] custom-scroll divide-y divide-[var(--border-color)]">
                          <button onClick={()=> { setFMetodoId(''); setOpenFiltroMetodo(false); }} className={`w-full text-left px-2 py-1 hover:bg-[var(--dark-color)] ${!fMetodoId? 'bg-[var(--primary-color)]/20':''}`}>Todos</button>
                          {paymentMethods.map(m=> (
                            <button key={m.id} onClick={()=> { setFMetodoId(String(m.id)); setOpenFiltroMetodo(false); }} className={`w-full text-left px-2 py-1 hover:bg-[var(--dark-color)] flex items-center gap-1 ${String(fMetodoId)===String(m.id)? 'bg-[var(--primary-color)]/20':''}`}>
                              {String(fMetodoId)===String(m.id) && <span className="material-symbols-outlined text-[14px] text-[var(--primary-color)]">check</span>}
                              <span className="truncate">{m.name}</span>
                            </button>
                          ))}
                          {paymentMethods.length===0 && <div className="px-2 py-1 text-[10px] text-[var(--text-secondary-color)]">Sin métodos</div>}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)]">Total factura</label>
                      <input value={fTotal} onChange={e=> setFTotal(e.target.value)} placeholder="Ej: $5.000.000" className="form-field h-8 text-[11px]" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] uppercase tracking-wide text-[var(--text-secondary-color)]">Desde / Hasta</label>
                      <div className="flex items-center gap-2">
                        <input type="date" value={fDesde} onChange={e=> setFDesde(e.target.value)} className="form-field h-8 text-[11px]" />
                        <input type="date" value={fHasta} onChange={e=> setFHasta(e.target.value)} className="form-field h-8 text-[11px]" />
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={()=> { setApFNota(fNota); setApFProductoIds(fProductoIds); setApFMetodoId(fMetodoId); setApFTotal(fTotal); setApFDesde(fDesde); setApFHasta(fHasta); setApFYear(fYear); setApFMonth(fMonth); setShowFilters(false); refreshOrders(); }} className="btn btn-xs btn-soft"><span className="material-symbols-outlined text-[14px]">check</span>Aplicar</button>
                    <button onClick={()=>{ setFNota(''); setFProductoIds([]); setFMetodoId(''); setFTotal(''); setFDesde(''); setFHasta(''); setApFNota(''); setApFProductoIds([]); setApFMetodoId(''); setApFTotal(''); setApFDesde(''); setApFHasta(''); /* mantener año/mes */ setApFYear(fYear); setApFMonth(fMonth); refreshOrders(); pushToast('Filtros limpiados (Año/Mes preservados).','info'); }} className="btn btn-xs btn-outline"><span className="material-symbols-outlined text-[14px]">filter_alt_off</span>Limpiar</button>
                  </div>
                </div>
              )}
            </div>
            {ordersLoading && <div className="text-[10px] text-[var(--text-secondary-color)]">Cargando…</div>}
            <div className="max-h-96 overflow-auto text-[11px] flex flex-col gap-4 pr-1">
              {groupedVisibleOrders.map(g=> {
                const dayStr = g.day; // YYYY-MM-DD
                let label = dayStr;
                if(/\d{4}-\d{2}-\d{2}/.test(dayStr)){
                  const [y,m,d] = dayStr.split('-').map(Number);
                  const dateObj = new Date(y, m-1, d);
                  const today = new Date();
                  const yest = new Date(); yest.setDate(today.getDate()-1);
                  function same(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
                  const wd = dateObj.toLocaleString('es',{ weekday:'long'}); // martes
                  const mn = dateObj.toLocaleString('es',{ month:'long'}); // septiembre
                  const base = `${wd}, ${d} ${mn} ${y}`;
                  if(same(dateObj,today)) label = `hoy ${base}`;
                  else if(same(dateObj,yest)) label = `ayer ${base}`;
                  else label = base;
                }
                return (
                  <div key={g.day} className="flex flex-col gap-2">
                    <div className="sticky top-0 -mt-1 pt-1 z-10">
                      <div className="px-2 py-1 rounded-md bg-[var(--card-color)]/80 backdrop-blur border border-[var(--border-color)] text-[9px] font-semibold text-[var(--text-secondary-color)] flex items-center gap-2">
                        <span className="material-symbols-outlined text-[12px] text-[var(--primary-color)]">calendar_today</span>
                        <span className="truncate capitalize">{label}</span>
                        <span className="ml-auto text-[8px] font-normal opacity-70">{g.orders.length} pedido{g.orders.length!==1?'s':''}</span>
                      </div>
                    </div>
                  {g.orders.map(o=> {
                const dt = parseOdooDate(o.date_order);
                const clienteNote = typeof o.note === 'string' ? o.note.replace('Cliente:','Cliente: ').trim() : '';
                const det = orderDetails[o.id];
                const isOpen = expanded===o.id;
                const orderMeta = (()=>{ 
                  if(!o.name) return { number:'', refund:false };
                  const idx = o.name.indexOf('POS/');
                  let rest = idx>=0? o.name.slice(idx+4).trim(): o.name; // ejemplo: 0000 o 0000REEMBOLSO
                  const refund = /REEMBOLSO$/i.test(rest);
                  if(refund){
                    rest = rest.replace(/REEMBOLSO$/,'').trim();
                  }
                  return { number: rest, refund };
                })();
                const displayRef = (o.pos_reference ?? orderMeta.number);
                const rawCliente = clienteNote.replace(/^Cliente:\s*/i,'').trim();
                const hasCliente = rawCliente && !/^\(?sin nombre\)?$/i.test(rawCliente) && !/^cliente:?$/i.test(rawCliente);
                const clienteDisplay = hasCliente? rawCliente : 'Sin cliente';
                return (
                  <div key={o.id} className="p-2 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)] flex flex-col gap-2 shadow-sm">
                    <button onClick={()=> toggleExpand(o)} className="flex items-center justify-between text-left gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className={`material-symbols-outlined flex-shrink-0 text-[16px] rounded-full p-1 ${isOpen? 'bg-[var(--primary-color)]/15 text-[var(--primary-color)]':'bg-[var(--dark-color)]/60 text-[var(--text-secondary-color)]'} transition-colors`}>{isOpen? 'expand_less':'expand_more'}</span>
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center gap-1 text-[10px]">
                            <span className="material-symbols-outlined text-[14px] text-[var(--primary-color)]">confirmation_number</span>
                            <span className="font-semibold truncate max-w-[120px]">{displayRef}</span>
                            {orderMeta.refund && (
                              <span className="px-1.5 py-0.5 rounded-md text-[8px] font-semibold bg-[var(--danger-color)] text-white tracking-wide">REEMBOLSO</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[9px] text-[var(--text-secondary-color)]">
                            <span className="inline-flex items-center gap-1 truncate max-w-[180px]">
                              <span className="material-symbols-outlined text-[12px] opacity-70">person</span>
                              <span className={`truncate ${!hasCliente? 'italic opacity-70':''}`}>{clienteDisplay}</span>
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-[10px] font-semibold text-[var(--primary-color)] tabular-nums">{formatCurrency(o.amount_total)}</span>
                        <span className="text-[8px] uppercase tracking-wide text-[var(--text-secondary-color)]">
                          {dt ? (()=> { const d=dt.getDate(); const m=dt.toLocaleString('es',{month:'short'}).replace('.',''); const y=dt.getFullYear(); return `${d} ${m.toUpperCase()} ${y}`; })() : (()=> { const raw=o.date_order?.slice(0,10); if(!raw) return ''; const [Y,M,D]=raw.split('-'); const temp=new Date(Number(Y),Number(M)-1,Number(D)); const m=temp.toLocaleString('es',{month:'short'}).replace('.',''); return `${Number(D)} ${m.toUpperCase()} ${Y}`; })()}
                        </span>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="mt-2 p-2 rounded-lg border border-[var(--border-color)] bg-[var(--card-color)] flex flex-col gap-2">
                        {(!det || det.loading) && <div className="text-[10px] flex items-center gap-1 text-[var(--text-secondary-color)]"><span className="material-symbols-outlined text-[12px] animate-spin">progress_activity</span>Cargando detalles…</div>}
                        {det?.error && <div className="text-[10px] text-[var(--danger-color)]">{det.error}</div>}
                        {det && !det.loading && !det.error && (
                          <>
                            {/* Líneas */}
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center justify-between">
                                <div className="text-[9px] uppercase tracking-wider text-[var(--text-secondary-color)] font-semibold">Líneas</div>
                                <div className="text-[8px] text-[var(--text-secondary-color)]">{det.lines.length} items</div>
                              </div>
                              {det.lines.length>0 ? (
                                <div className="rounded-lg border border-[var(--border-color)] overflow-hidden">
                                  <div className="px-3 py-1 bg-[var(--dark-color)]/60 text-[8.5px] font-semibold tracking-wide text-[var(--text-secondary-color)] uppercase flex justify-between">
                                    <span className="flex-1">Producto y detalles</span>
                                    <span className="w-24 text-right pr-1">Subtotal</span>
                                  </div>
                                  <div className="max-h-52 overflow-auto custom-scroll divide-y divide-[var(--border-color)]">
                                    {det.lines.map((l,i)=> {
                                      const prod = Array.isArray(l.product_id)? l.product_id[1]: l.product_id;
                                      const subtotal = l.qty*l.price_unit;
                                      return (
                                        <div key={l.id} className={`px-3 py-2 text-[10px] ${i%2? 'bg-[var(--dark-color)]/25':'bg-transparent'}`}> 
                                          <div className="font-medium leading-snug break-words whitespace-pre-wrap">{prod}</div>
                                          <div className="mt-1 flex items-center gap-3 flex-wrap text-[9px] text-[var(--text-secondary-color)]">
                                            <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[11px] opacity-60">format_list_numbered</span><span className="uppercase tracking-wide">Cant:</span><span className="font-semibold text-[var(--text-color)] tabular-nums">{l.qty}</span></span>
                                            <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[11px] opacity-60">sell</span><span className="uppercase tracking-wide">Precio:</span><span className="font-semibold text-[var(--text-color)] tabular-nums">{formatCurrency(l.price_unit)}</span></span>
                                            <span className="ml-auto inline-flex items-center gap-1"><span className="uppercase tracking-wide opacity-70">Subtot:</span><span className="font-bold text-[var(--primary-color)] tabular-nums">{formatCurrency(subtotal)}</span></span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <div className="px-3 py-2 bg-[var(--dark-color)]/60 text-[9px] font-semibold border-t border-[var(--border-color)] flex justify-between items-center">
                                    <span className="opacity-70 uppercase tracking-wide">Total</span>
                                    <span className="text-[var(--primary-color)] text-[11px]">{formatCurrency(o.amount_total)}</span>
                                  </div>
                                </div>
                              ) : (
                                <div className="text-[9px] text-[var(--text-secondary-color)] italic">Sin líneas</div>
                              )}
                            </div>
                            {/* Pagos */}
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center justify-between">
                                <div className="text-[9px] uppercase tracking-wider text-[var(--text-secondary-color)] font-semibold">Pagos</div>
                                <div className="text-[8px] text-[var(--text-secondary-color)]">{det.payments.length}</div>
                              </div>
                              {det.payments.length>0 ? (
                                <div className="rounded-lg border border-[var(--border-color)] overflow-hidden">
                                  <div className="grid grid-cols-[1fr_80px] px-2 py-1 bg-[var(--dark-color)]/60 text-[8.5px] font-semibold tracking-wide text-[var(--text-secondary-color)] uppercase">
                                    <div>Método</div>
                                    <div className="text-right">Monto</div>
                                  </div>
                                  <div className="max-h-40 overflow-auto custom-scroll">
                                    {det.payments.map((p,i)=> {
                                      const method = Array.isArray(p.payment_method_id)? p.payment_method_id[1]: p.payment_method_id;
                                      return (
                                        <div key={p.id} className={`grid grid-cols-[1fr_80px] px-2 py-1 text-[10px] items-center ${i%2? 'bg-[var(--dark-color)]/30':'bg-transparent'}`}>
                                          <div className="truncate pr-2">{method}</div>
                                          <div className="text-right font-semibold text-[var(--success-color)] tabular-nums">{formatCurrency(p.amount)}</div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <div className="grid grid-cols-[1fr_80px] px-2 py-1 bg-[var(--dark-color)]/60 text-[9px] font-semibold border-t border-[var(--border-color)]">
                                    <div className="opacity-70">Pagado</div>
                                    <div className="text-right text-[var(--success-color)]">{formatCurrency(o.amount_paid)}</div>
                                  </div>
                                </div>
                              ) : (
                                <div className="text-[9px] text-[var(--text-secondary-color)] italic">Sin pagos</div>
                              )}
                              <div className="grid grid-cols-3 gap-2 text-[9px] mt-1">
                                <div className="p-2 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)]/40 flex flex-col gap-0.5">
                                  <span className="uppercase tracking-wide font-semibold text-[var(--text-secondary-color)]">Total</span>
                                  <span className="font-bold text-[var(--primary-color)] text-[11px]">{formatCurrency(o.amount_total)}</span>
                                </div>
                                <div className="p-2 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)]/40 flex flex-col gap-0.5">
                                  <span className="uppercase tracking-wide font-semibold text-[var(--text-secondary-color)]">Pagado</span>
                                  <span className="font-bold text-[var(--success-color)] text-[11px]">{formatCurrency(o.amount_paid)}</span>
                                </div>
                                <div className="p-2 rounded-lg border border-[var(--border-color)] bg-[var(--dark-color)]/40 flex flex-col gap-0.5">
                                  <span className="uppercase tracking-wide font-semibold text-[var(--text-secondary-color)]">Pendiente</span>
                                  <span className="font-bold text-[var(--danger-color)] text-[11px]">{formatCurrency(Math.max(0,o.amount_total - o.amount_paid))}</span>
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ); })}
                </div>
              ); })}
              {!ordersLoading && filteredOrders.length===0 && <div className="text-[10px] text-[var(--text-secondary-color)]">Sin pedidos</div>}
              {filteredOrders.length>visibleOrders.length && (
                <div className="pt-1">
                  <button onClick={()=> setVisibleCount(c=> Math.min(c+20, filteredOrders.length))} className="btn btn-xs btn-outline w-full">
                    <span className="material-symbols-outlined text-[14px]">expand_more</span>
                    Mostrar más ({filteredOrders.length - visibleOrders.length} restantes)
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Sesión */}
          <div className="p-4 rounded-xl border border-[var(--border-color)] bg-[var(--card-color)] text-[11px]">
            <h2 className="m-0 mb-2 font-heading font-bold text-xs uppercase tracking-wider text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-base text-[var(--primary-color)]">info</span>Sesión</h2>
            <div><span className="text-[var(--text-secondary-color)]">Sesión:</span> <span className="font-semibold">{session.name}</span></div>
            <div><span className="text-[var(--text-secondary-color)]">Config:</span> <span className="font-semibold">{Array.isArray(session.config_id)? session.config_id[1]: session.config_id}</span></div>
            <div><span className="text-[var(--text-secondary-color)]">Inicio:</span> <span className="font-semibold">{session.start_at}</span></div>
          </div>
        </div>
      )}
      {/* cierre condicional session */}
    </div>
  );
}
