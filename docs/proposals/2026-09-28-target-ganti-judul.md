# Proposal — Target picker untuk "Ganti Judul" di provider langsung

**Tanggal:** 2026-09-28
**Status:** menunggu approve — kode BELUM disentuh
**Estimasi:** ±45 baris di `scraper/bot.js`, plus test

## 1. Bug yang dilaporkan

Ochi, 28 Sep 22:43:

```
> https://drive.usercontent.google.com/download?id=1APT8QPCKvF9oQ3t92FQLnaK4u8w2qg7r&export=download&authuser=0
> One Piece
> 📥 Download dengan judul: One Piece
> ✅ One Piece — Selesai
> 📊 1 episode · 239 MB · 1✓
> Total: 1 episode · 239 MB · Berhasil 1 · ⏱️ 00:22
```

Dia mengirim link gdrive, menekan **Ganti Judul**, mengetik `One Piece` — dan bot **langsung mengunduh serta mengirim ke Telegram**, tanpa pernah menanyakan target.

Dia mengharapkan target picker muncul, tapi tidak. Intinya: **setiap link dari provider langsung yang pakai "Ganti Judul" langsung mengunduh ke Telegram, tanpa pilihan target sama sekali.**

## 2. Root cause (terverifikasi di kode)

`scraper/bot.js` baris 2556-2582, blok "Pending download: custom title input":

```
2564  if (pending.handler === 'gofile')     return handleGofileUrl(..., customTitle);
2565  if (pending.handler === 'pixeldrain') return handlePixeldrainUrl(..., customTitle);
2566  if (pending.handler === 'gdrive')     return handleGdriveUrl(..., customTitle);
2567  if (pending.handler === 'filedon')    return handleFiledonUrl(..., customTitle);
2568  if (pending.handler === 'kamenime') {
2569    // Jangan langsung unduh — user masih harus memilih target (Telegram /
2570    // Vidoy+TG / Vidoy). Judul kustom disimpan, nanti dibaca dl_go.
2571    rememberCustomTitle(pending.url, customTitle);
2576    reply_markup: { inline_keyboard: animeTargetKeyboard(
2577      `dl_go:tg:${kmUrlId}`, `dl_go:vyt:${kmUrlId}`, `dl_go:vv:${kmUrlId}`) }
2582  if (pending.handler === 'mega')       return handleMegaUrl(..., customTitle);
```

Baris 2569-2570 **sudah menjelaskan niat yang benar** — dan penerapannya hanya di
kamenime. Lima provider lain (`gofile`, `pixeldrain`, `gdrive`, `filedon`, `mega`)
tetap langsung mengunduh. Ini inkonsistensi terhadap comentario yang sudah ada di
kode, bukan keputusan desain.

**Five provider, bukan empat** — koreksi terhadap catatan awal saya.

### 2.1 Konsekuensi §6 (ini yang serius)

Karena jalur ini tidak pernah menanyakan target, kode PRJS tidak bisa Inhibition
"hanya Telegram" untuk provider langsung di menu "Ganti Judul". Hasilnya selalu
download + kirim Telegram, dan `handleGdriveUrl` juga meng-upload ke Vidoy
sehingga file tetap muncul di sana (§6: satu episode satu file).

### 2.2 `opts` di `handleGdriveUrl` tidak dipakai

```
scraper/handlers/download.js
  async function handleGdriveUrl(chatId, url, customTitle = null, opts = {})
  ...
  opts. → 0 kemunculan di dalam fungsi
```

Parameter `opts` ada di signature tapi tidak pernah dibaca. Ini bukti tambahan
bahwa jalur "pilihan target" memang belum dirancang untuk handler ini.

## 3. Yang sudah ada dan bisa dipakai (tanpa kontrak baru)

`dl_go:` handler **sudah mendukung keenam provider**. `bot.js` baris 4650-4673:

```
target === 'tg'  →  isGofileUrl / isGdriveUrl / isPixeldrainUrl /
                    isFiledonUrl / isKamenimeUrl / isMegaUrl
target vyt / vv  →  resolveDirectUrl(url)  (mencakup keenam provider)
```

`dl_go:` juga sudah membaca judul kustom dengan benar (`takeCustomTitle`, baris
4642) dan `rememberCustomTitle` sudah dipakai di kamenime (baris 2571).

