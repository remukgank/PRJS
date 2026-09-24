// Cloudflare Worker relay untuk api.gofile.io
// Deploy: https://dash.cloudflare.com → Workers & Pages → Create → paste kode ini
// Set secret TOKEN (GoFile account token) & set bindings var di Settings → Variables
// Endpoint: GET https://<worker>.workers.dev/resolve?code=<contentId>
//          e.g. /resolve?code=qJJMOR6z

// ===== Konfigurasi (ubah via env vars / Settings) =====
const GOFILE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const GOFILE_LANG = "en-US";
const GOFILE_SALT = "12af056dacea0b";
const WT_WINDOW_SEC = 14400;

function generateWebsiteToken(accountToken) {
  const window = Math.floor(Date.now() / 1000 / WT_WINDOW_SEC);
  const raw = `${GOFILE_UA}::${GOFILE_LANG}::${accountToken}::${window}::${GOFILE_SALT}`;
  return sha256Hex(raw);
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const QUALITY_ORDER = ["4K", "FULLHD", "MP4HD", "720p", "480p", "360p"];

function parseDownloadBlocks(html) {
  const blocks = {};
  const liRe = /<li[^>]*>\s*<strong[^>]*>([^<]+)<\/strong>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const q = m[1].trim().replace(/\s+/g, "");
    const inner = m[2];
    const servers = {};
    const hrefRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let h;
    while ((h = hrefRe.exec(inner))) {
      const href = h[1].trim();
      const name = (h[2] || "").trim().toLowerCase();
      // Generic: slug = hostname .split interdip dari href (bukan hardcode nama server)
      // Buff www86.zippyshare.com → zippyshare (buang awalan www<angka>.)
      let key = null;
      try {
        const host = new URL(href).hostname.replace(/^www(?:\d+)\./i, "").replace(/^www\./, "").split(".")[0];
        if (host) key = host.toLowerCase();
      } catch {}
      if (!key && name) key = name.replace(/\s+/g, "");
      // Server mati/anti-bot tak disajikan: Zippyshare tutup (302 ke homepage), Racaty
      // pakai anti-bot JS chain (butuh headless, bukan curl). Hanya server scrapeable
      // (Gofile/Pixeldrain/Filedon/GDrivePlayer) yang dibuka ke bot.
      if (key && /^(?:zipps?yshare|racaty)$/i.test(key)) continue;
      if (key) servers[key] = href;
    }
    if (Object.keys(servers).length) blocks[q] = servers;
  }
  const chosenQ = QUALITY_ORDER.find((q) => blocks[q]) || Object.keys(blocks).find((q) => blocks[q]) || null;
  return { blocks, chosenQ, preferred: chosenQ ? blocks[chosenQ] : null };
}

