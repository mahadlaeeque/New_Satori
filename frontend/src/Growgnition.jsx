import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart
} from "recharts";
import {
  LayoutDashboard, DollarSign, ShoppingCart, Truck, Warehouse, Factory,
  Users, Shield, BarChart3, TrendingUp, TrendingDown, ArrowUpRight,
  ArrowDownRight, Mic, MicOff, Send, MessageSquare, X, ChevronRight, AudioLines,
  ChevronLeft, LogOut, Bell, Search, Settings, Menu, Package, Globe,
  Zap, Brain, Activity, Eye, EyeOff, Target, AlertTriangle, CheckCircle,
  Clock, FileText, Layers, PieChart as PieChartIcon, Lock, Mail, User,
  Volume2, VolumeX, Minimize2, Maximize2, Bot, Sparkles, ChevronDown, Download,
  Plus, ToggleLeft, ToggleRight, Phone, Hash, Trash2, Edit3, Play, Pause, ArrowRight, MessageCircle,
  HelpCircle, Calendar, Command, CreditCard, Star, MoreHorizontal, Copy, Share2, Link as LinkIcon, UserPlus,
  Filter, Sun, Moon, ThumbsUp, ThumbsDown, RefreshCw, Check
} from "lucide-react";
// Lazy-loaded: the Availability Engine is a big self-contained page (cards,
// heatmap, radar, modals, jspdf export) most sessions never open first —
// splitting it keeps login/first-paint lean.
const AvailabilityEnginePage = lazy(() => import("./AvailabilityEngine.jsx"));
import SatoriAvatar from "./components/SatoriAvatar.jsx";

// ─── TMC Brand Color Palette ───
// Theme-aware tokens go through CSS custom properties so the same JSX inline
// styles render correctly in both light and dark mode. Brand colors that
// should NOT flip (accent green, danger red, etc.) stay as hex literals.
// The CSS variable defaults live in the global <style> block at the App root.
const COLORS = {
  primary:        "var(--c-primary)",
  primaryLight:   "var(--c-primary-light)",
  primaryDark:    "var(--c-primary-dark)",
  accent:         "#8AC441",
  accentLight:    "#9DD35A",
  accentDark:     "#68933F",
  purple:         "#353085",
  teal:           "#0A5F89",
  warning:        "#F59E0B",
  danger:         "#EF4444",
  success:        "#8AC441",
  info:           "#0A5F89",
  surface:        "var(--c-surface)",
  surfaceAlt:     "var(--c-surface-alt)",
  border:         "var(--c-border)",
  silver:         "var(--c-text-muted)",
  textPrimary:    "var(--c-text-primary)",
  textSecondary:  "var(--c-text-secondary)",
  textMuted:      "var(--c-text-muted)",
  chartColors:    ["#8AC441", "#353085", "#0A5F89", "#94A3B8", "#68933F", "#F59E0B", "#EF4444", "#9DD35A"],
  gradientStart:  "var(--c-primary)",
  gradientEnd:    "#8AC441",
};

// ─── TMC Logo Image Component ───
const TMCLogo = ({ height = 40, light = false }) => (
  <img
    src={light ? "/tmc-logo-light.png" : "/tmc-logo-dark.png"}
    alt="TMC"
    style={{ height, width: "auto", objectFit: "contain" }}
  />
);

// ─── Utility Components ───
const KPICard = ({ title, value, change, changeType, icon: Icon, color, subtitle }) => (
  <div style={{
    background: COLORS.surface, borderRadius: 16, padding: "20px 24px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
    border: `1px solid ${COLORS.border}`, position: "relative", overflow: "hidden",
    transition: "all 0.2s", cursor: "default"
  }}
  onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
  onMouseLeave={e => { e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)"; e.currentTarget.style.transform = "translateY(0)"; }}
  >
    <div style={{ position: "absolute", top: 0, right: 0, width: 80, height: 80, background: `${color}10`, borderRadius: "0 16px 0 80px" }} />
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}15`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon size={20} color={color} />
      </div>
      {change && (
        <div style={{
          display: "flex", alignItems: "center", gap: 2, fontSize: 13, fontWeight: 600,
          color: changeType === "up" ? COLORS.success : COLORS.danger,
          background: changeType === "up" ? "#ECFDF5" : "#FEF2F2",
          padding: "2px 8px", borderRadius: 20
        }}>
          {changeType === "up" ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          {change}
        </div>
      )}
    </div>
    <div style={{ fontSize: 28, fontWeight: 700, color: COLORS.textPrimary, lineHeight: 1.2 }}>{value}</div>
    <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 4, fontWeight: 500 }}>{title}</div>
    {subtitle && <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{subtitle}</div>}
  </div>
);

const ChartCard = ({ title, subtitle, children, style = {} }) => {
  // Per-chart controls: view full screen + download as PNG. The buttons are
  // tagged data-html2canvas-ignore so they don't appear in the exported image.
  const cardRef = useRef(null);
  const [isFs, setIsFs] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === cardRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFs = () => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else { try { el.requestFullscreen?.(); } catch { /* blocked — no-op */ } }
  };
  const download = async () => {
    const el = cardRef.current;
    if (!el || busy) return;
    setBusy(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(el, {
        backgroundColor: getComputedStyle(el).backgroundColor || "#ffffff",
        scale: 2, useCORS: true, logging: false,
      });
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `${String(title || "chart").replace(/[^\w-]+/g, "_").slice(0, 60) || "chart"}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
      console.error("chart download failed", e);
    } finally {
      setBusy(false);
    }
  };
  const iconBtn = {
    background: "transparent", border: `1px solid ${COLORS.border}`, borderRadius: 8,
    padding: "5px 7px", cursor: "pointer", color: COLORS.textMuted,
    display: "flex", alignItems: "center", transition: "all 0.15s",
  };
  return (
    <div ref={cardRef} className="satori-chartcard" style={{
      background: COLORS.surface, borderRadius: 16, padding: 24,
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: `1px solid ${COLORS.border}`, ...style
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>{subtitle}</div>}
        </div>
        <div data-html2canvas-ignore="true" style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={download} title="Download as PNG" disabled={busy} style={{ ...iconBtn, opacity: busy ? 0.5 : 1 }}
            onMouseEnter={e => { e.currentTarget.style.background = COLORS.surfaceAlt; e.currentTarget.style.color = COLORS.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textMuted; }}>
            <Download size={15} />
          </button>
          <button onClick={toggleFs} title={isFs ? "Exit full screen" : "View full screen"} style={iconBtn}
            onMouseEnter={e => { e.currentTarget.style.background = COLORS.surfaceAlt; e.currentTarget.style.color = COLORS.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textMuted; }}>
            {isFs ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>
      {children}
    </div>
  );
};

// ── Data freshness ("Data as of ...") ──────────────────────────────────────
// Module-level cache so the freshness probe runs once per session no matter
// how many DataAsOf labels mount. Backend caches it 1h server-side too.
let _freshnessCache = null;
let _freshnessPromise = null;
// Re-poll cadence — matches the 30-min Drive→BigQuery pipeline, so the
// "Data as of" timestamp advances roughly when the warehouse actually reloads
// (NOT a per-minute wall clock).
const FRESHNESS_POLL_MS = 30 * 60 * 1000;
function fetchDataFreshness(force = false) {
  if (!force && _freshnessCache) return Promise.resolve(_freshnessCache);
  if (_freshnessPromise) return _freshnessPromise;
  const base = import.meta.env.VITE_API_BASE || "";
  const token = localStorage.getItem("token");
  _freshnessPromise = fetch(`${base}/api/data-freshness`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) _freshnessCache = d; return d || _freshnessCache; })
    .catch(() => _freshnessCache)
    // Clear the in-flight handle once settled so a failed/empty fetch retries
    // next time instead of caching a permanently-rejected promise.
    .finally(() => { _freshnessPromise = null; });
  return _freshnessPromise;
}

// Clear cached freshness (called on logout so the next user re-fetches).
function clearDataFreshnessCache() {
  _freshnessCache = null;
  _freshnessPromise = null;
}

function useDataFreshness() {
  const [f, setF] = useState(_freshnessCache);
  useEffect(() => {
    let mounted = true;
    fetchDataFreshness().then((d) => { if (mounted) setF(d); });
    // Refresh every ~30 min so the displayed last-loaded time keeps up with the
    // pipeline without polling every minute.
    const id = setInterval(() => {
      fetchDataFreshness(true).then((d) => { if (mounted && d) setF(d); });
    }, FRESHNESS_POLL_MS);
    return () => { mounted = false; clearInterval(id); };
  }, []);
  return f;
}

// "Data as of Apr 24, 2026" pill. `source` picks a specific warehouse source
// (attendance | allocation | timesheet); omit it for the overall latest date.
const DataAsOf = ({ source, prefix = "Data as of", style = {} }) => {
  const f = useDataFreshness();
  const info = f && (source ? f.sources?.[source] : f.overall);
  // Prefer the real pipeline load time (when data was last pulled into
  // BigQuery). Show it as date + time in the viewer's local timezone. Fall back
  // to the latest data-coverage date if the load time isn't available, or for
  // source-specific pills (which want that source's data date).
  const loaded = (!source && f?.last_loaded) ? new Date(f.last_loaded) : null;
  let display = null;
  let titleText = "";
  if (loaded && !isNaN(loaded.getTime())) {
    display = loaded.toLocaleString([], {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
    titleText = `Warehouse last refreshed from BigQuery: ${display}`
      + (info?.label ? ` · latest data date ${info.label}` : "");
  } else if (info?.label) {
    display = info.label;
    titleText = `Latest ${source || "warehouse"} data: ${info.label}`;
  }
  if (!display) return null;
  return (
    <div
      title={titleText}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 11, color: COLORS.textMuted, whiteSpace: "nowrap", ...style,
      }}
    >
      <Clock size={11} />
      {prefix} {display}
    </div>
  );
};

// ── First-run product tour (embedded enablement) ───────────────────────────
// Hand-rolled spotlight tour (no external lib) anchored to elements via their
// data-tour="…" attribute. Auto-runs once for new users; replayable from Help.
const ONBOARDING_STEPS = [
  { selector: null, page: "agent", title: "Welcome to Satori 👋",
    body: "Your AI partner for workforce and sales intelligence. This two-minute tour walks through every part of the platform — skip anytime, or replay it from Help.",
    narration: "Hi, I'm Satori — your AI partner for workforce and sales intelligence. Let me walk you through everything I can do. It only takes two minutes, and you can skip or replay this tour anytime from the Help menu." },
  { selector: '[data-tour="nav"]', placement: "right", page: "agent", title: "Find your way around",
    body: "Everything lives in this sidebar: Ask Me Anything, the Report Builder, the Dashboard Builder, and the Availability Engine. We'll visit each one.",
    narration: "This sidebar is home base. From here you can reach Ask Me Anything, the Report Builder, the Dashboard Builder, and the Availability Engine. Let's visit each one." },
  { selector: '[data-tour="agent-input"]', placement: "top", page: "agent", title: "Ask Me Anything — in plain English",
    body: "Ask about attendance, timesheets, allocation, or sales — Satori writes the SQL against live warehouse data and answers in business language. There's a voice mode too, in English or Urdu.",
    narration: "This is Ask Me Anything. Type any question about attendance, timesheets, allocation, or sales — in plain English — and I'll query the live data warehouse and answer in business language. You can also talk to me by voice, in English or Urdu." },
  { selector: '[data-tour="sample-prompts"]', placement: "left", page: "agent", title: "Not sure where to start?",
    body: "Tap a sample prompt — they're grouped by topic and show the kinds of questions Satori handles well.",
    narration: "If you're not sure where to start, tap one of these sample prompts. They're grouped by topic and show the kinds of questions I handle well." },
  { selector: '[data-tour="insight-feed"]', placement: "left", page: "agent", title: "Satori noticed…",
    body: "Every day Satori scans attendance, timesheets and allocations for anomalies and posts what it finds here — click any card to dig in, or press Briefing to hear the day's summary read aloud.",
    narration: "I don't just wait for questions. Every day I scan attendance, timesheets and allocations for anomalies, and post what I notice right here. Click any card to dig in — or press the briefing button and I'll read you the day's summary." },
  { selector: '[data-tour="nav-reports"]', placement: "right", page: "reports", title: "Report Builder",
    body: "Describe the report you need and Satori builds it as a real table — refine it in chat, download as Excel or PDF, and share it with teammates as view-only or editable.",
    narration: "This is the Report Builder. Describe the report you need and I'll build it as a real table. You can refine it in chat, download it as Excel or P D F, and share it with teammates." },
  { selector: '[data-tour="nav-dashboards"]', placement: "right", page: "dashboards", title: "Dashboard Builder",
    body: "Describe a dashboard and get live KPIs, charts and filters built from the warehouse. Click any chart to drill down, refine in chat, and share with your team.",
    narration: "Next, the Dashboard Builder. Describe what you want to monitor and I'll build live KPIs, charts and filters. Click any chart to drill into the detail behind it, refine it in chat, and share it with your team." },
  { selector: '[data-tour="nav-availability"]', placement: "right", page: "availability", title: "Availability Engine",
    body: "Live capacity across the whole workforce: who's allocated, who's partial, who's on the bench — backed by the weekly allocation plan and real timesheets.",
    narration: "This is the Availability Engine — live capacity across the whole workforce. It shows who's fully allocated, who has spare capacity, and who's on the bench, using the weekly allocation plan cross-checked against real timesheets." },
  { selector: '[data-tour="avail-toggle"]', placement: "bottom", page: "availability", title: "Heatmap, Bench Radar & more",
    body: "Flip to the Capacity heatmap to see every person's allocation week by week — including planned future weeks. The Bench Radar flags who frees up soon, and Create Task finds the best-fit person for new work.",
    narration: "Flip this toggle to the capacity heatmap to see every person's allocation week by week, including planned future weeks. The Bench Radar flags who frees up soon — before they hit the bench — and Create Task ranks the best-fit people for new work using skills tagged by practice heads." },
  { selector: '[data-tour="avail-toggle"]', placement: "bottom", page: "availability", title: "Every person, one click deep",
    body: "Click any employee for their full profile — projects, weekly allocation, plan-vs-actuals, 30-day attendance, skills — and export a staffing-ready PDF one-pager.",
    narration: "And click any employee to open their full profile — current projects, weekly allocation, plan versus actuals, thirty-day attendance, and skills. You can even export a staffing-ready P D F one-pager." },
  { selector: '[data-tour="data-as-of"]', placement: "bottom", page: "agent", title: "Know how fresh your data is",
    body: "The warehouse refreshes every 30 minutes. This pill always shows when data was last loaded, so you know exactly how current every answer is.",
    narration: "One more thing — the data behind all of this refreshes every thirty minutes, and this pill always shows when it was last loaded. So you know exactly how current every answer is." },
  { selector: '[data-tour="help"]', placement: "left", page: "agent", title: "Help & support, anytime",
    body: "Open Help for guidance, to replay this tour, or to report an issue straight to the team. That's the tour — you're ready!",
    narration: "If you ever need a hand, the Help menu has guidance, lets you replay this tour, and can send an issue report straight to the team. That's the tour — now go ahead and ask me anything!" },
];

const ONBOARDING_FLAG = "satori_onboarding_done_v2";

const OnboardingTour = ({ onNavigate }) => {
  const [active, setActive] = useState(false);
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState(null);
  // Narrated by the avatar via /api/tts; mute persists across sessions.
  const [voiceOn, setVoiceOn] = useState(() => {
    try { return localStorage.getItem("satori_tour_voice") !== "0"; } catch { return true; }
  });
  const [speaking, setSpeaking] = useState(false);
  const [narrLoading, setNarrLoading] = useState(false);
  const audioRef = useRef(null);
  const ttsCache = useRef({});

  const stopNarration = useCallback(() => {
    if (audioRef.current) { try { audioRef.current.pause(); } catch { /* noop */ } audioRef.current = null; }
    setSpeaking(false);
  }, []);

  const start = useCallback(() => { setIdx(0); setActive(true); }, []);
  const finish = useCallback(() => {
    setActive(false);
    stopNarration();
    try { localStorage.setItem(ONBOARDING_FLAG, "1"); } catch (_) { /* ignore */ }
  }, [stopNarration]);

  // Launch on the "replay" event, and auto-launch once for first-time users.
  useEffect(() => {
    const onStart = () => start();
    window.addEventListener("satori:start-tour", onStart);
    let t;
    try {
      if (!localStorage.getItem(ONBOARDING_FLAG)) t = setTimeout(start, 800);
    } catch (_) { /* ignore */ }
    return () => { window.removeEventListener("satori:start-tour", onStart); if (t) clearTimeout(t); };
  }, [start]);

  const step = ONBOARDING_STEPS[idx];

  // Steps carry a `page` so the tour actually SHOWS each area while talking
  // about it — switch view first, then measure (with retries, since the
  // target mounts after the page renders and may fetch before it appears).
  useEffect(() => {
    if (!active) return;
    if (step?.page && onNavigate) { try { onNavigate(step.page); } catch { /* noop */ } }
    const measure = () => {
      const sel = step?.selector;
      if (!sel) { setRect(null); return; }
      const el = document.querySelector(sel);
      const r = el ? el.getBoundingClientRect() : null;
      // Ignore hidden / zero-size targets (e.g. a freshness pill with no data).
      setRect(r && r.width > 4 && r.height > 4 ? r : null);
    };
    measure();
    const retries = [setTimeout(measure, 350), setTimeout(measure, 900), setTimeout(measure, 1800)];
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      retries.forEach(clearTimeout);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, idx, step, onNavigate]);

  // Speak the step's narration (cached per step so Back/Next don't re-bill TTS).
  useEffect(() => {
    if (!active || !voiceOn) { stopNarration(); return; }
    let cancelled = false;
    (async () => {
      stopNarration();
      const text = step?.narration || step?.body;
      if (!text) return;
      try {
        let b64 = ttsCache.current[idx];
        if (!b64) {
          setNarrLoading(true);
          const r = await fetch(`${API_BASE}/api/tts`, {
            method: "POST",
            headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!r.ok) return; // silent — the tour works fine without voice
          const j = await r.json();
          b64 = j.audio;
          ttsCache.current[idx] = b64;
        }
        if (cancelled || !b64) return;
        const audio = new Audio(`data:audio/wav;base64,${b64}`);
        audioRef.current = audio;
        audio.onended = () => { if (!cancelled) setSpeaking(false); };
        setSpeaking(true);
        audio.play().catch(() => setSpeaking(false));
      } catch { /* voice is best-effort */ }
      finally { if (!cancelled) setNarrLoading(false); }
    })();
    return () => { cancelled = true; setNarrLoading(false); stopNarration(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, idx, voiceOn]);

  const toggleVoice = () => {
    setVoiceOn(v => {
      const nv = !v;
      try { localStorage.setItem("satori_tour_voice", nv ? "1" : "0"); } catch { /* ignore */ }
      if (!nv) stopNarration();
      return nv;
    });
  };

  if (!active) return null;

  const last = idx >= ONBOARDING_STEPS.length - 1;
  const PAD = 8, CARD_W = 360, CARD_H = 250;
  const vw = window.innerWidth, vh = window.innerHeight;

  const spot = rect ? {
    top: Math.max(rect.top - PAD, 0), left: Math.max(rect.left - PAD, 0),
    width: rect.width + PAD * 2, height: rect.height + PAD * 2,
  } : null;

  let cardTop, cardLeft;
  if (!rect) {
    cardTop = vh / 2 - CARD_H / 2; cardLeft = vw / 2 - CARD_W / 2;
  } else {
    const place = step.placement || "bottom";
    if (place === "right")     { cardLeft = rect.right + 16; cardTop = rect.top; }
    else if (place === "left") { cardLeft = rect.left - CARD_W - 16; cardTop = rect.top + 8; }
    else if (place === "top")  { cardLeft = rect.left; cardTop = rect.top - CARD_H - 16; }
    else                       { cardLeft = rect.left; cardTop = rect.bottom + 16; }
    cardLeft = Math.min(Math.max(cardLeft, 12), vw - CARD_W - 12);
    cardTop  = Math.min(Math.max(cardTop, 12), vh - CARD_H - 12);
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000 }}>
      {spot ? (
        <div style={{
          position: "fixed", top: spot.top, left: spot.left, width: spot.width, height: spot.height,
          borderRadius: 12, boxShadow: "0 0 0 9999px rgba(15,23,42,0.62)", transition: "all 0.2s ease",
          pointerEvents: "none",
        }} />
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.62)", pointerEvents: "none" }} />
      )}

      {/* Blocks interaction with the app underneath while the tour is open. */}
      <div style={{ position: "fixed", inset: 0 }} />

      <div style={{
        position: "fixed", top: cardTop, left: cardLeft, width: CARD_W,
        background: COLORS.surface, borderRadius: 14, border: `1px solid ${COLORS.border}`,
        boxShadow: "0 24px 60px rgba(0,0,0,0.28)", padding: 18, zIndex: 2001,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <SatoriAvatar state={speaking ? "speaking" : narrLoading ? "thinking" : "idle"} audioLevel={speaking ? 0.55 : 0} size={46} />
            <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>{step.title}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button onClick={toggleVoice} title={voiceOn ? "Mute the narration" : "Unmute the narration"}
              style={{ background: "none", border: "none", cursor: "pointer", color: voiceOn ? COLORS.accent : COLORS.textMuted, display: "flex" }}>
              {voiceOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
            <button onClick={finish} title="Skip tour" style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, display: "flex" }}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: COLORS.textSecondary, marginBottom: 16, minHeight: 56 }}>
          {step.body}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 5 }}>
            {ONBOARDING_STEPS.map((_, i) => (
              <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: i === idx ? COLORS.accent : COLORS.border }} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {idx > 0 && (
              <button onClick={() => setIdx((i) => Math.max(0, i - 1))} style={{
                padding: "6px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
                background: COLORS.surface, color: COLORS.textSecondary, fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>Back</button>
            )}
            <button onClick={() => (last ? finish() : setIdx((i) => i + 1))} style={{
              padding: "6px 14px", borderRadius: 8, border: "none",
              background: COLORS.accent, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>{last ? "Got it" : "Next"}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Pulse survey + non-usage nudge (feedback loop) ─────────────────────────
const PULSE_LAST_KEY = "satori_pulse_last";
const PULSE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // ask at most every 30 days
const LAST_SEEN_KEY = "satori_last_seen";
const NUDGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;  // nudge if away 7+ days

const EngagementPrompts = () => {
  const [pulseOpen, setPulseOpen] = useState(false);
  const [pulseDone, setPulseDone] = useState(false);
  const [nudge, setNudge] = useState(false);

  // Non-usage nudge: compare the stored last-seen time, then stamp "now".
  useEffect(() => {
    try {
      const prev = parseInt(localStorage.getItem(LAST_SEEN_KEY) || "0", 10);
      const now = Date.now();
      if (prev && now - prev > NUDGE_THRESHOLD_MS) setNudge(true);
      localStorage.setItem(LAST_SEEN_KEY, String(now));
    } catch (_) { /* ignore */ }
  }, []);

  // Pulse: at most once per 30 days, only after onboarding, delayed so it
  // doesn't collide with the first-run tour.
  useEffect(() => {
    let t;
    try {
      const onboarded = localStorage.getItem(ONBOARDING_FLAG);
      const last = parseInt(localStorage.getItem(PULSE_LAST_KEY) || "0", 10);
      if (onboarded && Date.now() - last > PULSE_INTERVAL_MS) {
        t = setTimeout(() => setPulseOpen(true), 25000);
      }
    } catch (_) { /* ignore */ }
    return () => { if (t) clearTimeout(t); };
  }, []);

  const stampPulse = () => { try { localStorage.setItem(PULSE_LAST_KEY, String(Date.now())); } catch (_) { /* ignore */ } };
  const dismissPulse = () => { stampPulse(); setPulseOpen(false); };
  const submitPulse = async (score) => {
    stampPulse();
    try {
      const token = localStorage.getItem("token");
      const base = import.meta.env.VITE_API_BASE || "";
      await fetch(`${base}/api/pulse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ score }),
      });
    } catch (_) { /* non-blocking */ }
    setPulseDone(true);
    setTimeout(() => setPulseOpen(false), 1600);
  };

  return (
    <>
      {nudge && (
        <div style={{
          position: "fixed", top: 76, left: "50%", transform: "translateX(-50%)", zIndex: 1500,
          display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderRadius: 12,
          background: COLORS.surface, border: `1px solid ${COLORS.border}`, boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
          fontSize: 13, color: COLORS.textPrimary, maxWidth: "90%",
        }}>
          <Sparkles size={16} color={COLORS.accent} />
          <span>Welcome back! Ask Satori what changed in your data while you were away.</span>
          <button onClick={() => setNudge(false)} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, display: "flex" }}>
            <X size={15} />
          </button>
        </div>
      )}

      {pulseOpen && (
        <div style={{
          position: "fixed", bottom: 28, left: 28, zIndex: 1500, width: 300,
          background: COLORS.surface, borderRadius: 14, border: `1px solid ${COLORS.border}`,
          boxShadow: "0 20px 50px rgba(0,0,0,0.22)", padding: 16,
        }}>
          {pulseDone ? (
            <div style={{ textAlign: "center", padding: "8px 0", color: COLORS.textPrimary }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>🙏</div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Thanks for your feedback!</div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>Quick pulse</div>
                <button onClick={dismissPulse} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, display: "flex" }}>
                  <X size={15} />
                </button>
              </div>
              <div style={{ fontSize: 12.5, color: COLORS.textSecondary, marginBottom: 12 }}>
                How useful is Satori for your work so far?
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "space-between" }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => submitPulse(n)} style={{
                    flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${COLORS.border}`,
                    background: COLORS.surfaceAlt, color: COLORS.textPrimary, fontSize: 14, fontWeight: 600, cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.border; e.currentTarget.style.color = COLORS.textPrimary; }}
                  >{n}</button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: COLORS.textMuted }}>
                <span>Not useful</span><span>Very useful</span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
};

const StatusBadge = ({ status }) => {
  const config = {
    healthy: { bg: "#ECFDF5", color: "#059669", label: "Healthy" },
    warning: { bg: "#FFFBEB", color: "#D97706", label: "Warning" },
    critical: { bg: "#FEF2F2", color: "#DC2626", label: "Critical" },
    ontrack: { bg: "#EFF6FF", color: "#2563EB", label: "On Track" },
  };
  const c = config[status] || config.healthy;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: c.color, background: c.bg, padding: "3px 10px", borderRadius: 20 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.color }} />
      {c.label}
    </span>
  );
};

// ─── Mock Data ───
const financeData = {
  revenue: [
    { month: "Jul", actual: 12.4, budget: 11.8 }, { month: "Aug", actual: 13.1, budget: 12.2 },
    { month: "Sep", actual: 11.8, budget: 12.5 }, { month: "Oct", actual: 14.2, budget: 13.0 },
    { month: "Nov", actual: 15.1, budget: 13.5 }, { month: "Dec", actual: 16.8, budget: 14.0 },
    { month: "Jan", actual: 14.5, budget: 14.2 }, { month: "Feb", actual: 15.9, budget: 14.8 },
  ],
  expenses: [
    { name: "COGS", value: 42 }, { name: "Operations", value: 18 },
    { name: "Marketing", value: 12 }, { name: "R&D", value: 15 }, { name: "Admin", value: 13 },
  ],
  cashflow: [
    { month: "Jul", inflow: 14.2, outflow: 11.8 }, { month: "Aug", inflow: 15.1, outflow: 12.3 },
    { month: "Sep", inflow: 13.5, outflow: 12.8 }, { month: "Oct", inflow: 16.0, outflow: 13.1 },
    { month: "Nov", inflow: 17.2, outflow: 13.8 }, { month: "Dec", inflow: 18.5, outflow: 14.2 },
    { month: "Jan", inflow: 16.8, outflow: 14.5 }, { month: "Feb", inflow: 17.9, outflow: 14.9 },
  ],
};

const procurementData = {
  spend: [
    { month: "Jul", direct: 5.2, indirect: 2.1 }, { month: "Aug", direct: 5.8, indirect: 2.3 },
    { month: "Sep", direct: 5.5, indirect: 2.0 }, { month: "Oct", direct: 6.1, indirect: 2.4 },
    { month: "Nov", direct: 6.4, indirect: 2.2 }, { month: "Dec", direct: 6.8, indirect: 2.5 },
    { month: "Jan", direct: 6.2, indirect: 2.3 }, { month: "Feb", direct: 6.5, indirect: 2.4 },
  ],
  vendors: [
    { name: "Supplier A", score: 94, spend: 2.4, onTime: 97 },
    { name: "Supplier B", score: 88, spend: 1.8, onTime: 92 },
    { name: "Supplier C", score: 91, spend: 1.5, onTime: 95 },
    { name: "Supplier D", score: 76, spend: 1.2, onTime: 84 },
    { name: "Supplier E", score: 82, spend: 0.9, onTime: 89 },
  ],
  categories: [
    { name: "Raw Materials", value: 35 }, { name: "Components", value: 25 },
    { name: "Services", value: 20 }, { name: "MRO", value: 12 }, { name: "IT", value: 8 },
  ],
};

const supplyChainData = {
  fulfillment: [
    { month: "Jul", rate: 94.2, target: 96 }, { month: "Aug", rate: 95.1, target: 96 },
    { month: "Sep", rate: 93.8, target: 96 }, { month: "Oct", rate: 96.3, target: 96 },
    { month: "Nov", rate: 96.8, target: 96 }, { month: "Dec", rate: 95.5, target: 96 },
    { month: "Jan", rate: 97.1, target: 96 }, { month: "Feb", rate: 96.9, target: 96 },
  ],
  inventory: [
    { category: "Raw Materials", days: 18, optimal: 15 },
    { category: "WIP", days: 8, optimal: 6 },
    { category: "Finished Goods", days: 22, optimal: 20 },
    { category: "Spare Parts", days: 35, optimal: 30 },
  ],
};

const warehouseData = {
  utilization: [
    { zone: "Zone A", used: 87, capacity: 100 }, { zone: "Zone B", used: 72, capacity: 100 },
    { zone: "Zone C", used: 95, capacity: 100 }, { zone: "Zone D", used: 61, capacity: 100 },
    { zone: "Zone E", used: 78, capacity: 100 },
  ],
  throughput: [
    { day: "Mon", inbound: 420, outbound: 385 }, { day: "Tue", inbound: 380, outbound: 410 },
    { day: "Wed", inbound: 450, outbound: 420 }, { day: "Thu", inbound: 410, outbound: 440 },
    { day: "Fri", inbound: 390, outbound: 470 }, { day: "Sat", inbound: 280, outbound: 310 },
    { day: "Sun", inbound: 120, outbound: 150 },
  ],
};

const manufacturingData = {
  oee: [
    { line: "Line 1", availability: 92, performance: 88, quality: 97 },
    { line: "Line 2", availability: 88, performance: 91, quality: 95 },
    { line: "Line 3", availability: 95, performance: 85, quality: 98 },
    { line: "Line 4", availability: 90, performance: 87, quality: 96 },
  ],
  production: [
    { month: "Jul", planned: 1200, actual: 1150 }, { month: "Aug", planned: 1300, actual: 1280 },
    { month: "Sep", planned: 1250, actual: 1190 }, { month: "Oct", planned: 1400, actual: 1380 },
    { month: "Nov", planned: 1350, actual: 1340 }, { month: "Dec", planned: 1500, actual: 1460 },
    { month: "Jan", planned: 1450, actual: 1420 }, { month: "Feb", planned: 1380, actual: 1360 },
  ],
};

const salesData = {
  pipeline: [
    { stage: "Lead", value: 8.2, count: 142 }, { stage: "Qualified", value: 5.4, count: 87 },
    { stage: "Proposal", value: 3.8, count: 54 }, { stage: "Negotiation", value: 2.1, count: 28 },
    { stage: "Closed Won", value: 1.5, count: 18 },
  ],
  regional: [
    { region: "North America", revenue: 12.4 }, { region: "Europe", revenue: 8.7 },
    { region: "APAC", revenue: 6.2 }, { region: "MEA", revenue: 3.8 }, { region: "LATAM", revenue: 2.1 },
  ],
};

const hrData = {
  headcount: [
    { dept: "Engineering", count: 245, open: 12 }, { dept: "Sales", count: 180, open: 8 },
    { dept: "Operations", count: 156, open: 5 }, { dept: "Finance", count: 82, open: 3 },
    { dept: "HR", count: 45, open: 2 }, { dept: "Marketing", count: 68, open: 4 },
  ],
  retention: [
    { month: "Jul", rate: 96.2 }, { month: "Aug", rate: 95.8 }, { month: "Sep", rate: 96.5 },
    { month: "Oct", rate: 95.1 }, { month: "Nov", rate: 96.0 }, { month: "Dec", rate: 94.8 },
    { month: "Jan", rate: 95.5 }, { month: "Feb", rate: 96.1 },
  ],
};

const qualityData = {
  defects: [
    { month: "Jul", rate: 1.8, target: 2.0 }, { month: "Aug", rate: 1.5, target: 2.0 },
    { month: "Sep", rate: 2.1, target: 2.0 }, { month: "Oct", rate: 1.7, target: 2.0 },
    { month: "Nov", rate: 1.4, target: 2.0 }, { month: "Dec", rate: 1.6, target: 2.0 },
    { month: "Jan", rate: 1.3, target: 2.0 }, { month: "Feb", rate: 1.2, target: 2.0 },
  ],
  metrics: [
    { subject: "On-Time Delivery", A: 95, fullMark: 100 },
    { subject: "Defect Rate", A: 92, fullMark: 100 },
    { subject: "First Pass Yield", A: 88, fullMark: 100 },
    { subject: "Customer Complaints", A: 85, fullMark: 100 },
    { subject: "Audit Score", A: 96, fullMark: 100 },
    { subject: "CAPA Closure", A: 90, fullMark: 100 },
  ],
};

const boardData = {
  overview: [
    { month: "Jul", revenue: 12.4, profit: 3.2, margin: 25.8 },
    { month: "Aug", revenue: 13.1, profit: 3.5, margin: 26.7 },
    { month: "Sep", revenue: 11.8, profit: 2.9, margin: 24.6 },
    { month: "Oct", revenue: 14.2, profit: 3.8, margin: 26.8 },
    { month: "Nov", revenue: 15.1, profit: 4.1, margin: 27.2 },
    { month: "Dec", revenue: 16.8, profit: 4.7, margin: 28.0 },
    { month: "Jan", revenue: 14.5, profit: 3.9, margin: 26.9 },
    { month: "Feb", revenue: 15.9, profit: 4.3, margin: 27.0 },
  ],
  health: [
    { function: "Finance", score: 92, status: "healthy" },
    { function: "Sales", score: 87, status: "healthy" },
    { function: "Procurement", score: 78, status: "warning" },
    { function: "Supply Chain", score: 85, status: "healthy" },
    { function: "Manufacturing", score: 91, status: "healthy" },
    { function: "Warehouse", score: 74, status: "warning" },
    { function: "HR", score: 89, status: "healthy" },
    { function: "Quality", score: 94, status: "healthy" },
  ],
};

// ─── Chat Agent Component ───
const ChatAgent = ({ isOpen, onClose, dashboardContext }) => {
  const [messages, setMessages] = useState([
    { role: "assistant", text: `Welcome to Satori AI Assistant. I'm connected to your ${dashboardContext || "Executive"} dashboard and ready to help you analyze data, generate insights, and answer questions. How can I assist you?` }
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setMessages([
      { role: "assistant", text: `Welcome to Satori AI Assistant. I'm connected to your ${dashboardContext || "Executive"} dashboard and ready to help you analyze data, generate insights, and answer questions. How can I assist you?` }
    ]);
  }, [dashboardContext]);

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg = input.trim();
    setMessages(prev => [...prev, { role: "user", text: userMsg }]);
    setInput("");
    setIsTyping(true);
    setTimeout(() => {
      const responses = [
        `Based on the ${dashboardContext} data, I can see several key trends. Revenue has increased 8.3% quarter-over-quarter, with the strongest performance in December. Would you like me to drill deeper into any specific metric?`,
        `Looking at your ${dashboardContext} KPIs, the overall health score is strong at 89/100. I've identified 2 areas needing attention: inventory turnover and supplier on-time delivery. Shall I generate a detailed action plan?`,
        `I've analyzed the ${dashboardContext} dashboard data. Here's a quick summary: key metrics are trending positively with a 12% improvement in operational efficiency. The AI model predicts continued growth if current trends hold. Want me to create a forecast?`,
      ];
      setMessages(prev => [...prev, { role: "assistant", text: responses[Math.floor(Math.random() * responses.length)] }]);
      setIsTyping(false);
    }, 1500);
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, width: 400, height: 540,
      background: COLORS.surface, borderRadius: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
      display: "flex", flexDirection: "column", zIndex: 1000, overflow: "hidden",
      border: `1px solid ${COLORS.border}`
    }}>
      {/* Header */}
      <div style={{
        background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accentDark})`,
        padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(138,196,65,0.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Bot size={20} color="#fff" />
          </div>
          <div>
            <div style={{ color: "#fff", fontWeight: 600, fontSize: 14, fontFamily: "'Poppins', sans-serif" }}>Satori AI</div>
            <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>Enterprise AI Assistant &middot; TMC</div>
          </div>
        </div>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: 6, cursor: "pointer", color: "#fff" }}>
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "80%", padding: "10px 14px", borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
              background: msg.role === "user" ? COLORS.primary : "#F1F5F9",
              color: msg.role === "user" ? "#fff" : COLORS.textPrimary, fontSize: 13, lineHeight: 1.5
            }}>
              {msg.text}
            </div>
          </div>
        ))}
        {isTyping && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ background: COLORS.surfaceAlt, padding: "10px 14px", borderRadius: "16px 16px 16px 4px", fontSize: 13 }}>
              <span style={{ display: "inline-flex", gap: 4 }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: 6, height: 6, borderRadius: "50%", background: COLORS.textMuted,
                    animation: `bounce 1.4s infinite ease-in-out both`,
                    animationDelay: `${i * 0.16}s`
                  }} />
                ))}
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "12px 16px", borderTop: `1px solid ${COLORS.border}`, display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSend()}
          placeholder="Ask about your dashboard data..."
          style={{
            flex: 1, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "10px 14px",
            fontSize: 13, outline: "none", background: COLORS.surfaceAlt
          }}
        />
        <button onClick={handleSend} style={{
          width: 40, height: 40, borderRadius: 12, border: "none",
          background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`,
          color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};

// ─── Voice Agent Component ───
// ─── Real Voice Modal (ports Old Satori) ──────────────────────────────────────
// Browser <-> Gemini Live API via WebSocket. Mic capture as PCM16 -> WS. Audio
// output PCM played back. Tool calls (BigQuery SQL) round-trip through
// /api/voice/query on the backend.
const GEMINI_WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const VoiceModal = ({ open, onClose }) => {
  const [state, setState] = useState("connecting"); // connecting | listening | speaking | closing
  const [statusText, setStatusText] = useState("Connecting to Satori\u2026");

  const [audioLevel, setAudioLevel] = useState(0);  // 0..1, drives mascot mouth
  const wsRef = useRef(null);
  const captureCtxRef = useRef(null);
  const playCtxRef = useRef(null);
  const analyserRef = useRef(null);      // AnalyserNode tap on playCtx output
  const amplitudeRafRef = useRef(null);   // requestAnimationFrame handle
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const isSpeakingRef = useRef(false);
  const setupDoneRef = useRef(false);
  const setupTimeoutRef = useRef(null);
  const closingRef = useRef(false);
  const activeSourcesRef = useRef([]);
  const turnEndedRef = useRef(false);
  const pendingHangupRef = useRef(false);
  const hangupWatchdogRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Mascot mouth amplitude loop -- ~60fps RMS of TTS audio.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const a = analyserRef.current;
      if (a) {
        const bins = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(bins);
        let sum = 0; const n = Math.min(32, bins.length);
        for (let i = 0; i < n; i++) sum += bins[i] * bins[i];
        const rms = Math.sqrt(sum / n) / 255;
        const level = Math.max(0, Math.min(1, Math.pow(rms, 0.6) * 1.8));
        setAudioLevel(level);
      } else {
        setAudioLevel(0);
      }
      amplitudeRafRef.current = requestAnimationFrame(tick);
    };
    amplitudeRafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (amplitudeRafRef.current) cancelAnimationFrame(amplitudeRafRef.current);
      amplitudeRafRef.current = null;
      setAudioLevel(0);
    };
  }, [open]);

  const start = async () => {
    closingRef.current = false;
    setupDoneRef.current = false;
    setState("connecting");
    setStatusText("Connecting to Satori\u2026");

    const apiBase = import.meta.env.VITE_API_BASE || "";
    const token = localStorage.getItem("token");
    let config;
    try {
      const res = await fetch(`${apiBase}/api/voice/session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Failed to get session config");
      config = await res.json();
    } catch (e) {
      setStatusText(e?.message || "Failed to get session config.");
      setTimeout(stop, 3000);
      return;
    }

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      captureCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      playCtxRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      try {
        const a = playCtxRef.current.createAnalyser();
        a.fftSize = 256;
        a.smoothingTimeConstant = 0.6;
        a.connect(playCtxRef.current.destination);
        analyserRef.current = a;
      } catch (e) {
        console.warn("[VoiceModal] analyser setup failed", e);
        analyserRef.current = null;
      }
      sourceRef.current = captureCtxRef.current.createMediaStreamSource(streamRef.current);
      processorRef.current = captureCtxRef.current.createScriptProcessor(4096, 1, 1);
      sourceRef.current.connect(processorRef.current);
      processorRef.current.connect(captureCtxRef.current.destination);
    } catch {
      setStatusText("Microphone permission denied.");
      setTimeout(stop, 3000);
      return;
    }

    const ws = new WebSocket(`${GEMINI_WS_BASE}?key=${config.apiKey}`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: config.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } },
          },
          systemInstruction: { parts: [{ text: config.systemInstruction }] },
          tools: config.tools || [],
        },
      }));
      setupTimeoutRef.current = setTimeout(() => {
        if (!setupDoneRef.current) { setStatusText("Setup timed out."); stop(); }
      }, 8000);
    };

    ws.onmessage = async (evt) => {
      let data;
      try { data = JSON.parse(typeof evt.data === "string" ? evt.data : await evt.data.text()); } catch { return; }

      // Log non-audio events so we can see whether toolCalls are actually firing.
      // Drop modelTurn audio chunks (they spam the console at ~50 hz).
      const isAudioOnly = data.serverContent?.modelTurn?.parts?.every?.(p => p.inlineData?.data && !p.text);
      if (!isAudioOnly) {
        console.log("[VoiceModal WS]", data);
      }

      if (data.setupComplete) {
        setupDoneRef.current = true;
        if (setupTimeoutRef.current) clearTimeout(setupTimeoutRef.current);
        // Trigger the model to greet the user. The voice system prompt
        // tells it to say the right opening line in English or Urdu.
        // Treating this as a normal user turn means the audio response
        // comes back through the existing speaker pipeline.
        try {
          ws.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "Greet the user now with your opening line." }] }],
              turnComplete: true,
            },
          }));
          // Set busy so the mic doesn't capture during the greeting playback.
          isSpeakingRef.current = true;
          setState("speaking");
          setStatusText("Satori is greeting you\u2026");
        } catch (e) {
          setState("listening");
          setStatusText("Listening\u2026 speak now");
        }
        return;
      }

      if (data.toolCall?.functionCalls?.length) {
        // Voice agent gating: mic stops capturing while the agent is busy.
        isSpeakingRef.current = true;
        const responses = [];
        let sawEndCall = false;
        for (const fc of data.toolCall.functionCalls) {
          if (fc.name === "end_call") {
            // The model is signaling that the user said goodbye. Acknowledge
            // the tool call so Gemini moves on, then mark the connection
            // for shutdown once audio playback drains.
            sawEndCall = true;
            responses.push({ id: fc.id, name: fc.name, response: { output: "Goodbye accepted." } });
            continue;
          }
          // BigQuery tool call
          setState("speaking");
          setStatusText("Satori is consulting BigQuery\u2026");
          try {
            const r = await fetch(`${apiBase}/api/voice/query`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ sql: fc.args?.sql || "" }),
            });
            const json = await r.json();
            responses.push({ id: fc.id, name: fc.name, response: { output: json.result || "(no result)" } });
          } catch (err) {
            responses.push({ id: fc.id, name: fc.name, response: { output: "Query failed: " + (err?.message || "unknown") } });
          }
        }
        ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        if (sawEndCall) {
          // Flag for hang-up after current audio finishes.
          pendingHangupRef.current = true;
          setStatusText("Goodbye\u2026");
          // ROBUST HANG-UP: the model is instructed to SPEAK its farewell
          // first and only THEN call end_call, so by the time this tool call
          // arrives the goodbye audio has usually already drained \u2014 meaning
          // src.onended won't fire again to trigger the close. Rather than
          // depend on onended/turnComplete ordering, run a watchdog that
          // hangs up once audio drains (with a short grace so the farewell
          // finishes), or after a hard max wait regardless.
          if (hangupWatchdogRef.current) clearInterval(hangupWatchdogRef.current);
          const hangupStartedAt = Date.now();
          hangupWatchdogRef.current = setInterval(() => {
            if (closingRef.current) {
              clearInterval(hangupWatchdogRef.current);
              hangupWatchdogRef.current = null;
              return;
            }
            const drained = activeSourcesRef.current.length === 0;
            const elapsed = Date.now() - hangupStartedAt;
            if ((drained && elapsed > 600) || elapsed > 10000) {
              clearInterval(hangupWatchdogRef.current);
              hangupWatchdogRef.current = null;
              if (pendingHangupRef.current) {
                pendingHangupRef.current = false;
                setStatusText("Goodbye");
                try { stop(); } catch {}
              }
            }
          }, 300);
        } else {
          setStatusText("Working on your answer\u2026");
        }
        return;
      }

      if (data.serverContent) {
        const sc = data.serverContent;
        if (sc.modelTurn?.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData?.data) {
              if (!isSpeakingRef.current) {
                isSpeakingRef.current = true;
                setState("speaking");
                setStatusText("Satori is speaking\u2026");
              }
              playPcm(part.inlineData.data);
            }
          }
        }
        if (sc.turnComplete) {
          // Gemini signals "I'm done emitting audio" but the chunks are still
          // queued ahead. Flip the mic gate OFF only after the last queued
          // chunk finishes playing (handled in src.onended). If audio is
          // already drained, drop straight back to listening.
          turnEndedRef.current = true;
          if (activeSourcesRef.current.length === 0) {
            isSpeakingRef.current = false;
            turnEndedRef.current = false;
            setState("listening");
            setStatusText("Listening\u2026 speak now");
            nextPlayTimeRef.current = 0;
          }
        }
        if (sc.interrupted) {
          // User interrupted Gemini mid-sentence (or VAD detected speech).
          // Stop every queued chunk so we don't keep talking AT the user.
          for (const s of activeSourcesRef.current) { try { s.stop(); } catch {} }
          activeSourcesRef.current = [];
          isSpeakingRef.current = false;
          turnEndedRef.current = false;
          nextPlayTimeRef.current = 0;
          setState("listening");
          setStatusText("Listening\u2026 speak now");
        }
      }
    };

    ws.onerror = () => { if (!closingRef.current) setStatusText("Connection error \u2014 see console."); };
    ws.onclose = (ev) => {
      if (closingRef.current) return;
      const reason = ev.reason || (
        ev.code === 1008 ? "policy violation (API key or model)" :
        ev.code === 1011 ? "server error" :
        ev.code === 1006 ? "abnormal close (network or auth)" :
        ev.code >= 4000  ? "auth or model error" :
        "unknown"
      );
      setStatusText(`Disconnected (${ev.code}: ${reason})`);
      setTimeout(stop, 4000);
    };

    const captureSR = captureCtxRef.current.sampleRate;
    processorRef.current.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !setupDoneRef.current) return;
      // Voice agent gating: while the agent is busy (speaking, consulting
      // BigQuery, or otherwise mid-turn) DROP captured audio. This guarantees
      // the agent only listens for the next prompt AFTER the current one
      // wraps up — prevents barge-in and self-hearing through the speaker.
      if (isSpeakingRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
      let samples = pcm16;
      if (captureSR !== 16000) {
        const ratio = captureSR / 16000;
        const outLen = Math.floor(pcm16.length / ratio);
        samples = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) samples[i] = pcm16[Math.round(i * ratio)];
      }
      const bytes = new Uint8Array(samples.buffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({
        realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: btoa(bin) } },
      }));
    };
  };

  const playPcm = (b64) => {
    const ctx = playCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") { try { ctx.resume(); } catch {} }
    try {
      const raw = atob(b64);
      // PCM16 needs an even byte count. Drop a trailing odd byte rather than
      // tossing the whole frame on chunk-boundary alignment.
      const len = raw.length & ~1;
      if (len < 2) return;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = raw.charCodeAt(i);
      const pcm16 = new Int16Array(bytes.buffer, 0, len / 2);
      const floats = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) floats[i] = pcm16[i] / 32768.0;
      const buf = ctx.createBuffer(1, floats.length, 24000);
      buf.copyToChannel(floats, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (analyserRef.current) {
        src.connect(analyserRef.current);
      } else {
        src.connect(ctx.destination);
      }

      // Scheduling: queue chunks back-to-back. If the playhead is behind
      // realtime (first chunk of a turn, or recovery after a stall), start
      // a hair after now to avoid a click. Otherwise let the queue extend
      // naturally — the model is allowed to stay several seconds ahead
      // during a long answer, that is NORMAL and not a glitch. The previous
      // 500ms cap was truncating long sentences.
      const now = ctx.currentTime;
      const base = (nextPlayTimeRef.current && nextPlayTimeRef.current > now)
        ? nextPlayTimeRef.current
        : now + 0.015;
      src.start(base);
      nextPlayTimeRef.current = base + buf.duration;

      activeSourcesRef.current.push(src);
      src.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== src);
        // When the LAST queued chunk finishes AND Gemini already signaled
        // turnComplete, only THEN flip the mic gate off. This prevents the
        // mic from re-enabling while the speaker is still mid-sentence,
        // which is what caused the agent to "speak over itself".
        if (activeSourcesRef.current.length === 0 && turnEndedRef.current) {
          isSpeakingRef.current = false;
          turnEndedRef.current = false;
          nextPlayTimeRef.current = 0;
          if (pendingHangupRef.current) {
            // Voice agent goodbye: drop straight to closing.
            pendingHangupRef.current = false;
            setStatusText("Goodbye");
            setTimeout(() => { try { stop(); } catch {} }, 400);
          } else {
            setState("listening");
            setStatusText("Listening\u2026 speak now");
          }
        }
      };
    } catch (e) {
      console.warn("[VoiceModal] playPcm error", e);
    }
  };

  const stop = () => {
    closingRef.current = true;
    setState("closing");
    setupDoneRef.current = false;
    // Cancel any audio chunks queued for future playback so the modal
    // closes cleanly instead of continuing to speak for 5 seconds.
    for (const s of (activeSourcesRef.current || [])) {
      try { s.stop(); } catch {}
    }
    activeSourcesRef.current = [];
    try { processorRef.current?.disconnect(); } catch {}
    try { sourceRef.current?.disconnect(); } catch {}
    streamRef.current?.getTracks().forEach(t => t.stop());
    try { captureCtxRef.current?.close(); } catch {}
    try { analyserRef.current?.disconnect(); } catch {}
    analyserRef.current = null;
    try { playCtxRef.current?.close(); } catch {}
    try { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close(); } catch {}
    processorRef.current = null; sourceRef.current = null; streamRef.current = null;
    captureCtxRef.current = null; playCtxRef.current = null; wsRef.current = null;
    nextPlayTimeRef.current = 0;
    pendingHangupRef.current = false;
    if (hangupWatchdogRef.current) { clearInterval(hangupWatchdogRef.current); hangupWatchdogRef.current = null; }
    if (setupTimeoutRef.current) clearTimeout(setupTimeoutRef.current);
    onClose?.();
  };

  if (!open) return null;
  return (
    <div onClick={stop} style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}>
        <div style={{ margin: "0 auto 24px", display: "inline-flex" }}>
          <SatoriAvatar
            state={state === "connecting" ? "thinking" : state === "closing" ? "idle" : state}
            audioLevel={audioLevel}
            size={232}
            ariaLabel="Satori voice agent"
          />
        </div>
        <div style={{ color: "#e2e8f0", fontSize: 14, maxWidth: 420 }}>{statusText}</div>
        <button onClick={stop} style={{
          marginTop: 24, display: "inline-flex", alignItems: "center", gap: 8,
          padding: "8px 20px", borderRadius: 999,
          background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)",
          color: "#fca5a5", fontSize: 13, cursor: "pointer",
        }}>
          <X size={15} /> End call
        </button>
      </div>
    </div>
  );
};


// ─── Floating Mic + Help buttons (ports Old Satori FabButtons) ──────────────
const HELP_TOPICS = [
  "How do I ask a question about my data?",
  "How do I build a dashboard?",
  "How do I generate a report?",
  "How do I use the voice agent?",
  "What is Schema Settings?",
  "What data is available in Satori?",
];

const FabButtons = ({ pageLabel } = {}) => {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpBusy, setHelpBusy] = useState(false);
  const [helpAnswer, setHelpAnswer] = useState("");
  const [helpQuestion, setHelpQuestion] = useState("");
  // "Report an issue" modal state
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState("bug");
  const [reportMsg, setReportMsg] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(false);
  const apiBase = import.meta.env.VITE_API_BASE || "";

  const submitReport = async () => {
    const message = reportMsg.trim();
    if (!message) return;
    setReportBusy(true);
    try {
      const token = localStorage.getItem("token");
      const r = await fetch(`${apiBase}/api/support/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          message, category: reportCategory,
          page: pageLabel || "", url: window.location.href,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReportDone(true);
      setReportMsg("");
      setTimeout(() => { setReportOpen(false); setReportDone(false); }, 1800);
    } catch (e) {
      alert("Couldn't send your report: " + (e?.message || "unknown error"));
    } finally {
      setReportBusy(false);
    }
  };

  const askHelp = async (q) => {
    setHelpBusy(true); setHelpAnswer(""); setHelpQuestion(q);
    try {
      const r = await fetch(`${apiBase}/api/help`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await r.json();
      setHelpAnswer((data.answer || "(no response)").replace(/<[^>]+>/g, ""));
    } catch (e) {
      setHelpAnswer("Failed: " + (e?.message || "unknown"));
    } finally { setHelpBusy(false); }
  };

  const fabStyle = {
    width: 56, height: 56, borderRadius: "50%", border: "none", cursor: "pointer",
    background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.teal})`,
    color: "#fff", boxShadow: "0 10px 28px rgba(15,23,42,0.25)",
    display: "flex", alignItems: "center", justifyContent: "center",
    transition: "transform 0.15s",
  };

  return (
    <>
      <div style={{
        position: "fixed", bottom: 28, right: 28, zIndex: 900,
        display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end",
      }}>
        <button
          data-tour="help"
          onClick={() => setHelpOpen(o => !o)}
          title="Help — how to use Satori"
          style={fabStyle}
          onMouseEnter={e => e.currentTarget.style.transform = "scale(1.05)"}
          onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
        ><HelpCircle size={24} /></button>
        <button
          onClick={() => setVoiceOpen(true)}
          title="Talk to Satori (voice)"
          style={fabStyle}
          onMouseEnter={e => e.currentTarget.style.transform = "scale(1.05)"}
          onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
        ><Mic size={24} /></button>
        <SatoriIntroHint />
      </div>

      {helpOpen && (
        <div style={{
          position: "fixed", bottom: 110, right: 28, zIndex: 900,
          width: 360, maxHeight: 520, borderRadius: 16, overflow: "hidden",
          background: COLORS.surface, border: `1px solid ${COLORS.border}`,
          boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            padding: "12px 16px", color: "#fff",
            background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.teal})`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Need a hand?</div>
            <button onClick={() => setHelpOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.85)", display: "flex", alignItems: "center" }}>
              <X size={15} />
            </button>
          </div>

          {/* Replay the onboarding tour */}
          <button
            onClick={() => { setHelpOpen(false); window.dispatchEvent(new CustomEvent("satori:start-tour")); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "10px 16px", border: "none", borderBottom: `1px solid ${COLORS.border}`,
              background: COLORS.surfaceAlt, color: COLORS.textPrimary, cursor: "pointer",
              fontSize: 12.5, fontWeight: 600, textAlign: "left",
            }}
          >
            <Sparkles size={14} color={COLORS.accent} /> Take the product tour
          </button>

          {/* Report an issue */}
          <button
            onClick={() => { setReportDone(false); setReportOpen(true); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "10px 16px", border: "none", borderBottom: `1px solid ${COLORS.border}`,
              background: COLORS.surface, color: COLORS.textPrimary, cursor: "pointer",
              fontSize: 12.5, fontWeight: 600, textAlign: "left",
            }}
          >
            <AlertTriangle size={14} color={COLORS.danger} /> Report an issue
          </button>

          {/* Custom question input */}
          <div style={{ padding: 10, borderBottom: `1px solid ${COLORS.border}` }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="Or type your own question..."
                value={helpQuestion}
                onChange={(e) => setHelpQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && helpQuestion.trim()) askHelp(helpQuestion.trim()); }}
                style={{
                  flex: 1, padding: "8px 10px", borderRadius: 8,
                  border: `1px solid ${COLORS.border}`, fontSize: 12.5, background: COLORS.surface,
                }}
              />
              <button
                disabled={helpBusy || !helpQuestion.trim()}
                onClick={() => askHelp(helpQuestion.trim())}
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "none",
                  background: helpBusy || !helpQuestion.trim() ? "#E2E8F0" : COLORS.accent,
                  color: helpBusy || !helpQuestion.trim() ? COLORS.textMuted : "#fff",
                  fontSize: 12, fontWeight: 600, cursor: helpBusy ? "default" : "pointer",
                }}
              >Ask</button>
            </div>
          </div>

          {/* Topic suggestions OR answer */}
          <div style={{ padding: 10, overflowY: "auto", flex: 1 }}>
            {helpBusy && (
              <div style={{ padding: 20, textAlign: "center", color: COLORS.textMuted, fontSize: 12 }}>
                <Activity size={16} style={{ animation: "spin 1s linear infinite" }} /> Asking Satori…
              </div>
            )}
            {!helpBusy && helpAnswer && (
              <>
                <div style={{
                  padding: 10, background: COLORS.surfaceAlt, borderRadius: 10,
                  fontSize: 11.5, fontStyle: "italic", color: COLORS.textSecondary, marginBottom: 6,
                }}>
                  Q: {helpQuestion}
                </div>
                <div style={{
                  padding: 12, background: `${COLORS.accent}10`, borderLeft: `3px solid ${COLORS.accent}`,
                  borderRadius: 8, fontSize: 13, color: COLORS.textPrimary, lineHeight: 1.55, whiteSpace: "pre-wrap",
                }}>{helpAnswer}</div>
                <button onClick={() => { setHelpAnswer(""); setHelpQuestion(""); }} style={{
                  marginTop: 10, padding: "6px 10px", borderRadius: 8, border: "none",
                  background: "transparent", color: COLORS.textSecondary, fontSize: 11.5, cursor: "pointer",
                }}>← Back to topics</button>
              </>
            )}
            {!helpBusy && !helpAnswer && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {HELP_TOPICS.map(t => (
                  <button key={t} onClick={() => askHelp(t)} style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "8px 12px", borderRadius: 8, border: "none",
                    background: COLORS.surfaceAlt, color: COLORS.textPrimary, fontSize: 12, cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = `${COLORS.accent}15`; e.currentTarget.style.color = COLORS.accent; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = COLORS.surfaceAlt; e.currentTarget.style.color = COLORS.textPrimary; }}
                  >{t}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Report an issue modal */}
      {reportOpen && (
        <div
          onClick={() => !reportBusy && setReportOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15,23,42,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{
            width: 460, maxWidth: "100%", background: COLORS.surface, borderRadius: 16,
            border: `1px solid ${COLORS.border}`, boxShadow: "0 24px 60px rgba(0,0,0,0.28)", overflow: "hidden",
          }}>
            <div style={{
              padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between",
              borderBottom: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>
                <AlertTriangle size={16} color={COLORS.danger} /> Report an issue
              </div>
              <button onClick={() => !reportBusy && setReportOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, display: "flex" }}>
                <X size={16} />
              </button>
            </div>

            {reportDone ? (
              <div style={{ padding: 28, textAlign: "center", color: COLORS.textPrimary }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>✅</div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Thanks — your report was sent.</div>
                <div style={{ fontSize: 12.5, color: COLORS.textSecondary }}>The team will take a look. You can keep working.</div>
              </div>
            ) : (
              <div style={{ padding: 18 }}>
                <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginBottom: 14 }}>
                  We'll automatically include the page you're on and your browser details to help us debug.
                </div>
                <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>Type</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0 14px" }}>
                  {[
                    { id: "bug", label: "Something's broken" },
                    { id: "data", label: "Data looks wrong" },
                    { id: "feature", label: "Feature request" },
                    { id: "other", label: "Other" },
                  ].map((c) => (
                    <button key={c.id} onClick={() => setReportCategory(c.id)} style={{
                      padding: "6px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontWeight: 500,
                      border: `1px solid ${reportCategory === c.id ? COLORS.accent : COLORS.border}`,
                      background: reportCategory === c.id ? `${COLORS.accent}15` : COLORS.surface,
                      color: reportCategory === c.id ? COLORS.accent : COLORS.textMuted,
                    }}>{c.label}</button>
                  ))}
                </div>
                <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>What happened?</label>
                <textarea
                  value={reportMsg}
                  onChange={(e) => setReportMsg(e.target.value)}
                  rows={5}
                  placeholder="Describe the issue, what you expected, and any steps to reproduce…"
                  style={{
                    width: "100%", marginTop: 6, padding: "10px 12px", borderRadius: 10,
                    border: `1px solid ${COLORS.border}`, fontSize: 13, fontFamily: "inherit",
                    resize: "vertical", outline: "none", boxSizing: "border-box", background: COLORS.surfaceAlt,
                    color: COLORS.textPrimary,
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                  <button onClick={() => setReportOpen(false)} disabled={reportBusy} style={{
                    padding: "8px 14px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
                    background: COLORS.surface, color: COLORS.textSecondary, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                  }}>Cancel</button>
                  <button onClick={submitReport} disabled={reportBusy || !reportMsg.trim()} style={{
                    padding: "8px 16px", borderRadius: 8, border: "none",
                    background: reportBusy || !reportMsg.trim() ? "#E2E8F0" : COLORS.accent,
                    color: reportBusy || !reportMsg.trim() ? COLORS.textMuted : "#fff",
                    fontSize: 12.5, fontWeight: 600, cursor: reportBusy || !reportMsg.trim() ? "default" : "pointer",
                  }}>{reportBusy ? "Sending…" : "Send report"}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <VoiceModal open={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </>
  );
};

// ─── Dashboard Components ───

// Board Dashboard
const BoardDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Total Revenue" value="$113.8M" change="12.4%" changeType="up" icon={DollarSign} color={COLORS.success} subtitle="YTD FY2026" />
      <KPICard title="Net Profit Margin" value="27.0%" change="1.8pp" changeType="up" icon={TrendingUp} color={COLORS.primary} subtitle="vs 25.2% prior year" />
      <KPICard title="Operating Cash Flow" value="$34.2M" change="8.7%" changeType="up" icon={Activity} color={COLORS.accent} subtitle="Trailing 12 months" />
      <KPICard title="Workforce" value="776" change="34 open" changeType="up" icon={Users} color={COLORS.info} subtitle="Across 6 departments" />
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
      <ChartCard title="Revenue, Profit & Margin Trend" subtitle="Monthly performance (in $M)">
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={boardData.overview}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis yAxisId="left" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12, fill: COLORS.textMuted }} unit="%" />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} />
            <Legend />
            <Bar yAxisId="left" dataKey="revenue" name="Revenue ($M)" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
            <Bar yAxisId="left" dataKey="profit" name="Profit ($M)" fill={COLORS.accent} radius={[4, 4, 0, 0]} />
            <Line yAxisId="right" type="monotone" dataKey="margin" name="Margin %" stroke={COLORS.warning} strokeWidth={2} dot={{ r: 4 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Business Function Health" subtitle="Real-time health scores">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {boardData.health.map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 90, fontSize: 12, fontWeight: 500, color: COLORS.textSecondary }}>{item.function}</div>
              <div style={{ flex: 1, height: 8, background: COLORS.surfaceAlt, borderRadius: 4, overflow: "hidden" }}>
                <div style={{
                  width: `${item.score}%`, height: "100%", borderRadius: 4,
                  background: item.score >= 85 ? `linear-gradient(90deg, ${COLORS.success}, ${COLORS.accent})` : `linear-gradient(90deg, ${COLORS.warning}, #FBBF24)`
                }} />
              </div>
              <div style={{ width: 32, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, textAlign: "right" }}>{item.score}</div>
              <StatusBadge status={item.status} />
            </div>
          ))}
        </div>
      </ChartCard>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      {[
        { label: "Order Fulfillment", value: "96.9%", target: "96%", status: "healthy" },
        { label: "Avg Days Payable", value: "42 days", target: "45 days", status: "healthy" },
        { label: "Defect Rate", value: "1.2%", target: "<2%", status: "healthy" },
        { label: "Employee Retention", value: "96.1%", target: "95%", status: "healthy" },
      ].map((item, i) => (
        <div key={i} style={{
          background: COLORS.surface, borderRadius: 16, padding: 20, border: `1px solid ${COLORS.border}`,
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: COLORS.textSecondary }}>{item.label}</span>
            <StatusBadge status={item.status} />
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary }}>{item.value}</div>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>Target: {item.target}</div>
        </div>
      ))}
    </div>
  </div>
);

// Finance Dashboard
const FinanceDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Total Revenue" value="$15.9M" change="9.7%" changeType="up" icon={DollarSign} color={COLORS.success} subtitle="February 2026" />
      <KPICard title="Gross Margin" value="58.2%" change="1.4pp" changeType="up" icon={TrendingUp} color={COLORS.primary} subtitle="vs 56.8% prior month" />
      <KPICard title="Operating Expenses" value="$6.8M" change="2.1%" changeType="down" icon={ArrowDownRight} color={COLORS.warning} subtitle="Below budget by 3.2%" />
      <KPICard title="Days Sales Outstanding" value="34 days" change="2 days" changeType="up" icon={Clock} color={COLORS.info} subtitle="Industry avg: 38 days" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
      <ChartCard title="Revenue vs Budget" subtitle="Actual vs planned revenue ($M)">
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={financeData.revenue}>
            <defs>
              <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.15} />
                <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} />
            <Legend />
            <Area type="monotone" dataKey="actual" name="Actual" stroke={COLORS.primary} fill="url(#revGrad)" strokeWidth={2} />
            <Line type="monotone" dataKey="budget" name="Budget" stroke={COLORS.textMuted} strokeWidth={2} strokeDasharray="6 4" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Expense Breakdown" subtitle="By category (% of total)">
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={financeData.expenses} cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="value">
              {financeData.expenses.map((_, i) => <Cell key={i} fill={COLORS.chartColors[i]} />)}
            </Pie>
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
    <ChartCard title="Cash Flow Analysis" subtitle="Inflows vs outflows ($M)">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={financeData.cashflow}>
          <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
          <YAxis tick={{ fontSize: 12, fill: COLORS.textMuted }} />
          <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} />
          <Legend />
          <Bar dataKey="inflow" name="Cash Inflow" fill={COLORS.success} radius={[4, 4, 0, 0]} />
          <Bar dataKey="outflow" name="Cash Outflow" fill={COLORS.danger} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  </div>
);

// Procurement Dashboard
const ProcurementDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Total Spend" value="$8.9M" change="5.2%" changeType="up" icon={ShoppingCart} color={COLORS.primary} subtitle="February 2026" />
      <KPICard title="Cost Savings" value="$1.2M" change="18.4%" changeType="up" icon={TrendingDown} color={COLORS.success} subtitle="YTD negotiated savings" />
      <KPICard title="PO Cycle Time" value="3.2 days" change="0.8 days" changeType="up" icon={Clock} color={COLORS.accent} subtitle="Avg processing time" />
      <KPICard title="Supplier On-Time" value="91.4%" change="2.1%" changeType="up" icon={CheckCircle} color={COLORS.info} subtitle="Delivery compliance" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ChartCard title="Procurement Spend Trend" subtitle="Direct vs indirect ($M)">
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={procurementData.spend}>
            <defs>
              <linearGradient id="directGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.15} />
                <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="indirectGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.accent} stopOpacity={0.15} />
                <stop offset="95%" stopColor={COLORS.accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Area type="monotone" dataKey="direct" name="Direct" stroke={COLORS.primary} fill="url(#directGrad)" strokeWidth={2} />
            <Area type="monotone" dataKey="indirect" name="Indirect" stroke={COLORS.accent} fill="url(#indirectGrad)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Spend by Category" subtitle="Procurement distribution">
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={procurementData.categories} cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="value">
              {procurementData.categories.map((_, i) => <Cell key={i} fill={COLORS.chartColors[i]} />)}
            </Pie>
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
    <ChartCard title="Top Supplier Scorecard" subtitle="Performance metrics">
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 6px" }}>
          <thead>
            <tr>
              {["Supplier", "Score", "Spend ($M)", "On-Time %", "Status"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {procurementData.vendors.map((v, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "#F8FAFC" : "#fff" }}>
                <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 500, borderRadius: "8px 0 0 8px" }}>{v.name}</td>
                <td style={{ padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 60, height: 6, background: COLORS.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${v.score}%`, height: "100%", borderRadius: 3, background: v.score >= 90 ? COLORS.success : v.score >= 80 ? COLORS.warning : COLORS.danger }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{v.score}</span>
                  </div>
                </td>
                <td style={{ padding: "10px 12px", fontSize: 13 }}>${v.spend}M</td>
                <td style={{ padding: "10px 12px", fontSize: 13 }}>{v.onTime}%</td>
                <td style={{ padding: "10px 12px", borderRadius: "0 8px 8px 0" }}>
                  <StatusBadge status={v.score >= 90 ? "healthy" : v.score >= 80 ? "warning" : "critical"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  </div>
);

// Supply Chain Dashboard
const SupplyChainDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Order Fulfillment" value="96.9%" change="1.4%" changeType="up" icon={CheckCircle} color={COLORS.success} subtitle="Above 96% target" />
      <KPICard title="Avg Lead Time" value="5.2 days" change="0.8 days" changeType="up" icon={Clock} color={COLORS.primary} subtitle="Order to delivery" />
      <KPICard title="Inventory Turnover" value="8.4x" change="0.6x" changeType="up" icon={Package} color={COLORS.accent} subtitle="Annualized" />
      <KPICard title="Perfect Order Rate" value="92.3%" change="1.1%" changeType="up" icon={Target} color={COLORS.info} subtitle="On-time, complete, no damage" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ChartCard title="Fulfillment Rate Trend" subtitle="Actual vs target (%)">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={supplyChainData.fulfillment}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis domain={[90, 100]} tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Line type="monotone" dataKey="rate" name="Actual" stroke={COLORS.primary} strokeWidth={2} dot={{ r: 4 }} />
            <Line type="monotone" dataKey="target" name="Target" stroke={COLORS.danger} strokeWidth={2} strokeDasharray="6 4" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Inventory Days by Category" subtitle="Actual vs optimal (days)">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={supplyChainData.inventory} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis type="number" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis dataKey="category" type="category" tick={{ fontSize: 12, fill: COLORS.textMuted }} width={100} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Bar dataKey="days" name="Actual" fill={COLORS.primary} radius={[0, 4, 4, 0]} barSize={16} />
            <Bar dataKey="optimal" name="Optimal" fill={COLORS.accent} radius={[0, 4, 4, 0]} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  </div>
);

// Warehouse Dashboard
const WarehouseDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Space Utilization" value="78.6%" change="3.2%" changeType="up" icon={Warehouse} color={COLORS.primary} subtitle="Across all zones" />
      <KPICard title="Pick Accuracy" value="99.4%" change="0.2%" changeType="up" icon={Target} color={COLORS.success} subtitle="Order accuracy rate" />
      <KPICard title="Avg Pick Time" value="4.2 min" change="12%" changeType="up" icon={Clock} color={COLORS.accent} subtitle="Per order line" />
      <KPICard title="Dock-to-Stock" value="2.1 hrs" change="18 min" changeType="up" icon={Truck} color={COLORS.info} subtitle="Receiving cycle time" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ChartCard title="Zone Utilization" subtitle="Capacity usage by zone (%)">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={warehouseData.utilization}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="zone" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Bar dataKey="used" name="Utilized %" radius={[6, 6, 0, 0]}>
              {warehouseData.utilization.map((entry, i) => (
                <Cell key={i} fill={entry.used >= 90 ? COLORS.danger : entry.used >= 75 ? COLORS.warning : COLORS.success} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Daily Throughput" subtitle="Inbound vs outbound (units)">
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={warehouseData.throughput}>
            <defs>
              <linearGradient id="inGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.15} />
                <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="outGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.accent} stopOpacity={0.15} />
                <stop offset="95%" stopColor={COLORS.accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="day" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Area type="monotone" dataKey="inbound" name="Inbound" stroke={COLORS.primary} fill="url(#inGrad)" strokeWidth={2} />
            <Area type="monotone" dataKey="outbound" name="Outbound" stroke={COLORS.accent} fill="url(#outGrad)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  </div>
);

// Manufacturing Dashboard
const ManufacturingDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Overall OEE" value="82.4%" change="2.8%" changeType="up" icon={Factory} color={COLORS.primary} subtitle="All production lines" />
      <KPICard title="Production Volume" value="1,360 units" change="4.2%" changeType="up" icon={Package} color={COLORS.success} subtitle="February 2026" />
      <KPICard title="Planned Downtime" value="4.2%" change="0.8%" changeType="up" icon={Clock} color={COLORS.accent} subtitle="Maintenance scheduled" />
      <KPICard title="First Pass Yield" value="96.8%" change="0.4%" changeType="up" icon={Target} color={COLORS.info} subtitle="No rework required" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ChartCard title="OEE by Production Line" subtitle="Availability x Performance x Quality">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={manufacturingData.oee}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="line" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis domain={[70, 100]} tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Bar dataKey="availability" name="Availability" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
            <Bar dataKey="performance" name="Performance" fill={COLORS.accent} radius={[4, 4, 0, 0]} />
            <Bar dataKey="quality" name="Quality" fill={COLORS.success} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Production Plan vs Actual" subtitle="Monthly output (units)">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={manufacturingData.production}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Line type="monotone" dataKey="planned" name="Planned" stroke={COLORS.textMuted} strokeWidth={2} strokeDasharray="6 4" />
            <Line type="monotone" dataKey="actual" name="Actual" stroke={COLORS.primary} strokeWidth={2} dot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  </div>
);

// Sales Dashboard
const SalesDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Pipeline Value" value="$21.0M" change="14.2%" changeType="up" icon={TrendingUp} color={COLORS.primary} subtitle="Active opportunities" />
      <KPICard title="Win Rate" value="32.8%" change="3.1pp" changeType="up" icon={Target} color={COLORS.success} subtitle="Closed won / total" />
      <KPICard title="Avg Deal Size" value="$83.3K" change="8.4%" changeType="up" icon={DollarSign} color={COLORS.accent} subtitle="Last 90 days" />
      <KPICard title="Sales Cycle" value="28 days" change="4 days" changeType="up" icon={Clock} color={COLORS.info} subtitle="Avg days to close" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ChartCard title="Sales Pipeline Funnel" subtitle="Stage value ($M) and opportunity count">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={salesData.pipeline} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis type="number" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis dataKey="stage" type="category" tick={{ fontSize: 12, fill: COLORS.textMuted }} width={85} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Bar dataKey="value" name="Value ($M)" radius={[0, 6, 6, 0]}>
              {salesData.pipeline.map((_, i) => <Cell key={i} fill={COLORS.chartColors[i]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Revenue by Region" subtitle="Distribution ($M)">
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={salesData.regional} cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="revenue">
              {salesData.regional.map((_, i) => <Cell key={i} fill={COLORS.chartColors[i]} />)}
            </Pie>
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  </div>
);

// HR Dashboard
const HRDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Total Headcount" value="776" change="3.4%" changeType="up" icon={Users} color={COLORS.primary} subtitle="Active employees" />
      <KPICard title="Open Positions" value="34" change="8 new" changeType="up" icon={FileText} color={COLORS.warning} subtitle="Across departments" />
      <KPICard title="Retention Rate" value="96.1%" change="0.6pp" changeType="up" icon={TrendingUp} color={COLORS.success} subtitle="Rolling 12 months" />
      <KPICard title="Avg Time to Hire" value="32 days" change="5 days" changeType="up" icon={Clock} color={COLORS.info} subtitle="From posting to offer" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ChartCard title="Headcount by Department" subtitle="Staff and open positions">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={hrData.headcount}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="dept" tick={{ fontSize: 11, fill: COLORS.textMuted }} />
            <YAxis tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Bar dataKey="count" name="Current" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
            <Bar dataKey="open" name="Open Roles" fill={COLORS.warning} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Employee Retention Trend" subtitle="Monthly rate (%)">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={hrData.retention}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis domain={[93, 97]} tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Line type="monotone" dataKey="rate" name="Retention %" stroke={COLORS.success} strokeWidth={2} dot={{ r: 4, fill: COLORS.success }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  </div>
);

// Quality Dashboard
const QualityDashboard = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <KPICard title="Defect Rate" value="1.2%" change="0.3pp" changeType="up" icon={Shield} color={COLORS.success} subtitle="Below 2% target" />
      <KPICard title="First Pass Yield" value="96.8%" change="1.2%" changeType="up" icon={CheckCircle} color={COLORS.primary} subtitle="Production quality" />
      <KPICard title="Customer Complaints" value="12" change="4 fewer" changeType="up" icon={AlertTriangle} color={COLORS.warning} subtitle="This month" />
      <KPICard title="CAPA Closure Rate" value="94.2%" change="2.1%" changeType="up" icon={Target} color={COLORS.info} subtitle="On-time resolution" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ChartCard title="Defect Rate Trend" subtitle="Actual vs target (%)">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={qualityData.defects}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <YAxis domain={[0, 3]} tick={{ fontSize: 12, fill: COLORS.textMuted }} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none" }} />
            <Legend />
            <Line type="monotone" dataKey="rate" name="Defect Rate" stroke={COLORS.primary} strokeWidth={2} dot={{ r: 4 }} />
            <Line type="monotone" dataKey="target" name="Target" stroke={COLORS.danger} strokeWidth={2} strokeDasharray="6 4" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Quality Scorecard" subtitle="Multi-dimensional assessment">
        <ResponsiveContainer width="100%" height={260}>
          <RadarChart cx="50%" cy="50%" outerRadius={90} data={qualityData.metrics}>
            <PolarGrid stroke="#E2E8F0" />
            <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: COLORS.textMuted }} />
            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 10 }} />
            <Radar name="Score" dataKey="A" stroke={COLORS.primary} fill={COLORS.primary} fillOpacity={0.2} />
          </RadarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  </div>
);

// ─── Sample Prompts Data ───
// Aligned to TMC's Satori_Project dataset — workforce (attendance, allocation,
// timesheets, capability) + sales operations (account coverage, pipeline, AM
// scorecards, hunting gap).
const SAMPLE_PROMPTS = {
  attendance: [
    { title: "Today's Attendance",      prompt: "What's the overall attendance rate today and how many people were marked late?" },
    { title: "Top Absentees",           prompt: "Who are the top 10 absentees in the last 30 days?" },
    { title: "Department Attendance",   prompt: "Break down attendance rate by department for the last 30 days." },
    { title: "Late Arrival Patterns",   prompt: "Which weekdays have the most late arrivals?" },
  ],
  availability: [
    { title: "Who's on Bench",          prompt: "List all employees currently on the bench with their position and competencies." },
    { title: "Allocation Breakdown",    prompt: "How many employees are Allocated vs Partially Available vs On Bench right now?" },
    { title: "Find a Developer",        prompt: "Find me a React developer who is available next month, ideally bilingual." },
    { title: "Department Capacity",     prompt: "Average allocation percentage by department right now." },
  ],
  capability: [
    { title: "Top Competencies",        prompt: "What are the top 10 competencies in the workforce by employee count?" },
    { title: "Capability Coverage",     prompt: "Headcount per Employee_Position. Where are we thin?" },
    { title: "Location Distribution",   prompt: "How is the workforce distributed across locations?" },
    { title: "Skills by Department",    prompt: "Top 3 competencies for each department." },
  ],
  timesheets: [
    { title: "Hours by Project",        prompt: "Total hours logged per project in the last 30 days. Top 15 projects." },
    { title: "Top Contributors",        prompt: "Who logged the most hours in the last 30 days?" },
    { title: "Ticket Status Mix",       prompt: "Breakdown of ticket statuses for the last 60 days." },
  ],
  pipeline: [
    { title: "Pipeline Health",         prompt: "Open pipeline USD by salesperson with deal count and win rate." },
    { title: "Plan vs Pipeline",        prompt: "For each AM, show their 2026 target vs Q1 achievement vs CRM pipeline coverage ratio." },
    { title: "Q1 Achievement Ranking",  prompt: "Rank AMs by Q1 USD achievement. Who's leading and who's at risk?" },
    { title: "Win Rate Leaders",        prompt: "Top 5 salespeople by historical win rate. How does pipeline size correlate?" },
  ],
  accounts: [
    { title: "Account Coverage",        prompt: "How many accounts does each AM cover by tier (A/B/C)?" },
    { title: "Zero-Visit Accounts",     prompt: "Which AMs have the most accounts with zero visits in Q1?" },
    { title: "Dormant Accounts",        prompt: "Show me the dormant accounts list — names, AM, and last activity if available." },
    { title: "Q1 Visit Totals",         prompt: "Total Q1 visits per AM. Compare against headcount of accounts they cover." },
  ],
  hunting: [
    { title: "New-Business Gap",        prompt: "Which AMs have the biggest new-business hunting gap right now?" },
    { title: "Hunting Targets",         prompt: "What's the hunting gap quota per AM for the year and Q1 progress so far?" },
    { title: "Workload Feasibility",    prompt: "Compare each AM's required field days vs available field days. Who's overbooked?" },
  ],
};

const PROMPT_CATEGORIES = [
  { id: "all",          label: "All" },
  { id: "attendance",   label: "Attendance" },
  { id: "availability", label: "Availability" },
  { id: "capability",   label: "Capability" },
  { id: "timesheets",   label: "Timesheets" },
  { id: "pipeline",     label: "Pipeline" },
  { id: "accounts",     label: "Accounts" },
  { id: "hunting",      label: "Hunting Gap" },
];

// Sales-only prompt categories — hidden from non-admin users (sales data is
// admin-only). Mirrors the backend Sales_* restriction.
const SALES_PROMPT_CATS = new Set(["pipeline", "accounts", "hunting"]);
const isAdminRole = () => {
  try { return (JSON.parse(localStorage.getItem("permissions") || "{}").role || "").toLowerCase() === "admin"; }
  catch { return false; }
};


// ─── Markdown Renderer ───
const renderMarkdown = (text) => {
  if (!text) return null;
  // Strip any HTML the AI might still emit (legacy prompts told it to use
  // <p>/<strong>/<ul>/<li>). Convert common tags to markdown equivalents so
  // bold + lists still render, then drop everything else.
  let s = String(text);
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<p[^>]*>/gi, "");
  s = s.replace(/<\/?strong[^>]*>/gi, "**");
  s = s.replace(/<\/?b>/gi, "**");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<\/li>/gi, "\n");
  s = s.replace(/<\/?ul[^>]*>/gi, "");
  s = s.replace(/<\/?ol[^>]*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");           // strip anything else
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  const lines = s.split("\n");
  const elements = [];
  let inList = false;
  let listItems = [];

  const flushList = () => {
    if (listItems.length) {
      elements.push(<ul key={`ul-${elements.length}`} style={{ margin: "8px 0", paddingLeft: 20 }}>{listItems}</ul>);
      listItems = [];
      inList = false;
    }
  };

  const renderInline = (str, keyPrefix = "") => {
    // Bold
    const parts = [];
    let remaining = str;
    let idx = 0;
    const boldRegex = /\*\*(.+?)\*\*/g;
    let match;
    let lastIndex = 0;
    while ((match = boldRegex.exec(remaining)) !== null) {
      if (match.index > lastIndex) parts.push(<span key={`${keyPrefix}-t${idx++}`}>{remaining.slice(lastIndex, match.index)}</span>);
      parts.push(<strong key={`${keyPrefix}-b${idx++}`}>{match[1]}</strong>);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < remaining.length) parts.push(<span key={`${keyPrefix}-t${idx++}`}>{remaining.slice(lastIndex)}</span>);
    return parts.length ? parts : str;
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Headers
    if (trimmed.startsWith("### ")) { flushList(); elements.push(<h4 key={`h-${i}`} style={{ fontSize: 14, fontWeight: 700, margin: "14px 0 6px", color: "#333" }}>{renderInline(trimmed.slice(4), `h${i}`)}</h4>); return; }
    if (trimmed.startsWith("## ")) { flushList(); elements.push(<h3 key={`h-${i}`} style={{ fontSize: 15, fontWeight: 700, margin: "14px 0 6px", color: "#333" }}>{renderInline(trimmed.slice(3), `h${i}`)}</h3>); return; }
    // Bullet points
    if (/^[*\-•]\s+/.test(trimmed)) {
      inList = true;
      const content = trimmed.replace(/^[*\-•]\s+/, "");
      listItems.push(<li key={`li-${i}`} style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 4 }}>{renderInline(content, `li${i}`)}</li>);
      return;
    }
    // Numbered lists
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushList();
      const content = trimmed.replace(/^\d+[.)]\s+/, "");
      elements.push(<div key={`ol-${i}`} style={{ display: "flex", gap: 8, marginBottom: 4 }}><span style={{ color: "#8AC441", fontWeight: 600 }}>{trimmed.match(/^\d+/)[0]}.</span><span style={{ fontSize: 13, lineHeight: 1.7 }}>{renderInline(content, `ol${i}`)}</span></div>);
      return;
    }
    // Empty line
    if (!trimmed) { flushList(); elements.push(<div key={`br-${i}`} style={{ height: 8 }} />); return; }
    // Regular paragraph
    flushList();
    elements.push(<p key={`p-${i}`} style={{ fontSize: 13, lineHeight: 1.7, margin: "4px 0" }}>{renderInline(trimmed, `p${i}`)}</p>);
  });
  flushList();
  return <div>{elements}</div>;
};

// ─── Proactive insight feed ("Satori noticed") + spoken morning briefing ───
// The feed is Satori talking FIRST: deterministic anomaly checks run server-
// side once a day and surface here. Clicking a card drops a ready-made
// question into the chat input; the Briefing button has the avatar read a
// composed summary aloud (script from /api/briefing, voice from /api/tts).
const INSIGHT_SEV = {
  critical: { bg: "#FEE2E2", fg: "#B91C1C", label: "Critical" },
  warn:     { bg: "#FEF3C7", fg: "#B45309", label: "Heads-up" },
  info:     { bg: "#E0F2FE", fg: "#0A5F89", label: "FYI" },
};

const BriefingPlayer = ({ onClose }) => {
  const [phase, setPhase] = useState("loading"); // loading | speaking | done | error
  const [script, setScript] = useState("");
  const [err, setErr] = useState(null);
  const [level, setLevel] = useState(0);
  const audioRef = useRef(null);
  const lvlTimer = useRef(null);

  const stop = () => {
    if (audioRef.current) { try { audioRef.current.pause(); } catch { /* noop */ } audioRef.current = null; }
    if (lvlTimer.current) { clearInterval(lvlTimer.current); lvlTimer.current = null; }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const headers = { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" };
        const b = await fetch(`${API_BASE}/api/briefing`, { headers })
          .then(r => { if (!r.ok) throw new Error("Couldn't prepare the briefing."); return r.json(); });
        if (cancelled) return;
        setScript(b.script || "");
        const t = await fetch(`${API_BASE}/api/tts`, { method: "POST", headers, body: JSON.stringify({ text: b.script }) })
          .then(r => { if (!r.ok) throw new Error("Voice is unavailable right now — here's the text instead."); return r.json(); });
        if (cancelled) return;
        const audio = new Audio(`data:${t.mime || "audio/wav"};base64,${t.audio}`);
        audioRef.current = audio;
        audio.onended = () => { if (!cancelled) { setPhase("done"); setLevel(0); stop(); } };
        setPhase("speaking");
        lvlTimer.current = setInterval(() => setLevel(0.35 + Math.random() * 0.45), 130);
        audio.play().catch(() => { if (!cancelled) setPhase("done"); });
      } catch (e) {
        if (!cancelled) { setErr(String(e.message || e)); setPhase(script ? "done" : "error"); }
      }
    })();
    return () => { cancelled = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div onClick={() => { stop(); onClose(); }} style={{
      position: "fixed", inset: 0, zIndex: 1500, background: "rgba(15,23,42,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: COLORS.surface, borderRadius: 18, maxWidth: 520, width: "100%",
        padding: 28, textAlign: "center", boxShadow: "0 24px 60px rgba(0,0,0,0.3)",
      }}>
        <div style={{ display: "inline-flex", marginBottom: 14 }}>
          <SatoriAvatar state={phase === "loading" ? "greeting" : phase === "speaking" ? "speaking" : "idle"} audioLevel={level} size={170} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: COLORS.textPrimary, marginBottom: 8 }}>
          {phase === "loading" ? "Preparing your briefing…" : phase === "error" ? "Briefing unavailable" : "Today's briefing"}
        </div>
        {phase === "error" ? (
          <div style={{ fontSize: 13, color: "#B91C1C" }}>{err}</div>
        ) : (
          <div style={{ fontSize: 13, lineHeight: 1.65, color: COLORS.textSecondary, maxHeight: 190, overflowY: "auto", textAlign: "left", padding: "0 6px" }}>
            {script || "…"}
          </div>
        )}
        {phase === "done" && err && <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 8 }}>{err}</div>}
        <div style={{ marginTop: 18 }}>
          <button onClick={() => { stop(); onClose(); }} style={{
            padding: "9px 22px", borderRadius: 10, border: "none", background: COLORS.accent,
            color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
          }}>Close</button>
        </div>
      </div>
    </div>
  );
};

const InsightFeed = ({ onAsk }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/insights`, { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } });
        if (r.ok) { const j = await r.json(); if (!cancelled) setData(j); }
      } catch { /* feed is additive — never break the page */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const items = (data && data.insights) || [];
  const shown = expanded ? items : items.slice(0, 4);
  return (
    <div data-tour="insight-feed" style={{ padding: "20px 18px", borderBottom: `1px solid ${COLORS.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, display: "flex", alignItems: "center", gap: 6 }}>
          <Zap size={14} color={COLORS.accent} /> Satori noticed
        </div>
        <button onClick={() => setBriefingOpen(true)} title="Have Satori read today's briefing aloud" style={{
          padding: "5px 10px", borderRadius: 7, border: "none", background: COLORS.accent, color: "#fff",
          fontSize: 11, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5,
        }}>
          <Play size={11} /> Briefing
        </button>
      </div>
      {loading ? (
        <div style={{ fontSize: 11, color: COLORS.textMuted }}>Scanning today's data — first load of the day takes a few seconds…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 11, color: COLORS.textMuted }}>All quiet — no anomalies in today's scan of attendance, timesheets and allocations.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {shown.map((it) => {
            const sev = INSIGHT_SEV[it.severity] || INSIGHT_SEV.info;
            return (
              <button key={it.id} onClick={() => onAsk && onAsk(`Dig into this finding: ${it.title} — ${it.body}`)}
                title="Ask Satori about this" style={{
                  padding: "10px 12px", background: COLORS.surface, border: `1px solid ${COLORS.border}`,
                  borderRadius: 10, cursor: "pointer", textAlign: "left", width: "100%", transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = COLORS.accent; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = COLORS.border; }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: sev.bg, color: sev.fg, textTransform: "uppercase", letterSpacing: "0.4px", flexShrink: 0 }}>{sev.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                </div>
                <div style={{ fontSize: 10.5, color: COLORS.textSecondary, lineHeight: 1.45 }}>{it.body}</div>
              </button>
            );
          })}
          {items.length > 4 && (
            <button onClick={() => setExpanded(x => !x)} style={{
              padding: "6px 10px", borderRadius: 8, border: `1px dashed ${COLORS.border}`, background: "transparent",
              color: COLORS.textMuted, fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}>{expanded ? "Show less" : `Show all ${items.length}`}</button>
          )}
        </div>
      )}
      {briefingOpen && <BriefingPlayer onClose={() => setBriefingOpen(false)} />}
    </div>
  );
};

// ─── Agent & RAG Page ───
const AgentPage = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [mode, setMode] = useState("text"); // "text" or "voice"
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [isListening, setIsListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceLang, setVoiceLang] = useState("ur"); // "ur" or "en"
  const [recentQueries, setRecentQueries] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [feedback, setFeedback] = useState({}); // { [responseId]: 'up' | 'down' }
  const [copiedIdx, setCopiedIdx] = useState(null);
  const messagesEndRef = useRef(null);

  // Copy an assistant message to the clipboard (ChatGPT-style action).
  const copyMessage = useCallback((idx, text) => {
    try { navigator.clipboard?.writeText(text || ""); } catch (_) { /* ignore */ }
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
  }, []);

  // Regenerate: re-ask the user prompt that produced this answer, in place.
  const regenerate = useCallback(async (assistantIdx) => {
    let userIdx = assistantIdx - 1;
    while (userIdx >= 0 && messages[userIdx]?.role !== "user") userIdx--;
    if (userIdx < 0) return;
    const prompt = messages[userIdx].text;
    const history = messages.slice(0, userIdx).map((m) => ({ role: m.role, text: m.text }));
    setIsTyping(true);
    try {
      const token = localStorage.getItem("token");
      const base = import.meta.env.VITE_API_BASE || "";
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, history, conversation_id: conversationId }),
      });
      const data = await res.json();
      setMessages((prev) => {
        const copy = [...prev];
        if (copy[assistantIdx]) {
          copy[assistantIdx] = {
            role: "assistant", text: data.reply || "(no reply)",
            timestamp: new Date(), responseId: data.response_id ?? null,
          };
        }
        return copy;
      });
    } catch (_) {
      /* leave the original answer in place on failure */
    } finally {
      setIsTyping(false);
    }
  }, [messages, conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // Thumbs ± on an AI response. Optimistic; toggles off if the same vote is
  // clicked twice (still recorded server-side as the latest rating).
  const sendFeedback = useCallback(async (responseId, rating) => {
    if (responseId == null) return;
    setFeedback(prev => ({ ...prev, [responseId]: prev[responseId] === rating ? null : rating }));
    try {
      const token = localStorage.getItem("token");
      const base = import.meta.env.VITE_API_BASE || "";
      await fetch(`${base}/api/chat/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message_id: responseId, conversation_id: conversationId, rating }),
      });
    } catch (_) { /* non-blocking */ }
  }, [conversationId]);

  // Fetch recent queries on mount and after each message sent
  const fetchRecentQueries = async () => {
    const token = localStorage.getItem("token");
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/chat/history?limit=10`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRecentQueries(data.history || []);
      }
    } catch {}
  };

  useEffect(() => { fetchRecentQueries(); }, []);

  // Fetch saved conversations for the chat-history sidebar.
  const fetchConversations = async () => {
    const token = localStorage.getItem("token");
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations?limit=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch {}
  };
  useEffect(() => { fetchConversations(); }, []);

  const startNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    setInput("");
  };

  const loadConversation = async (convId) => {
    const token = localStorage.getItem("token");
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${convId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const loaded = (data.messages || []).map(m => ({
        role: m.role,
        text: m.content,
        timestamp: new Date(m.created_at + (m.created_at?.endsWith?.('Z') ? '' : 'Z')),
        // Carry the DB message id so thumbs feedback works on history-loaded turns.
        responseId: m.role === "assistant" ? (m.id ?? null) : null,
      }));
      setMessages(loaded);
      setConversationId(convId);
    } catch {}
  };

  const deleteConversation = async (convId, e) => {
    e?.stopPropagation?.();
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    const token = localStorage.getItem("token");
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${convId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        if (convId === conversationId) startNewConversation();
        fetchConversations();
      }
    } catch {}
  };

  const [voiceStatus, setVoiceStatus] = useState("idle"); // idle, connecting, listening, speaking
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const micCtxRef = useRef(null);
  const streamRef = useRef(null);
  const workletRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef([]);
  const sessionIdRef = useRef(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopVoice();
  }, []);

  const getAudioContext = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  };

  // Play received PCM audio chunks with proper scheduling
  const playAudioChunk = (pcmBytes, sessionId) => {
    // Drop chunks from old/cancelled sessions
    if (sessionId !== sessionIdRef.current) return;
    const ctx = getAudioContext();
    if (!ctx || ctx.state === "closed") return;
    const int16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;

    // Track this source so we can cancel it
    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
    };
  };

  const stopVoice = () => {
    // Invalidate session — any in-flight audio chunks will be dropped
    sessionIdRef.current += 1;

    // Close WebSocket
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    // Stop mic stream
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    // Disconnect audio worklet
    if (workletRef.current) { try { workletRef.current.disconnect(); } catch {} workletRef.current = null; }
    // Stop all currently-playing or scheduled audio sources
    activeSourcesRef.current.forEach(s => { try { s.stop(0); s.disconnect(); } catch {} });
    activeSourcesRef.current = [];
    // Close playback AudioContext to silence everything immediately
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    // Close mic AudioContext
    if (micCtxRef.current && micCtxRef.current.state !== "closed") {
      try { micCtxRef.current.close(); } catch {}
      micCtxRef.current = null;
    }
    // Reset audio scheduling
    nextPlayTimeRef.current = 0;
    isPlayingRef.current = false;
    setIsListening(false);
    setVoiceStatus("idle");
    setVoiceTranscript("");
  };

  const startVoiceSession = async () => {
    // Make sure any prior session is fully torn down before starting a new one
    stopVoice();
    // Allow stopVoice's state updates to flush
    await new Promise(r => setTimeout(r, 50));

    // New session ID — audio chunks tagged with this will play; older ones get dropped
    sessionIdRef.current += 1;
    const mySessionId = sessionIdRef.current;

    setVoiceStatus("connecting");
    const token = localStorage.getItem("token");
    const wsUrl = API_BASE.replace("http", "ws") + `/ws/voice?token=${token}&lang=${voiceLang}`;

    try {
      let micCtx; // Define here to be accessible in catch block
      // Get mic access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;

      // Set up AudioContext for mic capture at 16kHz
      micCtx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = micCtx;
      const source = micCtx.createMediaStreamSource(stream);

      // Use ScriptProcessor to capture PCM (simpler than AudioWorklet for single-file)
      const processor = micCtx.createScriptProcessor(4096, 1, 1);
      workletRef.current = processor;

      // Open WebSocket
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.binaryType = "arraybuffer";

      // Tracks whether the AI is currently speaking so we can mute the mic.
      // Using a plain object (manual ref) so the onaudioprocess closure always
      // reads the latest value without needing a React ref passed into a closure.
      const speaking = { current: false };

      ws.onopen = () => {
        // Start sending mic audio once Gemini session is ready
      };

      ws.onmessage = (event) => {
        // Drop messages from old sessions
        if (mySessionId !== sessionIdRef.current) return;
        if (event.data instanceof ArrayBuffer) {
          // Audio from Gemini — play it. Mark AI as speaking so mic is muted.
          speaking.current = true;
          setVoiceStatus("speaking");
          playAudioChunk(new Uint8Array(event.data), mySessionId);
        } else {
          // JSON message
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "ready") {
              setVoiceStatus("listening");
              setIsListening(true);
              // Send a greeting trigger so AI speaks first
              ws.send(JSON.stringify({ type: "text_input", text: "Start the conversation with your opening greeting." }));
              // Connect mic processor to send audio.
              // IMPORTANT: we skip sending while the AI is speaking (speaking.current=true)
              // to prevent background voices/noise from being picked up by the mic and
              // interrupting the AI mid-response. The mic resumes automatically once
              // turn_complete fires and speaking.current is reset to false.
              processor.onaudioprocess = (e) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (speaking.current) return; // muted — AI is speaking, don't send mic audio
                const float32 = e.inputBuffer.getChannelData(0);
                // Simple noise gate: skip very quiet frames (RMS below ~-45dBFS)
                // to avoid sending near-silence that background hiss can ride on.
                let sumSq = 0;
                for (let i = 0; i < float32.length; i++) sumSq += float32[i] * float32[i];
                const rms = Math.sqrt(sumSq / float32.length);
                if (rms < 0.008) return; // below noise floor — discard
                const int16 = new Int16Array(float32.length);
                for (let i = 0; i < float32.length; i++) {
                  int16[i] = Math.max(-32768, Math.min(32767, Math.floor(float32[i] * 32768)));
                }
                ws.send(int16.buffer);
              };
              source.connect(processor);
              processor.connect(micCtx.destination);
            } else if (msg.type === "status") {
              // Tool call status (e.g., "Querying your data...")
              setVoiceTranscript(msg.message);
            } else if (msg.type === "transcript") {
              // Gemini sent back a text transcript
              setVoiceTranscript(msg.text);
              if (msg.text) {
                setMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last && last.role === "assistant" && last.streaming) {
                    const updated = [...prev];
                    updated[updated.length - 1] = { ...last, text: last.text + msg.text };
                    return updated;
                  }
                  return [...prev, { role: "assistant", text: msg.text, timestamp: new Date(), streaming: true }];
                });
              }
            } else if (msg.type === "turn_complete") {
              // Gemini finished speaking — unmute mic and go back to listening.
              // Small delay so the last audio frame finishes playing before we
              // open the mic again (avoids the tail of AI audio triggering VAD).
              setTimeout(() => { speaking.current = false; }, 300);
              setVoiceStatus("listening");
              setMessages(prev => {
                const updated = [...prev];
                if (updated.length && updated[updated.length - 1].streaming) {
                  updated[updated.length - 1] = { ...updated[updated.length - 1], streaming: false };
                }
                return updated;
              });
            } else if (msg.type === "ping") {
              // Server keepalive — ignore silently
            } else if (msg.type === "error") {
              console.error("Voice error:", msg.message);
              stopVoice();
            }
          } catch {}
        }
      };

      ws.onerror = () => stopVoice();
      ws.onclose = () => { setVoiceStatus("idle"); setIsListening(false); };

    } catch (err) {
      console.error("Voice init error:", err);
      alert("Could not access microphone. Please allow microphone access and try again.");
      stopVoice();
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isTyping) return;
    const userMsg = { role: "user", text: trimmed, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    const token = localStorage.getItem("token");
    const history = messages.map(m => ({ role: m.role, text: m.text }));

    try {
      // Use /api/chat (non-stream) so we get conversation_id back for the
      // chat-history sidebar. Streaming UX still feels responsive because the
      // typing indicator stays up until the full reply arrives.
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ message: trimmed, history, conversation_id: conversationId }),
      });

      if (!res.ok) {
        // Surface the real failure to the user so debug doesn't need server
        // logs. Reads status + content-type + first few hundred chars of
        // body so a 502/HTML page from Cloud Run shows up clearly instead
        // of disguising as "Request failed".
        let detail = `HTTP ${res.status}`;
        try {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const err = await res.json();
            detail = err?.detail || JSON.stringify(err).slice(0, 400) || detail;
          } else {
            const txt = await res.text();
            detail = (txt || "(empty)").slice(0, 400);
          }
        } catch (e) { detail += " (could not read body)"; }
        console.error("[/api/chat]", res.status, detail);
        setMessages(prev => [...prev, { role: "assistant", text: `Error (${res.status}): ${detail}`, timestamp: new Date() }]);
        setIsTyping(false);
        return;
      }

      const data = await res.json();
      setIsTyping(false);
      setMessages(prev => [...prev, { role: "assistant", text: data.reply || "(no reply)", timestamp: new Date(), responseId: data.response_id ?? null }]);
      const newConvId = data.conversation_id;
      const isFirstTurn = !conversationId && newConvId;
      if (newConvId) setConversationId(newConvId);
      fetchRecentQueries();

      // Optimistic insert into the sidebar so the brand-new conversation
      // shows up instantly with the first user message as the title — exactly
      // how ChatGPT behaves. The server-side fetch a moment later refreshes
      // it with the canonical title/timestamp the backend stored.
      if (isFirstTurn) {
        const optimisticTitle = (trimmed || "New conversation").slice(0, 60);
        setConversations(prev => {
          if (prev?.some?.(c => c.id === newConvId)) return prev;
          return [
            {
              id: newConvId,
              title: optimisticTitle,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              message_count: 2,
            },
            ...(prev || []),
          ];
        });
      }
      // Server-side refresh — immediate + small delay so we cover the
      // common Postgres commit-visibility lag without flickering.
      fetchConversations();
      setTimeout(() => { fetchConversations(); }, 700);
    } catch (err) {
      console.error("[/api/chat] network error", err);
      setMessages(prev => [...prev, { role: "assistant", text: `Network error: ${err?.message || "fetch failed"}`, timestamp: new Date() }]);
      setIsTyping(false);
    }
  };

  const getFilteredPrompts = () => {
    const canSales = isAdminRole();
    const allow = (cat) => canSales || !SALES_PROMPT_CATS.has(cat);
    if (selectedCategory === "all") {
      return Object.entries(SAMPLE_PROMPTS)
        .filter(([cat]) => allow(cat))
        .flatMap(([cat, prompts]) => prompts.map(p => ({ ...p, category: cat })));
    }
    if (!allow(selectedCategory)) return [];
    return (SAMPLE_PROMPTS[selectedCategory] || []).map(p => ({ ...p, category: selectedCategory }));
  };


  const hasMessages = messages.length > 0;

  return (
    <div style={{ display: "flex", height: "100%", gap: 0 }}>
      {/* ─── Left: Conversation Area ─── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
        {/* Messages Area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>
          {!hasMessages && (
            <div style={{ textAlign: "center", paddingTop: 40 }}>
              <div style={{ width: 64, height: 64, borderRadius: 20, background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                <Sparkles size={32} color="#fff" />
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>How can I help you today?</div>
              <div style={{ fontSize: 14, color: COLORS.textSecondary, marginBottom: 32, maxWidth: 500, margin: "0 auto 32px" }}>
                Ask me anything about your business data. I connect to your enterprise systems to retrieve real-time insights.
              </div>
              {/* Inline quick prompts */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 600, margin: "0 auto" }}>
                {[
                  { title: "Attendance Today", prompt: "What's the overall attendance rate today and how many people were marked late?", icon: Calendar },
                  { title: "Top Absentees",    prompt: "Who are the top 10 absentees in the last 30 days with their department?",          icon: AlertTriangle },
                  { title: "Q1 AM Ranking",    prompt: "Rank AMs by Q1 USD achievement. Who's leading and who's at risk?",                  icon: TrendingUp },
                  { title: "Bench List",       prompt: "List all employees currently on the bench with their position and competencies.",  icon: Users },
                ].map((item, i) => (
                  <button key={i} onClick={() => { setInput(item.prompt); }} style={{
                    padding: "16px 18px", background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14,
                    cursor: "pointer", textAlign: "left", transition: "all 0.15s",
                    display: "flex", gap: 12, alignItems: "flex-start"
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.boxShadow = "0 2px 8px rgba(138,196,65,0.12)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = COLORS.border; e.currentTarget.style.boxShadow = "none"; }}
                  >
                    <item.icon size={18} color={COLORS.accent} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 4 }}>{item.title}</div>
                      <div style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.4 }}>{item.prompt}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const fb = msg.responseId != null ? feedback[msg.responseId] : undefined;
            return (
            <div key={i} style={{
              display: "flex", flexDirection: "column",
              alignItems: msg.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 16, animation: "fadeIn 0.3s ease"
            }}>
              <div style={{
                maxWidth: "70%", padding: "14px 18px", borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                background: msg.role === "user" ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accentDark})` : COLORS.surface,
                color: msg.role === "user" ? "#fff" : COLORS.textPrimary,
                border: msg.role === "assistant" ? `1px solid ${COLORS.border}` : "none",
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
              }}>
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>{msg.role === "assistant" ? renderMarkdown(msg.text) : msg.text}</div>
              </div>
              {msg.role === "assistant" && (
                <div style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 6, paddingLeft: 4 }}>
                  <button onClick={() => copyMessage(i, msg.text)} title={copiedIdx === i ? "Copied!" : "Copy"} style={{
                    background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex",
                    color: copiedIdx === i ? COLORS.accent : COLORS.textMuted,
                  }}>{copiedIdx === i ? <Check size={14} /> : <Copy size={14} />}</button>
                  {messages.slice(0, i).some((m) => m.role === "user") && (
                    <button onClick={() => regenerate(i)} title="Regenerate response" disabled={isTyping} style={{
                      background: "none", border: "none", cursor: isTyping ? "default" : "pointer", padding: 4, display: "flex",
                      color: COLORS.textMuted, opacity: isTyping ? 0.5 : 1,
                    }}><RefreshCw size={14} /></button>
                  )}
                  {msg.responseId != null && (
                    <>
                      <button onClick={() => sendFeedback(msg.responseId, "up")} title="Helpful" style={{
                        background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex",
                        color: fb === "up" ? COLORS.accent : COLORS.textMuted,
                      }}><ThumbsUp size={14} fill={fb === "up" ? COLORS.accent : "none"} /></button>
                      <button onClick={() => sendFeedback(msg.responseId, "down")} title="Not helpful" style={{
                        background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex",
                        color: fb === "down" ? COLORS.danger : COLORS.textMuted,
                      }}><ThumbsDown size={14} fill={fb === "down" ? COLORS.danger : "none"} /></button>
                    </>
                  )}
                  {fb && <span style={{ fontSize: 10.5, color: COLORS.textMuted, marginLeft: 4 }}>{fb === "up" ? "Thanks!" : "Thanks — we'll improve."}</span>}
                </div>
              )}
            </div>
          );})}

          {isTyping && (
            <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 16 }}>
              <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, padding: "14px 18px", borderRadius: "16px 16px 16px 4px", display: "flex", gap: 6, alignItems: "center" }}>
                <div style={{ display: "flex", gap: 4 }}>
                  {[0, 1, 2].map(j => (
                    <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: COLORS.accent, animation: `bounce 1.2s ${j * 0.15}s infinite` }} />
                  ))}
                </div>
                <span style={{ fontSize: 11, color: COLORS.textMuted, marginLeft: 4 }}>Thinking...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div data-tour="agent-input" style={{ padding: "16px 32px 20px", borderTop: `1px solid ${COLORS.border}`, background: COLORS.surface, flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1, position: "relative" }}>
              <textarea
                value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder="Ask about your data, trends, or business metrics..."
                rows={2}
                style={{
                  width: "100%", padding: "12px 18px", border: `1px solid ${COLORS.border}`, borderRadius: 14,
                  fontSize: 14, outline: "none", background: COLORS.surfaceAlt, transition: "all 0.2s", boxSizing: "border-box",
                  resize: "none", fontFamily: "inherit", lineHeight: 1.5, display: "block", margin: 0
                }}
                onFocus={e => { e.target.style.borderColor = COLORS.accent; e.target.style.background = COLORS.surface; }}
                onBlur={e => { e.target.style.borderColor = COLORS.border; e.target.style.background = COLORS.surfaceAlt; }}
              />
            </div>
            {/* Send button */}
            <button onClick={handleSend} disabled={!input.trim()} style={{
              width: 46, height: 46, borderRadius: 14, border: "none", cursor: input.trim() ? "pointer" : "default",
              background: input.trim() ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})` : "#E2E8F0",
              display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s", flexShrink: 0,
              alignSelf: "flex-end", marginBottom: 0
            }}>
              <Send size={18} color="#fff" />
            </button>
            {/* (Voice agent button removed — the floating mic FAB at bottom-right handles this now.) */}
          </div>
        </div>

        {/* Voice session — floating card at bottom */}
        {voiceStatus !== "idle" && (
          <div style={{
            position: "absolute", bottom: 16, left: 24, right: 24, zIndex: 50,
            background: COLORS.surface, borderRadius: 20, padding: "18px 24px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
            border: `1px solid ${COLORS.border}`,
            animation: "fadeIn 0.25s ease",
            display: "flex", alignItems: "center", gap: 16
          }}>
            {voiceStatus === "connecting" ? (
              <div style={{ width: 44, height: 44, borderRadius: "50%", border: `3px solid ${COLORS.border}`, borderTopColor: COLORS.accent, animation: "spin 0.8s linear infinite", flexShrink: 0, margin: "0 auto" }} />
            ) : (
              <>
                {/* Pulsing indicator */}
                <div style={{
                  width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
                  background: voiceStatus === "listening"
                    ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`
                    : `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentLight})`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  animation: voiceStatus === "listening" ? "pulse 2s infinite" : "none",
                  boxShadow: voiceStatus === "speaking" ? `0 0 0 6px ${COLORS.accent}20` : "none",
                  transition: "all 0.3s"
                }}>
                  <AudioLines size={20} color="#fff" />
                </div>

                {/* Waveform + status */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 24, marginBottom: 4 }}>
                    {Array.from({ length: 20 }, (_, i) => (
                      <div key={i} style={{
                        width: 2.5, borderRadius: 2, flex: "0 0 auto",
                        background: voiceStatus === "listening" ? COLORS.primary : COLORS.accent,
                        animation: `wave 1s infinite ease-in-out`,
                        animationDelay: `${i * 0.04}s`,
                        height: `${6 + Math.random() * 16}px`,
                        opacity: 0.6
                      }} />
                    ))}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: voiceStatus === "listening" ? COLORS.textPrimary : COLORS.accent }}>
                    {voiceStatus === "listening" ? (voiceLang === "ur" ? "سن رہی ہوں..." : "Listening...") : (voiceLang === "ur" ? "بول رہی ہوں..." : "Speaking...")}
                  </div>
                </div>

                {/* Language toggle */}
                <div style={{ display: "flex", gap: 2, background: COLORS.surfaceAlt, borderRadius: 8, padding: 2, flexShrink: 0 }}>
                  {[{ code: "ur", label: "اردو" }, { code: "en", label: "EN" }].map(l => (
                    <button key={l.code} onClick={() => {
                      stopVoice();
                      setTimeout(() => setVoiceLang(l.code), 50);
                    }} style={{
                      padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600,
                      background: voiceLang === l.code ? "#fff" : "transparent",
                      color: voiceLang === l.code ? COLORS.accent : COLORS.textMuted,
                      boxShadow: voiceLang === l.code ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                      transition: "all 0.15s"
                    }}>
                      {l.label}
                    </button>
                  ))}
                </div>

                {/* End button */}
                <button onClick={stopVoice} style={{
                  width: 36, height: 36, borderRadius: 10, border: "none",
                  background: "#FEF2F2", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.15s", flexShrink: 0
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "#FEE2E2"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "#FEF2F2"; }}
                title={voiceLang === "ur" ? "بات ختم کریں" : "End conversation"}
                >
                  <X size={16} color="#EF4444" />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ─── Right Sidebar ─── */}
      <div style={{
        width: 340, borderLeft: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt,
        display: "flex", flexDirection: "column", overflowY: "auto", flexShrink: 0
      }}>
        {/* Proactive insights + spoken morning briefing */}
        <InsightFeed onAsk={(q) => setInput(q)} />

        {/* Sample Prompts */}
        <div data-tour="sample-prompts" style={{ padding: "20px 18px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={14} color={COLORS.accent} /> Sample Prompts
          </div>
          {/* Category tabs (sales categories hidden from non-admins) */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
            {PROMPT_CATEGORIES.filter(cat => isAdminRole() || !SALES_PROMPT_CATS.has(cat.id)).map(cat => (
              <button key={cat.id} onClick={() => setSelectedCategory(cat.id)} style={{
                padding: "4px 10px", borderRadius: 8, border: `1px solid ${selectedCategory === cat.id ? COLORS.accent : COLORS.border}`,
                background: selectedCategory === cat.id ? `${COLORS.accent}15` : COLORS.surface, fontSize: 10, fontWeight: 500,
                color: selectedCategory === cat.id ? COLORS.accent : COLORS.textMuted, cursor: "pointer", transition: "all 0.15s"
              }}>
                {cat.label}
              </button>
            ))}
          </div>
          {/* Prompt cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
            {getFilteredPrompts().slice(0, 8).map((p, i) => (
              <button key={i} onClick={() => setInput(p.prompt)} style={{
                padding: "10px 12px", background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
                cursor: "pointer", textAlign: "left", transition: "all 0.15s", width: "100%"
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.background = `${COLORS.accent}08`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = COLORS.border; e.currentTarget.style.background = COLORS.surface; }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 3 }}>{p.title}</div>
                <div style={{ fontSize: 10, color: COLORS.textSecondary, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{p.prompt}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Chat History */}
        <div style={{ padding: "16px 18px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, display: "flex", alignItems: "center", gap: 6 }}>
              <Clock size={14} color={COLORS.accent} /> Chat History
            </div>
            <button
              onClick={startNewConversation}
              title="Start a new conversation"
              style={{
                padding: "5px 9px", borderRadius: 7, border: "none",
                background: COLORS.accent, color: "#fff", fontSize: 11, fontWeight: 600,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <Plus size={11} /> New
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 360, overflowY: "auto", paddingRight: 4, paddingBottom: 64 }}>
            {conversations.length === 0 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted, padding: "8px 10px" }}>No saved conversations yet.</div>
            ) : (
              conversations.map(conv => {
                const isActive = conv.id === conversationId;
                const ts = conv.updated_at || conv.created_at;
                const diff = ts ? (Date.now() - new Date(ts + (ts.endsWith?.("Z") ? "" : "Z")).getTime()) : 0;
                const mins = Math.floor(diff / 60000);
                const timeAgo = mins < 1 ? "Just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
                return (
                  <div
                    key={conv.id}
                    onClick={() => loadConversation(conv.id)}
                    style={{
                      padding: "9px 10px",
                      background: isActive ? `${COLORS.accent}1a` : "transparent",
                      border: isActive ? `1px solid ${COLORS.accent}66` : "1px solid transparent",
                      borderRadius: 8, cursor: "pointer", transition: "all 0.15s",
                      display: "flex", alignItems: "center", gap: 8,
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = COLORS.surface; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                  >
                    {/* Delete lives on the LEFT and is always visible — the floating
                        help/mic action buttons overlap the right edge of this panel,
                        so a right-aligned (hover-only) trash icon was unreachable. */}
                    <button
                      onClick={(e) => deleteConversation(conv.id, e)}
                      title="Delete this conversation"
                      style={{
                        width: 22, height: 22, padding: 0, borderRadius: 6, border: "none",
                        background: "transparent", color: COLORS.textMuted, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        opacity: 0.6, transition: "all 0.15s",
                      }}
                      onMouseEnter={e => { e.stopPropagation(); e.currentTarget.style.background = "#FEE2E2"; e.currentTarget.style.color = COLORS.danger; e.currentTarget.style.opacity = 1; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textMuted; e.currentTarget.style.opacity = 0.6; }}
                    >
                      <Trash2 size={12} />
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 500, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{conv.title || "(untitled)"}</div>
                      <div style={{ fontSize: 9.5, color: COLORS.textMuted, display: "flex", gap: 6 }}>
                        <span>{timeAgo}</span>
                        {conv.message_count ? <span>· {conv.message_count} msgs</span> : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

      </div>
    </div>
  );
};


// ─── Scope notice ─────────────────────────────────────────────────────
//
// The TMC dataset covers workforce (employees, attendance, allocation,
// timesheets) AND sales operations (AM scorecards, pipeline, accounts,
// hunting gap). The legacy SAP mirror notice no longer applies — every
// term it used to warn about ("sales", "revenue", "customer") is now
// natively supported. We keep these helpers as no-ops so existing call
// sites don't break.
const _MIRROR_SCOPE_PATTERN = /^.{0}$/;  // never matches

const _isOutOfScopeRevenuePrompt = (_text) => false;

const _buildMirrorScopeNotice = (kind) => {
  const noun = kind === "report" ? "report" : "dashboard";
  return (
    `**Quick orientation — what this ${noun} can pull from:**\n\n` +
    `I'm connected to TMC's workforce + sales warehouse. That covers attendance, allocation, bench, timesheets, AM scorecards, pipeline coverage, account visits, and the hunting gap. Try things like:\n\n` +
    `- "Monthly attendance summary by department"\n` +
    `- "Q1 AM scorecard: target vs achievement vs open pipeline"\n` +
    `- "Bench list with competencies"\n` +
    `- "Pipeline coverage and win rate by AM"\n`
  );
};


// ─── Report Chat Panel (auto-saving) ───
//
// Mirrors DashboardChatPanel: every time the AI returns a `ready` config the
// panel auto-saves it (POST first, PUT on later turns) and notifies the
// parent via `onConfigChange(newConfig, savedId)` so the preview re-renders.
const ReportChatPanel = ({
  existingConfig,
  existingId,
  onConfigChange,
  onSaveStateChange,
  onClose,
}) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [savedIdLocal, setSavedIdLocal] = useState(existingId || null);
  const [scopeNoticeShown, setScopeNoticeShown] = useState(false);
  const messagesEndRef = useRef(null);
  const seededRef = useRef(false);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isTyping]);

  useEffect(() => {
    if (seededRef.current) return;
    const savedHistory = Array.isArray(existingConfig?.chat_history) ? existingConfig.chat_history : null;
    if (savedHistory && savedHistory.length > 0) {
      setMessages(savedHistory);
    } else if (existingConfig) {
      setMessages([{ role: "assistant", text: "What would you like to change about this report? You can ask me to add or remove columns, change filters, swap the format, or rebuild it from scratch." }]);
    }
    seededRef.current = true;
  }, [existingConfig]);

  // Strip `chat_history` from existing_config before sending to Gemini —
  // the history exists only for local UI replay; Gemini already gets the
  // turn-by-turn `history` array separately.
  const _existingConfigForAI = useMemo(() => {
    if (!existingConfig) return null;
    const { chat_history, ...rest } = existingConfig;
    return rest;
  }, [existingConfig]);

  const persistConfig = useCallback(async (newConfig, chatHistory) => {
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    onSaveStateChange?.("saving");
    // Embed the chat history alongside the config so the build conversation
    // replays the next time the report is opened.
    const configToSave = { ...newConfig, chat_history: chatHistory || [] };
    try {
      let resolvedId = savedIdLocal;
      if (resolvedId) {
        const res = await fetch(`${base}/api/reports/${resolvedId}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: configToSave.title || "Untitled Report",
            description: configToSave.description || "",
            config: configToSave,
          }),
        });
        if (!res.ok) throw new Error("Update failed");
      } else {
        const res = await fetch(`${base}/api/reports`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: configToSave.title || "Untitled Report",
            description: configToSave.description || "",
            config: configToSave,
          }),
        });
        if (!res.ok) throw new Error("Create failed");
        const data = await res.json();
        resolvedId = data.id || data._id;
        setSavedIdLocal(resolvedId);
      }
      onConfigChange?.(configToSave, resolvedId);
      onSaveStateChange?.("saved");
    } catch (err) {
      console.error("Auto-save failed:", err);
      onSaveStateChange?.("error");
    }
  }, [savedIdLocal, onConfigChange, onSaveStateChange]);

  const handleSend = async (overrideText) => {
    const trimmed = (overrideText ?? input).trim();
    if (!trimmed || isTyping) return;
    // Track the conversation locally so persistConfig can capture the full
    // history including the latest assistant turn — sidesteps React's
    // batched-setState lag inside an async handler.
    let pendingHistory = [...messages, { role: "user", text: trimmed }];
    setMessages(pendingHistory);
    if (!overrideText) setInput("");

    if (!scopeNoticeShown && _isOutOfScopeRevenuePrompt(trimmed)) {
      pendingHistory = [...pendingHistory, {
        role: "assistant",
        text: _buildMirrorScopeNotice("report"),
        isScopeNotice: true,
      }];
      setMessages(pendingHistory);
      setScopeNoticeShown(true);
    }

    setIsTyping(true);

    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    const history = pendingHistory.slice(0, -1).map((m) => ({ role: m.role, text: m.text }));

    try {
      const res = await fetch(`${base}/api/report/refine`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history,
          // Edit-mode hint — when there's an existing config, the AI uses it
          // as the source of truth instead of re-asking everything from
          // scratch and inventing a fresh report. `chat_history` is stripped
          // (see `_existingConfigForAI`) so prompt tokens aren't wasted on
          // prior turns the AI already has via `history`.
          ...(_existingConfigForAI ? { existing_config: _existingConfigForAI } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed" }));
        throw new Error(err.detail || "Request failed");
      }
      const data = await res.json();
      setIsTyping(false);

      let newConfig = null;
      let truncatedJson = !!data.truncated;
      if (data.ready && data.config) newConfig = data.config;
      else if (!truncatedJson && data.reply && data.reply.includes('"ready"') && data.reply.includes('"config"')) {
        truncatedJson = true;
      }

      if (newConfig) {
        if (existingConfig?.sql && !newConfig.sql) {
          newConfig.sql = existingConfig.sql;
          newConfig.all_columns = existingConfig.all_columns;
          newConfig.numeric_columns = newConfig.numeric_columns || existingConfig.numeric_columns;
          newConfig.total_columns = newConfig.total_columns || existingConfig.total_columns;
        }
        pendingHistory = [...pendingHistory, { role: "assistant", text: savedIdLocal ? "Updating your report..." : "Building your report..." }];
        setMessages(pendingHistory);
        await persistConfig(newConfig, pendingHistory);
      } else if (truncatedJson) {
        pendingHistory = [...pendingHistory, {
          role: "assistant",
          text: data.reply || "My response was cut off while writing the report config. Try saying **\"generate\"** again, or ask me to simplify it (fewer sections / shorter SQL).",
        }];
        setMessages(pendingHistory);
      } else {
        pendingHistory = [...pendingHistory, { role: "assistant", text: data.reply }];
        setMessages(pendingHistory);
      }
    } catch (err) {
      setIsTyping(false);
      pendingHistory = [...pendingHistory, { role: "assistant", text: `Something went wrong: ${err.message}` }];
      setMessages(pendingHistory);
    }
  };

  const suggestedPrompts = [
    "Monthly attendance summary by department for the last 30 days",
    "Top 10 absentees in the last 30 days with department and position",
    "Q1 AM scorecard: target vs achievement vs open pipeline by AM",
    "Bench report: every employee currently at 0% allocation with competency",
  ];

  const showEmptyState = messages.length === 0 && !existingConfig;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: COLORS.surface, minHeight: 0 }}>
      {onClose && (
        <div style={{
          padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={15} color={COLORS.purple} />
            <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
              {existingId ? "Edit with AI" : "Build with AI"}
            </span>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", padding: 4, cursor: "pointer",
            color: COLORS.textSecondary, display: "flex", alignItems: "center"
          }}><X size={17} /></button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px", minHeight: 0 }}>
        {showEmptyState && (
          <div style={{ textAlign: "center", paddingTop: 16 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 18,
              background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
              display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px"
            }}>
              <FileText size={26} color="#fff" />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 6 }}>
              What tabular report do you need?
            </div>
            <div style={{ fontSize: 13, color: COLORS.textSecondary, marginBottom: 22, maxWidth: 480, margin: "0 auto 22px", lineHeight: 1.55 }}>
              Describe the data you need — I'll design the columns, filters, and totals. Saved automatically as you go, then download to Excel or PDF.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 460, margin: "0 auto" }}>
              {suggestedPrompts.map((p, i) => (
                <button key={i} onClick={() => setInput(p)} style={{
                  padding: "12px 14px", background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12,
                  cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 500, color: COLORS.textPrimary,
                  transition: "all 0.15s"
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.purple; e.currentTarget.style.boxShadow = "0 2px 8px rgba(53,48,133,0.12)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.border; e.currentTarget.style.boxShadow = "none"; }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          const isLastAssistant = msg.role === "assistant" && i === messages.length - 1;
          const hasGeneratePrompt = isLastAssistant && /say[\s\S]{0,20}generate/i.test(msg.text);
          const displayText = hasGeneratePrompt
            ? msg.text.replace(/\n*\s*Say[\s\S]*?generate[\s\S]*?\.\s*$/i, "").trim()
            : msg.text;
          return (
            <div key={i} style={{
              display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 14, animation: "fadeIn 0.3s ease"
            }}>
              <div style={{
                maxWidth: "88%", padding: "12px 16px",
                borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                background: msg.isScopeNotice
                  ? "#FEF9E7"
                  : (msg.role === "user" ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accentDark})` : COLORS.surface),
                color: msg.role === "user" ? "#fff" : COLORS.textPrimary,
                border: msg.isScopeNotice
                  ? `1px solid ${COLORS.warning}`
                  : (msg.role === "assistant" ? `1px solid ${COLORS.border}` : "none"),
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
              }}>
                {msg.isScopeNotice && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 11, fontWeight: 700, color: COLORS.warning, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    <AlertTriangle size={13} /> Data scope notice
                  </div>
                )}
                <div style={{ fontSize: 13, lineHeight: 1.65 }}>
                  {msg.role === "assistant" ? renderMarkdown(displayText) : msg.text}
                </div>
              </div>
              {hasGeneratePrompt && !isTyping && (
                <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
                  <button onClick={() => handleSend("generate")} style={{
                    padding: "9px 18px", borderRadius: 9, border: "none",
                    background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
                    color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                    boxShadow: "0 4px 12px rgba(53,48,133,0.25)",
                  }}>
                    <Sparkles size={13} /> Generate
                  </button>
                  <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>or refine below</span>
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 14 }}>
            <div style={{
              padding: "12px 16px", borderRadius: "14px 14px 14px 4px",
              background: COLORS.surface, border: `1px solid ${COLORS.border}`, boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
            }}>
              <div style={{ display: "flex", gap: 4 }}>
                {[0, 1, 2].map((d) => (
                  <div key={d} style={{
                    width: 6, height: 6, borderRadius: "50%", background: COLORS.textMuted,
                    animation: `pulse 1.2s ease-in-out ${d * 0.2}s infinite`
                  }} />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div style={{
        padding: "12px 16px", borderTop: `1px solid ${COLORS.border}`, background: COLORS.surface,
        display: "flex", gap: 8, alignItems: "center", flexShrink: 0
      }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={existingConfig ? "What should I change?" : "Describe the report you need..."}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 10,
            border: `1px solid ${COLORS.border}`, fontSize: 13, outline: "none",
            transition: "border-color 0.2s"
          }}
          onFocus={(e) => (e.target.style.borderColor = COLORS.accent)}
          onBlur={(e) => (e.target.style.borderColor = COLORS.border)}
        />
        <button onClick={() => handleSend()} disabled={isTyping || !input.trim()} style={{
          width: 38, height: 38, borderRadius: 10, border: "none",
          background: input.trim() ? COLORS.accent : COLORS.border,
          color: "#fff", cursor: input.trim() ? "pointer" : "default",
          display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.2s"
        }}>
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};

// ─── Report Preview (HTML table + downloads + per-column remove) ───
//
// Renders the SQL result as a clean tabular preview. Each column header shows
// a small × button for one-click removal — that updates the saved config's
// `columns` (visible subset) and re-runs preview. Adding a column is offered
// via the "Add column" menu (re-inserts a previously-removed column) or via
// the AI chat (regenerates the report).
// ─── AI Insights panel — shown under a built report / dashboard ──────────────
// Takes a compact text `summary` of the rendered data; calls /api/ai/insights
// and renders the returned markdown bullets. Renders nothing until there's data.
const AiInsights = ({ kind, title, summary }) => {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    const s = (summary || "").trim();
    if (!s) { setText(""); setErr(""); return; }
    let cancelled = false;
    setLoading(true); setErr("");
    const base = import.meta.env.VITE_API_BASE || "";
    fetch(`${base}/api/ai/insights`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind, title: title || "", data_summary: s }),
    })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setText(d.insights || ""); if (!d.insights) setErr("Couldn't generate insights right now."); } })
      .catch(() => { if (!cancelled) setErr("Couldn't generate insights right now."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind, title, summary]);

  if (!(summary || "").trim()) return null;
  return (
    <div style={{ margin: "16px", background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "hidden", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 18px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt }}>
        <Sparkles size={16} color={COLORS.accent} />
        <span style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.textPrimary }}>AI Insights</span>
        {loading && <span style={{ marginLeft: "auto", fontSize: 12, color: COLORS.textMuted }}>Analyzing…</span>}
      </div>
      <div style={{ padding: "14px 18px", fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6 }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.textMuted }}>
            <Activity size={15} style={{ animation: "spin 1s linear infinite" }} /> Generating insights from your data…
          </div>
        ) : err ? (
          <span style={{ color: COLORS.textMuted }}>{err}</span>
        ) : text ? (
          renderMarkdown(text)
        ) : null}
      </div>
    </div>
  );
};

const ReportPreview = ({ config, configRev, onConfigChange, onSaveMeta, isReadOnly = false }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState({ columns: [], all_columns: [], rows: [], total_rows: 0, numeric_columns: [], total_columns: [], sql: "" });
  const [downloading, setDownloading] = useState(null);

  const fmtCell = (v, col) => {
    if (v == null || v === "" || v === "None" || v === "null") return "";
    if (data.numeric_columns?.includes(col)) {
      const n = Number(v);
      if (!Number.isNaN(n)) {
        return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toFixed(2);
      }
    }
    return String(v);
  };

  const totalsRow = useMemo(() => {
    if (!data.total_columns?.length || !data.rows?.length) return null;
    const totals = {};
    for (const c of data.total_columns) {
      totals[c] = 0;
      for (const row of data.rows) {
        const n = Number(row?.[c]);
        if (!Number.isNaN(n)) totals[c] += n;
      }
    }
    return totals;
  }, [data]);

  const fetchPreview = useCallback(async () => {
    if (!config) return;
    setLoading(true);
    setError("");
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/report/preview`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Preview failed" }));
        throw new Error(err.detail || "Preview failed");
      }
      const result = await res.json();
      setData(result);
      // First preview enriches the config with sql + all_columns + numeric/total
      // columns; persist that so subsequent column toggles can reuse the SQL.
      const needsEnrich = !config.sql && result.sql;
      if (needsEnrich && onConfigChange) {
        onConfigChange({
          ...config,
          sql: result.sql,
          all_columns: result.all_columns,
          columns: result.columns,
          numeric_columns: result.numeric_columns,
          total_columns: result.total_columns,
          description: config.description || result.description,
        });
      }
    } catch (err) {
      console.error("ReportPreview error:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [config, onConfigChange]);

  useEffect(() => { fetchPreview(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [configRev]);

  const handleRemoveColumn = (col) => {
    if (!data.columns || data.columns.length <= 1) return;
    const newCols = data.columns.filter((c) => c !== col);
    setData((prev) => ({ ...prev, columns: newCols }));
    onSaveMeta?.({
      config: {
        ...config,
        columns: newCols,
        numeric_columns: (config.numeric_columns || data.numeric_columns || []).filter((c) => c !== col),
        total_columns: (config.total_columns || data.total_columns || []).filter((c) => c !== col),
      },
    });
  };

  const handleAddColumn = (col) => {
    if (!col || data.columns?.includes(col)) return;
    const all = data.all_columns || [];
    const newCols = all.filter((c) => data.columns.includes(c) || c === col);
    setData((prev) => ({ ...prev, columns: newCols }));
    onSaveMeta?.({ config: { ...config, columns: newCols } });
  };

  const handleDownload = async (format) => {
    setDownloading(format);
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/report/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: config.title || "Report",
          format,
          config: { ...config, columns: data.columns },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed" }));
        throw new Error(err.detail || "Download failed");
      }
      const blob = await res.blob();
      const filename = res.headers.get("X-Report-Filename") ||
        `${(config.title || "report").replace(/\s+/g, "_")}.${format === "pdf" ? "pdf" : "xlsx"}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Download failed: " + err.message);
    } finally {
      setDownloading(null);
    }
  };

  const hiddenColumns = (data.all_columns || []).filter((c) => !data.columns?.includes(c));

  // Compact text summary of the rendered table for the AI insights panel.
  const insightSummary = useMemo(() => {
    const cols = data.columns || [];
    const rows = data.rows || [];
    if (!cols.length || !rows.length) return "";
    const head = cols.join(" | ");
    const lines = rows.slice(0, 50).map((r) => cols.map((c) => { const v = r?.[c]; return v == null ? "" : String(v); }).join(" | "));
    return `Columns: ${head}\nTotal rows: ${data.total_rows ?? rows.length} (showing ${Math.min(50, rows.length)}):\n${lines.join("\n")}`;
  }, [data]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10,
        padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surface, flexShrink: 0
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12.5, color: COLORS.textSecondary }}>
            {loading ? "Loading preview…" : `${data.rows?.length || 0} of ${data.total_rows || 0} rows · ${data.columns?.length || 0} columns`}
          </div>
          <DataAsOf />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {!isReadOnly && hiddenColumns.length > 0 && (
            <HiddenColumnsMenu hidden={hiddenColumns} onAdd={handleAddColumn} />
          )}
          <button onClick={() => handleDownload("excel")} disabled={loading || !!downloading} style={{
            padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
            background: "#2E7D32", color: "#fff", fontSize: 12.5, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6, opacity: loading || downloading ? 0.6 : 1
          }}>
            <Download size={13} /> {downloading === "excel" ? "Preparing…" : "Excel"}
          </button>
          <button onClick={() => handleDownload("pdf")} disabled={loading || !!downloading} style={{
            padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
            background: "#C62828", color: "#fff", fontSize: 12.5, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6, opacity: loading || downloading ? 0.6 : 1
          }}>
            <Download size={13} /> {downloading === "pdf" ? "Preparing…" : "PDF"}
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {error && (
          <div style={{ padding: 24, color: COLORS.danger, fontSize: 13 }}>
            <AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
            {error}
          </div>
        )}
        {loading && !data.rows?.length && (
          <div style={{ textAlign: "center", padding: 60, color: COLORS.textSecondary }}>
            <Activity size={24} style={{ animation: "spin 1s linear infinite" }} />
            <div style={{ marginTop: 8, fontSize: 13 }}>Running query against BigQuery…</div>
          </div>
        )}
        {!loading && !error && data.columns?.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {data.columns.map((col) => {
                  const isNumeric = data.numeric_columns?.includes(col);
                  return (
                    <th key={col} style={{
                      padding: "10px 12px", textAlign: isNumeric ? "right" : "left",
                      background: COLORS.primary, color: "#fff", fontWeight: 600, fontSize: 11,
                      textTransform: "uppercase", letterSpacing: 0.4, position: "sticky", top: 0, zIndex: 1,
                      whiteSpace: "nowrap"
                    }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {col}
                        {!isReadOnly && data.columns.length > 1 && (
                          <button
                            onClick={() => handleRemoveColumn(col)}
                            title={`Remove "${col}" column`}
                            style={{
                              background: "rgba(255,255,255,0.18)", border: "none", borderRadius: 4,
                              width: 16, height: 16, cursor: "pointer", color: "#fff",
                              display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = COLORS.danger)}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.18)")}
                          >
                            <X size={10} />
                          </button>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr key={ri} style={{ background: ri % 2 ? COLORS.surfaceAlt : "#fff" }}>
                  {data.columns.map((col) => {
                    const isNumeric = data.numeric_columns?.includes(col);
                    return (
                      <td key={col} style={{
                        padding: "8px 12px", textAlign: isNumeric ? "right" : "left",
                        borderBottom: `1px solid ${COLORS.border}`, whiteSpace: "nowrap",
                        color: COLORS.textPrimary, fontVariantNumeric: isNumeric ? "tabular-nums" : "normal"
                      }}>
                        {fmtCell(row?.[col], col)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {totalsRow && (
                <tr style={{ background: `${COLORS.accent}1a`, fontWeight: 700 }}>
                  {data.columns.map((col, ci) => {
                    const isTotalCol = data.total_columns?.includes(col);
                    const isNumeric = data.numeric_columns?.includes(col);
                    let content = "";
                    if (ci === 0 && !isTotalCol) content = "TOTAL";
                    else if (isTotalCol) content = fmtCell(totalsRow[col], col);
                    return (
                      <td key={col} style={{
                        padding: "10px 12px", textAlign: isNumeric ? "right" : "left",
                        borderTop: `2px solid ${COLORS.primary}`, color: COLORS.textPrimary,
                        fontVariantNumeric: isNumeric ? "tabular-nums" : "normal"
                      }}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              )}
            </tbody>
          </table>
        )}
        {!loading && !error && (!data.columns?.length || !data.rows?.length) && (
          <div style={{ textAlign: "center", padding: 60, color: COLORS.textSecondary, fontSize: 13 }}>
            No data returned. Adjust filters in the chat panel.
          </div>
        )}
      </div>
      {!loading && !error && (
        <div style={{ overflowY: "auto", flexShrink: 0, maxHeight: "40%" }}>
          <AiInsights kind="report" title={config?.title} summary={insightSummary} />
        </div>
      )}
    </div>
  );
};

const HiddenColumnsMenu = ({ hidden, onAdd }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} style={{
        padding: "8px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
        background: COLORS.surface, cursor: "pointer", color: COLORS.textPrimary, fontSize: 12.5, fontWeight: 600,
        display: "flex", alignItems: "center", gap: 6
      }}>
        <Plus size={13} /> Add column
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 200, maxHeight: 320, overflowY: "auto", zIndex: 100
        }}>
          {hidden.map((col) => (
            <div key={col} onClick={() => { onAdd(col); setOpen(false); }} style={{
              padding: "9px 14px", fontSize: 12.5, cursor: "pointer", color: COLORS.textPrimary
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = COLORS.surfaceAlt)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {col}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Reports Page (orchestrator: list / creating / viewing) ───
const ReportsPage = () => {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState("list");

  const [activeId, setActiveId] = useState(null);
  const [activeConfig, setActiveConfig] = useState(null);
  const [activeName, setActiveName] = useState("");
  const [activeFavorite, setActiveFavorite] = useState(false);
  const [activeIsShared, setActiveIsShared] = useState(false);
  const [activeCanEdit, setActiveCanEdit] = useState(false); // editor-role recipients
  const [chatOpen, setChatOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewRev, setPreviewRev] = useState(0);
  const currentUserId = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("user") || "null")?.id; } catch { return null; }
  }, []);

  const menuRef = useRef(null);
  useEffect(() => {
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/reports`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to load reports");
      const list = await res.json();
      setReports(Array.isArray(list) ? list : list.reports || []);
    } catch (err) {
      console.error("ReportsPage fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  useEffect(() => {
    if (saveState === "saved") {
      const t = setTimeout(() => setSaveState("idle"), 2500);
      return () => clearTimeout(t);
    }
  }, [saveState]);

  const openReport = async (r) => {
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    const id = r.id || r._id;
    try {
      const res = await fetch(`${base}/api/reports/${id}`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to load");
      const full = await res.json();
      setActiveId(full.id || full._id || id);
      setActiveConfig(full.config);
      setActiveName(full.name || full.config?.title || "Untitled Report");
      setActiveFavorite(!!full.is_favorite);
      setActiveIsShared(!!full.is_shared);
      setActiveCanEdit(!!full.can_edit);
      setChatOpen(false);
      setShareOpen(false);
      setSaveState("idle");
      setMode("viewing");
      setPreviewRev((k) => k + 1);
    } catch (err) {
      alert("Failed to load: " + err.message);
    }
  };

  const startCreating = () => {
    setActiveId(null);
    setActiveConfig(null);
    setActiveName("");
    setActiveFavorite(false);
    setActiveIsShared(false);
    setActiveCanEdit(true);
    setChatOpen(false);
    setShareOpen(false);
    setSaveState("idle");
    setMode("creating");
  };

  const backToList = () => {
    setMode("list");
    setActiveId(null);
    setActiveConfig(null);
    setSaveState("idle");
    fetchReports();
  };

  const handleConfigChange = (newConfig, newId) => {
    setActiveConfig(newConfig);
    setActiveName((prev) => newConfig.title || prev || "Untitled Report");
    setPreviewRev((k) => k + 1);
    if (mode === "creating") {
      setActiveId(newId);
      setMode("viewing");
      // Land on the clean preview; user can open "Edit with AI" from the
      // toolbar if they want to refine.
      setChatOpen(false);
    } else if (newId && !activeId) {
      setActiveId(newId);
    }
  };

  const persistMeta = async (changes) => {
    if (!activeId) return;
    // Recipients can't write — pretend the change "saved" locally so per-column
    // toggles still feel responsive in their session, but skip the API call.
    if (activeIsShared && !activeCanEdit) {
      if (changes.config) {
        setActiveConfig(changes.config);
        setPreviewRev((k) => k + 1);
      }
      return;
    }
    setSaveState("saving");
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/reports/${activeId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaveState("saved");
      if (changes.config) {
        setActiveConfig(changes.config);
        setPreviewRev((k) => k + 1);
      }
    } catch (err) {
      console.error("Meta persist failed:", err);
      setSaveState("error");
    }
  };

  // Used by ReportPreview to silently enrich the saved config with cached SQL
  // after the very first preview — no user action triggered it, so we don't
  // flash the "Saving" pill. Skipped when the current user is a recipient
  // (they can't PUT) — they'll just re-design from cache on every preview,
  // which is fine and rare.
  const handleSilentConfigEnrich = (enrichedConfig) => {
    setActiveConfig(enrichedConfig);
    if (activeId && (!activeIsShared || activeCanEdit)) {
      const token = localStorage.getItem("token");
      const base = import.meta.env.VITE_API_BASE || "";
      fetch(`${base}/api/reports/${activeId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: enrichedConfig }),
      }).catch((err) => console.error("Silent enrich failed:", err));
    }
  };

  const handleRename = async () => {
    const newName = (titleDraft || "").trim();
    setEditingTitle(false);
    setTitleDraft("");
    if (!newName || newName === activeName) return;
    setActiveName(newName);
    const newConfig = { ...activeConfig, title: newName };
    setActiveConfig(newConfig);
    await persistMeta({ name: newName, config: newConfig });
  };

  const handleToggleFavorite = async () => {
    const newVal = !activeFavorite;
    setActiveFavorite(newVal);
    await persistMeta({ is_favorite: newVal });
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      await fetch(`${base}/api/reports/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      setReports((prev) => prev.filter((r) => (r.id || r._id) !== id));
      if (activeId === id) backToList();
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  };

  const handleDuplicate = async (idOrItem) => {
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    const id = typeof idOrItem === "object" ? (idOrItem.id || idOrItem._id) : idOrItem;
    try {
      const res = await fetch(`${base}/api/reports/${id}`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Load failed");
      const full = await res.json();
      const dupRes = await fetch(`${base}/api/reports`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: (full.name || "Untitled") + " (copy)",
          description: full.description || "",
          config: full.config,
        }),
      });
      if (!dupRes.ok) throw new Error("Duplicate failed");
      await fetchReports();
    } catch (err) {
      alert("Duplicate failed: " + err.message);
    }
  };

  // For shared items: revoke own access. Backend permits the recipient to
  // delete their own share row.
  const handleRemoveFromMyList = async (id) => {
    if (!currentUserId) return;
    if (!window.confirm("Remove this report from your list? You'll lose access until the owner shares it again.")) return;
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/reports/${id}/shares/${currentUserId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Could not remove");
      setReports((prev) => prev.filter((r) => (r.id || r._id) !== id));
      if (activeId === id) backToList();
    } catch (err) {
      alert("Could not remove: " + err.message);
    }
  };

  // ── Mode: creating ──
  if (mode === "creating") {
    return (
      <div style={{ height: "100%", padding: 24, boxSizing: "border-box" }}>
        <div style={{
          height: "100%", display: "flex", flexDirection: "column",
          background: COLORS.surface, borderRadius: 16, border: `1px solid ${COLORS.border}`, overflow: "hidden"
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button onClick={backToList} style={{
                background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 8,
                padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary
              }}>
                <ChevronLeft size={16} />
              </button>
              <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>New Report</div>
            </div>
            <SaveStatePill state={saveState} />
          </div>
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
            <ReportChatPanel
              onConfigChange={handleConfigChange}
              onSaveStateChange={setSaveState}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Mode: viewing ──
  if (mode === "viewing" && activeConfig) {
    return (
      <div style={{ height: "100%", padding: 24, boxSizing: "border-box", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <button onClick={backToList} title="Back to reports" style={{
              background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
              padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary, flexShrink: 0
            }}>
              <ChevronLeft size={16} />
            </button>
            {editingTitle && !activeIsShared ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.target.blur();
                  if (e.key === "Escape") { setEditingTitle(false); setTitleDraft(""); }
                }}
                style={{
                  fontSize: 20, fontWeight: 700, color: COLORS.textPrimary,
                  border: `1px solid ${COLORS.accent}`, borderRadius: 6, padding: "3px 8px", outline: "none",
                  background: COLORS.surface, flex: 1, maxWidth: 480
                }}
              />
            ) : (
              <div
                onClick={() => { if (!activeIsShared) { setTitleDraft(activeName); setEditingTitle(true); } }}
                title={activeIsShared ? "Read-only — owner controls renaming" : "Click to rename"}
                style={{
                  fontSize: 20, fontWeight: 700, color: COLORS.textPrimary,
                  cursor: activeIsShared ? "default" : "text",
                  padding: "3px 6px", borderRadius: 6, border: "1px solid transparent",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 480
                }}
                onMouseEnter={(e) => { if (!activeIsShared) e.currentTarget.style.borderColor = COLORS.border; }}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
              >
                {activeName}
              </div>
            )}
            {activeIsShared && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: COLORS.purple,
                background: `${COLORS.purple}1a`, padding: "3px 10px", borderRadius: 20,
                display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0,
              }}>
                <Share2 size={11} /> Shared with you
              </span>
            )}
            <SaveStatePill state={saveState} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {!activeIsShared && (
              <>
                <button onClick={handleToggleFavorite} title={activeFavorite ? "Remove from favorites" : "Mark as favorite"} style={{
                  background: activeFavorite ? `${COLORS.warning}1a` : "#fff",
                  border: `1px solid ${activeFavorite ? COLORS.warning : COLORS.border}`,
                  borderRadius: 8, padding: "8px 10px", cursor: "pointer",
                  color: activeFavorite ? COLORS.warning : COLORS.textSecondary,
                  display: "flex", alignItems: "center"
                }}>
                  <Star size={15} fill={activeFavorite ? COLORS.warning : "none"} />
                </button>
                <button onClick={() => setShareOpen(true)} title="Share with people in your company" style={{
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
                  padding: "8px 14px", cursor: "pointer", color: COLORS.textPrimary,
                  fontSize: 13, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6
                }}>
                  <Share2 size={14} /> Share
                </button>
                <button onClick={() => setScheduleOpen(true)} title="Email this to me on a schedule" style={{
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
                  padding: "8px 14px", cursor: "pointer", color: COLORS.textPrimary,
                  fontSize: 13, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6
                }}>
                  <Calendar size={14} /> Schedule
                </button>
                <button
                  onClick={() => setChatOpen((v) => !v)}
                  title={chatOpen ? "Close AI editor" : "Open AI editor"}
                  aria-pressed={chatOpen}
                  style={{
                    padding: "8px 14px", borderRadius: 8,
                    border: chatOpen ? "none" : `1px solid ${COLORS.border}`,
                    background: chatOpen ? `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})` : "#fff",
                    color: chatOpen ? "#fff" : COLORS.textPrimary,
                    fontSize: 13, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                    boxShadow: chatOpen ? "0 4px 12px rgba(53,48,133,0.25)" : "none",
                    transition: "all 0.15s ease",
                  }}
                >
                  <Sparkles size={14} /> Edit with AI
                </button>
              </>
            )}
            {activeIsShared && activeCanEdit && (
              <button
                onClick={() => setChatOpen((v) => !v)}
                title={chatOpen ? "Close AI editor" : "Open AI editor"}
                aria-pressed={chatOpen}
                style={{
                  padding: "8px 14px", borderRadius: 8,
                  border: chatOpen ? "none" : `1px solid ${COLORS.border}`,
                  background: chatOpen ? `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})` : "#fff",
                  color: chatOpen ? "#fff" : COLORS.textPrimary,
                  fontSize: 13, fontWeight: 600, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <Sparkles size={14} /> Edit with AI
              </button>
            )}
            <div ref={menuRef} style={{ position: "relative" }}>
              <button onClick={() => setMenuOpen((v) => !v)} title="More" style={{
                background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
                padding: "8px 10px", cursor: "pointer", color: COLORS.textSecondary,
                display: "flex", alignItems: "center"
              }}>
                <MoreHorizontal size={16} />
              </button>
              {menuOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", right: 0,
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 200, zIndex: 100, overflow: "hidden"
                }}>
                  {!activeIsShared && (
                    <>
                      <MenuItem icon={Trash2} danger onClick={() => { setMenuOpen(false); handleDelete(activeId, activeName); }}>Delete report</MenuItem>
                    </>
                  )}
                  {activeIsShared && (
                    <MenuItem icon={X} danger onClick={() => { setMenuOpen(false); handleRemoveFromMyList(activeId); }}>Remove from my list</MenuItem>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", gap: 16, minHeight: 0 }}>
          <div style={{
            flex: chatOpen ? "1 1 60%" : "1 1 100%",
            background: COLORS.surface, borderRadius: 16, border: `1px solid ${COLORS.border}`,
            overflow: "hidden", minWidth: 0, transition: "flex 0.2s ease",
            display: "flex", flexDirection: "column"
          }}>
            <ReportPreview
              config={activeConfig}
              configRev={previewRev}
              onConfigChange={handleSilentConfigEnrich}
              onSaveMeta={persistMeta}
              isReadOnly={activeIsShared && !activeCanEdit}
            />
          </div>
          {chatOpen && (!activeIsShared || activeCanEdit) && (
            <div style={{
              flex: "0 0 40%", maxWidth: 480, background: COLORS.surface,
              border: `1px solid ${COLORS.border}`, borderRadius: 16, overflow: "hidden",
              display: "flex", flexDirection: "column", minHeight: 0
            }}>
              <ReportChatPanel
                key={`chat-${activeId}`}
                existingConfig={activeConfig}
                existingId={activeId}
                onConfigChange={handleConfigChange}
                onSaveStateChange={setSaveState}
                onClose={() => setChatOpen(false)}
              />
            </div>
          )}
        </div>
        {shareOpen && (
          <ShareModal
            kind="report"
            itemId={activeId}
            itemName={activeName}
            onClose={() => setShareOpen(false)}
          />
        )}
        {scheduleOpen && activeId && (
          <ScheduleModal
            kind="report"
            itemId={activeId}
            itemName={activeName}
            onClose={() => setScheduleOpen(false)}
          />
        )}
      </div>
    );
  }

  // ── Mode: list ──
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 32, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary }}>Reports</div>
          {reports.length > 0 && (
            <span style={{
              fontSize: 12, fontWeight: 600, background: `${COLORS.accent}20`, color: COLORS.accentDark,
              padding: "2px 10px", borderRadius: 20
            }}>{reports.length}</span>
          )}
        </div>
        {reports.length > 0 && (
          <button onClick={startCreating} style={{
            padding: "10px 18px", borderRadius: 10, border: "none",
            background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8,
            boxShadow: "0 4px 12px rgba(53,48,133,0.25)"
          }}>
            <Plus size={16} /> New Report
          </button>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 60, color: COLORS.textSecondary }}>
          <Activity size={24} style={{ animation: "spin 1s linear infinite" }} />
          <div style={{ marginTop: 8, fontSize: 13 }}>Loading reports...</div>
        </div>
      )}

      {!loading && reports.length === 0 && (
        <div style={{ textAlign: "center", padding: 80, background: COLORS.surface, borderRadius: 16, border: `1px dashed ${COLORS.border}` }}>
          <div style={{
            width: 72, height: 72, borderRadius: 22, background: COLORS.surfaceAlt,
            display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px"
          }}>
            <FileText size={32} color={COLORS.textMuted} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 6 }}>No reports yet</div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, marginBottom: 22, maxWidth: 420, margin: "0 auto 22px", lineHeight: 1.55 }}>
            Describe the data you want to see and AI will design a tabular report — saved automatically, exportable to Excel or PDF.
          </div>
          <button onClick={startCreating} style={{
            padding: "11px 22px", borderRadius: 10, border: "none",
            background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 8,
            boxShadow: "0 4px 12px rgba(53,48,133,0.25)"
          }}>
            <Sparkles size={14} /> Build your first report
          </button>
        </div>
      )}

      {!loading && reports.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {reports.map((r) => (
            <ReportCard
              key={r.id || r._id}
              report={r}
              onOpen={() => openReport(r)}
              onDelete={() => handleDelete(r.id || r._id, r.name)}
              onDuplicate={() => handleDuplicate(r)}
              onRemoveFromList={() => handleRemoveFromMyList(r.id || r._id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const ReportCard = ({ report, onOpen, onDelete, onDuplicate, onRemoveFromList }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const stamp = report.updated_at || report.created_at;
  const stampLabel = stamp ? new Date(stamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
  const isShared = !!report.is_shared;

  return (
    <div onClick={onOpen} style={{
      background: COLORS.surface, borderRadius: 14, padding: 18, border: `1px solid ${COLORS.border}`,
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)", cursor: "pointer",
      display: "flex", flexDirection: "column", transition: "all 0.18s",
      position: "relative", minHeight: 160
    }}
    onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "0 6px 16px rgba(0,0,0,0.1)"; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.borderColor = COLORS.purple; }}
    onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)"; e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.borderColor = COLORS.border; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: `${COLORS.purple}1a`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <FileText size={17} color={COLORS.purple} />
        </div>
        <div ref={ref} style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setMenuOpen((v) => !v)} style={{
            background: "none", border: "none", padding: 6, borderRadius: 6, cursor: "pointer",
            color: COLORS.textMuted, display: "flex", alignItems: "center"
          }}
            onMouseEnter={(e) => e.currentTarget.style.background = COLORS.surfaceAlt}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", right: 0,
              background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
              boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 200, zIndex: 100, overflow: "hidden"
            }}>
              {!isShared && (
                <>
                  <MenuItem icon={Trash2} danger onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</MenuItem>
                </>
              )}
              {isShared && (
                <MenuItem icon={X} danger onClick={() => { setMenuOpen(false); onRemoveFromList?.(); }}>Remove from my list</MenuItem>
              )}
            </div>
          )}
        </div>
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
        {report.is_favorite ? <Star size={14} fill={COLORS.warning} color={COLORS.warning} /> : null}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{report.name}</span>
      </div>
      <div style={{
        fontSize: 12.5, color: COLORS.textSecondary, marginBottom: 10, lineHeight: 1.5,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 36
      }}>
        {report.description || "No description"}
      </div>
      {isShared && (
        <div style={{
          alignSelf: "flex-start", marginBottom: 8,
          fontSize: 11, fontWeight: 600, color: COLORS.purple,
          background: `${COLORS.purple}1a`, padding: "3px 10px", borderRadius: 20,
          display: "inline-flex", alignItems: "center", gap: 4,
        }}>
          <Share2 size={11} /> Shared by {report.shared_by_name || "someone"}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: "auto" }}>
        Last edited {stampLabel}
      </div>
    </div>
  );
};


// ─── Rules Engine Data ───
const ACTION_CHANNELS = [
  { id: "email", label: "Email", icon: Mail, color: "#3B82F6", bg: "#EFF6FF" },
  { id: "whatsapp", label: "WhatsApp", icon: Phone, color: "#25D366", bg: "#F0FDF4" },
  { id: "sms", label: "SMS", icon: MessageCircle, color: "#8B5CF6", bg: "#F5F3FF" },
  { id: "slack", label: "Slack", icon: Hash, color: "#E01E5A", bg: "#FFF1F2" },
  { id: "webhook", label: "Webhook", icon: Globe, color: COLORS.textMuted, bg: "#F9FAFB" },
];

const RULE_METRICS = [
  { group: "Finance", items: ["Receivables Balance", "Payables Aging", "Cash Flow", "Monthly Revenue", "Operating Expenses"] },
  { group: "Sales", items: ["Pipeline Value", "Win Rate", "Customer Churn Rate", "Avg Deal Size", "Quarterly Bookings"] },
  { group: "Supply Chain", items: ["Inventory Level", "Lead Time", "Fulfillment Rate", "Backorder Count"] },
  { group: "Manufacturing", items: ["OEE Score", "Defect Rate", "Downtime Hours", "Production Output"] },
  { group: "HR", items: ["Headcount", "Turnover Rate", "Open Positions", "Avg Time-to-Hire"] },
];

const RULE_OPERATORS = [
  { id: "gt", label: ">", desc: "greater than" },
  { id: "lt", label: "<", desc: "less than" },
  { id: "gte", label: ">=", desc: "at least" },
  { id: "lte", label: "<=", desc: "at most" },
  { id: "eq", label: "=", desc: "equals" },
  { id: "neq", label: "!=", desc: "not equal to" },
  { id: "chg", label: "changes by", desc: "changes by" },
];

const RULES_TEMPLATES = [
  { id: "rt1", title: "High Receivables Alert", category: "Finance", description: "Alert when outstanding receivables exceed threshold", metric: "Receivables Balance", operator: "gt", value: "500000", unit: "$", channels: ["email", "whatsapp"], schedule: "hourly", icon: DollarSign, color: "#F59E0B" },
  { id: "rt2", title: "Low Inventory Warning", category: "Supply Chain", description: "Notify when stock drops below minimum level", metric: "Inventory Level", operator: "lt", value: "100", unit: "units", channels: ["email", "slack"], schedule: "realtime", icon: Package, color: "#0A5F89" },
  { id: "rt3", title: "Quality Defect Spike", category: "Manufacturing", description: "Alert on sudden increase in defect rate", metric: "Defect Rate", operator: "gt", value: "2", unit: "%", channels: ["email", "sms"], schedule: "realtime", icon: Shield, color: "#EF4444" },
  { id: "rt4", title: "Pipeline Drop Alert", category: "Sales", description: "Notify when pipeline value drops significantly", metric: "Pipeline Value", operator: "chg", value: "-15", unit: "%", channels: ["slack"], schedule: "daily", icon: TrendingDown, color: "#353085" },
  { id: "rt5", title: "Cash Flow Warning", category: "Finance", description: "Critical alert for low cash flow situations", metric: "Cash Flow", operator: "lt", value: "200000", unit: "$", channels: ["email", "whatsapp", "sms"], schedule: "daily", icon: AlertTriangle, color: "#D97706" },
  { id: "rt6", title: "Delivery Delay Alert", category: "Supply Chain", description: "Alert when lead times exceed SLA", metric: "Lead Time", operator: "gt", value: "5", unit: "days", channels: ["email"], schedule: "hourly", icon: Truck, color: "#0A5F89" },
  { id: "rt7", title: "High Turnover Alert", category: "HR", description: "Notify HR when turnover rate exceeds target", metric: "Turnover Rate", operator: "gt", value: "8", unit: "%", channels: ["email", "slack"], schedule: "weekly", icon: Users, color: "#8B5CF6" },
  { id: "rt8", title: "Production Downtime", category: "Manufacturing", description: "Alert on extended unplanned downtime", metric: "Downtime Hours", operator: "gt", value: "4", unit: "hrs", channels: ["email", "sms", "slack"], schedule: "realtime", icon: Factory, color: "#EF4444" },
];

const RULES_CATEGORIES = [
  { id: "all", label: "All" }, { id: "Finance", label: "Finance" }, { id: "Sales", label: "Sales" },
  { id: "Supply Chain", label: "Supply Chain" }, { id: "Manufacturing", label: "Mfg" }, { id: "HR", label: "HR" },
];

const MOCK_RULES = [
  { id: 1, name: "High Receivables Alert", enabled: true, trigger: { metric: "Receivables Balance", operator: ">", value: "$500K" }, actions: [{ channel: "email", recipients: "cfo@tmc.com, finance-team@tmc.com" }, { channel: "whatsapp", recipients: "+971 50 123 4567" }], schedule: "Hourly", lastTriggered: "2 hours ago", executionCount: 47, createdAt: "Jan 15, 2026" },
  { id: 2, name: "Low Inventory — Raw Materials", enabled: true, trigger: { metric: "Inventory Level", operator: "<", value: "100 units" }, actions: [{ channel: "email", recipients: "procurement@tmc.com" }, { channel: "slack", recipients: "#supply-chain-alerts" }], schedule: "Real-time", lastTriggered: "35 min ago", executionCount: 128, createdAt: "Feb 1, 2026" },
  { id: 3, name: "Quality Defect Rate Spike", enabled: true, trigger: { metric: "Defect Rate", operator: ">", value: "2%" }, actions: [{ channel: "email", recipients: "quality@tmc.com" }, { channel: "sms", recipients: "+971 55 987 6543" }], schedule: "Real-time", lastTriggered: "Yesterday", executionCount: 12, createdAt: "Feb 10, 2026" },
  { id: 4, name: "Pipeline Value Drop", enabled: false, trigger: { metric: "Pipeline Value", operator: "changes by", value: "-15%" }, actions: [{ channel: "slack", recipients: "#sales-leadership" }], schedule: "Daily", lastTriggered: "3 days ago", executionCount: 8, createdAt: "Feb 15, 2026" },
  { id: 5, name: "Cash Flow Critical", enabled: true, trigger: { metric: "Cash Flow", operator: "<", value: "$200K" }, actions: [{ channel: "email", recipients: "cfo@tmc.com" }, { channel: "whatsapp", recipients: "+971 50 123 4567" }, { channel: "sms", recipients: "+971 50 123 4567" }], schedule: "Daily", lastTriggered: "1 week ago", executionCount: 3, createdAt: "Feb 20, 2026" },
  { id: 6, name: "Employee Turnover Alert", enabled: false, trigger: { metric: "Turnover Rate", operator: ">", value: "8%" }, actions: [{ channel: "email", recipients: "hr-director@tmc.com" }, { channel: "slack", recipients: "#hr-leadership" }], schedule: "Weekly", lastTriggered: "Never", executionCount: 0, createdAt: "Mar 1, 2026" },
];

const MOCK_EXECUTIONS = [
  { id: 1, ruleName: "Low Inventory — Raw Materials", time: "35 min ago", channel: "email", status: "success", detail: "Sent to procurement@tmc.com" },
  { id: 2, ruleName: "Low Inventory — Raw Materials", time: "35 min ago", channel: "slack", status: "success", detail: "Posted to #supply-chain-alerts" },
  { id: 3, ruleName: "High Receivables Alert", time: "2 hours ago", channel: "email", status: "success", detail: "Sent to cfo@tmc.com, finance-team@tmc.com" },
  { id: 4, ruleName: "High Receivables Alert", time: "2 hours ago", channel: "whatsapp", status: "failed", detail: "Delivery failed — recipient offline" },
  { id: 5, ruleName: "Quality Defect Rate Spike", time: "Yesterday", channel: "email", status: "success", detail: "Sent to quality@tmc.com" },
  { id: 6, ruleName: "Quality Defect Rate Spike", time: "Yesterday", channel: "sms", status: "success", detail: "Sent to +971 55 987 6543" },
  { id: 7, ruleName: "Pipeline Value Drop", time: "3 days ago", channel: "slack", status: "success", detail: "Posted to #sales-leadership" },
  { id: 8, ruleName: "Cash Flow Critical", time: "1 week ago", channel: "email", status: "success", detail: "Sent to cfo@tmc.com" },
  { id: 9, ruleName: "Cash Flow Critical", time: "1 week ago", channel: "whatsapp", status: "success", detail: "Sent to +971 50 123 4567" },
  { id: 10, ruleName: "Cash Flow Critical", time: "1 week ago", channel: "sms", status: "failed", detail: "SMS quota exceeded" },
];

// ─── Rules Engine Page ───
const RulesEnginePage = () => {
  const [rules, setRules] = useState(MOCK_RULES);
  const [showModal, setShowModal] = useState(false);
  const [modalStep, setModalStep] = useState(1);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [execFilter, setExecFilter] = useState("all");
  const [newRule, setNewRule] = useState({ name: "", metric: "", operator: "gt", value: "", unit: "", channels: [], recipients: {}, schedule: "realtime", message: "" });
  const [metricDropdownOpen, setMetricDropdownOpen] = useState(false);

  const amber = { primary: "#F59E0B", deep: "#D97706", light: "#FFFBEB", badge: "#FEF3C7" };

  const toggleRule = (id) => setRules(prev => prev.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));

  const getChannelInfo = (ch) => ACTION_CHANNELS.find(c => c.id === ch) || ACTION_CHANNELS[0];

  const openFromTemplate = (tpl) => {
    setNewRule({ name: tpl.title, metric: tpl.metric, operator: tpl.operator, value: tpl.value, unit: tpl.unit, channels: [...tpl.channels], recipients: {}, schedule: tpl.schedule, message: "" });
    setModalStep(1);
    setShowModal(true);
  };

  const createRule = () => {
    const opLabel = RULE_OPERATORS.find(o => o.id === newRule.operator)?.label || ">";
    const rule = {
      id: rules.length + 1, name: newRule.name || `${newRule.metric} Alert`, enabled: true,
      trigger: { metric: newRule.metric, operator: opLabel, value: `${newRule.unit === "$" ? "$" : ""}${newRule.value}${newRule.unit && newRule.unit !== "$" ? " " + newRule.unit : ""}` },
      actions: newRule.channels.map(ch => ({ channel: ch, recipients: newRule.recipients[ch] || "" })),
      schedule: newRule.schedule === "realtime" ? "Real-time" : newRule.schedule.charAt(0).toUpperCase() + newRule.schedule.slice(1),
      lastTriggered: "Never", executionCount: 0, createdAt: "Just now"
    };
    setRules(prev => [rule, ...prev]);
    setShowModal(false);
    setNewRule({ name: "", metric: "", operator: "gt", value: "", unit: "", channels: [], recipients: {}, schedule: "realtime", message: "" });
    setModalStep(1);
  };

  const filteredTemplates = selectedCategory === "all" ? RULES_TEMPLATES : RULES_TEMPLATES.filter(t => t.category === selectedCategory);
  const filteredExecs = execFilter === "all" ? MOCK_EXECUTIONS : MOCK_EXECUTIONS.filter(e => e.status === execFilter);
  const activeCount = rules.filter(r => r.enabled).length;
  const pausedCount = rules.length - activeCount;

  const stepLabels = ["Trigger", "Actions", "Schedule", "Review"];

  return (
    <div style={{ display: "flex", height: "100%", gap: 0 }}>
      {/* ─── Left: Rules List ─── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Action Bar */}
        <div style={{ padding: "16px 28px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surface, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => { setShowModal(true); setModalStep(1); setNewRule({ name: "", metric: "", operator: "gt", value: "", unit: "", channels: [], recipients: {}, schedule: "realtime", message: "" }); }} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 12, border: "none", cursor: "pointer",
              background: `linear-gradient(135deg, ${amber.primary}, ${amber.deep})`, color: "#fff", fontSize: 13, fontWeight: 600,
              boxShadow: "0 2px 8px rgba(245,158,11,0.3)", transition: "all 0.15s"
            }}>
              <Plus size={16} /> Create New Rule
            </button>
            <span style={{ fontSize: 12, color: COLORS.textMuted }}>{activeCount} active &middot; {pausedCount} paused</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {ACTION_CHANNELS.slice(0, 4).map(ch => (
              <div key={ch.id} style={{ display: "flex", alignItems: "center", gap: 3, padding: "4px 8px", background: ch.bg, borderRadius: 16 }}>
                <ch.icon size={11} color={ch.color} />
                <span style={{ fontSize: 9, color: ch.color, fontWeight: 500 }}>{ch.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Rules List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>
          {rules.length === 0 ? (
            <div style={{ textAlign: "center", paddingTop: 60 }}>
              <div style={{ width: 64, height: 64, borderRadius: 20, background: `linear-gradient(135deg, ${amber.primary}, ${amber.deep})`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                <Zap size={32} color="#fff" />
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>Set up your first rule</div>
              <div style={{ fontSize: 14, color: COLORS.textSecondary, maxWidth: 400, margin: "0 auto" }}>
                Automate alerts and notifications based on your business metrics. Get notified via email, WhatsApp, SMS, or Slack.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {rules.map(rule => (
                <div key={rule.id} style={{
                  padding: "18px 20px", background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14,
                  transition: "all 0.15s", cursor: "pointer", position: "relative"
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = amber.primary; e.currentTarget.style.boxShadow = "0 2px 12px rgba(245,158,11,0.12)"; e.currentTarget.style.background = amber.light; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = COLORS.border; e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.background = COLORS.surface; }}
                >
                  {/* Top row */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>{rule.name}</div>
                    <button onClick={e => { e.stopPropagation(); toggleRule(rule.id); }} style={{
                      width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer", position: "relative",
                      background: rule.enabled ? amber.primary : "#D1D5DB", transition: "all 0.2s", padding: 0
                    }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: "50%", background: COLORS.surface, position: "absolute", top: 3,
                        left: rule.enabled ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)"
                      }} />
                    </button>
                  </div>
                  {/* Condition */}
                  <div style={{ fontSize: 12, color: COLORS.textSecondary, marginBottom: 10 }}>
                    When <span style={{ fontWeight: 600, color: COLORS.textPrimary }}>{rule.trigger.metric}</span> {rule.trigger.operator} <span style={{ fontWeight: 600, color: amber.deep }}>{rule.trigger.value}</span>
                  </div>
                  {/* Actions + Schedule row */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {rule.actions.map((a, i) => {
                        const ch = getChannelInfo(a.channel);
                        return (
                          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 500, padding: "3px 8px", borderRadius: 6, background: ch.bg, color: ch.color }}>
                            <ch.icon size={10} /> {ch.label}
                          </span>
                        );
                      })}
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 500, padding: "3px 8px", borderRadius: 6, background: COLORS.surfaceAlt, color: COLORS.textSecondary }}>
                        <Clock size={10} /> {rule.schedule}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: COLORS.textMuted, textAlign: "right" }}>
                      <div>Last: {rule.lastTriggered}</div>
                      <div>{rule.executionCount} executions</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── Right Sidebar ─── */}
      <div style={{ width: 340, borderLeft: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt, display: "flex", flexDirection: "column", overflowY: "auto", flexShrink: 0 }}>
        {/* Rule Templates */}
        <div style={{ padding: "18px 18px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <Sparkles size={14} color={amber.primary} />
            <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>Rule Templates</span>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
            {RULES_CATEGORIES.map(c => (
              <button key={c.id} onClick={() => setSelectedCategory(c.id)} style={{
                padding: "4px 10px", borderRadius: 16, border: `1px solid ${selectedCategory === c.id ? amber.primary : COLORS.border}`,
                background: selectedCategory === c.id ? amber.badge : "#fff", color: selectedCategory === c.id ? amber.deep : COLORS.textSecondary,
                fontSize: 10, fontWeight: 500, cursor: "pointer", transition: "all 0.15s"
              }}>{c.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 240, overflowY: "auto" }}>
            {filteredTemplates.map(tpl => (
              <div key={tpl.id} onClick={() => openFromTemplate(tpl)} style={{
                padding: "12px 14px", background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
                cursor: "pointer", transition: "all 0.15s"
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = amber.primary; e.currentTarget.style.background = amber.light; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = COLORS.border; e.currentTarget.style.background = COLORS.surface; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <tpl.icon size={14} color={tpl.color} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{tpl.title}</span>
                </div>
                <div style={{ fontSize: 10, color: COLORS.textSecondary, marginBottom: 6 }}>{tpl.description}</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {tpl.channels.map(ch => {
                    const info = getChannelInfo(ch);
                    return <span key={ch} style={{ fontSize: 8, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: info.bg, color: info.color }}>{info.label}</span>;
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Execution History */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <Activity size={14} color={COLORS.textSecondary} />
            <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>Execution History</span>
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {[{ id: "all", label: "All" }, { id: "success", label: "Success" }, { id: "failed", label: "Failed" }].map(f => (
              <button key={f.id} onClick={() => setExecFilter(f.id)} style={{
                padding: "3px 10px", borderRadius: 12, border: `1px solid ${execFilter === f.id ? (f.id === "failed" ? COLORS.danger : f.id === "success" ? COLORS.success : amber.primary) : COLORS.border}`,
                background: execFilter === f.id ? (f.id === "failed" ? "#FEF2F2" : f.id === "success" ? "#F0FDF4" : amber.badge) : "#fff",
                color: execFilter === f.id ? (f.id === "failed" ? COLORS.danger : f.id === "success" ? "#16A34A" : amber.deep) : COLORS.textMuted,
                fontSize: 10, fontWeight: 500, cursor: "pointer"
              }}>{f.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
            {filteredExecs.map(ex => (
              <div key={ex.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", background: COLORS.surface, borderRadius: 8, border: `1px solid ${COLORS.border}` }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: ex.status === "success" ? COLORS.success : COLORS.danger, marginTop: 5, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ex.ruleName}</div>
                  <div style={{ fontSize: 9, color: COLORS.textMuted }}>{ex.time} &middot; {ex.detail}</div>
                </div>
                {(() => { const ch = getChannelInfo(ex.channel); return <ch.icon size={12} color={ch.color} style={{ flexShrink: 0, marginTop: 2 }} />; })()}
              </div>
            ))}
          </div>
        </div>

        {/* Quick Stats */}
        <div style={{ padding: "14px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <Target size={14} color={COLORS.textSecondary} />
            <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>Quick Stats</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Total", value: rules.length, color: COLORS.textPrimary },
              { label: "Active", value: activeCount, color: COLORS.success },
              { label: "Triggered", value: "24", color: amber.primary },
            ].map(s => (
              <div key={s.label} style={{ textAlign: "center", padding: "10px 8px", background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}` }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 9, color: COLORS.textMuted, fontWeight: 500 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Rule Creation Modal ─── */}
      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setShowModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 560, maxHeight: "80vh", background: COLORS.surface, borderRadius: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {/* Modal Header */}
            <div style={{ padding: "20px 28px 16px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>Create New Rule</div>
              <button onClick={() => setShowModal(false)} style={{ width: 28, height: 28, borderRadius: 8, border: "none", background: COLORS.surfaceAlt, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <X size={14} color={COLORS.textMuted} />
              </button>
            </div>

            {/* Step Indicator */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "16px 28px 12px" }}>
              {stepLabels.map((label, i) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 600,
                      background: modalStep > i + 1 ? COLORS.success : modalStep === i + 1 ? amber.primary : "#E5E7EB",
                      color: modalStep >= i + 1 ? "#fff" : COLORS.textMuted
                    }}>
                      {modalStep > i + 1 ? <CheckCircle size={14} /> : i + 1}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: modalStep === i + 1 ? 600 : 400, color: modalStep === i + 1 ? amber.deep : COLORS.textMuted }}>{label}</span>
                  </div>
                  {i < 3 && <div style={{ width: 24, height: 1, background: modalStep > i + 1 ? COLORS.success : "#E5E7EB" }} />}
                </div>
              ))}
            </div>

            {/* Modal Body */}
            <div style={{ padding: "16px 28px 24px", overflowY: "auto", flex: 1 }}>
              {/* Step 1: Trigger */}
              {modalStep === 1 && (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 4 }}>When this happens...</div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 20 }}>Define the condition that triggers this rule</div>
                  {/* Metric */}
                  <label style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 6, display: "block" }}>Metric</label>
                  <div style={{ position: "relative", marginBottom: 14 }}>
                    <button onClick={() => setMetricDropdownOpen(!metricDropdownOpen)} style={{
                      width: "100%", padding: "10px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.surfaceAlt,
                      fontSize: 13, color: newRule.metric ? COLORS.textPrimary : COLORS.textMuted, cursor: "pointer", textAlign: "left",
                      display: "flex", justifyContent: "space-between", alignItems: "center"
                    }}>
                      <span>{newRule.metric || "Select a metric..."}</span>
                      <ChevronDown size={14} color={COLORS.textMuted} />
                    </button>
                    {metricDropdownOpen && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.1)", zIndex: 10, maxHeight: 220, overflowY: "auto", marginTop: 4 }}>
                        {RULE_METRICS.map(g => (
                          <div key={g.group}>
                            <div style={{ padding: "8px 14px 4px", fontSize: 9, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>{g.group}</div>
                            {g.items.map(item => (
                              <button key={item} onClick={() => { setNewRule(p => ({ ...p, metric: item })); setMetricDropdownOpen(false); }} style={{
                                width: "100%", padding: "8px 14px 8px 24px", border: "none", background: newRule.metric === item ? amber.light : "transparent",
                                fontSize: 12, color: COLORS.textPrimary, cursor: "pointer", textAlign: "left"
                              }}
                              onMouseEnter={e => { if (newRule.metric !== item) e.currentTarget.style.background = COLORS.surfaceAlt; }}
                              onMouseLeave={e => { if (newRule.metric !== item) e.currentTarget.style.background = "transparent"; }}
                              >{item}</button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Operator + Value */}
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 6, display: "block" }}>Condition</label>
                      <select value={newRule.operator} onChange={e => setNewRule(p => ({ ...p, operator: e.target.value }))} style={{
                        width: "100%", padding: "10px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.surfaceAlt, fontSize: 13, color: COLORS.textPrimary, cursor: "pointer"
                      }}>
                        {RULE_OPERATORS.map(o => <option key={o.id} value={o.id}>{o.label} ({o.desc})</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 6, display: "block" }}>Value</label>
                      <input value={newRule.value} onChange={e => setNewRule(p => ({ ...p, value: e.target.value }))} placeholder="e.g. 500000" style={{
                        width: "100%", padding: "10px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.surfaceAlt, fontSize: 13, outline: "none", boxSizing: "border-box"
                      }} />
                    </div>
                    <div style={{ width: 80 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 6, display: "block" }}>Unit</label>
                      <input value={newRule.unit} onChange={e => setNewRule(p => ({ ...p, unit: e.target.value }))} placeholder="$, %, etc." style={{
                        width: "100%", padding: "10px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.surfaceAlt, fontSize: 13, outline: "none", boxSizing: "border-box"
                      }} />
                    </div>
                  </div>
                  {/* Preview */}
                  {newRule.metric && newRule.value && (
                    <div style={{ marginTop: 16, padding: "12px 16px", background: amber.light, borderRadius: 10, border: `1px solid ${amber.badge}` }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: amber.deep, marginBottom: 2 }}>Rule preview</div>
                      <div style={{ fontSize: 13, color: COLORS.textPrimary }}>
                        Alert when <strong>{newRule.metric}</strong> {RULE_OPERATORS.find(o => o.id === newRule.operator)?.desc || ">"} <strong>{newRule.unit === "$" ? "$" : ""}{newRule.value}{newRule.unit && newRule.unit !== "$" ? " " + newRule.unit : ""}</strong>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: Actions */}
              {modalStep === 2 && (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 4 }}>Then do this...</div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 20 }}>Choose notification channels and recipients</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
                    {ACTION_CHANNELS.map(ch => {
                      const active = newRule.channels.includes(ch.id);
                      return (
                        <button key={ch.id} onClick={() => setNewRule(p => ({ ...p, channels: active ? p.channels.filter(c => c !== ch.id) : [...p.channels, ch.id] }))} style={{
                          padding: "14px 16px", borderRadius: 12, border: `2px solid ${active ? ch.color : COLORS.border}`,
                          background: active ? ch.bg : "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s"
                        }}>
                          <div style={{ width: 36, height: 36, borderRadius: 10, background: active ? ch.color : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}>
                            <ch.icon size={18} color={active ? "#fff" : COLORS.textMuted} />
                          </div>
                          <div style={{ textAlign: "left" }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: active ? ch.color : COLORS.textPrimary }}>{ch.label}</div>
                            <div style={{ fontSize: 10, color: COLORS.textMuted }}>{active ? "Enabled" : "Click to enable"}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {/* Recipient inputs */}
                  {newRule.channels.map(chId => {
                    const ch = getChannelInfo(chId);
                    return (
                      <div key={chId} style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: ch.color, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
                          <ch.icon size={12} /> {ch.label} Recipients
                        </label>
                        <input value={newRule.recipients[chId] || ""} onChange={e => setNewRule(p => ({ ...p, recipients: { ...p.recipients, [chId]: e.target.value } }))}
                          placeholder={chId === "email" ? "email@company.com" : chId === "slack" ? "#channel-name" : chId === "webhook" ? "https://..." : "+971 50 xxx xxxx"}
                          style={{ width: "100%", padding: "10px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.surfaceAlt, fontSize: 12, outline: "none", boxSizing: "border-box" }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Step 3: Schedule */}
              {modalStep === 3 && (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 4 }}>How often to check...</div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 20 }}>Set the monitoring frequency for this rule</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {[
                      { id: "realtime", label: "Real-time", desc: "Check continuously", icon: Zap },
                      { id: "hourly", label: "Every Hour", desc: "Check once per hour", icon: Clock },
                      { id: "daily", label: "Every Day", desc: "Check once per day", icon: Activity },
                      { id: "weekly", label: "Every Week", desc: "Check once per week", icon: Target },
                    ].map(s => (
                      <button key={s.id} onClick={() => setNewRule(p => ({ ...p, schedule: s.id }))} style={{
                        padding: "18px 16px", borderRadius: 12, border: `2px solid ${newRule.schedule === s.id ? amber.primary : COLORS.border}`,
                        background: newRule.schedule === s.id ? amber.light : "#fff", cursor: "pointer", textAlign: "left", transition: "all 0.15s"
                      }}>
                        <s.icon size={20} color={newRule.schedule === s.id ? amber.primary : COLORS.textMuted} style={{ marginBottom: 8 }} />
                        <div style={{ fontSize: 13, fontWeight: 600, color: newRule.schedule === s.id ? amber.deep : COLORS.textPrimary }}>{s.label}</div>
                        <div style={{ fontSize: 10, color: COLORS.textMuted }}>{s.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 4: Review */}
              {modalStep === 4 && (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 16 }}>Review & Create</div>
                  {/* Rule Name */}
                  <label style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 6, display: "block" }}>Rule Name</label>
                  <input value={newRule.name} onChange={e => setNewRule(p => ({ ...p, name: e.target.value }))} placeholder={`${newRule.metric || "Custom"} Alert`} style={{
                    width: "100%", padding: "10px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.surfaceAlt, fontSize: 13, outline: "none", marginBottom: 16, boxSizing: "border-box"
                  }} />
                  {/* Summary */}
                  <div style={{ background: COLORS.surfaceAlt, borderRadius: 12, padding: "16px 18px", border: `1px solid ${COLORS.border}` }}>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Trigger</div>
                      <div style={{ fontSize: 13, color: COLORS.textPrimary }}>
                        When {newRule.metric} {RULE_OPERATORS.find(o => o.id === newRule.operator)?.desc} {newRule.unit === "$" ? "$" : ""}{newRule.value}{newRule.unit && newRule.unit !== "$" ? " " + newRule.unit : ""}
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Actions</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {newRule.channels.map(chId => {
                          const ch = getChannelInfo(chId);
                          return <span key={chId} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 500, padding: "4px 10px", borderRadius: 6, background: ch.bg, color: ch.color }}><ch.icon size={11} /> {ch.label}</span>;
                        })}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Schedule</div>
                      <div style={{ fontSize: 13, color: COLORS.textPrimary }}>{newRule.schedule === "realtime" ? "Real-time monitoring" : `${newRule.schedule.charAt(0).toUpperCase() + newRule.schedule.slice(1)} checks`}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ padding: "14px 28px 20px", borderTop: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => modalStep === 1 ? setShowModal(false) : setModalStep(s => s - 1)} style={{
                padding: "10px 20px", borderRadius: 10, border: `1px solid ${COLORS.border}`, background: COLORS.surface,
                fontSize: 13, fontWeight: 500, color: COLORS.textSecondary, cursor: "pointer"
              }}>{modalStep === 1 ? "Cancel" : "Back"}</button>
              <button onClick={() => modalStep === 4 ? createRule() : setModalStep(s => s + 1)}
                disabled={modalStep === 1 && (!newRule.metric || !newRule.value) || modalStep === 2 && newRule.channels.length === 0}
                style={{
                  padding: "10px 24px", borderRadius: 10, border: "none", cursor: "pointer",
                  background: (modalStep === 1 && (!newRule.metric || !newRule.value)) || (modalStep === 2 && newRule.channels.length === 0)
                    ? "#E5E7EB" : `linear-gradient(135deg, ${amber.primary}, ${amber.deep})`,
                  color: "#fff", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
                  boxShadow: (modalStep === 1 && (!newRule.metric || !newRule.value)) || (modalStep === 2 && newRule.channels.length === 0)
                    ? "none" : "0 2px 8px rgba(245,158,11,0.3)"
                }}>
                {modalStep === 4 ? "Create Rule" : "Next"} {modalStep < 4 && <ArrowRight size={14} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Shared Filter Dropdown ───
const FilterDropdown = ({ label, options, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6, background: value ? `${COLORS.accent}20` : COLORS.surfaceAlt,
          border: `1px solid ${value ? COLORS.accent : COLORS.border}`, borderRadius: 8, padding: "6px 14px",
          fontSize: 12.5, color: value ? COLORS.textPrimary : COLORS.textSecondary, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
        }}
      >
        {value || label} <ChevronDown size={13} />
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 4, background: COLORS.surface, border: `1px solid ${COLORS.border}`,
          borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 100, maxHeight: 240, overflowY: "auto", minWidth: 180,
        }}>
          <div onClick={() => { onChange(null); setOpen(false); }} style={{
            padding: "8px 14px", fontSize: 12.5, cursor: "pointer", color: COLORS.textMuted, fontStyle: "italic",
            borderBottom: `1px solid ${COLORS.border}`,
          }}>Clear filter</div>
          {(options || []).map(opt => (
            <div key={opt} onClick={() => { onChange(opt); setOpen(false); }} style={{
              padding: "7px 14px", fontSize: 12.5, cursor: "pointer", background: opt === value ? `${COLORS.accent}15` : "transparent",
              fontWeight: opt === value ? 600 : 400, color: COLORS.textPrimary,
            }}
              onMouseEnter={e => e.currentTarget.style.background = `${COLORS.accent}10`}
              onMouseLeave={e => e.currentTarget.style.background = opt === value ? `${COLORS.accent}15` : "transparent"}
            >{opt}</div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Dealer / Product Orders Helpers ───
const _arApi = () => import.meta.env.VITE_API_BASE || "";

const arTableHeaderStyle = {
  padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 11,
  color: "#fff", textTransform: "uppercase", letterSpacing: 0.5,
  background: COLORS.primary, whiteSpace: "nowrap",
};
const arCellStyle = { padding: "8px 12px", fontSize: 13, borderBottom: `1px solid ${COLORS.border}`, whiteSpace: "nowrap" };
const fmtQty = (v) => v != null ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 }) : "0";

const DealerOrdersDashboard = () => {
  const [rawData, setRawData] = useState(null);
  const [serverSummary, setServerSummary] = useState({});
  const [serverTopDealers, setServerTopDealers] = useState([]);
  const [serverQtyByPlant, setServerQtyByPlant] = useState([]);
  const [serverStacked, setServerStacked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ dealer_name: null, plant_name: null, product: null });
  const [page, setPage] = useState(1);

  const token = localStorage.getItem("token");
  const base = _arApi();

  useEffect(() => {
    fetch(`${base}/api/ar/data`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => {
        setRawData(d.data || []);
        setServerSummary(d.summary || {});
        setServerTopDealers(d.top_dealers || []);
        setServerQtyByPlant(d.qty_by_plant || []);
        setServerStacked(d.stacked || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filterOpts = useMemo(() => {
    if (!rawData) return {};
    return {
      dealer_names: [...new Set(rawData.map(r => r.dealer_name).filter(Boolean))].sort(),
      plant_names: [...new Set(rawData.map(r => r.plant_name).filter(Boolean))].sort(),
      products: [...new Set(rawData.map(r => r.product).filter(Boolean))].sort(),
    };
  }, [rawData]);

  const filtered = useMemo(() => {
    if (!rawData) return [];
    return rawData.filter(r => {
      if (filters.dealer_name && r.dealer_name !== filters.dealer_name) return false;
      if (filters.plant_name && r.plant_name !== filters.plant_name) return false;
      if (filters.product && r.product !== filters.product) return false;
      return true;
    });
  }, [rawData, filters]);

  const hasFilters = filters.dealer_name || filters.plant_name || filters.product;

  const summary = useMemo(() => {
    if (!hasFilters && serverSummary.total_orders != null) {
      return {
        totalOrders: serverSummary.total_orders, totalQty: serverSummary.total_qty,
        uniqueDealers: serverSummary.unique_dealers, uniqueProducts: serverSummary.unique_products,
        uniquePlants: serverSummary.unique_plants, avgQtyPerOrder: serverSummary.avg_qty_per_order,
      };
    }
    if (!filtered.length) return {};
    const totalQty = filtered.reduce((s, r) => s + (r.qty || 0), 0);
    return {
      totalOrders: filtered.length, totalQty,
      uniqueDealers: new Set(filtered.map(r => r.dealer_code)).size,
      uniqueProducts: new Set(filtered.map(r => r.product)).size,
      uniquePlants: new Set(filtered.map(r => r.plant_name)).size,
      avgQtyPerOrder: filtered.length ? Math.round(totalQty / filtered.length * 10) / 10 : 0,
    };
  }, [filtered, hasFilters, serverSummary]);

  const topDealers = useMemo(() => {
    if (!hasFilters && serverTopDealers.length) return serverTopDealers;
    const byDealer = {};
    filtered.forEach(r => {
      const key = r.dealer_code || "?";
      if (!byDealer[key]) byDealer[key] = { dealer_code: key, dealer_name: r.dealer_name || key, qty: 0 };
      byDealer[key].qty += r.qty || 0;
    });
    return Object.values(byDealer).sort((a, b) => b.qty - a.qty).slice(0, 10);
  }, [filtered, hasFilters, serverTopDealers]);

  const qtyByPlant = useMemo(() => {
    if (!hasFilters && serverQtyByPlant.length) return serverQtyByPlant;
    const byPlant = {};
    filtered.forEach(r => {
      const key = r.plant_name || "Unknown";
      byPlant[key] = (byPlant[key] || 0) + (r.qty || 0);
    });
    return Object.entries(byPlant).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
  }, [filtered, hasFilters, serverQtyByPlant]);

  // Product-wise demand across top dealers (stacked bar)
  const { stackedData, productKeys } = useMemo(() => {
    if (!hasFilters && serverStacked.length) {
      const prodSet = new Set();
      const dealerTotals = {};
      const map = {};
      serverStacked.forEach(r => {
        prodSet.add(r.product);
        dealerTotals[r.dealer_name] = (dealerTotals[r.dealer_name] || 0) + (r.qty || 0);
        if (!map[r.dealer_name]) map[r.dealer_name] = { dealer: r.dealer_name };
        map[r.dealer_name][r.product] = (map[r.dealer_name][r.product] || 0) + (r.qty || 0);
      });
      const topDlrs = Object.entries(dealerTotals).sort((a, b) => b[1] - a[1]).map(e => e[0]);
      return { stackedData: topDlrs.map(d => map[d] || { dealer: d }).reverse(), productKeys: [...prodSet] };
    }
    if (!filtered.length) return { stackedData: [], productKeys: [] };
    const prodTotals = {};
    filtered.forEach(r => { prodTotals[r.product || "Other"] = (prodTotals[r.product || "Other"] || 0) + (r.qty || 0); });
    const topProds = Object.entries(prodTotals).sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);
    const dealerTotals = {};
    filtered.forEach(r => { dealerTotals[r.dealer_name || "Unknown"] = (dealerTotals[r.dealer_name || "Unknown"] || 0) + (r.qty || 0); });
    const topDlrs = Object.entries(dealerTotals).sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0]);
    const map = {};
    filtered.forEach(r => {
      const d = r.dealer_name || "Unknown";
      const p = topProds.includes(r.product) ? r.product : null;
      if (!topDlrs.includes(d) || !p) return;
      if (!map[d]) map[d] = { dealer: d };
      map[d][p] = (map[d][p] || 0) + (r.qty || 0);
    });
    return { stackedData: topDlrs.map(d => map[d] || { dealer: d }).reverse(), productKeys: topProds };
  }, [filtered, hasFilters, serverStacked]);

  const pageData = useMemo(() => {
    const total = filtered.length;
    const items = filtered.slice((page - 1) * 100, page * 100);
    return { items, total };
  }, [filtered, page]);

  const applyFilter = (key, val) => { setFilters(f => ({ ...f, [key]: val })); setPage(1); };

  const s = summary;
  const STACK_COLORS = ["#4285F4", "#F4A940", "#AB68CC", "#A8B820", "#4DC9C9", "#E87070", "#7B9EE6", "#66BB6A"];

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300, color: COLORS.textMuted }}>
        <Activity size={20} style={{ marginRight: 8, animation: "spin 1s linear infinite" }} /> Loading Dealer Orders data...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Filter Bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <FilterDropdown label="Dealer Name" options={filterOpts.dealer_names} value={filters.dealer_name} onChange={v => applyFilter("dealer_name", v)} />
        <FilterDropdown label="Plant Name" options={filterOpts.plant_names} value={filters.plant_name} onChange={v => applyFilter("plant_name", v)} />
        <FilterDropdown label="Product" options={filterOpts.products} value={filters.product} onChange={v => applyFilter("product", v)} />
      </div>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <KPICard title="Total Quantity Sold" value={fmtQty(s.totalQty)} icon={Layers} color={COLORS.success} />
        <KPICard title="Total Orders" value={fmtQty(s.totalOrders)} icon={Package} color={COLORS.info} />
        <KPICard title="Active Dealers" value={fmtQty(s.uniqueDealers)} icon={Users} color={COLORS.accent} />
        <KPICard title="Avg Quantity per Order" value={fmtQty(s.avgQtyPerOrder)} icon={TrendingUp} color={COLORS.danger} />
      </div>

      {/* Product-wise Demand Across Dealers (full width stacked bar) */}
      <ChartCard title="Product-wise Demand Across Dealers">
        <ResponsiveContainer width="100%" height={Math.max(400, stackedData.length * 36)}>
          <BarChart data={stackedData} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
            <YAxis dataKey="dealer" type="category" tick={{ fontSize: 11, fill: COLORS.textSecondary }} width={130} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Qty"]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {productKeys.map((prod, i) => (
              <Bar key={prod} dataKey={prod} stackId="a" fill={STACK_COLORS[i % STACK_COLORS.length]} barSize={22} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Charts Row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Top 10 Dealers by Quantity">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topDealers} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => fmtQty(v)} />
              <YAxis dataKey="dealer_name" type="category" tick={{ fontSize: 11, fill: COLORS.textSecondary }} width={120} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Quantity"]} />
              <Bar dataKey="qty" radius={[0, 4, 4, 0]} barSize={20}>
                {topDealers.map((_, i) => (
                  <Cell key={i} fill={COLORS.chartColors[i % COLORS.chartColors.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Quantity by Plant">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={qtyByPlant} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => fmtQty(v)} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: COLORS.textSecondary }} width={120} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Quantity"]} />
              <Bar dataKey="qty" fill={COLORS.primary} radius={[0, 4, 4, 0]} barSize={20}>
                {qtyByPlant.map((_, i) => (
                  <Cell key={i} fill={COLORS.chartColors[i % COLORS.chartColors.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Orders Table */}
      <ChartCard title="All Orders">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                {["Order No", "Dealer Code", "Dealer Name", "Plant", "Product", "Quantity"].map((h, i) => (
                  <th key={h} style={{ ...arTableHeaderStyle, textAlign: i === 5 ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageData.items.map((row, i) => (
                <tr key={`${row.order_no}-${i}`} style={{ background: i % 2 === 0 ? "#fff" : COLORS.surfaceAlt }}>
                  <td style={arCellStyle}>{row.order_no}</td>
                  <td style={arCellStyle}>{row.dealer_code}</td>
                  <td style={{ ...arCellStyle, fontWeight: 500 }}>{row.dealer_name}</td>
                  <td style={arCellStyle}>{row.plant_name}</td>
                  <td style={arCellStyle}>{row.product}</td>
                  <td style={{ ...arCellStyle, textAlign: "right", fontWeight: 600, color: COLORS.info }}>{fmtQty(row.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "10px 0 0", fontSize: 12, color: COLORS.textMuted }}>
            <span>{pageData.total > 0 ? ((page - 1) * 100) + 1 : 0} - {Math.min(page * 100, pageData.total)} / {pageData.total}</span>
            <button onClick={() => page > 1 && setPage(page - 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronLeft size={14} /></button>
            <button onClick={() => page * 100 < pageData.total && setPage(page + 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronRight size={14} /></button>
          </div>
        </div>
      </ChartCard>
    </div>
  );
};

// ─── Product Orders Dashboard ───
const ProductOrdersDashboard = () => {
  const [rawData, setRawData] = useState(null);
  const [serverSummary, setServerSummary] = useState({});
  const [serverTopProducts, setServerTopProducts] = useState([]);
  const [serverQtyByPlant, setServerQtyByPlant] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ product: null, plant_name: null, dealer_name: null });
  const [page, setPage] = useState(1);

  const token = localStorage.getItem("token");
  const base = _arApi();

  useEffect(() => {
    fetch(`${base}/api/ap/data`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => {
        setRawData(d.data || []);
        setServerSummary(d.summary || {});
        setServerTopProducts(d.top_products || []);
        setServerQtyByPlant(d.qty_by_plant || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filterOpts = useMemo(() => {
    if (!rawData) return {};
    return {
      products: [...new Set(rawData.map(r => r.product).filter(Boolean))].sort(),
      plant_names: [...new Set(rawData.map(r => r.plant_name).filter(Boolean))].sort(),
      dealer_names: [...new Set(rawData.map(r => r.dealer_name).filter(Boolean))].sort(),
    };
  }, [rawData]);

  const filtered = useMemo(() => {
    if (!rawData) return [];
    return rawData.filter(r => {
      if (filters.product && r.product !== filters.product) return false;
      if (filters.plant_name && r.plant_name !== filters.plant_name) return false;
      if (filters.dealer_name && r.dealer_name !== filters.dealer_name) return false;
      return true;
    });
  }, [rawData, filters]);

  const hasProdFilters = filters.product || filters.plant_name || filters.dealer_name;

  const summary = useMemo(() => {
    if (!hasProdFilters && serverSummary.total_orders != null) {
      return {
        totalProducts: serverSummary.total_products, totalQty: serverSummary.total_qty,
        totalOrders: serverSummary.total_orders, uniqueDealers: serverSummary.unique_dealers,
        uniquePlants: serverSummary.unique_plants,
      };
    }
    if (!filtered.length) return {};
    const totalQty = filtered.reduce((s, r) => s + (r.qty || 0), 0);
    return {
      totalProducts: new Set(filtered.map(r => r.product)).size, totalQty,
      totalOrders: filtered.length, uniqueDealers: new Set(filtered.map(r => r.dealer_code)).size,
      uniquePlants: new Set(filtered.map(r => r.plant_name)).size,
    };
  }, [filtered, hasProdFilters, serverSummary]);

  const topProducts = useMemo(() => {
    if (!hasProdFilters && serverTopProducts.length) return serverTopProducts;
    const byProduct = {};
    filtered.forEach(r => {
      const key = r.product || "Unknown";
      if (!byProduct[key]) byProduct[key] = { product: key, qty: 0 };
      byProduct[key].qty += r.qty || 0;
    });
    return Object.values(byProduct).sort((a, b) => b.qty - a.qty).slice(0, 10);
  }, [filtered, hasProdFilters, serverTopProducts]);

  const qtyByPlant = useMemo(() => {
    if (!hasProdFilters && serverQtyByPlant.length) return serverQtyByPlant;
    const byPlant = {};
    filtered.forEach(r => {
      const key = r.plant_name || "Unknown";
      byPlant[key] = (byPlant[key] || 0) + (r.qty || 0);
    });
    return Object.entries(byPlant).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
  }, [filtered, hasProdFilters, serverQtyByPlant]);

  const pageData = useMemo(() => {
    const total = filtered.length;
    const items = filtered.slice((page - 1) * 100, page * 100);
    return { items, total };
  }, [filtered, page]);

  const applyFilter = (key, val) => { setFilters(f => ({ ...f, [key]: val })); setPage(1); };

  const s = summary;

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300, color: COLORS.textMuted }}>
        <Activity size={20} style={{ marginRight: 8, animation: "spin 1s linear infinite" }} /> Loading Product Orders data...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Filter Bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <FilterDropdown label="Product" options={filterOpts.products} value={filters.product} onChange={v => applyFilter("product", v)} />
        <FilterDropdown label="Plant Name" options={filterOpts.plant_names} value={filters.plant_name} onChange={v => applyFilter("plant_name", v)} />
        <FilterDropdown label="Dealer Name" options={filterOpts.dealer_names} value={filters.dealer_name} onChange={v => applyFilter("dealer_name", v)} />
      </div>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16 }}>
        <KPICard title="Total Products" value={fmtQty(s.totalProducts)} icon={Package} color={COLORS.primary} />
        <KPICard title="Total Quantity" value={fmtQty(s.totalQty)} icon={Layers} color={COLORS.info} />
        <KPICard title="Total Orders" value={fmtQty(s.totalOrders)} icon={FileText} color={COLORS.accent} />
        <KPICard title="Unique Dealers" value={fmtQty(s.uniqueDealers)} icon={Users} color={COLORS.purple} />
        <KPICard title="Unique Plants" value={fmtQty(s.uniquePlants)} icon={Globe} color={COLORS.teal} />
      </div>

      {/* Charts Row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Top 10 Products by Quantity">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topProducts} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => fmtQty(v)} />
              <YAxis dataKey="product" type="category" tick={{ fontSize: 11, fill: COLORS.textSecondary }} width={120} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Quantity"]} />
              <Bar dataKey="qty" radius={[0, 4, 4, 0]} barSize={20}>
                {topProducts.map((_, i) => (
                  <Cell key={i} fill={COLORS.chartColors[i % COLORS.chartColors.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Quantity by Plant">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={qtyByPlant} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => fmtQty(v)} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: COLORS.textSecondary }} width={120} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Quantity"]} />
              <Bar dataKey="qty" fill={COLORS.primary} radius={[0, 4, 4, 0]} barSize={20}>
                {qtyByPlant.map((_, i) => (
                  <Cell key={i} fill={COLORS.chartColors[i % COLORS.chartColors.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Orders Table */}
      <ChartCard title="All Orders">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                {["Order No", "Product", "Plant", "Dealer Code", "Dealer Name", "Quantity"].map((h, i) => (
                  <th key={h} style={{ ...arTableHeaderStyle, textAlign: i === 5 ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageData.items.map((row, i) => (
                <tr key={`${row.order_no}-${i}`} style={{ background: i % 2 === 0 ? "#fff" : COLORS.surfaceAlt }}>
                  <td style={arCellStyle}>{row.order_no}</td>
                  <td style={{ ...arCellStyle, fontWeight: 500 }}>{row.product}</td>
                  <td style={arCellStyle}>{row.plant_name}</td>
                  <td style={arCellStyle}>{row.dealer_code}</td>
                  <td style={arCellStyle}>{row.dealer_name}</td>
                  <td style={{ ...arCellStyle, textAlign: "right", fontWeight: 600, color: COLORS.info }}>{fmtQty(row.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "10px 0 0", fontSize: 12, color: COLORS.textMuted }}>
            <span>{pageData.total > 0 ? ((page - 1) * 100) + 1 : 0} - {Math.min(page * 100, pageData.total)} / {pageData.total}</span>
            <button onClick={() => page > 1 && setPage(page - 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronLeft size={14} /></button>
            <button onClick={() => page * 100 < pageData.total && setPage(page + 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronRight size={14} /></button>
          </div>
        </div>
      </ChartCard>
    </div>
  );
};

// ─── Inventory & Stock Dashboard ───
const InventoryStockDashboard = () => {
  const [rawData, setRawData] = useState(null);
  const [serverSummary, setServerSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ material_name: null, plant_name: null, sales_district_name: null });
  const [page, setPage] = useState(1);

  const token = localStorage.getItem("token");
  const base = _arApi();

  useEffect(() => {
    fetch(`${base}/api/stock/data`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setRawData(d.data || []); setServerSummary(d.summary || {}); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filterOpts = useMemo(() => {
    if (!rawData) return {};
    return {
      material_names: [...new Set(rawData.map(r => r.material_name).filter(Boolean))].sort(),
      plant_names: [...new Set(rawData.map(r => r.plant_name).filter(Boolean))].sort(),
      sales_district_names: [...new Set(rawData.map(r => r.sales_district_name).filter(Boolean))].sort(),
    };
  }, [rawData]);

  const filtered = useMemo(() => {
    if (!rawData) return [];
    return rawData.filter(r => {
      if (filters.material_name && r.material_name !== filters.material_name) return false;
      if (filters.plant_name && r.plant_name !== filters.plant_name) return false;
      if (filters.sales_district_name && r.sales_district_name !== filters.sales_district_name) return false;
      return true;
    });
  }, [rawData, filters]);

  const hasFilters = filters.material_name || filters.plant_name || filters.sales_district_name;
  const summary = useMemo(() => {
    if (!hasFilters && serverSummary.total_stock_qty != null) {
      const t = serverSummary.total_stock_qty || 0;
      const m = serverSummary.total_materials || 0;
      return { totalStockQty: t, totalMaterials: m, activePlants: serverSummary.active_plants || 0, storageLocations: serverSummary.storage_locations || 0, avgStockPerMaterial: m ? Math.round(t / m * 100) / 100 : 0 };
    }
    if (!filtered.length) return {};
    const totalStockQty = filtered.reduce((s, r) => s + (r.stock_qty || 0), 0);
    const totalMaterials = new Set(filtered.map(r => r.material_name)).size;
    return {
      totalStockQty,
      totalMaterials,
      activePlants: new Set(filtered.map(r => r.plant_name)).size,
      storageLocations: new Set(filtered.map(r => r.storage_location_name)).size,
      avgStockPerMaterial: totalMaterials ? Math.round(totalStockQty / totalMaterials * 10) / 10 : 0,
    };
  }, [filtered, hasFilters, serverSummary]);

  const materialsByVolume = useMemo(() => {
    const byMaterial = {};
    filtered.forEach(r => {
      const key = r.material_name || "Unknown";
      byMaterial[key] = (byMaterial[key] || 0) + (r.stock_qty || 0);
    });
    return Object.entries(byMaterial).map(([material_name, stock_qty]) => ({ material_name, stock_qty })).sort((a, b) => b.stock_qty - a.stock_qty).slice(0, 10);
  }, [filtered]);

  const pageData = useMemo(() => {
    const total = filtered.length;
    const items = filtered.slice((page - 1) * 100, page * 100);
    return { items, total };
  }, [filtered, page]);

  const applyFilter = (key, val) => { setFilters(f => ({ ...f, [key]: val })); setPage(1); };

  const s = summary;

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300, color: COLORS.textMuted }}>
        <Activity size={20} style={{ marginRight: 8, animation: "spin 1s linear infinite" }} /> Loading Inventory & Stock data...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Filter Bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <FilterDropdown label="Material Name" options={filterOpts.material_names} value={filters.material_name} onChange={v => applyFilter("material_name", v)} />
        <FilterDropdown label="Plant Name" options={filterOpts.plant_names} value={filters.plant_name} onChange={v => applyFilter("plant_name", v)} />
        <FilterDropdown label="Sales District" options={filterOpts.sales_district_names} value={filters.sales_district_name} onChange={v => applyFilter("sales_district_name", v)} />
      </div>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16 }}>
        <KPICard title="Total Stock Quantity" value={fmtQty(s.totalStockQty)} icon={Layers} color={COLORS.success} />
        <KPICard title="Total Materials" value={fmtQty(s.totalMaterials)} icon={Package} color={COLORS.accent} />
        <KPICard title="Active Plants" value={fmtQty(s.activePlants)} icon={Factory} color={COLORS.info} />
        <KPICard title="Storage Locations" value={fmtQty(s.storageLocations)} icon={Warehouse} color={COLORS.danger} />
        <KPICard title="Avg Stock per Material" value={fmtQty(s.avgStockPerMaterial)} icon={TrendingUp} color={COLORS.purple} />
      </div>

      {/* Materials by Stock Volume Chart */}
      <ChartCard title="Materials by Stock Volume">
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={materialsByVolume} margin={{ top: 5, right: 30, left: 10, bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="material_name" tick={{ fontSize: 10, fill: COLORS.textSecondary }} angle={-30} textAnchor="end" interval={0} />
            <YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Stock Qty"]} />
            <Bar dataKey="stock_qty" fill="#F4733C" radius={[4, 4, 0, 0]} barSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Stock Table */}
      <ChartCard title="All Stock Records">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                {["Material", "Plant", "Storage Location", "District", "Office", "Date", "Stock Qty"].map((h, i) => (
                  <th key={h} style={{ ...arTableHeaderStyle, textAlign: i === 6 ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageData.items.map((row, i) => (
                <tr key={`${row.material_code}-${row.stock_date}-${i}`} style={{ background: i % 2 === 0 ? "#fff" : COLORS.surfaceAlt }}>
                  <td style={{ ...arCellStyle, fontWeight: 500 }}>{row.material_name}</td>
                  <td style={arCellStyle}>{row.plant_name}</td>
                  <td style={arCellStyle}>{row.storage_location_name}</td>
                  <td style={arCellStyle}>{row.sales_district_name}</td>
                  <td style={arCellStyle}>{row.sales_office_name}</td>
                  <td style={arCellStyle}>{row.stock_date}</td>
                  <td style={{ ...arCellStyle, textAlign: "right", fontWeight: 600, color: COLORS.info }}>{fmtQty(row.stock_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "10px 0 0", fontSize: 12, color: COLORS.textMuted }}>
            <span>{pageData.total > 0 ? ((page - 1) * 100) + 1 : 0} - {Math.min(page * 100, pageData.total)} / {pageData.total}</span>
            <button onClick={() => page > 1 && setPage(page - 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronLeft size={14} /></button>
            <button onClick={() => page * 100 < pageData.total && setPage(page + 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronRight size={14} /></button>
          </div>
        </div>
      </ChartCard>
    </div>
  );
};

// ─── Sales Invoice Dashboard ───
const SalesInvoiceDashboard = () => {
  const [rawData, setRawData] = useState(null);
  const [serverSummary, setServerSummary] = useState({});
  const [serverTopProducts, setServerTopProducts] = useState([]);
  const [serverTrend, setServerTrend] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ product_name: null, location_name: null });
  const [page, setPage] = useState(1);

  const token = localStorage.getItem("token");
  const base = _arApi();

  const parseDate = (s) => { if (!s || s.length !== 8) return null; return `${s.slice(4,8)}-${s.slice(2,4)}-${s.slice(0,2)}`; };

  useEffect(() => {
    fetch(`${base}/api/invoices/data`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => {
        setRawData(d.data || []);
        setServerSummary(d.summary || {});
        setServerTopProducts(d.top_products || []);
        setServerTrend(d.trend || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filterOpts = useMemo(() => {
    if (!rawData) return {};
    return {
      product_names: [...new Set(rawData.map(r => r.product_name).filter(Boolean))].sort(),
      location_names: [...new Set(rawData.map(r => r.location_name).filter(Boolean))].sort(),
    };
  }, [rawData]);

  const filtered = useMemo(() => {
    if (!rawData) return [];
    return rawData.filter(r => {
      if (filters.product_name && r.product_name !== filters.product_name) return false;
      if (filters.location_name && r.location_name !== filters.location_name) return false;
      return true;
    });
  }, [rawData, filters]);

  const hasInvFilters = filters.product_name || filters.location_name;
  const summary = useMemo(() => {
    if (!hasInvFilters && serverSummary.total_invoices != null) {
      return { totalSalesQty: serverSummary.total_sales_qty || 0, totalInvoices: serverSummary.total_invoices || 0, activeDealers: serverSummary.active_dealers || 0, avgQtyPerInvoice: serverSummary.avg_qty_per_invoice || 0 };
    }
    if (!filtered.length) return {};
    const totalSalesQty = filtered.reduce((s, r) => s + (r.invoice_qty || 0), 0);
    return {
      totalSalesQty,
      totalInvoices: filtered.length,
      activeDealers: new Set(filtered.map(r => r.dealer_code)).size,
      avgQtyPerInvoice: filtered.length ? Math.round(totalSalesQty / filtered.length * 10) / 10 : 0,
    };
  }, [filtered, hasInvFilters, serverSummary]);

  const TREND_COLORS = ["#4285F4", "#F4A940", "#AB68CC", "#A8B820", "#4DC9C9"];

  const { salesTrend, trendProducts } = useMemo(() => {
    // Use server trend data when no filters
    if (!hasInvFilters && serverTrend.length) {
      const prodSet = new Set();
      const byDate = {};
      serverTrend.forEach(r => {
        const d = parseDate(r.billing_date);
        if (!d) return;
        prodSet.add(r.product_name);
        if (!byDate[d]) byDate[d] = { date: d };
        byDate[d][r.product_name] = (byDate[d][r.product_name] || 0) + (r.qty || 0);
      });
      return { salesTrend: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)), trendProducts: [...prodSet] };
    }
    if (!filtered.length) return { salesTrend: [], trendProducts: [] };
    const prodTotals = {};
    filtered.forEach(r => { prodTotals[r.product_name || "Other"] = (prodTotals[r.product_name || "Other"] || 0) + (r.invoice_qty || 0); });
    const topProds = Object.entries(prodTotals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
    const byDate = {};
    filtered.forEach(r => {
      const d = parseDate(r.billing_date);
      if (!d) return;
      if (!byDate[d]) byDate[d] = { date: d };
      const prod = topProds.includes(r.product_name) ? r.product_name : null;
      if (prod) byDate[d][prod] = (byDate[d][prod] || 0) + (r.invoice_qty || 0);
    });
    return { salesTrend: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)), trendProducts: topProds };
  }, [filtered, hasInvFilters, serverTrend]);

  const topProducts = useMemo(() => {
    if (!hasInvFilters && serverTopProducts.length) {
      return serverTopProducts.map(r => ({ product_name: r.product_name, invoice_qty: r.total_qty })).slice(0, 10);
    }
    const byProduct = {};
    filtered.forEach(r => {
      const key = r.product_name || "Unknown";
      byProduct[key] = (byProduct[key] || 0) + (r.invoice_qty || 0);
    });
    return Object.entries(byProduct).map(([product_name, invoice_qty]) => ({ product_name, invoice_qty })).sort((a, b) => b.invoice_qty - a.invoice_qty).slice(0, 10);
  }, [filtered, hasInvFilters, serverTopProducts]);

  const pageData = useMemo(() => {
    const total = filtered.length;
    const items = filtered.slice((page - 1) * 100, page * 100);
    return { items, total };
  }, [filtered, page]);

  const applyFilter = (key, val) => { setFilters(f => ({ ...f, [key]: val })); setPage(1); };

  const s = summary;

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300, color: COLORS.textMuted }}>
        <Activity size={20} style={{ marginRight: 8, animation: "spin 1s linear infinite" }} /> Loading Sales Invoice data...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Filter Bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <FilterDropdown label="Product Name" options={filterOpts.product_names} value={filters.product_name} onChange={v => applyFilter("product_name", v)} />
        <FilterDropdown label="Location" options={filterOpts.location_names} value={filters.location_name} onChange={v => applyFilter("location_name", v)} />
      </div>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <KPICard title="Total Sales Quantity" value={fmtQty(s.totalSalesQty)} icon={Layers} color="#4CAF50" />
        <KPICard title="Total Invoices" value={fmtQty(s.totalInvoices)} icon={FileText} color="#F4733C" />
        <KPICard title="Active Dealers" value={fmtQty(s.activeDealers)} icon={Users} color="#00BCD4" />
        <KPICard title="Avg Qty per Invoice" value={fmtQty(s.avgQtyPerInvoice)} icon={TrendingUp} color="#FFB300" />
      </div>

      {/* Sales Trend Over Time */}
      <ChartCard title="Sales Trend Over Time">
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={salesTrend} margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: COLORS.textMuted }} />
            <YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Qty"]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {trendProducts.map((prod, i) => (
              <Line key={prod} type="monotone" dataKey={prod} stroke={TREND_COLORS[i % TREND_COLORS.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Top 10 Products by Sales Volume */}
      <ChartCard title="Top 10 Products by Sales Volume">
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={topProducts} margin={{ top: 5, right: 30, left: 10, bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="product_name" tick={{ fontSize: 10, fill: COLORS.textSecondary }} angle={-30} textAnchor="end" interval={0} />
            <YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} formatter={val => [fmtQty(val), "Invoice Qty"]} />
            <Bar dataKey="invoice_qty" fill="#C4D82E" radius={[4, 4, 0, 0]} barSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Invoice Table */}
      <ChartCard title="All Invoice Records">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                {["Invoice No", "Dealer Code", "Date", "Location", "Product", "Quantity"].map((h, i) => (
                  <th key={h} style={{ ...arTableHeaderStyle, textAlign: i === 5 ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageData.items.map((row, i) => (
                <tr key={`${row.invoice_number}-${i}`} style={{ background: i % 2 === 0 ? "#fff" : COLORS.surfaceAlt }}>
                  <td style={arCellStyle}>{row.invoice_number}</td>
                  <td style={arCellStyle}>{row.dealer_code}</td>
                  <td style={arCellStyle}>{parseDate(row.billing_date) || row.billing_date}</td>
                  <td style={arCellStyle}>{row.location_name}</td>
                  <td style={{ ...arCellStyle, fontWeight: 500 }}>{row.product_name}</td>
                  <td style={{ ...arCellStyle, textAlign: "right", fontWeight: 600, color: COLORS.info }}>{fmtQty(row.invoice_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "10px 0 0", fontSize: 12, color: COLORS.textMuted }}>
            <span>{pageData.total > 0 ? ((page - 1) * 100) + 1 : 0} - {Math.min(page * 100, pageData.total)} / {pageData.total}</span>
            <button onClick={() => page > 1 && setPage(page - 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronLeft size={14} /></button>
            <button onClick={() => page * 100 < pageData.total && setPage(page + 1)} style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary }}><ChevronRight size={14} /></button>
          </div>
        </div>
      </ChartCard>
    </div>
  );
};

// ─── Dashboard Renderer (generic spec-driven dashboard) ───
const DashboardRenderer = ({ spec, onBack }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ kpis: [], charts: [], filterOptions: {} });
  const [filterValues, setFilterValues] = useState({});
  // Drill-down modal state. `drill` is null when closed; otherwise carries the
  // chart metadata + clicked value + (eventually) fetched rows/columns.
  const [drill, setDrill] = useState(null);

  // Compact text summary of KPIs + charts for the AI insights panel.
  const dashInsightSummary = useMemo(() => {
    const parts = [];
    if (data.kpis?.length) {
      parts.push("KPIs: " + data.kpis.map((k) => `${k.label || k.title || "metric"} = ${k.value}`).join("; "));
    }
    for (const ch of (data.charts || [])) {
      if (ch.error || !ch.data?.length) continue;
      const lk = ch.labelKey || "label";
      const vks = ch.valueKeys || ["value"];
      const pts = ch.data.slice(0, 20).map((d) => `${d[lk]}: ${vks.map((vk) => `${vk}=${d[vk]}`).join(", ")}`).join("; ");
      parts.push(`Chart "${ch.title}": ${pts}`);
    }
    return parts.join("\n");
  }, [data]);

  // Open drill-down modal for a clicked chart segment. We fetch the per-row
  // breakdown from the backend, which uses Gemini Flash to write the SQL.
  const openDrill = useCallback(async (chart, clickedLabel) => {
    if (!chart || clickedLabel == null || clickedLabel === "") return;
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    setDrill({
      loading: true,
      title: `${chart.title} — ${clickedLabel}`,
      label: clickedLabel,
      parentTitle: chart.title,
      rows: [],
      columns: [],
    });
    try {
      const res = await fetch(`${base}/api/dashboard/drill`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          parent_sql:   chart.sql,
          parent_title: chart.title,
          parent_type:  chart.type,
          label_key:    chart.labelKey,
          label_value:  clickedLabel,
          value_keys:   chart.valueKeys,
        }),
      });
      const result = await res.json();
      setDrill((prev) => prev && ({
        ...prev,
        loading: false,
        rows: result.rows || [],
        columns: result.columns || [],
        error: result.error || null,
        sql: result.sql || "",
      }));
    } catch (err) {
      setDrill((prev) => prev && ({ ...prev, loading: false, error: String(err) }));
    }
  }, []);
  const closeDrill = useCallback(() => setDrill(null), []);

  const ICON_MAP = { Package, Layers, Users, FileText, DollarSign, TrendingUp, Factory, Globe, Truck, Warehouse };

  const fmtPkr = (v) => {
    if (v == null) return "0";
    const n = Number(v);
    if (n >= 1e9) return `PKR ${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `PKR ${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `PKR ${(n / 1e3).toFixed(1)}K`;
    return `PKR ${n.toFixed(0)}`;
  };

  const formatValue = (v, fmt) => {
    if (fmt === "pkr") return fmtPkr(v);
    if (fmt === "percent") return `${v}%`;
    if (fmt === "number") return fmtQty(v);
    return v ?? "0";
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/dashboard/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: spec, filters: filterValues }),
      });
      if (!res.ok) throw new Error("Failed to load dashboard");
      const result = await res.json();
      setData(result);
    } catch (err) {
      console.error("DashboardRenderer fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [spec, filterValues]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleFilterChange = (field, value) => {
    setFilterValues((prev) => ({ ...prev, [field]: value }));
  };

  // Short-form number formatter for axis ticks + tooltips. Turns 13_470_753_907
  // into "13.5B" so big-PKR charts don't crowd the y-axis with "0000000000".
  const fmtAxisShort = (v) => {
    if (v == null || v === "") return "";
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
    if (abs >= 1e9)  return `${(n / 1e9).toFixed(1)}B`;
    if (abs >= 1e6)  return `${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e3)  return `${(n / 1e3).toFixed(1)}K`;
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
  };

  // Tooltip uses the same short form but adds a full-precision underline so
  // hover gives both shapes.
  const fmtTooltip = (v) => {
    if (v == null || v === "") return "";
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return `${fmtAxisShort(n)} (${n.toLocaleString(undefined, { maximumFractionDigits: 2 })})`;
  };

  // Trim long category labels so horizontal-bar Y-axis doesn't blow out the
  // chart. Tooltip still shows the full string.
  const clipLabel = (s, max = 28) => {
    const str = s == null ? "" : String(s);
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  };

  // Pie charts with more than this many slices get rolled up into a single
  // "Other" wedge so we don't draw 40 micro-slivers with overlapping labels.
  const MAX_PIE_SLICES = 8;
  const compactPieData = (rows, labelKey, valueKey) => {
    if (!rows || rows.length <= MAX_PIE_SLICES) return rows || [];
    const sorted = [...rows].sort((a, b) => Number(b?.[valueKey] || 0) - Number(a?.[valueKey] || 0));
    const top = sorted.slice(0, MAX_PIE_SLICES - 1);
    const otherValue = sorted.slice(MAX_PIE_SLICES - 1).reduce((sum, r) => sum + Number(r?.[valueKey] || 0), 0);
    return [...top, { [labelKey]: "Other", [valueKey]: otherValue }];
  };

  const renderChart = (chart, idx) => {
    const { title, data: chartData, type, labelKey = "label", valueKeys = ["value"], variant, error } = chart;
    const colors = COLORS.chartColors;

    if (error || !chartData || chartData.length === 0) {
      return (
        <ChartCard key={idx} title={title}>
          <div style={{
            height: 240, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", textAlign: "center",
            color: error ? COLORS.danger : COLORS.textSecondary, padding: 24, fontSize: 13
          }}>
            {error ? (
              <>
                <AlertTriangle size={20} style={{ marginBottom: 8 }} />
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Query failed</div>
                <div style={{ fontFamily: "monospace", fontSize: 11.5, maxWidth: 360, lineHeight: 1.4 }}>{error}</div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 4 }}>No data for the chosen scope.</div>
                <div style={{ fontSize: 11.5, color: COLORS.textMuted }}>Try clearing filters or editing the dashboard.</div>
              </>
            )}
          </div>
        </ChartCard>
      );
    }

    // Hint shown under every drillable chart so users know to click.
    const drillHint = (
      <div style={{ fontSize: 11, color: COLORS.textMuted, textAlign: "center", marginTop: 4 }}>
        Click any {type === "pie" ? "slice" : type === "line" ? "point" : "bar"} to see the breakdown
      </div>
    );

    // ── Make string value-series plottable ───────────────────────────────
    // Recharts only draws NUMERIC series. Values arrive as strings in two
    // common cases that otherwise render a blank chart:
    //   • time-of-day "09:28:00" (FORMAT_TIME output) → decimal hours
    //   • numeric text "8.0" / "1,234" (un-SAFE_CAST STRING column) → number
    // Coerce per value-key; remember clock-time keys so the axis/tooltip read
    // back as HH:MM. Guarantees a chart with real rows is never empty.
    const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
    const toHours = (s) => { const m = TIME_RE.exec(String(s).trim()); return m ? (+m[1]) + (+m[2]) / 60 + (m[3] ? (+m[3]) / 3600 : 0) : null; };
    const hoursToClock = (h) => {
      if (h == null || !Number.isFinite(+h)) return "";
      let mins = Math.round(+h * 60); mins = ((mins % 1440) + 1440) % 1440;
      return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    };
    const _keyIsTime = {};
    for (const vk of valueKeys) {
      const vals = (chartData || []).map((r) => r?.[vk]).filter((x) => x != null && x !== "");
      _keyIsTime[vk] = vals.length > 0 && vals.every((x) => typeof x === "string" && TIME_RE.test(x.trim()));
    }
    const plotData = (chartData || []).map((r) => {
      const o = { ...r };
      for (const vk of valueKeys) {
        const raw = o[vk];
        if (raw == null || raw === "") { o[vk] = null; continue; }
        if (_keyIsTime[vk]) o[vk] = toHours(raw);
        else if (typeof raw === "string") { const n = Number(raw.replace(/,/g, "")); if (Number.isFinite(n)) o[vk] = n; }
      }
      return o;
    });
    const allTime = valueKeys.length > 0 && valueKeys.every((vk) => _keyIsTime[vk]);
    const yTickFmt = allTime ? hoursToClock : fmtAxisShort;
    const valTooltipFmt = allTime ? ((v) => hoursToClock(v)) : ((v) => fmtTooltip(v));

    if (type === "pie") {
      const pieData = compactPieData(plotData, labelKey, valueKeys[0]);
      return (
        <ChartCard key={idx} title={title}>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey={valueKeys[0]}
                nameKey={labelKey}
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={(entry) => clipLabel(entry?.[labelKey], 18)}
                onClick={(d) => openDrill(chart, d?.[labelKey] ?? d?.name)}
                style={{ cursor: "pointer" }}
              >
                {pieData.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
              </Pie>
              <Tooltip formatter={valTooltipFmt} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
          {drillHint}
        </ChartCard>
      );
    }

    if (type === "line") {
      return (
        <ChartCard key={idx} title={title}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart
              data={plotData}
              onClick={(state) => {
                const lbl = state?.activeLabel ?? state?.activePayload?.[0]?.payload?.[labelKey];
                if (lbl != null) openDrill(chart, lbl);
              }}
              style={{ cursor: "pointer" }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey={labelKey} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={yTickFmt} width={allTime ? 64 : 56} domain={allTime ? ["dataMin", "dataMax"] : undefined} />
              <Tooltip formatter={valTooltipFmt} />
              <Legend />
              {valueKeys.map((vk, vi) => (
                <Line key={vk} type="monotone" dataKey={vk} stroke={colors[vi % colors.length]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6, cursor: "pointer" }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {drillHint}
        </ChartCard>
      );
    }

    // Bar chart (default)
    const handleBarClick = (payload) => {
      // Recharts fires onClick on a Bar with the data point as the argument.
      // It contains the full row, so we can pull the labelKey value out.
      const lbl = payload?.[labelKey] ?? payload?.payload?.[labelKey];
      if (lbl != null) openDrill(chart, lbl);
    };
    const isHorizontal = variant === "horizontal";
    // Horizontal bars deserve more height than vertical ones — one bar per
    // row, ~28px each, with a floor so a 3-bar chart still has room.
    const horizontalHeight = Math.max(300, (chartData?.length || 0) * 28 + 80);
    // Pick a Y-axis width that scales with the longest label, capped so we
    // don't eat the whole chart on a single huge string.
    const longestLabel = isHorizontal
      ? (chartData || []).reduce((m, r) => Math.max(m, String(r?.[labelKey] ?? "").length), 0)
      : 0;
    const yAxisWidth = isHorizontal ? Math.min(220, Math.max(120, longestLabel * 6.5)) : 56;
    return (
      <ChartCard key={idx} title={title}>
        <ResponsiveContainer width="100%" height={isHorizontal ? horizontalHeight : 300}>
          <BarChart data={plotData} layout={isHorizontal ? "vertical" : "horizontal"} margin={{ top: 8, right: 20, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            {isHorizontal ? (
              <>
                <YAxis
                  type="category"
                  dataKey={labelKey}
                  tick={{ fontSize: 11 }}
                  width={yAxisWidth}
                  interval={0}
                  tickFormatter={(v) => clipLabel(v, 28)}
                />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={yTickFmt} domain={allTime ? ["dataMin", "dataMax"] : undefined} />
              </>
            ) : (
              <>
                <XAxis dataKey={labelKey} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={yTickFmt} width={allTime ? 64 : 56} domain={allTime ? ["dataMin", "dataMax"] : undefined} />
              </>
            )}
            <Tooltip formatter={valTooltipFmt} />
            <Legend />
            {valueKeys.map((vk, vi) => (
              // When there's only one value series, color each bar
              // individually from the palette so two adjacent single-series
              // bar charts don't end up looking identical (all-green vs
              // all-green). With multiple series we keep one color per
              // series so the legend stays meaningful.
              <Bar
                key={vk}
                dataKey={vk}
                fill={colors[vi % colors.length]}
                radius={[4, 4, 0, 0]}
                onClick={handleBarClick}
                style={{ cursor: "pointer" }}
              >
                {valueKeys.length === 1 && (chartData || []).map((_, i) => (
                  <Cell key={`c-${i}`} fill={colors[i % colors.length]} cursor="pointer" />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
        {drillHint}
      </ChartCard>
    );
  };

  const kpiCols = Math.min((data.kpis || []).length, 4) || 1;

  return (
    <div>
      {/* Title bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        {onBack && (
          <button onClick={onBack} style={{
            background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 8,
            padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary
          }}>
            <ChevronLeft size={16} />
          </button>
        )}
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.textPrimary }}>{spec?.title || "Dashboard"}</div>
          {spec?.description && <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 2 }}>{spec.description}</div>}
          <DataAsOf style={{ marginTop: 4 }} />
        </div>
      </div>

      {/* Filters — only render a filter once its options have loaded. An empty
          options list means the field couldn't be resolved to real values
          (e.g. a date-range field, or a column that doesn't exist), so we hide
          it rather than show a useless blank dropdown. */}
      {(() => {
        const usable = (spec?.filters || []).filter(
          (f) => ((data.filterOptions && data.filterOptions[f.field]) || []).length > 0
        );
        if (usable.length === 0) return null;
        return (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
            {usable.map((f) => (
              <FilterDropdown
                key={f.field}
                label={f.label || f.field}
                options={data.filterOptions[f.field]}
                value={filterValues[f.field] || null}
                onChange={(v) => handleFilterChange(f.field, v)}
              />
            ))}
          </div>
        );
      })()}

      {loading && (
        <div style={{ textAlign: "center", padding: 40, color: COLORS.textSecondary }}>
          <Activity size={24} style={{ animation: "spin 1s linear infinite" }} />
          <div style={{ marginTop: 8, fontSize: 13 }}>Loading dashboard...</div>
        </div>
      )}

      {!loading && (
        <>
          {/* Scope restriction badge — shown when plant-level access control is active */}
          {data.scope_applied && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "5px 12px", borderRadius: 20, marginBottom: 16,
              background: "#FFFBEB", border: "1px solid #FCD34D",
              fontSize: 12, fontWeight: 600, color: "#92400E",
            }}>
              <Filter size={12} />
              Filtered to your plant access
              {data.scope_plants?.length > 0 && (
                <span style={{ fontWeight: 400, color: "#B45309" }}>
                  ({data.scope_plants.join(", ")})
                </span>
              )}
            </div>
          )}

          {/* Diagnostic banner — surfaces BQ errors AND zero-row queries so empty dashboards are debuggable */}
          {(() => {
            const widgets = [
              ...((data.kpis || []).map((k) => {
                const hasError = !!k.error;
                const empty = !hasError && (k.value === null || k.value === undefined || k.value === "");
                return { kind: "KPI", title: k.title, error: k.error, sql: k.sql,
                         status: hasError ? "error" : (empty ? "empty" : "ok"),
                         rows: empty ? 0 : (hasError ? 0 : 1) };
              })),
              ...((data.charts || []).map((c) => {
                const hasError = !!c.error;
                const rowCount = (c.data || []).length;
                return { kind: "Chart", title: c.title, error: c.error, sql: c.sql,
                         status: hasError ? "error" : (rowCount === 0 ? "empty" : "ok"),
                         rows: rowCount };
              })),
            ];
            const problems = widgets.filter((w) => w.status !== "ok");
            if (problems.length === 0) return null;
            const errCount = problems.filter((w) => w.status === "error").length;
            const emptyCount = problems.filter((w) => w.status === "empty").length;
            const headline = errCount > 0
              ? `${errCount} ${errCount === 1 ? "query" : "queries"} errored${emptyCount ? ` and ${emptyCount} returned no rows` : ""} — click for SQL`
              : `${emptyCount} ${emptyCount === 1 ? "query" : "queries"} returned no rows — click to see the SQL`;
            return (
              <details style={{
                marginBottom: 16, padding: "10px 14px", borderRadius: 10,
                background: "#FEF3C7", border: "1px solid #FCD34D", fontSize: 12.5, color: "#92400E"
              }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  <AlertTriangle size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  {headline}
                </summary>
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                  {problems.map((w, ix) => (
                    <div key={ix} style={{ padding: 10, background: COLORS.surface, borderRadius: 8, border: "1px solid #FCD34D" }}>
                      <div style={{ fontWeight: 600, marginBottom: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span>{w.kind}: {w.title}</span>
                        <span style={{
                          fontSize: 10.5, padding: "2px 8px", borderRadius: 4, color: "#fff",
                          background: w.status === "error" ? "#DC2626" : "#9CA3AF"
                        }}>{w.status === "error" ? "ERROR" : `${w.rows} rows`}</span>
                      </div>
                      {w.error && (
                        <div style={{ fontFamily: "monospace", fontSize: 11.5, color: "#7C2D12", marginBottom: 4 }}>{w.error}</div>
                      )}
                      {w.sql && (
                        <pre style={{
                          marginTop: 6, padding: 8, background: COLORS.surfaceAlt, borderRadius: 6,
                          fontSize: 11, color: COLORS.textSecondary, overflow: "auto", maxHeight: 220, whiteSpace: "pre-wrap"
                        }}>{w.sql}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            );
          })()}

          {/* KPI grid */}
          {data.kpis?.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${kpiCols}, 1fr)`, gap: 16, marginBottom: 24 }}>
              {data.kpis.map((kpi, i) => {
                const IconComp = ICON_MAP[kpi.icon] || Activity;
                const hasValue = kpi.value !== null && kpi.value !== undefined && kpi.value !== "" && !kpi.error;
                return (
                  <KPICard
                    key={i}
                    title={kpi.title}
                    value={hasValue ? formatValue(kpi.value, kpi.format) : (kpi.error ? "—" : "0")}
                    icon={IconComp}
                    color={COLORS.chartColors[i % COLORS.chartColors.length]}
                    change={kpi.change}
                    changeType={kpi.changeType}
                    subtitle={kpi.error ? `Error — see banner above` : (kpi.subtitle || (hasValue ? null : "No matching data"))}
                  />
                );
              })}
            </div>
          )}

          {/* Charts: 2 per row */}
          {data.charts?.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {data.charts.map((chart, i) => renderChart(chart, i))}
            </div>
          )}
          {!loading && dashInsightSummary && (
            <AiInsights kind="dashboard" title={spec?.title || spec?.name} summary={dashInsightSummary} />
          )}
        </>
      )}

      {/* Drill-down modal — shows row-level breakdown for clicked chart segment */}
      {drill && (
        <div
          onClick={closeDrill}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1000, padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.surface, borderRadius: 16, width: "min(960px, 100%)",
              maxHeight: "85vh", display: "flex", flexDirection: "column",
              boxShadow: "0 16px 48px rgba(0,0,0,0.25)",
              border: `1px solid ${COLORS.border}`,
            }}
          >
            {/* Header */}
            <div style={{
              padding: "16px 20px", borderBottom: `1px solid ${COLORS.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
                  {drill.title}
                </div>
                <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                  Row-level breakdown
                </div>
              </div>
              <button
                onClick={closeDrill}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: COLORS.textSecondary, fontSize: 22, lineHeight: 1, padding: 4,
                }}
                title="Close"
              >×</button>
            </div>
            {/* Body */}
            <div style={{ padding: 20, overflow: "auto", flex: 1 }}>
              {drill.loading ? (
                <div style={{ textAlign: "center", padding: 40, color: COLORS.textSecondary }}>
                  Loading breakdown…
                </div>
              ) : drill.error ? (
                <div style={{ padding: 16, background: "rgba(239,68,68,0.08)", borderRadius: 8, color: COLORS.danger, fontSize: 13 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Couldn't generate breakdown</div>
                  <div style={{ fontFamily: "monospace", fontSize: 12 }}>{drill.error}</div>
                </div>
              ) : (drill.rows?.length || 0) === 0 ? (
                <div style={{ textAlign: "center", padding: 40, color: COLORS.textSecondary, fontSize: 13 }}>
                  No detail rows for this category.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `2px solid ${COLORS.border}` }}>
                        {drill.columns.map((c) => (
                          <th key={c} style={{
                            textAlign: "left", padding: "10px 12px", fontSize: 12,
                            fontWeight: 600, color: COLORS.textSecondary,
                            textTransform: "uppercase", letterSpacing: 0.4,
                            background: COLORS.surfaceAlt,
                          }}>{c.replace(/_/g, " ")}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {drill.rows.map((row, ri) => (
                        <tr key={ri} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                          {drill.columns.map((c) => {
                            const v = row[c];
                            const isNum = typeof v === "number" || (!isNaN(Number(v)) && v !== null && v !== "");
                            return (
                              <td key={c} style={{
                                padding: "10px 12px", color: COLORS.textPrimary,
                                textAlign: isNum ? "right" : "left",
                                fontVariantNumeric: isNum ? "tabular-nums" : undefined,
                              }}>
                                {v == null ? "—" : (isNum ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v))}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 12, fontSize: 11, color: COLORS.textMuted, textAlign: "right" }}>
                    {drill.rows.length} {drill.rows.length === 1 ? "row" : "rows"}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Dashboard Chat Panel (auto-saving, embeddable) ───
//
// This panel handles the AI-driven dashboard refinement loop. Whenever the
// AI returns a `ready: true` config, the panel auto-persists it (POST for the
// first save, PUT for subsequent edits) and then notifies the parent via
// `onConfigChange(newConfig, savedId)` so the dashboard re-renders in place.
// There is no manual Save button — the parent owns the visible save state.
const DashboardChatPanel = ({
  existingConfig,
  existingId,
  onConfigChange,
  onSaveStateChange,
  onClose,
}) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [savedIdLocal, setSavedIdLocal] = useState(existingId || null);
  const [scopeNoticeShown, setScopeNoticeShown] = useState(false);
  const messagesEndRef = useRef(null);
  const seededRef = useRef(false);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isTyping]);

  // Replay the build conversation when opening an existing dashboard, so the
  // user sees what was originally asked + how the AI responded. Falls back
  // to a friendly intro when there's no saved history.
  useEffect(() => {
    if (seededRef.current) return;
    const savedHistory = Array.isArray(existingConfig?.chat_history) ? existingConfig.chat_history : null;
    if (savedHistory && savedHistory.length > 0) {
      setMessages(savedHistory);
    } else if (existingConfig) {
      setMessages([{ role: "assistant", text: "What would you like to change about this dashboard?" }]);
    }
    seededRef.current = true;
  }, [existingConfig]);

  // Strip `chat_history` from existing_config before sending to Gemini. The
  // history is only useful for the local UI replay — Gemini just needs the
  // structural config (sql, columns, filters, etc.) and we don't want to
  // burn prompt tokens on prior chat turns it already has via `history`.
  const _existingConfigForAI = useMemo(() => {
    if (!existingConfig) return null;
    const { chat_history, ...rest } = existingConfig;
    return rest;
  }, [existingConfig]);

  const persistConfig = useCallback(async (newConfig, chatHistory) => {
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    onSaveStateChange?.("saving");
    // Embed the chat history alongside the config so the next time this
    // dashboard is opened we can replay the build conversation. Always sent
    // (even if empty) so a saved dashboard never has a stale prior history.
    const configToSave = { ...newConfig, chat_history: chatHistory || [] };
    try {
      const id = savedIdLocal;
      let resolvedId = id;
      if (id) {
        const res = await fetch(`${base}/api/dashboards/${id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: configToSave.title || "Untitled Dashboard",
            description: configToSave.description || "",
            config: configToSave,
          }),
        });
        if (!res.ok) throw new Error("Update failed");
      } else {
        const res = await fetch(`${base}/api/dashboards`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: configToSave.title || "Untitled Dashboard",
            description: configToSave.description || "",
            config: configToSave,
          }),
        });
        if (!res.ok) throw new Error("Create failed");
        const data = await res.json();
        resolvedId = data.id || data._id;
        setSavedIdLocal(resolvedId);
      }
      onConfigChange?.(configToSave, resolvedId);
      onSaveStateChange?.("saved");
    } catch (err) {
      console.error("Auto-save failed:", err);
      onSaveStateChange?.("error");
    }
  }, [savedIdLocal, onConfigChange, onSaveStateChange]);

  const handleSend = async (overrideText) => {
    const trimmed = (overrideText ?? input).trim();
    if (!trimmed || isTyping) return;
    // Track the conversation locally so `persistConfig` gets the up-to-date
    // history without fighting React's async setState batching.
    let pendingHistory = [...messages, { role: "user", text: trimmed }];
    setMessages(pendingHistory);
    if (!overrideText) setInput("");

    // Mirror-scope notice — when the user asks about revenue/sales/dealers/
    // customers etc., insert a one-time yellow assistant message warning
    // that the SAP mirror is procurement+manufacturing+finance only.
    if (!scopeNoticeShown && _isOutOfScopeRevenuePrompt(trimmed)) {
      pendingHistory = [...pendingHistory, {
        role: "assistant",
        text: _buildMirrorScopeNotice("dashboard"),
        isScopeNotice: true,
      }];
      setMessages(pendingHistory);
      setScopeNoticeShown(true);
    }

    setIsTyping(true);

    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    const history = pendingHistory.slice(0, -1).map((m) => ({ role: m.role, text: m.text }));

    try {
      const res = await fetch(`${base}/api/dashboard/refine`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history,
          ...(_existingConfigForAI ? { existing_config: _existingConfigForAI } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed" }));
        throw new Error(err.detail || "Request failed");
      }
      const data = await res.json();
      setIsTyping(false);

      // Detect a fresh config — either via the structured `ready` flag or
      // by extracting JSON from the reply (older Gemini turns sometimes leak it).
      let newConfig = null;
      let truncatedJson = !!data.truncated;
      if (data.ready && data.config) newConfig = data.config;
      else if (!truncatedJson && data.reply && data.reply.includes('"ready"') && data.reply.includes('"config"')) {
        try {
          const m = data.reply.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            if (parsed.ready && parsed.config) newConfig = parsed.config;
            else if (parsed.version && parsed.title && parsed.kpis) newConfig = parsed;
          } else {
            truncatedJson = true;
          }
        } catch {
          truncatedJson = true;
        }
      }

      if (newConfig) {
        pendingHistory = [...pendingHistory, { role: "assistant", text: savedIdLocal ? "Updating your dashboard..." : "Building your dashboard..." }];
        setMessages(pendingHistory);
        await persistConfig(newConfig, pendingHistory);
      } else if (truncatedJson) {
        pendingHistory = [...pendingHistory, {
          role: "assistant",
          text: data.reply || "My response was cut off while writing the dashboard config. Try saying **\"generate\"** again, or ask me to simplify the dashboard (fewer charts / shorter SQL).",
        }];
        setMessages(pendingHistory);
      } else {
        pendingHistory = [...pendingHistory, { role: "assistant", text: data.reply }];
        setMessages(pendingHistory);
      }
    } catch (err) {
      setIsTyping(false);
      pendingHistory = [...pendingHistory, { role: "assistant", text: `Something went wrong: ${err.message}` }];
      setMessages(pendingHistory);
    }
  };

  const suggestedPrompts = [
    "Attendance rate by department over the last 30 days",
    "Bench vs allocated headcount split with top competencies on the bench",
    "Q1 AM scorecard: target vs achievement vs open pipeline by AM",
    "Pipeline coverage and historical win rate by AM",
  ];

  const showEmptyState = messages.length === 0 && !existingConfig;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: COLORS.surface, minHeight: 0 }}>
      {onClose && (
        <div style={{
          padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={15} color={COLORS.purple} />
            <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
              {existingId ? "Edit with AI" : "Build with AI"}
            </span>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", padding: 4, cursor: "pointer",
            color: COLORS.textSecondary, display: "flex", alignItems: "center"
          }}><X size={17} /></button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px", minHeight: 0 }}>
        {showEmptyState && (
          <div style={{ textAlign: "center", paddingTop: 16 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 18,
              background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
              display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px"
            }}>
              <LayoutDashboard size={26} color="#fff" />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 6 }}>
              What dashboard would you like to build?
            </div>
            <div style={{ fontSize: 13, color: COLORS.textSecondary, marginBottom: 22, maxWidth: 480, margin: "0 auto 22px", lineHeight: 1.55 }}>
              Describe the metrics and visuals you need. I'll design the KPIs, charts, and filters — saved automatically as you go.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 460, margin: "0 auto" }}>
              {suggestedPrompts.map((p, i) => (
                <button key={i} onClick={() => setInput(p)} style={{
                  padding: "12px 14px", background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12,
                  cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 500, color: COLORS.textPrimary,
                  transition: "all 0.15s"
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.purple; e.currentTarget.style.boxShadow = "0 2px 8px rgba(53,48,133,0.12)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.border; e.currentTarget.style.boxShadow = "none"; }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          const isLastAssistant = msg.role === "assistant" && i === messages.length - 1;
          const hasGeneratePrompt = isLastAssistant && /say[\s\S]{0,20}generate/i.test(msg.text);
          const displayText = hasGeneratePrompt
            ? msg.text.replace(/\n*\s*Say[\s\S]*?generate[\s\S]*?\.\s*$/i, "").trim()
            : msg.text;
          return (
            <div key={i} style={{
              display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 14, animation: "fadeIn 0.3s ease"
            }}>
              <div style={{
                maxWidth: "88%", padding: "12px 16px",
                borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                background: msg.isScopeNotice
                  ? "#FEF9E7"
                  : (msg.role === "user" ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accentDark})` : COLORS.surface),
                color: msg.role === "user" ? "#fff" : COLORS.textPrimary,
                border: msg.isScopeNotice
                  ? `1px solid ${COLORS.warning}`
                  : (msg.role === "assistant" ? `1px solid ${COLORS.border}` : "none"),
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
              }}>
                {msg.isScopeNotice && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 11, fontWeight: 700, color: COLORS.warning, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    <AlertTriangle size={13} /> Data scope notice
                  </div>
                )}
                <div style={{ fontSize: 13, lineHeight: 1.65 }}>
                  {msg.role === "assistant" ? renderMarkdown(displayText) : msg.text}
                </div>
              </div>
              {hasGeneratePrompt && !isTyping && (
                <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
                  <button onClick={() => handleSend("generate")} style={{
                    padding: "9px 18px", borderRadius: 9, border: "none",
                    background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
                    color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                    boxShadow: "0 4px 12px rgba(53,48,133,0.25)",
                  }}>
                    <Sparkles size={13} /> Generate
                  </button>
                  <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>or refine below</span>
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 14 }}>
            <div style={{
              padding: "12px 16px", borderRadius: "14px 14px 14px 4px",
              background: COLORS.surface, border: `1px solid ${COLORS.border}`, boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
            }}>
              <div style={{ display: "flex", gap: 4 }}>
                {[0, 1, 2].map((d) => (
                  <div key={d} style={{
                    width: 6, height: 6, borderRadius: "50%", background: COLORS.textMuted,
                    animation: `pulse 1.2s ease-in-out ${d * 0.2}s infinite`
                  }} />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div style={{
        padding: "12px 16px", borderTop: `1px solid ${COLORS.border}`, background: COLORS.surface,
        display: "flex", gap: 8, alignItems: "center", flexShrink: 0
      }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={existingConfig ? "What should I change?" : "Describe your dashboard..."}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 10,
            border: `1px solid ${COLORS.border}`, fontSize: 13, outline: "none",
            transition: "border-color 0.2s"
          }}
          onFocus={(e) => (e.target.style.borderColor = COLORS.accent)}
          onBlur={(e) => (e.target.style.borderColor = COLORS.border)}
        />
        <button onClick={() => handleSend()} disabled={isTyping || !input.trim()} style={{
          width: 38, height: 38, borderRadius: 10, border: "none",
          background: input.trim() ? COLORS.accent : COLORS.border,
          color: "#fff", cursor: input.trim() ? "pointer" : "default",
          display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.2s"
        }}>
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};

// ─── Save state pill (inline next to dashboard title) ───
const SaveStatePill = ({ state }) => {
  if (state === "saving") return (
    <div style={{ fontSize: 12, color: COLORS.textMuted, display: "flex", alignItems: "center", gap: 6 }}>
      <Activity size={12} style={{ animation: "spin 1s linear infinite" }} /> Saving…
    </div>
  );
  if (state === "saved") return (
    <div style={{ fontSize: 12, color: COLORS.success, display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
      <CheckCircle size={12} /> Saved
    </div>
  );
  if (state === "error") return (
    <div style={{ fontSize: 12, color: COLORS.danger, display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
      <AlertTriangle size={12} /> Save failed
    </div>
  );
  return null;
};

const MenuItem = ({ children, onClick, danger, icon: Icon }) => (
  <div onClick={onClick} style={{
    padding: "10px 14px", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
    color: danger ? COLORS.danger : COLORS.textPrimary, fontWeight: 500
  }}
    onMouseEnter={(e) => e.currentTarget.style.background = danger ? "#FEF2F2" : COLORS.surfaceAlt}
    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
  >
    {Icon && <Icon size={14} />} {children}
  </div>
);

// ─── Share Modal (works for dashboards + reports) ───
//
// Usage:
//   <ShareModal kind="dashboard" itemId={42} itemName="Stock by Plant" onClose={...} />
//   <ShareModal kind="report"    itemId={17} itemName="Top 50 Materials" onClose={...} />
// Manages its own collaborator-list + user-search state. Calls
// /api/{kind}s/{id}/shares for list/add/remove and /api/users/search for the
// autocomplete. Owner-only — the parent should only render this modal when
// the current user owns the item.
// ─── Schedule modal — email me this dashboard/report on a cadence ──────────
// One subscription per user × item (saving replaces). Delivery is handled by
// /api/subscriptions/run-due (Cloud Scheduler, hourly); times are Pakistan
// time. Reports arrive as an inline table, dashboards as their KPI values.
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ScheduleModal = ({ kind, itemId, itemName, onClose }) => {
  const [cadence, setCadence] = useState("weekly");
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [hour, setHour] = useState(9);
  const [recipients, setRecipients] = useState("");
  const [existing, setExisting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const headers = { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/subscriptions?kind=${kind}&item_id=${itemId}`, { headers });
        if (!r.ok) return;
        const j = await r.json();
        const s = (j.subscriptions || [])[0];
        if (s && !cancelled) {
          setExisting(s);
          setCadence(s.cadence || "weekly");
          setDayOfWeek(Number(s.day_of_week || 0));
          setHour(Number(s.hour ?? 9));
          setRecipients(s.recipients || "");
        }
      } catch { /* fresh form */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, itemId]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${API_BASE}/api/subscriptions`, {
        method: "POST", headers,
        body: JSON.stringify({ kind, item_id: itemId, cadence, day_of_week: dayOfWeek, hour, recipients }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.detail || `HTTP ${r.status}`); }
      setMsg("Scheduled ✓ — first email arrives at the next matching time.");
      setExisting({ id: -1 });
    } catch (e) { setMsg(`Couldn't save: ${e.message || e}`); }
    finally { setBusy(false); }
  };

  const unsubscribe = async () => {
    if (!existing?.id || existing.id === -1) {
      // Saved this session — refetch to get the id.
      const r = await fetch(`${API_BASE}/api/subscriptions?kind=${kind}&item_id=${itemId}`, { headers });
      const j = await r.json().catch(() => ({}));
      existing.id = (j.subscriptions || [])[0]?.id;
    }
    if (!existing?.id) return;
    setBusy(true); setMsg(null);
    try {
      await fetch(`${API_BASE}/api/subscriptions/${existing.id}`, { method: "DELETE", headers });
      setExisting(null);
      setMsg("Subscription removed.");
    } finally { setBusy(false); }
  };

  const sel = {
    padding: "9px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
    background: COLORS.surface, color: COLORS.textPrimary, fontSize: 13, fontWeight: 600, width: "100%",
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1400, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: COLORS.surface, borderRadius: 16, width: "100%", maxWidth: 460, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: COLORS.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
            <Calendar size={18} color={COLORS.accent} /> Schedule by email
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: COLORS.textMuted, marginBottom: 16 }}>
          "{itemName}" will be emailed {kind === "report" ? "as a table" : "with its KPI values"} on the schedule below (Pakistan time).
        </div>

        <div style={{ display: "grid", gridTemplateColumns: cadence === "weekly" ? "1fr 1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" }}>Cadence</label>
            <select value={cadence} onChange={e => setCadence(e.target.value)} style={{ ...sel, marginTop: 4 }}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly (1st)</option>
            </select>
          </div>
          {cadence === "weekly" && (
            <div>
              <label style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" }}>Day</label>
              <select value={dayOfWeek} onChange={e => setDayOfWeek(Number(e.target.value))} style={{ ...sel, marginTop: 4 }}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          <div>
            <label style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" }}>From (hour)</label>
            <select value={hour} onChange={e => setHour(Number(e.target.value))} style={{ ...sel, marginTop: 4 }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </div>
        </div>

        <label style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" }}>Recipients</label>
        <input value={recipients} onChange={e => setRecipients(e.target.value)}
          placeholder="Leave blank to send to yourself, or comma-separate emails"
          style={{ ...sel, marginTop: 4, marginBottom: 14, boxSizing: "border-box" }} />

        {msg && <div style={{ fontSize: 12.5, color: msg.startsWith("Couldn't") ? "#B91C1C" : COLORS.accentDark || COLORS.accent, fontWeight: 600, marginBottom: 10 }}>{msg}</div>}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          {existing ? (
            <button onClick={unsubscribe} disabled={busy} style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.surface, color: "#B91C1C", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
              Unsubscribe
            </button>
          ) : <span />}
          <button onClick={save} disabled={busy} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: COLORS.accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Saving…" : existing ? "Update schedule" : "Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
};

const ShareModal = ({ kind, itemId, itemName, onClose }) => {
  const baseUrl = (kind === "report" ? "/api/reports" : "/api/dashboards") + `/${itemId}/shares`;
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(null); // user_id being added (for spinner)
  const [error, setError] = useState("");
  const [role, setRole] = useState("viewer"); // access level applied to new shares
  const searchTimer = useRef(null);

  const token = () => localStorage.getItem("token");
  const apiBase = () => import.meta.env.VITE_API_BASE || "";

  const fetchShares = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase()}${baseUrl}`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.ok) throw new Error("Could not load collaborators");
      const data = await res.json();
      setShares(data.shares || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => { fetchShares(); }, [fetchShares]);

  // Debounced user search.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`${apiBase()}/api/users/search?q=${encodeURIComponent(query.trim())}`, {
          headers: { Authorization: `Bearer ${token()}` },
        });
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        setResults(data.users || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => searchTimer.current && clearTimeout(searchTimer.current);
  }, [query]);

  const alreadyShared = useMemo(() => new Set(shares.map((s) => s.user_id)), [shares]);

  const handleAdd = async (u) => {
    setAdding(u.id);
    setError("");
    try {
      const res = await fetch(`${apiBase()}${baseUrl}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: u.id, role }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Could not share");
      }
      setQuery("");
      setResults([]);
      await fetchShares();
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(null);
    }
  };

  // Change an existing collaborator's access level (re-POST upserts the role).
  const handleChangeRole = async (userId, newRole) => {
    setError("");
    setShares((prev) => prev.map((s) => (s.user_id === userId ? { ...s, role: newRole } : s)));
    try {
      const res = await fetch(`${apiBase()}${baseUrl}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, role: newRole }),
      });
      if (!res.ok) throw new Error("Could not update access");
    } catch (e) {
      setError(e.message);
      await fetchShares();
    }
  };

  const handleRemove = async (userId) => {
    setError("");
    try {
      const res = await fetch(`${apiBase()}${baseUrl}/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.ok) throw new Error("Could not revoke");
      setShares((prev) => prev.filter((s) => s.user_id !== userId));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      animation: "fadeIn 0.15s ease",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 520, maxHeight: "85vh", background: COLORS.surface, borderRadius: 16,
        boxShadow: "0 20px 50px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "18px 22px", borderBottom: `1px solid ${COLORS.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, background: `${COLORS.purple}1a`,
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
            }}>
              <Share2 size={17} color={COLORS.purple} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
                Share {kind === "report" ? "report" : "dashboard"}
              </div>
              <div style={{ fontSize: 12, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {itemName}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", padding: 4, cursor: "pointer",
            color: COLORS.textSecondary, display: "flex", alignItems: "center"
          }}><X size={18} /></button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 22px", overflowY: "auto", flex: 1 }}>
          {/* Search box */}
          <div style={{ position: "relative", marginBottom: 14 }}>
            <Search size={15} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: COLORS.textMuted }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              style={{
                width: "100%", padding: "10px 14px 10px 38px", borderRadius: 10,
                border: `1px solid ${COLORS.border}`, fontSize: 13, outline: "none",
                background: COLORS.surfaceAlt, transition: "all 0.15s", boxSizing: "border-box",
              }}
              onFocus={(e) => { e.target.style.borderColor = COLORS.purple; e.target.style.background = COLORS.surface; }}
              onBlur={(e) => { e.target.style.borderColor = COLORS.border; e.target.style.background = COLORS.surfaceAlt; }}
            />
          </div>

          {/* Access level for new shares */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: COLORS.textMuted, fontWeight: 500 }}>New people can:</span>
            <div style={{ display: "flex", border: `1px solid ${COLORS.border}`, borderRadius: 8, overflow: "hidden" }}>
              {[
                { id: "viewer", label: "View" },
                { id: "editor", label: "Edit" },
              ].map((o) => (
                <button key={o.id} onClick={() => setRole(o.id)} style={{
                  padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: role === o.id ? COLORS.purple : COLORS.surface,
                  color: role === o.id ? "#fff" : COLORS.textSecondary,
                }}>{o.label}</button>
              ))}
            </div>
          </div>

          {/* Search results */}
          {query.trim() && (
            <div style={{
              marginBottom: 14, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "hidden",
              maxHeight: 240, overflowY: "auto"
            }}>
              {searching && (
                <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: COLORS.textMuted }}>Searching…</div>
              )}
              {!searching && results.length === 0 && (
                <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: COLORS.textMuted }}>No matching users.</div>
              )}
              {!searching && results.map((u) => {
                const isAlreadyShared = alreadyShared.has(u.id);
                return (
                  <div key={u.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                    padding: "10px 14px", borderBottom: `1px solid ${COLORS.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: 8,
                        background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accentDark})`,
                        color: "#fff", fontSize: 12, fontWeight: 700,
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      }}>
                        {(u.full_name || u.email || "?")[0].toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {u.full_name || u.email}
                        </div>
                        <div style={{ fontSize: 11, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                      </div>
                    </div>
                    {isAlreadyShared ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.success, display: "flex", alignItems: "center", gap: 4 }}>
                        <CheckCircle size={12} /> Shared
                      </span>
                    ) : (
                      <button onClick={() => handleAdd(u)} disabled={adding === u.id} style={{
                        padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                        background: COLORS.purple, color: "#fff", fontSize: 12, fontWeight: 600,
                        display: "flex", alignItems: "center", gap: 4, opacity: adding === u.id ? 0.6 : 1,
                      }}>
                        <UserPlus size={12} /> {adding === u.id ? "Adding…" : "Share"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Current collaborators */}
          <div style={{ fontSize: 11.5, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            People with access
          </div>
          {loading && (
            <div style={{ padding: 18, textAlign: "center", fontSize: 12, color: COLORS.textMuted }}>Loading…</div>
          )}
          {!loading && shares.length === 0 && (
            <div style={{
              padding: "18px 14px", textAlign: "center", fontSize: 12.5, color: COLORS.textSecondary,
              background: COLORS.surfaceAlt, borderRadius: 10
            }}>
              Only you can see this {kind === "report" ? "report" : "dashboard"} right now. Add someone above to share it.
            </div>
          )}
          {!loading && shares.map((s) => (
            <div key={s.user_id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
              padding: "10px 4px", borderBottom: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
                  color: "#fff", fontSize: 12, fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  {(s.full_name || s.email || "?")[0].toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.full_name || s.email}
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.email}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <select
                  value={s.role === "editor" ? "editor" : "viewer"}
                  onChange={(e) => handleChangeRole(s.user_id, e.target.value)}
                  style={{
                    fontSize: 11.5, fontWeight: 600, color: COLORS.textSecondary, cursor: "pointer",
                    border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "3px 6px",
                    background: COLORS.surface,
                  }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button onClick={() => handleRemove(s.user_id)} title="Revoke access" style={{
                  background: "none", border: "none", padding: 4, borderRadius: 6, cursor: "pointer",
                  color: COLORS.textMuted, display: "flex", alignItems: "center"
                }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#FEF2F2"; e.currentTarget.style.color = COLORS.danger; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textMuted; }}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ))}

          {error && (
            <div style={{
              marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 12,
              background: "#FEF2F2", color: COLORS.danger, fontWeight: 500
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px 22px", borderTop: `1px solid ${COLORS.border}`,
          display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, flexShrink: 0,
          background: COLORS.surfaceAlt
        }}>
          <button onClick={onClose} style={{
            padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer",
            background: COLORS.primary, color: "#fff", fontSize: 12.5, fontWeight: 600,
          }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Dashboard list card ───
const DashboardCard = ({ dashboard, onOpen, onDelete, onDuplicate, onRemoveFromList }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const stamp = dashboard.updated_at || dashboard.created_at;
  const stampLabel = stamp ? new Date(stamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
  const isShared = !!dashboard.is_shared;

  return (
    <div onClick={onOpen} style={{
      background: COLORS.surface, borderRadius: 14, padding: 18, border: `1px solid ${COLORS.border}`,
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)", cursor: "pointer",
      display: "flex", flexDirection: "column", transition: "all 0.18s",
      position: "relative", minHeight: 160
    }}
    onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "0 6px 16px rgba(0,0,0,0.1)"; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.borderColor = COLORS.accent; }}
    onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)"; e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.borderColor = COLORS.border; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: `${COLORS.accent}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <LayoutDashboard size={17} color={COLORS.accentDark} />
        </div>
        <div ref={ref} style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setMenuOpen((v) => !v)} style={{
            background: "none", border: "none", padding: 6, borderRadius: 6, cursor: "pointer",
            color: COLORS.textMuted, display: "flex", alignItems: "center"
          }}
            onMouseEnter={(e) => e.currentTarget.style.background = COLORS.surfaceAlt}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", right: 0,
              background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
              boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 200, zIndex: 100, overflow: "hidden"
            }}>
              {!isShared && (
                <>
                  <MenuItem icon={Trash2} danger onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</MenuItem>
                </>
              )}
              {isShared && (
                <MenuItem icon={X} danger onClick={() => { setMenuOpen(false); onRemoveFromList?.(); }}>Remove from my list</MenuItem>
              )}
            </div>
          )}
        </div>
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
        {dashboard.is_favorite ? <Star size={14} fill={COLORS.warning} color={COLORS.warning} /> : null}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dashboard.name}</span>
      </div>
      <div style={{
        fontSize: 12.5, color: COLORS.textSecondary, marginBottom: 10, lineHeight: 1.5,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 36
      }}>
        {dashboard.description || "No description"}
      </div>
      {isShared && (
        <div style={{
          alignSelf: "flex-start", marginBottom: 8,
          fontSize: 11, fontWeight: 600, color: COLORS.purple,
          background: `${COLORS.purple}1a`, padding: "3px 10px", borderRadius: 20,
          display: "inline-flex", alignItems: "center", gap: 4,
        }}>
          <Share2 size={11} /> Shared by {dashboard.shared_by_name || "someone"}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: "auto" }}>
        Last edited {stampLabel}
      </div>
    </div>
  );
};

// ─── Dashboards Page (orchestrator: list / creating / viewing) ───
const DashboardsPage = () => {
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState("list"); // "list" | "creating" | "viewing"

  const [activeId, setActiveId] = useState(null);
  const [activeConfig, setActiveConfig] = useState(null);
  const [activeName, setActiveName] = useState("");
  const [activeFavorite, setActiveFavorite] = useState(false);
  const [activeIsShared, setActiveIsShared] = useState(false);
  const [activeCanEdit, setActiveCanEdit] = useState(false); // editor-role recipients
  const [chatOpen, setChatOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const currentUserId = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("user") || "null")?.id; } catch { return null; }
  }, []);

  const menuRef = useRef(null);
  useEffect(() => {
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const fetchDashboards = useCallback(async () => {
    setLoading(true);
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/dashboards`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to load dashboards");
      const list = await res.json();
      setDashboards(Array.isArray(list) ? list : list.dashboards || []);
    } catch (err) {
      console.error("DashboardsPage fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDashboards(); }, [fetchDashboards]);

  // The "Saved" pill auto-fades after a couple of seconds.
  useEffect(() => {
    if (saveState === "saved") {
      const t = setTimeout(() => setSaveState("idle"), 2500);
      return () => clearTimeout(t);
    }
  }, [saveState]);

  const openDashboard = async (d) => {
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    const id = d.id || d._id;
    try {
      const res = await fetch(`${base}/api/dashboards/${id}`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to load");
      const full = await res.json();
      setActiveId(full.id || full._id || id);
      setActiveConfig(full.config);
      setActiveName(full.name || full.config?.title || "Untitled Dashboard");
      setActiveFavorite(!!full.is_favorite);
      setActiveIsShared(!!full.is_shared);
      setActiveCanEdit(!!full.can_edit);
      setChatOpen(false);
      setShareOpen(false);
      setSaveState("idle");
      setMode("viewing");
      setRenderKey((k) => k + 1);
    } catch (err) {
      alert("Failed to load: " + err.message);
    }
  };

  const startCreating = () => {
    setActiveId(null);
    setActiveConfig(null);
    setActiveName("");
    setActiveFavorite(false);
    setActiveIsShared(false);
    setActiveCanEdit(true);
    setChatOpen(false);
    setShareOpen(false);
    setSaveState("idle");
    setMode("creating");
  };

  const backToList = () => {
    setMode("list");
    setActiveId(null);
    setActiveConfig(null);
    setSaveState("idle");
    fetchDashboards();
  };

  // Called by DashboardChatPanel after each successful auto-save.
  const handleConfigChange = (newConfig, newId) => {
    setActiveConfig(newConfig);
    setActiveName((prev) => newConfig.title || prev || "Untitled Dashboard");
    setRenderKey((k) => k + 1);
    if (mode === "creating") {
      // First save promotes us into the viewing layout. Chat panel stays
      // closed by default — the dashboard speaks for itself; the user can
      // click "Edit with AI" if they want to refine.
      setActiveId(newId);
      setMode("viewing");
      setChatOpen(false);
    } else if (newId && !activeId) {
      setActiveId(newId);
    }
  };

  const persistMeta = async (changes) => {
    if (!activeId) return;
    setSaveState("saving");
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/dashboards/${activeId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaveState("saved");
    } catch (err) {
      console.error("Meta persist failed:", err);
      setSaveState("error");
    }
  };

  const handleRename = async () => {
    const newName = (titleDraft || "").trim();
    setEditingTitle(false);
    setTitleDraft("");
    if (!newName || newName === activeName) return;
    setActiveName(newName);
    const newConfig = { ...activeConfig, title: newName };
    setActiveConfig(newConfig);
    await persistMeta({ name: newName, config: newConfig });
  };

  const handleToggleFavorite = async () => {
    const newVal = !activeFavorite;
    setActiveFavorite(newVal);
    await persistMeta({ is_favorite: newVal });
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      await fetch(`${base}/api/dashboards/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      setDashboards((prev) => prev.filter((d) => (d.id || d._id) !== id));
      if (activeId === id) backToList();
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  };

  const handleDuplicate = async (idOrItem) => {
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    const id = typeof idOrItem === "object" ? (idOrItem.id || idOrItem._id) : idOrItem;
    try {
      const res = await fetch(`${base}/api/dashboards/${id}`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Load failed");
      const full = await res.json();
      const dupRes = await fetch(`${base}/api/dashboards`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: (full.name || "Untitled") + " (copy)",
          description: full.description || "",
          config: full.config,
        }),
      });
      if (!dupRes.ok) throw new Error("Duplicate failed");
      await fetchDashboards();
    } catch (err) {
      alert("Duplicate failed: " + err.message);
    }
  };

  // For shared items: revoke own access. Calls DELETE on the share row keyed
  // to the current user — backend permits owner OR self.
  const handleRemoveFromMyList = async (id) => {
    if (!currentUserId) return;
    if (!window.confirm("Remove this dashboard from your list? You'll lose access until the owner shares it again.")) return;
    const token = localStorage.getItem("token");
    const base = import.meta.env.VITE_API_BASE || "";
    try {
      const res = await fetch(`${base}/api/dashboards/${id}/shares/${currentUserId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Could not remove");
      setDashboards((prev) => prev.filter((d) => (d.id || d._id) !== id));
      if (activeId === id) backToList();
    } catch (err) {
      alert("Could not remove: " + err.message);
    }
  };

  // ── Mode: creating ──
  if (mode === "creating") {
    return (
      <div style={{ height: "100%", padding: 24, boxSizing: "border-box" }}>
        <div style={{
          height: "100%", display: "flex", flexDirection: "column",
          background: COLORS.surface, borderRadius: 16, border: `1px solid ${COLORS.border}`, overflow: "hidden"
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button onClick={backToList} style={{
                background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 8,
                padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary
              }}>
                <ChevronLeft size={16} />
              </button>
              <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>New Dashboard</div>
            </div>
            <SaveStatePill state={saveState} />
          </div>
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
            <DashboardChatPanel
              onConfigChange={handleConfigChange}
              onSaveStateChange={setSaveState}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Mode: viewing ──
  if (mode === "viewing" && activeConfig) {
    return (
      <div style={{ height: "100%", padding: 24, boxSizing: "border-box", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <button onClick={backToList} title="Back to dashboards" style={{
              background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
              padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", color: COLORS.textSecondary, flexShrink: 0
            }}>
              <ChevronLeft size={16} />
            </button>
            {editingTitle && !activeIsShared ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.target.blur();
                  if (e.key === "Escape") { setEditingTitle(false); setTitleDraft(""); }
                }}
                style={{
                  fontSize: 20, fontWeight: 700, color: COLORS.textPrimary,
                  border: `1px solid ${COLORS.accent}`, borderRadius: 6, padding: "3px 8px", outline: "none",
                  background: COLORS.surface, flex: 1, maxWidth: 480
                }}
              />
            ) : (
              <div
                onClick={() => { if (!activeIsShared) { setTitleDraft(activeName); setEditingTitle(true); } }}
                title={activeIsShared ? "Read-only — owner controls renaming" : "Click to rename"}
                style={{
                  fontSize: 20, fontWeight: 700, color: COLORS.textPrimary,
                  cursor: activeIsShared ? "default" : "text",
                  padding: "3px 6px", borderRadius: 6, border: "1px solid transparent",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 480
                }}
                onMouseEnter={(e) => { if (!activeIsShared) e.currentTarget.style.borderColor = COLORS.border; }}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
              >
                {activeName}
              </div>
            )}
            {activeIsShared && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: COLORS.purple,
                background: `${COLORS.purple}1a`, padding: "3px 10px", borderRadius: 20,
                display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0,
              }}>
                <Share2 size={11} /> Shared with you
              </span>
            )}
            <SaveStatePill state={saveState} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {!activeIsShared && (
              <>
                <button onClick={handleToggleFavorite} title={activeFavorite ? "Remove from favorites" : "Mark as favorite"} style={{
                  background: activeFavorite ? `${COLORS.warning}1a` : "#fff",
                  border: `1px solid ${activeFavorite ? COLORS.warning : COLORS.border}`,
                  borderRadius: 8, padding: "8px 10px", cursor: "pointer",
                  color: activeFavorite ? COLORS.warning : COLORS.textSecondary,
                  display: "flex", alignItems: "center"
                }}>
                  <Star size={15} fill={activeFavorite ? COLORS.warning : "none"} />
                </button>
                <button onClick={() => setShareOpen(true)} title="Share with people in your company" style={{
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
                  padding: "8px 14px", cursor: "pointer", color: COLORS.textPrimary,
                  fontSize: 13, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6
                }}>
                  <Share2 size={14} /> Share
                </button>
                <button onClick={() => setScheduleOpen(true)} title="Email this to me on a schedule" style={{
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
                  padding: "8px 14px", cursor: "pointer", color: COLORS.textPrimary,
                  fontSize: 13, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6
                }}>
                  <Calendar size={14} /> Schedule
                </button>
                <button
                  onClick={() => setChatOpen((v) => !v)}
                  title={chatOpen ? "Close AI editor" : "Open AI editor"}
                  aria-pressed={chatOpen}
                  style={{
                    padding: "8px 14px", borderRadius: 8,
                    border: chatOpen ? "none" : `1px solid ${COLORS.border}`,
                    background: chatOpen ? `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})` : "#fff",
                    color: chatOpen ? "#fff" : COLORS.textPrimary,
                    fontSize: 13, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                    boxShadow: chatOpen ? "0 4px 12px rgba(53,48,133,0.25)" : "none",
                    transition: "all 0.15s ease",
                  }}
                >
                  <Sparkles size={14} /> Edit with AI
                </button>
              </>
            )}
            {activeIsShared && activeCanEdit && (
              <button
                onClick={() => setChatOpen((v) => !v)}
                title={chatOpen ? "Close AI editor" : "Open AI editor"}
                aria-pressed={chatOpen}
                style={{
                  padding: "8px 14px", borderRadius: 8,
                  border: chatOpen ? "none" : `1px solid ${COLORS.border}`,
                  background: chatOpen ? `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})` : "#fff",
                  color: chatOpen ? "#fff" : COLORS.textPrimary,
                  fontSize: 13, fontWeight: 600, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <Sparkles size={14} /> Edit with AI
              </button>
            )}
            <div ref={menuRef} style={{ position: "relative" }}>
              <button onClick={() => setMenuOpen((v) => !v)} title="More" style={{
                background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8,
                padding: "8px 10px", cursor: "pointer", color: COLORS.textSecondary,
                display: "flex", alignItems: "center"
              }}>
                <MoreHorizontal size={16} />
              </button>
              {menuOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", right: 0,
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 200, zIndex: 100, overflow: "hidden"
                }}>
                  {!activeIsShared && (
                    <>
                      <MenuItem icon={Trash2} danger onClick={() => { setMenuOpen(false); handleDelete(activeId, activeName); }}>Delete dashboard</MenuItem>
                    </>
                  )}
                  {activeIsShared && (
                    <MenuItem icon={X} danger onClick={() => { setMenuOpen(false); handleRemoveFromMyList(activeId); }}>Remove from my list</MenuItem>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", gap: 16, minHeight: 0 }}>
          <div style={{
            flex: chatOpen ? "1 1 60%" : "1 1 100%",
            background: COLORS.surface, borderRadius: 16, border: `1px solid ${COLORS.border}`,
            padding: 20, overflowY: "auto", minWidth: 0, transition: "flex 0.2s ease"
          }}>
            <DashboardRenderer key={renderKey} spec={activeConfig} />
          </div>
          {chatOpen && (!activeIsShared || activeCanEdit) && (
            <div style={{
              flex: "0 0 40%", maxWidth: 480, background: COLORS.surface,
              border: `1px solid ${COLORS.border}`, borderRadius: 16, overflow: "hidden",
              display: "flex", flexDirection: "column", minHeight: 0
            }}>
              <DashboardChatPanel
                key={`chat-${activeId}`}
                existingConfig={activeConfig}
                existingId={activeId}
                onConfigChange={handleConfigChange}
                onSaveStateChange={setSaveState}
                onClose={() => setChatOpen(false)}
              />
            </div>
          )}
        </div>
        {shareOpen && (
          <ShareModal
            kind="dashboard"
            itemId={activeId}
            itemName={activeName}
            onClose={() => setShareOpen(false)}
          />
        )}
        {scheduleOpen && activeId && (
          <ScheduleModal
            kind="dashboard"
            itemId={activeId}
            itemName={activeName}
            onClose={() => setScheduleOpen(false)}
          />
        )}
      </div>
    );
  }

  // ── Mode: list (default) ──
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 32, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary }}>Dashboards</div>
          {dashboards.length > 0 && (
            <span style={{
              fontSize: 12, fontWeight: 600, background: `${COLORS.accent}20`, color: COLORS.accentDark,
              padding: "2px 10px", borderRadius: 20
            }}>{dashboards.length}</span>
          )}
        </div>
        {dashboards.length > 0 && (
          <button onClick={startCreating} style={{
            padding: "10px 18px", borderRadius: 10, border: "none",
            background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8,
            boxShadow: "0 4px 12px rgba(53,48,133,0.25)"
          }}>
            <Plus size={16} /> New Dashboard
          </button>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 60, color: COLORS.textSecondary }}>
          <Activity size={24} style={{ animation: "spin 1s linear infinite" }} />
          <div style={{ marginTop: 8, fontSize: 13 }}>Loading dashboards...</div>
        </div>
      )}

      {!loading && dashboards.length === 0 && (
        <div style={{ textAlign: "center", padding: 80, background: COLORS.surface, borderRadius: 16, border: `1px dashed ${COLORS.border}` }}>
          <div style={{
            width: 72, height: 72, borderRadius: 22, background: COLORS.surfaceAlt,
            display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px"
          }}>
            <LayoutDashboard size={32} color={COLORS.textMuted} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 6 }}>No dashboards yet</div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, marginBottom: 22, maxWidth: 420, margin: "0 auto 22px", lineHeight: 1.55 }}>
            Describe what you want to track and AI will design it for you. Saved automatically.
          </div>
          <button onClick={startCreating} style={{
            padding: "11px 22px", borderRadius: 10, border: "none",
            background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})`,
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 8,
            boxShadow: "0 4px 12px rgba(53,48,133,0.25)"
          }}>
            <Sparkles size={14} /> Build your first dashboard
          </button>
        </div>
      )}

      {!loading && dashboards.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {dashboards.map((d) => (
            <DashboardCard
              key={d.id || d._id}
              dashboard={d}
              onOpen={() => openDashboard(d)}
              onDelete={() => handleDelete(d.id || d._id, d.name)}
              onDuplicate={() => handleDuplicate(d)}
              onRemoveFromList={() => handleRemoveFromMyList(d.id || d._id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ─── User Management (admin-only) ───
const UserManagementPage = ({ currentUserId, onPermissionsChanged }) => {
  const [users, setUsers] = useState([]);
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingFeaturesFor, setEditingFeaturesFor] = useState(null); // user object
  const [editingUserFor, setEditingUserFor] = useState(null);
  const [resettingPwFor, setResettingPwFor] = useState(null);
  const [managingScopeFor, setManagingScopeFor] = useState(null);
  const [openMenuId, setOpenMenuId] = useState(null);

  const apiBase = import.meta.env.VITE_API_BASE || "";
  const authHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem("token")}`,
    "Content-Type": "application/json",
  });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [u, f] = await Promise.all([
        fetch(`${apiBase}/api/admin/users`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${apiBase}/api/admin/features`, { headers: authHeaders() }).then(r => r.json()),
      ]);
      setUsers(u.users || []);
      setFeatures(f.features || []);
    } catch (e) {
      setError("Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Close action menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    const handler = (e) => {
      if (!e.target.closest?.("[data-row-menu]")) setOpenMenuId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenuId]);

  const handleToggleActive = async (u) => {
    if (u.id === currentUserId) return; // self-lock guard (also enforced by backend)
    try {
      const res = await fetch(`${apiBase}/api/admin/users/${u.id}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ is_active: !u.is_active }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Update failed");
      fetchAll();
    } catch (e) {
      alert(e.message);
    }
  };

  // Admin escape hatch — wipe the target user's TOTP secret + backup codes so
  // they re-enroll on next login. Used when a user has lost their device.
  const handleReset2fa = async (u) => {
    if (!window.confirm(`Reset 2FA for ${u.full_name}? They'll be forced to enroll a new Authenticator app on their next sign-in. Their existing backup codes will stop working.`)) return;
    try {
      const res = await fetch(`${apiBase}/api/admin/users/${u.id}/2fa`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Reset failed");
      alert(`2FA reset for ${u.full_name}.`);
      fetchAll();
    } catch (e) {
      alert(e.message);
    }
  };

  const handleDelete = async (u) => {
    if (u.id === currentUserId) return;
    if (!confirm(`Permanently delete user "${u.full_name}" (${u.email})?\n\nThis removes the account and all of their dashboards, reports, chats, and scope settings. This cannot be undone. To temporarily disable instead, use Deactivate.`)) return;
    try {
      const res = await fetch(`${apiBase}/api/admin/users/${u.id}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Delete failed");
      fetchAll();
    } catch (e) {
      alert(e.message);
    }
  };

  const [syncingDepts, setSyncingDepts] = useState(false);
  const handleSyncDepartments = async () => {
    if (!confirm("Re-sync every imported practice head's department(s) from the Practice Heads list?\n\nThis overwrites each matching user's department scope with the values from the source file (e.g. Mirza Amir Baig → SAP Analytics; Rai Sohaib Amjad → SAP Finance + SAP Controlling).")) return;
    setSyncingDepts(true);
    try {
      const res = await fetch(`${apiBase}/api/admin/users/resync-practice-head-scopes`, {
        method: "POST", headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      alert(`Departments synced — updated ${data.summary?.updated ?? 0} user(s), ${data.summary?.no_user ?? 0} unmatched.`);
      fetchAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setSyncingDepts(false);
    }
  };

  return (
    <div style={{ padding: 32 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary }}>User Management</div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 4 }}>
            Add team members and control which features each can access.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleSyncDepartments}
            disabled={syncingDepts}
            title="Re-read the Practice Heads list and reset each matching user's department scope to the file's Department column"
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px",
              border: `1px solid ${COLORS.border}`, borderRadius: 10,
              background: COLORS.surface, color: COLORS.textPrimary,
              fontSize: 13, fontWeight: 600, cursor: syncingDepts ? "default" : "pointer",
              opacity: syncingDepts ? 0.6 : 1,
            }}
          >
            <Activity size={16} /> {syncingDepts ? "Syncing…" : "Sync Departments"}
          </button>
          <button
            onClick={() => setShowImport(true)}
            title="Bulk-create users from the Practice_Heads_List BigQuery table"
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px",
              border: `1px solid ${COLORS.border}`, borderRadius: 10,
              background: COLORS.surface, color: COLORS.textPrimary,
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}
          >
            <UserPlus size={16} /> Import Practice Heads
          </button>
          <button
            onClick={() => setShowAdd(true)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px",
              border: "none", borderRadius: 10,
              background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accentDark})`,
              color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
              boxShadow: "0 2px 8px rgba(51,51,51,0.18)"
            }}
          >
            <Plus size={16} /> Add User
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: "#DC2626", fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "visible" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1.7fr 1.4fr 0.8fr 1.3fr 0.85fr 0.85fr 1.1fr 56px",
          padding: "14px 20px", background: COLORS.surfaceAlt, borderBottom: `1px solid ${COLORS.border}`,
          fontSize: 11, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px",
        }}>
          <div>User</div><div>Email</div><div>Role</div><div>Department</div><div>Status</div><div>Features</div><div>Last Login</div><div></div>
        </div>

        {loading && (
          <div style={{ padding: 40, textAlign: "center", color: COLORS.textSecondary }}>
            <Activity size={20} style={{ animation: "spin 1s linear infinite" }} />
            <div style={{ marginTop: 8, fontSize: 13 }}>Loading users…</div>
          </div>
        )}

        {!loading && users.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: COLORS.textMuted, fontSize: 13 }}>No users found.</div>
        )}

        {!loading && users.map((u) => {
          const isMe = u.id === currentUserId;
          const isAdmin = (u.role || "").toLowerCase() === "admin";
          // Department scope: admins see everything; scoped users show their
          // assigned practice(s); unscoped non-admins show an em-dash.
          const depts = u.departments || [];
          const depDisplay = isAdmin ? "All" : (depts.length ? depts.join(", ") : "—");
          const depTitle = isAdmin
            ? "Admin — full access to all departments"
            : (depts.length ? depts.join(", ") : "No department scope assigned (sees all)");
          return (
            <div
              key={u.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1.7fr 1.4fr 0.8fr 1.3fr 0.85fr 0.85fr 1.1fr 56px",
                padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}`,
                fontSize: 13, alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 999, background: `${COLORS.accent}25`,
                  color: COLORS.accentDark, display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700, fontSize: 12,
                }}>
                  {(u.full_name || u.email || "?").trim().charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: COLORS.textPrimary }}>
                    {u.full_name} {isMe && <span style={{ fontSize: 11, fontWeight: 500, color: COLORS.textMuted }}>(you)</span>}
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.textMuted }}>{u.company_name}</div>
                </div>
              </div>
              <div style={{ color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
              <div>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20,
                  color: isAdmin ? COLORS.purple : COLORS.textSecondary,
                  background: isAdmin ? `${COLORS.purple}15` : COLORS.surfaceAlt,
                }}>
                  {isAdmin ? "Admin" : "User"}
                </span>
              </div>
              <div
                title={depTitle}
                style={{
                  color: isAdmin ? COLORS.textMuted : COLORS.textSecondary,
                  fontStyle: (isAdmin || !depts.length) ? "italic" : "normal",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                {depDisplay}
              </div>
              <div>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20,
                  color: u.is_active ? "#059669" : "#9CA3AF",
                  background: u.is_active ? "#ECFDF5" : "#F3F4F6",
                }}>
                  {u.is_active ? "Active" : "Disabled"}
                </span>
              </div>
              <div style={{ color: COLORS.textSecondary }}>
                {isAdmin ? <span style={{ color: COLORS.textMuted, fontStyle: "italic" }}>All</span> : `${u.features_count || 0} of ${features.length}`}
              </div>
              <div style={{ color: COLORS.textMuted, fontSize: 12 }}>
                {u.last_login ? new Date(u.last_login).toLocaleString() : "—"}
              </div>
              <div data-row-menu style={{ position: "relative", justifySelf: "end" }}>
                <button
                  onClick={() => setOpenMenuId(openMenuId === u.id ? null : u.id)}
                  style={{
                    width: 32, height: 32, borderRadius: 8, border: "none", background: "transparent",
                    cursor: "pointer", color: COLORS.textMuted, display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = COLORS.surfaceAlt}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  title="Actions"
                >
                  <Settings size={16} />
                </button>
                {openMenuId === u.id && (
                  <div style={{
                    position: "absolute", right: 0, top: "100%", marginTop: 4,
                    background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 180, zIndex: 50, overflow: "hidden",
                  }}>
                    {[
                      { label: "Edit details", onClick: () => { setEditingUserFor(u); setOpenMenuId(null); } },
                      !isAdmin && { label: "Manage features", onClick: () => { setEditingFeaturesFor(u); setOpenMenuId(null); } },
                      !isAdmin && { label: "Data scope", onClick: () => { setManagingScopeFor(u); setOpenMenuId(null); } },
                      { label: "Reset password", onClick: () => { setResettingPwFor(u); setOpenMenuId(null); } },
                      { label: "Reset 2FA (lost device)", onClick: () => { handleReset2fa(u); setOpenMenuId(null); } },
                      !isMe && { label: u.is_active ? "Deactivate" : "Reactivate", onClick: () => { handleToggleActive(u); setOpenMenuId(null); } },
                      !isMe && { label: "Delete", danger: true, onClick: () => { handleDelete(u); setOpenMenuId(null); } },
                    ].filter(Boolean).map((item, i) => (
                      <div
                        key={i}
                        onClick={item.onClick}
                        style={{
                          padding: "10px 14px", fontSize: 13, cursor: "pointer",
                          color: item.danger ? "#DC2626" : COLORS.textPrimary,
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = COLORS.surfaceAlt}
                        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                      >
                        {item.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showAdd && (
        <AddUserModal
          features={features}
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); fetchAll(); }}
        />
      )}
      {showImport && (
        <ImportPracticeHeadsModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); fetchAll(); }}
        />
      )}
      {editingFeaturesFor && (
        <ManageFeaturesModal
          user={editingFeaturesFor}
          features={features}
          onClose={() => setEditingFeaturesFor(null)}
          onSaved={() => {
            const wasMe = editingFeaturesFor.id === currentUserId;
            setEditingFeaturesFor(null);
            fetchAll();
            if (wasMe && onPermissionsChanged) onPermissionsChanged();
          }}
        />
      )}
      {editingUserFor && (
        <EditUserModal
          user={editingUserFor}
          isSelf={editingUserFor.id === currentUserId}
          onClose={() => setEditingUserFor(null)}
          onSaved={() => {
            const wasMe = editingUserFor.id === currentUserId;
            setEditingUserFor(null);
            fetchAll();
            if (wasMe && onPermissionsChanged) onPermissionsChanged();
          }}
        />
      )}
      {resettingPwFor && (
        <ResetPasswordModal
          user={resettingPwFor}
          onClose={() => setResettingPwFor(null)}
          onSaved={() => setResettingPwFor(null)}
        />
      )}
      {managingScopeFor && (
        <ManageScopeModal
          user={managingScopeFor}
          onClose={() => setManagingScopeFor(null)}
          onSaved={() => setManagingScopeFor(null)}
        />
      )}
    </div>
  );
};

// ─── Shared modal shell ───
const ModalShell = ({ title, subtitle, onClose, children, footer, width = 520 }) => {
  // Track where mousedown started so a text-selection drag that ends on the
  // backdrop doesn't accidentally close the modal (only a clean click that
  // both *started* and *ended* on the backdrop should close it).
  const mouseDownTargetRef = useRef(null);
  return (
  <div
    onMouseDown={(e) => { mouseDownTargetRef.current = e.target; }}
    onClick={(e) => { if (mouseDownTargetRef.current === e.currentTarget) onClose(); }}
    style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      animation: "fadeIn 0.15s ease",
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: COLORS.surface, borderRadius: 16, width, maxWidth: "92vw", maxHeight: "88vh",
        display: "flex", flexDirection: "column", boxShadow: "0 24px 48px rgba(0,0,0,0.18)",
      }}
    >
      <div style={{ padding: "18px 22px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{subtitle}</div>}
        </div>
        <button
          onClick={onClose}
          style={{ width: 30, height: 30, borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", color: COLORS.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <X size={18} />
        </button>
      </div>
      <div style={{ padding: 22, overflowY: "auto", flex: 1 }}>{children}</div>
      {footer && (
        <div style={{ padding: "14px 22px", borderTop: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          {footer}
        </div>
      )}
    </div>
  </div>
  );
};

const _inputStyle = {
  width: "100%", padding: "10px 12px", border: `1px solid ${COLORS.border}`,
  borderRadius: 10, fontSize: 13, outline: "none", boxSizing: "border-box",
  background: COLORS.surfaceAlt,
};
const _labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 6 };

const FeaturePicker = ({ features, selected, onChange, disabled = false }) => {
  const groups = features.reduce((acc, f) => {
    (acc[f.group || "Other"] ||= []).push(f);
    return acc;
  }, {});
  const toggle = (id) => {
    if (disabled) return;
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {Object.entries(groups).map(([group, items]) => (
        <div key={group}>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>{group}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {items.map((f) => {
              const checked = selected.includes(f.id);
              return (
                <label
                  key={f.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                    border: `1px solid ${checked ? COLORS.accent : COLORS.border}`,
                    borderRadius: 10, cursor: disabled ? "not-allowed" : "pointer",
                    background: checked ? `${COLORS.accent}10` : "#fff",
                    opacity: disabled ? 0.55 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(f.id)}
                    disabled={disabled}
                    style={{ accentColor: COLORS.accent, width: 16, height: 16 }}
                  />
                  <span style={{ fontSize: 13, color: COLORS.textPrimary, fontWeight: 500 }}>{f.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

// Bulk-import users from the Practice_Heads_List BigQuery table.
// Two-step flow: fetch preview → admin unticks rows they don't want →
// confirm POST. Backend creates users with role=user, all features
// granted, and a `department` scope entry per row.
const ImportPracticeHeadsModal = ({ onClose, onImported }) => {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState({}); // {email: bool}
  const [importing, setImporting] = useState(false);
  const [resultModal, setResultModal] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/admin/users/practice-heads-preview`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
        }
        const data = await res.json();
        setRows(data.rows || []);
        setWarning(data.warning || "");
        // Default: tick every row that would create (skip already-exists).
        const sel = {};
        for (const r of (data.rows || [])) {
          sel[r.email] = !!r.would_create;
        }
        setSelected(sel);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggle = (email) => setSelected(s => ({ ...s, [email]: !s[email] }));
  const selectAllReady = () => {
    const sel = {};
    for (const r of rows) sel[r.email] = !!r.would_create;
    setSelected(sel);
  };
  const selectNone = () => {
    const sel = {};
    for (const r of rows) sel[r.email] = false;
    setSelected(sel);
  };
  const selectedEmails = Object.entries(selected).filter(([_, v]) => v).map(([e]) => e);
  const readyToCreateCount = rows.filter(r => r.would_create && selected[r.email]).length;

  const handleImport = async () => {
    if (selectedEmails.length === 0) return;
    setImporting(true);
    setError("");
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/api/admin/users/practice-heads-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ emails: selectedEmails }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      setResultModal(data);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: COLORS.surface, borderRadius: 16, width: "100%", maxWidth: 980, maxHeight: "88vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: COLORS.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
              <UserPlus size={20} color={COLORS.accent} /> Import Practice Heads
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: COLORS.textSecondary }}>
              Bulk-create users from <code style={{ background: COLORS.surfaceAlt, padding: "1px 6px", borderRadius: 4 }}>Practice_Heads_List</code>.
              Each new user is role <strong>user</strong>, gets every feature, and is scoped to their own practice (EmployeeHierarchyNode).
            </p>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {error && (
            <div style={{ padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle size={16} /> {error}
            </div>
          )}
          {warning && (
            <div style={{ padding: "10px 14px", background: "#FEF3C7", color: "#92400E", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              {warning}
            </div>
          )}
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", color: COLORS.textMuted, fontSize: 14 }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: COLORS.textMuted, fontSize: 14, border: `1px dashed ${COLORS.border}`, borderRadius: 10 }}>
              No rows in Practice_Heads_List.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
                <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
                  {readyToCreateCount} of {rows.length} selected for import
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={selectAllReady} style={{
                    padding: "6px 12px", borderRadius: 6, border: `1px solid ${COLORS.border}`,
                    background: COLORS.surface, color: COLORS.textSecondary, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}>Select ready</button>
                  <button onClick={selectNone} style={{
                    padding: "6px 12px", borderRadius: 6, border: `1px solid ${COLORS.border}`,
                    background: COLORS.surface, color: COLORS.textSecondary, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}>Select none</button>
                </div>
              </div>
              <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "40px 1.4fr 1.6fr 1.5fr 1.2fr 1.2fr",
                  padding: "10px 14px", background: COLORS.surfaceAlt, borderBottom: `1px solid ${COLORS.border}`,
                  fontSize: 11, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px",
                }}>
                  <div></div>
                  <div>Name</div>
                  <div>Email</div>
                  <div>Practice</div>
                  <div>Position</div>
                  <div>Status</div>
                </div>
                {rows.map(r => {
                  const isReady = r.would_create;
                  const isSelected = !!selected[r.email];
                  return (
                    <div key={r.email} style={{
                      display: "grid", gridTemplateColumns: "40px 1.4fr 1.6fr 1.5fr 1.2fr 1.2fr",
                      padding: "12px 14px", borderTop: `1px solid ${COLORS.border}`,
                      fontSize: 13, alignItems: "center",
                      opacity: isReady ? 1 : 0.65,
                    }}>
                      <div>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!isReady}
                          onChange={() => toggle(r.email)}
                        />
                      </div>
                      <div style={{ fontWeight: 600, color: COLORS.textPrimary }}>{r.resource_name || "—"}</div>
                      <div style={{ color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.email}</div>
                      <div style={{ color: COLORS.textSecondary }}>{r.hierarchy_node || r.department || "—"}</div>
                      <div style={{ color: COLORS.textMuted, fontSize: 12 }}>{r.position || "—"}</div>
                      <div>
                        {isReady ? (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: "#DCFCE7", color: "#0E7E3E" }}>Ready</span>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: COLORS.surfaceAlt, color: COLORS.textMuted }}>Exists</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: COLORS.textMuted }}>
                Each created user gets a one-time random password — you'll see them in the summary after import so you can share them out of band.
              </div>
            </>
          )}
        </div>

        <div style={{ padding: "14px 24px", borderTop: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "flex-end", gap: 8, background: COLORS.surfaceAlt }}>
          <button onClick={onClose} style={{
            padding: "10px 18px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
            background: COLORS.surface, color: COLORS.textSecondary, fontWeight: 600, fontSize: 14, cursor: "pointer",
          }}>Cancel</button>
          <button
            onClick={handleImport}
            disabled={readyToCreateCount === 0 || importing || loading}
            style={{
              padding: "10px 20px", borderRadius: 8, border: "none",
              background: readyToCreateCount > 0 && !importing ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})` : "#E5E7EB",
              color: "#fff", fontWeight: 700, fontSize: 14,
              cursor: readyToCreateCount > 0 && !importing ? "pointer" : "not-allowed",
              opacity: readyToCreateCount > 0 && !importing ? 1 : 0.6,
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            {importing ? "Importing…" : `Import ${readyToCreateCount} user${readyToCreateCount === 1 ? "" : "s"}`}
          </button>
        </div>

        {resultModal && (
          <ImportResultOverlay
            result={resultModal}
            onClose={() => {
              setResultModal(null);
              onImported && onImported();
            }}
          />
        )}
      </div>
    </div>
  );
};

// Shows the per-row summary after the import call — includes the temp
// passwords for newly-created users so the admin can share them.
const ImportResultOverlay = ({ result, onClose }) => {
  const created = (result.results || []).filter(r => r.status === "created");
  const skipped = (result.results || []).filter(r => r.status === "skipped");
  const errored = (result.results || []).filter(r => r.status === "error");
  return (
    <div style={{
      position: "absolute", inset: 0, background: "rgba(15,23,42,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 5,
    }}>
      <div style={{
        background: COLORS.surface, borderRadius: 14, width: "100%", maxWidth: 720, maxHeight: "85%",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      }}>
        <div style={{ padding: "18px 22px", borderBottom: `1px solid ${COLORS.border}` }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.textPrimary }}>
            Import complete
          </h3>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: COLORS.textSecondary }}>
            Created {created.length} · Skipped {skipped.length} · Errored {errored.length}
          </p>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {created.length > 0 && (
            <>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Created — share these temp passwords privately</h4>
              <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, marginBottom: 16, overflow: "hidden" }}>
                {created.map((r, i) => (
                  <div key={r.email} style={{
                    padding: "10px 14px", borderTop: i === 0 ? "none" : `1px solid ${COLORS.border}`,
                    display: "grid", gridTemplateColumns: "1.5fr 2fr 1.5fr", gap: 12, alignItems: "center", fontSize: 13,
                  }}>
                    <div style={{ fontWeight: 600, color: COLORS.textPrimary }}>{r.name}</div>
                    <div style={{ color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.email}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 12, color: COLORS.accent, fontWeight: 700, userSelect: "all" }}>{r.temp_password}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          {skipped.length > 0 && (
            <>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Skipped</h4>
              <div style={{ fontSize: 13, color: COLORS.textSecondary, marginBottom: 12 }}>
                {skipped.map(r => r.email).join(", ")}
              </div>
            </>
          )}
          {errored.length > 0 && (
            <>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#991B1B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Errors</h4>
              <div style={{ fontSize: 13, color: "#991B1B" }}>
                {errored.map(r => <div key={r.email}>{r.email}: {r.message}</div>)}
              </div>
            </>
          )}
        </div>
        <div style={{ padding: "12px 22px", borderTop: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "flex-end", background: COLORS.surfaceAlt }}>
          <button onClick={onClose} style={{
            padding: "9px 18px", borderRadius: 8, border: "none",
            background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`,
            color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
          }}>Done</button>
        </div>
      </div>
    </div>
  );
};

const AddUserModal = ({ features, onClose, onCreated }) => {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [granted, setGranted] = useState(features.map((f) => f.id)); // default: all features
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (!email.trim() || !fullName.trim() || !password.trim()) {
      setErr("Email, name, and password are all required.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE || ""}/api/admin/users`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(), full_name: fullName.trim(), password,
          role, features: role === "admin" ? [] : granted,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || "Failed to create user");
      }
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="Add User"
      subtitle="Create a new team member and grant them feature access."
      onClose={onClose}
      width={580}
      footer={
        <>
          <button onClick={onClose} disabled={busy} style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${COLORS.border}`, background: COLORS.surface, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: COLORS.primary, color: "#fff", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Creating…" : "Create user"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={_labelStyle}>Full name</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={_inputStyle} placeholder="Jane Doe" />
          </div>
          <div>
            <label style={_labelStyle}>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={_inputStyle} placeholder="jane@tmcltd.com" />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={_labelStyle}>Temporary password</label>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} style={_inputStyle} placeholder="At least 4 characters" />
          </div>
          <div>
            <label style={_labelStyle}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={_inputStyle}>
              <option value="user">User</option>
              <option value="admin">Admin (full access)</option>
            </select>
          </div>
        </div>
        <div>
          <label style={_labelStyle}>
            Feature access {role === "admin" && <span style={{ fontStyle: "italic", color: COLORS.textMuted, fontWeight: 500 }}>— admins always see everything</span>}
          </label>
          <FeaturePicker features={features} selected={role === "admin" ? features.map((f) => f.id) : granted} onChange={setGranted} disabled={role === "admin"} />
        </div>
        {err && <div style={{ padding: 10, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#DC2626", fontSize: 13 }}>{err}</div>}
      </div>
    </ModalShell>
  );
};

const ManageFeaturesModal = ({ user, features, onClose, onSaved }) => {
  const [granted, setGranted] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_BASE || ""}/api/admin/users/${user.id}/features`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    })
      .then((r) => r.json())
      .then((data) => setGranted(data.features || []))
      .catch(() => setErr("Failed to load current features."))
      .finally(() => setLoading(false));
  }, [user.id]);

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE || ""}/api/admin/users/${user.id}/features`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ features: granted }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Save failed");
      onSaved();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={`Features for ${user.full_name}`}
      subtitle="Choose which features this user can access. Admins always see everything."
      onClose={onClose}
      width={580}
      footer={
        <>
          <button onClick={onClose} disabled={busy} style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${COLORS.border}`, background: COLORS.surface, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={busy || loading} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: COLORS.accent, color: "#fff", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: COLORS.textSecondary }}>Loading…</div>
      ) : (
        <FeaturePicker features={features} selected={granted} onChange={setGranted} />
      )}
      {err && <div style={{ marginTop: 12, padding: 10, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#DC2626", fontSize: 13 }}>{err}</div>}
    </ModalShell>
  );
};

// ─── Data Scope Modal ───────────────────────────────────────────────────────
// Controls which DEPARTMENT(S) (Employee_Data.EmployeeHierarchyNode) a user is
// restricted to. When enforced, the user only sees workforce data (attendance,
// timesheets, allocations, employees) for the selected practice(s) across the
// AI chat/voice agent, dashboards, reports, and the Availability Engine. Sales
// data stays shared. Admins always see everything. Multi-select supports heads
// who lead more than one practice (e.g. Rai Sohaib Amjad → SAP Finance + SAP
// Controlling).
const ManageScopeModal = ({ user, onClose, onSaved }) => {
  const apiBase = import.meta.env.VITE_API_BASE || "";
  const authH = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" });

  const [deptValues, setDeptValues] = useState([]);   // [{value, label}] from BQ
  const [enforced, setEnforced] = useState(false);
  const [selectedDepts, setSelectedDepts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Load current scope + the available department list in parallel.
  useEffect(() => {
    Promise.all([
      fetch(`${apiBase}/api/admin/users/${user.id}/scope`, { headers: authH() }).then(r => r.json()),
      fetch(`${apiBase}/api/admin/lookups/department`, { headers: authH() }).then(r => r.json()),
    ])
      .then(([scope, lookup]) => {
        const values = lookup.values || [];
        setDeptValues(values);
        setEnforced(scope.policies?.department === true);
        // Normalise stored scope values to the warehouse casing so the
        // checkboxes pre-select correctly even when the seeded value differs
        // in case (e.g. 'SAP ABAP & FIORI' vs 'SAP ABAP & Fiori').
        const byLower = new Map(values.map(v => [String(v.value).toLowerCase(), v.value]));
        const stored = scope.values?.department || [];
        setSelectedDepts(stored.map(s => byLower.get(String(s).toLowerCase()) || s));
      })
      .catch(() => setErr("Failed to load scope settings."))
      .finally(() => setLoading(false));
  }, [user.id]);

  const toggleDept = (val) => {
    setSelectedDepts(prev => prev.includes(val) ? prev.filter(p => p !== val) : [...prev, val]);
  };

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`${apiBase}/api/admin/users/${user.id}/scope`, {
        method: "PUT",
        headers: authH(),
        body: JSON.stringify({ dimension: "department", enforced, values: enforced ? selectedDepts : [] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Save failed");
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <ModalShell
      title={`Data Scope — ${user.full_name}`}
      subtitle="Restrict this user to specific department(s). Applies to AI chat/voice, dashboards, reports, and the Availability Engine."
      onClose={onClose}
      width={520}
      footer={
        <>
          <button onClick={onClose} disabled={busy} style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${COLORS.border}`, background: COLORS.surface, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={busy || loading} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: COLORS.primary, color: "#fff", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: COLORS.textSecondary }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Department scope toggle */}
          <div style={{ padding: 16, background: COLORS.surfaceAlt, borderRadius: 12, border: `1px solid ${COLORS.border}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>Department Access</div>
                <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>
                  {enforced ? "Restricted — user sees only the selected department(s)" : "Unrestricted — user sees all departments (default)"}
                </div>
              </div>
              {/* Toggle switch */}
              <div
                onClick={() => { setEnforced(v => !v); }}
                style={{
                  width: 44, height: 24, borderRadius: 12, background: enforced ? COLORS.primary : "#D1D5DB",
                  cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0,
                }}
              >
                <div style={{
                  position: "absolute", top: 2, left: enforced ? 22 : 2, width: 20, height: 20,
                  borderRadius: "50%", background: COLORS.surface, transition: "left 0.2s",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
                }} />
              </div>
            </div>

            {enforced && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 10 }}>
                  Select Allowed Departments
                </div>
                {deptValues.length === 0 ? (
                  <div style={{ fontSize: 13, color: COLORS.textMuted }}>No departments found in the data warehouse.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                    {deptValues.map(p => {
                      const checked = selectedDepts.includes(p.value);
                      return (
                        <label
                          key={p.value}
                          style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                            border: `1px solid ${checked ? COLORS.accent : COLORS.border}`,
                            borderRadius: 9, cursor: "pointer",
                            background: checked ? `${COLORS.accent}10` : "#fff",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDept(p.value)}
                            style={{ accentColor: COLORS.accent, width: 15, height: 15 }}
                          />
                          <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{p.value}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {enforced && selectedDepts.length === 0 && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "#FEF9E7", border: "1px solid #FCD34D", borderRadius: 8, fontSize: 12, color: "#92400E" }}>
                    ⚠ No departments selected — this user will see no workforce data.
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.5 }}>
            Changes apply to AI chat/voice, dashboards, reports, and the Availability Engine. Sales data stays visible to everyone. Admins always see all data regardless of scope settings.
          </div>
        </div>
      )}
      {err && <div style={{ marginTop: 12, padding: 10, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#DC2626", fontSize: 13 }}>{err}</div>}
    </ModalShell>
  );
};

const EditUserModal = ({ user, isSelf, onClose, onSaved }) => {
  const [fullName, setFullName] = useState(user.full_name || "");
  const [role, setRole] = useState((user.role || "user").toLowerCase());
  const [active, setActive] = useState(!!user.is_active);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      const body = { full_name: fullName, role, is_active: active };
      const res = await fetch(`${import.meta.env.VITE_API_BASE || ""}/api/admin/users/${user.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Save failed");
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <ModalShell
      title="Edit user"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button onClick={onClose} disabled={busy} style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${COLORS.border}`, background: COLORS.surface, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: COLORS.primary, color: "#fff", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={_labelStyle}>Email</label>
          <input value={user.email} disabled style={{ ..._inputStyle, color: COLORS.textMuted, background: COLORS.surfaceAlt }} />
        </div>
        <div>
          <label style={_labelStyle}>Full name</label>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={_inputStyle} />
        </div>
        <div>
          <label style={_labelStyle}>Role {isSelf && <span style={{ color: COLORS.textMuted, fontStyle: "italic", fontWeight: 500 }}>— you can't demote yourself</span>}</label>
          <select value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf} style={{ ..._inputStyle, opacity: isSelf ? 0.6 : 1 }}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: COLORS.textPrimary, cursor: isSelf ? "not-allowed" : "pointer" }}>
          <input type="checkbox" checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} style={{ accentColor: COLORS.accent }} />
          Account active {isSelf && <span style={{ color: COLORS.textMuted, fontStyle: "italic" }}>(you can't deactivate yourself)</span>}
        </label>
        {err && <div style={{ padding: 10, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#DC2626", fontSize: 13 }}>{err}</div>}
      </div>
    </ModalShell>
  );
};

const ResetPasswordModal = ({ user, onClose, onSaved }) => {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (pw.trim().length < 4) { setErr("Password must be at least 4 characters."); return; }
    setBusy(true); setErr("");
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE || ""}/api/admin/users/${user.id}/password`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Reset failed");
      setDone(true);
      setTimeout(onSaved, 800);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <ModalShell
      title={`Reset password for ${user.full_name}`}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button onClick={onClose} disabled={busy} style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${COLORS.border}`, background: COLORS.surface, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={busy || done} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: COLORS.danger, color: "#fff", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy || done ? 0.7 : 1 }}>
            {done ? "Done!" : busy ? "Resetting…" : "Reset password"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13, color: COLORS.textSecondary, marginBottom: 10 }}>
        Set a new password for <strong>{user.email}</strong>. Share it with them securely; they should change it after their next login.
      </div>
      <label style={_labelStyle}>New password</label>
      <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} style={_inputStyle} placeholder="At least 4 characters" />
      {err && <div style={{ marginTop: 10, padding: 10, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#DC2626", fontSize: 13 }}>{err}</div>}
    </ModalShell>
  );
};


// ─── AI privacy toggle (inline in profile dropdown) ───
//
// Reads + writes /api/me/settings.ai_opt_out. When the user opts out, the
// backend skips injecting BigQuery data context into Gemini calls — their
// raw prompts still go through but with PII redaction only. The toggle is
// a small inline UI element, not a full settings page.
const AiOptOutToggle = () => {
  const [optOut, setOptOut] = useState(null);
  const [saving, setSaving] = useState(false);
  const apiBase = import.meta.env.VITE_API_BASE || "";

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;
    fetch(`${apiBase}/api/me/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setOptOut(d ? !!d.ai_opt_out : false))
      .catch(() => setOptOut(false));
  }, [apiBase]);

  const toggle = async (e) => {
    e.stopPropagation();
    if (optOut === null) return;
    setSaving(true);
    const next = !optOut;
    setOptOut(next);
    const token = localStorage.getItem("token");
    try {
      await fetch(`${apiBase}/api/me/settings`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ai_opt_out: next }),
      });
    } catch {} finally { setSaving(false); }
  };

  // Hidden for now — return null unconditionally
  return null;
};


// ─── Privacy & data page (linked from profile menu) ───
const PrivacyPage = ({ onBack }) => (
  <div style={{ height: "100%", overflowY: "auto", padding: 40, boxSizing: "border-box", maxWidth: 760, margin: "0 auto" }}>
    <button onClick={onBack} style={{
      background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 8,
      padding: "6px 12px", cursor: "pointer", color: COLORS.textSecondary, fontSize: 13, fontWeight: 500, marginBottom: 20,
    }}>
      <ChevronLeft size={14} style={{ verticalAlign: "middle", marginRight: 4 }} /> Back
    </button>
    <h1 style={{ fontSize: 26, fontWeight: 800, color: COLORS.textPrimary, marginBottom: 6 }}>Privacy & data</h1>
    <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 28 }}>
      How Satori handles your data, cookies, and AI prompts.
    </div>

    <h2 style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, marginTop: 24, marginBottom: 8 }}>Authentication</h2>
    <p style={{ fontSize: 13.5, lineHeight: 1.65, color: COLORS.textSecondary }}>
      Every account uses mandatory two-factor authentication via an Authenticator app (Google Authenticator, Microsoft Authenticator, Authy, or similar). Your TOTP secret is encrypted at rest with a Fernet key held in Google Secret Manager. Single-use backup codes are bcrypt-hashed; the plaintext is shown to you exactly once at enrollment.
    </p>

    <h2 style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, marginTop: 24, marginBottom: 8 }}>Cookies</h2>
    <p style={{ fontSize: 13.5, lineHeight: 1.65, color: COLORS.textSecondary }}>
      We use one cookie: <code style={{ background: COLORS.surfaceAlt, padding: "1px 6px", borderRadius: 4, fontFamily: "ui-monospace, monospace" }}>satori_trust_device</code>. It's set when you check "Trust this device for 30 days" after a successful 2FA verification. The cookie is <strong>HttpOnly</strong> (JavaScript can't read it), <strong>Secure</strong> (HTTPS only), and <strong>SameSite=None</strong> so it works across our frontend and API subdomains. It expires 30 days after your last login. Clicking <strong>Sign out</strong> clears it.
    </p>

    <h2 style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, marginTop: 24, marginBottom: 8 }}>What gets logged</h2>
    <ul style={{ fontSize: 13.5, lineHeight: 1.7, color: COLORS.textSecondary, paddingLeft: 22 }}>
      <li>Login attempts (success + failure, with IP) — kept 90 days.</li>
      <li>Data-access events: dashboard views, report previews, downloads, AI prompts, share changes, admin actions — kept 1 year, visible to admins under Audit Log.</li>
      <li>AI chat history (your prompts and our replies) — kept 30 days.</li>
    </ul>

    <h2 style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, marginTop: 24, marginBottom: 8 }}>AI data flow</h2>
    <p style={{ fontSize: 13.5, lineHeight: 1.65, color: COLORS.textSecondary }}>
      The Ask-Me-Anything assistant and dashboard / report builders send your prompts to Google Gemini (Vertex AI in <code style={{ background: COLORS.surfaceAlt, padding: "1px 6px", borderRadius: 4, fontFamily: "ui-monospace, monospace" }}>us-central1</code>). Prompts are PII-redacted server-side before they leave — emails, phone numbers, CNIC patterns, and long numeric runs are replaced with placeholders. Business-data context (BigQuery rows) is also injected so the AI can answer with real numbers. You can opt out of the data-context injection from the profile menu — your prompts still go to the AI, but with no TMC row data attached.
    </p>

    <h2 style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, marginTop: 24, marginBottom: 8 }}>Exports</h2>
    <p style={{ fontSize: 13.5, lineHeight: 1.65, color: COLORS.textSecondary }}>
      Every Excel and PDF download is watermarked in the file header with your email and the export timestamp, and recorded in the audit log. Admins can trace a leaked file back to the user who exported it.
    </p>

    <h2 style={{ fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, marginTop: 24, marginBottom: 8 }}>Data subject rights</h2>
    <p style={{ fontSize: 13.5, lineHeight: 1.65, color: COLORS.textSecondary }}>
      Need a copy of your data or want your content removed? An admin can export your full profile + dashboards + reports + audit history as a JSON file, or purge your saved content. Email your admin or open a request via internal support.
    </p>

    <div style={{ marginTop: 36, padding: "14px 18px", background: COLORS.surfaceAlt, borderRadius: 12, fontSize: 12.5, color: COLORS.textMuted }}>
      Satori is built and operated by <strong>TallyMarks Consulting (TMC)</strong> for internal capability and workforce reporting. For any data governance questions or compliance requests contact your TMC point of contact.
    </div>
  </div>
);


// ─── Audit Log Page (admin only) ───
//
// Renders the data-access audit log (data_access_log table) returned by
// /api/admin/audit. Each row is one governance-relevant event — dashboard
// view, report download, AI chat, share change, 2FA admin reset, etc.
// Filterable by action prefix (e.g. "report.download" for exports) and
// user. Defaults to the last 200 rows.
const AuditLogPage = () => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const apiBase = import.meta.env.VITE_API_BASE || "";

  const fetchLog = useCallback(async () => {
    setLoading(true); setError("");
    const token = localStorage.getItem("token");
    try {
      const q = filter ? `?action=${encodeURIComponent(filter)}&limit=500` : "?limit=500";
      const res = await fetch(`${apiBase}/api/admin/audit${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load audit log");
      const data = await res.json();
      setEvents(data.events || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiBase, filter]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) : "—";
  const actionColor = (a) => {
    if (!a) return COLORS.textMuted;
    if (a.startsWith("share.")) return COLORS.purple;
    if (a.startsWith("report.download")) return COLORS.danger;
    if (a.startsWith("totp.")) return COLORS.warning;
    if (a.startsWith("ai.feedback.flagged")) return COLORS.danger;
    if (a.startsWith("ai.")) return COLORS.teal;
    if (a.startsWith("user.")) return COLORS.danger;
    return COLORS.accentDark;
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 32, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary }}>Audit Log</div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 2 }}>
            Every data-touching action: dashboard views, report downloads, AI prompts, share changes, admin overrides.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {[
            { label: "All", val: "" },
            { label: "🚩 Flagged", val: "ai.feedback.flagged" },
            { label: "Downloads", val: "report.download" },
            { label: "Shares", val: "share." },
            { label: "AI", val: "ai." },
            { label: "Admin", val: "totp.admin_reset" },
          ].map((f) => (
            <button key={f.val} onClick={() => setFilter(f.val)} style={{
              padding: "6px 12px", borderRadius: 8,
              border: filter === f.val ? "none" : `1px solid ${COLORS.border}`,
              background: filter === f.val ? `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})` : "#fff",
              color: filter === f.val ? "#fff" : COLORS.textPrimary,
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>{f.label}</button>
          ))}
        </div>
      </div>
      {loading && (
        <div style={{ textAlign: "center", padding: 40, color: COLORS.textSecondary }}>
          <Activity size={20} style={{ animation: "spin 1s linear infinite" }} />
          <div style={{ fontSize: 13, marginTop: 6 }}>Loading audit log…</div>
        </div>
      )}
      {error && (
        <div style={{ padding: 14, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: COLORS.danger, fontSize: 13 }}>
          {error}
        </div>
      )}
      {!loading && !error && events.length === 0 && (
        <div style={{ padding: 60, textAlign: "center", color: COLORS.textSecondary, background: COLORS.surface, borderRadius: 12, border: `1px dashed ${COLORS.border}` }}>
          No events match this filter yet.
        </div>
      )}
      {!loading && events.length > 0 && (
        <div style={{ background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: COLORS.primary, color: "#fff" }}>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>When</th>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>User</th>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>Action</th>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>Resource</th>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>Detail</th>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>IP</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={e.id} style={{ background: i % 2 ? COLORS.surfaceAlt : "#fff", borderBottom: `1px solid ${COLORS.border}` }}>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap", color: COLORS.textSecondary, fontFamily: "ui-monospace, monospace" }}>{fmtTime(e.created_at)}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap" }}>{e.user_email || "—"}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap", fontWeight: 600, color: actionColor(e.action) }}>{e.action}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap" }}>{e.resource_type ? `${e.resource_type}#${e.resource_id || ""}` : "—"}</td>
                  <td style={{ padding: "8px 14px", color: COLORS.textSecondary, fontSize: 12, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.detail || ""}>{e.detail || "—"}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap", color: COLORS.textMuted, fontFamily: "ui-monospace, monospace" }}>{e.ip_address || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};


const SupportTicketsPage = () => {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const apiBase = import.meta.env.VITE_API_BASE || "";

  const fetchTickets = useCallback(async () => {
    setLoading(true); setError("");
    const token = localStorage.getItem("token");
    try {
      const q = filter ? `?status=${encodeURIComponent(filter)}` : "";
      const res = await fetch(`${apiBase}/api/admin/support/tickets${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load tickets");
      const data = await res.json();
      setTickets(data.tickets || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiBase, filter]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  const setStatus = async (id, status) => {
    const token = localStorage.getItem("token");
    try {
      await fetch(`${apiBase}/api/admin/support/tickets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      });
      fetchTickets();
    } catch (_) { /* ignore */ }
  };

  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
  const catLabel = { bug: "Broken", data: "Data", feature: "Feature", other: "Other" };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 32, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary }}>Support Tickets</div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 2 }}>
            Issues users reported via "Report an issue". Each is also emailed to the support inbox.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {[{ label: "All", val: "" }, { label: "Open", val: "open" }, { label: "Resolved", val: "resolved" }].map((f) => (
            <button key={f.val} onClick={() => setFilter(f.val)} style={{
              padding: "6px 12px", borderRadius: 8,
              border: filter === f.val ? "none" : `1px solid ${COLORS.border}`,
              background: filter === f.val ? `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.teal})` : "#fff",
              color: filter === f.val ? "#fff" : COLORS.textPrimary,
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>{f.label}</button>
          ))}
        </div>
      </div>
      {loading && (
        <div style={{ textAlign: "center", padding: 40, color: COLORS.textSecondary }}>
          <Activity size={20} style={{ animation: "spin 1s linear infinite" }} />
          <div style={{ fontSize: 13, marginTop: 6 }}>Loading tickets…</div>
        </div>
      )}
      {error && (
        <div style={{ padding: 14, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: COLORS.danger, fontSize: 13 }}>
          {error}
        </div>
      )}
      {!loading && !error && tickets.length === 0 && (
        <div style={{ padding: 60, textAlign: "center", color: COLORS.textSecondary, background: COLORS.surface, borderRadius: 12, border: `1px dashed ${COLORS.border}` }}>
          No tickets here yet.
        </div>
      )}
      {!loading && tickets.length > 0 && (
        <div style={{ background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: COLORS.primary, color: "#fff" }}>
                {["When", "User", "Type", "Page", "Message", "Status", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t, i) => (
                <tr key={t.id} style={{ background: i % 2 ? COLORS.surfaceAlt : "#fff", borderBottom: `1px solid ${COLORS.border}` }}>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap", color: COLORS.textSecondary, fontFamily: "ui-monospace, monospace" }}>{fmtTime(t.created_at)}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap" }}>{t.user_email || "—"}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap", fontWeight: 600 }}>{catLabel[t.category] || t.category || "—"}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap", color: COLORS.textMuted }}>{t.page || "—"}</td>
                  <td style={{ padding: "8px 14px", color: COLORS.textSecondary, maxWidth: 420 }} title={t.message || ""}>{t.message || "—"}</td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap" }}>
                    <span style={{
                      padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                      background: t.status === "resolved" ? "#ECFDF5" : "#FFFBEB",
                      color: t.status === "resolved" ? "#059669" : "#B45309",
                    }}>{t.status === "resolved" ? "Resolved" : "Open"}</span>
                  </td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap" }}>
                    <button onClick={() => setStatus(t.id, t.status === "resolved" ? "open" : "resolved")} style={{
                      padding: "5px 10px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
                      background: COLORS.surface, color: COLORS.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                    }}>{t.status === "resolved" ? "Reopen" : "Resolve"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};


// ─── Navigation Config ───
// Three permission-gated workspace features + an admin-only User Management page.
// `requiresFeature` maps to a feature_id in the backend FEATURE_CATALOG.
// `adminOnly` items render only for admins, regardless of feature grants.
// ─── Schema Settings (admin only) ───────────────────────────────────────────
//
// Lets admins curate per-table descriptions (column types, column meanings,
// join hints) that get injected into every agent's system prompt. The
// Auto-Detect Schema button pulls the live column metadata from BigQuery and
// drops it into the description box; the admin can then add business context
// (e.g. "EmployeeHierarchyNode = department", "JOIN on Resource_Name").
const SchemaSettingsCard = () => {
  const apiBase = import.meta.env.VITE_API_BASE || "";
  const authH = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" });

  const [rows, setRows] = useState([]);
  const [availableTables, setAvailableTables] = useState([]);
  const [addPicker, setAddPicker] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [autoBusy, setAutoBusy] = useState(null); // table_name currently auto-detecting
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const reload = () => {
    setLoading(true);
    Promise.all([
      fetch(`${apiBase}/api/admin/schema-settings`, { headers: authH() }).then(r => r.json()),
      fetch(`${apiBase}/api/admin/schema-tables`, { headers: authH() }).then(r => r.json()),
    ])
      .then(([s, t]) => {
        setRows((s.settings || []).map(r => ({ ...r })));
        setAvailableTables(t.tables || []);
      })
      .catch(() => setError("Failed to load schema settings."))
      .finally(() => setLoading(false));
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const updateRow = (idx, patch) => {
    setRows(rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const removeRow = (idx) => {
    setRows(rows.filter((_, i) => i !== idx));
  };

  const addRow = () => {
    const name = (addPicker || "").trim();
    if (!name) return;
    if (rows.some(r => r.table_name === name)) {
      setError(`"${name}" is already in the list.`);
      return;
    }
    setRows([...rows, { table_name: name, description: "", sort_order: (rows.length + 1) * 10 }]);
    setAddPicker("");
  };

  const autoDetect = async (idx) => {
    const row = rows[idx];
    if (!row?.table_name) return;
    setAutoBusy(row.table_name); setError("");
    try {
      const res = await fetch(`${apiBase}/api/admin/schema-settings/auto-detect`, {
        method: "POST", headers: authH(),
        body: JSON.stringify({ table_name: row.table_name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Auto-detect failed");
      const data = await res.json();
      // Preserve any user-written notes by appending the freshly-detected
      // columns underneath if the box already has content; otherwise replace.
      const next = row.description.trim()
        ? `${row.description.trim()}\n\n--- Auto-detected ---\n${data.description}`
        : data.description;
      updateRow(idx, { description: next });
    } catch (e) {
      setError(e.message);
    } finally {
      setAutoBusy(null);
    }
  };

  const saveAll = async () => {
    setSaving(true); setError(""); setSuccess("");
    try {
      const payload = rows.map((r, i) => ({
        table_name: r.table_name,
        description: r.description,
        sort_order: r.sort_order || (i + 1) * 10,
      }));
      const res = await fetch(`${apiBase}/api/admin/schema-settings`, {
        method: "PUT", headers: authH(),
        body: JSON.stringify({ settings: payload }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Save failed");
      setSuccess(`Saved ${rows.length} table${rows.length === 1 ? "" : "s"}.`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const resetDefaults = async () => {
    if (!confirm("Reset all schema settings to the TMC defaults? This wipes any custom descriptions you've added.")) return;
    setResetting(true); setError(""); setSuccess("");
    try {
      const res = await fetch(`${apiBase}/api/admin/schema-settings/reset`, {
        method: "POST", headers: authH(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Reset failed");
      reload();
      setSuccess("Schema settings reset to defaults.");
      setTimeout(() => setSuccess(""), 3000);
    } catch (e) { setError(e.message); }
    finally { setResetting(false); }
  };

  const unusedTables = availableTables.filter(t => !rows.some(r => r.table_name === t));

  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 24 }}>
      <div style={{ padding: "16px 22px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
          <FileText size={16} color={COLORS.accent} />
          Schema Settings
        </div>
        <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 3, lineHeight: 1.5 }}>
          Tell Satori what each BigQuery table contains. The text you save here is injected into every AI agent (chat, dashboard builder, report builder) on every call — so describing columns, value types, and join keys makes the AI substantially smarter. Click <strong>Auto-Detect Schema</strong> to pull live column types, then add business context (what each column means, join hints, valid filter values).
        </div>
      </div>

      {error && (
        <div style={{ margin: 14, padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: "#DC2626", fontSize: 13 }}>{error}</div>
      )}
      {success && (
        <div style={{ margin: 14, padding: "10px 14px", background: "#ECFDF5", border: "1px solid #6EE7B7", borderRadius: 10, color: "#065F46", fontSize: 13 }}>✓ {success}</div>
      )}

      <div style={{ padding: 18 }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: COLORS.textSecondary, fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {rows.map((row, idx) => (
              <div key={idx} style={{
                padding: 14, marginBottom: 14, background: COLORS.surfaceAlt,
                border: `1px solid ${COLORS.border}`, borderRadius: 12
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <input
                    type="text"
                    value={row.table_name}
                    onChange={e => updateRow(idx, { table_name: e.target.value })}
                    placeholder="Table_Name"
                    style={{
                      flex: 1, padding: "9px 12px", borderRadius: 8,
                      border: `1px solid ${COLORS.border}`, fontSize: 13, fontWeight: 600,
                      fontFamily: "monospace", background: COLORS.surface,
                    }}
                  />
                  <button
                    onClick={() => autoDetect(idx)}
                    disabled={autoBusy === row.table_name || !row.table_name}
                    style={{
                      padding: "9px 14px", borderRadius: 8, border: "none",
                      background: autoBusy === row.table_name ? "#D1FAE5" : "#ECFDF5",
                      color: "#15803D", fontSize: 12.5, fontWeight: 600,
                      cursor: autoBusy === row.table_name ? "default" : "pointer", whiteSpace: "nowrap",
                    }}
                  >
                    {autoBusy === row.table_name ? "Detecting…" : "Auto-Detect Schema"}
                  </button>
                  <button
                    onClick={() => removeRow(idx)}
                    title="Remove this table"
                    style={{
                      width: 32, height: 32, borderRadius: 8, border: "none",
                      background: "#FEE2E2", color: "#DC2626", cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
                <textarea
                  value={row.description}
                  onChange={e => updateRow(idx, { description: e.target.value })}
                  placeholder="Describe what this table contains, the column types, and any join keys or filter-value caveats the AI should know."
                  rows={5}
                  style={{
                    width: "100%", padding: 12, borderRadius: 8,
                    border: `1px solid ${COLORS.border}`, background: COLORS.surface,
                    fontSize: 12.5, fontFamily: "monospace", lineHeight: 1.55,
                    color: COLORS.textPrimary, resize: "vertical", boxSizing: "border-box",
                  }}
                />
              </div>
            ))}

            {/* Add new table row */}
            <div style={{
              display: "flex", gap: 8, marginTop: 6, padding: 12,
              border: `1px dashed ${COLORS.border}`, borderRadius: 12,
              background: COLORS.surfaceAlt,
            }}>
              <select
                value={addPicker}
                onChange={e => setAddPicker(e.target.value)}
                style={{
                  flex: 1, padding: "8px 10px", borderRadius: 8,
                  border: `1px solid ${COLORS.border}`, fontSize: 13, background: COLORS.surface,
                }}
              >
                <option value="">+ Add another table…</option>
                {unusedTables.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button
                onClick={addRow}
                disabled={!addPicker}
                style={{
                  padding: "8px 14px", borderRadius: 8, border: "none",
                  background: addPicker ? COLORS.accent : "#E2E8F0",
                  color: addPicker ? "#fff" : COLORS.textMuted,
                  fontSize: 12.5, fontWeight: 600, cursor: addPicker ? "pointer" : "default",
                }}
              >Add</button>
            </div>
          </>
        )}
      </div>

      {/* Footer buttons */}
      <div style={{
        padding: "14px 18px", borderTop: `1px solid ${COLORS.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: COLORS.surfaceAlt,
      }}>
        <button
          onClick={resetDefaults}
          disabled={resetting}
          style={{
            padding: "10px 18px", borderRadius: 9, border: "1px solid #FECACA",
            background: "#FEF2F2", color: "#DC2626", fontSize: 13, fontWeight: 600,
            cursor: resetting ? "default" : "pointer",
          }}
        >{resetting ? "Resetting…" : "Reset to Defaults"}</button>
        <button
          onClick={saveAll}
          disabled={saving}
          style={{
            padding: "10px 22px", borderRadius: 9, border: "none",
            background: saving ? "#9DD35A" : COLORS.accent, color: "#fff",
            fontSize: 13, fontWeight: 600, cursor: saving ? "default" : "pointer",
          }}
        >{saving ? "Saving…" : "Save Settings"}</button>
      </div>
    </div>
  );
};


// ─── System Settings Page (admin only) ──────────────────────────────────────
//
// Lets the admin enable / disable additional data-scope dimensions beyond the
// default "plant" (which is always on). Dimensions that are enabled here will
// appear as configurable scope options in the Data Scope modal.
const SystemSettingsPage = () => {
  const apiBase = import.meta.env.VITE_API_BASE || "";
  const authH = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json" });

  const [dimensions, setDimensions] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null); // dimension key being saved
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // ── Bypass OTP ──
  const [bypassOtp, setBypassOtp] = useState("");
  const [bypassOtpDraft, setBypassOtpDraft] = useState("");
  const [bypassOtpVisible, setBypassOtpVisible] = useState(false);
  const [bypassSaving, setBypassSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`${apiBase}/api/admin/scope-dimensions`, { headers: authH() }).then(r => r.json()),
      fetch(`${apiBase}/api/admin/settings`, { headers: authH() }).then(r => r.json()),
    ])
      .then(([dims, cfg]) => {
        setDimensions(dims.dimensions || {});
        const code = (cfg.settings || {}).bypass_otp ?? "";
        setBypassOtp(code);
        setBypassOtpDraft(code);
      })
      .catch(() => setError("Failed to load settings."))
      .finally(() => setLoading(false));
  }, []);

  const toggleDimension = async (dim, currentEnabled) => {
    if (dimensions[dim]?.locked) return; // plant is locked
    setSaving(dim); setError(""); setSuccess("");
    try {
      const res = await fetch(`${apiBase}/api/admin/scope-dimensions`, {
        method: "PUT",
        headers: authH(),
        body: JSON.stringify({ dimension: dim, enabled: !currentEnabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Save failed");
      setDimensions(prev => ({
        ...prev,
        [dim]: { ...prev[dim], enabled: !currentEnabled },
      }));
      setSuccess(`${dimensions[dim]?.label || dim} ${!currentEnabled ? "enabled" : "disabled"}.`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (e) { setError(e.message); } finally { setSaving(null); }
  };

  const saveBypassOtp = async () => {
    setBypassSaving(true); setError(""); setSuccess("");
    try {
      const res = await fetch(`${apiBase}/api/admin/settings`, {
        method: "PUT",
        headers: authH(),
        body: JSON.stringify({ key: "bypass_otp", value: bypassOtpDraft }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Save failed");
      setBypassOtp(bypassOtpDraft);
      setSuccess("Bypass OTP code saved.");
      setTimeout(() => setSuccess(""), 3000);
    } catch (e) { setError(e.message); } finally { setBypassSaving(false); }
  };

  const DIM_DESCRIPTIONS = {
    department: "Restrict users to one or more departments / practices (SAP Finance, Qlik, SAP GRC, etc.). When enabled, set each user's allowed departments from User Management → Data scope. Scoped users only see workforce data (attendance, timesheets, allocations, employees) for their department; sales data stays shared.",
  };

  return (
    <div style={{ padding: 32, maxWidth: 720 }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary }}>System Settings</div>
        <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 4 }}>
          Configure company-wide data governance settings. Changes apply to all users.
        </div>
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: "#DC2626", fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ padding: "10px 14px", background: "#ECFDF5", border: "1px solid #6EE7B7", borderRadius: 10, color: "#065F46", fontSize: 13, marginBottom: 16 }}>
          ✓ {success}
        </div>
      )}

      {/* Data Scope Dimensions card */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 24 }}>
        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
            <Shield size={16} color={COLORS.accent} />
            Data Scope Dimensions
          </div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 3 }}>
            Enable dimensions to restrict individual users' data access. Once enabled, you can set per-user restrictions from User Management → Data scope.
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 32, textAlign: "center", color: COLORS.textSecondary, fontSize: 13 }}>Loading…</div>
        ) : (
          <div>
            {Object.entries(dimensions).map(([dim, info], i) => {
              const isLast = i === Object.entries(dimensions).length - 1;
              return (
                <div
                  key={dim}
                  style={{
                    display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                    padding: "16px 22px",
                    borderBottom: isLast ? "none" : `1px solid ${COLORS.border}`,
                    opacity: saving === dim ? 0.7 : 1,
                  }}
                >
                  <div style={{ flex: 1, marginRight: 24 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{info.label}</span>
                      {info.locked && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: `${COLORS.accent}15`, color: COLORS.accentDark, textTransform: "uppercase", letterSpacing: "0.4px" }}>
                          Always On
                        </span>
                      )}
                      {!info.locked && info.enabled && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#ECFDF5", color: "#065F46", textTransform: "uppercase", letterSpacing: "0.4px" }}>
                          Active
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 3, lineHeight: 1.5 }}>
                      {DIM_DESCRIPTIONS[dim] || `Control access to the ${dim} dimension.`}
                    </div>
                  </div>
                  {/* Toggle */}
                  <div
                    onClick={() => !info.locked && toggleDimension(dim, info.enabled)}
                    style={{
                      width: 44, height: 24, borderRadius: 12, flexShrink: 0, marginTop: 2,
                      background: info.enabled ? COLORS.primary : "#D1D5DB",
                      cursor: info.locked ? "not-allowed" : "pointer",
                      position: "relative", transition: "background 0.2s",
                      opacity: info.locked ? 0.7 : 1,
                    }}
                  >
                    <div style={{
                      position: "absolute", top: 2, left: info.enabled ? 22 : 2, width: 20, height: 20,
                      borderRadius: "50%", background: COLORS.surface, transition: "left 0.2s",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Info card */}
      <div style={{ padding: "14px 18px", background: COLORS.surfaceAlt, borderRadius: 12, border: `1px solid ${COLORS.border}`, fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.6, marginBottom: 24 }}>
        <strong style={{ color: COLORS.textPrimary }}>How data scope works:</strong> By default every user can see all data (no restrictions). When you enable a dimension here, you can then go to User Management → select a user → <em>Data scope</em> to restrict that user to specific values. Admins always see all data regardless of these settings.
      </div>

      {/* Security card */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 24 }}>
        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
            <Lock size={16} color={COLORS.accent} />
            Security
          </div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 3 }}>
            Emergency access and testing overrides.
          </div>
        </div>

        <div style={{ padding: "18px 22px" }}>
          <div style={{ marginBottom: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, display: "block", marginBottom: 4 }}>
              Bypass OTP Code
            </label>
            <div style={{ fontSize: 12, color: COLORS.textSecondary, marginBottom: 10, lineHeight: 1.5 }}>
              A master code that skips 2FA verification for any account — for testing or emergency access.
              Leave blank to disable the bypass entirely.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ position: "relative", flex: 1, maxWidth: 240 }}>
                <input
                  type={bypassOtpVisible ? "text" : "password"}
                  value={bypassOtpDraft}
                  onChange={e => setBypassOtpDraft(e.target.value)}
                  placeholder="Enter bypass code or leave blank to disable"
                  maxLength={20}
                  style={{ ..._inputStyle, paddingRight: 40, fontFamily: bypassOtpVisible ? "monospace" : "inherit", letterSpacing: bypassOtpVisible ? "0.12em" : "normal" }}
                />
                <button
                  onClick={() => setBypassOtpVisible(v => !v)}
                  title={bypassOtpVisible ? "Hide" : "Show"}
                  style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, display: "flex", alignItems: "center" }}
                >
                  {bypassOtpVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button
                onClick={saveBypassOtp}
                disabled={bypassSaving || bypassOtpDraft === bypassOtp}
                style={{
                  padding: "10px 16px", borderRadius: 9, border: "none", fontSize: 13, fontWeight: 600,
                  background: (bypassSaving || bypassOtpDraft === bypassOtp) ? "#E2E8F0" : COLORS.primary,
                  color: (bypassSaving || bypassOtpDraft === bypassOtp) ? COLORS.textMuted : "#fff",
                  cursor: (bypassSaving || bypassOtpDraft === bypassOtp) ? "default" : "pointer",
                  transition: "all 0.15s", whiteSpace: "nowrap",
                }}
              >
                {bypassSaving ? "Saving…" : "Save"}
              </button>
            </div>
            {bypassOtp === "" && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#16A34A", fontWeight: 500 }}>✓ Bypass is currently disabled.</div>
            )}
            {bypassOtp !== "" && (
              <div style={{ marginTop: 8, fontSize: 12, color: COLORS.textMuted }}>
                Bypass is <strong style={{ color: "#D97706" }}>active</strong>. Anyone who knows this code can log in without their Authenticator app.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Schema settings - admin-curated per-table descriptions injected into agent prompts */}
      <SchemaSettingsCard />
    </div>
  );
};

// ─── Usage Analytics (superadmin-only: superadmin, Mahad, Numair) ──────────
// Adoption pulse for the platform owners: who's using Satori, how much, what
// they use, and how the AI answers are being rated. Backed by the audit
// trail; the endpoint is require_superadmin so the data never leaks wider.
const UsageAnalyticsPage = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/admin/usage-analytics?days=30`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) setData(j);
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) return <div style={{ padding: 32, color: "#B91C1C", fontSize: 14 }}>Couldn't load usage analytics: {error}</div>;
  if (!data) return <div style={{ padding: 32, color: COLORS.textMuted, fontSize: 14 }}>Loading usage analytics…</div>;

  const t = data.totals || {};
  const fb = data.feedback || { up: 0, down: 0 };
  const fbTotal = fb.up + fb.down;
  const fbRate = fbTotal ? Math.round((fb.up / fbTotal) * 100) : null;
  const cards = [
    { label: "Active today", value: t.active_today, sub: "distinct users" },
    { label: "Active / 7 days", value: t.active_7d, sub: "weekly actives" },
    { label: `Active / ${data.days} days`, value: t.active_users, sub: "monthly actives" },
    { label: "AI questions", value: t.ai_questions, sub: `last ${data.days} days` },
    { label: "Total events", value: t.events, sub: "all activity" },
    { label: "Answer rating", value: fbRate != null ? `${fbRate}%` : "—", sub: `👍 ${fb.up} · 👎 ${fb.down}`, color: fbRate == null ? undefined : fbRate >= 80 ? "#0E7E3E" : fbRate >= 60 ? "#B45309" : "#B91C1C" },
  ];
  const maxAction = Math.max(1, ...(data.top_actions || []).map(a => a.count));

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: COLORS.textPrimary }}>Usage Analytics</h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: COLORS.textMuted }}>
          Platform adoption over the last {data.days} days · visible to superadmins only
          {data.pulse?.avg != null && <> · pulse score <b>{data.pulse.avg}/5</b> ({data.pulse.count} responses)</>}
          {data.support && <> · support tickets {data.support.open} open / {data.support.total} total</>}
        </p>
      </div>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 14, marginBottom: 20 }}>
        {cards.map((c, i) => (
          <div key={i} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>{c.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: c.color || COLORS.textPrimary, marginTop: 5, fontVariantNumeric: "tabular-nums" }}>{c.value ?? "—"}</div>
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Daily actives + AI questions trend */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <TrendingUp size={16} color={COLORS.accent} /> Daily active users & AI questions
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data.daily || []} margin={{ top: 4, right: 16, bottom: 0, left: -16 }}>
            <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={(d) => String(d).slice(5)} />
            <YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} allowDecimals={false} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="users" name="Active users" stroke={COLORS.accent} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="questions" name="AI questions" stroke="#0A5F89" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Feature usage */}
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <BarChart3 size={16} color={COLORS.accent} /> Most-used actions
          </div>
          {(data.top_actions || []).map((a) => (
            <div key={a.action} style={{ display: "grid", gridTemplateColumns: "180px 1fr 56px", gap: 10, alignItems: "center", padding: "6px 0" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.action}>{a.action}</div>
              <div style={{ height: 8, background: COLORS.surfaceAlt, borderRadius: 999, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round((a.count / maxAction) * 100)}%`, background: COLORS.accent }} />
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.textSecondary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.count.toLocaleString()}</div>
            </div>
          ))}
        </div>

        {/* Top users */}
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <Users size={16} color={COLORS.accent} /> Most active users
          </div>
          {(data.top_users || []).map((u, i) => (
            <div key={u.email} style={{ display: "grid", gridTemplateColumns: "20px 1fr 70px 130px", gap: 10, alignItems: "center", padding: "7px 0", borderTop: i === 0 ? "none" : `1px solid ${COLORS.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.textMuted }}>{i + 1}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.textSecondary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{u.events.toLocaleString()}</span>
              <span style={{ fontSize: 11, color: COLORS.textMuted, textAlign: "right" }}>{String(u.last_seen).slice(0, 16)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const NAV_ITEMS = [
  { id: "_divider_workspace", label: "WORKSPACE", isDivider: true },
  { id: "agent", label: "Ask Me Anything", icon: Bot, component: AgentPage, requiresFeature: "agent" },
  { id: "reports", label: "Report Builder", icon: FileText, component: ReportsPage, requiresFeature: "reportbuilder" },
  { id: "dashboards", label: "Dashboard Builder", icon: LayoutDashboard, component: DashboardsPage, requiresFeature: "dashboards" },
  { id: "_divider_intelligence", label: "INTELLIGENCE", isDivider: true },
  { id: "availability", label: "Availability Engine", icon: Activity, component: AvailabilityEnginePage, requiresFeature: "availability" },
  { id: "_divider_admin", label: "ADMIN", isDivider: true, superAdminOnly: true },
  { id: "users", label: "User Management", icon: Users, component: UserManagementPage, superAdminOnly: true },
  { id: "audit", label: "Audit Log", icon: Shield, component: AuditLogPage, superAdminOnly: true },
  { id: "usage", label: "Usage Analytics", icon: BarChart3, component: UsageAnalyticsPage, superAdminOnly: true },
  { id: "support", label: "Support Tickets", icon: MessageSquare, component: SupportTicketsPage, superAdminOnly: true },
  { id: "settings", label: "System Settings", icon: Settings, component: SystemSettingsPage, superAdminOnly: true },
];

// ─── Global fetch interceptor — fires "auth:session-expired" on any 401 ───
// Installed once at module load. The App component listens for this event
// and clears the session, sending the user back to the login page.
// Guard: only fires when there IS a token in localStorage (so wrong-password
// 401s on the login form — which have no Authorization header — are ignored).
(function _installFetchInterceptor() {
  const _orig = window.fetch.bind(window);
  window.fetch = async function (url, options) {
    const response = await _orig(url, options);
    if (response.status === 401 && localStorage.getItem("token")) {
      const hdrs = options?.headers || {};
      const authValue =
        typeof hdrs.get === "function"
          ? hdrs.get("Authorization") || hdrs.get("authorization")
          : hdrs.Authorization || hdrs.authorization || "";
      if (authValue) {
        window.dispatchEvent(new CustomEvent("auth:session-expired"));
      }
    }
    return response;
  };
})();

// ─── Login Page ───
const API_BASE = import.meta.env.VITE_API_BASE || "";

const LoginPage = ({ onLogin, expiredMsg }) => {
  // ── Stage machine ─────────────────────────────────────────────────────
  // "credentials"   email + password (default)
  // "setup-scan"    QR + 6-digit confirm (first-time enrollment)
  // "setup-codes"   show backup codes once after enrollment succeeds
  // "challenge"     6-digit OR backup-code prompt on subsequent logins
  const [stage, setStage] = useState("credentials");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // 2FA flow state
  const [setupToken, setSetupToken] = useState("");
  const [setupSecret, setSetupSecret] = useState("");
  const [setupQr, setSetupQr] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(true);
  const [pendingUserEmail, setPendingUserEmail] = useState("");
  const [backupCodes, setBackupCodes] = useState([]);
  const [pendingSession, setPendingSession] = useState(null);

  const resetTo = (next) => { setError(""); setCode(""); setUseBackupCode(false); setStage(next); };

  // ── Forgot-password (self-service reset) ──
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const submitForgot = async (e) => {
    e.preventDefault();
    setForgotBusy(true); setError("");
    try {
      await fetch(`${API_BASE}/api/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      // Always show the same confirmation regardless of whether the email exists.
      setForgotSent(true);
    } catch {
      setForgotSent(true);
    } finally {
      setForgotBusy(false);
    }
  };

  // ── Stage 1: credentials → /api/login (returns ok | setup | challenge) ──
  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        credentials: "include", // for the trust-device cookie (same-origin / cookie-friendly browsers)
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email, password,
          // Fallback for browsers that block cross-origin HttpOnly cookies.
          // If the cookie can't cross origins (e.g. different *.run.app on Chrome),
          // the backend will accept this body field instead.
          trust_token: localStorage.getItem("satori_trust_token") || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Login failed");
        setIsLoading(false);
        return;
      }
      // Path A — fully authenticated (no 2FA needed OR trusted device matched).
      if (data.stage === "ok") {
        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));
        if (data.permissions) localStorage.setItem("permissions", JSON.stringify(data.permissions));
        // Refresh the trust_token if backend returned an updated one (sliding expiry)
        if (data.trust_token) localStorage.setItem("satori_trust_token", data.trust_token);
        onLogin(data.user, data.permissions);
        return;
      }
      setPendingUserEmail(data.user?.email || "");
      // Path B — first-time enrollment. Kick off setup-start to fetch QR.
      if (data.stage === "setup") {
        setSetupToken(data.setup_token);
        const r2 = await fetch(`${API_BASE}/api/2fa/setup-start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setup_token: data.setup_token }),
        });
        const d2 = await r2.json();
        if (!r2.ok) { setError(d2.detail || "Couldn't start enrollment"); setIsLoading(false); return; }
        setSetupSecret(d2.secret);
        setSetupQr(d2.qr_data_url);
        resetTo("setup-scan");
      }
      // Path C — already enrolled, needs a 6-digit code.
      else if (data.stage === "challenge") {
        setChallengeToken(data.challenge_token);
        resetTo("challenge");
      }
      setIsLoading(false);
    } catch (err) {
      setError("Cannot connect to server");
      setIsLoading(false);
    }
  };

  // ── Stage 2: enrollment confirm ───────────────────────────────────────
  const handleSetupConfirm = async (e) => {
    e?.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/2fa/setup-confirm`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup_token: setupToken, code, trust_device: trustDevice }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Verification failed");
        setIsLoading(false);
        setCode("");
        return;
      }
      // Stash the session — user must acknowledge backup codes before
      // we mark them logged in.
      setBackupCodes(data.backup_codes || []);
      setPendingSession({ token: data.token, user: data.user, permissions: data.permissions });
      resetTo("setup-codes");
      setIsLoading(false);
    } catch (err) {
      setError("Cannot connect to server");
      setIsLoading(false);
    }
  };

  // ── Stage 3: challenge ────────────────────────────────────────────────
  const handleChallenge = async (e) => {
    e?.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/2fa/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_token: challengeToken, code, trust_device: trustDevice }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Verification failed");
        setIsLoading(false);
        setCode("");
        return;
      }
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
      if (data.permissions) localStorage.setItem("permissions", JSON.stringify(data.permissions));
      // Store trust_token in localStorage as fallback for browsers that block
      // cross-origin HttpOnly cookies (different *.run.app subdomains on Chrome).
      if (data.trust_token) localStorage.setItem("satori_trust_token", data.trust_token);
      onLogin(data.user, data.permissions);
    } catch (err) {
      setError("Cannot connect to server");
      setIsLoading(false);
    }
  };

  // After enrollment, only enter the app once the user clicks "I've saved them".
  const handleEnterApp = () => {
    if (!pendingSession) return;
    localStorage.setItem("token", pendingSession.token);
    localStorage.setItem("user", JSON.stringify(pendingSession.user));
    if (pendingSession.permissions) localStorage.setItem("permissions", JSON.stringify(pendingSession.permissions));
    if (pendingSession.trust_token) localStorage.setItem("satori_trust_token", pendingSession.trust_token);
    onLogin(pendingSession.user, pendingSession.permissions);
  };

  const downloadBackupCodes = () => {
    const body = [
      `Satori — Two-Factor Backup Codes`,
      `Account: ${pendingUserEmail}`,
      `Generated: ${new Date().toLocaleString()}`,
      ``,
      `Each code works ONCE. Use one if you lose access to your Authenticator app.`,
      `Keep this file in your password manager or somewhere safe.`,
      ``,
      ...backupCodes,
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `satori-backup-codes.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Code field is reused for TOTP (6 digits) and backup codes (8 chars + dash).
  // Sanitize input to keep it tidy.
  const sanitizeTotp = (s) => (s || "").replace(/\D+/g, "").slice(0, 6);
  const sanitizeBackup = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9);

  return (
    <div style={{
      minHeight: "100vh", display: "flex", background: COLORS.surfaceAlt,
      fontFamily: "'Red Hat Display', 'Poppins', -apple-system, BlinkMacSystemFont, sans-serif"
    }}>
      {/* Left Panel — TMC Branding */}
      <div style={{
        flex: 1, background: `linear-gradient(135deg, ${COLORS.primaryDark} 0%, ${COLORS.primary} 50%, #444 100%)`,
        display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
        padding: 60, position: "relative", overflow: "hidden"
      }}>
        {/* Background Pattern — TMC tally mark inspired diagonal lines */}
        <div style={{ position: "absolute", inset: 0, opacity: 0.06 }}>
          {Array.from({ length: 20 }, (_, i) => (
            <div key={i} style={{
              position: "absolute", width: 2, height: 200,
              background: "#8AC441", transform: "rotate(15deg)",
              top: `${-10 + (i % 5) * 25}%`, left: `${i * 5.5}%`,
            }} />
          ))}
          {Array.from({ length: 15 }, (_, i) => (
            <div key={`d${i}`} style={{
              position: "absolute", width: 2, height: 160,
              background: COLORS.surface, transform: "rotate(-15deg)",
              top: `${20 + (i % 4) * 20}%`, left: `${i * 7}%`,
            }} />
          ))}
        </div>

        <div style={{ position: "relative", zIndex: 1, textAlign: "center", maxWidth: 480 }}>
          {/* Satori Brand */}
          <div style={{ marginBottom: 36 }}>
            <div style={{ fontSize: 48, fontWeight: 800, color: "#fff", letterSpacing: "-1px", lineHeight: 1.2, fontFamily: "'Red Hat Display', sans-serif", textTransform: "lowercase" }}>satori</div>
            <div style={{ width: 32, height: 3, background: COLORS.accent, margin: "12px auto 0", borderRadius: 2 }} />
          </div>

          <div style={{ fontSize: 20, fontWeight: 300, color: "rgba(255,255,255,0.85)", lineHeight: 1.6, marginBottom: 36, fontFamily: "'Red Hat Display', sans-serif" }}>
            Transform your enterprise data into <br />
            <span style={{ fontWeight: 700, color: COLORS.accent }}>actionable intelligence</span>
          </div>

          <div style={{ display: "flex", gap: 28, justifyContent: "center" }}>
            {[
              { icon: Zap, label: "Insights" },
              { icon: Mic, label: "Agents" },
              { icon: Brain, label: "AI Engine" },
            ].map((item, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 50, height: 50, borderRadius: 12,
                  background: "rgba(138,196,65,0.12)", border: "1px solid rgba(138,196,65,0.25)",
                  display: "flex", alignItems: "center", justifyContent: "center"
                }}>
                  <item.icon size={22} color={COLORS.accent} />
                </div>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontWeight: 500 }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ position: "absolute", top: 24, right: 28 }}>
          <img src="/tmc-monogram.png" alt="TMC" style={{ height: 29, width: "auto" }} />
        </div>
      </div>

      {/* Right Panel — stage-dependent content */}
      <div style={{ width: 520, display: "flex", flexDirection: "column", justifyContent: "center", padding: "60px 80px", overflowY: "auto" }}>

        {/* ── Stage 1: credentials ─────────────────────────────────────── */}
        {stage === "credentials" && (
          <>
            {/* Session-expired banner — shown when redirected after token expiry */}
            {expiredMsg && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "11px 14px", marginBottom: 20,
                background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 10,
                fontSize: 13, fontWeight: 500, color: "#92400E",
              }}>
                <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                {expiredMsg}
              </div>
            )}
            <div style={{ marginBottom: 40 }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>Welcome back</div>
              <div style={{ fontSize: 15, color: COLORS.textSecondary }}>Your enterprise intelligence awaits</div>
            </div>
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>Email address</label>
                <div style={{ position: "relative" }}>
                  <Mail size={18} color={COLORS.textMuted} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }} />
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="name@company.com" autoComplete="email" autoFocus
                    style={{
                      width: "100%", padding: "12px 14px 12px 44px", border: `1px solid ${COLORS.border}`,
                      borderRadius: 12, fontSize: 14, outline: "none", background: COLORS.surfaceAlt,
                      transition: "all 0.2s", boxSizing: "border-box"
                    }}
                    onFocus={e => { e.target.style.borderColor = COLORS.primary; e.target.style.background = COLORS.surface; }}
                    onBlur={e => { e.target.style.borderColor = "#E2E8F0"; e.target.style.background = COLORS.surfaceAlt; }}
                  />
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>Password</label>
                <div style={{ position: "relative" }}>
                  <Lock size={18} color={COLORS.textMuted} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }} />
                  <input
                    type="password" value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="Enter your password" autoComplete="current-password"
                    style={{
                      width: "100%", padding: "12px 14px 12px 44px", border: `1px solid ${COLORS.border}`,
                      borderRadius: 12, fontSize: 14, outline: "none", background: COLORS.surfaceAlt,
                      transition: "all 0.2s", boxSizing: "border-box"
                    }}
                    onFocus={e => { e.target.style.borderColor = COLORS.primary; e.target.style.background = COLORS.surface; }}
                    onBlur={e => { e.target.style.borderColor = "#E2E8F0"; e.target.style.background = COLORS.surfaceAlt; }}
                  />
                </div>
              </div>
              {error && (
                <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: "#DC2626", fontSize: 13, fontWeight: 500 }}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={isLoading} style={{
                width: "100%", padding: "14px", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600,
                background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`,
                color: "#fff", cursor: "pointer", transition: "all 0.2s",
                fontFamily: "'Poppins', 'Red Hat Display', sans-serif",
                opacity: isLoading ? 0.7 : 1, marginTop: 8,
                boxShadow: "0 4px 12px rgba(51,51,51,0.3)"
              }}>
                {isLoading ? (
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <span style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
                    Signing in...
                  </span>
                ) : "Sign in"}
              </button>
              <div style={{ textAlign: "center", marginTop: 2 }}>
                <button
                  type="button"
                  onClick={() => { setForgotEmail(email); setForgotSent(false); resetTo("forgot"); }}
                  style={{ background: "none", border: "none", color: COLORS.accentDark, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 4 }}
                >
                  Forgot password?
                </button>
              </div>
            </form>
          </>
        )}

        {/* ── Forgot password: request a reset link by email ───────────── */}
        {stage === "forgot" && (
          <>
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>Reset your password</div>
              <div style={{ fontSize: 14, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                Enter your work email and we'll send you a link to set a new password.
              </div>
            </div>
            {forgotSent ? (
              <>
                <div style={{ padding: "12px 14px", background: "#ECFDF5", border: "1px solid #6EE7B7", borderRadius: 10, color: "#065F46", fontSize: 13.5, lineHeight: 1.5 }}>
                  If <strong>{forgotEmail}</strong> is registered, a password-reset link is on its way. The link expires in 30 minutes — check your inbox (and spam).
                </div>
                <button type="button" onClick={() => resetTo("credentials")} style={{ marginTop: 18, width: "100%", padding: "12px", border: `1px solid ${COLORS.border}`, borderRadius: 12, fontSize: 14, fontWeight: 600, background: COLORS.surface, color: COLORS.textPrimary, cursor: "pointer" }}>
                  Back to sign in
                </button>
              </>
            ) : (
              <form onSubmit={submitForgot} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <div>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>Email address</label>
                  <div style={{ position: "relative" }}>
                    <Mail size={18} color={COLORS.textMuted} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }} />
                    <input
                      type="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)}
                      placeholder="name@tmcltd.com" autoComplete="email" autoFocus required
                      style={{ width: "100%", padding: "12px 14px 12px 44px", border: `1px solid ${COLORS.border}`, borderRadius: 12, fontSize: 14, outline: "none", background: COLORS.surfaceAlt, boxSizing: "border-box" }}
                    />
                  </div>
                </div>
                <button type="submit" disabled={forgotBusy} style={{
                  width: "100%", padding: "14px", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600,
                  background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`, color: "#fff",
                  cursor: forgotBusy ? "default" : "pointer", opacity: forgotBusy ? 0.7 : 1,
                }}>
                  {forgotBusy ? "Sending…" : "Send reset link"}
                </button>
                <button type="button" onClick={() => resetTo("credentials")} style={{ background: "none", border: "none", color: COLORS.textSecondary, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Back to sign in
                </button>
              </form>
            )}
          </>
        )}

        {/* ── Stage 2: enrollment (scan QR + first code) ───────────────── */}
        {stage === "setup-scan" && (
          <>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.accent, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 8 }}>Set up two-factor authentication</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>Scan with your Authenticator app</div>
              <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                Open Google Authenticator, Microsoft Authenticator, Authy, or any TOTP app and scan this QR. Then enter the 6-digit code shown in the app to finish setup.
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, alignItems: "flex-start", marginBottom: 20 }}>
              {setupQr ? (
                <img src={setupQr} alt="2FA QR code" style={{ width: 168, height: 168, borderRadius: 12, border: `1px solid ${COLORS.border}`, padding: 8, background: COLORS.surface, flexShrink: 0 }} />
              ) : (
                <div style={{ width: 168, height: 168, borderRadius: 12, border: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Activity size={24} style={{ animation: "spin 1s linear infinite" }} />
                </div>
              )}
              <div style={{ flex: 1, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>Can't scan?</div>
                Enter this key manually in your app:
                <div style={{
                  marginTop: 8, padding: "8px 10px", background: COLORS.surfaceAlt,
                  borderRadius: 8, border: `1px solid ${COLORS.border}`,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: 12, color: COLORS.textPrimary, wordBreak: "break-all", letterSpacing: 0.5
                }}>{setupSecret}</div>
              </div>
            </div>
            <form onSubmit={handleSetupConfirm} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>Enter the 6-digit code from your app</label>
                <input
                  type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
                  value={code} onChange={(e) => setCode(sanitizeTotp(e.target.value))}
                  placeholder="123456" maxLength={6}
                  style={{
                    width: "100%", padding: "14px 16px", border: `1px solid ${COLORS.border}`,
                    borderRadius: 12, fontSize: 22, outline: "none", background: COLORS.surfaceAlt,
                    boxSizing: "border-box", letterSpacing: 8, textAlign: "center",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  }}
                  onFocus={e => { e.target.style.borderColor = COLORS.primary; e.target.style.background = COLORS.surface; }}
                  onBlur={e => { e.target.style.borderColor = "#E2E8F0"; e.target.style.background = COLORS.surfaceAlt; }}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: COLORS.textSecondary, cursor: "pointer" }}>
                <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} style={{ accentColor: COLORS.primary }} />
                Trust this device for 30 days
              </label>
              {error && (
                <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: "#DC2626", fontSize: 13, fontWeight: 500 }}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={isLoading || code.length !== 6} style={{
                width: "100%", padding: "14px", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600,
                background: code.length === 6 ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})` : "#E2E8F0",
                color: "#fff", cursor: code.length === 6 && !isLoading ? "pointer" : "default",
                opacity: isLoading ? 0.7 : 1, boxShadow: code.length === 6 ? "0 4px 12px rgba(51,51,51,0.3)" : "none"
              }}>
                {isLoading ? "Verifying…" : "Confirm and continue"}
              </button>
              <button type="button" onClick={() => resetTo("credentials")} style={{
                background: "none", border: "none", color: COLORS.textSecondary, fontSize: 12, cursor: "pointer", padding: 6
              }}>← Back to login</button>
            </form>
          </>
        )}

        {/* ── Stage 3: backup codes (one-time display) ─────────────────── */}
        {stage === "setup-codes" && (
          <>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.accent, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 8 }}>Save your recovery codes</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>You won't see these again</div>
              <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                If you lose your phone, you can use any of these codes <strong>once</strong> in place of a 6-digit code. Save them in a password manager, screenshot them, or download the file.
              </div>
            </div>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16,
              padding: 14, background: COLORS.surfaceAlt, borderRadius: 12, border: `1px solid ${COLORS.border}`,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 14, color: COLORS.textPrimary
            }}>
              {backupCodes.map((c, i) => (
                <div key={i} style={{ padding: "6px 8px", background: COLORS.surface, borderRadius: 6, textAlign: "center", letterSpacing: 1 }}>
                  {c}
                </div>
              ))}
            </div>
            <button onClick={downloadBackupCodes} style={{
              padding: "10px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 10,
              background: COLORS.surface, cursor: "pointer", color: COLORS.textPrimary, fontSize: 13, fontWeight: 600,
              display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 16
            }}>
              <Download size={14} /> Download as .txt
            </button>
            <button onClick={handleEnterApp} style={{
              width: "100%", padding: "14px", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600,
              background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`,
              color: "#fff", cursor: "pointer",
              boxShadow: "0 4px 12px rgba(51,51,51,0.3)"
            }}>
              I've saved them — continue
            </button>
          </>
        )}

        {/* ── Stage 4: challenge (subsequent logins) ───────────────────── */}
        {stage === "challenge" && (
          <>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.accent, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 8 }}>Two-factor verification</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>Enter your code</div>
              <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                {useBackupCode
                  ? <>Type one of your <strong>backup codes</strong> (format: XXXX-XXXX). Each one works only once.</>
                  : <>Open your Authenticator app and enter the 6-digit code for <strong>{pendingUserEmail || "Satori"}</strong>.</>}
              </div>
            </div>
            <form onSubmit={handleChallenge} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <input
                type="text"
                inputMode={useBackupCode ? "text" : "numeric"}
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(useBackupCode ? sanitizeBackup(e.target.value) : sanitizeTotp(e.target.value))}
                placeholder={useBackupCode ? "XXXX-XXXX" : "123456"}
                maxLength={useBackupCode ? 9 : 6}
                style={{
                  width: "100%", padding: "16px 16px", border: `1px solid ${COLORS.border}`,
                  borderRadius: 12, fontSize: 22, outline: "none", background: COLORS.surfaceAlt,
                  boxSizing: "border-box", letterSpacing: useBackupCode ? 4 : 8, textAlign: "center",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  textTransform: useBackupCode ? "uppercase" : "none",
                }}
                onFocus={e => { e.target.style.borderColor = COLORS.primary; e.target.style.background = COLORS.surface; }}
                onBlur={e => { e.target.style.borderColor = "#E2E8F0"; e.target.style.background = COLORS.surfaceAlt; }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: COLORS.textSecondary, cursor: "pointer" }}>
                <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} style={{ accentColor: COLORS.primary }} />
                Trust this device for 30 days
              </label>
              {error && (
                <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: "#DC2626", fontSize: 13, fontWeight: 500 }}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={isLoading || (useBackupCode ? code.length < 9 : code.length !== 6)} style={{
                width: "100%", padding: "14px", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600,
                background: (useBackupCode ? code.length >= 9 : code.length === 6) ? `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})` : "#E2E8F0",
                color: "#fff",
                cursor: (useBackupCode ? code.length >= 9 : code.length === 6) && !isLoading ? "pointer" : "default",
                opacity: isLoading ? 0.7 : 1, boxShadow: (useBackupCode ? code.length >= 9 : code.length === 6) ? "0 4px 12px rgba(51,51,51,0.3)" : "none"
              }}>
                {isLoading ? "Verifying…" : "Verify and sign in"}
              </button>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <button type="button" onClick={() => { setUseBackupCode((v) => !v); setCode(""); setError(""); }} style={{
                  background: "none", border: "none", color: COLORS.accent, fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 6
                }}>
                  {useBackupCode ? "Use a 6-digit code instead" : "Use a backup code instead"}
                </button>
                <button type="button" onClick={() => resetTo("credentials")} style={{
                  background: "none", border: "none", color: COLORS.textSecondary, fontSize: 12, cursor: "pointer", padding: 6
                }}>← Back to login</button>
              </div>
            </form>
          </>
        )}

      </div>

      {/* Global Animation Styles */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes satori-intro-pulse {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.025); }
        }
        @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); } 50% { box-shadow: 0 0 0 12px rgba(239,68,68,0); } }
        @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
        @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.5); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #94A3B8; }

        /* ─── Theme tokens ─── Light is default. Dark overrides the same
           variables under html[data-satori-theme="dark"]. JSX inline styles
           that read COLORS.surface etc. resolve to var(--c-…) so they pick
           up the active theme automatically. */
        :root, html[data-satori-theme="light"] {
          --c-primary:         #333333;
          --c-primary-light:   #676767;
          --c-primary-dark:    #1a1a1a;
          --c-surface:         #FFFFFF;
          --c-surface-alt:     #F8FAF5;
          --c-border:          #E6E7E8;
          --c-text-primary:    #333333;
          --c-text-secondary:  #676767;
          --c-text-muted:      #B3B2B3;
          --c-page-bg:         #F7F9FA;
          --c-input-bg:        #FFFFFF;
        }
        html[data-satori-theme="dark"] {
          --c-primary:         #F1F5F9;
          --c-primary-light:   #CBD5E1;
          --c-primary-dark:    #FFFFFF;
          --c-surface:         #1E293B;
          --c-surface-alt:     #0F172A;
          --c-border:          #334155;
          --c-text-primary:    #F1F5F9;
          --c-text-secondary:  #CBD5E1;
          --c-text-muted:      #94A3B8;
          --c-page-bg:         #0B1220;
          --c-input-bg:        #1E293B;
        }
        html[data-satori-theme="dark"] body { background: var(--c-page-bg); color: var(--c-text-primary); }

        /* Override hardcoded hex backgrounds via attribute selector. Inline
           styles use rgb(...) serialization on most browsers, so we target
           both spellings. Selectors are intentionally specific. */
        html[data-satori-theme="dark"] [style*="background: rgb(255, 255, 255)"],
        html[data-satori-theme="dark"] [style*="background:#fff"],
        html[data-satori-theme="dark"] [style*='background: #fff'],
        html[data-satori-theme="dark"] [style*='background: COLORS.surface'] {
          background: var(--c-surface) !important;
        }
        html[data-satori-theme="dark"] [style*="background: rgb(248, 250, 252)"],
        html[data-satori-theme="dark"] [style*="background:#F8FAFC"],
        html[data-satori-theme="dark"] [style*="background:#f8fafc"] {
          background: var(--c-surface-alt) !important;
        }
        html[data-satori-theme="dark"] [style*="background: rgb(250, 251, 252)"],
        html[data-satori-theme="dark"] [style*="background:#FAFBFC"] {
          background: var(--c-surface-alt) !important;
        }
        html[data-satori-theme="dark"] [style*="background: rgb(241, 245, 249)"],
        html[data-satori-theme="dark"] [style*="background:#F1F5F9"] {
          background: var(--c-surface-alt) !important;
        }
        html[data-satori-theme="dark"] [style*="border: 1px solid rgb(241, 245, 249)"],
        html[data-satori-theme="dark"] [style*="border-bottom: 1px solid rgb(241, 245, 249)"],
        html[data-satori-theme="dark"] [style*="borderBottom"][style*="rgb(241, 245, 249)"] {
          border-color: var(--c-border) !important;
        }
        html[data-satori-theme="dark"] [style*="color: rgb(17, 24, 39)"],
        html[data-satori-theme="dark"] [style*="color: rgb(31, 41, 55)"],
        html[data-satori-theme="dark"] [style*="color: rgb(15, 23, 42)"] {
          color: var(--c-text-primary) !important;
        }
        html[data-satori-theme="dark"] [style*="color: rgb(100, 116, 139)"],
        html[data-satori-theme="dark"] [style*="color: rgb(71, 85, 105)"] {
          color: var(--c-text-secondary) !important;
        }
        html[data-satori-theme="dark"] [style*="color: rgb(148, 163, 184)"],
        html[data-satori-theme="dark"] [style*="color: rgb(156, 163, 175)"] {
          color: var(--c-text-muted) !important;
        }

        /* Hex-form text-color overrides — Chrome sometimes preserves the
           original hex string in inline-style, so attribute selectors keyed
           on rgb() won't match. Match the hex form too. */
        html[data-satori-theme="dark"] [style*="color: #0F172A"],
        html[data-satori-theme="dark"] [style*="color: #0f172a"],
        html[data-satori-theme="dark"] [style*="color: #111827"],
        html[data-satori-theme="dark"] [style*="color:#0F172A"],
        html[data-satori-theme="dark"] [style*="color: #1F2937"],
        html[data-satori-theme="dark"] [style*="color: #1F1F1F"],
        html[data-satori-theme="dark"] [style*="color: #1E293B"],
        html[data-satori-theme="dark"] [style*="color: #1e293b"],
        html[data-satori-theme="dark"] [style*="color: #0B1220"] {
          color: var(--c-text-primary) !important;
        }
        html[data-satori-theme="dark"] [style*="color: #475569"],
        html[data-satori-theme="dark"] [style*="color: #4B5563"],
        html[data-satori-theme="dark"] [style*="color: #374151"],
        html[data-satori-theme="dark"] [style*="color: #334155"] {
          color: var(--c-text-secondary) !important;
        }
        html[data-satori-theme="dark"] [style*="color: #64748B"],
        html[data-satori-theme="dark"] [style*="color: #6B7280"],
        html[data-satori-theme="dark"] [style*="color: #94A3B8"],
        html[data-satori-theme="dark"] [style*="color: #94a3b8"],
        html[data-satori-theme="dark"] [style*="color: #9CA3AF"] {
          color: var(--c-text-muted) !important;
        }

        /* Catch borders specified with darker hex literals */
        html[data-satori-theme="dark"] [style*="border: 1px solid #E2E8F0"],
        html[data-satori-theme="dark"] [style*="border: 1px solid #e2e8f0"],
        html[data-satori-theme="dark"] [style*="border: 1px solid #E5E7EB"],
        html[data-satori-theme="dark"] [style*="border: 1px solid #CBD5E1"],
        html[data-satori-theme="dark"] [style*="1px solid #F1F5F9"] {
          border-color: var(--c-border) !important;
        }

        /* Light-grey card surfaces commonly used inside other panels */
        html[data-satori-theme="dark"] [style*="background: #F8FAFC"],
        html[data-satori-theme="dark"] [style*="background:#F8FAFC"],
        html[data-satori-theme="dark"] [style*="background: rgb(248, 250, 252)"],
        html[data-satori-theme="dark"] [style*="background: #F1F5F9"],
        html[data-satori-theme="dark"] [style*="background:#F1F5F9"],
        html[data-satori-theme="dark"] [style*="background: rgb(241, 245, 249)"],
        html[data-satori-theme="dark"] [style*="background: #FAFBFC"],
        html[data-satori-theme="dark"] [style*="background:#FAFBFC"],
        html[data-satori-theme="dark"] [style*="background: rgb(250, 251, 252)"] {
          background: var(--c-surface-alt) !important;
        }
        /* Pure-white card surfaces */
        html[data-satori-theme="dark"] [style*="background: #FFFFFF"],
        html[data-satori-theme="dark"] [style*="background:#FFFFFF"],
        html[data-satori-theme="dark"] [style*="background: #fff"],
        html[data-satori-theme="dark"] [style*="background:#fff"],
        html[data-satori-theme="dark"] [style*="background: rgb(255, 255, 255)"] {
          background: var(--c-surface) !important;
        }

        /* Pale status/info tints (green/amber/red/blue/purple) glow white on a
           dark page. Re-tint them to subtle dark-appropriate fills so colored
           cards (success/warning/error/info banners, KPI chips) look right. */
        html[data-satori-theme="dark"] [style*="#ECFDF5"],
        html[data-satori-theme="dark"] [style*="#F0FDF4"],
        html[data-satori-theme="dark"] [style*="#D1FAE5"],
        html[data-satori-theme="dark"] [style*="rgb(236, 253, 245)"],
        html[data-satori-theme="dark"] [style*="rgb(240, 253, 244)"],
        html[data-satori-theme="dark"] [style*="rgb(220, 252, 231)"] {
          background-color: rgba(34, 197, 94, 0.13) !important;
        }
        html[data-satori-theme="dark"] [style*="#FEF2F2"],
        html[data-satori-theme="dark"] [style*="#FEE2E2"],
        html[data-satori-theme="dark"] [style*="rgb(254, 242, 242)"],
        html[data-satori-theme="dark"] [style*="rgb(254, 226, 226)"] {
          background-color: rgba(239, 68, 68, 0.13) !important;
        }
        html[data-satori-theme="dark"] [style*="#FEF9E7"],
        html[data-satori-theme="dark"] [style*="#FEF3C7"],
        html[data-satori-theme="dark"] [style*="#FFFBEB"],
        html[data-satori-theme="dark"] [style*="rgb(254, 243, 199)"],
        html[data-satori-theme="dark"] [style*="rgb(255, 251, 235)"] {
          background-color: rgba(245, 158, 11, 0.14) !important;
        }
        html[data-satori-theme="dark"] [style*="#EFF6FF"],
        html[data-satori-theme="dark"] [style*="#DBEAFE"],
        html[data-satori-theme="dark"] [style*="rgb(239, 246, 255)"],
        html[data-satori-theme="dark"] [style*="rgb(219, 234, 254)"] {
          background-color: rgba(10, 95, 137, 0.18) !important;
        }
        html[data-satori-theme="dark"] [style*="#F5F3FF"],
        html[data-satori-theme="dark"] [style*="#EDE9FE"],
        html[data-satori-theme="dark"] [style*="rgb(245, 243, 255)"] {
          background-color: rgba(53, 48, 133, 0.22) !important;
        }

        /* The chat / dashboard / report page wrapper often sets background
           on the outer div via Tailwind-like literals; force the page bg in
           dark mode so the white sliver behind cards isn't blinding. */
        html[data-satori-theme="dark"] body,
        html[data-satori-theme="dark"] #root {
          background: var(--c-page-bg) !important;
        }

        /* Default text color for any element that didn't set its own — keeps
           anything we haven't migrated yet readable. */
        html[data-satori-theme="dark"] {
          color-scheme: dark;
        }

        /* Scrollbar tint per theme */
        html[data-satori-theme="dark"] ::-webkit-scrollbar-thumb { background: #4B5563; }
        html[data-satori-theme="dark"] ::-webkit-scrollbar-thumb:hover { background: #6B7280; }

        /* Native form controls — inputs/selects/textareas with no inline bg
           need to flip too. */
        html[data-satori-theme="dark"] input[type="text"],
        html[data-satori-theme="dark"] input[type="search"],
        html[data-satori-theme="dark"] input[type="number"],
        html[data-satori-theme="dark"] input[type="email"],
        html[data-satori-theme="dark"] input[type="password"],
        html[data-satori-theme="dark"] textarea,
        html[data-satori-theme="dark"] select {
          background-color: var(--c-input-bg) !important;
          color: var(--c-text-primary) !important;
          border-color: var(--c-border) !important;
        }
        html[data-satori-theme="dark"] input::placeholder,
        html[data-satori-theme="dark"] textarea::placeholder {
          color: var(--c-text-muted) !important;
          opacity: 0.7;
        }

        /* ─── Recharts dark-mode polish ──────────────────────────────────
           Default recharts tooltips have a white background that glows on
           a dark page, and the cartesian grid uses #F1F5F9 which is barely
           visible. Override both. */
        html[data-satori-theme="dark"] .recharts-default-tooltip {
          background: var(--c-surface) !important;
          border: 1px solid var(--c-border) !important;
          color: var(--c-text-primary) !important;
          border-radius: 12px !important;
        }
        html[data-satori-theme="dark"] .recharts-tooltip-wrapper * {
          color: var(--c-text-primary) !important;
        }
        html[data-satori-theme="dark"] .recharts-cartesian-grid line,
        html[data-satori-theme="dark"] .recharts-cartesian-grid-horizontal line,
        html[data-satori-theme="dark"] .recharts-cartesian-grid-vertical line {
          stroke: var(--c-border) !important;
          stroke-opacity: 0.6;
        }
        html[data-satori-theme="dark"] .recharts-cartesian-axis-line,
        html[data-satori-theme="dark"] .recharts-cartesian-axis-tick-line {
          stroke: var(--c-border) !important;
        }
        html[data-satori-theme="dark"] .recharts-legend-item-text {
          color: var(--c-text-secondary) !important;
          fill: var(--c-text-secondary) !important;
        }

        /* ─── Status pill chips (KPI cards) ──────────────────────────────
           Light up/down indicators are tinted on #ECFDF5 / #FEF2F2 which
           glow white against a dark page. Mute them in dark mode. */
        html[data-satori-theme="dark"] [style*="background: #ECFDF5"],
        html[data-satori-theme="dark"] [style*="background:#ECFDF5"],
        html[data-satori-theme="dark"] [style*="background: rgb(236, 253, 245)"] {
          background: rgba(138,196,65,0.15) !important;
        }
        html[data-satori-theme="dark"] [style*="background: #FEF2F2"],
        html[data-satori-theme="dark"] [style*="background:#FEF2F2"],
        html[data-satori-theme="dark"] [style*="background: rgb(254, 242, 242)"] {
          background: rgba(239,68,68,0.18) !important;
        }
        html[data-satori-theme="dark"] [style*="background: #FEF3C7"],
        html[data-satori-theme="dark"] [style*="background:#FEF3C7"] {
          background: rgba(245,158,11,0.18) !important;
        }
        html[data-satori-theme="dark"] [style*="background: #DBEAFE"],
        html[data-satori-theme="dark"] [style*="background:#DBEAFE"] {
          background: rgba(10,95,137,0.22) !important;
        }
        html[data-satori-theme="dark"] [style*="background: #EFF6FF"],
        html[data-satori-theme="dark"] [style*="background:#EFF6FF"] {
          background: rgba(10,95,137,0.18) !important;
        }
        html[data-satori-theme="dark"] [style*="background: #F3F4F6"],
        html[data-satori-theme="dark"] [style*="background:#F3F4F6"],
        html[data-satori-theme="dark"] [style*="background: rgb(243, 244, 246)"] {
          background: var(--c-surface-alt) !important;
        }
        html[data-satori-theme="dark"] [style*="background: #FAFAFA"],
        html[data-satori-theme="dark"] [style*="background:#FAFAFA"],
        html[data-satori-theme="dark"] [style*="background: rgb(250, 250, 250)"] {
          background: var(--c-surface-alt) !important;
        }

        /* Tables — alternating row backgrounds + th/td borders */
        html[data-satori-theme="dark"] table { color: var(--c-text-primary); }
        html[data-satori-theme="dark"] thead th {
          background: var(--c-surface-alt) !important;
          color: var(--c-text-secondary) !important;
          border-bottom: 1px solid var(--c-border) !important;
        }
        html[data-satori-theme="dark"] tbody td,
        html[data-satori-theme="dark"] tbody th {
          border-bottom: 1px solid var(--c-border) !important;
        }
        html[data-satori-theme="dark"] tbody tr:nth-child(even) {
          background: rgba(255,255,255,0.02);
        }

        /* Buttons that rely on the lightest brand tints */
        html[data-satori-theme="dark"] [style*="background: rgba(138, 196, 65, 0.1)"],
        html[data-satori-theme="dark"] [style*="background:rgba(138,196,65,0.1)"] {
          background: rgba(138,196,65,0.22) !important;
        }

        /* Soft shadows look invisible on dark — bump them */
        html[data-satori-theme="dark"] [style*="box-shadow: 0 1px 3px rgba(0,0,0,0.06)"],
        html[data-satori-theme="dark"] [style*="box-shadow:0 1px 3px rgba(0,0,0,0.06)"] {
          box-shadow: 0 1px 3px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.25) !important;
        }
        html[data-satori-theme="dark"] [style*="box-shadow: 0 4px 12px rgba(0,0,0,0.08)"] {
          box-shadow: 0 4px 12px rgba(0,0,0,0.45) !important;
        }

        /* Catch lavender / cream tints used as soft section backgrounds */
        html[data-satori-theme="dark"] [style*="background: #F5F3FF"],
        html[data-satori-theme="dark"] [style*="background:#F5F3FF"],
        html[data-satori-theme="dark"] [style*="background: #EEF2FF"],
        html[data-satori-theme="dark"] [style*="background:#EEF2FF"],
        html[data-satori-theme="dark"] [style*="background: #FFFBEB"],
        html[data-satori-theme="dark"] [style*="background:#FFFBEB"] {
          background: var(--c-surface-alt) !important;
        }

        /* Modal / dropdown / floating panel backdrops */
        html[data-satori-theme="dark"] [style*="background: rgba(0, 0, 0, 0.5)"],
        html[data-satori-theme="dark"] [style*="background: rgba(0,0,0,0.5)"],
        html[data-satori-theme="dark"] [style*="background:rgba(0,0,0,0.5)"] {
          background: rgba(0, 0, 0, 0.72) !important;
        }
      `}</style>
    </div>
  );
};

const SatoriIntroHint = () => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem("satori_mascot_intro_seen") === "1"; } catch {}
    if (seen) return;
    const t1 = setTimeout(() => setVisible(true), 800);       // fade in
    const t2 = setTimeout(() => dismiss(), 12000);             // auto-dismiss
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dismiss = () => {
    try { localStorage.setItem("satori_mascot_intro_seen", "1"); } catch {}
    setVisible(false);
  };
  if (!visible) return null;
  return (
    <div
      style={{
        position: "fixed", bottom: 84, right: 100, zIndex: 1000,
        background: COLORS.surface, color: COLORS.textPrimary,
        border: `1px solid ${COLORS.accent}`,
        borderRadius: 12, padding: "10px 14px 12px",
        maxWidth: 260, fontSize: 12.5,
        boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
        animation: "satori-intro-pulse 2.4s ease-in-out infinite",
      }}
    >
      <div style={{ fontWeight: 700, color: COLORS.accent, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Meet Satori</span>
        <button onClick={dismiss} style={{ background: "none", border: "none", color: COLORS.textMuted, cursor: "pointer", padding: 0, lineHeight: 1 }}>
          <X size={13} />
        </button>
      </div>
      <div style={{ lineHeight: 1.4 }}>
        Click here any time to talk to your AI assistant by voice.
      </div>
      {/* small arrow pointing down-right to the mascot */}
      <div style={{
        position: "absolute", bottom: -7, right: 28, width: 14, height: 14,
        background: COLORS.surface,
        borderRight: `1px solid ${COLORS.accent}`,
        borderBottom: `1px solid ${COLORS.accent}`,
        transform: "rotate(45deg)",
      }} />
    </div>
  );
};

// ─── Main App ───
// ─── Reset Password page (reached from the emailed link, works logged-out) ───
const ResetPasswordPage = () => {
  const token = (() => {
    const q = (typeof window !== "undefined" ? window.location.hash : "").split("?")[1] || "";
    return new URLSearchParams(q).get("token") || "";
  })();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    if (pw.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (pw !== pw2) { setErr("Passwords don't match."); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, new_password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Reset failed");
      setDone(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const goLogin = () => { window.location.hash = ""; window.location.reload(); };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: COLORS.surfaceAlt, fontFamily: "'Red Hat Display', 'Poppins', sans-serif", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 36, boxShadow: "0 12px 40px rgba(0,0,0,0.10)" }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 8 }}>Set a new password</div>
        {!token ? (
          <>
            <div style={{ fontSize: 14, color: "#DC2626", lineHeight: 1.55 }}>This reset link is missing its token. Please use the most recent link from your email, or request a new one from the sign-in page.</div>
            <button onClick={goLogin} style={{ marginTop: 20, width: "100%", padding: 12, border: `1px solid ${COLORS.border}`, borderRadius: 12, fontWeight: 600, background: COLORS.surface, cursor: "pointer" }}>Back to sign in</button>
          </>
        ) : done ? (
          <>
            <div style={{ padding: "12px 14px", background: "#ECFDF5", border: "1px solid #6EE7B7", borderRadius: 10, color: "#065F46", fontSize: 13.5, lineHeight: 1.5 }}>
              Your password has been updated. You can now sign in with your new password.
            </div>
            <button onClick={goLogin} style={{ marginTop: 20, width: "100%", padding: 14, border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600, background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`, color: "#fff", cursor: "pointer" }}>Go to sign in</button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
            <div style={{ fontSize: 14, color: COLORS.textSecondary, lineHeight: 1.5, marginBottom: 4 }}>Choose a new password for your Satori account.</div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>New password</label>
              <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" autoFocus required
                style={{ width: "100%", padding: "12px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 12, fontSize: 14, outline: "none", background: COLORS.surfaceAlt, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>Confirm new password</label>
              <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Re-enter your new password" autoComplete="new-password" required
                style={{ width: "100%", padding: "12px 14px", border: `1px solid ${COLORS.border}`, borderRadius: 12, fontSize: 14, outline: "none", background: COLORS.surfaceAlt, boxSizing: "border-box" }} />
            </div>
            {err && <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: "#DC2626", fontSize: 13 }}>{err}</div>}
            <button type="submit" disabled={busy} style={{ width: "100%", padding: 14, border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600, background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`, color: "#fff", cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
              {busy ? "Updating…" : "Update password"}
            </button>
            <button type="button" onClick={goLogin} style={{ background: "none", border: "none", color: COLORS.textSecondary, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          </form>
        )}
      </div>
    </div>
  );
};

// ─── Boot splash ──────────────────────────────────────────────────────
//
// A short, branded "boot sequence" shown right after sign-in (and once per
// browser session when landing with a live token). Pure CSS keyframes — no
// extra deps. Self-dismisses (~2.9s) and calls onDone so the app underneath
// is fully rendered and ready by the time it fades away.
const SatoriBootSplash = ({ onDone, userName }) => {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setLeaving(true), 2450);  // begin fade-out
    const t2 = setTimeout(() => onDone?.(), 3000);        // unmount
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  const firstName = (userName || "").trim().split(/\s+/)[0] || "";

  return (
    <div
      role="status"
      aria-label="Loading Satori"
      style={{
        position: "fixed", inset: 0, zIndex: 99999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "radial-gradient(1200px 820px at 50% 36%, #0c2418 0%, #07140d 55%, #03070500 100%), #040806",
        opacity: leaving ? 0 : 1,
        transform: leaving ? "scale(1.04)" : "scale(1)",
        transition: "opacity 0.55s ease, transform 0.6s ease",
        pointerEvents: leaving ? "none" : "auto",
        overflow: "hidden",
        fontFamily: "'Red Hat Display', 'Poppins', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <style>{`
        @keyframes satboot-fadeUp { 0% { opacity:0; transform: translateY(16px);} 100% { opacity:1; transform: translateY(0);} }
        @keyframes satboot-grow   { 0% { width:0; opacity:0;} 100% { width:64px; opacity:1;} }
        @keyframes satboot-pulse  { 0%,100% { transform: scale(1); opacity:0.55;} 50% { transform: scale(1.4); opacity:1;} }
        @keyframes satboot-ring   { 0% { transform: scale(0.85); opacity:0.55;} 70% { opacity:0;} 100% { transform: scale(1.9); opacity:0;} }
        @keyframes satboot-shimmer{ 0% { background-position: -180% 0;} 100% { background-position: 180% 0;} }
        @keyframes satboot-bar    { 0% { transform: translateX(-100%);} 100% { transform: translateX(0);} }
      `}</style>

      {/* Brand tally-mark diagonal lines */}
      <div style={{ position: "absolute", inset: 0, opacity: 0.07, pointerEvents: "none" }}>
        {Array.from({ length: 22 }, (_, i) => (
          <div key={i} style={{
            position: "absolute", width: 2, height: 260, background: "#8AC441",
            transform: "rotate(15deg)", top: `${-12 + (i % 5) * 22}%`, left: `${i * 4.8}%`,
          }} />
        ))}
      </div>
      {/* Faint grid, masked to a soft center spotlight */}
      <div style={{
        position: "absolute", inset: 0, opacity: 0.6, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(138,196,65,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(138,196,65,0.045) 1px, transparent 1px)",
        backgroundSize: "46px 46px",
        WebkitMaskImage: "radial-gradient(circle at 50% 42%, #000 0%, transparent 68%)",
        maskImage: "radial-gradient(circle at 50% 42%, #000 0%, transparent 68%)",
      }} />

      <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: 24 }}>
        {/* WELCOME TO THE FUTURE + pulsing dot */}
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 34, animation: "satboot-fadeUp 0.7s ease both" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#8AC441", boxShadow: "0 0 16px #8AC441", animation: "satboot-pulse 1.6s ease-in-out infinite" }} />
          <span style={{ fontSize: 12.5, letterSpacing: "6px", fontWeight: 600, color: "#8AC441", textTransform: "uppercase" }}>Welcome to the Future</span>
        </div>

        {/* TMC logo with expanding glow ring */}
        <div style={{ position: "relative", marginBottom: 30, animation: "satboot-fadeUp 0.7s ease 0.12s both" }}>
          <div style={{ position: "absolute", inset: -20, borderRadius: "50%", border: "1px solid rgba(138,196,65,0.4)", animation: "satboot-ring 2.4s ease-out infinite" }} />
          <img
            src="/tmc-logo-light.png"
            alt="TMC"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
            style={{ height: 52, width: "auto", filter: "drop-shadow(0 0 24px rgba(138,196,65,0.4))" }}
          />
        </div>

        {/* satori wordmark with a sweeping shimmer */}
        <div style={{ animation: "satboot-fadeUp 0.8s ease 0.32s both" }}>
          <div style={{
            fontSize: 74, fontWeight: 800, letterSpacing: "-2.5px", lineHeight: 1, textTransform: "lowercase",
            backgroundImage: "linear-gradient(100deg, #ffffff 0%, #ffffff 38%, #c9f08a 50%, #ffffff 62%, #ffffff 100%)",
            backgroundSize: "200% auto", WebkitBackgroundClip: "text", backgroundClip: "text",
            WebkitTextFillColor: "transparent", color: "transparent",
            animation: "satboot-shimmer 2.6s linear infinite",
          }}>satori</div>
        </div>

        {/* Accent divider that grows in */}
        <div style={{ height: 3, background: "#8AC441", borderRadius: 2, margin: "16px 0 16px", boxShadow: "0 0 12px rgba(138,196,65,0.6)", animation: "satboot-grow 0.7s ease 0.7s both" }} />

        {/* Tagline */}
        <div style={{ fontSize: 14.5, fontWeight: 300, letterSpacing: "2px", color: "rgba(255,255,255,0.55)", animation: "satboot-fadeUp 0.8s ease 0.92s both" }}>
          TMC's Capability Intelligence Matrix
        </div>

        {/* Personalised line */}
        {firstName ? (
          <div style={{ marginTop: 22, fontSize: 12.5, letterSpacing: "0.5px", color: "rgba(255,255,255,0.42)", animation: "satboot-fadeUp 0.8s ease 1.15s both" }}>
            Initializing your workspace, {firstName}…
          </div>
        ) : null}

        {/* Indeterminate progress bar */}
        <div style={{ width: 220, height: 3, marginTop: firstName ? 22 : 30, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden", animation: "satboot-fadeUp 0.6s ease 1.05s both" }}>
          <div style={{ height: "100%", width: "100%", borderRadius: 3, background: "linear-gradient(90deg, rgba(104,147,63,0) 0%, #8AC441 60%, #8AC441 100%)", boxShadow: "0 0 10px rgba(138,196,65,0.7)", animation: "satboot-bar 2.1s cubic-bezier(0.4,0,0.2,1) 0.3s both" }} />
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!localStorage.getItem("token"));
  // Boot splash: show once per browser session when arriving with a live token,
  // and on every explicit sign-in (handleLogin sets it too).
  const [showSplash, setShowSplash] = useState(() => {
    try {
      const hasToken = !!localStorage.getItem("token");
      const seen = sessionStorage.getItem("satori_boot_shown");
      if (hasToken && !seen) { sessionStorage.setItem("satori_boot_shown", "1"); return true; }
    } catch { /* sessionStorage unavailable — skip splash */ }
    return false;
  });
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  });
  const [permissions, setPermissions] = useState(() => {
    try { return JSON.parse(localStorage.getItem("permissions") || "null"); } catch { return null; }
  });
  const [activePage, setActivePage] = useState("agent");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [notifications] = useState(5);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  // Dark mode — persisted in localStorage. Applied via a CSS filter
  // injection so we don't have to refactor every inline-styled component
  // to read from a theme context.
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem("satori_dark") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("satori_dark", darkMode ? "1" : "0"); } catch {}
    const root = document.documentElement;
    root.setAttribute("data-satori-theme", darkMode ? "dark" : "light");
    // Belt-and-braces: also set the CSS variables directly on the root style
    // declaration so even if our injected <style> CSS doesn't apply for some
    // reason (e.g. cached old build, specificity issue), the variables still
    // resolve. var(--c-…) inline styles will pick these up.
    const tokens = darkMode ? {
      "--c-primary":         "#F1F5F9",
      "--c-primary-light":   "#CBD5E1",
      "--c-primary-dark":    "#FFFFFF",
      "--c-surface":         "#1E293B",
      "--c-surface-alt":     "#0F172A",
      "--c-border":          "#334155",
      "--c-text-primary":    "#F1F5F9",
      "--c-text-secondary":  "#CBD5E1",
      "--c-text-muted":      "#94A3B8",
      "--c-page-bg":         "#0B1220",
      "--c-input-bg":        "#1E293B",
    } : {
      "--c-primary":         "#333333",
      "--c-primary-light":   "#676767",
      "--c-primary-dark":    "#1a1a1a",
      "--c-surface":         "#FFFFFF",
      "--c-surface-alt":     "#F8FAF5",
      "--c-border":          "#E6E7E8",
      "--c-text-primary":    "#333333",
      "--c-text-secondary":  "#676767",
      "--c-text-muted":      "#B3B2B3",
      "--c-page-bg":         "#F7F9FA",
      "--c-input-bg":        "#FFFFFF",
    };
    for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
    // Final fallback: directly mutate the body background + color so the
    // page never gets stuck on white when dark mode is on.
    document.body.style.background = darkMode ? "#0B1220" : "";
    document.body.style.color      = darkMode ? "#F1F5F9" : "";
  }, [darkMode]);
  // Shown on the login page when redirected due to token expiry
  const [sessionExpiredMsg, setSessionExpiredMsg] = useState("");

  // Refresh permissions from the backend (used after login + after self-edit in admin page).
  const refreshPermissions = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/me/permissions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setPermissions(data);
      localStorage.setItem("permissions", JSON.stringify(data));
    } catch {}
  }, []);

  // On mount (once per login session), always pull the authoritative
  // permissions from the server — the cached login copy can be missing fields
  // like is_superadmin (which gates the Admin nav), so a reload must reconcile.
  const _permsRefreshed = useRef(false);
  useEffect(() => {
    if (isLoggedIn && !_permsRefreshed.current) {
      _permsRefreshed.current = true;
      refreshPermissions();
    }
    if (!isLoggedIn) _permsRefreshed.current = false;
  }, [isLoggedIn, refreshPermissions]);

  // -- Stale-currentUser refresh --
  // localStorage caches the user blob from login time. If anything on the
  // server side changes (company rename, role flip, full-name edit) the
  // cached blob can lag forever. Hit /api/me once per mount when logged in
  // and replace both state + localStorage with the fresh value. Failure is
  // silent - the cached blob is still good enough to render.
  useEffect(() => {
    if (!isLoggedIn) return;
    const token = localStorage.getItem("token");
    if (!token) return;
    const base = import.meta.env.VITE_API_BASE || "";
    fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(fresh => {
        if (!fresh || typeof fresh !== "object") return;
        setCurrentUser(prev => {
          const merged = { ...(prev || {}), ...fresh };
          try { localStorage.setItem("user", JSON.stringify(merged)); } catch {}
          return merged;
        });
      })
      .catch(() => {});
  }, [isLoggedIn]);

  // ── Session expiry listener ──
  // The global fetch interceptor fires "auth:session-expired" whenever any
  // authenticated request receives a 401. We catch it here and force logout.
  // Using stable React setState callbacks means no deps / stale-closure risk.
  useEffect(() => {
    const handler = () => {
      // Clear token immediately so the interceptor won't re-fire for inflight requests
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      localStorage.removeItem("permissions");
      setCurrentUser(null);
      setPermissions(null);
      setIsLoggedIn(false);
      setSessionExpiredMsg("Your session has expired. Please sign in again.");
    };
    window.addEventListener("auth:session-expired", handler);
    return () => window.removeEventListener("auth:session-expired", handler);
  }, []); // empty — only uses stable setState functions

  const handleLogin = (user, perms) => {
    setCurrentUser(user);
    if (perms) setPermissions(perms);
    setIsLoggedIn(true);
    setSessionExpiredMsg(""); // clear any expiry banner on successful login
    try { sessionStorage.setItem("satori_boot_shown", "1"); } catch { /* ignore */ }
    setShowSplash(true); // play the branded boot sequence on every sign-in
    if (!perms) refreshPermissions();
  };
  const handleLogout = () => {
    // Best-effort: ask the backend to clear the trust-device cookie so the
    // next sign-in on this browser will require 2FA again. Fire-and-forget
    // — we don't block the UI on the request.
    const base = import.meta.env.VITE_API_BASE || "";
    fetch(`${base}/api/logout`, { method: "POST", credentials: "include" }).catch(() => {});
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem("permissions");
    localStorage.removeItem("satori_trust_token"); // clear trust token on explicit logout
    clearDataFreshnessCache(); // don't carry one user's freshness into the next session
    setCurrentUser(null);
    setPermissions(null);
    setIsLoggedIn(false);
    setSessionExpiredMsg(""); // manual logout — no expiry message needed
  };

  // Compute the visible sidebar items based on the user's role + feature grants.
  // Drop dividers that have no visible items below them.
  const isAdmin = (permissions?.role || currentUser?.role || "").toLowerCase() === "admin";
  // superAdminOnly items (currently just System Settings) require BOTH admin
  // role AND the bootstrap superadmin email. Backend sets is_superadmin in
  // /api/me/permissions; we treat a missing flag as false for safety.
  const isSuperAdmin = Boolean(permissions?.is_superadmin);
  const allowedFeatures = new Set(permissions?.features || []);
  const visibleNav = (() => {
    const filtered = NAV_ITEMS.filter((item) => {
      if (item.isDivider) return true; // keep for now; we'll prune empty sections after
      if (item.superAdminOnly) return isSuperAdmin;
      if (item.adminOnly) return isAdmin;
      if (item.requiresFeature) return isAdmin || allowedFeatures.has(item.requiresFeature);
      return true;
    });
    // Drop a divider if it has no actual items between it and the next divider/end
    const result = [];
    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      if (item.isDivider) {
        const hasFollower = filtered.slice(i + 1).some(
          (n) => !n.isDivider
            && (!n.superAdminOnly || isSuperAdmin)
            && (!n.adminOnly || isAdmin)
        );
        // also drop if next divider comes before any non-divider
        const nextDividerIdx = filtered.slice(i + 1).findIndex((n) => n.isDivider);
        const sliceEnd = nextDividerIdx === -1 ? filtered.length : i + 1 + nextDividerIdx;
        const hasItemsInSection = filtered.slice(i + 1, sliceEnd).length > 0;
        if (hasFollower && hasItemsInSection) result.push(item);
      } else {
        result.push(item);
      }
    }
    return result;
  })();

  // If the active page is no longer permitted (e.g. admin revoked it from this user
  // while they were logged in), fall back to the first available feature.
  useEffect(() => {
    if (!isLoggedIn) return;
    const activeStillVisible = visibleNav.some((n) => !n.isDivider && n.id === activePage);
    if (!activeStillVisible) {
      const firstNav = visibleNav.find((n) => !n.isDivider);
      if (firstNav) setActivePage(firstNav.id);
    }
  }, [isLoggedIn, visibleNav, activePage]);

  const currentNav = NAV_ITEMS.find(n => n.id === activePage);
  const DashboardContent = currentNav?.component || (visibleNav.find((n) => !n.isDivider)?.component);

  // Hash-based route for the privacy page so logged-in users can land on it
  // from the profile dropdown without us pulling in react-router. Updates
  // when the hash changes (back/forward buttons work).
  const [routeHash, setRouteHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));
  useEffect(() => {
    const onHash = () => setRouteHash(window.location.hash || "");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const onPrivacy = routeHash === "#privacy";

  // Password-reset page is reachable from the emailed link even when logged out.
  if (routeHash.startsWith("#reset")) return <ResetPasswordPage />;

  if (!isLoggedIn) return <LoginPage onLogin={handleLogin} expiredMsg={sessionExpiredMsg} />;

  return (
    <div style={{ display: "flex", height: "100vh", background: COLORS.surfaceAlt, fontFamily: "'Red Hat Display', 'Poppins', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      {/* Branded boot sequence on sign-in (fixed overlay, self-dismisses) */}
      {showSplash && (
        <SatoriBootSplash
          userName={currentUser?.full_name || currentUser?.name || currentUser?.email}
          onDone={() => setShowSplash(false)}
        />
      )}
      {/* Sidebar */}
      <div style={{
        width: sidebarCollapsed ? 72 : 260, background: COLORS.surface, borderRight: `1px solid ${COLORS.border}`,
        display: "flex", flexDirection: "column", transition: "width 0.3s ease",
        boxShadow: "2px 0 8px rgba(0,0,0,0.02)", zIndex: 10, overflow: "hidden",
        flexShrink: 0
      }}>
        {/* Sidebar Header */}
        <div style={{
          padding: sidebarCollapsed ? "0 16px" : "0 24px",
          borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center",
          gap: 12, height: 64
        }}>
          {sidebarCollapsed ? (
            <div style={{ width: 30, height: 30, borderRadius: 8, background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "#fff", fontSize: 15, fontWeight: 800, fontFamily: "'Red Hat Display', sans-serif" }}>S</span>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 26, fontWeight: 800, color: COLORS.textPrimary, lineHeight: 1, fontFamily: "'Red Hat Display', sans-serif", letterSpacing: "-0.5px", textTransform: "lowercase" }}>satori</div>
              <div style={{ width: 28, height: 3, background: COLORS.accent, borderRadius: 2, marginTop: 6 }} />
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav data-tour="nav" style={{ flex: 1, padding: "16px 12px", overflowY: "auto" }}>
          {visibleNav.map((item, idx) => {
            if (item.isDivider) {
              return (
                <div key={item.id} style={{ fontSize: 10, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "1px", padding: sidebarCollapsed ? (idx === 0 ? "0 4px 8px" : "12px 4px 8px") : (idx === 0 ? "0 12px 8px" : "12px 12px 8px"), display: sidebarCollapsed ? "none" : "block", marginTop: idx === 0 ? 0 : 8, borderTop: idx === 0 ? "none" : `1px solid ${COLORS.border}` }}>
                  {item.label}
                </div>
              );
            }
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                data-tour={`nav-${item.id}`}
                onClick={() => { setActivePage(item.id); if (window.location.hash) window.location.hash = ""; }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: sidebarCollapsed ? "10px 0" : "10px 12px",
                  justifyContent: sidebarCollapsed ? "center" : "flex-start",
                  borderRadius: 10, border: "none", cursor: "pointer", marginBottom: 2,
                  background: isActive ? `${COLORS.accent}18` : "transparent",
                  color: isActive ? COLORS.accent : COLORS.textSecondary,
                  fontSize: 13, fontWeight: isActive ? 600 : 500,
                  transition: "all 0.15s"
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = COLORS.surfaceAlt; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <item.icon size={18} />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Sidebar Footer */}
        <div style={{ padding: "12px", borderTop: `1px solid ${COLORS.border}` }}>
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 8,
              padding: "8px 12px", justifyContent: sidebarCollapsed ? "center" : "flex-start",
              borderRadius: 8, border: "none", cursor: "pointer", background: COLORS.surfaceAlt,
              color: COLORS.textMuted, fontSize: 12
            }}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <><ChevronLeft size={16} /> <span>Collapse</span></>}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top Bar */}
        <header style={{
          height: 64, background: COLORS.surface, borderBottom: `1px solid ${COLORS.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 16px 0 32px", flexShrink: 0
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.textPrimary }}>{currentNav?.label || "Dashboard"}</div>
              <div style={{ fontSize: 12, color: COLORS.textMuted }}>
                {activePage === "agent" ? "Enterprise AI · Connected to your data sources"
                  : activePage === "reports" ? "Build, edit, and download tabular reports as Excel or PDF"
                  : activePage === "rules" ? "Automated alerts & notifications"
                  : activePage === "dashboards" ? "Build, view, and refine your custom dashboards"
                  : activePage === "ap" ? "Product Orders"
                  : activePage === "ar" ? "Dealer Orders"
                  : activePage === "invoices" ? "TMC Sales Invoice Analytics"
                  : activePage === "stock" ? "Inventory & Stock Monitoring"
                  : "Real-time analytics · Updated just now"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Warehouse data freshness — visible app-wide */}
            <span data-tour="data-as-of" style={{ display: "inline-flex" }}>
              <DataAsOf style={{
                padding: "6px 10px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
                background: COLORS.surfaceAlt,
              }} />
            </span>
            {/* Dark mode toggle */}
            <button
              onClick={() => setDarkMode(!darkMode)}
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              style={{
                width: 38, height: 38, borderRadius: 10, border: `1px solid ${COLORS.border}`,
                background: darkMode ? "#1F2937" : "#fff", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: darkMode ? "#FBBF24" : "#475569", transition: "all 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#8AC441")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#E2E8F0")}
            >
              {darkMode ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            {/* Profile with dropdown */}
            <div style={{ position: "relative" }}>
              <div onClick={() => setProfileMenuOpen(!profileMenuOpen)} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "6px 12px 6px 6px",
                borderRadius: 10, border: profileMenuOpen ? `1px solid ${COLORS.accent}` : "1px solid #E2E8F0",
                cursor: "pointer", transition: "all 0.15s", userSelect: "none"
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accentDark})`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontSize: 13, fontWeight: 600
                }}>{currentUser?.full_name?.[0] || "U"}</div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, lineHeight: 1.2 }}>{currentUser?.full_name || "User"}</div>
                  <div style={{ fontSize: 10, color: COLORS.textMuted }}>{currentUser?.company_name || ""}</div>
                </div>
                <ChevronDown size={14} color={COLORS.textMuted} style={{ marginLeft: 2, transition: "transform 0.2s", transform: profileMenuOpen ? "rotate(180deg)" : "none" }} />
              </div>

              {/* Dropdown menu */}
              {profileMenuOpen && (
                <>
                  {/* Invisible backdrop to close menu */}
                  <div onClick={() => setProfileMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
                  <div style={{
                    position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
                    width: 220, background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.12)", overflow: "hidden",
                    animation: "fadeIn 0.15s ease"
                  }}>
                    {/* User info header */}
                    <div style={{ padding: "14px 16px", borderBottom: `1px solid ${COLORS.border}` }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{currentUser?.full_name || "User"}</div>
                      <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{currentUser?.email || ""}</div>
                    </div>
                    {/* AI privacy toggle — per-user opt-out from sending business
                        data context to Gemini. The user's prompt itself is
                        always PII-redacted server-side before any third-party
                        call; this toggle additionally suppresses the BigQuery
                        context-injection that the chat agent uses. */}
                    <AiOptOutToggle />
                    {/* Privacy / governance disclosure */}
                    <a href="#privacy" onClick={(e) => { e.preventDefault(); setProfileMenuOpen(false); window.location.hash = "#privacy"; }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
                        fontSize: 13, color: COLORS.textSecondary, textDecoration: "none",
                        borderTop: `1px solid ${COLORS.border}`,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = COLORS.surfaceAlt; e.currentTarget.style.color = COLORS.textPrimary; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textSecondary; }}
                    >
                      <Shield size={15} /> Privacy & data
                    </a>
                    {/* Logout */}
                    <div style={{ borderTop: `1px solid ${COLORS.border}` }}>
                      <button onClick={() => { setProfileMenuOpen(false); handleLogout(); }} style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
                        border: "none", background: "transparent", cursor: "pointer", fontSize: 13,
                        color: COLORS.danger, transition: "all 0.1s", textAlign: "left"
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#FEF2F2"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                      >
                        <LogOut size={15} /> Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Dashboard Area */}
        <main style={{ flex: 1, overflow: onPrivacy || activePage === "agent" || activePage === "reports" || activePage === "rules" || activePage === "dashboards" ? "hidden" : "auto", padding: onPrivacy || activePage === "agent" || activePage === "reports" || activePage === "rules" || activePage === "dashboards" || activePage === "users" || activePage === "audit" || activePage === "support" ? 0 : 32 }}>
          <div style={{ animation: "fadeIn 0.3s ease", height: onPrivacy || activePage === "agent" || activePage === "reports" || activePage === "rules" || activePage === "dashboards" ? "100%" : "auto" }}>
            {onPrivacy ? (
              <PrivacyPage onBack={() => { window.location.hash = ""; }} />
            ) : DashboardContent && (
              <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: COLORS.textMuted, fontSize: 14 }}>Loading…</div>}>
                {activePage === "users"
                  ? <DashboardContent currentUserId={currentUser?.id} onPermissionsChanged={refreshPermissions} />
                  : <DashboardContent />}
              </Suspense>
            )}
          </div>

          {/* Footer */}
          <div style={{
            marginTop: 32, padding: "20px 0", borderTop: `1px solid ${COLORS.border}`,
            display: activePage === "agent" || activePage === "reports" || activePage === "rules" || activePage === "dashboards" || activePage === "users" || activePage === "audit" || activePage === "support" ? "none" : "flex", justifyContent: "space-between", alignItems: "center"
          }}>
            <div style={{ fontSize: 12, color: COLORS.textMuted }}>
              Satori v1.0 &middot; TallyMarks Consulting (TMC)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: COLORS.textMuted }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.success }} />
                Data Warehouse Connected
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.success }} />
                ERP System Active
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.success }} />
                AI Engine Online
              </span>
            </div>
          </div>
        </main>
      </div>

      {/* Chat Agent */}
      <ChatAgent isOpen={chatOpen} onClose={() => setChatOpen(false)} dashboardContext={currentNav?.label} />

      {/* Floating Mic + Help buttons (ports Old Satori FAB) — visible on every page */}
      <FabButtons pageLabel={currentNav?.label} />

      {/* First-run product tour (replayable from Help) */}
      <OnboardingTour onNavigate={setActivePage} />

      {/* Pulse survey + welcome-back nudge */}
      <EngagementPrompts />


      {/* Global Styles */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); } 50% { box-shadow: 0 0 0 12px rgba(239,68,68,0); } }
        @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
        @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.5); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #94A3B8; }
      `}</style>
    </div>
  );
}
