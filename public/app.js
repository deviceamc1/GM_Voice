/**
 * EDGE — Frontend Live Voice & Mid-Sentence Cut-In Controller
 * - Re-evaluates live speech every 2–3 words while the user is still speaking (without waiting for a pause).
 * - Measures exact millisecond latency from the wrong word spoken to Edge's first audio sound.
 * - Keeps GEMINI_API_KEY strictly on the server.
 */

import { EdgeMascotVisualizer } from './mascot.js';

const canvasEl = document.getElementById('edge-mascot-canvas');
const mascot = new EdgeMascotVisualizer(canvasEl);

// DOM References
const activeJudgeModelEl = document.getElementById('active-judge-model');
const activeTtsModelEl = document.getElementById('active-tts-model');
const securityStatusDot = document.getElementById('security-status-dot');
const keyStatusLabel = document.getElementById('key-status-label');

const mascotStateBadge = document.getElementById('mascot-state-badge');
const mascotStateText = document.getElementById('mascot-state-text');

const latencyHud = document.getElementById('latency-hud');
const latencyTriggerWordBadge = document.getElementById('latency-trigger-word-badge');
const latencyTotalMs = document.getElementById('latency-total-ms');
const latencyBreakdownText = document.getElementById('latency-breakdown-text');

const verdictStage = document.getElementById('verdict-stage');
const verdictChip = document.getElementById('verdict-chip');
const verdictMeta = document.getElementById('verdict-meta');
const edgeSpokenQuote = document.getElementById('edge-spoken-quote');

const streamActiveDot = document.getElementById('stream-active-dot');
const wordCheckCounter = document.getElementById('word-check-counter');
const tokenizedTranscript = document.getElementById('tokenized-transcript');

const micToggleBtn = document.getElementById('mic-toggle-btn');
const micBtnTitle = document.getElementById('mic-btn-title');
const micBtnSub = document.getElementById('mic-btn-sub');
const replayVoiceBtn = document.getElementById('replay-voice-btn');

const customSpeechForm = document.getElementById('custom-speech-form');
const customSpeechInput = document.getElementById('custom-speech-input');
const ledgerList = document.getElementById('ledger-list');
const clearLedgerBtn = document.getElementById('clear-ledger-btn');

// Modal DOM
const openKeyModalBtn = document.getElementById('open-key-modal-btn');
const closeKeyModalBtn = document.getElementById('close-key-modal-btn');
const cancelKeyModalBtn = document.getElementById('cancel-key-modal-btn');
const keyModal = document.getElementById('key-modal');
const keyConfigForm = document.getElementById('key-config-form');
const serverApiKeyInput = document.getElementById('server-api-key-input');

// Runtime State
let audioCtx = null;
let currentAudioSource = null;
let lastSpokenCorrection = null;
let lastSpokenAudioBase64 = null;
let lastSpokenLanguage = 'en';

let isMicListening = false;
let speechRecognition = null;
let isRecognitionRunning = false;
let micMediaStream = null;
let micAnalyser = null;
let micResultStartIndex = 0;
let awaitingNextMicUtterance = false;
let micAutoResumeTimer = null;

// Rolling Mid-Sentence Word Stream State
let streamSessionId = 0;
let activeStreamTimer = null;
let wordRegistry = []; // [{ word, timestamp, isCheckpoint }]
let rollingCheckCount = 0;
let isInterruptedCurrentStream = false;

// Single-flight coalescing state so interim speech events never clog browser HTTP connections
let inFlightEvalCount = 0;
let queuedEvalParams = null;
let interimDebounceTimer = null;

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Safely starts Web Speech API recognition if Live Mic mode is active and Edge isn't currently speaking.
 */
function safeStartSpeechRecognition() {
  if (!isMicListening || !speechRecognition || isRecognitionRunning) return;
  try {
    speechRecognition.start();
  } catch (e) {
    // Ignore InvalidStateError if already started
  }
}

/**
 * Automatically resumes Live Mic listening as soon as Edge finishes speaking a cut-in correction,
 * so the user can immediately speak their next sentence without toggling the mic button off and on.
 */
