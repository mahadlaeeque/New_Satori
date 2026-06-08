/*
 * SatoriMascot.jsx
 * ----------------------------------------------------------------------------
 * Professional-styled SVG mascot for Satori — TMC's AI Practice avatar.
 *
 * V3 redesign (June 2026):
 *   - Slimmer adult face proportions (taller oval, narrower jaw)
 *   - Sleek long straight hair instead of bowl-cut bangs
 *   - Refined eye anatomy — smaller, almond shape, restrained catchlight
 *   - Thinner straight brows, neutral natural lips, near-invisible blush
 *   - Minimal accent: a small glowing energy dot above the hair + tiny green
 *     stud earrings (replaces the cartoony leaf hair-clip)
 *   - Blazer-style collar with TMC green pin on the lapel
 *
 * States the rest of the app drives:
 *   "idle"       — slow breath, soft closed eyes, faint natural smile
 *   "listening"  — alert almond eyes, accent dot pulses with rings
 *   "thinking"   — closed eyes looking up, accent dot sparkles spin
 *   "speaking"   — mouth opens with audio amplitude (audioLevel prop)
 *   "done"       — transient happy state after end-of-call
 *
 * Web Audio integration unchanged: pass audioLevel (0..1) from a Gemini Live
 * playback AnalyserNode and the mouth + accent halo scale in real time.
 *
 * Author: TMC AI Practice. License: internal.
 */
import React, { useEffect } from "react";

const STYLE_ID = "satori-mascot-keyframes";