function detectSinglePageLink(html, scope) {
  const mvRe = /<a[^>]+href="([^"]*-episode-(?:movie|ova|special|batch|ona)\b[^"]*)"[^>]*>([^<]*)<\/a>/gi;
  let mm;
  while ((mm = mvRe.exec(scope || html))) return mm[1].trim();
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: cors });
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", hasToken: !!((env.TOKEN || "").trim()), tokenPrefix: (env.TOKEN || "").trim().slice(0, 8) }),
        { headers: { "Content-Type": "application/json", ...cors } }
      );
    }

    if (url.pathname === "/fetch") {
      const target = (url.searchParams.get("url") || "").trim();
      if (!target) {
        return new Response(JSON.stringify({ ok: false, message: "url param required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      const clearance = (env.CF_CLEARANCE || "").trim();
      try {
        const hdrs = { "User-Agent": GOFILE_UA, Accept: "text/html,application/xhtml+xml" };
        if (clearance) hdrs["Cookie"] = `cf_clearance=${clearance}`;
        const r = await fetch(target, { headers: hdrs, redirect: "manual", cf: { cacheTtl: 60 } });
        const text = await r.text();
        return new Response(
          JSON.stringify({
            ok: true,
            status: r.status,
            location: r.headers.get("location") || r.headers.get("Location") || null,
            snippet: text.slice(0, 12000),
          }),
          {
            headers: { "Content-Type": "application/json", ...cors },
          }
        );
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, message: String(e && e.message || e).slice(0, 300) }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    if (url.pathname === "/samehadaku") {
      const target = (url.searchParams.get("url") || "").trim();
      if (!target) {
        return new Response(JSON.stringify({ ok: false, message: "url param required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      const clearance = (env.CF_CLEARANCE || "").trim();
      try {
        const hdrs = { "User-Agent": GOFILE_UA, Accept: "text/html,application/xhtml+xml" };
        if (clearance) hdrs["Cookie"] = `cf_clearance=${clearance}`;
        const r = await fetch(target, { headers: hdrs, cf: { cacheTtl: 60 } });
        const html = await r.text();
        if (r.status >= 400) {
          return new Response(JSON.stringify({ ok: false, status: r.status, message: `http ${r.status}` }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        // Anime page: list episode (class lstepsiode) — termasuk -end/-END (episode terakhir).
        const isAnime = /\/anime\//i.test(target);
        if (isAnime) {
          const epRe = /<a[^>]+href="([^"]+(?:-episode-|-エピソード-)(\d+)(?:-?(?:end|END|End))?\/?)"[^>]*>([^<]+)<\/a>/gi;
          const episodes = [];
          const epByNum = new Map();
          let m2;
          while ((m2 = epRe.exec(html))) {
            const href = m2[1].trim();
            const num = parseInt(m2[2], 10);
            const title = m2[3].trim().replace(/\s+/g, " ");
            const prev = epByNum.get(num);
            // Prefer anchor judul (bukan anchor angka di header), biar title jujur non-numerik.
            if (!prev || (!/^\d+$/.test(title) && /^\d+$/.test(prev.title))) {
              epByNum.set(num, { url: href.startsWith("http") ? href : new URL(href, target).href, title });
            }
          }
          for (const [num, { url, title }] of epByNum) {
            episodes.push({ ep: num, url, title: /^[\d\s\-]+$/.test(title) ? `Episode ${num}` : title });
          }
          // Samehadaku kadang me-list episode dengan href /<slug>-<N>/ (tanpa -episode-), mis.
          // Dragon Ball Heroes: ep 20-42 = /super-dragon-ball-heroes-31/ dst. Pola slug-angka ini
          // WAJIB disaring dalam scope blok <div class="lstepsiode"> saja (pagar #1), supaya link
          // lain di halaman (menu, anime lain, pagination) tak ikut tertangkap sebagai episode.
          const listRe = /<div[^>]*class=["'][^"']*lstepsiode[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi;
          const listM = listRe.exec(html);
          let listHtml = "";
          if (listM && listM[1]) {
            listHtml = listM[1];
            const bareRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
            const bareByEp = new Map();
            let bm;
            while ((bm = bareRe.exec(listHtml))) {
              const href = bm[1].trim();
              let seg;
              try {
                seg = (new URL(href, target).pathname || "").replace(/\/+$/, "").split("/").pop() || "";
              } catch { continue; }
              // Lewati yang sudah ditangani epRe (-episode- atau -エピソード-) dan flag ringkasan
              // atau penanda angka yang bukan nomor episode (season/part/movie/ova/dll).
              if (/-episode-|-エピソード-/i.test(seg)) continue;
              if (/-(?:season|part|movie|ova|ona|special|batch|end)-\d+$/i.test(seg)) continue;
              const tm = seg.match(/^(.+?)-(\d+)$/);
              if (!tm) continue;
              const num = parseInt(tm[2], 10);
              const title = bm[2].trim().replace(/\s+/g, " ");
              const prev = bareByEp.get(num);
              // Prefer anchor judul (bukan yang isinya cuma angka), biar title tak jadi "31".
              if (!prev || (!/^\d+$/.test(title) && /^\d+$/.test(prev.title))) {
                bareByEp.set(num, { href, title });
              }
            }
            for (const [num, v] of bareByEp) {
              if (episodes.find((e) => e.ep === num)) continue;
              episodes.push({
                ep: num,
                url: v.href.startsWith("http") ? v.href : new URL(v.href, target).href,
                title: /^[\d\s\-]+$/.test(v.title) ? `Episode ${num}` : v.title,
              });
            }
          }
          // Samehadaku: ep 1 kadang di-link ke <slug>/ (tanpa pola -episode-N), mis. Isekai Mokushiroku Mynoghra.
          // Hanya diproses bila setidaknya ada satu link -episode-N lain (judul multi-episode), sehingga
          // halaman movie/single (tanpa link -episode-N) tetap jatuh ke parse download blocks di bawah.
          if (episodes.length) {
            const ep1Re = /<span class="lchx"><a[^>]+href="([^"]+)"[^>]*>\s*([^<]*?Episode\s*1\b[^<]*?)\s*<\/a><\/span>/gi;
            let m3;
            while ((m3 = ep1Re.exec(html))) {
              const href = m3[1].trim();
              if (/-episode-|エピソード/i.test(href)) continue;
              if (episodes.find((e) => e.ep === 1)) continue;
              const title = m3[2].trim().replace(/\s+/g, " ");
              const num = parseInt((title.match(/Episode\s*(\d+)/i) || [])[1] || "0", 10);
              if (num === 1) episodes.push({ ep: 1, url: href.startsWith("http") ? href : new URL(href, target).href, title });
            }
          }
          if (!episodes.length) {
            const single = detectSinglePageLink(html, listHtml || html);
            if (single) {
              const subUrl = single.startsWith("http") ? single : new URL(single, target).href;
              const sr = await fetch(subUrl, { headers: hdrs, cf: { cacheTtl: 60 } }).catch(() => null);
              if (sr && sr.ok) {
                const sub = parseDownloadBlocks(await sr.text());
                if (sub.preferred) {
                  return new Response(JSON.stringify({ ok: true, type: "episode", quality: sub.chosenQ, servers: sub.preferred, blocks: sub.blocks, via: "single" }), {
                    headers: { "Content-Type": "application/json", ...cors },
                  });
                }
              }
            }
          }
          episodes.sort((a, b) => a.ep - b.ep);
          if (episodes.length) {
            return new Response(JSON.stringify({ ok: true, type: "anime", episodes }), {
              headers: { "Content-Type": "application/json", ...cors },
            });
          }
          // Movie/single — no episode links, fall through to parse download blocks below
        }
        // Episode page: Parse download-eps blocks: <li><strong>FULLHD</strong> <span><a href="...gofile...">...</a>
        const parsed = parseDownloadBlocks(html);
        if (!parsed.preferred) {
          return new Response(JSON.stringify({ ok: false, message: "no FULLHD/4K servers found", blocks: parsed.blocks }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        return new Response(JSON.stringify({ ok: true, type: "episode", quality: parsed.chosenQ, servers: parsed.preferred, blocks: parsed.blocks }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, message: String(e && e.message || e).slice(0, 300) }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    if (url.pathname !== "/resolve") {
      return new Response(JSON.stringify({ status: "error", message: "use /resolve?code=..." }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const code = (url.searchParams.get("code") || "").trim();
    if (!code) {
      return new Response(JSON.stringify({ status: "error", message: "code param required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ status: "error", message: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const token = (env.TOKEN || "").trim();
    const guest = token === "";
    const wt = await generateWebsiteToken(token);
    const apiUrl =
      `https://api.gofile.io/contents/${code}` +
      `?contentFilter=&page=1&pageSize=1000&sortField=createTime&sortDirection=-1`;

    const headers = {
      "User-Agent": GOFILE_UA,
      "X-BL": GOFILE_LANG,
      "X-Website-Token": wt,
      Accept: "application/json",
      Origin: "https://gofile.io",
      Referer: "https://gofile.io/",
    };
    if (!guest) headers["Authorization"] = `Bearer ${token}`;

    // 1. Coba dengan Authorization (premium) / tanpa (guest)
    try {
      const apiResp = await fetch(apiUrl, { headers, cf: { cacheTtl: 60 } });
      let json;
      try {
        json = await apiResp.json();
      } catch {
        json = { status: "error", message: `non-json http ${apiResp.status}` };
      }
      if (json.status === "ok") {
        return new Response(JSON.stringify({ ok: true, data: json.data }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      // Jika error-notPremium & guest, coba tanpa token (hanya WT)
      if (!guest && /error-notPremium/.test(json.message || "")) {
        delete headers["Authorization"];
        const guestResp = await fetch(apiUrl, { headers, cf: { cacheTtl: 60 } });
        const guestJson = await guestResp.json().catch(() => null);
        if (guestJson && guestJson.status === "ok") {
          return new Response(JSON.stringify({ ok: true, data: guestJson.data }), {
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
      }
      return new Response(JSON.stringify({ ok: false, ...json }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, status: "error", message: String(e && e.message || e).slice(0, 300) }),
        { status: 502, headers: { "Content-Type": "application/json", ...cors } }
      );
    }
  },
};