function resumeLiveMicAfterEdgeSpeaks() {
  if (micAutoResumeTimer) {
    clearTimeout(micAutoResumeTimer);
    micAutoResumeTimer = null;
  }

  if (isMicListening) {
    isInterruptedCurrentStream = false;
    awaitingNextMicUtterance = true;
    if (micAnalyser) {
      mascot.connectAnalyser(micAnalyser);
    } else {
      mascot.connectAnalyser(null);
    }
    mascot.setState('LISTENING');
    streamActiveDot.classList.add('active');
    updateMascotStateUI(
      'LISTENING',
      'LIVE MIC ACTIVE • SPEAK NEXT SENTENCE (AUTO-LISTENING)'
    );
    safeStartSpeechRecognition();
  } else {
    mascot.connectAnalyser(null);
    mascot.setState('IDLE');
    updateMascotStateUI('IDLE', 'PASSIVE GUARDIAN • LISTENING EVERY 2–3 WORDS');
  }
}

/**
 * Plays the instant 24K golden acoustic cut-in chime at t=0ms and returns the exact performance.now() timestamp.
 */
function playCutInChimeNow() {
  const ctx = ensureAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(528, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(792, ctx.currentTime + 0.11);
  gain.gain.setValueAtTime(0.14, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.connect(gain);
  gain.connect(ctx.destination);
  const firstSoundTime = performance.now();
  osc.start();
  osc.stop(ctx.currentTime + 0.16);
  return firstSoundTime;
}

async function decodeAndPlayWavBase64(audioBase64) {
  const ctx = ensureAudioContext();
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) {
      // ignore
    }
    currentAudioSource = null;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }

  const binaryString = atob(audioBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  mascot.connectAnalyser(analyser);

  const startMoment = performance.now();
  source.start(0);
  currentAudioSource = source;

  source.onended = () => {
    currentAudioSource = null;
    if (mascot.state === 'INTERRUPT_SPEAKING') {
      resumeLiveMicAfterEdgeSpeaks();
    }
  };
  return startMoment;
}

/**
 * Plays Edge's witty voice using the exact Iteration 1 Gemini TTS ('Puck') audio from the server.
 * Only falls back to browser speechSynthesis if no API key is configured on the server.
 */
async function playEdgeCutInVoice({ correction, audioBase64, language = 'en', skipChime = false }) {
  ensureAudioContext();

  // Stop any previous audio or speech synthesis
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) {
      // ignore
    }
    currentAudioSource = null;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  if (micAutoResumeTimer) {
    clearTimeout(micAutoResumeTimer);
    micAutoResumeTimer = null;
  }

  lastSpokenCorrection = correction;
  if (audioBase64) {
    lastSpokenAudioBase64 = audioBase64;
  }
  lastSpokenLanguage = language;
  replayVoiceBtn.disabled = false;

  mascot.setState('INTERRUPT_SPEAKING');
  updateMascotStateUI('INTERRUPT_SPEAKING', 'EDGE CUTTING IN OUT LOUD • DUBAI FACT GUARDIAN');

  // 1. If Gemini 3 TTS ('Puck') WAV audio is already cached/present, play it immediately!
  if (audioBase64) {
    try {
      return await decodeAndPlayWavBase64(audioBase64);
    } catch (decodeErr) {
      console.warn('[Edge Audio] Falling back from inline WAV:', decodeErr);
    }
  }

  // 2. Play cut-in chime at t=0ms (if not already played) while awaiting the in-flight Gemini TTS ('Puck') audio
  const firstSoundTime = skipChime ? performance.now() : playCutInChimeNow();

  // 3. Await the server's in-flight Gemini TTS ('Puck') synthesis so we always get the authentic Iteration 1 voice!
  try {
    const ttsRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: correction, language })
    });
    if (ttsRes.ok) {
      const ttsData = await ttsRes.json();
      if (ttsData && ttsData.audioBase64) {
        lastSpokenAudioBase64 = ttsData.audioBase64;
        await decodeAndPlayWavBase64(ttsData.audioBase64);
        return firstSoundTime;
      }
    }
  } catch (ttsErr) {
    console.warn('[Edge /api/tts fetch error]:', ttsErr);
  }

  // 4. Fallback ONLY when no Gemini API key is configured on the server (or offline)
  if ('speechSynthesis' in window && correction) {
    const utter = new SpeechSynthesisUtterance(correction);
    utter.lang = language === 'ar' ? 'ar-AE' : language === 'hi' ? 'hi-IN' : 'en-US';
    utter.rate = 1.05;
    utter.pitch = 1.02;

    utter.onend = () => {
      if (mascot.state === 'INTERRUPT_SPEAKING') {
        resumeLiveMicAfterEdgeSpeaks();
      }
    };
    utter.onerror = () => {
      if (mascot.state === 'INTERRUPT_SPEAKING') {
        resumeLiveMicAfterEdgeSpeaks();
      }
    };
    window.speechSynthesis.speak(utter);
  }

  // Safety timer to guarantee mic resumes even if speechSynthesis onend doesn't fire
  const estimatedDurationMs = Math.max(2800, Math.min(6800, correction.length * 48));
  micAutoResumeTimer = setTimeout(() => {
    if (mascot.state === 'INTERRUPT_SPEAKING' && !currentAudioSource) {
      resumeLiveMicAfterEdgeSpeaks();
    }
  }, estimatedDurationMs);

  return firstSoundTime;
}

