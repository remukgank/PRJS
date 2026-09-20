# Hokidrama Vidara-Only + Group Filecode

**Date**: 2026-09-06
**Author**: hermes (implementasi atas approve user; D6 data oleh agent user, D7 + sort oleh hermes)

## Root Cause

Web hokidrama memaksa konten yang tidak ada sehingga terlihat scam:

1. Drama Telegram-only (tanpa episode Vidara) ikut tampil via fallback `media`/`media_parts`, lengkap dengan card "tersimpan di Telegram".
2. Hasil batch merge (10 ep/chunk = banyak row share 1 filecode) di-render 1 tombol per row — 91 tombol untuk 9 file, semua tombol dalam grup link ke file yang sama, judul player menipu (`find` ketemu episode pertama), 10 tombol nyala aktif sekaligus, React key duplikat.

Aturan final dari user: Web = HANYA yang ada di Vidara. Menu tetap pakai Episode (range). Kedepannya migrasi ke Part.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `hokidrama/src/lib/data.js` | D1: hapus fallback `media`-only di `queryAllDramas` (sumber daftar = `vidara_uploads` saja). D3: hapus `getTelegramParts`, `mintDeeplink`, `BOT_USERNAME`, field `playable`/`playUrl`. D6: `getVidaraEpisodes` return `parts[]` group-by-filecode `{filecode, embedUrl, eps, epStart, epEnd, count, label}` + sort by ep terkecil (group oleh agent user, sort oleh hermes) |
| `hokidrama/src/app/drama/[id]/page.js` | D2: hapus total section Telegram + param `tgpart`/`tgMode`; tanpa episode Vidara = `notFound()` (404). D4: hapus empty-state "Belum ada video". D7: render dari `v.parts` — 1 tombol per file, label range (`Ep 1–10`), key unik, 1 active, header `N video · M episode` |
| `hokidrama/src/components/DramaCard.jsx` | D3: hapus class `scanline` mati. D9: terima prop `query`, teruskan `&q=` ke link drama |
| `hokidrama/src/app/page.js` (homepage) | D9: teruskan `query` ke `DramaCard` supaya link drama bawa `?q=` |
| `hokidrama/src/app/drama/[id]/page.js` | D8+D9: tombol Kembali pakai `drama.source` dari DB (`/${drama.source}`), bukan param URL; kalau datang dari search (`?q=`) kembali ke `/?q=...`. Link antar-part (`?ep=`) pertahankan `qSuffix` supaya konteks search tidak hilang saat pindah video |
| `hokidrama/src/lib/data.js` (tidak diubah) | `posterFor` via `/api/file?file_id=` tetap hidup — poster via file_id boleh (aturan user) |

D5 visual (hero/grid) TIDAK dikerjakan — menunggu keputusan terpisah.

## Detail Teknis

- Group-by memakai `Map` keyed filecode, `epStart`/`epEnd` dari min/max ep numerik, label `Ep ${lo}–${hi}` (tunggal: `Ep ${lo}`). Sort eksplisit by `epStart` karena `ORDER BY ep` tidak menjamin urutan grup.
- `page.js` punya fallback 1-part-per-episode bila `v.parts` kosong (kompatibilitas).
- URL lama `?ep=<filecode>` tetap jalan (`find` by filecode ketemu part-nya).
- Tidak menyentuh: query lain, `/api/file` logic, deeplink mint di bot, skema DB, logika bot apapun.

## Verification

- `node --check` data.js OK, page.js OK (DramaCard.jsx tidak applicable — `.jsx` bukan JS murni).
- `npx next build` sukses, 8 halaman generate.
- Verifikasi curl halaman drama shortmax 852656: `Semua Video (9 video · 91 episode)`, 9 tombol range Ep 1–10 … Ep 81–91, Tepat 1 tombol active, nol sisa Telegram di HTML.
- PM2 `hokidrama` restart, status online.
- `grep` sisa `getTelegramParts|mintDeeplink|tgpart|tgMode|scanline|playable|playUrl|Belum ada video` di `src/` = nol.
