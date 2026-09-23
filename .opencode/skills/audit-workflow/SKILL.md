---
name: audit-workflow
description: Use at the start of every session and whenever fixing bugs, changing code, or committing. Enforces: read skill at session start, proposal first before implementation, wait for user approval, strict scope, node --check + functional test scenario, API/endpoint cross-check against latest Telegram Bot API docs, audit log in docs/audit/, deploy via pm2 (ask first) + verify before commit + push + version tag.
---

# Audit Workflow

## Aturan Main

0. **Awal sesi** → baca SKILL.md ini dulu; update kalau ada bagian yang usang/gak sesuai lagi (catatan salah, session summary lama → pindahkan ke docs/audit/)
1. **Proposal fix dulu** (root cause + rencana + scope file) → tunggu user approve
2. **Implement** hanya sesuai proposal yang disetujui → test lokal: `node --check` semua .js yang berubah + jelaskan skenario functional test (apa yang harus terjadi, apa yang harus di-observe)
3. **Cari potensi bug/error/ketidaksesuaian** → cross-check penggunaan API/endpoint dengan dokumentasi/response asli; cek bug kelas yang sama di call path saudara
4. **Sumber kebenaran API = dokumentasi terbaru** https://core.telegram.org/bots/api (boleh fetch via jina.ai: `https://r.jina.ai/https://core.telegram.org/bots/api`); fitur wajib modern & profesional demi kenyamanan pengguna
5. **Setelah selesai** → LOG perubahan (file apa saja yang kena + folder mana) di docs/audit/
6. **Deploy dulu, baru commit**: Tanya user dulu sebelum restart via pm2 (biar gak konflik) → restart → verifikasi jalan normal → **baru** commit + push + **add tag versi** baru
   - Tag wajib lengkap & proporsional terhadap besar perubahan: `v<major>.<minor>.<patch>` — bedakan kecil (patch) / sedang (minor) / besar (major)
   - Jangan commit/push/tag sebelum deploy terverifikasi jalan normal

## Prinsip Penting

- **Kode yang diedit dan yang dites di server adalah SAMA.** Jangan pernah berasumsi kode berbeda.
- **Error yang masuk akal = belum restart bot.** Jangan cari-cari alasan lain sebelum mastiin bot sudah di-restart.
- **Wajib trace dulu** sebelum ngapa-ngapain. Jangan langsung tebak atau asumsi.
- **Jangan berspekulasi soal "instance/server lain" sebelum verifikasi.** Cek dulu bukti yang ada: `/proc/<pid>/cwd`, folder kerja, docker logs, timestamp file — baru simpulkan. (Kasus 31 Jul: batch log dikira dari server user padahal dari Replit sendiri — cwd dan docker logs udah nunjukin dari awal.)
- **Tugas gue (opencode) = PRJS saja.** Repo fomo-drama / cs-hokireceh itu milik user — kodenya ditangani user. Jangan sentuh/edit/commit repo fomo-drama tanpa perintah eksplisit. Proposal untuk fomo-drama boleh dibikin di docs/audit PRJS, tapi implementasi + commit = user. (Kasus 3 Aug: gue edit sync-check.js fomo-drama tanpa izin scope.)
- **Kalau nemu isu lain di luar scope proposal saat implementasi → laporkan dulu, jangan langsung fix.**
- **Gunakan Bahasa Indonesia** untuk semua komunikasi.

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
