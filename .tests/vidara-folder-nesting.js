// Tes nesting folder Vidara via dashboard POST /files — reversible (dihapus di akhir)
//
// Jalankan dari root repo:   node .tests/vidara-folder-nesting.js
// Butuh env: VIDARA_USERNAME, VIDARA_PASSWORD, VIDARA_API
// (cookie csrf_token harus di-decodeURIComponent; POST /login wajib bawa header
//  Origin: https://vidara.to — tanpa itu ditolak 403 "Security check failed")
//
// Hasil terakhir (1 Okt 2026): nesting TERBUKTI jalan —
//   parent zz-probe-parent = fld_id 33132, child zz-probe-child = 33133,
//   halaman /files?folder_id=33132 memuat child (dan sebaliknya),
//   keduanya dihapus via REST /v1/folder/delete → sisa probe 0.
const BASE = 'https://vidara.to';
const USER = process.env.VIDARA_USERNAME;
const PASS = process.env.VIDARA_PASSWORD;
const API_KEY = process.env.VIDARA_API;
const REST = 'https://api.vidara.so/v1';

let cookies = {};

function saveCookie(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    ...opts,
    headers: { 'user-agent': UA, origin: BASE, ...(opts.headers || {}), ...(cookieHeader() ? { cookie: cookieHeader() } : {}) },
  });
  saveCookie(res);
  return res;
}

async function rest(ep, params) {
  const u = `${REST}${ep}?api_key=${API_KEY}&${new URLSearchParams(params)}`;
  const r = await fetch(u);
  return { s: r.status, t: await r.text() };
}

(async () => {
  // 1) GET /login → ambil cookie csrf_token
  const lg = await req('/login');
  await lg.text();
  const csrf = cookies['csrf_token'] ? decodeURIComponent(cookies['csrf_token']) : '';
  console.log('login page:', lg.status, '| csrf token:', csrf ? 'ada' : 'tidak ada');

  // 2) POST /login — persis pola dashboard: JSON + X-CSRF-Token + fingerprint
  const lr = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'user-agent': UA, accept: 'application/json' },
    body: JSON.stringify({
      username: USER,
      password: PASS,
      fingerprint: { browser: { name: 'Chrome', version: '131' } },
    }),
  });
  const lrTxt = await lr.text();
  console.log('login POST:', lr.status, '|', lrTxt.slice(0, 150));

  // verifikasi: buka /files — kalau masih dilempar /login berarti gagal
  const probe = await req('/files');
  const probeTxt = await probe.text();
  const loggedIn = !/\/login/.test(probe.headers.get('location') || '') && !/name="username"/.test(probeTxt);
  console.log('verifikasi login:', probe.status, loggedIn ? 'MASUK' : 'GAGAL', '| cookie:', Object.keys(cookies).join(','));
  if (!loggedIn) { console.log('LOGIN GAGAL — berhenti, tidak ada yang dibuat'); return; }

  // 3) buka /files untuk ambil token halaman (kalau dipakai)
  const fl = await req('/files');
  const fhtml = await fl.text();
  const ptoken =
    (fhtml.match(/name="_token"\s+value="([^"]+)"/) || [])[1] ||
    (fhtml.match(/csrf-token"\s+content="([^"]+)"/) || [])[1] || csrf;
  console.log('/files:', fl.status, '| token halaman:', ptoken ? 'ada' : 'tidak');

  // 4) create PARENT
  const pRes = await req('/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ action: 'create', folder_name: 'zz-probe-parent', parent_id: '', _token: ptoken }),
  });
  const pTxt = await pRes.text();
  console.log('create parent →', pRes.status, pRes.headers.get('location') || '', '|', pTxt.slice(0, 200));

  // cari id parent dari list REST
  const list1 = JSON.parse((await rest('/folder/list')).t);
  const parent = (list1.result?.folders || []).find(f => f.name === 'zz-probe-parent');
  console.log('parent id:', parent ? parent.fld_id : 'TIDAK KETEMU');
  if (!parent) { console.log('berhenti — tidak ada yang perlu dihapus'); return; }

  // 5) create CHILD dengan parent_id
  const cRes = await req('/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ action: 'create', folder_name: 'zz-probe-child', parent_id: String(parent.fld_id), _token: ptoken }),
  });
  const cTxt = await cRes.text();
  console.log('create child  →', cRes.status, cRes.headers.get('location') || '', '|', cTxt.slice(0, 200));

  const list2 = JSON.parse((await rest('/folder/list')).t);
  const child = (list2.result?.folders || []).find(f => f.name === 'zz-probe-child');
  console.log('child id:', child ? child.fld_id : 'TIDAK KETEMU');

  // 6) VERIFIKASI nesting: buka /files?folder_id=parent → ada child?
  if (child) {
    await req(`/files?folder_id=${parent.fld_id}`);
    const inside = await (await req(`/files?folder_id=${parent.fld_id}`)).text();
    const hasChildInParentPage = inside.includes('zz-probe-child');
    const childPage = await (await req(`/files?folder_id=${child.fld_id}`)).text();
    const parentMentionInChild = /zz-probe-parent/.test(childPage);
    const breadcrumb = (inside.match(/folder_id=(\d+)[^>]*>\s*zz-probe/gi) || []).slice(0, 4);
    console.log('=== VERIFIKASI ===');
    console.log('halaman parent memuat child :', hasChildInParentPage);
    console.log('halaman child  memuat parent:', parentMentionInChild);
    console.log('link folder di halaman parent:', JSON.stringify(breadcrumb));
    // cek URL addressable: apakah child bisa dibuka lewat URL parent?parent=child
  }

  // 7) BERSIHKAN via REST API (terbukti jalan)
  for (const f of [child, parent].filter(Boolean)) {
    const d = await rest('/folder/delete', { fld_id: f.fld_id });
    console.log('hapus', f.name, '→', d.s, d.t.slice(0, 80));
  }
  const after = JSON.parse((await rest('/folder/list')).t);
  const sisa = (after.result?.folders || []).filter(f => /^zz-probe/.test(f.name));
  console.log('sisa probe:', sisa.length);
})().catch(e => console.log('ERR', e.message));
