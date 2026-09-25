'use strict';

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'tg-emoji', 'tg-time', 'code', 'pre', 'blockquote',
]);

const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*?)?)\/?>/;
const ENTITY_RE = /^&(lt|gt|amp|quot);|^&#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6});/;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHtml(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  const src = value;
  let out = '';
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '&') {
      const entity = src.slice(i, i + 12).match(ENTITY_RE);
      if (entity) {
        out += entity[0];
        i += entity[0].length;
        continue;
      }
      out += '&amp;';
      i += 1;
      continue;
    }
    if (ch === '<') {
      const match = src.slice(i).match(TAG_RE);
      if (match && ALLOWED_TAGS.has(match[2].toLowerCase())) {
        const closing = match[1] === '/';
        const name = match[2].toLowerCase();
        if (match[0].endsWith('/>')) {
          out += match[0];
          i += match[0].length;
          continue;
        }
        if (closing) {
          const idx = stack.lastIndexOf(name);
          if (idx < 0) {
            out += '&lt;';
            i += 1;
            continue;
          }
          for (let k = stack.length - 1; k > idx; k--) out += `</${stack[k]}>`;
          stack.length = idx;
          out += `</${name}>`;
          i += match[0].length;
          continue;
        }
        stack.push(name);
        out += match[0];
        i += match[0].length;
        continue;
      }
      out += '&lt;';
      i += 1;
      continue;
    }
    if (ch === '>') {
      out += '&gt;';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  for (let k = stack.length - 1; k >= 0; k--) out += `</${stack[k]}>`;
  return out;
}

function isTelegramBadRequest(err) {
  if (!err) return false;
  const bodyCode = err.response && err.response.body && err.response.body.error_code;
  if (typeof bodyCode === 'number') return bodyCode === 400;
  const status = err.response && err.response.status;
  if (typeof status === 'number') return status === 400;
  if (typeof err.telegramErrorCode === 'number') return err.telegramErrorCode === 400;
  return /^400\b/.test(String(err.message || ''));
}

function sanitizeHtmlPayload(payload) {
  if (!payload || payload.parse_mode !== 'HTML') return payload;
  const next = { ...payload };
  if (typeof next.text === 'string') next.text = safeHtml(next.text);
  if (typeof next.caption === 'string') next.caption = safeHtml(next.caption);
  return next;
}

function toPlainTextPayload(payload) {
  const next = { ...payload };
  delete next.parse_mode;
  if (typeof next.text === 'string') next.text = safeHtml(next.text);
  if (typeof next.caption === 'string') next.caption = safeHtml(next.caption);
  return next;
}

module.exports = { escapeHtml, safeHtml, isTelegramBadRequest, sanitizeHtmlPayload, toPlainTextPayload, ALLOWED_TAGS };
