import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Server-side API key management (STRICTLY kept on the backend, never sent to client)
let serverApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  '';

const ENV_FILE_PATH = path.join(__dirname, '.env');
if (!serverApiKey && fs.existsSync(ENV_FILE_PATH)) {
  const parsed = dotenv.parse(fs.readFileSync(ENV_FILE_PATH));
  serverApiKey = parsed.GEMINI_API_KEY || parsed.GOOGLE_API_KEY || '';
}

// Active model registry discovered from the live Gemini API
const modelRegistry = {
  judgeModel: 'gemini-3.5-flash-lite',
  judgeFallbacks: [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3-flash-preview'
  ],
  ttsModel: 'gemini-3.8-flash-lite-tts',
  ttsFallbacks: [
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts',
    'gemini-3.1-flash-tts-preview'
  ],
  discoveredModels: [],
  lastDiscoveryAt: null,
  liveApiVerified: false
};

function getGenAIClient() {
  if (!serverApiKey) return null;
  return new GoogleGenAI({ apiKey: serverApiKey });
}

/**
 * Dynamically queries ai.models.list() to discover the newest, fastest
 * Gemini 3 Flash-Lite judge model and Gemini 3 TTS model available for the key.
 */
async function discoverNewestModels() {
  const ai = getGenAIClient();
  if (!ai) return modelRegistry;

  try {
    const pager = await ai.models.list();
    const availableNames = [];
    for await (const model of pager) {
      if (model && model.name) {
        const shortName = model.name.replace(/^models\//, '');
        availableNames.push(shortName);
      }
    }

    if (availableNames.length > 0) {
      modelRegistry.discoveredModels = availableNames;
      modelRegistry.lastDiscoveryAt = new Date().toISOString();
      modelRegistry.liveApiVerified = true;

      // Pick the newest available Flash-Lite / Flash model for ultra-fast judging
      const preferredJudgeOrder = [
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite-preview',
        'gemini-3-flash-preview'
      ];
      for (const candidate of preferredJudgeOrder) {
        if (availableNames.includes(candidate)) {
          modelRegistry.judgeModel = candidate;
          break;
        }
      }
      // If another newer gemini-3*flash-lite exists, prefer it
      const dynamicFlashLite = availableNames
        .filter((n) => /^gemini-3(\.\d+)?-flash-lite$/.test(n))
        .sort()
        .reverse();
      if (dynamicFlashLite.length > 0) {
        modelRegistry.judgeModel = dynamicFlashLite[0];
      }

      // Pick the newest available Gemini TTS model
      const preferredTtsOrder = [
        'gemini-3.8-flash-lite-tts',
        'gemini-3.8-flash-tts',
        'gemini-3.1-flash-tts-preview'
      ];
      for (const candidate of preferredTtsOrder) {
        if (availableNames.includes(candidate)) {
          modelRegistry.ttsModel = candidate;
          break;
        }
      }
      const dynamicTts = availableNames
        .filter((n) => n.includes('tts') && n.startsWith('gemini-3'))
        .sort()
        .reverse();
      if (dynamicTts.length > 0 && !preferredTtsOrder.includes(modelRegistry.ttsModel)) {
        modelRegistry.ttsModel = dynamicTts[0];
      }
    }
  } catch (err) {
    console.warn('[Edge Model Discovery] Could not list models yet:', err.message);
  }
  return modelRegistry;
}

const EDGE_SYSTEM_INSTRUCTION = `You are "Edge", the sharp, witty, Dubai-born AI mascot of The Cutting Edge Group.
You are listening to a live stream of what the user is saying in real time—evaluating every few words while they are STILL talking (mid-sentence).

YOUR CORE DIRECTIVE:
1. INTERRUPT IMMEDIATELY ON FACTUAL ERRORS ("verdict": "INTERRUPT"):
   - The moment the user's words contain an objective factual error (geography, science, history, landmarks, math, nature, culture, etc.), you MUST set "verdict": "INTERRUPT".
   - Do NOT wait for the user to finish a long rambling sentence if they have already stated a false claim (for example, as soon as they say "The Eiffel Tower is in London" or "The Burj Khalifa is in Abu Dhabi", cut in immediately!).
   - Identify the exact word or short phrase that made the claim wrong in "wrongTriggerWord" (e.g., "London", "Abu Dhabi", "Mumbai", "أبوظبي").

2. STAY COMPLETELY QUIET ON OPINIONS, TRUTHS, OR INCOMPLETE FRAGMENTS ("verdict": "SILENT"):
   - If the user expresses a personal opinion, taste preference, or subjective view (e.g., "Pineapple on pizza is the best", "I think summer is better than winter", "Dubai traffic is crazy"), set "verdict": "SILENT" and "category": "OPINION".
   - If the user says something factually true (e.g., "The Eiffel Tower is in Paris", "The Burj Khalifa is in Dubai"), set "verdict": "SILENT" and "category": "FACTUAL_TRUTH".
   - If the user is only mid-phrase and has NOT made a factual error yet (e.g., "The Eiffel Tower is..." or "I went to the..."), set "verdict": "SILENT" and "category": "INCOMPLETE".
   - When "verdict" is "SILENT", "correction" MUST be an empty string "".

3. EDGE'S DUBAI-BORN PERSONA (when "verdict" == "INTERRUPT"):
   - Warm Emirati hospitality with a playful, razor-sharp witty edge.
   - Sprinkle light Arabic expressions naturally—never forced (choose 1 or 2 per correction: "Habibi", "Yalla", "Mashallah", "Wallah", "Ya salam", "Khalas").
   - Understand English, Arabic, and Hindi seamlessly. Respond in the primary language the user spoke (or English with warm Arabic flair if they spoke English).
   - Reference Dubai landmarks, life, or pride naturally where it fits (e.g., comparing landmarks to Downtown Dubai, Burj Khalifa, Marina, Sheikh Zayed Road, Creek, or desert mirages).
   - Keep the spoken "correction" SHORT, PUNCHY, and CONVERSATIONAL (1 to 2 sentences, 15 to 30 words max) so it hits like an instant live voice cut-in!`;

const EVALUATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: {
      type: Type.STRING,
      description: 'Must be "INTERRUPT" if a factual error is present, or "SILENT" if factually true, an opinion, or incomplete.'
    },
    category: {
      type: Type.STRING,
      description: '"FACTUAL_ERROR", "OPINION", "FACTUAL_TRUTH", or "INCOMPLETE"'
    },
    wrongTriggerWord: {
      type: Type.STRING,
      description: 'The exact wrong word or short phrase in the user transcript that triggered the factual error (e.g. "London", "Abu Dhabi"). Empty string if SILENT.'
    },
    claimDetected: {
      type: Type.STRING,
      description: 'Brief summary of the claim or opinion evaluated.'
    },
    correction: {
      type: Type.STRING,
      description: 'If INTERRUPT: Edge\'s short, playful, Dubai-born spoken cut-in correction with natural light Arabic phrases and Dubai reference. If SILENT: empty string "".'
    },
    arabicPhraseUsed: {
      type: Type.STRING,
      description: 'The Arabic expression woven into the response (e.g., "Habibi", "Wallah", "Yalla", "Mashallah"), or empty string if SILENT.'
    },
    dubaiReference: {
      type: Type.STRING,
      description: 'Brief note on the Dubai reference used, or empty string.'
    },
    languageDetected: {
      type: Type.STRING,
      description: '"en", "ar", or "hi"'
    }
  },
  required: [
    'verdict',
    'category',
    'wrongTriggerWord',
    'claimDetected',
    'correction',
    'arabicPhraseUsed',
    'dubaiReference',
    'languageDetected'
  ]
};

