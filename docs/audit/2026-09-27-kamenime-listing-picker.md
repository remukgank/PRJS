# Kamenime masuk ke picker anime

**Tanggal:** 27 Sep 2026
**File:** `scraper/providers/kamenime.js`, `scraper/bot.js`, `scraper/tests/test-kamenime-provider.js`, `scraper/tests/fixtures/kamenime/effects-episodes.html` (baru)
**Status:** kode selesai + terverifikasi. **Belum di-deploy** (butuh restart pm2).

---

## 1. Masalah

Provider kamenime (`f4d8a3b`) hanya jalan per-URL:

```
https://www.kamenime.com/anime/naruto-shippuden/episode/1
```

User harus menempel URL episode manual. Tidak ada cara kirim halaman anime lalu
pilih episode — padahal gofile/pixeldrain/filedon/samehadaku semua punya alur
"pilih dari library". Ketidakkonsistenan UX.

## 2. Root cause (verified)

Halaman `https://www.kamenime.com/anime/naruto-shippuden` = 37.184 bytes, **tidak
berisi daftar episode**. Hanya 2 link navigasi (`EPISODE TERLAMA` → ep 1,
`EPISODE TERBARU` → ep 500).

Daftar episode dimuat saat tombol "DAFTAR EPISODE" diklik — `wire:click="toggleVideo"`,
Laravel **Livewire v3.14.1**. Snapshot Livewire hanya berisi metadata
(`first_episode` = `App\Models\Video` key 6824, `latest_episode` key 7343),
bukan daftar episode.

## 3. Menembus Livewire — 5 hal yang WAJIB benar

Semuanya diuji satu per satu karena gagal satu saja:

| # | Intercept | Kalau salah |
|---|---|---|
| 1 | endpoint `/livewire/update` (v3) | `/livewire/message/<name>` (format **v2**) → **HTTP 404** |
| 2 | `Content-Type: application/json` + header `X-Livewire: 1` | ditolak |
| 3 | `components[].snapshot` = **string** JSON (bukan objek) | **HTTP 500** |
| 4 | `X-CSRF-TOKEN` dari `<meta name="csrf-token">` + cookie `XSRF-TOKEN` | ditolak |
| 5 | pilih komponen `memo.name === 'show.anime-show'` | komponen pertama di halaman adalah `offcanvas-navbar` |

Respons sukses: `components[0].effects.html` = **271.165 byte** berisi grid
500 episode.

## 4. Implementasi

### 4.1 `providers/kamenime.js`
- `isKamenimeAnimePage(url)` — memisahkan halaman anime dari URL episode/file.
  Wajib: `isKamenimeUrl` sendiri **salah** untuk halaman anime (memang begitu).
- `parseKamenimeAnime(url)` → `{ slug, title, pageUrl }`.
- `listKamenimeEpisodes(animeUrl)` → `{ slug, episodes, pageUrl }`,
  `episodes` = `[{ ep, url, title }]`.
  - Gagal → `Kamenime: listing tidak bisa diambil, kirim URL episode manual (penyebab)`.
    **Tidak menebak nomor episode sama sekali.**
- Nomor episode selalu diambil dari `href`, judul dinormalkan ke `Episode N` —
  teks anchor navigasi (`EPISODE TERLAMA`/`TERBARU`) tidak bocor jadi judul,
  dan tidak ada nomor yang dikarang dari teks.

### 4.2 `bot.js`
- `kamenimeEpisodeMap` (epId hash-8 → URL), `buildKamenimeEpisodePicker()`.
- Dispatcher `isKamenimeAnimePage(text)` **di atas** `isKamenimeUrl(text)`.
- Callback `kam_ep:<epId>` → `handleKamenimeUrl`.
- Kegagalan listing menampilkan pesan jujur + contoh URL episode manual.

## 4.3 Bug: `kam_ep:` langsung unduh, tanpa pilih target

Dilaporkan user setelah picker dipakai: memilih episode **langsung mengunduh**,
tidak ada tombol target sama sekali.

