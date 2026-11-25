/**
 * 보안 외부 HTTP 클라이언트 (Electron Main 전용).
 *
 * 보안 원칙:
 * - URL 형식 및 프로토콜 검사 (HTTPS 우선, file/javascript/data/ftp 등 차단)
 * - localhost 및 사설 IP / 링크로컬 / 내부망 대역 차단 (초기 URL + 모든 리다이렉트 + DNS 해석 결과)
 * - 응답 크기 제한(기본 5 MB) 및 요청 시간 제한(기본 12초)
 * - 호스트별 요청 빈도 제한(rate limiting)
 * - robots.txt 확인 및 준수 (차단 경로 우회 금지)
 * - 인증/쿠키/개인정보 기록 및 우회 금지
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { SafeHttpClient, SafeHttpResponse } from './types';

export const USER_AGENT = 'GOMO-Create/0.1.0 (Windows Desktop Original-Text Reader; respects robots.txt)';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MIN_HOST_INTERVAL_MS = 250;

export class SourceNetworkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceNetworkError';
    this.code = code;
  }
}

/** 사설/로컬 IPv4·IPv6 여부 판별 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  if (!clean) return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (clean.startsWith('::ffff:')) {
    return isPrivateOrReservedIp(clean.slice(7));
  }

  const ver = isIP(clean);
  if (ver === 4) {
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (ver === 6) {
    if (clean === '::' || clean === '::1') return true;
    // fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast)
    if (/^(fc|fd|fe[89ab]|ff)/i.test(clean)) return true;
    return false;
  }

  return true;
}

/** URL 문자열의 프로토콜·호스트·사설망 차단 검사 */
export function validateSafeUrl(rawUrl: string, opts: { requireHttps?: boolean } = {}): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new SourceNetworkError('INVALID_URL', 'URL이 비어 있습니다.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SourceNetworkError('INVALID_URL', '올바른 URL 형식이 아닙니다. (예: https://ko.wikisource.org/...)');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SourceNetworkError('UNSUPPORTED_PROTOCOL', `허용되지 않는 프로토콜(${parsed.protocol})입니다. HTTPS URL만 사용할 수 있습니다.`);
  }
  if (opts.requireHttps && parsed.protocol !== 'https:') {
    throw new SourceNetworkError('HTTPS_REQUIRED', '보안을 위해 HTTPS 주소만 허용합니다.');
  }
  if (parsed.username || parsed.password) {
    throw new SourceNetworkError('CREDENTIALS_IN_URL', '인증 정보가 포함된 URL은 보안상 허용하지 않습니다.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0'
  ) {
    throw new SourceNetworkError('BLOCKED_LOCAL_HOST', '로컬(localhost) 및 내부 네트워크 주소는 보안상 차단됩니다.');
  }

  // IPv6 리터럴 대괄호 제거 후 검사
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bareHost) && isPrivateOrReservedIp(bareHost)) {
    throw new SourceNetworkError('BLOCKED_PRIVATE_IP', '사설 IP 또는 로컬 IP 주소에는 접근할 수 없습니다.');
  }

  return parsed;
}

/** DNS 해석 후 사설/로컬 IP로 풀리는지 추가 검사 (DNS Rebinding 방지) */
async function assertPublicDns(hostname: string): Promise<void> {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) {
    if (isPrivateOrReservedIp(bare)) {
      throw new SourceNetworkError('BLOCKED_PRIVATE_IP', '사설 IP 또는 로컬 IP 주소에는 접근할 수 없습니다.');
    }
    return;
  }
  try {
    const records = await lookup(bare, { all: true });
    if (!records.length) {
      throw new SourceNetworkError('DNS_FAILED', `호스트(${bare}) 주소를 확인할 수 없습니다.`);
    }
    for (const r of records) {
      if (isPrivateOrReservedIp(r.address)) {
        throw new SourceNetworkError('BLOCKED_PRIVATE_IP', `호스트(${bare})가 사설/로컬 IP로 연결되어 보안상 차단했습니다.`);
      }
    }
  } catch (err) {
    if (err instanceof SourceNetworkError) throw err;
    throw new SourceNetworkError('NETWORK_ERROR', `인터넷 연결 또는 도메인 조회에 실패했습니다: ${bare}`);
  }
}

/** robots.txt 규칙 파서 (User-agent: * 및 GOMO-Create 기준) */
export function parseRobotsDisallow(robotsText: string, userAgentToken = 'gomo-create'): string[] {
  const lines = robotsText.replace(/\r\n?/g, '\n').split('\n');
  let activeGroup: 'none' | 'star' | 'specific' = 'none';
  const starDisallows: string[] = [];
  const specificDisallows: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      activeGroup = 'none';
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      const ua = val.toLowerCase();
      if (ua === '*') activeGroup = activeGroup === 'specific' ? 'specific' : 'star';
      else if (ua.includes(userAgentToken)) activeGroup = 'specific';
      else if (activeGroup === 'none') activeGroup = 'none';
    } else if (key === 'disallow' && val) {
      if (activeGroup === 'specific') specificDisallows.push(val);
      else if (activeGroup === 'star') starDisallows.push(val);
    }
  }
  return specificDisallows.length > 0 ? specificDisallows : starDisallows;
}