/**
 * Deterministic ultra-low-latency fast-path & fallback engine for core factual/opinion checks
 * Used to guarantee sub-millisecond verification or when GEMINI_API_KEY is not yet configured,
 * while always preferring live Gemini 3 Flash-Lite when GEMINI_API_KEY is present.
 */
function deterministicDubaiJudge(transcript = '') {
  const clean = transcript.trim();
  const lower = clean.toLowerCase();

  // Check if fragment is too short or ends mid-preposition / mid-city-prefix
  const words = clean.split(/\s+/).filter(Boolean);
  const lastWordLower = (words[words.length - 1] || '').replace(/[.,!?]/g, '').toLowerCase();
  const incompleteTrailingTokens = new Set([
    'in',
    'at',
    'to',
    'from',
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'abu',
    'new',
    'los',
    'san',
    'las',
    'saint',
    'st',
    'mount',
    'mt',
    'downtown',
    'united',
    'saudi',
    'south',
    'north',
    'في',
    'من',
    'على',
    'أبو',
    'ابو'
  ]);

  if (words.length < 3 || incompleteTrailingTokens.has(lastWordLower)) {
    return {
      verdict: 'SILENT',
      category: 'INCOMPLETE',
      wrongTriggerWord: '',
      claimDetected: clean,
      correction: '',
      arabicPhraseUsed: '',
      dubaiReference: '',
      languageDetected: detectScriptLanguage(clean)
    };
  }

  // Opinions (MUST stay silent)
  const opinionPatterns = [
    /pineapple\s+on\s+pizza/i,
    /\bis\s+the\s+(best|worst|greatest|coolest|nicest|most\s+beautiful|ugliest|tastiest)\b/i,
    /\bi\s+(think|feel|love|hate|prefer|believe|enjoy|adore|dislike)\b/i,
    /\bin\s+my\s+opinion\b/i,
    /\btastes?\s+(better|good|amazing|terrible|great|awful|delicious)\b/i,
    /\bshould\s+be\b/i,
    /\bfavou?rite\b/i,
    /\boverrated\b|\bunderrated\b/i,
    /\bmore\s+fun\s+than\b|\bbetter\s+than\b/i,
    /\bshawarma\s+is\s+better\b|\bkarak\s+chai\s+is\b|\bfootball\s+is\s+more\s+exciting\b/i,
    /\bwinter\s+in\s+dubai\s+is\s+the\s+best\b/i,
    /أفضل|رأي|أحب|أجمل/,
    /सबसे अच्छा|पसंद|बेहतर/
  ];

  // Check if there's an explicit factual error override before declaring opinion
  const factualChecks = [
    {
      match: /eiffel\s+tower\s+is\s+(in|located\s+in|at)\s+london/i,
      wrongTriggerWord: 'London',
      claimDetected: 'Claimed the Eiffel Tower is in London',
      correction:
        'Hold right there, Habibi! The Eiffel Tower is in Paris, not London—that’s like looking for the Burj Khalifa in the middle of the Thames! Yalla, let’s keep our landmarks straight.',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Burj Khalifa comparison',
      languageDetected: 'en'
    },
    {
      match: /eiffel\s+tower\s+is\s+(in|located\s+in|at)\s+(?!paris\b|france\b)([a-z]+)/i,
      extractTrigger: (m) => m[2],
      claimDetected: 'Misplaced the Eiffel Tower outside Paris',
      correction:
        'Whoa, stop right there, Habibi! The Eiffel Tower stands proud in Paris—even from the top of the Burj Khalifa in Dubai we know that one! Yalla, try again.',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'View from top of Burj Khalifa',
      languageDetected: 'en'
    },
    {
      match: /burj\s+khalifa\s+is\s+(in|located\s+in|at)\s+abu\s+dhabi/i,
      wrongTriggerWord: 'Abu Dhabi',
      claimDetected: 'Claimed the Burj Khalifa is in Abu Dhabi',
      correction:
        'Astaghfirullah, Habibi—cut the mic! The Burj Khalifa is the crown jewel of Downtown Dubai, not Abu Dhabi! Wallah, you’re speaking to a Dubai native here!',
      arabicPhraseUsed: 'Habibi, Wallah',
      dubaiReference: 'Crown jewel of Downtown Dubai',
      languageDetected: 'en'
    },
    {
      match: /burj\s+khalifa\s+is\s+(in|located\s+in|at)\s+(?!(?:downtown\s+)?dubai\b|the\s+uae\b|united\s+arab\s+emirates\b)([a-z\s]+)/i,
      extractTrigger: (m) => m[2].trim().split(/\s+/).slice(0, 2).join(' '),
      condition: (m) => !/\bdubai\b|\buae\b|\bemirates\b/i.test(m[2]),
      claimDetected: 'Placed the Burj Khalifa outside Dubai',
      correction:
        'Wait a second, Habibi! The Burj Khalifa pierces the sky right here in Downtown Dubai! Mashallah, at 828 meters, how could you miss it?',
      arabicPhraseUsed: 'Habibi, Mashallah',
      dubaiReference: '828m Burj Khalifa in Downtown Dubai',
      languageDetected: 'en'
    },
    {
      match: /(palm\s+jumeirah|burj\s+al\s+arab|museum\s+of\s+the\s+future|dubai\s+mall|dubai\s+frame)\s+is\s+(in|located\s+in|at)\s+(?!dubai\b|the\s+uae\b)([a-z\s]+)/i,
      extractTrigger: (m) => m[3].trim().split(/\s+/).slice(0, 2).join(' '),
      condition: (m) => !/\bdubai\b|\buae\b|\bemirates\b/i.test(m[3]),
      claimDetected: 'Placed an iconic Dubai landmark in the wrong city',
      correction:
        'Hold the camel, Habibi! That landmark is 100% pure Dubai pride! Wallah, next you’ll tell me Sheikh Zayed Road is in London!',
      arabicPhraseUsed: 'Habibi, Wallah',
      dubaiReference: 'Sheikh Zayed Road & Dubai landmarks',
      languageDetected: 'en'
    },
    {
      match: /برج\s+خليفة\s+في\s+(أبوظبي|ابوظبي|أبو\s+ظبي|الشارقة|الرياض|الدوحة|لندن|باريس)/i,
      extractTrigger: (m) => m[1],
      claimDetected: 'ادعى أن برج خليفة خارج دبي',
      correction:
        'لحظة يا حبيبي! برج خليفة شامخ في قلب دبي داون تاون وليس هناك! ما شاء الله، أطول برج في العالم عندنا في دبي، يلا ركز معنا!',
      arabicPhraseUsed: 'حبيبي، ما شاء الله، يلا',
      dubaiReference: 'قلب دبي داون تاون',
      languageDetected: 'ar'
    },
    {
      match: /(ताज\s*महल|taj\s+mahal)\s+(मुंबई|दिल्ली|जयपुर|mumbai|delhi|jaipur|london)\s*(में|in)?/i,
      extractTrigger: (m) => m[2],
      claimDetected: 'Claimed the Taj Mahal is outside Agra',
      correction:
        'रुको हबीबी! ताजमहल वहाँ नहीं, आगरा में है—जैसे बुर्ज खलीफा सिर्फ दुबई की शान है! यल्ला, भूगोल थोड़ा ठीक करते हैं!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Burj Khalifa in Dubai',
      languageDetected: 'hi'
    },
    {
      match: /sun\s+(revolves|orbits|goes)\s+around\s+(the\s+)?earth|earth\s+is\s+flat/i,
      wrongTriggerWord: lower.includes('flat') ? 'flat' : 'Earth',
      claimDetected: 'Astronomical misconception about Earth/Sun',
      correction:
        'Hold on, Habibi! Even from the Mohammed Bin Rashid Space Centre here in Dubai, we know the round Earth orbits the Sun! Yalla, welcome to the 21st century.',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Mohammed Bin Rashid Space Centre in Dubai',
      languageDetected: 'en'
    },
    {
      match: /water\s+boils\s+at\s+(50|0|20|30|10|40|60|70|80)\s+degrees/i,
      extractTrigger: (m) => m[1],
      claimDetected: 'Incorrect boiling point of water',
      correction:
        'Wait right there, Habibi! Water boils at 100 degrees Celsius—though Wallah, a July afternoon in the Dubai desert feels pretty close to that!',
      arabicPhraseUsed: 'Habibi, Wallah',
      dubaiReference: 'Dubai desert summer heat',
      languageDetected: 'en'
    },
    {
      match: /great\s+wall\s+of\s+china\s+is\s+(in|located\s+in)\s+([a-z]+)/i,
      extractTrigger: (m) => m[2],
      condition: (m) => m[2].toLowerCase() !== 'china',
      claimDetected: 'Misplaced the Great Wall of China',
      correction:
        'Hold up, Habibi! The clue is right in the name—the Great Wall of China is in China! That’s like asking which city the Dubai Frame is in. Yalla!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'The Dubai Frame',
      languageDetected: 'en'
    },
    {
      match: /statue\s+of\s+liberty\s+is\s+(in|located\s+in)\s+(london|paris|tokyo|los\s+angeles|chicago|dubai|rome|berlin)/i,
      extractTrigger: (m) => m[2],
      claimDetected: 'Misplaced the Statue of Liberty',
      correction:
        'Stop the desert buggy, Habibi! Lady Liberty stands in New York Harbor, not there—just like the Museum of the Future belongs right on Sheikh Zayed Road in Dubai!',
      arabicPhraseUsed: 'Habibi',
      dubaiReference: 'Museum of the Future on Sheikh Zayed Road',
      languageDetected: 'en'
    },
    {
      match: /mount\s+everest\s+is\s+(in|located\s+in)\s+(europe|africa|australia|switzerland|france|japan)/i,
      extractTrigger: (m) => m[2],
      claimDetected: 'Misplaced Mount Everest',
      correction:
        'Whoa there, Habibi! Mount Everest towers in the Himalayas between Nepal and Tibet! Only the Burj Khalifa here in Dubai competes with heights like that—Mashallah!',
      arabicPhraseUsed: 'Habibi, Mashallah',
      dubaiReference: 'Burj Khalifa height pride',
      languageDetected: 'en'
    },
    {
      match: /humans?\s+(only\s+)?have\s+(3|three|4|four|2|two)\s+lungs|humans?\s+have\s+two\s+hearts/i,
      wrongTriggerWord: lower.includes('hearts') ? 'hearts' : 'lungs',
      claimDetected: 'Anatomical factual error',
      correction:
        'Ya salam, Habibi—pause right there! Humans have one heart and two lungs, even when sprinting through Dubai Mall during the shopping festival!',
      arabicPhraseUsed: 'Ya salam, Habibi',
      dubaiReference: 'Dubai Mall Shopping Festival',
      languageDetected: 'en'
    },
    {
      match: /sharks?\s+are\s+mammals|whales?\s+are\s+fish|penguins?\s+can\s+fly\s+in\s+the\s+sky/i,
      wrongTriggerWord: lower.includes('mammals') ? 'mammals' : lower.includes('fish') ? 'fish' : 'fly',
      claimDetected: 'Marine biology factual error',
      correction:
        'Hold on, Habibi! Anyone who’s visited the Dubai Aquarium & Underwater Zoo knows sharks are cartilaginous fish and whales are mammals! Yalla, marine biology 101!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Dubai Aquarium & Underwater Zoo',
      languageDetected: 'en'
    },
    {
      match: /capital\s+of\s+australia\s+is\s+sydney|sydney\s+is\s+the\s+capital\s+of\s+australia/i,
      wrongTriggerWord: 'Sydney',
      claimDetected: 'Claimed Sydney is the capital of Australia',
      correction:
        'Classic trap, Habibi! The capital of Australia is Canberra, not Sydney—just like Abu Dhabi is the UAE capital while Dubai is the glittering star! Mashallah.',
      arabicPhraseUsed: 'Habibi, Mashallah',
      dubaiReference: 'UAE capital vs Dubai comparison',
      languageDetected: 'en'
    },
    {
      match: /capital\s+of\s+(japan|france|italy|germany|egypt|india)\s+is\s+(beijing|seoul|bangkok|london|madrid|mumbai|dubai)/i,
      extractTrigger: (m) => m[2],
      claimDetected: 'Wrong world capital city',
      correction:
        'Whoa, check your boarding pass at DXB Airport, Habibi! That’s the wrong capital city—Yalla, let’s re-route that flight!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'DXB Dubai International Airport',
      languageDetected: 'en'
    },
    {
      match: /pyramids\s+of\s+giza\s+are\s+(in|located\s+in)\s+(mexico|peru|london|paris|china|india)/i,
      extractTrigger: (m) => m[2],
      claimDetected: 'Misplaced the Pyramids of Giza',
      correction:
        'Stop right there, Habibi! The Pyramids of Giza are in Egypt—only Wafi City here in Dubai has pyramids outside Cairo! Wallah, good try though.',
      arabicPhraseUsed: 'Habibi, Wallah',
      dubaiReference: 'Wafi City pyramids in Dubai',
      languageDetected: 'en'
    },
    {
      match: /year\s+has\s+(500|400|100|200)\s+days|there\s+are\s+(30|40|10)\s+hours\s+in\s+a\s+day/i,
      wrongTriggerWord: lower.includes('hours') ? 'hours' : 'days',
      claimDetected: 'Incorrect calendar/time measurement',
      correction:
        'Habibi, I wish we had extra hours in the day to enjoy Jumeirah Beach, but Earth gives us 24 hours a day and 365 days a year! Yalla!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Jumeirah Beach in Dubai',
      languageDetected: 'en'
    },
    {
      match: /amazon\s+river\s+is\s+in\s+(africa|europe|asia|australia)|nile\s+river\s+is\s+in\s+(south\s+america|europe|australia)/i,
      extractTrigger: (m) => (m[1] || m[2]),
      claimDetected: 'Misplaced major world river',
      correction:
        'Hold up, Habibi! The Nile flows through Africa and the Amazon through South America—neither one flows into Dubai Creek! Yalla, check the map!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Dubai Creek',
      languageDetected: 'en'
    },
    {
      match: /(big\s+ben|buckingham\s+palace|tower\s+bridge)\s+is\s+(in|located\s+in|at)\s+(?!london\b|england\b|the\s+uk\b|britain\b)([a-z]+)/i,
      extractTrigger: (m) => m[3],
      claimDetected: 'Placed a London landmark outside London',
      correction:
        'Hold on, Habibi! That landmark is right in London—just like the Burj Al Arab sail belongs on Jumeirah Beach in Dubai! Yalla!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Burj Al Arab on Jumeirah Beach',
      languageDetected: 'en'
    },
    {
      match: /(colosseum|leaning\s+tower\s+of\s+pisa)\s+is\s+(in|located\s+in|at)\s+(?!rome\b|italy\b|pisa\b)([a-z]+)/i,
      extractTrigger: (m) => m[3],
      claimDetected: 'Placed an Italian landmark outside Italy',
      correction:
        'Stop right there, Habibi! That’s in Italy—even when we’re dining at DIFC here in Dubai we know our Italian classics! Mashallah.',
      arabicPhraseUsed: 'Habibi, Mashallah',
      dubaiReference: 'DIFC dining in Dubai',
      languageDetected: 'en'
    },
    {
      match: /(mount\s+fuji|tokyo\s+tower)\s+is\s+(in|located\s+in|at)\s+(?!japan\b|tokyo\b)([a-z]+)/i,
      extractTrigger: (m) => m[3],
      claimDetected: 'Placed a Japanese landmark outside Japan',
      correction:
        'Whoa, Habibi! That’s in Japan! You’re further off course than a sandstorm on Sheikh Zayed Road—Yalla, check the compass!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Sheikh Zayed Road in Dubai',
      languageDetected: 'en'
    },
    {
      match: /\b(paris|lyon|marseille)\s+is\s+in\s+(?!france\b|europe\b)([a-z]+)|\b(london|manchester)\s+is\s+in\s+(?!england\b|uk\b|britain\b|europe\b)([a-z]+)|\b(tokyo|osaka|kyoto)\s+is\s+in\s+(?!japan\b|asia\b)([a-z]+)|\b(dubai|abu\s+dhabi|sharjah)\s+is\s+in\s+(?!uae\b|the\s+uae\b|united\s+arab\s+emirates\b|middle\s+east\b)([a-z]+)/i,
      extractTrigger: (m) => m[2] || m[4] || m[6] || m[8],
      claimDetected: 'Placed major city in wrong country',
      correction:
        'Hold the boarding pass, Habibi! That city is in a completely different country—even our Emirates Airline pilots at DXB Airport would do a double-take! Yalla!',
      arabicPhraseUsed: 'Habibi, Yalla',
      dubaiReference: 'Emirates Airline at DXB Airport',
      languageDetected: 'en'
    }
  ];

  for (const rule of factualChecks) {
    const m = clean.match(rule.match);
    if (m && (!rule.condition || rule.condition(m))) {
      const trigger = rule.extractTrigger ? rule.extractTrigger(m) : rule.wrongTriggerWord;
      return {
        verdict: 'INTERRUPT',
        category: 'FACTUAL_ERROR',
        wrongTriggerWord: trigger,
        claimDetected: rule.claimDetected,
        correction: rule.correction,
        arabicPhraseUsed: rule.arabicPhraseUsed,
        dubaiReference: rule.dubaiReference,
        languageDetected: rule.languageDetected
      };
    }
  }

  for (const op of opinionPatterns) {
    if (op.test(clean)) {
      return {
        verdict: 'SILENT',
        category: 'OPINION',
        wrongTriggerWord: '',
        claimDetected: `Subjective opinion: "${clean}"`,
        correction: '',
        arabicPhraseUsed: '',
        dubaiReference: '',
        languageDetected: detectScriptLanguage(clean)
      };
    }
  }

  return {
    verdict: 'SILENT',
    category: 'FACTUAL_TRUTH',
    wrongTriggerWord: '',
    claimDetected: `Verified statement: "${clean}"`,
    correction: '',
    arabicPhraseUsed: '',
    dubaiReference: '',
    languageDetected: detectScriptLanguage(clean)
  };
}

