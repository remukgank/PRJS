# Proposal: Gaya Inline Menu (field `style`)

Tanggal: 26 Sep 2026 · Bot API 10.3 · belum diimplementasikan

## 1. Fakta(field `style`, sudah diverifikasi ke API)

Dokumentasi resmi `InlineKeyboardButton.style`:

> Optional. Style of the button. Must be one of "danger" (red), "success"
> (green) or "primary" (blue). If omitted, then an app-specific style is used.

Uji nyata ke API (bot pengujian, pesan uji dihapus):

| Nilai | Hasil |
|---|---|
| `primary` | OK |
| `success` | OK |
| `danger` | OK |
| (kosong) | OK — app-specific |
| `link` | **Ditolak** — `Invalid button style specified` |
| nilai lain | **Ditolak** |

Field `disabled` (baru di 10.3) bertipe `DisabledButton`; `{}` sudah cukup dan
**boleh dipadukan dengan `style`** (terverifikasi OK).

`KeyboardButton` (reply keyboard) punya `style` dengan 3 nilai yang sama, tetapi
**tidak** punya `disabled`.

Penting: `style` itu **warna**, bukan penanda aksi. Penentu jenis tombol tetap
`callback_data` / `url` / `web_app` / `disabled`.

## 2. Masalah sekarang

Dari 181 tombol di `scraper/bot.js` + `handlers/*`, hanya **4** memakai
`style` (keyboard target anime, baru dibuat) dan 3 memakai `disabled: {}`.
Semua menu lain masih monoton — tidak ada panduan visual mana aksi utama.

## 3. Aturan warna

| Warna | Arti | Contoh |
|---|---|---|
| `primary` (biru) | **satu** aksi utama per layar | `📚 Cari Drama/Anime`, `⬇️ Download Semua`, `🗜 Vidoy+TG — gabung 10` |
| `success` (hijau) | aksi yang menghasilkan berkas / upload | `📥 Telegram`, `🗜 Vidara — gabung 10`, `✅ Selesai` |
| `danger` (merah) | destruktif / matikan / hapus | `🗑️ Hapus Judul`, `🗑️ Ya, Hapus`, toggle yang sedang OFF |
| *(tanpa style)* | navigasi & informasi | `⬅️ Kembali`, `⬅️ Prev`, `Next ➡️`, `📄 1/3`, `💬 Live Chat` |
| `disabled: {}` | target belum terkonfigurasi | tombol upload Vidoy/Vidara mati |

Aturan tambahan:
- Maksimal **1** `primary` per keyboard — kalau lebih, tidak ada yang menonjol.
- Tombol navigasi tidak pernah diberi warna.
- Emoji dibedakan per jenis konten: `🗜` untuk drama (gabung 10), `📥` untuk anime
  (per episode). Tidak diubah pada proposal ini — hanya dicatat.

## 4. Pemetaan per menu

### Menu utama — `mainMenuKeyboard` / `replyMainKeyboard`
| Tombol | Style |
|---|---|
| 📚 Cari Drama/Anime · 📚 Katalog | `primary` |
| 🎬 Drama | `success` |
| 💎 VIP · ❓ Bantuan · 💬 Live Chat · 🛠 Admin Panel | — |

### Admin Panel — `adminPanelKeyboard` (dua definisi, keduanya harus sama)
| Tombol | Style |
|---|---|
| 💾 Simpan ke Library | `success` bila ON, `danger` bila OFF |
| 📚 Cari Drama/Anime | `primary` |
| 🤖 AI Endpoint · 🔑 AI Key · 🧠 AI Model | — |
| 🌐 Domain Vidara · 🗂 Vidoy Links · 📊 Status · ⭐ Saldo · ⬅️ Kembali | — |

### Aksi drama — `mainActionKeyboard('drama')`
| Tombol | Style |
|---|---|
| 🗜 Vidoy+TG — gabung 10 | `primary` |
| 🗜 Telegram / 🗜 Vidara / 🗜 Vidara+TG — gabung 10 | `success` |
| ⚙️ Opsi per episode · 🔢 Pilih episode · 💬 Live Chat · 🏠 Menu Utama | — |

### Aksi anime — `mainActionKeyboard('anime')` + `animeTargetKeyboard`
| Tombol | Style |
|---|---|
| 📥 Vidoy + TG | `primary` |
| 📥 Telegram · 📥 Vidara + TG · 📥 Vidara + Vidoy | `success` |
| Yang tidak terkonfigurasi | `disabled: {}` (+ `style` ikut) |
| 🔢 Pilih episode · 💬 Live Chat · 🏠 Menu Utama · ⬅️ Kembali | — |

### Picker episode — `lib/samKeyboard.buildPicker` + tombol server
| Tombol | Style |
|---|---|
| ⬇️ Download Semua (N) | `primary` |
| ⬇️ Gofile / Krakenfiles / Pixeldrain / Filedon | `success` |
| Tombol episode (1, 2, 3, …) | — |
| ⬅️ Prev · 📄 1/3 · Next ➡️ · ⬅️ Kembali | — |

### Library — `handlers/library.js`
| Tombol | Style |
|---|---|
| ✅ Selesai | `success` |
| 🗑️ Hapus Judul · 🗑️ Hapus Ep · 🗑️ Ya, Hapus | `danger` |
| ⬅️ Prev · ⬅️ Kembali | — |

### Panel Vidoy — `handlers/admin.js`
| Tombol | Style |
|---|---|
| 🔄 Perbarui Semua · 🔄 Perbarui #n | `primary` |
| ⬅️ Kembali | — |

### Lain-lain
| Tombol | Style |
|---|---|
| 📥 Download: … (titlePrompt) | `primary` |
| ✏️ Ganti Judul | — |
| 💳 Tarik Saldo via Fragment | `primary` |
| ⭐ paket VIP | `success` |

## 5. Rencana implementasi

1. Helper terpusat `scraper/lib/btn.js`:
   - `btn(text, data, style)` — tombol aksi
   - `btnOff(text)` — `disabled: {}` (+ style opsional)
   - `nav(text, data)` — navigasi tanpa warna
   - `grid(rows)` — penjaga struktur row (array of Object) agar bug
     "InlineKeyboardButton must be an Object" tidak terulang
2. Ganti setiap keyboard agar memakai helper + pemetaan di atas.
3. Hapus duplikasi `adminPanelKeyboard` (bot.js & handlers/admin.js) — satu
   sumber kebenaran.
4. Tes:
   - semua nilai `style` hanya dari `primary|success|danger`
   - maks 1 `primary` per keyboard
   - navigasi tanpa style
   - struktur row valid + `callback_data` 1–64 byte
   - golden test untuk 3–4 menu utama

## 6. Risiko & catatan

- `style` hanyaURRENT tersedia di klien Telegram yang mendukung 10.3; klien lama
  mengabaikan field ini (aman — tidak error).
- Tombol `disabled: {}` tetap bisa di-style (terverifikasi).
- Reply keyboard: hanya `style`, tanpa `disabled`.
- Perubahan ini murni visual; tidak menyentuh `callback_data` sehingga alur
  callback tidak berubah.