**Akibatnya:** user tidak bisa memilih Telegram / Vidoy+TG / Vidoy — dan karena
`tg` memberi caption 3 baris tanpa link, padahal `vyt` memberi 4 baris + link
Vidoy, opsi itu jadi mustahil dipilih.

**Penyebab:** handler `kam_ep:` memanggil `handleKamenimeUrl` secara langsung.
Semua provider lain (`sam_ep`, `kur_go`) selalu menanyakan target dulu.

**Fix** — daftarkan URL ke `urlCache`, lalu pakai alur `dl_go` yang sudah ada
(sudah punya cabang kamenime di target `tg` dan `resolveDirectUrl` untuk vyt/vv):

```js
const urlId = cacheUrl(episodeUrl);
return bot.editMessageText('📥 <b>Kamenime</b>\n\nPilih target:', {
  chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
  reply_markup: { inline_keyboard: animeTargetKeyboard(
    `dl_go:tg:${urlId}`, `dl_go:vyt:${urlId}`, `dl_go:vv:${urlId}`) },
}).catch(() => {});
```

Test (p) mengunci: `kam_ep` harus memuat `animeTargetKeyboard` + ketiga tombol
`dl_go:tg/vyt/vv` + `cacheUrl`, dan **dilarang** memanggil `handleKamenimeUrl`.
Bukti mutasi: kembalikan bug → 15 pass / **1 fail**.

## 5. Verifikasi

`test-kamenime-provider.js` **16 pass / 0 fail** (dari 10 → 16 lewat 2 tahap).

Kasus baru:

| | yang dibuktikan |
|---|---|
| k) | `parseKamenimeAnime` → slug; `isKamenimeAnimePage` pisahkan halaman/episode/file |
| l) | `listKamenimeEpisodes` dari **fixture offline** (tanpa network) → 14 episode, judul ternormalisasi, tanpa duplikat; stub memverifikasi `snapshot` **string** + `memo.name === 'show.anime-show'` |
| m) | Livewire gagal → error menyebut penyebab + "kirim URL episode manual", **bukan** daftar karangan |
| n) | **regresi**: `/storage/...mp4` tetap instan, 0 request |
| o) | `bot.js` punya dispatcher + `kam_ep:` + map; anime-page **sebelum** `isKamenimeUrl` |
| p) | `kam_ep:` menampilkan pilihan target (tg/vyt/vv) dan **tidak** langsung unduh |

Fixture `tests/fixtures/kamenime/effects-episodes.html` (5.067 bytes) =
potongan nyata `effects.html` (14 episode, termasuk anchor navigasi ep 1 & 500).

Bukti mutasi:

| mutasi | hasil |
|---|---|
| `snapshot` jadi objek | 14 pass / **1 fail** (l) — "snapshot harus string" |
| pilih komponen pertama (`offcanvas-navbar`) | 14 pass / **1 fail** (l) — "pilih komponen salah" |
| hapus `kam_ep:` dari `bot.js` | 14 pass / **1 fail** (o) |
| `kam_ep:` dikembalikan ke langsung-unduh | 15 pass / **1 fail** (p) |

Bukti live: `listKamenimeEpisodes('.../anime/naruto-shippuden')` →
**500 episode, 0 lubang** (min 1, max 500), 500 judul unik, tidak ada `undefined`.

Suite penuh: **235 pass / 0 fail**.

## 6. Catatan

- **Caption & library tidak diubah** — `handleKamenimeUrl` (`download.js`) tetap
  dipakai apa adanya, termasuk `upsertMedia` + `savePartFileId` + cek duplikat.
- Picker memakai kunci library `anime:<slug>` yang **sama** dengan
  `handleKamenimeUrl`, jadi episode yang sudah dikirim dari sumber mana pun
  tampil 📦. Untuk Naruto, kunci itu `naruto-shippuden` — sama dengan
  samehadaku, jadi status "sudah ada" lintas-sumber.
- 2 request per listing (GET halaman + POST Livewire). Tidak ada pengef caching;
  kalau listing ini sering dipakai, cache per-slug layak ditambahkan terpisah.
- Livewire bisa berubah kapan saja. Karena itu kegagalan **tidak** disembunyikan
  dan **tidak** ditebak — user diberi pesan + contoh URL episode manual.
