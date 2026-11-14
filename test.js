import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:3000';

async function postJson(endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(res.status, 200, `Expected 200 from ${endpoint}, got ${res.status}`);
  return res.json();
}

async function runTests() {
  console.log('🧪 Starting Edge Automated Verification Suite...\n');

  // 1. Health & Model Verification (Gemini 3 Flash-Lite + Gemini 3.8 TTS)
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  const health = await healthRes.json();
  console.log('1. Health & Active Models:', health);
  assert.equal(health.status, 'ok');
  assert.ok(
    health.judgeModel.startsWith('gemini-3'),
    `Expected newest Gemini 3 judge model, got ${health.judgeModel}`
  );
  assert.ok(
    health.ttsModel.startsWith('gemini-3') && health.ttsModel.includes('tts'),
    `Expected newest Gemini 3 TTS model, got ${health.ttsModel}`
  );
  assert.equal(
    'apiKey' in health,
    false,
    'API key must NEVER be exposed in /api/health response'
  );

  // 2. Verify no API key exists in any public frontend files
  const publicFiles = ['index.html', 'app.js', 'mascot.js', 'styles.css'];
  for (const file of publicFiles) {
    const content = fs.readFileSync(path.join(process.cwd(), 'public', file), 'utf8');
    assert.equal(
      /AIzaSy[A-Za-z0-9_-]{33}/.test(content),
      false,
      `Found leaked API key pattern in public/${file}`
    );
  }
  console.log('2. Frontend Security Audit: PASSED (Zero API keys in browser bundle)');

  // 3. Test Mid-Sentence Rolling Evaluation: "The Eiffel Tower is in London..."
  // First 4 words ("The Eiffel Tower is") -> should be SILENT (INCOMPLETE)
  const partialEiffel = await postJson('/api/evaluate', {
    transcript: 'The Eiffel Tower is',
    isPartialStream: true
  });
  console.log('3a. Partial harmless phrase ("The Eiffel Tower is"):', partialEiffel.verdict, partialEiffel.category);
  assert.equal(partialEiffel.verdict, 'SILENT');

  // At 6th word ("The Eiffel Tower is in London") while user is still mid-sentence -> MUST INTERRUPT!
  const wrongEiffel = await postJson('/api/evaluate', {
    transcript: 'The Eiffel Tower is in London',
    isPartialStream: true
  });
  console.log('3b. Mid-sentence factual error ("The Eiffel Tower is in London"):', {
    verdict: wrongEiffel.verdict,
    wrongTriggerWord: wrongEiffel.wrongTriggerWord,
    correction: wrongEiffel.correction
  });
  assert.equal(wrongEiffel.verdict, 'INTERRUPT');
  assert.ok(wrongEiffel.correction.length > 10, 'Correction must be non-empty');
  assert.ok(
    /habibi|yalla|mashallah|wallah/i.test(wrongEiffel.correction),
    'Correction should include natural light Arabic phrase'
  );

  // 4. Test Opinion Silence: "Pineapple on pizza is the best" -> MUST STAY SILENT
  const opinionRes = await postJson('/api/evaluate', {
    transcript: 'Pineapple on pizza is the best',
    isPartialStream: false
  });
  console.log('4. Opinion check ("Pineapple on pizza is the best"):', {
    verdict: opinionRes.verdict,
    category: opinionRes.category,
    correction: opinionRes.correction
  });
  assert.equal(opinionRes.verdict, 'SILENT');
  assert.equal(opinionRes.correction, '');

  // 5. Extra Test: "The Burj Khalifa is in Abu Dhabi" -> MUST INTERRUPT
  const burjRes = await postJson('/api/evaluate', {
    transcript: 'The Burj Khalifa is in Abu Dhabi',
    isPartialStream: true
  });
  console.log('5. Extra Test ("The Burj Khalifa is in Abu Dhabi"):', {
    verdict: burjRes.verdict,
    wrongTriggerWord: burjRes.wrongTriggerWord,
    correction: burjRes.correction
  });
  assert.equal(burjRes.verdict, 'INTERRUPT');
  assert.ok(
    /dubai/i.test(burjRes.correction),
    'Burj Khalifa correction should reference Dubai'
  );

  // 6. Multilingual Tests (Arabic & Hindi)
  const arabicRes = await postJson('/api/evaluate', {
    transcript: 'برج خليفة في أبوظبي',
    isPartialStream: true
  });
  console.log('6a. Arabic Factual Error ("برج خليفة في أبوظبي"):', {
    verdict: arabicRes.verdict,
    languageDetected: arabicRes.languageDetected,
    correction: arabicRes.correction
  });
  assert.equal(arabicRes.verdict, 'INTERRUPT');

  const hindiRes = await postJson('/api/evaluate', {
    transcript: 'ताजमहल मुंबई में है',
    isPartialStream: true
  });
  console.log('6b. Hindi Factual Error ("ताजमहल मुंबई में है"):', {
    verdict: hindiRes.verdict,
    languageDetected: hindiRes.languageDetected,
    correction: hindiRes.correction
  });
  assert.equal(hindiRes.verdict, 'INTERRUPT');

  // 7. Factual Truth Silence: "The Burj Khalifa is in Downtown Dubai"
  const trueRes = await postJson('/api/evaluate', {
    transcript: 'The Burj Khalifa is in Downtown Dubai',
    isPartialStream: false
  });
  console.log('7. Factual Truth ("The Burj Khalifa is in Downtown Dubai"):', {
    verdict: trueRes.verdict,
    category: trueRes.category
  });
  assert.equal(trueRes.verdict, 'SILENT');
  assert.equal(trueRes.correction, '');

  console.log('\n✅ ALL AUTOMATED VERIFICATION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