// Top-of-head accent pivot — used for ring + spin + micro-sway transforms
const CLIP_X = 100;
const CLIP_Y = 50;

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes satori-breath {
      0%, 100% { transform: translateY(0) scale(1); }
      50%      { transform: translateY(-1.5px) scale(1.012); }
    }
    @keyframes satori-blink {
      0%, 93%, 100% { transform: scaleY(1); }
      97%           { transform: scaleY(0.1); }
    }
    @keyframes satori-clip-pulse {
      0%, 100% { opacity: 0.75; transform: scale(1); }
      50%      { opacity: 1;    transform: scale(1.15); }
    }
    @keyframes satori-ring-expand {
      0%   { opacity: 0.6; transform: scale(0.85); }
      100% { opacity: 0;   transform: scale(1.8); }
    }
    @keyframes satori-think-orbit {
      0%   { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .satori-root         { animation: satori-breath 4.6s ease-in-out infinite; transform-origin: 100px 130px; }
    .satori-eye-blink    { animation: satori-blink 6.5s infinite; transform-origin: center; transform-box: fill-box; }
    .satori-clip-pulse   { animation: satori-clip-pulse 1.4s ease-in-out infinite; transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-ring-1       { animation: satori-ring-expand 2.0s ease-out infinite;             transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-ring-2       { animation: satori-ring-expand 2.0s ease-out infinite 0.5s;        transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-ring-3       { animation: satori-ring-expand 2.0s ease-out infinite 1.0s;        transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-think-spin   { animation: satori-think-orbit 3.0s linear infinite;               transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }

    @keyframes satori-micro-tilt {
      0%, 94%, 100% { transform: rotate(0deg); }
      96%           { transform: rotate(-1.5deg); }
      98%           { transform: rotate(1.5deg); }
    }
    @keyframes satori-micro-sway {
      0%, 90%, 100% { transform: rotate(0deg); }
      93%           { transform: rotate(-3deg); }
      96%           { transform: rotate(3deg); }
    }
    @keyframes satori-done-nod {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      35%      { transform: translateY(2px) rotate(1.5deg); }
      70%      { transform: translateY(0) rotate(-0.8deg); }
    }

    .satori-micro-tilt    { animation: satori-micro-tilt 28s ease-in-out infinite;    transform-origin: 100px 130px; transform-box: view-box; }
    .satori-micro-sway    { animation: satori-micro-sway 22s ease-in-out infinite;    transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-done-nod      { animation: satori-done-nod 0.8s ease-out 1;               transform-origin: 100px 115px; transform-box: view-box; }
  `;
  document.head.appendChild(s);
}

// Palette — refined / muted, not playful
const SKIN        = "#ebccaa";   // neutral peach, slightly muted
const SKIN_SHADE  = "#cda286";   // cheekbone / jaw contour
const SKIN_DEEP   = "#a37854";   // ear inner, nose
const HAIR        = "#1a1816";   // sleek near-black
const HAIR_HI     = "#2e2925";   // subtle sheen
const HAIR_DEEP  = "#0d0c0b";    // hair shadow
const GREEN       = "#8AC441";   // TMC primary — used sparingly
const GREEN_BRT   = "#cdf08a";   // accent glow
const LIP         = "#a4625e";   // natural beige-rose
const LIP_DEEP    = "#5f3833";   // mouth shadow
const LIP_HI      = "#b87874";   // lower lip soft
const LINE        = "#1a1614";   // line-art (warm black)
const BROW        = "#2a1f1c";   // brow color
const BLUSH       = "#c98a78";   // very subtle — listening only

/* -------------------------------------------------------------------------- */
/* Hair — back layer: long, sleek, falls straight down                        */
/* -------------------------------------------------------------------------- */
function HairBack() {
  return (
    <g>
      {/* Left long sleek strand */}
      <path d="M 56,92 Q 38,128 40,178 L 62,182 L 64,150 Q 60,120 64,98 Z" fill={HAIR} />
      {/* Right long sleek strand */}
      <path d="M 144,92 Q 162,128 160,178 L 138,182 L 136,150 Q 140,120 136,98 Z" fill={HAIR} />
      {/* Mid-strand highlights for hair sheen */}
      <path d="M 44,140 L 46,170" stroke={HAIR_HI} strokeWidth="1" opacity="0.5" />
      <path d="M 156,140 L 154,170" stroke={HAIR_HI} strokeWidth="1" opacity="0.5" />
      {/* Hair shadow at neck */}
      <ellipse cx="100" cy="178" rx="22" ry="4" fill={HAIR_DEEP} opacity="0.5" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Face — slimmer adult oval, refined cheekbones, subtle chin                 */
/* -------------------------------------------------------------------------- */
function Face() {
  return (
    <g>
      {/* Neck — narrower */}
      <rect x="91" y="160" width="18" height="22" rx="3" fill={SKIN} />
      <path d="M 91,172 Q 100,176 109,172" fill={SKIN_SHADE} opacity="0.4" />
      {/* Ears — smaller, more refined */}
      <ellipse cx="59" cy="120" rx="4.5" ry="7.5" fill={SKIN} />
      <ellipse cx="59" cy="122" rx="2" ry="3.5" fill={SKIN_DEEP} opacity="0.5" />
      <ellipse cx="141" cy="120" rx="4.5" ry="7.5" fill={SKIN} />
      <ellipse cx="141" cy="122" rx="2" ry="3.5" fill={SKIN_DEEP} opacity="0.5" />
      {/* Earrings — tiny TMC green stud accents */}
      <circle cx="59" cy="127" r="1.4" fill={GREEN} />
      <circle cx="141" cy="127" r="1.4" fill={GREEN} />
      {/* Face oval — narrower (38), longer (54), shifted up slightly */}
      <ellipse cx="100" cy="116" rx="38" ry="54" fill={SKIN} />
      {/* Cheekbone shading (very subtle) */}
      <ellipse cx="66" cy="125" rx="8" ry="22" fill={SKIN_SHADE} opacity="0.18" />
      <ellipse cx="134" cy="125" rx="8" ry="22" fill={SKIN_SHADE} opacity="0.10" />
      {/* Jawline soft shadow */}
      <ellipse cx="100" cy="158" rx="18" ry="5" fill={SKIN_SHADE} opacity="0.22" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Hair — front layer: sleek side-parted style                                */
/* -------------------------------------------------------------------------- */
function HairFront() {
  return (
    <g>
      {/* Crown — smooth dome */}
      <path d="M 62,95 Q 68,55 100,52 Q 132,55 138,95 L 140,108 L 60,108 Z" fill={HAIR} />
      {/* Side-swept bangs over forehead (subtle, professional) */}
      <path d="M 100,68 Q 78,73 64,98 Q 64,108 70,108 Q 92,100 116,94 Q 130,92 140,98 Q 142,80 124,72 Q 110,66 100,68 Z" fill={HAIR} />
      {/* Hair part line / highlight */}
      <path d="M 84,72 Q 100,62 116,72" fill="none" stroke={HAIR_HI} strokeWidth="1" opacity="0.55" />
      {/* Side temple hair */}
      <path d="M 62,98 Q 60,118 64,118 Q 66,108 64,100 Z" fill={HAIR} />
      <path d="M 138,98 Q 140,118 136,118 Q 134,108 136,100 Z" fill={HAIR} />
      {/* Subtle layered strand suggestion */}
      <path d="M 70,108 Q 80,112 92,108" fill="none" stroke={HAIR_HI} strokeWidth="0.7" opacity="0.5" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Eyes — smaller almond shape, restrained expression                         */
/* -------------------------------------------------------------------------- */
function Eyes({ state }) {
  if (state === "thinking") {
    return (
      <g>
        {/* Brows lifted slightly */}
        <path d="M 73,105 Q 84,102 92,104" fill="none" stroke={BROW} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M 108,104 Q 116,102 127,105" fill="none" stroke={BROW} strokeWidth="1.8" strokeLinecap="round" />
        {/* Closed-up almond lashes */}
        <path d="M 74,116 Q 84,112 92,116" fill="none" stroke={LINE} strokeWidth="2" strokeLinecap="round" />
        <path d="M 108,116 Q 116,112 126,116" fill="none" stroke={LINE} strokeWidth="2" strokeLinecap="round" />
      </g>
    );
  }

  if (state === "listening") {
    return (
      <g className="satori-eye-blink">
        {/* Brows — thin, neutral */}
        <path d="M 73,104 Q 84,101 92,103" fill="none" stroke={BROW} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M 108,103 Q 116,101 127,104" fill="none" stroke={BROW} strokeWidth="1.8" strokeLinecap="round" />
        {/* Sclera — smaller almond */}
        <path d="M 75,117 Q 83,112 91,117 Q 83,121 75,117 Z" fill="#ffffff" />
        <path d="M 109,117 Q 117,112 125,117 Q 117,121 109,117 Z" fill="#ffffff" />
        {/* Iris — TMC green */}
        <circle cx="83"  cy="117" r="4.5" fill={GREEN} />
        <circle cx="117" cy="117" r="4.5" fill={GREEN} />
        {/* Iris darker rim */}
        <circle cx="83"  cy="117" r="4.5" fill="none" stroke="#5a7a26" strokeWidth="0.6" />
        <circle cx="117" cy="117" r="4.5" fill="none" stroke="#5a7a26" strokeWidth="0.6" />
        {/* Pupil */}
        <circle cx="83"  cy="117" r="2.2" fill="#141413" />
        <circle cx="117" cy="117" r="2.2" fill="#141413" />
        {/* Single tasteful catchlight */}
        <circle cx="84.5"  cy="115.5" r="1.2" fill="#ffffff" />
        <circle cx="118.5" cy="115.5" r="1.2" fill="#ffffff" />
        {/* Upper lash line (defines eye shape) */}
        <path d="M 75,117 Q 83,112 91,117" fill="none" stroke={LINE} strokeWidth="1.3" strokeLinecap="round" />
        <path d="M 109,117 Q 117,112 125,117" fill="none" stroke={LINE} strokeWidth="1.3" strokeLinecap="round" />
      </g>
    );
  }

  // idle / speaking / done — gentle closed almond eyes
  const lift = state === "speaking" || state === "done" ? -0.5 : 0;
  return (
    <g className="satori-eye-blink">
      {/* Brows — soft, neutral */}
      <path d="M 73,105 Q 84,102 92,104" fill="none" stroke={BROW} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M 108,104 Q 116,102 127,105" fill="none" stroke={BROW} strokeWidth="1.7" strokeLinecap="round" />
      {/* Eye crescents */}
      <path d={`M 75,${118 + lift} Q 83,${122 + lift} 91,${118 + lift}`}
            fill="none" stroke={LINE} strokeWidth="2" strokeLinecap="round" />
      <path d={`M 109,${118 + lift} Q 117,${122 + lift} 125,${118 + lift}`}
            fill="none" stroke={LINE} strokeWidth="2" strokeLinecap="round" />
      {/* Subtle outer lash hints */}
      <path d="M 74,117 L 72,116" stroke={LINE} strokeWidth="1" strokeLinecap="round" opacity="0.7" />
      <path d="M 126,117 L 128,116" stroke={LINE} strokeWidth="1" strokeLinecap="round" opacity="0.7" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Nose — minimal soft hint                                                   */
/* -------------------------------------------------------------------------- */
function Nose() {
  return (
    <g>
      <path d="M 100,128 Q 101,133 100,135 Q 99,134 99.5,132 Z"
            fill={SKIN_DEEP} opacity="0.45" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Mouth — natural, refined; no plump cartoon lips                            */
/* -------------------------------------------------------------------------- */
function Mouth({ state, audioLevel = 0 }) {
  const lvl = Math.max(0, Math.min(1, audioLevel));

  if (state === "speaking" || state === "done") {
    const rx = 4 + lvl * 5;
    const ry = 2.5 + lvl * 3.5;
    return (
      <g>
        {/* Upper lip thin line */}
        <path d="M 92,144 Q 100,142 108,144" fill="none" stroke={LIP_DEEP} strokeWidth="1" strokeLinecap="round" />
        {/* Mouth opening (dark inside) */}
        <ellipse cx="100" cy="146" rx={rx} ry={ry} fill={LIP_DEEP} />
        {/* Inner mouth hint */}
        <ellipse cx="100" cy={146 + ry * 0.2} rx={rx * 0.6} ry={ry * 0.4} fill={LIP} />
        {/* Lower lip — subtle */}
        <path d={`M ${100 - rx - 1},${146 + ry - 0.2} Q 100,${149 + ry * 0.5} ${100 + rx + 1},${146 + ry - 0.2}`}
              fill={LIP_HI} opacity="0.75" />
      </g>
    );
  }
  if (state === "listening") {
    return (
      <g>
        {/* Closed natural mouth, slightly parted */}
        <path d="M 94,144 Q 100,143 106,144" fill="none" stroke={LIP_DEEP} strokeWidth="1.3" strokeLinecap="round" />
        <path d="M 96,146 Q 100,147 104,146" fill="none" stroke={LIP} strokeWidth="0.9" strokeLinecap="round" opacity="0.7" />
      </g>
    );
  }
  if (state === "thinking") {
    return (
      <g>
        {/* Slight asymmetric pursed line */}
        <path d="M 93,145 Q 100,143 107,145" fill="none" stroke={LIP_DEEP} strokeWidth="1.4" strokeLinecap="round" />
      </g>
    );
  }
  // idle — natural neutral expression with a very soft smile
  return (
    <g>
      <path d="M 92,144 Q 100,148 108,144" fill="none" stroke={LIP_DEEP} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M 94,144 Q 100,142 106,144" fill="none" stroke={LIP} strokeWidth="1" strokeLinecap="round" opacity="0.6" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Cheeks — extremely subtle, only visible when listening                     */
/* -------------------------------------------------------------------------- */
function Cheeks({ state }) {
  if (state !== "listening" && state !== "speaking" && state !== "done") return null;
  const op = state === "listening" ? 0.22 : 0.16;
  return (
    <g>
      <ellipse cx="74"  cy="132" rx="5" ry="3" fill={BLUSH} opacity={op} />
      <ellipse cx="126" cy="132" rx="5" ry="3" fill={BLUSH} opacity={op} />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Head accent — minimal glow dot above hair                                  */
/*    Replaces the cartoon hair-clip. Just a small TMC-green AI energy dot    */
/*    that pulses on listening, spins satellites on thinking, glows on speak. */
/* -------------------------------------------------------------------------- */
function HeadAccent({ state, audioLevel = 0 }) {
  const showRings = state === "listening";
  const spin = state === "thinking";
  const isSpeaking = state === "speaking" || state === "done";
  const lvl = Math.max(0, Math.min(1, audioLevel));
  const speakOrbR = isSpeaking ? 3 + lvl * 2 : 3;
  const speakHalo = isSpeaking ? lvl * 0.8 : 0;

  return (
    <g className="satori-micro-sway">
      {showRings && (
        <>
          <circle className="satori-ring-1" cx={CLIP_X} cy={CLIP_Y} r="11" fill="none" stroke={GREEN} strokeWidth="1.1" />
          <circle className="satori-ring-2" cx={CLIP_X} cy={CLIP_Y} r="11" fill="none" stroke={GREEN} strokeWidth="0.9" />
          <circle className="satori-ring-3" cx={CLIP_X} cy={CLIP_Y} r="11" fill="none" stroke={GREEN} strokeWidth="0.7" />
        </>
      )}
      {isSpeaking && (
        <circle cx={CLIP_X} cy={CLIP_Y} r={speakOrbR + 6}
                fill={GREEN_BRT} opacity={speakHalo * 0.4} />
      )}
      <g className={spin ? "satori-think-spin" : ""}>
        {/* Soft outer glow disc */}
        <circle cx={CLIP_X} cy={CLIP_Y} r={speakOrbR + 1.5} fill={GREEN} opacity="0.35" />
        {/* Main accent dot */}
        <circle className={showRings ? "satori-clip-pulse" : ""}
                cx={CLIP_X} cy={CLIP_Y} r={speakOrbR}
                fill={GREEN} />
        {/* Bright center */}
        <circle cx={CLIP_X} cy={CLIP_Y - 0.5} r={Math.max(1, speakOrbR * 0.5)} fill={GREEN_BRT} />
        {spin && (
          <>
            <circle cx={CLIP_X + 9} cy={CLIP_Y} r="1.4" fill={GREEN_BRT} opacity="0.8" />
            <circle cx={CLIP_X - 7} cy={CLIP_Y + 4} r="1.1" fill={GREEN_BRT} opacity="0.6" />
          </>
        )}
      </g>
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Body — blazer with V-neck + TMC green pin on the lapel                     */
/* -------------------------------------------------------------------------- */
function Body() {
  return (
    <g>
      {/* Blazer shoulders */}
      <path d="M 38,184 Q 100,172 162,184 L 168,200 L 32,200 Z" fill="#1a1a18" />
      {/* Inner V-neck (slightly lighter — suggests a shirt under blazer) */}
      <path d="M 88,180 Q 100,196 112,180 L 112,200 L 88,200 Z" fill="#3a3a37" />
      {/* Lapels (slightly darker than blazer) */}
      <path d="M 88,180 L 80,200 L 78,200 L 86,178 Z" fill="#0e0e0d" />
      <path d="M 112,180 L 120,200 L 122,200 L 114,178 Z" fill="#0e0e0d" />
      {/* TMC pin on left lapel */}
      <circle cx="92" cy="190" r="2.6" fill={GREEN} />
      <circle cx="92" cy="190" r="1" fill={GREEN_BRT} />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */
const SatoriMascot = ({
  state = "idle",
  size = 240,
  audioLevel = 0,
  onClick = null,
  ariaLabel = "Satori",
  style = {},
}) => {
  useEffect(() => { ensureKeyframes(); }, []);

  const safeState = ["idle", "listening", "thinking", "speaking", "done"].includes(state)
    ? state
    : "idle";

  const Wrapper = onClick ? "button" : "div";
  const wrapperStyle = {
    background: "transparent",
    border: "none",
    padding: 0,
    margin: 0,
    cursor: onClick ? "pointer" : "default",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 0,
    ...style,
  };

  return (
    <Wrapper type={onClick ? "button" : undefined}
             onClick={onClick || undefined}
             aria-label={ariaLabel}
             style={wrapperStyle}>
      <svg
        className="satori-root"
        viewBox="0 0 200 200"
        width={size}
        height={size}
        role="img"
        aria-label={ariaLabel}
        xmlns="http://www.w3.org/2000/svg"
      >
        <g className={safeState === "done" ? "satori-done-nod" : (safeState === "idle" ? "satori-micro-tilt" : "")}>
          {/* Back layer: long hair, drawn behind everything */}
          <HairBack />
          {/* Face + neck + ears + earrings */}
          <Face />
          {/* Body — drawn before front hair so hair lays naturally over shoulders */}
          <Body />
          {/* Front hair / sleek bangs */}
          <HairFront />
          {/* Minimal AI energy accent above the head */}
          <HeadAccent state={safeState} audioLevel={audioLevel} />
          {/* Facial features */}
          <Eyes state={safeState} />
          <Cheeks state={safeState} />
          <Nose />
          <Mouth state={safeState} audioLevel={audioLevel} />
        </g>
      </svg>
    </Wrapper>
  );
};

export default SatoriMascot;
