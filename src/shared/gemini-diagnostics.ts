/**
 * Gemini 연결 진단 — 연결 확인 때 모은 "사실"과 그로부터의 판정, 복사해서 붙여넣을 수 있는 진단 텍스트.
 * Electron 없이 테스트할 수 있도록 순수 함수로만 구성합니다 (scripts/test-version-skew.mjs).
 */
import { AUTOMATION_PROTOCOL, type VersionIssue } from './gemini-protocol';

/** 앱 파이프에 붙은 Host 연결 하나 (pipe-client가 Host·확장의 자기 보고를 기록) */
export interface HostConnectionInfo {
  connId: number;
  connectedAt: string;
  host?: { protocol: number | null; version: string; pid?: number; startedAt?: string; caller?: string; logFile?: string; chromeConnected?: boolean };
  /** 이 Host를 띄운 확장이 보낸 HELLO. protocol null = 0.2.0 이하 서비스 워커 코드(0.2.1부터 HELLO에 protocol 포함) */
  extensionHello?: { version: string | null; protocol: number | null; at: string };
  /** 0.2.2+ 확장의 회신 봉투에 실린 프로토콜 */
  lastReplyProtocol?: number;
  lastFromHostAt?: string;
}

const extProto = (c: HostConnectionInfo) => Math.max(Number(c.extensionHello?.protocol) || 0, Number(c.lastReplyProtocol) || 0);

/** 요청을 보낼 연결 선택: 자동화 프로토콜을 지원하는 확장의 Host 중 가장 최근 → 없으면 가장 최근 연결 */
export function pickHostConnection(list: HostConnectionInfo[]): number | null {
  if (!list.length) return null;
  const capable = list.filter(c => extProto(c) >= AUTOMATION_PROTOCOL && c.host?.chromeConnected !== false);
  const pool = capable.length ? capable : list;
  return pool.reduce((a, b) => (b.connId > a.connId ? b : a)).connId;
}

export interface ConnectionDiagnostics {
  at: string;
  app: { protocol: number };
  pipe: string;
  serverError?: string | null;
  activeConnId: number | null;
  hosts: HostConnectionInfo[];
  /** HOST_INFO_REQUEST 응답 (null = timeoutMs 안에 응답 없음) */
  hostInfo: { protocol: number | null; version: string; pid?: number; startedAt?: string; caller?: string; logFile?: string; chromeConnected?: boolean; extension?: { version: string | null; protocol: number | null; at?: string } | null } | null;
  hostInfoTimeoutMs: number;
  /** GEMINI_STATUS_RESULT 응답 (null = timeoutMs 안에 응답 없음) */
  status: {
    ms: number;
    extension: { protocol?: number; version?: string; build?: string; id?: string; swStartedAt?: string } | null;
    content: { state: string; protocol?: number; error?: string } | null;
    tabs: number;
    envelopeProtocol?: number;
  } | null;
  statusTimeoutMs: number;
}

/** 사실 → 판정. null = 문제 없음 */
export function diagnose(d: ConnectionDiagnostics): VersionIssue | null {
  if (!d.hosts.length) return { code: 'HOST_NOT_CONNECTED', message: 'Native Host가 앱에 연결되어 있지 않습니다.' };
  if (!d.hostInfo || !(Number(d.hostInfo.protocol) >= AUTOMATION_PROTOCOL)) {
    return { code: 'HOST_OUTDATED', message: `Native Host가 이전 버전입니다(버전 확인에 ${d.hostInfo ? `프로토콜 ${d.hostInfo.protocol ?? '없음'}으로 응답` : `${d.hostInfoTimeoutMs / 1000}초 안에 응답 없음`}, 필요: ${AUTOMATION_PROTOCOL}).` };
  }
  if (!d.status) {
    return { code: 'EXTENSION_NO_REPLY', message: `Chrome 확장 프로그램이 ${d.statusTimeoutMs / 1000}초 안에 상태 응답을 보내지 않았습니다(Host ${d.hostInfo.pid ?? '?'}의 확장 연결: ${d.hostInfo.chromeConnected === false ? '끊김' : '연결됨'}).` };
  }
  const reported = Number(d.status.extension?.protocol) || Number(d.status.envelopeProtocol) || 0;
  if (reported < AUTOMATION_PROTOCOL) {
    const hello = d.hostInfo.extension;
    const others = d.hosts.length > 1 ? ` 앱에 Host가 ${d.hosts.length}개 연결되어 있습니다(Chrome 프로필이나 확장 사본이 여럿일 수 있음).` : '';
    let why = '';
    if (hello?.version === '0.1.0') why = ' 응답한 확장은 0.1.0입니다 — 다른 Chrome 프로필이나 다른 폴더에 설치된 이전 사본이 연결되어 있습니다.';
    else if (hello?.version) why = ` 응답한 확장의 카드 버전은 ${hello.version}인데 서비스 워커 코드가 버전을 보고하지 않습니다 — Chrome이 서비스 워커를 이전 코드로 실행 중입니다.`;
    return { code: 'EXTENSION_OUTDATED', message: `Chrome 확장 프로그램이 이전 버전으로 실행 중입니다(보고된 프로토콜: 없음, 필요: ${AUTOMATION_PROTOCOL}).${why}${others}` };
  }
  const c = d.status.content;
  if (c && (c.state === 'outdated' || (c.state === 'ok' && !(Number(c.protocol) >= AUTOMATION_PROTOCOL)))) {
    return { code: 'CONTENT_OUTDATED', message: 'Gemini 탭에 이전 버전의 확장 스크립트가 남아 있습니다.' };
  }
  return null;
}

