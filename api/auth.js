// api/auth.js — password gate

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ ok: false, error: 'Password required' });
  }

  if (password === process.env.SITE_PASSWORD) {
    res.setHeader(
      'Set-Cookie',
      `drama_auth=1; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Strict`
    );
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false, error: 'Wrong password' });
};
