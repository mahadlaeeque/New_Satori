/*
 * SatoriMascot.jsx
 * ----------------------------------------------------------------------------
 * Rendered-image avatar for Satori — TMC's AI Practice voice agent.
 *
 * V4 (June 2026): replaced the procedural SVG with three rendered PNG mouth
 * poses (closed / half / open). During the "speaking" state we crossfade
 * between them based on the live audio amplitude (audioLevel prop, 0..1),
 * giving real-time lip sync to the Gemini Live TTS stream.
 *
 * States the rest of the app drives:
 *   "idle"       — closed mouth, gentle breathing
 *   "listening"  — closed mouth, accent dot pulses + concentric rings overlay
 *   "thinking"   — closed mouth, accent dot sparkles spin overlay
 *   "speaking"   — mouth crossfades (closed -> half -> open) by audioLevel
 *   "done"       — closed mouth, brief nod animation
 *
 * The overlay (TMC-green accent dot above the hair) keeps the same role the
 * SVG version played: an at-a-glance signal of what the agent is doing.
 *
 * Same prop interface as V1-V3 — drop-in replacement, no callsite changes.
 *
 * Author: TMC AI Practice. License: internal.
 */
import React, { useEffect } from "react";

// Vite handles the asset URLs (hashed at build time, inlined at runtime).
import mouthClosed from "../assets/voice/satori-mouth-closed.png";
import mouthHalf   from "../assets/voice/satori-mouth-half.png";
import mouthOpen   from "../assets/voice/satori-mouth-open.png";

