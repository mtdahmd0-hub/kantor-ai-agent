import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentById } from '../shared/roster.js';
import { buildSystemPrompt } from './prompts.js';

// ---------- Konfigurasi (lihat .env.example) ----------
const env = process.env;
const PORT = Number(env.PORT || 3001);
const ACCESS_CODE = env.ACCESS_CODE || '';
const MAX_TOKENS = Number(env.MAX_TOKENS || 1500);
const RATE_PER_MINUTE = Number(env.RATE_PER_MINUTE || 15);
const DAILY_MAX_REQUESTS = Number(env.DAILY_MAX_REQUESTS || 300);
const MAX_HISTORY = 20;
const MAX_CHARS = 4000;

// Provider AI. Yang tidak punya key dilewati. Dicoba sesuai LLM_ORDER; kalau satu gagal
// sebelum sempat mengirim teks, otomatis pindah ke provider berikutnya.
// Semua lewat endpoint yang kompatibel OpenAI (baseURL).
const ALL_PROVIDERS = [
  { name: 'gemini', key: env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    leader: env.GEMINI_MODEL_LEADER || 'gemini-3.5-flash', team: env.GEMINI_MODEL_TEAM || 'gemini-2.5-flash',
    extra: { reasoning_effort: 'low' } },
  { name: 'groq', key: env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1',
    leader: env.GROQ_MODEL_LEADER || 'openai/gpt-oss-120b', team: env.GROQ_MODEL_TEAM || 'openai/gpt-oss-20b',
    extra: { reasoning_effort: 'low' } },
  { name: 'openrouter', key: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1',
    leader: env.OPENROUTER_MODEL_LEADER || 'google/gemma-4-31b-it:free', team: env.OPENROUTER_MODEL_TEAM || 'google/gemma-4-26b-a4b-it:free' },
];
const ORDER = (env.LLM_ORDER || 'gemini,groq,openrouter').split(',').map((s) => s.trim());
const PROVIDERS = ORDER.map((n) => ALL_PROVIDERS.find((p) => p.name === n && p.key)).filter(Boolean);

const DEMO = !PROVIDERS.length;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// ---------- Pembatas: akses, rate limit per IP, batas harian ----------
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function requireAccess(req, res, next) {
  if (!ACCESS_CODE) return next();
  if (safeEqual(req.get('x-access-code') || '', ACCESS_CODE)) return next();
  res.status(401).json({ error: 'Kode akses salah atau belum diisi.' });
}

const hits = new Map(); // ip -> [timestamp]
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MINUTE) {
    return res.status(429).json({ error: 'Terlalu cepat. Tunggu sebentar lalu coba lagi.' });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < 60_000)) hits.delete(ip);
  }
}, 5 * 60_000).unref();

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
let daily = { day: today(), count: 0 };
function dailyCap(req, res, next) {
  if (daily.day !== today()) daily = { day: today(), count: 0 };
  if (daily.count >= DAILY_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Batas pemakaian harian tercapai. Coba lagi besok.' });
  }
  daily.count += 1;
  next();
}

// ---------- Util ----------
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS) }))
    .filter((m) => m.content)
    .slice(-MAX_HISTORY);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function demoReply(agent, lastUser) {
  return (
    `Halo, gue ${agent.name.split(' ')[0]} (${agent.role}).\n\n` +
    `**Mode demo**: server belum punya API key AI (GEMINI/GROQ/OPENROUTER), jadi ini jawaban contoh supaya tampilan chat bisa dites.\n\n` +
    `Lo bilang: "${lastUser.slice(0, 160)}"\n\n` +
    `Setelah API key dipasang, gue bakal jawab sungguhan sesuai keahlian gue: ${agent.focus}.\n\n` +
    `- Poin contoh pertama\n- Poin contoh kedua\n- Poin contoh ketiga`
  );
}

