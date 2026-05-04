// api/edit.js — targeted text-instruction edits on an existing image

const MODEL_IDS = {
  fast: 'gemini-3.1-flash-image-preview',
  pro:  'gemini-3-pro-image-preview',
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
    imageData  = null,
    imageMime  = 'image/png',
    instruction = '',
    model      = 'fast',
  } = req.body;

  if (!imageData) {
    return res.status(400).json({ error: 'No image provided' });
  }
  if (!instruction.trim()) {
    return res.status(400).json({ error: 'No instruction provided' });
  }

  const prompt =
    `Edit this image: ${instruction.trim()}. ` +
    `Apply only the described change — keep everything else exactly as it is. ` +
    `Preserve the original photo's style, lighting, colour temperature, composition, and all unaffected areas.`;

  console.log('[edit] model=%s instruction=', model, instruction.slice(0, 200));

  const modelId = MODEL_IDS[model] || MODEL_IDS.fast;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: imageMime, data: imageData } },
          ],
        }],
        generationConfig: {
          responseModalities: ['IMAGE'],
        },
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `API error ${resp.status}`);

    const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart) throw new Error('No image returned — the model may have blocked the prompt');

    return res.json({
      image: {
        id:       `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        data:     imagePart.inlineData.data,
        mimeType: imagePart.inlineData.mimeType || 'image/png',
        seed:     Math.floor(Math.random() * 99999),
        pinned:   false,
      },
    });
  } catch (err) {
    console.error('[edit]', err);
    return res.status(500).json({ error: err.message });
  }
};
