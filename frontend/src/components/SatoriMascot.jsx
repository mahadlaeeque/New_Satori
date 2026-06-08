/*
 * SatoriMascot.jsx
 * ----------------------------------------------------------------------------
 * Animated SVG version of Satori — TMC's AI Practice mascot.
 *
 * States the rest of the app drives:
 *   "idle"       — slow breath, soft closed-crescent eyes, gentle smile
 *   "listening"  — wide alert eyes, antenna pulses with concentric rings
 *   "thinking"   — closed eyes looking up, antenna sparkle, slow rotation
 *   "speaking"   — smiling eyes, mouth opens with audio amplitude (audioLevel prop)
 *   "done"       — transient happy face after end-of-call (auto-revert handled by parent)
 *
 * Web Audio integration: pass audioLevel (0..1) computed from a Gemini Live
 * playback AnalyserNode and the mouth scales in real time during "speaking".
 *
 * Designed to be a 1:1 swappable interface with the upcoming Rive version --
 * when the .riv file lands, callers keep the same props and we render
 * <RiveSatoriMascot> from inside this same component without breaking anything.
 *
 * Author: TMC AI Practice. License: internal.
 */
import React, { useEffect, useRef } from "react";

const STYLE_ID = "satori-mascot-keyframes";

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
    @keyframes satori-antenna-pulse {
      0%, 100% { opacity: 0.55; transform: scale(1); }
      50%      { opacity: 1;    transform: scale(1.12); }
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
    .satori-antenna-orb  { animation: satori-antenna-pulse 1.4s ease-in-out infinite; transform-origin: 100px 28px; transform-box: view-box; }
    .satori-ring-1       { animation: satori-ring-expand 1.8s ease-out infinite;             transform-origin: 100px 28px; transform-box: view-box; }
    .satori-ring-2       { animation: satori-ring-expand 1.8s ease-out infinite 0.45s;       transform-origin: 100px 28px; transform-box: view-box; }
    .satori-ring-3       { animation: satori-ring-expand 1.8s ease-out infinite 0.9s;        transform-origin: 100px 28px; transform-box: view-box; }
    .satori-think-spin   { animation: satori-think-orbit 2.6s linear infinite;               transform-origin: 100px 28px; transform-box: view-box; }
    .satori-mouth-wiggle { animation: satori-mouth-wiggle 0.18s ease-in-out infinite;        transform-origin: 100px 132px; transform-box: view-box; }

    /* Micro idle animations — long cycle so they fire only every 24s,
       once per loop. Subtle head tilt and antenna sway. */
    @keyframes satori-micro-tilt {
      0%, 92%, 100% { transform: rotate(0deg); }
      94%           { transform: rotate(-2.5deg); }
      96%           { transform: rotate(2.5deg); }
      98%           { transform: rotate(0deg); }
    }
    @keyframes satori-micro-sway {
      0%, 88%, 100% { transform: rotate(0deg); }
      91%           { transform: rotate(-6deg); }
      94%           { transform: rotate(6deg); }
      97%           { transform: rotate(0deg); }
    }
    @keyframes satori-done-nod {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      35%      { transform: translateY(4px) rotate(2deg); }
      70%      { transform: translateY(0) rotate(-1deg); }
    }

    .satori-micro-tilt    { animation: satori-micro-tilt 24s ease-in-out infinite;    transform-origin: 100px 110px; transform-box: view-box; }
    .satori-micro-sway    { animation: satori-micro-sway 18s ease-in-out infinite;    transform-origin: 100px 50px;  transform-box: view-box; }
    .satori-done-nod      { animation: satori-done-nod 0.8s ease-out 1;               transform-origin: 100px 100px; transform-box: view-box; }

    /* When audio amplitude is driving the mouth, the wiggle is replaced
       by a continuous inline-transform set from JS — see SatoriMascot.jsx. */
  `;
  document.head.appendChild(s);
}

/**
 * Eye expressions per state.
 *  - idle      : closed-crescent (relaxed smile)
 *  - listening : wide ovals with bright pupils + eyelashes
 *  - thinking  : closed crescents tilted up + 3 thought-dots
 *  - speaking  : closed-crescent smile (eyes folded happy)
 *  - done      : same as speaking
 */
function Eyes({ state, color = "#8AC441", pupilColor = "#cdf08a" }) {
  if (state === "listening") {
    return (
      <g className="satori-eye-blink">
        <ellipse cx="79"  cy="98" rx="6" ry="8" fill={color} />
        <ellipse cx="121" cy="98" rx="6" ry="8" fill={color} />
        <ellipse cx="79"  cy="100" rx="2.5" ry="3.5" fill={pupilColor} />
        <ellipse cx="121" cy="100" rx="2.5" ry="3.5" fill={pupilColor} />
        {/* eyelashes */}
        <path d="M 72,90 L 74,87" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 79,88 L 79,85" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 86,90 L 84,87" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 114,90 L 116,87" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 121,88 L 121,85" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M 128,90 L 126,87" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      </g>
    );
  }
  if (state === "thinking") {
    return (
      <g className="satori-eye-blink">
        <path d="M 72,98 Q 79,93 86,98" fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
        <path d="M 114,98 Q 121,93 128,98" fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
      </g>
    );
  }
  // idle / speaking / done — happy closed crescents
  const yOffset = state === "speaking" || state === "done" ? -1 : 0;
  return (
    <g className="satori-eye-blink">
      <path d={`M 72,${98 + yOffset} Q 79,${105 + yOffset} 86,${98 + yOffset}`}
            fill="none" stroke={color} strokeWidth={state === "speaking" || state === "done" ? 2.8 : 2.5}
            strokeLinecap="round" />
      <path d={`M 114,${98 + yOffset} Q 121,${105 + yOffset} 128,${98 + yOffset}`}
            fill="none" stroke={color} strokeWidth={state === "speaking" || state === "done" ? 2.8 : 2.5}
            strokeLinecap="round" />
      <circle cx="79"  cy="91" r="0.8" fill={color} />
      <circle cx="121" cy="91" r="0.8" fill={color} />
    </g>
  );
}

/**
 * Mouth per state. During "speaking", the mouth scales with audioLevel.
 */
function Mouth({ state, audioLevel = 0, color = "#8AC441", innerColor = "#cdf08a" }) {
  const lvl = Math.max(0, Math.min(1, audioLevel));

  if (state === "speaking" || state === "done") {
    const rx = 8 + lvl * 7;       // 8 .. 15
    const ry = 5 + lvl * 5;       // 5 .. 10
    return (
      <g>
        <ellipse cx="100" cy="132" rx={rx} ry={ry} fill={color} />
        <ellipse cx="100" cy="132" rx={rx * 0.6} ry={ry * 0.55} fill={innerColor} />
        <ellipse cx="100" cy="133" rx={rx * 0.3} ry={ry * 0.2}  fill="#141413" />
        {/* speech waves emerging from the mouth */}
        <path d="M 116,128 Q 122,132 116,136" fill="none"
              stroke={color} strokeWidth="1.5" strokeLinecap="round"
              opacity={0.4 + lvl * 0.4} />
        <path d="M 122,124 Q 130,132 122,140" fill="none"
              stroke={color} strokeWidth="1.2" strokeLinecap="round"
              opacity={0.25 + lvl * 0.35} />
        <path d="M 84,128 Q 78,132 84,136" fill="none"
              stroke={color} strokeWidth="1.5" strokeLinecap="round"
              opacity={0.4 + lvl * 0.4} />
        <path d="M 78,124 Q 70,132 78,140" fill="none"
              stroke={color} strokeWidth="1.2" strokeLinecap="round"
              opacity={0.25 + lvl * 0.35} />
      </g>
    );
  }
  if (state === "listening") {
    // small attentive O
    return <circle cx="100" cy="134" r="3" fill="none" stroke={color} strokeWidth="2" />;
  }
  if (state === "thinking") {
    // tiny straight line — concentrating
    return <line x1="95" y1="134" x2="105" y2="134" stroke={color} strokeWidth="2.4" strokeLinecap="round" />;
  }
  // idle — small gentle smile
  return (
    <path d="M 92,132 Q 100,138 108,132" fill="none"
          stroke={color} strokeWidth="2.5" strokeLinecap="round" />
  );
}

/**
 * Antenna + listening pulse rings.
 */
function Antenna({ state, audioLevel = 0 }) {
  const showRings = state === "listening";
  const spin = state === "thinking";
  const isSpeaking = state === "speaking" || state === "done";
  // Audio-reactive glow during speech: orb radius + outer halo opacity
  // both scale with the live amplitude (0..1).
  const lvl = Math.max(0, Math.min(1, audioLevel));
  const speakOrbR  = isSpeaking ? 7 + lvl * 3.5 : 7;
  const speakHalo  = isSpeaking ? lvl * 0.85 : 0;
  return (
    <g className="satori-micro-sway">
      {showRings && (
        <>
          <circle className="satori-ring-1" cx="100" cy="28" r="14" fill="none"
                  stroke="#8AC441" strokeWidth="1.2" />
          <circle className="satori-ring-2" cx="100" cy="28" r="14" fill="none"
                  stroke="#8AC441" strokeWidth="1.0" />
          <circle className="satori-ring-3" cx="100" cy="28" r="14" fill="none"
                  stroke="#8AC441" strokeWidth="0.8" />
        </>
      )}
      <line x1="100" y1="50" x2="100" y2="30" stroke="#444" strokeWidth="2" />
      {/* Speaking halo (transparent except when audio is loud) */}
      {isSpeaking && (
        <circle cx="100" cy="28" r={speakOrbR + 6}
                fill="#cdf08a" opacity={speakHalo * 0.35} />
      )}
      <g className={spin ? "satori-think-spin" : ""}>
        <circle className={showRings ? "satori-antenna-orb" : ""}
                cx="100" cy="28"
                r={showRings ? 9 : speakOrbR}
                fill="#8AC441" />
        <circle cx="100" cy="27" r={2.8 + (isSpeaking ? lvl * 1.5 : 0)}
                fill="#cdf08a" />
        {spin && (
          <>
            <circle cx="112" cy="28" r="2" fill="#cdf08a" opacity="0.8" />
            <circle cx="100" cy="40" r="1.5" fill="#cdf08a" opacity="0.6" />
          </>
        )}
      </g>
    </g>
  );
}

/**
 * Hair / side wings.
 */
function Hair() {
  return (
    <g>
      <path d="M 28,90 Q 12,110 18,150 Q 24,170 36,172 L 48,160 L 48,110 Q 40,90 28,90 Z"
            fill="#2a2a28" />
      <path d="M 172,90 Q 188,110 182,150 Q 176,170 164,172 L 152,160 L 152,110 Q 160,90 172,90 Z"
            fill="#2a2a28" />
      <circle cx="22" cy="140" r="6" fill="#8AC441" />
      <circle cx="178" cy="140" r="6" fill="#8AC441" />
    </g>
  );
}

/**
 * Body collar (sits below the head).
 */
function Body() {
  return (
    <g>
      <path d="M 48,162 L 62,192 L 138,192 L 152,162 Z" fill="#2a2a28" />
      <rect x="93" y="170" width="14" height="14" rx="3" fill="#8AC441" />
      <text x="100" y="181" textAnchor="middle"
            style={{ fontSize: 9, fontWeight: 500, fill: "#141413",
                     fontFamily: "Calibri, sans-serif" }}>
        s
      </text>
    </g>
  );
}

/**
 * Cheek blush dots — slightly brighter when listening / speaking.
 */
function Cheeks({ state }) {
  const op = state === "listening" ? 0.85 : (state === "speaking" || state === "done" ? 0.8 : 0.5);
  const r  = state === "listening" ? 3.2 : (state === "speaking" || state === "done" ? 3.0 : 2.5);
  return (
    <g>
      <circle cx="68"  cy="118" r={r} fill="#8AC441" opacity={op} />
      <circle cx="132" cy="118" r={r} fill="#8AC441" opacity={op} />
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
          <Hair />
          <Antenna state={safeState} audioLevel={audioLevel} />
          {/* Head shell */}
          <rect x="42"  y="50"  width="116" height="108" rx="28"
                fill="#2a2a28" stroke="#3b3b39" strokeWidth="1" />
          {/* Face screen */}
          <rect x="54"  y="64"  width="92"  height="84"  rx="20" fill="#141413" />
          <Eyes state={safeState} />
          <Cheeks state={safeState} />
          <Mouth state={safeState} audioLevel={audioLevel} />
          <Body />
        </g>
      </svg>
    </Wrapper>
  );
};

export default SatoriMascot;
