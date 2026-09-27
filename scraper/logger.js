const pino = require('pino');
// pino-pretty tidak dipakai lagi: output terminal sekarang satu baris ringkas
// (lihat terminalFormat) — pretty + ringkas = dobel output yang bikin ribet.
const path = require('path');
const fs = require('fs');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const level = process.env.LOG_LEVEL || 'info';

function truncateLog(filePath, maxLines) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    if (lines.length <= maxLines + 1) return;
    fs.writeFileSync(filePath, lines.slice(-maxLines).join('\n') + '\n');
  } catch {}
}

truncateLog(path.join(LOG_DIR, 'app.log'), 500);
truncateLog(path.join(LOG_DIR, 'ffmpeg.log'), 500);
truncateLog(path.join(LOG_DIR, 'local-api.log'), 1000);

const baseOpts = {
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) { return { level: label }; },
    bindings() { return {}; },
  },
};

// Terminal-friendly: SATU BARIS per event, field penting saja, tanpa JSON.
// Dipakai kalau bot jalan di pm2 — output pm2 menumpuk di
// ~/.pm2/logs/prjs-bot-out.log, jauh dari terminal, sehingga trace jadi ribet.
// Format: HH:MM:SS LEVEL  pesan  ·  key=value
// Matikan dengan LOG_TERMINAL=off.
const TERMINAL_ON = (process.env.LOG_TERMINAL || 'on').toLowerCase() !== 'off';
// Field yang dicetak ke terminal. Harus mencakup semua field log yang dipakai
// untuk trace — kalau tidak, informasi hanya ada di logs/app.log (JSON) padahal
// yang enak dibaca cepat justru yang muncul di `pm2 logs`.
// Dipakai: progres unduhan + query/hasil !dell & !vdell (f4428ca).
const terminalKeys = [
  // unduhan
  'mb', 'totalMb', 'kbps', 'etaSec', 'container', 'sizeMb', 'source', 'attempt',
  // media & target
  'ep', 'part', 'target', 'title', 'file', 'server', 'quality',
  // !dell / !vdell — query & hasil (f4428ca)
  'q', 'hasil', 'slugs', 'rows', 'keys', 'media_key', 'terhapus', 'sisa', 'dari',
  'fileTerhapus', 'gagal',
  // konteks umum
  'chatId', 'err',
];
function fmtVal(v) {
  if (Array.isArray(v)) return v.length ? `[${v.join(',')}]` : '[]';
  return String(v);
}
function terminalFormat(obj) {
  const o = obj || {};
  const time = o.time ? new Date(o.time).toTimeString().slice(0, 8)
    : new Date().toTimeString().slice(0, 8);
  const lvl = String(o.level || 'info').toUpperCase().padEnd(5);
  const msg = o.msg ? String(o.msg) : (o.err ? String(o.err) : '');
  const rest = [];
  for (const k of terminalKeys) {
    if (o[k] !== undefined && o[k] !== null && k !== 'err') rest.push(`${k}=${fmtVal(o[k])}`);
  }
  const err = o.err && o.err !== o.msg ? `  ! ${o.err}` : '';
  const tail = rest.length ? '  ·  ' + rest.join(' ') : '';
  return `${time} ${lvl} ${msg}${err}${tail}\n`;
}

const appLogFile = pino.transport({
  target: 'pino/file',
  options: { destination: path.join(LOG_DIR, 'app.log') },
});

const streams = [{ stream: appLogFile }];
if (TERMINAL_ON) {
  streams.push({
    stream: { write: (line) => { try { process.stdout.write(terminalFormat(JSON.parse(line))); } catch {} } },
  });
}

const appLogger = pino(baseOpts, pino.multistream(streams));

const ffmpegLogger = pino(
  { ...baseOpts, level: 'info' },
  pino.transport({
    target: 'pino/file',
    options: { destination: path.join(LOG_DIR, 'ffmpeg.log') },
  })
);

function childLogger(bindings) {
  return appLogger.child(bindings);
}

module.exports = { logger: appLogger, ffmpegLogger, childLogger, LOG_DIR };
