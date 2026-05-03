// api/generate.js — text-to-image via Gemini image models

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY environment variable is not set' });
  }

  const {
    prompt          = '',
    negPrompt       = '',
    style           = '',   // full prompt string from STYLE_MAP
    context         = '',
    model           = 'fast',
    count           = 1,
    ratio           = '1:1',
    cfg             = 7,
    locEnabled      = false,
    locTextHandling = 'leave',
    locRegion       = '',
  } = req.body;

  // Map cfg (1–20) to temperature (1.0–0.2). High cfg = strict = low temp.
  const temperature = Math.max(0.2, Math.min(1.0, 1.0 - ((cfg - 1) / 19) * 0.8));

  let fullPrompt;

  if (locEnabled && locRegion) {
    // ── Localization path ──────────────────────────────────────────────────
    const eth   = locRegion.charAt(0).toUpperCase() + locRegion.slice(1);
    const parts = [`A person of ${eth} ethnicity and heritage`];
    if (style)   parts.push(style);
    if (prompt)  parts.push(prompt);
    if (context) parts.push(context);
    if (locTextHandling === 'translate') parts.push(`text in the image should appear in the language of ${locRegion}`);
    else if (locTextHandling === 'localize') parts.push(`use culturally appropriate visual elements for ${locRegion}`);
    else if (locTextHandling === 'remove')   parts.push('no visible text in the image');
    parts.push(RATIO_LABELS[ratio] || ratio);
    fullPrompt = parts.join('. ').replace(/\.+/g, '.').trim();

  } else {
    // ── Standard path ─────────────────────────────────────────────────────
    const parts = [];
    if (style)     parts.push(style);
    if (prompt)    parts.push(prompt);
    if (context)   parts.push(`Scene: ${context}`);
    parts.push(RATIO_LABELS[ratio] || ratio);
    if (negPrompt) parts.push(`Avoid: ${negPrompt}`);
    fullPrompt = parts.join('. ').replace(/\.+/g, '.').trim();
  }

  if (!fullPrompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  console.log('[generate] cfg=%d temp=%.2f prompt=', cfg, temperature, fullPrompt.slice(0, 400));

  const modelId = MODEL_IDS[model] || MODEL_IDS.balanced;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  try {
    const n = Math.min(Math.max(1, count), 4);
    const images = await Promise.all(
      Array.from({ length: n }).map(async (_, i) => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: {
              responseModalities: ['IMAGE'],
              temperature,
            },
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
    console.error('[generate]', err);
    return res.status(500).json({ error: err.message });
  }
};
