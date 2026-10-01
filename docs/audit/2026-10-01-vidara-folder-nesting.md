# 2026-10-01 — Folder Vidara: bug per-episode + nesting lewat dashboard (bukan REST API)

Status: **DIIMPLEMENTASI + SEKALI JALAN** (approve user: "terserah lo", keputusan
root `Anime` = induk, jalur drama tidak disentuh).

## Masalah

User melaporkan folder di Vidara terbentuk **per episode**, bukan per judul.

Bukti di server (`GET /v1/folder/list`, 1 Okt 19:16 UTC):

```
total folder: 137
folder per-episode: 129   ← anime — Dragon Ball — Ep 01 … Ep 129 (videos: 1 masing-masing)
folder per-judul:    8
```

129 = jumlah episode yang berhasil di-upload. Semua **berisi file nyata**
(bukan sampah) — jadi penyelesaiannya reorganisasi, bukan sekadar hapus.

## Root cause

`scraper/handlers/vidoy.js` — satu argumen `title` dipakai untuk dua keperluan:

```js
// baris 475 (pemanggil)
const v = await uploadToVidaraFolder(destPath, `${vidoyTitle} — Ep ${NN}`);

// baris 237 (di dalam fungsi)
await Vdara.renameVideo(filecode, `${title}`);              // ✅ nama file per episode
const folderName = Vdara.vidaraFolderName(title, 'anime'); // ❌ suffix "— Ep NN" ikut ke folder
```

`vidaraFolderName` (`vidara-uploader.js:214`) hanya membungkus `${prov} — ${title}`.
Jalur drama tidak kena karena `title`-nya judul murni.

## Mengapa kelihatan "flat" selama ini

1. **Dokumentasi resmi** https://vidara.to/api → bagian Folder List:
   *"Folders are flat — there is no nesting."* `Folder Create` cuma menerima `name`.
2. Tes langsung: `folder/create?parent_id=-999999` (ID tidak valid) → **200 OK**
   tanpa error → `parent_id` diabaikan, bukan divalidasi. `/folder/list` tidak
   mengembalikan field parent apa pun (dicek 10 kandidat: `parent`,
   `parent_id`, `pid`, `level`, `depth`, `path`, `children`, … nihil;
   `code` selalu sama dengan `fld_id`).
3. Kita hanya memegang **API key** → semua yang terlihat dari `v1/folder/list`
   memang datar.

## Temuan: nesting ADA, lewat dashboard (butuh session login)

Diambil dari JS dashboard (`GET https://vidara.to/login`, inline script):

```js
POST https://vidara.to/files
body: { action:'create', folder_name:'…', parent_id:'<fld_id induk>' }
header: X-CSRF-Token: decodeURIComponent(cookie.csrf_token)   // dari Set-Cookie
        Origin: https://vidara.to                             // WAJIB
payload login: { username, password, fingerprint:{browser:{name,version}} }
```

- **Tanpa header `Origin`** → `403 {"message":"Security check failed…"}`
- Token CSRF harus lewat `decodeURIComponent` (nilai cookie ber-encoding).
- `fingerprint` = info browser yang diekstrak dari User-Agent (mudah ditiru).
- Login sukses → cookie `session_token`.

### Bukti eksekusi (tes reversible, 1 Okt 19:41 UTC)

```
login POST: 200 {"success":true}
create parent → {"success":true}  zz-probe-parent = fld_id 33132
create child  → {"success":true}  zz-probe-child  = fld_id 33133 (parent_id=33132)
GET /files?folder_id=33132 memuat "zz-probe-child" : true   ✅
GET /files?folder_id=33133 memuat "zz-probe-parent": true   ✅ (breadcrumb dua arah)
hapus keduanya via REST /v1/folder/delete → deleted:true, sisa probe 0  ✅
```

Catatan: `/v1/folder/list` **tetap datar** bahkan setelah ada anak → untuk cek
keberadaan folder harus lewat `GET /files?folder_id=` (HTML dashboard).

## Endpoint yang terbukti (untuk rencana reorganisasi)

| endpoint | fakta kunci |
|---|---|
| `POST /files` (dashboard, session) | satu-satunya cara buat folder **bersarang** |
| `GET /v1/folder/create?name=` (API key) | flat saja, tanpa parent |
| `GET /v1/folder/delete?fld_id=` | **aman** — docs: *"videos inside are kept and moved back to the root"* |
| `GET /v1/folder/edit?fld_id=&name=` | rename — belum dipakai kode |
| `GET /v1/video/list?fld_id=&page=&limit=` | isi per folder (limit max 200) |
| `GET /v1/video/move?filecode=&fld_id=` | pindah file — **tanpa session**, `fld_id=0` = ke root |

Pola benar (dibandingkan dengan bot milik user di repo lain): **1 folder per
series**, semua episode → `fld_id` sama (27 video → 1 folder, bukan 27 folder).

## Rencana (menunggu approve)

Target struktur sesuai permintaan user:

```
Anime/                 ← fld_id 33106 (sudah ada, dibuat user)
  Dragon Ball/          ← POST /files, parent_id=33106
    Dragon Ball — Ep 01 … Ep 129   ← video/move via API key
```

