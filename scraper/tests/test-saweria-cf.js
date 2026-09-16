/**
 * test-saweria-cf.js — Opsi A+B berlapis pada polling Saweria.
 *
 * Uji:
 *  - curlGet: header lengkap + cookie jar + deteksi challenge (Just a moment / 403)
 *  - checkPaymentStatus: direct poll OK, challenge -> escalate FlareSolverr OK,
 *    fade cepat (fail-fast) saat FlareSolverr down -> masuk consecutiveErrors biasa
 *  - tanpa network nyata: execFile dipatch (child_process.execFile), axios dipatch
 *    (require.cache axios).
 *
 * Usage: node scraper/tests/test-saweria-cf.js
 */

const cp = require('child_process');
const REAL_EXEC = cp.execFile;

let mockCurl = null;
cp.execFile = function (cmd, args, opts, cb) {
  if (typeof mockCurl === 'function') return mockCurl(cmd, args, opts, cb);
  return REAL_EXEC.apply(cp, arguments);
};

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

function freshService() {
  delete require.cache[require.resolve('../services/saweriaService')];
  return require('../services/saweriaService');
}

function mockAxios(axiosImpl) {
  require.cache[require.resolve('axios')] = { exports: axiosImpl };
  return freshService();
}

function restoreAxios() {
  delete require.cache[require.resolve('axios')];
}

