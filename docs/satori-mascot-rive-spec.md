# Satori Mascot — Rive Artist Specification

Author: TMC AI Practice
Status: ready for Rive artist (v2 upgrade — replaces the SVG version at `frontend/src/components/SatoriMascot.jsx`)
Target deliverable: a single `satori.riv` file, ~50–250 KB, exported from Rive Editor

---

## Goal

Build a Rive interactive character file that drops into the existing
`<SatoriMascot>` React component as a 1:1 swap for the current animated
SVG. Same prop interface, same callsites, same behaviour — just with
bone-rigged motion, real viseme lip-sync, and idle micro-movements.

## Character — design reference

The character was designed in SVG and is committed at
`frontend/src/components/SatoriMascot.jsx`. Use that file as the
character sheet. Key visual elements:

- **Head shell** — rounded-square, dark charcoal (`#2a2a28`), border
  `#3b3b39`, 116×108 viewBox units.
- **Face screen** — inset darker panel (`#141413`), 92×84.
- **Hair / side wings** — black charcoal pieces curling down from the
  top corners of the head. Tipped with TMC green (`#8AC441`) glow
  circles.
- **Antenna** — thin metal stem with a TMC-green orb on top
  (`#8AC441` outer, `#cdf08a` inner highlight).
- **Eyes** — TMC green (`#8AC441`) with brighter green pupils
  (`#cdf08a`). State-dependent shape (see state matrix below).
- **Cheek blush dots** — small green semi-transparent circles below
  the eyes (`#8AC441` at 50–85% opacity).
- **Mouth** — TMC green with brighter inner. Shape changes per state.
- **Body collar** — short trapezoid below the head, dark charcoal,
  with a small green square emblem ("s" letter) centred.

Palette:

| Token  | Hex      | Use                                  |
| ------ | -------- | ------------------------------------ |
| GREEN  | `#8AC441`| Eyes, mouth, accents, antenna orb    |
| PUPIL  | `#cdf08a`| Eye highlights, inner mouth, sparkle |
| DARK   | `#2a2a28`| Head shell, body collar, hair        |
| SCREEN | `#141413`| Face screen, mouth interior dot      |
| BORDER | `#3b3b39`| Head outline                         |

Personality: **warm-professional**, leans feminine but stylized.
Gender presentation should feel like a friendly AI assistant
character — not anime-cute, not corporate-cold. The SVG version
strikes the right balance; match that vibe.

## Artboard + scale

- Artboard size: **200 × 200** Rive units (matches the current SVG
  viewBox; React renders it at sizes from `56px` floating-corner up to
  `260px` voice-modal centred).
- Character should be centred around `(100, 100)` and fill the
  artboard with about 8 px of padding on every side.
- Origin (0,0) is **top-left**, Y increases downward (standard Rive).
- The wrapper `<button>` already provides the click target — no
  built-in hit detection needed inside the Rive file.

## State machine — required inputs

Create **one State Machine** named **`SatoriStateMachine`** with the
following inputs (these are the contract the React side will set):

### Boolean inputs (one-hot — only one is `true` at a time)

| Name         | Default | Description                                   |
| ------------ | ------- | --------------------------------------------- |
| `isIdle`     | `true`  | Slow breath, soft closed eyes, gentle smile   |
| `isListening`| `false` | Wide alert eyes, antenna pulses + rings       |
| `isThinking` | `false` | Closed eyes tilted up, antenna spinning glow  |
| `isSpeaking` | `false` | Smiling eyes, mouth opens (drive by `audioLevel`) |
| `isDone`     | `false` | Transient happy smile after end-of-call       |

### Number inputs

| Name         | Range   | Description                                     |
| ------------ | ------- | ----------------------------------------------- |
| `audioLevel` | 0.0–1.0 | RMS amplitude of TTS audio. Drives mouth scale during `isSpeaking`. |

### Trigger inputs

