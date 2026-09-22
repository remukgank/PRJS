# Audit: Batch "Download Semua" Samehadaku (anti-klik satu-satu)

- **Tanggal**: 2026-09-21
- **File terdampak**: `scraper/bot.js`, `scraper/handlers/download.js`
- **Test**: `node --check` (bot.js, download.js) PASS; `scraper/tests/test-download-sam-batch.js` (5 kasus) PASS
- **Status**: implementasi + verifikasi selesai; **belum di-commit** (tunggu E2E live + konfirmasi)

## Latar belakang UX

Log user menunjukkan per-anime `naruto-kecil` diklik **3x per episode** (`sam_ep` →
`sam_dl` → `sam_go`) → 1 cour 24 ep ≈ 72 klik. Pesan dengan 6 URL anime sekaligus juga
tidak terproses (batch hanya ada utk gofile-direct & pixeldrain, bukan samehadaku).

## Desain

### `scraper/bot.js` — tombol + handler callback

- `buildSamehadakuEpisodePicker` kini menambahkan tombol bawah:
  `⬇️ Download Semua (N)` → `sam_all:<cacheUrl(animeUrl)>`, N = episode yang belum di-library.
  Jika semua sudah ada → `✅ Semua episode sudah di library` (tombol tetap, guard di handler).
  Otomatis ikut di kedua tempat pemanggil (message handler & `sam_back`).
- Handler `data.startsWith('sam_all:')`:
  1. Admin-only; resolve animeUrl via `cacheUrl`.
  2. Lock `samAllBusy` (Set, key `chatId:title`) → cegah dobel queue.
  3. `resolveSamehadakuFullhd(animeUrl)` (type anime) → filter episode yang sudah di-library
     (`listPartsWithFile`). Queue kosong → pesan "semua sudah di library".
  4. Satu `RichProgress` table (`📥 Batch <title>`, baris `Ep N`) untuk seluruh queue.
  5. Loop sequential, per item: resolve server → `pickBestServer` (prioritas
     `gofile > filedon > pixeldrain > gdriveplayer`) → `downloadSamehadakuFile(...)` →
     baris `done <MB>` / `fail <err>`; jeda `SAM_BATCH_PACE_MS` (env, default 1000ms)
     antar item. Akhir loop: `rp.done()`.
- Backpressure otomatis: `checkBeforeDownload()` sudah dipanggil di dalam `downloadWithAria2c`
  (downloader.js:77,315) → tiap item batch ikut gate tanpa wiring baru.

### `scraper/handlers/download.js` — status-return (backward-compatible)

Leaf handler kini **mengembalikan `{ ok, file, sizeMb, part, error }`** di jalur sukses &
gagal: `handleGofileUrl` (direct+folder), `handlePixeldrainUrl`, `handleFiledonUrl`,
`downloadSamehadakuFile` (branch gdriveplayer, "server tidak tersedia", "belum didukung"),
catch luar. Caller existing (sam_go, `dl:`, message handler) mengabaikan return → behavior
tidak berubah. Batch memakai return utk status baris yang jujur (tak ada false-done).

Baru diekspor: `pickBestServer(servers)` (prioritas SERVER_PRIORITY) + konstanta
`SAM_BATCH_PACE_MS` (env `SAM_BATCH_PACE_MS`).

## Verifikasi

- `node --check scraper/bot.js`, `node --check scraper/handlers/download.js`: PASS.
- `node scraper/tests/test-download-sam-batch.js` (harness lokal, tanpa ctx):
  pickBestServer prioritas/luar-prioritas/kosong; `SAM_BATCH_PACE_MS`; server kosong →
  `{ ok:false }` tanpa crash. Semua PASS.
- Re-run `test-watchdog-aria2c.js` (5 skenario) utk konfirmasi downloader tidak regresi
  (area download.js disentuh).
- **E2E live (belum)**: restart bot build baru → klik `⬇️ Download Semua` pada anime
  naruto-kecil → perhatikan table + `done/fail` per baris.

## Batasan / keputusan

- Server batch dibatasi yang didukung langsung: gofile/filedon/pixeldrain/gdriveplayer.
  `krakenfiles` tidak punya handler di `downloadSamehadakuFile` (sudah begitu sebelumnya).
- Auto-server = prioritas tetap (`gofile → filedon → pixeldrain → gdriveplayer`);
  user yang mau server spesifik tetap pakai alur `sam_ep → sam_dl → sam_go` per episode.
