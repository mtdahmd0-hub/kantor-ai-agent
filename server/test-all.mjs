// Tes semua karyawan: kirim satu pertanyaan ke tiap orang, tampilkan tabel hasil.
// Menjalankan server sendiri di port terpisah (memakai key di .env), jadi tidak mengganggu `npm run dev`.
//
//   node server/test-all.mjs            pertanyaan singkat (perkenalan), murah dan cepat
//   node server/test-all.mjs --quick    pakai tombol cepat pertama tiap karyawan (jawaban panjang)
//   node server/test-all.mjs rina putri cuma karyawan tertentu
import { spawn } from 'node:child_process';
import { AGENTS } from '../shared/roster.js';

const PORT = 3095;
const CONCURRENCY = 3; // jangan terlalu banyak sekaligus, kuota gratis provider kecil
const args = process.argv.slice(2);
const useQuick = args.includes('--quick');
const only = args.filter((a) => !a.startsWith('--'));
const agents = only.length ? AGENTS.filter((a) => only.includes(a.id)) : AGENTS;
if (!agents.length) throw new Error(`Karyawan tidak ditemukan: ${only.join(', ')}`);

const srv = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), ACCESS_CODE: '', RATE_PER_MINUTE: '1000', DAILY_MAX_REQUESTS: '1000' },
});
let log = '';
srv.stdout.on('data', (d) => (log += d));
srv.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50 && !log.includes('jalan di'); i++) await new Promise((r) => setTimeout(r, 100));
console.log(log.match(/Mode: .*/)?.[0] ?? log);
if (log.includes('Mode: DEMO')) console.log('PERINGATAN: mode demo, isi API key di .env dulu.');

async function test(agent) {
  const question = useQuick ? agent.quick[0] : 'Perkenalkan dirimu dalam 1-2 kalimat dan sebutkan 3 hal yang bisa kamu bantu.';
  const t0 = Date.now();
  try {
    const r = await fetch(`http://localhost:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, messages: [{ role: 'user', content: question }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const events = (await r.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
    const text = events.map((e) => e.t || '').join('').trim();
    const error = events.find((e) => e.error)?.error || (r.ok ? '' : `HTTP ${r.status}`);
    return { agent, text, error, secs: (Date.now() - t0) / 1000 };
  } catch (e) {
    return { agent, text: '', error: e.message, secs: (Date.now() - t0) / 1000 };
  }
}

const results = [];
const queue = [...agents];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const res = await test(queue.shift());
    results.push(res);
    const ok = res.text && !res.error;
    console.log(`${ok ? 'OK  ' : 'GAGAL'} ${res.agent.name.padEnd(18)} ${res.secs.toFixed(1).padStart(5)}s  ${ok ? res.text.slice(0, 70).replace(/\s+/g, ' ') : res.error}`);
  }
}));
await new Promise((r) => setTimeout(r, 200));
srv.kill();

// Ringkasan per karyawan, urut sesuai roster
const via = (id) => log.match(new RegExp(`\\[chat\\] ${id} via (\\S+) model=(\\S+)`))?.slice(1).join(' / ') || '-';
results.sort((a, b) => agents.indexOf(a.agent) - agents.indexOf(b.agent));
console.log('\nKaryawan            Divisi       Peran                   Provider / model                     Detik  Huruf');
for (const { agent, text, error, secs } of results) {
  console.log(`${(error ? '✗ ' : '✓ ') + agent.name.padEnd(18)}${agent.division.padEnd(13)}${(agent.role + (agent.leader ? ' *' : '')).slice(0, 23).padEnd(24)}${via(agent.id).padEnd(37)}${secs.toFixed(1).padStart(5)}  ${String(text.length).padStart(5)}`);
}
const failed = results.filter((r) => r.error || !r.text);
console.log(`\n${results.length - failed.length}/${results.length} karyawan menjawab.  (* = leader)`);
for (const e of log.match(/\[chat error\].*/g) || []) console.log('  log:', e.slice(0, 160));
process.exit(failed.length ? 1 : 0);