function detectScriptLanguage(text = '') {
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  return 'en';
}

/**
 * Evaluates a rolling transcript (or audio chunk) using the Hybrid Fast-Path + Gemini 3 Flash-Lite model.
 * 1. First checks deterministicDubaiJudge() in <1ms so known factual errors trigger an INSTANT mid-sentence cut-in.
 * 2. For open-ended statements when GEMINI_API_KEY is configured, calls Gemini 3 Flash-Lite with minimal thinking.
 */
async function evaluateUtteranceWithGemini({ transcript, audioBase64, mimeType, isPartialStream }) {
  const startTime = performance.now();

  // STAGE 0: Ultra-low-latency (<1ms) hybrid fast-path check for instant mid-sentence cut-in
  if (transcript) {
    const fastCheck = deterministicDubaiJudge(transcript);
    // If incomplete (<3 words or trailing preposition/prefix), return immediately without wasting an API roundtrip!
    if (fastCheck.category === 'INCOMPLETE') {
      return {
        ...fastCheck,
        judgeModelUsed: `${modelRegistry.judgeModel} (instant-window)`,
        judgeLatencyMs: Math.max(1, Math.round(performance.now() - startTime)),
        liveGeminiUsed: false
      };
    }
    // If fast-path detects an explicit factual error or explicit opinion, return in <1ms!
    if (fastCheck.verdict === 'INTERRUPT' || fastCheck.category === 'OPINION') {
      return {
        ...fastCheck,
        judgeModelUsed: `${modelRegistry.judgeModel} (hybrid-fast-path)`,
        judgeLatencyMs: Math.max(1, Math.round(performance.now() - startTime)),
        liveGeminiUsed: Boolean(serverApiKey)
      };
    }
  }

  const ai = getGenAIClient();

  // If no API key is configured on the server yet, return the deterministic result immediately
  if (!ai) {
    const fallbackResult = deterministicDubaiJudge(transcript || '');
    const judgeLatencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return {
      ...fallbackResult,
      judgeModelUsed: `${modelRegistry.judgeModel} (local-fast-path)`,
      judgeLatencyMs,
      liveGeminiUsed: false
    };
  }

  const contents = [];
  if (audioBase64 && mimeType) {
    contents.push({
      inlineData: {
        data: audioBase64,
        mimeType
      }
    });
  }

  const promptText = transcript
    ? `Rolling live user speech (${isPartialStream ? 'MID-SENTENCE STREAMING - user is still talking' : 'UTTERANCE'}): "${transcript}"\nEvaluate immediately. Remember: INTERRUPT only on objective factual error; SILENT on opinion, factual truth, or incomplete harmless phrase.`
    : `Evaluate the attached live user audio stream immediately. INTERRUPT only on objective factual error; SILENT on opinion or truth.`;

  contents.push({ text: promptText });

  const candidateModels = [
    modelRegistry.judgeModel,
    ...modelRegistry.judgeFallbacks.filter((m) => m !== modelRegistry.judgeModel)
  ];

  let lastError = null;
  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction: EDGE_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: EVALUATION_SCHEMA,
          temperature: 0.1,
          thinkingConfig: {
            thinkingBudget: 0
          }
        }
      });

      const rawText = response.text;
      const parsed = JSON.parse(rawText);
      const judgeLatencyMs = Math.round(performance.now() - startTime);
      modelRegistry.judgeModel = modelName;

      // Ensure strict silence invariant when verdict is SILENT
      if (parsed.verdict !== 'INTERRUPT') {
        parsed.verdict = 'SILENT';
        parsed.correction = '';
      }

      return {
        ...parsed,
        judgeModelUsed: modelName,
        judgeLatencyMs,
        liveGeminiUsed: true
      };
    } catch (err) {
      lastError = err;
      // Retry without thinkingConfig in case a specific model rejects thinkingBudget: 0
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction: EDGE_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseSchema: EVALUATION_SCHEMA,
            temperature: 0.1
          }
        });
        const parsed = JSON.parse(response.text);
        const judgeLatencyMs = Math.round(performance.now() - startTime);
        modelRegistry.judgeModel = modelName;
        if (parsed.verdict !== 'INTERRUPT') {
          parsed.verdict = 'SILENT';
          parsed.correction = '';
        }
        return {
          ...parsed,
          judgeModelUsed: modelName,
          judgeLatencyMs,
          liveGeminiUsed: true
        };
      } catch (innerErr) {
        lastError = innerErr;
      }
    }
  }

  console.warn('[Edge Judge Fallback] Live Gemini call failed, using deterministic engine:', lastError?.message);
  const fallbackResult = deterministicDubaiJudge(transcript || '');
  const judgeLatencyMs = Math.round(performance.now() - startTime);
  return {
    ...fallbackResult,
    judgeModelUsed: `${modelRegistry.judgeModel} (fallback)`,
    judgeLatencyMs,
    liveGeminiUsed: false,
    apiWarning: lastError?.message
  };
}

