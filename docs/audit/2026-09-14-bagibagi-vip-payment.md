# Proposal — Pembayaran VIP Otomatis via BagiBagi (Browser Automation)

**Date**: 2026-09-14
**Author**: opencode
**Status**: IMPLEMENTED — menunggu live test user + commit (lihat bagian Verifikasi)

## Root Cause / Latar Belakang

Integrasi pembayaran otomatis BagiBagi ke bot (pola Saweria: create donasi → QR → deteksi bayar → auto-grant VIP) tidak bisa dilakukan dengan pendekatan curl/API murni karena proteksi Cloudflare:

- Semua request **write** (`POST /api/UserProfile/save-donation`, `POST /api/Payment/qris`) dan **WS** (`wss://ws.bagibagi.co/ws/payment`) memerlukan konteks browser yang sudah menyelesaikan **Cloudflare Managed Challenge** (`cf-response` header) + `x-authorization`.
- `x-authorization` = `encryptToBase64(fingerprint, "bagibagisupport")` (PBKDF2 100k iter + AES-CBC) — **bisa dibangun ulang dari Node** (sudah di-verify, struktur salt 32 + iv 16 + ct 80).
- Namun `cf-response` **terikat ke instance challenge** — token dari browser user gagal di-replay dari server/IP beda (hasil tes: `"Captcha verification failed"` HTTP 400). WS dari luar juga ditolak (`HTTP 403`).
- Kesimpulan: **perlu browser sungguhan** yang menyelesaikan challenge secara natural.

### Temuan pendukung (investigasi 2026-09-14)
- Body `save-donation` dan `Payment/qris` sudah diketahui dari capture user + JS bundle (di bawah).

#### Request body terkonfirmasi (dari capture DevTools user)

`POST /api/UserProfile/save-donation` — header wajib `x-authorization` (fingerprint terenkripsi) + `cf-response` (akut challenge CF):
```json
{"username":"","preferedName":"Seseorang","message":"Semangat kaka","isAnnonymous":true,"amount":50000,
 "receiverUserName":"sepibukansapi","email":"gentarmusic@gmail.com","userId":"","isTransactionWithoutLogin":true,
 "isPrivateTransaction":false,"soundBoardId":"","pollingId":"","voiceNoteMode":"normal","mediaShare":"",
 "startSecond":0,"endSecond":0,"ip":"","partyQueueJoin":false,"partyQueueAnswers":[],"requestSong":false}
```
Response: `{"data":"<donationId-UUID>","success":true}`.

`POST /api/Payment/qris` — TANPA `x-authorization` dan TANPA `cf-response` (cukup session cookies CF setelah challenge awal; body 578 byte):
```json
{"items":[{"id":"bagibagi-coin-50000","brand":"BagiBagi","category":"BagiBagi coin","merchant_name":"BagiBagi",
 "name":"BagiBagiCoin","price":50000,"quantity":1}],"grossAmount":50000,
 "orderId":"bagibagi-72f078cf-bc63-4ce2-8410-229a77080195",
 "transactionDetails":{"order_id":"bagibagi-72f078cf-bc63-4ce2-8410-229a77080195","gross_amount":50000,"fee":{"fee":0}},
 "donationId":"72f078cf-bc63-4ce2-8410-229a77080195","userId":"","isDonate":true,
 "isTransactionWithoutLogin":true,"destinationUserId":"","voucherId":"",
 "returnUrl":"https://bagibagi.co/sepibukansapi","qrisAcquirer":"SP"}
```
Response: `{data:{merchantCode, paymentUrl, qrString, amount, statusCode:"00", statusMessage:"SUCCESS"}}`.
Catatan: `donationId` = UUID dari save-donation; `orderId` = `bagibagi-<donationId>`; `qrisAcquirer:"SP"` (QRIS family: SP/SQ/IQ/INQ).
- Alur frontend: form → Turnstile/CF challenge → Remix action build `x-authorization` dari fingerprint → `POST /UserProfile/save-donation` dengan header `CF-Response` + `X-Authorization` → `POST /Payment/qris` (body: items/grossAmount/orderId/donationId/isDonate/...).
- WS protocol (dari bundle): `JoinTransactionGroup` → `TransactionStatusChanged` (cek `resultCode === "00"`) → konfirmasi lewat `POST /Payment/check-transaction`.
- Catatan desain: `x-authorization` dipakai save-donation, **tidak** dipakai Payment/qris; cf-response juga tidak wajib di Payment/qris. Karena worker membangun `x-authorization` sendiri dari fingerprint yang di-generate-nya (persisten per instance), pertanyaan "token static/dynamic" tidak lagi relevan bagi desain kita.
- Frame WS saat sukses belum tertangkap, tapi **bukan blocker lagi**: status final diambil via `POST /Payment/check-transaction {merchantOrderId: bagibagi-<donationId>}` (polling 7s), sama seperti polling saweria.
- WS handshake terkonfirmasi dari browser (101) pada `wss://ws.bagibagi.co/ws/payment?userId=9fd311e3-3d14-49eb-b065-4230d8809de1` = **userId akun penerima** (sepibukansapi). Dari luar browser (tanpa konteks CF) koneksi ditolak (403). Konsekuensi desain: WS dibuka **di dalam browser worker** (via CDP `page.evaluate`), bukan dari Node. Implementasi memakai polling `check-transaction` sebagai path utama; WS-in-browser opsional untuk percepatan real-time.

