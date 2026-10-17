# Insiden — String koneksi Neon terekspos di repo publik PRJS

**Date**: 2026-10-17
**Author**: opencode
**Status**: File dikeluarkan dari `main` (Tahap A ✅) · rotasi Neon = **WAJIB oleh owner** · purge riwayat = menunggu persetujuan

## Root Cause

1. 11 Okt 2026 sync `fomo-drama/` menghasilkan backup `fomo-drama.bak-20261011/`
   di dalam workspace PRJS.
2. 17 Okt 2026 04:23 UTC commit `a69d94c8455…` ("Update start script and add new
   agent skill documentation", author **Replit Agent**) memakai `git add -A` →
   **157 file backup ikut ter-commit** ke repo PRJS yang bersifat **public**
   (`GET api.github.com/repos/remukgank/PRJS` → `"private": false`).
3. Salah satu file —
   `fomo-drama.bak-20261011/.agents/skills/audit-workflow/SKILL.md` — memuat
   **string koneksi Neon lengkap** (user `neondb_owner`, password di dalamnya)
   untuk dua endpoint. Alert Neon (org `org-rough-bar-15886090`, project
   `proud-bird-56349576`, endpoint `ep-withered-butterfly-az83tr06`) mengonfirmasi
   paparan.

## Kredensial yang terekspos

| Endpoint | Dimuat di |
|---|---|
| `ep-withered-butterfly-az83tr06-pooler` | SKILL.md (2×) |
| `ep-lucky-shape-azp5k3qp-pooler` | SKILL.md (2×) |

Scan menyeluruh repo (HEAD + backup):
- **tidak ada** token bot Telegram, PAT GitHub, atau API key Vidara di file backup
  (`README.md` & `.env.example` hanya placeholder `user:password@host:5432/dbname`)
- tidak ada `.env`/secret PRJS yang pernah ter-commit
- **bot PRJS tidak memakai Neon** — `DATABASE_URL` bot = host `helium`; jadi
  rotasi Neon tidak impacting bot ini

## Scope Perubahan

| File | Perubahan |
|---|---|
| `fomo-drama.bak-20261011/**` (157 file) | `git rm -r --cached` → tidak lagi ter-track di `main` (folder juga sudah hilang dari working tree; clone utuh tetap di `./fomo-drama`, untracked) |

## Verification

- `git ls-tree -r origin/main | grep -c '^fomo-drama.bak'` → **0**
- Sisa jejak: commit `a69d94c8455…` di riwayat + branch `gitsafe-backup/main`
  → butuh purge (`git filter-repo --path fomo-drama.bak-20261011 --invert-paths`
  + force-push semua ref & tag) — menunggu persetujuan owner (force-push ke repo
  publik mengubah seluruh SHA).

## Tindakan owner (WAJIB)

1. Neon Console → reset password untuk **kedua endpoint** di atas.
2. Update connection string di semua konsumennya (layanan/fomo-drama — bukan bot
   PRJS).
3. Password lama dianggap bocor: repo publik sejak 04:23 UTC, rotation adalah
   satu-satunya fix yang menutup risiko; purge history hanya mengurangi jejak
   (crawler/cache bisa sudah menyalin).