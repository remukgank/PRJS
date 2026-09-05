# Backlog — GoFile Share Multi-File Tanpa Pilihan Kualitas

**Date**: 2026-09-03
**Author**: opencode
**Status**: Backlog — belum dikerjakan, bukan bagian Batch E
**Item**: 1 — GoFile multi-file quality picker (parkir, belum diputusin)

## Temuan

Share GoFile berisi >1 file (contoh: `https://gofile.io/d/t4spBXpP` berisi FHD ~998MB + 720p ~603MB dari judul yang sama) hanya diproses `files[0]` via `resolveGofileFirstFile` (`scraper/gofile.js:236`). File lain diabaikan diam-diam — user tidak diberi tahu ada pilihan kualitas. Urutan `files[0]` tergantung `sortField=name` API GoFile dan bisa berubah.

Bukan bug/crash, bukan data salah — gap UX. Opsi solusi (belum disetujui): tampilkan daftar file untuk dipilih sebelum download, mirip pola keyboard server yang sudah ada.
