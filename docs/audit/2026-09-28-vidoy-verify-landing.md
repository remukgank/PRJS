# 2026-09-28 — Verifikasi pasca-upload Vidoy (tutup kelas phantom-record)

Proposal: `docs/proposals/2026-09-27-bersihkan-91-record-hilang.md` (bagian verifikasi)

## Masalah

99 record `vidoy_uploads` (91 + 8) menunjuk file yang tidak pernah mendarat di
Vidoy. Server membalas sukses + filecode, DB langsung ditulis — tanpa pernah
memastikan file benar-benar ada di folder. Record phantom memblokir upload
ulang via dedup `link+part`, dan tidak ketahuan sampai dihitung manual.

## Perbaikan (1 file: `scraper/services/vidoyService.js`, `uploadSingle`)

Setelah `uploadFile` ok dan sebelum `saveVidoyUpload`:

```js
if (up.filecode && up.folderId && up.folderId !== '0' && Vidoy.folderFileIndex) {
  try {
    const idx = await Vidoy.folderFileIndex(up.folderId, { force: true });
    if (!idx.byId.has(String(up.filecode))) {
      return { ok: false, error: 'file tidak mendarat di folder Vidoy (teregistrasi tapi hilang)' };
    }
  } catch (e) {
    // Fail-open: verifikasi gagal (network) bukan bukti file hilang.
  }
}
```

- `force: true` — tanpa cache basi. Cache baru saja di-invalidate, jadi selalu refetch.
- Fail-open saat verifikasi error: lebih baik record ditulis daripada upload sukses tapi tidak tercatat (itu membuat duplikat).
- Root (`'0'`) dan tanpa filecode dilewati — tidak ada yang diverifikasi di sana.

## Test: `scraper/tests/test-vidoy-verify-landing.js` (baru, 7 pass)

Ekstrak blok verifikasi asli, jalankan dengan stub:

- file mendarat → lolos
- file tidak mendarat → `ok:false`, DB tidak ditulis
- verifikasi throw → fail-open, lolos
- folder `'0'` / tanpa filecode → dilewati
- `force:true` dikunci; urutan save-setelah-verifikasi dikunci

### Mutasi wajib

| Yang dicabut | Hasil |
|---|---|
| seluruh blok verifikasi | 0 pass / **7 fail** |
| fail-closed (blokir saat verifikasi error) | 6 pass / **1 fail** |

### Dua cacat harness yang diperbaiki

1. Assertion `saved` untuk kasus lolos — `saveVidoyUpload` ada di LUAR blok
   ekstrak, jadi selalu null. Diganti assertion lolos-vs-return; urutan save
   dikunci test penjaga terpisah.
2. Ekstraksi saat load — mutasi membuat crash tanpa FAIL. Dibuat lazy per-test
   (pola yang sama seperti `test-animeep-parser.js`).

## Test existing yang perlu disesuaikan

`tests/test-vidoy-listing.js` ("file BELUM ada di listing -> upload normal")
gagal — stub `folderFileIndex`-nya selalu return listing kosong, padahal kode
baru memanggilnya DUA kali (pra-upload tanpa force, pasca-upload dengan force).
Di produksi, panggilan kedua refetch dan melihat file yang baru mendarat.

Diperbaiki minimal dengan stub yang membedakan via argumen `force`: tanpa force
→ kosong (maksud asli test terjaga: lanjut upload); dengan force → berisi file
(mensimulasikan realita pasca-upload). Maksud test tidak berubah, hanya stub
yang kini akurat. Hasil: 20 pass, 0 fail.

## Suite

```
TOTAL 529 pass / 3 fail
test-vidoy-verify-landing   7 pass / 0 fail   (baru)
test-vidoy-listing         20 pass / 0 fail
```

Tiga FAIL hanya di `test-kamenime-batch.js` (5, 6, 11) — test merah user untuk
koreksi #3 yang belum diimplementasikan. Diff ini menyebut library 0 kali.

Dicualikan (butuh network/aria2c): `test-rich.js`, `test-rich-direct.js`,
`test-all-subdomains.js`, `test-watchdog-aria2c.js`.
