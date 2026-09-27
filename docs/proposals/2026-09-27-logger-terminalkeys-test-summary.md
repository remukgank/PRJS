PROPOSAL — 2 item kecil: terminalKeys logger + ringkasan test yang menipu

Konteks: sesi opencode ses_f9e5474c9ffeoRyJV5yyQ1DI7m. Baca file ini = isi proposal.
Status: f4428ca sudah deployed & test hijau (371 pass). Dua item iniStubang.

ITEM 1 — terminalKeys: field log !dell/!vdell tidak terlihat di pm2 logs
MASALAH (verified)
scraper/logger.js:41 `const terminalKeys = [...]` — hanya field putih itu yang
dicetak ke terminal. Semua field baru dari f4428ca TIDAK ada di whitelist:
  q, hasil, slugs, rows, keys, media_key, terhapus, sisa, dari, fileTerhapus, gagal
Dampanya: di `pm2 logs` yang terlihat cuma `msg` + `chatId`. Log新一代 yang
paling berguna (berapa baris ketemu, berapa record tersisa setelah delete)
hanya ada di logs/app.log — padahal justru itu yang perlu dibaca cepat saat
debug !dell/!vdell.

SCOPE — 1 file: scraper/logger.js, hanya array terminalKeys (sekitar baris 41)
JANGAN sentuh logic logger lain, jangan sentuh bot.js.

ITEM
Tambahkan ke terminalKeys: q, hasil, slugs, rows, keys, media_key, terhapus,
sisa, dari, fileTerhapus, gagal.
Tambahkan juga 'part' dan 'ep' kalau belum ada (dipakai !vdell).

WAJIB
1. node --check scraper/logger.js
2. Bukti: jalankan 1 skenario log yang memuat field-field itu,.print apa yang
   muncul di output terminal (bukan hanya JSON penuh). Kalau tidak masuk
   terminal, test harus gagal.
3. Test: test-logger-terminal-keys.js — stub console, pastikan field di atas
   muncul di baris terminal dan field yang TIDAK di whitelist tetap tidak
   bocor. Print hasilnya.
4. Suite penuh tetap hijau (371 pass + test baru)
5. LOG di docs/audit/2026-09-27-logger-terminal-keys.md

ITEM 2 — ringkasan test-vidoy-uploader.js tercetak di tengah file
MASALAH (verified, dilaporkan olehmu sendiri)
scraper/tests/test-vidoy-uploader.js:479 mencetak "RESULT: 46 pass, 0 fail"
di tengah file, sementara ~80 test lagi jalan SETELAHNYA. Ringkasan yang
terlanjur dicetak selalu hijau walau ada FAIL sesudahnya — anyone yang scroll
tertipu, dan exit code tetap 0. Saya sendiri salah baca karena cuma grep
baris ringkasan itu (mengira 46, padahal sebenarnya 157 pass).

SCOPE — 1 file: scraper/tests/test-vidoy-uploader.js, HANYA bagian ringkasan.
JANGAN sentuh test case-nya.

ITEM
Pindahkan ringkasan ke AKHIR file, atau lebih baik HAPUS total dan biarkan
exit code yang jadi satu-satunya penentu. Pilih yang lebih aman; kalau hapus,
pastikan test runner/CLAUDE yang memanggil file ini tetap bisa Mendeteksi gagal
lewat exit code (cek pemanggilnya: package.json script / runner lain).

WAJIB
1. node --check scraper/tests/test-vidoy-uploader.js
2. Bukti: temporarily潮流 sisipkan 1 test yang PASTI FAIL di bagian akhir,
   jalankan, tunjukkan file reporting failure dengan benar (bukan hijau palsu),
   lalu kembalikan. Print output kedua percobaan.
3. Suite penuh tetap hijau (371 pass)
4. LOG: tambahkan di docs/audit/2026-09-27-dell-vdell-logging.md bagian
   tentang cacat test ini, dengan before/after.

DI LUAR SCOPE
bot.js, handlers/, providers/, downloader.js, vidaraService.js, gofile-worker.js,
jangan restart proses, jangan sentuh perintah !dell/!vdell (fitur, bukan logging).