- File multi-anime (N URL dalam 1 pesan) **tidak** masuk scope batch ini — masih satu anime
  per pesan (note di next-step proposal).
- Tidak menyentuh: `hokidrama/**`, `start.sh`, `.pm2/**`, `.replit`, provider lain.

---

## HOTFIX 05:10 — Pagination episode picker (tombol >100 terpotong)

- **Temuan** (laporan user + reproduksi): anime 220 ep (naruto-kecil) membangun keyboard
  berisi 221 tombol → Telegram/Local API memotong di 100 → menu episode putus setelah ~Ep 100
  **dan** tombol `⬇️ Download Semua` (tadinya di baris paling bawah) ikut terpotong/hilang.
- **Perbaikan** `scraper/bot.js`:
  - `buildSamehadakuEpisodePicker(eps, animeUrl, page = 0)` kini PAGED (`SAM_PAGE_EP`,
    default 20 ep/halaman = 4 baris ×5) + nav `⬅️ Prev | 📄 X/Y | Next ➡️`
    (`sam_page:<page>:<urlId>`).
  - Tombol `⬇️ Download Semua (N)` dipindah ke **baris paling atas** → dijamin selalu tampil,
    tidak pernah terpotong.
  - Caption jalan baris: `Episode X–Y (hal. X/Y)`.
  - Cache episode `samehadakuEpisodesCache` (Map animeUrl→{eps,ts}, TTL `SAM_CACHE_MS`)
    utk navigasi halaman tanpa fetch ulang; dipakai juga oleh `sam_all`.
  - Handler baru `sam_page:` (admin-only, clamp halaman, fallback ke cache→resolve).
- **Modul baru** `scraper/lib/samKeyboard.js`: `paginate()` + `buildPicker()` (murni,
  testable tanpa side-effect bot). `bot.js` require `buildPicker`.
- **Verifikasi**: `node --check` keduanya PASS; `node scraper/tests/test-sam-picker-pagination.js`
  → **7/7 PASS** (11 halaman, tombol batch di posisi pertama, prev/next bounds, clamp
  page 999, done-state/count, semua halaman ≤100 tombol & baris ≤5 ep).
- **E2E live (menunggu)**: bot restart (PID 2026) → kirim ulang link naruto-kecil →
  tombol `⬇️ Download Semua (207)` tampil di atas + navigasi hal. 1/11.
- Catatan: tombol earlie tipu-mata user, ini bukan perubahan data — picker lama yang
  "terlihat normal" adalah keyboard <100 tombol tanpa nav.

## HARDENING 05:15 — Fallback server otomatis di batch

- **Masalah**: batch lama cuma `pickBestServer` (satu pilihan). Gofile sering kena `> limit`
  harian → episode langsung FAIL meski server lain (pixeldrain/filedon/gdriveplayer) sehat.
- **Perbaikan** `scraper/handlers/download.js` + `scraper/bot.js`:
  - Ekspor baru `pickBestServerList(servers)` → daftar server tersedia dalam urutan
    `SERVER_PRIORITY` (gofile → filedon → pixeldrain → gdriveplayer); `pickBestServer`
    kini = `pickBestServerList()[0]` (kompatibel).
  - Loop `sam_all` diganti: iterasi **calon server berurutan**; server gagal → coba
    berikutnya; baru mark FAIL jika semua gagal.
  - **Anti-duplikat**: record DB hanya dibuat setelah sukses (existing behavior);
    nama file temp gofile/pixeldrain unik per-call (`gofile_${Date.now()}`, `pixeldrain_${Date.now()}`)
    → tidak ada percampuran partial antar server saat fallback.
- **Verifikasi**: `node --check` PASS; `test-download-sam-batch.js` +4 kasus
  (`pickBestServerList` urutan/lewatkan/kosong/konsistensi) → 9 kasus PASS;
  `test-sam-picker-pagination.js` re-run → 7 PASS (tidak regresi).
- **Restart (belum)**: download user masih berjalan → kode siap di disk, restart ditunda
  sampai user konfirmasi download selesai.

## HARDENING 06:50 — Anti-file-salah (partMismatch) + E2E batch

- **Temuan E2E** (setelah batch `Naruto Kecil ok:206 fail:0`): part **69 kosong** di library
  (219/220, tanpa duplikat). Audit: server filedon untuk link ep 69 di situs menunjuk file
  `Naruto-70-360p-SAMEHADAKU.CARE.mp4` (file ep 70!); part yang di-save = 70 yang sudah ada
  → guard `if (!existing)` menolak simpan → "ok" di batch tapi tidak tersimpan. Mirror
  pixeldrain ep 69 = `Naruto-69-720p` (benar).
