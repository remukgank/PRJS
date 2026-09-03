# Fix UX Samehadaku — Tombol Kembali ke List Episode Setelah Download

**Date**: 2026-09-03
**Author**: opencode

## Root Cause

Alur Samehadaku: `anime → pilih ep (sam_ep) → pilih server (sam_dl) → preview → Ya Download (sam_go) → download`. Setelah download selesai via `sam_go` → `downloadSamehadakuFile` → `Max`/`RichProgress done`, bot hanya menampilkan `Menu Utama`, bukan opsi kembali ke daftar episode. User harus kirim ulang link anime untuk lanjut episode berikutnya — tidak efisien.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` `sam_go` (4863) | Setelah `downloadSamehadakuFile` sukses, jika `sameInfoG.slug` ada, kirim pesan follow-up dengan tombol `⬅️ Kembali ke list episode` (`sam_back:<animeUrl>`) |

## Detail Teknis

```js
await downloadSamehadakuFile(...);
if (sameInfoG?.slug) {
  const animeUrlBack = `https://v2.samehadaku.how/anime/${sameInfoG.slug}/`;
  await bot.sendMessage(chatId, `⬅️ Kembali ke list episode?`, {
    reply_markup: { inline_keyboard: [[{ text: `⬅️ Kembali ke list episode`, callback_data: `sam_back:${cacheUrl(animeUrlBack)}` }]] },
  });
}
```

- Guard `sameInfoG?.slug` → hanya untuk samehadaku, tidak untuk download non-samehadaku.
- `animeUrlBack` memakai `sameInfoG.slug` (anime slug, mis. `gaikotsu-kishi-sama-tadaima-isekai-e-odekakechuu-season-2`) → format `/anime/<slug>/` yang sudah di-fix `sam_back` generic (bukan hardcode Tensura).
- Pesan kedua terpisah dari `RichProgress done` (Menu Utama) — tidak crash, hanya extra message.

## Verification

- `node --check scraper/bot.js` — lulus
- Functional: alur `anime → ep → server → Ya Download` → download selesai → muncul tombol Kembali ke list episode → klik → kembali ke daftar `Ep 1..N`.
