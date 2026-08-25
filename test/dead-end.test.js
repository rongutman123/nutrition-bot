// The bot answering "I didn't understand" to everything, for hours, was never a
// parsing problem — it was a turn that ended with no write and no text, and a
// fallback message that blamed the user for it. These cover every way a turn can
// come back empty.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  claudeCalls, scriptClaude, say, useTool,
  post, textUpdate, resetAll, db, lastText, seedGoals,
} from './harness.js';

const { default: handler } = await import('../api/agent.js');

/* A turn that produces nothing at all — no text block, no tool use. */
const silent = () => ({ stop_reason: 'end_turn', content: [] });
/* A web-search continuation that has not said anything yet. */
const silentPause = () => ({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'x' } }] });

beforeEach(() => {
  resetAll();
  seedGoals();
});

describe('a turn that comes back empty', () => {
  test('an answer from an earlier round survives a silent wrap-up round', async () => {
    scriptClaude(
      useTool('query_log', { days: 7 }, { text: '🔥 <b>1,900</b> קק"ל בממוצע' }),
      silent()
    );
    await post(handler, textUpdate('כמה אכלתי בממוצע השבוע?'));

    assert.match(lastText(), /1,900/);
  });

  test('web-search pauses do not consume the tool-round budget', async () => {
    scriptClaude(
      silentPause(), silentPause(), silentPause(),
      say('🍗 <b>250</b> קק"ל למנה')
    );
    await post(handler, textUpdate('כמה קלוריות במנת נאגטס של מקדונלדס?'));

    assert.match(lastText(), /250/, 'the answer after the searches is delivered');
    assert.doesNotMatch(lastText(), /לא הצלחתי/);
  });

  test('a silent turn is rescued by asking again without the conversation', async () => {
    scriptClaude(
      silent(),                       // the turn itself
      silent(),                       // retry with tools off
      say('🍌 בננה בינונית — <b>105</b> קק"ל')  // retry with no tools and no history
    );
    await post(handler, textUpdate('בננה'));

    assert.match(lastText(), /105/);
    const bare = claudeCalls.at(-1);
    assert.equal(bare.tools, undefined, 'the last resort sends no tools');
    assert.equal(bare.messages.length, 1, 'and no history — a poisoned history is the usual cause');
  });

  test('a genuine dead end says it is a bug, and carries the reason', async () => {
    scriptClaude(silent(), silent(), silent());
    await post(handler, textUpdate('בננה'));

    assert.match(lastText(), /לא הצלחתי לענות/);
    assert.match(lastText(), /תקלה אצלי/, 'never blames the wording');
    assert.match(lastText(), /stop=end_turn/, 'the reason is debuggable from the chat');
    assert.doesNotMatch(lastText(), /לא הבנתי/);
    assert.equal(db.rows('meals').length, 0);
  });

  test('a failed tool is reported in the diagnostic instead of vanishing', async () => {
    scriptClaude(
      useTool('log_meal', { items: [], confidence: 'high' }), // rejected: empty items
      silent(), silent(), silent()
    );
    await post(handler, textUpdate('משהו'));

    assert.match(lastText(), /log_meal/);
    assert.equal(db.rows('meals').length, 0);
  });
});

describe('an unanswered turn does not poison the next one', () => {
  test('a dangling user turn is folded into the next message, not answered by a fake assistant', async () => {
    scriptClaude(silent(), silent(), silent());
    await post(handler, textUpdate('אכלתי יוגורט'));

    scriptClaude(say('🥛 רשמתי'));
    await post(handler, textUpdate('דנונה 0%'));

    const msgs = claudeCalls.at(-1).messages;
    assert.equal(msgs.length, 1, 'no invented assistant turn');
    assert.equal(msgs[0].role, 'user');
    assert.match(msgs[0].content, /אכלתי יוגורט/, 'the unanswered message is still in context');
    assert.match(msgs[0].content, /דנונה 0%/);
    assert.doesNotMatch(JSON.stringify(msgs), /אין תשובה שמורה/);
  });
});
