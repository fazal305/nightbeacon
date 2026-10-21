import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WEB_TRANSLATORS, guessNllbLanguage, parseMicrosoftReply, parseYandexReply, looksDegenerate, decodeEntities } from './webTranslate.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function fake(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const [status, body, text] = handler(String(url), init);
    return {
      ok: status === 200,
      status,
      headers: { get: () => null },
      text: async () => text ?? (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  return calls;
}

test('source language guess tells close languages apart', () => {
  assert.equal(guessNllbLanguage('عاجل: انفجار في الميناء'), 'arb_Arab');
  assert.equal(guessNllbLanguage('خبر فوری: انفجار در بندر گزارش شد'), 'pes_Arab');
  assert.equal(guessNllbLanguage('پاکستان میں دھماکہ ہوا ہے'), 'urd_Arab');
  assert.equal(guessNllbLanguage('Терміново: вибух у порту'), 'ukr_Cyrl');
  assert.equal(guessNllbLanguage('Срочно: взрыв в порту'), 'rus_Cyrl');
  assert.equal(guessNllbLanguage("İstanbul'da patlama oldu"), 'tur_Latn');
  assert.equal(guessNllbLanguage('hello world'), null);
});

test('bing: fetches a token once, then translates; replies parsed', async () => {
  const calls = fake((url) => (url.includes('/translate/auth') ? [200, null, 'TOKEN123'] : [200, [{ detectedLanguage: { language: 'ar' }, translations: [{ text: 'Explosion at the port' }] }]]));
  assert.deepEqual(await WEB_TRANSLATORS.bing('انفجار'), { text: 'Explosion at the port', lang: 'ar' });
  await WEB_TRANSLATORS.bing('انفجار');
  assert.equal(calls.filter((c) => c.url.includes('/auth')).length, 1, 'token reused');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer TOKEN123');
  assert.throws(() => parseMicrosoftReply('x', { error: 1 }), /unexpected reply/);
});

test('yandex and microsoft (keyed) translate; a missing key rests the provider', async () => {
  fake(() => [200, { code: 200, lang: 'ru-en', text: ['Explosion in the port'] }]);
  assert.deepEqual(await WEB_TRANSLATORS.yandex('взрыв'), { text: 'Explosion in the port', lang: 'ru' });
  assert.throws(() => parseYandexReply({ code: 403 }), /unexpected/);

  delete process.env.MS_TRANSLATOR_KEY;
  await assert.rejects(WEB_TRANSLATORS.microsoft('x'), (err) => err.systemic && err.retryAfterMs === 3600_000);
  process.env.MS_TRANSLATOR_KEY = 'k';
  process.env.MS_TRANSLATOR_REGION = 'westeurope';
  const calls = fake(() => [200, [{ detectedLanguage: { language: 'fa' }, translations: [{ text: 'News' }] }]]);
  assert.equal((await WEB_TRANSLATORS.microsoft('خبر')).text, 'News');
  assert.equal(calls[0].init.headers['Ocp-Apim-Subscription-Region'], 'westeurope');
  delete process.env.MS_TRANSLATOR_KEY;
});

test('deepl: free keys use the free host; out of monthly allowance rests it for hours', async () => {
  process.env.DEEPL_API_KEY = 'abc:fx';
  const calls = fake(() => [200, { translations: [{ detected_source_language: 'RU', text: 'Hello' }] }]);
  assert.deepEqual(await WEB_TRANSLATORS.deepl('привет'), { text: 'Hello', lang: 'ru' });
  assert.match(calls[0].url, /api-free\.deepl\.com/);
  fake(() => [456, 'Quota exceeded']);
  await assert.rejects(WEB_TRANSLATORS.deepl('x'), (err) => err.systemic && err.retryAfterMs === 6 * 3600_000);
  delete process.env.DEEPL_API_KEY;
});

test('mymemory, cloudflare, huggingface, nllb: language passed, quota and unknown language handled', async () => {
  let calls = fake(() => [200, { responseStatus: 200, responseData: { translatedText: 'Urgent' } }]);
  assert.equal((await WEB_TRANSLATORS.mymemory('عاجل')).text, 'Urgent');
  assert.match(calls[0].url, /langpair=ar%7Cen/);
  fake(() => [200, { responseStatus: 200, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }]);
  await assert.rejects(WEB_TRANSLATORS.mymemory('عاجل'), (err) => err.systemic);
  await assert.rejects(WEB_TRANSLATORS.mymemory('hello world'), (err) => err.systemic === false, 'unknown language: next provider');

  process.env.CLOUDFLARE_ACCOUNT_ID = 'acc';
  process.env.CLOUDFLARE_API_TOKEN = 'tok';
  calls = fake(() => [200, { success: true, result: { translated_text: 'Explosion' } }]);
  assert.equal((await WEB_TRANSLATORS.cloudflare('Срочно: взрыв')).text, 'Explosion');
  assert.equal(JSON.parse(calls[0].init.body).source_lang, 'ru');

  process.env.HF_TOKEN = 'hf';
  calls = fake(() => [200, [{ translation_text: 'Explosion' }]]);
  assert.equal((await WEB_TRANSLATORS.huggingface('Терміново: вибух')).text, 'Explosion');
  assert.equal(JSON.parse(calls[0].init.body).parameters.src_lang, 'ukr_Cyrl');

  process.env.NLLB_URL = 'http://127.0.0.1:6060';
  calls = fake(() => [200, { text: 'Explosion in the port' }]);
  assert.equal((await WEB_TRANSLATORS.nllb('خبر فوری: انفجار در بندر')).text, 'Explosion in the port');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'خبر فوری: انفجار در بندر', src: 'pes_Arab' });
  for (const k of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'NLLB_URL']) delete process.env[k];
});

test('garbled machine translations are rejected; entities decoded', () => {
  const ar = 'تحذير أمريكي لدول الشرق الأوسط من تصعيد حاد في المنطقة';
  assert.equal(looksDegenerate(ar, 'American warning to Middle East states of a sharp escalation in the region'), false);
  assert.equal(looksDegenerate(ar, ''), true, 'empty for real text');
  assert.equal(looksDegenerate('#tag', ''), false, 'nothing to translate');
  assert.equal(looksDegenerate(ar, 'Website | | | | | | | | |'), true);
  assert.equal(looksDegenerate(ar, '# #ايت a ______________'), true);
  assert.equal(looksDegenerate(ar, "From the message of the People's People's People's People's People's Front"), true);
  assert.equal(looksDegenerate(ar + ' ' + ar, '- ?'), true, 'mostly symbols');
  assert.equal(decodeEntities('the &quot;NAZA&quot; film &amp; Israel&apos;s'), 'the "NAZA" film & Israel\'s');
});