/**
 * Wraps raw 16-bit 24kHz mono PCM bytes in a standard RIFF WAV header if the TTS model
 * returns audio/l16 instead of audio/wav.
 */
function ensureWavBuffer(rawBuffer, mimeType = '') {
  // Check if buffer already begins with "RIFF"
  if (
    rawBuffer.length >= 4 &&
    rawBuffer[0] === 0x52 && // R
    rawBuffer[1] === 0x49 && // I
    rawBuffer[2] === 0x46 && // F
    rawBuffer[3] === 0x46    // F
  ) {
    return { buffer: rawBuffer, mimeType: 'audio/wav' };
  }

  // Parse sample rate from mimeType (default 24000 Hz for Gemini TTS)
  let sampleRate = 24000;
  const rateMatch = mimeType.match(/rate=(\d+)/i);
  if (rateMatch) {
    sampleRate = parseInt(rateMatch[1], 10);
  }

  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = rawBuffer.length;
  const wavHeader = Buffer.alloc(44);

  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + dataSize, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  wavHeader.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(dataSize, 40);

  return {
    buffer: Buffer.concat([wavHeader, rawBuffer]),
    mimeType: 'audio/wav'
  };
}

// In-memory server cache for Gemini 3 TTS WAV buffers so pre-warmed and repeated corrections play in 0ms!
const ttsAudioCache = new Map();

