# Cross-check Telegram Bot API 10.3 — hasil review & fix

Tanggal: 2026-08-29
Cakupan: `bot.js` (root) dan `scraper/bot.js` (utama, ~3991 baris) vs https://core.telegram.org/bots/api (Bot API 10.3, 24 Agu 2026).

## Temuan yang DI-FIX

### 1. isAdmin bypass (kritis)
- Sebelum: `ADMIN_IDS.length === 0 || ADMIN_IDS.includes(userId)` — jika `ADMIN_USER_IDS` kosong, SEMUA user dianggap admin (bisa scrape/merge tanpa bayar).
- Sesudah: jika tidak ada admin terdaftar, deny-all + log warning. `bot.js:468`, `scraper/bot.js:586`.
- Test: `isAdmin(123)` → false saat env kosong.

### 2. callback_data >64 bytes (kritis)
- `callback_data` maksimal **1-64 bytes** per docs. Tombol `dl:gofile:${encodeURIComponent(url)}`, `dl:pixeldrain:${...}`, `dl_title_use/custom` menyisipkan URL penuh (bisa >100).
- Fix: `urlCache` Map id→URL (mirip `slugCache`), callback_data jadi `dl:gofile:5` dsb. Cache dihapus bila >500 entri / >30 menit. Resolver memakai `resolveUrl(id)` dulu, fallback decode URL lama (urutan penting — id numerik selalu truthy).
- Berlaku di `scraper/bot.js` dan `bot.js` (root). `titlePromptKeyboard` ikut di-fix.

### 3. sendPaidMedia `file://` di cloud (kritis)
- Docs: `file://` hanya valid dengan **Local Bot API Server**; di cloud (api.telegram.org) harus `attach://`/file_id.
- Fix: guard — jika media berupa path lokal tapi `LOCAL_API_PORT` kosong, throw error jelas (jangan kirim JSON berisi `file://`). `bot.js:1455`, `scraper/bot.js:1988`.

### 4. Caption melebihi 1024 char (sedang)
- Semua media/caption limit **0-1024 char**. `cleanCaption` + synopsis bisa panjang.
- Fix: `caption.slice(0, 1024)` di `sendVideo`, `sendAudio`, `sendDocument`, `sendPhoto`, `sendPaidMediaVideo` (kedua file).

## Temuan yang AMAN / sudah benar
- `sendInvoice` XTR: `currency:'XTR'`, `prices` tepat 1 item, `provider_token:''` → sesuai docs (XTR wajib), `title.slice(0,32)`, `description.slice(0,255)`.
- `answerPreCheckoutQuery` dalam 10 detik → OK.
- `getMyStarBalance` → `result.amount + nanostar_amount/1e9` → OK (StarAmount).
- `star_count` 1-25000 → STAR_PRICE default 10 OK.
- `callback_data` yang lain (act:*, lib_part, lib_menu, ep) memakai slugCache / id pendek → OK.
- `sendPhoto` caption 0-1024 + parse_mode HTML → OK.
- Rich Messages: `sendRichMessage`, `sendDraft`, `sendStreaming` — lokal ke local API, tidak ada konflik dengan dok (Bot API 10.3 tidak punya `rich_message` di sendMessage; hanya editMessageText/sendRichMessage — dipakai sesuai).
- `createForumTopic` (bot root) — hanya supergroup forum, tidak dipakai di scraper.

## Pengecekan
- `node --check` lulus di `bot.js` dan `scraper/bot.js`.
- `require('./scraper/bot.js')` dengan token dummy load tanpa crash (DB/lokal siap).
- Perilaku preset terverifikasi: API_BASE lokal vs cloud benar-benar mengikuti `LOCAL_API_PORT`.

## Catatan tambahan
- `getFile` limit 20 MB di cloud belum di-handle (vision `getImageBase64` — risiko kecil di lingkungan Local API tanpa batas). Ditandai open, bukan fix sekarang.
- `429` di `answerCallbackQuery` masih di-silence `.catch(()=>{})` — dibiarkan agar tidak spam error, tapi FLOOD backoff di alur download belum ditambah.
## Gabungan 1 pesan rich menu merge10 (pasca commit)

- Keluhan user: alur merge10 mengirim 2 pesan per part (rich "Selesai" + pesan terpisah "📤 ... terkirim ke topic").
- Fix: `RichProgress.done(note)` menerima catatan opsional; `actionMerge10` menyimpan `sentNote` lalu meneruskannya ke `rp.done(sentNote)` — hapus `bot.sendMessage` terpisah. Pola sama diterapkan di alur `per_ep` (`Progress.done` kini `parse_mode:'HTML'` agar tag `<b>` dapat dirender).
- Verifikasi: simulasi isi pesan final menghasilkan satu pesan gabungan; `node --check` OK.
