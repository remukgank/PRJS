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

## 4.4 Dua bug dari report user: caption 1 baris & tidak streaming

User melaporkan: caption cuma **1 baris**, dan videonya **tidak streaming**. Dua-duanya
saya akui sebagai kesalahan saya.

### Bug 1 — caption 1 baris (pelanggaran kontrak AGENTS §5)

Saya mengklaim "caption 3 baris" berdasarkan **membaca kode**, bukan hasil run.
Kenyataannya:

```js
let finalCap = cap;
if (titleForCap) { finalCap = [ ...3 baris... ].join('\n'); }
```

Kalau `titleForCap` kosong (tidak ada di DB, tidak ada customTitle), yang terkirim
adalah `cap` = `cleanCaption(fileName)` — **1 baris**. Klaim saya salah karena
tidak pernah menjalankan jalurnya.

**Fix:** caption WAJIB lewat `buildCaption` (`handlers/vidoy.js`) — helper yang
sama dipakai semua provider. Fallback `—` untuk judul kosong, plus guard yang
melemak error kalau caption memuat `undefined`.

Bukti: `buildCaption` → 3 baris tanpa link, **4 baris** dengan link, judul kosong
→ `➧ Judul :- <b>—</b>` (bukan 1 baris).

### Bug 2 — tidak streaming (root cause di short-circuit remux)

Probe file kamenime ep 1 (121.331.884 byte):

```
ftyp@0(32)  free@32(8)  mdat@40(120407556)  moov@120407596(924288)
```

Atom `moov` ada di **belakang** → file **tidak faststart**. Player harus
mengunduh seluruh 115 MB sebelum bisa mulai memutar, jadi `supports_streaming:
true` jadi tidak berguna.

**Root cause — saya sendiri.** `remuxToMp4` punya short-circuit:

```js
if (head.slice(4, 8).toString('latin1') === 'ftyp') return inputPath;  // ← skip
```

Asumsi saya "sudah MP4 jadi tidak perlu remux" — tapi short-circuit itu juga
**melewatkan `-movflags +faststart`**. Every jalur remux di project ini memakai
`+faststart`; hanya jalur "sudah MP4" yang melewatkannya.

- Samehadaku kirim `.ts` → remux → faststart ✓
- Kamenime kirim `.mp4` → skip remux → **tidak faststart** ✗

Ironisnya, test (f) yang saya tulis ("tidak boleh remux") justru **mengunci** bug
ini. Test yang salah bukan hanya lolos — dia melarang perbaikannya.

**Fix (2 tempat):**
1. `downloader.js` — helper `isFaststartMp4()` (baca posisi atom: `moov` sebelum
   `mdat` = faststart). `remuxToMp4` skip hanya bila MP4 **dan** faststart.
   `downloader.js` tadinya di luar scope; diubah karena inibug yang saya buat
   dan short-circuit-nya ada di sana.
2. `handlers/download.js` — `handleKamenimeUrl` memanggil
   `isFaststartMp4()` lalu `remuxToMp4()` bila perlu.

Bukti fungsional (file asli 121 MB):

```
SEBELUM : faststart=false
SESUDAH : faststart=true | 1339ms | remux? true
info    : {"width":1280,"height":720,"duration":1387,"codec":"h264"}
```

`1339ms` — karena `-c copy` (tanpa re-encode). Codec & resolusi tetap utuh.

## 4.5 Permintaan user: "Ganti Judul" + label provider `hokireceh`

### 1. Ganti Judul di kamenime

**Keluhan:** judul hasil kamenime tidak cocok, dan tidak ada cara mengubahnya.

**Root cause:** dispatcher episode kamenime memanggil `handleKamenimeUrl` langsung,
melewati `titlePromptKeyboard`. Semua provider lain (filedon/gdrive/gofile) lewat
satu prompt: `[📥 Download: <judul> | ✏️ Ganti Judul]` → pilih target → unduh.
Kamenime tidak punya tombol itu sama sekali.

Selain itu `resolveProviderTitle()` **tidak punya cabang kamenime**, sehingga
jatuh ke `else` → `getPixeldrainInfo()` (gagal) → `fileName` null → judul selalu
nama file.

**Fix:**
- `resolveProviderTitle()` punya cabang `isKamenimeUrl` → `resolveKamenimeFile().fileName`
- Dispatcher episode kamenime memakai `titlePromptKeyboard` (sama filedon)
- `kam_ep:` (dari picker) memakai `titlePromptKeyboard` juga — sebelumnya langsung
  ke `animeTargetKeyboard`, jadi judul tetap tak bisa diganti dari picker

