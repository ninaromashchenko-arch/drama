// api/generate.js — text-to-image via Gemini image models
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
    prompt = '',
    style = '',
    context = '',
    model = 'balanced',
    count = 1,
    ratio = '1:1',
    locEnabled = false,
    locTextHandling = 'leave',
    locRegion = '',
  } = req.body;

  // Build full prompt
  let parts = [];
  if (style)   parts.push(style);
  if (prompt)  parts.push(prompt);
  if (context) parts.push(`Scene: ${context}`);
  parts.push(RATIO_LABELS[ratio] || ratio);

  if (locEnabled && locRegion) {
    parts.push(`Localized for ${locRegion}`);
    if (locTextHandling === 'translate') parts.push('translate any visible text to the local language');
    else if (locTextHandling === 'localize') parts.push('use culturally appropriate visual elements and aesthetics for this region');
    else if (locTextHandling === 'remove')  parts.push('no text or writing visible in the image');
  }

  const fullPrompt = parts.join('. ').replace(/\.+/g, '.').trim();
  if (!fullPrompt) {
    return res.status(400).json({ error: 'No prompt provided' });
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
            contents: [{ parts: [{ text: fullPrompt }] }],
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
    console.error('[generate]', err);
    return res.status(500).json({ error: err.message });
  }
}
