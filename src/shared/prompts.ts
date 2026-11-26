import type { AIStage, StudioProject } from './types';
import { AUDIENCES, GENRES } from './workflow';
import { CAPTION_MAX, CHARS_PER_SEC, effectVocabulary } from './effects';

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
/** 효과 연출 원칙 — 적은 이미지로 동영상처럼 보이게 */
const MOTION_PRINCIPLES = `[효과 연출 원칙: 적은 미디어로 동영상처럼]
- 새 이미지를 늘리기보다, 한 이미지 안에서 샷을 2~4개로 나눠 샷마다 다른 카메라 움직임을 줍니다. 예: 넓게 보여 주며 천천히 확대(zoom_in) → 주인공 쪽으로 초점 다가가기(focus_in, focus 좌표) → 오른쪽으로 이동(pan_right).
- 이웃한 샷·이웃한 장면이 같은 움직임이 되지 않게 번갈아 씁니다. 고정(static)은 꼭 필요한 정지 순간에만.
- 움직임 세기(strength)는 0.06~0.15가 자연스럽습니다. 어린이·평온한 장면은 0.06~0.1, 감정이 커지는 장면은 0.12~0.18.
- 분위기 효과(overlay)와 색감(tone)으로 하루의 빛 흐름·정서 변화를 표현합니다(예: 아침 light_rays → 한낮 sparkle → 그늘 fog → 노을 golden/dusk → 밤 stars). 모든 장면에 같은 효과를 넣지 마세요.
- 전환(transitionIn)은 정서가 바뀌는 곳에서만 강하게(fade_black·fade_white·circle_open), 같은 흐름 안에서는 fade·dissolve로 부드럽게. 첫 장면은 fade_black 또는 fade_white.
- 동영상(kind "video")은 작품 전체에서 1~3개, 가장 중요한 움직임이 필요한 장면에만. 동영상 장면도 앞에 기준 이미지 정지 샷(source "image")을 두고 이어서 영상 샷(source "video")을 둘 수 있습니다.
[효과 사전 — id만 사용]
${effectVocabulary()}`;

