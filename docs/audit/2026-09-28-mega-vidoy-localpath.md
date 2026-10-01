# 2026-09-28 — Mega ke Vidoy lewat file lokal (`localPath`)

## Masalah

Tombol MEGA di picker Samehadaku (`sam_dl:mega:`, ditambah sebelumnya) membuka
jalan buntu untuk target `vyt`/`vv`:

```
sam_go:vyt:mega:2  →  resolveDirectUrl(mega-url) → null  → "Gagal resolve link file"
```

`resolveDirectUrl` return null untuk mega karena `mega.File` streaming, bukan
URL HTTP (`handlers/download.js`, komentar di kode). Tidak ada download, tidak
ada error di log — hening setelah callback.

## Koreksi atas klaim agent

Agent sempat menyatakan "MEGA tidak bisa ke Vidoy — by design". **Salah.**
Trace `actionAnimeEpisode` (`handlers/vidoy.js:249-324`):

```
1. ensureMp4(directUrl, destPath)          ← download URL → file LOKAL
2. vidoyService.uploadSingle({ outDir })   ← upload file LOKAL → Vidoy
3. sendAnimeMedia(destPath)                ← kirim file LOKAL → Telegram
```

Upload Vidoy memakai **file lokal**, bukan URL. URL hanya dibutuhkan di langkah
1. Dan `handleMegaUrl` membuktikan mega bisa jadi file lokal
(`resolveMegaFile` → `downloadMegaFile(mf.file, outPath)`).

Jadi mega HANYA butuh langkah 1 diganti — langkah 2 dan 3 tidak berubah.

## Perbaikan (tanpa restart, tanpa commit — instruksi user)

### `handlers/vidoy.js` — `actionAnimeEpisode` menerima `localPath`

```js
const { ..., silent, localPath } = opts || {};
...
} else if (localPath && fs.existsSync(localPath)) {
  // File sudah diunduh pemanggil (mega streaming, tanpa URL HTTP).
  // Salin ke destPath lalu validasi seperti biasa.
  fs.copyFileSync(localPath, destPath);
  const check = isReusableVideo(destPath);
  if (!check.ok) throw ...;
  // ensureMp4 TIDAK dipanggil — directUrl tidak dibutuhkan
} else {
  // ... jalur normal via ensureMp4(directUrl)
}
```

### `bot.js` — `sam_go` cabang mega

```js
let megaLocal = null;
if (server === 'mega') {
  const mf = await resolveMegaFile(fileUrlG);
  megaLocal = path.join(os.tmpdir(), `mega-${Date.now()}-ep....mp4`);
  await downloadMegaFile(mf.file, megaLocal, () => {});
}
const direct = megaLocal ? { url: fileUrlG } : await resolveDirectUrl(fileUrlG);
...
res = await actionAnimeEpisode(chatId, { ..., directUrl: direct.url, localPath: megaLocal, ... });
...
finally { if (megaLocal) fs.unlinkSync(megaLocal); }
```

Import ditambah: `downloadMegaFile` (ke destructure mega yang sudah ada) dan
`os` (stdlib).

`directUrl: fileUrlG` tetap diteruskan untuk logging (`hostOf`) — tidak dipakai
untuk download karena `localPath` membuat `ensureMp4` dilewati. Non-mega tidak
tersentuh (`megaLocal` null → jalur lama persis).

### Insiden saat implementasi: `oldString` terpotong

`oldString` untuk blok sam_go berakhir di tengah baris (`message_id: msgId`
tanpa penutup) → baris `if (!direct)` kehilangan ekornya →
`SyntaxError: Unexpected token 'const'`. Diperbaiki dengan melengkapi ekor
baris dari `git diff`. Pelajaran: untuk edit multi-baris, verifikasi
`node --check` SEGERA setelah tiap edit, dan jangan pakai `oldString` yang
berakhir di tengah statement.

## Test: `scraper/tests/test-mega-vidoy-local.js` (baru, 9 pass)

Membaca kode asli + menjalankan cabang asli dengan stub:

- `localPath` di-destructure; cabang menyalin + validasi tanpa `ensureMp4`
- file valid → copy, tanpa ensureMp4; file rusak → throw, tanpa ensureMp4
- sam_go mega → `downloadMegaFile` + `localPath: megaLocal` + `finally unlink`
- mega gagal → pesan "Gagal unduh Mega" (tidak hang)
- non-mega → `resolveDirectUrl` tetap dipakai
- import `downloadMegaFile` + `os` ada

### Mutasi wajib

| Yang dicabut | Hasil |
|---|---|
| cabang `localPath` di vidoy.js | 6 pass / **3 fail** |
| `localPath: megaLocal` tidak dioper | 8 pass / **1 fail** |
| download ke `/dev/null` (bukan megaLocal) | **FAIL** |

### Kesalahan test yang diperbaiki

Test 3e awal memakai regex yang hanya menangkap sesudah `require(`,
padahal nama import ada **sebelumnya** (`const { … } = require(…)`).
Selalu FAIL walau import benar. Diperbaiki dengan menangkap grup destructure.

## Suite

```
TOTAL 522 pass / 3 fail
test-mega-vidoy-local    9 pass / 0 fail   (baru)
```

Tiga FAIL semuanya di `test-kamenime-batch.js` (5, 6, 11) — **test merah milik
user** untuk koreksi #3 (library di `actionAnimeEpisode`) yang memang belum
diimplementasikan. Test itu menuntut `upsertMedia`/`savePartFileId`/
`animeProvider === 'hokireceh'` di dalam `actionAnimeEpisode`, yang diverifikasi
nol kemunculannya. Diff saya ke `vidoy.js` menyebut library 0 kali — jadi
bukan regresi, melainkan TDD yang belum hijau.

## Tidak dilakukan (instruksi user)

- **Restart**: bot sedang dipakai user untuk tes. Perubahan belum aktif.
- **Commit**: menunggu verifikasi manual + urutan deploy user.
