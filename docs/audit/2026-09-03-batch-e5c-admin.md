# Batch E5c — handlers/admin.js (Admin, VIP, Payment)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e5c-admin`

## Scope

Pindahkan dari `scraper/bot.js` ke `scraper/handlers/admin.js` via ctx injection:
- `adminPanelKeyboard`, `makePostRequest`, `sendInvoice`, `vipPaymentRows`
- Callback: `admin_panel`, `balance`, `vip`, `select_payment_*`, `stars_pkg_*`, `qris_pkg_*`, `saweria_cancel_*` (sebagai `handleAdminPanel`, `handleBalance`, `handleVip`, `handleSelectPayment`, `handlePaymentAction`)
- Handler `bot.on('pre_checkout_query')` sebagai `handlePreCheckout`
- `bot.js` simpan wrapper delegasi tipis; `polling_error` stay di facade.

**Tetap di facade** (keputusan proposal): `msg.successful_payment` (aktivasi VIP + recordPayment), `pendingAi*`, `/addvip`, VIP check di `lib_part`, `sendInvoice`/`makePostRequest`/`adminPanelKeyboard` definisi lama (masih dipakai non-admin path — duplikasi sementara dibersihkan di E6). `isAdmin` tetap di facade (dipakai 60x), diteruskan via ctx.

## Detail — ctx & dependensi

- `initAdmin({ bot, config: { ADMIN_IDS, STAR_PRICE, LOCAL_API_PORT, TOKEN } })` + `ensureCtx` guard (pola E4/E5a/E5b)
- Import langsung stateless: `services/vipPackages` (`VIP_PACKAGES`, `VIP_STAR_PRICES`, `VIP_PACKAGE_ORDER`), `db` (`getSetting`, `setSetting`), `services/vipService` + `services/saweriaService` via inline require di handler (pola lama dipertahankan, bukan diubah)
- `handleBalance`/`handleVip` terima `mainMenuKeyboard` via parameter (keyboard umum, bukan domain admin); `handlePaymentAction` terima `mainMenuKeyboard` + `isAdminUser`
- Tidak ada `require('../bot')` — cegah cyclical

## Verification

- `node --check scraper/bot.js`, `scraper/handlers/admin.js` — lulus
- **Functional test (mock, alasan eksplisit di proposal):** guard tanpa init throw jelas ✓; post-init `handlePreCheckout` lanjut request (gagal network di sandbox = expected, bukan guard) + log `Pre-checkout answer failed` dengan queryId ✓
- **Startup pm2 dari branch:** `Bot running`, `Polling started`, `Database tables initialized`, tidak ada `Unhandled` baru ✓

## Rollback

Branch `batch-e5c-admin` dari `main` (27e2981, setelah proposal E5c). Jika bermasalah: `git checkout main -- scraper/bot.js` + hapus `scraper/handlers/admin.js`, atau `git revert` 1 commit. DB tidak disentuh.
