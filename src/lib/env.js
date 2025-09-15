// Runtime env loader: combina variables build (process.env) con window.__RUNTIME_CONFIG__
function readRuntime(){
  if(typeof window !== 'undefined' && window.__RUNTIME_CONFIG__) return window.__RUNTIME_CONFIG__;
  return {};
}

const runtime = readRuntime();

export function getEnv(key, fallback=''){
  if(key in runtime) return runtime[key] ?? fallback;
  const v = process.env[key];
  let val = (v===undefined? fallback : v);
  if (typeof window !== 'undefined' && window.location?.protocol === 'https:' && key === 'REACT_APP_NOTIFY_URL' && val && /^http:\/\//.test(val)) {
    // Fuerza uso de proxy relativo si se detecta URL insegura en contexto HTTPS
    val = '/notify';
  }
  return val;
}

export function listEnv(keys){
  return Object.fromEntries(keys.map(k=> [k, getEnv(k,'')]));
}
