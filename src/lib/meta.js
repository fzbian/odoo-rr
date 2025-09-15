// Helper para fijar título y favicon dinámicamente
export function setPageTitle(title){
  if(typeof document!== 'undefined'){ document.title = title ? `${title} · ATM Ricky Rich` : 'ATM Ricky Rich'; }
}

export function setFavicon(href='/logo192.png'){
  if(typeof document === 'undefined') return;
  let link = document.querySelector("link[rel='icon']");
  if(!link){
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

export function applyPageMeta({ title, favicon }){
  setPageTitle(title);
  if(favicon) setFavicon(favicon); else setFavicon();
}
