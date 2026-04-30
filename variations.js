// api/variations.js — image-to-image variations via Gemini image models
// Accepts an optional base64 reference image; if absent, falls back to text-only.
// Model routing: fast/balanced → gemini-3.1-flash-image-preview (Nano Banana 2)
//                pro            → gemini-3-pro-image-preview    (Nano Banana Pro)

export const config = { maxDuration: 60 };

const MODEL_IDS = {
  fast:     'gemini-3.1-flash-image-preview',
  balanced: 'gemini-3.1-flash-image-preview',
  pro:      'gemini-3-pro-image-preview',
};

const RATIO_LABELS = {
  '1:1':  'square 1:1 aspect ratio',
  '16:9': 'wide landscape 16:9 aspect ratio',
  '9:16': 'tall portrait 9:16 aspect ratio',
  '4:3':  'standard 4:3 aspect ratio',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY environment variable is not set' });
  }

  const {
    refImageData = null,
    refImageMime = 'image/jpeg',
    prompt = '',
    style = '',
    context = '',
    model = 'balanced',
    count = 1,
    ratio = '1:1',
    divergence = 35,
    varType = 'alternatives',
    locEnabled = false,
    locTextHandling = 'leave',
    locRegion = '',
  } = req.body;

  // Human-readable divergence description
  const divergenceDesc =
    divergence < 20 ? 'very subtle (nearly identical)'
    : divergence < 40 ? 'subtle'
    : divergence < 60 ? 'moderate'
    : divergence < 80 ? 'significant'
    : 'dramatic (highly different)';

  const varDesc = varType === 'alternatives'
    ? 'use a different composition, angle, and framing from the original'
    : 'keep the same composition and framing, vary the details, lighting, and colour palette';

  // Build prompt
  let promptParts = [
    `Create a ${divergenceDesc} portrait variation of this reference image.`,
    varDesc,
  ];
  if (style)   promptParts.push(`Style: ${style}`);
  if (prompt)  promptParts.push(prompt);
  if (context) promptParts.push(`Scene context: ${context}`);
  promptParts.push(RATIO_LABELS[ratio] || ratio);

  if (locEnabled && locRegion) {
    promptParts.push(`Localized for ${locRegion}`);
    if (locTextHandling === 'translate') promptParts.push('translate any visible text to the local language');
    else if (locTextHandling === 'localize') promptParts.push('use culturally appropriate visual elements for this region');
    else if (locTextHandling === 'remove')  promptParts.push('no text or writing visible in the image');
  }

  const fullPrompt = promptParts.join('. ').replace(/\.+/g, '.').trim();

  // Build content parts — text first, then optional image
  const contentParts = [{ text: fullPrompt }];
  if (refImageData) {
    contentParts.push({ inlineData: { mimeType: refImageMime, data: refImageData } });
  }

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
            contents: [{ parts: contentParts }],
            generationConfig: { responseModalities: ['IMAGE'] },
          }),
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error?.message || `API error ${resp.status}`);

        const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (!imagePart) throw new Error('No image returned — the model may have blocked the prompt');

        return {
          id: `img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          data: imagePart.inlineData.data,
          mimeType: imagePart.inlineData.mimeType || 'image/png',
          seed: Math.floor(Math.random() * 99999),
          pinned: false,
        };
      })
    );

    return res.json({ images });
  } catch (err) {
    console.error('[variations]', err);
    return res.status(500).json({ error: err.message });
  }
}
