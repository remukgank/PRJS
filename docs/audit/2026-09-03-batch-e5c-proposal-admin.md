# Proposal E5c — handlers/admin.js (Admin, VIP, Payment)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

## 1. Scope: Yang Pindah vs Yang Tetap

**Pindah ke `handlers/admin.js`:**
- `isAdmin` (664), `adminPanelKeyboard` (891), `sendInvoice` (700), `makePostRequest` (672, dipakai `pre_checkout` + invoice)
- Callback: `admin_panel` (3382), `balance` (3563), `vip` (3686), `saweria_cancel_*` (3756)
- Handler `bot.on('pre_checkout_query')` (3799) — answer ok:true + log
- `bot.on('polling_error')` (3811) stay di `bot.js` facade (generic logger, bukan domain)

**Tetap di facade (`bot.js`), TIDAK ikut E5c:**
- `msg.successful_payment` (1888, aktivasi VIP Stars + `recordPayment`) — berada di message handler umum, bukan domain admin terpisah. Memindahkannya berarti memecah message handler yang bukan scope E5.
- `pendingAiEndpoint/Key/Model`, `pendingVidaraDomain` (321-324 + message handler 1989-2042) — dipakai message handler umum untuk input bertahap, bukan payment flow. Tetap di facade.
- `/addvip` manual admin (2495) — berada di message handler umum.
- Rate-limit VIP check di `lib_part` (`vipService.isVipUser`) — tetap di facade, hanya guard baca.

Alasan: E5c hanya memindahkan kode yang kohesif domain payment/admin dan tidak terjalin dengan message-handler flow. Memaksa pindah `successful_payment`/`pendingAi*` berarti memecah message handler — di luar scope dan risiko melebar.

## 2. `pre_checkout_query` — Test Ketat (payment flow kritis)

Handler saat ini: `answerPreCheckoutQuery(ok:true)` + log `Pre-checkout approved`; on error log `Pre-checkout answer failed`. Tidak mengubah charge (Telegram yang charge, bot hanya approve).

**Kenapa mock (bukan live-trigger payment asli):** trigger payment asli berarti charge Stars/rupiah sungguhan ke akun produksi + callback `successful_payment` yang mengaktifkan VIP nyata. Itu biaya + side effect nyata untuk sebuah test refactor. Mock memverifikasi wiring (`answerPreCheckoutQuery` dipanggil dengan `ok:true`, log muncul) tanpa uang bergerak. Ini keputusan sadar — live-trigger hanya untuk download handler (tanpa biaya), bukan payment.

**Test plan E5c:**
1. `node --check` semua file berubah
2. Mock `pre_checkout_query` → verifikasi `answerPreCheckoutQuery` dipanggil `{ok:true}` + log `Pre-checkout approved`
3. Mock `act:vip` → keyboard paket render; mock `act:admin_panel` → panel render; `sendInvoice` payload sama (bandingkan field per field dengan versi facade)
4. Restart pm2 dari branch → polling jalan, tidak ada `Unhandled` baru

## 3. Shared State

- **Tidak ada Map milik domain admin** — `isAdmin` stateless dari `ADMIN_IDS`; panel/VIP/Saweria tidak baca/tulis Map apa pun (audit: 0 pemakaian Map di 4 blok callback).
- **ctx**: `{ bot, logger, config: { ADMIN_IDS, STAR_PRICE }, isAdmin }` + import langsung stateless (`services/vipService`, `services/saweriaService`, `db` get/setSetting, `VIP_PACKAGES`). `sendInvoice` butuh `makePostRequest` (ikut pindah, hanya dipakai invoice + pre-checkout).
- Tidak ada `require('../bot')` — cegah cyclical.

## 4. Rollback Plan

- Branch `batch-e5c-admin` terpisah — 1 commit, merge setelah verifikasi.
- DB tidak disentuh. `bot.js` simpan wrapper delegasi tipis (pola E4/E5a/E5b).
- Jika bermasalah: `git checkout main -- scraper/bot.js` + hapus `scraper/handlers/admin.js`, atau `git revert` 1 commit.

Tunggu approve sebelum mulai E5c.