#### Status akhir via `POST /api/Payment/check-transaction`

Body: `{"merchantOrderId":"bagibagi-<donationId>"}`. Response (terkonfirmasi dari capture):
```json
{"data":{"merchantOrderId":"bagibagi-72f078cf-...","reference":"D1272326QGLPU62UNX2LLYE",
 "amount":"50000","statusCode":"01","statusMessage":"PROCESS"},"success":true,"message":""}
```
Semantik (selaras logika `Z()` di bundle):
- `statusCode:"01"` / `statusMessage:"PROCESS"` → pending, lanjut poll (7s).
- `statusCode:"00"` / `statusMessage:"SUCCESS"` → lunas; `amount` (string, angka rupiah) + `reference` dipakai untuk grant VIP + audit.
- selain itu → gagal/kadaluarsa.
Tanpa `x-authorization`/`cf-response` — hanya butuh session cookie browser.
- Workspace **sudah punya stack browser stealth**: Chromium 138 (nix) + `undetected_chromedriver` 3.5.5 + selenium + Xvfb di `.solver/` (infra yang sama dengan FlareSolverr, sudah terbukti tembus bagibagi.co).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scripts/bagibagi-worker.py` (baru) | Bottle HTTP server di `127.0.0.1:8192` (env `BAGIBAGI_WORKER_URL`). Endpoints: `POST /create` (isi form donasi di browser → create donation → Payment/qris → return `{donationId, qrString, paymentUrl, amount}`), `GET /status?donationId=` (check-transaction dari dalam browser), `POST /abort`. Satu Chromium persistent (cookies + cf-context reuse). |
| `scripts/start-bagibagi-worker.sh` (baru) | Wrapper start + supervisor-loop, pola `scraper/start-flaresolverr.sh` (source `.solver/paths.env`, set `LD_LIBRARY_PATH`, Xvfb). |
| `scraper/services/bagibagiService.js` (baru) | Adaptasi `saweriaService.js`: `startPayment(ctx, userId, days)` → panggil worker `/create` → kirim foto QR → `pollStatus` via `/status` (interval 7s, TTL 15 menit, MAX_CONSECUTIVE_ERRORS) → sukses: insert `payments` + `vipService.addVipUser` + notify admin. Pakai package `qrcode` yang sudah ada. |
| `scraper/handlers/admin.js` | Menu VIP kini punya 3 tombol: `⬛ QRIS` (Saweria) → `select_payment_qris`, `🟦 BagiBagi` → `select_payment_bagibagi`, `⭐ Stars` → `select_payment_stars`. Handler baru `bagibagi_pkg_*` (mulai `bagibagiService.startPayment`, cek `BAGIBAGI_RECEIVER_USERNAME`), cancel `bagibagi_cancel_*`, dan `select_payment_bagibagi`. Callback lama `qris_pkg_*` tetap menuju Saweria (stabil, tidak lagi auto-switch provider). |
| `scraper/bot.js` | Dispatch callback `bagibagi_pkg_*`, `select_payment_bagibagi`, dan `bagibagi_cancel_*`. |
| Env baru (secrets, dipegang user) | `BAGIBAGI_WORKER_URL=http://127.0.0.1:8192`, `BAGIBAGI_RECEIVER_USERNAME=sepibukansapi`, `BAGIBAGI_RECEIVER_USER_ID=9fd311e3-3d14-49eb-b065-4230d8809de1`. Opsional: `BAGIBAGI_WORKER_PORT`, `BAGIBAGI_CAPTCHA_TIMEOUT`, `BAGIBAGI_PAYMENT_WAIT_TIMEOUT`, `BAGIBAGI_DRIVER_PATH`, `BAGIBAGI_PAGE_URL`. (`VIP_PAYMENT_PROVIDER` TIDAK lagi dipakai — menu pakai tombol terpisah.) |
| `docs/audit/2026-09-14-bagibagi-vip-payment.md` | File ini — proposal + hasil verifikasi. |

