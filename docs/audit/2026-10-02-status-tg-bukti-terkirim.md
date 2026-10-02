# 2026-10-02 — Status picker "129 perlu dikirim": bukti Telegram dari 3 sumber (A+B)

**Date**: 2026-10-02
**Author**: opencode
**Approve user**: "Approve" (A+B, tag patch)

## Root Cause

Picker episode menandai `tg = true` **hanya** dari `vidoy_uploads.pointer`.
Akibatnya episode yang terkirim ke Telegram tapi file-nya tidak dipegang Vidoy
(target `vt` — file di Vidara) tidak pernah dianggap terkirim, walau buktinya
sudah ada di DB:

1. **`vidoy.js:519`** `if (msgId && out.vidoy)` — pointer Telegram hanya
   ditulis bersama `saveVidoyUpload`. Jalur `vt` (`out.vidoy` kosong) →
   pointer tidak pernah disimpan. Insiden: angka "129 perlu dikirim" di
   picker; tiap episode `vt` baru menambah hitungan salah.
2. **`media_parts.file_id`** — jalur kamenime (`savePartFileId` dari
   `sent.video.file_id`) **sudah menyimpan bukti pesan terkirim** utk 153/153
   episode Dragon Ball, tetapi `episodeStatusMap` hanya membacanya sebagai
   `lib` (library), bukan `tg` — bukti terkirim diabaikan.
3. `vidara_uploads` tidak punya kolom pointer sama sekali.

Bukti run (bukan asumsi): `listPartsWithFile('anime:dragon-ball')` → 153 baris
semua `file_id IS NOT NULL`; `listVidoyUploads('Dragon Ball')` → 0; sebelum
fix statusDragon Ball = 153 "perlu dikirim", sesudahnya (validasi live):
`📨 153 di Telegram · 🔼 0 · 📄 0 · ⬜ 0`.

## Keputusan desain

- **B** ≠ backfill UPDATE data — cukup `episodeStatusMap` menganggap
  `file_id` sebagai bukti terkirim (datanya sudah ada).
- **A** = pointer TG ditulis ke `vidara_uploads` (`setVidaraTelegramPointer`,
  UPDATE tanpa insert — record tidak ada = 0 baris, bukan error).
  ❌ Ditolak: membuat record `vidoy_uploads` dari jalur Vidara — berisiko
  memblokir upload Vidoy (§6: record ada → skip, melanggar "kalau ada
  Vidara, boleh download ke Vidoy").
- Aturan kunci dipertahankan: **record host TANPA pointer = bukan bukti**
  terkirim (label `🔼 Vidara saja` tetap dihitung terpisah dari `tg`).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/db.js` | `ALTER vidara_uploads ADD tg_chat_id/tg_message_id` (init, idempotent) · `listPartsWithFile` SELECT `file_id` · `listVidaraUploads` SELECT kolom pointer · fungsi baru `setVidaraTelegramPointer` + export |
| `scraper/lib/episode-status.js` | part dgn `file_id` → `tg: true` (B) · record vidara dgn pointer → `tg: true` (A) · komentar disesuaikan |
| `scraper/handlers/vidoy.js` | blok msgId berdiri sendiri: selalu `setVidaraTelegramPointer(vidoyTitle, ep, …)`; `setVidoyTelegramPointer`+`saveVidoyUpload` tetap di dalam `if (out.vidoy)` |
| `AGENTS.md` §6 | Sumber status picker = bukti Telegram (`vidoy_uploads.pointer` ∪ `vidara_uploads.pointer` ∪ `media_parts.file_id`) ∪ library; label & tombol disesuaikan kode |
| `AGENTS.md` §3 | Resep pgrep diperbaiki: pattern `bot[.]js` (hindari self-match shell) + `sort -n \| tail -1` (node, bukan wrapper) |
| `.tests/status-tg-proof.js` (baru) | 7 tes: file_id→tg · record tanpa pointer→bukan bukti · pointer→tg · key tanpa record tidak error · pemanggilan di vidoy.js · SELECT pointer |

## Verification

- `node --check` lulus untuk `db.js`, `episode-status.js`, `vidoy.js`.
- Test: `.tests/status-tg-proof.js` **7 pass 0 fail** · `test-episode-status`
  11 · `test-media-contract` 12 · `.tests/caption-server-line` 13 ·
  `test-btn-style` 10 · `test-vidoy-uploader` 164 — **total 217 pass, 0 fail**.
- Validasi live DB (kode baru, sebelum deploy): Dragon Ball = `📨153 · 📄0 · ⬜0`
  (sebelumnya 153 "perlu dikirim") · DBZ = `📨1 · ⬜128` (ep1 tadi sudah masuk).
- Deploy: kill PID lama → start manual background → `Bot running` +
  `Polling started` + `Database tables initialized` (ALTER jalan), **1
  instance** (PID 7579), **0 ERROR** setelah start, PID file diverifikasi
  `ps -o cmd` = `node scraper/bot.js`.

## Catatan / luar scope

- **Vidoy quota habis** (5,33/5,37 GB, log 09:04) — upload Vidoy praktis
  mentok; fallback Vidara bekerja (`Vidoy quota habis — fallback ke Vidara`
  → Telegram ✅ + Vidara ✅). Perlu perhatian user (reset/proses/limit).
- `setPartTelegramPointer` (pointer `media_parts.tg_*`) sudah ada dan dipakai
  jalur drama (bot.js:2776/5068) tetapi **tidak dipakai jalur anime** —
  tidak diubah (pointer vidara sudah mencakup semua provider `vt`; jalur
  drama merge-10 juga tidak menyimpan pointer → kandidat perbaikan lanjutan
  kalau picker drama bermasalah serupa).
- Literasi "kamenime = provider hokireceh" — bila provider library diperluas,
  sumber `file_id` ikut menutup otomatis.