- **Perbaikan** `scraper/handlers/download.js` + `bot.js`:
  - Helper `partMismatch(expectedEp, gotPart)` — tolak server sebelum download jika nomor
    episode di nama file ≠ episode yang diminta (want>0 && got>0 && beda).
  - Dipasang di 3 branch `downloadSamehadakuFile` tanpa menambah biaya fetch:
    filedon (`partN`), pixeldrain (`pixPart`), gdriveplayer (`gpPart`); `expectedEp` =
    `sameInfo?.episode` di-pass dari `downloadSamehadakuFile` (arg opsional ke-4, callers lain
    aman).
  - Ter-integrasi dgn fallback: filedon ep-69 ditolak → batch otomatis coba pixeldrain
    (benar, 720p) → part 69 tersimpan.
- **Verifikasi**: `node --check` PASS; `test-download-sam-batch.js` **11 kasus PASS**
  (baru: partMismatch ditolak/cocok/null); `test-sam-picker-pagination.js` 7 PASS.
- **Restart**: bot di-restart (PID baru) utk mengaktifkan fallback + guard.
- Bisnis-impact E2E batch: ok 206 termasuk 1 "ok"-palsu (ep 69 = dobel ep 70 di chat) —
  pesan tele itu bisa dihapus manual; ulangi download ep 69 via `sam_ep → Ep 69 → Pixeldrain`.

## HARDENING 07:20 — RichProgress window mode (batch besar spt One Piece 1163 ep)

- **Masalah**: `RichProgress` me-render SEMUA baris ke 1 pesan → batch ~1163 ep melebihi
  limit 4096 char Telegram → editMessageText 400 berulang + spam fallback ke grup.
- **Perbaikan** `scraper/lib/progress.js` + `bot.js`:
  - Opsi `opts.window` (baru): saat total > window, render hanya baris dari
    `recentActivity` (update **terbaru**, bukan tail array) → live-feed tetap benar,
    ukuran pesan ≤ ~1.5KB berapa pun total ep.
  - `_trackActivity`/`_displayList`; summary/footer tetap memakai hitungan GLOBAL
    (`19✓/1163 · 1✗ · N baris lain tersembunyi`).
  - `sam_all` memakai `window: SAM_BATCH_WINDOW` (env, default 15).
- **Verifikasi**: `node --check` PASS; harness (1163 ep, window 15): live 1034 char,
  summary `19✓/1163`, Ep terbaru tampil, Ep lama keluar window; `renderRichDone` 1148 char;
  batch kecil tanpa window tidak terpotong; `test-download-sam-batch` + pagination re-run PASS.
- **Status**: siap utk batch One Piece setelah restart.

## HARDENING 07:46 — gdriveplayer.io + temuan server One Piece

- **Bug**: link server `gdriveplayer.io/download.php?link=...` (dipakai anime One Piece)
  ditolak `isGdrivePlayerUrl` karena regex cuma terima `.me`/`.to` → batch/mp trijatuh ke
  pesan "Server gdriveplayer belum didukung langsung" per episode.
- **Fix** `scraper/providers/gdriveplayer.js`: host regex `\.(?:me|to|io)$`.
  Test baru `scraper/tests/test-gdriveplayer-io.js` 3 PASS (io diterima; me/to tetap; host lain ditolak).
- **Temuan lapangan One Piece (v2.samehadaku.how)**, sampling 20 ep:
  - ep 1–~80: hanya `gdriveplayer` → gdriveplayer.io balas "File belum siap / tidak ditemukan"
  - ep ~150–1050: `acefile`/`reupload`/`mirrored` → semua **di luar** host didukung;
    `reupload.org` ternyata domain hangus ("for sale"), bukan file host
  - ep ≥ ~1100: `gofile`+`pixeldrain`+`filedon` → DIDUKUNG (bisa download)
  - Vote stock: attempt Download Semua → ep 1 sikC resolve; dari 1163 ep hanya ±70–100 yang layak.
