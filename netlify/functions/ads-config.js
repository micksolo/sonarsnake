import { publicAdsConfig, readAdsEnv } from './_shared/ads-config.js';

export default async () => {
  const cfg = publicAdsConfig(readAdsEnv());
  return Response.json(cfg, { headers: { 'cache-control': 'no-store' } });
};

export const config = { path: '/api/ads-config' };
