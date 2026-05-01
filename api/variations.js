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
    style           = '',
    context         = '',
    model           = 'fast',
    count           = 1,
    ratio           = '1:1',
    divergence      = 35,
    varType         = 'alternatives',
    locEnabled      = false,
    locTextHandling = 'leave',
    locRegion       = '',
  } = req.body;

  // ─── Ethnicity-swap path ────────────────────────────────────────────────────
  // When localization is ON and a region is provided, we completely restructure
  // the prompt so ethnicity is the PRIMARY instruction rather than an afterthought.
  // We also silently boost divergence so the model has enough "permission" to
  // re-render facial features — a floor of 65 regardless of slider value.

  if (locEnabled && locRegion) {
    const eth    = ethnicityLabel(locRegion);
    const negTxt = negativeTerms(eth);

    // Effective divergence: user slider OR 65 minimum (significant change needed
    // for face/skin re-rendering to actually take hold).
    const effectiveDivergence = Math.max(divergence, 65);
    const strengthDesc =
      effectiveDivergence < 60 ? 'moderate'
      : effectiveDivergence < 80 ? 'significant'
      : 'dramatic';

    // Lead line — ethnicity transformation comes FIRST so the model weights it most.
    const leadLine =
      `TRANSFORM this portrait: change the subject to a ${eth} person. ` +
      `Render authentic ${eth} facial bone structure, skin tone, eye shape, nose shape, ` +
      `and ethnic features with photorealistic accuracy. ` +
      `This is a ${strengthDesc} re-rendering of facial features only.`;

    // Preserve line — explicit list of what must NOT change.
    const preserveLine =
      `PRESERVE UNCHANGED: exact pose, body position, clothing, hairstyle silhouette, ` +
      `lighting direction, background, and overall composition. ` +
      `Only the person's face and skin should change.`;

    // Optional scene/style additions.
    const extras = [];
    if (style)   extras.push(`Style: ${style}`);
    if (prompt)  extras.push(prompt);
    if (context) extras.push(context);

    // Text handling
    const [txtPos, txtNeg] = textHandlingPrompt(locTextHandling, locRegion);
    if (txtPos) extras.push(txtPos);

    // Combine all negative instructions
    const negativeLine = [negTxt, txtNeg].filter(Boolean).join('. ');

    const fullPrompt = [leadLine, preserveLine, ...extras, negativeLine, RATIO_LABELS[ratio] || ratio]
      .filter(Boolean)
      .join('. ')
      .replace(/\.{2,}/g, '.')
      .trim();

    console.log('[variations:loc] ethnicity=%s effectiveDivergence=%d', eth, effectiveDivergence);
    console.log('[variations:loc] prompt=', fullPrompt.slice(0, 200));

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
              generationConfig: { responseModalities: ['IMAGE'] },
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

  const divergenceDesc =
    divergence < 20 ? 'very subtle (nearly identical)'
    : divergence < 40 ? 'subtle'
    : divergence < 60 ? 'moderate'
    : divergence < 80 ? 'significant'
    : 'dramatic (highly different)';

  const varDesc = varType === 'alternatives'
    ? 'use a different composition, angle, and framing from the original'
    : 'keep the same composition and framing, vary the details, lighting, and colour palette';

  const promptParts = [
    `Create a ${divergenceDesc} portrait variation of this reference image.`,
    varDesc,
  ];
  if (style)   promptParts.push(`Style: ${style}`);
  if (prompt)  promptParts.push(prompt);
  if (context) promptParts.push(`Scene context: ${context}`);
  promptParts.push(RATIO_LABELS[ratio] || ratio);

  // Text handling (standard path)
  const [txtPos, txtNeg] = textHandlingPrompt(locTextHandling);
  if (txtPos) promptParts.push(txtPos);
  if (txtNeg) promptParts.push(`Avoid: ${txtNeg}`);

  const fullPrompt = promptParts.join('. ').replace(/\.+/g, '.').trim();

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
            generationConfig: { responseModalities: ['IMAGE'] },
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
