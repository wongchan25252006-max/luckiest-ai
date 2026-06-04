async function api(path, opts = {}) {
  const init = { credentials: 'include', headers: {}, ...opts };
  if (init.body && !(init.body instanceof FormData) && typeof init.body !== 'string') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(path, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
}

function fmtDate(ts) { if (!ts) return ''; return new Date(ts).toLocaleString(); }

function fmtAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function fmtMoney(cents, currency = 'USD') {
  const v = (cents || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function initials(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

const PLATFORM_GLYPHS = { facebook: 'f', instagram: 'IG', whatsapp: 'W', whatsapp_baileys: 'W', telegram: 'T' };
function platformIcon(p) {
  return `<span class="platform-icon ${p}" title="${p}">${PLATFORM_GLYPHS[p] || '?'}</span>`;
}

function avatar(picUrl, name, size = 40) {
  if (picUrl) {
    return `<div class="avatar" style="width:${size}px;height:${size}px;"><img src="${escapeHtml(picUrl)}" onerror="this.parentElement.innerHTML='${initials(name)}'"/></div>`;
  }
  return `<div class="avatar" style="width:${size}px;height:${size}px;">${initials(name)}</div>`;
}

async function renderTopbar(currentPage) {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  let me = null;
  try { me = (await api('/api/auth/me')).user; } catch {}

  let unread = 0;
  if (me) {
    try {
      const n = (await api('/api/messages/notifications')).notifications || [];
      unread = n.filter(x => !x.read).length;
    } catch {}
  }

  const adminLinks = me && me.role === 'admin'
    ? `<a href="/admin.html" class="${currentPage==='admin'?'active':''}">Admin</a>`
    : '';
  const userLinks = me ? `
    <a href="/dashboard.html" class="${currentPage==='dashboard'?'active':''}">Dashboard</a>
    <a href="/manager.html" class="${currentPage==='manager'?'active':''}">Contacts</a>
    <a href="/messages.html" class="${currentPage==='messages'?'active':''}">Inbox${unread?`<span class="badge">${unread}</span>`:''}</a>
    <a href="/scheduler.html" class="${currentPage==='scheduler'?'active':''}">Scheduler</a>
    <a href="/profile.html" class="${currentPage==='profile'?'active':''}">AI Brain</a>
    <a href="/platforms.html" class="${currentPage==='platforms'?'active':''}">Platforms</a>
    <a href="/billing.html" class="${currentPage==='billing'?'active':''}">Billing</a>
    ${adminLinks}
    <a href="#" id="logoutBtn">Logout</a>
  ` : `
    <a href="/login.html">Login</a>
    <a href="/signup.html" class="active">Get started</a>
  `;

  bar.innerHTML = `
    <a href="/" class="brand">
      <span class="brand-dot"></span>
      <span class="brand-text">Luckiest AI</span>
    </a>
    <div class="links">${userLinks}</div>
  `;

  const logout = document.getElementById('logoutBtn');
  if (logout) logout.onclick = async (e) => {
    e.preventDefault();
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  };
}