- **A.** Fix `uploadToVidaraFolder(destPath, title, folderTitle)` → nama folder
  dari judul polos; `renameVideo` tetap per-episode. Test: assert argumen folder
  tidak mengandung `— Ep`.
- **B.** Modul session dashboard (`createFolderNesting`) dengan **fallback
  otomatis ke folder flat** — endpoint `POST /files` undocumented, kalau berubah
  upload tidak boleh ikut gagal.
- **C.** Reorganisasi 129 folder lama: buat `Anime/Dragon Ball` → `video/list`
  tiap folder → `video/move` → `folder/delete` folder kosong (nol risiko file
  hilang).
- **D.** Tag **minor** `v3.5.0`.

Pertanyaan yang belum dijawab user: (1) root `Anime` dipakai sebagai induk —
setuju? (2) jalur drama ikut di-nest atau tidak?

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/vidara-dashboard.js` | **BARU** — session login dashboard (`POST /login` + `X-CSRF-Token` + `Origin`), `createNestedFolder` (`POST /files` + `parent_id`), `getOrCreateSeriesFolder` (lookup by nama → nested → fallback flat) |
| `scraper/handlers/vidoy.js` | `uploadToVidaraFolder(destPath, title, folderTitle)` — folder dari `folderTitle` (judul polos); pemanggil teruskan `vidoyTitle`; `require('../vidara-dashboard')` |
| `.tests/vidara-series-folder.js` | **BARU** — tes fix (14 assertion, reversible) |
| `.tests/vidara-folder-nesting.js` | **BARU** — tes bukti nesting dashboard (reversible) |
| `.tests/vidara-reorganize-folders.js` | **BARU** — script reorganisasi idempoten (dry-run default, `--execute`) |
| `AGENTS.md` §2.4, `SKILL.md` poin 2 | Aturan file tes wajib di `.tests/`, bukan `/tmp` |

## Detail Teknis

- **Root cause fix**: satu argumen `title` (per episode) dipakai untuk
  `renameVideo` DAN `vidaraFolderName` → suffix `— Ep NN` bocor ke nama folder.
  Kini terpisah: `title` untuk nama file, `folderTitle` untuk folder.
- **`getOrCreateSeriesFolder(judul)`** — urutan aman:
  1. nama sudah ada di `/folder/list` (nested ATAU flat — sama fungsinya) → pakai
  2. belum ada → buat **anak** root `Anime` via `POST /files` (session)
  3. session/endpont gagal → buat **flat** via API key dengan nama SAMA (judul)
  → inti fix (folder per judul) tetap tercapai walau nesting mati.
- Cache `judul → fld_id` in-memory mencegah double-create.
- Endpoint `POST /files` **tidak terdokumentasi** → fallback wajib; kredensial
  `VIDARA_USERNAME`/`VIDARA_PASSWORD` dari env (tidak pernah dicetak).

## Reorganisasi 129 folder (sekali jalan)

- Run 1: **129 video di-move** ke `Dragon Ball` (fld_id 33109), tapi delete
  tertahan — penentu "kosong" memakai `/video/list?fld_id=` yang **TERBUKTI basi**
  (masih menampilkan video yang sudah pindah).
- Fix script: penentu = **`/folder/list` → `videos === 0`** (count per folder,
  konsisten: legacy 0, tujuan 129).
- Run 2: **129 folder lama dihapus, 0 gagal, 0 dilewati**.
- Hasil akhir: total folder **137 → 10**; `Anime` (0) + `Dragon Ball` (129 video)
  + folder drama tetap; `legacy sisa: 0`.

## Verification

- `node --check` `vidara-dashboard.js` + `handlers/vidoy.js` → lolos.
- `.tests/vidara-series-folder.js` → **14 pass, 0 fail**, termasuk bukti langsung:
  judul baru muncul sebagai **anak** `Anime` (`GET /files?folder_id=<Anime>`),
  judul lama dipakai tanpa menambah folder, probe dibersihkan.
- Bot jalan dengan kode baru (user start 20:02, pid 12299, cwd =
  `/home/runner/workspace` = HEAD); `Polling started` tanpa error baru
  (error terakhir 17:18, sebelum start).

## Catatan lanjutan (di luar scope, TIDAK dikerjakan)

- **Jalur drama** (`vidaraService.js` / `vidara-uploader.js:245`) sengaja tidak
  disentuh — sudah benar per judul; kalau mau di-nest di bawah `Anime` itu
  perubahan terpisah.
- Bot saat ini berjalan **tanpa pm2** (proses manual, `pm2 list` kosong) →
  tidak ada auto-restart. Kalau mau dipindah ke pm2: matikan proses manual
  dulu, jangan dinyalakan berduaan (risiko `409 Conflict` getUpdates).
- `scraper/vidara.js:86` `makeEmbedUrl` masih mematok `https://vidara.so/e/…`
  — dead code (tidak dipakai siapa pun), dilaporkan saja.

## File tes

`.tests/vidara-folder-nesting.js` — jalankan ulang kapan saja:

```bash
node .tests/vidara-folder-nesting.js   # butuh VIDARA_USERNAME, VIDARA_PASSWORD, VIDARA_API
```

Hasil terakhir: nesting terbukti, semua probe dibersihkan (sisa 0).