## Detail Teknis

### Worker Python (`.solver` stack reuse)
- Start mirip FlareSolverr: `source .solver/paths.env`, `export LD_LIBRARY_PATH="$GLIB_LIB:$NSS_LIB:$XCB_LIB:$NSPR_LIB"`, `PYTHONPATH=$SOLVER_DIR/pkg:$SOLVER_DIR/src`.
- `undetected_chromedriver` + selenium memakai `CHROMIUM_BIN` dari `paths.env`.
- Satu instance Chromium dibuat persistent (user-data-dir sementara) untuk reuse cookies/cf-context; headless sesuai konfigurasi — bisa toggle `--headless=new` / Xvfb.
- Alur `/create`:
  1. Buka `https://bagibagi.co/<receiver>`.
  2. Generate fingerprint (FingerprintJS di page) — `x-authorization` dibangun worker (implementasi `encryptToBase64`).
  3. Isi form (amount, preferedName, message), solve CF challenge bila muncul (auto; fallback ke `BAGIBAGI_2CAPTCHA_KEY` bila plugin solve-turnstile tersedia).
  4. Submit → tunggu `donationId` dari network/domsave.
  5. Trigge `Payment/qris` → tangkap `qrString`/`paymentUrl` dari response network.
  6. Return payload; simpan state `donationId → pending` untuk `/status`.
- `/status`: dari session browser panggil `POST /Payment/check-transaction` `{merchantOrderId: bagibagi-<donationId>}` → balikin `{statusCode, statusMessage, amount, reference}`.
- Turnstile & interstitial CF: hook CDP `Page.addScriptToEvaluateOnNewDocument` menangkap respons `/api/` (termasuk `save-donation` & `/Payment/qris`) ke `window.__bbq`. Challange ditangani: (a) interstitial "Performing security verification" saat buka halaman, (b) widget Turnstile di dialog Verifikasi setelah konfirmasi — keduanya ditunggu sejumlah detik (env `BAGIBAGI_CAPTCHA_TIMEOUT`/`BAGIBAGI_PAYMENT_WAIT_TIMEOUT`); bila tetap menggantung → error `captcha_unresolved` (HTTP 409) supaya bot memberi pesan ramah + retry. 2captcha **tidak viable** (token Turnstile terikat widget id + postMessage, tak bisa di-inject) — tidak diimplementasikan.
- Bootstrap worker (terverifikasi): wajib set `utils.PATCHED_DRIVER_PATH` ke `$HOME/.local/share/undetected_chromedriver/chromedriver` sebelum `get_webdriver()` (hindari unduhan online yang gagal CERT_VERIFY di sandbox); path `paths.env` dibungkus quote → di-strip via `_load_paths()`; worker menolak start bila chromedriver belum ada (pesan yang jelas).
- Timeout tiap create: ~90s (bisa >90s saat interstitial menunggu); error dipetakan ke kode yang bisa dibaca bot.

### Node service
- Sama struktur `saweriaService.js`: `activeIntervals`, `processingPayments`, `cancelAndCleanup`, zombie killer TTL.
- Sukses → `pool.query INSERT payments ... ON CONFLICT (order_id) DO UPDATE` (schema `payments` sudah dibuat `vipService.loadVipCache`) → `vipService.addVipUser(userIdStr, days, {username, paymentMethod:'bagibagi_qris', amount})` → notify admin + edit message sukses.

## Verification

