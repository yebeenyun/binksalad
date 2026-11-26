const AUTHORIZE_ENDPOINT = 'https://kauth.kakao.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://kauth.kakao.com/oauth/token';
const USER_INFO_ENDPOINT = 'https://kapi.kakao.com/v2/user/me';

export function getKakaoConfig(environment = process.env) {
  const config = {
    restApiKey: environment.KAKAO_REST_API_KEY?.trim() || '',
    clientSecret: environment.KAKAO_CLIENT_SECRET?.trim() || '',
    redirectUri: environment.KAKAO_REDIRECT_URI?.trim() || ''
  };
  return { ...config, configured: Boolean(config.restApiKey && config.clientSecret && config.redirectUri) };
}

export function createKakaoAuthorizationUrl(state, config) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', config.restApiKey);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function fetchKakaoProfile(code, config, fetchImplementation = fetch) {
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.restApiKey,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code
  });
  const tokenResponse = await fetchImplementation(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: tokenBody,
    signal: AbortSignal.timeout(10_000)
  });
  if (!tokenResponse.ok) throw new Error('카카오 토큰 발급에 실패했습니다.');
  const tokenResult = await tokenResponse.json();
  if (typeof tokenResult.access_token !== 'string' || !tokenResult.access_token) {
    throw new Error('카카오 토큰 응답이 올바르지 않습니다.');
  }

  const profileResponse = await fetchImplementation(USER_INFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokenResult.access_token}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!profileResponse.ok) throw new Error('카카오 사용자 정보를 가져오지 못했습니다.');
  const profile = await profileResponse.json();
  if (profile.id == null) throw new Error('카카오 사용자 정보에 회원 번호가 없습니다.');

  const nickname = profile.kakao_account?.profile?.nickname || profile.properties?.nickname || '';
  return { userId: String(profile.id), nickname: String(nickname).slice(0, 100) || null };
}
