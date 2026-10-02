# 2026-10-02 — Domain aktif Vidara diprioritaskan di link embed (approve owner)

**Date**: 2026-10-02
**Author**: opencode
**Approve user**: "Approve dan lanjutkan `node --check` HARUS clean… ikuti semua aturan."

## Root Cause

UI admin "🌐 Domain Vidara" (bot.js `pendingVidaraDomain`) berjanji:

> Domain akan dipakai untuk generate link embed: `https://<domain>/e/<filecode>`

Setting tersimpan benar (`bot_settings.vidara_active_domain = iosbgaigo.com`),
tapi implementasi **mengutamakan domain dari respons API** sehingga link & record
tetap `vidara.to`:

| # | Lokasi | Sebelum |
|---|--------|---------|
| 1 | `vidoy.js` upload branch | `out.vidaraLink = v.link` → `buildVideoLink(ref, info.link)` — `apiLink` menang |
| 2 | `vidoy.js` host record | `v.host \|\| getVidaraActiveDomain()` — `v.host` menang → semua record DBZ `domain = vidara.to` |
| 3 | `vidaraLinkFromRecord` | pakai `rec.domain` saja, tidak baca setting |

Jalur drama (`vidara.js` `saveDomain` = `getVidaraActiveDomain() || …`) sudah
benar sejak awal — bukti memang dua jalur beda kebijakan.

## Keputusan

- **Active domain = prioritas** di ketiga titik vidoy.js (kontrak UI menang atas
  "domain dari server sendiri").
- **Record DB tidak diubah** — tetap bukti domain saat upload (aturan §6 tidak
  terpengaruh); yang dibentuk ulang hanya link publik + domain record BARU.
- `vidaraLinkFromRecord(rec, activeDomain = '')` — **param opsi, fungsi tetap
  sync** → pemanggil lama & test lama (`runExtracted`) kompatibel.
- Fallback tetap ada: tanpa setting → perilaku lama persis (`v.link` /
  `rec.domain`).

## Verifikasi keamanan (bukan asumsi)

- **HEAD live**: `vidara.to/e/zLxZ993QBiY4e` = **200**, `iosbgaigo.com/e/zLxZ993QBiY4e`
  = **200** — filecode lintas-domain hidup, mengganti host link aman.
- Input UI dinormalisasi handler (`bot.js:2413`: strip `https?://` + trailing
  `/`) → activeDomain = hostname murni; test #7 tetap menguji defensif strip.

## Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/handlers/vidoy.js` | `vidaraLinkFromRecord(rec, activeDomain)` · 2 pemanggil bawa `(await getVidaraActiveDomain())` · upload branch: `out.vidaraLink` & `host` record prioritaskan `activeDomain` |
| `.tests/vidara-active-domain.js` (baru) | 10 tes: 4 sumber statis · 4 fungsi asli (extract, tanpa mock) · 1 `buildVideoLink` · **1 LIVE HEAD 200** |
| `.tests/caption-server-line.js` | guard regex → `\(preVidara[,)]` (argumen ke-2 aktif — guard tetap memaksa `preVidara` argumen pertama) |

`node --check scraper/handlers/vidoy.js` + `.tests/vidara-active-domain.js` lulus.

## Test

- `.tests/vidara-active-domain` **10/0** · `vidara-embed-link` 16/0 ·
  `caption-server-line` **13/0** · `status-tg-proof` 7/0
- `test-vidara-anime` 25/0 · `test-media-contract` 12/0 ·
  `test-episode-status` 11/0 · `test-btn-style` 10/0 ·
  `test-vidoy-uploader` 164/0 · `test-all-subdomains` exit 0 (live)
- **Total 358 pass, 0 fail.**

## API cross-check

Scope **tidak menyentuh Bot API Telegram**: tidak ada method/param baru, struktur
caption & `parse_mode` identik, kontrak media §5 (5 baris, `Server :- …`, label
= domain asli URL) tidak berubah — hanya nilai host domain mengikuti setting.
Endpoint Vidara (`/video/info` dsb.) tidak berubah; hanya prioritas hasilnya.

## Catatan

- Setelah owner **run ulang** bot (start = owner, AGENTS §3): episode baru →
  link `https://iosbgaigo.com/e/<code>`; episode lama (skip) ikut domain aktif
  saat caption dibangun ulang; record lama TIDAK ditimpa sampai ada upload baru.
- 409 awal (2 instance: 2721 + 3236) sudah beres — 1 instance, milik owner.
