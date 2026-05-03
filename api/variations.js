// api/variations.js — image-to-image variations via Gemini image models
// Model routing: fast → gemini-3.1-flash-image-preview (Nano Banana 2)
//                pro  → gemini-3-pro-image-preview    (Nano Banana Pro)

const MODEL_IDS = {
  fast:     'gemini-3.1-flash-image-preview',
  balanced: 'gemini-3.1-flash-image-preview',
  pro:      'gemini-3-pro-image-preview',
};

const RATIO_LABELS = {
  '1:1':  'square 1:1 aspect ratio',
  '16:9': 'wide landscape 16:9 aspect ratio',
  '9:16': 'tall portrait 9:16 aspect ratio',
  '4:3':  'standard landscape 4:3 aspect ratio',
  '3:4':  'standard portrait 3:4 aspect ratio',
};

// Human-readable region → ethnicity descriptor used in the prompt lead.
// Falls back to the raw region string if not found.
function ethnicityLabel(region = '') {
  const r = region.toLowerCase().trim();
  const MAP = {
    philippines: 'Filipino',
    filipino:    'Filipino',
    'southeast asia': 'Southeast Asian',
    indonesia:   'Indonesian',
    thailand:    'Thai',
    vietnam:     'Vietnamese',
    malaysia:    'Malaysian',
    africa:      'Black African',
    nigeria:     'Nigerian',
    ghana:       'Ghanaian',
    kenya:       'Kenyan',
    ethiopia:    'Ethiopian',
    'south africa': 'South African',
    brazil:      'Brazilian',
    'latin america': 'Latin American',
    mexico:      'Mexican',
    colombia:    'Colombian',
    india:       'Indian',
    'south asia': 'South Asian',
    pakistan:    'Pakistani',
    bangladesh:  'Bangladeshi',
    china:       'East Asian / Chinese',
    japan:       'Japanese',
    korea:       'Korean',
    'east asia': 'East Asian',
    'middle east': 'Middle Eastern',
    arab:        'Arab',
    iran:        'Iranian / Persian',
    turkey:      'Turkish',
    'us':        'American',
    'united states': 'American',
  };
  // exact match first
  if (MAP[r]) return MAP[r];
  // partial match
  const key = Object.keys(MAP).find(k => r.includes(k));
  if (key) return MAP[key];
  // capitalise whatever was typed
  return region.charAt(0).toUpperCase() + region.slice(1);
}

// Negative terms to push the model away from the original.
// Only used when ethnicity swap is active.
function negativeTerms(ethnicity) {
  const eth = ethnicity.toLowerCase();
  const common = 'do not copy the original person\'s ethnicity, skin colour, or facial structure';
  if (eth.includes('filipino') || eth.includes('southeast') || eth.includes('asian')) {
    return `${common}. Avoid Caucasian, European, or pale white skin tone and features`;
  }
  if (eth.includes('african') || eth.includes('black') || eth.includes('nigerian')) {
    return `${common}. Avoid Caucasian, European, or pale white skin tone and features`;
  }
  if (eth.includes('latin') || eth.includes('brazilian') || eth.includes('mexican')) {
    return `${common}. Avoid Northern European or East Asian features`;
  }
  if (eth.includes('indian') || eth.includes('south asian')) {
    return `${common}. Avoid Caucasian, East Asian, or African features`;
  }
  if (eth.includes('east asian') || eth.includes('chinese') || eth.includes('japanese') || eth.includes('korean')) {
    return `${common}. Avoid Caucasian, European, or South Asian features`;
  }
  // generic fallback
  return `${common}. Avoid retaining the original subject's racial characteristics`;
}

