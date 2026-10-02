# 2026-10-02 — Baris `Server` dinamis di caption + `show_caption_above_media`

Status: **DIIMPLEMENTASI + TEST LOLOS** (approve user: mode B, anime + drama,
"fitur wajib modern & profesional").

## Masalah (2 bagian)

**A. Pesan batch Dragon Ball (1 Okt 16:43–17:09) terkirim 3 baris tanpa link.**

Bukti dari user: `Episode :- 128` berakhir di `Provider` — baris `Link` hilang.
Root cause = bukan data, tapi **timing**: batch berjalan 17:08 dengan kode
lama; fallback caption `captionLink = out.vidoy.link || out.vidaraLink` baru
masuk commit `4d74efe` **18:11** dan aktif setelah restart 18:38. Untuk target
`vt` (tanpa record Vidoy) `link` falsy → `buildCaption` baris 614 menggugurkan
baris Link.

Bukti perbaikan: batch tes 2 Okt 05:20 (`kam_allgo:vt`, jalur **skip**) sudah
menghasilkan 4 baris + link `https://vidara.to/YXssZ6mftryMD` (ep129) —
rekonstruksi `vidaraLinkFromRecord` dari record DB ep1/128/129 juga selalu
non-kosong. `handleKamenimeUrl` (download.js) tercatat **0 kali** — semua
pesan dari `actionAnimeEpisode`.

**B. Permintaan baris `Server` (mode B — dinamis) untuk anime + drama.**

## Keputusan desain

- `Server :- VIDARA|VIDOY` = host yang **benar-benar memegang file episode
  itu** (dinamis, bukan teks statis "VIDARA/VIDOY (hanya salah satu)").
- Hanya tampil **bersama Link** — tanpa link = tanpa server (upload gagal /
  download manual tidak punya host).
- Fitur modern (cross-check Bot API 10.3, 24 Agu 2026, via
  `r.jina.ai/https://core.telegram.org/bots/api`):
  `show_caption_above_media: true` — caption tampil **di atas** video
  (param resmi `sendVideo`), user melihat judul/episode/provider/link/server
  tanpa meng-expand.

## Implementasi (scope yang di-approve)

| File | Perubahan |
|---|---|
| `scraper/handlers/vidoy.js` | `buildCaption` + param `server` (baris ke-5 bersyarat); `actionAnimeEpisode` → `captionServer = vidoyLink ? 'VIDOY' : (captionLink ? 'VIDARA' : '')`; merge10 Vidoy → `server: item.link ? 'VIDOY' : ''` |
| `scraper/handlers/vidara.js` | caption literal drama: `let fc` diangkat keluar `try` + baris `Link` (rekonstruksi `fc`+`saveDomain`) + `Server :- VIDARA`, keduanya bersyarat `fc` ada; import `shortLinkLabel` |
| `scraper/lib/telegram.js` | `sendVideo` → `show_caption_above_media: true` di **kedua** jalur (local API + `_bot.sendVideo`) — satu titik, otomatis menjangkau semua pengirim (anime, drama, batch, channel) |
| `scraper/tests/test-media-contract.js` | asersi caption 4→5 baris + test baru `show_caption_above_media` (12 pass) |
| `.tests/caption-server-line.js` | **baru** — 11 skenario: 5/4/3 baris, guard pemanggil, tanpa `undefined`, skenario rekonstruksi record DB |
| `AGENTS.md` §5 | kontrak caption diperbarui: 4 baris + `Server` = 5; wajib `show_caption_above_media` |

**Tidak disentuh** (sesuai proposal): download manual (`download.js` caption
literal), `bot.js` `actionPerEpisode`/`actionMerge10`, `batch-download.js` —
ketiganya **tidak meng-upload ke host mana pun** → tanpa baris Link & Server
(konsisten).

## Verification (hasil run, bukan klaim)

