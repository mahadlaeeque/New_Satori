import { useState } from "react";

const COLORS = {
  accent: "#8AC441",
  primary: "#333333",
  primaryDark: "#1a1a1a",
  border: "#E6E7E8",
  textMuted: "#B3B2B3",
};

// Sidebar logo options — shown on white background at sidebar scale
const styles = [
  {
    name: "A — Dot + Text",
    render: () => (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.accent, flexShrink: 0 }} />
        <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.primary, fontFamily: "'Red Hat Display', sans-serif", letterSpacing: "-0.5px", textTransform: "lowercase" }}>satori</div>
      </div>
    ),
  },
  {
    name: "B — Green Box + Text",
    render: () => (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.accent})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#fff", fontSize: 15, fontWeight: 800, fontFamily: "'Red Hat Display', sans-serif" }}>S</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.primary, fontFamily: "'Red Hat Display', sans-serif", letterSpacing: "-0.5px", textTransform: "lowercase" }}>satori</div>
      </div>
    ),
  },
  {
    name: "C — Bar + Text",
    render: () => (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 3, height: 22, borderRadius: 2, background: COLORS.accent, flexShrink: 0 }} />
        <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.primary, fontFamily: "'Red Hat Display', sans-serif", letterSpacing: "-0.5px", textTransform: "lowercase" }}>satori</div>
      </div>
    ),
  },
  {
    name: "D — Stacked Mark",
    render: () => (
      <div>
        <div style={{ fontSize: 19, fontWeight: 800, color: COLORS.primary, fontFamily: "'Red Hat Display', sans-serif", letterSpacing: "-0.5px", textTransform: "lowercase", lineHeight: 1 }}>satori</div>
        <div style={{ width: 20, height: 2.5, background: COLORS.accent, borderRadius: 2, marginTop: 4 }} />
      </div>
    ),
  },
  {
    name: "E — Circle Mark + Text",
    render: () => (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: "50%", background: COLORS.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#fff", fontSize: 14, fontWeight: 800, fontFamily: "'Red Hat Display', sans-serif" }}>S</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.primary, fontFamily: "'Red Hat Display', sans-serif", letterSpacing: "-0.5px", textTransform: "lowercase" }}>satori</div>
      </div>
    ),
  },
  {
    name: "F — Outline Box + Text",
    render: () => (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, border: `2px solid ${COLORS.accent}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: COLORS.accent, fontSize: 15, fontWeight: 800, fontFamily: "'Red Hat Display', sans-serif" }}>S</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.primary, fontFamily: "'Red Hat Display', sans-serif", letterSpacing: "-0.5px", textTransform: "lowercase" }}>satori</div>
      </div>
    ),
  },
];

export default function LogoPreview() {
  const [selected, setSelected] = useState(null);
  return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", padding: 60, fontFamily: "'Red Hat Display', sans-serif" }}>
      <div style={{ fontSize: 14, color: "#999", marginBottom: 40, textTransform: "uppercase", letterSpacing: 2 }}>Pick a sidebar logo style</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
        {styles.map((s, i) => (
          <div
            key={i}
            onClick={() => setSelected(i)}
            style={{
              background: "#fff",
              border: selected === i ? `2px solid ${COLORS.accent}` : `2px solid ${COLORS.border}`,
              borderRadius: 14, padding: "32px 24px", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center",
              gap: 20, transition: "all 0.2s",
              minHeight: 100,
              boxShadow: selected === i ? "0 4px 12px rgba(138,196,65,0.15)" : "none",
            }}
          >
            {s.render()}
            <div style={{ fontSize: 11, color: "#999", fontWeight: 500 }}>{s.name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
