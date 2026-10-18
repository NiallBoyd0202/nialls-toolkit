// Runs on Amazon UK/EU pages. Shows a "Track seller" button on storefront and seller-profile pages.
(() => {
  const BTN_ID = 'nt-track';

  function sellerIdFromUrl(href) {
    try {
      const u = new URL(href);
      const id = u.searchParams.get('seller') || u.searchParams.get('me');
      return id && /^A[0-9A-Z]{9,20}$/.test(id) ? id : null;
    } catch { return null; }
  }

  function sellerName() {
    const el = document.querySelector('#seller-name, #sellerName, h1#seller-name, .a-profile-name');
    return el ? el.textContent.trim().slice(0, 120) : '';
  }

  function showToast(text, ok = true) {
    let t = document.getElementById('nt-toast');
    if (!t) { t = document.createElement('div'); t.id = 'nt-toast'; document.body.appendChild(t); }
    t.textContent = text;
    t.className = ok ? 'ok' : 'err';
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.display = 'none'; }, 4000);
  }

  function render() {
    const id = sellerIdFromUrl(location.href);
    let btn = document.getElementById(BTN_ID);
    if (!id) { if (btn) btn.remove(); return; }
    if (btn && btn.dataset.seller === id) return;
    if (!btn) {
      btn = document.createElement('div');
      btn.id = BTN_ID;
      document.body.appendChild(btn);
    }
    btn.dataset.seller = id;
    btn.innerHTML = `<button type="button" class="nt-main">＋ Track seller in Niall's Toolkit</button><button type="button" class="nt-open" title="Open Niall's Toolkit">↗</button>`;
    btn.querySelector('.nt-main').onclick = () => {
      chrome.runtime.sendMessage({ type: 'trackSeller', url: location.href, name: sellerName() }, (res) => {
        if (chrome.runtime.lastError || !res) return showToast("Niall's Toolkit: couldn't save — reload the page and try again", false);
        if (!res.ok) return showToast(`Niall's Toolkit: ${res.error}`, false);
        showToast(res.existed ? "Already tracking this seller in Niall's Toolkit" : "Seller added to Niall's Toolkit — it imports when you open the dashboard");
        btn.querySelector('.nt-main').textContent = "✓ Tracking in Niall's Toolkit";
      });
    };
    btn.querySelector('.nt-open').onclick = () => chrome.runtime.sendMessage({ type: 'openDashboard', hash: 'tracker/storefronts' });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ntToast') {
      if (!msg.ok) showToast(`Niall's Toolkit: ${msg.error}`, false);
      else showToast(msg.existed ? "Already tracking this seller in Niall's Toolkit" : "Seller added to Niall's Toolkit");
    }
  });

  render();
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; render(); } }, 1200);
})();
