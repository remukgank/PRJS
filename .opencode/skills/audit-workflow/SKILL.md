---
name: audit-workflow
description: Use at the start of every session and whenever fixing bugs, changing code, or committing. Enforces: read skill at session start, proposal first before implementation, wait for user approval, strict scope, node --check + functional test scenario, API/endpoint cross-check, audit log in docs/audit/, commit only after confirmation.
---

# Audit Workflow

## Aturan Main

0. **Awal sesi** → baca SKILL.md ini dulu; update kalau ada bagian yang usang/gak sesuai lagi (catatan salah, session summary lama → pindahkan ke docs/audit/)
1. **Proposal fix dulu** (root cause + rencana + scope file) → tunggu user approve
2. **Implement** hanya sesuai proposal yang disetujui → test lokal: `node --check` semua .js yang berubah + jelaskan skenario functional test (apa yang harus terjadi, apa yang harus di-observe)
3. **Cari potensi bug/error/ketidaksesuaian** → cross-check penggunaan API/endpoint dengan dokumentasi/response asli; cek bug kelas yang sama di call path saudara
4. **Restart bot bila perlu** → tunggu user melakukan tes manual di Replit/server
5. **Setelah user mengonfirmasi OK** → commit + push otomatis
6. **Update docs/audit/** sesuai format yang ada — selalu LOG file apa saja yang kena dan di folder mana

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

- Link gofile/pixeldrain dari non-admin via tombol → `downloadAndSendPaidMedia` (ada quota check)
- Link gofile/pixeldrain dari text langsung → `handleGofileUrl`/`handlePixeldrainUrl` (TANPA quota check untuk non-admin)
- File ID cache di PostgreSQL tabel `file_cache`, key = MD5 hash URL (`crypto.createHash('md5')` di bot.js)
- `sendPaidMediaVideo` pake `apiPost('sendPaidMedia', ...)` langsung (support LOCAL API & cloud API)
- `batch-download.js` mode default = **merge** (10 ep/chunk); `--per-ep` untuk upload per episode, `--merge-size N` untuk atur ukuran chunk
- Restart FlareSolverr (tanpa Docker container): native `bash scraper/start-flaresolverr.sh &` dulu, fallback `docker restart flaresolverr` (sejak 26 Aug 2026, di batch-download.js & vidara-uploader.js)
