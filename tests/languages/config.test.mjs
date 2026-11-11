import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';

const {
  classifyTrigger,
  defaultLanguagePair,
  describeLanguagePair,
  isLongEnoughToDetect,
  isTranslatableInput,
  languagesMatch,
  meaningfulText,
} = await loadTs('languages/config.ts');
const { canonicalLanguage, languageOptionLabel, translatorLanguages } = await loadTs('languages/catalog.ts');

test('the default pair remains Chinese to English', () => {
  assert.deepEqual(defaultLanguagePair, { source: 'zh', target: 'en' });
  assert.equal(translatorLanguages.some(language => language.code === 'zh'), true);
  assert.equal(translatorLanguages.some(language => language.code === 'zh-Hant'), true);
  assert.equal(translatorLanguages.some(language => language.code === 'en'), true);
  assert.equal(new Set(translatorLanguages.map(language => language.code)).size, translatorLanguages.length);
});

test('Han text matches a Chinese trigger and other languages wait for detection', () => {
  assert.equal(isTranslatableInput('你好', defaultLanguagePair), true);
  assert.equal(isTranslatableInput('你好', { source: 'zh', target: 'ja' }), true);
  assert.equal(isTranslatableInput('Hello', defaultLanguagePair), false);
  assert.equal(classifyTrigger('你好', 'ja'), 'detect');
  assert.equal(classifyTrigger('你好', 'zh-Hant'), 'detect');
  assert.equal(classifyTrigger('Hello', 'zh-Hant'), 'skip');
  assert.equal(isTranslatableInput('你好', { source: 'ja', target: 'en' }), false);
});

test('links, mentions, emoji, and punctuation are not treated as text', () => {
  assert.equal(meaningfulText('https://x.com/test @alice 🔥!!!'), '');
  assert.equal(classifyTrigger('https://x.com @alice 🔥!!!', 'en'), 'skip');
  assert.equal(classifyTrigger('https://x.com 你好', 'zh'), 'match');
  assert.equal(isLongEnoughToDetect('Hello'), false);
  assert.equal(isLongEnoughToDetect('Hello world'), true);
  assert.equal(isLongEnoughToDetect('こんにちは'), true);
});

test('language matching keeps Chinese variants distinct', () => {
  assert.equal(languagesMatch('zh-CN', 'zh'), true);
  assert.equal(languagesMatch('zh-Hans-CN', 'zh'), true);
  assert.equal(languagesMatch('zh-Hant', 'zh'), false);
  assert.equal(languagesMatch('zh-HK', 'zh'), false);
  assert.equal(languagesMatch('zh-TW', 'zh-Hant'), true);
  assert.equal(languagesMatch('zh-Hant-TW', 'zh-Hant'), true);
  assert.equal(languagesMatch('en-US', 'en'), true);
  assert.equal(languagesMatch('nb', 'no'), true);
  assert.equal(languagesMatch('ja', 'en'), false);
  assert.equal(canonicalLanguage('ZH-hant'), 'zh-Hant');
  assert.equal(canonicalLanguage('xx'), null);
  assert.match(languageOptionLabel('ja'), /^Japanese/);
  assert.equal(languageOptionLabel('en'), 'English');
});

test('language labels follow the configured pair', async () => {
  assert.equal(describeLanguagePair(defaultLanguagePair), 'Chinese → English');
  assert.equal(describeLanguagePair({ source: 'zh', target: 'ja' }), 'Chinese → Japanese');
  assert.equal(describeLanguagePair({ source: 'en', target: 'zh-Hant' }), 'English → Chinese (Traditional)');
});