function run() {
  const svc = freshService();
  const { curlGet, checkPaymentStatus, fetchViaFlareSolverr, isChallengeResponse } = svc._internal;

  // --- isChallengeResponse ---
  ok(isChallengeResponse('<!DOCTYPE html><html...<title>Just a moment...</title>...'), 'detect Just a moment');
  ok(isChallengeResponse('Attention Required! Cloudflare'), 'detect Attention Required');
  ok(!isChallengeResponse('{"data":{"id":"x","transaction_status":"pending","amount_raw":10000}}'), 'JSON biasa bukan challenge');
  ok(!isChallengeResponse('{"status":404}'), '404 JSON bukan challenge');

  let callLog = [];
  const mockCurlFn = (statusCode, body) => (cmd, args, opts, cb) => {
    callLog.push({ cmd, args });
    cb(null, `${body}\n${statusCode}`);
  };

  (async () => {
    // --- curlGet sukses (status 200 JSON) ---
    callLog = [];
    mockCurl = mockCurlFn(200, '{"data":{"id":"abc","transaction_status":"pending","amount_raw":10000}}');
    try {
      const r = await freshService()._internal.curlGet('https://backend.saweria.co/donations/qris/snap/xyz');
      ok(r?.data?.id === 'abc', 'curlGet parse JSON 200');
      const args = callLog[0].args.join(' ');
      ok(args.includes('-b /tmp/saweria.cookies') && args.includes('-c /tmp/saweria.cookies'), 'curlGet pakai cookie jar r+w');
      ok(args.includes('Accept: application/json'), 'curlGet pakai Accept json');
      ok(args.includes('sec-ch-ua') && args.includes('Sec-Fetch-Mode'), 'curlGet header lengkap (CURL_HEADERS)');
      ok(args.includes('-w') && args.includes('%{http_code}'), 'curlGet minta http_code');
    } catch (e) { ok(false, `curlGet 200: ${e.message}`); }

    // --- curlGet 403 challenge -> reject err.challenge ---
    callLog = [];
    mockCurl = mockCurlFn(403, '<html><title>Just a moment...</title></html>');
    try {
      await freshService()._internal.curlGet('https://backend.saweria.co/donations/qris/snap/xyz');
      ok(false, 'curlGet 403 harus reject');
    } catch (e) {
      ok(!!e.challenge, 'curlGet 403 reject dengan .challenge=true');
      ok(/HTTP 403/.test(e.message), 'curlGet 403 error menyebut HTTP 403');
    }

    // --- curlGet non-challenge (misal 404 JSON/halaman) -> challenge=false ---
    callLog = [];
    mockCurl = mockCurlFn(404, '{"error":"not found"}');
    try {
      await freshService()._internal.curlGet('https://backend.saweria.co/donations/qris/snap/no-such');
      ok(false, 'curlGet 404 harus reject');
    } catch (e) {
      ok(!e.challenge, 'curlGet 404 non-challenge reject .challenge=false');
    }

    // --- checkPaymentStatus: direct OK ---
    mockCurl = mockCurlFn(200, '{"data":{"id":"abc","transaction_status":"pending","amount_raw":10000}}');
    try {
      const st = await freshService()._internal.checkPaymentStatus('abc');
      ok(st?.id === 'abc' && st?.status === 'pending' && st?.amount === 10000, 'checkPaymentStatus direct OK');
    } catch (e) { ok(false, `checkPaymentStatus direct: ${e.message}`); }

    // --- checkPaymentStatus: FS down saat direct challenge -> fail-fast (non-challenge, masuk consecutiveErrors) ---
    mockCurl = mockCurlFn(403, '<html><title>Just a moment...</title></html>');
    const downAxios = {
      post: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8191'); },
    };
    restoreAxios();
    const svcDown = mockAxios(downAxios);
    const downErr = new Error('FS password?');
    downErr.failFast = true;
    const t0 = Date.now();
    try {
      await svcDown._internal.checkPaymentStatus('abc');
      ok(false, 'FS down harus reject');
    } catch (e) {
      const dt = Date.now() - t0;
      ok(/ECONNREFUSED/.test(e.message), `FS down reject cepat ${dt}ms — fail-fast, masuk consecutiveErrors`);
      ok(dt < 3000, `fail-fast < 3s (actual ${dt}ms)`);
      ok(!e.challenge, 'error FS-down bukan challenge (poll normal lanjut round berikutnya via A)');
    }

    // --- checkPaymentStatus: challenge -> escalate FlareSolverr OK (SUCCESS) ---
    mockCurl = mockCurlFn(403, '<html><title>Just a moment...</title></html>');
    const okAxios = {
      post: async (u, body, opts) => ({
        data: { status: 'ok', solution: { response: '{"data":{"id":"abc","transaction_status":"SUCCESS","amount_raw":10000}}' } },
      }),
    };
    restoreAxios();
    const svcOk = mockAxios(okAxios);
    try {
      const st = await svcOk._internal.checkPaymentStatus('abc');
      ok(st?.status === 'SUCCESS', 'challenge -> FlareSolverr OK (SUCCESS)');
    } catch (e) { ok(false, `escalate OK: ${e.message}`); }

    // --- checkPaymentStatus: FS passthrough non-JSON -> err.challenge=true (bukan fail-fast) ---
    mockCurl = mockCurlFn(403, '<html><title>Just a moment...</title></html>');
    const nonJsonAxios = {
      post: async () => ({ data: { status: 'ok', solution: { response: '<html>Just a moment...' } } }),
    };
    restoreAxios();
    const svcNonJson = mockAxios(nonJsonAxios);
    try {
      await svcNonJson._internal.checkPaymentStatus('abc');
      ok(false, 'FS passthrough non-JSON harus reject');
    } catch (e) {
      ok(!!e.challenge, 'FS passthrough non-JSON reject .challenge=true');
    }

    // --- curlPost juga pakai cookie jar ---
    callLog = [];
    mockCurl = (cmd, args, opts, cb) => { callLog.push({ args }); cb(null, '{"ok":true}'); };
    try {
      const svcPost = freshService();
      await svcPost._internal.curlPost('https://backend.saweria.co/donations/snap/user', { amount: 1000 });
      const a = callLog[0].args.join(' ');
      ok(a.includes('-b /tmp/saweria.cookies') && a.includes('-c /tmp/saweria.cookies'), 'curlPost pakai cookie jar r+w');
    } catch (e) { ok(false, `curlPost cookie: ${e.message}`); }

    mockCurl = null;
    restoreAxios();

    console.log(`\n${pass} pass, ${fail} fail`);
    process.exit(fail ? 1 : 0);
  })();
}

run();