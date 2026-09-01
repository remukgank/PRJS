# 2026-08-12: Insiden secret .9router/ ter-commit ke repo public

**Date**: 2026-08-12
**Author**: opencode

## Kronologi

- Commit `d41d630` (Replit Agent) meng-commit file rahasia `.9router/` ke repo
  **public** `remukgank/PRJS`: `auth/cli-secret`, `jwt-secret`, `machine-id`,
  `db/data.sqlite` (+ wal/shm), `runtime/mitm/server.js`, `runtime/package.json`.
- `.9router/` tidak ada di `.gitignore`, jadi ikut ke-repo.
- `git pull` di workspace gagal: file untracked lokal `.9router/` akan
  ter-overwrite oleh merge.

## Root Cause

1. `.9router/` tidak ter-ignore → runtime lokal (yang dipakai server) mudah
   ter-commit tidak sengaja oleh agent/alat lain.
2. Repo berstatus public → secret yang ter-commit langsung ter-ekspose.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `.gitignore` | Tambah `.9router/` |
| `.9router/**` | Dihapus dari tracking git (`git rm -r --cached`) — file tetap ada di disk, direstore dari backup `/tmp/opencode/9router-backup-1786513394` |

Commit hasil: `4f361df`.

## Detail Teknis

- Backup lokal `.9router/` di-copy ke `/tmp/opencode/9router-backup-1786513394`
  sebelum pull; versi asli runtime (secret berbeda dari yang ter-commit — yang
  ter-commit milik instance Replit Agent) direstore setelah merge.
- Secret dihapus dari HEAD, tapi **tetap ada di history git** (commit `d41d630`).
- Repo ini public → secret sudah ter-ekspose permanent.

## Keputusan

- **Tidak rewrite history** (filter-repo + force push): paparan sudah terjadi
  dan ada remote lain (`gitsafe-backup`); rewrite tidak menghapus eksposur.
- **Tidak kembalikan subset runtime** (`server.js`/`package.json`) ke repo:
  ignore penuh lebih aman agar secret tidak ikut lagi; runtime tetap jalan dari
  file lokal yang sudah di-ignore.
- **Wajib rotate secret** di instance yang secret-nya bocor (instance Replit
  Agent yang membuat commit `d41d630`): `auth/cli-secret`, `jwt-secret`,
  `machine-id`.

## Verification

- `git pull` sukses (`c5002d6..31803da`), working tree bersih.
- `node --check scraper/bot.js` — OK, fix `cleanCaption` tetap utuh setelah merge.
- `git status` bersih setelah commit `4f361df` + push.
