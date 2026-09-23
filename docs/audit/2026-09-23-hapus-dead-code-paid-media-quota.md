# Hapus dead code jalur quota & paid media (Opsi A)

**Date**: 2026-09-23
**Author**: opencode
**Source**: dokumentasi resmi Bot API 10.3 (24 Agu 2026) via r.jina.ai
**Proposal**: Opsi A — disetujui user

## Root Cause

Cross-check API menemukan klaster dead code: `downloadAndSendPaidMedia` tidak
punya satu pun pemanggil di seluruh `scraper/` sejak initial commit
(`git log -S` hanya menunjuk commit awal) — begitu pula
`showGofileFileInfo`/`showPixeldrainFileInfo`. Akibatnya kuota free-download
(`FREE_DOWNLOAD_LIMIT=3`) & paid media (`sendPaidMedia`) tak pernah berjalan,
sementara teks bantuan & kartu info (bila dipanggil) menjanjikan quota yang tidak
ada. Beberapa helper turunannya juga yatim (`formatFileSize`,
`getRemainingFreeDownloads`, dsb).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | Hapus: const `FREE_DOWNLOAD_LIMIT`, fungsi `hasFreeDownload`/`getRemainingFreeDownloads`/`incrementFreeDownload`, `formatFileSize`, `sendPaidMediaVideo`, `showGofileFileInfo`, `showPixeldrainFileInfo`, `downloadAndSendPaidMedia`, `setInterval(cleanupOldDownloads)`; bersihkan import (`getFreeDownloadCount`, `incrementFreeDownload`, `cleanupOldDownloads`, `getCachedFileId`, `setCachedFileId`, `resolveGofileFirstFile`); teks `act:help` non-admin & admin tak lagi menjanjikan quota harian |
| `scraper/db.js` | Hapus: `CREATE TABLE free_downloads`, fungsi `getFreeDownloadCount`/`incrementFreeDownload`/`cleanupOldDownloads` + exports-nya (tabel lama di DB dibiarkan, tidak di-drop) |
| `.opencode/skills/audit-workflow/SKILL.md` | Catatan quota yang basi diperbaiki: semua jalur link → `handleGofileUrl`/`handlePixeldrainUrl` tanpa quota |

## Detail Teknis

- Probe server lokal `127.0.0.1:9091`: method `sendRichMessage` (10.1) &
  `editEphemeralMessageText` (10.2) balas 400 (bukan 404) → server hidup;
  binary `telegram-bot-api/build` dibangun dari source **10.3** (CMakeLists=10.3,
  build 25 Agu 2026). Fitur modern (DisabledButton, force_reply, ephemeral)
  siap pakai — belum dipakai (belum masuk scope approve).
- `Message.paid_media` bertipe `PaidMediaInfo` (object `{star_count, paid_media[]}`),
  bukan array — path lama `result.paid_media[0]` salah; jalur ini ikut terhapus.
- `sendPaidMediaVideo` selalu memaksa `type:'video'` padahal `InputPaidMedia`
  hanya photo/video/live_photo — inkonsistensi yang ikut hilang bersih.
- `STAR_PRICE` TETAP dipakai (invoice akses non-admin `bot.js:3295` + config admin)
  dan `setCachedFileId` tetap dipakai `lib/telegram.js` — tidak ikut dihapus.
- Tabel `free_downloads` di DB dibiarkan (tanpa DROP) — kode tak lagi menyentuhnya.

## Verification

- `node --check scraper/bot.js` & `scraper/db.js` lulus.
- Nol sisa referensi: `rg FREE_DOWNLOAD_LIMIT|hasFreeDownload|getRemaining...|free_downloads|downloadAndSendPaidMedia|sendPaidMediaVideo|...` → kosong di bot.js/db.js.
- `require('./scraper/db.js')` load OK.
- 11 suite test lama PASS (filename-sanitize 9, libmenu-grid 14, livechat 4,
  extract-provider, sam-prescan, pagination 7, gdriveplayer-io 3, parse-ep1 14,
  download-sam-batch, kuronime, anime-topic-router 18).
- Skenario functional: restart bot → `/start` & tombol ❓ Bantuan tampil tanpa
  baris quota "3x gratis"; kirim link gofile → download jalan normal (semua
  jalur ke `handleGofileUrl`); admin & non-admin tidak terkena quota apa pun
  (memang tidak pernah ada sejak awal).

## Catatan lanjutan (belum di-approve, di luar scope Opsi A)

- Fitur modern `show_caption_above_media` (sendVideo) & `DisabledButton` (nav
  library) — siap server 10.3, menunggu approve.
