# 2026-09-28 — Ack cepat di handler navigasi picker (anti "macet saat ditekan")

## Gejala (log produksi, bukan teori)

```
11:43:48 sam_page:16:19
11:43:50 sam_page:16:19
11:43:52 sam_page:16:19   (×12 dalam 27 detik, tanpa perubahan terlihat)
```

User menekan tombol berkali-kali karena tidak ada respon. Tidak ada error di
log — bot diam, bukan crash.

## Akar cause (tiga lapis)

**Lapis 1 — tidak ada ack cepat.** `sam_page:`/`kam_page:`/`kur_page:` tidak
memanggil `answerCallbackQuery` di awal. Ack hanya ada di jalur gagal (bukan
admin / link kadaluarsa). Yang dikerjakan pertama: `editMessageText` + fetch
provider + query DB + render. Spinner Telegram muter terus → user mengira tap
tidak masuk → tap berulang → tiap tap antre full render baru → makin lambat.

**Lapis 2 — tombol number menipu (bukan bug, tapi pemicu).** `📄 17/59`
callback-nya `sam_page:16:19` — render ulang halaman yang sama. Hasil edit
identik → Telegram tolak "message is not modified" → ditangkap diam-diam →
tidak ada perubahan terlihat → user tap lagi. 12× `16:19` kemungkinan tombol
ini, bukan Next yang rusak.

**Bukan penyebab (dikoreksi dari diagnosis awal):** fetch ulang tiap tap.
`sam_page:` SUDAH memakai `samehadakuEpisodesCache` (TTL 10 menit) — diagnosis
awal yang menyebut tidak pakai cache salah karena filter `rg` menyembunyikan
baris cache-nya. `kam_page` dan `kur_page` juga sudah pakai cache masing-masing.
Jadi satu-satunya yang hilang hanya ack.

## Perbaikan (3 baris, 1 pola)

Setelah cek admin, sebelum kerja lambat, di ketiga handler:

```js
bot.answerCallbackQuery(query.id).catch(() => {});
```

Tanpa `await` (fire-and-forget), tanpa return — spinner berhenti <100ms walau
render masih jalan. Komentar yang sama di ketiga tempat supaya alasan tidak
hilang. Tombol number tidak diubah: setelah ack cepat + cache hit, tap-nya
jadi murah dan tidak merusak apa-apa.

## Test: `scraper/tests/test-picker-ack.js` (baru, 7 pass)

Per handler: ack ada SEBELUM semua kerja lambat (fetch/render/DB/edit);
ack tidak di-await; urutan admin → ack → kerja terjaga.

Mutasi (hapus 1 ack): 5 pass / 2 fail. Pulih: 7 pass.

## Suite

```
TOTAL 536 pass / 3 fail
test-picker-ack    7 pass / 0 fail   (baru)
```

Tiga FAIL hanya `test-kamenime-batch.js` (5, 6, 11) — test merah user untuk
koreksi #3 yang belum diimplementasikan. Tidak terkait.

## Tidak dilakukan (instruksi user)

Restart (bot via Workflows, user yang restart) dan commit (user yang commit
setelah verifikasi manual).
