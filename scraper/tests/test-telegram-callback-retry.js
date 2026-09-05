const assert = require('node:assert/strict');
const {
  initTelegram,
  wrapAnswerCallbackQuery,
} = require('../lib/telegram');

function setupBot(behavior, maxRetry = 2) {
  const calls = [];
  const bot = {
    answerCallbackQuery: async function (queryId, options) {
      calls.push({ queryId, options });
      return behavior(calls.length);
    },
  };
  initTelegram({ API_MAX_RETRY: maxRetry });
  const sleeps = [];
  wrapAnswerCallbackQuery(bot, async (ms) => sleeps.push(ms));
  return { bot, calls, sleeps };
}

async function run() {
  {
    const { bot, calls, sleeps } = setupBot(() => 'ok');
    assert.equal(await bot.answerCallbackQuery('q-success', { text: 'ok' }), 'ok');
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }

  {
    const { bot, calls, sleeps } = setupBot((attempt) => {
      if (attempt === 1) {
        const err = new Error('Too Many Requests');
        err.response = { body: { parameters: { retry_after: 1 } } };
        throw err;
      }
      return 'recovered';
    });
    assert.equal(await bot.answerCallbackQuery('q-retry'), 'recovered');
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [1500]);
  }

  {
    const { bot, calls, sleeps } = setupBot(() => {
      const err = new Error('Too Many Requests');
      err.response = { body: { parameters: { retry_after: 1 } } };
      throw err;
    }, 2);
    await assert.rejects(() => bot.answerCallbackQuery('q-exhausted'), /Too Many Requests/);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [1500, 1500]);
  }

  {
    const { bot, calls, sleeps } = setupBot(() => {
      throw new Error('network failure');
    });
    await assert.rejects(() => bot.answerCallbackQuery('q-non-429'), /network failure/);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }

  console.log('telegram callback retry mock: 4/4 passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});