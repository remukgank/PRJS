# Multi-akun Vidara — menu pilihan akun aktif, tanpa rotasi otomatis (11 Okt 2026)

## Konteks

User punya **2 akun Vidara**, masing-masing punya folder Anime + Drama:

| Akun | Anime | Drama |
|---|---|---|
| 1 | `f/WIwN753` | `f/WopyJJ3` |
| 2 | `f/WWkO5JJ` | `f/WWi7QLS` |

Permintaan: support multi-username (password disamakan) + **menu pilihan akun
default**. Larangan eksplisit: **jangan auto-rotasi per episode** — bisa
memecah 1 judul (full episode) antar akun (folder berbeda per akun, link
campur, library kacau).

Root cause terkait (11 Okt, sesi sebelum): folder "sejajar" (Dragon Ball Super
sejajar Anime) = kredensial split-akun — dashboard login (username/pass) beda
akun dengan API key → `parent_id` tak ter-resolve → fallback flat. Fitur ini
sekaligus memberi kendalikan user: username dan API key dipilih **per index**
sehingga slot i selalu satu akun yang konsisten.

## Keputusan desain (di-approve user)

- **1 akun aktif dipilih manual** via menu admin "👤 Akun Vidara".
  Semua operasi (upload, folder nesting `Anime/<judul>`, link, delete)
  memakai **akun aktif** — tanpa switch diam-diam.
- Limit harian habis → pesan jelas + saran ganti akun via menu
  (kalau `accountCount() > 1`).
- Kontrak media §5 **tidak berubah** (caption tetap 1 Link + Server VIDARA).

## Implementasi

- **Env**: `VIDARA_USERNAME` = daftar koma (`user1,user2`),
  `VIDARA_API`/`VIDARA_API_KEY` = daftar koma urut sejajar,
  `VIDARA_PASSWORD` tunggal untuk semua.
  Back-compat: 1 nilai = 1 akun, perilaku lama identik.
- **State module** (`scraper/vidara-uploader.js`): `ACTIVE_ACCOUNT` (0-based),
  `setActiveAccount/getActiveAccount/accountCount/activeApiKey/usernameFor/
  accountLabel`; `vidaraCall` + `uploadFileRef` memakai `activeApiKey()`;
  `VIDARA_KEY` export = key[0] (guard `!!VIDARA_KEY` lama tetap valid).
- **`vidara-dashboard.js`**: `login()` memakai `Vdara.activeUsername()` +
  password tunggal; `resetSession()` ikut `folderCache.clear()` (fld_id akun
  lama tidak berlaku di akun baru).
- **DB** (`scraper/db.js`):
  - `vidara_uploads` + kolom `account INTEGER DEFAULT 0` (migration
    `ADD COLUMN IF NOT EXISTS` — **sudah dijalankan manual di DB live** saat
    implementasi, idempotent).
  - `saveVidaraUpload(..., account)`; SELECT `getVidaraUpload` +
    `listVidaraUploads` ikut mengambil `account` (AGENTS §4: SELECT lengkap).
  - `getVidaraActiveAccount/setVidaraActiveAccount` → `bot_settings`.
- **Delete akurat**: `deleteVideo(filecode, accountIdx)` — file milik akun 1
  tidak bisa dihapus dengan key akun 2, jadi pemanggil meneruskan
  `preVidara.account` (kolom pemilik record) — mencegah file yatim yang tak
  pernah bisa dibersihkan.
- **Flag limit per-akun**: `vidara_limit_reset_at:<idx>` — limit 200/hari
  berlaku per akun; flag global lama akan memblokir akun 2 yang masih punya
  kuota (dibuktikan saat desain).
- **Menu**: `handlers/admin.js` tombol `👤 Akun Vidara` (sebaris dengan
  Domain Vidara) → `bot.js` handler `act:vidara_account` (daftar akun + ✅
  aktif) + `act:vidara_acc:<idx>` (simpan DB, set state, reset session
  dashboard); startup load akun aktif dari `bot_settings`.

## Pengujian (hasil nyata, 11 Okt 2026)

- `node --check` 9 file yang berubah — semua OK.
- `.tests/vidara-multi-account.js` (baru): **9/9 pass** — parse env multi via
  subprocess (accountCount/usernameFor/apiKeyFor/clamp/activeApiKey), struktural
  (vidaraCall+uploadFileRef activeApiKey, login activeUsername, resetSession
  clear cache, deleteVideo accountIdx, flag per-akun, 4 titik saveVidaraUpload
  +account, migration+export, tombol+handler+startup), **DB roundtrip asli**
  (record `account` terbaca, get/setVidaraActiveAccount roundtrip + restore).
- `scraper/tests/test-batch-quota.js` 19/19 — assertion struktural disesuaikan
  (flag per-akun; jendela cek pre-check 600→1200 char karena pesan saran).
- `scraper/tests/test-vidara-anime.js` 25/25 · `test-media-contract.js` 12/12.
- `.tests/vidara-active-domain.js` 10/10 · `batch-skip-vt.js` 8/8 ·
  `caption-server-line.js` 13/13 · `vidara-series-folder.js` 14/14 ·
  `vidara-reorganize-folders.js` dry-run OK (0 request).

## Catatan deploy

- Kode **belum live** — butuh restart bot oleh owner (aturan §3).
- Secrets agar multi-akun aktif: `VIDARA_USERNAME=user1,user2`,
  `VIDARA_API=key1,key2` (urut sejajar), `VIDARA_PASSWORD` tunggal.
  Slot i harus satu akun penuh (username_i + key_i dari akun yang sama) —
  inilah fix struktural untuk masalah folder "sejajar".
- Setelah restart: pilih akun via Admin Panel → 👤 Akun Vidara.
- Migration kolom `account` idempotent — restart kode lama sekalipun aman.
