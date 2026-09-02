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
        // Anime page: list episode <a href="...-episode-N/"> (class lstepsiode) — termasuk -end/-END (episode terakhir)
        const isAnime = /\/anime\//i.test(target);
        if (isAnime) {
          const epRe = /<a[^>]+href="([^"]+(?:-episode-|-エピソード-)(\d+)(?:-?(?:end|END|End))?\/?)"[^>]*>([^<]+)<\/a>/gi;
          const episodes = [];
          let m2;
          while ((m2 = epRe.exec(html))) {
            const href = m2[1].trim();
            const num = parseInt(m2[2], 10);
            const title = m2[3].trim().replace(/\s+/g, " ");
            if (!episodes.find((e) => e.ep === num)) episodes.push({ ep: num, url: href.startsWith("http") ? href : new URL(href, target).href, title });
          }
          episodes.sort((a, b) => a.ep - b.ep);
          if (!episodes.length) {
            return new Response(JSON.stringify({ ok: false, message: "no episodes found (anime page)", htmlSnippet: html.slice(0, 2000) }), {
              status: 404,
              headers: { "Content-Type": "application/json", ...cors },
            });
          }
          return new Response(JSON.stringify({ ok: true, type: "anime", episodes }), {
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        // Episode page: Parse download-eps blocks: <li><strong>FULLHD</strong> <span><a href="...gofile...">...</a>
        const qualityOrder = ["4K", "FULLHD", "MP4HD", "480p", "360p"];
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
            const name = (h[2] || '').trim().toLowerCase();
            // Generic: slug = hostname .split interdip dari href (bukan hardcode nama server)
            let key = null;
            try {
              const host = new URL(href).hostname.replace(/^www\./, '').split('.')[0];
              if (host) key = host.toLowerCase();
            } catch {}
            if (!key && name) key = name.replace(/\s+/g, '');
            if (key) servers[key] = href;
          }
          if (Object.keys(servers).length) blocks[q] = servers;
        }
        // Prefer 4K > FULLHD > MP4HD (4K if exists, FULLHD otherwise)
        const preferred = blocks["4K"] || blocks.FULLHD || blocks.MP4HD || null;
        const chosenQ = blocks["4K"] ? "4K" : blocks.FULLHD ? "FULLHD" : "MP4HD";
        if (!preferred) {
          return new Response(JSON.stringify({ ok: false, message: "no FULLHD/4K servers found", blocks }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        return new Response(JSON.stringify({ ok: true, type: "episode", quality: chosenQ, servers: preferred, blocks }), {
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