### 2. Label provider = `hokireceh`

Provider di caption sebelumnya `extractProvider(kmName)`, yang untuk
`"Naruto Shippuden-episode-1.mp4"` tidak menghasilkan apa-apa yang berguna.
Sekarang label tetap: `hokireceh`.

**Jebakan yang hampir terjadi:** `pending.handler` (internal dispatch key) ikut
terganti jadi `'hokireceh'`. Kalau begitu, cabang
`if (pending.handler === 'kamenime')` tidak akan pernah jalan dan judul kustom
yang sudah diketik user diam-diam hilang. Test (q) mengunci pemisahan ini:
`handler` internal = `kamenime`, label tampil = `hokireceh`.

## 5. Verifikasi

`test-kamenime-provider.js` **18 pass / 0 fail** (dari 10).

Kasus baru:

| | yang dibuktikan |
|---|---|
| k) | `parseKamenimeAnime` → slug; `isKamenimeAnimePage` pisahkan halaman/episode/file |
| l) | `listKamenimeEpisodes` dari **fixture offline** (tanpa network) → 14 episode, judul ternormalisasi, tanpa duplikat; stub memverifikasi `snapshot` **string** + `memo.name === 'show.anime-show'` |
| m) | Livewire gagal → error menyebut penyebab + "kirim URL episode manual", **bukan** daftar karangan |
| n) | **regresi**: `/storage/...mp4` tetap instan, 0 request |
| o) | `bot.js` punya dispatcher + `kam_ep:` + map; anime-page **sebelum** `isKamenimeUrl` |
| p) | `kam_ep:` menampilkan pilihan target (tg/vyt/vv) dan **tidak** langsung unduh |
| f) | pertahankan `.mp4` + cek faststart + `supports_streaming: true` |
| f2) | `remuxToMp4` memaksa remux untuk MP4 non-faststart |
| g) | caption lewat `buildCaption`: 3 baris (4 + link), tidak pernah 1 baris |
| p) | `kam_ep:` pakai `titlePromptKeyboard` (ada "Ganti Judul") + `resolveProviderTitle` punya cabang kamenime |
| q) | label provider `hokireceh`; internal dispatch key tetap `kamenime` |

Fixture `tests/fixtures/kamenime/effects-episodes.html` (5.067 bytes) =
potongan nyata `effects.html` (14 episode, termasuk anchor navigasi ep 1 & 500).

Bukti mutasi:

| mutasi | hasil |
|---|---|
| `snapshot` jadi objek | 14 pass / **1 fail** (l) — "snapshot harus string" |
| pilih komponen pertama (`offcanvas-navbar`) | 14 pass / **1 fail** (l) — "pilih komponen salah" |
| hapus `kam_ep:` dari `bot.js` | 14 pass / **1 fail** (o) |
| `kam_ep:` dikembalikan ke langsung-unduh | 15 pass / **1 fail** (p) |
| hapus cek faststart di `handleKamenimeUrl` | 16 pass / **1 fail** (f) |
| short-circuit `remuxToMp4` dikembalikan | 16 pass / **1 fail** (f2) |
| hapus prompt judul dari `kam_ep` | 17 pass / **1 fail** (p) |
| label provider kembali ke `extractProvider` | 17 pass / **1 fail** (q) |
| hapus cabang kamenime di `resolveProviderTitle` | 17 pass / **1 fail** (p) |

Bukti live: `listKamenimeEpisodes('.../anime/naruto-shippuden')` →
**500 episode, 0 lubang** (min 1, max 500), 500 judul unik, tidak ada `undefined`.

Suite penuh: **237 pass / 0 fail**.

## 6. Pelajaran

Dua bug di atas punya pola yang sama: **saya menyimpulkan dari membaca kode, lalu
melaporkannya sebagai fakta tanpa menjalankannya.**

- "caption 3 baris" →kenyataannya 1 baris.
- "tidak perlu remux karena sudah MP4" → padahal itu yang mematikan streaming.

Test yang saya tulis untuk "kunci perilaku" (test f: "tidak boleh remux") justru
melarang perbaikannya sendiri. Test yang mengunci perilaku benar tapi **berdasar
asumsi salah** lebih berbahaya daripada tidak ada test, karena ia kelihatan
menjaga.

Yang終 benar: jalankan jalur electorate sungguhan (unduh 121 MB, periksa atom,
remux, ukur ulang) dan laporkan hasilnya — bukan klaim dari diff.

## 7. Catatan

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