const STYLE_ID = "satori-mascot-keyframes";

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes satori-breath {
      0%, 100% { transform: translateY(0) scale(1); }
      50%      { transform: translateY(-2px) scale(1.012); }
    }
    @keyframes satori-accent-pulse {
      0%, 100% { opacity: 0.75; transform: scale(1); }
      50%      { opacity: 1;    transform: scale(1.18); }
    }
    @keyframes satori-ring-expand {
      0%   { opacity: 0.7; transform: scale(0.85); }
      100% { opacity: 0;   transform: scale(1.9); }
    }
    @keyframes satori-think-orbit {
      0%   { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes satori-done-nod {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      35%      { transform: translateY(3px) rotate(1.5deg); }
      70%      { transform: translateY(0) rotate(-0.8deg); }
    }
    @keyframes satori-micro-tilt {
      0%, 94%, 100% { transform: rotate(0deg); }
      96%           { transform: rotate(-1.2deg); }
      98%           { transform: rotate(1.2deg); }
    }

    .satori-root           { animation: satori-breath 4.6s ease-in-out infinite; transform-origin: center 80%; }
    .satori-accent-pulse   { animation: satori-accent-pulse 1.4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
    .satori-ring-1         { animation: satori-ring-expand 2.0s ease-out infinite;        transform-origin: center; transform-box: fill-box; }
    .satori-ring-2         { animation: satori-ring-expand 2.0s ease-out infinite 0.5s;   transform-origin: center; transform-box: fill-box; }
    .satori-ring-3         { animation: satori-ring-expand 2.0s ease-out infinite 1.0s;   transform-origin: center; transform-box: fill-box; }
    .satori-think-spin     { animation: satori-think-orbit 3.0s linear infinite;          transform-origin: center; transform-box: fill-box; }
    .satori-done-nod       { animation: satori-done-nod 0.8s ease-out 1; transform-origin: center 60%; }
    .satori-micro-tilt     { animation: satori-micro-tilt 28s ease-in-out infinite; transform-origin: center 60%; }

    /* Crossfade between mouth poses — driven by inline opacity from React. */
    .satori-mouth-layer    { position: absolute; inset: 0; transition: opacity 80ms linear; pointer-events: none; }
  `;
  document.head.appendChild(s);
}

// TMC palette — accents only (the image carries everything else now).
const GREEN     = "#8AC441";
const GREEN_BRT = "#cdf08a";

/**
 * Compute per-mouth-pose opacities from the live audio amplitude.
 * Three thresholds with small overlap so the crossfade reads as smooth lip
 * motion rather than discrete frames.
 */
function mouthOpacities(state, audioLevel) {
  if (state !== "speaking" && state !== "done") {
    // All non-speaking states show closed mouth.
    return { closed: 1, half: 0, open: 0 };
  }
  const lvl = Math.max(0, Math.min(1, audioLevel || 0));
  // Map lvl in [0,1] to a position across (closed -> half -> open) with
  // soft transitions around the breakpoints.
  if (lvl < 0.12) {
    // mostly closed, a touch of half kicking in at the top end
    const t = lvl / 0.12;
    return { closed: 1 - t * 0.3, half: t * 0.3, open: 0 };
  }
  if (lvl < 0.32) {
    // closed -> half
    const t = (lvl - 0.12) / 0.20;
    return { closed: 1 - t, half: t, open: 0 };
  }
  if (lvl < 0.55) {
    // half hold + open ramping in
    const t = (lvl - 0.32) / 0.23;
    return { closed: 0, half: 1 - t, open: t };
  }
  // fully open
  return { closed: 0, half: 0, open: 1 };
}

/**
 * Small floating accent + state overlay rendered ABOVE the avatar's head.
 * Sized to ~28% of the avatar width, positioned just above the hairline.
 */
function StateOverlay({ state, audioLevel, size }) {
  const showRings = state === "listening";
  const spin = state === "thinking";
  const isSpeaking = state === "speaking" || state === "done";
  const lvl = Math.max(0, Math.min(1, audioLevel || 0));
  const orbR = isSpeaking ? 6 + lvl * 4 : 6;
  const halo = isSpeaking ? lvl * 0.85 : 0;

  // Overlay box: sits at the top-center, sized to give the accent room.
  const w = Math.max(40, size * 0.4);
  const top = size * 0.04;
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top,
        width: w,
        height: w,
        transform: "translateX(-50%)",
        pointerEvents: "none",
      }}
    >
      <svg
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Listening rings — radiate outward */}
        {showRings && (
          <>
            <circle className="satori-ring-1" cx="50" cy="50" r="22"
                    fill="none" stroke={GREEN} strokeWidth="1.4" />
            <circle className="satori-ring-2" cx="50" cy="50" r="22"
                    fill="none" stroke={GREEN} strokeWidth="1.1" />
            <circle className="satori-ring-3" cx="50" cy="50" r="22"
                    fill="none" stroke={GREEN} strokeWidth="0.9" />
          </>
        )}
        {/* Speaking halo — opacity tied to live amplitude */}
        {isSpeaking && (
          <circle cx="50" cy="50" r={orbR + 8}
                  fill={GREEN_BRT} opacity={halo * 0.35} />
        )}
        {/* Thinking orbit — small satellite dots spinning around the accent */}
        <g className={spin ? "satori-think-spin" : ""}>
          {/* Soft outer disc */}
          <circle cx="50" cy="50" r={orbR + 2.5} fill={GREEN} opacity="0.35" />
          {/* Main accent dot — pulses for listening */}
          <circle className={showRings ? "satori-accent-pulse" : ""}
                  cx="50" cy="50" r={orbR}
                  fill={GREEN} />
          {/* Bright center */}
          <circle cx="50" cy="49" r={Math.max(1.5, orbR * 0.5)}
                  fill={GREEN_BRT} />
          {spin && (
            <>
              <circle cx="76" cy="50" r="2.2" fill={GREEN_BRT} opacity="0.85" />
              <circle cx="50" cy="76" r="1.8" fill={GREEN_BRT} opacity="0.65" />
              <circle cx="24" cy="50" r="1.4" fill={GREEN_BRT} opacity="0.5"  />
            </>
          )}
        </g>
      </svg>
    </div>
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

  const opa = mouthOpacities(safeState, audioLevel);

  const Wrapper = onClick ? "button" : "div";
  const wrapperStyle = {
    background: "transparent",
    border: "none",
    padding: 0,
    margin: 0,
    cursor: onClick ? "pointer" : "default",
    display: "inline-block",
    lineHeight: 0,
    ...style,
  };

  // Apply the "done nod" once + idle micro-tilt; breathing always on.
  const innerClass = [
    "satori-root",
    safeState === "done" ? "satori-done-nod" : "",
    safeState === "idle" ? "satori-micro-tilt" : "",
  ].filter(Boolean).join(" ");

  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick || undefined}
      aria-label={ariaLabel}
      style={wrapperStyle}
    >
      <div
        className={innerClass}
        style={{
          position: "relative",
          width: size,
          height: size,
          display: "inline-block",
        }}
        role="img"
        aria-label={ariaLabel}
      >
        {/* Three mouth poses stacked — opacity blends them per audioLevel */}
        <img
          src={mouthClosed}
          alt=""
          draggable={false}
          className="satori-mouth-layer"
          style={{ opacity: opa.closed, width: "100%", height: "100%", objectFit: "contain" }}
        />
        <img
          src={mouthHalf}
          alt=""
          draggable={false}
          className="satori-mouth-layer"
          style={{ opacity: opa.half, width: "100%", height: "100%", objectFit: "contain" }}
        />
        <img
          src={mouthOpen}
          alt=""
          draggable={false}
          className="satori-mouth-layer"
          style={{ opacity: opa.open, width: "100%", height: "100%", objectFit: "contain" }}
        />
        {/* State overlay — accent dot + listening rings + thinking sparkles */}
        <StateOverlay state={safeState} audioLevel={audioLevel} size={size} />
      </div>
    </Wrapper>
  );
};

export default SatoriMascot;
