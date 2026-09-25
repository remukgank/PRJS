# Lapisan keamanan HTML terpusat (safeHtml) — anti 400 "can't parse entities"

**Date**: 2026-09-24
**Author**: opencode
**Versi**: `v2.3.0` (minor — menambah lapisan keamanan baru di semua path kirim)
**Proposal**: disetujui user
**Sumber kebenaran**: dokumen resmi Telegram Bot API **10.3** (24 Agu 2026, diverifikasi ulang via r.jina.ai → core.telegram.org/bots/api)

## Root Cause

Audit terhadap 149 titik `parse_mode: 'HTML'` di codebase menemukan **71 titik**
yang menyisipkan data mentah (tanpa escape) ke string HTML:

| File | Titik | Sumber data berisiko |
|------|-------|----------------------|
| `scraper/bot.js` | 62 | `dramaTitle`/`dName`/`detectedTitle`/`promptTitle` (judul dari halaman web), `fileName`/`info.name` di dalam `<code>`, **`customTitle` (diketik user)**, **`err.message`** (berisi filename/URL), slug/subdomain |
| `scraper/handlers/vidara.js` | 6 | `info.title`, `label`, `session.meta.title`, `err.message` |
| `scraper/handlers/download.js` | 3 | `info.title`, `err.message` |

Data dengan `&`, `<`, atau `>` membuat Telegram menolak dengan
`400 Bad Request: can't parse entities`. Karena sebagian besar pemanggil memakai
`.catch(() => {})`, error **ditelan**: pesan macet di status sebelumnya (mis.
"🔍 Mengambil link server...") tanpa penjelasan. Dua instance konkret sudah
terbukti & diperbaiki terpisah (preview kuronime, preview film samehadaku), namun
71 titik sisanya hanya bisa ditutup secara **terpusat** — konvensi repo sudah
memiliki titik ini (`wrapAnswerCallbackQuery` di `lib/telegram.js:44-75`).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/lib/html.js` (baru) | `safeHtml()`: pertahankan tag resmi + entitas valid; escape `&` telanjang & `<`/`>` di luar tag; auto-close tag tak berpasangan; rapikan nesting salah (tag penutup liar jadi teks). `escapeHtml()` (helper lama, konsisten). `isTelegramBadRequest()`: `response.body.error_code === 400` (library) / `err.telegramErrorCode === 400` (apiPost) / `status === 400`. `sanitizeHtmlPayload()` & `toPlainTextPayload()` untuk payload `apiPost` |
| `scraper/lib/telegram.js` | `wrapHtmlSafety(bot)` (pola sama seperti `wrapAnswerCallbackQuery`, mark `Symbol.for('prjs.telegram.htmlSafetyWrapped')`), dipasang di `initTelegram`; membungkus 10 method (`sendMessage`, `editMessageText`, `editMessageCaption`, `sendPhoto/Video/Document/Audio/Animation/Voice/VideoNote`): sanitasi `text`/`caption` bila `parse_mode==='HTML'`; bila tetap 400 → retry **sekali** tanpa `parse_mode` + `logger.warn`. `apiPost`: sanitasi payload sebelum kirim, lampirkan `err.telegramErrorCode`, fallback plain-text sekali (retry flood/transient tetap utuh) |
| `scraper/bot.js` | `sendRichMessage` & `sendRichMessageDraft`: konten `format:'html'` disanitasi `safeHtml` (jalur markdown tidak diubah — lihat catatan) |
| `scraper/tests/test-html-safety.js` (baru) | 22 test: `safeHtml` (escape, tag sah, entitas, auto-close, nesting salah, tag asing, null/non-string), `ALLOWED_TAGS` hanya tag resmi, `isTelegramBadRequest` (ETELEGRAM/apiPost/429), `sanitizeHtmlPayload`/`toPlainTextPayload`, wrapper bot (sanitasi pra-kirim, retry plain-text saat 400, 429 tanpa retry), `apiPost` end-to-end lewat HTTP server nyata, anti-drift |

## Detail Teknis

- **Daftar tag & entitis resmi** (dari docs, bukan asumsi): `b, strong, i, em, u,
  ins, s, strike, del`, `span class="tg-spoiler"`, `tg-spoiler`, `a href`,
  `tg-emoji emoji-id`, `tg-time`, `code`, `pre`, `blockquote` (+`expandable`).
  Entitas: semua numerik + named `&lt; &gt; &amp; &quot;`; `<`/`>`/`&` di luar
  tag/entitas wajib di-escape. Hanya tag di daftar itu yang dipertahankan.
- **Tanpa asumsi string error**: docs tidak mendokumentasikan teks error parse-entity,
  jadi deteksi memakai kode numerik dari library (`TelegramError.response.body.error_code`,
  `dist/http.js:107` & `dist/errors.js:40-46`) dan `telegramErrorCode` yang kini
  dipasang `apiPost`.
- **Tanpa double-escape**: titik komposisi yang sudah meng-escape (mis. `escHtml`
  di preview, `library.js:114` sinopsis) tetap utuh karena `safeHtml`
  mempertahankan entitas valid (`&amp;` → `&amp;`).
- **Aman untuk pesan hilang**: retry memakai **method & argumen yang sama** tanpa
  `parse_mode` — untuk `editMessageText` tetap edit (tak pernah berubah jadi kirim
  baru), jadi tak ada duplikasi pesan.
- **Efek 400 lain** (mis. "message is too long", "chat not found") tetap gagal
  setelah retry dan errornya diteruskan; tak ada retry tanpa batas (sekali saja).
- **Error yang ditemukan saat implementasi & diperbaiki**: fallback `apiPost`
  sempat diinisialisasi dengan kuota retry 0 sehingga resilience 429 saat fallback
  hilang → kini memakai kuota flood/transient yang sama.
- `parse_mode` resmi: `HTML`, `MarkdownV2`, `Markdown` (legacy). Jalur
  `MarkdownV2`/`Markdown` tidak disentuh (lihat catatan).

## Verification

- `node --check` **CLEAN**: `scraper/lib/html.js`, `scraper/lib/telegram.js`,
  `scraper/bot.js`, `scraper/tests/test-html-safety.js`.
- `test-html-safety.js`: **22 pass, 0 fail** (termasuk `apiPost` end-to-end lewat
  HTTP server lokal: payload HTML disanitasi → 400 → fallback tanpa `parse_mode` → Sukses).
- Regresi 16 suite hijau: caption-escape 6, movie 13, parse-ep1 14, ep1-slug 22,
  slugtail 28, picker 7, libmenu 14, livechat 4, filename 9, anime-router 18,
  gdriveplayer 3, prescan, batch, kuronime, extract-provider.
- Skenario functional setelah restart: kirim judul/berkas bermasalah `&`/`<`
  (mis. drama dengan `&` di judul, nama file `A&B.mp4`, atau judul hasil ketikan
  user) → pesan terkirim dengan tampilan benar (format `<b>`/`<tg-spoiler>` tetap
  aktif), tanpa status macet; bila tetap gagal → pesan terkirim sebagai plain
  text dan muncul `WARN ... retry sebagai plain text` di log.

## Deploy

- `lib/telegram.js` + `bot.js` berubah → **restart bot** (tanya dulu).
- Setelah restart & tes → commit, push, tag `v2.3.0`.

## Catatan (di luar scope)

- Jalur **rich message format `markdown`** (`sendRichMessage` dengan
  `format:'markdown'`, dipakai menu & status) belum disanitasi — aturan escaping
  Markdown/MarkdownV2 berbeda; perlu proposal terpisah bila tomato.
- Pesan `MarkdownV2` (bila ada) belum tersentuh.