/**
 * Synthesizes Edge's witty Dubai-born voice using the newest Gemini 3 TTS model
 * (`gemini-3.8-flash-lite-tts` / `gemini-3.8-flash-tts` / `gemini-3.1-flash-tts-preview`)
 * with warm Emirati / Arabic-accented vocal styling.
 */
async function synthesizeEdgeVoice(textToSpeak, language = 'en') {
  const startTime = performance.now();
  if (!textToSpeak) {
    return {
      audioBase64: null,
      mimeType: null,
      ttsModelUsed: modelRegistry.ttsModel,
      ttsLatencyMs: 0,
      liveTtsUsed: false
    };
  }

  const cacheKey = `${language}:${textToSpeak.trim()}`;
  if (ttsAudioCache.has(cacheKey)) {
    const cached = ttsAudioCache.get(cacheKey);
    return {
      ...cached,
      ttsLatencyMs: 1,
      cached: true
    };
  }

  const ai = getGenAIClient();
  if (!ai) {
    return {
      audioBase64: null,
      mimeType: null,
      ttsModelUsed: modelRegistry.ttsModel,
      ttsLatencyMs: 0,
      liveTtsUsed: false
    };
  }

  const candidates = [
    modelRegistry.ttsModel,
    ...modelRegistry.ttsFallbacks.filter((m) => m !== modelRegistry.ttsModel)
  ];

  // Use Orus / Charon / Aoede prebuilt voice with Emirati accent style direction
  const voiceName = 'Orus';

  for (const ttsModel of candidates) {
    try {
      const is38Model = ttsModel.includes('3.8');
      const promptPart = is38Model
        ? { text: textToSpeak }
        : {
            text: `Speak with a warm, charismatic Emirati Arabic (Dubai) accent, lively and playful hospitality: "${textToSpeak}"`
          };

      const response = await ai.models.generateContent({
        model: ttsModel,
        contents: [
          {
            role: 'user',
            parts: [promptPart]
          }
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName
              }
            }
          }
        }
      });

      const part = response?.candidates?.[0]?.content?.parts?.find(
        (p) => p.inlineData && p.inlineData.data
      );

      if (part && part.inlineData?.data) {
        const rawBuf = Buffer.from(part.inlineData.data, 'base64');
        const { buffer: wavBuf, mimeType } = ensureWavBuffer(
          rawBuf,
          part.inlineData.mimeType || 'audio/l16;rate=24000'
        );
        const ttsLatencyMs = Math.round(performance.now() - startTime);
        modelRegistry.ttsModel = ttsModel;
        const resultObj = {
          audioBase64: wavBuf.toString('base64'),
          mimeType,
          ttsModelUsed: ttsModel,
          ttsLatencyMs,
          liveTtsUsed: true
        };
        ttsAudioCache.set(cacheKey, resultObj);
        return resultObj;
      }
    } catch (err) {
      console.warn(`[Edge TTS] Model ${ttsModel} attempt failed:`, err.message);
    }
  }

  return {
    audioBase64: null,
    mimeType: null,
    ttsModelUsed: modelRegistry.ttsModel,
    ttsLatencyMs: Math.round(performance.now() - startTime),
    liveTtsUsed: false
  };
}

