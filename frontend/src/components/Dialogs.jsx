// ─────────────────────────────────────────────────────────────────────────────
// Shared in-app dialog service — replaces the browser's window.confirm /
// window.alert with themed, dark-mode-aware dialogs that match Satori's UI.
//
// Usage (imperative, promise-based — keeps call sites tiny):
//   const ok = await confirmDialog({ title, message, danger, confirmLabel });
//   if (!ok) return;
//   await alertDialog({ title, message });      // or: alertDialog("message")
//
// A single <DialogHost/> must be mounted once near the app root. If it is not
// mounted (or something goes wrong), the helpers fall back to the NATIVE
// window.confirm / window.alert so a confirmation gate is never silently lost.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect } from "react";
import { AlertTriangle, Info, Trash2 } from "lucide-react";

// Module-level bridge set by the mounted <DialogHost/>.
let _push = null;

function _normalize(input) {
  return typeof input === "string" ? { message: input } : (input || {});
}

/** Show a confirm dialog. Resolves true (confirmed) or false (cancelled). */
export function confirmDialog(input) {
  const opts = _normalize(input);
  return new Promise((resolve) => {
    if (typeof _push !== "function") {
      // Host not mounted yet — never lose the confirmation gate.
      try { resolve(window.confirm(opts.message || opts.title || "Are you sure?")); }
      catch { resolve(false); }
      return;
    }
    _push({ kind: "confirm", ...opts, _resolve: resolve });
  });
}

/** Show an informational/error dialog with a single OK button. Resolves when dismissed. */
export function alertDialog(input) {
  const opts = _normalize(input);
  return new Promise((resolve) => {
    if (typeof _push !== "function") {
      try { window.alert(opts.message || opts.title || ""); } catch { /* ignore */ }
      resolve();
      return;
    }
    _push({ kind: "alert", ...opts, _resolve: resolve });
  });
}

// One-time keyframe injection so the module is fully self-contained (does not
// depend on animations defined elsewhere in the app).
const _KF_ID = "satori-dialog-keyframes";
function _ensureKeyframes() {
  if (typeof document === "undefined" || document.getElementById(_KF_ID)) return;
  const el = document.createElement("style");
  el.id = _KF_ID;
  el.textContent =
    "@keyframes satoriDlgFade{from{opacity:0}to{opacity:1}}" +
    "@keyframes satoriDlgIn{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}";
  document.head.appendChild(el);
}

/** Mount ONCE near the app root. Renders whichever dialog is currently active. */
export function DialogHost() {
  const [dlg, setDlg] = useState(null);

  // Register the module-level bridge for the imperative helpers.
  useEffect(() => {
    _ensureKeyframes();
    _push = (d) => setDlg(d);
    return () => { _push = null; };
  }, []);

  // Keyboard: Enter confirms, Escape cancels. Hook runs before the early return.
  useEffect(() => {
    if (!dlg) return undefined;
    const finish = (result) => {
      const resolve = dlg._resolve;
      setDlg(null);
      try { resolve && resolve(result); } catch { /* ignore */ }
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(dlg.kind === "confirm" ? false : undefined); }
      else if (e.key === "Enter") { e.preventDefault(); finish(dlg.kind === "confirm" ? true : undefined); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dlg]);

  if (!dlg) return null;

  const isConfirm = dlg.kind === "confirm";
  const danger = !!dlg.danger;
  const accent = danger ? "#EF4444" : "var(--c-primary)";
  const Icon = dlg.icon || (isConfirm ? (danger ? Trash2 : AlertTriangle) : Info);

  const finish = (result) => {
    const resolve = dlg._resolve;
    setDlg(null);
    try { resolve && resolve(result); } catch { /* ignore */ }
  };
  const onCancel = () => finish(isConfirm ? false : undefined);
  const onConfirm = () => finish(isConfirm ? true : undefined);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 4000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        animation: "satoriDlgFade 0.15s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role={isConfirm ? "alertdialog" : "dialog"}
        aria-modal="true"
        style={{
          width: "100%", maxWidth: 420, background: "var(--c-surface)", borderRadius: 16,
          boxShadow: "0 20px 50px rgba(0,0,0,0.28)", border: "1px solid var(--c-border)",
          overflow: "hidden", animation: "satoriDlgIn 0.16s ease",
        }}
      >
        <div style={{ padding: "22px 22px 18px", display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{
            width: 40, height: 40, borderRadius: 11, flexShrink: 0,
            background: danger ? "var(--sem-danger-bg)" : "var(--c-surface-alt)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Icon size={20} color={accent} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--c-text-primary)", marginBottom: dlg.message ? 5 : 0 }}>
              {dlg.title || (isConfirm ? "Are you sure?" : "Notice")}
            </div>
            {dlg.message ? (
              <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--c-text-secondary)", whiteSpace: "pre-line" }}>
                {dlg.message}
              </div>
            ) : null}
          </div>
        </div>
        <div style={{
          display: "flex", justifyContent: "flex-end", gap: 10,
          padding: "14px 22px", borderTop: "1px solid var(--c-border)", background: "var(--c-surface-alt)",
        }}>
          {isConfirm ? (
            <button
              onClick={onCancel}
              style={{
                padding: "9px 16px", borderRadius: 9, border: "1px solid var(--c-border)",
                background: "var(--c-surface)", color: "var(--c-text-secondary)",
                fontWeight: 600, fontSize: 13, cursor: "pointer",
              }}
            >{dlg.cancelLabel || "Cancel"}</button>
          ) : null}
          <button
            autoFocus
            onClick={onConfirm}
            style={{
              padding: "9px 18px", borderRadius: 9, border: "none",
              background: accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
            }}
          >{dlg.confirmLabel || (isConfirm ? "Confirm" : "OK")}</button>
        </div>
      </div>
    </div>
  );
}

export default DialogHost;
