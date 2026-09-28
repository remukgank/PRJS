'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V_PATH = path.join(__dirname, '..', 'vidoy-uploader');

function loadUploaderWithCurl(fakeCurl) {
  const cp = require('node:child_process');
  const realExecFile = cp.execFile;
  for (const key of Object.keys(require.cache)) {
    if (key === V_PATH || key.endsWith('/vidoy-uploader.js')) delete require.cache[key];
  }
  cp.execFile = fakeCurl;
  try {
    return require(V_PATH);
  } finally {
    cp.execFile = realExecFile;
  }
}

function response(body, code = 200) {
  return `${body}\n${code}`;
}

async function run() {
  const warning = '<br /><b>Deprecated</b>: explode(): Passing null to parameter #2 ($string) is deprecated';
  const parsed = require(V_PATH).parseJsonLoose(`${warning}\n{"status":200,"filecode":"ok1"}`);
  assert.deepEqual(parsed, { status: 200, filecode: 'ok1' });
  assert.deepEqual(require(V_PATH).parseCurlResponse(`${warning}\n200`), {
    body: warning,
    code: 200,
  });

  const oldEnv = {
    VIDOY_USERNAME: process.env.VIDOY_USERNAME,
    VIDOY_PASSWORD: process.env.VIDOY_PASSWORD,
    VIDOY_COOKIE_JAR: process.env.VIDOY_COOKIE_JAR,
    VIDOY_CDN_URL: process.env.VIDOY_CDN_URL,
  };
  const cookie = path.join(os.tmpdir(), `vidoy-cdn-response-${process.pid}.cookie`);
  const filePath = path.join(os.tmpdir(), 'Demo — Ep 05.mp4');
  fs.writeFileSync(filePath, 'fake video');
  process.env.VIDOY_USERNAME = 'test-user';
  process.env.VIDOY_PASSWORD = 'test-password';
  process.env.VIDOY_COOKIE_JAR = cookie;
  process.env.VIDOY_CDN_URL = 'https://upload.vidoycdn.com/413';

  const fakeCurl = (cmd, args, opts, cb) => {
    const flat = args.join(' ');
    let body = '';
    let code = 200;
    if (flat.includes('/signin')) {
      fs.writeFileSync(cookie, 'session');
      body = 'logged in';
    } else if (flat.includes('/folders')) {
      body = JSON.stringify([{
        id: 'root',
        name: 'ANIME',
        parent: '',
        child: [{ id: 'folder-1', name: 'Demo', parent: 'root', child: [] }],
      }]);
    } else if (flat.includes('upload.vidoycdn.com')) {
      body = `${warning}\n<b>Warning</b>: Undefined array key 1`;
    } else if (flat.includes('folder_ajax/folder-1')) {
      body = JSON.stringify({
        contents: { videos: [{ id: 'file-5', title: 'Demo — Ep 05.mp4' }] },
        page: { current: 1, next: null },
      });
    } else if (flat.includes('/view/file-5')) {
      body = 'https://vidkud.com/e/file-5';
    }
    process.nextTick(() => cb(null, response(body, code), ''));
    return { stderr: { on() {} } };
  };

  try {
    const V = loadUploaderWithCurl(fakeCurl);
    const result = await V.upload(filePath, null, ['ANIME', 'Demo']);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.fromListing, true);
    assert.equal(result.filecode, 'file-5');
    assert.equal(result.link, 'https://vidkud.com/e/file-5');
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(cookie, { force: true });
    fs.rmSync(filePath, { force: true });
  }

  console.log('vidoy CDN response/reconciliation: 3/3 passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});