function updateMascotStateUI(state, label) {
  mascotStateBadge.dataset.state = state;
  mascotStateText.textContent = label;
}

/**
 * Renders the live tokenized transcript bar showing each word spoken so far,
 * highlighting 2-3 word check boundaries, the exact wrong trigger word, and any cut-off tail.
 */
function renderTokenizedStream(wrongTriggerWord = '', droppedWords = []) {
  tokenizedTranscript.innerHTML = '';

  if (wordRegistry.length === 0 && droppedWords.length === 0) {
    const span = document.createElement('span');
    span.className = 'transcript-placeholder';
    span.textContent = 'Start speaking or trigger a live mid-sentence stream below...';
    tokenizedTranscript.appendChild(span);
    return;
  }

  const normalizedTrigger = (wrongTriggerWord || '').toLowerCase().trim();
  const triggerParts = normalizedTrigger ? normalizedTrigger.split(/\s+/) : [];

  wordRegistry.forEach((entry, idx) => {
    const tokenEl = document.createElement('span');
    tokenEl.className = 'word-token';
    if (entry.isCheckpoint) {
      tokenEl.classList.add('checkpoint-word');
    }

    const cleanWord = entry.word.replace(/[.,!?،।"]/g, '').toLowerCase();
    if (
      normalizedTrigger &&
      (cleanWord === normalizedTrigger || triggerParts.includes(cleanWord))
    ) {
      tokenEl.classList.add('wrong-trigger');
    }

    tokenEl.textContent = entry.word;
    tokenizedTranscript.appendChild(tokenEl);
  });

  if (isInterruptedCurrentStream) {
    const marker = document.createElement('span');
    marker.className = 'cut-marker-pill';
    marker.textContent = '⚡ EDGE CUT IN MID-SENTENCE';
    tokenizedTranscript.appendChild(marker);
  }

  // Render any remaining words of the sentence that were cut off when Edge jumped in
  droppedWords.forEach((w) => {
    const droppedEl = document.createElement('span');
    droppedEl.className = 'word-token cutoff-dropped';
    droppedEl.title = 'Cut off mid-sentence by Edge';
    droppedEl.textContent = w;
    tokenizedTranscript.appendChild(droppedEl);
  });
}

/**
 * Finds the exact performance.now() timestamp when the wrong word was spoken in the rolling stream.
 */
function findWrongWordTimestamp(wrongTriggerWord) {
  if (!wordRegistry.length) return performance.now() - 120;
  if (wrongTriggerWord) {
    const target = wrongTriggerWord.toLowerCase().trim();
    const parts = target.split(/\s+/);
    // Search from the most recent word backwards to match the last word of the wrong trigger phrase
    for (let i = wordRegistry.length - 1; i >= 0; i--) {
      const w = wordRegistry[i].word.replace(/[.,!?،।"]/g, '').toLowerCase();
      if (w === target || parts.includes(w)) {
        return wordRegistry[i].timestamp;
      }
    }
  }
  return wordRegistry[wordRegistry.length - 1].timestamp;
}

/**
 * Updates the Wrong-Word-to-First-Sound Stopwatch HUD and appends to the Session Audit Ledger.
 */
function updateVerdictAndTelemetry({
  result,
  spokenTextSoFar,
  wrongWordToFirstSoundMs,
  isFinalSentence
}) {
  if (result.verdict === 'INTERRUPT') {
    verdictStage.dataset.verdict = 'INTERRUPT';
    verdictChip.textContent = `⚡ MID-SENTENCE CUT-IN • ${result.arabicPhraseUsed || 'HABIBI'}`;
    verdictMeta.textContent = `Trigger: "${result.wrongTriggerWord || 'Factual Error'}" • ${result.dubaiReference || 'Dubai Fact Check'}`;
    edgeSpokenQuote.textContent = `“${result.correction}”`;

    // Update Stopwatch HUD
    latencyHud.classList.add('flash-active');
    setTimeout(() => latencyHud.classList.remove('flash-active'), 650);

    latencyTriggerWordBadge.textContent = `TRIGGER: "${(result.wrongTriggerWord || 'ERROR').toUpperCase()}"`;
    latencyTotalMs.textContent = `${wrongWordToFirstSoundMs} ms`;
    const judgeMs = result.judgeLatencyMs ?? 0;
    const ttsMs = result.ttsLatencyMs ?? 0;
    latencyBreakdownText.textContent = `Judge: ${judgeMs}ms • TTS: ${ttsMs}ms`;

    prependLedgerItem({
      verdict: 'INTERRUPT',
      category: result.category,
      claim: spokenTextSoFar,
      triggerWord: result.wrongTriggerWord,
      correction: result.correction,
      latencyMs: wrongWordToFirstSoundMs,
      modelUsed: result.judgeModelUsed
    });
  } else if (isFinalSentence) {
    // Only transition to the calm emerald SILENT_APPROVAL banner once the sentence finishes without error
    mascot.setState('SILENT_APPROVAL');
    updateMascotStateUI(
      'SILENT_APPROVAL',
      `EDGE STAYS QUIET • ${result.category === 'OPINION' ? 'OPINION RESPECTED' : 'FACT VERIFIED'}`
    );

    verdictStage.dataset.verdict = 'SILENT';
    verdictChip.textContent =
      result.category === 'OPINION'
        ? '◈ GOLDEN SILENCE • SUBJECTIVE OPINION'
        : '◈ GOLDEN SILENCE • FACTUALLY TRUE';
    verdictMeta.textContent = `Evaluated in ${result.judgeLatencyMs || 1}ms • 0 dB vocal output`;
    edgeSpokenQuote.textContent =
      result.category === 'OPINION'
        ? '“(Silence — Edge gives a warm Emirati nod. Taste and opinions are always yours, Habibi!)”'
        : '“(Silence — Factually spot-on, Mashallah. Edge stays completely quiet.)”';

    latencyTriggerWordBadge.textContent =
      result.category === 'OPINION' ? 'OPINION → SILENT' : 'TRUE → SILENT';
    latencyTotalMs.textContent = 'SILENT (0 dB)';
    latencyBreakdownText.textContent = `Verified in ${result.judgeLatencyMs || 1}ms • No interruption`;

    prependLedgerItem({
      verdict: 'SILENT',
      category: result.category,
      claim: spokenTextSoFar,
      triggerWord: '',
      correction: 'Edge stayed completely silent.',
      latencyMs: result.judgeLatencyMs || 1,
      modelUsed: result.judgeModelUsed
    });
  }
}

function prependLedgerItem({
  verdict,
  category,
  claim,
  triggerWord,
  correction,
  latencyMs,
  modelUsed
}) {
  const emptyEl = ledgerList.querySelector('.ledger-empty');
  if (emptyEl) emptyEl.remove();

  const item = document.createElement('div');
  item.className = `ledger-item ${verdict === 'INTERRUPT' ? 'ledger-interrupt' : 'ledger-silent'}`;

  const badgeText =
    verdict === 'INTERRUPT'
      ? `⚡ CUT-IN (${latencyMs}ms from "${triggerWord || 'word'}")`
      : `◈ SILENT (${category})`;

  item.innerHTML = `
    <div class="ledger-item-top">
      <span>${badgeText}</span>
      <span>${modelUsed || 'gemini-3.5-flash-lite'}</span>
    </div>
    <div class="ledger-claim">“${escapeHtml(claim)}”</div>
    <div class="ledger-response">${escapeHtml(correction)}</div>
  `;

  ledgerList.prepend(item);
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Evaluates the current rolling word buffer against /api/evaluate.
 * Uses coalescing concurrency control so rapid interim mic events never clog browser HTTP connections,
 * and triggers the UI + acoustic cut-in at t=0ms while streaming Iteration 1 Gemini TTS ('Puck') voice.
 */
async function evaluateRollingWindow({
  sessionId,
  isFinalSentence = false,
  remainingWords = []
}) {
  if (sessionId !== streamSessionId || isInterruptedCurrentStream) return null;

  const spokenTextSoFar = wordRegistry.map((w) => w.word).join(' ');
  if (!spokenTextSoFar.trim()) return null;

  // Prevent browser 6-connection pool starvation during rapid live mic speech:
  // allow at most 2 concurrent in-flight evaluations and coalesce intermediate snapshots into queuedEvalParams
  if (inFlightEvalCount >= 2 && !isFinalSentence) {
    queuedEvalParams = { sessionId, isFinalSentence, remainingWords };
    return null;
  }

  inFlightEvalCount += 1;
  rollingCheckCount += 1;
  wordCheckCounter.textContent = `Checks: ${rollingCheckCount} • Words: ${wordRegistry.length}`;

  try {
    const response = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: spokenTextSoFar,
        isPartialStream: !isFinalSentence,
        includeAudio: false,
        requestId: `${sessionId}-${rollingCheckCount}`
      })
    });

    if (!response.ok) return null;
    const result = await response.json();

    // Verify stream hasn't been superseded or already interrupted
    if (sessionId !== streamSessionId || isInterruptedCurrentStream) return null;

    if (result.verdict === 'INTERRUPT') {
      isInterruptedCurrentStream = true;
      queuedEvalParams = null;
      if (interimDebounceTimer) {
        clearTimeout(interimDebounceTimer);
        interimDebounceTimer = null;
      }

      // Immediately halt any ongoing simulated word stream or live mic recognition!
      if (activeStreamTimer) {
        clearInterval(activeStreamTimer);
        activeStreamTimer = null;
      }
      if (speechRecognition && isMicListening) {
        try {
          speechRecognition.abort();
        } catch (e) {
          // ignore
        }
      }
      streamActiveDot.classList.remove('active');

      // 1. Highlight the exact wrong word and show the remaining words that got cut off mid-sentence
      renderTokenizedStream(result.wrongTriggerWord, remainingWords);

      // 2. Fire the golden acoustic cut-in chime at t=0ms and lock the latency stopwatch IMMEDIATELY!
      const wrongWordTime = findWrongWordTimestamp(result.wrongTriggerWord);
      const firstSoundTime = playCutInChimeNow();
      const wrongWordToFirstSoundMs = Math.max(
        8,
        Math.round(firstSoundTime - wrongWordTime)
      );

      // 3. Update the Verdict Stage, Spoken Quote, and Stopwatch HUD at t=0ms BEFORE waiting for TTS audio!
      updateVerdictAndTelemetry({
        result,
        spokenTextSoFar,
        wrongWordToFirstSoundMs,
        isFinalSentence: true
      });

      // 4. Play Edge's Iteration 1 Gemini TTS ('Puck') voice (and auto-resume mic when finished)
      await playEdgeCutInVoice({
        correction: result.correction,
        audioBase64: result.audioBase64 || null,
        language: result.languageDetected || 'en',
        skipChime: true
      });

      return result;
    }

    if (isFinalSentence) {
      streamActiveDot.classList.remove('active');
      updateVerdictAndTelemetry({
        result,
        spokenTextSoFar,
        wrongWordToFirstSoundMs: 0,
        isFinalSentence: true
      });
    }
    return result;
  } catch (err) {
    console.error('[Edge Rolling Evaluation Error]:', err);
    return null;
  } finally {
    inFlightEvalCount = Math.max(0, inFlightEvalCount - 1);
    if (
      queuedEvalParams &&
      !isInterruptedCurrentStream &&
      queuedEvalParams.sessionId === streamSessionId
    ) {
      const nextCall = queuedEvalParams;
      queuedEvalParams = null;
      evaluateRollingWindow(nextCall);
    }
  }
}

/**
 * Streams an utterance word-by-word at realistic live speaking cadence,
 * triggering a non-blocking check on EVERY word after word 3 WITHOUT waiting for a pause,
 * so Edge cuts the speaker off mid-sentence the exact millisecond a wrong fact word appears!
 */
export async function streamUtteranceMidSentence(fullSentence) {
  const words = fullSentence.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return;

  ensureAudioContext();

  // Reset current stream state
  if (activeStreamTimer) {
    clearInterval(activeStreamTimer);
    activeStreamTimer = null;
  }
  if (interimDebounceTimer) {
    clearTimeout(interimDebounceTimer);
    interimDebounceTimer = null;
  }
  queuedEvalParams = null;
  streamSessionId += 1;
  const currentSession = streamSessionId;
  wordRegistry = [];
  rollingCheckCount = 0;
  isInterruptedCurrentStream = false;

  streamActiveDot.classList.add('active');
  mascot.setState('LISTENING');
  mascot.setSimulatedEnergy(0.32);
  updateMascotStateUI('LISTENING', 'USER SPEAKING • RE-CHECKING EVERY WORD MID-SENTENCE');

  let index = 0;
  const WORD_CADENCE_MS = 160; // Natural speaking cadence so mid-sentence cut-off is unmistakable

  return new Promise((resolve) => {
    activeStreamTimer = setInterval(async () => {
      if (currentSession !== streamSessionId || isInterruptedCurrentStream) {
        clearInterval(activeStreamTimer);
        activeStreamTimer = null;
        resolve();
        return;
      }

      if (index < words.length) {
        const word = words[index];
        index += 1;
        const isLastWord = index === words.length;
        // Re-check on EVERY word once at least 3 words are spoken!
        const shouldCheckpoint = index >= 3 || isLastWord;

        wordRegistry.push({
          word,
          timestamp: performance.now(),
          isCheckpoint: shouldCheckpoint
        });

        mascot.setSimulatedEnergy(0.28 + Math.random() * 0.35);
        renderTokenizedStream();
        wordCheckCounter.textContent = `Checks: ${rollingCheckCount} • Words: ${wordRegistry.length}`;

        if (shouldCheckpoint) {
          const remainingWords = words.slice(index);
          const evalRes = await evaluateRollingWindow({
            sessionId: currentSession,
            isFinalSentence: isLastWord,
            remainingWords
          });
          if (evalRes?.verdict === 'INTERRUPT' || isLastWord) {
            clearInterval(activeStreamTimer);
            activeStreamTimer = null;
            resolve(evalRes);
          }
        }
      } else {
        clearInterval(activeStreamTimer);
        activeStreamTimer = null;
        resolve();
      }
    }, WORD_CADENCE_MS);
  });
}

/**
 * Real-Time Browser Microphone Streaming (Web Speech API interimResults + Web Audio Analyser)
 * Automatically resets and continues listening across unlimited back-to-back sentences!
 */
async function toggleLiveMicrophone() {
  if (isMicListening) {
    stopLiveMicrophone();
    return;
  }

  ensureAudioContext();
  const SpeechRecognitionClass =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  try {
    micMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const micSource = audioCtx.createMediaStreamSource(micMediaStream);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 128;
    micSource.connect(micAnalyser);
    mascot.connectAnalyser(micAnalyser);
  } catch (micErr) {
    console.warn('[Edge Mic] Audio stream analyser unavailable:', micErr.message);
  }

  if (!SpeechRecognitionClass) {
    verdictMeta.textContent =
      'Browser SpeechRecognition unavailable — use the Live Stream bar or scenario cards!';
    return;
  }

  isMicListening = true;
  micToggleBtn.setAttribute('aria-pressed', 'true');
  micBtnTitle.textContent = 'Listening Live (Click to Stop)';
  micBtnSub.textContent = 'Auto-continues across sentences';
  streamActiveDot.classList.add('active');
  mascot.setState('LISTENING');
  updateMascotStateUI('LISTENING', 'LIVE MIC ACTIVE • RE-CHECKING EVERY WORD MID-SENTENCE');

  streamSessionId += 1;
  wordRegistry = [];
  rollingCheckCount = 0;
  isInterruptedCurrentStream = false;
  awaitingNextMicUtterance = false;
  micResultStartIndex = 0;
  queuedEvalParams = null;

  let lastCheckedTranscript = '';
  let lastCheckedWordCount = 0;

  speechRecognition = new SpeechRecognitionClass();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.maxAlternatives = 1;
  speechRecognition.lang = 'en-US';

  speechRecognition.onstart = () => {
    isRecognitionRunning = true;
    micResultStartIndex = 0;
  };

  speechRecognition.onresult = (event) => {
    // Ignore microphone pickup while Edge is speaking out loud
    if (isInterruptedCurrentStream || mascot.state === 'INTERRUPT_SPEAKING') return;

    let combinedTranscript = '';
    let hasFinal = false;
    for (let i = micResultStartIndex; i < event.results.length; i++) {
      combinedTranscript += event.results[i][0].transcript + ' ';
      if (event.results[i].isFinal && i === event.results.length - 1) {
        hasFinal = true;
      }
    }

    const cleanTranscript = combinedTranscript.trim();
    const spokenWords = cleanTranscript.split(/\s+/).filter(Boolean);
    if (spokenWords.length === 0) return;

    // If the previous sentence finished (either SILENT or INTERRUPT), automatically start a clean window
    // on the very first word of the user's new sentence!
    if (awaitingNextMicUtterance) {
      awaitingNextMicUtterance = false;
      streamSessionId += 1;
      wordRegistry = [];
      rollingCheckCount = 0;
      lastCheckedTranscript = '';
      lastCheckedWordCount = 0;
      queuedEvalParams = null;
      streamActiveDot.classList.add('active');
      mascot.setState('LISTENING');
      updateMascotStateUI('LISTENING', 'LIVE MIC ACTIVE • RE-CHECKING EVERY WORD MID-SENTENCE');
    }

    const activeSession = streamSessionId;

    // Stamp new words with exact performance.now() arrival time
    const now = performance.now();
    const updatedRegistry = spokenWords.map((w, idx) => {
      const existing = wordRegistry[idx];
      if (existing && existing.word.toLowerCase() === w.toLowerCase()) {
        return existing;
      }
      return {
        word: w,
        timestamp: now,
        isCheckpoint: idx >= 2
      };
    });

    wordRegistry = updatedRegistry;
    renderTokenizedStream();

    // If this sentence just finalized, advance micResultStartIndex so the next sentence starts fresh!
    if (hasFinal) {
      micResultStartIndex = event.results.length;
      awaitingNextMicUtterance = true;
      if (interimDebounceTimer) {
        clearTimeout(interimDebounceTimer);
        interimDebounceTimer = null;
      }
      lastCheckedTranscript = cleanTranscript;
      lastCheckedWordCount = wordRegistry.length;
      evaluateRollingWindow({
        sessionId: activeSession,
        isFinalSentence: true,
        remainingWords: []
      });
      return;
    }

    // Trigger mid-sentence check whenever a new word is added (once >= 3 words)
    // OR after a 240ms pause on the current word so we don't spam 60 syllable requests!
    if (wordRegistry.length >= 3) {
      if (wordRegistry.length > lastCheckedWordCount) {
        lastCheckedWordCount = wordRegistry.length;
        lastCheckedTranscript = cleanTranscript;
        if (interimDebounceTimer) {
          clearTimeout(interimDebounceTimer);
          interimDebounceTimer = null;
        }
        evaluateRollingWindow({
          sessionId: activeSession,
          isFinalSentence: false,
          remainingWords: []
        });
      } else if (cleanTranscript !== lastCheckedTranscript) {
        if (interimDebounceTimer) clearTimeout(interimDebounceTimer);
        interimDebounceTimer = setTimeout(() => {
          if (!isInterruptedCurrentStream && activeSession === streamSessionId) {
            lastCheckedTranscript = cleanTranscript;
            evaluateRollingWindow({
              sessionId: activeSession,
              isFinalSentence: false,
              remainingWords: []
            });
          }
        }, 240);
      }
    }
  };

  speechRecognition.onerror = () => {
    // Keep listening unless explicitly stopped or currently speaking an interrupt
  };

  speechRecognition.onend = () => {
    isRecognitionRunning = false;
    if (
      isMicListening &&
      !isInterruptedCurrentStream &&
      mascot.state !== 'INTERRUPT_SPEAKING'
    ) {
      safeStartSpeechRecognition();
    }
  };

  safeStartSpeechRecognition();
}

function stopLiveMicrophone() {
  isMicListening = false;
  isRecognitionRunning = false;
  awaitingNextMicUtterance = false;
  if (micAutoResumeTimer) {
    clearTimeout(micAutoResumeTimer);
    micAutoResumeTimer = null;
  }
  if (interimDebounceTimer) {
    clearTimeout(interimDebounceTimer);
    interimDebounceTimer = null;
  }
  queuedEvalParams = null;

  micToggleBtn.setAttribute('aria-pressed', 'false');
  micBtnTitle.textContent = 'Start Live Mic';
  micBtnSub.textContent = 'Continuous mid-sentence listening';
  streamActiveDot.classList.remove('active');

  if (speechRecognition) {
    try {
      speechRecognition.abort();
    } catch (e) {
      // ignore
    }
    speechRecognition = null;
  }
  if (micMediaStream) {
    micMediaStream.getTracks().forEach((t) => t.stop());
    micMediaStream = null;
  }
  micAnalyser = null;
  mascot.connectAnalyser(null);
  mascot.setState('IDLE');
  updateMascotStateUI('IDLE', 'PASSIVE GUARDIAN • LISTENING EVERY 2–3 WORDS');
}

// ============================================================================
// Event Listeners & Initialization
// ============================================================================

micToggleBtn.addEventListener('click', toggleLiveMicrophone);

replayVoiceBtn.addEventListener('click', () => {
  if (lastSpokenCorrection) {
    playEdgeCutInVoice({
      correction: lastSpokenCorrection,
      audioBase64: lastSpokenAudioBase64,
      language: lastSpokenLanguage
    });
  }
});

customSpeechForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = customSpeechInput.value.trim();
  if (!text) return;
  customSpeechInput.value = '';
  streamUtteranceMidSentence(text);
});

