/**
 * test-rich.js
 * Test sendRichMessage via cloud API.
 *
 * Run: TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node scraper/test-rich.js
 */

const { sendRichMessage } = require('./bot');

const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!CHAT_ID) {
  console.error('ERROR: Set TELEGRAM_CHAT_ID environment variable');
  console.error('Example: TELEGRAM_CHAT_ID=123456789 node scraper/test-rich.js');
  process.exit(1);
}

(async () => {
  console.log('Testing sendRichMessage via cloud API...\n');

  // Test 1: HTML format
  console.log('Test 1: HTML format');
  try {
    const htmlContent = [
      '<b>Bold text</b>',
      '<i>Italic text</i>',
      '<code>Inline code</code>',
      '<s>Strikethrough</s>',
      '<a href="https://telegram.org">Link</a>',
      '',
      '<pre>Code block</pre>',
    ].join('\n');

    const result = await sendRichMessage(CHAT_ID, htmlContent, { format: 'html' });
    console.log('✅ HTML sent:', result.message_id);
  } catch (err) {
    console.error('❌ HTML failed:', err.message);
  }

  // Test 2: Markdown format
  console.log('\nTest 2: Markdown format');
  try {
    const mdContent = [
      '**Bold text**',
      '*Italic text*',
      '`Inline code`',
      '~~Strikethrough~~',
      '[Link](https://telegram.org)',
      '',
      '```',
      'Code block',
      '```',
    ].join('\n');

    const result = await sendRichMessage(CHAT_ID, mdContent, { format: 'markdown' });
    console.log('✅ Markdown sent:', result.message_id);
  } catch (err) {
    console.error('❌ Markdown failed:', err.message);
  }

  // Test 3: AI response style
  console.log('\nTest 3: AI response style');
  try {
    const aiContent = [
      '<b>🤖 AI Response</b>',
      '',
      'Ini adalah contoh response dengan format <i>rich message</i>.',
      '',
      '<b>Features:</b>',
      '• Bold text',
      '• <i>Italic text</i>',
      '• <code>Code</code>',
      '',
      '<pre>',
      'function hello() {',
      '  console.log("Hello World!");',
      '}',
      '</pre>',
    ].join('\n');

    const result = await sendRichMessage(CHAT_ID, aiContent, { format: 'html' });
    console.log('✅ AI style sent:', result.message_id);
  } catch (err) {
    console.error('❌ AI style failed:', err.message);
  }

  console.log('\nDone!');
})();
