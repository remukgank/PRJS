# 2026-10-01 — Fail-fast batas harian Vidara (stop buang 1,7 GB)

Proposal: bagian "plus" dari `docs/proposals/2026-10-01-vidara-vidoy-dual-host.md`
(fix pasca-deploy `v3.4.0`)

## Masalah

Log produksi 17:09–17:18 UTC: batch `kam_all` target `vt` (Vidara + TG) mengunduh
episode 130–153 satu per satu, semuanya gagal di menit yang sama karena akun
Vidara sudah menyentuh **200 file/hari**:

```
ERROR Anime episode upload gagal ! Vidara upload: filecode kosong —
 {"error":"Daily upload limit reached — this account can upload 200 files
  per day and has used 200. The limit resets at 00:00 UTC."}  · ep=130 target=vt
```

24 episode × ~70 MB ≈ **1,7 GB bandwidth terbuang**, dan `break` fail-fast yang
sudah terpasang di `kam_all`/`sam_all`/`kur_all` **tidak pernah jalan**.

Root cause: `isQuotaExceededError` (`lib/quota.js`) hanya mengenali pola kuota
storage bulanan Vidoy (`quota_exceeded`, `storage limit`, …). Pesan batas harian
Vidara tidak cocok satupun → `isQuotaExceededError(err.message)` selalu `false`.

Efek kedua (baru ketahuan setelah pola ditambahkan): ketiga loop menulis pesan
`Batch dihentikan — Vidoy penuh.` + `quotaResetDate()` untuk **semua** jenis
kegagalan. Untuk kasus Vidara: host yang disalahkan salah, dan tanggal resetnya
kosong — padahal yang dicari user adalah 00:00 UTC, bukan 1 Nov.

## Perbaikan (3 file)

### `scraper/lib/quota.js`

- Konstanta `VIDARA_DAILY_RE = /daily upload limit|upload limit reached|files per day/i`
  → masuk `isQuotaExceededError` **dan** jadi fungsi terpisah
  `vidaraDailyLimitError()` (pemanggil perlu membedakan host, bukan cuma
  "berhenti").
- **Pola sengaja spesifik.** Pola bebas `limit reached` juga cocok dengan
  `"Rate limit reached, retry in 30s"` (429 sementara) → batch berhenti untuk
  error yang hilang dalam hitungan detik. Pola itu sempat ada di regex dan baru
  ketahuan saat mutation test `M6`.
- `quotaResetDate()` menangani dua bentuk: `reset_at` bulanan (Vidoy) **dan**
  `"resets at 00:00 UTC"` harian (Vidara) → `nextUtcMidnightMs()`.
- `quotaStopInfo(msg)` → `{ host, headline, detail, reset }` supaya pesan
  berhenti menunjuk host yang benar.

### `scraper/bot.js`

Ketiga loop (`kam_all:3826`, `sam_all:4091`, `kur_all:4637`) memakai
`quotaStopInfo` — headline `Limit harian Vidara penuh` / `Vidoy penuh`, detail
`Vidara mengizinkan 200 file/hari` / `Kuota Vidoy habis`, reset ikut benar.
Log juga membawa `host: stop.host`.

### `scraper/handlers/vidoy.js`

Vidara **tidak punya** endpoint kuota (semua 404, lihat proposal §2) → tidak
ada yang bisa dicek dari API. Satu-satunya cara: mencatat sendiri saat limit
kena.

- **Set saat kena**: di catch `Anime episode upload gagal`, kalau
  `vidaraDailyLimitError(err.message)` → `setSetting('vidara_limit_reset_at', nextUtcMidnightMs())`.
- **Cek sebelum download**: pre-check di awal `actionAnimeEpisode` (sebelum
  lock, sebelum `p.update('⬇️ download')`) membaca flag; masih berlaku →
  kembalikan error + tanggal reset, **tanpa mengunduh apa pun**.
- Tanpa flag ini, batch berikutnya tetap mengorbankan satu episode penuh sebelum
  gagal — itu masalah yang sama persis dengan yang diperbaiki.

## Test: `scraper/tests/test-batch-quota.js` (19 pass / 0 fail, +4 tes baru)

- Pesan limit harian **asli** dari log (1 Okt) terdeteksi; kasus negatif
  `Rate limit reached, retry in 30s` / `Too many requests` wajib tetap `false`.
- `quotaStopInfo` → `host: vidara`, headline benar, reset = 00:00 UTC berikutnya;
  payload Vidoy tetap `host: vidoy` + `reset 2026-10-01`.
- `bot.js`: 3× `quotaStopInfo`, tidak ada lagi headline/detail hardcode.
- `handlers/vidoy.js`: flag dicatat `vidaraDailyLimitError` (bukan deteksi umum)
  dan dicek **sebelum** anchor `p.update('⬇️ download')`.

Dua test lama diubah: ekstraksi `new Function(grabFn(...))` diganti
`require(QUOTA)` — sejak `VIDARA_DAILY_RE` masuk, ekstraksi satu-fungsi gagal
`VIDARA_DAILY_RE is not defined` dan tidak menguji apa pun.

**Mutation test — 6 mutasi, semuanya terdeteksi:** pola daily dihapus (M1),
headline kembali hardcode (M2), flag dicek setelah unduhan (M3), `setSetting`
dihapus (M4), `quotaResetDate` tidak menangani harian (M5), pola dilemahkan
jadi `/limit reached/i` (M6).

Catatan proses: M3 awalnya **tidak** terdeteksi — bukan karena test lemah,
tapi karena script mutasinya memakai anchor `const busyKey` yang ada di
fungsi lain, sehingga slice-nya berantakan dan file tidak benar-benar berubah.
Diulang dengan anchor dibatasi `actionAnimeEpisode` + verifikasi posisi
(`check=20442 > download=20366`) → 18/1 fail.

## Verifikasi

- `node --check` 4 file yang berubah → lolos.
- Suite penuh: **936 pass / 0 fail** (naik 4 dari test baru).
- Deploy: `kill 204` (tidak ada auto-restart infra) → `pm2 start scraper/bot.js
  --name prjs-bot --cwd /home/runner/workspace --max-memory-restart 700M` +
  `pm2 save`. Syarat §3 terpenuhi: download terakhir 79 menit sebelumnya,
  tidak menyentuh instance Replit.
- Verifikasi: `Bot running` + `Polling started` 18:38:06, **1** proses
  `bot.js` (pid 9290), pm2 `online`, 0 restart.

## Sisa yang belum diverifikasi di produksi

Belum ada batch `vt` yang kena limit harian SETELAH fix ini — klaim bahwa batch
berhenti setelah 1 percobaan (bukan 24) baru benar kalau diuji saat limit
benar-benar penuh lagi (reset 00:00 UTC).
