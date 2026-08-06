'use strict';
// QA report #5 ("I need chat memory like Claude") — the transcript already survives
// WITHIN one open tab; it just never survived a page refresh. These lock the
// sessionStorage persistence helpers, including the graceful no-sessionStorage path
// (private browsing / Node — sessionStorage is undefined there, exercised naturally
// by NOT defining a fake one in some tests).
const test = require('node:test');
const assert = require('node:assert');
const Agent = require('../../public/js/components/agent');

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('loadPersistedTranscript: no sessionStorage (e.g. Node/private browsing) -> [], never throws', () => {
  assert.deepStrictEqual(Agent.loadPersistedTranscript(), []);
});
test('persistTranscript / clearPersistedTranscript: no-ops without sessionStorage, never throw', () => {
  assert.doesNotThrow(() => Agent.persistTranscript([{ role: 'user', content: 'hi' }]));
  assert.doesNotThrow(() => Agent.clearPersistedTranscript());
});

test('persistTranscript then loadPersistedTranscript round-trips the transcript', () => {
  global.sessionStorage = fakeStorage();
  try {
    const t = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    Agent.persistTranscript(t);
    assert.deepStrictEqual(Agent.loadPersistedTranscript(), t);
  } finally { delete global.sessionStorage; }
});

test('clearPersistedTranscript removes it (load returns [] after)', () => {
  global.sessionStorage = fakeStorage();
  try {
    Agent.persistTranscript([{ role: 'user', content: 'x' }]);
    Agent.clearPersistedTranscript();
    assert.deepStrictEqual(Agent.loadPersistedTranscript(), []);
  } finally { delete global.sessionStorage; }
});

test('loadPersistedTranscript: garbled/non-array JSON in storage -> [], never throws', () => {
  global.sessionStorage = fakeStorage();
  try {
    global.sessionStorage.setItem('agent_transcript', '{"not":"an array"}');
    assert.deepStrictEqual(Agent.loadPersistedTranscript(), []);
    global.sessionStorage.setItem('agent_transcript', 'not even json{{{');
    assert.deepStrictEqual(Agent.loadPersistedTranscript(), []);
  } finally { delete global.sessionStorage; }
});

test('persistTranscript: a non-array input is stored as [] defensively', () => {
  global.sessionStorage = fakeStorage();
  try {
    Agent.persistTranscript('not-an-array');
    assert.deepStrictEqual(Agent.loadPersistedTranscript(), []);
  } finally { delete global.sessionStorage; }
});