| Name     | Effect                                                        |
| -------- | ------------------------------------------------------------- |
| `blink`  | Force a one-shot eye blink (we'll auto-trigger every ~5s)    |
| `wave`   | Acknowledge wave at end of call (optional polish)             |

## State matrix — visual behaviour per state

### `isIdle` (default)

- Breathing animation on the whole character — gentle Y translate
  (-2 px → 0 → -2 px) + scale (1.0 → 1.015 → 1.0), 4.2 s cycle.
- Eyes: closed-crescent smile shape, `#8AC441` stroke width 2.5.
- Mouth: small soft smile arc.
- Antenna: orb static at base brightness, no rings.
- Cheek blush: 50% opacity.

### `isListening`

- Eyes: **wide open** ovals (rx=6, ry=8 ellipses), `#8AC441` fill
  with `#cdf08a` pupil inset.
- Eyelashes: 3 tiny strokes above each eye (left-edge, centre,
  right-edge), `#8AC441`, 1.2 px width.
- Mouth: small attentive `o` — circle outline rx=3, no fill.
- Antenna: orb grows from r=7 to r=9, brighter `#cdf08a` core,
  **three pulse rings** expanding outward (r=14 → r=24, opacity 0.7
  → 0, 1.8s cycle, staggered by 0.45 s).
- Cheek blush: 85% opacity.

### `isThinking`

- Eyes: closed crescents but **tilted upward** (apex 5 px higher),
  giving "looking up" feel.
- Mouth: thin horizontal line (concentrating).
- Antenna: orb spins slowly around its base (2.6 s/rev), with two
  satellite dots (`#cdf08a` r=2 and r=1.5) orbiting.
- Cheek blush: 50%.

### `isSpeaking`

- Eyes: happy closed crescents, same as `isDone` (eyes folded).
- Mouth: **scales with `audioLevel` input**.
  - At `audioLevel = 0`: ellipse rx=8, ry=5.
  - At `audioLevel = 1`: ellipse rx=15, ry=10.
  - Linear interpolation between.
  - Inner highlight ellipse scales proportionally (rx=0.6×outer).
  - Tiny dark dot at (100, 133) inside the mouth (rx=0.3× outer).
- Speech-wave arcs: 4 small curves (2 left, 2 right) emerging from
  mouth, opacity tied to `audioLevel` (0.4 baseline → 0.8 at full).
- Cheek blush: 80% opacity.

### `isDone`

- Same as `isSpeaking` but with `audioLevel` = 0 (closed mouth, happy
  eyes). Optional `wave` trigger plays a small head-tilt + cheek
  brighten flash.

## Animations to build (one per state, plus shared)

1. **`Idle`** — looping breath (4.2s)
2. **`Listening`** — looping antenna pulse + ring expansion (1.8s)
3. **`Thinking`** — looping antenna orbit (2.6s)
4. **`Speaking`** — listens to `audioLevel` continuously; idle posture
   loops underneath
5. **`Done`** — short 0.8s acknowledgement, then returns to `Idle`
6. **`Blink`** — 0.2s one-shot, eye-Y scale 1→0.1→1
7. **`Wave`** (optional) — 0.6s one-shot head tilt + cheek flash

## Transitions in the State Machine

- `isIdle → isListening` — 200 ms fade
- `isIdle → isThinking` — 200 ms fade
- Any state → `isSpeaking` — 100 ms fade (snappy)
- `isSpeaking → isIdle` — 300 ms fade
- `isDone` auto-transitions to `isIdle` after 800 ms

## Bones / rigging (recommended)

Even though the design is stylised, a simple bone rig makes the
character feel alive:

- `root` — controls overall breath translate/scale
- `head` — pivot at (100, 105), allows slight tilts during thinking +
  wave
- `antenna` — child of head, pivot at (100, 50), allows rotation for
  thinking + slight sway on idle
- `left_eye`, `right_eye` — pivots at (79, 98) and (121, 98); used
  for blink scale
- `mouth` — pivot at (100, 132); scaled by `audioLevel` during
  speaking

Hair wings and body collar can stay static (no rig needed) unless
you want to add a tiny sway loop.

## Export checklist

- File format: `.riv` (Rive runtime format, not the `.rev` editor
  file)
- Compress: yes
- Include: only the artboard + state machine described above (don't
  ship unused artboards)
- Filename: `satori.riv`
- Drop the file into: `frontend/src/assets/satori.riv`

## How the React side will use it

When `satori.riv` is in place, the engineer (me) will:

1. `npm install @rive-app/react-canvas`
2. Add a `useRive` block inside `SatoriMascot.jsx`:

```jsx
import { useRive, useStateMachineInput } from "@rive-app/react-canvas";
import satoriRive from "../assets/satori.riv";

const { RiveComponent, rive } = useRive({
  src: satoriRive,
  stateMachines: "SatoriStateMachine",
  autoplay: true,
});
const isIdleInput      = useStateMachineInput(rive, "SatoriStateMachine", "isIdle");
const isListeningInput = useStateMachineInput(rive, "SatoriStateMachine", "isListening");
const isThinkingInput  = useStateMachineInput(rive, "SatoriStateMachine", "isThinking");
const isSpeakingInput  = useStateMachineInput(rive, "SatoriStateMachine", "isSpeaking");
const isDoneInput      = useStateMachineInput(rive, "SatoriStateMachine", "isDone");
const audioLevelInput  = useStateMachineInput(rive, "SatoriStateMachine", "audioLevel");
```

3. On every prop change, set the matching boolean input to `true` and
   all others to `false`, plus set `audioLevelInput.value = audioLevel`.
4. The existing prop interface (`state`, `audioLevel`, `size`,
   `onClick`, `ariaLabel`) stays identical — no callsite changes
   needed.

## QA before delivery

Please verify in Rive Editor's preview:

1. Toggle `isListening = true` → eyes go wide, antenna shows 3
   expanding rings.
2. Set `isSpeaking = true`, then slide `audioLevel` from 0 → 1 →
   the mouth ellipse smoothly grows.
3. Toggle `isThinking = true` → antenna orb visibly orbits its base.
4. Hit `blink` trigger 3× rapidly → eyes blink each time, no jam.
5. The character renders cleanly at sizes 56 px, 100 px, and 260 px
   (no visible aliasing or off-by-one pixel artefacts).

## Open questions for the artist

- Do we want any micro-movement during `isIdle` beyond breath? (e.g.,
  a subtle 5° antenna sway or occasional ear-twitch) — your call,
  keep it small.
- The cheek blush — would a faint pulse (opacity 50 ↔ 70%) feel
  alive without being distracting? Up to you.
- Mouth shape vocabulary — we can start with one shape that scales,
  but if you want to add 2-3 viseme variants ("ah", "ee", "oh"), the
  React side can pass them as additional triggers driven by an
  amplitude-to-phoneme heuristic. Not required for v1.

## Budget + timing reference

Typical Rive artist on Upwork / Fiverr: $200–500 for a project of
this size, 5–7 working days. Recommend looking for someone with at
least one published character-state-machine sample in their
portfolio.

## Contact

Questions on the spec: ping the TMC AI Practice team.
The current SVG version at `frontend/src/components/SatoriMascot.jsx`
is the visual ground truth — when in doubt, match the SVG.
