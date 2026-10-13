import { useState, useEffect, useRef, useCallback } from "react";
import { listFontPresets } from "@churchkit/config/font-presets";
import { buildNav } from "@churchkit/config/nav";
import { listHomeLayouts } from "@churchkit/config/home-layouts";
import { parseBibleReference } from "@churchkit/config/bible";
import { renderSermonNotesDocument } from "@churchkit/config/sermon-notes";

// ─── Constants ───────────────────────────────────────────────────────────────
// No default. A guessed API base would point one church's admin panel at
// another church's data; an unset one should fail loudly at startup.
const API = import.meta.env.PUBLIC_API_BASE || "";

/**
 * Slugs the website's own routes own. A page named one of these would be
 * shadowed by the real route and appear broken, so page creation refuses
 * them. Kept in step with apps/web/src/lib/nav.ts.
 */
const RESERVED_SLUGS = new Set([
  "", "ministries", "media", "events", "contact", "give", "leadership",
  "im-new", "connect-card", "prayer-request", "api", "admin", "404",
]);

const DEEP_LINKS = ["home", "events", "watch", "bible", "account"];

const DEEP_LINK_LABELS = {
  home: "Home — Main dashboard with carousel, service times, and featured content",
  events: "Events — Upcoming church events list",
  watch: "Watch — Sermon media library",
  bible: "Bible — Verse of the day, reading plans, and memory verse",
  account: "Account — Connect card, ministries, staff directory, and giving",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// The Access JWT lives in an HttpOnly cookie — unreadable from JS by design
// — and Cloudflare only injects CF-Access-Jwt-Assertion on requests it
// proxies to the protected hostname itself. Calling the API same-origin
// (apps/admin/src/worker.mjs proxies /api/* over a service binding) means
// that header rides along automatically; nothing here needs to read or
// forward it.
function api(path, opts = {}) {
  return fetch(`${API}${path}`, {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

/**
 * D1 stores timestamps as unix *seconds* (`unixepoch()`), while PCO and
 * YouTube hand back ISO strings. Passing seconds straight to `new Date()`
 * reads them as milliseconds, which is why every form submission was dated
 * in January 1970. Anything numeric below ~year 5138 in ms is really
 * seconds, so scale it.
 */
function toDate(d) {
  if (d === null || d === undefined || d === "") return null;
  const n = typeof d === "number" ? d : /^\d+$/.test(String(d).trim()) ? Number(d) : NaN;
  const date = Number.isNaN(n) ? new Date(d) : new Date(n < 1e11 ? n * 1000 : n);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtDate(d) {
  const date = toDate(d);
  if (!date) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(d) {
  const date = toDate(d);
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** `spiritual_journey` / `firstName` → "Spiritual Journey" / "First Name". */
function labelize(key) {
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isEmpty(v) {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
  if (typeof v === "object") return Object.values(v).every(isEmpty);
  return false;
}

/** One line of text for a value that isn't worth its own nested block. */
function flatten(v) {
  if (isEmpty(v)) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(flatten).join(", ");
  if (typeof v === "object") {
    return Object.entries(v)
      .filter(([, x]) => !isEmpty(x))
      .map(([k, x]) => `${labelize(k)}: ${flatten(x)}`)
      .join(", ");
  }
  return String(v);
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((msg, type = "success") => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);
  return { toasts, show };
}

function ToastStack({ toasts }) {
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8 }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: t.type === "error" ? "#c0392b" : "var(--admin-brand)",
          color: "#fff",
          padding: "12px 20px",
          borderRadius: 8,
          fontFamily: "DM Sans, sans-serif",
          fontSize: 14,
          boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
          animation: "slideUp 0.3s ease",
          maxWidth: 320,
        }}>
          {t.type === "success" ? "✓ " : "⚠ "}{t.msg}
        </div>
      ))}
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const h = e => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 32, width: "100%", maxWidth: wide ? 720 : 520, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 22, color: "var(--admin-brand)", margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 22, cursor: "pointer", color: "#888", lineHeight: 1 }}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Form helpers ─────────────────────────────────────────────────────────────
function Field({ label, children, required, style }) {
  return (
    <div style={{ marginBottom: 16, ...style }}>
      <label style={{ display: "block", fontFamily: "DM Sans, sans-serif", fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 6 }}>
        {label}{required && <span style={{ color: "#c0392b" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "10px 14px",
  border: "1.5px solid #ddd", borderRadius: 8, fontFamily: "DM Sans, sans-serif",
  fontSize: 14, color: "#222", background: "#fafafa", outline: "none",
  transition: "border-color 0.2s",
};

const btnPrimary = {
  background: "var(--admin-brand)", color: "#fff", border: "none", padding: "10px 22px",
  borderRadius: 8, fontFamily: "DM Sans, sans-serif", fontWeight: 600,
  fontSize: 14, cursor: "pointer", transition: "background 0.2s",
};

const btnSecondary = {
  background: "transparent", color: "var(--admin-brand)", border: "1.5px solid var(--admin-brand)",
  padding: "10px 22px", borderRadius: 8, fontFamily: "DM Sans, sans-serif",
  fontWeight: 600, fontSize: 14, cursor: "pointer",
};

const btnGold = {
  background: "var(--admin-accent)", color: "#fff", border: "none", padding: "10px 22px",
  borderRadius: 8, fontFamily: "DM Sans, sans-serif", fontWeight: 600,
  fontSize: 14, cursor: "pointer",
};

// ─── Sidebar ──────────────────────────────────────────────────────────────────
// sermon-notes, notifications and mobile all exist to serve the mobile
// app (sermon notes are read only by apps/mobile; device stats and push
// have nothing to show without it) — caps.push is the only signal this
// system has for "a mobile app is actually in use here", so all three
// share that gate rather than each inventing its own.
const APP_ONLY_PAGES = new Set(["sermon-notes", "notifications", "mobile"]);

const NAV = [
  { id: "homepage", label: "Homepage", icon: "⌂" },
  { id: "staff", label: "Staff", icon: "👥" },
  { id: "pages", label: "Pages", icon: "📄" },
  { id: "sermon-notes", label: "Sermon Notes", icon: "📖" },
  { id: "notifications", label: "Push Notifications", icon: "🔔" },
  { id: "submissions", label: "Form Submissions", icon: "📬" },
  { id: "mobile", label: "Mobile App", icon: "📱" },
  { id: "navigation", label: "Navigation", icon: "☰" },
  { id: "health", label: "System Health", icon: "🩺" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

function Sidebar({ page, setPage, unread, user, onSignOut, churchName, caps }) {
  const nav = NAV.filter(n => !APP_ONLY_PAGES.has(n.id) || caps.push);
  return (
    <aside style={{
      width: 240, minHeight: "100vh", background: "var(--admin-brand)", display: "flex",
      flexDirection: "column", position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 100,
    }}>
      <div style={{ padding: "28px 24px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ fontFamily: "Playfair Display, serif", fontSize: 16, color: "#faf8f3", lineHeight: 1.3 }}>
          {churchName || "Admin"}
        </div>
        <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 3, letterSpacing: 1, textTransform: "uppercase" }}>
          Admin Panel
        </div>
      </div>
      <nav style={{ flex: 1, padding: "16px 0" }}>
        {nav.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            display: "flex", alignItems: "center", gap: 12, width: "100%",
            padding: "11px 24px", border: "none", cursor: "pointer", textAlign: "left",
            background: page === n.id ? "color-mix(in srgb, var(--admin-accent) 20%, transparent)" : "transparent",
            borderLeft: page === n.id ? "3px solid var(--admin-accent)" : "3px solid transparent",
            color: page === n.id ? "#faf8f3" : "rgba(255,255,255,0.65)",
            fontFamily: "DM Sans, sans-serif", fontSize: 14,
            transition: "all 0.15s",
          }}>
            <span style={{ fontSize: 16, opacity: 0.85 }}>{n.icon}</span>
            <span style={{ fontWeight: page === n.id ? 600 : 400 }}>{n.label}</span>
            {n.id === "submissions" && unread > 0 && (
              <span style={{ marginLeft: "auto", background: "var(--admin-accent)", color: "#fff", borderRadius: 10, padding: "1px 8px", fontSize: 11, fontWeight: 700 }}>{unread}</span>
            )}
          </button>
        ))}
      </nav>
      <div style={{ padding: "16px 24px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>Signed in as</div>
        <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#faf8f3", fontWeight: 600, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.name || user?.email || "Admin"}</div>
        {user?.email && <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>}
        <button onClick={onSignOut} style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "rgba(255,255,255,0.55)", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "5px 12px", cursor: "pointer", width: "100%" }}>Sign out</button>
      </div>
    </aside>
  );
}

// ─── Top Bar ──────────────────────────────────────────────────────────────────
function TopBar({ title, actions }) {
  return (
    <div style={{
      height: 64, background: "#fff", borderBottom: "1px solid #e8e4dd",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 32px", position: "sticky", top: 0, zIndex: 50,
    }}>
      <h1 style={{ fontFamily: "Playfair Display, serif", fontSize: 22, color: "var(--admin-brand)", margin: 0 }}>{title}</h1>
      <div style={{ display: "flex", gap: 10 }}>{actions}</div>
    </div>
  );
}

// ─── Loading / Error ──────────────────────────────────────────────────────────
function Loading() {
  return (
    <div style={{ padding: 60, textAlign: "center", color: "#999", fontFamily: "DM Sans, sans-serif" }}>
      <div style={{ fontSize: 28, marginBottom: 12 }}>⟳</div>
      Loading…
    </div>
  );
}

function ErrorMsg({ msg }) {
  return (
    <div style={{ margin: 24, padding: 20, background: "#fff5f5", border: "1.5px solid #fcc", borderRadius: 8, color: "#c0392b", fontFamily: "DM Sans, sans-serif", fontSize: 14 }}>
      ⚠ {msg || "Something went wrong. Please try again."}
    </div>
  );
}

// ─── Badge ────────────────────────────────────────────────────────────────────
function Badge({ label, color = "#e8f5e9", text = "var(--admin-brand)" }) {
  return (
    <span style={{
      background: color, color: text, padding: "3px 10px", borderRadius: 12,
      fontFamily: "DM Sans, sans-serif", fontSize: 12, fontWeight: 600,
    }}>{label}</span>
  );
}

// ─── Focal Point Picker ───────────────────────────────────────────────────────
function FocalPointPicker({ src, x, y, onChange }) {
  const imgRef = useRef();
  const fx = x ?? 50;
  const fy = y ?? 50;

  function pickFromEvent(e) {
    const rect = imgRef.current.getBoundingClientRect();
    const px = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const py = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    onChange(Math.round(px * 10) / 10, Math.round(py * 10) / 10);
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div
        ref={imgRef}
        onClick={pickFromEvent}
        style={{ position: "relative", width: "100%", maxWidth: 320, cursor: "crosshair", borderRadius: 8, overflow: "hidden", border: "1.5px solid #ddd", lineHeight: 0 }}
      >
        <img src={src} alt="" style={{ width: "100%", display: "block" }} />
        <div style={{
          position: "absolute", left: `${fx}%`, top: `${fy}%`, width: 22, height: 22,
          marginLeft: -11, marginTop: -11, borderRadius: "50%",
          border: "2.5px solid #fff", background: "color-mix(in srgb, var(--admin-accent) 85%, transparent)",
          boxShadow: "0 0 0 1.5px var(--admin-brand), 0 2px 8px rgba(0,0,0,0.45)",
          pointerEvents: "none",
        }} />
      </div>
      <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 6 }}>
        Click the image to choose what shows in the header crop ({Math.round(fx)}%, {Math.round(fy)}%)
      </div>
    </div>
  );
}

// ─── WYSIWYG Editor ───────────────────────────────────────────────────────────
function WYSIWYGEditor({ value, onChange, sermonsMode, caps, toast }) {
  const editorRef = useRef();
  const internalValue = useRef(value);
  const fileInputRef = useRef();
  const savedRangeRef = useRef(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = value;
  }, []);

  useEffect(() => {
    if (editorRef.current && value !== internalValue.current) {
      editorRef.current.innerHTML = value;
      internalValue.current = value;
    }
  }, [value]);

  function exec(cmd, val) {
    editorRef.current.focus();
    document.execCommand(cmd, false, val || null);
  }

  function captureSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editorRef.current.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }

  function applyInlineStyle(styleProp, value) {
    editorRef.current.focus();
    const sel = window.getSelection();
    if (savedRangeRef.current) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
    }
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (toast) toast("Select some text first", "error"); else alert("Select some text first");
      return;
    }
    const range = sel.getRangeAt(0);
    const span = document.createElement("span");
    span.style[styleProp] = value;
    try {
      range.surroundContents(span);
    } catch {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    // Clear any conflicting inline style on nested elements (e.g. a previously
    // applied font) so this new wrap actually takes effect instead of being
    // overridden by a more deeply nested inline style.
    span.querySelectorAll("*").forEach(el => {
      if (el.style && el.style[styleProp]) {
        el.style[styleProp] = "";
        if (!el.getAttribute("style")) el.removeAttribute("style");
      }
    });
    sel.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.addRange(newRange);
    onChange(editorRef.current.innerHTML);
  }

  // Chrome's execCommand('insertHTML') silently strips class and data-*
  // attributes from the HTML it's given — proven by reproducing it
  // directly: a <span class="sn-blank" data-answer="…"> survives the round
  // trip as a bare <span style="…"> with neither attribute, because
  // execCommand runs inserted markup through its own formatting-only
  // sanitizer rather than inserting it verbatim. inline style and
  // attributes like href/src pass through fine (that's why the old
  // <input class="blank-field"> and image insertion never hit this), but
  // sn-blank and sn-scripture both depend on class/data-* surviving, so
  // they build the node directly and place it with Range/Selection
  // instead — the same approach the original <input> insertion already
  // used, for the same reason.
  function insertNodeAtSelection(node) {
    editorRef.current.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editorRef.current.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // The real answer is the span's own text — visible here in the editor so
  // it can be read and edited normally. It's only masked to a same-length
  // blank, and only revealed one tap at a time, when the note is actually
  // viewed (see packages/config/src/sermon-notes.mjs). Storing an empty
  // input for the reader to guess into, which is what this used to do,
  // isn't a "hidden real value" at all.
  function insertFillinBlank() {
    const answer = prompt("Answer (hidden from readers until tapped):");
    if (!answer) return;
    const span = document.createElement("span");
    span.className = "sn-blank";
    span.setAttribute("data-answer", answer);
    span.textContent = answer;
    insertNodeAtSelection(span);
    onChange(editorRef.current.innerHTML);
  }

  // Only the reference and lookup params are stored — never the verse
  // text itself. The text is fetched live from /api/bible/text every time
  // a reader taps the reference, so it can't go stale and never needs
  // re-typing if a translation is corrected. An unrecognized reference
  // inserts nothing rather than guessing at one — see CLAUDE.md on why a
  // wrong fallback is worse than none.
  function insertScriptureBlock() {
    const ref = prompt("Scripture reference (e.g. John 3:16 or John 3:16-18):");
    if (!ref) return;
    const parsed = parseBibleReference(ref);
    if (!parsed) {
      if (toast) toast("Could not recognize that reference", "error"); else alert("Could not recognize that reference");
      return;
    }
    const { book, chapter, startVerse, endVerse } = parsed;
    const translation = "NIV";
    const link = document.createElement("a");
    link.href = "#";
    link.className = "sn-scripture";
    link.setAttribute("data-ref", ref);
    link.setAttribute("data-translation", translation);
    link.setAttribute("data-usfm", book.usfm);
    link.setAttribute("data-chapter", String(chapter));
    link.setAttribute("data-start-verse", startVerse != null ? String(startVerse) : "");
    link.setAttribute("data-end-verse", endVerse != null ? String(endVerse) : "");
    link.textContent = `📖 ${ref}`;
    insertNodeAtSelection(link);
    onChange(editorRef.current.innerHTML);
  }

  function insertMainPoint() {
    exec("insertHTML", `<div style="border-left:5px solid var(--admin-brand);padding:14px 20px;margin:16px 0;background:#f0f5f0;font-weight:600;color:var(--admin-brand);font-family:DM Sans,sans-serif">Main Point: </div>`);
    onChange(editorRef.current.innerHTML);
  }

  function openImagePicker() {
    const sel = window.getSelection();
    savedRangeRef.current = (sel && sel.rangeCount > 0 && editorRef.current.contains(sel.anchorNode))
      ? sel.getRangeAt(0).cloneRange()
      : null;
    fileInputRef.current.click();
  }

  async function handleImageUpload(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    setUploadingImage(true);
    try {
      const res = await fetch(`${API}/api/admin/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error();
      const { url } = await res.json();
      editorRef.current.focus();
      const sel = window.getSelection();
      if (savedRangeRef.current) {
        sel.removeAllRanges();
        sel.addRange(savedRangeRef.current);
      }
      exec("insertHTML", `<img src="${url}" alt="" style="max-width:100%;border-radius:6px;margin:12px 0" />`);
      onChange(editorRef.current.innerHTML);
    } catch {
      if (toast) toast("Image upload failed", "error"); else alert("Image upload failed");
    } finally {
      setUploadingImage(false);
      fileInputRef.current.value = "";
    }
  }

  const toolBtn = (label, action, tip, disabled) => (
    <button title={tip} onClick={action} disabled={disabled} style={{
      border: "1px solid #ddd", background: disabled ? "#f5f5f5" : "#fff", padding: "5px 10px",
      cursor: disabled ? "not-allowed" : "pointer", borderRadius: 5, fontFamily: "DM Sans, sans-serif",
      fontSize: 12, color: disabled ? "#aaa" : "#333",
    }}>{label}</button>
  );

  const sep = <div style={{ width: 1, background: "#ddd", margin: "2px 4px" }} />;

  const selectStyle = {
    border: "1px solid #ddd", background: "#fff", borderRadius: 5,
    fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#333",
    padding: "5px 6px", cursor: "pointer",
  };

  const FONT_FAMILIES = [
    { label: "Cormorant Garamond", value: "'Cormorant Garamond', serif" },
    { label: "Roboto", value: "'Roboto', sans-serif" },
    { label: "Couture", value: "'Couture', 'Roboto', sans-serif" },
    { label: "Christian Heedlay", value: "'Christian Heedlay', cursive" },
  ];

  const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40];

  return (
    <div style={{ border: "1.5px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ background: "#f7f5f0", borderBottom: "1px solid #ddd", padding: "8px 10px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
        <select
          title="Font Family"
          defaultValue=""
          onMouseDown={captureSelection}
          onChange={e => { if (e.target.value) applyInlineStyle("fontFamily", e.target.value); e.target.value = ""; }}
          style={selectStyle}
        >
          <option value="">Font…</option>
          {FONT_FAMILIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select
          title="Font Size"
          defaultValue=""
          onMouseDown={captureSelection}
          onChange={e => { if (e.target.value) applyInlineStyle("fontSize", `${e.target.value}px`); e.target.value = ""; }}
          style={selectStyle}
        >
          <option value="">Size…</option>
          {FONT_SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
        </select>
        {sep}
        {toolBtn("B", () => exec("bold"), "Bold")}
        {toolBtn("I", () => exec("italic"), "Italic")}
        {toolBtn("U", () => exec("underline"), "Underline")}
        {toolBtn("S", () => exec("strikeThrough"), "Strikethrough")}
        {sep}
        {toolBtn("H1", () => exec("formatBlock", "h1"), "Heading 1")}
        {toolBtn("H2", () => exec("formatBlock", "h2"), "Heading 2")}
        {toolBtn("H3", () => exec("formatBlock", "h3"), "Heading 3")}
        {toolBtn("¶", () => exec("formatBlock", "p"), "Paragraph")}
        {sep}
        {toolBtn("Left", () => exec("justifyLeft"), "Align Left")}
        {toolBtn("Center", () => exec("justifyCenter"), "Align Center")}
        {toolBtn("Right", () => exec("justifyRight"), "Align Right")}
        {toolBtn("Justify", () => exec("justifyFull"), "Justify")}
        {sep}
        {toolBtn("• List", () => exec("insertUnorderedList"), "Bullet List")}
        {toolBtn("1. List", () => exec("insertOrderedList"), "Numbered List")}
        {toolBtn("❝", () => exec("formatBlock", "blockquote"), "Blockquote")}
        {sep}
        <input type="color" title="Text Color" onChange={e => exec("foreColor", e.target.value)} style={{ width: 28, height: 28, padding: 0, border: "1px solid #ddd", borderRadius: 5, cursor: "pointer", background: "#fff" }} />
        <input type="color" title="Highlight Color" defaultValue="#fff59d" onChange={e => exec("hiliteColor", e.target.value)} style={{ width: 28, height: 28, padding: 0, border: "1px solid #ddd", borderRadius: 5, cursor: "pointer", background: "#fff" }} />
        {toolBtn("x₂", () => exec("subscript"), "Subscript")}
        {toolBtn("x²", () => exec("superscript"), "Superscript")}
        {toolBtn("⌫", () => exec("removeFormat"), "Clear Formatting")}
        {sep}
        {toolBtn("↶", () => exec("undo"), "Undo")}
        {toolBtn("↷", () => exec("redo"), "Redo")}
        {sep}
        {toolBtn("🔗", () => { const u = prompt("URL:"); u && exec("createLink", u); }, "Link")}
        {toolBtn(uploadingImage ? "Uploading…" : "🖼 Image", openImagePicker, "Insert image")}
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => handleImageUpload(e.target.files[0])} />
        {sermonsMode && <>
          {toolBtn("Fill in Blank", insertFillinBlank, "Insert a hidden-answer blank readers tap to reveal")}
          {toolBtn(
            "📖 Scripture",
            insertScriptureBlock,
            caps?.bible ? "Insert a tappable scripture reference" : "Set BIBLE_API_KEY or BIBLE_BRAIN_API_KEY to enable scripture lookups",
            !caps?.bible
          )}
          {toolBtn("★ Main Point", insertMainPoint, "Insert main point block")}
        </>}
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={e => {
          internalValue.current = e.currentTarget.innerHTML;
          onChange(e.currentTarget.innerHTML);
        }}
        style={{
          minHeight: 300, padding: 20, outline: "none",
          fontFamily: "Source Serif 4, serif", fontSize: 16, lineHeight: 1.7,
          color: "#222", background: "#fff",
        }}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Homepage
// ════════════════════════════════════════════════════════════════════════════════
// Every piece of homepage copy that isn't already church-specific data
// (name, tagline, service times, ...) — keep in sync with the `text`
// object in apps/web/src/pages/index.astro, which has these same keys and
// defaults. Left blank here, the site renders the default shown as a
// placeholder.
const HOME_TEXT_GROUPS = [
  { title: "Hero & Live Banner", fields: [
    ["Live Stream Banner", "home_live_banner_text", "We're live right now — click here to watch the live stream"],
    ["Hero Primary Button", "home_hero_cta_primary", "Plan Your Visit"],
    ["Hero Secondary Button", "home_hero_cta_secondary", "Learn More"],
  ]},
  { title: "Featured Event Strip", fields: [
    ["Eyebrow Label", "home_featured_event_eyebrow", "Featured Event"],
    ["Fallback Event Name", "home_featured_event_fallback_name", "Upcoming Event"],
    ["Register Button", "home_featured_event_cta", "Register Now →"],
  ]},
  { title: "Latest Sermon", fields: [
    ["Eyebrow Label", "home_sermon_eyebrow", "Latest Message"],
    ["Fallback Title", "home_sermon_fallback_title", "Sunday Service"],
    ["Watch Button", "home_sermon_cta_watch", "Watch Now"],
    ["Browse Button", "home_sermon_cta_browse", "Browse All Messages"],
  ]},
  { title: "Our Vision", fields: [
    ["Eyebrow Label", "home_vision_eyebrow", "Our Vision"],
    ["Heading", "home_vision_heading", "Believe · Belong · Become"],
    ["Pillar 1 Title", "home_pillar1_title", "Believe in God"],
    ["Pillar 1 Body", "home_pillar1_body", "Our walk of faith starts with knowing God through Jesus, spending time in His Word, in prayer, and in worship.", true],
    ["Pillar 2 Title", "home_pillar2_title", "Belong to Community"],
    ["Pillar 2 Body", "home_pillar2_body", "The Christian life isn't meant to be lived alone. We gather together so we can grow together in genuine community.", true],
    ["Pillar 3 Title", "home_pillar3_title", "Become like Jesus"],
    ["Pillar 3 Body", "home_pillar3_body", "We become like Jesus when we love and serve who Jesus loves: the Church, our communities, and the world.", true],
  ]},
  { title: "Upcoming Events", fields: [
    ["Eyebrow Label", "home_events_eyebrow", "What's Coming Up"],
    ["Heading", "home_events_heading", "Upcoming Events"],
    ["See All Button", "home_events_cta", "See All Events"],
    ["Register Label", "home_event_register_label", "Register →"],
    ["Free Label", "home_event_free_label", "Free"],
  ]},
  { title: "Gathering Times & Find Us", fields: [
    ["Gathering Times Heading", "home_gathering_heading", "Gathering Times"],
    ["Gathering CTA", "home_gathering_cta", "Plan My Visit"],
    ["Find Us Heading", "home_findus_heading", "Find Us"],
    ["Get Directions Button", "home_findus_cta", "Get Directions"],
  ]},
  { title: "Connect With Us", fields: [
    ["Heading", "home_connect_heading", "Connect With Us"],
    ["Body", "home_connect_body", "New here? We'd love to meet you. Fill out a connect card and our team will reach out.", true],
    ["Button 1", "home_connect_cta1", "Fill Out a Connect Card"],
    ["Button 2", "home_connect_cta2", "I'm New Here"],
    ["Button 3", "home_connect_cta3", "Share a Prayer Request"],
  ]},
];

// [id, "Name — description"] pairs for the layout picker, from
// @churchkit/config's single definition — see font-presets.mjs's own
// comment for why this isn't a second copy hand-maintained here.
const HOME_LAYOUTS = listHomeLayouts();

function HomepagePage({ toast, caps }) {
  const [slides, setSlides] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({});
  const [imgPreview, setImgPreview] = useState(null);
  const [featuredId, setFeaturedId] = useState(null);
  const [homeText, setHomeText] = useState({});
  const [savingText, setSavingText] = useState(false);

  useEffect(() => {
    Promise.all([
      api("/api/admin/carousel").then(r => r.json()).catch(() => ({})),
      api("/api/admin/pco-events").then(r => r.json()).catch(() => ({})),
      api("/api/admin/settings").then(r => r.json()).catch(() => ({})),
    ]).then(([c, e, s]) => {
      setSlides(Array.isArray(c?.data) ? c.data : []);
      setEvents(Array.isArray(e?.data) ? e.data : []);
      setFeaturedId(s?.data?.featured_event_id || null);
      setHomeText(s?.data || {});
    }).finally(() => setLoading(false));
  }, []);

  const setText = (key, val) => setHomeText(t => ({ ...t, [key]: val }));

  async function saveHomeText() {
    setSavingText(true);
    try {
      const payload = Object.fromEntries(HOME_TEXT_GROUPS.flatMap(g => g.fields).map(([, key]) => [key, homeText[key] || ""]));
      const res = await api("/api/admin/settings", { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) throw new Error("Save failed");
      toast("Homepage text saved");
    } catch {
      toast("Save failed", "error");
    } finally {
      setSavingText(false);
    }
  }

  function openEdit(slide) {
    setForm(slide || { headline: "", subtext: "", button_label: "", button_link: "", image_url: "" });
    setImgPreview(slide?.image_url || null);
    setModal(slide ? "edit" : "new");
  }

  async function handleImageUpload(file) {
    if (!file) return;
    const preview = URL.createObjectURL(file);
    setImgPreview(preview);
    const fd = new FormData();
    fd.append("file", file);
    setUploading(true);
    try {
      const res = await fetch(`${API}/api/admin/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { url } = await res.json();
      setForm(f => ({ ...f, image_url: url }));
    } catch {
      toast("Image upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function saveSlide() {
    if (!form.headline) return toast("Headline is required", "error");
    setSaving(true);
    const updated = modal === "new"
      ? [...slides, { ...form, sort_order: slides.length }]
      : slides.map(s => s.sort_order === form.sort_order ? form : s);
    try {
      const res = await api("/api/admin/carousel", { method: "POST", body: JSON.stringify({ slides: updated }) });
      if (!res.ok) throw new Error("Save failed");
      setSlides(updated);
      setModal(null);
      toast("Carousel saved");
    } catch {
      toast("Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function setFeatured(id) {
    setFeaturedId(id);
    try {
      await api("/api/admin/featured-event", { method: "POST", body: JSON.stringify({ featured_event_id: id }) });
      toast("Featured event updated");
    } catch {
      toast("Failed to set featured event", "error");
    }
  }

  // Saves immediately on selection rather than waiting for "Save Homepage
  // Text" below — a layout choice is a single discrete decision, not a
  // batch of prose a church drafts and revises before committing.
  async function setLayout(id) {
    setText("home_layout", id);
    try {
      await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ home_layout: id }) });
      toast("Homepage layout updated");
    } catch {
      toast("Failed to update layout", "error");
    }
  }

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 32 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
        {/* Carousel */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 18, color: "var(--admin-brand)", margin: 0 }}>Carousel Slides</h2>
            <button onClick={() => openEdit(null)} style={btnPrimary}>+ Add Slide</button>
          </div>
          {slides.length === 0 && <div style={{ color: "#aaa", fontFamily: "DM Sans, sans-serif", fontSize: 14, padding: "20px 0" }}>No slides yet.</div>}
          {slides.map((s, i) => (
            <div key={i} style={{ background: "#fff", border: "1px solid #e8e4dd", borderRadius: 10, padding: 16, marginBottom: 12, display: "flex", gap: 14, alignItems: "center" }}>
              {s.image_url && <img src={s.image_url} alt="" style={{ width: 80, height: 52, objectFit: "cover", borderRadius: 6 }} />}
              <div style={{ flex: 1, fontFamily: "DM Sans, sans-serif" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#222" }}>{s.headline}</div>
                <div style={{ fontSize: 12, color: "#888" }}>{s.subtext}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => openEdit(s)} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 12 }}>Edit</button>
                <button onClick={() => setSlides(slides.filter((_, j) => j !== i))} style={{ border: "1px solid #fcc", background: "#fff", color: "#c0392b", padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "DM Sans, sans-serif" }}>✕</button>
              </div>
            </div>
          ))}
          <button onClick={async () => { setSaving(true); try { const res = await api("/api/admin/carousel", { method: "POST", body: JSON.stringify({ slides }) }); if (!res.ok) throw new Error(); toast("Carousel order saved"); } catch { toast("Save failed", "error"); } finally { setSaving(false); } }} style={{ ...btnPrimary, marginTop: 8 }}>
            {saving ? "Saving…" : "Save Order"}
          </button>
        </div>

        {/* Featured Event */}
        <div>
          <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 18, color: "var(--admin-brand)", margin: "0 0 16px" }}>Featured Event</h2>
          {events.length === 0 && <div style={{ color: "#aaa", fontFamily: "DM Sans, sans-serif", fontSize: 14 }}>No upcoming events found.</div>}
          {events.map(ev => (
            <div key={ev.id} onClick={() => setFeatured(ev.id)} style={{
              background: featuredId === ev.id ? "#f0f7ef" : "#fff",
              border: featuredId === ev.id ? "1.5px solid var(--admin-brand)" : "1px solid #e8e4dd",
              borderRadius: 10, padding: "14px 18px", marginBottom: 10, cursor: "pointer",
              fontFamily: "DM Sans, sans-serif", transition: "all 0.15s",
            }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#222" }}>{ev.name}</div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 3 }}>{fmtDate(ev.starts_at)}</div>
              {featuredId === ev.id && <div style={{ fontSize: 12, color: "var(--admin-brand)", fontWeight: 600, marginTop: 4 }}>★ Currently Featured</div>}
            </div>
          ))}
        </div>
      </div>

      {/*
        Which order the hero's five content blocks render in — the hero
        itself and the footer always frame the page, so only what's between
        them moves. A church with no events or sermon configured yet won't
        see a visible difference until that content exists; the order is
        still saved for when it does.
      */}
      <div style={{ marginTop: 32, background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", padding: 24 }}>
        <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 18, color: "var(--admin-brand)", margin: "0 0 16px" }}>Homepage Layout</h2>
        <Field label="Section order">
          <select style={inputStyle} value={homeText.home_layout || "classic"} onChange={e => setLayout(e.target.value)}>
            {HOME_LAYOUTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </Field>
      </div>

      {/*
        Everything on the homepage that isn't already church data (name,
        address, service times) but still isn't code — labels, button
        text, the Vision/pillars prose. Blank means "use the default shown
        as a placeholder," so a church that never opens this still gets a
        working homepage.
      */}
      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 18, color: "var(--admin-brand)", margin: "0 0 16px" }}>Homepage Text</h2>
        {HOME_TEXT_GROUPS.map(group => (
          <div key={group.title} style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", padding: 24, marginBottom: 16 }}>
            <h3 style={{ fontFamily: "Playfair Display, serif", fontSize: 15, color: "var(--admin-brand)", margin: "0 0 16px", paddingBottom: 10, borderBottom: "1px solid #f0ece4" }}>{group.title}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {group.fields.map(([label, key, fallback, multiline]) => (
                <Field key={key} label={label} style={multiline ? { gridColumn: "span 2" } : undefined}>
                  {multiline
                    ? <textarea style={{ ...inputStyle, minHeight: 70 }} value={homeText[key] || ""} onChange={e => setText(key, e.target.value)} placeholder={fallback} />
                    : <input style={inputStyle} value={homeText[key] || ""} onChange={e => setText(key, e.target.value)} placeholder={fallback} />}
                </Field>
              ))}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveHomeText} style={btnPrimary} disabled={savingText}>{savingText ? "Saving…" : "Save Homepage Text"}</button>
        </div>
      </div>

      {(modal === "new" || modal === "edit") && (
        <Modal title={modal === "new" ? "Add Carousel Slide" : "Edit Slide"} onClose={() => setModal(null)}>
          <Field label="Headline" required>
            <input style={inputStyle} value={form.headline || ""} onChange={e => setForm(f => ({ ...f, headline: e.target.value }))} />
          </Field>
          <Field label="Subtext">
            <input style={inputStyle} value={form.subtext || ""} onChange={e => setForm(f => ({ ...f, subtext: e.target.value }))} />
          </Field>
          <Field label="Button Label">
            <input style={inputStyle} value={form.button_label || ""} onChange={e => setForm(f => ({ ...f, button_label: e.target.value }))} />
          </Field>
          <Field label="Button Link">
            <input style={inputStyle} value={form.button_link || ""} onChange={e => setForm(f => ({ ...f, button_link: e.target.value }))} />
          </Field>
          <Field label="Image">
            {caps.mediaUploads ? (
              <>
                <input type="file" accept="image/*" onChange={e => handleImageUpload(e.target.files[0])} style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13 }} />
                {uploading && <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888", marginTop: 6 }}>Uploading…</div>}
                {imgPreview && !uploading && <img src={imgPreview} alt="" style={{ marginTop: 10, maxWidth: "100%", height: 140, objectFit: "cover", borderRadius: 8 }} />}
              </>
            ) : (
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>Configure media storage to enable image uploads.</div>
            )}
          </Field>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
            <button onClick={() => setModal(null)} style={btnSecondary}>Cancel</button>
            <button onClick={saveSlide} style={btnPrimary} disabled={saving || uploading}>{uploading ? "Uploading…" : saving ? "Saving…" : "Save Slide"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Staff
// ════════════════════════════════════════════════════════════════════════════════
function StaffPage({ toast, caps }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [imgPreview, setImgPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api("/api/admin/staff").then(r => r.json()).then(d => setStaff(Array.isArray(d?.data) ? d.data : [])).catch(() => setStaff([])).finally(() => setLoading(false));
  }, []);

  function openEdit(member) {
    setForm(member || { name: "", title: "", email: "", bio: "", photo_url: "", active: true });
    setImgPreview(member?.photo_url || null);
    setModal(member ? "edit" : "new");
  }

  async function handlePhoto(file) {
    if (!file) return;
    setImgPreview(URL.createObjectURL(file));
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API}/api/admin/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error();
      const { url } = await res.json();
      setForm(f => ({ ...f, photo_url: url }));
    } catch { toast("Photo upload failed", "error"); }
  }

  async function saveMember() {
    if (!form.name) return toast("Name is required", "error");
    setSaving(true);
    try {
      if (form.id) {
        await api(`/api/admin/staff/${form.id}`, { method: "PUT", body: JSON.stringify(form) });
        setStaff(s => s.map(m => m.id === form.id ? form : m));
      } else {
        const res = await api("/api/admin/staff", { method: "POST", body: JSON.stringify(form) });
        const { id } = await res.json();
        setStaff(s => [...s, { ...form, id }]);
      }
      setModal(null);
      toast("Staff member saved");
    } catch { toast("Save failed", "error"); } finally { setSaving(false); }
  }

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 32 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 24 }}>
        <button onClick={() => openEdit(null)} style={btnPrimary}>+ Add Staff Member</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 20 }}>
        {staff.map(m => (
          <div key={m.id} style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", overflow: "hidden" }}>
            <div style={{ position: "relative", height: 180, background: "#f0ece4", cursor: "pointer" }} onClick={() => openEdit(m)}>
              {m.photo_url
                ? <img src={m.photo_url} alt={m.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 48, color: "#ccc" }}>👤</div>
              }
              <div style={{ position: "absolute", inset: 0, background: "color-mix(in srgb, var(--admin-brand) 85%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0, transition: "opacity 0.2s" }}
                onMouseEnter={e => e.currentTarget.style.opacity = 1}
                onMouseLeave={e => e.currentTarget.style.opacity = 0}>
                <span style={{ color: "#fff", fontFamily: "DM Sans, sans-serif", fontSize: 13, fontWeight: 600 }}>Change Photo</span>
              </div>
            </div>
            <div style={{ padding: "14px 16px" }}>
              <div style={{ fontFamily: "Playfair Display, serif", fontSize: 15, color: "#222" }}>{m.name}</div>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 2 }}>{m.title}</div>
              <button onClick={() => openEdit(m)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 12, marginTop: 10 }}>Edit</button>
            </div>
          </div>
        ))}
        {staff.length === 0 && <div style={{ color: "#aaa", fontFamily: "DM Sans, sans-serif", fontSize: 14 }}>No staff members yet.</div>}
      </div>

      {(modal === "new" || modal === "edit") && (
        <Modal title={modal === "new" ? "Add Staff Member" : "Edit Staff Member"} onClose={() => setModal(null)}>
          <Field label="Full Name" required>
            <input style={inputStyle} value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </Field>
          <Field label="Title">
            <input style={inputStyle} value={form.title || ""} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          </Field>
          <Field label="Email">
            <input type="email" style={inputStyle} value={form.email || ""} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          </Field>
          <Field label="Bio">
            <textarea style={{ ...inputStyle, height: 90, resize: "vertical" }} value={form.bio || ""} onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} />
          </Field>
          <Field label="Photo">
            {caps.mediaUploads ? (
              <input type="file" accept="image/*" onChange={e => handlePhoto(e.target.files[0])} style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13 }} />
            ) : (
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>Configure media storage to enable photo uploads.</div>
            )}
            {imgPreview && <img src={imgPreview} alt="" style={{ marginTop: 10, width: 80, height: 80, objectFit: "cover", borderRadius: "50%" }} />}
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "DM Sans, sans-serif", fontSize: 14 }}>
              <input type="checkbox" checked={!!form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
              Show on website
            </label>
          </Field>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
            <button onClick={() => setModal(null)} style={btnSecondary}>Cancel</button>
            <button onClick={saveMember} style={btnPrimary} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Ministry Pages
// ════════════════════════════════════════════════════════════════════════════════
function PagesPage({ toast, siteUrl, caps }) {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [newPageModal, setNewPageModal] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [imgPreview, setImgPreview] = useState(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState({});

  async function handleGalleryImage(slotNum, file) {
    if (!file) return;
    const key = `gallery_image_${slotNum}`;
    setUploadingGallery(u => ({ ...u, [slotNum]: true }));
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API}/api/admin/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error();
      const { url } = await res.json();
      setEditing(ed => ({ ...ed, [key]: url }));
    } catch { toast("Image upload failed", "error"); } finally {
      setUploadingGallery(u => ({ ...u, [slotNum]: false }));
    }
  }

  function removeGalleryImage(slotNum) {
    setEditing(ed => ({ ...ed, [`gallery_image_${slotNum}`]: "" }));
  }

  async function handleHeaderImage(file) {
    if (!file) return;
    setImgPreview(URL.createObjectURL(file));
    setUploadingImg(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API}/api/admin/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error();
      const { url } = await res.json();
      setEditing(ed => ({ ...ed, image_url: url, image_focal_x: 50, image_focal_y: 50 }));
    } catch { toast("Image upload failed", "error"); } finally { setUploadingImg(false); }
  }

  useEffect(() => {
    api("/api/admin/pages").then(r => r.json()).then(d => setPages(Array.isArray(d?.data) ? d.data : [])).catch(() => setPages([])).finally(() => setLoading(false));
  }, []);

  async function openEditor(slug) {
    setEditing({
      slug, title: "", sub_title: "", subtext: "", html: "", image_url: "", image_focal_x: 50, image_focal_y: 50,
      gallery_image_1: "", gallery_image_2: "", gallery_image_3: "", published: true,
      is_ministry: false, sort_order: 0,
    });
    setImgPreview(null);
    setEditorLoading(true);
    try {
      const res = await api(`/api/admin/pages/${slug}`);
      const d = await res.json();
      const page = d?.data || d;
      setEditing({
        slug, title: page.title || "", sub_title: page.sub_title || "", subtext: page.subtext || "",
        html: page.content_html || page.html || "", image_url: page.image_url || "",
        image_focal_x: page.image_focal_x ?? 50, image_focal_y: page.image_focal_y ?? 50,
        gallery_image_1: page.gallery_image_1 || "", gallery_image_2: page.gallery_image_2 || "", gallery_image_3: page.gallery_image_3 || "",
        published: (page.status || "published") !== "draft",
        is_ministry: !!page.is_ministry, sort_order: page.sort_order ?? 0,
      });
      setImgPreview(page.image_url || null);
    } catch { /* keep defaults */ } finally { setEditorLoading(false); }
  }

  async function save() {
    setSaving(true);
    try {
      await api(`/api/admin/pages/${editing.slug}`, {
        method: "POST",
        body: JSON.stringify({
          title: editing.title, sub_title: editing.sub_title, subtext: editing.subtext, content_html: editing.html,
          image_url: editing.image_url, image_focal_x: editing.image_focal_x, image_focal_y: editing.image_focal_y,
          gallery_image_1: editing.gallery_image_1 || null, gallery_image_2: editing.gallery_image_2 || null, gallery_image_3: editing.gallery_image_3 || null,
          is_ministry: editing.is_ministry ? 1 : 0,
          sort_order: Number(editing.sort_order) || 0,
          status: editing.published ? "published" : "draft",
        }),
      });
      setPages(ps => ps.map(p => p.slug === editing.slug ? { ...p, title: editing.title, sub_title: editing.sub_title, subtext: editing.subtext, image_url: editing.image_url, status: editing.published ? "published" : "draft" } : p));
      toast("Page saved");
    } catch { toast("Save failed", "error"); } finally { setSaving(false); }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api(`/api/admin/pages/${deleteTarget}`, { method: "DELETE" });
      setPages(ps => ps.filter(p => p.slug !== deleteTarget));
      setDeleteTarget(null);
      toast("Page deleted");
    } catch { toast("Delete failed", "error"); } finally { setDeleting(false); }
  }

  async function createPage() {
    const slug = newSlug.trim().toLowerCase().replace(/\s+/g, "-");
    if (!slug) return toast("Slug is required", "error");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return toast("Slug can only contain lowercase letters, numbers and hyphens", "error");
    }
    if (RESERVED_SLUGS.has(slug)) {
      return toast(`"${slug}" is used by the site itself — choose another name`, "error");
    }
    if (pages.some(p => p.slug === slug)) {
      return toast(`A page called "${slug}" already exists`, "error");
    }
    setCreating(true);
    try {
      await api(`/api/admin/pages/${slug}`, {
        method: "POST",
        body: JSON.stringify({ title: "", subtext: "", content_html: "", status: "draft" }),
      });
      const newPage = { slug, title: "", subtext: "", status: "draft" };
      setPages(ps => [...ps, newPage]);
      setNewPageModal(false);
      setNewSlug("");
      toast("Page created");
      openEditor(slug);
    } catch { toast("Create failed", "error"); } finally { setCreating(false); }
  }

  if (editing) {
    return (
      <div style={{ padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
          <button onClick={() => setEditing(null)} style={{ ...btnSecondary, padding: "7px 14px", fontSize: 13 }}>← Back</button>
          <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 20, color: "var(--admin-brand)", margin: 0 }}>{editing.title || editing.slug}</h2>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "DM Sans, sans-serif", fontSize: 14, color: "#444" }}>
              <input type="checkbox" checked={editing.published} onChange={e => setEditing(ed => ({ ...ed, published: e.target.checked }))} />
              Published
            </label>
            {siteUrl && (
              <button onClick={() => window.open(`${siteUrl.replace(/\/+$/, "")}/${editing.slug}`, "_blank")} style={{ ...btnSecondary, padding: "8px 16px", fontSize: 13 }}>Preview ↗</button>
            )}
            <button onClick={save} style={btnPrimary} disabled={saving}>{saving ? "Saving…" : "Save Page"}</button>
          </div>
        </div>
        {editorLoading ? <Loading /> : (
          <>
            <Field label="Title">
              <input style={inputStyle} value={editing.title} onChange={e => setEditing(ed => ({ ...ed, title: e.target.value }))} placeholder="Page title" />
            </Field>
            <Field label="Sub Title">
              <input style={inputStyle} value={editing.sub_title || ""} onChange={e => setEditing(ed => ({ ...ed, sub_title: e.target.value }))} placeholder="Secondary heading shown on the page" />
            </Field>
            <Field label="Subtext">
              <input style={inputStyle} value={editing.subtext} onChange={e => setEditing(ed => ({ ...ed, subtext: e.target.value }))} placeholder="Short description shown on cards and under the title" />
            </Field>
            {/*
              What makes a page a ministry. There is no fixed list of
              ministries anywhere in ChurchKit — a church decides here which
              of its pages appear on the ministries index and in the site
              menu, and in what order.
            */}
            <Field label="Ministry">
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "DM Sans, sans-serif", fontSize: 14, color: "#333" }}>
                <input
                  type="checkbox"
                  checked={!!editing.is_ministry}
                  onChange={e => setEditing(ed => ({ ...ed, is_ministry: e.target.checked ? 1 : 0 }))}
                />
                <span>Show this page under Ministries, and in the site menu</span>
              </label>
            </Field>
            <Field label="Sort Order">
              <input
                type="number"
                style={{ ...inputStyle, maxWidth: 140 }}
                value={editing.sort_order ?? 0}
                onChange={e => setEditing(ed => ({ ...ed, sort_order: Number(e.target.value) || 0 }))}
              />
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 6 }}>
                Lower numbers appear first.
              </div>
            </Field>
            <Field label="Header Image">
              {caps.mediaUploads ? (
                <input type="file" accept="image/*" onChange={e => handleHeaderImage(e.target.files[0])} style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13 }} />
              ) : (
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>Configure media storage to enable image uploads.</div>
              )}
              {uploadingImg && <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 6 }}>Uploading…</div>}
              {imgPreview && !uploadingImg && (
                <FocalPointPicker
                  src={imgPreview}
                  x={editing.image_focal_x}
                  y={editing.image_focal_y}
                  onChange={(x, y) => setEditing(ed => ({ ...ed, image_focal_x: x, image_focal_y: y }))}
                />
              )}
            </Field>
            <div style={{ marginBottom: 8, fontFamily: "DM Sans, sans-serif", fontSize: 13, fontWeight: 600, color: "#444" }}>Body</div>
            <WYSIWYGEditor value={editing.html} onChange={html => setEditing(ed => ({ ...ed, html }))} toast={toast} />

            <div style={{ marginTop: 28 }}>
              <Field label="Gallery Images (shown below the body)">
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {[1, 2, 3].map(n => {
                    const key = `gallery_image_${n}`;
                    const url = editing[key];
                    const uploading = !!uploadingGallery[n];
                    return (
                      <div key={n} style={{ width: 140 }}>
                        <div style={{
                          width: 140, height: 100, borderRadius: 8, overflow: "hidden",
                          background: "#f0ece4", display: "flex", alignItems: "center", justifyContent: "center",
                          border: "1.5px solid #ddd",
                        }}>
                          {uploading ? (
                            <span style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888" }}>Uploading…</span>
                          ) : url ? (
                            <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <span style={{ fontSize: 22, color: "#ccc" }}>🖼</span>
                          )}
                        </div>
                        {caps.mediaUploads ? (
                          <label style={{
                            display: "block", marginTop: 6, textAlign: "center", fontSize: 12, fontFamily: "DM Sans, sans-serif",
                            color: "var(--admin-brand)", cursor: "pointer", border: "1px solid var(--admin-brand)", borderRadius: 6, padding: "5px 0",
                          }}>
                            {url ? "Replace" : "Upload"}
                            <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => handleGalleryImage(n, e.target.files[0])} />
                          </label>
                        ) : (
                          <div style={{
                            marginTop: 6, textAlign: "center", fontSize: 11, fontFamily: "DM Sans, sans-serif", color: "#aaa",
                          }}>
                            Uploads unavailable
                          </div>
                        )}
                        {url && !uploading && (
                          <button onClick={() => removeGalleryImage(n)} style={{
                            width: "100%", marginTop: 4, background: "transparent", border: "none",
                            color: "#c0392b", fontSize: 12, fontFamily: "DM Sans, sans-serif", cursor: "pointer",
                          }}>Remove</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Field>
            </div>
          </>
        )}
      </div>
    );
  }

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 32 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <button onClick={() => { setNewSlug(""); setNewPageModal(true); }} style={btnPrimary}>+ New Page</button>
      </div>
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", overflow: "hidden" }}>
        {pages.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#aaa", fontFamily: "DM Sans, sans-serif" }}>No pages yet. Create one above.</div>}
        {pages.map((pg, i) => (
          <div key={pg.slug} style={{
            display: "flex", alignItems: "center", padding: "16px 24px",
            borderBottom: i < pages.length - 1 ? "1px solid #f0ece4" : "none",
          }}>
            <div style={{ width: 60, height: 40, borderRadius: 6, overflow: "hidden", background: "#f0ece4", flexShrink: 0, marginRight: 16 }}>
              {pg.image_url
                ? <img src={pg.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "#ccc" }}>🖼</div>
              }
            </div>
            <div style={{ flex: 1, fontFamily: "DM Sans, sans-serif" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#222" }}>{pg.title || pg.slug}</div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>/{pg.slug}</div>
            </div>
            {pg.status === "draft" && <Badge label="Draft" color="#fff5e6" text="var(--admin-accent)" />}
            <div style={{ display: "flex", gap: 10, marginLeft: 16 }}>
              <button onClick={() => openEditor(pg.slug)} style={{ ...btnSecondary, padding: "7px 18px", fontSize: 13 }}>Edit</button>
              <button onClick={() => setDeleteTarget(pg.slug)} style={{ border: "1px solid #fcc", background: "#fff", color: "#c0392b", padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "DM Sans, sans-serif" }}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {deleteTarget && (
        <Modal title="Delete Page" onClose={() => setDeleteTarget(null)}>
          <p style={{ fontFamily: "DM Sans, sans-serif", fontSize: 14, color: "#555", lineHeight: 1.6 }}>
            Are you sure you want to delete <strong>/{deleteTarget}</strong>? This cannot be undone.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
            <button onClick={() => setDeleteTarget(null)} style={btnSecondary}>Cancel</button>
            <button onClick={confirmDelete} style={{ ...btnPrimary, background: "#c0392b" }} disabled={deleting}>{deleting ? "Deleting…" : "Delete Page"}</button>
          </div>
        </Modal>
      )}

      {newPageModal && (
        <Modal title="New Page" onClose={() => setNewPageModal(false)}>
          <Field label="Slug" required>
            <input style={inputStyle} value={newSlug} onChange={e => setNewSlug(e.target.value)} placeholder="e.g. outreach or small-groups" autoFocus />
          </Field>
          <p style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: -8, marginBottom: 16 }}>
            The page will be available at {(siteUrl || "your site").replace(/^https?:\/\//, "").replace(/\/+$/, "")}/<strong>{newSlug || "slug"}</strong>
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={() => setNewPageModal(false)} style={btnSecondary}>Cancel</button>
            <button onClick={createPage} style={btnPrimary} disabled={creating}>{creating ? "Creating…" : "Create Page"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Sermon Notes
// ════════════════════════════════════════════════════════════════════════════════
function SermonNotesPage({ toast, caps }) {
  const [sermons, setSermons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [html, setHtml] = useState("");
  const [published, setPublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);

  useEffect(() => {
    api("/api/admin/sermons").then(r => r.json()).then(d => setSermons(Array.isArray(d?.data) ? d.data : [])).catch(() => setSermons([])).finally(() => setLoading(false));
  }, []);

  async function openEditor(s) {
    setEditing(s);
    setNotesLoading(true);
    try {
      const res = await api(`/api/admin/sermons/${s.id || s.planId}/notes`);
      const d = await res.json();
      const notes = d?.data || d;
      setHtml(notes.html || "");
      setPublished(!!notes.published || !!s.notes_published);
    } catch { setHtml(""); setPublished(false); } finally { setNotesLoading(false); }
  }

  async function save() {
    setSaving(true);
    try {
      await api(`/api/admin/sermons/${editing.id || editing.planId}/notes`, { method: "POST", body: JSON.stringify({ html, published }) });
      setSermons(s => s.map(m => m.id === editing.id ? { ...m, has_notes: true, notes_published: published } : m));
      toast("Notes saved");
    } catch { toast("Save failed", "error"); } finally { setSaving(false); }
  }

  if (editing) {
    return (
      <div style={{ padding: 32, display: "grid", gridTemplateColumns: "1fr 280px", gap: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <button onClick={() => setEditing(null)} style={{ ...btnSecondary, padding: "7px 14px", fontSize: 13 }}>← Back</button>
            <div style={{ flex: 1 }}>
              <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 18, color: "var(--admin-brand)", margin: 0 }}>{editing.title}</h2>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>{fmtDate(editing.date)}</div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "DM Sans, sans-serif", fontSize: 14, color: "#444" }}>
              <input type="checkbox" checked={published} onChange={e => setPublished(e.target.checked)} />
              Published in App
            </label>
            <button onClick={save} style={btnPrimary} disabled={saving}>{saving ? "Saving…" : "Save Notes"}</button>
          </div>
          {notesLoading ? <Loading /> : <WYSIWYGEditor value={html} onChange={setHtml} sermonsMode caps={caps} toast={toast} />}
        </div>
        <div>
          <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, fontWeight: 600, color: "#888", marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>Phone Preview</div>
          <div style={{
            width: 260, background: "#1a1a1a", borderRadius: 36, padding: "20px 10px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.3)", margin: "0 auto",
          }}>
            <div style={{ background: "#fff", borderRadius: 26, overflow: "hidden", height: 480 }}>
              <div style={{ background: "var(--admin-brand)", padding: "12px 16px" }}>
                <div style={{ fontFamily: "Playfair Display, serif", fontSize: 13, color: "#fff" }}>{editing.title}</div>
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 2 }}>{fmtDate(editing.date)}</div>
              </div>
              <iframe
                title="Sermon notes preview"
                sandbox="allow-scripts"
                srcDoc={renderSermonNotesDocument(html, { apiBase: API })}
                style={{ border: "none", width: "100%", height: "calc(100% - 56px)" }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 32 }}>
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", overflow: "hidden" }}>
        {sermons.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#aaa", fontFamily: "DM Sans, sans-serif" }}>No sermons found</div>}
        {sermons.map((s, i) => (
          <div key={s.id || i} style={{ display: "flex", alignItems: "center", padding: "16px 24px", borderBottom: i < sermons.length - 1 ? "1px solid #f0ece4" : "none", gap: 12 }}>
            <div style={{ flex: 1, fontFamily: "DM Sans, sans-serif" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#222" }}>{s.title}</div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{fmtDate(s.date)}{s.series ? ` · ${s.series}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {s.has_notes && <Badge label="Has Notes" />}
              {s.notes_published && <Badge label="Published" color="#e8f5e9" />}
              <button onClick={() => openEditor(s)} style={{ ...btnSecondary, padding: "7px 16px", fontSize: 13 }}>
                {s.has_notes ? "Edit Notes" : "Add Notes"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Notifications
// ════════════════════════════════════════════════════════════════════════════════
function NotificationsPage({ toast }) {
  const [form, setForm] = useState({ title: "", body: "", deepLink: "home", audience: "Everyone", timing: "now", scheduleDate: "", scheduleTime: "" });
  const [history, setHistory] = useState([]);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api("/api/admin/notifications").then(r => r.json()).then(d => setHistory(Array.isArray(d?.data) ? d.data : [])).catch(() => setHistory([]));
  }, []);

  async function send() {
    setSending(true);
    try {
      await api("/api/admin/notifications/send", {
        method: "POST",
        body: JSON.stringify({
          title: form.title, body: form.body,
          deep_link: form.deepLink, audience: form.audience,
          send_after: form.timing === "schedule" ? `${form.scheduleDate}T${form.scheduleTime}` : null,
        }),
      });
      toast("Notification sent!");
      setConfirm(false);
      setForm({ title: "", body: "", deepLink: "home", audience: "Everyone", timing: "now", scheduleDate: "", scheduleTime: "" });
    } catch { toast("Send failed", "error"); } finally { setSending(false); }
  }

  const statusColor = s => s === "sent" ? "#e8f5e9" : s === "scheduled" ? "#fff5e6" : "#f5f5f5";
  const statusText = s => s === "sent" ? "var(--admin-brand)" : s === "scheduled" ? "var(--admin-accent)" : "#888";

  return (
    <div style={{ padding: 32, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
      <div>
        <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 18, color: "var(--admin-brand)", margin: "0 0 20px" }}>New Notification</h2>
        <Field label={`Title (${form.title.length}/65)`} required>
          <input style={inputStyle} maxLength={65} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
        </Field>
        <Field label={`Message (${form.body.length}/178)`} required>
          <textarea style={{ ...inputStyle, height: 90, resize: "vertical" }} maxLength={178} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
        </Field>
        <Field label="Deep Link">
          <select style={inputStyle} value={form.deepLink} onChange={e => setForm(f => ({ ...f, deepLink: e.target.value }))}>
            {DEEP_LINKS.map(l => <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>)}
          </select>
        </Field>
        <Field label="Audience">
          <select style={inputStyle} value={form.audience} onChange={e => setForm(f => ({ ...f, audience: e.target.value }))}>
            <option>Everyone</option>
            <option>Specific Groups</option>
            <option>Checked In Today</option>
          </select>
        </Field>
        <Field label="Send Timing">
          <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
            {["now", "schedule"].map(t => (
              <label key={t} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "DM Sans, sans-serif", fontSize: 14, cursor: "pointer" }}>
                <input type="radio" name="timing" value={t} checked={form.timing === t} onChange={() => setForm(f => ({ ...f, timing: t }))} />
                {t === "now" ? "Send Now" : "Schedule"}
              </label>
            ))}
          </div>
          {form.timing === "schedule" && (
            <div style={{ display: "flex", gap: 10 }}>
              <input type="date" style={{ ...inputStyle, flex: 1 }} value={form.scheduleDate} onChange={e => setForm(f => ({ ...f, scheduleDate: e.target.value }))} />
              <input type="time" style={{ ...inputStyle, flex: 1 }} value={form.scheduleTime} onChange={e => setForm(f => ({ ...f, scheduleTime: e.target.value }))} />
            </div>
          )}
        </Field>
        <button onClick={() => { if (!form.title || !form.body) return toast("Title and message required", "error"); setConfirm(true); }} style={btnPrimary}>
          {form.timing === "schedule" ? "Schedule Notification" : "Send Notification"}
        </button>
      </div>

      <div>
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", padding: 24, marginBottom: 24 }}>
          <h3 style={{ fontFamily: "Playfair Display, serif", fontSize: 16, color: "var(--admin-brand)", margin: "0 0 16px" }}>Preview</h3>
          <div style={{ background: "#f0ece4", borderRadius: 12, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ width: 36, height: 36, background: "var(--admin-brand)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style={{ fontSize: 16 }}>✝</span>
            </div>
            <div style={{ fontFamily: "DM Sans, sans-serif" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#222" }}>{form.title || "Notification Title"}</div>
              <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>{form.body || "Your message will appear here."}</div>
            </div>
          </div>
        </div>

        <h3 style={{ fontFamily: "Playfair Display, serif", fontSize: 16, color: "var(--admin-brand)", margin: "0 0 12px" }}>Notification History</h3>
        {history.length === 0 && <div style={{ color: "#aaa", fontFamily: "DM Sans, sans-serif", fontSize: 14 }}>No notifications sent yet.</div>}
        {history.map((n, i) => (
          <div key={i} style={{ background: "#fff", border: "1px solid #e8e4dd", borderRadius: 10, padding: "14px 18px", marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ fontFamily: "DM Sans, sans-serif" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#222" }}>{n.title}</div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{n.body}</div>
                <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>{fmtDate(n.sent_at || n.scheduled_at)}</div>
              </div>
              <Badge label={n.status || "sent"} color={statusColor(n.status)} text={statusText(n.status)} />
            </div>
          </div>
        ))}
      </div>

      {confirm && (
        <Modal title="Confirm Send" onClose={() => setConfirm(false)}>
          <p style={{ fontFamily: "DM Sans, sans-serif", fontSize: 14, color: "#555", lineHeight: 1.6 }}>
            You're about to send <strong>"{form.title}"</strong> to <strong>{form.audience}</strong>.
            {form.timing === "schedule" && ` Scheduled for ${form.scheduleDate} at ${form.scheduleTime}.`}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
            <button onClick={() => setConfirm(false)} style={btnSecondary}>Cancel</button>
            <button onClick={send} style={btnPrimary} disabled={sending}>{sending ? "Sending…" : "Confirm Send"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Submissions
// ════════════════════════════════════════════════════════════════════════════════

/** The form_type values the API stores, and what staff call them. */
const FORM_TYPE_LABELS = {
  connect_card: "Connect Card",
  im_new: "I'm New",
  prayer_request: "Prayer Request",
  contact: "Contact",
};

/** Bot bait the public forms render hidden; never worth a row here. */
const HONEYPOT_FIELDS = ["website", "url", "company", "fax"];

/** Shown first, in this order; anything else follows in submission order. */
const FIELD_ORDER = [
  "first_name", "firstName", "last_name", "lastName", "name",
  "email", "phone", "birthdate",
  "address", "street", "city", "state", "zip",
  "spouse_name", "spouseName", "children",
  "interested_in", "spiritual_journey", "spiritualStatus",
  "how_did_you_hear", "how_found", "howHeard", "how_heard",
  "subject", "message", "request", "notes",
  "prayer_request", "prayerRequest", "prayer_privacy", "prayerPrivacy",
  "source",
];

function DetailField({ label, value, color = "#222" }) {
  return (
    <div>
      <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 14, color, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

/**
 * The whole submission as the visitor filled it in. It used to render as
 * `[object Object]`: the API parses the stored JSON before returning it, and
 * the modal ran every top-level column through String(). Nested shapes are
 * real here — `children` is a list of objects, `address` an object,
 * `spiritualStatus` a list — so each gets a readable block of its own.
 */
function SubmittedData({ data }) {
  if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
    return <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 14, color: "#aaa" }}>No form data recorded.</div>;
  }

  const keys = Object.keys(data).filter(k => !HONEYPOT_FIELDS.includes(k));
  const ordered = [
    ...FIELD_ORDER.filter(k => keys.includes(k)),
    ...keys.filter(k => !FIELD_ORDER.includes(k)),
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      {ordered.map(key => {
        const value = data[key];
        const listOfObjects = Array.isArray(value) && value.some(v => v && typeof v === "object");
        const list = Array.isArray(value) && !isEmpty(value);

        if (listOfObjects || (list && value.length > 1)) {
          return (
            <div key={key} style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{labelize(key)}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "DM Sans, sans-serif", fontSize: 14, color: "#222" }}>
                {value.filter(v => !isEmpty(v)).map((v, i) => <li key={i} style={{ marginBottom: 2 }}>{flatten(v)}</li>)}
              </ul>
            </div>
          );
        }

        const text = flatten(value);
        const long = text.length > 60;
        return (
          <div key={key} style={long ? { gridColumn: "1 / -1" } : undefined}>
            <DetailField label={labelize(key)} value={text} color={isEmpty(value) ? "#aaa" : "#222"} />
          </div>
        );
      })}
    </div>
  );
}

function SubmissionsPage({ toast }) {
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("All");
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api("/api/admin/submissions").then(r => r.json()).then(d => setSubmissions(Array.isArray(d?.data) ? d.data : [])).catch(() => setSubmissions([])).finally(() => setLoading(false));
  }, []);

  // The tabs used to compare their own labels against form_type, so every
  // tab but "All" filtered everything away. Filter on the stored value.
  const tabs = ["All", ...Object.keys(FORM_TYPE_LABELS)];
  const filtered = filter === "All" ? submissions : submissions.filter(s => s.form_type === filter);

  function exportCSV() {
    // One column per field anyone submitted — dumping the raw row put the
    // whole nested payload in a single "[object Object]" cell.
    const fields = [];
    for (const s of filtered) {
      for (const k of Object.keys(s.data || {})) {
        if (!fields.includes(k) && !HONEYPOT_FIELDS.includes(k)) fields.push(k);
      }
    }
    const headers = ["Submitted", "Form Type", "PCO Person ID", ...fields.map(labelize)];
    const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      headers.map(cell).join(","),
      ...filtered.map(s => [
        fmtDateTime(s.submitted_at),
        FORM_TYPE_LABELS[s.form_type] || s.form_type || "",
        s.pco_person_id || "",
        ...fields.map(f => (isEmpty(s.data?.[f]) ? "" : flatten(s.data[f]))),
      ].map(cell).join(",")),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "submissions.csv"; a.click();
  }

  function getSubmissionName(s) {
    const d = s.data || {};
    if (d.name) return d.name;
    const first = d.firstName || d.first_name || "";
    const last = d.lastName || d.last_name || "";
    if (first || last) return `${first} ${last}`.trim();
    return "—";
  }

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 32 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 4, background: "#fff", border: "1px solid #e8e4dd", borderRadius: 8, padding: 4 }}>
          {tabs.map(t => (
            <button key={t} onClick={() => setFilter(t)} style={{
              padding: "7px 16px", borderRadius: 6, border: "none", cursor: "pointer",
              background: filter === t ? "var(--admin-brand)" : "transparent",
              color: filter === t ? "#fff" : "#555",
              fontFamily: "DM Sans, sans-serif", fontSize: 13, fontWeight: filter === t ? 600 : 400,
            }}>{FORM_TYPE_LABELS[t] || t}</button>
          ))}
        </div>
        {filtered.length > 0 && <button onClick={exportCSV} style={{ ...btnSecondary, padding: "8px 18px", fontSize: 13 }}>Export CSV</button>}
      </div>

      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f7f5f0" }}>
              {["Name", "Type", "Date", "PCO Status"].map(h => (
                <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontFamily: "DM Sans, sans-serif", fontSize: 12, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 40, textAlign: "center", color: "#aaa", fontFamily: "DM Sans, sans-serif" }}>No submissions found</td></tr>
            )}
            {filtered.map((s, i) => (
              <tr key={i} onClick={() => setSelected(s)} style={{ borderBottom: "1px solid #f0ece4", cursor: "pointer", transition: "background 0.1s" }}
                onMouseEnter={e => e.currentTarget.style.background = "#faf8f3"}
                onMouseLeave={e => e.currentTarget.style.background = ""}>
                <td style={{ padding: "14px 20px", fontFamily: "DM Sans, sans-serif", fontSize: 14, fontWeight: 600, color: "#222" }}>{getSubmissionName(s)}</td>
                <td style={{ padding: "14px 20px" }}><Badge label={FORM_TYPE_LABELS[s.form_type] || s.form_type || "Contact"} /></td>
                <td style={{ padding: "14px 20px", fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>{fmtDate(s.submitted_at)}</td>
                <td style={{ padding: "14px 20px" }}>{s.pco_person_id ? <Badge label="Added to PCO" /> : <span style={{ color: "#aaa", fontFamily: "DM Sans, sans-serif", fontSize: 13 }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <Modal title={`Submission: ${getSubmissionName(selected)}`} onClose={() => setSelected(null)} wide>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
            <DetailField label="Form Type" value={FORM_TYPE_LABELS[selected.form_type] || selected.form_type || "—"} />
            <DetailField label="Submitted" value={fmtDateTime(selected.submitted_at)} />
            <DetailField
              label="Planning Center"
              value={selected.pco_person_id
                ? <a href={`https://people.planningcenteronline.com/people/${selected.pco_person_id}`} target="_blank" rel="noreferrer" style={{ color: "var(--admin-brand)" }}>View profile</a>
                : "Not synced"}
            />
            <DetailField label="Staff Emailed" value={selected.emailed ? "Yes" : "No"} />
            {selected.pco_error && (
              <div style={{ gridColumn: "1 / -1" }}>
                <DetailField label="Sync Problem" value={selected.pco_error} color="#a33" />
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid #f0ece4", paddingTop: 20 }}>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>Submitted Form</div>
            <SubmittedData data={selected.data} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
            <button onClick={() => setSelected(null)} style={btnPrimary}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Pings exactly this one device — for confirming push actually reaches a
 * phone (a fresh local build, say) without notifying every real subscriber. */
function SendTestButton({ playerId, toast }) {
  const [sending, setSending] = useState(false);
  async function send() {
    setSending(true);
    try {
      const r = await api("/api/admin/notifications/test", {
        method: "POST",
        body: JSON.stringify({ player_id: playerId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || "Send failed");
      toast("Test notification sent");
    } catch (e) { toast(e.message || "Send failed", "error"); } finally { setSending(false); }
  }
  return (
    <button
      onClick={send}
      disabled={sending}
      style={{
        padding: "5px 12px", borderRadius: 6, border: "1px solid #d8d2c4",
        background: "#fff", color: "var(--admin-brand)", fontFamily: "DM Sans, sans-serif",
        fontSize: 12, fontWeight: 600, cursor: sending ? "default" : "pointer",
        opacity: sending ? 0.6 : 1,
      }}
    >
      {sending ? "Sending…" : "Send Test"}
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Mobile App
// ════════════════════════════════════════════════════════════════════════════════
function MobileAppPage({ toast, settings }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api("/api/admin/device-stats")
      .then(async r => {
        // A failed request must not read the same as zero devices — that
        // difference is the whole reason this page exists.
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `Request failed (${r.status})`);
        return r.json();
      })
      .then(d => setStats(d?.data || null))
      .catch(e => setError(e.message || "Failed to load device stats"))
      .finally(() => setLoading(false));
  }, []);

  const statCard = (label, value, icon, color = "var(--admin-brand)") => (
    <div style={{
      background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd",
      padding: "24px 28px", display: "flex", alignItems: "center", gap: 20,
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 12, background: `${color}15`,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888", marginBottom: 4 }}>{label}</div>
        <div style={{ fontFamily: "Playfair Display, serif", fontSize: 28, color, lineHeight: 1 }}>
          {loading ? "…" : (value ?? "—")}
        </div>
      </div>
    </div>
  );

  if (error) return <ErrorMsg msg={error} />;

  return (
    <div style={{ padding: 32, maxWidth: 900 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, marginBottom: 32 }}>
        {statCard("Total Devices", stats?.total, "📱", "var(--admin-brand)")}
        {statCard("iOS Devices", stats?.ios, "🍎", "#555")}
        {statCard("Android Devices", stats?.android, "🤖", "#3ddc84")}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 32 }}>
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", padding: 28 }}>
          <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 17, color: "var(--admin-brand)", margin: "0 0 20px", paddingBottom: 12, borderBottom: "1px solid #f0ece4" }}>App Configuration</h2>
          {/*
            Only what this deployment can actually know. Bundle IDs and EAS
            project names live in the church's own build config, not here,
            and printing one church's would be wrong everywhere else.
          */}
          {[
            ["API Base URL", API || "not configured"],
            ["Website", settings.site_url || "not set"],
            ["Church Center", settings.church_center_url || "not set"],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f7f5f0", gap: 16 }}>
              <span style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888", flexShrink: 0 }}>{k}</span>
              <span style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#222", fontWeight: 500, textAlign: "right", wordBreak: "break-all" }}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", padding: 28 }}>
          <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 17, color: "var(--admin-brand)", margin: "0 0 20px", paddingBottom: 12, borderBottom: "1px solid #f0ece4" }}>Deep Link Reference</h2>
          {DEEP_LINKS.map(link => (
            <div key={link} style={{ padding: "10px 0", borderBottom: "1px solid #f7f5f0" }}>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, fontWeight: 600, color: "var(--admin-brand)", marginBottom: 3 }}>
                <code style={{ background: "#f0f7ef", padding: "2px 8px", borderRadius: 4, fontSize: 12 }}>{link}</code>
              </div>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 4 }}>
                {DEEP_LINK_LABELS[link]}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", overflow: "hidden" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #f0ece4" }}>
          <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 17, color: "var(--admin-brand)", margin: 0 }}>Recently Registered Devices</h2>
        </div>
        {loading ? (
          <Loading />
        ) : !stats?.recent?.length ? (
          <div style={{ padding: 40, textAlign: "center", color: "#aaa", fontFamily: "DM Sans, sans-serif" }}>No devices registered yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f7f5f0" }}>
                {["Player ID", "Platform", "App Version", "PCO Person", "Last Seen", ""].map(h => (
                  <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontFamily: "DM Sans, sans-serif", fontSize: 12, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.recent.map((d, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f0ece4" }}>
                  <td style={{ padding: "12px 20px", fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#555" }}>
                    <code style={{ fontSize: 11 }}>{d.onesignal_player_id?.slice(0, 12)}…</code>
                  </td>
                  <td style={{ padding: "12px 20px" }}>
                    <Badge
                      label={d.platform || "unknown"}
                      color={d.platform === "ios" ? "#f0f0f5" : d.platform === "android" ? "#e8f5e8" : "#f5f5f5"}
                      text={d.platform === "ios" ? "#555" : d.platform === "android" ? "#2d6e2d" : "#888"}
                    />
                  </td>
                  <td style={{ padding: "12px 20px", fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>{d.app_version || "—"}</td>
                  <td style={{ padding: "12px 20px", fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>{d.pco_person_id || "—"}</td>
                  <td style={{ padding: "12px 20px", fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>{fmtDate(d.last_seen_at)}</td>
                  <td style={{ padding: "12px 20px" }}>
                    <SendTestButton playerId={d.onesignal_player_id} toast={toast} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: System Health
// ════════════════════════════════════════════════════════════════════════════════

function HealthCard({ check }) {
  const { label, color, text } = check.ok === true
    ? { label: "Working", color: "#e8f5e8", text: "#2d6e2d" }
    : check.ok === false
    ? { label: "Failing", color: "#fde8e8", text: "#c0392b" }
    : check.configured
    ? { label: "Configured", color: "#f0f0f5", text: "#555" }
    : { label: "Not Configured", color: "#f5f5f5", text: "#aaa" };

  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", padding: "20px 24px", marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div style={{ fontFamily: "Playfair Display, serif", fontSize: 16, color: "var(--admin-brand)" }}>{check.name}</div>
        <Badge label={label} color={color} text={text} />
      </div>
      <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888", marginTop: 8, lineHeight: 1.5 }}>{check.detail}</div>
    </div>
  );
}

function HealthPage({ toast }) {
  const [checks, setChecks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);

  async function load() {
    setChecking(true);
    try {
      const res = await api("/api/admin/health");
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Request failed (${res.status})`);
      const d = await res.json();
      setChecks(Array.isArray(d?.data) ? d.data : []);
      setCheckedAt(new Date());
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to run health checks");
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <Loading />;
  if (error) return <ErrorMsg msg={error} />;

  const failing = checks.filter(c => c.ok === false).length;

  return (
    <div style={{ padding: 32, maxWidth: 760 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>
          {failing > 0
            ? `${failing} integration${failing === 1 ? "" : "s"} configured but not authenticating.`
            : "Every configured integration is authenticating correctly."}
          {checkedAt && <span> Last checked {checkedAt.toLocaleTimeString()}.</span>}
        </div>
        <button onClick={load} style={btnSecondary} disabled={checking}>{checking ? "Checking…" : "Re-check"}</button>
      </div>

      {checks.map(c => <HealthCard key={c.name} check={c} />)}

      <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#aaa", marginTop: 8, lineHeight: 1.6 }}>
        This makes a real call to each configured provider — it checks that a credential actually authenticates, not just
        that it's set. "Not Configured" means the feature is simply unused, which is normal for a deployment that hasn't
        set up every integration.
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Settings
// ════════════════════════════════════════════════════════════════════════════════
function PdfUploadField({ label, value, onChange, toast }) {
  const [uploading, setUploading] = useState(false);

  async function handleUpload(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    setUploading(true);
    try {
      const res = await fetch(`${API}/api/admin/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { url } = await res.json();
      onChange(url);
      toast(`${label} uploaded`);
    } catch {
      toast(`${label} upload failed`, "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Field label={label}>
      <input
        type="file"
        accept="application/pdf"
        onChange={e => handleUpload(e.target.files[0])}
        style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13 }}
      />
      {uploading && <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888", marginTop: 6 }}>Uploading…</div>}
      {value && !uploading && (
        <a href={value} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 8, fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "var(--admin-brand)" }}>
          View current PDF ↗
        </a>
      )}
    </Field>
  );
}

function LogoUploadField({ label, value, onChange, toast, style }) {
  const [uploading, setUploading] = useState(false);

  async function handleUpload(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    setUploading(true);
    try {
      const res = await fetch(`${API}/api/admin/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { url } = await res.json();
      onChange(url);
      toast(`${label} uploaded`);
    } catch {
      toast(`${label} upload failed`, "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Field label={label} style={style}>
      <input
        type="file"
        accept="image/*"
        onChange={e => handleUpload(e.target.files[0])}
        style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13 }}
      />
      {uploading && <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888", marginTop: 6 }}>Uploading…</div>}
      {value && !uploading && (
        <img src={value} alt={label} style={{ display: "block", marginTop: 10, maxHeight: 60, maxWidth: 220, borderRadius: 4 }} />
      )}
    </Field>
  );
}

function SettingsSection({ title, children }) {
  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e4dd", padding: 28, marginBottom: 24 }}>
      <h2 style={{ fontFamily: "Playfair Display, serif", fontSize: 17, color: "var(--admin-brand)", margin: "0 0 20px", paddingBottom: 12, borderBottom: "1px solid #f0ece4" }}>{title}</h2>
      {children}
    </div>
  );
}

/**
 * `{ sunday: ["9:00 AM"] }` + `{ sunday: "Childcare is available..." }` ⇄
 * the editable rows above. Notes are a separate setting (`service_notes`,
 * keyed the same way as `service_times`) rather than a new shape for
 * `service_times` itself, so a deployment that never touches this still
 * has plain arrays of strings.
 */
function serviceTimesToRows(times, notes) {
  let parsedTimes = times;
  if (typeof parsedTimes === "string") {
    try { parsedTimes = JSON.parse(parsedTimes); } catch { parsedTimes = {}; }
  }
  let parsedNotes = notes;
  if (typeof parsedNotes === "string") {
    try { parsedNotes = JSON.parse(parsedNotes); } catch { parsedNotes = {}; }
  }
  if (!parsedTimes || typeof parsedTimes !== "object") return [];
  return Object.entries(parsedTimes).map(([day, dayTimes]) => ({
    day: day.charAt(0).toUpperCase() + day.slice(1),
    times: Array.isArray(dayTimes) ? dayTimes.join(", ") : String(dayTimes ?? ""),
    note: (parsedNotes && parsedNotes[day]) || "",
  }));
}

function rowsToServiceTimes(rows) {
  const out = {};
  for (const { day, times } of rows) {
    const key = day.trim().toLowerCase();
    if (!key) continue;
    out[key] = times.split(",").map(t => t.trim()).filter(Boolean);
  }
  return out;
}

function rowsToServiceNotes(rows) {
  const out = {};
  for (const { day, note } of rows) {
    const key = day.trim().toLowerCase();
    if (!key || !note) continue;
    out[key] = note;
  }
  return out;
}

// [id, label] pairs for the picker below, from @churchkit/config's
// FONT_PRESETS — the same list apps/web renders from, so this can't offer a
// font the site doesn't know how to render.
const FONT_PAIRINGS = listFontPresets();

function SettingsPage({ toast, caps }) {
  const [settings, setSettings] = useState({});
  const [serviceRows, setServiceRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api("/api/admin/settings")
      .then(r => r.json())
      .then(d => {
        const loaded = d?.data || {};
        setSettings(loaded);
        setServiceRows(serviceTimesToRows(loaded.service_times, loaded.service_notes));
      })
      .catch(() => setSettings({}))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      // Settings are stored as flat key/value strings — re-stringify any
      // object-valued setting (e.g. service_times, loaded pre-parsed from
      // the API) before sending, or D1 rejects the whole batch.
      const payload = Object.fromEntries(
        Object.entries(settings).map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : v])
      );
      const res = await api("/api/admin/settings", { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      toast("Settings saved");
    } catch (e) { toast(e.message || "Save failed", "error"); } finally { setSaving(false); }
  }

  const set = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  // Rows are held locally rather than derived from the stored object on
  // every render: an empty day name produces no key, so a freshly added row
  // would round-trip to nothing and disappear as soon as it appeared. The
  // rows are the editing surface; service_times is what gets saved.
  const setServiceDays = rows => {
    setServiceRows(rows);
    set("service_times", rowsToServiceTimes(rows));
    set("service_notes", rowsToServiceNotes(rows));
  };
  const updateServiceDay = (i, patch) =>
    setServiceDays(serviceRows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addServiceDay = () => setServiceDays([...serviceRows, { day: "", times: "", note: "" }]);
  const removeServiceDay = i => setServiceDays(serviceRows.filter((_, idx) => idx !== i));

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 32, maxWidth: 760 }}>
      <SettingsSection title="Church Information">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {[["Church Name", "church_name"], ["Tagline", "tagline"], ["Phone", "phone"], ["Email", "email"]].map(([l, k]) => (
            <Field key={k} label={l}><input style={inputStyle} value={settings[k] || ""} onChange={e => set(k, e.target.value)} /></Field>
          ))}
          <Field label="Address" style={{ gridColumn: "span 2" }}>
            <input style={inputStyle} value={settings.address || ""} onChange={e => set("address", e.target.value)} />
          </Field>
        </div>
      </SettingsSection>

      {/*
        Colors/fonts are otherwise compiled once from brand.json at build
        time (packages/brand/generate.mjs) — these three fields let a
        church override that live, with no rebuild. Left blank, everything
        below renders exactly what was compiled in; nothing here can appear
        in code, only in these settings rows. Mobile is unaffected: its
        theme is baked into the app binary and only changes on its own next
        build, regardless of anything set here.
      */}
      <SettingsSection title="Branding">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {[["Primary Color", "theme_primary_color"], ["Accent Color", "theme_accent_color"]].map(([l, k]) => (
            <Field key={k} label={l}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="color"
                  value={settings[k] || "var(--admin-brand)"}
                  onChange={e => set(k, e.target.value)}
                  style={{ width: 44, height: 36, padding: 2, border: "1.5px solid #ddd", borderRadius: 6, cursor: "pointer" }}
                />
                {settings[k]
                  ? <button onClick={() => set(k, "")} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 12 }}>Reset to default</button>
                  : <span style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>Using deployed default</span>}
              </div>
            </Field>
          ))}
          <Field label="Font Pairing" style={{ gridColumn: "span 2" }}>
            {/*
              No default to a real preset here — "" means "whatever
              brand.json compiled," a genuinely different thing from
              "Classic" (Cormorant Garamond + Roboto specifically). Defaulting
              the <select> to classic used to silently claim a church was
              using a preset it had never chosen, while the site itself
              rendered its own brand.json fonts underneath — the two could
              name completely different typefaces and nothing here would
              show it.
            */}
            <select style={inputStyle} value={settings.theme_font_pairing || ""} onChange={e => set("theme_font_pairing", e.target.value)}>
              <option value="">Default — whatever brand.json compiled</option>
              {FONT_PAIRINGS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </Field>
          <div style={{ gridColumn: "span 2", display: "flex", alignItems: "center", gap: 14, padding: "16px 20px", background: "#faf8f3", borderRadius: 8, border: "1px solid #e8e4dd" }}>
            <span style={{ width: 28, height: 28, borderRadius: "50%", background: settings.theme_primary_color || "var(--admin-brand)", border: "1px solid rgba(0,0,0,0.1)", flexShrink: 0 }} title="Primary" />
            <span style={{ width: 28, height: 28, borderRadius: "50%", background: settings.theme_accent_color || "var(--admin-accent)", border: "1px solid rgba(0,0,0,0.1)", flexShrink: 0 }} title="Accent" />
            <span style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#666" }}>
              {settings.theme_font_pairing
                ? (FONT_PAIRINGS.find(([id]) => id === settings.theme_font_pairing) || [])[1]
                : "Default — whatever brand.json compiled"}
              {" — fonts load from Google Fonts on the live site, not previewed here."}
            </span>
          </div>
          {caps.mediaUploads ? (
            <>
              <LogoUploadField label="Logo (light background)" value={settings.logo_dark_url} onChange={url => set("logo_dark_url", url)} toast={toast} />
              <LogoUploadField label="Logo (dark background / footer)" value={settings.logo_white_url} onChange={url => set("logo_white_url", url)} toast={toast} />
            </>
          ) : (
            <div style={{ gridColumn: "span 2", fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>
              Configure media storage to enable logo uploads — using the deployed default logo for now.
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Giving">
        <Field label="Giving URL" style={{ gridColumn: "span 2" }}>
          <input style={inputStyle} value={settings.giving_url || ""} onChange={e => set("giving_url", e.target.value)} placeholder="https://giving.planningcenteronline.com/give/..." />
        </Field>
      </SettingsSection>

      {/*
        These used to write `sunday_times` and `wednesday_times`, which
        nothing read — the website and app have always read the
        `service_times` JSON. They also assumed a church meets on Sunday and
        Wednesday and nothing else. Days are now whatever this church says
        they are.
      */}
      <SettingsSection title="Service Times">
        <div style={{ gridColumn: "span 2" }}>
          {serviceRows.map((row, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 6 }}>
                <input
                  style={{ ...inputStyle, flex: "0 0 180px" }}
                  value={row.day}
                  placeholder="Day (e.g. Sunday)"
                  onChange={e => updateServiceDay(i, { day: e.target.value })}
                />
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={row.times}
                  placeholder="9:00 AM — Bible Study, 10:30 AM — Worship"
                  onChange={e => updateServiceDay(i, { times: e.target.value })}
                />
                <button onClick={() => removeServiceDay(i)} style={{ ...btnSecondary, padding: "8px 14px" }}>Remove</button>
              </div>
              <input
                style={{ ...inputStyle, marginLeft: 192 }}
                value={row.note}
                placeholder="Optional note (e.g. Childcare is available for infants through 5th grade.)"
                onChange={e => updateServiceDay(i, { note: e.target.value })}
              />
            </div>
          ))}
          <button onClick={addServiceDay} style={{ ...btnSecondary, marginTop: 4 }}>+ Add a day</button>
          <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 8 }}>
            Separate multiple services on the same day with commas.
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Website">
        <Field label="Website URL">
          <input style={inputStyle} value={settings.site_url || ""} onChange={e => set("site_url", e.target.value)} placeholder="https://example.org" />
        </Field>
        <Field label="Church Center URL">
          <input style={inputStyle} value={settings.church_center_url || ""} onChange={e => set("church_center_url", e.target.value)} placeholder="https://example.churchcenter.com" />
        </Field>
        <Field label="Timezone">
          <input style={inputStyle} value={settings.timezone || ""} onChange={e => set("timezone", e.target.value)} placeholder="America/Chicago" />
          <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 6 }}>
            IANA name. Event and service times are shown in this zone. Defaults to UTC.
          </div>
        </Field>
        <Field label="Locale">
          <input style={inputStyle} value={settings.locale || ""} onChange={e => set("locale", e.target.value)} placeholder="en-US" />
        </Field>
        {caps.mediaUploads ? (
          <div style={{ gridColumn: "span 2" }}>
            <LogoUploadField label="Homepage Image" value={settings.hero_image_url} onChange={url => set("hero_image_url", url)} toast={toast} />
            {/*
              Only meaningful once there's an image to position within —
              the hero crops this to a tall panel (see HeroSection.astro),
              so the part of a wide photo that matters (a face, the cross on
              the steeple) needs to be choosable rather than always assuming
              the center.
            */}
            {settings.hero_image_url && (
              <FocalPointPicker
                src={settings.hero_image_url}
                x={settings.hero_image_focal_x}
                y={settings.hero_image_focal_y}
                onChange={(x, y) => { set("hero_image_focal_x", x); set("hero_image_focal_y", y); }}
              />
            )}
          </div>
        ) : (
          <div style={{ gridColumn: "span 2", fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#888" }}>
            Configure media storage to enable the homepage image — it stays hidden until then.
          </div>
        )}
      </SettingsSection>

      {caps.email && (
        <SettingsSection title="Visitor Welcome Email">
          <Field label="Message" style={{ gridColumn: "span 2" }}>
            <textarea
              style={{ ...inputStyle, minHeight: 180, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}
              value={settings.welcome_email_html || ""}
              onChange={e => set("welcome_email_html", e.target.value)}
              placeholder="Leave empty to use the built-in default."
            />
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: 12, color: "#888", marginTop: 6 }}>
              Sent to anyone who submits a connect card. HTML is allowed. Use{" "}
              <code>{"{{first_name}}"}</code>, <code>{"{{church_name}}"}</code>,{" "}
              <code>{"{{address}}"}</code>, <code>{"{{phone}}"}</code> and{" "}
              <code>{"{{email}}"}</code> as placeholders.
            </div>
          </Field>
        </SettingsSection>
      )}

      {/*
        Read only by apps/mobile/src/screens/HomeScreen.tsx — the website
        never shows a bulletin or newsletter link. caps.push is this
        system's only signal that a mobile app is actually in use (see
        APP_ONLY_PAGES above), so showing these to a deployment with no app
        just offers settings that do nothing.
      */}
      {caps.mediaUploads && caps.push && (
        <SettingsSection title="Bulletin & Newsletter">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <PdfUploadField
              label="Weekly Bulletin (PDF)"
              value={settings.bulletin_pdf_url}
              onChange={url => set("bulletin_pdf_url", url)}
              toast={toast}
            />
            <PdfUploadField
              label="Newsletter (PDF)"
              value={settings.newsletter_pdf_url}
              onChange={url => set("newsletter_pdf_url", url)}
              toast={toast}
            />
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Form Routing">
        {[["Connect Card Email", "connect_email"], ["I'm New Email", "imnew_email"], ["Contact Form Email", "contact_email"]].map(([l, k]) => (
          <Field key={k} label={l}><input type="email" style={inputStyle} value={settings[k] || ""} onChange={e => set(k, e.target.value)} /></Field>
        ))}
      </SettingsSection>

      <SettingsSection title="PCO Integration">
        {[["Workflow ID", "pco_workflow_id"], ["Note Category ID", "pco_note_category_id"]].map(([l, k]) => (
          <Field key={k} label={l}><input type="password" style={inputStyle} value={settings[k] || ""} onChange={e => set(k, e.target.value)} /></Field>
        ))}
      </SettingsSection>

      <SettingsSection title="YouTube Integration">
        {[["Channel ID", "youtube_channel_id"], ["API Key", "youtube_api_key"]].map(([l, k]) => (
          <Field key={k} label={l}><input type="password" style={inputStyle} value={settings[k] || ""} onChange={e => set(k, e.target.value)} /></Field>
        ))}
      </SettingsSection>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={save} style={{ ...btnPrimary, padding: "12px 32px", fontSize: 15 }} disabled={saving}>{saving ? "Saving…" : "Save All Settings"}</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGE: Navigation
// ════════════════════════════════════════════════════════════════════════════════

function moveInArray(arr, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= arr.length) return arr;
  const next = [...arr];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// A page picker still leaves label/href free-editable — it only ever fills
// them in, once, on selection. That way an existing page's title and URL
// are one click away without giving up the ability to link somewhere the
// page list doesn't cover (an anchor, an external site, a future route).
function PagePicker({ pageOptions, onPick }) {
  if (!pageOptions.length) return null;
  return (
    <select
      value=""
      onChange={e => {
        if (!e.target.value) return;
        const picked = JSON.parse(e.target.value);
        onPick(picked);
      }}
      style={{ ...inputStyle, flex: "0 0 168px", color: "#888", fontSize: 13 }}
    >
      <option value="">Insert a page…</option>
      {pageOptions.map(p => (
        <option key={p.href} value={JSON.stringify(p)}>{p.label} — {p.href}</option>
      ))}
    </select>
  );
}

function NavLinkRow({ link, onChange, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown, indent, pageOptions }) {
  const children = link.children || [];
  const updateChild = (i, patch) => onChange({ ...link, children: children.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  const removeChild = (i) => onChange({ ...link, children: children.filter((_, idx) => idx !== i) });
  const addChild = () => onChange({ ...link, children: [...children, { href: "", label: "" }] });
  const moveChild = (i, delta) => onChange({ ...link, children: moveInArray(children, i, delta) });

  return (
    <div style={{ background: "#fff", border: "1px solid #e8e4dd", borderRadius: 10, padding: 14, marginBottom: 10, marginLeft: indent }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <button onClick={onMoveUp} disabled={!canMoveUp} style={moveBtnStyle}>↑</button>
          <button onClick={onMoveDown} disabled={!canMoveDown} style={moveBtnStyle}>↓</button>
        </div>
        <PagePicker pageOptions={pageOptions} onPick={picked => onChange({ ...link, label: picked.label, href: picked.href })} />
        <input style={{ ...inputStyle, flex: "0 0 200px" }} value={link.label} placeholder="Label" onChange={e => onChange({ ...link, label: e.target.value })} />
        <input style={{ ...inputStyle, flex: 1 }} value={link.href} placeholder="/path" onChange={e => onChange({ ...link, href: e.target.value })} />
        <button onClick={onRemove} style={{ border: "1px solid #fcc", background: "#fff", color: "#c0392b", padding: "8px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontFamily: "DM Sans, sans-serif" }}>Remove</button>
      </div>
      {children.length > 0 && (
        <div style={{ marginTop: 10, paddingLeft: 40 }}>
          {children.map((child, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <button onClick={() => moveChild(i, -1)} disabled={i === 0} style={moveBtnStyle}>↑</button>
                <button onClick={() => moveChild(i, 1)} disabled={i === children.length - 1} style={moveBtnStyle}>↓</button>
              </div>
              <PagePicker pageOptions={pageOptions} onPick={picked => updateChild(i, { label: picked.label, href: picked.href })} />
              <input style={{ ...inputStyle, flex: "0 0 180px" }} value={child.label} placeholder="Label" onChange={e => updateChild(i, { label: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1 }} value={child.href} placeholder="/path" onChange={e => updateChild(i, { href: e.target.value })} />
              <button onClick={() => removeChild(i)} style={{ border: "1px solid #fcc", background: "#fff", color: "#c0392b", padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "DM Sans, sans-serif" }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, paddingLeft: 40 }}>
        <button onClick={addChild} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 12 }}>+ Add Dropdown Item</button>
      </div>
    </div>
  );
}

const moveBtnStyle = {
  width: 26, height: 20, border: "1px solid #ddd", background: "#fafafa", borderRadius: 4,
  cursor: "pointer", fontSize: 11, lineHeight: 1, color: "#555",
};

// A page's real URL, by the same rule apps/web's [...slug].astro and
// /ministries/[slug].astro use. A church that has given a page its own
// dedicated route (its own file under apps/web/src/pages, rather than
// falling through the generic [...slug] handler) will need to correct
// the href after inserting it — this covers the common case, and the
// href stays a free-editable field for exactly that reason.
function pageToOption(page) {
  return {
    label: page.title || page.slug,
    href: page.is_ministry ? `/ministries/${page.slug}` : `/${page.slug}`,
  };
}

// Real site sections that aren't rows in the pages table, so the picker
// would otherwise never offer them. Media/Events only appear when their
// capability is actually configured — same rule save-time filtering
// enforces, just surfaced earlier so the picker doesn't offer a dead end.
function builtInPageOptions(settings, caps) {
  const opts = [
    { label: "Home", href: "/" },
    { label: "Ministries (index)", href: "/ministries" },
    { label: "Contact", href: "/contact" },
  ];
  if (caps.sermons) opts.push({ label: "Media", href: "/media" });
  if (caps.events) opts.push({ label: "Events", href: "/events" });
  if (settings.giving_url) opts.push({ label: "Give", href: "/give" });
  return opts;
}

function NavigationPage({ toast, settings, caps }) {
  const [links, setLinks] = useState([]);
  const [pages, setPages] = useState([]);
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api("/api/admin/pages").then(r => r.json()).then(d => {
      const allPages = Array.isArray(d?.data) ? d.data : [];
      setPages(allPages);
      const ministries = allPages.filter(p => p.is_ministry && p.status === "published");
      // An explicit menu (nav_links) always wins once a church has saved
      // one — same rule the website itself follows. Until then, this
      // screen edits the same automatic menu the site is showing right
      // now, computed the identical way, so nothing changes the moment a
      // church's first edit here is saved.
      if (settings.nav_links) {
        try {
          const parsed = typeof settings.nav_links === "string" ? JSON.parse(settings.nav_links) : settings.nav_links;
          if (Array.isArray(parsed) && parsed.length) {
            setLinks(parsed);
            setIsCustom(true);
            setLoading(false);
            return;
          }
        } catch {}
      }
      setLinks(buildNav({ settings, ministries, capabilities: caps }));
      setIsCustom(false);
      setLoading(false);
    }).catch(() => setLoading(false));
    // Only re-derive on first load: once a church starts editing, further
    // settings/caps changes shouldn't yank their in-progress edits out
    // from under them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageOptions = [
    ...builtInPageOptions(settings, caps),
    ...pages.filter(p => p.status === "published").map(pageToOption),
  ];

  const updateLink = (i, patch) => setLinks(links.map((l, idx) => (idx === i ? patch : l)));
  const removeLink = (i) => setLinks(links.filter((_, idx) => idx !== i));
  const addLink = () => setLinks([...links, { href: "", label: "" }]);
  const moveLink = (i, delta) => setLinks(moveInArray(links, i, delta));

  async function save() {
    setSaving(true);
    try {
      const res = await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ nav_links: JSON.stringify(links) }) });
      if (!res.ok) throw new Error();
      setIsCustom(true);
      toast("Navigation saved");
    } catch {
      toast("Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function resetToAutomatic() {
    setSaving(true);
    try {
      const res = await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ nav_links: "" }) });
      if (!res.ok) throw new Error();
      const ministries = pages.filter(p => p.is_ministry && p.status === "published");
      setLinks(buildNav({ settings: { ...settings, nav_links: "" }, ministries, capabilities: caps }));
      setIsCustom(false);
      toast("Reset to the automatic menu");
    } catch {
      toast("Reset failed", "error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div style={{ padding: 32, maxWidth: 900 }}>
      <div style={{ background: "#faf8f3", border: "1px solid #e8e4dd", borderRadius: 10, padding: "14px 18px", marginBottom: 24, fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#666" }}>
        {isCustom
          ? "This menu is a custom override — it no longer changes automatically when ministries or capabilities change."
          : "This is the automatic menu, built from your ministry pages and configured features. Editing and saving it below turns it into a custom menu."}
      </div>

      {links.map((link, i) => (
        <NavLinkRow
          key={i}
          link={link}
          indent={0}
          pageOptions={pageOptions}
          onChange={(patch) => updateLink(i, patch)}
          onRemove={() => removeLink(i)}
          onMoveUp={() => moveLink(i, -1)}
          onMoveDown={() => moveLink(i, 1)}
          canMoveUp={i > 0}
          canMoveDown={i < links.length - 1}
        />
      ))}

      <button onClick={addLink} style={{ ...btnSecondary, marginTop: 4 }}>+ Add Menu Item</button>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32, paddingTop: 20, borderTop: "1px solid #e8e4dd" }}>
        <button onClick={resetToAutomatic} style={{ ...btnSecondary, borderColor: "#ccc", color: "#888" }} disabled={saving}>Reset to Automatic Menu</button>
        <button onClick={save} style={{ ...btnPrimary, padding: "12px 32px", fontSize: 15 }} disabled={saving}>{saving ? "Saving…" : "Save Navigation"}</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ════════════════════════════════════════════════════════════════════════════════
// ─── Local login ────────────────────────────────────────────────────────────
// Only ever rendered under `local` admin-auth mode — a deployment using
// cloudflare-access never reaches this screen, because Cloudflare's own
// hosted login runs at the edge before a request gets here at all. See
// apps/api/src/platform/localAuth.ts.
function LoginScreen({ onSuccess }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ username, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Invalid username or password.");
        return;
      }
      onSuccess({ username: data.username, mustChangePassword: !!data.mustChangePassword, password });
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf8f3" }}>
      <form onSubmit={submit} style={{ width: 360, background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
        <h1 style={{ fontFamily: "Playfair Display, serif", fontSize: 24, color: "var(--admin-brand)", marginBottom: 4 }}>Admin Login</h1>
        <p style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#777", marginBottom: 24 }}>Sign in to manage this site.</p>
        <Field label="Username" required>
          <input style={inputStyle} value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </Field>
        <Field label="Password" required>
          <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {error && <p style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#c0392b", marginBottom: 16 }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ ...btnPrimary, width: "100%", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}

/**
 * Forced after a login whose password was the one `churchkit seed` printed
 * once and never again — the point of `must_change_password` is that this
 * screen is unavoidable, not a dismissible banner someone defers forever.
 */
function ForceChangePassword({ username, currentPassword, onDone }) {
  const [current, setCurrent] = useState(currentPassword);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (next.length < 12) { setError("New password must be at least 12 characters."); return; }
    if (next !== confirm) { setError("Passwords do not match."); return; }
    setBusy(true);
    setError("");
    try {
      const res = await api("/api/admin/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || "Could not change password."); return; }
      onDone();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf8f3" }}>
      <form onSubmit={submit} style={{ width: 380, background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
        <h1 style={{ fontFamily: "Playfair Display, serif", fontSize: 22, color: "var(--admin-brand)", marginBottom: 4 }}>Set a New Password</h1>
        <p style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#777", marginBottom: 24 }}>
          You're signed in as <strong>{username}</strong> with the default password. Choose a new one before continuing.
        </p>
        <Field label="New password" required>
          <input style={inputStyle} type="password" value={next} onChange={e => setNext(e.target.value)} autoFocus autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password" required>
          <input style={inputStyle} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        {error && <p style={{ fontFamily: "DM Sans, sans-serif", fontSize: 13, color: "#c0392b", marginBottom: 16 }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ ...btnPrimary, width: "100%", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Set Password"}
        </button>
      </form>
    </div>
  );
}

/**
 * The panel's fonts, resets, and --admin-brand/--admin-accent custom
 * properties — needed on the login/change-password/unavailable screens
 * too, not just the authenticated shell, since those render *instead of*
 * the shell rather than inside it and would otherwise see undefined
 * custom properties (an empty var() with no declared fallback).
 */
function GlobalStyle({ primaryColor, accentColor }) {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@300;400;500;600&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap');
      :root { --admin-brand: ${primaryColor}; --admin-accent: ${accentColor}; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #faf8f3; }
      @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      input:focus, textarea:focus, select:focus { border-color: var(--admin-brand) !important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--admin-brand) 10%, transparent); }
      button:hover { opacity: 0.9; }
      [contenteditable] h1 { font-family: Playfair Display, serif; font-size: 28px; color: var(--admin-brand); margin: 16px 0 8px; }
      [contenteditable] h2 { font-family: Playfair Display, serif; font-size: 22px; color: var(--admin-brand); margin: 14px 0 6px; }
      [contenteditable] h3 { font-family: DM Sans, sans-serif; font-size: 16px; font-weight: 700; color: #333; margin: 12px 0 4px; }
      [contenteditable] blockquote { border-left: 3px solid var(--admin-accent); padding: 10px 16px; margin: 12px 0; color: #555; font-style: italic; }
      [contenteditable] ul, [contenteditable] ol { padding-left: 24px; margin: 8px 0; }
      [contenteditable] p { margin: 6px 0; }
    `}</style>
  );
}

export default function App() {
  const [page, setPage] = useState("homepage");
  const [unread, setUnread] = useState(0);
  const { toasts, show: toast } = useToast();

  const [user, setUser] = useState({ name: "Admin", email: "" });

  // Gates the whole panel. Cloudflare Access never reaches "login" or
  // "unavailable" — it authenticates at the edge before a request gets
  // here, so by the time this component runs, an Access-protected
  // deployment's /api/admin/settings probe below already succeeds.
  const [authState, setAuthState] = useState("checking");
  const [authError, setAuthError] = useState("");
  const [pendingLogin, setPendingLogin] = useState(null);
  const usingAccessRef = useRef(false);

  useEffect(() => {
    api("/api/admin/settings").then(async (r) => {
      if (r.ok) { setAuthState("ok"); return; }
      if (r.status === 401) { setAuthState("login"); return; }
      if (r.status === 501) {
        const body = await r.json().catch(() => ({}));
        setAuthError(body.remedy || body.error || "The admin panel is not configured on this deployment.");
        setAuthState("unavailable");
        return;
      }
      setAuthState("login");
    }).catch(() => setAuthState("login"));
  }, []);

  // The panel is labelled with whatever church this deployment serves. No
  // name is hardcoded anywhere in this file.
  const [settings, setSettings] = useState({});
  useEffect(() => {
    api("/api/settings")
      .then(r => r.json())
      .then(d => setSettings(d?.data || {}))
      .catch(() => {});
  }, []);
  const churchName = settings.church_name || "";
  const siteUrl = settings.site_url || "";

  // The panel's own chrome (sidebar, active states, headings) is styled
  // with these two custom properties throughout instead of a hardcoded
  // green/gold, so a church's admin panel actually looks like its site —
  // same theme_primary_color/theme_accent_color settings the Branding
  // section already writes to. Defaults match what this file used to
  // hardcode everywhere, so an unconfigured deployment looks unchanged.
  const primaryColor = settings.theme_primary_color || "var(--admin-brand)";
  const accentColor = settings.theme_accent_color || "var(--admin-accent)";

  // What this deployment can actually do, so the panel doesn't offer
  // settings for integrations that have no credentials behind them.
  const [caps, setCaps] = useState({});
  useEffect(() => {
    api("/api/capabilities")
      .then(r => r.json())
      .then(d => setCaps(d?.data || {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/cdn-cgi/access/get-identity", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.email) {
          setUser({ name: data.name || data.email, email: data.email });
          usingAccessRef.current = true;
        }
      })
      .catch(() => {});
  }, []);

  async function handleSignOut() {
    if (usingAccessRef.current) {
      window.location.href = "/cdn-cgi/access/logout";
      return;
    }
    await api("/api/admin/logout", { method: "POST" }).catch(() => {});
    setUser({ name: "Admin", email: "" });
    setAuthState("login");
  }

  const PAGE_TITLES = {
    homepage: "Homepage", staff: "Staff",
    pages: "Pages", "sermon-notes": "Sermon Notes",
    notifications: "Push Notifications", submissions: "Form Submissions",
    mobile: "Mobile App",
    navigation: "Navigation",
    health: "System Health",
    settings: "Settings",
  };

  // A page reached only by its sidebar button disappears along with that
  // button — send the panel somewhere real rather than rendering a page for
  // a capability that just went away (or was never there this session).
  useEffect(() => {
    if (APP_ONLY_PAGES.has(page) && !caps.push) setPage("homepage");
  }, [page, caps.push]);

  if (authState === "checking") return null;

  if (authState === "unavailable") {
    return (
      <>
        <GlobalStyle primaryColor={primaryColor} accentColor={accentColor} />
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf8f3", fontFamily: "DM Sans, sans-serif", padding: 24 }}>
          <div style={{ maxWidth: 440, textAlign: "center" }}>
            <h1 style={{ fontFamily: "Playfair Display, serif", fontSize: 22, color: "var(--admin-brand)", marginBottom: 12 }}>Admin Panel Unavailable</h1>
            <p style={{ color: "#555", fontSize: 14 }}>{authError}</p>
          </div>
        </div>
      </>
    );
  }

  if (authState === "login") {
    return (
      <>
        <GlobalStyle primaryColor={primaryColor} accentColor={accentColor} />
        <LoginScreen
          onSuccess={({ username, mustChangePassword, password }) => {
            if (mustChangePassword) {
              setPendingLogin({ username, password });
              setAuthState("change-password");
            } else {
              setAuthState("ok");
            }
          }}
        />
      </>
    );
  }

  if (authState === "change-password") {
    return (
      <>
        <GlobalStyle primaryColor={primaryColor} accentColor={accentColor} />
        <ForceChangePassword
          username={pendingLogin?.username}
          currentPassword={pendingLogin?.password}
          onDone={() => { setPendingLogin(null); setAuthState("ok"); }}
        />
      </>
    );
  }

  const renderPage = () => {
    const props = { toast, setPage, settings, siteUrl, churchName, caps };
    switch (page) {
      case "homepage": return <HomepagePage {...props} />;
      case "staff": return <StaffPage {...props} />;
      case "pages": return <PagesPage {...props} />;
      case "sermon-notes": return caps.push ? <SermonNotesPage {...props} /> : <HomepagePage {...props} />;
      case "notifications": return caps.push ? <NotificationsPage {...props} /> : <HomepagePage {...props} />;
      case "submissions": return <SubmissionsPage {...props} />;
      case "mobile": return caps.push ? <MobileAppPage {...props} /> : <HomepagePage {...props} />;
      case "navigation": return <NavigationPage {...props} />;
      case "health": return <HealthPage {...props} />;
      case "settings": return <SettingsPage {...props} />;
      default: return <HomepagePage {...props} />;
    }
  };

  return (
    <>
      <GlobalStyle primaryColor={primaryColor} accentColor={accentColor} />
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar page={page} setPage={setPage} unread={unread} user={user} onSignOut={handleSignOut} churchName={churchName} caps={caps} />
        <div style={{ marginLeft: 240, flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
          <TopBar title={PAGE_TITLES[page]} />
          <main style={{ flex: 1, background: "#faf8f3" }}>
            {renderPage()}
          </main>
        </div>
      </div>
      <ToastStack toasts={toasts} />
    </>
  );
}