// Text handling returns [positiveInstruction, negativeInstruction]
function textHandlingPrompt(handling, region = '') {
  const neg = 'do not generate random gibberish characters, distorted letters, blurry text, or illegible text artefacts';
  switch (handling) {
    case 'leave':
      return [
        'Preserve all existing text, signs, labels, and written characters in the image exactly as they appear in the original — do not alter, distort, translate, or remove any text',
        neg,
      ];
    case 'translate':
      return [
        `Translate all visible text, signs, and labels in the image to the language spoken in ${region}. Render the translated text clearly and legibly in the same visual position and style`,
        neg,
      ];
    case 'localize':
      return [
        `Replace all visible text and signage with culturally appropriate content for ${region}. Adapt any written copy, brand names, or labels so they feel native to ${region}`,
        neg,
      ];
    case 'remove':
      return [
        'Remove all visible text, signs, labels, written characters, and typographic elements from the image. Leave clean surfaces where text previously appeared',
        'do not leave text residue, partial letters, or ghost impressions of removed text',
      ];
    default:
      return ['', ''];
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY environment variable is not set' });
  }

  const {
    refImageData    = null,
    refImageMime    = 'image/jpeg',
    prompt          = '',
    context         = '',
    model           = 'fast',
    count           = 1,
    ratio           = '1:1',
    cfg             = 7,
    divergence      = 35,
    varType         = 'alternatives',
    locEnabled      = false,
    locTextHandling = 'leave',
    locRegion       = '',
  } = req.body;

  // Map cfg (1–20) to temperature (1.0–0.2). Same curve as generate.js.
  const temperature = Math.max(0.2, Math.min(1.0, 1.0 - ((cfg - 1) / 19) * 0.8));

  // ─── Ethnicity-swap path ────────────────────────────────────────────────────
  // Concise, structured TRANSFORM prompt — no style injection.

  if (locEnabled && locRegion) {
    const eth = ethnicityLabel(locRegion);

    const parts = [
      `TRANSFORM: Re-render subject as ${eth}.`,
      `STRICT STRUCTURAL LOCK: Maintain identical head-tilt, gaze-vector, and facial geometry. Keep original clothing, hair silhouette, and background.`,
      `RENDER SPECS: Authentic ${eth} bone structure and skin tone. Blend face seamlessly. Match original film grain, focal depth, and ambient lighting exactly. Do not add artificial sharpness or smoothing.`,
    ];
    if (prompt)  parts.push(prompt);
    if (context) parts.push(context);

    // Text handling
    const [txtPos, txtNeg] = textHandlingPrompt(locTextHandling, locRegion);
    if (txtPos) parts.push(txtPos);

    // Negative line
    const negTxt = negativeTerms(eth);
    const negativeLine = [negTxt, txtNeg].filter(Boolean).join('. ');
    if (negativeLine) parts.push(`Avoid: ${negativeLine}`);

    parts.push(RATIO_LABELS[ratio] || ratio);

    const fullPrompt = parts.join('. ').replace(/\.{2,}/g, '.').trim();

    console.log('[variations:loc] ethnicity=%s cfg=%d temp=%.2f', eth, cfg, temperature);
    console.log('[variations:loc] prompt=', fullPrompt.slice(0, 300));

    const contentParts = [{ text: fullPrompt }];
    if (refImageData) {
      contentParts.push({ inlineData: { mimeType: refImageMime, data: refImageData } });
    }

    const modelId = MODEL_IDS[model] || MODEL_IDS.fast;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    try {
      const n = Math.min(Math.max(1, count), 4);
      const images = await Promise.all(
        Array.from({ length: n }).map(async (_, i) => {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: contentParts }],
              generationConfig: { responseModalities: ['IMAGE'], temperature },
            }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error?.message || `API error ${resp.status}`);
          const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
          if (!imagePart) throw new Error('No image returned — the model may have blocked the prompt');
          return {
            id:       `img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
            data:     imagePart.inlineData.data,
            mimeType: imagePart.inlineData.mimeType || 'image/png',
            seed:     Math.floor(Math.random() * 99999),
            pinned:   false,
          };
        })
      );
      return res.json({ images });
    } catch (err) {
      console.error('[variations:loc]', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Standard variation path ────────────────────────────────────────────────
  // No style injection — styles are a Generate-only concept.

  const divergenceWord =
    divergence < 20 ? 'very subtle'
    : divergence < 40 ? 'subtle'
    : divergence < 60 ? 'moderate'
    : 'dramatic';

  const compositionLogic = varType === 'alternatives'
    ? 'use a different composition, angle, and framing from the original'
    : 'keep the same composition and framing, vary the lighting and colour palette';

  // Text handling negative only (standard path doesn't need the positive instruction)
  const [, txtNeg] = textHandlingPrompt(locTextHandling);

  const promptParts = [
    `Create a ${divergenceWord} portrait variation.`,
    compositionLogic,
  ];
  if (prompt)  promptParts.push(prompt);
  if (context) promptParts.push(`Scene context: ${context}`);
  promptParts.push(RATIO_LABELS[ratio] || ratio);
  if (txtNeg)  promptParts.push(`Avoid: ${txtNeg}`);

  const fullPrompt = promptParts.join('. ').replace(/\.+/g, '.').trim();

  const contentParts = [{ text: fullPrompt }];
  if (refImageData) {
    contentParts.push({ inlineData: { mimeType: refImageMime, data: refImageData } });
  }

  const modelId = MODEL_IDS[model] || MODEL_IDS.fast;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  console.log('[variations] divergence=%d cfg=%d temp=%.2f', divergence, cfg, temperature);
  console.log('[variations] prompt=', fullPrompt.slice(0, 300));

  try {
    const n = Math.min(Math.max(1, count), 4);
    const images = await Promise.all(
      Array.from({ length: n }).map(async (_, i) => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: contentParts }],
            generationConfig: { responseModalities: ['IMAGE'], temperature },
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error?.message || `API error ${resp.status}`);
        const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (!imagePart) throw new Error('No image returned — the model may have blocked the prompt');
        return {
          id:       `img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          data:     imagePart.inlineData.data,
          mimeType: imagePart.inlineData.mimeType || 'image/png',
          seed:     Math.floor(Math.random() * 99999),
          pinned:   false,
        };
      })
    );
    return res.json({ images });
  } catch (err) {
    console.error('[variations]', err);
    return res.status(500).json({ error: err.message });
  }
};
