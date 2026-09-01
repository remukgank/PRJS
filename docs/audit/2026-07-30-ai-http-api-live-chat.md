# Migrasi AI: spawn opencode → HTTP API + rebrand ke Live Chat

**Date**: 2026-07-30
**Author**: opencode

## Root Cause

1. **`opencode` spawn hang**: `child_process.spawn` dengan `--auto` flag membaca stdin, hang saat stdin berupa pipe. Fix awal `proc.stdin.end()` masih rawan.

2. **Akses filesystem+shell**: spawn `opencode` memberi akses penuh ke fs dan shell via `--auto` — tidak aman untuk publik.

3. **Branding "AI"**: teks user-facing mengandung "AI" dan "asisten AI", tidak cocok untuk live chat publik.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/ai.js` | Hapus `child_process.spawn`, ganti `axios.post` ke Zen API `/zen/v1/chat/completions`. Cascade 7 model gratis. Tanpa auth. |
| `bot.js` | Hapus `mimoSessionId`, `dir`, session tracking. Hapus admin check. Ganti teks AI → Live Chat. `markdownToHtml` tambah `\n\n` → `<br><br>`. |
| `scraper/bot.js` | Sama seperti bot.js |

## Detail Teknis

### scraper/ai.js — rewrite total

```js
// Sebelum: spawn opencode binary
const proc = spawn('opencode', ['run', '--format', 'json', '-m', model, '--auto', ...]);

// Sesudah: HTTP POST ke Zen API
const res = await axios.post('https://opencode.ai/zen/v1/chat/completions', {
  model: 'deepseek-v4-flash-free',
  messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: question }],
});
```

Model cascade (7 model gratis, prioritas kecerdasan):
1. `deepseek-v4-flash-free`
2. `nemotron-3-ultra-free`
3. `big-pickle`
4. `mimo-v2.5-free`
5. `laguna-s-2.1-free`
6. `ling-3.0-flash-free`
7. `north-mini-code-free`

System prompt diubah jadi persona "Hokireceh (Hoki)" — admin virtual, dilarang menyebut AI.

### bot.js — user-facing text

Semua referensi "AI" di teks publik diganti:
- `"🤖 AI Chat"` → `"💬 Live Chat"`
- `"Mode AI aktif"` → `"Live Chat Aktif"`
- Thinking placeholder: `<tg-thinking>Admin sedang mengetik</tg-thinking>`

### markdownToHtml

```js
// Tambahan: konversi paragraf
.replace(/\n{2,}/g, '<br><br>')
```

## Verification

- `node --check` lulus di semua 3 file
- Tes manual: Live Chat berfungsi, response atas nama "Hoki", tanpa menyebut AI
- Format paragraf (double newline → `<br><br>`) berfungsi
