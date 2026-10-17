import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentById, agentsOf, divisionById } from '../shared/roster.js';
import { readLinkedPages } from './web.js';
import { buildSystemPrompt, teamPlanPrompt, TEAM_MEMBER, TEAM_FINAL, managerPlanPrompt, MANAGER_TASK, MANAGER_FINAL } from './prompts.js';

// ---------- Konfigurasi (lihat .env.example) ----------
const env = process.env;
const PORT = Number(env.PORT || 3001);
const ACCESS_CODE = env.ACCESS_CODE || '';
const MAX_TOKENS = Number(env.MAX_TOKENS || 1500);
// Jawaban yang dibaca langsung user (chat langsung & hasil akhir leader/GM, termasuk paket "Prompt siap pakai")
// butuh ruang lebih panjang; kerja internal anggota tim tetap MAX_TOKENS supaya hemat kuota.
const FINAL_MAX_TOKENS = Number(env.FINAL_MAX_TOKENS || 3000);
const RATE_PER_MINUTE = Number(env.RATE_PER_MINUTE || 15);
const DAILY_MAX_REQUESTS = Number(env.DAILY_MAX_REQUESTS || 300);
const MAX_HISTORY = 20;
const MAX_CHARS = 4000;

// Provider AI. Yang tidak punya key dilewati. Dicoba sesuai LLM_ORDER; kalau satu gagal
// sebelum sempat mengirim teks, otomatis pindah ke provider berikutnya.
// Semua lewat endpoint yang kompatibel OpenAI (baseURL).
// GROQ_STAFF_KEYS: key akun Groq lain (dipisah koma) untuk anggota tim; digilir, akun utama jadi cadangannya.
const staffKeys = (list) => String(list || '').split(',').map((k) => k.trim()).filter(Boolean)
  .map((key, i) => ({ key, label: `staf ${i + 1}` }));
const ALL_PROVIDERS = [
  { name: 'gemini', key: env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    leader: env.GEMINI_MODEL_LEADER || 'gemini-3.5-flash', team: env.GEMINI_MODEL_TEAM || 'gemini-3.5-flash-lite',
    extra: { reasoning_effort: 'low' } },
  { name: 'groq', key: env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1',
    leader: env.GROQ_MODEL_LEADER || 'openai/gpt-oss-120b', team: env.GROQ_MODEL_TEAM || 'openai/gpt-oss-20b',
    extra: { reasoning_effort: 'low' }, staff: staffKeys(env.GROQ_STAFF_KEYS) },
  { name: 'openrouter', key: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1',
    leader: env.OPENROUTER_MODEL_LEADER || 'google/gemma-4-31b-it:free', team: env.OPENROUTER_MODEL_TEAM || 'google/gemma-4-26b-a4b-it:free' },
];
const ORDER = (env.LLM_ORDER || 'groq,gemini,openrouter').split(',').map((s) => s.trim());
const PROVIDERS = ORDER.map((n) => ALL_PROVIDERS.find((p) => p.name === n && p.key)).filter(Boolean);
for (const p of PROVIDERS) p.staff ??= [];

// Akun yang dicoba untuk satu panggilan, berurutan.
// Leader & GM: akun utama dulu, lalu akun staf (dipinjam saat akun utama sibuk/habis).
// Anggota tim: akun staf digilir (mulai dari akun berikutnya tiap panggilan), lalu akun utama.
let staffTurn = 0;
function accountsFor(p, leader, rotate = true) {
  const main = { key: p.key, label: 'utama' };
  if (!p.staff.length) return [main];
  const n = p.staff.length;
  const start = rotate ? staffTurn++ % n : 0;
  const staff = p.staff.map((_, i) => p.staff[(start + i) % n]);
  return leader ? [main, ...staff] : [...staff, main];
}

const DEMO = !PROVIDERS.length;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' })); // riwayat berisi hasil tim/Bram yang panjang (browser sudah meringkasnya)

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
  next(); // yang dihitung tiap panggilan AI (lihat generate), karena mode tim/manager memanggil AI berkali-kali
}

