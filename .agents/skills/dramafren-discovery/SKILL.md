# Drama Discovery — dramafren.org

## Cara Cari Drama Indonesia Baru

### Endpoint
```
GET https://{subdomain}.dramafren.org/index.php?page=search_result&q={keyword}&lang={id|in}
```

### Langkah
1. Buat FlareSolverr session (`sessions.create`)
2. Search keyword Indonesia via `search_result`
3. Parse `page=detail&id={id}&lang={lang}` dari HTML
4. Filter `lang=id` atau `lang=in`
5. Collect unique ID, bandingin dengan `.md` existing

### Keyword
`cinta, hati, raja, ratu, aku, kamu, dosa, mimpi, istri, suami, ayah, ibu, putri, selingkuh, dendam, bidadari, mawar, bulan, matahari`

### Subdomain Aktif (Indonesian Content)
- `flickreels` → lang=id, ID numeric
- `shortmax` → lang=id, ID numeric
- `stardusttv` → lang=id, ID numeric
- `dramabite` → lang=id, ID numeric
- `dramabox` → lang=in, ID format 41000/42000
- `netshort` → lang=id, ID random 19-digit
- `reelshort` → lang=id, ID hex

### File Data
- `docs/dramafren-discovery.md` — dokumentasi lengkap
- `scraper/*.md` — daftar drama per subdomain
- `drama_indonesia.txt` — dramabox list (root)

### Performa
- Request pertama per domain: ~11s (solve CF)
- Lanjutan: ~2s per request
