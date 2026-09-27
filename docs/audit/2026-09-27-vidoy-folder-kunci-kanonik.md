# 2026-09-27 — Folder Vidoy dibuat dua kali karena beda ejaan judul

## Gejala

Dua folder Vidoy dengan nama yang nyaris sama untuk **anime yang sama**:

```
Re:Zero kara Hajimeru Isekai Seikatsu     23 file
Re-Zero kara Hajimeru Isekai Seikatsu      2 file  (hanya Ep 7 & 16)
```

Di dashboard keduanya terbaca "nama sama" — memang hanya beda satu karakter.

## Bukti (log + DB, bukan asumsi)

```
13:49:43 – 14:12:53   23 episode → folder myci7nuu4s1
                      title = "Re:Zero kara Hajimeru Isekai Seikatsu"   (TITIK DUA)
14:35:16              ensureMp4 gagal — retry dengan URL fresh   err="download HTTP 500"
                      → Ep 7 & 16 GAGAL
14:41:13              user kirim https://www.kamenime.com/anime/rezero-kara-hajimeru-…
14:41:28              dl_title_use:2
14:41:33              mulai download ep=7  title="Re-Zero kara Hajimeru Isekai Seikatsu"  (STRIP)
14:41:46              Vidoy upload sukses  folderId=gzovkizv6x7      ← FOLDER BARU
14:44:46              Vidoy upload sukses  folderId=gzovkizv6x7
```

Dari DB, part yang hilang di folder 23-episode **tepat 7 dan 16** — konsisten dengan
episode yang gagal lalu di-retry. **URL-nya sama persis**, yang berbeda hanya judul.

## Akar cause

Nama folder adalah judul mentah, dan pencocokannya tidak menormalkan tanda baca:

```js
// vidoy-uploader.js:420
function animeFolderPath(title) {
  return [ROOT_PARENT_NAME, DB_PARENT_NAME, 'ANIME', title];   // ← title mentah
}

// vidoy-uploader.js:166 (SEBELUM fix)
function findNode(nodes, name, parentId) {
  const key = sanitizeFolderName(name).toLowerCase();            // ← hanya lowercase
  return nodes.find((n) => String(n.name || '').trim().toLowerCase() === key && …);
}
```

Terbukti:

```
sanitizeFolderName("Re:Zero kara Hajimeru Isekai Seikatsu") = "Re:Zero kara Hajimeru Isekai Seikatsu"
sanitizeFolderName("Re-Zero kara Hajimeru Isekai Seikatsu") = "Re-Zero kara Hajimeru Isekai Seikatsu"
kunci sama? false
```

Kunci berbeda → `findNode` null → `createFolderVerified` membuat folder baru.
`ensureFolder` sendiri tidak salah: dia memakai nama yang diberi, sesuai kontrak.

## Perbaikan (1 file: `scraper/vidoy-uploader.js`)

Helper baru `folderKey()` yang menormalkan kunci pencocokan:

```js
function folderKey(name) {
  return sanitizeFolderName(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
```

`findNode` memakai `folderKey(n.name) === folderKey(name)`.

**Yang dinormalkan HANYA cara mencari, bukan nama yang dibuat.** Folder yang sudah
terlanjur ada tetap bernama `Re:Zero kara Hajimeru Isekai Seikatsu` — tidak ada
rename, tidak ada migrasi, tidak ada data yang diubah.

Hasil kunci:

```
Re-Zero kara Hajimeru Isekai Seikatsu     → rezerokarahajimeruisekaiseikatsu
Re:Zero kara Hajimeru Isekai Seikatsu     → rezerokarahajimeruisekaiseikatsu   SAMA
Re:Zero kara Hajimeru Isekai Seikatsu S2  → rezerokarahajimeruisekaiseikatsus2  TERPISAH
```

S2 tetap terpisah karena `s2` masih ikut di kunci — itu memang anime berbeda
(25 episode sendiri, bukan season lanjutan dari 25 episode di bawahnya).

