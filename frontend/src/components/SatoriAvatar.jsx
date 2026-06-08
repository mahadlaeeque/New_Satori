/*
 * SatoriAvatar.jsx
 * ----------------------------------------------------------------------------
 * Image-based voice-agent avatar with an animated talking mouth, set inside a
 * TMC-green circular frame.
 *
 * Three rendered frames (closed / half / open) of the same TMC persona are
 * stacked and cross-faded. While Satori is actually speaking (audio playing)
 * a ~8fps loop drives the mouth through a natural talking pattern, biased open
 * when her voice is louder — so the lips visibly move. When there's no audio
 * (idle, listening, or while a query runs) the mouth stays closed/attentive.
 * Falls back to the SVG mascot if an image fails to load, so nothing breaks.
 *
 * Props:
 *   state       "idle" | "listening" | "thinking" | "speaking" | "done"
 *   audioLevel  0..1 amplitude from the Gemini Live playback AnalyserNode
 *   size        px (square)
 */
import React, { useEffect, useRef, useState } from "react";
import SatoriMascot from "./SatoriMascot.jsx";
import imgClosed from "../assets/voice/satori-mouth-closed.png";
import imgHalf from "../assets/voice/satori-mouth-half.png";
import imgOpen from "../assets/voice/satori-mouth-open.png";

const GREEN       = "#8AC441";   // TMC primary green
const GREEN_LT    = "#a6d65f";   // lighter centre for the disc
const GREEN_DK    = "#5f8a2c";   // darker rim for depth
const AV_STYLE_ID = "satori-avatar-keyframes";

function ensureAvatarKeyframes() {
  if (typeof document === "undefined" || document.getElementById(AV_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = AV_STYLE_ID;
  s.textContent = `
    @keyframes satori-av-breath { 0%,100%{transform:translateY(0) scale(1);} 50%{transform:translateY(-1.5px) scale(1.01);} }
    @keyframes satori-av-ring   { 0%,100%{opacity:0.45;transform:scale(1);} 50%{opacity:0.9;transform:scale(1.06);} }
    .satori-av-breath { animation: satori-av-breath 4.8s ease-in-out infinite; transform-origin: center bottom; }
    .satori-av-ring   { animation: satori-av-ring 1.8s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

const IMG = { closed: imgClosed, half: imgHalf, open: imgOpen };
const FRAME_KEYS = ["closed", "half", "open"];

const SatoriAvatar = ({ state = "idle", audioLevel = 0, size = 232, ariaLabel = "Satori" }) => {
  useEffect(() => { ensureAvatarKeyframes(); }, []);
  const [errored, setErrored] = useState(false);
  const [mouth, setMouth] = useState("closed");

  // Keep the latest amplitude in a ref so the talking loop can read it live
  // without restarting on every render.
  const lvl = Math.max(0, Math.min(1, audioLevel));
  const lvlRef = useRef(0);
  lvlRef.current = lvl;

  const speaking = state === "speaking" || state === "done";
  const listening = state === "listening";

  // Animated talking mouth — only while speaking AND audio is actually playing.
  useEffect(() => {
    if (!speaking) { setMouth("closed"); return; }
    let prev = "closed";
    const id = setInterval(() => {
      const a = lvlRef.current;
      let next;
      if (a < 0.05) {
        next = "closed";                                   // silence gap → mouth shut
      } else {
        const r = Math.random();
        if (a > 0.28)      next = r < 0.65 ? "open"  : "half";
        else if (a > 0.12) next = r < 0.55 ? "half"  : (r < 0.8 ? "open" : "closed");
        else               next = r < 0.6  ? "half"  : "closed";
        if (next === prev && next !== "closed") next = next === "open" ? "half" : "open"; // force visible motion
      }
      prev = next;
      setMouth(next);
    }, 115);
    return () => clearInterval(id);
  }, [speaking]);

  if (errored) {
    return <SatoriMascot state={state} audioLevel={audioLevel} size={size} ariaLabel={ariaLabel} />;
  }

  // Ring glow around the green disc: pulses while listening, brightens with the
  // voice while speaking, faint at rest.
  const ringOpacity = speaking ? Math.min(1, 0.4 + lvl * 0.6) : (listening ? 0.6 : 0.3);
  const ringBlur = speaking ? 18 + lvl * 26 : 16;

  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-flex" }}>
      {/* Outer glow ring (TMC green) */}
      <div
        className={listening ? "satori-av-ring" : ""}
        style={{
          position: "absolute", inset: -4, borderRadius: "50%",
          boxShadow: `0 0 ${ringBlur}px ${Math.round(6 + lvl * 10)}px ${GREEN}`,
          opacity: ringOpacity,
          transition: "opacity 0.12s ease, box-shadow 0.12s ease",
          pointerEvents: "none",
        }}
      />
      {/* Green circular frame the persona sits inside */}
      <div style={{
        position: "absolute", inset: 0, borderRadius: "50%", overflow: "hidden",
        background: `radial-gradient(circle at 50% 38%, ${GREEN_LT} 0%, ${GREEN} 58%, ${GREEN_DK} 100%)`,
        boxShadow: "inset 0 -8px 20px rgba(0,0,0,0.18), inset 0 4px 12px rgba(255,255,255,0.15)",
        border: `2px solid ${GREEN_DK}`,
      }}>
        {/* Stacked mouth frames — all preloaded, cross-faded. Scaled to ~90% so
            a green rim shows around the persona ("placed in the circle"). */}
        <div className="satori-av-breath"
             style={{ position: "absolute", inset: 0 }}>
          {FRAME_KEYS.map((k) => (
            <img
              key={k}
              src={IMG[k]}
              onError={() => setErrored(true)}
              alt={k === mouth ? ariaLabel : ""}
              aria-hidden={k !== mouth}
              draggable={false}
              style={{
                position: "absolute", inset: 0, width: "100%", height: "100%",
                objectFit: "contain",
                transform: "scale(0.92) translateY(2%)",
                opacity: k === mouth ? 1 : 0,
                transition: "opacity 45ms linear",
                pointerEvents: "none",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default SatoriAvatar;
