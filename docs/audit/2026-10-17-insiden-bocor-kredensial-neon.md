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

## Tahap B — purge riwayat (17 Okt 2026, disetujui owner)

Metode resmi `git-filter-repo` di **fresh clone** (`/tmp/opencode/prjs-purge`),
bukan `--force` di repo kerja:

```bash
git clone https://github.com/remukgank/PRJS.git prjs-purge
uvx --from git-filter-repo git-filter-repo \
  --path fomo-drama.bak-20261011 --invert-paths
git remote add origin https://github.com/remukgank/PRJS.git   # filter-repo menghapus origin
git push --force origin main && git push --force origin --tags
```

Hasil:
- 296 commit diparse; commit `a69d94c8455…` (satu-satunya yang memuat 157 file
  backup) hilang → `HEAD` 294 commit
- `git log --all -- fomo-drama.bak-20261011` → kosong di clone & remote
- `git ls-remote origin | grep -c a69d94c` → **0** (tidak ada ref menuju commit lama)
- Backup refs lokal: `/tmp/opencode/prjs-backup/pre-purge-20261017-0614.bundle` (2,2 MB)
- **Perubahan SHA (konsekuensi force-push)**: `main` `496de8f…` → `1119303…`,
  tag `v3.8.1` `fdc120d…` → `7f0f956…`. Tag yang lahir **sebelum** 17 Okt 04:23
  tetap sama (`v3.6.10`, `v3.6.11`, `v3.7.0`, `v3.7.1`, `v3.8.0`) karena tidak
 iku rewrite.
- Branch `gitsafe-backup/main` ternyata **tidak ada** di remote (hanya ref lokal
  stale) → tidak ada yang perlu di-push untuk branch itu.
- Repo kerja disinkronkan: `git fetch origin && git reset --hard origin/main`
  (untracked seperti `./fomo-drama`, `logs/` tidak tersentuh).

## Tindakan owner (WAJIB)

1. Neon Console → **hapus project / endpoint** tersebut bila memang tidak dipakai
   (dikonfirmasi: bot PRJS memakai host `helium`, bukan Neon; 0 koneksi lokal ke
   `:5432`). Bila ternyata masih ada konsumen, **reset password** kedua endpoint.
2. Kredensial lama tetap dianggap bocor: repo publik sejak 04:23 UTC — penghapusan
   project/rotasi adalah penutup risiko; purge history (Tahap B) hanya mengurangi
   jejak (crawler/cache bisa sudah menyalin sebelum ini).