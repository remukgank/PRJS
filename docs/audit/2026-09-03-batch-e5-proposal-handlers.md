# Proposal E5 — handlers/library + handlers/vidara + handlers/admin

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

## 1. Satu Batch atau Dipecah? — Dipecah (E5a/E5b/E5c)

**Keputusan: pecah jadi 3 sub-step.** Hasil audit ketergantungan silang:

- **Library** (keyboard builders + callback `lib_menu`/`act:lib`): keyboard builders murni tanpa Map; callback memakai `pendingAdds.set` ×1. Tidak memanggil Vidara/Admin.
- **Vidara** (`actionVidara*` ×4, dipanggil dari callback `v_per_ep`/`v_merge10`/`vt_*`): hanya `vidaraBusy.set/delete` (lock per-chat). Tidak memanggil Library/Admin.
- **Admin** (`isAdmin`, `adminPanelKeyboard`, VIP/Saweria, `sendInvoice`, `pre_checkout_query`): dipakai lintas domain sebagai guard (`isAdmin` 62 refs), tapi modul admin sendiri tidak memanggil Library/Vidara.

Ketiganya **independen** (tidak saling panggil, tidak share Map selain pola umum). Menggabung 3 domain beda dalam 1 commit hanya memperbesar blast radius tanpa benefit ordering — sama seperti pelajaran E3/E4. Maka:

| Sub-step | Isi | Risk |
|----------|-----|------|
| **E5a** | `handlers/library.js` — keyboard builders (`librarySearchResultKeyboard`, `buildLibraryKeyboard`, `libraryPartsKeyboard`, `libraryPartsPageKeyboard`) + callback `lib_menu`/`act:lib` | Low-Medium |
| **E5b** | `handlers/vidara.js` — `actionVidaraPerEp`, `actionVidaraMerge10`, `actionVidaraAndTelegram*` + lock `vidaraBusy` | Medium |
| **E5c** | `handlers/admin.js` — `isAdmin`, `adminPanelKeyboard`, VIP/Saweria, `sendInvoice`, `pre_checkout_query` handler | Medium (payment flow, test lebih ketat) |

`polling_error` stay di `bot.js` facade (generic logger, bukan domain).

## 2. `pre_checkout_query` ke admin.js — Test Ketat

Handler saat ini (bot.js:4235): `answerPreCheckoutQuery(ok:true)` + log. Test plan E5c:
- Trigger `pre_checkout_query` buatan (mock query Stars/Saweria) → verifikasi `answerPreCheckoutQuery` dipanggil dengan `ok:true` + log `Pre-checkout approved` muncul
- Verifikasi tidak ada regresi: `sendInvoice` masih terpanggil dari flow VIP dengan payload yang sama
- Rollback terpisah: payment flow di branch sendiri (E5c), tidak gabung dengan library/vidara

## 3. Shared State Per Modul (hasil audit)

**Map yang dipakai langsung (semua hanya pola baca/tulis Map sendiri, tidak lintas modul):**
- Library: `pendingAdds.set` ×1 (di callback `lib_menu` tambah part)
- Vidara: `vidaraBusy.set/delete` (lock per-chat di 4 action)
- Admin: tidak ada Map sendiri (guard `isAdmin` stateless dari `ADMIN_IDS`; `pendingAi*`/`pendingVidaraDomain` dipakai di message handler umum, bukan domain admin — tetap di `bot.js` facade)

**ctx pattern (established E4):** `{ bot, logger, config, sessions, samehadakuEpisodeMap, ... }` + Map spesifik per modul (`pendingAdds` untuk library, `vidaraBusy` untuk vidara). Tidak ada `require('../bot')` dari handler.

**Dependensi lain:** Library → `db` (`searchDrama`, `listPartsWithFile`, `getMediaBySlug`); Vidara → `services/vidaraService` + `downloader`; Admin → `services/vipService`, `services/saweriaService`. Semua stateless import langsung (pola E4).

## 4. Test Coverage Per Modul

- **Library:** `/cari <nama>` → keyboard hasil (sudah ada fix UTF-8 — re-test); `lib_menu` slug → parts keyboard; `act:lib_list_c` pagination drama/anime
- **Vidara:** 1 batch `v_merge10` kecil (mock upload bila perlu) → progress done tanpa error baru; `vidaraBusy` lock release setelah selesai
- **Admin:** `act:admin_panel` render; mock `pre_checkout_query` → approved + log; `sendInvoice` payload sama

Tunggu approve sebelum mulai E5a. E5b/E5c butuh approve terpisah masing-masing setelah E5a merge.
