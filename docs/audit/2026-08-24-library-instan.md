# Fitur Library Instan (auto-save file_id)

**Date**: 2026-08-24
**Author**: opencode

## Objective

- Bangun fitur "Library Instan" ala fomo-drama: simpan file_id otomatis ke DB, user bisa `/cari` dan nonton instan dari Telegram servers
- Reorganisasi menu: admin panel terpisah dari user menu
- Input judul manual untuk gofile/pixeldrain (yang tidak punya judul bawaan)
- Pastikan batch-download.js tidak terganggu oleh fitur library

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/db.js` | Migrasi: `media_parts` += kolom `file_id`, `file_size`, `file_name`; tabel baru `bot_settings` (key-value persist); helper: `savePartFileId()`, `getSetting()`, `setSetting()`, `searchDrama()`, `listPartsWithFile()`, `getPartFileId()` |
| `scraper/bot.js` | Menu reorganization: `mainMenuKeyboard()` = user-only (Cari Drama, Live Chat, Bantuan); `adminPanelKeyboard()` = admin-only (Library toggle, Status, Stars). Command baru: `/cari <judul>`, `/libsimpan [on|off]`, `/admin`. Callback baru: `act:admin_panel`, `act:lib_toggle`, `act:lib_search`, `lib_menu:{slug}`, `lib_part:{slug}:{part}`, `dl_title_use:`, `dl_title_custom:`. Deep link: `/start lib_{slug}_{part}`. Gofile/pixeldrain: admin dapat prompt judul sebelum download via inline keyboard. `pendingDownloads` Map untuk state custom title input. `sendToTopicVideo()` return result (bukan bool) untuk capture file_id. `actionMerge10`: capture sendResult → save file_id jika libsimpan ON |
| `scraper/batch-download.js` | Import `savePartFileId`, `getSetting`; `uploadFile()` capture `sendVideoToChannel` result → simpan file_id saat libsimpan ON (default OFF, tidak ganggu upload flow) |

## Detail Teknis

### Key Design Decisions

- **Toggle global `/libsimpan on|off`**: default OFF — admin kontrol kapan mulai koleksi; setting di tabel `bot_settings`, persist lintas restart & batch process
- **Menu terpisah**: `/start` → user menu (📚 Cari Drama, 💬 Live Chat, ❓ Bantuan); `/admin` → admin panel (💾 Library toggle, 📊 Status, ⭐ Stars)
- **Gofile/Pixeldrain title prompt**: admin get inline keyboard "Download: filename" vs "Ganti Judul" → state via `pendingDownloads` Map → custom title dipakai sebagai caption
- **File_id disimpan SETELAH upload sukses**: tidak mengganggu flow upload; `sendToTopicVideo` return result (bukan bool) supaya file_id bisa di-capture dari topic mirror path

## Verification

- `node --check` lulus untuk `bot.js`, `batch-download.js`, `db.js`
- Batch-download upload flow tidak berubah: `uploaded++` → library save tambahan di luar retry loop → fallback ke `markPartUploaded()` tetap jalan
