/*
 * SatoriMascot.jsx
 * ----------------------------------------------------------------------------
 * Human-styled SVG version of Satori — TMC's AI Practice mascot.
 *
 * V2 redesign:
 *   - Soft peach face shape (no longer a robot screen)
 *   - Real eye anatomy: sclera + green iris + dark pupil + catchlight
 *   - Eyebrows + lip-shaped mouth + cheek blush
 *   - Dark hair silhouette with TMC-green tips
 *   - Green leaf hair-clip on top of head (replaces the antenna,
 *     keeps all the same state-animation hooks)
 *
 * States the rest of the app drives:
 *   "idle"       — slow breath, soft closed eyes, gentle smile
 *   "listening"  — wide alert eyes, hair-clip pulses with rings
 *   "thinking"   — closed eyes looking up, hair-clip sparkles spin
 *   "speaking"   — smiling eyes, mouth opens with audio amplitude (audioLevel)
 *   "done"       — transient happy face after end-of-call
 *
 * Web Audio integration: pass audioLevel (0..1) computed from a Gemini Live
 * playback AnalyserNode and the mouth + halo scale in real time during "speaking".
 *
 * Author: TMC AI Practice. License: internal.
 */
import React, { useEffect } from "react";

const STYLE_ID = "satori-mascot-keyframes";

