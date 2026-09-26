# PROPOSAL: Vidoy sebagai target upload + menu upload Drama & Anime

**Date**: 2026-09-25
**Author**: opencode
**Status**: disetujui user ("kamu atur saja asal profesional & maksimal") → implementasi
**Versi**: `v3.0.0` (major — provider upload baru, 2 menu, tabel DB, alur anime baru)
**Sumber kebenaran**: dokumen resmi Telegram Bot API **10.3** (24 Agu 2026, diverifikasi via r.jina.ai)

## 1. Kebutuhan

Drama ke depan tidak lagi per-episode → upload **gabung 10**. Perlu target upload
**Vidoy** (selain Vidara & Telegram). Anime tetap per-episode dengan pilihan target.

Menu upload yang diminta:
- **Drama**: `Telegram — gabung 10`, `Vidara — gabung 10`, `Vidara+TG — gabung 10`,
  **`Vidoy — gabung 10`**, **`Vidoy+TG — gabung 10`**
- **Anime** (baru, per episode): `Telegram`, `Vidara+TG`, **`Vidoy+TG`**, **`Vidara+Vidoy`**

## 2. Bukti live (akun Vidoy user, 25 Sep 2026)

| Uji | Hasil |
|---|---|
| Login session (`/signin`, cookie jar) | ✅ HTTP 200 |
| `GET /folders` | ✅ JSON skema `{id, name, parent, child}` |
| **Upload 2-step** (CDN multipart → `/manual/upload`) | ✅ 3,2 dtk, `id=xrp5jzq6ten0` |
| Public link | ✅ `https://vski.cc/e/{id}` HTTP 200 tanpa auth; `/view/` juga memberi `/d/` |
| **Struktur 3 level** (`VVIP AKSES/DATABASE/ANIME|DRAMA/...`) | ✅ create-di-root + `move` ke parent bekerja |
| Panjang nama folder | ✅ sampai 160 karakter |
| Karakter `:` `?` `*` `"` `|` `\` `&` `+` spasi, CJK | ✅ tersimpan utuh |
| **`<` `>`** | ❌ gagal dibuat — **`add-folder` tetap balas HTTP 303 (silent fail)** |
| **Emoji** | ⚠️ tersimpan sebagai `???????` |
| `/folders` tanpa session | HTTP **302** (bukan 401/403) |

Implikasi desain (wajib, bukan opsional):
- `add-folder` **harus diverifikasi lewat re-list** setelah create (HTTP 303 tidak
  trustworthy) — pola ini sudah ada di kode sumber, dipertahankan.
- Sanitasi nama folder: buang `<` `>`, buang emoji, trim, cap 120 karakter.
- Deteksi session habis harus mencakup **302**, bukan hanya 401/403.

## 3. Keputusan diambil (standar profesional)

| # | Keputusan | Alasan |
|---|---|---|
| D1 | Menu anime muncul **sebelum** download (menggantikan tombol "✅ Ya, Download") | sesuai "gak perlu gabung, langsung pilih target" |
| D2 | Opsi **per-episode drama dipindah** ke sub-menu `⚙️ Opsi per episode` | tidak hilang fitur, menu utama tidak ramai |
| D3 | Nama file di folder: `<Judul> - Ep X-Y` (drama: `<Judul> - Ep 1-10`) | jelas saat diunduh, sortable, Avoid spasivoted |
| D4 | Batas ukuran Vidoy **belum diketahui** → strategy: upload streaming `curl` (timeout 600 dtk) + deteksi penolakan server (status != 200 / pesan) + fallback **sub-part** seperti alur Telegram/Vidara | tidak menebak limit; degrade aman |
| D5 | Tombol target memakai `style` (10.3) & tombol **mati** memakai `"disabled": {}` (10.3) | UX jelas: opsiVidoy tampil Abu-abu (bukan error) saat `VIDOY_USERNAME/PASSWORD` belum ada |
| D6 | Versi **major `v3.0.0`** | provider baru + 2 menu + tabel DB + alur anime |

### Bentuk menu final

**Drama** (gabung 10):
```
🗜 Telegram — gabung 10      act:merge10
🗜 Vidara — gabung 10        act:v_merge10
🗜 Vidara+TG — gabung 10     act:vt_merge10
🗜 Vidoy — gabung 10         act:vy_merge10      🆕
🗜 Vidoy+TG — gabung 10      act:vyt_merge10     🆕
⚙️ Opsi per episode          act:drama_legacy
🔢 Pilih episode             act:list
💬 Live Chat                 act:ai
🏠 Menu Utama                act:main_menu
```
Sub-menu `act:drama_legacy`: `Telegram — per episode`, `Vidara — per episode`, `Vidara+TG — per episode`.

**Anime** (per episode, di langkah preview sebelum download):
```
📥 Telegram                 sam_go:tg:<urlId>
📥 Vidara + Telegram        sam_go:vt:<urlId>
📥 Vidoy + Telegram         sam_go:vyt:<urlId>
📥 Vidara + Vidoy           sam_go:vv:<urlId>
⬅️ Ganti server             sam_ep:<urlId>
```
(Status tombol: Vidoy mati bila kredensial belum ada; Vidara mati bila `VIDARA_API` kosong.)

## 4. Scope file

| File | Perubahan |
|---|---|
| `scraper/vidoy-uploader.js` (baru) | Port teruji: logger **pino**, tangani **302** sebagai session-expired, buang dead code `pairs`, pertahankan quote-path `-F "files[]=@path"`, tambah `sanitizeFolderName()`, `getOrCreateFolderPath(segments)` (multi-level + verifikasi re-list), `buildFolderUrl/extractFolderId/nextFolderHost` (teruji) |
| `scraper/services/vidoyService.js` (baru) | `uploadDramaBatchesVidoy` (merge 10) & `uploadAnimeToVidoy` (per-ep), memakai `ensureMp4`/`ffmpegConcat`/`downloadChunk` dari `vidaraService` (tanpa duplikasi) |
| `scraper/db.js` | Tabel `vidoy_uploads` + `saveVidoyUpload`, `listVidoyUploads` (ikut pola `vidara_uploads`) |
| `scraper/handlers/vidoy.js` (baru) | Aksi `vy_merge10`, `vyt_merge10`, `sam_go:vyt`, `sam_go:vv` (progress RichProgress, laporan link, cleanup file) |
| `scraper/bot.js` | `mainActionKeyboard(kind)`: `'drama'` (9 tombol + sub-menu), `'anime'`/preview (4 target, `style` + `disabled` sesuai ketersediaan); routing aksi baru; wiring `initVidoy` |
| `scraper/tests/test-vidoy-uploader.js` (baru) | Sanitasi nama (buang `<`/`>`/emoji, cap 120, trim), `getOrCreateFolderPath` (sudah ada vs buat, cache, verifikasi 302), util folder URL, guard anti-drift |
| `scraper/tests/test-upload-menus.js` (baru) | Bentuk 2 menu: jumlah tombol, `callback_data` ≤ 64 **byte**, `disabled: {}` saat kredensial kosong, `style` valid |
| `docs/audit/2026-09-25-vidoy-upload-menu.md` (baru) | LOG perubahan (root cause, keputusan, verifikasi) |

Tidak diubah: `gofile-worker.js`, alur samehadaku/kuronime yang ada, `handlers/vidara.js` (kecuali bila perlu penyelarasan nama).

## 5. Verifikasi

- `node --check` **CLEAN** tiap file yang berubah.
- Test offline: `test-vidoy-uploader.js`, `test-upload-menus.js`, plus 16 suite lama.
- **Deploy**: restart bot (kode bot berubah) → tes: menu drama menampilkan 5 opsi gabung-10 (+ Vidoy aktif bila kredensial ada), preview anime menampilkan 4 target, upload uji ke `VVIP AKSES/DATABASE/DRAMA/<judul>/` menghasilkan link publik.
- Setelah verifikasi → commit + push + tag `v3.0.0`.

## 6. Catatan

- Batas ukuran file Vidoy belum terukur (50 KB ✅ teruji). BilaFFD48MB+ ditolak, galat akan dilaporkan eksplisit (D4) — pengukuran batas jadi follow-up terpisah.
- Artefak uji live (untuk dihapus user): video `xrp5jzq6ten0`; folder uji `ZZ-TEST-VIDOY` + 15 folder `ZZT …`. Folder `VVIP AKSES/DATABASE/ANIME|DRAMA` **dipertahankan**.
