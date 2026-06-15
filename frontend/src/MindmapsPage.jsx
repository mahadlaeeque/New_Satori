// ─── Mindmap Builder ───
// Data-grounded node graphs. MVP: the org/department tree (TMC → departments →
// people) pulled live from Employee_Data, rendered with react-flow. Describe a
// scope ("map the Qlik department") or pick a department, generate, then save.
//
// Backend endpoints:
//   GET    /api/mindmap/org-tree ?department=
//   GET    /api/mindmaps            (list saved)
//   POST   /api/mindmaps            (save)
//   GET    /api/mindmaps/{id}       (load)
//   DELETE /api/mindmaps/{id}
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Sparkles, Save, Trash2, X, RefreshCw, Network, MapPin, Briefcase,
  Users, ChevronDown, Building2,
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const C = {
  accent: "#8AC441", accentDark: "#68933F", purple: "#353085",
  surface: "var(--c-surface)", surfaceAlt: "var(--c-surface-alt)", border: "var(--c-border)",
  textPrimary: "var(--c-text-primary)", textSecondary: "var(--c-text-secondary)", textMuted: "var(--c-text-muted)",
};
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}` });

// ── Custom node cards ──
const RootNode = ({ data }) => (
  <div style={{ padding: "12px 18px", borderRadius: 14, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`, color: "#fff", boxShadow: `0 8px 22px ${C.accent}55`, minWidth: 150, textAlign: "center" }}>
    <Handle type="source" position={Position.Right} style={{ background: C.accent }} />
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontWeight: 800, fontSize: 15 }}>
      <Building2 size={16} /> {data.label}
    </div>
    {data.sublabel && <div style={{ fontSize: 10.5, opacity: 0.9, marginTop: 2 }}>{data.sublabel}</div>}
  </div>
);
const DeptNode = ({ data }) => (
  <div style={{ padding: "10px 16px", borderRadius: 12, background: C.surface, border: `2px solid ${C.accent}`, minWidth: 150 }}>
    <Handle type="target" position={Position.Left} style={{ background: C.accent }} />
    <Handle type="source" position={Position.Right} style={{ background: C.accent }} />
    <div style={{ fontWeight: 800, fontSize: 13.5, color: C.textPrimary }}>{data.label}</div>
    {data.sublabel && <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2 }}>{data.sublabel}</div>}
  </div>
);
const PersonNode = ({ data }) => (
  <div style={{ padding: "8px 13px", borderRadius: 10, background: C.surface, border: `1px solid ${C.border}`, minWidth: 150, maxWidth: 230 }}>
    <Handle type="target" position={Position.Left} style={{ background: C.border }} />
    <div style={{ fontWeight: 700, fontSize: 12.5, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.label}</div>
    {data.sublabel && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.sublabel}</div>}
  </div>
);
const NODE_TYPES = { root: RootNode, department: DeptNode, person: PersonNode };

// Layered left→right layout: root | departments | people. People stack under
// their department; the department node centres on its people block.
function layout(apiNodes, apiEdges) {
  const COL = { root: 30, department: 380, person: 720 };
  const ROW = 64;
  const childrenOf = {};
  apiEdges.forEach(e => { (childrenOf[e.source] = childrenOf[e.source] || []).push(e.target); });
  const pos = {};
  let row = 0;
  const deptNodes = apiNodes.filter(n => n.type === "department");
  deptNodes.forEach(dept => {
    const people = childrenOf[dept.id] || [];
    const startRow = row;
    if (people.length === 0) { pos[dept.id] = row * ROW; row += 1; }
    people.forEach(pid => { pos[pid] = row * ROW; row += 1; });
    const endRow = Math.max(startRow, row - 1);
    pos[dept.id] = ((startRow + endRow) / 2) * ROW;
    row += 0.6; // gap between departments
  });
  const deptYs = deptNodes.map(d => pos[d.id]);
  pos["root"] = deptYs.length ? (Math.min(...deptYs) + Math.max(...deptYs)) / 2 : 0;
  const rfNodes = apiNodes.map(n => ({
    id: n.id, type: n.type, position: { x: COL[n.type] ?? 0, y: pos[n.id] ?? 0 }, data: { ...n },
  }));
  const rfEdges = apiEdges.map(e => ({
    id: e.id, source: e.source, target: e.target, type: "smoothstep",
    style: { stroke: "var(--c-border)", strokeWidth: 1.5 },
  }));
  return { rfNodes, rfEdges };
}