// ---------- Util ----------
// Batas panjang per pesan: pesan user MAX_CHARS; jawaban AI terakhir dibiarkan panjang karena biasanya
// itu yang direvisi ("perbaiki bagian iklannya"); jawaban AI lama cukup ringkasannya.
const MAX_LAST_ANSWER = 12_000;
const MAX_OLD_ANSWER = 3_000;
// Total riwayat ±24.000 huruf (±6.000 token) supaya chat & revisi biasa masih muat di jatah Groq
// (8.000 token/menit per akun, dihitung dari input). Pesan terlama dibuang lebih dulu.
const HISTORY_BUDGET = 24_000;
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}\n…[dipotong]`);

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content)
    .slice(-MAX_HISTORY);
  while (out.length && out[0].role !== 'user') out.shift();
  const lastAnswer = out.findLastIndex((m) => m.role === 'assistant');
  const clipped = out.map((m, i) => ({
    role: m.role,
    content: clip(m.content, m.role === 'user' ? MAX_CHARS : i === lastAnswer ? MAX_LAST_ANSWER : MAX_OLD_ANSWER),
  }));
  const size = () => clipped.reduce((n, m) => n + m.content.length, 0);
  while (clipped.length > 2 && size() > HISTORY_BUDGET) {
    clipped.splice(0, 2); // buang sepasang tanya-jawab terlama (pesan terakhir user & jawaban terakhir tetap)
    while (clipped.length && clipped[0].role !== 'user') clipped.shift();
  }
  return clipped;
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

// ---------- Pelacak kuota (untuk bar kuota di UI) ----------
// Groq memberi sisa jatah di header; OpenRouter lewat /api/v1/key; Gemini tidak memberi apa-apa,
// jadi pemakaiannya dihitung sendiri dan limitnya diketahui dari error 429.
// ponytail: hitungan Gemini hanya dari request lewat server ini dan reset tengah malam waktu Pasifik
// (jadwal reset Gemini). Kalau key yang sama dipakai aplikasi lain, angkanya lebih kecil dari aslinya.
const QUOTA_FILE = fileURLToPath(new URL('./.quota.json', import.meta.url));
const quotaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
let quota = { day: quotaDay(), models: {} };
try {
  const saved = JSON.parse(readFileSync(QUOTA_FILE, 'utf8'));
  if (saved.day === quota.day) quota = saved;
} catch { /* belum ada file */ }
// Di Vercel file sistem read-only, jadi catatan kuota cukup di memori instance.
const saveQuota = () => { if (!process.env.VERCEL) writeFile(QUOTA_FILE, JSON.stringify(quota), () => {}); };

function quotaOf(p, model, label = 'utama') {
  if (quota.day !== quotaDay()) quota = { day: quotaDay(), models: {} };
  const id = label === 'utama' ? `${p.name}:${model}` : `${p.name}:${model}:${label}`;
  return (quota.models[id] ??= { used: 0 });
}

// "1m26.4s", "577ms", "956s", "2h3m" -> milidetik
function parseDuration(s) {
  let ms = 0;
  for (const [, n, u] of String(s || '').matchAll(/([\d.]+)(ms|h|m|s)/g)) ms += n * { ms: 1, s: 1e3, m: 6e4, h: 3.6e6 }[u];
  return ms;
}

function noteHeaders(q, h) {
  const limit = h.get('x-ratelimit-limit-requests');
  if (limit == null) return;
  q.limit = Number(limit);
  q.remaining = Number(h.get('x-ratelimit-remaining-requests'));
  if (h.get('x-ratelimit-limit-tokens') != null) { // jatah token per menit (Groq)
    q.tokLimit = Number(h.get('x-ratelimit-limit-tokens'));
    q.tokRemaining = Number(h.get('x-ratelimit-remaining-tokens'));
    q.tokResetAt = Date.now() + parseDuration(h.get('x-ratelimit-reset-tokens'));
  }
}

// Pemakaian token bertahap: sebelum memanggil, pesan perkiraan token dari jatah per menit akun ini.
// canWait = false: kalau jatahnya kurang, langsung false (pindah ke akun lain tanpa menunggu).
// canWait = true: tunggu sampai pulih (maks TOKEN_WAIT_MS) supaya tidak kena 429; lebih lama = false.
// ponytail: perkiraan token kasar (huruf/4 + MAX_TOKENS) dan "pulih" dianggap penuh saat reset-tokens lewat;
// kalau masih sering kena 429, naikkan pembagi atau kecilkan MAX_TOKENS.
const TOKEN_WAIT_MS = Number(env.TOKEN_WAIT_MS || 20_000);
// Perkiraan token input (huruf/4, cocok dengan hitungan Groq ±10%). Groq menolak request kalau INPUT-nya
// saja melebihi jatah token/menit (413), sedangkan jawaban baru dihitung setelah keluar.
const inputTokens = (system, messages) =>
  Math.ceil((system.length + messages.reduce((n, m) => n + m.content.length, 0)) / 4);
// yang dipesan dari jatah per menit: input + perkiraan panjang jawaban (jarang sampai batas maksimal)
const estimateTokens = (input, maxTokens) => input + Math.min(maxTokens, 1500);

async function reserveTokens(q, need, label, canWait) {
  if (q.tokRemaining == null) return true; // belum tahu jatahnya
  need = Math.min(need, q.tokLimit); // input sudah dicek muat di generate(); jawaban panjang tetap boleh
  for (;;) {
    if (Date.now() >= q.tokResetAt) q.tokRemaining = Math.max(q.tokRemaining, q.tokLimit);
    if (q.tokRemaining >= need) break;
    const wait = q.tokResetAt - Date.now();
    if (!canWait) return false;
    if (wait > TOKEN_WAIT_MS) {
      console.log(`[antre] ${label} dilewati: perlu tunggu ${(wait / 1000).toFixed(0)}s (sisa ${q.tokRemaining}, butuh ±${need})`);
      return false;
    }
    console.log(`[antre] ${label} tunggu ${(wait / 1000).toFixed(1)}s (sisa ${q.tokRemaining} token, butuh ±${need})`);
    await sleep(wait + 50);
  }
  q.tokRemaining -= need; // dipesan, supaya panggilan bersamaan ikut antre
  return true;
}

function noteLimited(q, headers, body) {
  let wait = Number(headers.get('retry-after')) * 1000 || 60_000;
  try {
    const j = JSON.parse(body);
    for (const d of (Array.isArray(j) ? j[0] : j)?.error?.details || []) {
      if (d.retryDelay) wait = parseDuration(d.retryDelay);
      for (const v of d.violations || []) {
        if (/PerDay/.test(v.quotaId) && v.quotaValue) { // jatah harian Gemini habis
          q.limit = Number(v.quotaValue);
          q.used = Math.max(q.used, q.limit);
        }
      }
    }
  } catch { /* bukan JSON */ }
  q.blockedUntil = Date.now() + wait;
  saveQuota();
}

let orInfo = { at: 0, data: null };
async function openRouterFree(p) {
  if (Date.now() - orInfo.at < 30_000) return orInfo.data;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${p.key}` }, signal: AbortSignal.timeout(5000) });
    orInfo = { at: Date.now(), data: (await r.json()).data?.free_model_daily_requests || null };
  } catch {
    orInfo = { at: Date.now(), data: null };
  }
  return orInfo.data;
}

