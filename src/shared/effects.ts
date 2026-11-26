/**
 * 화면 효과(연출) 모델 — 적은 이미지로도 동영상처럼 보이게 하는 장면 효과.
 *
 * 한 장면 = 이미지(또는 동영상) 1개. 그 안을 여러 "샷"으로 나눠 샷마다
 * 다른 카메라 움직임(확대·축소·이동·초점 당기기)을 준다. 장면에는 분위기 효과(빛줄기·반짝임·안개 등)와
 * 색감, 들어오는 전환(페이드·밀기·원형 열기 등)을 붙인다. 자막은 원문을 줄 단위로 나눠 시간을 배분한다.
 *
 * 모든 필드는 선택(optional)이며, 비어 있으면 normalizeSceneEffects가 장면 순서에 따라
 * 서로 다른 움직임을 자동으로 채운다(기존 작품 하위 호환).
 */
import type { Audience } from './types';

export const MOTION_TYPES = ['static', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'focus_in', 'focus_out', 'drift'] as const;
export type MotionType = typeof MOTION_TYPES[number];
export const MOTION_LABEL: Record<MotionType, string> = {
  static: '고정', zoom_in: '천천히 확대', zoom_out: '천천히 축소', pan_left: '왼쪽으로 이동', pan_right: '오른쪽으로 이동',
  pan_up: '위로 이동', pan_down: '아래로 이동', focus_in: '초점으로 다가가기', focus_out: '초점에서 물러나기', drift: '부드럽게 흐르기'
};

export const OVERLAY_TYPES = ['none', 'light_rays', 'glow', 'sparkle', 'dust', 'petals', 'snow', 'rain', 'fog', 'stars', 'fireflies', 'vignette'] as const;
export type OverlayType = typeof OVERLAY_TYPES[number];
export const OVERLAY_LABEL: Record<OverlayType, string> = {
  none: '없음', light_rays: '빛줄기', glow: '은은한 빛 번짐', sparkle: '반짝임', dust: '떠다니는 먼지빛', petals: '꽃잎 날림',
  snow: '눈', rain: '비', fog: '안개', stars: '별빛 깜박임', fireflies: '반딧불', vignette: '가장자리 어둡게'
};

export const TONE_TYPES = ['none', 'warm', 'cool', 'golden', 'dusk', 'night', 'bright', 'sepia', 'mono'] as const;
export type ToneType = typeof TONE_TYPES[number];
export const TONE_LABEL: Record<ToneType, string> = {
  none: '원본', warm: '따뜻하게', cool: '차분하게', golden: '금빛', dusk: '노을', night: '밤', bright: '밝고 맑게', sepia: '옛 사진', mono: '흑백'
};

export const TRANSITION_TYPES = ['cut', 'fade', 'dissolve', 'fade_black', 'fade_white', 'wipe_left', 'wipe_right', 'slide_left', 'slide_right', 'slide_up', 'zoom', 'circle_open', 'blur'] as const;
export type TransitionType = typeof TRANSITION_TYPES[number];
export const TRANSITION_LABEL: Record<TransitionType, string> = {
  cut: '컷', fade: '부드러운 페이드', dissolve: '디졸브', fade_black: '검게 사라졌다 나타나기', fade_white: '하얗게 밝아지며 전환',
  wipe_left: '왼쪽으로 닦아내기', wipe_right: '오른쪽으로 닦아내기', slide_left: '왼쪽으로 밀기', slide_right: '오른쪽으로 밀기', slide_up: '위로 밀기',
  zoom: '확대하며 전환', circle_open: '원형으로 열기', blur: '흐려지며 전환'
};
/** 편집기가 FFmpeg xfade를 쓸 때 대응하는 이름 */
export const TRANSITION_XFADE: Record<TransitionType, string> = {
  cut: 'none', fade: 'fade', dissolve: 'dissolve', fade_black: 'fadeblack', fade_white: 'fadewhite', wipe_left: 'wipeleft', wipe_right: 'wiperight',
  slide_left: 'slideleft', slide_right: 'slideright', slide_up: 'slideup', zoom: 'zoomin', circle_open: 'circleopen', blur: 'hblur'
};