// Dipanggil setelah semua provider gagal; err = error provider terakhir.
function friendlyError(err) {
  const status = err?.status;
  if (status === 400 || status === 401) return 'API key atau model ditolak provider AI. Cek .env di server.';
  if (status === 402 || status === 403) return 'Akun API tidak punya akses atau saldo. Cek dashboard provider.';
  if (status === 429) return 'Semua provider AI kena batas kuota. Coba lagi sebentar lagi.';
  if (status === 529 || status >= 500) return 'Server AI lagi sibuk. Coba lagi sebentar lagi.';
  return 'Terjadi kesalahan di server. Coba lagi.';
}

function httpError(status, message) {
  return Object.assign(new Error(String(message).slice(0, 300)), { status });
}

// Streaming dari endpoint kompatibel OpenAI (Gemini, Groq, OpenRouter). Menghasilkan potongan teks.
async function* streamOpenAI(p, model, system, messages, signal) {
  const r = await fetch(`${p.baseURL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: MAX_TOKENS, stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
      ...p.extra,
    }),
  });
  if (!r.ok) throw httpError(r.status, await r.text());

  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue; // baris komentar SSE (mis. ": OPENROUTER PROCESSING")
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const j = JSON.parse(data);
      if (j.error) throw httpError(j.error.code || 500, j.error.message);
      const t = j.choices?.[0]?.delta?.content;
      if (t) yield t;
    }
  }
}
// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({ demo: DEMO, needsCode: Boolean(ACCESS_CODE) });
});

app.get('/api/verify', requireAccess, (req, res) => res.json({ ok: true }));

app.post('/api/chat', requireAccess, rateLimit, dailyCap, async (req, res) => {
  const agent = agentById(req.body?.agentId);
  if (!agent) return res.status(400).json({ error: 'Karyawan tidak ditemukan.' });

  const messages = cleanMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Pesan kosong.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let closed = false;
  const ac = new AbortController();
  res.on('close', () => {
    closed = true;
    if (!res.writableFinished) ac.abort();
  });

  try {
    if (DEMO) {
      const words = demoReply(agent, messages[messages.length - 1].content).split(/(\s+)/);
      for (const w of words) {
        if (closed) return;
        send({ t: w });
        await sleep(25);
      }
    } else {
      const system = buildSystemPrompt(agent);
      let sent = false;
      let lastErr = null;
      for (const p of PROVIDERS) {
        const model = agent.leader ? p.leader : p.team;
        try {
          for await (const t of streamOpenAI(p, model, system, messages, ac.signal)) {
            sent = true;
            if (!closed) send({ t });
          }
          if (!sent) throw httpError(502, 'jawaban kosong');
          console.log(`[chat] ${agent.id} via ${p.name} model=${model}`);
          lastErr = null;
          break;
        } catch (err) {
          if (closed) return;
          lastErr = err;
          console.error(`[chat error] ${p.name} model=${model}`, err?.status || '', String(err?.message || err).slice(0, 200));
          if (sent) break; // sebagian jawaban sudah terkirim, jangan disambung provider lain
        }
      }
      if (lastErr) throw lastErr;
    }
    if (!closed) send({ done: true });
  } catch (err) {
    if (!closed) {
      console.error('[chat error]', err?.status || '', err?.message || err);
      send({ error: friendlyError(err) });
    }
  } finally {
    res.end();
  }
});

// ---------- Frontend hasil build (produksi) ----------
const dist = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(`${dist}/index.html`);
  });
}

app.listen(PORT, () => {
  console.log(`Kantor AI API jalan di http://localhost:${PORT}`);
  console.log(DEMO ? 'Mode: DEMO (tanpa API key AI)'
    : `Mode: LIVE  urutan: ${PROVIDERS.map((p) => `${p.name}(${p.leader} / ${p.team})`).join(' > ')}`);
  console.log(ACCESS_CODE ? 'Kode akses: aktif' : 'Kode akses: TIDAK aktif (isi ACCESS_CODE sebelum dipublikasi)');
});
