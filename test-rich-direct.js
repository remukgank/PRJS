/**
 * test-rich-direct.js
 * Direct test sendRichMessage to cloud API (no bot polling needed).
 *
 * Run: TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node scraper/test-rich-direct.js
 */

const https = require('https');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('ERROR: Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  console.error('Example: TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node scraper/test-rich-direct.js');
  process.exit(1);
}

function sendRichMessage(chatId, content, format = 'html') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      rich_message: {
        [format]: content,
        is_rtl: false,
        skip_entity_detection: false,
      },
    });

    const req = https.request(
      `https://api.telegram.org/bot${TOKEN}/sendRichMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.ok) resolve(json.result);
            else reject(new Error(json.description || JSON.stringify(json)));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('=== Test sendRichMessage (Cloud API) ===\n');

  // Test 1: HTML
  console.log('Test 1: HTML format');
  try {
    const html = '<b>Bold</b> | <i>Italic</i> | <code>Code</code>\n\n<pre>Code block</pre>';
    const result = await sendRichMessage(CHAT_ID, html, 'html');
    console.log('✅ Success:', result.message_id);
  } catch (err) {
    console.error('❌ Failed:', err.message);
  }

  // Test 2: Markdown
  console.log('\nTest 2: Markdown format');
  try {
    const md = '**Bold** | *Italic* | `Code`\n\n```\nCode block\n```';
    const result = await sendRichMessage(CHAT_ID, md, 'markdown');
    console.log('✅ Success:', result.message_id);
  } catch (err) {
    console.error('❌ Failed:', err.message);
  }

  // Test 3: AI response style
  console.log('\nTest 3: AI response style');
  try {
    const ai = [
      '<b>🤖 AI Response</b>',
      '',
      'Ini contoh <i>rich message</i> dari bot.',
      '',
      '<b>Features:</b>',
      '• Bold text',
      '• <i>Italic text</i>',
      '• <code>Inline code</code>',
      '',
      '<pre>function hello() {\n  console.log("Hello!");\n}</pre>',
    ].join('\n');
    const result = await sendRichMessage(CHAT_ID, ai, 'html');
    console.log('✅ Success:', result.message_id);
  } catch (err) {
    console.error('❌ Failed:', err.message);
  }

  console.log('\nDone!');
})();
