// Membaca halaman web yang ditautkan user (untuk tim QA/SEO/riset), lalu meringkasnya jadi teks
// yang bisa dibaca AI. Hanya http/https publik: alamat internal/privat ditolak (cegah SSRF).
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const MAX_URLS = 2;
const MAX_BYTES = 500_000;
const MAX_TEXT = 4_000;
const TIMEOUT_MS = 8_000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

// ponytail: alamat dicek lewat DNS sebelum fetch; DNS bisa berubah di antara cek dan fetch (DNS rebinding).
// Risiko kecil karena endpoint sudah dilindungi ACCESS_CODE; kalau perlu lebih ketat, pakai agent undici dengan lookup terkunci.
async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('hanya http/https');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('port tidak diizinkan');
  if (url.username || url.password) throw new Error('URL berisi login');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('alamat internal/privat tidak diizinkan');
}

async function fetchPublic(raw) {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const r = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'KantorAI-Reader/1.0 (+QA bot)', Accept: 'text/html,text/plain;q=0.9' },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = new URL(r.headers.get('location'), url); // ikuti redirect, dicek ulang di putaran berikutnya
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new Error(`bukan halaman teks (${type.split(';')[0] || 'tanpa tipe'})`);
    let body = '';
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      body += dec.decode(chunk, { stream: true });
      if (body.length > MAX_BYTES) break;
    }
    return { url: url.href, html: body };
  }
  throw new Error('terlalu banyak redirect');
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => (tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1];

// Ringkasan halaman untuk AI: info SEO/QA penting + teks halaman (dipotong).
export function summarizePage(url, html) {
  const head = (re) => (html.match(re) || [])[1];
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const meta = (n) => attr(metas.find((m) => new RegExp(`(name|property)\\s*=\\s*["']${n}["']`, 'i').test(m)) || '', 'content');
  const headings = [...html.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => `${m[1].toUpperCase()}: ${strip(m[2]).slice(0, 120)}`).filter((h) => h.length > 4);
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter((t) => !(attr(t, 'alt') || '').trim()).length;
  const links = (html.match(/<a\b[^>]*href/gi) || []).length;
  const body = strip(html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' '));
  return [
    `### Halaman: ${url}`,
    `- Title: ${strip(head(/<title[^>]*>([\s\S]*?)<\/title>/i) || '(tidak ada)')}`,
    `- Meta description: ${meta('description') || '(tidak ada)'}`,
    `- OG title/image: ${meta('og:title') || '-'} / ${meta('og:image') ? 'ada' : 'tidak ada'}`,
    `- Viewport meta: ${meta('viewport') ? 'ada' : 'TIDAK ADA'} · Canonical: ${attr((html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i) || [''])[0], 'href') || '-'} · lang: ${attr((html.match(/<html\b[^>]*>/i) || [''])[0], 'lang') || '-'}`,
    `- Gambar: ${imgs.length} (tanpa alt: ${noAlt}) · Link: ${links} · Ukuran HTML: ${Math.round(html.length / 1024)} KB`,
    `- Heading:\n${headings.slice(0, 25).map((h) => `  - ${h}`).join('\n') || '  (tidak ada H1-H3)'}`,
    `- Teks halaman (dipotong):\n${body.slice(0, MAX_TEXT)}${body.length > MAX_TEXT ? ' …' : ''}`,
  ].join('\n');
}

// Cari URL di pesan user, baca (maks 2), kembalikan lampiran teks untuk ditempel ke pesan.
export async function readLinkedPages(text) {
  const urls = [...new Set(text.match(/https?:\/\/[^\s<>"'`)\]]+/g) || [])].map((u) => u.replace(/[.,;:!?]+$/, '')).slice(0, MAX_URLS);
  if (!urls.length) return '';
  const parts = await Promise.all(urls.map(async (u) => {
    try {
      const page = await fetchPublic(u);
      return summarizePage(page.url, page.html);
    } catch (err) {
      return `### Halaman: ${u}\n(Gagal dibuka otomatis: ${err.message}. Jangan mengarang isinya; minta user menempel teks/screenshot.)`;
    }
  }));
  return `\n\n---\nIsi halaman yang ditautkan (dibaca otomatis oleh server saat ini, tanpa menjalankan JavaScript; kecepatan asli/Core Web Vitals tidak terukur dari sini):\n\n${parts.join('\n\n')}`;
}