- **Keputusan user**: batch One Piece penuh **ditunda** (bukan bug kode; mirror belum sediakan server utk ep lama).
- **Catatan stabilitas**: proses bot sempat hilang (tanpa trace, diduga OOM ketika sam_all resolve
  1163 ep; restart bersih → PID 1162). Belum ada guard paralel untuk resolve ratusan ep sekaligus — jika
  batch One Piece dijalankan tanpa tunda, batasi concurrency resolve (loop sequensial) + dipantau.
- **Acefile = Google Drive (klaim user & terkonfirmasi)**:
  - Scraper menangkap `acefile` → `https://acefile.co/f/<id>/<file>`; `acefile` BUKAN host didukung
    (di luar SERVER_PRIORITY) → "belum didukung". `acefile.co` juga 404 dari IP datacenter (antiscrape) —
    jadi halamannya tak bisa di-resolve di server sekalipun ditambahkan.
  - Namun target aslinya Google Drive DIDUKUNG penuh (`providers/gdrive.js`, `handleGdriveUrl`, dan
    paste link drive di chat): uji resolve `OP-Spesial-FULLHD-SAMEHADAKU.CARE.mp4` 250.7MB OK + aria2c
    dry-run OK dari IP server (Google tidak terblokir).
  - **Workaround kini**: user buka link acefile di browser → salin link Google Drive → paste ke chat bot
    → bot unduh lewat jalur gdrive. Otomatisasi butuh resolve halaman acefile (terblokir dari IP ini);
    bisa dievaluasi via FlareSolverr nanti jika user mau.

## HARDENING 08:15 — silent batch + detail Ep + pre-flight scan server

- **Masalah**: (1) `downloadSamehadakuFile` mengirim pesan gagal ke chat utk TIAP ep di batch
  (spam; tanpa nomor episode); (2) batch One Piece menghabiskan berjam-jam men-strike ep yang
  pasti gagal (server tak didukung / gdriveplayer file tak siap).
- **Fix a — silent + detail** (`scraper/handlers/download.js`, `scraper/bot.js`):
  - `downloadSamehadakuFile(chatId, ..., opts={})`; `opts.silent=true` menekan kelima titik pesan
    gagal (server tak ada, file salah, gdriveplayer gagal, belum didukung, catch umum).
  - Pesan non-silent kini memuat `Ep N` (dari `sameInfo`); typo "Kelik"→"Klik".
  - Loop batch memanggil dgn `{ silent: true }`; status hanya di tabel RichProgress.
- **Fix b — pre-flight scan** (`scraper/lib/samPrescan.js` baru, `scraper/bot.js` batch):
  - `scanSupportedServers` resolve servers tiap ep paralel (concurrency `SAM_SCAN_CONCURRENCY` default 6),
    `viableFromScanned` klasifikasi ep yg punya ≥1 host didukung (`pickBestServerList`).
  - Batch: scan dulu (pesan "🔎 Pre-scan..."), skip ep tanpa host didukung, hanya unduh yg layak;
    hasıl scan di-reuse di loop utama (tidak resolve ulang → tidak ada stall 60-80s/ep).
  - Env: `SAM_PRE_SCAN=0` matikan; `SAM_SCAN_CONCURRENCY=n`.
- **Test**: `test-sam-prescan.js` 3 PASS; `test-download-sam-batch` (+2 kasus silent/detail) PASS;
  pagination 7 PASS; gdriveplayer-io 3 PASS.
- **Status**: deploy via restart (PID baru); One Piece tinggal klik Download Semua → pre-scan
  langsung lewati ±1050 ep tanpa server → unduh ep bisa.
## HARDENING 11:45 — leafAlert silent + extractProvider SAMEHADAKU (deploy: batch selesai + restart)
- **Bug 1 (Provider unknown)**: flow batch tidak set `samehadakuEpisodeMap` → caption pixeldrain
  jatuh ke `extractProvider` yang gagal kenali `SAMEHADAKU.CARE` (ada titik) → "Provider :- unknown".
  Fix: (a) `downloadSamehadakuFile` set map utk setiap url (identik dgn flow manual);
  (b) `extractProvider` kenali `SAMEHADAKU.CARE/.VIP/.HOW/.HOST`.
- **Bug 2 (spam ⚠️ batch)**: `silent` sebelumnya hanya di downloadSamehadakuFile; leaf handler
  (pixeldrain/filedon) tetap kirim pesan sendiri. Fix: `leafAlert()` + toggle `_samQuiet` oleh
  downloadSamehadakuFile (try/finally). Batch senyap; flow manual tetap lantang.
