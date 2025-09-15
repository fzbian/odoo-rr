import React, { useEffect, useState, useCallback, useRef } from 'react';
import { applyPageMeta } from './lib/meta';
import { useAuth } from './context/AuthContext';
import SessionBanner from './components/SessionBanner';
import { sendWhatsAppMessage, NUMBER_TRASPASOS, bold } from './lib/notify';
import './App.css';
import './index.css';

function formatQty(n){
  if(!Number.isFinite(n)) return '—';
  const v=Number(n); const isInt=Math.abs(v-Math.round(v))<1e-9;
  return new Intl.NumberFormat('es-ES',{minimumFractionDigits:0,maximumFractionDigits:isInt?0:2}).format(v);
}

export default function DamagedPage(){
  useEffect(()=> { applyPageMeta({ title: 'Averiados', favicon: '/logo192.png' }); }, []);
  const { auth, executeKwSilent, executeKw } = useAuth();
  const canAccess = auth?.employee && auth?.isDeveloper; // Department Administration
  const [damagedLocId, setDamagedLocId] = useState(null); // id de ubicación averiados derivado de quants
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]); // {id,name,default_code,qty}
  const [error, setError] = useState('');
  const [scrapMap, setScrapMap] = useState({}); // id -> {qty:'', loading:false}
  const [info, setInfo] = useState('');
  const [confirm, setConfirm] = useState(null); // { product, qty }
  const [scrapProcessing, setScrapProcessing] = useState(false);
  const didInitRef = useRef(false); // prevenir doble llamada inicial (StrictMode)

  // ÚNICA petición: stock.quant filtrando ubicaciones "aver" o "AVE/Stock" y agregando por producto.
  const fetchDamaged = useCallback(async ()=>{
    setLoading(true); setError(''); setInfo('');
    try {
      // Única llamada: quants con join product y location para filtrar por nombre de location en domain relacional.
      // Odoo permite domain sobre campos relacionales usando notación dot (location_id.complete_name)
      const quants = await executeKwSilent({
        model:'stock.quant',
        method:'search_read',
        params:[[
          ['quantity','>',0],
          '|', ['location_id.complete_name','ilike','averi'], ['location_id.complete_name','ilike','AVE/Stock']
        ], ['product_id','quantity','location_id']],
        kwargs:{ limit:20000 }
      });
      if(!quants.length){ setProducts([]); setLoading(false); return; }
      // Agregamos por producto y a la vez agregamos totales por location para elegir la principal (mayor qty total)
      const prodAgg = new Map(); // pid -> {qty, name, code}
      const locAgg = new Map(); // locId -> total qty
      quants.forEach(q=>{
        const pid = Array.isArray(q.product_id)? q.product_id[0]: q.product_id;
        const pname = Array.isArray(q.product_id)? q.product_id[1]: '';
        const locId = Array.isArray(q.location_id)? q.location_id[0]: q.location_id;
        const locQtyPrev = locAgg.get(locId)||0; locAgg.set(locId, locQtyPrev + Number(q.quantity||0));
        const prev = prodAgg.get(pid) || { qty:0, name:pname, code: (pname.match(/^\s*\[([^\]]+)\]/)?.[1] || '') };
        prev.qty += Number(q.quantity||0);
        prodAgg.set(pid, prev);
      });
      // damagedLocId: location con mayor qty agregada
      let topLoc = null; let topQty = -1;
      locAgg.forEach((v,k)=>{ if(v>topQty){ topQty=v; topLoc=k; } });
      setDamagedLocId(topLoc);
      const list = Array.from(prodAgg.entries()).map(([id, o])=>{
        const cleaned = o.name.replace(/^\s*\[[^\]]+\]\s*/,'');
        return { id, name:cleaned, fullName:o.name, default_code:o.code, qty:Number(o.qty.toFixed(2)) };
      }).filter(p=>p.qty>0).sort((a,b)=>{
        const ra=(a.default_code||'').trim(); const rb=(b.default_code||'').trim();
        if(!ra && !rb) return a.name.localeCompare(b.name);
        if(!ra) return 1; if(!rb) return -1;
        const segA = ra.split(/\D+/).filter(Boolean).map(n=>parseInt(n,10));
        const segB = rb.split(/\D+/).filter(Boolean).map(n=>parseInt(n,10));
        const len=Math.max(segA.length,segB.length);
        for(let i=0;i<len;i++){ const va=segA[i]??-1; const vb=segB[i]??-1; if(va!==vb) return va-vb; }
        const cmp=ra.localeCompare(rb, undefined,{numeric:true,sensitivity:'base'}); if(cmp!==0) return cmp;
        return a.name.localeCompare(b.name);
      });
      setProducts(list);
    } catch(e){ setError(e.message); }
    finally { setLoading(false); }
  }, [executeKwSilent]);

  useEffect(()=>{
    if(didInitRef.current) return;
    didInitRef.current=true;
    fetchDamaged();
  }, [fetchDamaged]);

  function updateScrap(id, patch){
    setScrapMap(m => ({ ...m, [id]: { ...(m[id]||{ qty:'' }), ...patch } }));
  }

  async function scrapProductConfirmed(product, qty){
    setScrapProcessing(true);
    try {
      // Intentar localizar ubicación de descarte (scrap) si existe (usage = inventory y nombre ilike 'Scrap')
      let scrapLoc = null;
      try {
        const s = await executeKwSilent({ model:'stock.location', method:'search_read', params:[[['scrap_location','=',true]], ['id']], kwargs:{ limit:1 } });
        if (s && s.length) scrapLoc = s[0];
      } catch(_){}
  const scrapVals = { product_id:product.id, scrap_qty:qty, location_id:damagedLocId, ...(scrapLoc? { scrap_location_id: scrapLoc.id }: {}) };
      const scrapId = await executeKw({ model:'stock.scrap', method:'create', params:[scrapVals], activity:'Creando descarte...' });
      await executeKw({ model:'stock.scrap', method:'action_validate', params:[[scrapId]], activity:'Validando descarte...' });
  // Ajuste local inmediato (sin esperar releer)
  setProducts(ps => ps.map(x => x.id===product.id? { ...x, qty: Number((x.qty - qty).toFixed(2)) }: x).filter(x=>x.qty>0));
  setInfo(`Producto ${product.name} reducido en ${qty}.`);
      try {
        const msg = [
          '♻️ *Salida de Averiados*',
          `${bold('Producto')}: ${product.name}`,
          `${bold('Cantidad')}: ${formatQty(qty)}`
        ].join('\n');
        if(NUMBER_TRASPASOS) sendWhatsAppMessage({ number: NUMBER_TRASPASOS, text: msg });
      } catch(_){ }
      updateScrap(product.id,{ qty:'' });
      setConfirm(null);
    } catch(e){
      updateScrap(product.id,{ error:e.message });
    } finally {
      setScrapProcessing(false);
    }
  }

  function openConfirm(p){
    const entry = scrapMap[p.id]||{};
    const qty = Number(entry.qty);
    if(!qty || qty<=0) { updateScrap(p.id,{ error:'Cantidad inválida'}); return; }
    if(qty>p.qty){ updateScrap(p.id,{ error:'Cantidad mayor que stock'}); return; }
    setConfirm({ product:p, qty });
  }

  if(!canAccess){
    return (
      <div className="p-6 max-w-xl mx-auto">
        <SessionBanner />
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
    <div className="max-w-5xl mx-auto p-6">
      <SessionBanner />
      <section className="flex items-center gap-5 p-6 border border-[var(--border-color)] rounded-2xl shadow-soft mb-4" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }}>
        <img src="/logo192.png" alt="Logo" className="h-14 w-auto" />
        <div>
          <h1 className="m-0 font-heading font-extrabold text-2xl tracking-tight">Averiados</h1>
          <p className="m-0 mt-1 text-[var(--text-secondary-color)]">Gestión y salida definitiva de stock averiado.</p>
        </div>
      </section>
      {loading && (
        <div className="p-6 text-center text-sm text-[var(--text-secondary-color)]">
          <span className="material-symbols-outlined animate-spin text-[var(--primary-color)] align-middle mr-2">progress_activity</span>Cargando stock averiados...
        </div>
      )}
      {error && !loading && (
        <div className="p-4 border border-[var(--danger-color)] rounded-xl text-[var(--danger-color)] text-sm mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined">error</span>{error}
        </div>
      )}
      {!loading && !error && (
        <div className="bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-4 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h2 className="m-0 font-heading font-bold text-sm uppercase tracking-wider text-[var(--text-secondary-color)]">Stock averiado ({products.length})</h2>
            <button onClick={fetchDamaged} className="inline-flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] border border-[var(--border-color)] text-xs font-semibold hover:bg-[var(--dark-color)]"><span className="material-symbols-outlined text-sm">refresh</span>Recargar</button>
          </div>
          {products.length===0 && (
            <div className="text-center py-10 text-xs text-[var(--text-secondary-color)]">No hay productos averiados con stock &gt; 0.</div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.map(p => {
              const entry = scrapMap[p.id]||{};
              return (
                <div key={p.id} className="p-3 rounded-2xl border border-[var(--border-color)] bg-[var(--dark-color)] flex flex-col gap-3 shadow-soft">
                  <div className="flex items-stretch gap-3">
                    <div className="flex-1 min-w-0 flex flex-col">
                      <div className="font-semibold text-sm leading-snug break-words line-clamp-2">{p.name}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-secondary-color)]">
                        {p.default_code && <span className="px-1.5 py-0.5 rounded bg-black/20 border border-[var(--border-color)] text-[9px] font-mono">{p.default_code}</span>}
                      </div>
                    </div>
                    <div className="w-20 flex flex-col items-center justify-center rounded-xl bg-black/20 border border-[var(--border-color)] text-center p-2 gap-1">
                      <span className="font-mono text-sm font-bold tracking-tight">{formatQty(p.qty)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="number" min="0" step="1" placeholder="Cantidad" className="w-24 flex-shrink-0 bg-[var(--dark-color)] border border-[var(--border-color)] rounded-[var(--radius)] px-2 py-2 text-xs" value={entry.qty||''} onChange={e=>updateScrap(p.id,{ qty:e.target.value })} />
                    <button disabled={entry.loading || !entry.qty || Number(entry.qty)<=0} onClick={()=>openConfirm(p)} className="ml-auto inline-flex items-center gap-1 px-3 py-2 rounded-[var(--radius)] bg-[var(--danger-color)] text-white text-[11px] font-semibold disabled:opacity-40">
                      {entry.loading ? <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span> : <span className="material-symbols-outlined text-sm">delete_forever</span>}
                      Hacer salida
                    </button>
                  </div>
                  {entry.error && <div className="text-[10px] text-[var(--danger-color)]">{entry.error}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {info && <div className="mt-4 p-3 rounded-xl border border-[var(--success-color)] text-[var(--success-color)] text-xs flex items-center gap-2 bg-[var(--success-color)]/10"><span className="material-symbols-outlined text-sm">check_circle</span>{info}</div>}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[var(--card-color)] border border-[var(--border-color)] rounded-2xl p-5 shadow-soft relative">
            <div className="flex items-center gap-2 mb-4">
              <span className="material-symbols-outlined text-[var(--danger-color)]">delete_forever</span>
              <h3 className="m-0 font-heading text-lg font-bold">Confirmar salida</h3>
            </div>
            <p className="m-0 mb-4 text-xs text-[var(--text-secondary-color)]">Esta acción reduce definitivamente el stock del producto averiado.</p>
            <div className="mb-4 p-3 rounded-xl bg-[var(--dark-color)] border border-[var(--border-color)] text-xs flex flex-col gap-2">
              <div className="font-semibold text-[var(--text-color)] leading-snug">{confirm.product.name}</div>
              <div className="flex flex-col gap-1 font-mono">
                <div className="flex items-center gap-2"><span className="text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[13px] opacity-60">inventory_2</span>Actual:</span><span className="kbd">{formatQty(confirm.product.qty)}</span></div>
                <div className="flex items-center gap-2"><span className="text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[13px] opacity-60">remove</span>Salida:</span><span className="text-[var(--danger-color)] font-semibold">{formatQty(confirm.qty)}</span></div>
                <div className="flex items-center gap-2"><span className="text-[var(--text-secondary-color)] flex items-center gap-1"><span className="material-symbols-outlined text-[13px] opacity-60">done_all</span>Nuevo:</span><span className="text-[var(--success-color)] font-semibold">{formatQty(confirm.product.qty - confirm.qty)}</span></div>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 sm:justify-end">
              <button disabled={scrapProcessing} onClick={()=>setConfirm(null)} className="inline-flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] border border-[var(--border-color)] text-xs font-semibold"><span className="material-symbols-outlined text-sm">close</span>Cancelar</button>
              <button disabled={scrapProcessing} onClick={()=>scrapProductConfirmed(confirm.product, confirm.qty)} className="inline-flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] bg-[var(--danger-color)] text-white text-xs font-semibold">
                {scrapProcessing ? <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span> : <span className="material-symbols-outlined text-sm">check_circle</span>}
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