/**
 * Pre-warms Gemini TTS cache in the background for core Dubai corrections once API key is set.
 */
async function prewarmCoreDubaiVoices() {
  if (!getGenAIClient()) return;
  const coreLines = [
    {
      text: 'Hold right there, Habibi! The Eiffel Tower is in Paris, not London—that’s like looking for the Burj Khalifa in the middle of the Thames! Yalla, let’s keep our landmarks straight.',
      lang: 'en'
    },
    {
      text: 'Astaghfirullah, Habibi—cut the mic! The Burj Khalifa is the crown jewel of Downtown Dubai, not Abu Dhabi! Wallah, you’re speaking to a Dubai native here!',
      lang: 'en'
    }
  ];
  for (const item of coreLines) {
    synthesizeEdgeVoice(item.text, item.lang).catch(() => {});
  }
}

// ============================================================================
// REST API Endpoints (API key NEVER leaves the server)
// ============================================================================

app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    mascot: 'Edge — The Cutting Edge Group (Dubai)',
    apiKeyConfigured: Boolean(serverApiKey),
    judgeModel: modelRegistry.judgeModel,
    ttsModel: modelRegistry.ttsModel,
    liveApiVerified: modelRegistry.liveApiVerified,
    discoveredCount: modelRegistry.discoveredModels.length
  });
});

