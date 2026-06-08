/*
 * SatoriAvatar.jsx
 * ----------------------------------------------------------------------------
 * Video + still voice-agent avatar inside a TMC-green circular frame.
 *
 *   speaking  -> looping talking clip (real lip movement)
 *   otherwise -> a STATIC resting picture (not a frozen video frame), kept
 *                alive with gentle breathing and a periodic natural blink
 *                (an eyes-lowered frame flashed over the open frame; both come
 *                from the same source so they align perfectly).
 *
 * All three assets share one flat-grey background so the circle reads uniform.
 * A green ring pulses while listening and brightens with the live voice while
 * speaking. Falls back to the idle still if the video can't load.
 *
 * Props: state, audioLevel (0..1), size (px).
 */
import React, { useEffect, useRef, useState } from "react";
import videoSpeaking from "../assets/voice/satori-speaking.mp4";
import idleImg from "../assets/voice/satori-idle.png";
import blinkImg from "../assets/voice/satori-blink.png";

const GREEN    = "#8AC441";
const GREEN_LT = "#a6d65f";
const GREEN_DK = "#5f8a2c";
const GREY_BG  = "#bebebc";
const AV_STYLE_ID = "satori-avatar-keyframes";

function ensureAvatarKeyframes() {
  if (typeof document === "undefined" || document.getElementById(AV_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = AV_STYLE_ID;
  s.textContent = `
    @keyframes satori-av-breath { 0%,100%{transform:translateY(0) scale(1);} 50%{transform:translateY(-1.5px) scale(1.012);} }
    @keyframes satori-av-blink  { 0%,93%,99%,100%{opacity:0;} 95%,97%{opacity:1;} }
    @keyframes satori-av-ring   { 0%,100%{opacity:0.40;} 50%{opacity:0.85;} }
    .satori-av-breath { animation: satori-av-breath 4.8s ease-in-out infinite; transform-origin: center bottom; }
    .satori-av-blink  { animation: satori-av-blink 4.6s ease-in-out infinite; }
    .satori-av-ring   { animation: satori-av-ring 1.8s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

const SatoriAvatar = ({ state = "idle", audioLevel = 0, size = 232, ariaLabel = "Satori" }) => {
  useEffect(() => { ensureAvatarKeyframes(); }, []);
  const videoRef = useRef(null);
  const [broken, setBroken] = useState(false);

  const lvl = Math.max(0, Math.min(1, audioLevel));
  const speaking = state === "speaking" || state === "done";
  const listening = state === "listening";

  // Play the clip while speaking; otherwise pause + reset to the resting frame.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (speaking) {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      try { v.pause(); v.currentTime = 0; } catch {}
    }
  }, [speaking]);

  const ringOpacity = speaking ? Math.min(1, 0.4 + lvl * 0.6) : (listening ? 0.65 : 0.3);
  const media = {
    position: "absolute", inset: 0, width: "100%", height: "100%",
    objectFit: "cover", objectPosition: "center top", pointerEvents: "none",
  };

  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-flex" }}>
      <div style={{
        position: "absolute", inset: 0, borderRadius: "50%", overflow: "hidden",
        background: GREY_BG, border: `3px solid ${GREEN_DK}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      }}>
        {/* Speaking clip — visible only while speaking */}
        <video
          ref={videoRef}
          src={videoSpeaking}
          muted loop playsInline preload="auto"
          onError={() => setBroken(true)}
          style={{ ...media, opacity: speaking && !broken ? 1 : 0, transition: "opacity 0.18s ease" }}
        />
        {/* Idle still — breathing + periodic blink — visible when not speaking */}
        <div className="satori-av-breath"
             style={{ position: "absolute", inset: 0, opacity: speaking && !broken ? 0 : 1, transition: "opacity 0.18s ease" }}>
          <img src={idleImg} alt={ariaLabel} draggable={false} style={media} />
          {/* blink frame flashed over the open eyes */}
          <img src={blinkImg} alt="" aria-hidden draggable={false}
               className={!speaking ? "satori-av-blink" : ""}
               style={{ ...media, opacity: 0 }} />
        </div>
        {/* Green ring — pulses listening / brightens with the voice speaking */}
        <div
          className={listening ? "satori-av-ring" : ""}
          style={{
            position: "absolute", inset: 3, borderRadius: "50%",
            border: `3px solid ${GREEN_LT}`,
            opacity: ringOpacity,
            boxShadow: speaking ? `inset 0 0 ${10 + lvl * 16}px ${GREEN_LT}` : "none",
            transition: "opacity 0.12s ease",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
};

export default SatoriAvatar;
