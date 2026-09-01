const pino = require('pino');
const pretty = require('pino-pretty');
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

const consoleStream = pretty({
  colorize: true,
  translateTime: 'HH:MM:ss',
  ignore: 'pid,hostname',
  destination: 1,
});

const appLogFile = pino.transport({
  target: 'pino/file',
  options: { destination: path.join(LOG_DIR, 'app.log') },
});

const appLogger = pino(baseOpts, pino.multistream([
  { stream: appLogFile },
  { stream: consoleStream },
]));

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