document.querySelectorAll('[data-utterance]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const utterance = btn.getAttribute('data-utterance');
    if (utterance) {
      streamUtteranceMidSentence(utterance);
    }
  });
});

clearLedgerBtn.addEventListener('click', () => {
  ledgerList.innerHTML =
    '<div class="ledger-empty">Every rolling 2–3 word check and cut-in latency will appear here.</div>';
});

// Server-Side API Key Vault Modal
openKeyModalBtn.addEventListener('click', () => {
  keyModal.classList.remove('hidden');
  serverApiKeyInput.focus();
});

const closeModal = () => keyModal.classList.add('hidden');
closeKeyModalBtn.addEventListener('click', closeModal);
cancelKeyModalBtn.addEventListener('click', closeModal);

keyConfigForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = serverApiKeyInput.value.trim();
  if (!apiKey) return;

  try {
    const res = await fetch('/api/config-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    const data = await res.json();
    if (data.ok) {
      serverApiKeyInput.value = '';
      closeModal();
      await syncServerTelemetry();
    }
  } catch (err) {
    console.error('[Edge Key Vault Error]:', err);
  }
});

async function syncServerTelemetry() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    activeJudgeModelEl.textContent = data.judgeModel || 'gemini-3.5-flash-lite';
    activeTtsModelEl.textContent = data.ttsModel || 'gemini-3.8-flash-lite-tts';
    if (data.apiKeyConfigured) {
      securityStatusDot.style.background = 'hsl(160, 75%, 48%)';
      keyStatusLabel.textContent = 'Key Secured (Server)';
    } else {
      securityStatusDot.style.background = 'hsl(42, 88%, 58%)';
      keyStatusLabel.textContent = 'Set Server Key';
    }
  } catch (err) {
    console.warn('[Edge Telemetry Sync]:', err.message);
  }
}

syncServerTelemetry();