// Streaming dari endpoint kompatibel OpenAI (Gemini, Groq, OpenRouter). Menghasilkan potongan teks.
// q = catatan kuota akun+model ini (diisi dari header / error 429).
// Batas waktu per panggilan: provider yang menggantung dianggap gagal (pindah ke provider berikutnya),
// supaya satu alur tim/Bram tidak menghabiskan batas 300 detik fungsi Vercel.
const CALL_TIMEOUT_MS = Number(env.CALL_TIMEOUT_MS || 120_000);

async function* streamOpenAI(p, model, key, q, system, messages, signal, maxTokens) {
  const r = await fetch(`${p.baseURL}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens, stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
      ...p.extra,
    }),
  });
  noteHeaders(q, r.headers);
  if (!r.ok) {
    const body = await r.text();
    if (r.status === 429) noteLimited(q, r.headers, body);
    throw httpError(r.status, body);
  }

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
// Per provider: putaran 1 langsung pindah akun kalau jatah token/menit akun kurang (tanpa menunggu);
// putaran 2 baru antre di akun yang tadi sibuk. Akun yang sedang kena limit 429 dilewati tanpa memanggil API.
async function* generate(agent, system, messages, signal, maxTokens = MAX_TOKENS) {
  const groups = PROVIDERS.map((p) => [p, agent.leader ? p.leader : p.team]);
  if (agent.leader) groups.push(...PROVIDERS.filter((p) => p.team !== p.leader).map((p) => [p, p.team]));
  const input = inputTokens(system, messages);
  const need = estimateTokens(input, maxTokens);
  daily.count += 1;
  let lastErr = httpError(429, 'semua akun & provider sedang kena limit');
  groups: for (const [p, model] of groups) {
    const accts = accountsFor(p, agent.leader);
    const busy = []; // akun yang dilewati karena jatah token/menit kurang
    for (const canWait of [false, true]) {
      for (const acct of canWait ? busy : accts) {
        const q = quotaOf(p, model, acct.label);
        if (q.blockedUntil > Date.now()) continue;
        if (q.tokLimit && input > q.tokLimit * 0.95) { // input saja sudah melebihi jatah/menit: semua akun provider ini pasti menolak (413)
          console.log(`[antre] ${p.name} dilewati: input ±${input} token > batas ${q.tokLimit}/menit, pakai provider berikutnya`);
          continue groups;
        }
        if (!(await reserveTokens(q, need, `${p.name} ${acct.label}`, canWait))) {
          if (!canWait) busy.push(acct);
          continue;
        }
        if (signal.aborted) throw httpError(499, 'dibatalkan');
        let sent = false;
        try {
          for await (const t of streamOpenAI(p, model, acct.key, q, system, messages, signal, maxTokens)) {
            sent = true;
            yield t;
          }
          if (!sent) throw httpError(502, 'jawaban kosong');
          q.used += 1;
          q.blockedUntil = 0;
          saveQuota();
          console.log(`[chat] ${agent.id} via ${p.name} model=${model} akun=${acct.label}`);
          return;
        } catch (err) {
          if (signal.aborted) throw err;
          lastErr = err;
          console.error(`[chat error] ${p.name} model=${model} akun=${acct.label}`, err?.status || '', String(err?.message || err).slice(0, 200));
          if (sent) throw err; // sebagian jawaban sudah terkirim, jangan disambung akun/provider lain
          if (err.status === 413) { // request terlalu besar untuk provider ini: akun lain juga pasti menolak
            q.tokLimit ??= Math.max(1000, input - 1);
            continue groups;
          }
        }
      }
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

// Ambil JSON rencana dari jawaban leader/manager:
// { questions } kalau brief terlalu tipis (hanya kalau canAsk), atau { facts, summary, tasks }.
// Kalau tidak bisa dibaca: semua anggota dapat brief utuh, atau error kalau fallbackAll = false
// (manager, supaya tidak memanggil semua divisi sekaligus).
function parsePlan(raw, mates, brief, { fallbackAll = true, canAsk = false } = {}) {
  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    const ask = Array.isArray(j.pertanyaan) ? j.pertanyaan.map((q) => String(q).trim()).filter(Boolean).slice(0, 3) : [];
    if (canAsk && ask.length && !(j.tugas || []).length) return { questions: ask };
    const f = j[Object.keys(j).find((k) => /^(fakta|facts?|key_?facts)/i.test(k))]; // AI kadang menamai "fakta_kunci"/"facts"
    const facts = typeof f === 'string' ? f.trim()
      : f && typeof f === 'object' ? Object.entries(f).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
    if (!facts) console.log('[rencana] tanpa fakta kunci:', raw.slice(0, 300).replace(/\s+/g, ' '));
    const find = (id) => mates.find((m) => m.id === String(id).toLowerCase() || firstName(m).toLowerCase() === String(id).toLowerCase());
    const tasks = (j.tugas || [])
      .map((t) => ({ agent: find(t.id), task: String(t.tugas || '').trim() }))
      .filter((t, i, all) => t.agent && t.task && all.findIndex((x) => x.agent === t.agent) === i);
    if (tasks.length) return { facts, summary: String(j.rencana || '').trim(), tasks };
  } catch { /* pakai cadangan di bawah */ }
  if (!fallbackAll) throw httpError(502, `rencana tidak terbaca: ${raw.slice(0, 120)}`);
  return { facts: '', summary: '', tasks: mates.map((m) => ({ agent: m, task: `Kerjakan bagian dari brief ini sesuai keahlianmu (${m.focus}):\n${brief}` })) };
}

// Balasan saat brief terlalu tipis: pertanyaan dulu, tim belum dipanggil (hemat kuota).
const askFirst = (who, questions) => `### ❓ ${firstName(who)} perlu info dulu sebelum membagi tugas\n`
  + questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
  + '\n\nJawab pertanyaan di atas (atau tulis "pakai asumsi saja"), lalu kirim lagi dengan kotak tim tetap dicentang.';
// ponytail: heuristik kasar, brief >= 8 kata dianggap cukup jelas dan tidak boleh dijawab dengan pertanyaan
// (AI cenderung terlalu sering bertanya). Kalau ada brief panjang yang tetap perlu ditanya, naikkan batasnya.
const mayAsk = (brief) => brief.trim().split(/\s+/).length < 8;
const factsBlock = (facts) => (facts ? `Fakta kunci (wajib dipakai sama persis, jangan diubah):\n${facts}\n\n` : '');

// Jalankan tugas-tugas bersamaan; hasil dikeluarkan sesuai urutan tugas. Satu gagal tidak menghentikan yang lain.
async function* runAll(tasks, work, signal, onStatus) {
  const jobs = tasks.map(async ({ agent, task }) => {
    onStatus(agent.id, 'working');
    try {
      const text = await work(agent, task);
      onStatus(agent.id, 'done');
      return { agent, text };
    } catch (err) {
      onStatus(agent.id, 'idle');
      if (signal.aborted) throw err;
      return { agent, text: '', error: friendlyError(err) };
    }
  });
  for (const j of jobs) j.catch(() => {}); // saat dibatalkan, cegah unhandled rejection dari job yang belum ditunggu
  for (const job of jobs) yield await job;
}

const planList = (who, plan, lines) => `### Rencana ${firstName(who)}\n${plan.summary ? `${plan.summary}\n\n` : ''}`
  + `${plan.facts ? `**Fakta kunci:** ${plan.facts}\n\n` : ''}${lines.join('\n')}\n\n`;
const firstLine = (s) => s.split('\n')[0].slice(0, 200);

// Mode kerja tim: leader membagi tugas -> anggota mengerjakan bersamaan -> leader menggabungkan.
// Menghasilkan teks markdown bertahap; onStatus(agentId, 'working'|'done'|'idle') untuk animasi karakter.
// verbose = false: hanya hasil akhir (dipakai saat leader bekerja di bawah manager).
async function* teamWork(leader, messages, signal, onStatus, verbose = true) {
  const mates = agentsOf(leader.division).filter((a) => a.id !== leader.id);
  const brief = messages[messages.length - 1].content;
  const leaderSystem = buildSystemPrompt(leader);

  // 1. Rencana (di bawah manager tidak boleh bertanya: brief sudah dicek Bram)
  const canAsk = verbose && mayAsk(brief);
  const planRaw = await collect(generate(leader, `${leaderSystem}\n\n${teamPlanPrompt(mates, canAsk)}`, messages, signal));
  const plan = parsePlan(planRaw, mates, brief, { canAsk });
  if (plan.questions) {
    yield askFirst(leader, plan.questions);
    return;
  }
  if (verbose) yield planList(leader, plan, plan.tasks.map((t) => `- **${firstName(t.agent)}** (${t.agent.role}): ${firstLine(t.task)}`));

  // 2. Anggota bekerja bersamaan
  const work = (agent, task) => collect(generate(agent, `${buildSystemPrompt(agent)}\n\n${TEAM_MEMBER}`,
    [{ role: 'user', content: `${factsBlock(plan.facts)}Tugasmu dari ${leader.name}:\n${task}\n\nBrief untuk tim ${divisionById(leader.division).name} (konteks):\n"""\n${brief}\n"""` }], signal));
  const results = [];
  for await (const r of runAll(plan.tasks, work, signal, onStatus)) {
    results.push(r);
    if (verbose) yield `### ${r.error ? '⚠️' : '✅'} ${firstName(r.agent)} · ${r.agent.role}\n${r.error ? `_Gagal: ${r.error}_` : r.text}\n\n`;
  }
  if (!results.some((r) => r.text)) throw httpError(503, 'semua anggota tim gagal');

  // 3. Leader menggabungkan
  const done = results.filter((r) => r.text).map((r) => `## ${r.agent.name} (${r.agent.role})\n${r.text}`).join('\n\n');
  if (verbose) yield `### 📝 Hasil akhir dari ${firstName(leader)}\n`;
  yield* generate(leader, `${leaderSystem}\n\n${TEAM_FINAL}`,
    [...messages.slice(0, -1), { role: 'user', content: `${brief}\n\n${factsBlock(plan.facts)}---\nHasil kerja timmu:\n\n${done}` }], signal, FINAL_MAX_TOKENS);
}

// Mode manager: GM membagi brief ke penanggung jawab divisi -> tiap leader bekerja bersama timnya
// (staf tunggal bekerja sendiri), semua divisi bersamaan -> GM menggabungkan jadi satu paket.
async function* managerWork(manager, messages, signal, onStatus) {
  const heads = AGENTS.filter((a) => a.id !== manager.id && (a.leader || agentsOf(a.division).length === 1));
  const brief = messages[messages.length - 1].content;
  const managerSystem = buildSystemPrompt(manager);
  const divName = (a) => divisionById(a.division).name;
  const hasTeam = (a) => agentsOf(a.division).length > 1;

  // 1. Rencana: pilih divisi
  const planRaw = await collect(generate(manager, `${managerSystem}\n\n${managerPlanPrompt(heads, mayAsk(brief))}`, messages, signal));
  const plan = parsePlan(planRaw, heads, brief, { fallbackAll: false, canAsk: mayAsk(brief) });
  if (plan.questions) {
    yield askFirst(manager, plan.questions);
    return;
  }
  yield planList(manager, plan,
    plan.tasks.map((t) => `- **${divName(t.agent)}** → ${firstName(t.agent)}${hasTeam(t.agent) ? ' & tim' : ''}: ${firstLine(t.task)}`));

  // 2. Divisi bekerja bersamaan
  // Tugas divisi ditaruh paling depan + daftar bagian divisi lain, supaya tiap divisi (dan timnya)
  // hanya mengerjakan bagiannya; brief asli hanya konteks. Tanpa ini semua divisi mengerjakan seluruh brief.
  const work = (head, task) => {
    const others = plan.tasks.filter((t) => t.agent !== head)
      .map((t) => `- ${divName(t.agent)}: ${firstLine(t.task)}`).join('\n');
    const content = `${factsBlock(plan.facts)}Tugas divisimu dari ${manager.name} (kerjakan HANYA ini):\n${task}\n\n`
      + (others ? `Bagian lain sudah dikerjakan divisi lain, JANGAN ikut dibuat:\n${others}\n\n` : '')
      + `Brief asli user (hanya untuk konteks):\n"""\n${brief}\n"""`;
    return hasTeam(head)
      ? collect(teamWork(head, [{ role: 'user', content }], signal, onStatus, false))
      : collect(generate(head, `${buildSystemPrompt(head)}\n\n${MANAGER_TASK}`, [{ role: 'user', content }], signal));
  };
  const results = [];
  for await (const r of runAll(plan.tasks, work, signal, onStatus)) {
    results.push(r);
    yield `### ${r.error ? '⚠️' : '✅'} ${divName(r.agent)} · ${firstName(r.agent)}${hasTeam(r.agent) ? ' & tim' : ''}\n${r.error ? `_Gagal: ${r.error}_` : r.text}\n\n`;
  }
  if (!results.some((r) => r.text)) throw httpError(503, 'semua divisi gagal');

  // 3. GM menggabungkan
  const done = results.filter((r) => r.text).map((r) => `## ${divName(r.agent)} (${r.agent.name})\n${r.text}`).join('\n\n');
  yield `### 📝 Hasil akhir dari ${firstName(manager)}\n`;
  yield* generate(manager, `${managerSystem}\n\n${MANAGER_FINAL}`,
    [...messages.slice(0, -1), { role: 'user', content: `${brief}\n\n${factsBlock(plan.facts)}---\nHasil kerja semua divisi:\n\n${done}` }], signal, FINAL_MAX_TOKENS);
}

// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({ demo: DEMO, needsCode: Boolean(ACCESS_CODE) });
});

