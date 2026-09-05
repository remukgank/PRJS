---
name: FlareSolverr runtime
description: Batasan runtime FlareSolverr native di workspace Replit.
---

FlareSolverr native harus dipasangkan dengan Chromium dan library yang dibangun oleh setup solver, bukan Chromium lain yang ditemukan otomatis di `/repl/tools`. `undetected-chromedriver` juga mengharapkan `version_main` bertipe integer.

**Why:** Workspace menyediakan lebih dari satu Chromium; autodetection memilih versi berbeda dan menyebabkan driver gagal start atau status 127.

**How to apply:** Startup solver harus menetapkan `CHROME_BIN` ke path dari `.solver/paths.env`, mengisi `LD_LIBRARY_PATH` dari path yang sama, dan mengonversi major version ke integer hanya saat memanggil `uc.Chrome`.