const t = (iso?: string) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR', { hour12: false });
};
const CONTENT_LABEL: Record<string, string> = { ok: '최신', outdated: '이전 버전', none: '아직 없음(전송 때 자동 주입)', unknown: '확인 못 함' };

/** 승희님이 복사해서 보내 줄 진단 텍스트 (프롬프트·응답 본문 없음) */
export function formatDiagnostics(d: ConnectionDiagnostics, issue: VersionIssue | null = diagnose(d)): string {
  const L: string[] = [];
  L.push(`[GOMO 연결 진단] ${t(d.at)}`);
  L.push(`판정: ${issue ? `${issue.code} — ${issue.message}` : '정상 (버전 일치)'}`);
  L.push(`앱: 자동화 프로토콜 ${d.app.protocol}, 연결 통로 ${d.pipe}${d.serverError ? ` (오류: ${d.serverError})` : ''}`);
  L.push(`Host 연결 ${d.hosts.length}개${d.hosts.length > 1 ? ' ← 여러 개면 Chrome 프로필/확장 사본이 여럿이거나 이전 Host가 남아 있음' : ''}:`);
  for (const h of d.hosts) {
    const host = h.host;
    const hello = h.extensionHello;
    L.push(`  #${h.connId}${h.connId === d.activeConnId ? ' (사용 중)' : ''} 연결 ${t(h.connectedAt)} · Host ${host ? `${host.version || '?'} 프로토콜 ${host.protocol ?? '없음'} pid ${host.pid ?? '?'} 시작 ${t(host.startedAt)}` : '정보 없음(이전 Host)'}`);
    L.push(`      호출 확장: ${host?.caller || '-'} · 확장 연결: ${host?.chromeConnected === false ? '끊김' : host ? '연결됨' : '?'} · 확장 HELLO: ${hello ? `버전 ${hello.version ?? '?'} 프로토콜 ${hello.protocol ?? '없음'} (${t(hello.at)})` : '받지 못함'}`);
  }
  const hi = d.hostInfo;
  L.push(`Host 버전 확인 응답: ${hi ? `${hi.version} 프로토콜 ${hi.protocol ?? '없음'} pid ${hi.pid ?? '?'} 시작 ${t(hi.startedAt)} · 확장 연결 ${hi.chromeConnected === false ? '끊김' : '연결됨'}` : `${d.hostInfoTimeoutMs / 1000}초 안에 응답 없음`}`);
  const s = d.status;
  if (!s) L.push(`확장 상태 응답: ${d.statusTimeoutMs / 1000}초 안에 응답 없음`);
  else {
    const e = s.extension;
    L.push(`확장 상태 응답(${s.ms}ms): ${e ? `버전 ${e.version || '?'} 프로토콜 ${e.protocol ?? '없음'} 빌드 ${e.build || '?'} ID ${e.id || '?'} 서비스 워커 시작 ${t(e.swStartedAt)}` : '버전 정보 없음 → 이전 서비스 워커 코드'} · Gemini 탭 ${s.tabs}개`);
    L.push(`Gemini 탭 스크립트: ${s.content ? `${CONTENT_LABEL[s.content.state] || s.content.state}${s.content.protocol ? ` (프로토콜 ${s.content.protocol})` : ''}${s.content.error ? ` (${s.content.error})` : ''}` : '보고 없음'}`);
  }
  L.push(`Host 로그 파일: ${hi?.logFile || d.hosts.find(h => h.host?.logFile)?.host?.logFile || '%USERPROFILE%\\.gomo-create\\host.log'}`);
  return L.join('\n');
}
