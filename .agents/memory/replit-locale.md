---
name: Replit locale
description: Locale yang tersedia di workspace Replit dan pilihan aman untuk konfigurasi shell.
---

Workspace Replit ini tidak menyediakan `id_ID.UTF-8`; locale yang tersedia mencakup `C.utf8` dan `en_US.utf8`.

**Why:** Menetapkan `LANG` atau `LC_ALL` ke locale yang tidak terpasang membuat setiap shell baru mencetak warning `setlocale`.

**How to apply:** Untuk konfigurasi project, gunakan `C.UTF-8` (atau nama locale yang dikonfirmasi lewat `locale -a`) dan validasi `.replit` sebelum menggantinya.