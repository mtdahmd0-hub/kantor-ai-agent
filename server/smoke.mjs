// Cek cepat provider + fallback (memakai key asli di .env, biaya sangat kecil).
// Jalankan: node server/smoke.mjs
// 1) normal: harus menjawab lewat provider pertama.
// 2) GEMINI_API_KEY dirusak: harus tetap menjawab lewat provider cadangan.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

async function ask(extraEnv, port) {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, ...extraEnv, PORT: String(port), ACCESS_CODE: '' } });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  try {
    for (let i = 0; i < 50 && !log.includes('jalan di'); i++) await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(`http://localhost:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'rina', messages: [{ role: 'user', content: 'Sapa saya dalam satu kalimat pendek.' }] }),
    });
    const events = (await r.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
    await new Promise((r) => setTimeout(r, 100));
    return { text: events.map((e) => e.t || '').join(''), error: events.find((e) => e.error)?.error, log };
  } finally {
    srv.kill();
  }
}

const a = await ask({}, 3091);
console.log('normal  :', a.log.match(/via \S+ model=\S+/)?.[0], '|', a.text.slice(0, 80).replace(/\s+/g, ' '));
assert.ok(a.text && !a.error, `normal gagal: ${a.error}\n${a.log}`);

const b = await ask({ GEMINI_API_KEY: 'rusak-untuk-tes' }, 3092);
console.log('fallback:', b.log.match(/via \S+ model=\S+/)?.[0], '|', b.text.slice(0, 80).replace(/\s+/g, ' '));
assert.match(b.log, /\[chat error\] gemini/, 'gemini seharusnya gagal');
assert.ok(b.text && !b.error && !/via gemini/.test(b.log), `fallback gagal: ${b.error}\n${b.log}`);
console.log('OK');
