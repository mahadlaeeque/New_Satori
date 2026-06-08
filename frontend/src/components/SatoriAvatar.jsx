/*
 * SatoriAvatar.jsx
 * ----------------------------------------------------------------------------
 * Image-based voice-agent avatar with amplitude-driven lip-sync.
 *
 * Three rendered frames (closed / half / open mouth) of the same TMC persona
 * are stacked and cross-faded based on the live voice amplitude while Satori
 * is speaking, so her mouth moves in sync. A soft TMC-green aura sits behind
 * the head — gently pulsing while listening, brightening with the voice level
 * while speaking. If any image fails to load it falls back to the SVG mascot,
 * so the modal never breaks.
 *
 * Props:
 *   state       "idle" | "listening" | "thinking" | "speaking" | "done"
 *   audioLevel  0..1 amplitude from the Gemini Live playback AnalyserNode
 *   size        px (square)
 */
import React, { useEffect, useState } from "react";
import SatoriMascot from "./SatoriMascot.jsx";
import imgClosed from "../assets/voice/satori-mouth-closed.png";
import imgHalf from "../assets/voice/satori-mouth-half.png";
import imgOpen from "../assets/voice/satori-mouth-open.png";

const GREEN = "#8AC441";
const AV_STYLE_ID = "satori-avatar-keyframes";

function ensureAvatarKeyframes() {
  if (typeof document === "undefined" || document.getElementById(AV_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = AV_STYLE_ID;
  s.textContent = `
    @keyframes satori-av-breath { 0%,100%{transform:translateY(0) scale(1);} 50%{transform:translateY(-2px) scale(1.012);} }
    @keyframes satori-av-glow   { 0%,100%{opacity:0.40;transform:translate(-50%,-50%) scale(1);} 50%{opacity:0.62;transform:translate(-50%,-50%) scale(1.07);} }
    .satori-av-breath { animation: satori-av-breath 4.8s ease-in-out infinite; transform-origin: center bottom; }
    .satori-av-glow   { animation: satori-av-glow 2.2s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

const FRAMES = [
  { key: "closed", img: imgClosed },
  { key: "half",   img: imgHalf },
  { key: "open",   img: imgOpen },
];

const SatoriAvatar = ({ state = "idle", audioLevel = 0, size = 260, ariaLabel = "Satori" }) => {
  useEffect(() => { ensureAvatarKeyframes(); }, []);
  const [errored, setErrored] = useState(false);

  if (errored) {
    return <SatoriMascot state={state} audioLevel={audioLevel} size={size} ariaLabel={ariaLabel} />;
  }

  const lvl = Math.max(0, Math.min(1, audioLevel));
  const speaking = state === "speaking" || state === "done";
  const listening = state === "listening";

  // Lip-sync: pick the mouth frame from the live amplitude while speaking.
  // Idle / listening / thinking → mouth closed (attentive).
  let active = "closed";
  if (speaking) active = lvl > 0.32 ? "open" : (lvl > 0.10 ? "half" : "closed");

  // Aura behind the head: brighter + larger with the voice while speaking,
  // gentle pulse while listening, faint at rest.
  const glowOpacity = speaking ? Math.min(0.9, 0.32 + lvl * 0.7) : (listening ? 0.5 : 0.22);
  const glowScale = speaking ? 1 + lvl * 0.16 : 1;

  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-flex" }}>
      {/* TMC-green aura, centered over the head area (~32% from top) */}
      <div
        className={listening ? "satori-av-glow" : ""}
        style={{
          position: "absolute", top: "32%", left: "50%",
          width: size * 0.74, height: size * 0.74,
          transform: `translate(-50%, -50%) scale(${glowScale})`,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${GREEN}cc 0%, ${GREEN}66 42%, transparent 70%)`,
          opacity: glowOpacity,
          filter: "blur(10px)",
          transition: "opacity 0.1s ease, transform 0.1s ease",
          pointerEvents: "none",
        }}
      />
      {/* Stacked frames (all preloaded; cross-fade avoids flicker) with a soft breath */}
      <div className="satori-av-breath"
           style={{ position: "relative", width: "100%", height: "100%" }}>
        {FRAMES.map((f) => (
          <img
            key={f.key}
            src={f.img}
            onError={() => setErrored(true)}
            alt={f.key === active ? ariaLabel : ""}
            aria-hidden={f.key !== active}
            draggable={false}
            style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              objectFit: "contain",
              opacity: f.key === active ? 1 : 0,
              transition: "opacity 60ms linear",
              filter: "drop-shadow(0 10px 22px rgba(0,0,0,0.38))",
              pointerEvents: "none",
            }}
          />
        ))}
      </div>
    </div>
  );
};

export default SatoriAvatar;