export interface FocusPoint { x: number; y: number }
/** 한 장면 안의 샷: 같은 미디어에서 다른 움직임 */
export interface Shot {
  durationSec: number;
  motion: MotionType;
  /** 움직임 세기 0.02~0.3 (확대 비율·이동 거리). 기본 0.1 */
  strength: number;
  /** 초점 위치(0~1, 왼쪽 위 기준). focus_in/out·zoom에서 다가갈 곳 */
  focus?: FocusPoint;
  /** 영상 장면에서: 'image' = 기준 이미지 정지 구간, 'video' = 동영상 구간 */
  source?: 'image' | 'video';
  /** 이 샷이 보여 주는 것(한국어 메모, 예: "양의 얼굴로 다가감") */
  note?: string;
}
export interface SceneTransition { type: TransitionType; durationSec: number }
export interface SceneEffects {
  shots?: Shot[];
  overlay?: OverlayType;
  /** 효과 강도 0~1 (기본 0.5) */
  overlayStrength?: number;
  tone?: ToneType;
  /** 이 장면으로 들어올 때의 전환 */
  transitionIn?: SceneTransition;
  /** 자막 줄 (원문 그대로, 순서대로 이어 붙이면 narration) */
  captions?: string[];
}

export const FOCUS_PRESETS: { id: string; label: string; point: FocusPoint }[] = [
  { id: 'center', label: '가운데', point: { x: 0.5, y: 0.5 } },
  { id: 'left', label: '왼쪽', point: { x: 0.3, y: 0.5 } },
  { id: 'right', label: '오른쪽', point: { x: 0.7, y: 0.5 } },
  { id: 'top', label: '위쪽', point: { x: 0.5, y: 0.32 } },
  { id: 'bottom', label: '아래쪽', point: { x: 0.5, y: 0.62 } },
  { id: 'top-left', label: '왼쪽 위', point: { x: 0.3, y: 0.35 } },
  { id: 'top-right', label: '오른쪽 위', point: { x: 0.7, y: 0.35 } },
  { id: 'bottom-left', label: '왼쪽 아래', point: { x: 0.3, y: 0.6 } },
  { id: 'bottom-right', label: '오른쪽 아래', point: { x: 0.7, y: 0.6 } }
];
export function nearestFocusPreset(f?: FocusPoint): string {
  if (!f) return 'center';
  let best = FOCUS_PRESETS[0]; let d = Infinity;
  for (const p of FOCUS_PRESETS) { const dd = (p.point.x - f.x) ** 2 + (p.point.y - f.y) ** 2; if (dd < d) { d = dd; best = p; } }
  return best.id;
}

