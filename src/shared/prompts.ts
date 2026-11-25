import type { AIStage, StudioProject } from './types';
import { AUDIENCES, GENRES } from './workflow';

const SAFETY = `영상 속 자막, 글씨, 워터마크를 만들지 않는다. 원문의 실제 문장을 임의로 바꾸지 않는다. 어린이를 포함한 시청자 대상이라면 비폭력적·정서적으로 안전한 묘사를 우선한다. 성경은 하나님을 인간 형상으로 묘사하지 않고, 예수님의 얼굴을 정면으로 클로즈업하지 않는다. 원문 자체는 변경하지 않는다. 캐릭터 복장·색감·시대와 지역적 맥락의 일관성을 유지한다.`;
const common = (p: StudioProject) => `당신은 낭독 콘텐츠의 시각 연출·이미지·영상·음악 제작 기획자입니다. 답변은 요구한 JSON 스키마 하나로만 작성하고 Markdown 설명은 쓰지 마세요.
작품 제목: ${p.brief.title}
장르: ${GENRES[p.brief.genre]}
대상: ${AUDIENCES[p.brief.audience]}
저자/출처: ${p.brief.author || '미입력'}${p.brief.source ? ` (${p.brief.source})` : ''}
목표 길이(초): ${p.brief.targetDuration}
화면 비율: ${p.brief.aspectRatio}
원문(필수 참조, 요약·각색 금지):
<<<ORIGINAL_TEXT
${p.brief.originalText}
ORIGINAL_TEXT
제작 안전 규칙: ${SAFETY}`;
export function makeAIPrompt(p:StudioProject, stage:AIStage):string {
  const intro=common(p);
  if(stage==='analysis') return `${intro}

[임무] 작품을 분석하고, 구분 가능한 화풍 3개와 연출 방향 3개를 제안하세요. 각 id는 영문 짧은 고유 문자열입니다. 특정 텍스트나 이미지를 직접 생성하지 말고 작품 의미를 보존하세요.
[출력 형식 정확히]
{ "schema":"creator.analysis.v1", "summary":"한 문장 작품 요약", "emotion":"핵심 정서", "keywords":["키워드"], "styles":[{"id":"watercolor","label":"따뜻한 수채화","description":"묘사"}], "directions":[{"id":"gentle","label":"잔잔한 서정","description":"묘사"}], "cautions":["주의점"] }
styles/directions는 각각 3개, keywords는 3~6개로 작성하세요.`;
  if(stage==='storyboard') { const style=p.analysis?.styles.find(x=>x.id===p.selection.styleId),direction=p.analysis?.directions.find(x=>x.id===p.selection.directionId); return `${intro}
선택한 화풍: ${style?.label||'미선택'} — ${style?.description||''}
선택한 연출 방향: ${direction?.label||'미선택'} — ${direction?.description||''}
[임무] 원문을 순서대로 누락 없이 낭독할 수 있도록 4~12개 장면으로 나눕니다. narration은 해당 장면에서 실제 읽을 원문 문장을 그대로 적으세요. 장면 id는 S01, S02 형식. 각 장면의 시각 연출, 이미지/영상 권장 구분과 예상 초를 적으세요.
[출력 형식]
{ "schema":"creator.storyboard.v1", "scenes":[{"id":"S01","title":"장면 제목","narration":"원문 그대로","visual":"화면 구성","durationSec":12,"kind":"image"}] }`; }
  if(stage==='prompt') return `${intro}
선택 화풍: ${p.analysis?.styles.find(x=>x.id===p.selection.styleId)?.label||''}
승인 장면표(JSON): ${JSON.stringify(p.scenes.map(({id,title,narration,visual,kind})=>({id,title,narration,visual,kind})))}
[임무] 각 장면별로 이미지 생성 영어 프롬프트와 (가능한 경우) 짧은 동영상 영어 프롬프트를 만드세요. kind가 "video"인 장면은 videoPrompt를 반드시 채우세요. 영상 동작은 하나씩, 카메라 움직임은 느리게, 화면의 텍스트를 금지합니다. 동일 화풍/캐릭터의 일관성을 위해 반복 공통 묘사를 넣으세요. 배경음악은 무보컬, 기존 저작물 모방 금지.
[출력 형식]
{ "schema":"creator.prompts.v1", "items":[{"sceneId":"S01","imagePrompt":"English prompt","videoPrompt":"English prompt","negativePrompt":"English negatives"}], "bgmPrompt":"English instrumental music prompt" }
items는 장면 수와 동일해야 하고 모든 sceneId가 정확히 한 번 나타나야 합니다.`;
  return `${intro}
사용 가능한 미디어 인벤토리(JSON): ${JSON.stringify(p.scenes.map(s=>({sceneId:s.id,media:p.assets.find(a=>a.id===s.assetId)?.name||null,kind:s.kind,durationSec:s.durationSec,narration:s.narration})))}
[임무] 실제 확보된 파일을 고려해 최종 타임라인 순서/길이/전환을 설계하세요. 확보되지 않은 미디어를 있다고 가정하지 마세요. 낭독은 나중에 사람이 녹음하므로 길이는 잠정값입니다. 확정 원문은 바꾸지 마세요.
[출력 형식]
{ "schema":"creator.editplan.v1", "clips":[{"sceneId":"S01","durationSec":12,"transition":"fade"}], "notes":"편집 관련 메모" }
transition은 cut, fade, dissolve 중 하나입니다.`;
}
/** Independent provider port: implement adapters without changing the editor UI or project data. */
export interface AIProviderAdapter {
  id: string;
  name: string;
  isConfigured(): Promise<boolean>;
  request(prompt: string, signal?: AbortSignal): Promise<string>;
}
export class ManualProvider implements AIProviderAdapter {
  readonly id='manual'; readonly name='수동 AI JSON 연결';
  async isConfigured():Promise<boolean>{return true;}
  async request():Promise<string>{throw Error('수동 연결 모드: 프롬프트를 복사해 AI에 보낸 뒤 JSON 답변을 붙여넣으세요.');}
}
