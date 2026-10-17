/* Keep existing controls connected to the Sona app and official social page. */
(() => {
  const social = 'https://x.com/SonaFiTrade';
  const app = '/app/';
  const root = location.pathname.includes('/policies/') ? '../../' : './';
  function isLaunchControl(anchor) {
    return anchor?.matches('.framer-gsf9G') &&
      ['Follow Sona', 'Explore Sona', 'Launch app'].includes(anchor.textContent.trim());
  }
  function updateLaunchControl(anchor) {
    const label = anchor.querySelector('.framer-text');
    if (label && label.textContent !== 'Launch app') label.textContent = 'Launch app';
    if (anchor.getAttribute('href') !== app) anchor.setAttribute('href', app);
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
    anchor.setAttribute('aria-label', 'Launch Sona app');
  }
  function refresh() {
    document.querySelectorAll('.framer-1nbugvf-container video').forEach(video => {
      video.removeAttribute('src');
      video.poster = root + 'assets/sona-banner.png';
      video.pause();
    });
    document.querySelectorAll('.framer-4474yi input').forEach(input => {
      input.type = 'text';
      input.value = '@SonaFiTrade';
      input.readOnly = true;
      input.setAttribute('aria-label', 'Contact Sona on X');
    });
    document.querySelectorAll('a').forEach(a => {
      if (isLaunchControl(a)) {
        if (a.textContent.trim() !== 'Launch app') updateLaunchControl(a);
        return;
      }
      const label = a.textContent.trim();
      if (label === 'Terms & Conditions') a.href = root + 'policies/terms-conditions/index.html';
      if (label === 'Home') a.href = root + 'index.html';
      if (label === 'Protocol') a.href = root + 'index.html#capabilities';
      if (label === 'Flywheel') a.href = root + 'index.html#flywheel';
      if (label === 'FAQ') a.href = root + 'index.html#faq';
      if (a.href === social) { a.setAttribute('aria-label', label || 'Sona on X'); a.rel = 'noopener noreferrer'; }
    });
    const faq = Array.from(document.querySelectorAll('h2')).find(el => el.textContent.includes('Everything you need to know'));
    if (faq) faq.closest('section')?.setAttribute('id','faq');
  }
  document.addEventListener('submit', event => {
    if (event.target.matches('.framer-4474yi')) {
      event.preventDefault();event.stopImmediatePropagation();window.open(social,'_blank','noopener,noreferrer');
    }
  },true);
  window.addEventListener('click', event => {
    const node = event.target;
    if (!(node instanceof Element)) return;
    const anchor=node.closest('a');
    if (isLaunchControl(anchor)) {
      updateLaunchControl(anchor);
      event.stopImmediatePropagation();
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
        event.preventDefault();location.href = app;
      }
      return;
    }
    if (node.closest('.framer-4474yi') || node.closest('.framer-1nbugvf-container') || node.closest('.framer-103u8w0')) {
      event.preventDefault();event.stopImmediatePropagation();window.open(social,'_blank','noopener,noreferrer');return;
    }
    if(anchor && anchor.origin === location.origin) {
      event.preventDefault();event.stopImmediatePropagation();
      const url = new URL(anchor.href);
      if(url.hash && /^(#capabilities|#flywheel|#faq)$/.test(url.hash) && !location.pathname.includes('/policies/')) {
        document.querySelector(url.hash)?.scrollIntoView({behavior:'smooth'});history.replaceState(null,'',url.hash);
      } else location.href = anchor.href;
    }
  },true);
  refresh();
  let pending=false;
  new MutationObserver(() => {if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;refresh()})}).observe(document.getElementById('main'),{childList:true,characterData:true,subtree:true});
})();
