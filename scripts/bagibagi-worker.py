#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bagibagi-worker.py — Payment worker BagiBagi untuk PRJS bot.

Memberikan "payment gateway" berbasis browser (strategi Opsi A yang disetujui):
- Chromium via undetected_chromedriver (stack .solver) membuka halaman donasi,
  mengisi form (amount, nama, pesan), memilih QRIS, centang TOS, submit,
  lalu menunggu Turnstile (Cloudflare managed challenge) selesai secara otomatis
  di dalam browser.
- Setelah verifikasi lolos, alur frontend bagibagi mem-POST save-donation dan
  /api/Payment/qris; worker meng-hook window.fetch dan mengambil donationId +
  qrString dari respons.
- Status pembayaran dicek melalui /api/Payment/check-transaction dari konteks
  browser yang sama (cookies + konteks cf sama).

HTTP API (127.0.0.1:8192 oleh default, env BAGIBAGI_WORKER_PORT):
  GET  /health
  POST /create  {amount, name, message} -> {donationId, qrString, paymentUrl, amount}
  GET  /status?donationId=...           -> {statusCode, statusMessage, amount, reference}
  POST /abort   {donationId}            -> ack (bersih-bersih lokal)

Catatan lingkungan: manajer challenge Cloudflare (Turnstile) mungkin tidak
menyelesaikan verifikasi pada IP tertentu. Jika widget tetap "Selesaikan
verifikasi" melewati BAGIBAGI_CAPTCHA_TIMEOUT detik, /create mengembalikan
{error:"captcha_unresolved"} supaya bot bisa memberi pesan dan retry.
"""
import json
import logging
import os
import re
import sys
import threading
import time

SOLVER_DIR_VAR = "BAGIBAGI_SOLVER_DIR"
SOLVER_DIR = os.environ.get(SOLVER_DIR_VAR) or os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".solver")
)
PKG_DIR = os.path.join(SOLVER_DIR, "pkg")
SRC_DIR = os.path.join(SOLVER_DIR, "src")
for p in (PKG_DIR, SRC_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

from bottle import Bottle, request, response  # noqa: E402

RECEIVER_USERNAME = os.environ.get("BAGIBAGI_RECEIVER_USERNAME", "sepibukansapi")
PAGE_URL = os.environ.get("BAGIBAGI_PAGE_URL") or f"https://bagibagi.co/{RECEIVER_USERNAME}"
WORKER_PORT = int(os.environ.get("BAGIBAGI_WORKER_PORT", "8192"))
CAPTCHA_TIMEOUT = int(os.environ.get("BAGIBAGI_CAPTCHA_TIMEOUT", "50"))
PAYMENT_WAIT_TIMEOUT = int(os.environ.get("BAGIBAGI_PAYMENT_WAIT_TIMEOUT", "35"))
DRIVER_PATH = os.environ.get(
    "BAGIBAGI_DRIVER_PATH",
    os.path.join(os.path.expanduser("~"), ".local", "share", "undetected_chromedriver", "chromedriver"),
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bagibagi-worker")

SET_NUMBER_JS = r"""
function bbsetVal(el, v) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  el.blur();
}
"""

# Hook dipasang via CDP di setiap dokumen baru: tangkap fetch/XHR ke /api/
# (terutama save-donation dan /Payment/qris) supaya worker bisa membaca
# donationId + qrString tanpa tergantung selektor DOM dalam.
HOOK_JS = r"""
if (!window.__bbq) {
  window.__bbq = { save: [], qris: [], log: [] };
  const kf = window.fetch;
  window.fetch = function(url, opts) {
    try {
      const u = String(url);
      if (u.includes('/api/')) {
        let b = '';
        try { const x = opts && opts.body; b = typeof x === 'string' ? x : (x ? JSON.stringify(x) : ''); } catch (e) {}
        return kf.apply(this, arguments).then(res => {
          const clone = res.clone();
          clone.text().then(txt => {
            const rec = { u, m: (opts && opts.method) || 'GET', b: b, s: res.status, t: txt };
            window.__bbq.log.push(rec);
            if (u.includes('save-donation')) window.__bbq.save.push(rec);
            if (u.includes('/Payment/qris')) window.__bbq.qris.push(rec);
          }).catch(() => {});
          return res;
        });
      }
      return kf.apply(this, arguments);
    } catch (e) { return kf.apply(this, arguments); }
  };
  const _o = XMLHttpRequest.prototype.open;
  const _s = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) { this.__bbrec = { m, u: String(u) }; return _o.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(bd) {
    const rec = this.__bbrec || {};
    const x = this;
    x.addEventListener('load', () => {
      if (rec.u && rec.u.includes('/api/')) {
        const o = { u: rec.u, m: rec.m, b: bd ? String(bd) : '', s: x.status, t: x.responseText || '' };
        window.__bbq.log.push(o);
        if (rec.u.includes('save-donation')) window.__bbq.save.push(o);
        if (rec.u.includes('/Payment/qris')) window.__bbq.qris.push(o);
      }
    });
    return _s.apply(this, arguments);
  };
}
"""

_lock = threading.RLock()
_driver = None
_driver_dead = False


def _load_paths():
    """Baca .solver/paths.env untuk env binary Chromium/Xvfb/LD."""
    paths_file = os.path.join(SOLVER_DIR, "paths.env")
    env = {}
    if os.path.isfile(paths_file):
        with open(paths_file) as f:
            for line in f:
                line = line.strip()
                if line and "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    env[k] = v.strip().strip('"')
    return env


def _ensure_browser():
    global _driver, _driver_dead
    with _lock:
        if _driver is not None and not _driver_dead:
            try:
                _driver.current_url
                return _driver
            except Exception:
                _driver_dead = True
        if not os.path.isfile(DRIVER_PATH):
            raise RuntimeError(
                f"chromedriver tidak ditemukan di {DRIVER_PATH}. Jalankan setup solver (.solver) sekali."
            )
        envp = _load_paths()
        if os.environ.get("CHROME_BIN"):
            pass
        elif envp.get("CHROMIUM_BIN"):
            os.environ["CHROME_BIN"] = envp["CHROMIUM_BIN"]
        if envp.get("XVFB_BIN"):
            os.environ["PATH"] = envp["XVFB_BIN"] + ":" + os.environ.get("PATH", "")
        current_ld = os.environ.get("LD_LIBRARY_PATH", "")
        extra = ":".join([envp["GLIB_LIB"], envp["NSS_LIB"], envp["XCB_LIB"], envp["NSPR_LIB"]])
        if current_ld:
            os.environ["LD_LIBRARY_PATH"] = extra + ":" + current_ld
        else:
            os.environ["LD_LIBRARY_PATH"] = extra
        os.environ.setdefault("HEADLESS", "true")
        if not os.environ.get("CHROME_BIN"):
            raise RuntimeError("Tidak bisa menentukan CHROME_BIN (periksa .solver/paths.env).")

        import utils

        utils.PATCHED_DRIVER_PATH = DRIVER_PATH
        _driver = utils.get_webdriver()
        _driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": HOOK_JS + SET_NUMBER_JS})
        _driver_dead = False
        log.info("browser ready")
        return _driver


def _js(driver, script, *args):
    return driver.execute_script(script, *args)


# ---------------------------------------------------------------- flow donasi
def _click_qris_card(driver):
    """Pilih kartu metode pembayaran QRIS di panel konfirmasi."""
    picked = _js(driver, r"""
      const cards = [...document.querySelectorAll('button')].filter(b => {
        const t = (b.textContent || '').trim();
        const r = b.getBoundingClientRect();
        return r.width > 0 && (t === 'QRIS' || t === 'South East Asia') && r.y > 600;
      });
      const pick = cards.find(c => c.getBoundingClientRect().height > 40) || cards[0];
      if (!pick) return null;
      pick.click();
      return pick.textContent.trim();
    """)
    return picked


def _click_tos(driver):
    """Centang checkbox TOS di dialog payment pakai REAL click (Selenium).

    Hasil tes: dispatchEvent() JS tidak mengubah `checked` (react-hook-form
    merespons pointer event asli). Solusi: scroll element ke view, lalu klik
    via ActionChains (trusted event). Dilakukan untuk BOTH input checkbox
    dan button[role=checkbox] yang menaunginya.
    """
    from selenium.webdriver.common.action_chains import ActionChains
    try:
        target = _js(driver, r"""
          const q = (sel) => [...document.querySelectorAll(sel)];
          const candidates = [];
          for (const el of q('input[type="checkbox"]')) {
            const r = el.getBoundingClientRect();
            candidates.push({ el, kind: 'input', w: r.width, h: r.height });
          }
          for (const el of q('button[role="checkbox"]')) {
            const r = el.getBoundingClientRect();
            candidates.push({ el, kind: 'button', w: r.width, h: r.height });
          }
          const vis = candidates.filter(c => c.w > 0 && c.h > 0);
          if (vis.length) {
            vis.sort((a, b) => (b.h * b.w) - (a.h * a.w));
            const pick = vis[0];
            pick.el.scrollIntoView({ block: 'center', behavior: 'instant' });
            return { index: 0, found: true };
          }
          return { found: false };
        """)
        if not target.get('found'):
            return False
        time.sleep(0.5)
        # input checkbox: klik via ActionChains — scrollIntoView sudah dilakukan
        try:
            inp = driver.find_element("css selector", "input[type='checkbox']")
            if inp.is_displayed():
                ActionChains(driver).move_to_element(inp).pause(0.3).click().perform()
                time.sleep(0.7)
        except Exception:
            pass
        # button role=checkbox (React controlled) — klik juga supaya state aria-checked berubah
        try:
            btn = driver.find_element("css selector", "button[role='checkbox']")
            if btn.is_displayed():
                ActionChains(driver).move_to_element(btn).pause(0.2).click().perform()
                time.sleep(0.7)
        except Exception:
            pass
        # verifikasi state
        state = _js(driver, r"""
          const out = [];
          for (const el of document.querySelectorAll('input[type="checkbox"]')) out.push({ kind: 'input', checked: el.checked });
          for (const el of document.querySelectorAll('button[role="checkbox"]')) out.push({ kind: 'button', ariaChecked: el.getAttribute('aria-checked') });
          return out;
        """)
        log.info("[tos] setelah klik (real): %s", json.dumps(state))
        return state and any(
            (s.get('checked') is True) or (s.get('ariaChecked') == 'true') for s in state
        )
    except Exception as e:
        log.warning("tos click error: %s", e)
        return False


def _click_confirm(driver):
    """Klik tombol konfirmasi dialog payment ('Bagibagi' di bawah dialog).

    Seperti TOS, React/Remix hanya merespons trusted pointer event. Klik real
    via ActionChains pada tombol confirm yang terletak paling bawah halaman
    (dialog payment), SETELAH memastikan TOS sudah tercentang.
    """
    from selenium.webdriver.common.action_chains import ActionChains
    try:
        found = _js(driver, r"""
          const bs = [...document.querySelectorAll('button')].filter(b => {
            const t = (b.textContent || '').trim();
            const r = b.getBoundingClientRect();
            return t === 'Bagibagi' && r.width > 200 && r.height > 10;
          });
          const ordered = bs.sort((x, y) => y.getBoundingClientRect().y - x.getBoundingClientRect().y);
          const t = ordered[0];
          if (!t) return { ok: false, reason: 'no-button' };
          if (t.disabled || t.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
          t.scrollIntoView({ block: 'center', behavior: 'instant' });
          return { ok: true };
        """)
        if not found.get('ok'):
            # kalau disabled karena TOS belum terdeteksi, coba centang TOS lagi
            _click_tos(driver)
            time.sleep(0.7)
            return _click_confirm(driver)
        time.sleep(0.5)
        btns = driver.find_elements("css selector", "button")
        cand = [b for b in btns if (b.text or '').strip() == 'Bagibagi']
        # pilih yang paling bawah (dialog payment)
        cand.sort(key=lambda b: b.location['y'], reverse=True)
        btn = cand[0]
        ActionChains(driver).move_to_element(btn).pause(0.2).click().perform()
        log.info("confirm real-click (y~%s)", btn.location['y'])
        return True
    except Exception as e:
        log.warning("confirm click error: %s", e)
        return False


def _fill_form(driver, amount, name, message):
    result = _js(driver, SET_NUMBER_JS + r"""
      const a = document.querySelector('#amount') || document.querySelector("input[name='amount']");
      const m = document.querySelector('#message') || document.querySelector("textarea[name='message']");
      const n = document.querySelector('#preferedName');
      const e = document.querySelector('#email') || document.querySelector("input[name='email']") || document.querySelector("input[type='email']");
      if (!a) return { err: 'amount input not found' };
      bbsetVal(a, String(arguments[0]));
      if (m) bbsetVal(m, String(arguments[2]));
      if (n) bbsetVal(n, String(arguments[1]));
      if (e) bbsetVal(e, 'donatur.test.2026@gmail.com');
      if (e) e.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, hasEmail: !!e };
    """, amount, name, message)
    if not result.get('ok'):
        raise RuntimeError(result.get('err') or 'form fill failed')
    time.sleep(0.8)


def _submit_form(driver):
    ok = _js(driver, r"""
      const t = [...document.querySelectorAll("button[type='submit']")].find(b => (b.textContent || '').trim() === 'Bagibagi');
      if (!t) return false;
      t.click();
      return true;
    """)
    if not ok:
        raise RuntimeError('submit button not found')


def _dump_buttons(driver, tag):
    """Dump label semua tombol & boolean state untuk debug dialog."""
    try:
        btns = _js(driver, r"""
          return [...document.querySelectorAll('button')].map(b => {
            const r = b.getBoundingClientRect();
            return { t: (b.textContent || '').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y), dis: b.disabled, role: b.getAttribute('role') || '', ariachk: b.getAttribute('aria-checked') };
          });
        """)
        import datetime as _dt
        safe = re.sub(r'[^0-9A-Za-z]', '_', tag)
        with open(f"/tmp/bbdev_buttons_{safe}.json", "w") as f:
            json.dump(btns, f)
        log.info("[buttons:%s] count=%s (full dump di /tmp/bbdev_buttons_%s.json)", tag, len(btns), safe)
    except Exception as e:
        log.warning("[buttons:%s] gagal: %s", tag, e)


def _dump_checkboxes(driver, tag):
    """Dump semua input checkbox & role=checkbox + state aria-checked / checked."""
    try:
        items = _js(driver, r"""
          const out = [];
          for (const el of document.querySelectorAll('input[type=checkbox]')) {
            const r = el.getBoundingClientRect();
            out.push({ kind: 'input', checked: el.checked, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y), name: el.name || '' });
          }
          for (const el of document.querySelectorAll('[role="checkbox"], button[role="checkbox"]')) {
            const r = el.getBoundingClientRect();
            out.push({ kind: 'button', ariaChecked: el.getAttribute('aria-checked'), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y), t: (el.textContent||'').trim().slice(0,40) });
          }
          for (const el of document.querySelectorAll('[data-checkbox], .toggle, .switch')) {
            const r = el.getBoundingClientRect();
            out.push({ kind: 'custom', text: (el.textContent||'').trim().slice(0,30), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) });
          }
          return out;
        """)
        log.info("[checkboxes:%s] %s", tag, json.dumps(items)[:1500])
    except Exception as e:
        log.warning("[checkboxes:%s] gagal: %s", tag, e)


def _wait_for_pay_dialog(driver, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = _js(driver, r"""
          const bt = document.body.innerText || '';
          return { hasTotal: bt.includes('Total Pembayaran'), hasCheckbox: !![...document.querySelectorAll('button')].find(b => b.getAttribute('role') === 'checkbox' || b.getAttribute('aria-checked') !== null) };
        """)
        if st.get('hasTotal') and st.get('hasCheckbox'):
            _dump_buttons(driver, "dialog-ready")
            _dump_checkboxes(driver, "dialog-ready")
            _log_state_stub(driver, "dialog-ready")
            _dump_form(driver, "dialog-ready")
            return True
        time.sleep(1)
    return False


def _dump_form(driver, tag):
    """Dump semua input/form text-content + pesan error di halaman (debug)."""
    try:
        info = _js(driver, r"""
          const inputs = [...document.querySelectorAll('input, textarea, select')].map(el => ({
            id: el.id || '', name: el.name || '', type: el.type || '', value: (el.value || '').slice(0, 60),
            placeholder: el.placeholder || '', cls: (el.className || '').slice(0, 40)
          }));
          const errs = [...document.querySelectorAll('[role=alert], [aria-invalid=true], .error, .text-red')].map(e => (e.textContent||'').trim().slice(0,80));
          return { inputs, errs };
        """)
        log.info("[form:%s] inputs=%s errs=%s", tag, json.dumps(info.get('inputs'))[:1200], json.dumps(info.get('errs'))[:500])
    except Exception as e:
        log.warning("[form:%s] gagal: %s", tag, e)


def _extract_qris_and_donation(driver):
    """Baca hasil dari window.__bbq; fallback dari teks halaman."""
    data = _js(driver, "return window.__bbq || null;")
    donation_id = None
    qr_string = None
    payment_url = None
    amount = None
    if data:
        for rec in data.get('save', []):
            try:
                j = json.loads(rec.get('t') or '{}')
                if j.get('success') and j.get('data'):
                    donation_id = j['data']
                    break
            except Exception:
                pass
        for rec in data.get('qris', []):
            try:
                j = json.loads(rec.get('t') or '{}')
                d = (j or {}).get('data') or {}
                qr_string = d.get('qrString') or qr_string
                payment_url = d.get('paymentUrl') or payment_url
                amount = d.get('amount') or amount
                mo = d.get('merchantOrderId') or ''
                mm = re.match(r'^bagibagi-([0-9a-fA-F-]{20,})$', mo or '')
                if mm:
                    donation_id = donation_id or mm.group(1)
            except Exception:
                pass
    if not donation_id:
        refs = _js(driver, r"""return (document.body.innerText.match(/bagibagi-[0-9a-f-]{20,}/g) || []).slice(0, 3);""")
        if refs:
            donation_id = re.sub(r'^bagibagi-', '', refs[0])
    return donation_id, qr_string, payment_url, amount


def _wait_form(driver, timeout=45):
    deadline = time.time() + timeout
    last_hint = ''
    while time.time() < deadline:
        ok, hint = _js(driver, r"""
          const a = document.querySelector('#amount') || document.querySelector("input[name='amount']");
          return [ !!a, (document.body.innerText || '').slice(0, 200) ];
        """)
        last_hint = hint or last_hint
        if ok:
            return True
        if re.search(r'(Performing security verification|Just a moment|Verifying you are human)', hint or '', re.I):
            time.sleep(2)
            continue
        time.sleep(1.5)
    low = (last_hint or '').lower()
    if 'security verification' in low or 'verifying you are human' in low or 'just a moment' in low:
        raise RuntimeError('captcha_unresolved')
    raise RuntimeError('form tidak muncul. Halaman: ' + (last_hint or '').replace('\n', ' | ')[:140])


def _do_create(driver, amount, name, message):
    log.info("create start amount=%s", amount)
    driver.get(PAGE_URL)
    log.info("page loaded, waiting for form")
    _wait_form(driver)
    log.info("form ready")
    time.sleep(1)
    _fill_form(driver, amount, name, message)
    log.info("form filled")
    _submit_form(driver)
    log.info("form submitted")

    if not _wait_for_pay_dialog(driver, 15):
        bt = _js(driver, "return (document.body.innerText || '').slice(0, 300);")
        raise RuntimeError(f'payment dialog tidak muncul: {bt[:120]}')
    log.info("payment dialog shown")
    _click_qris_card(driver)
    log.info("qris card clicked")
    time.sleep(1)
    _click_tos(driver)
    log.info("tos clicked")
    _dump_checkboxes(driver, "after-tos")
    time.sleep(0.5)
    if not _click_confirm(driver):
        raise RuntimeError('tombol konfirmasi tidak ditemukan')
    log.info("confirm clicked, waiting for donation/qr")
    time.sleep(2)
    _log_state_stub(driver, "after-confirm")

    # Pagar #1: reset-once per run donasi (bukan global).
    # Pagar #2: silent window — setelah reset, poll token SAJA (~3 dtk) selama
    #           sisa PAYMENT_WAIT_TIMEOUT, tanpa execute()/klik, supaya widget
    #           menyelesaikan challenge sendiri. Tanpa token → captcha_unresolved.
    # Pagar #3: log reset + setiap polling (token ada/tidak, iframe mount/tidak).
    deadline = time.time() + PAYMENT_WAIT_TIMEOUT
    turnstile_reset_done = False
    last_token_poll = 0.0
    while time.time() < deadline:
        donation_id, qr_string, payment_url, amount_out = _extract_qris_and_donation(driver, )
        if donation_id and qr_string:
            return {
                "donationId": donation_id,
                "qrString": qr_string,
                "paymentUrl": payment_url or "",
                "amount": amount_out if amount_out is not None else amount,
            }
        st = _js(driver, r"""
          const bt = document.body.innerText || '';
          const frames = [...document.querySelectorAll('iframe')].map(f => (f.src||'').slice(0,120));
          const dialogText = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].map(d => (d.innerText||'')).join(' ');
          const combined = bt + ' ' + dialogText;
          return {
            verify: combined.includes('Verifikasi'),
            verifyText: combined.includes('Selesaikan verifikasi') || combined.includes('verifikasi'),
            hasDialog: !!document.querySelector('[role="dialog"]'),
            frames: frames,
            tail: bt.replace(/\s+/g, ' ').slice(-300),
            dialogSnippet: dialogText.replace(/\s+/g, ' ').slice(0, 200),
          };
        """)
        if st.get('verifyText'):
            if not turnstile_reset_done:
                # Pagar #1: reset SAKALI (re-arm dari state 'executing' macet)
                _save_debug_screenshot(driver, "turnstile-reset")
                _dump_verify_frames(driver)
                _turnstile_reset_once(driver)
                turnstile_reset_done = True
            # Pagar #2: silent window — poll token saja tanpa execute()/klik
            if time.time() - last_token_poll >= 3:
                tok = _turnstile_poll_token(driver)
                log.info("[turnstile-poll] token='%s' iframe=%s frames=%s verify=%s verifyText=%s dialog=%s dlg='%s'",
                         tok.get('token'), tok.get('iframeNow'), st.get('frames'),
                         st.get('verify'), st.get('verifyText'), st.get('hasDialog'),
                         st.get('dialogSnippet'))
                last_token_poll = time.time()
        time.sleep(2)

    _save_debug_screenshot(driver, "turnstile-stuck")
    final = _js(driver, r"""
      const bt = document.body.innerText || '';
      const frames = [...document.querySelectorAll('iframe')].map(f => (f.src||'').slice(0,120));
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].map(d => (d.innerText||'').replace(/\s+/g,' ').slice(0,300));
      return { full: bt.replace(/\s+/g, ' ').slice(0, 1000), tail: bt.replace(/\s+/g, ' ').slice(-500), frames, dialogs };""")
    log.info("stuck state: %s", json.dumps(final, ensure_ascii=False)[:1500])
    raise RuntimeError('captcha_unresolved')


def _save_debug_screenshot(driver, tag):
    """Simpan screenshot debug ke /tmp untuk inspeksi visual kondisi widget."""
    try:
        import datetime
        ts = datetime.datetime.now().strftime("%H%M%S")
        path = f"/tmp/bbdev_{tag}_{ts}.png"
        driver.get_screenshot_as_file(path)
        log.info("screenshot saved: %s", path)
    except Exception as e:
        log.warning("screenshot gagal: %s", e)


def _log_state_stub(driver, tag):
    """Dump body-text pendek + URL saat ini untuk debug tahapan alur donasi."""
    try:
        info = _js(driver, r"""
          const bt = document.body.innerText || '';
          const frames = [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 80));
          return { tail: bt.replace(/\s+/g, ' ').slice(-260), frames: frames };
        """)
        url = driver.current_url
        log.info("[state:%s] url=%s frames=%s tail='%s'", tag, url, info.get('frames'), info.get('tail'))
    except Exception as e:
        log.warning("[state:%s] gagal dump: %s", tag, e)


def _dump_verify_frames(driver):
    """Dump semua iframe (termasuk dalam shadow DOM) + info dialog verifikasi."""
    try:
        info = _js(driver, r"""
          const out = { iframes: [], shadowIframes: [], dialogHtml: '', bodyHasCf: false };
          const bt = document.body.innerText || '';
          out.bodyHasCf = bt.includes('challenges.cloudflare.com') || bt.includes('Turnstile') || bt.includes('verifikasi');
          for (const f of document.querySelectorAll('iframe')) {
            const r = f.getBoundingClientRect();
            out.iframes.push({ src: (f.src||'').slice(0,120), id: f.id||'', cls: (f.className||'').slice(0,40), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) });
          }
          document.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
              el.shadowRoot.querySelectorAll('iframe').forEach(f => {
                const r = f.getBoundingClientRect();
                out.shadowIframes.push({ src: (f.src||'').slice(0,120), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) });
              });
            }
          });
          const d = document.querySelector('[role="dialog"]');
          if (d) out.dialogHtml = (d.outerHTML || '').slice(0, 1200);
          const ct = document.getElementById('cf-turnstile');
          if (ct) {
            out.turnstileHtml = (ct.outerHTML || '').slice(0, 900);
            const tok = document.getElementById('cf-chl-widget');
            out.turnstileToken = tok ? (tok.value || '').slice(0, 60) : null;
            out.turnstileIframes = ct.querySelectorAll('iframe').length;
          }
          out.windowTurnstile = typeof window.turnstile === 'object' ? Object.keys(window.turnstile) : null;
          out.cfScriptLoaded = !!document.querySelector("script[src*='challenges.cloudflare.com'], script[src*='turnstile']");
          return out;
        """)
        log.info("[verify-frames] iframes=%s shadow=%s bodyHasCf=%s turnstile=%s token=%s winTurnstile=%s scriptLoaded=%s dialogHtml='%s'",
                 json.dumps(info.get('iframes')), json.dumps(info.get('shadowIframes')),
                 info.get('bodyHasCf'), json.dumps(info.get('turnstileHtml')), json.dumps(info.get('turnstileToken')),
                 json.dumps(info.get('windowTurnstile')), info.get('cfScriptLoaded'),
                 info.get('dialogHtml'))
        try:
            logs = driver.get_log('browser')
            ents = [json.dumps({'lv': e.get('level'), 'msg': e.get('message', '')[:260]}) for e in logs[-8:]]
            log.info("[console-logs] %s", ' | '.join(ents))
        except Exception:
            pass
    except Exception as e:
        log.warning("[verify-frames] gagal: %s", e)


def _turnstile_reset_once(driver):
    """Pagar #1: reset widget Turnstile SAKALI per run donasi.

    Widget sempat di state 'executing' yang macet (warning CF "widget is
    already executing"). reset() re-arm widget agar CF evaluasi ulang.
    Dipanggil maks 1x per donasi (flag di level _do_create, bukan global).
    """
    try:
        res = _js(driver, r"""
          const host = document.getElementById('cf-turnstile');
          if (!host || typeof window.turnstile === 'undefined') return { ok: false, reason: 'no-widget' };
          const inp = host.querySelector('input[name="cf-turnstile-response"]');
          const hadToken = !!(inp && inp.value);
          window.turnstile.reset(host);
          return { ok: true, hadTokenBefore: hadToken };
        """)
        log.info("[turnstile-reset] %s", json.dumps(res, ensure_ascii=False))
        return bool(res.get('ok'))
    except Exception as e:
        log.warning("[turnstile-reset] error: %s", e)
        return False


def _turnstile_poll_token(driver):
    """Pagar #2/#3: polling token Turnstile TANPA side-effect (no execute/klik).

    Baca nilai input hidden cf-turnstile-response, fallback getResponse().
    Tidak memanggil execute/reset/clik apapun supaya widget bisa menyelesaikan
    challenge-nya sendiri dalam silent window.
    """
    try:
        res = _js(driver, r"""
          const host = document.getElementById('cf-turnstile');
          let token = '';
          if (host) {
            const inp = host.querySelector('input[name="cf-turnstile-response"]');
            if (inp && inp.value) token = inp.value;
            if (!token && window.turnstile && window.turnstile.getResponse) {
              try { token = window.turnstile.getResponse(host) || ''; } catch (e) {}
            }
          }
          return {
            token: String(token).slice(0, 60),
            iframeNow: !!(host && host.querySelector('iframe')),
          };
        """)
        return res
    except Exception as e:
        log.warning("[turnstile-poll] error: %s", e)
        return {'token': '', 'iframeNow': False}


def _try_click_turnstile(driver):
    """Real click ke checkbox Turnstile.

    Turnstile render di iframe cross-origin (challenges.cloudflare.com), jadi
    checkbox TIDAK terlihat dari JS parent page. Pendekatan:
     1. biasakan switch ke frame Turnstile via Selenium,
     2. cari checkbox/element clickable (input[type=checkbox] atau [role=checkbox]),
     3. klik PERTAMA (klik-pertama Turnstile interaktif biasanya menampilkan
        challenge, klik/kontrol kedua menyelesaikannya), pakai ActionChains
        supaya event-nya natural.
    """
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.common.exceptions import WebDriverException
    try:
        all_frames = driver.find_elements("css selector", "iframe")
        for f in all_frames:
            src = f.get_attribute("src") or ""
            cls = f.get_attribute("class") or ""
            tgt = any(("challenges.cloudflare.com" in src) or ("turnstile" in cls.lower()) or ("turnstile" in src.lower()) for x in [1])
            if ("challenges.cloudflare.com" in src or "turnstile" in cls.lower() or "turnstile" in src.lower()):
                try:
                    driver.switch_to.frame(f)
                except WebDriverException:
                    continue
                checked = _js(driver, r"""
                    const boxes = [...document.querySelectorAll('input[type=checkbox], [role=checkbox], input[type=button], .checkbox, .ctp-checkbox-label, .cb-input')];
                    const b = boxes[0] || [...document.querySelectorAll('input,button')].find(x => { const t=(x.textContent||'').trim(); return t==='I am the human'||t.includes('Verify'); });
                    if (!b) return 'no-box';
                    const r = b.getBoundingClientRect();
                    if (!r.width && !r.height) return 'hidden';
                    b.scrollIntoView({block:'center'});
                    return 'found';
                """)
                if checked == 'found':
                    try:
                        el = driver.find_element("css selector", "input[type=checkbox], [role=checkbox]") if True else None
                    except Exception:
                        el = None
                    try:
                        if el is None:
                            el = driver.find_element("css selector", ".cb-input, .checkbox, .ctp-checkbox-label, input[type=button]")
                    except Exception:
                        el = None
                    if el is not None:
                        try:
                            ActionChains(driver).move_to_element(el).pause(0.3).move_by_offset(1, 1).click().perform()
                            log.info("Turnstile checkbox diklik (iframe)")
                        except WebDriverException:
                            _js(driver, "var b=document.activeElement; return !!b;")
                driver.switch_to.parent_frame()
                time.sleep(0.6)
        driver.switch_to.default_content()
    except Exception as e:
        log.warning("turnstile click error: %s", e)

    # Fallback: widget non-interactive / invisible yang belum di-execute.
    try:
        exec_res = _js(driver, r"""
          const host = document.getElementById('cf-turnstile');
          if (!host || typeof window.turnstile === 'undefined') return { done: false, reason: 'no-widget' };
          const inp = host.querySelector('input[name="cf-turnstile-response"]');
          if (inp && inp.value) return { done: true, token: inp.value.slice(0, 40) };
          const w0 = window.turnstile && window.turnstile.getResponse && window.turnstile.getResponse(host);
          if (w0) return { done: true, token: w0.slice(0, 40) };
          const res = window.turnstile.execute(host);
          return { done: false, submitted: !!res, reason: 'execute-called' };
        """)
        log.info("[turnstile-exec] %s", json.dumps(exec_res, ensure_ascii=False))
        if exec_res.get('done'):
            log.info("[turnstile] TOKEN DIPEROLEH: %s", exec_res.get('token'))
    except Exception as e:
        log.warning("turnstile execute error: %s", e)

    # Mini-wait supaya iframe sempat render, lalu cek ulang
    time.sleep(3)
    try:
        recheck = _js(driver, r"""
          const host = document.getElementById('cf-turnstile');
          if (!host) return { done: false };
          const inp = host.querySelector('input[name="cf-turnstile-response"]');
          const ifr = host.querySelector('iframe');
          return { done: !!(inp && inp.value), token: (inp && inp.value || '').slice(0, 40), iframeNow: !!ifr, iframeSrc: ifr ? (ifr.src || '').slice(0, 80) : '' };
        """)
        log.info("[turnstile-recheck] %s", json.dumps(recheck, ensure_ascii=False))
    except Exception as e:
        log.warning("turnstile recheck error: %s", e)


# ---------------------------------------------------------------- API
def api_health():
    state = "ok"
    alive = False
    try:
        if _driver is not None and not _driver_dead:
            _driver.current_url
            alive = True
        elif _driver is None:
            alive = True
    except Exception:
        alive = False
    return {"ok": alive, "browserAlive": alive, "pageUrl": PAGE_URL}


def api_create():
    try:
        body = request.json or {}
    except Exception:
        body = {}
    amount = int(body.get("amount") or 0)
    name = str(body.get("name") or "Seseorang").strip()[:40]
    message = str(body.get("message") or "").strip()[:255]
    if amount < 1000:
        response.status = 400
        return {"error": "invalid_amount"}
    with _lock:
        driver = _ensure_browser()
        try:
            res = _do_create(driver, amount, name, message)
            log.info("create success amount=%s donation=%s", amount, res.get("donationId"))
            return res
        except RuntimeError as e:
            err = str(e)
            if err == "captcha_unresolved":
                response.status = 409
                return {"error": err, "detail": "Verifikasi Cloudflare tidak selesai di lingkungan ini. Coba lagi nanti."}
            response.status = 500
            return {"error": "create_failed", "detail": err}
        except Exception as e:
            log.exception("create error")
            response.status = 500
            return {"error": "create_failed", "detail": str(e)}


def api_status():
    donation_id = (request.query.donationId or "").strip()
    if not donation_id:
        response.status = 400
        return {"error": "donationId required"}
    with _lock:
        driver = _ensure_browser()
        try:
            out = _js(driver, r"""
              return fetch('/api/Payment/check-transaction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ merchantOrderId: 'bagibagi-' + arguments[0] })
              }).then(r => r.json()).then(j => ({
                code: j && j.success !== false ? (j.data && j.data.statusCode) : 'UNKNOWN',
                message: j && j.data ? j.data.statusMessage : (j.message || 'UNKNOWN'),
                amount: j && j.data ? j.data.amount : null,
                reference: j && j.data ? j.data.reference : null
              })).catch(e => ({ code: 'ERROR', message: String(e) }));
            """, donation_id)
            return out
        except Exception as e:
            log.exception("status error")
            response.status = 500
            return {"error": "status_failed", "detail": str(e)}


def api_abort():
    try:
        body = request.json or {}
    except Exception:
        body = {}
    donation_id = (body.get("donationId") or "").strip()
    if not donation_id:
        response.status = 400
        return {"error": "donationId required"}
    # Tidak ada API cancel di bagibagi; QR hanya kedaluwarsa. Kembalikan halaman
    # ke kondisi bersih agar /create berikutnya tidak tertabrak dialog lama.
    try:
        with _lock:
            if _driver is not None and not _driver_dead:
                _js(_driver, "window.location.hash = ''; document.body.click();")
    except Exception:
        pass
    log.info("abort donation=%s", donation_id)
    return {"ok": True}


app = Bottle()
app.route("/health", method="GET", callback=api_health)
app.route("/create", method="POST", callback=api_create)
app.route("/status", method="GET", callback=api_status)
app.route("/abort", method="POST", callback=api_abort)


if __name__ == "__main__":
    host = os.environ.get("BAGIBAGI_WORKER_HOST", "127.0.0.1")
    log.info("bagibagi-worker listening on http://%s:%s page=%s", host, WORKER_PORT, PAGE_URL)
    app.run(host=host, port=WORKER_PORT, quiet=True)