// Public AdSense H5 Games Ads settings. Publisher ids are not secrets, but they
// are still not invented here: empty or invalid values disable ads.

const CLIENT_RE = /^ca-pub-\d{10,22}$/;
const CHANNEL_RE = /^\d{1,20}$/;
const HOST_RE = /^ca-host-pub-\d{1,22}$/;
const FREQ_RE = /^\d{1,4}s$/;

export function publicAdsConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const client = String(src.client || '').trim();
  if (!CLIENT_RE.test(client)) return { enabled: false };
  const channel = String(src.channel || '').trim();
  const host = String(src.host || '').trim();
  const frequencyHint = String(src.frequencyHint || '').trim();
  const test = src.test === true || src.test === 'on' || src.test === '1' || src.test === 'true';
  const cfg = {
    enabled: true,
    client,
    frequencyHint: FREQ_RE.test(frequencyHint) ? frequencyHint : '120s',
    test
  };
  if (CHANNEL_RE.test(channel)) cfg.channel = channel;
  if (HOST_RE.test(host)) cfg.host = host;
  return cfg;
}

function readName(name, env) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      const v = Netlify.env.get(name);
      if (v != null && String(v) !== '') return String(v);
    }
  } catch (e) {}
  const v = env ? env[name] : '';
  return v == null ? '' : String(v);
}

export function readAdsEnv(env = process.env) {
  return {
    client: readName('ADSENSE_CLIENT', env),
    channel: readName('ADSENSE_CHANNEL', env),
    host: readName('ADSENSE_HOST', env),
    frequencyHint: readName('ADSENSE_FREQUENCY_HINT', env),
    test: readName('ADSENSE_TEST', env)
  };
}
