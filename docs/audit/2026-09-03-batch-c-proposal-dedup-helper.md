# Proposal Batch C — Dedup Helper detectTitleFromFilename (H2)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum diimplementasikan, menunggu approve

## Latar Belakang

Duplikasi logic auto-detect judul di 4 handler (`handleGofileUrl` direct, `handleGofileUrl` share, `handlePixeldrainUrl`, `handleGdriveUrl`) — masing-masing mengulang blok `extractSourcePattern` → `findMediaByPattern` → fallback `parseSamehadakuFilename` + alias lowercase. Tiap fix (mis. Batch B case-insensitive, fix uncensored) harus diedit di 4 tempat → rawan inkonsistensi (H2).

## Proposal

Ekstrak helper terpusat `detectTitleFromFilename(fileName)` yang encapsulate 2 level auto-detect, ganti 4 call site jadi 1 baris.

### 1. Signature Helper

```js
// scraper/lib/titleDetect.js (baru) atau scraper/db.js
async function detectTitleFromFilename(fileName): Promise<{
  title: string|null,
  pattern: string|null,   // pattern yang match (untuk log)
  source: 'pattern'|'samehadaku-short'|null
}>
```

Return `title` untuk `customTitle`, `pattern`/`source` opsional untuk log yang sekarang ada di tiap handler.

Implementasi helper:

```js
async function detectTitleFromFilename(fileName) {
  const pattern = extractSourcePattern(fileName);
  if (pattern) {
    const m = await findMediaByPattern(pattern).catch(()=>null);
    if (m) return { title: m.nama, pattern, source: 'pattern' };
  }
  const gdSame = parseSamehadakuFilename(fileName);
  if (gdSame?.short) {
    for (const prov of ['kuronime','samehadaku']) {
      const m = await findMediaByPattern(`${prov}-${gdSame.short}`).catch(()=>null);
      if (m) return { title: m.nama, pattern: `${prov}-${gdSame.short}`, source: 'samehadaku-short' };
    }
  }
  return { title: null, pattern: null, source: null };
}
```

### 2. 4 Call Site yang Diganti

| Handler | Lokasi | Sebelum | Sesudah |
|---------|--------|---------|---------|
| `handleGofileUrl` direct | `scraper/bot.js:1904-1928` | blok `if (!customTitle) { extractSourcePattern → findMedia... → parseSamehadaku... }` | `const { title } = await detectTitleFromFilename(fileName); if (title) customTitle = title;` |
| `handleGofileUrl` share | `scraper/bot.js:2044-2064` | sama (pakai `file.name`) | sama |
| `handlePixeldrainUrl` | `scraper/bot.js:2249-2269` | sama | sama |
| `handleGdriveUrl` | `scraper/bot.js:2561-2575` | sama | sama |

**Tidak termasuk** (sengaja):
- `handleFiledonUrl` (2408) — sudah benar dengan pola `fdSame?.episode ?? ...`, bukan H2
- `handleGofileBatch` (2163) — batch multi-file tanpa auto-detect judul
- Title prompt callbacks (4830, 4837) — flow `dl_title_use`, bukan download handler

### 3. Fallback parseSamehadakuFilename — Digabung ke Dalam Helper

Ya, digabung di helper (level 2 di atas), bukan terpisah di call site. Call site tidak perlu lagi `if (!customTitle && gdSame?.short) { ... }` — helper sudah handle.

### 4. Skenario Test

Minimal nutup 4 provider + bug samehadaku:

- GoFile direct: `TSSDK-S2-P2-1-FULLHD-SAMEHADAKU.VIP.mp4` → `kuronime-tssdk` (case-insensitive, Batch B) → match `Tensei S...`
- GoFile share: `1080p-...-kuronime-kjny03unc.mp4` → `kuronime-kjny` → match Kaifuku (fix uncensored)
- Pixeldrain: `GKsTIeO-S2-5-FULLHD-SAMEHADAKU.CARE.mp4` → fallback `kuronime-gkstieo` → match Gaikotsu S...
- GDrive: `TsSDKMGnoKh-FULLHD-SAMEHADAKU.CARE.mp4` → mixed case `TsSDKMGnoKh` → match via Batch B
- Negative: `random-unknown-xyz.mp4` → return null (tidak throw)

## Risiko

- Rendah — hanya ekstraksi helper, tidak ubah query/logic. 4 call site jadi konsisten, mengurangi risiko H2 regresi.
- Dependensi: Batch B harus selesai dulu (sudah, case-insensitive aktif).

## Keputusan

Tunggu approve sebelum implement. Setelah approve → implement 1 commit, `node --check` + functional test 4 provider di atas, log perubahan.
