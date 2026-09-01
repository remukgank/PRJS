# Migrasi AI Chat: mimo → opencode (deepseek-v4-flash-free)

**Date**: 2026-07-30
**Author**: opencode

## Root Cause

Binary `mimo` tidak tersedia di environment (`spawn mimo ENOENT`) karena versi free-nya sudah ditutup. Bot crash setiap kali user mencoba AI Chat.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/ai.js` | Ganti binary, konstanta, flags, cara passing message, error messages |

## Detail Teknis

`opencode` v1.18.9 tersedia di environment dan format JSON output-nya kompatibel (`type: "text"`, `part.text`) — tidak perlu ubah parser.

| Aspek | Sebelum | Sesudah |
|-------|---------|---------|
| Binary | `mimo` | `opencode` |
| Env override | `MIMO_BIN`, `MIMO_MODEL` | `OPENCODE_BIN`, `OPENCODE_MODEL` |
| Default model | `mimo/mimo-auto` | `opencode/deepseek-v4-flash-free` |
| Flag perms | `--dangerously-skip-permissions` | `--auto` |
| Flag model | `--model` | `-m` |
| Flag session | `--continue --session id` | `--session id` |
| Input message | `proc.stdin.write(msg)` | positional arg terakhir di array spawn |
| Output parser | `parseMimoOutput` | `parseOpencodeOutput` (logika identik) |

Session continuity diverifikasi manual:
- Turn 1: `"Nama saya Budi"` → reply menyebut Budi ✅
- Turn 2: `--session <id>` + `"Siapa nama saya?"` → `"Budi."` ✅

## Verification

- `node --check scraper/ai.js` lulus
- Bot di-restart, polling aktif, DB initialized — tidak ada error
- `cost: 0` pada output opencode — model free terkonfirmasi