### Sudah diverifikasi (sandbox 2026-09-14)
- `node --check` lulus untuk semua `.js` berubah (`admin.js`, `bot.js`, `bagibagiService.js`); `require('./scraper/services/bagibagiService.js')` sukses.
- `resolveQrisProvider()` ► dihapus (desain berubah ke tombol terpisah); `qrIS_pkg_*` fixed ke Saweria. Menu diuji via require + `node --check` (handler `select_payment_bagibagi`/`bagibagi_pkg_*` terdaftar).
- Worker standalone (via `scripts/start-bagibagi-worker.sh`, `CHROME_BIN` nix + uc patched + Xvfb headless):
  - `GET /health` → `{"ok":true}`.
  - `POST /create` amount Rp 10.000 → `{"error":"captcha_unresolved", ...}` HTTP 409 (interstitial CF "Performing security verification" tidak selesai di IP sandbox) — ini hasil **jujur** untuk lingkungan ini, bukan bug.
  - `GET /status` tanpa id → 400 `donationId required`; dengan id karangan → shape JSON terbentuk (fetch dari konteks halaman terblokir interstitial → `code:ERROR`).
  - `POST /abort` → `{"ok":true}`; `POST /create` amount <1000 → 400.
- Browser cleanup: proses worker/supervisor/Chromium di-stop setelah tes; port 8192 bebas.

### Live test sesi pertama (2026-09-14) — 2 bug blocking ditemukan & diperbaiki
- User tap `🟦 BagiBagi → paket` tidak ada respons apa pun.
- **BUG 1 (guard `act:`)**: `bot.js` guard `if (!data.startsWith('act:')) return;` membuang SEMUA callback pembayaran karena `bagibagi_pkg_*` / `qris_pkg_*` / `stars_pkg_*` / `saweria_cancel_*` / `bagibagi_cancel_*` tidak diawali `act:`. Perbaikan: callback pembayaran ditangani SEBELUM guard (regex `^(stars_pkg_|qris_pkg_|bagibagi_pkg_|saweria_cancel_|bagibagi_cancel_)` → `handlePaymentAction` langsung, bot.js:~3510). Pre-existing bug — Stars & Saweria juga terdampak.
- **BUG 2 (`ctx.reply` undefined)**: `paymentCtx()` di `admin.js` tidak punya method `reply`, padahal `bagibagiService.startPayment` dan `saweriaService.startPayment` memanggil `ctx.reply(...)`. Perbaikan: `reply: (html, opts) => bot.sendMessage(chatId, html, opts)` ditambahkan ke paymentCtx.
- Setelah fix: log menunjukkan callback `bagibagi_pkg_3`/`bagibagi_pkg_7`/`bagibagi_pkg_1` sampai ke `handlePaymentAction`, worker `/create` dipanggil, balasan `captcha_unresolved` (409) dari sandbox — **flow benar, hanya CF yang memblokir IP sandbox**.
- Penyempurnaan tambahan: `withRetry` di `bagibagiService` kini **langsung throw `captcha_unresolved` tanpa retry** (deterministik per IP, retry sia-sia), dan tombol "🔄 Coba Lagi" memperbaiki callback salah provider (dulu `act:qris_pkg_${days}` → sekarang `bagibagi_pkg_${days}`).

### Sesi debug worker (2026-09-14) — alur sampai dialog verifikasi, macet di Turnstile (IP sandbox)
- TOS checkbox: `dispatchEvent`/JS `.click()` tidak trusted → React (bagibagi pakai Remix/shadcn Radix) abaikan. Fix: Selenium `ActionChains` **real click** → `[tos] setelah klik (real): [{"checked": true...}]` ✅.
- Field **email wajib** (valdasi "Email tidak valid" memblokir submit diam-diam): `_fill_form` kini isi `#email` nilai `.gmail.com` valid ✅ (dump form: `value: donatur.test.2026@gmail.com`).
- Tombol konfirmasi dialog payment (`Bagibagi`, w=510, bawah halaman) juga butuh real click (JS click diabaikan React) → `_click_confirm` pakai ActionChains ✅.
- Setelah 3 fix itu: dialog **"Verifikasi BagiBagi — Selesaikan verifikasi untuk melanjutkan transaksi"** MUNCUL (Radix `[role=dialog]`, berisi `#cf-turnstile` + `input[name=cf-turnstile-response]`). Semua tahapan form → QR bank/e-wallet → payment dialog → TOS → confirm sudah tembus di headful Chromium (Xvfb).
- **Blocker tersisa = Turnstile tidak menghasilkan token di sandbox**: widget `#cf-turnstile` ter-mount shell tapi iframe challenge **tidak pernah muncul** (frames=[], shadow=[] selama 35 detik), `execute()` memicu warning "Call to execute() on a widget that is already executing" dan selesai tanpa token. Network ke challenges.cloudflare.com OK (200), JS `window.turnstile` + api.js ter-load (render/execute/reset tersedia). Perilaku ini khas **managed challenge yang ditahan di IP datacenter** (34.47.206.162) — sama akarnya dengan interstitial CF di headless.