- **Test**: `test-extract-provider.js` 3 PASS (baru); `test-download-sam-batch` +1 kasus
  leafAlert-quiet → 14 PASS; suite lama tetap hijau.
- **Catatan live (dari log)**: ep1125 di-kill slow-guard (pixeldrain 35 KiB/s<70, 1.15GB buang,
  file valid 1.197GB tapi IP kita di-throttle); ep1126 pixeldrain 404 `not_found` (file hilang);
  gofile ep >=1125 semua `error-notFound` (folder dihapus) → fallback pixeldrain/filedon.

## HARDENING 03:5x — Anti-429 (deploy: restart bot berikutnya)
- **Gejala**: DBH batch → `Too Many Requests (retry after 15-17)` berulang pada RichProgress
  start/done/tick; fallback _internalSendRichMessage = kirim pesan BARU → perparah rate-limit.
- **Fix (scraper/lib/progress.js)**:
  - `_postJson` + `_postJsonRetry`: semua call ke Local/Bot API via helper; jika 429 → tunggu
    `retry_after` lalu retry SATU kali (bukan langsung fallback pesan baru).
  - Throttle global `_editGate` (min 800ms antar edit ke Telegram, lintas SEMUA RichProgress).
  - Interval tick: Progress 3000→4000ms; RichProgress 5000→6000ms.
- **Fix (scraper/handlers/download.js)**: `noopRp()` + `_samQuiet` ternary di 5 titik pembuatan
  RichProgress leaf (gofile-direct, gofile-firstfile, pixeldrain, filedon, gdriveplayer) —
  batch tdk bikin sub-progress per-ep; trafik edit turun drastis; flow manual tetap normal.
- **Test**: test-download-sam-batch (14 PASS), extract-provider (3), prescan (3), pagination (7),
  gdriveplayer-io (3), samehadaku-parse-ep1 (14). test-rich* butuh env → skip.

## HARDENING — act:help guard (deploy: restart bot)
- **Bug**: `limit` ("🟢 Local API — limit 2 GB" / API publik) di-render ke SEMUA user =
  bocor info internal. Role-split lainnya (Cara Pakai, link didukung, subdomain) sudah benar.
- **Fix**: isAdminUser → versi teknis; user → "🟢 Video langsung dari Telegram — maks 2 GB
  per file" (tanpa istilah "Local API"; hilangkan baris saat API publik).
  - Hotfix: isAdminUser dipindah ke atas (TDZ ReferenceError di act:help) — node --check OK.

## HARDENING 04:4x — Live Chat manual (tanpa AI endpoint)
- **Fitur**: saat `ai_endpoint` belum diset, pesan user (teks/foto) di sesi 💬 Live Chat
  diteruskan ke topic "💬 Live Chat" di grup RF_GROUP_ID; admin balas via reply → dikirim
  balik ke user (rute via tabel `livechat_route` baru).
- **scraper/db.js**: migrasi tabel `livechat_route(admin_msg_id PK, user_chat_id, user_msg_id,
  user_name, ts)` + `saveLiveChatRoute`/`getLiveChatRoute` (round-trip test 4 PASS — catatan:
  pg mengembalikan BIGINT sebagai string, compare pakai Number()).
- **scraper/bot.js**:
  - Helper `escHtml`, `ensureLiveChatTopic` (auto-create `createForumTopic('💬 Live Chat')`,
    persist di reelfren_topics.json key `/live-chat` — walau RF_GROUP_ENABLED false tetap jalan
    asal RF_GROUP_ID ada), `forwardToLiveChatAdmin`.
  - Branch `!aiEndpoint`: admin → pesan "AI endpoint belum diset + /setai"; user → forward ke
    admin (ack sekali per sesi via `liveChatAcked`), fallback "Belum tersedia" jika gagal.
  - Admin-reply routing di awal message handler: reply di grup pada pesan forward → kirim ke
    user (teks → sendMessage; foto → sendPhoto; lampir keyboard ⬅️ Keluar); route tetap
    disimpan agar reply beruntun ke pesan sama tetap terkirim.
  - Guard album: buffer AI album hanya aktif saat ai_endpoint ada (manual mode → foto album
    diteruskan per-foto).
  - `liveChatAcked` dibersihkan saat keluar (menu/act:ai_exit).
- **Deploy**: restart bot di terminal user (patch belum live — tunggu restart + redirect log).
- **Test**: node --check OK; test-livechat-route 4 PASS; suite lama tetap hijau.
