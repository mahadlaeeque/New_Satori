// ─── WorldMap ───
// The punch-location map behind the Attendance Pulse dashboard — the panel
// that replaces Qlik's Check_In_Location / Check_Out_Location point layers.
//
// Deliberately dependency-free: an inline vector basemap (see worldPath.js)
// drawn into an SVG, rather than Leaflet/Mapbox over a tile server. No CDN, no
// runtime network call, no API key, nothing to break behind a proxy — and it
// themes with the rest of Satori instead of fighting a raster basemap in dark
// mode.
//
// Interaction mirrors the Qlik sheet: per-layer toggles, scroll/drag to
// navigate, home + fit controls, hover for the numbers, click to drill.

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { Plus, Minus, Home, Maximize, MapPin } from "lucide-react";
import { WORLD_PATH_D, WORLD_W, WORLD_H, projectLon, projectLat } from "./worldPath.js";

const C = {
  surface:       "var(--c-surface)",
  surfaceAlt:    "var(--c-surface-alt)",
  border:        "var(--c-border)",
  textPrimary:   "var(--c-text-primary)",
  textSecondary: "var(--c-text-secondary)",
  textMuted:     "var(--c-text-muted)",
};

// Layer colours echo the Qlik sheet (teal in / amber out) so anyone moving
// across from the old dashboard reads the map the same way.
const LAYER_COLORS = ["#0E7C86", "#E3A008", "#7C3AED", "#DC2626", "#2563EB"];
const MIN_W = WORLD_W / 60;   // deepest zoom (~city block)
const MAX_W = WORLD_W;        // whole world; never zoom out past it
// Vertical anchor for the "whole world" view: the midpoint of the inhabited
// band (~70°N to ~55°S). Centring on the equator instead would spend a third
// of a wide panel on Antarctica.
const HOME_CY = (projectLat(70) + projectLat(-55)) / 2;

// Panel height is DERIVED from its width — an equirectangular world is 2:1, so
// forcing it into a taller box would letterbox it with dead ocean above and
// below. The `height` prop is a ceiling, not a target.
const boxHeightFor = (w, ceiling) => Math.round(Math.max(240, Math.min(ceiling, w / 2.2)));

/** Keep a view inside the world, given the panel's aspect ratio (h/w). */
const clampWith = (v, aspect) => {
  const w = Math.min(MAX_W, Math.max(MIN_W, v.w));
  const h = w * aspect;
  // When the visible band is taller than the world there's nothing to pan to —
  // lock it on the inhabited band rather than letting the globe drift away.
  const y = h >= WORLD_H
    ? Math.min(0, Math.max(WORLD_H - h, HOME_CY - h / 2))
    : Math.min(WORLD_H - h, Math.max(0, v.y));
  return { w, x: Math.min(WORLD_W - w, Math.max(0, v.x)), y };
};

