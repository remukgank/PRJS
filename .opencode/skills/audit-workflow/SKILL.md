---
name: audit-workflow
description: Use at the start of every session and whenever fixing bugs, changing code, or committing. Enforces: read skill at session start, proposal first before implementation, wait for user approval, strict scope, node --check + functional test scenario, API/endpoint cross-check against latest Telegram Bot API docs, audit log in docs/audit/, deploy via manual background start on Replit (AGENTS §3, no pm2; ask first) + verify before commit + push + version tag.
---

# Audit Workflow

## Aturan Main

0. **Awal sesi** → baca SKILL.md ini dulu; update kalau ada bagian yang usang/gak sesuai lagi (catatan salah, session summary lama → pindahkan ke docs/audit/)
1. **Proposal fix dulu** (root cause + rencana + scope file) → tunggu user approve
2. **Implement** hanya sesuai proposal yang disetujui → test lokal: `node --check` semua .js yang berubah + jelaskan skenario functional test (apa yang harus terjadi, apa yang harus di-observe). **File tes wajib taruh di `.tests/` repo — JANGAN di `/tmp`** (ke-wipe saat restart) supaya bisa dicek ulang kapan saja (`node .tests/<nama>.js`).
3. **Cari potensi bug/error/ketidaksesuaian** → cross-check penggunaan API/endpoint dengan dokumentasi/response asli; cek bug kelas yang sama di call path saudara
4. **Sumber kebenaran API = dokumentasi terbaru** https://core.telegram.org/bots/api (boleh fetch via jina.ai: `https://r.jina.ai/https://core.telegram.org/bots/api`); fitur wajib modern & profesional demi kenyamanan pengguna
5. **Setelah selesai** → LOG perubahan (file apa saja yang kena + folder mana) di docs/audit/
6. **Deploy dulu, baru commit**: restart bot sesuai AGENTS §3 (Replit =
   **start manual background**, JANGAN pm2; jangan nyalakan Workflow Run saat
   proses manual hidup) → verifikasi jalan normal → **baru** commit + push + **add tag versi** baru
   - **Start/restart/stop bot = owner yang jalankan (2 Okt 2026)** — agent
      cukup **monitor & lapor**; start hanya kalau diminta (syarat & resep di
      AGENTS §3: tidak ada download, tidak ada instance lain, `9router` dkk. =
      infrastruktur jangan pernah kill). Restart *instance* Replit = perlu izin.
   - **DILARANG kill/restart proses bot milik owner tanpa persetujuan eksplisit
      owner** — kalau 409/duplikat: lapor + beri perintah kill untuk owner
      jalankan sendiri (AGENTS §3).
    - Resep start/stop/monitor = **AGENTS §3** (PID via `pgrep`, log di
      `logs/telegram-bot-manual.log`, `tail -n` jangan `tail -f`).
    - Verifikasi: 1 proses `bot.js`, `kill -0 $(cat logs/telegram-bot-manual.pid)`,
      log startup `Bot running` + `Polling started`, tanpa `409 Conflict`,
      dan kode yang jalan = HEAD
   - **Tag wajib lengkap & proporsional** terhadap besar perubahan: `v<major>.<minor>.<patch>` — kecil (patch) / sedang (minor) / besar (major)
   - **Penentu utama: ada yang rusak atau tidak.** Kalau tidak ada konsumen lama
     yang harus berubah → **minor**, sesederhana quantify fiturnya. Banyaknya
     commit bukan penentu (34 commit tetap boleh jadi satu minor).
     MAJOR hanya kalau ada kontrak yang patah: kontrak media (§5 caption 4
     baris / `supports_streaming` / topic Anime), format `callback_data` +
     bentuk `inline_keyboard`, atau nama/parameter yang sudah dipakai pemanggil
     di luar repo.
   - Teladan repo: `v3.0.0 → v3.1.0` (minor) sudah memuat fitur baru `!dell`
     + tombol picker berwarna. Gunakan itu sebagai acuan.
   - **Tag yang salah harus dihapus & diganti**, bukan dibiarkan
     (27 Sep 2026: v4.0.0 untuk provider baru → sebenarnya v3.2.0; sudah
     dihapus dari lokal + remote).
   - Jangan commit/push/tag sebelum deploy terverifikasi jalan normal