app.get('/api/verify', requireAccess, (req, res) => res.json({ ok: true }));

// Sisa kuota per model, urut sesuai prioritas provider. limit/remaining null = belum diketahui.
// Groq tidak punya endpoint "sisa kuota"; angkanya hanya ada di header respons. Kalau server ini belum
// punya angkanya (baru dinyalakan / instance Vercel baru), kirim request 1 token, sekali per akun+model.
// Gemini sengaja tidak dicek begini: jatah gratisnya cuma 20/hari.
async function probeQuota(p, model, acct) {
  const q = quotaOf(p, model, acct.label);
  if (q.limit != null || q.probed) return;
  q.probed = true;
  try {
    const r = await fetch(`${p.baseURL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${acct.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
    });
    noteHeaders(q, r.headers);
    const body = await r.text();
    if (r.status === 429) noteLimited(q, r.headers, body);
  } catch { /* tidak apa-apa, baris tetap "belum ada data" */ }
}

app.get('/api/quota', requireAccess, async (req, res) => {
  const now = Date.now();
  const rows = [];
  for (const p of PROVIDERS) {
    if (p.name === 'groq') {
      await Promise.all([[p.leader, { key: p.key, label: 'utama' }], ...accountsFor(p, false, false).map((a) => [p.team, a])]
        .map(([model, acct]) => probeQuota(p, model, acct)));
    }
    const free = p.name === 'openrouter' ? await openRouterFree(p) : null;
    // leader: akun utama selalu; akun staf hanya kalau sudah pernah dipinjam leader hari ini
    const lines = accountsFor(p, true, false)
      .filter((a) => a.label === 'utama' || quotaOf(p, p.leader, a.label).used || quotaOf(p, p.leader, a.label).limit)
      .map((a) => ['leader', p.leader, a]);
    if (p.team !== p.leader || p.staff.length) {
      for (const a of accountsFor(p, false, false)) lines.push(['tim', p.team, a]);
    }
    for (const [role, model, acct] of lines) {
      const q = quotaOf(p, model, acct.label);
      const limit = free?.limit ?? q.limit ?? null;
      const remaining = free?.remaining ?? q.remaining ?? (limit == null ? null : Math.max(0, limit - q.used));
      rows.push({
        provider: p.name, model, role, used: free?.used ?? q.used, limit, remaining,
        account: p.staff.length ? acct.label : null, // hanya ditampilkan kalau provider punya akun staf
        shared: Boolean(free), // jatah OpenRouter dibagi semua model gratis
        blockedFor: Math.max(0, (q.blockedUntil || 0) - now),
      });
    }
  }
  res.json({ demo: DEMO, rows });
});

app.post('/api/chat', requireAccess, rateLimit, dailyCap, async (req, res) => {
  const agent = agentById(req.body?.agentId);
  if (!agent) return res.status(400).json({ error: 'Karyawan tidak ditemukan.' });

  const messages = cleanMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Pesan kosong.' });
  }

  // Lampiran otomatis di pesan terakhir user (ikut ke rencana, semua divisi, dan anggota tim):
  // profil klien aktif dari browser + isi halaman web yang ditautkan.
  if (!DEMO) {
    const last = messages[messages.length - 1];
    const client = String(req.body?.client || '').trim().slice(0, 2000);
    const pages = await readLinkedPages(last.content);
    if (client) last.content = `Profil klien aktif (pakai sebagai fakta utama, jangan diubah):\n${client}\n\n---\nPermintaan:\n${last.content}`;
    last.content += pages;
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
      // team: true -> GM membagi ke divisi, leader membagi ke anggota; selain itu chat biasa
      const multi = req.body?.team !== true ? null
        : agent.division === 'manager' ? managerWork
          : agent.leader && agentsOf(agent.division).length > 1 ? teamWork : null;
      const gen = multi
        ? multi(agent, messages, ac.signal, (who, state) => !closed && send({ who, state }))
        : generate(agent, buildSystemPrompt(agent), messages, ac.signal, FINAL_MAX_TOKENS); // dibaca langsung user
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

// Di Vercel, app dipakai sebagai serverless function (api/index.js) tanpa listen.
// ponytail: di Vercel, rate limit, batas harian, dan catatan kuota hanya di memori tiap instance
// (bisa reset saat instance baru dibuat); ACCESS_CODE tetap jadi pengaman utama.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Kantor AI API jalan di http://localhost:${PORT}`);
    console.log(DEMO ? 'Mode: DEMO (tanpa API key AI)'
      : `Mode: LIVE  urutan: ${PROVIDERS.map((p) => `${p.name}(${p.leader} / ${p.team}${p.staff.length ? `, ${p.staff.length} akun staf digilir` : ''})`).join(' > ')}`);
    console.log(ACCESS_CODE ? 'Kode akses: aktif' : 'Kode akses: TIDAK aktif (isi ACCESS_CODE sebelum dipublikasi)');
  });
}

export default app;