- `node --check` 6 file: **OK semua**.
- `.tests/caption-server-line.js`: **11 pass, 0 fail**.
- `scraper/tests/test-media-contract.js`: **12 pass, 0 fail**.
- `test-kamenime-provider`: **26 pass / 0 fail** (caption vt tanpa server = 4
  baris tetap).
- `test-vidoy-uploader`: **164 pass / 0 fail**; `test-caption-html-escape` 6/6;
  `test-html-safety` 22/22; `test-episode-status` 11/11;
  `test-animeep-parser` 8/8; `test-btn-style` 10/10.
- Total ronde ini: **217+ pass, 0 fail**.

## Temuan luar scope (dilaporkan, TIDAK diubah)

1. `bot.js:1825` note `⚠️ … > limit — hanya Vidara` **menyesatkan** —
   `grep uploadFileViaCurl|uploadToVidara|uploadBatches` di `bot.js` = nihil;
   jalur itu tidak pernah meng-upload ke Vidara (hanya kirim TG).
2. Caption drama literal di `bot.js` `actionPerEpisode`/`actionMerge10`,
   `batch-download.js`, dan `download.js` (filedon/mega/gdrive/kuronime/
   kamenime manual) tetap **3 baris tanpa Link** — di luar kontrak §5 yang
   aslinya menyebut 4 baris; tidak diperbaiki karena di luar approve.
3. Pesan lama (129 ep Dragon Ball, 3 baris) bisa diedit via
   `editMessageCaption` — tapi butuh `message_id` yang belum tersimpan
   (proposal A/B pointer TG masih menunggu keputusan user).

## Follow-up fix (v3.6.1): skip Vidara kirim string ke `vidaraLinkFromRecord`

Setelah deploy v3.6.0, user kirim ulang ep1 target `vt` (06:06:44 log) dan
menerima caption **3 baris tanpa Link & Server** — padahal `Vidara dilewati`
muncul (record ada).

**Root cause** (`vidoy.js:474`):

```js
const alreadyInVidara = preVidara && preVidara.filecode; // → STRING "IIV7UjteaSEbx"
out.vidaraLink = vidaraLinkFromRecord(alreadyInVidara);   // ❌ terima string
// rec.filecode → undefined → code='' → return '' → captionLink='' → 3 baris
```

Baris 373 (jalur `!needTg`) sudah benar memakai `preVidara` (objek). Rekonstruksi
runtime: `recode(preVidara)` = `https://vidara.to/IIV7UjteaSEbx` ✓ vs
`recode("IIV7UjteaSEbx")` = `''` ✗.

**Pelajaran (sesuai AGENTS §4):** verifikasi tadi menguji *fungsi*
(`vidaraLinkFromRecord` dgn objek literal = benar) tapi bukan *pemanggilannya* —
argumen runtime bisa berbeda dari yang disangka.

**Fix:** argumen → `preVidara` + komentar penanda insiden + test anti-regresi di
`.tests/caption-server-line.js` (larangan source `vidaraLinkFromRecord(
alreadyInVidara)` + rekonstruksi string-vs-objek). Test: `.tests` 12 pass,
`test-media-contract` 12 pass, `test-vidoy-uploader` 164 pass — 0 fail.

**Deploy:** daemon pm2 ternyata kehilangan daftar (`dump.pm2` kosong — bot
06:05 jalan di luar pm2). Dibereskan: kill bot lama (tidak ada download
aktif — ep1 06:06 sudah `done`), `pm2 start scraper/bot.js --name prjs-bot
--cwd /home/runner/workspace --max-memory-restart 700M` + `pm2 save` →
`prjs-bot` online PID 3964, `Polling started`, 0 error, 1 instance.
9router & FlareSolverr tidak tersentuh.

## Tag

- `v3.6.0` — **minor**: kontrak caption berubah (4→5 baris + fitur baru) tapi
  tidak ada konsumen/integrasi lama yang rusak; mengikuti preseden `v3.1.0`
  (`!dell` + tombol baru = minor).
- `v3.6.1` — **patch**: fix argumen `vidaraLinkFromRecord(preVidara)` (caption
  skip kehilangan baris Link & Server).