export default function MindmapsPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [departments, setDepartments] = useState([]);
  const [department, setDepartment] = useState("");   // "" = whole company
  const [title, setTitle] = useState("TMC — Org Map");
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState(null);
  const [saved, setSaved] = useState([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedMsg, setSavedMsg] = useState(null);

  const build = useCallback(async (dept) => {
    setLoading(true); setError(null); setSelected(null);
    try {
      const r = await fetch(`${API_BASE}/api/mindmap/org-tree?department=${encodeURIComponent(dept || "")}`, { headers: authHeaders() });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.detail || "Couldn't build the map."); setLoading(false); return; }
      const j = await r.json();
      if (j.departments) setDepartments(j.departments);
      setTitle(j.title || "Org Map");
      setCounts(j.counts || null);
      const { rfNodes, rfEdges } = layout(j.nodes || [], j.edges || []);
      setNodes(rfNodes); setEdges(rfEdges);
    } catch { setError("Couldn't reach the server."); }
    finally { setLoading(false); }
  }, [setNodes, setEdges]);

  const loadSaved = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/mindmaps`, { headers: authHeaders() });
      if (r.ok) setSaved((await r.json()).mindmaps || []);
    } catch { /* non-blocking */ }
  }, []);

  useEffect(() => { build(""); loadSaved(); /* eslint-disable-next-line */ }, []);

  // Free-text "describe it" → match a department name, else whole company.
  const runPrompt = () => {
    const t = prompt.trim().toLowerCase();
    if (!t) return;
    const match = departments.find(d => t.includes(d.toLowerCase()));
    const dept = match || "";
    setDepartment(dept);
    build(dept);
  };

  const save = async () => {
    setSavedMsg(null);
    try {
      const r = await fetch(`${API_BASE}/api/mindmaps`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: title || "Untitled mindmap", config: { type: "org_tree", department } }),
      });
      if (!r.ok) { setSavedMsg({ type: "error", msg: "Couldn't save." }); return; }
      setSavedMsg({ type: "ok", msg: "Saved." });
      loadSaved();
      setTimeout(() => setSavedMsg(null), 2500);
    } catch { setSavedMsg({ type: "error", msg: "Couldn't save." }); }
  };

  const openSaved = async (id) => {
    setSavedOpen(false);
    try {
      const r = await fetch(`${API_BASE}/api/mindmaps/${id}`, { headers: authHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      const dept = j.config?.department || "";
      setDepartment(dept); setTitle(j.name || "Org Map");
      build(dept);
    } catch { /* ignore */ }
  };

  const deleteSaved = async (id, e) => {
    e.stopPropagation();
    try { await fetch(`${API_BASE}/api/mindmaps/${id}`, { method: "DELETE", headers: authHeaders() }); loadSaved(); }
    catch { /* ignore */ }
  };

  const onNodeClick = useCallback((_e, node) => setSelected(node.data), []);

  const selStyle = useMemo(() => ({
    position: "absolute", top: 16, right: 16, width: 260, zIndex: 5,
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16,
    boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
  }), []);

  const ctrlInput = { padding: "8px 11px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surfaceAlt, color: C.textPrimary, fontSize: 13, outline: "none" };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: C.surfaceAlt }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 800, fontSize: 14, color: C.textPrimary }}>
          <Network size={16} color={C.accent} /> Mindmap Builder
        </div>

        {/* Describe / prompt */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 280px", minWidth: 220 }}>
          <input
            value={prompt} onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") runPrompt(); }}
            placeholder="Describe the map — e.g. “map the Qlik department”"
            style={{ ...ctrlInput, flex: 1 }}
          />
          <button onClick={runPrompt} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: "none", background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            <Sparkles size={14} /> Build
          </button>
        </div>

        {/* Department dropdown */}
        <select value={department} onChange={e => { setDepartment(e.target.value); build(e.target.value); }} style={{ ...ctrlInput, cursor: "pointer", maxWidth: 200 }}>
          <option value="">Whole company</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        <button onClick={() => build(department)} title="Refresh" style={{ padding: 8, borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.textMuted, cursor: "pointer", display: "flex" }}>
          <RefreshCw size={14} style={{ animation: loading ? "spin 0.8s linear infinite" : "none" }} />
        </button>

        <div style={{ flex: 1 }} />

        {/* Saved */}
        <div style={{ position: "relative" }}>
          <button onClick={() => { setSavedOpen(o => !o); loadSaved(); }} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.textSecondary, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            Saved <ChevronDown size={13} />
          </button>
          {savedOpen && (
            <div style={{ position: "absolute", top: "110%", right: 0, width: 260, maxHeight: 320, overflowY: "auto", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", zIndex: 20, padding: 6 }}>
              {saved.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textMuted, padding: 12 }}>No saved mindmaps yet.</div>
              ) : saved.map(m => (
                <div key={m.id} onClick={() => openSaved(m.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surfaceAlt}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                  <button onClick={e => deleteSaved(m.id, e)} style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, display: "flex" }}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button onClick={save} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: "none", background: C.accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          <Save size={14} /> Save
        </button>
      </div>

      {/* Title + counts */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 20px", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
        <input value={title} onChange={e => setTitle(e.target.value)} style={{ border: "none", background: "transparent", color: C.textPrimary, fontSize: 15, fontWeight: 800, outline: "none", flex: 1, minWidth: 0 }} />
        {counts && <span style={{ fontSize: 12, color: C.textMuted, whiteSpace: "nowrap" }}>{counts.people} people · {counts.departments} dept(s)</span>}
        {savedMsg && <span style={{ fontSize: 12, fontWeight: 700, color: savedMsg.type === "ok" ? C.accent : "var(--sem-danger-fg)" }}>{savedMsg.msg}</span>}
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {error ? (
          <div style={{ padding: 24, color: "var(--sem-danger-fg)", fontWeight: 600 }}>{error}</div>
        ) : (
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            nodeTypes={NODE_TYPES} onNodeClick={onNodeClick}
            fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--c-border)" gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => n.type === "root" ? C.accent : n.type === "department" ? C.accentDark : "var(--c-border)"} style={{ background: "var(--c-surface-alt)" }} />
          </ReactFlow>
        )}

        {loading && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted, fontSize: 14, background: "rgba(0,0,0,0.03)", zIndex: 4 }}>Building map…</div>}

        {/* Node detail panel */}
        {selected && (
          <div style={selStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: C.textPrimary }}>{selected.label}</div>
              <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, display: "flex" }}><X size={16} /></button>
            </div>
            {selected.sublabel && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.textSecondary, marginBottom: 6 }}><Briefcase size={13} /> {selected.sublabel}</div>}
            {selected.location && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.textSecondary, marginBottom: 6 }}><MapPin size={13} /> {selected.location}</div>}
            {selected.code && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Code: {selected.code}</div>}
            {selected.type === "department" && (
              <button onClick={() => { setDepartment(selected.label); build(selected.label); }} style={{ marginTop: 10, width: "100%", padding: "8px 12px", borderRadius: 9, border: `1px solid ${C.accent}`, background: `${C.accent}15`, color: C.accentDark, fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>
                Focus this department
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
