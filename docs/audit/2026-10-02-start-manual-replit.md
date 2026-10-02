# 2026-10-02 — Migrasi start bot Replit: pm2 → manual background + insiden 409 tiga instance

**Date**: 2026-10-02
**Author**: opencode

## Root Cause

Aturan lama AGENTS §3 (`start standar: pm2 start prjs-bot`) **tidak berlaku di
Replit** — user 2 Okt 2026: *"di Replit emang gaboleh pakai pm2"*. Karena itu
owner menjalankan bot secara **manual** (`node scraper/bot.js`), sementara
agent tetap mengikuti resep pm2 lama → **dua jalur start hidup berdampak
bergantian**:

| Waktu (2 Okt) | Kejadian |
|---|---|
| 06:11–06:36 | pm2 `prjs-bot` direstart 3× (4631 → 4953); setiap restart **meninggalkan proses yatim** yang tidak mati oleh SIGINT pm2 |
| 06:33 | Owner start manual di terminal (pts/4) → instance tambahan |
| 06:33–06:37 | **3 instance** → `409 Conflict: terminated by other getUpdates request` (polling error 39×) |
| 06:37 | Kill 2 yatim (4631, 4820) → tinggal 4953 (pm2) → 409 berhenti |
| 06:43 | Menurut prosedur baru: `pm2 delete prjs-bot` → start manual background (resep user, PID 5287) |
| 06:44 | **Workflow Run Replit** (`.replit:74` = `node scraper/bot.js`) nyala otomatis → PID 5335 (parent `pid2`, stdout pts/4) → 409 lagi (17×) |
| 06:46 | Kill 5335 → tinggal 5287 → sejak 06:47 **0×409** |

Bug sekunder: resep awal menyimpan `echo $!` = **PID wrapper `setsid`** (5284)
yang mati setelah fork → `kill $(cat …pid)` tidak mematikan bot (PID sejati
5287). PID file diperbaiki manual + resep AGENTS kini memakai `pgrep`.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `AGENTS.md` §3 | Ditulis ulang: **larangan pm2 di Replit**, resep start manual background (`setsid` + `logs/telegram-bot-manual.log`), PID wajib via `pgrep` (bukan `$!`), larangan menyalakan Workflow Run saat manual hidup, monitoring `tail -n` (bukan `tail -f`), stop via PID file |
| `.opencode/skills/audit-workflow/SKILL.md` | Sinkron: bagian deploy/restart pm2 diganti rujukan prosedur Replit manual (AGENTS §3) |
| `docs/audit/2026-10-02-start-manual-replit.md` | Dokumen ini |
| `logs/telegram-bot-manual.pid` | Diperbaiki: `5284` → `5287` (PID node sejati) |
| (server) pm2 `prjs-bot` | `pm2 delete` + `pm2 save` — daftar pm2 bersih |
| (server) proses | Dihentikan: 4631, 4820 (yatim pm2), 5335 (workflow Run ganda) |

## Detail Teknis

- Log proses manual **terpisah** dari pm2: `logs/telegram-bot-manual.log`
  (`logs/app.log` = era pm2, tidak lagi menerima tulisan bot manual).
- Workflow Run Replit = `.replit` baris 74: `args = "source /run/replit/env/latest && node scraper/bot.js"`
  → kalau dinyalakan bersamaan proses manual → 409. Dinyalakan/dihentikan
  owner dari UI.
- Infra yang **tidak** disentuh: `9router` (PID 205), `telegram-bot-api` local
  (PID 179, port 9091), FlareSolverr.
- DeprecationWarning `deleteWebHook(...)` (node-telegram-bot-api) = kosmetik.

## Verification

- `kill -0 5287` → bot manual hidup; **tepat 1** proses `scraper/bot.js`.
- `409 Conflict` = **0** sejak 06:47 (polling normal).
- Functional live: aksi user `ep=2 Dragon Ball` (06:50) → download 53,7 MB
  selesai → `Vidara dilewati — file sudah ada` (aturan anti-duplikat jalan).
- `logs/telegram-bot-manual.pid` = `5287` → perintah kill dari AGENTS §3
  terverifikasi mematikan proses yang benar.
- AGENTS §3 & SKILL.md tidak lagi menyebut pm2 sebagai jalur start.
