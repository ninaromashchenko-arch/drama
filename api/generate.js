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

// Per-style technical specs and negative prompts.
// The sandwich format: [MEDIUM] → [SUBJECT] → [SCENE] → [TECHNICAL] → [AVOID]
const STYLE_CONFIG = {
  closeup: {
    medium:   'extreme close-up portrait, tight face crop, 85mm lens, f/1.4 aperture, eyes in tack-sharp focus, skin pores visible',
    technical:'shallow depth of field, background fully bokeh-blurred, subject isolated',
    negative: 'wide angle distortion, full body composition, soft focus on eyes, environmental portrait, zoom lens compression',
  },
  emotional: {
    medium:   'candid documentary portrait, raw unguarded expression, photojournalistic',
    technical:'available light only, no flash, handheld feel, reportage framing',
    negative: 'studio lighting, posed composition, artificial fill light, retouched skin, glamour lighting, professional headshot aesthetic',
  },
  phoneshot: {
    medium:   'smartphone screenshot, mobile UI overlay, status bar visible at top, notification elements, screen glare',
    technical:'compressed JPEG artefacts, smartphone aspect ratio, tap-to-focus, screen surface reflection',
    negative: 'DSLR quality, professional photography, studio lighting, bokeh, cinematic color grade, film look',
  },
  cctv: {
    medium:   'CCTV surveillance footage, high-angle fixed security camera, monochrome black-and-white',
    technical:'low bitrate compression, 480p resolution equivalent, heavy digital noise, horizontal scan lines, date/time stamp overlay, wide fisheye distortion',
    negative: 'color image, HDR, 4K resolution, sharp crisp detail, professional photography, cinematic framing, warm tones, bokeh',
  },
  ugc: {
    medium:   'casual mobile phone snapshot, amateur photography, unprocessed',
    technical:'f/8 aperture, deep depth of field, natural color science, no post-processing, slight motion blur, 12MP mobile sensor noise',
    negative: 'bokeh, studio lighting, DSLR quality, cinematic color grade, 4K, masterpiece rendering, HDR, film emulation, color grading, professional finish, sharp commercial look',
  },
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
    style           = '',   // full prompt string from STYLE_MAP (fallback)
    styleId         = '',   // id key: 'ugc', 'cctv', 'closeup', etc.
    context         = '',
    model           = 'balanced',
    count           = 1,
    ratio           = '1:1',
    cfg             = 7,    // guidance slider (1–20)
    locEnabled      = false,
    locTextHandling = 'leave',
    locRegion       = '',
  } = req.body;

  const styleConf = STYLE_CONFIG[styleId] || null;

  // Map cfg (1–20) to temperature (1.0–0.2).
  // Low cfg (e.g. 5 for Casual) → high temperature → looser, more natural output.
  // High cfg (e.g. 16) → low temperature → more literal, structured output.
  const temperature = Math.max(0.2, Math.min(1.0, 1.0 - ((cfg - 1) / 19) * 0.8));

  let fullPrompt;

  if (locEnabled && locRegion) {
    // ── Localization path ──────────────────────────────────────────────────
    const eth   = locRegion.charAt(0).toUpperCase() + locRegion.slice(1);
    const parts = [`A person of ${eth} ethnicity and heritage`];
    if (styleConf)       parts.push(styleConf.medium);
    else if (style)      parts.push(style);
    if (prompt)          parts.push(prompt);
    if (context)         parts.push(context);
    if (locTextHandling === 'translate') parts.push(`text in the image should appear in the language of ${locRegion}`);
    else if (locTextHandling === 'localize') parts.push(`use culturally appropriate visual elements for ${locRegion}`);
    else if (locTextHandling === 'remove')   parts.push('no visible text in the image');
    parts.push(RATIO_LABELS[ratio] || ratio);
    if (styleConf?.negative) parts.push(`Avoid: ${styleConf.negative}`);
    fullPrompt = parts.join('. ').replace(/\.+/g, '.').trim();

  } else if (styleConf) {
    // ── Sandwich format (style selected) ──────────────────────────────────
    const parts = [
      `[MEDIUM: ${styleConf.medium}]`,
      prompt  ? `[SUBJECT: ${prompt}]`         : null,
      context ? `[SCENE: ${context}]`           : null,
      `[TECHNICAL: ${styleConf.technical}]`,
      `[AVOID: ${styleConf.negative}]`,
      RATIO_LABELS[ratio] || ratio,
    ].filter(Boolean);
    fullPrompt = parts.join('. ').replace(/\.+/g, '.').trim();

  } else {
    // ── Standard path (no style selected) ─────────────────────────────────
    const parts = [];
    if (style)   parts.push(style);
    if (prompt)  parts.push(prompt);
    if (context) parts.push(`Scene: ${context}`);
    parts.push(RATIO_LABELS[ratio] || ratio);
    fullPrompt = parts.join('. ').replace(/\.+/g, '.').trim();
  }

  if (!fullPrompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  console.log('[generate] styleId=%s cfg=%d temp=%.2f', styleId, cfg, temperature);
  console.log('[generate] prompt=', fullPrompt.slice(0, 400));

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
