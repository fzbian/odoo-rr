// Runtime env loader: combina variables build (process.env) con window.__RUNTIME_CONFIG__
function readRuntime(){
  if(typeof window !== 'undefined' && window.__RUNTIME_CONFIG__) return window.__RUNTIME_CONFIG__;
  return {};
}

const runtime = readRuntime();

export function getEnv(key, fallback=''){
  if(key in runtime) return runtime[key] ?? fallback;
  const v = process.env[key];
  return (v===undefined? fallback : v);
}

export function listEnv(keys){
  return Object.fromEntries(keys.map(k=> [k, getEnv(k,'')]));
}