Artinya perbaikannya **tidak menyentuh kontrak baru** — hanya memakai kembali
jalur yang sudah ada dan sudah dipakai kamenime.

## 4. Rencana

Ubah blok baris 2564-2582 jadi satu jalur untuk semua provider:

```
2564  const handler = pending.handler;
      // Simpan judul dulu, lalu tanyakan target — sama untuk SEMUA provider.
      // Tidak ada provider yang boleh langsung unduh di sini.
      rememberCustomTitle(pending.url, customTitle);
      const urlId = cacheUrl(pending.url);
      return bot.sendMessage(chatId,
        `📥 <b>${labelProvider}</b>\n\n➧ Judul :- <b>${escHtml(customTitle)}</b>\n\nPilih target:`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: animeTargetKeyboard(
              `dl_go:tg:${urlId}`, `dl_go:vyt:${urlId}`, `dl_go:vv:${urlId}`) } });
```

Yang berubah: **5 cabang `return handle...` jadi 1 jalur keyboard.**

Tidak berubah: `dl_go:` handler, `animeTargetKeyboard`, `rememberCustomTitle`,
semua handler `handle*Url`, dan format tombol.

## 5. Risiko — dan bagaimana mitigasi

### 5.1 Keyboard lama jadi tidak berlaku

Telegram tidak menghapus tombol yang sudah terkirim. Kalau ada pesan lama dengan
tombol `dl_title_use:1` di chat, masih bisa ditekan — dan itu sudah berlaku sekarang
(klik `dl_title_use:` tetap masuk ke preview target normal, jadi tidak rusak).

### 5.2 `handleMegaUrl` mungkin tidak punya jalur Vidoy

`resolveDirectUrl` untuk mega **tidak** mengembalikan URL langsung yang bisa
diupload (`mega.File` untuk streaming). Perlu diverifikasi sebelum commit: kalau
mega tidak bisa di-`vyt`, tombol Vidoy untuk mega harus disembunyikan — kalau tidak,
user menekan Vidoy dan dapat error.

**Ini yang harus diuji lebih dulu, sebelum touched.**

### 5.3 `provider` string untuk preview

`dl_title_use:` (baris 4616) sudah menghitung `provider` dari URL. Blok custom
title perlu nama provider yang sama agar preview konsisten.

## 6. Test yang harus ditulis

| # | test | yang dijaga |
|---|---|---|
| T1 | Custom title untuk keenam provider **wajib** menyimpan judul dulu | tidak ada `return handle*Url` langsung di blok custom title |
| T2 | `dl_go:tg` / `vyt` / `vv` terbentuk untuk keenam provider | keyboard benar |
| T3 | `dl_go:` membaca judul kustom untuk keenam provider | `takeCustomTitle` terpakai |
| T4 | `resolveDirectUrl` untuk mega | apakah Vidoy mungkin (untuk §5.2) |
| T5 | Tombol lama `dl_title_use:` tetap jalan | backward compatibility |

Wajib **mutasi**: setiap mutasi harus tertangkap `test-*.js` yang memanggil
fungsi produksi, bukan definisi salinan. Ini pelajaran dari 28 Sep: test yang
menyalin definisi terlihat hijau tapi tidak menguji apa pun.

## 7. Verifikasi manual

1. Kirim link gdrive → **Ganti Judul** → ketik judul → **harus muncul 3 tombol
   target** (Telegram / Vidoy+TG / Vidoy). Tidak langsung unduh.
2. Pilih **Telegram** → file terkirim ke Telegram, **tidak** masuk Vidoy.
3. Ulangi, pilih **Vidoy** → file masuk Vidoy, tidak terkirim Telegram.
4. Ulangi untuk `mega` — cek apakah Vidoy bisa (§5.2).
5. Pastikan tidak ada `✅ ... Selesai` yang muncul sebelum tombol ditekan.

## 8. Di luar scope (dilaporkan, tidak dikerjakan)

- `handleGdriveUrl` punya parameter `opts` yang tidak dipakai — kalau nanti perlu
  "hanya Vidoy saja tanpa Telegram", itu tempatnya. Sekarang belum ada kebutuhannya.
- `test-vidoy-listing` 9 fail pre-existing (terbukti `git stash`).
- Inconsistent `sam_all` (samehadaku) yang hanya cek `media_parts`, tidak pernah
  `vidoy_uploads` — `sam_allgo` tidak konsisten dengan `kam_allgo`.
