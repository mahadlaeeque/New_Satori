/*
 * SatoriAvatar.jsx
 * ----------------------------------------------------------------------------
 * Video-based voice-agent avatar set inside a TMC-green circular frame.
 *
 * A short looping speaking clip (the TMC persona) plays while Satori is
 * speaking; otherwise it's paused on its first (resting) frame. A green ring
 * around the circle pulses while listening and brightens with the live voice
 * amplitude while speaking. Falls back to a still idle image if the video
 * can't load.
 *
 * Props: state ("idle"|"listening"|"thinking"|"speaking"|"done"),
 *        audioLevel (0..1), size (px).
 */
import React, { useEffect, useRef, useState } from "react";
import videoSpeaking from "../assets/voice/satori-speaking.mp4";
import idleImg from "../assets/voice/satori-idle.png";

const GREEN    = "#8AC441";
const GREEN_LT = "#a6d65f";
const GREEN_DK = "#5f8a2c";
const GREY_BG  = "#b4b4b1";
const AV_STYLE_ID = "satori-avatar-keyframes";

function ensureAvatarKeyframes() {
  if (typeof document === "undefined" || document.getElementById(AV_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = AV_STYLE_ID;
  s.textContent = `
    @keyframes satori-av-ring { 0%,100%{opacity:0.40;} 50%{opacity:0.85;} }
    .satori-av-ring { animation: satori-av-ring 1.8s ease-in-out infinite; }
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

  // Play the clip while speaking; otherwise pause on the resting first frame.
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

  const mediaStyle = {
    position: "absolute", inset: 0, width: "100%", height: "100%",
    objectFit: "cover", objectPosition: "center top",
    transform: "scale(1.05)", transformOrigin: "center top",
    pointerEvents: "none",
  };

  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-flex" }}>
      <div style={{
        position: "absolute", inset: 0, borderRadius: "50%", overflow: "hidden",
        background: GREY_BG, border: `3px solid ${GREEN_DK}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      }}>
        {!broken ? (
          <video
            ref={videoRef}
            src={videoSpeaking}
            poster={idleImg}
            muted
            loop
            playsInline
            preload="auto"
            onError={() => setBroken(true)}
            style={mediaStyle}
          />
        ) : (
          <img src={idleImg} alt={ariaLabel} draggable={false} style={mediaStyle} />
        )}
        {/* Green ring — pulses while listening, brightens with the voice while speaking */}
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
