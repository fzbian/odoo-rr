import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';

// Hook centralizado para precargar y cachear productos una sola vez.
// Devuelve { products, loading, error, filter(term) }
// products: array completo (limit configurable), se obtiene la primera vez que algún componente lo pide.
// Cache en variable módulo para evitar refetch.
let cache = { loaded: false, products: [], loading: false, error: null, promise: null };

export function useProducts(options={}){
  const { executeKw } = useAuth();
  const { limit = 5000, fields = ['name','default_code','uom_id','standard_price','qty_available'] } = options;
  const [, forceRender] = useState(0);
  const mounted = useRef(true);

  useEffect(()=>{ return ()=>{ mounted.current=false; }; },[]);

  useEffect(()=>{
    if(cache.loaded || cache.loading || cache.promise) return;
    cache.loading = true;
    cache.promise = (async()=>{
      try {
        const list = await executeKw({ model:'product.product', method:'search_read', params:[[['sale_ok','!=',false]], fields], kwargs:{ limit }, activity:'Precargando productos...' });
        cache.products = list;
        cache.loaded = true;
      } catch(e){
        cache.error = e.message || String(e);
      } finally {
        cache.loading = false;
        cache.promise = null;
        if(mounted.current) forceRender(x=>x+1);
      }
    })();
  },[executeKw, fields, limit]);

  const filter = (term)=>{
    const t = (term||'').trim().toLowerCase();
    if(!t) return cache.products.slice(0,50);
    return cache.products.filter(p=> (p.default_code && p.default_code.toLowerCase().includes(t)) || (p.name && p.name.toLowerCase().includes(t)) ).slice(0,50);
  };

  return {
    products: cache.products,
    loading: !cache.loaded && cache.loading,
    loaded: cache.loaded,
    error: cache.error,
    filter,
  };
}