export function isPathDisallowedByRobots(pathname: string, disallows: string[]): boolean {
  for (const rule of disallows) {
    if (rule === '/') return true;
    const normalized = rule.replace(/\*.*$/, '');
    if (normalized && pathname.startsWith(normalized)) return true;
  }
  return false;
}

export function createSafeHttpClient(opts: { skipDnsCheck?: boolean } = {}): SafeHttpClient {
  const hostLastCall = new Map<string, number>();
  const robotsCache = new Map<string, { fetchedAt: number; disallows: string[] }>();

  async function paceHost(host: string): Promise<void> {
    const last = hostLastCall.get(host) ?? 0;
    const wait = MIN_HOST_INTERVAL_MS - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    hostLastCall.set(host, Date.now());
  }

  async function rawFetchWithRedirects(
    startUrl: string,
    timeoutMs: number,
    maxBytes: number,
    accept: string
  ): Promise<SafeHttpResponse> {
    let currentUrl = validateSafeUrl(startUrl, { requireHttps: false });
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!opts.skipDnsCheck) await assertPublicDns(currentUrl.hostname);
      await paceHost(currentUrl.hostname);

      let res: Response;
      try {
        res = await fetch(currentUrl.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: accept
          },
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout')) {
          throw new SourceNetworkError('TIMEOUT', '원문 제공처 응답 시간이 초과되었습니다.');
        }
        throw new SourceNetworkError('NETWORK_ERROR', '인터넷 연결을 확인하거나 잠시 후 다시 시도해 주세요.');
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          throw new SourceNetworkError('REDIRECT_ERROR', '리다이렉트 대상 주소를 확인할 수 없습니다.');
        }
        if (hop === MAX_REDIRECTS) {
          throw new SourceNetworkError('TOO_MANY_REDIRECTS', '리다이렉트가 너무 많아 요청을 중단했습니다.');
        }
        const resolved = new URL(loc, currentUrl).toString();
        currentUrl = validateSafeUrl(resolved, { requireHttps: false });
        continue;
      }

      const contentLength = Number(res.headers.get('content-length') || '0');
      if (contentLength > maxBytes) {
        throw new SourceNetworkError('RESPONSE_TOO_LARGE', `응답 크기가 허용 한도(${Math.round(maxBytes / 1024 / 1024)} MB)를 초과했습니다.`);
      }

      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel().catch(() => {});
              throw new SourceNetworkError('RESPONSE_TOO_LARGE', `응답 크기가 허용 한도(${Math.round(maxBytes / 1024 / 1024)} MB)를 초과했습니다.`);
            }
            chunks.push(value);
          }
        }
      }

      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }

      const contentType = res.headers.get('content-type') || '';
      const charsetMatch = contentType.match(/charset=([a-z0-9_-]+)/i);
      const charset = (charsetMatch?.[1] || 'utf-8').toLowerCase();
      let text: string;
      try {
        text = new TextDecoder(charset).decode(merged);
      } catch {
        text = new TextDecoder('utf-8').decode(merged);
      }

      return {
        ok: res.ok,
        status: res.status,
        finalUrl: currentUrl.toString(),
        contentType,
        text,
        bytes: total
      };
    }

    throw new SourceNetworkError('TOO_MANY_REDIRECTS', '리다이렉트 한도를 초과했습니다.');
  }

  async function isRobotsAllowed(url: string): Promise<{ allowed: boolean; reason?: string }> {
    const parsed = validateSafeUrl(url);
    const origin = parsed.origin;
    const cached = robotsCache.get(origin);
    let disallows: string[] = [];

    if (cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000) {
      disallows = cached.disallows;
    } else {
      try {
        const res = await rawFetchWithRedirects(`${origin}/robots.txt`, 5000, 256 * 1024, 'text/plain,*/*');
        if (res.ok) disallows = parseRobotsDisallow(res.text);
      } catch {
        // robots.txt가 없거나 응답하지 않는 경우 보수적으로 빈 규칙으로 처리(단, 개별 사이트 정책에서 추가 제한 가능)
        disallows = [];
      }
      robotsCache.set(origin, { fetchedAt: Date.now(), disallows });
    }

    if (isPathDisallowedByRobots(parsed.pathname, disallows)) {
      return {
        allowed: false,
        reason: `${parsed.hostname}의 robots.txt 정책에 따라 이 경로(${parsed.pathname})의 자동 수집이 허용되지 않습니다.`
      };
    }
    return { allowed: true };
  }

  async function fetchText(
    url: string,
    reqOpts: { timeoutMs?: number; maxBytes?: number; checkRobots?: boolean; accept?: string } = {}
  ): Promise<SafeHttpResponse> {
    validateSafeUrl(url);
    if (reqOpts.checkRobots) {
      const robots = await isRobotsAllowed(url);
      if (!robots.allowed) {
        throw new SourceNetworkError('ROBOTS_DISALLOWED', robots.reason || 'robots.txt 정책에 의해 자동 접근이 제한되었습니다.');
      }
    }
    return rawFetchWithRedirects(
      url,
      reqOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      reqOpts.maxBytes ?? DEFAULT_MAX_BYTES,
      reqOpts.accept ?? 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5'
    );
  }

  return { fetchText, isRobotsAllowed };
}