/** 시청 대상별 자막 읽기 속도(글자/초, 공백 제외) */
export const CHARS_PER_SEC: Record<Audience, number> = { preschool: 3.5, kids: 4.0, teens: 5.0, adult: 5.5, family: 4.5 };
/** 한 자막 줄 권장 최대 글자 수 */
export const CAPTION_MAX: Record<Audience, number> = { preschool: 14, kids: 18, teens: 22, adult: 24, family: 20 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const normText = (t: string) => t.replace(/\s+/g, '').replace(/[“”‘’"'.,!?·…:;]/g, '');

/** 기존 cut/fade/dissolve 외 영문 별칭도 받아 정규화 */
export function parseTransition(v: unknown): TransitionType | null {
  if (oneOf(TRANSITION_TYPES, v)) return v;
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias: Record<string, TransitionType> = {
    none: 'cut', crossfade: 'fade', cross_fade: 'fade', fadeblack: 'fade_black', fade_to_black: 'fade_black', fadewhite: 'fade_white', fade_to_white: 'fade_white',
    wipeleft: 'wipe_left', wiperight: 'wipe_right', slideleft: 'slide_left', slideright: 'slide_right', slideup: 'slide_up', zoomin: 'zoom', zoom_in: 'zoom',
    circleopen: 'circle_open', iris: 'circle_open', hblur: 'blur'
  };
  return alias[k] || null;
}
export function parseMotion(v: unknown): MotionType | null {
  if (oneOf(MOTION_TYPES, v)) return v;
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias: Record<string, MotionType> = {
    none: 'static', still: 'static', push_in: 'zoom_in', ken_burns: 'zoom_in', pull_out: 'zoom_out', zoomin: 'zoom_in', zoomout: 'zoom_out',
    push_to_focus: 'focus_in', pull_from_focus: 'focus_out', tilt_up: 'pan_up', tilt_down: 'pan_down', float: 'drift'
  };
  return alias[k] || null;
}

/**
 * 원문 장면 문장을 자막 줄로 나눈다. 줄바꿈 → 문장부호 → 어절 순으로 끊고, maxChars를 넘지 않게 한다.
 * 글자는 바꾸지 않는다(공백만 정리).
 */
export function splitCaptions(narration: string, maxChars = 18): string[] {
  const pieces = narration.split(/\n+/).map(s => s.trim()).filter(Boolean)
    .flatMap(line => line.split(/(?<=[.!?。…,，;:])\s+/).map(s => s.trim()).filter(Boolean));
  const out = pieces.flatMap(piece => splitLong(piece.split(/\s+/), maxChars));
  return out.length ? out : [narration.trim()];
}
const visibleLen = (s: string) => s.replace(/\s/g, '').length;
/** 연결 어미(…니·…며·…고·…서 등)나 문장부호로 끝나는 어절 뒤는 자연스러운 끊는 자리 */
const NATURAL_BREAK = /([니며고면도여요다라은]|[.,!?…:;])$/;
function splitLong(words: string[], maxChars: number): string[] {
  const whole = words.join(' ');
  const total = visibleLen(whole);
  if (total <= maxChars || words.length < 2) return [whole];
  const target = total / Math.ceil(total / maxChars);
  let best = -1; let bestScore = Infinity; let left = 0;
  for (let k = 1; k < words.length; k++) {
    left += visibleLen(words[k - 1]);
    if (left > maxChars) break;
    const score = Math.abs(left - target) - (NATURAL_BREAK.test(words[k - 1]) ? 3 : 0);
    if (score < bestScore) { bestScore = score; best = k; }
  }
  if (best < 0) best = 1;
  return [words.slice(0, best).join(' '), ...splitLong(words.slice(best), maxChars)];
}

/** 자막 줄들이 원문 장면 문장과 같은 글자인지(공백·문장부호 무시) */
export function captionsMatch(captions: string[], narration: string): boolean {
  return normText(captions.join('')) === normText(narration);
}

/** 장면 순서마다 다른 움직임 패턴 (연속 장면이 같은 움직임이 되지 않도록) */
const AUTO_PATTERNS: { motion: MotionType; focus?: FocusPoint }[][] = [
  [{ motion: 'zoom_in' }, { motion: 'focus_in', focus: { x: 0.5, y: 0.45 } }],
  [{ motion: 'pan_right' }, { motion: 'zoom_out' }],
  [{ motion: 'focus_out', focus: { x: 0.4, y: 0.5 } }, { motion: 'pan_left' }],
  [{ motion: 'pan_up' }, { motion: 'focus_in', focus: { x: 0.6, y: 0.4 } }],
  [{ motion: 'drift' }, { motion: 'zoom_in' }],
  [{ motion: 'pan_left' }, { motion: 'focus_out', focus: { x: 0.55, y: 0.5 } }]
];

/** 장면 길이와 자막 줄 수로 샷을 자동 구성 (이미지 장면 2~3샷, 짧은 장면 1샷) */
export function autoShots(durationSec: number, sceneIndex: number, captionCount = 1, kind: 'image' | 'video' = 'image'): Shot[] {
  if (kind === 'video') return [{ durationSec: round1(durationSec), motion: 'static', strength: 0, source: 'video' }];
  const count = durationSec < 7 ? 1 : durationSec < 14 ? 2 : clamp(Math.max(2, Math.min(captionCount, 3)), 2, 3);
  const pattern = AUTO_PATTERNS[sceneIndex % AUTO_PATTERNS.length];
  const each = durationSec / count;
  return Array.from({ length: count }, (_, i) => {
    const p = i < pattern.length ? pattern[i] : AUTO_PATTERNS[(sceneIndex + i) % AUTO_PATTERNS.length][0];
    return { durationSec: round1(each), motion: p.motion, strength: 0.1, ...(p.focus ? { focus: p.focus } : {}), source: 'image' as const };
  });
}

/** 샷 길이 합을 장면 길이에 맞춘다(비율 유지, 마지막 샷에서 반올림 오차 보정) */
export function fitShots(shots: Shot[], durationSec: number): Shot[] {
  if (!shots.length) return shots;
  const sum = shots.reduce((n, s) => n + s.durationSec, 0) || 1;
  const scaled = shots.map(s => ({ ...s, durationSec: round1(Math.max(0.5, s.durationSec * durationSec / sum)) }));
  const diff = round1(durationSec - scaled.reduce((n, s) => n + s.durationSec, 0));
  scaled[scaled.length - 1].durationSec = round1(Math.max(0.5, scaled[scaled.length - 1].durationSec + diff));
  return scaled;
}

/** AI·사용자 입력(느슨한 JSON)을 Shot으로 정리. 잘못된 값은 버리거나 기본값으로 */
export function parseShots(raw: unknown, kind: 'image' | 'video'): Shot[] {
  if (!Array.isArray(raw)) return [];
  const shots: Shot[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const durationSec = Number(o.durationSec ?? o.duration);
    if (!Number.isFinite(durationSec) || durationSec <= 0) continue;
    const motion = parseMotion(o.motion) || 'zoom_in';
    const strength = Number.isFinite(Number(o.strength)) ? clamp(Number(o.strength), 0, 0.3) : (motion === 'static' ? 0 : 0.1);
    const f = o.focus as Record<string, unknown> | undefined;
    const focus = f && Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y)) ? { x: clamp(Number(f.x), 0, 1), y: clamp(Number(f.y), 0, 1) } : undefined;
    const source = kind === 'video' ? (o.source === 'image' ? 'image' as const : 'video' as const) : 'image' as const;
    shots.push({ durationSec, motion, strength, ...(focus ? { focus } : {}), source, ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim() } : {}) });
  }
  if (kind === 'video' && shots.length && !shots.some(s => s.source === 'video')) shots[shots.length - 1].source = 'video';
  return shots.slice(0, 6);
}

