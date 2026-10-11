# Audit — Menu 👤 Akun Vidara: kuota harian per akun (N/200) + status limit

**Tanggal:** 11 Okt 2026
**Status:** ✅ Di-approve user, diimplement, diuji (7/7 + regresi 66 pass)
**Scope:** `scraper/db.js`, `scraper/bot.js`, `.tests/vidara-quota-menu.js`

---

## 1. Hasil trace endpoint quota (sebelum implement)

Permintaan user: tampilkan sisa quota harian langsung dari server.

| Sumber yang dicoba | Hasil (11 Okt 2026) |
|---|---|
| API `api.vidara.so/v1`: `/user` `/me` `/account` `/quota` `/limits` `/usage` `/stats` `/docs` `/openapi.json` | **semua `404 page not found`** |
| Dashboard `vidara.to` (session login valid): `/index` (17 KB), `/profile`, `/account`, `/user` | **tidak ada info quota** — tidak ada "N/200", kata quota/limit, atau data embed |
| XHR `vidara.to/api/*` | **404** |
| Pesan error saat limit kena | hanya `"resets at 00:00 UTC"` — **tanpa angka sisa/terpakai** |

**Kesimpulan:** server Vidara tidak menyediakan sisa quota lewat jalur apa pun.
Satu-satunya sumber angka akurat = **hitungan bot sendiri** atas file yang
benar-benar masuk, plus flag saat API menolak (limit kena).

## 2. Desain implement

- **Counter per akun** — `bot_settings`: `vidara_daily_count:<idx>:<YYYY-MM-DD UTC>`.
  Tanggal UTC ganti = key beda → **reset otomatis**, sinkron dengan reset server
  (00:00 UTC). Tanpa cron.
- **Inkrement otomatis** di `saveVidaraUpload` (db.js) — satu titik untuk SEMUA
  jalur upload (per-episode, batch, fallback vv). **Hanya baris BARU** yang
  dihitung (`RETURNING (xmax = 0) AS inserted`) — overwrite re-upload tidak
  menggandakan hitungan.
- **Menu** (`bot.js`, `vidaraAccountMenuView`):
  ```
  👤 Akun Vidara — upload selalu pakai akun aktif
  (1 judul full = 1 akun, tanpa rotasi otomatis)

  ▸ Akun 1 (user_one) · aktif
    📤 hari ini 12/200 · 🟢 sisa 188

  ▸ Akun 2 (user_two)
    📤 hari ini 200/200 · 🔴 limit kena · reset 17:00 WIB
  ```
- **Tombol**: pilih akun `success` (aktif) / `danger` (kena limit) ·
  **🔄 Refresh kuota** (edit in-place, fallback pesan baru). Ganti akun juga
  meng-edit menu di tempat (✅ pindah) — tidak membanjiri chat.
- **Patuh §4**: `primary` tidak dipakai sama sekali di menu (maks 1/papan),
  `callback_data` tetap pola string (`vidara_acc:<idx>`), `inline_keyboard`
  = array of row ✓.

## 3. Bukti

- `node --check` db.js + bot.js ✓
- `.tests/vidara-quota-menu.js` **7/7** — key format UTC, counter 0→3,
  insert-vs-overwrite (xmax), isolasi tanggal, struktural menu + db + style
- Regresi: `test-batch-quota` 19/19 · `test-vidara-anime` 26/26 ·
  `vidara-multi-account` 9/9 · `test-media-contract` 12/12

## 4. Batasan (jujur)

Angka = upload **lewat bot**. Upload manual via web Vidara tidak terhitung
(memang tidak bisa dibaca dari mana pun — lihat §1). Untuk alur kerja
(semua upload via bot) angkanya akurat 100%. Kalau nanti Vidara menambah
endpoint quota, tinggal ganti sumber angka di `vidaraAccountMenuView`.