### Opsi yang ditolak

**`source_pattern` sebagai kunci folder.** Lebih stabil, tapi segmen folder
jadi `naruto-kecil` alih-alih `Naruto Kecil` → seluruh folder
yang ada harus di-migrasi. Versi kanonik jauh lebih murah.

**Mengubah `sanitizeFolderName`.** Dipakai juga untuk nama file, dan `:` legal
di sana. Tidak boleh disentuh diam-diam.

## Test: `scraper/tests/test-folder-vidoy-kunci.js` (baru, 12 pass)

Memakai `folderKey` asli dari modul, plus 4 test penjaga wiring di
`vidoy-uploader.js`.

- 1a) `Re-Zero` == `Re:Zero` (kasus bukti)
- 1b) S2 tetap terpisah
- 1c) judul berbeda tidak collide
- 2a) 7 varian pemisah (spasi `-` `_` `.` `:` + huruf besar) → 1 kunci
- 2a2) batas normalisasi: `Black's Torch` ≠ `Black Torch` (apostrof bukan pemisah)
- 2b) 4 judul → 4 kunci unik
- 2c) kunci tidak pernah kosong
- 2d) CJK/latin tidak jadi `""`
- 3a) `findNode` memakai `folderKey(n.name)`, tidak ada `toLowerCase` mentah
- 3b) pola buang karakter menyertakan `a-z0-9`
- 3c) `animeFolderPath` tetap memakai `title` (nama folder tidak diubah)
- 3d) `folderKey` di-export

### Mutasi wajib

| Yang dicabut | Hasil |
|---|---|
| `folderKey(n.name)` → `String(n.name).trim().toLowerCase()` | 11 pass / **1 fail** |
| `replace(/[^a-z0-9]+/g,'')` dihapus dari `folderKey` | 8 pass / **4 fail** |

## Kesalahan saya sendiri di test

Test 2a awalnya menuntut `Black's Torch` dan `Black Torch` collide. Gagal.
Kenyataannya `Black's` → `blackstorch` ≠ `blacktorch`. Dua string itu memang
berbeda, jadi asumsi saya yang salah, bukan kodenya. Dipecah jadi 2a (variasi
pemisah — harus collide) dan 2a2 (kutip — documented, tidak collide).

## Catatan teknis

`vidoy-uploader.js` memuat satu **null byte** di dalam regex
`/[\x00-\x1f\x7f]/g` (strip control char) — itu yang membuat `ripgrep` dan
sejawatnya menganggap file ini binary. Sah, dan **dipertahankan**: seluruh edit
dilakukan binary-safe dan jumlah null byte diverifikasi tetap 1 sebelum/sesudah.

## Suite

```
TOTAL 478 pass / 1 fail
test-folder-vidoy-kunci   12 pass / 0 fail   (baru)
```

Satu-satunya FAIL adalah `test-episode-status.js` — sudah dilaporkan terpisah
sebelum fix ini, tidak terkait: picker `vidoyKeysFromEpisodes` sekarang 3
(samehadaku + kuronime + kamenime) tapi assertion masih `strictEqual(count, 2)`.
Perbaikan butuh proposal terpisah.

Dicualikan (butuh network/aria2c): `test-rich.js`, `test-rich-direct.js`,
`test-all-subdomains.js`, `test-watchdog-aria2c.js`.

## Yang TIDAK dikerjakan di sini

- **Pindah Ep 7 & 16 ke folder `myci7nuu4s1`** — dikerjakan manual di dashboard
  oleh user. API `move` di `vidoy-uploader.js` hanya mendukung
  `move_type=folder`; tidak ada `move_type=file` di seluruh kode.
- **Update `folder_id` di DB** untuk 2 baris tersebut setelah dipindah.
- **`test-episode-status.js`** — assertion usang, item terpisah.
