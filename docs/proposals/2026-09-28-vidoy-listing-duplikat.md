# Proposal: listing file Vidoy — tutup duplikat dengan verifikasi ke sumber

Tanggal: 2026-09-28
Status: MENUNGGU APPROVE
Menggantikan: `2026-09-28-vidoy-pending-record.md` (pending-record tidak lagi diperlukan)

---

## 1. Koreksi terhadap proposal sebelumnya

Proposal `2026-09-28-vidoy-pending-record.md` dibangun di atas assertion "tidak ada endpoint
listing file di Vidoy". **Assertion itu salah.** Endpoint-nya ada dan sudah diuji langsung:

```
GET https://vidoy.asia/folder_ajax/<folderId>?p=<n>&l=<perPage>&q=&f=date&s=DESC
Header wajib: Accept: application/json, X-Requested-With: XMLHttpRequest
Cookie: session login bot (/tmp/vidoy_bot_cookies.txt, sudah ada)
```

Respons JSON (terverifikasi):

```json
{
  "meta": { "title": "📂 One Piece", ... },
  "page": { "current": 1, "next": 2, "number": [1,2,3], "max": 9 },
  "contents": {
    "folder":  { "id": "fx9wycxor3h", "name": "One Piece", "parent": "0kemjvcuq8e" },
    "videos":  [ { "id": "20msvw48nicx", "title": "One Piece — Ep 208.mp4",
                   "size": "100.5 MB", "duration": "00:24:00",
                   "date": "28-09-2026", ... } ],
    "totalResults": 500
  }
}
```

`videos[].id` = filecode = bagian terakhir link publik `/d/<id>`.
`videos[].title` = nama file persis seperti di-upload.

Struktur ini **JSON stabil**, bukan HTML yang perlu di-parse rapuh.

## 2. Biaya Terukur (bukan estimasi)

`l=100` dipakai langsung (server hormat, `page.max` = 5 untuk 500 file).

| Anime | file | request | waktu |
|-------|-----:|--------:|------:|
| Naruto Shippuden | 500 | 5 | 0,72 dtk |
| Naruto Kecil | 220 | 3 | — |
| One Piece | 212 | 3 | — |
| Re:Zero S1 / S2 | 25 / 25 | 1 / 1 | — |

Rata-rata **143 ms per request**. Listing satu folder penuh = beberapa ratus milidetik.
Untuk Naruto (500 episode) hanya **5 request** — bukan 500.

## 3. Kenapa Ini Menutup Duplikat (dan pending-record tidak)

Jendela duplikat terjadi karena `uploadSingle` hanya percaya DB:

```js
const existing = (await db.listVidoyUploads(mediaKey, kind))
  .find((r) => Number(r.part) === num && r.link);
```

Kalau proses mati antara `uploadFile` dan `saveVidoyUpload`, DB kosong padahal file sudah
ada di Vidoy → episode di-upload lagi.

Dengan listing, sumber kebenaran jadi **dua sisi**:

```
1. resolveFolder() → dapat folderId
2. listFolderFiles(folderId) → Set{ title, id }   ← sekali per anime, di-cache
3. uploadSingle cek: nama file "X — Ep N.mp4" sudah ada di Set?
   sudah  → skip, catat link dari listing   (tidak upload ulang)
   belum  → upload seperti biasa
```

Kalau DB kosong tapi Vidoy punya file dengan nama yang sama → **ter-detect, di-skip**.
Itu persis kasus yatim yang ditemukan (ep 204/205/401/494/495).

Cache per `folderId` invalidated kalau `resolveFolder` mengembalikan folder baru.
Per batch 500 episode: 5 request listing + 0 request per episode (hasil di-cache).

## 4.SKEMA Fix

### `scraper/vidoy-uploader.js` — 2 fungsi baru

```js
async function listFolderFiles(folderId) {
  await ensureSession();
  const perPage = 100;
  const out = [];
  let page = 1;
  for (;;) {
    const res = await curlWithCode([
      '-H', 'Accept: application/json',
      '-H', 'X-Requested-With: XMLHttpRequest',
      ...baseArgs(),
      `${VIDOY_BASE}/folder_ajax/${encodeURIComponent(folderId)}?p=${page}&l=${perPage}&q=&f=date&s=DESC`,
    ]);
    if (res.code !== 200) throw new Error(`Vidoy folder_ajax HTTP ${res.code}`);
    let data;
    try { data = JSON.parse(res.body); } catch { throw new Error('folder_ajax body bukan JSON'); }
    const videos = data?.contents?.videos || [];
    out.push(...videos);
    const next = data?.page?.next;
    if (!next || !videos.length) break;
    page = next;
  }
  return out; // [{id, title, size, duration, date}]
}
```

`folderFileIndex(folderId)` — helper yang mengembalikan `Map` dua arah:
- byTitle: `"One Piece — Ep 208.mp4"` → item
- byId: `"20msvw48nicx"` → item
plus cache `Map<folderId, {byTitle, byId, at}>` dengan TTL sederhana.

