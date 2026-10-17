// Kartu "Kuota AI": bar sisa jatah tiap provider/model, dari /api/quota.
import { getCode } from './chat.js';

const NAMES = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' };
const KEY_OPEN = 'kantorai.quota.open';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shortModel = (m) => m.replace(/^(google|openai)\//, '').replace(/^gemini-/, '').replace(/:free$/, '');

function waitText(ms) {
  const m = Math.ceil(ms / 60000);
  return m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} jam ${m % 60} mnt`;
}

function row(r) {
  let pct = 0;
  let level = 'unknown';
  let text = r.used ? `${r.used} dipakai` : 'belum ada data';
  if (r.blockedFor > 0) {
    level = 'out';
    text = `limit · pulih ±${waitText(r.blockedFor)}`;
  } else if (r.limit) {
    pct = Math.round((r.remaining / r.limit) * 100);
    level = pct > 50 ? 'ok' : pct > 20 ? 'low' : 'out';
    text = `sisa ${r.remaining}/${r.limit}`;
  }
  const acct = r.account ? ` · ${r.account}` : '';
  const title = `${NAMES[r.provider]} ${r.model} (${r.role}${r.account ? `, akun ${r.account}` : ''})${r.account === 'utama' && r.role === 'tim' ? ' · cadangan saat semua akun staf habis' : ''}${r.shared ? ' · jatah harian dibagi semua model gratis OpenRouter' : ''}${!r.limit && r.blockedFor <= 0 ? (r.provider === 'gemini'
    ? ' · Google tidak memberi info sisa kuota; yang terlihat hanya pemakaian lewat server ini, limitnya ketahuan saat pertama kena batas'
    : ' · server belum dapat angka dari provider (server baru menyala); muncul setelah dipakai') : ''}`;
  return `<li class="q-row" title="${esc(title)}">
    <span class="q-model"><b>${esc(r.role)}</b> ${esc(shortModel(r.model))}${acct ? `<em>${esc(acct)}</em>` : ''}</span>
    <span class="q-bar ${level}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(title)}"><i style="width:${level === 'out' && r.blockedFor > 0 ? 0 : pct}%"></i></span>
    <span class="q-text">${esc(text)}</span>
  </li>`;
}

export function initQuota() {
  const el = document.getElementById('quota');
  const list = el.querySelector('.q-list');
  const toggle = el.querySelector('.q-head');
  let open = true;
  try { open = localStorage.getItem(KEY_OPEN) !== '0'; } catch { /* abaikan */ }

  const setOpen = (v) => {
    open = v;
    toggle.setAttribute('aria-expanded', String(v));
    list.hidden = !v;
    try { localStorage.setItem(KEY_OPEN, v ? '1' : '0'); } catch { /* abaikan */ }
  };
  toggle.addEventListener('click', () => {
    setOpen(!open);
    if (open) refresh(); // baru dibuka: tampilkan angka terbaru
  });
  setOpen(open);

  async function refresh() {
    try {
      const r = await fetch('/api/quota', { headers: { 'x-access-code': getCode() } });
      if (!r.ok) throw new Error(String(r.status));
      const { demo, rows } = await r.json();
      if (demo || !rows.length) {
        el.hidden = true;
        return;
      }
      let html = '';
      let last = '';
      rows.forEach((x, i) => {
        if (x.provider !== last) {
          html += `<li class="q-prov">${NAMES[x.provider] || x.provider}<small>${i === 0 ? 'utama' : 'cadangan'}</small></li>`;
          last = x.provider;
        }
        html += row(x);
      });
      list.innerHTML = html;
      el.hidden = false;
    } catch {
      el.hidden = true; // server mati / kode akses belum diisi
    }
  }

  // Hemat invocation (Vercel Hobby: 1 juta/bulan): sekali saat dibuka, lalu tiap 60 detik
  // hanya kalau tab terlihat DAN kartu terbuka. Kartu dilipat / tab disembunyikan = berhenti total.
  const active = () => open && !document.hidden;
  refresh();
  setInterval(() => { if (active()) refresh(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (active()) refresh(); });
  return { refresh: () => { if (active()) refresh(); } };
}