/** 이웃 샷이 같은 움직임이면 다음 샷을 다른 움직임으로 바꿔 단조로움을 피한다 */
function diversify(shots: Shot[], prevLast?: MotionType): Shot[] {
  const alt: MotionType[] = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left', 'focus_in', 'drift'];
  let prev = prevLast;
  return shots.map(s => {
    if (s.source === 'video' || s.motion === 'static') { prev = s.motion; return s; }
    let m: MotionType = s.motion;
    if (m === prev) m = alt.find(a => a !== prev) || m;
    prev = m;
    return m === s.motion ? s : { ...s, motion: m };
  });
}

export interface EffectSceneInput { id: string; narration: string; durationSec: number; kind: 'image' | 'video'; effects?: SceneEffects }

/**
 * 장면 효과를 완성한다. 비어 있는 항목은 자동으로 채우고, 샷 길이를 장면 길이에 맞추고,
 * 자막 줄이 원문과 다르면 원문으로 다시 나눈다.
 */
export function normalizeSceneEffects(scene: EffectSceneInput, index: number, audience: Audience, prevLastMotion?: MotionType): SceneEffects {
  const fx = scene.effects || {};
  const maxChars = CAPTION_MAX[audience] || 18;
  const captions = fx.captions && fx.captions.length && captionsMatch(fx.captions, scene.narration)
    ? fx.captions.map(c => c.trim()).filter(Boolean)
    : splitCaptions(scene.narration, maxChars);
  let shots = fx.shots && fx.shots.length ? fx.shots.map(s => ({ ...s })) : autoShots(scene.durationSec, index, captions.length, scene.kind);
  if (scene.kind === 'image') shots = shots.map(s => ({ ...s, source: 'image' as const }));
  else if (!shots.some(s => s.source === 'video')) shots = [...shots, { durationSec: Math.max(2, scene.durationSec / 2), motion: 'static', strength: 0, source: 'video' }];
  shots = diversify(fitShots(shots, scene.durationSec), prevLastMotion);
  const transitionIn: SceneTransition = fx.transitionIn && oneOf(TRANSITION_TYPES, fx.transitionIn.type)
    ? { type: fx.transitionIn.type, durationSec: clamp(Number(fx.transitionIn.durationSec) || 1, 0, 3) }
    : { type: index === 0 ? 'fade_black' : 'fade', durationSec: index === 0 ? 1.2 : 1.0 };
  if (transitionIn.type === 'cut') transitionIn.durationSec = 0;
  return {
    shots, captions, transitionIn,
    overlay: oneOf(OVERLAY_TYPES, fx.overlay) ? fx.overlay : 'none',
    overlayStrength: clamp(Number.isFinite(Number(fx.overlayStrength)) ? Number(fx.overlayStrength) : 0.5, 0, 1),
    tone: oneOf(TONE_TYPES, fx.tone) ? fx.tone : 'none'
  };
}

