# 2026-08-30 — Upgrade Sistem VIP & Pembayaran (referensi fomo-drama)

## Tujuan
Menuntaskan menu VIP & pembayaran PRJS yang selama ini minimal dan partial, dengan mengadopsi
resep dari `fomo-drama/services/saweriaService.js` + `vipService.js` (pola addVipUser stacking,
aktivasi otomatis via polling, audit payments).

## Temuan Awal (bug wiring)
- `act:qris_pkg_*` sebelumnya `require('../fomo-drama/services/saweriaService')` — saat sukses
  service itu memanggil **vipService milik fomo-drama** (tabel `vip_members`, DB fomo-drama),
  bukan `vip_users` PRJS → pembayaran QRIS tidak mengaktifkan VIP di PRJS.
- `pay_stars` kirim invoice tanpa aktivasi; `successful_payment` hanya untuk unlock per-drama.
- `vipService.addVipUser` memakai `GREATEST` (bukan extend dari expiry) → tidak stacking.
- Tidak ada tabel `payments`, tidak ada `/addvip`, menu `act:vip` tanpa status/perpanjang.

## Perubahan
| File | Perubahan |
|------|-----------|
| `scraper/services/saweriaService.js` (BARU) | Adaptasi lokal dari fomo-drama: `startPayment`, `calculateAmount`, `createDonation`, `checkPaymentStatus`, polling 7 dtk / timeout 15 mnt, `saweria_cancel_*`, zombie cleanup interval lokal (unref), `formatRupiah`. Sukses → `vipService.addVipUser` PRJS + insert `payments` + notif admin. Tanpa referral (PRJS tidak punya). Env: `SAWERIA_USERNAME`, `SAWERIA_USER_ID`. Paket = `VIP_PACKAGES` lokal (3/7/15/30/60/90: 15k/25k/40k/70k/120k/170k). |
| `scraper/services/vipService.js` | `addVipUser` diubah jadi **stacking**: extend dari `expire_at` aktif (baca dulu, bukan `GREATEST`). Tambah `recordPayment`. `loadVipCache` kini create tabel `payments` (id BIGSERIAL, order_id UNIQUE, user_id, username, amount, method, vip_days, status, message, created_at, processed_at). `getVipInfo` return null jika expired. |
| `scraper/bot.js` | Konstanta `VIP_PACKAGES` & `VIP_STAR_PRICES` (skala IDR→Stars: 50/90/150/250/430/600⭐). Menu `act:vip`: harga paket + status VIP (sisa hari + Perpanjang) bila aktif. `select_payment_qris` pakai `VIP_PACKAGES`. `select_payment_stars` → daftar paket ⭐ (`stars_pkg_<days>`). `stars_pkg_*` → `sendInvoice(payload='vip:<days>:<userId>', XTR)`. `successful_payment` deteksi payload `vip:days:userId` → `addVipUser` + `recordPayment` + notif admin (dibedakan dari unlock per-drama). `qris_pkg_*` → `require('./services/saweriaService')` dgn ctx adapter (answerCbQuery/reply/replyWithPhoto/telegram/notify). Tambah callback `saweria_cancel_<donationId>` → `cancelAndCleanup` + pesan batal. Tambah command admin `/addvip <user_id> <days>` (aktivasi manual + recordPayment + notif user). `sendInvoice` terima arg `label`. |
| `package.json` | Tambah dep `"qrcode": "^1.5.4"` (generate QR; `--no-audit --no-fund` install lokal sukses, 29 pkg). |

## Verifikasi
- `node --check` scraper/bot.js & 2 service → OK.
- `vipService` tes stub pool: `addVipUser(30)` → `+30` = extend tepat 30 hari dari expiry
  (diff 30.0 hari), `getVipInfo` daysLeft ~60, `recordPayment` insert `payments` (`STACK OK`).
- Menu `act:vip` render: free user lihat QRIS+Stars tanpa Perpanjang; VIP user lihat status
  `sisa <b>12 hari</b>` + tombol Perpanjang (`VIP MENU OK`).
- `saweriaService` smoke: load + export + `VIP_PACKAGES` sesuai (`SAWERIA SMOKE OK`).
- `fetch` sisi server (Local API): `npm i`, set `.env` `SAWERIA_USERNAME`/`SAWERIA_USER_ID`
  (jangan di-commit), restart pm2. Tes alur: menu `💎 VIP` → QRIS → scan QR → bayar →
  auto-aktif; Stars → pilih paket → bayar ⭐ → auto-aktif; `/addvip 12345 7`.

## Lanjutan (perbaikan setelah tes live di Replit)
| File | Perubahan |
|------|-----------|
| `scraper/bot.js` & `scraper/services/saweriaService.js` | Semua callback VIP diberi prefix `act:` (`act:select_payment_qris`, `act:qris_pkg_*`, `act:stars_pkg_*`, `act:saweria_cancel_*`). Handler membaca `act = data.slice(4)` → tanpa prefix, tombol QRIS/Stars dulu **tidak pernah match** (bug lama yang sudah dead). |
| `scraper/services/saweriaService.js` | Fix `EFATAL: Unsupported file input: object`: `sendPhoto` node-telegram-bot-api hanya terima string/Buffer/stream, bukan `{source: path}` → `replyWithPhoto` kini kirim path string langsung. |
| `scraper/services/vipPackages.js` (BARU) | Source tunggal `VIP_PACKAGES`, `VIP_STAR_PRICES`, `VIP_PACKAGE_ORDER`. Harga baru ≈Rp 1.000/hari, makin lama makin murah, nominal QRIS kelipatan 1.000 (min Saweria), min 1⭐: 1h=1000/1⭐, 3h=3000/3⭐, 7h=5000/5⭐, 15h=9000/9⭐, 30h=15000/15⭐, 60h=27000/27⭐, 90h=38000/38⭐. |
| `scraper/bot.js` | Pakai `vipPackages`; rows paket dibuat dinamis via helper `vipPaymentRows(kind)` (7 paket + tombol kembali), tidak lagi hardcode. |

## Verifikasi
- `node --check` bot.js + 3 service → OK.
- `vip-test.js` stacking → `STACK OK` (diff 30.0 hari).
- `vip-menu-test.js` menu baru → `VIP MENU OK (harga baru + prefix + rows)` (termasuk cek `act:` prefix di semua callback, rows 1–90 hari, tidak ada callback tanpa prefix).
- `saweria-smoke-test.js` → `SAWERIA SMOKE OK` (export bersih, `vipPackages` harga baru).
- Live Replit: error `Saweria payment error / Unsupported file input` tercatat di `logs/app.log` — root cause software library, fixed. Restart bot via Replit workflow (auto-restart ada delay ~40 dtk; sempat 2 instance → 409 getUpdates, sudah dirapikan jadi 1).

## Catatan
- Harga Stars pakai konstanta di code (`VIP_STAR_PRICES`) — bisa diubah tanpa env.
- `pay_stars` legacy tetap ada untuk unlock per-drama (session-based), tidak usah dipakai untuk VIP.
- `logger` di service wajib destructure `{ logger }` dari `./logger` (pola file lain).
- Tabrakan: PRJS hanya punya 1 DB (helium) — tabel baru `vip_users` + `payments` dibuat otomatis
  oleh `loadVipCache()` saat bot start.