/** "Home" = as much of the world as fits without dead bands. */
const homeWith = (aspect) => {
  const w = Math.min(WORLD_W, WORLD_H / (aspect || 0.5));
  return clampWith({ x: (WORLD_W - w) / 2, w, y: HOME_CY - (w * aspect) / 2 }, aspect);
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const fmtNum = (v) => (v == null ? "—" : Number(v).toLocaleString());

export default function WorldMap({
  rows = [],
  latKey = "lat",
  lonKey = "lon",
  labelKey = "zone",
  valueKey = "punches",
  groupKey = "layer",
  height = 460,
  onPointClick,
}) {
  // The view carries x/y/w only — the height is derived from the panel's own
  // aspect ratio so the viewBox always matches the box it's painted into.
  // Fixing the viewBox at 2:1 instead letterboxes the map inside any panel
  // that isn't exactly twice as wide as it is tall.
  const [view, setView] = useState({ x: 0, y: HOME_CY - WORLD_H / 4, w: WORLD_W });
  const [boxW, setBoxW] = useState(0);
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null);       // { point, x, y } in container px
  const wrapRef = useRef(null);
  const outerRef = useRef(null);
  const dragRef = useRef(null);

  // Measure the panel, then frame the map to it. The first measurement picks
  // the home framing; later ones just re-clamp so a resize can't strand the
  // view off-screen. All of it runs from the observer callback, never from a
  // render or an effect body.
  const framedRef = useRef(false);
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || 0;
      if (!w) return;
      const a = boxHeightFor(w, height) / w;
      setBoxW(w);
      if (framedRef.current) {
        setView((v) => clampWith(v, a));
      } else {
        framedRef.current = true;
        setView(homeWith(a));
      }
    };
    // Microtask, not just the observer: ResizeObserver delivery is part of the
    // frame-production loop, so in any context that isn't painting (a
    // background tab, a headless check) it never fires and the map would sit
    // forever on its unmeasured 2:1 fallback. The microtask always runs.
    queueMicrotask(measure);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  const boxH = boxHeightFor(boxW || height * 2.2, height);
  const aspect = boxW > 0 ? boxH / boxW : WORLD_H / WORLD_W;

  // ── Normalise rows into plottable points ────────────────────────────────
  const points = useMemo(() => {
    const out = [];
    for (const r of rows || []) {
      const lat = num(r?.[latKey]);
      const lon = num(r?.[lonKey]);
      if (lat == null || lon == null) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      out.push({
        row: r,
        lat, lon,
        cx: projectLon(lon),
        cy: projectLat(lat),
        layer: String(r?.[groupKey] ?? "Locations"),
        label: String(r?.[labelKey] ?? ""),
        value: num(r?.[valueKey]) ?? 1,
      });
    }
    // Draw the heaviest points first so small ones stay clickable on top.
    return out.sort((a, b) => b.value - a.value);
  }, [rows, latKey, lonKey, labelKey, valueKey, groupKey]);

  // Sorted, not first-seen: the row order depends on which layer happened to
  // have the busiest cell, and a legend whose colours swap between refreshes
  // is worse than useless. Alphabetical also lands Check-in on teal and
  // Check-out on amber — the same pairing as the Qlik sheet.
  const layers = useMemo(() => {
    const seen = [...new Set(points.map((p) => p.layer))].sort();
    return seen.map((name, i) => ({ name, color: LAYER_COLORS[i % LAYER_COLORS.length] }));
  }, [points]);

  const colorOf = useCallback(
    (layer) => (layers.find((l) => l.name === layer) || layers[0] || {}).color || LAYER_COLORS[0],
    [layers],
  );

  const visible = useMemo(() => points.filter((p) => !hidden.has(p.layer)), [points, hidden]);
  const maxValue = useMemo(() => visible.reduce((m, p) => Math.max(m, p.value), 0) || 1, [visible]);

  // ── View helpers ────────────────────────────────────────────────────────
  const viewH = view.w * aspect;

  const clampView = useCallback((v) => clampWith(v, aspect), [aspect]);
  const homeView = useCallback(() => homeWith(aspect), [aspect]);

  const zoomBy = useCallback((factor, focus) => {
    setView((v) => {
      const h = v.w * aspect;
      const w = Math.min(MAX_W, Math.max(MIN_W, v.w * factor));
      // Keep the focus point (cursor, or the centre) pinned while scaling.
      const fx = focus ? focus.x : v.x + v.w / 2;
      const fy = focus ? focus.y : v.y + h / 2;
      const rx = (fx - v.x) / (v.w || 1);
      const ry = (fy - v.y) / (h || 1);
      return clampView({ x: fx - rx * w, y: fy - ry * (w * aspect), w });
    });
  }, [clampView, aspect]);

  const fitToData = useCallback(() => {
    if (!visible.length) { setView(homeView()); return; }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of visible) {
      minX = Math.min(minX, p.cx); maxX = Math.max(maxX, p.cx);
      minY = Math.min(minY, p.cy); maxY = Math.max(maxY, p.cy);
    }
    const padX = Math.max(24, (maxX - minX) * 0.12);
    const padY = Math.max(24, (maxY - minY) * 0.12);
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    // Grow the tighter axis to the PANEL's ratio — the projection is only
    // faithful when the viewBox and the box it paints into agree.
    const boxW = maxX - minX, boxH = maxY - minY;
    const w = Math.max(boxW, boxH / (aspect || 1));
    setView(clampView({ x: minX - (w - boxW) / 2, y: minY - (w * aspect - boxH) / 2, w }));
  }, [visible, clampView, homeView, aspect]);

  // Hover position only needs container-relative pixels, so it reads the
  // element rect directly rather than going through toWorld — that keeps this
  // callback stable across pans, which is what lets pointsLayer stay memoised.
  const hoverAt = useCallback((point, e) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setHover({ point, x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);

  // Screen px → viewBox units.
  const toWorld = useCallback((clientX, clientY) => {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: view.x + ((clientX - r.left) / r.width) * view.w,
      y: view.y + ((clientY - r.top) / r.height) * viewH,
      px: clientX - r.left,
      py: clientY - r.top,
      rect: r,
    };
  }, [view, viewH]);

  // Wheel zoom. Registered natively (not via the React prop) because React
  // attaches wheel listeners passively, and a passive listener can't
  // preventDefault — the page would scroll away under the cursor.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const w = toWorld(e.clientX, e.clientY);
      zoomBy(e.deltaY > 0 ? 1.22 : 1 / 1.22, w || undefined);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [toWorld, zoomBy]);

  const lastDragRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, view, moved: false };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - d.startX) / r.width) * d.view.w;
    const dy = ((e.clientY - d.startY) / r.height) * (d.view.w * aspect);
    if (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3) d.moved = true;
    setView(clampView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy }));
  };
  const endDrag = (e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    // Stamp the end of a real pan so the point's own click handler can tell a
    // drag-that-finished-on-a-dot from an actual click.
    if (d?.moved) lastDragRef.current = Date.now();
  };

  const toggleLayer = (name) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      // Never let the user hide every layer — an empty map reads as broken data.
      else if (layers.length - next.size > 1) next.add(name);
      return next;
    });
  };

  // Constant on-screen size regardless of zoom.
  const unit = view.w / WORLD_W;
  // LOG, not sqrt. Punch counts span four orders of magnitude — the head
  // office alone carries ~40k of them — and under sqrt every other site
  // collapses to the minimum dot. Log keeps the small sites legible while the
  // big one still reads as the biggest.
  const logMax = Math.log(maxValue + 1) || 1;
  const radiusOf = (v) => (3.5 + 9.5 * (Math.log(Math.max(0, v) + 1) / logMax)) * unit;

  const zoomPct = Math.round((WORLD_W / view.w) * 100);
  const isZoomed = Math.abs(view.w - WORLD_W) > 0.5;

  // A month of punches can be ~2000 location cells. Panning changes view.x/y
  // on every pointermove, which would otherwise re-render every one of those
  // circles 60 times a second. The points only actually depend on the ZOOM
  // level (through `unit`, which keeps their on-screen size constant), so memo
  // them on that and let the browser handle panning with a viewBox change
  // alone. Hover is deliberately NOT a dependency — highlighting in place
  // would invalidate the whole layer on every mouse move, so the hovered point
  // is redrawn as a small overlay on top instead.
  const pointsLayer = useMemo(() => visible.map((p, i) => {
    const r = radiusOf(p.value);
    const col = colorOf(p.layer);
    return (
      <circle
        key={`${p.layer}-${p.label}-${i}`}
        cx={p.cx} cy={p.cy} r={r}
        fill={col} fillOpacity={0.72}
        stroke="#fff" strokeWidth={0.9 * unit}
        style={{ cursor: onPointClick ? "pointer" : "default" }}
        onMouseEnter={(e) => hoverAt(p, e)}
        onMouseMove={(e) => hoverAt(p, e)}
        onMouseLeave={() => setHover(null)}
        onClick={() => {
          // A pan that ends over a point must not read as a click.
          if (Date.now() - lastDragRef.current < 150) return;
          onPointClick?.(p.label, p.row);
        }}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [visible, unit, maxValue, colorOf, onPointClick, hoverAt]);

  if (!points.length) {
    return (
      <div style={{
        height, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", color: C.textMuted, fontSize: 13, gap: 6,
      }}>
        <MapPin size={20} />
        <div style={{ fontWeight: 600, color: C.textSecondary }}>No punch coordinates in this selection</div>
        <div style={{ fontSize: 11.5, maxWidth: 420, textAlign: "center", lineHeight: 1.45 }}>
          Attendance rows only carry a location when the punch came from a
          GPS-enabled device. Try a wider month or clear a filter.
        </div>
      </div>
    );
  }

  const btn = {
    width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
    color: C.textSecondary, cursor: "pointer", padding: 0,
  };

  return (
    <div ref={outerRef} style={{ position: "relative" }}>
      <div
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        style={{
          position: "relative", height: boxH, borderRadius: 12, overflow: "hidden",
          border: `1px solid ${C.border}`, background: "var(--map-ocean, #E8F1F6)",
          cursor: dragging ? "grabbing" : "grab", touchAction: "none",
        }}
      >
        <svg
          viewBox={`${view.x} ${view.y} ${view.w} ${viewH}`}
          width="100%" height="100%"
          preserveAspectRatio="none"
          style={{ display: "block" }}
        >
          {/* graticule — 30° lon / 30° lat, purely for orientation */}
          <g stroke="var(--map-grid, #CBD9E2)" strokeWidth={0.5 * unit} opacity={0.7}>
            {Array.from({ length: 11 }, (_, i) => (i + 1) * (WORLD_W / 12)).map((x) => (
              <line key={`v${x}`} x1={x} y1={0} x2={x} y2={WORLD_H} />
            ))}
            {Array.from({ length: 5 }, (_, i) => (i + 1) * (WORLD_H / 6)).map((y) => (
              <line key={`h${y}`} x1={0} y1={y} x2={WORLD_W} y2={y} />
            ))}
          </g>

          <path
            d={WORLD_PATH_D}
            fillRule="evenodd"
            fill="var(--map-land, #D9E6D5)"
            stroke="var(--map-coast, #A9BEB2)"
            strokeWidth={0.5 * unit}
            strokeLinejoin="round"
          />

          {pointsLayer}

          {/* The hovered point is drawn as an overlay rather than by
              re-styling it in place — see pointsLayer's memo note. */}
          {hover?.point && (
            <g pointerEvents="none">
              <circle cx={hover.point.cx} cy={hover.point.cy} r={radiusOf(hover.point.value) * 1.8}
                      fill={colorOf(hover.point.layer)} opacity={0.2} />
              <circle cx={hover.point.cx} cy={hover.point.cy} r={radiusOf(hover.point.value)}
                      fill={colorOf(hover.point.layer)} fillOpacity={0.95}
                      stroke="#fff" strokeWidth={1.8 * unit} />
            </g>
          )}
        </svg>

        {/* Navigation controls — top-right, mirroring the Qlik sheet's cluster */}
        <div data-html2canvas-ignore="true" style={{
          position: "absolute", top: 12, right: 12, display: "flex", flexDirection: "column", gap: 6,
        }}>
          <button style={btn} title="Zoom in" onClick={() => zoomBy(1 / 1.5)}><Plus size={15} /></button>
          <button style={btn} title="Zoom out" onClick={() => zoomBy(1.5)}><Minus size={15} /></button>
          <button style={btn} title="Fit to punches" onClick={fitToData}><Maximize size={14} /></button>
          <button style={btn} title="Whole world" onClick={() => setView(homeView())}><Home size={14} /></button>
        </div>

        {/* Layer legend — click to show/hide a point layer */}
        <div style={{
          position: "absolute", top: 12, left: 12, background: C.surface,
          border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 10px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.08)", minWidth: 150,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: C.textMuted, marginBottom: 6, textTransform: "uppercase" }}>
            Layers
          </div>
          {layers.map((l) => {
            const off = hidden.has(l.name);
            const n = points.filter((p) => p.layer === l.name).length;
            return (
              <div
                key={l.name}
                onClick={() => toggleLayer(l.name)}
                title={off ? "Show this layer" : "Hide this layer"}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "3px 0",
                  cursor: "pointer", opacity: off ? 0.4 : 1, userSelect: "none",
                }}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                  background: off ? "transparent" : l.color,
                  border: `2px solid ${l.color}`,
                }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: C.textPrimary }}>{l.name}</span>
                <span style={{ fontSize: 11, color: C.textMuted, marginLeft: "auto" }}>{n}</span>
              </div>
            );
          })}
        </div>

        {/* Zoom read-out */}
        {isZoomed && (
          <div style={{
            position: "absolute", bottom: 10, left: 12, fontSize: 10.5, fontWeight: 600,
            color: C.textMuted, background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 6, padding: "3px 8px",
          }}>
            {zoomPct}% · drag to pan
          </div>
        )}

        {/* Hover card */}
        {hover && (
          <div style={{
            position: "absolute", pointerEvents: "none", zIndex: 5,
            // Flip the card back inside the panel near the right edge. Uses the
            // measured width rather than reading the ref during render.
            left: Math.max(8, Math.min(hover.x + 14, (boxW || 0) - 210)),
            top: Math.max(8, hover.y - 10),
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
            boxShadow: "0 6px 20px rgba(0,0,0,0.14)", padding: "9px 11px", minWidth: 180,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: colorOf(hover.point.layer) }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.textPrimary }}>{hover.point.layer}</span>
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6 }}>
              {hover.point.lat.toFixed(2)}°, {hover.point.lon.toFixed(2)}°
            </div>
            {[
              ["Punches", fmtNum(hover.point.row?.punches)],
              ["People", fmtNum(hover.point.row?.people)],
              hover.point.row?.permitted_pct != null
                ? ["Permitted", `${Number(hover.point.row.permitted_pct).toFixed(0)}%`]
                : null,
            ].filter(Boolean).map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 12 }}>
                <span style={{ color: C.textSecondary }}>{k}</span>
                <span style={{ fontWeight: 600, color: C.textPrimary }}>{v}</span>
              </div>
            ))}
            {onPointClick && (
              <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 6, fontStyle: "italic" }}>
                Click for the rows behind this point
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: C.textMuted, textAlign: "center", marginTop: 6 }}>
        {visible.length} location{visible.length === 1 ? "" : "s"} · scroll to zoom, drag to pan, click a point to drill in
      </div>
    </div>
  );
}
