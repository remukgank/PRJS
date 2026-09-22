const assert = require('assert');
const { initDatabase, saveLiveChatRoute, getLiveChatRoute, pool } = require('../db');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS  ${name}`);
}

(async () => {
  await initDatabase();
  const adminMsgId = 9_000_001;
  const userChatId = 12_345;
  const userName = 'Tester Satu';

  await saveLiveChatRoute(adminMsgId, userChatId, 1, userName);
  const row = await getLiveChatRoute(adminMsgId);
  ok('rute tersimpan dan terbaca', row && Number(row.user_chat_id) === userChatId && row.user_name === userName);

  const missing = await getLiveChatRoute(99_999);
  ok('id tak dikenal → null', missing === null);

  await saveLiveChatRoute(adminMsgId, userChatId, 2, 'Nama Baru');
  const updated = await getLiveChatRoute(adminMsgId);
  ok('ON CONFLICT: user_message diperbarui, 1 baris', Number(updated.user_msg_id) === 2 && updated.user_name === 'Nama Baru');

  const count = Number((await pool.query('SELECT COUNT(*) c FROM livechat_route WHERE admin_msg_id = $1', [adminMsgId])).rows[0].c);
  ok('tetap 1 baris', count === 1);

  await pool.query('DELETE FROM livechat_route WHERE admin_msg_id = $1', [adminMsgId]);
  console.log(`RESULT: ${passed} pass, 0 fail`);
  process.exit(0);
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});