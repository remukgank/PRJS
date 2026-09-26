'use strict';

// Helper tombol Telegram (Bot API 10.3).
//
// `style` itu WARNA, bukan penanda aksi:
//   primary (biru)  → satu aksi utama per layar
//   success (hijau) → aksi yang menghasilkan berkas/upload
//   danger  (merah) → destruktif (hapus, toggle mati)
//   (kosong)        → navigasi/informasi
// Penentu jenis tombol tetap callback_data / url / web_app / disabled.
//
// Nilai style yang valid hanya 3 — "link" TIDAK ada di 10.3 (ditolak API).

const STYLES = new Set(['primary', 'success', 'danger']);

function btn(text, data, style) {
  const b = { text: String(text) };
  if (data !== undefined && data !== null) {
    const cd = String(data);
    if (!cd.length) throw new Error('callback_data kosong');
    if (Buffer.byteLength(cd, 'utf8') > 64) throw new Error('callback_data > 64 byte: ' + cd);
    b.callback_data = cd;
  }
  if (style !== undefined && style !== null) {
    if (!STYLES.has(style)) throw new Error('style tidak valid: ' + style);
    b.style = style;
  }
  return b;
}

// Navigasi: sengaja tanpa warna.
function nav(text, data) {
  return btn(text, data);
}

// Tombol mati (mis. Vidoy/Vidara belum dikonfigurasi). Boleh tetap diberi style.
function btnOff(text, style) {
  const b = { text: String(text), disabled: {} };
  if (style && STYLES.has(style)) b.style = style;
  return b;
}

// Penjaga struktur: Telegram menolak dengan "InlineKeyboardButton must be an
// Object" kalau ada array di dalam row. function animeTargetKeyboard() sudah
// mengembalikan array of rows, jadi pemanggil WAJIB spread, bukan bungkus lagi.
function grid(rows) {
  if (!Array.isArray(rows)) throw new Error('rows harus array');
  return rows.map((row) => {
    if (!Array.isArray(row)) {
      throw new Error('baris harus array of Object (bukan array of array): ' + JSON.stringify(row));
    }
    return row.map((b) => {
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        throw new Error('tombol harus Object: ' + JSON.stringify(b));
      }
      if (!b.text) throw new Error('tombol tanpa text');
      return b;
    });
  });
}

function kb(rows) {
  return { inline_keyboard: grid(rows) };
}

// Hanya untuk pengujian: berapa tombol primary dalam satu keyboard.
function countStyle(keyboard, style) {
  const rows = (keyboard && keyboard.inline_keyboard) || keyboard || [];
  let n = 0;
  for (const row of rows) for (const b of row || []) if (b && b.style === style) n++;
  return n;
}

module.exports = { btn, nav, btnOff, grid, kb, countStyle, STYLES };
