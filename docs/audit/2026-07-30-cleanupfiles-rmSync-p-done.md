# Fix: cleanupFiles → fs.rmSync + tambah p.done di alur episode

**Date**: 2026-07-30
**Author**: opencode

## Root Cause

1. **Bug #1 — `cleanupFiles(outDir)`**: Fungsi `cleanupFiles` tidak robust untuk path rekursif/directory tree — rentan error partial delete. Di `handleUcDriveUrl`, `outDir` adalah direktori yang harus dihapus beserta isinya; `fs.rmSync` dengan `{ recursive: true, force: true }` lebih tepat.

2. **Bug #2 — `p.done()` tidak dipanggil**: Di handler episode listing, setelah sukses mengirim invoice ke non-admin, progress indicator `p.done()` tidak pernah dipanggil. Akibatnya user tidak mendapat konfirmasi ✅ bahwa proses selesai.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `bot.js` | Baris 1151: ganti `cleanupFiles(outDir)` → `fs.rmSync(outDir, { recursive: true, force: true })` |
| `bot.js` | Baris 2133: tambah `await p.done('Daftar episode siap')` |
| `scraper/bot.js` | Sama seperti di atas (sync dari sesi sebelumnya) |

## Detail Teknis

**Bug #1:**
```js
// Sebelum
if (outDir) cleanupFiles(outDir);

// Sesudah
if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
```
`fs.rmSync` menghapus direktori beserta seluruh isinya secara synchronous — tidak bergantung pada implementasi `cleanupFiles` yang bisa gagal di path rekursif.

**Bug #2:**
```js
// Sesudah (ditambahkan sebelum } catch)
await p.done('Daftar episode siap');
```
`p.done()` adalah method dari progress helper yang menampilkan ✅ + teks + timestamp. Dipanggil setelah invoice sukses dikirim atau keyboard aksi ditampilkan.

## Verification

- `node --check bot.js` lulus (tidak ada syntax error)
