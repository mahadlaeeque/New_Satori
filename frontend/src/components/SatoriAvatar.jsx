/*
 * SatoriAvatar.jsx
 * ----------------------------------------------------------------------------
 * Video persona inside a TMC-green circular frame, driven by four Veo clips
 * that share one framing + flat-grey background:
 *
 *   speaking / done -> looping talking clip (real lip movement)
 *   thinking        -> looping pondering clip (eyes glance aside, head tilt)
 *   greeting        -> welcome nod, plays ONCE then settles into the idle loop
 *   idle / listening / anything else -> gentle breathing idle loop
 *
 * All four <video> layers stay mounted (preloaded) and we cross-fade by
 * opacity, so state changes never flash a loading frame. If a clip fails to
 * load, that state falls back to the original still photo kept alive with a
 * breathing transform + periodic blink overlay.
 *
 * A green ring pulses while listening and brightens with the live voice while
 * speaking.
 *
 * Props: state ('idle'|'listening'|'thinking'|'speaking'|'done'|'greeting'),
 *        audioLevel (0..1), size (px), ariaLabel.
 */
import React, { useEffect, useRef, useState } from "react";
import videoSpeaking from "../assets/voice/satori-speaking.mp4";
import videoThinking from "../assets/voice/satori-thinking.mp4";
import videoGreeting from "../assets/voice/satori-greeting.mp4";
import videoIdleLoop from "../assets/voice/satori-idle-loop.mp4";
import idleImg from "../assets/voice/satori-idle.png";
import blinkImg from "../assets/voice/satori-blink.png";

const GREEN    = "#8AC441";
const GREEN_LT = "#a6d65f";
const GREEN_DK = "#5f8a2c";
const GREY_BG  = "#bebebc";
const AV_STYLE_ID = "satori-avatar-keyframes";

const CLIPS = [
  { key: "idle",     src: videoIdleLoop, loop: true  },
  { key: "thinking", src: videoThinking, loop: true  },
  { key: "speaking", src: videoSpeaking, loop: true  },
  { key: "greeting", src: videoGreeting, loop: false },
];

const clipForState = (state, greetEnded) => {
  if (state === "speaking" || state === "done") return "speaking";
  if (state === "thinking") return "thinking";
  if (state === "greeting") return greetEnded ? "idle" : "greeting";
  return "idle"; // idle, listening, connecting, closing, …
};

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
  const videoRefs = useRef({});
  const [brokenKeys, setBrokenKeys] = useState(() => new Set());
  const [greetEnded, setGreetEnded] = useState(false);

  // A fresh "greeting" state replays the welcome nod from the top.
  useEffect(() => {
    if (state === "greeting") {
      setGreetEnded(false);
      const v = videoRefs.current.greeting;
      if (v) { try { v.currentTime = 0; } catch { /* noop */ } }
    }
  }, [state]);

  const lvl = Math.max(0, Math.min(1, audioLevel));
  const speaking = state === "speaking" || state === "done";
  const listening = state === "listening";
  const thinking = state === "thinking";

  const activeKey = clipForState(state, greetEnded);
  const activeBroken = brokenKeys.has(activeKey);

  // Play only the visible layer; pause the rest (greeting is reset so the
  // next play starts from the nod, loops just resume where they were).
  useEffect(() => {
    for (const { key } of CLIPS) {
      const v = videoRefs.current[key];
      if (!v) continue;
      if (key === activeKey && !activeBroken) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      } else {
        try { v.pause(); } catch { /* noop */ }
      }
    }
  }, [activeKey, activeBroken]);

  const ringOpacity = speaking ? Math.min(1, 0.4 + lvl * 0.6) : (listening ? 0.65 : thinking ? 0.45 : 0.3);
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
        {/* Video layers — all mounted, the active one faded in */}
        {CLIPS.map(({ key, src, loop }) => (
          <video
            key={key}
            ref={(el) => { videoRefs.current[key] = el; }}
            src={src}
            muted loop={loop} playsInline preload="auto"
            onEnded={key === "greeting" ? () => setGreetEnded(true) : undefined}
            onError={() => setBrokenKeys(prev => { const n = new Set(prev); n.add(key); return n; })}
            style={{ ...media, opacity: key === activeKey && !brokenKeys.has(key) ? 1 : 0, transition: "opacity 0.18s ease" }}
          />
        ))}
        {/* Still-photo fallback — breathing + periodic blink — shown only when
            the active clip failed to load */}
        <div className="satori-av-breath"
             style={{ position: "absolute", inset: 0, opacity: activeBroken ? 1 : 0, transition: "opacity 0.18s ease" }}>
          <img src={idleImg} alt={ariaLabel} draggable={false} style={media} />
          <img src={blinkImg} alt="" aria-hidden draggable={false}
               className={activeBroken ? "satori-av-blink" : ""}
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
