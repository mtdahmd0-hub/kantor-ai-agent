// Profil klien: pilih/tambah/ubah/hapus lewat dialog. Datanya di chat.js (localStorage).
import { getClients, saveClients, activeClient } from './chat.js';

const NEW = '__new__';
const NONE = '';

export function initClients() {
  const $ = (id) => document.getElementById(id);
  const bar = $('client-bar');
  const nameEl = $('client-name');
  const dlg = $('client-dialog');
  const select = $('client-select');
  const inName = $('client-input-name');
  const inText = $('client-text');
  const del = $('client-delete');

  const paintBar = () => {
    const c = activeClient();
    nameEl.textContent = c ? c.name : 'belum dipilih';
    bar.classList.toggle('on', Boolean(c));
  };

  const fill = (id) => {
    const { list } = getClients();
    const c = list.find((x) => x.id === id);
    inName.value = c ? c.name : '';
    inText.value = c ? c.text : '';
    const editing = id !== NONE;
    inName.disabled = !editing;
    inText.disabled = !editing;
    del.hidden = !c;
    if (id === NEW) inName.focus();
  };

  const open = () => {
    const { list, active } = getClients();
    select.innerHTML = '';
    select.append(new Option('— Tanpa profil klien —', NONE));
    for (const c of list) select.append(new Option(c.name, c.id));
    select.append(new Option('+ Klien baru…', NEW));
    select.value = active && list.some((c) => c.id === active) ? active : list.length ? NONE : NEW;
    fill(select.value);
    dlg.showModal();
  };

  select.addEventListener('change', () => fill(select.value));
  bar.addEventListener('click', open);
  $('client-cancel').addEventListener('click', () => dlg.close());

  del.addEventListener('click', () => {
    const d = getClients();
    const c = d.list.find((x) => x.id === select.value);
    if (!c || !confirm(`Hapus profil "${c.name}"?`)) return;
    d.list = d.list.filter((x) => x.id !== c.id);
    if (d.active === c.id) d.active = null;
    saveClients(d);
    paintBar();
    dlg.close();
  });

  $('client-form').addEventListener('submit', (e) => {
    const d = getClients();
    const id = select.value;
    if (id === NONE) {
      d.active = null;
    } else {
      const name = inName.value.trim();
      if (!name) {
        e.preventDefault();
        inName.focus();
        return;
      }
      const text = inText.value.trim();
      const existing = d.list.find((x) => x.id === id);
      if (existing) Object.assign(existing, { name, text });
      else d.list.push({ id: `c${Date.now().toString(36)}`, name, text });
      d.active = existing ? existing.id : d.list[d.list.length - 1].id;
    }
    saveClients(d);
    paintBar();
  });

  paintBar();
}
