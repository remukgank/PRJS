# Audit Workflow

## Aturan Main

1. **Proposal fix dulu** (root cause + rencana + scope file jelas) → tunggu user approve
2. **Implement HANYA sesuai proposal yang disetujui** (jangan sekalian benerin hal lain di luar scope) → `node --check`
3. **Tunggu tes manual user di Replit/server** → tunggu perintah lanjut
4. **Setelah user mengonfirmasi OK** → commit + push
5. **Update docs/audit/** — bikin log fix sesuai format yang ada

## Prinsip Penting

- **Kode yang diedit dan yang dites di server adalah SAMA.** Jangan pernah berasumsi kode berbeda. Kalau bug "masih muncul", kemungkinan paling masuk akal = bot belum di-restart. Wajib trace/cek dulu sebelum simpulkan apapun.
- **Jangan berspekulasi soal "instance/server lain" sebelum verifikasi.** Cek dulu bukti yang ada: `/proc/<pid>/cwd`, folder kerja, docker logs, timestamp file — baru simpulkan. (Kasus 31 Jul: batch log dikira dari server user padahal dari Replit sendiri — cwd dan docker logs udah nunjukin dari awal.)
- **Tugas gue (opencode) = PRJS saja.** Repo fomo-drama / cs-hokireceh itu milik user — jangan sentuh/edit/commit tanpa perintah eksplisit. Proposal boleh dibikin di docs/audit PRJS, tapi implementasi + commit = user. (Kasus 3 Aug: gue edit sync-check.js fomo-drama tanpa izin scope.)
- **Kalau nemu isu lain di luar scope saat implementasi → laporkan dulu, jangan langsung fix.**
- **Gunakan Bahasa Indonesia** untuk semua komunikasi.

## Format Audit Log

File: `docs/audit/YYYY-MM-DD-judul-singkat.md`

```markdown
# Judul Fix

**Date**: YYYY-MM-DD
**Author**: opencode

## Root Cause

Penjelasan singkat kenapa bug terjadi.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `path/file.js` | deskripsi perubahan |

## Detail Teknis

Penjelasan teknis implementasi.

## Verification

- node --check lulus
- hasil test manual
```

## Catatan

- Link gofile/pixeldrain dari non-admin via tombol → `downloadAndSendPaidMedia` (ada quota check)
- Link gofile/pixeldrain dari text langsung → `handleGofileUrl`/`handlePixeldrainUrl` (TANPA quota check untuk non-admin)
- File ID cache di PostgreSQL tabel `file_cache`, key = MD5 hash URL
- `sendPaidMediaVideo` pake `apiPost('sendPaidMedia', ...)` langsung (support LOCAL API & cloud API)
