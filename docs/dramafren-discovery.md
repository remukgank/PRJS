# Discovery Drama Indonesia di dramafren.org

## Metode: Search per Keyword

Gunakan halaman **`page=search_result`** — BUKAN `page=search`.
Search page biasa return HTML kosong, `search_result` return daftar drama.

### URL Pattern
```
https://{subdomain}.dramafren.org/index.php?page=search_result&q={keyword}&lang={id|in}
```

- **`lang=id`** — flickreels, shortmax, stardusttv, netshort, reelshort, dramabite
- **`lang=in`** — dramabox aja

### Keyword Indonesia yang dipake
```
cinta, hati, raja, ratu, aku, kamu, dosa, mimpi, istri, suami,
ayah, ibu, putri, selingkuh, dendam, bidadari, mawar, bulan, matahari
```

### Cara
1. Bikin FlareSolverr session (biar cookie Cloudflare kepake)
2. Search tiap keyword di tiap subdomain via `search_result`
3. Parse HTML: cari `page=detail&id={id}&lang={lang}`
4. Filter `lang=id` atau `lang=in`
5. Kumpulin unique ID + judul dari `<h3>` tag
6. Bandingin dengan file `.md` yang udah ada → dapet update

### Regex Parsing HTML
Gunakan regex ini — perhatikan setiap subdomain punya format URL beda:
```js
// Match ALL detail links
/<a[^>]*href="([^"]*detail[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi

// Ekstrak ID dari href
/id=([^&]+)/
```

**PENTING**: 
- `reelshort` → URL **tidak** punya `&lang=id` di link HTML. Default ke 'id'.
- `netshort` → URL juga **tidak** punya `&lang=id` di HTML (tapi existing `.md` pakai). Default ke 'id'.
- `stardusttv` → URL punya `&slug=...&lang=id`. Pakai `&slug` sebelum `&lang`.
- `flickreels`, `shortmax`, `dramabite` → URL punya `&lang=id` standar.

### Scripts Discovery
Ada di `discovery/`:
- `scan.sh` — scan all subdomains via search_result
- `crosscheck.sh` — bandingin scan vs existing `.md`
- `append.sh` — append drama baru ke `.md`

Jalankan urut: `source /run/replit/env/latest && node discovery/scan.sh && node discovery/crosscheck.sh && node discovery/append.sh`

### Performa
- Request pertama per domain: ~11 detik (FlareSolverr solve CF)
- Request selanjutnya per domain: ~2 detik (session cookie cached)
- 1 keyword dapet 10-105 item (tergantung subdomain & keyword)

## Subdomain & Status

| Subdomain | Bahasa Indo | ID Pattern | Bisa Scan? |
|-----------|-------------|------------|------------|
| flickreels | ✅ | numeric (355-8720+) | ✅ sequential + search |
| shortmax | ✅ | numeric (109226-858418+) | ✅ sequential + search |
| stardusttv | ✅ | numeric (142-20526+) | ✅ sequential + search |
| dramabite | ✅ | numeric (10363-15942+) | ✅ sequential + search |
| dramabox | ✅ | 41000101XXX-42000XXXXX | ✅ search aja (range gede) |
| netshort | ✅ | random 19-digit | ✅ search aja |
| reelshort | ✅ | hex string | ✅ search aja |
| goodshort | ❌ 0 drama | — | — |
| shotshort | ❓ baru ditemukan | — | perlu dicek |
| dramawave, idrama, flextv, dll | ❌ | — | — |
