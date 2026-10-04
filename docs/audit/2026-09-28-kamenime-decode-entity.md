# Fix Decode HTML Entity di src kamenime (judul berisi karakter khusus)

**Date**: 2026-09-28
**Author**: Hermes (trace + implementasi, atas persetujuan Ochi)

## Root Cause

`decodeHtmlEntities()` di `scraper/providers/kamenime.js` hanya mengenali
entity numeric **2 digit**:

```js
.replace(/&#39;/g, "'")     // hanya &#39;
```

Kamenime menulis entity **3 digit** `&#039;` untuk apostrof. Pola itu tidak
kena, sehingga `&#039;` lolos mentah ke URL dan dua hal rusak sekaligus:

1. **Server balas 404.** `&` di URL diperlakukan sebagai awal query string,
   jadi path yang diminta jadi tidak valid.
2. **`fileNameFromUrl` memotong nama file di tengah** → `A Gatherer&`
   (bukan `A Gatherer's Adventure in Isekai-episode-1.mp4`).

Dugaan awal saya salah: saya mengira `resolveKamenimeFile` tidak memanggil
decode sama sekali. Trace kedua membetulkan — `absolutize()` **sudah**
memanggil `decodeHtmlEntities`; yang salah adalah isi fungsi itu sendiri.

## Gejala di produksi

```
20:12:36  https://www.kamenime.com/anime/a-gatherers-adventure-in-isekai
20:12:43  ERROR download HTTP 404
            url: .../anime/a-gatherers-adventure-in-isekai/episode/1
20:13:02  kam_all batch selesai · ok=0 fail=12 skip=0
```

**Berhasil 0 / Gagal 12** — bukan throttle, bukan rate limit. Satu format
URL yang salah dipakai untuk 12 episode sekaligus.

## Why 12 episode sekaligus gagal

Satu string yang sama salah decode untuk semua episode, jadi semua URL
error. Tidak ada hubungannya dengan kondisi server/konen.

## Bukti (eksekusi nyata, bukan baca kode)

**src yang benar-benar dikirim kamenime** (`curl` langsung ke halamannya):

```
<source src="/storage/anime/A Gatherer&#039;s Adventure in Isekai/A Gatherer&#039;s Adventure in Isekai-episode-1.mp4"
<source src="/storage/anime/ONE PIECE/ONE PIECE-episode-1.mp4"     ← kontrol, judul polos
```

**Sebelum fix:**
```
fileUrl : .../A%20Gatherer&#039;s%20Adventure%20in%20Isekai/...
fileName: "A Gatherer&"
```

**Setelah fix:**
```
fileUrl : .../A%20Gatherer's%20Adventure%20in%20Isekai/...
fileName: "A Gatherer's Adventure in Isekai-episode-1.mp4"
```

**Verifikasi server (tidak boleh berhenti di "seharusnya bisa")**:

```
HTTP 404   6.603 byte      →  URL mentah (kode lama)
HTTP 200   108.733.977 byte →  URL setelah decode (perbaikan)
```

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/providers/kamenime.js` | Tambah `decodeNumericEntity()` (desimal + heksa, dengan batas validitas BMP); `decodeHtmlEntities()` memanggilnya; alias `&#0*39;` dipertahankan |
| `.tests/test-kamenime-entity-decode.js` | Test baru (14 assert), memakai fungsi produksi nyata + mode `--online` |

Tidak ada perubahan di `bot.js`, `handlers/`, `services/`, atau kontrak media (§5).

## Detail Teknis

```js
function decodeNumericEntity(s) {
  return String(s).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_m, num) => {
    const cp = num[0].toLowerCase() === 'x' ? parseInt(num.slice(1), 16) : parseInt(num, 10);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return _m;  // di luar BMP -> biarkan
    try { return String.fromCodePoint(cp); } catch { return _m; }
  });
}
```

Pola umum ini menutup sekalian:

- `&#039;` — bug yang dilaporkan (3 digit)
- `&#39;` — bentuk lama (masih jalan, tidak regresi)
- `&#x27;` — heksadesimal, dipakai sebagian template
- `&#8217;` — apostrof tipografis (U+2019), **tidak tertangani sebelum fix ini**
  dan akan menggagalkan serial berikutnya yang memakainya

Batas validitas (`cp > 0x10ffff`) mencegah `String.fromCodePoint` melempar
`RangeError` pada input rusak — input aneh dibiarkan utuh, tidak crash.

Kontrol regresi: `ONE PIECE/ONE PIECE-episode-1.mp4` **tidak berubah** — judul
polos aman sejak awal, itu sebabnya bug ini bertahan lama tanpa terdeteksi.

## Verification

**node --check**
```
scraper/providers/kamenime.js              CLEAN
.tests/test-kamenime-entity-decode.js      CLEAN
```

**Test** — `.tests/test-kamenime-entity-decode.js`
```
offline : 12 pass / 0 fail
online  : 14 pass / 0 fail   (jalur produksi penuh, 1 request HTTP nyata)
```

**Mutasi — 5/5 TERTANGKAP, 0 test buta**

| # | Mutasi | Hasil |
|---|--------|-------|
| M1 | pola lama `&#39;` 2 digit (bug asli) | TANGKAP (5 test gagal) |
| M2 | `decodeNumericEntity` tidak dipanggil | TANGKAP (2 test gagal) |
| M3 | regex dibatasi 1-2 digit | TANGKAP (3 test gagal) |
| M4 | `fileNameFromUrl` tanpa `decodeURIComponent` | TANGKAP (2 test gagal) |
| M5 | `absolutize` tanpa decode | TANGKAP (2 test gagal) |

M4 sempat LOLOS di run pertama — test belum mengukur `fileNameFromUrl` secara
langsung. Test baru ditambahkan (bukan_accept "test sudah cukup"), M4 kini
tertangkap. Skrip mutasi punya guard `cmp` terhadap backup: kalau mutasi tidak
mengubah file, script berhenti, bukan melaporkan angka palsu.

**Regresi lintas test**
```
102 pass / 1 fail
```
`test-kamenime-batch` 1 fail = **pre-existing**, sudah gagal 10/1 juga pada
versi HEAD tanpa perubahan ini. `test-rich` / `test-rich-direct` bukan unit
test — skrip manual yang butuh `TELEGRAM_CHAT_ID` / `TELEGRAM_BOT_TOKEN`.

## Catatan di luar scope (ditemukan saat trace, TIDAK diperbaiki)

`parseSamehadakuEpisode` (`providers/samehadaku.js:38`) hanya mengenali pola
`/anime/<slug>-episode-N/`. URL `/anime/<slug>/episode-N` menghasilkan
`null` → pemanggil jatuh ke `ep = 1`. Perlu dicek apakah format URL itu
pernah dipakai sebelum Oceanic di sini.

`link_alive` = `null` untuk seluruh record `vidoy_uploads`. Commit `6a11e60`
sudah menutup phantom-record going forward (verifikasi pasca-upload), tapi
record lama belum pernah dicek — `link_checked_at` masih kosong semua.

## Skenario Functional Test (setelah bot restart, oleh owner)

1. Kirim `https://www.kamenime.com/anime/a-gatherers-adventure-in-isekai`
2. Picker harus muncul normal, 12 episode
3. Pilih 1 episode → **harus Sukses**, bukan "download HTTP 404"
4. Nama file/folder di Vidoy harus `A Gatherer's Adventure in Isekai-episode-N`
   (bukan `A Gatherer&`)
5. Kontrol: `https://www.kamenime.com/anime/one-piece/episode/1` tetap normal

Tag: `v3.3.5` (patch — memperbaiki perilaku salah, tidak ada kontrak berubah).