### Sesi Saran #1 (2026-09-15) — reset-once + silent window: bukti final IP ditolak CF
- Hipotesis diuji: mungkin spam `execute()` worker tiap ~3 dtk yang mengganggu widget (CF sempat warning "already executing"). Saran #1: `reset()` SAKALI per run donasi (flag di `_do_create`, bukan global) lalu **silent window** — poll token saja (`cf-turnstile-response` + `getResponse`) tiap ~3 dtk tanpa execute/klik selama PAYMENT_WAIT_TIMEOUT. Log reset + tiap poll (Pagar 1/2/3). Default hidup setelah restrukturisasi `_try_click_turnstile` (execute-only bila iframe interaktif memang mount).
- Implementasi: `_turnstile_reset_once()` + `_turnstile_poll_token()` (tanpa side-effect) di `scripts/bagibagi-worker.py`; loop wait = reset-once → silent poll. `py_compile` OK.
- **Hasil run nyata (log 03:02)**: `[turnstile-reset] {"hadTokenBefore": false, "ok": true}` → 8× `[turnstile-poll]` (03:02:14→03:02:47) semuanya `token='' iframe=False frames=[]` → `captcha_unresolved`. Reset-once berhasil, iframe challenge **tetap tidak pernah mount**, token tetap kosong walau tanpa gangguan execute.
- **Kesimpulan FINAL**: bukan menyebabkan widget; Cloudflare menolak dari sisi server di IP datacenter Replit (34.47.206.162). Token tidak akan keluar di lingkungan ini apa pun strateginya. Opsi lanjut: (a) worker dipindah ke mesin ber-IP non-datacenter + hubungkan bot via `BAGIBAGI_WORKER_URL` (Cloudflare Tunnel/cloudflared gratis; CF Workers tidak cocok — tidak bisa jalankan Chromium/Selenium); (b) jadikan QRIS/Saweria (yang jalan normal di IP ini) jalur utama, BagiBagi di-hold.
- **Terbukti dari live test 02:33**: paket **Rp 3.000 lolos form** sampai dialog verifikasi → "Min: 10.000" BUKAN blocker submit, hanya info/hint (record body page). Catatan "Min: 10.000 memblokir paket kecil" di bawah DICABUT.

### Belum bisa diverifikasi di sandbox (butuh live test user)
- Konteks CF tidak menyelesaikan managed challenge di IP sandbox ⇒ alur donasi penuh (form → QR keluar) & pembayaran tidak bisa di-test end-to-end di sini. Turnstile tidak akan resolve di IP Replit sebagaimana dibuktikan Saran #1.
- Live test (tangan user): `POST /create` → QR muncul → bayar dengan m-banking/e-wallet nominal terendah → bot auto-aktifkan VIP + messsage sukses + record `payments` (`method='bagibagi_qris'`). Hanya valid di IP non-datacenter.

## Diluar Scope / Catatan

- Tidak menyentuh `saweriaService.js`, `fomo-drama/`, `hokidrama/`, `.replit`, `start.sh`, `.pm2/`, `.solver/src` (FlareSolverr).
- Worker hidup 1 instance per bot → start via wrapper script (PM2 atau `nohup`).
- Risiko: CF challenge interaktif sesekali → retry + notify admin (worker sudah mengembalikan `captcha_unresolved`; service bot menampilkan pesan ramah + tombol coba lagi). 2captcha/Turnstile-solve **tidak viable** (token terikat widget), tidak diimplementasikan.
- Commit dilakukan HANYA setelah user konfirmasi hasil live test OK.