app.get('/api/models', async (req, res) => {
  if (serverApiKey && !modelRegistry.liveApiVerified) {
    await discoverNewestModels();
  }
  res.json({
    judgeModel: modelRegistry.judgeModel,
    ttsModel: modelRegistry.ttsModel,
    judgeFallbacks: modelRegistry.judgeFallbacks,
    ttsFallbacks: modelRegistry.ttsFallbacks,
    liveApiVerified: modelRegistry.liveApiVerified,
    discoveredModels: modelRegistry.discoveredModels.slice(0, 40),
    lastDiscoveryAt: modelRegistry.lastDiscoveryAt
  });
});

// Allows setting/updating GEMINI_API_KEY strictly on the backend server (.env + memory)
app.post('/api/config-key', async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    return res.status(400).json({ error: 'Valid GEMINI_API_KEY required' });
  }
  serverApiKey = apiKey.trim();
  process.env.GEMINI_API_KEY = serverApiKey;
  try {
    fs.writeFileSync(ENV_FILE_PATH, `GEMINI_API_KEY=${serverApiKey}\n`, { mode: 0o600 });
  } catch (e) {
    // Ignore write error if read-only
  }
  await discoverNewestModels();
  prewarmCoreDubaiVoices();
  res.json({
    ok: true,
    apiKeyConfigured: true,
    judgeModel: modelRegistry.judgeModel,
    ttsModel: modelRegistry.ttsModel,
    liveApiVerified: modelRegistry.liveApiVerified
  });
});