// Hair-clip pivot — used for ring + spin + micro-sway transform origins
const CLIP_X = 100;
const CLIP_Y = 48;

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes satori-breath {
      0%, 100% { transform: translateY(0) scale(1); }
      50%      { transform: translateY(-2px) scale(1.015); }
    }
    @keyframes satori-blink {
      0%, 92%, 100% { transform: scaleY(1); }
      96%           { transform: scaleY(0.1); }
    }
    @keyframes satori-clip-pulse {
      0%, 100% { opacity: 0.7; transform: scale(1); }
      50%      { opacity: 1;   transform: scale(1.12); }
    }
    @keyframes satori-ring-expand {
      0%   { opacity: 0.7; transform: scale(0.85); }
      100% { opacity: 0;   transform: scale(1.7); }
    }
    @keyframes satori-think-orbit {
      0%   { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes satori-mouth-wiggle {
      0%, 100% { transform: scale(1, 1); }
      50%      { transform: scale(1.05, 0.95); }
    }

    .satori-root         { animation: satori-breath 4.2s ease-in-out infinite; transform-origin: 100px 120px; }
    .satori-eye-blink    { animation: satori-blink 5.5s infinite; transform-origin: center; transform-box: fill-box; }
    .satori-clip-pulse   { animation: satori-clip-pulse 1.4s ease-in-out infinite; transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-ring-1       { animation: satori-ring-expand 1.8s ease-out infinite;             transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-ring-2       { animation: satori-ring-expand 1.8s ease-out infinite 0.45s;       transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-ring-3       { animation: satori-ring-expand 1.8s ease-out infinite 0.9s;        transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-think-spin   { animation: satori-think-orbit 2.6s linear infinite;               transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-mouth-wiggle { animation: satori-mouth-wiggle 0.18s ease-in-out infinite;        transform-origin: 100px 139px; transform-box: view-box; }

    @keyframes satori-micro-tilt {
      0%, 92%, 100% { transform: rotate(0deg); }
      94%           { transform: rotate(-2deg); }
      96%           { transform: rotate(2deg); }
      98%           { transform: rotate(0deg); }
    }
    @keyframes satori-micro-sway {
      0%, 88%, 100% { transform: rotate(0deg); }
      91%           { transform: rotate(-5deg); }
      94%           { transform: rotate(5deg); }
      97%           { transform: rotate(0deg); }
    }
    @keyframes satori-done-nod {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      35%      { transform: translateY(3px) rotate(2deg); }
      70%      { transform: translateY(0) rotate(-1deg); }
    }

    .satori-micro-tilt    { animation: satori-micro-tilt 24s ease-in-out infinite;    transform-origin: 100px 130px; transform-box: view-box; }
    .satori-micro-sway    { animation: satori-micro-sway 18s ease-in-out infinite;    transform-origin: ${CLIP_X}px ${CLIP_Y}px; transform-box: view-box; }
    .satori-done-nod      { animation: satori-done-nod 0.8s ease-out 1;               transform-origin: 100px 110px; transform-box: view-box; }
  `;
  document.head.appendChild(s);
}

const SKIN        = "#f6cfa6";
const SKIN_SHADE  = "#e8b48a";
const SKIN_DEEP   = "#cc8e5e";
const HAIR        = "#1d1c1a";
const HAIR_HI     = "#3a3733";
const GREEN       = "#8AC441";
const GREEN_BRT   = "#cdf08a";
const LIP         = "#c25c5c";
const LIP_DEEP    = "#8a3a3a";
const LIP_HI      = "#e69191";
const LINE        = "#2a2421";
const BROW        = "#2b2422";
const BLUSH       = "#ee9c8a";

function HairBack() {
  return (
    <g>
      <path d="M 50,90 Q 30,120 32,170 Q 36,182 50,185 L 60,180 L 60,140 Q 58,115 64,98 Z" fill={HAIR} />
      <path d="M 150,90 Q 170,120 168,170 Q 164,182 150,185 L 140,180 L 140,140 Q 142,115 136,98 Z" fill={HAIR} />
      <path d="M 36,150 Q 40,160 38,175" fill="none" stroke={HAIR_HI} strokeWidth="1.5" opacity="0.5" />
      <path d="M 164,150 Q 160,160 162,175" fill="none" stroke={HAIR_HI} strokeWidth="1.5" opacity="0.5" />
      <path d="M 34,178 Q 42,186 50,180" fill={GREEN} opacity="0.85" />
      <path d="M 166,178 Q 158,186 150,180" fill={GREEN} opacity="0.85" />
    </g>
  );
}

function Face() {
  return (
    <g>
      <rect x="88" y="158" width="24" height="20" rx="6" fill={SKIN} />
      <path d="M 88,170 Q 100,176 112,170" fill={SKIN_SHADE} opacity="0.5" />
      <ellipse cx="56" cy="118" rx="6" ry="9" fill={SKIN} />
      <ellipse cx="56" cy="120" rx="2.5" ry="4" fill={SKIN_DEEP} opacity="0.6" />
      <ellipse cx="144" cy="118" rx="6" ry="9" fill={SKIN} />
      <ellipse cx="144" cy="120" rx="2.5" ry="4" fill={SKIN_DEEP} opacity="0.6" />
      <ellipse cx="100" cy="118" rx="44" ry="52" fill={SKIN} />
      <ellipse cx="62" cy="120" rx="10" ry="44" fill={SKIN_SHADE} opacity="0.35" />
      <ellipse cx="138" cy="120" rx="10" ry="44" fill={SKIN_SHADE} opacity="0.18" />
      <ellipse cx="100" cy="158" rx="14" ry="5" fill={SKIN_SHADE} opacity="0.3" />
    </g>
  );
}

function HairFront() {
  return (
    <g>
      <path d="M 56,90 Q 62,58 100,52 Q 138,58 144,90 Q 148,102 144,108 L 56,108 Q 52,102 56,90 Z" fill={HAIR} />
      <path d="M 100,72 Q 80,80 64,98 Q 60,104 64,108 Q 88,98 108,92 Q 122,86 138,90 Q 142,82 130,76 Q 116,68 100,72 Z" fill={HAIR} />
      <path d="M 60,98 Q 56,110 60,128 Q 64,116 64,108 Z" fill={HAIR} />
      <path d="M 140,98 Q 144,110 140,128 Q 136,116 136,108 Z" fill={HAIR} />
      <path d="M 78,82 Q 92,75 110,76" fill="none" stroke={HAIR_HI} strokeWidth="1.2" opacity="0.55" />
      <path d="M 120,82 Q 130,84 138,90" fill="none" stroke={HAIR_HI} strokeWidth="1.2" opacity="0.45" />
    </g>
  );
}

function Eyes({ state }) {
  if (state === "thinking") {
    return (
      <g>
        <path d="M 70,100 Q 82,95 92,99" fill="none" stroke={BROW} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M 108,99 Q 118,95 130,100" fill="none" stroke={BROW} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M 72,114 Q 82,108 92,114" fill="none" stroke={LINE} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M 108,114 Q 118,108 128,114" fill="none" stroke={LINE} strokeWidth="2.4" strokeLinecap="round" />
      </g>
    );
  }

  if (state === "listening") {
    return (
      <g className="satori-eye-blink">
        <path d="M 70,96 Q 82,92 92,96" fill="none" stroke={BROW} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M 108,96 Q 118,92 130,96" fill="none" stroke={BROW} strokeWidth="2.4" strokeLinecap="round" />
        <ellipse cx="82"  cy="116" rx="8.5" ry="9" fill="#ffffff" />
        <ellipse cx="118" cy="116" rx="8.5" ry="9" fill="#ffffff" />
        <circle cx="82"  cy="117" r="6.2" fill={GREEN} />
        <circle cx="118" cy="117" r="6.2" fill={GREEN} />
        <circle cx="82"  cy="117" r="6.2" fill="none" stroke="#587a26" strokeWidth="0.7" />
        <circle cx="118" cy="117" r="6.2" fill="none" stroke="#587a26" strokeWidth="0.7" />
        <circle cx="82"  cy="117" r="3.5" fill={GREEN_BRT} opacity="0.5" />
        <circle cx="118" cy="117" r="3.5" fill={GREEN_BRT} opacity="0.5" />
        <circle cx="82"  cy="117" r="2.8" fill="#141413" />
        <circle cx="118" cy="117" r="2.8" fill="#141413" />
        <circle cx="84"  cy="114.5" r="1.8" fill="#ffffff" />
        <circle cx="120" cy="114.5" r="1.8" fill="#ffffff" />
        <circle cx="79.5" cy="119" r="0.8" fill="#ffffff" opacity="0.85" />
        <circle cx="115.5" cy="119" r="0.8" fill="#ffffff" opacity="0.85" />
        <path d="M 73,110 Q 82,106 91,110" fill="none" stroke={LINE} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M 109,110 Q 118,106 127,110" fill="none" stroke={LINE} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M 91,109 L 94,107" stroke={LINE} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 109,109 L 106,107" stroke={LINE} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 73,109 L 70,107" stroke={LINE} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 127,109 L 130,107" stroke={LINE} strokeWidth="1.2" strokeLinecap="round" />
      </g>
    );
  }

  const liftSpeaking = state === "speaking" || state === "done" ? -1 : 0;
  return (
    <g className="satori-eye-blink">
      <path d="M 70,99 Q 82,95 92,99" fill="none" stroke={BROW} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M 108,99 Q 118,95 130,99" fill="none" stroke={BROW} strokeWidth="2.2" strokeLinecap="round" />
      <path d={`M 72,${118 + liftSpeaking} Q 82,${125 + liftSpeaking} 92,${118 + liftSpeaking}`}
            fill="none" stroke={LINE} strokeWidth="2.6" strokeLinecap="round" />
      <path d={`M 108,${118 + liftSpeaking} Q 118,${125 + liftSpeaking} 128,${118 + liftSpeaking}`}
            fill="none" stroke={LINE} strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="71" cy="117" r="0.9" fill={LINE} />
      <circle cx="93" cy="117" r="0.9" fill={LINE} />
      <circle cx="107" cy="117" r="0.9" fill={LINE} />
      <circle cx="129" cy="117" r="0.9" fill={LINE} />
    </g>
  );
}

function Nose() {
  return (
    <g>
      <path d="M 100,128 Q 102,134 100,136 Q 98,135 99,132 Z" fill={SKIN_DEEP} opacity="0.55" />
      <ellipse cx="99" cy="135" rx="0.8" ry="0.4" fill={SKIN_DEEP} opacity="0.7" />
      <ellipse cx="101" cy="135" rx="0.8" ry="0.4" fill={SKIN_DEEP} opacity="0.7" />
    </g>
  );
}

function Mouth({ state, audioLevel = 0 }) {
  const lvl = Math.max(0, Math.min(1, audioLevel));

  if (state === "speaking" || state === "done") {
    const rx = 6 + lvl * 7;
    const ry = 4 + lvl * 5;
    return (
      <g>
        <path d="M 87,142 Q 93,138 100,140 Q 107,138 113,142"
              fill="none" stroke={LIP_DEEP} strokeWidth="1.3" strokeLinecap="round" />
        <ellipse cx="100" cy="145" rx={rx} ry={ry} fill={LIP_DEEP} />
        <ellipse cx="100" cy={145 + ry * 0.25} rx={rx * 0.7} ry={ry * 0.45} fill={LIP} />
        {lvl > 0.25 && (
          <rect x={100 - rx * 0.6} y={145 - ry * 0.7} width={rx * 1.2} height={Math.max(1.4, ry * 0.32)}
                fill="#fff" opacity="0.85" rx={1} />
        )}
        <path d={`M ${100 - rx - 1.5},${145 + ry - 0.5} Q 100,${149 + ry * 0.6} ${100 + rx + 1.5},${145 + ry - 0.5}`}
              fill={LIP_HI} opacity="0.9" />
      </g>
    );
  }
  if (state === "listening") {
    return (
      <g>
        <ellipse cx="100" cy="144" rx="3.2" ry="4" fill={LIP_DEEP} />
        <ellipse cx="100" cy="145" rx="2.2" ry="2.4" fill={LIP} />
        <path d="M 95,142 Q 100,140 105,142" fill="none" stroke={LIP_DEEP} strokeWidth="0.9" />
      </g>
    );
  }
  if (state === "thinking") {
    return (
      <g>
        <path d="M 90,144 Q 100,141 110,144" fill="none" stroke={LIP_DEEP} strokeWidth="2" strokeLinecap="round" />
        <path d="M 90,146 Q 100,148 110,146" fill="none" stroke={LIP} strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
      </g>
    );
  }
  return (
    <g>
      <path d="M 88,142 Q 100,150 112,142" fill="none" stroke={LIP_DEEP} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M 88,142 Q 100,139 112,142" fill="none" stroke={LIP} strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
      <path d="M 92,148 Q 100,151 108,148" fill="none" stroke={LIP_HI} strokeWidth="1" strokeLinecap="round" opacity="0.65" />
    </g>
  );
}

function Cheeks({ state }) {
  const op = state === "listening" ? 0.65 : (state === "speaking" || state === "done" ? 0.55 : 0.4);
  const rx = state === "listening" ? 7 : 6;
  return (
    <g>
      <ellipse cx="72"  cy="134" rx={rx} ry="4" fill={BLUSH} opacity={op} />
      <ellipse cx="128" cy="134" rx={rx} ry="4" fill={BLUSH} opacity={op} />
    </g>
  );
}

function HairClip({ state, audioLevel = 0 }) {
  const showRings = state === "listening";
  const spin = state === "thinking";
  const isSpeaking = state === "speaking" || state === "done";
  const lvl = Math.max(0, Math.min(1, audioLevel));
  const speakOrbR = isSpeaking ? 4.5 + lvl * 2.5 : 4.5;
  const speakHalo = isSpeaking ? lvl * 0.85 : 0;

  return (
    <g className="satori-micro-sway">
      {showRings && (
        <>
          <circle className="satori-ring-1" cx={CLIP_X} cy={CLIP_Y} r="14" fill="none" stroke={GREEN} strokeWidth="1.3" />
          <circle className="satori-ring-2" cx={CLIP_X} cy={CLIP_Y} r="14" fill="none" stroke={GREEN} strokeWidth="1.1" />
          <circle className="satori-ring-3" cx={CLIP_X} cy={CLIP_Y} r="14" fill="none" stroke={GREEN} strokeWidth="0.9" />
        </>
      )}
      {isSpeaking && (
        <circle cx={CLIP_X} cy={CLIP_Y} r={speakOrbR + 7} fill={GREEN_BRT} opacity={speakHalo * 0.4} />
      )}
      <g className={spin ? "satori-think-spin" : ""}>
        <path d="M 100,42 Q 88,38 84,48 Q 88,58 100,54 Z" fill={GREEN} />
        <path d="M 100,42 Q 112,38 116,48 Q 112,58 100,54 Z" fill={GREEN} />
        <path d="M 90,44 Q 94,48 92,52" fill="none" stroke={GREEN_BRT} strokeWidth="0.9" opacity="0.8" />
        <path d="M 110,44 Q 106,48 108,52" fill="none" stroke={GREEN_BRT} strokeWidth="0.9" opacity="0.8" />
        <circle className={showRings ? "satori-clip-pulse" : ""}
                cx={CLIP_X} cy={CLIP_Y}
                r={showRings ? 5.5 : speakOrbR}
                fill={GREEN_BRT} />
        <circle cx={CLIP_X} cy={CLIP_Y - 1} r="1.5" fill="#ffffff" opacity="0.85" />
        {spin && (
          <>
            <circle cx={CLIP_X + 12} cy={CLIP_Y} r="2"   fill={GREEN_BRT} opacity="0.8" />
            <circle cx={CLIP_X} cy={CLIP_Y + 12} r="1.5" fill={GREEN_BRT} opacity="0.6" />
          </>
        )}
      </g>
    </g>
  );
}

function Body() {
  return (
    <g>
      <path d="M 40,182 Q 100,170 160,182 L 165,200 L 35,200 Z" fill="#1f1f1d" />
      <path d="M 76,180 Q 100,192 124,180" fill="none" stroke={GREEN} strokeWidth="1.4" opacity="0.85" />
      <rect x="93" y="186" width="14" height="12" rx="2.5" fill={GREEN} />
      <text x="100" y="195" textAnchor="middle"
            style={{ fontSize: 9, fontWeight: 700, fill: "#141413", fontFamily: "Calibri, sans-serif" }}>
        s
      </text>
    </g>
  );
}

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
          <HairBack />
          <Face />
          <Body />
          <HairFront />
          <HairClip state={safeState} audioLevel={audioLevel} />
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