export function makeAIPrompt(p:StudioProject, stage:AIStage):string {
  const intro=common(p);
  const cps=CHARS_PER_SEC[p.brief.audience]||4; const capMax=CAPTION_MAX[p.brief.audience]||18;
  if(stage==='analysis') return `${intro}

[임무] 작품을 깊이 있게 분석하고, 구분 가능한 화풍 3개와 연출 방향 3개를 제안하세요. 각 id는 영문 짧은 고유 문자열입니다. 특정 텍스트나 이미지를 직접 생성하지 말고 작품 의미를 보존하세요.
- summary: 작품의 화자·듣는 이·중심 이미지가 드러나는 한두 문장.
- emotionArc: 원문 순서대로 정서가 어떻게 흘러가는지 4~7단계(예: "고백(밝고 단단함)", "쉼(가장 평온)", "그늘(두렵지 않음)").
- styles: 각 description에 붓질·질감·색·빛을 구체적으로, 그리고 이 작품에 맞는 이유를 한 문장.
- directions: 각 description에 중심 연출 아이디어, 카메라 움직임·효과·전환의 리듬(예: "느린 확대와 좌우 이동을 번갈아, 정서 전환에서만 하얗게 밝아지는 전환"), 장점과 주의점.
- visualBible: 첫 번째 화풍 기준의 스타일 바이블. styleSentence(이미지 생성에 그대로 붙일 영어 화풍 문장), palette(색 이름과 HEX 4~6개), lighting(장면 흐름에 따른 빛·시간대 변화), character(주인공이 있다면 모든 장면에서 같은 모습이 되도록 영어로 고정 묘사, 없으면 빈 문자열), avoid(금지 요소 영어 목록), motionStyle(이 작품에 맞는 움직임·효과 원칙 한국어 한두 문장).
- cautions: 영상화할 때 주의할 점(시대·지리 고증, 대상 연령, 종교적 표현 등) 3~6개.
[출력 형식 정확히]
{ "schema":"creator.analysis.v1", "summary":"작품 요약", "emotion":"핵심 정서", "emotionArc":["단계(정서)"], "keywords":["키워드"], "styles":[{"id":"watercolor","label":"따뜻한 수채화","description":"묘사"}], "directions":[{"id":"gentle","label":"잔잔한 서정","description":"묘사"}], "visualBible":{"styleSentence":"English style sentence","palette":["paper cream #F6F1E6"],"lighting":"빛 흐름","character":"English fixed character description","avoid":["text","watermark"],"motionStyle":"움직임 원칙"}, "cautions":["주의점"] }
styles/directions는 각각 3개, keywords는 3~6개로 작성하세요.`;
  if(stage==='storyboard') { const style=p.analysis?.styles.find(x=>x.id===p.selection.styleId),direction=p.analysis?.directions.find(x=>x.id===p.selection.directionId); const bible=p.analysis?.visualBible; return `${intro}
선택한 화풍: ${style?.label||'미선택'} — ${style?.description||''}
선택한 연출 방향: ${direction?.label||'미선택'} — ${direction?.description||''}
${p.analysis?.emotionArc?.length?`정서 흐름: ${p.analysis.emotionArc.join(' → ')}\n`:''}${bible?.motionStyle?`움직임 원칙: ${bible.motionStyle}\n`:''}${bible?.lighting?`빛 흐름: ${bible.lighting}\n`:''}
[임무] 원문을 순서대로 누락 없이 낭독할 수 있도록 장면으로 나누고, 장면마다 화면 효과까지 설계한 스토리보드를 만드세요.
- 장면 하나 = 새로 만들 이미지(또는 동영상) 하나입니다. 목표 길이 ${p.brief.targetDuration}초 기준 4~10개 장면이 적당하며, 그림이 바뀌어야 할 곳에서만 장면을 나눕니다.
- narration: 그 장면에서 실제 읽을 원문 문장을 글자 그대로(절 번호 제외). 장면 narration을 이어 붙이면 원문 전체가 되어야 합니다.
- captions: narration을 자막 줄로 나눈 배열. 글자를 바꾸지 말고 의미 단위로 끊어 한 줄 ${capMax}자 안팎. 이어 붙이면 narration과 같아야 합니다.
- durationSec: 자막을 초당 ${cps}자로 읽는 시간 + 앞뒤 여백 2~3초. 정서가 큰 장면은 여유 있게.
- visual: 화면 구성(무엇이 어디에, 빛·시간대). 카메라가 다가갈 초점 대상의 위치를 밝혀 주세요.
- mood: 이 장면의 정서 한 줄.
- shots: 이 장면 안의 샷 목록. 각 샷 {durationSec, motion, strength, focus:{x,y}(0~1, 선택), source("image"|"video"), note(무엇을 보여 주는지)}. durationSec 합 = 장면 durationSec.
- overlay / overlayStrength(0~1) / tone: 장면 분위기 효과와 색감.
- transitionIn: {type, durationSec} 이 장면으로 들어오는 전환.
${MOTION_PRINCIPLES}
[출력 형식]
{ "schema":"creator.storyboard.v2", "scenes":[{"id":"S01","title":"장면 제목","narration":"원문 그대로","captions":["원문 줄1","원문 줄2"],"visual":"화면 구성","mood":"정서","durationSec":12,"kind":"image","shots":[{"durationSec":6,"motion":"zoom_in","strength":0.08,"note":"전체 풍경"},{"durationSec":6,"motion":"focus_in","strength":0.12,"focus":{"x":0.62,"y":0.45},"note":"주인공에게 다가감"}],"overlay":"light_rays","overlayStrength":0.4,"tone":"warm","transitionIn":{"type":"fade_black","durationSec":1.2}}] }`; }
  if(stage==='prompt') { const bible=p.analysis?.visualBible; return `${intro}
선택 화풍: ${p.analysis?.styles.find(x=>x.id===p.selection.styleId)?.label||''}
${bible?`스타일 바이블(JSON, 모든 프롬프트에 반영): ${JSON.stringify(bible)}\n`:''}승인 장면표(JSON): ${JSON.stringify(p.scenes.map(({id,title,narration,visual,kind,mood,effects})=>({id,title,narration,visual,kind,mood,shots:effects?.shots?.map(s=>({motion:s.motion,focus:s.focus,source:s.source,note:s.note})),overlay:effects?.overlay,tone:effects?.tone})))}
[임무] 각 장면별로 이미지 생성 영어 프롬프트와 (가능한 경우) 짧은 동영상 영어 프롬프트를 만드세요. kind가 "video"인 장면은 videoPrompt를 반드시 채우세요. 영상 동작은 하나씩, 카메라 움직임은 느리게, 화면의 텍스트를 금지합니다.
- 일관성: 모든 imagePrompt 앞에 스타일 바이블의 styleSentence를, 주인공이 나오면 character 묘사를 그대로 반복해 넣으세요. 시대·지리 고증과 장면의 빛·시간대를 구체적으로.
- 움직임을 위한 구도: 편집기에서 확대·이동·초점 다가가기를 하므로 넓은 구도(wide or medium-wide)로, 주요 대상은 가장자리에서 떨어뜨리고, 샷의 focus 좌표 근처에 다가갈 대상(주인공·소품)을 또렷하게 배치하세요. 화면 아래 약 25%는 자막이 올라가도록 단순하고 낮은 대비로 비워 두세요.
- overlay 효과(빛줄기·반짝임·안개 등)는 편집기가 얹으므로 이미지에 과하게 그리지 말고, 같은 방향의 빛만 은은히.
- negativePrompt: 스타일 바이블의 avoid와 장면별 금지 요소.
- 배경음악은 무보컬, 기존 저작물 모방 금지. 정서 흐름에 따라 어디서 낮아지고 밝아지는지 묘사하세요.
[출력 형식]
{ "schema":"creator.prompts.v1", "items":[{"sceneId":"S01","imagePrompt":"English prompt","videoPrompt":"English prompt","negativePrompt":"English negatives"}], "bgmPrompt":"English instrumental music prompt" }
items는 장면 수와 동일해야 하고 모든 sceneId가 정확히 한 번 나타나야 합니다.`; }
  return `${intro}
사용 가능한 미디어 인벤토리(JSON): ${JSON.stringify(p.scenes.map(s=>({sceneId:s.id,media:p.assets.find(a=>a.id===s.assetId)?.name||null,kind:s.kind,durationSec:s.durationSec,narration:s.narration,mood:s.mood,transitionIn:s.effects?.transitionIn})))}
[임무] 실제 확보된 파일을 고려해 최종 타임라인 순서/길이/전환을 설계하세요. 확보되지 않은 미디어를 있다고 가정하지 마세요. 낭독은 나중에 사람이 녹음하므로 길이는 잠정값입니다(대상 기준 초당 ${cps}자). 확정 원문은 바꾸지 마세요. 장면 안의 샷 움직임은 스토리보드 설계를 따르므로 여기서는 장면 단위 길이와 전환만 정합니다.
- 정서가 바뀌는 경계에는 조금 긴 전환(1.2~1.8초)과 fade_black·fade_white·circle_open 같은 뚜렷한 전환을, 같은 흐름 안에서는 fade·dissolve 0.6~1.0초를 씁니다. 모든 클립에 같은 전환을 쓰지 마세요.
[출력 형식]
{ "schema":"creator.editplan.v1", "clips":[{"sceneId":"S01","durationSec":12,"transition":"fade_black","transitionSec":1.2}], "notes":"편집 관련 메모" }
transition은 ${'cut, fade, dissolve, fade_black, fade_white, wipe_left, wipe_right, slide_left, slide_right, slide_up, zoom, circle_open, blur'} 중 하나입니다.`;
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