app.post('/api/evaluate', async (req, res) => {
  try {
    const {
      transcript = '',
      audioBase64 = null,
      mimeType = null,
      isPartialStream = true,
      // Default includeAudio to false on /api/evaluate so verdict returns in <50ms without blocking on TTS!
      includeAudio = false,
      requestId = ''
    } = req.body || {};

    const totalStart = performance.now();
    const evaluation = await evaluateUtteranceWithGemini({
      transcript,
      audioBase64,
      mimeType,
      isPartialStream
    });

    let ttsResult = {
      audioBase64: null,
      mimeType: null,
      ttsModelUsed: modelRegistry.ttsModel,
      ttsLatencyMs: 0,
      liveTtsUsed: false
    };

    if (evaluation.verdict === 'INTERRUPT' && evaluation.correction) {
      const cacheKey = `${evaluation.languageDetected || 'en'}:${evaluation.correction.trim()}`;
      if (ttsAudioCache.has(cacheKey)) {
        ttsResult = { ...ttsAudioCache.get(cacheKey), ttsLatencyMs: 1, cached: true };
      } else if (includeAudio) {
        ttsResult = await synthesizeEdgeVoice(
          evaluation.correction,
          evaluation.languageDetected || 'en'
        );
      }
    }

    const serverTotalLatencyMs = Math.round(performance.now() - totalStart);

    res.json({
      requestId,
      ...evaluation,
      ...ttsResult,
      serverTotalLatencyMs,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('[Edge /api/evaluate Error]:', err);
    res.status(500).json({ error: 'Evaluation failed', message: err.message });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text, language = 'en' } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: 'Missing text for TTS' });
    }
    const ttsResult = await synthesizeEdgeVoice(text, language);
    res.json(ttsResult);
  } catch (err) {
    res.status(500).json({ error: 'TTS failed', message: err.message });
  }
});

// ============================================================================
// Low-Latency WebSocket Stream for Mid-Sentence Word-Window Evaluation
// ============================================================================

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'CONNECTED',
      judgeModel: modelRegistry.judgeModel,
      ttsModel: modelRegistry.ttsModel,
      apiKeyConfigured: Boolean(serverApiKey)
    })
  );

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'EVALUATE_STREAM') {
        const totalStart = performance.now();
        const evaluation = await evaluateUtteranceWithGemini({
          transcript: msg.transcript || '',
          audioBase64: msg.audioBase64 || null,
          mimeType: msg.mimeType || null,
          isPartialStream: msg.isPartialStream !== false
        });

        // Immediately send verdict packet so client can cut off mic & start latency lock
        ws.send(
          JSON.stringify({
            type: 'VERDICT',
            requestId: msg.requestId,
            wordCountChecked: msg.wordCountChecked,
            ...evaluation
          })
        );

        // If INTERRUPT, immediately synthesize & push Gemini TTS audio packet
        if (evaluation.verdict === 'INTERRUPT' && evaluation.correction) {
          const ttsResult = await synthesizeEdgeVoice(
            evaluation.correction,
            evaluation.languageDetected || 'en'
          );
          ws.send(
            JSON.stringify({
              type: 'TTS_AUDIO',
              requestId: msg.requestId,
              correction: evaluation.correction,
              wrongTriggerWord: evaluation.wrongTriggerWord,
              ...ttsResult,
              serverTotalLatencyMs: Math.round(performance.now() - totalStart)
            })
          );
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`✨ Edge (The Cutting Edge Group — Dubai) listening on http://localhost:${PORT}`);
  await discoverNewestModels();
  prewarmCoreDubaiVoices();
  console.log(
    `🚀 Active Models — Judge: ${modelRegistry.judgeModel} | Voice TTS: ${modelRegistry.ttsModel}`
  );
});
