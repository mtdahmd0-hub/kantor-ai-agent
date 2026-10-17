// Klien chat: simpan riwayat per karyawan (localStorage, opsional) dan baca stream SSE dari /api/chat.

const KEY_HISTORY = 'kantorai.history.v1';
const KEY_CODE = 'kantorai.code';

const safe = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* abaikan */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* abaikan */ }
  },
};

let histories = {};
try { histories = JSON.parse(safe.get(KEY_HISTORY) || '{}') || {}; } catch { histories = {}; }

const persist = () => safe.set(KEY_HISTORY, JSON.stringify(histories));

export const getHistory = (id) => histories[id] || [];
export function setHistory(id, list) {
  histories[id] = list.slice(-40);
  persist();
}
export function clearHistory(id) {
  delete histories[id];
  persist();
}

export const getCode = () => safe.get(KEY_CODE) || '';
export const setCode = (c) => (c ? safe.set(KEY_CODE, c) : safe.del(KEY_CODE));

export async function fetchConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error('config');
    return await r.json();
  } catch {
    return { demo: false, needsCode: false, offline: true };
  }
}

// Ringkas riwayat sebelum dikirim: server hanya memakai 20 pesan terakhir dan memotong jawaban panjang,
// jadi tidak perlu mengirim lebih (riwayat berisi hasil Bram bisa ratusan KB).
export const trimForSend = (messages) =>
  messages.slice(-20).map((m) => (m.content.length > 12_000 ? { ...m, content: m.content.slice(0, 12_000) } : m));

// Mengirim riwayat + pesan baru. Memanggil onText(potongan) saat streaming.
// team = mode kerja tim (khusus leader); onWho(agentId, status) dipanggil saat anggota mulai/selesai.
// Melempar Error dengan .code === 401 bila kode akses salah.
export async function streamChat(agentId, messages, { onText, onWho, signal, team = false }) {
  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-code': getCode() },
      body: JSON.stringify({ agentId, messages: trimForSend(messages), team }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Tidak bisa menghubungi server. Cek koneksi atau pastikan backend jalan.');
  }

  if (!res.ok) {
    let msg = 'Terjadi kesalahan.';
    try { msg = (await res.json()).error || msg; } catch { /* abaikan */ }
    const err = new Error(msg);
    err.code = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith('data:')) continue;
      let evt;
      try { evt = JSON.parse(raw.slice(5).trim()); } catch { continue; }
      if (evt.error) throw new Error(evt.error);
      if (evt.who) onWho?.(evt.who, evt.state);
      if (evt.t) {
        full += evt.t;
        onText(evt.t, full);
      }
    }
  }
  return full;
}
