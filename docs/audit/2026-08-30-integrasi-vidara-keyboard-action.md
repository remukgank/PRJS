# Integrasi Vidara ke Keyboard Action (Post-Scrape)

**Date**: 2026-08-30
**Author**: opencode

## Root Cause

Opsi upload ke Vidara tersembunyi di menu utama (`act:add_content`) sebagai flow terpisah. User harus kirim URL dua kali: sekali untuk scrape, sekali lagi untuk Vidara. Seharusnya semua opsi (Telegram, Vidara, Both) langsung muncul di keyboard action setelah scrape.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | Update `mainActionKeyboard()` — tambah 4 tombol Vidara (admin only). Hapus tombol "📤 Tambah Konten → Vidara" dari `mainMenuKeyboard`. Hapus `aimVidara` Map + interceptor + `handleAddContentVidara` + `act:add_content`/`act:add_content_cancel` callbacks. Tambah `buildResolveVideoUrl()`, `actionVidaraPerEp()`, `actionVidaraMerge10()`, `actionVidaraAndTelegramMerge10()`, `actionVidaraAndTelegramPerEp()`. Tambah callback handler: `act:v_per_ep`, `act:v_merge10`, `act:vt_per_ep`, `act:vt_merge10`. |

## Detail Teknis

### Keyboard baru (admin only, setelah scrape)

```
📥 Download semua — kirim per episode           (act:per_ep)
🗜 Download semua — gabung per 10 ep            (act:merge10)
📥 Download semua ke Vidara — kirim per episode  (act:v_per_ep)
🗜 Download semua ke Vidara — gabung per 10 ep   (act:v_merge10)
📥 Download semua ke Vidara & Telegram — kirim per episode  (act:vt_per_ep)
🗜 Download semua ke Vidara & Telegram — gabung per 10 ep   (act:vt_merge10)
🔢 Pilih episode tertentu                        (act:list)
💬 Live Chat                                     (act:ai)
🏠 Menu Utama                                    (act:main_menu)
```

### Fungsi baru

- `buildResolveVideoUrl(session)` — helper membangun video URL resolver dari session (reelfren/dramafren).
- `actionVidaraPerEp(chatId, session)` — download HLS → mp4 via `ensureMp4`, upload via `uploadFileViaCurl` (bukan `upload/url`).
- `actionVidaraMerge10(chatId, session)` — batch 10 via `uploadDramaBatchesVidara`.
- `actionVidaraAndTelegramMerge10(chatId, session)` — upload Vidara + kirim Telegram (download terpisah, filecleanup mandiri).
- `actionVidaraAndTelegramPerEp(chatId, session)` — per-ep: download → upload Vidara → kirim Telegram → cleanup.

### Pola file lifecycle (inspirasi VDL FIX-PARALLEL-001)

VDL: download lokal → fire Byse + Vidara bersamaan → tunggu keduanya selesai → baru hapus file.
PRJS (saat ini): Vidara dan Telegram download copy masing-masing → cleanup mandiri. Tidak ada conflict file karena tidak share file yang sama. Optimalisasi (download sekali) bisa dilakukan nanti.

### Yang dihapus

- Tombol "📤 Tambah Konten → Vidara" dari mainMenuKeyboard
- `aimVidara` Map + interceptor di message handler
- `handleAddContentVidara` function
- `act:add_content` dan `act:add_content_cancel` callbacks

## Verification

- `node --check scraper/bot.js` → OK
- Tidak ada dangling reference ke `aimVidara`, `handleAddContentVidara`, `act:add_content`
- `vidaraBusy` Map masih dipakai oleh fungsi Vidara baru
- `slug` dan `lang` ter-destructure dengan benar di semua fungsi baru
