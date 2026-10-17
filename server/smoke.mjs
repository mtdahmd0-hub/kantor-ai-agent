// Cek cepat provider + fallback (memakai key asli di .env, biaya sangat kecil).
// Jalankan: node server/smoke.mjs
// 1) normal: harus menjawab lewat provider pertama.
// 2) key provider yang menjawab di (1) dirusak: harus tetap menjawab lewat provider cadangan.
// 3) /api/quota mencatat pemakaian model yang menjawab.
// 4) GROQ_STAFF_KEYS: anggota tim digilir ke akun staf berbeda, leader tetap akun utama,
//    dan kalau semua akun staf gagal, anggota tim pakai akun utama.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

async function ask(extraEnv, port, agents = ['rina']) {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, ...extraEnv, PORT: String(port), ACCESS_CODE: '' } });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  try {
    for (let i = 0; i < 50 && !log.includes('jalan di'); i++) await new Promise((r) => setTimeout(r, 100));
    let events = [];
    for (const agentId of agents) {
      const r = await fetch(`http://localhost:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, messages: [{ role: 'user', content: 'Sapa saya dalam satu kalimat pendek.' }] }),
      });
      events = (await r.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
      if (events.find((e) => e.error)) break;
    }
    await new Promise((r) => setTimeout(r, 100));
    const quota = await (await fetch(`http://localhost:${port}/api/quota`)).json();
    return { quota, text: events.map((e) => e.t || '').join(''), error: events.find((e) => e.error)?.error, log };
  } finally {
    srv.kill();
  }
}

const a = await ask({}, 3091);
console.log('normal  :', a.log.match(/via \S+ model=\S+/)?.[0], '|', a.text.slice(0, 80).replace(/\s+/g, ' '));
assert.ok(a.text && !a.error, `normal gagal: ${a.error}\n${a.log}`);

const [, prov, model] = a.log.match(/via (\S+) model=(\S+)/);
const KEY_ENV = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
// rusak provider yang tadi menjawab (termasuk akun staf Groq, karena leader boleh meminjamnya)
const b = await ask({ [KEY_ENV[prov]]: 'rusak-untuk-tes', ...(prov === 'groq' && { GROQ_STAFF_KEYS: 'rusak-1,rusak-2' }) }, 3092);
console.log('fallback:', b.log.match(/via \S+ model=\S+/)?.[0], '|', b.text.slice(0, 80).replace(/\s+/g, ' '));
assert.match(b.log, new RegExp(`\\[chat error\\] ${prov}`), `${prov} seharusnya gagal`);
assert.ok(b.text && !b.error && !new RegExp(`via ${prov}`).test(b.log), `fallback gagal: ${b.error}\n${b.log}`);
const qrow = a.quota.rows.find((r) => r.provider === prov && r.model === model);
console.log('kuota   :', prov, model, qrow && `used=${qrow.used} limit=${qrow.limit} remaining=${qrow.remaining}`);
assert.ok(qrow && qrow.used >= 1, 'kuota tidak mencatat pemakaian');

const staffCount = String(process.env.GROQ_STAFF_KEYS || '').split(',').filter((k) => k.trim()).length;
if (staffCount && process.env.GROQ_API_KEY) {
  const team = ['bagas', 'siti', 'dimas', 'fajar'].slice(0, staffCount + 1);
  const c = await ask({ LLM_ORDER: 'groq' }, 3093, ['rina', ...team]);
  const acct = (id) => c.log.match(new RegExp(`\\[chat\\] ${id} via groq model=\\S+ akun=(utama|staf \\d+)`))?.[1];
  console.log('giliran :', ['rina', ...team].map((id) => `${id}=${acct(id)}`).join('  '));
  assert.ok(!c.error, `giliran gagal: ${c.error}\n${c.log}`);
  assert.equal(acct('rina'), 'utama', 'leader harus pakai akun utama');
  const used = team.slice(0, staffCount).map(acct);
  assert.ok(used.every((a) => /^staf/.test(a)), `anggota tim harus pakai akun staf dulu: ${used}`);
  assert.equal(new Set(used).size, staffCount, `akun staf harus bergiliran: ${used}`);

  const d = await ask({ LLM_ORDER: 'groq', GROQ_STAFF_KEYS: 'rusak-1,rusak-2' }, 3094, ['bagas']);
  console.log('staf habis -> utama:', d.log.match(/\[chat\] bagas via \S+ model=\S+ akun=\S+/)?.[0]);
  assert.match(d.log, /\[chat error\] groq model=\S+ akun=staf 1/);
  assert.match(d.log, /\[chat\] bagas via groq model=\S+ akun=utama/, 'staf seharusnya pindah ke akun utama');
}
console.log('OK');
