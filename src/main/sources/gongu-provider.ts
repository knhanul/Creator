/**
 * 한국저작권위원회 공유마당(gongu.copyright.or.kr) Source Adapter.
 *
 * 확인된 사실 (실제 robots.txt 점검 및 공식 정책 기준):
 * - gongu.copyright.or.kr/robots.txt 는 다음 파일 다운로드 경로를 명시적으로 차단(Disallow)합니다:
 *   /gongu/wrt/wrt/wrtDownPopup.do, /gongu/wrt/cmmn/wrtFileDownload.do, /gongu/cmmn/file/fileDown.do
 * - 공식 Open API(한국저작권위원회_공유(만료)저작물 서비스)는 공공데이터포털(data.go.kr)에서
 *   인증키를 발급받아 호출하는 메타데이터 조회 서비스입니다.
 *
 * 원칙:
 * 1. 확인되지 않은 비공개 API를 임의로 호출하거나 robots.txt 차단 경로를 우회하지 않는다.
 * 2. 공유마당 등록만으로 모든 작품을 무제한 이용 가능으로 자동 판정하지 않는다(기증·만료·CC·공공누리 유형별 상이).
 * 3. 검색 결과가 없거나 인증키가 없으면 존재하지 않는 가짜 후보를 만들어 보여주지 않는다.
 * 4. 자동 다운로드가 허용되지 않으므로 공식 공유마당 페이지를 열어 사용자가 직접 확인·다운로드 후 가져오도록 안내한다.
 */
import type {
  OriginalFetchResult,
  RightsEvidence,
  SourceCandidate,
  SourceSearchQuery
} from '../../shared/source-types';
import { evaluateRightsEvidence } from '../../shared/copyright';
import type { OriginalSourceProvider } from './types';

export const GONGU_OFFICIAL_URL = 'https://gongu.copyright.or.kr/';

export function buildGonguOfficialSearchUrl(query: string): string {
  const q = query.trim();
  if (!q) return GONGU_OFFICIAL_URL;
  return `https://gongu.copyright.or.kr/gongu/search/search/list.do?searchWord=${encodeURIComponent(q)}`;
}

export function createGonguProvider(): OriginalSourceProvider {
  const id = 'gongu-copyright';
  const name = '한국저작권위원회 공유마당';

  async function search(_query: SourceSearchQuery): Promise<SourceCandidate[]> {
    // robots.txt가 파일 다운로드 경로를 명시적으로 Disallow하고,
    // 공공데이터포털 Open API는 사용자별 인증키가 필요하므로 확인되지 않은 비공개 엔드포인트를 호출하지 않는다.
    // 존재하지 않는 작품을 지어내지 않기 위해 빈 배열을 반환하며, UI에서 공식 공유마당 검색 열기 버튼을 제공한다.
    return [];
  }

  async function getRightsInfo(candidate: SourceCandidate): Promise<RightsEvidence> {
    return evaluateRightsEvidence({
      providerEvidenceStatus: 'REVIEW_REQUIRED',
      providerEvidenceItems: [
        '공유마당에는 만료저작물·기증저작물·자유이용허락표시(CC)·공공누리 등 서로 다른 유형의 저작물이 함께 등록되어 있습니다.',
        `공식 자료 페이지에서 개별 저작물의 이용허락 유형(상업적 이용·2차적저작물·출처표시)을 직접 확인해야 합니다: ${candidate.sourceUrl || GONGU_OFFICIAL_URL}`
      ],
      jurisdiction: '대한민국',
      sourceAccessNote:
        'gongu.copyright.or.kr/robots.txt 정책에 따라 자동 파일 다운로드는 수행하지 않습니다. 공식 페이지에서 직접 확인하고 내려받은 TXT 파일을 가져오세요.'
    });
  }

  async function fetchOriginal(candidate: SourceCandidate): Promise<OriginalFetchResult> {
    const officialUrl = candidate.sourceUrl || buildGonguOfficialSearchUrl(candidate.title);
    const rights = await getRightsInfo(candidate);
    return {
      ok: false,
      sourceId: id,
      sourceName: name,
      workId: candidate.workId || 'gongu-manual',
      title: candidate.title,
      author: candidate.author,
      edition: candidate.edition || '공유마당 공식 자료 페이지 확인 필요',
      sourceUrl: officialUrl,
      rights,
      fetchedAt: new Date().toISOString(),
      inputMethod: 'search',
      errorCode: 'MANUAL_DOWNLOAD_REQUIRED',
      errorMessage:
        '공유마당은 robots.txt 정책상 자동 파일 다운로드를 허용하지 않습니다. 공식 공유마당 페이지에서 이용 조건을 확인하고 직접 내려받은 뒤 파일 가져오기 또는 붙여넣기를 이용해 주세요.',
      accessInfo: {
        manualOnly: true,
        officialUrl,
        reason: 'gongu.copyright.or.kr/robots.txt의 다운로드 경로 제한 및 저작물별 이용허락 조건 확인 필요'
      }
    };
  }

  return {
    id,
    name,
    description:
      '한국저작권위원회 공유마당 공식 검색 연계 (robots.txt 준수: 자동 다운로드 우회 없이 공식 페이지 직접 확인·가져오기 안내).',
    officialUrl: GONGU_OFFICIAL_URL,
    autoFetchSupported: false,
    kinds: ['literature'],
    search,
    fetchOriginal,
    getRightsInfo
  };
}
