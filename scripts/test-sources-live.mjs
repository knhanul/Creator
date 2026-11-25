/**
 * 실제 외부 원문 제공처 통합 확인 스크립트 (네트워크 필요).
 * 실행: npm run test:sources:live
 *
 * 확인 대상:
 * 1. 한국어 위키문헌(ko.wikisource.org): '서시 윤동주' 검색 → 실제 원문 추출 → PD-old-70 근거 확인
 * 2. 성경 개역한글판(bolls.life KRV): 시편 23편 1~6절 가져오기 → 6절 무결성 검증
 * 3. 한국저작권위원회 공유마당(gongu.copyright.or.kr): robots.txt 정책 확인
 * 4. Project Gutenberg(gutendex.com): 타임아웃/응답 상태 확인 (응답 불가 시 미검증 표기)
 */
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const { createDefaultSourceService } = loadTS(join(root, 'src/main/sources/source-service.ts'));
const { createSafeHttpClient } = loadTS(join(root, 'src/main/sources/http-client.ts'));

const http = createSafeHttpClient();
const service = createDefaultSourceService({ http });

async function runLive(name, fn) {
  try {
    await fn();
    console.log('LIVE PASS:', name);
  } catch (err) {
    console.log('LIVE UNVERIFIED/FAIL:', name, '-', err instanceof Error ? err.message : String(err));
  }
}

await runLive('한국어 위키문헌: 윤동주 서시 검색 → 원문 추출 → 저작권 근거', async () => {
  const search = await service.search({ query: '서시', author: '윤동주', providerIds: ['wikisource-ko'] });
  assert.ok(search.candidates.length > 0, '검색 후보 없음');
  const first = search.candidates[0];
  const fetched = await service.fetchOriginal(first);
  assert.equal(fetched.ok, true, fetched.errorMessage);
  assert.ok(fetched.originalText.includes('하늘을 우르러') || fetched.originalText.includes('하늘을 우러러'));
  assert.equal(fetched.rights.status, 'PUBLIC_DOMAIN_VERIFIED');
  console.log(`   -> 제목: ${fetched.title}, 저자: ${fetched.author}, 판본: ${fetched.edition}, 저작권: ${fetched.rights.status}, ${fetched.originalText.length}자`);
});

await runLive('성경 개역한글판(KRV): 시편 23편 1~6절 가져오기 및 검증', async () => {
  const res = await service.fetchBible({
    translationId: 'KRV',
    bookId: 19,
    chapter: 23,
    startVerse: 1,
    endVerse: 6
  });
  assert.equal(res.ok, true, res.errorMessage);
  assert.equal(res.originalText.split('\n').length, 6);
  assert.ok(res.originalText.includes('여호와는 나의 목자시니'));
  assert.equal(res.rights.status, 'PUBLIC_DOMAIN_VERIFIED');
  console.log(`   -> 제목: ${res.title}, 판본: ${res.edition}, 저작권: ${res.rights.status}, 절 수: ${res.meta.verseCount}`);
});

await runLive('공유마당(gongu.copyright.or.kr) robots.txt 다운로드 경로 제한 확인', async () => {
  const check = await http.isRobotsAllowed('https://gongu.copyright.or.kr/gongu/wrt/cmmn/wrtFileDownload.do');
  assert.equal(check.allowed, false, '공유마당 파일 다운로드 경로는 robots.txt로 차단되어야 함');
  console.log(`   -> 확인됨: ${check.reason}`);
});

await runLive('Project Gutenberg (gutendex.com) 검색 연결 확인', async () => {
  const res = await service.search({ query: 'Pride and Prejudice', providerIds: ['project-gutenberg'], limit: 2 });
  assert.ok(res.candidates.length > 0, 'Gutendex 응답 없음 또는 시간 초과');
  console.log(`   -> 검색됨: ${res.candidates[0].title} (${res.candidates[0].author})`);
});
