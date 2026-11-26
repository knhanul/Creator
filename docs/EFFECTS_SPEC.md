# 화면 효과 규격 `gomo.effects.v1` — 고모 창작실 → 고모 편집실

고모 창작실이 내보내는 `composer_project.json`(version 2)에 추가된 효과 필드입니다.
목표: **이미지 수는 적게, 화면은 동영상처럼.** 한 장면(이미지 1장)을 여러 *샷*으로 나눠
샷마다 다른 카메라 움직임을 주고, 장면마다 분위기 효과·색감·전환을 다르게 합니다.

편집실이 아직 모르는 필드는 무시해도 영상은 만들어집니다(움직임 없이 이어 붙임).

## 1. 무엇이 달라졌나

| 전 | 후 |
|---|---|
| 장면 1개 = 클립 1개 = 자막 1개 | 장면 1개 = **샷 2~4개(클립 여러 개, 같은 파일)** = **자막 여러 줄** |
| 전환: 컷·페이드·디졸브 | 전환 13종(FFmpeg `xfade` 이름) + 장면별 전환 길이 |
| 움직임 없음 | 샷마다 `motion`·`motion_strength`·`motion_focus` |
| — | 장면별 `overlay`(빛줄기·반짝임·안개…)·`tone`(색감) |
| 영상 장면 = 영상 하나 | 기준 이미지 **정지 샷 → 영상 샷**(기준 이미지가 연결된 경우) |

## 2. 클립 필드

```jsonc
{
  "file": "assets/image/S01.png",
  "type": "image",              // image | video
  "duration": 6.0,              // image: 보여 줄 시간
  "fit_duration": 9.5,          // video: 이 길이에 맞춰 속도 조절
  "mute": true,                 // video: 원음 제거
  "label": "푸른 언덕의 어린 양 (1/2)",
  "scene_id": "S01",            // 같은 장면의 샷은 같은 값
  "shot_index": 0,              // 장면 안 샷 순서
  "motion": "zoom_in",          // 아래 표
  "motion_strength": 0.08,      // 0~0.3
  "motion_focus": { "x": 0.62, "y": 0.45 }, // 0~1, 왼쪽 위 기준 (선택)
  "overlay": "light_rays",      // 아래 표 (없으면 효과 없음)
  "overlay_strength": 0.4,      // 0~1
  "tone": "warm",               // 아래 표 (없으면 원본)
  "transition": { "type": "fadeblack", "duration": 1.2, "effect": "fade_black" }
}
```

`transition`은 **이 클립이 들어올 때**의 전환입니다. 같은 장면 안 샷 사이에는 창작실이
`fade` 0.5초 이하를 넣습니다. `effect`는 창작실 내부 이름(표시용), `type`은 FFmpeg `xfade` 이름입니다.

### motion (이미지 클립)

`s` = motion_strength, 출력 크기 W×H, 클립 진행률 t(0→1, ease-in-out 권장).
기준 배율은 이동 여유를 위해 `1 + s` 이상으로 확대해 두고 잘라 냅니다.

| 값 | 뜻 | 구현 예 |
|---|---|---|
| `static` | 고정 | 배율 1 |
| `zoom_in` | 천천히 확대 | 배율 1 → 1+s, 중심 고정 |
| `zoom_out` | 천천히 축소 | 배율 1+s → 1 |
| `pan_left` / `pan_right` | 좌·우 이동 | 배율 1+s, x를 ±s·W/2 이동 |
| `pan_up` / `pan_down` | 위·아래 이동 | 배율 1+s, y를 ±s·H/2 이동 |
| `focus_in` | 초점으로 다가가기 | 배율 1 → 1+2s, 중심을 화면 중앙 → `motion_focus`로 |
| `focus_out` | 초점에서 물러나기 | `focus_in`의 반대 |
| `drift` | 부드럽게 흐르기 | 배율 1+s, 대각선으로 s·W/3 이동 |

FFmpeg 예(zoom_in, 30fps, 6초, s=0.08):
`zoompan=z='1+0.08*on/180':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=180:s=1920x1080:fps=30`
(떨림을 줄이려면 원본을 4배 정도로 키운 뒤 zoompan 하세요.)

### overlay (화면 위 분위기 효과)

`none · light_rays(빛줄기) · glow(은은한 빛 번짐) · sparkle(반짝임) · dust(떠다니는 먼지빛) · petals(꽃잎) · snow · rain · fog(안개) · stars(별빛 깜박임) · fireflies(반딧불) · vignette(가장자리 어둡게)`

편집실에 효과 영상(투명 배경 또는 screen 합성용 검은 배경 루프)을 두고 `overlay_strength`를 불투명도로
쓰는 방식이 간단합니다. `vignette`는 FFmpeg `vignette`, `glow`는 밝은 부분 blur 후 screen 합성.

### tone (색감)

`none · warm · cool · golden · dusk · night · bright · sepia · mono` — FFmpeg `colorbalance`/`eq`/`colorchannelmixer`
프리셋 정도면 충분합니다(예: warm = 빨강·노랑 +5%, night = 밝기 −15%·파랑 +10%).

### transition.type (FFmpeg xfade)

`none · fade · dissolve · fadeblack · fadewhite · wipeleft · wiperight · slideleft · slideright · slideup · zoomin · circleopen · hblur`

## 3. 자막

`subtitle.items`는 장면 문장을 **원문 글자 그대로** 줄 단위로 나눈 것입니다. 시간은 장면 길이 안에서
글자 수 비례로 배분한 잠정값이며(앞 0.6초·줄 사이 0.4초 쉼), 녹음 후 편집실에서 다시 맞춥니다.

## 4. 시간 계산

클립 `duration` 합 = 장면 길이이고, 장면 시작 시각은 앞 장면 길이의 누적입니다(전환 겹침은 계산에 넣지 않음 —
기존 v2와 같은 방식). 자막 시각도 같은 기준입니다.