## Prinsip Penting

- **Kode yang diedit dan yang dites di server adalah SAMA.** Jangan pernah berasumsi kode berbeda.
- **Error yang masuk akal = belum restart bot.** Jangan cari-cari alasan lain sebelum mastiin bot sudah di-restart.
- **Wajib trace dulu** sebelum ngapa-ngapain. Jangan langsung tebak atau asumsi.
- **Jangan berspekulasi soal "instance/server lain" sebelum verifikasi.** Cek dulu bukti yang ada: `/proc/<pid>/cwd`, folder kerja, docker logs, timestamp file — baru simpulkan. (Kasus 31 Jul: batch log dikira dari server user padahal dari Replit sendiri — cwd dan docker logs udah nunjukin dari awal.)
- **Tugas gue (opencode) = PRJS saja.** Repo fomo-drama / cs-hokireceh itu milik user — kodenya ditangani user. Jangan sentuh/edit/commit repo fomo-drama tanpa perintah eksplisit. Proposal untuk fomo-drama boleh dibikin di docs/audit PRJS, tapi implementasi + commit = user. (Kasus 3 Aug: gue edit sync-check.js fomo-drama tanpa izin scope.)
- **Kalau nemu isu lain di luar scope proposal saat implementasi → laporkan dulu, jangan langsung fix.**
- **Gunakan Bahasa Indonesia** untuk semua komunikasi.
- **Jangan menyatakan "sudah benar" dari baca kode — jalankan alurnya.** Aturan ini
  lahir dari 3 bug berturut (27 Sep 2026), semuanya kelalaian yang sama:
  - "caption 3 baris" → nyata **1 baris** (judul kosong jatuh ke `cap` mentah).
  - "sudah MP4 jadi tidak perlu remux" → itu yang **mematikan streaming**
    (short-circuit `remuxToMp4` melewatkan `-movflags +faststart`).
  - "kunci library pakai slug" → `media_key` = **judul asli**, jadi status
    "sudah ada" tidak akan pernah cocok.
  Kalau tidak bisa menjalankan alurnya, katakan begitu — jangan menyatakan sebagai
  fakta.
- **Test yang mengunci asumsi salah lebih berbahaya dari tidak ada test.** Test
  "handleKamenimeUrl tidak boleh remux" terlihat menjaga, tapi justru **melarang
  perbaikannya sendiri**. Kalau test mengunci perilaku, pastikan perilakunya benar
  lebih dulu (jalankan sekali, lihat hasilnya).
- **Penggantian teks yang gagal tidak boleh diam-diam gagal.** `assert s != before`
  hanya membuktikan *salah satu* penggantian berhasil. Bug nyata: `dl_go:tg` tidak
  dapat cabang kamenime karena `str.replace` tidak cocok.

## Format Audit Log

File: `docs/audit/YYYY-MM-DD-judul-singkat.md`

```markdown
# Judul Fix

**Date**: YYYY-MM-DD
**Author**: opencode

## Root Cause

Penjelasan singkat kenapa bug terjadi.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `path/file.js` | deskripsi perubahan |

## Detail Teknis

Penjelasan teknis implementasi.

## Verification

- node --check lulus
- hasil test manual
```

## Catatan

- Link gofile/pixeldrain (tombol & text) → `handleGofileUrl`/`handlePixeldrainUrl` — **TANPA quota check** (jalur quota/paid media `downloadAndSendPaidMedia` dihapus 23 Sep 2026 sebagai dead code; tidak pernah ada pemanggil sejak initial commit)
- File ID cache di PostgreSQL tabel `file_cache`, key = MD5 hash URL (`crypto.createHash('md5')` di bot.js)
- `sendPaidMediaVideo` pake `apiPost('sendPaidMedia', ...)` langsung (support LOCAL API & cloud API)
- `batch-download.js` mode default = **merge** (10 ep/chunk); `--per-ep` untuk upload per episode, `--merge-size N` untuk atur ukuran chunk
- Restart FlareSolverr (tanpa Docker container): native `bash scraper/start-flaresolverr.sh &` dulu, fallback `docker restart flaresolverr` (sejak 26 Aug 2026, di batch-download.js & vidara-uploader.js)
