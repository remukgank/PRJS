# Batch E5a — handlers/library.js (Keyboard + lib_menu)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e5a-library`

## Scope

Pindahkan dari `scraper/bot.js` ke `scraper/handlers/library.js` via ctx injection:
- 4 builder: `librarySearchResultKeyboard`, `buildLibraryKeyboard`, `libraryPartsKeyboard`, `libraryPartsPageKeyboard` (919-1044)
- 1 callback: `handleLibMenu` (ex `lib_menu:` 3653-3697) sebagai fungsi berparameter `(ctx, {chatId,msgId,query,data})`
- `bot.js` 4281 → ~4096 baris. Wrapper delegasi tipis untuk `lib_menu`; 3 pemanggil builder di-reroute ke modul.

**Tetap di facade** (keputusan audit): `lib_replace*`/`lib_add` (menulis `pendingReplaces`/`pendingAdds` yang dibaca message handler), `lib_toggle` (domain admin + `setSetting`), `lib_part` (campur VIP/rate-limit + sendVideo/sendPhoto), `lib_list`/`lib_search` (36 baris routing, refactor signature tidak sebanding).

## Detail — ctx

`initLibrary({ bot, isAdmin })` + `ensureCtx` guard (pola E4). DB fns (`listAllLibrary`, `searchDrama`, `listPartsWithFile`, `getMediaBySlug`, `getPartFileId`) + `truncateText`/`cacheSlug`/`resolveSlug` di-import langsung (stateless, pola E4). Tidak ada `require('../bot')`.

## Verification

- `node --check scraper/bot.js`, `scraper/handlers/library.js` — lulus
- **Functional test (sesuai proposal):** guard tanpa init throw jelas ✓; `librarySearchResultKeyboard` dengan nama 80 char → truncate tanpa surrogate menggantung (re-test fix UTF-8) ✓; `buildLibraryKeyboard` header + pagination ✓
- **Startup pm2 dari branch:** `Bot running`, `Polling started`, `Database tables initialized`, tidak ada `Unhandled` baru ✓

## Rollback

Branch `batch-e5a-library` dari `main` (05c0787, setelah proposal E5). Jika bermasalah: `git checkout main -- scraper/bot.js` + hapus `scraper/handlers/library.js`, atau `git revert` 1 commit. DB tidak disentuh.