/** 느슨한 AI JSON의 장면 효과 필드를 SceneEffects로 (스토리보드 v2) */
export function parseSceneEffects(r: Record<string, unknown>, kind: 'image' | 'video'): SceneEffects {
  const fx: SceneEffects = {};
  const shots = parseShots(r.shots, kind);
  if (shots.length) fx.shots = shots;
  if (oneOf(OVERLAY_TYPES, r.overlay)) fx.overlay = r.overlay;
  if (Number.isFinite(Number(r.overlayStrength))) fx.overlayStrength = clamp(Number(r.overlayStrength), 0, 1);
  if (oneOf(TONE_TYPES, r.tone)) fx.tone = r.tone;
  const t = r.transitionIn as Record<string, unknown> | string | undefined;
  const tType = parseTransition(typeof t === 'object' && t ? t.type : t);
  if (tType) fx.transitionIn = { type: tType, durationSec: clamp(Number(typeof t === 'object' && t ? t.durationSec : NaN) || (tType === 'cut' ? 0 : 1), 0, 3) };
  if (Array.isArray(r.captions)) {
    const caps = r.captions.filter((c): c is string => typeof c === 'string' && !!c.trim()).map(c => c.trim());
    if (caps.length) fx.captions = caps;
  }
  return fx;
}

export interface TimedCaption { start: number; end: number; text: string }
/**
 * 장면 안에서 자막 줄의 시작·끝(장면 시작 기준 초). 글자 수에 비례해 배분하고,
 * 앞 여백(전환 후 0.6초)·줄 사이 쉼(0.4초)·끝 여백(0.6초)을 둔다.
 */
export function timeCaptions(captions: string[], durationSec: number, leadIn = 0.6): TimedCaption[] {
  if (!captions.length) return [];
  const gap = 0.4; const tail = 0.6;
  const usable = Math.max(captions.length * 0.8, durationSec - leadIn - tail - gap * (captions.length - 1));
  const lens = captions.map(c => Math.max(1, c.replace(/\s/g, '').length));
  const total = lens.reduce((a, b) => a + b, 0);
  let t = Math.min(leadIn, durationSec * 0.1);
  return captions.map((text, i) => {
    const d = usable * lens[i] / total;
    const start = round1(t); const end = round1(Math.min(durationSec, t + d));
    t += d + gap;
    return { start, end: Math.max(end, round1(start + 0.5)), text };
  });
}

/** 자막을 다 읽기에 필요한 최소 장면 길이 */
export function minDurationFor(narration: string, audience: Audience): number {
  const chars = narration.replace(/\s/g, '').length;
  return round1(chars / (CHARS_PER_SEC[audience] || 4) + 1.6);
}

/** 사람이 읽기 쉬운 효과 요약 (카드·편집안 표시용) */
export function describeShots(shots: Shot[] | undefined): string {
  if (!shots?.length) return '';
  return shots.map(s => `${s.source === 'video' ? '영상' : MOTION_LABEL[s.motion]} ${s.durationSec}초`).join(' → ');
}

/** AI 프롬프트에 넣는 효과 사전 (영문 id + 한국어 뜻) */
export function effectVocabulary(): string {
  const list = <T extends string>(ids: readonly T[], label: Record<T, string>) => ids.map(id => `${id}(${label[id]})`).join(', ');
  return [
    `motion: ${list(MOTION_TYPES, MOTION_LABEL)}`,
    `overlay: ${list(OVERLAY_TYPES, OVERLAY_LABEL)}`,
    `tone: ${list(TONE_TYPES, TONE_LABEL)}`,
    `transition: ${list(TRANSITION_TYPES, TRANSITION_LABEL)}`
  ].join('\n');
}
