# 2026-08-04: Rotasi session FlareSolverr + retry episode gagal saat timeout beruntun

## Konteks
Batch jalan (per_ep, drama "Kita Bukan Kebetulan" netshort id
`1999794550705356801`, 80 eps) berhenti produktif di ep 61+. Mulai ep 61
FlareSolverr kena `Error solving the challenge. Timeout after 60.0 seconds`
beruntun (ep 61, 62, 63, 64, 77). Tiap timeout: `interceptVideoUrl` retry 1x
penuh 60s (dramafren.js:103) → ~120s+ per ep hangus, lalu episode di-mark
`fail` permanen di batch → drama jadi gap.

Pola "60 ep sukses → timeout semua" = session FlareSolverr basi/kena
rate-limit setelah dipakai banyak request. Session tidak pernah dirotasi
selama satu drama.

## Root Cause
1. `getVideoUrl` (index.js:92) tidak meneruskan flag `timeout` dari
   `interceptVideoUrl` ke pemanggil → batch tidak tahu beda "timeout" vs
   "videoUrl kosong".
2. Batch per_ep (batch-download.js) pakai 1 session untuk semua ep tanpa
   rotasi. Saat session basi, semua ep berikutnya timeout dan di-mark `fail`
   tanpa ada kesempatan retry.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/index.js` | `getVideoUrl` menyimpan `result.timeout = true` saat `interceptVideoUrl` kena timeout (server lain di-skip tetap) |
| `scraper/batch-download.js` | Per-ep loop: hitung `consecutiveTimeouts`; ≥2 timeout beruntun → `destroySession` + `createSession` baru (rotate). Episode yang gagal resolve di kumpulkan ke `resolveFailed` dan di-retry 1x di akhir drama dengan session baru. |

## Detail Teknis

### index.js — propagate timeout
```js
if (r.timeout) {
  result.timeout = true;
  break;
}
```
Pemanggil batch bisa cek `result.timeout` untuk membedakan gagal karena
challenge timeout (bisa pulih dengan session baru) vs gagal lain.

### batch-download.js — rotasi + retry
- `consecutiveTimeouts` di-reset ke 0 setiap resolve sukses.
- Saat `consecutiveTimeouts >= 2` → rotasi session (destroy, sleep 2s,
  create baru), counter reset. Jumlah 2 dipilih biar tidak over-react ke
  timeout sesekali, tapi responsif ke pola beruntun.
- Episode yang gagal resolve karena timeout masuk `resolveFailed` (ep, urlEp,
  outPath, label). Di akhir loop semua drama: retry 1x pakai session (yang
  sudah dirotasi). Sukses → `done++` & `fail--`, upload seperti biasa.
- Ep yang sudah pernah diupload (DB) tetap di-skip di retry.

## Verification
- `node --check scraper/batch-download.js` — OK
- `node --check scraper/index.js` — OK
- Log batch sebelum fix: ep 61-64, 77 timeout beruntun, progress mentok
  `✅ 60 ❌ 0` (75%) → setelah fix: ep gagal resolve di-retry 1x + session
  dirotasi tiap 2x timeout.

## Trade-off
- Retry 1x per drama menambah waktu maksimal ~jumlah ep gagal × (timeout 60s
  + retry internal). Terbatas hanya untuk ep yang timeout, dan hanya 1x —
  bukan infinite loop.
- Rotasi session menambah beban `sessions.create`/`destroy` (ringan) hanya
  saat ada pola timeout beruntun, bukan per-ep.
