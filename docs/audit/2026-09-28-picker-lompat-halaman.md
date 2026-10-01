# 2026-09-28 — Tombol lompat halaman picker (First/Last/±10)

## Masalah

Ke page 59 butuh 59× tap Prev/Next. Log produksi 28 Sep: ~100 tap untuk sampai
page 26 (kamenime) dan page 32 (samehadaku), 7 menit. Ack cepat + cache sudah
ada — tapi aritmetikanya tidak bisa menang: 59 tap × 1-2 detik = 2-5 menit
menekan tombol. Itu bukan lambat, itu desain yang salah.

## Perbaikan (1 file: `scraper/lib/samKeyboard.js`, fungsi nav builder)

Nav row sekarang (maksimal 7 tombol, kondisi menjaga tidak ada yang invalid):

```js
if (p > 0) nav.push({ text: '⏮', ... `page:0` });              // First
if (p >= 10) nav.push({ text: '⏪10', ... `page:${p-10}` });    // -10
if (p > 0) nav.push({ text: '⬅️ Prev', ... });                  // tetap
nav.push({ text: `📄 ...`, ... });                              // tetap
if (p < totalPages-1) nav.push({ text: 'Next ➡️', ... });       // tetap
if (p + 10 < totalPages) nav.push({ text: '10⏩', ... });       // +10
if (p < totalPages-1) nav.push({ text: '⏭', ... `page:${last}` }); // Last
```

Tidak ada perubahan handler — semua callback memakai format `page:urlId`
yang sudah ada. Satu tempat (`prefix` param) memperbaiki 3 provider
sekaligus. Batas 64 byte aman (angka saja, sudah diuji).

Contoh: page 0 → Last = page 59 dalam **1 tap**. Page 30 → terlihat semua 7.

## Test yang diperbarui (bukan regresi)

`test-picker-halaman.js` mengunci jumlah tombol nav lama:

- halaman terakhir: `here.length === 2` → sekarang 4 (First + -10 + Prev + Number)
- page 0: 2 tombol → sekarang 4 (Number + Next + +10 + Last)
- `.find()` tombol nav pertama untuk cek Prev → sekarang menemukan First;
  diganti cari spesifik callback Prev

Semuanya diperbarui dengan komentar alasan, bukan dihapus. Plus blok §6 baru:
7 tombol di tengah menunjuk page yang benar; tidak ada page negatif/overflow;
semua callback ≤ 64 byte.

Hasil: 189 pass / 0 fail (dari 173).

## Suite

```
TOTAL 536 pass / 3 fail
```

Tiga FAIL hanya `test-kamenime-batch.js` (5, 6, 11) — test merah user yang
sudah diketahui. Tidak terkait.

## Tidak dilakukan (instruksi user)

Restart (Workflows) dan commit (user setelah verifikasi manual).

---

## Follow-up: label pendek (nav + episode) — screenshot membuktikan truncate

### Bukti visual (attached_assets, 28 Sep)

Screenshot picker One Piece halaman terakhir dan pertama:

- Nav (4 tombol saja): `⏮ | ⏪10 | ⬅️ Pr... | 📄 59...` — "Prev" dan "59/59" terpotong jadi `...`
- Episode: `Ep ...` semua (1161-1180) — "Ep 1161" (7 char) tidak muat di 1/5 lebar
- Episode 1-9 tampil angka, 10+ jadi `...` — batasnya ~5 char di layar user

Jadi baris 7-tombol yang baru ditambah tidak akan terbaca. Dan user benar:
tombol lompat "tidak kelihatan" di halaman selain 1 — karena terpotong jadi
`...` yang tak terbaca, plus episode ikut tak terbaca ("berantakan").

### Perbaikan label nav: kata → simbol

```js
// sebelum: ⏮ ⏪10 ⬅️ Prev | 📄 17/59 | Next ➡️ 10⏩ ⏭  (terpotong)
// sesudah: ⏮ ⏪ ⬅️ | 17/59 | ➡️ ⏩ ⏭                    (simbol/angka saja)
```

Callback_data TIDAK berubah — hanya teks tampil. Test §7 baru mengunci:
tidak ada kata Prev/Next/📄, maksimal 6 char per label, urutan persis per
halaman (0/30/58).

### Perbaikan label episode: buang "Ep " + spasi

```js
// sebelum: `Ep ${ep}` / `📨 ${ep}`  → "Ep 1161" terpotong
// sesudah: `${ep}` / `📨${ep}`      → "1161" / "📨1161"
```

Callback tidak berubah (risiko nol). Dua test yang mengunci format lama
diperbarui dengan alasan tertulis:
- `test-vidoy-uploader.js`: `startsWith('Ep ')` → `/^\d+$/`
- `test-vidoy-uploader.js` KRITIS: regex label Telegram menerima tanpa spasi

Catatan gaya: kode asli memakai escape (`\ud83d\udce8`), edit pertama saya
memakai emoji literal (📨) sehingga regex test tidak cocok. Dikembalikan ke
escape tanpa spasi — gaya konsisten, test hijau (164 pass).

### Hasil

```
test-picker-halaman   222 pass / 0 fail  (189 + 33 label)
test-vidoy-uploader   164 pass / 0 fail
TOTAL                 536 pass / 3 fail (hanya test merah kamenime-batch)
```

---

## Info: limit Vidoy 1.900.000.000 byte (~1812 MiB) — GAP 188 MiB

User menginformasikan 28 Sep: limit upload Vidoy = 1.900.000.000 byte.

```
Vidoy limit : 1.900.000.000 byte = ~1812 MiB
Bot limit   : MAX_UPLOAD_MB = 2000 MiB (bot.js:136, saat LOCAL_API_PORT ada)
GAP         : ~188 MiB (197.152.000 byte)
```

**Konsekuensi yang belum ditangani:** file 1812–2000 MiB dengan target `vyt`/`vv`
akan lolos cek `MAX_UPLOAD_MB`, terdownload penuh, terkirim ke Telegram OK,
lalu **gagal di upload Vidoy** — buang bandwidth + status parsial membingungkan
(Telegram ✅, Vidoy ❌ tanpa pesan yang jelas).

`vidoyService.js` tidak punya cek ukuran pra-upload. Guard yang disarankan
(belum diimplementasikan): batas khusus Vidoy ~1800 MiB (margin aman dari
1812) dicek sebelum download untuk target `vyt`/`vv`, dengan pesan yang jelas
("file X MiB melebihi limit Vidoy 1812 MiB — pilih Telegram saja").
