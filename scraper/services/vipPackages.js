// services/vipPackages.js - source tunggal paket VIP & harga (IDR QRIS + Stars).
// Aturan harga: ~Rp 1.000/hari, makin lama makin murah per hari,
// nominal QRIS harus kelipatan 1.000 (batas minimum Saweria), minimum 1⭐.
const VIP_PACKAGES = {
  1: { price: 1000, label: '1 Hari' },
  3: { price: 3000, label: '3 Hari' },
  7: { price: 5000, label: '7 Hari' },
  15: { price: 9000, label: '15 Hari' },
  30: { price: 15000, label: '30 Hari' },
  60: { price: 27000, label: '60 Hari' },
  90: { price: 38000, label: '90 Hari' },
};

const VIP_STAR_PRICES = { 1: 1, 3: 3, 7: 5, 15: 9, 30: 15, 60: 27, 90: 38 };

const VIP_PACKAGE_ORDER = [1, 3, 7, 15, 30, 60, 90];

module.exports = { VIP_PACKAGES, VIP_STAR_PRICES, VIP_PACKAGE_ORDER };