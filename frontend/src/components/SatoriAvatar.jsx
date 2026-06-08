/*
 * SatoriAvatar.jsx
 * ----------------------------------------------------------------------------
 * Image-based voice-agent avatar with an animated talking mouth, set inside a
 * TMC-green circular frame.
 *
 * The three rendered frames (closed / half / open) are pixel-aligned — only
 * the mouth differs — so we HARD-SWAP between them (no cross-fade: fading two
 * transparent frames makes their soft edges double up and flicker). While
 * Satori is actually speaking (audio playing) a loop drives the mouth through
 * a natural talking pattern biased open with a louder voice; otherwise the
 * mouth stays closed. Falls back to the SVG mascot if an image fails to load.
 *
 * The persona is scaled to fill the circle so her shoulders emerge cleanly
 * from the bottom edge (clipped by the circle), and all glow stays INSIDE the
 * circle. Props: state, audioLevel (0..1), size (px).
 */
import React, { useEffect, useRef, useState } from "react";
import SatoriMascot from "./SatoriMascot.jsx";
import imgClosed from "../assets/voice/satori-mouth-closed.png";
import imgHalf from "../assets/voice/satori-mouth-half.png";
import imgOpen from "../assets/voice/satori-mouth-open.png";

const GREEN    = "#8AC441";
const GREEN_LT = "#a6d65f";
const GREEN_DK = "#5f8a2c";
const AV_STYLE_ID = "satori-avatar-keyframes";

function ensureAvatarKeyframes() {
  if (typeof document === "undefined" || document.getElementById(AV_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = AV_STYLE_ID;
  s.textContent = `
    @keyframes satori-av-breath { 0%,100%{transform:translateY(0) scale(1);} 50%{transform:translateY(-1.5px) scale(1.008);} }
    @keyframes satori-av-ring   { 0%,100%{opacity:0.40;} 50%{opacity:0.85;} }
    .satori-av-breath { animation: satori-av-breath 4.8s ease-in-out infinite; transform-origin: center top; }
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
        next = "closed";                                   // silence gap → shut
      } else if (a > 0.26) {
        next = prev === "open" ? "half" : "open";          // loud → big movement
      } else {
        next = prev === "half" ? "open" : "half";          // soft → gentle movement
      }
      prev = next;
      setMouth(next);
    }, 145);
    return () => clearInterval(id);
  }, [speaking]);

  if (errored) {
    return <SatoriMascot state={state} audioLevel={audioLevel} size={size} ariaLabel={ariaLabel} />;
  }

  const ringOpacity = speaking ? Math.min(1, 0.35 + lvl * 0.65) : (listening ? 0.7 : 0.25);

  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-flex" }}>
      {/* Green circular frame — everything (figure + glow) lives INSIDE it */}
      <div style={{
        position: "absolute", inset: 0, borderRadius: "50%", overflow: "hidden",
        background: `radial-gradient(circle at 50% 36%, ${GREEN_LT} 0%, ${GREEN} 60%, ${GREEN_DK} 100%)`,
        border: `2px solid ${GREEN_DK}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      }}>
        {/* Persona — scaled to fill so shoulders emerge from the bottom edge.
            Frames are stacked and HARD-SWAPPED (no opacity transition → no flicker). */}
        <div className="satori-av-breath" style={{ position: "absolute", inset: 0 }}>
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
                objectFit: "cover", objectPosition: "center top",
                transform: "scale(1.08)", transformOrigin: "center top",
                opacity: k === mouth ? 1 : 0,
                pointerEvents: "none",
              }}
            />
          ))}
        </div>
        {/* Inner ring — pulses while listening, brightens with the voice while
            speaking. Sits just inside the edge and is clipped by the circle. */}
        <div
          className={listening ? "satori-av-ring" : ""}
          style={{
            position: "absolute", inset: 3, borderRadius: "50%",
            border: `3px solid ${GREEN_LT}`,
            opacity: ringOpacity,
            boxShadow: speaking ? `inset 0 0 ${10 + lvl * 16}px ${GREEN_LT}` : "none",
            transition: "opacity 0.1s ease",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
};

export default SatoriAvatar;