### `scraper/services/vidoyService.js` — `uploadSingle`

Setelah `resolveFolder` (punya `folder.id`), sebelum `ensureMp4`/`uploadFile`:

```js
if (folder && folder.id) {
  const index = await Vidoy.folderFileIndex(folder.id);   // di-cache
  const wantName = `${Vidoy.sanitizeFolderName(title || mediaKey)} — Ep ${pad(num)}.mp4`;
  const hit = index.byTitle.get(wantName);
  if (hit) {
    // sudah ada di Vidoy — jangan upload ulang (§6)
    return { ok: true, skipped: true, fromListing: true,
             link: existingLinkOrBuild(hit.id), filecode: hit.id, part: num, ... };
  }
}
```

Kalau listing gagal (network/session) → **fallback ke perilaku sekarang** (DB check),
supaya listing tidak jadi titik gagal baru. Log warn sekali per folder.

### Tidak mengubah `listVidoyUploads` di db.js

Resume tetap `.find(r => r.part === num && r.link)`. Record `link NULL` tidak akan
pernah muncul karena tidak ada pending-record. Tidak ada risiko "episode hilang permanen".

## 5. SKEMA Test

`scraper/tests/test-vidoy-listing.js` (baru):

1. `listFolderFiles` pagination: 3 halaman (100/100/37) → 237 item, `next` dihormati
2. Halaman kosong (`videos: []`) → stop, tidak loop
3. `next: null` → stop
4. HTTP != 200 → throw dengan pesan jelas
5. Body bukan JSON → throw
6. `folderFileIndex` cache: 2× panggil folder sama → hanya 1 network call
7. `uploadSingle`: nama file SUDAH ada di listing → `skipped: true`, `uploadFile` **tidak** dipanggil
8. `uploadSingle`: nama file belum ada → `uploadFile` dipanggil
9. Listing GAGAL → fallback ke cek DB, `uploadFile` tetap dipanggil (tidak jadi blocker)
10. Case sensitivity & separator: `—` vs `-` di nama file tetap match (pakai normalisasi yg sama dgn `sanitizeFolderName`)

Mutation test: hapus baris cache-check → test 6 harus gagal;
hapus guard `if (hit)` → test 7 harus gagal.

## 6. SKOPE File

- `scraper/vidoy-uploader.js` — +2 fungsi, +cache, +2 export
- `scraper/services/vidoyService.js` — blok listing di `uploadSingle`
- `scraper/tests/test-vidoy-listing.js` — baru

Tidak menyentuh: DB, data Vidoy, `handlers/vidoy.js`, `bot.js`, `db.js`, folder.

## 7. Risiko

- **Listing gagal** → fallback ke DB check (perilaku sekarang). Tidak ada episode yang
  gagal total karena listing.
- **False positive skip**: kalau nama file identik tapi Isinya episode berbeda — tidak
  mungkin di satu folder karena satu folder = satu anime satu season. Nuno 500 file
  Naruto 500 nama unik, 0 duplikat title (terverifikasi).
- **Race**: dua proses upload episode yang sama bersamaan → keduanya lihat "belum ada".
  Ini sama seperti sekarang; tidak memburuk.
- **Waktu tambahan**: 5 request (~0,7 dtk) per anime per batch. Tidak per episode.

## 8. Temuan Samping (Reported, Tidak Di-fix)

Dari cross-check `/folders` —Vidoy punya 12 folder, tapi `vidoy_uploads` di DB PRJS cuma
2 key (Naruto Shippuden, One Piece):

| folder | file | di DB PRJS? |
|--------|-----:|-------------|
| Naruto Shippuden | 500 | ✅ 500 rows |
| One Piece | 212 | ✅ 209 rows (jalan) |
| Naruto Kecil | 220 | ❌ tidak ada |
| Re:Zero S1 | 25 | ❌ (ada di DB fomo-drama) |
| Re:Zero S2 | 25 | ❌ (ada di DB fomo-drama) |
| Black Torch | ? | ❌ |
| Terobsesi Padanya Siang dan Malam | ? | ❌ (drama) |

Artinya ada anime yang **sudah lengkap di Vidoy tapi tidak registered di DB PRJS**.
Konsekuensinya: kalau user run "Download Semua" Naruto Kecil dari PRJS, listing akan
men-github file yang sudah ada → **skip semua 220**. Itu perilaku benar (§6), tapi
pengguna mungkin tidak sadar episode itu "sudah ada". Perlu keputusan: apakah Vidoy jadi
acuan "sudah ada" walaupun tidak ada di DB?Report ini — tidak ada kode yang diubah.

## 9. Verifikasi Rencana

- `node --check` untuk 2 file
- test baru: 10 test + mutation
- regresi: `test-vidoy-uploader.js` (157), `test-media-key-konsisten.js` (15),
  `test-kamenime-batch.js` (11), `test-media-contract.js` (10)
- smoke test nyata: `listFolderFiles` dijalankan pada folder Naruto sungguhan
  (read-only, tidak mengubah apa pun)
- tidak ada restart selama batch One Piece jalan
