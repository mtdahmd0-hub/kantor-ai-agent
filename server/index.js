import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentById, agentsOf } from '../shared/roster.js';
import { buildSystemPrompt, teamPlanPrompt, TEAM_MEMBER, TEAM_FINAL } from './prompts.js';

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
    leader: env.GEMINI_MODEL_LEADER || 'gemini-3.5-flash', team: env.GEMINI_MODEL_TEAM || 'gemini-3.5-flash-lite',
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

// Jawaban dari provider pertama yang berhasil (urutan PROVIDERS). Pindah ke provider berikutnya
// hanya kalau gagal sebelum ada teks; kalau sebagian jawaban sudah keluar, errornya diteruskan.
// Leader yang semua model leadernya habis kuota masih dicoba lagi dengan model tim.
async function* generate(agent, system, messages, signal) {
  const tries = PROVIDERS.map((p) => [p, agent.leader ? p.leader : p.team]);
  if (agent.leader) tries.push(...PROVIDERS.filter((p) => p.team !== p.leader).map((p) => [p, p.team]));
  let lastErr = null;
  for (const [p, model] of tries) {
    let sent = false;
    try {
      for await (const t of streamOpenAI(p, model, system, messages, signal)) {
        sent = true;
        yield t;
      }
      if (!sent) throw httpError(502, 'jawaban kosong');
      console.log(`[chat] ${agent.id} via ${p.name} model=${model}`);
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      console.error(`[chat error] ${p.name} model=${model}`, err?.status || '', String(err?.message || err).slice(0, 200));
      if (sent) break;
    }
  }
  throw lastErr;
}

async function collect(gen) {
  let s = '';
  for await (const t of gen) s += t;
  return s;
}

const firstName = (a) => a.name.split(' ')[0];

// Ambil JSON rencana dari jawaban leader. Kalau tidak bisa dibaca, semua anggota dapat brief utuh.
function parsePlan(raw, mates, brief) {
  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    const find = (id) => mates.find((m) => m.id === String(id).toLowerCase() || firstName(m).toLowerCase() === String(id).toLowerCase());
    const tasks = (j.tugas || [])
      .map((t) => ({ agent: find(t.id), task: String(t.tugas || '').trim() }))
      .filter((t, i, all) => t.agent && t.task && all.findIndex((x) => x.agent === t.agent) === i);
    if (tasks.length) return { summary: String(j.rencana || '').trim(), tasks };
  } catch { /* pakai cadangan di bawah */ }
  return { summary: '', tasks: mates.map((m) => ({ agent: m, task: `Kerjakan bagian dari brief ini sesuai keahlianmu (${m.focus}):\n${brief}` })) };
}

// Mode kerja tim: leader membagi tugas -> anggota mengerjakan bersamaan -> leader menggabungkan.
// Menghasilkan teks markdown bertahap; onStatus(agentId, 'working'|'done'|'idle') untuk animasi karakter.
async function* teamWork(leader, messages, signal, onStatus) {
  const mates = agentsOf(leader.division).filter((a) => a.id !== leader.id);
  const brief = messages[messages.length - 1].content;
  const leaderSystem = buildSystemPrompt(leader);

  // 1. Rencana
  const planRaw = await collect(generate(leader, `${leaderSystem}\n\n${teamPlanPrompt(mates)}`, messages, signal));
  const plan = parsePlan(planRaw, mates, brief);
  yield `### Rencana ${firstName(leader)}\n${plan.summary ? `${plan.summary}\n\n` : ''}` +
    plan.tasks.map((t) => `- **${firstName(t.agent)}** (${t.agent.role}): ${t.task.split('\n')[0].slice(0, 200)}`).join('\n') + '\n\n';

  // 2. Anggota bekerja bersamaan. Satu anggota gagal tidak menghentikan tim.
  const jobs = plan.tasks.map(async ({ agent, task }) => {
    onStatus(agent.id, 'working');
    const content = `Brief dari user untuk tim ${leader.division}:\n"""\n${brief}\n"""\n\nTugasmu dari ${leader.name}:\n${task}`;
    try {
      const text = await collect(generate(agent, `${buildSystemPrompt(agent)}\n\n${TEAM_MEMBER}`, [{ role: 'user', content }], signal));
      onStatus(agent.id, 'done');
      return { agent, text };
    } catch (err) {
      onStatus(agent.id, 'idle');
      if (signal.aborted) throw err;
      return { agent, text: '', error: friendlyError(err) };
    }
  });
  for (const j of jobs) j.catch(() => {}); // saat dibatalkan, cegah unhandled rejection dari job yang belum ditunggu
  const results = [];
  for (const job of jobs) {
    const r = await job;
    results.push(r);
    yield `### ${r.error ? '⚠️' : '✅'} ${firstName(r.agent)} · ${r.agent.role}\n${r.error ? `_Gagal: ${r.error}_` : r.text}\n\n`;
  }
  if (!results.some((r) => r.text)) throw httpError(503, 'semua anggota tim gagal');

  // 3. Leader menggabungkan
  const work = results.filter((r) => r.text).map((r) => `## ${r.agent.name} (${r.agent.role})\n${r.text}`).join('\n\n');
  yield `### 📝 Hasil akhir dari ${firstName(leader)}\n`;
  yield* generate(leader, `${leaderSystem}\n\n${TEAM_FINAL}`,
    [...messages.slice(0, -1), { role: 'user', content: `${brief}\n\n---\nHasil kerja timmu:\n\n${work}` }], signal);
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
      const team = req.body?.team === true && agent.leader && agentsOf(agent.division).length > 1;
      if (team) daily.count += agentsOf(agent.division).length; // ±1 request per anggota + rencana + gabungan
      const gen = team
        ? teamWork(agent, messages, ac.signal, (who, state) => !closed && send({ who, state }))
        : generate(agent, buildSystemPrompt(agent), messages, ac.signal);
      for await (const t of gen) if (!closed) send({ t });
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
