# Fix Caption HTML Bocor Mentah di Jalur Telegram-Saja (`<b>` tampil mentah)

**Date**: 2026-09-28
**Author**: hermes (implementasi), laporan oleh Liu Qian Yu di grup

## Root Cause

Caption video anime dibangun sebagai **HTML** oleh `buildCaption()`
(`handlers/vidoy.js:577-583`), misalnya:

```
➧ Judul :- <b>Super Dragon Ball Heroes</b>
➧ Episode :- 12
➧ Provider :- hokireceh
```

Pengiriman caption punya **dua jalur** dengan implementasi berbeda:

| Jalur | Sumber payload | `parse_mode` | Hasil |
|---|---|---|---|
| TG+VIDOY / TG+VIDARA | `handlers/vidoy.js` `mediaOpts` | ✅ eksplisit `'HTML'` | tag jadi bold |
| **TG saja** | `handlers/download.js` (10 call site) → `lib/animeTopic.js` | ❌ **tidak pernah diset** | tag tampil **mentah** |

`buildAnimeSender()` di `lib/animeTopic.js` meneruskan `opts` apa adanya:

```js
const base = threadId ? { ...opts, message_thread_id: threadId } : { ...opts };
result = await sendVideo(chatId, filePath, { ...base, supports_streaming: true }, cacheInfo);
```

Tidak ada `parse_mode` di mana pun pada jalur itu. `lib/telegram.js:223-241`
cuma meneruskan `parse_mode` dari `opts` — kalau `undefined`, field itu tidak
dikirim ke Telegram. `botOptions` (`bot.js:114`) juga tidak punya default
`parse_mode`. Akibatnya Telegram merender tag HTML sebagai teks biasa.

**Kenapa mode Vidoy aman:** `handlers/vidoy.js:290-292` menyertakan
`parse_mode: 'HTML'` secara eksplisit di `mediaOpts`.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/lib/animeTopic.js` | Set `parse_mode` default `'HTML'` sekali di router (3 branch send: video/audio/document) |
| `scraper/tests/test-media-contract.js` | Assertion `animeTopic` diubah dari cek nama variabel (`base`) → cek perilaku (`supports_streaming: true` di branch video + parse_mode default) |
| `.tests/test-anime-parse-mode.js` | **Baru** — 15 test fungsional yang memanggil `buildAnimeSender()` asli dengan sender tiruan |

`handlers/download.js` **tidak disentuh** — 10 call site-nya ikut benar
karena `parse_mode` diset sekali di router. Ini mengikuti prinsip AGENTS §4
("ubah parser? cek SEMUA pemanggilnya") secara inverse: set di satu titik
yang lewat semua pemanggil, bukan 10 titik yang bisa ada yang terlewat.

## Detail Teknis

```js
// parse_mode WAJIB diset di sini (router), bukan di tiap pemanggil.
const base = { ...opts, parse_mode: opts.parse_mode || 'HTML' };
const withThread = threadId ? { ...base, message_thread_id: threadId } : base;
```

- `opts.parse_mode || 'HTML'` → pemanggil yang sudah mengirim `parse_mode`
  eksplisit (mis. `MarkdownV2`) **tidak ditimpa**.
- `sendAudio`/`sendDocument` tidak memakai spread `withThread` (butuh
  caption + thread saja), jadi keduanya menyebut `parse_mode` eksplisit.
- `show_caption_above_media: true` sudah ada di `lib/telegram.js:232,242`
  dan tidak diubah — kontrak media §5 tetap utuh.

## Verification

### node --check
- `scraper/lib/animeTopic.js` — PASS
- `scraper/tests/test-media-contract.js` — PASS
- `.tests/test-anime-parse-mode.js` — PASS

### Test fungsional (`.tests/test-anime-parse-mode.js`)
15 pass, 0 fail. Memanggil `buildAnimeSender()` **asli** dengan sender
tiruan yang mencatat payload:

1. video dapat `parse_mode: 'HTML'` walau pemanggil tidak menyediakannya
2. caption tidak dimodifikasi (tag tetap utuh untuk di-parse Telegram)
3. `supports_streaming` tetap `true`
4. `message_thread_id` tetap diteruskan
5. `parse_mode` eksplisit pemanggil tidak ditimpa
6. fallback `resolveThread → null` tetap dapat `parse_mode`
7. `resolveThread` melempar → fallback tetap `parse_mode`
8. audio & document dapat `parse_mode` (bug yang sama di kedua branch itu)
9. caption polos tidak dirusak
10. ketiga branch send punya baris-call yang bisa diperiksa
11. `sendVideo` memakai spread `withThread`
12. `sendAudio`/`sendDocument` menyebut `parse_mode` eksplisit
13. satu deklarasi `const base` yang menyertakan `parse_mode`
14. tidak ada payload send yang memakai `base` mentah

### Test suite yang ada
| Test | Hasil |
|------|-------|
| `test-media-contract.js` | 12 pass, 0 fail |
| `test-anime-topic-router.js` | 18 pass, 0 fail |
| `test-vidoy-uploader.js` | 164 pass, 0 fail |
| `test-watchdog-aria2c.js` | PASS (watchdog tidak terganggu) |

### Cross-check dokumentasi resmi
`parse_mode` adalah parameter opsional pada `sendVideo` — kalau tidak
dikirim, caption ditampilkan sebagai teks polos tanpa parsing HTML.
Sumber: https://core.telegram.org/bots/api#sendvideo (dicek 28 Sep 2026).

## Sisa pekerjaan (di luar scope fix ini)

Caption yang **sudah tersimpan** di DB masih bertag `<b>` — 53 baris di
`media_parts.caption` pada saat investigasi. Kalau bot kirim ulang episode
itu dari library (`lib_part:`), tag tetap bocor karena caption dibaca dari DB.
Perlu 1 query `UPDATE` untuk bersihin data lama.

Bug lain yang masih terbuka dan belum diperbaiki (hasil investigasi
sebelumnya, dilaporkan terpisah):

1. `lib/parser.js` `extractPartFromFilename` gagal parse
   `OP-933-FULLHD-SAMEHADAKU.VIP.mp4` → selalu `1` (angka di tengah string,
   regex hanya cocok di akhir). Verified: `parseSamehadakuFilename` di file
   yang sama sudah benar返回 933.
2. `downloader.js:317` — skip file parsial >1 MB tanpa validasi kelengkapan.
3. `handlers/vidoy.js:243` — skip `destPath` hanya karena "file ada", tanpa
   validasi → file parsial ter-upload ke Vidoy.
4. `handlers/vidoy.js:328` — `finally` `rmSync(outDir)` tidak jalan saat
   proses mati → sisa parsial terakumulasi.
5. Fallback caption `bot.js:5039-5043` (jalur `lib_part:`) memakai format
   `➧ Episode :- <b>Episode 1</b>` (kata "Episode" ganda) dan tidak punya
   baris Link meski link Vidoy tersedia di `vidoy_uploads`.