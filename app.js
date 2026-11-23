// PC web planner. Reads and writes the same Firestore data as the phone app:
// users/{uid}/days/{yyyy-MM-dd} and users/{uid}/meta/main, each { json, updatedAt, device }.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBFK6Vicph-Ko2sYSwXiP7p0O8eQyFzvps",
  authDomain: "franklin-planner-b419a.firebaseapp.com",
  projectId: "franklin-planner-b419a",
  storageBucket: "franklin-planner-b419a.firebasestorage.app",
  messagingSenderId: "729497032469",
  appId: "1:729497032469:web:97c197171024a9d11a3b1c",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const STATUS = {
  OPEN: { sym: "", label: "미완료" },
  DONE: { sym: "✓", label: "완료" },
  IN_PROGRESS: { sym: "●", label: "진행 중" },
  FORWARDED: { sym: "→", label: "이월" },
  DELEGATED: { sym: "◯", label: "위임" },
  DELETED: { sym: "✕", label: "삭제" },
};
const SAW = { "-1": "신체", "-2": "정신", "-3": "영적", "-4": "사회·정서" };
const DOW = "일월화수목금토";

const state = {
  uid: null,
  days: new Map(), // date -> day object
  meta: null,
  current: iso(new Date()),
  tab: "day",
  editingNote: false,
  nbOnlyOpen: false,
  unsubs: [],
};

// ---------- dates ----------
function pad(n) { return String(n).padStart(2, "0"); }
function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
function label(s) { const d = parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`; }
function shortDate(s) { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; }
function weekStart(s) { const d = parse(s); d.setDate(d.getDate() - d.getDay()); return iso(d); }
function nowHM() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let idSeq = 0;
function newId() { return Date.now() * 1000 + (idSeq++ % 1000); }

// ---------- data ----------
function emptyDay() { return { tasks: [], appointments: [], note: "", reflection: { good: "", improve: "", tomorrow: "" } }; }
function getDay(date) {
  const d = state.days.get(date);
  const base = emptyDay();
  if (!d) return base;
  const copy = JSON.parse(JSON.stringify(d));
  return { ...base, ...copy, reflection: { ...base.reflection, ...(copy.reflection || {}) } };
}
const pOrder = { A: 0, B: 1, C: 2 };
function sorted(tasks) {
  return [...tasks].sort((a, b) => (pOrder[a.p] - pOrder[b.p]) || (a.order - b.order) || (a.created - b.created));
}
function labels(tasks) {
  const n = {};
  const out = {};
  for (const t of sorted(tasks)) { n[t.p] = (n[t.p] || 0) + 1; out[t.id] = t.p + n[t.p]; }
  return out;
}
function nextOrder(day, p) { return Math.max(0, ...day.tasks.filter((t) => t.p === p).map((t) => t.order)) + 1; }
const isOpen = (t) => t.status === "OPEN" || t.status === "IN_PROGRESS";

const pendingSaves = new Map();
function saveDay(date, day, delay = 0) {
  state.days.set(date, day);
  clearTimeout(pendingSaves.get(date));
  const write = () => {
    pendingSaves.delete(date);
    setSaveState("저장 중…");
    setDoc(doc(db, "users", state.uid, "days", date), { json: JSON.stringify(day), updatedAt: Date.now(), device: "web" })
      .then(() => setSaveState("저장됨 " + nowHM()))
      .catch((e) => setSaveState("저장 실패: " + e.message));
  };
  if (delay) pendingSaves.set(date, setTimeout(write, delay)); else write();
}
function saveMeta(meta) {
  state.meta = meta;
  setDoc(doc(db, "users", state.uid, "meta", "main"), { json: JSON.stringify(meta), updatedAt: Date.now(), device: "web" })
    .catch((e) => setSaveState("저장 실패: " + e.message));
}
function setSaveState(text) { $("save-state").textContent = text; }

// ---------- auth & listeners ----------
$("signin").onclick = async () => {
  $("login-error").textContent = "";
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { $("login-error").textContent = "로그인 실패: " + e.message; }
};

onAuthStateChanged(auth, (user) => {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  state.days.clear();
  state.meta = null;
  $("loading").hidden = true;
  if (!user) {
    state.uid = null;
    $("login").hidden = false;
    $("tabs").hidden = true;
    $("day-view").hidden = true;
    $("notebook-view").hidden = true;
    $("account").innerHTML = "";
    return;
  }
  state.uid = user.uid;
  $("login").hidden = true;
  $("tabs").hidden = false;
  $("account").innerHTML = `<span>${esc(user.email)}</span><button class="ghost small" id="signout">로그아웃</button>`;
  $("signout").onclick = () => signOut(auth);
  state.unsubs.push(onSnapshot(collection(db, "users", user.uid, "days"), (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "removed") { state.days.delete(ch.doc.id); return; }
      if (ch.doc.metadata.hasPendingWrites) return;
      try { state.days.set(ch.doc.id, JSON.parse(ch.doc.data().json)); } catch { /* skip bad doc */ }
    });
    render();
  }));
  state.unsubs.push(onSnapshot(doc(db, "users", user.uid, "meta", "main"), (d) => {
    if (d.exists() && !d.metadata.hasPendingWrites) {
      try { state.meta = JSON.parse(d.data().json); } catch { /* ignore */ }
    }
    render();
  }));
  showTab(state.tab);
});

// ---------- tabs & navigation ----------
document.querySelectorAll("#tabs button").forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("day-view").hidden = tab !== "day";
  $("notebook-view").hidden = tab !== "notebook";
  render();
}
function goTo(date) { state.current = date; state.editingNote = false; showTab("day"); }
$("prev").onclick = () => goTo(addDays(state.current, -1));
$("next").onclick = () => goTo(addDays(state.current, 1));
$("today").onclick = () => goTo(iso(new Date()));
$("date-input").onchange = (e) => { if (e.target.value) goTo(e.target.value); };
document.addEventListener("keydown", (e) => {
  if (state.tab !== "day" || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (e.key === "ArrowLeft") $("prev").click();
  if (e.key === "ArrowRight") $("next").click();
});

// ---------- rendering ----------
function render() {
  if (!state.uid) return;
  if (state.tab === "day") renderDay(); else renderNotebook();
}

function renderDay() {
  const date = state.current;
  const day = getDay(date);
  const today = iso(new Date());
  $("date-label").textContent = label(date) + (date === today ? " · 오늘" : "");
  $("date-input").value = date;
  const left = day.tasks.filter(isOpen).length;
  $("summary").textContent = day.tasks.length ? `남은 일 ${left} / ${day.tasks.length}` : "";

  const goals = Object.fromEntries((state.meta?.goals || []).map((g) => [g.id, g.title]));
  const lab = labels(day.tasks);
  $("tasks").innerHTML = sorted(day.tasks).map((t) => {
    const st = STATUS[t.status] || STATUS.OPEN;
    const inactive = ["DONE", "FORWARDED", "DELETED"].includes(t.status);
    const notes = [];
    if (t.recurringId != null) notes.push("↻ 반복");
    if (t.status === "DELEGATED") notes.push(t.delegatedTo ? `위임: ${esc(t.delegatedTo)}` : "위임");
    if (t.status === "IN_PROGRESS") notes.push("진행 중");
    if (t.status === "FORWARDED") notes.push("다른 날로 이월됨");
    if (t.forwardedFrom) notes.push(`${shortDate(t.forwardedFrom)}부터 이월`);
    if (t.goalId != null && goals[t.goalId]) notes.push(`목표: ${esc(goals[t.goalId])}`);
    return `<div class="task ${t.status} ${inactive ? "inactive" : ""}" data-id="${t.id}">
      <button class="box ${t.status}" data-act="toggle" title="완료 체크">${st.sym}</button>
      <span class="label ${t.p}">${lab[t.id]}</span>
      <div class="ttext" data-act="edit" title="눌러서 수정"><span>${esc(t.text)}</span>${notes.length ? `<small>${notes.join(" · ")}</small>` : ""}</div>
      <select data-act="menu" title="상태·이월">
        <option value="">⋯</option>
        ${Object.entries(STATUS).filter(([k]) => k !== "FORWARDED").map(([k, v]) => `<option value="${k}">${v.sym ? v.sym + " " : ""}${v.label}</option>`).join("")}
        <option value="P:A">우선순위 A</option><option value="P:B">우선순위 B</option><option value="P:C">우선순위 C</option>
        <option value="FWD">→ 다음 날로 이월</option>
        <option value="REMOVE">완전히 지우기</option>
      </select>
    </div>`;
  }).join("") || `<p class="hint">할 일이 없습니다.</p>`;

  $("appts").innerHTML = [...day.appointments].sort((a, b) => a.time.localeCompare(b.time)).map((a) =>
    `<div class="appt" data-id="${a.id}"><span class="time">${esc(a.time)}</span><span>${esc(a.title)}</span><button class="del" title="삭제">✕</button></div>`,
  ).join("") || `<p class="hint">일정이 없습니다.</p>`;

  renderWeekGoals();

  if (!state.editingNote) $("note-view").innerHTML = noteHtml(day.note);
  $("note-view").hidden = state.editingNote;
  $("note-edit").hidden = !state.editingNote;
  $("note-toggle").textContent = state.editingNote ? "완료" : "편집";
  const ta = $("note-text");
  if (document.activeElement !== ta) ta.value = day.note;

  document.querySelectorAll("[data-refl]").forEach((el) => {
    if (document.activeElement !== el) el.value = day.reflection[el.dataset.refl] || "";
  });
}

function renderWeekGoals() {
  const meta = state.meta;
  const ws = weekStart(state.current);
  const goals = (meta?.weeklyGoals || []).filter((g) => g.weekStart === ws);
  $("week-card").hidden = !meta;
  if (!meta) return;
  const roles = Object.fromEntries((meta.roles || []).map((r) => [r.id, r.name]));
  const areas = [...new Set(goals.map((g) => g.area))];
  $("week-goals").innerHTML = areas.map((a) => `<div class="wg-area">${esc(SAW[a] ? "자기 쇄신 · " + SAW[a] : roles[a] || "역할")}</div>` +
    goals.filter((g) => g.area === a).map((g) =>
      `<label class="wg ${g.done ? "done" : ""}"><input type="checkbox" data-wg="${g.id}" ${g.done ? "checked" : ""}><span>${esc(g.text)}</span></label>`,
    ).join("")).join("") || `<p class="hint">이번 주 목표가 없습니다. 폰 앱의 주간 탭에서 정할 수 있습니다.</p>`;
}

function noteHtml(note) {
  if (!note) return "";
  return note.split("\n").map((line, i) => {
    const t = line.trimStart();
    if (t.startsWith("☐") || t.startsWith("☑")) {
      const done = t.startsWith("☑");
      return `<label class="check ${done ? "done" : ""}"><input type="checkbox" data-line="${i}" ${done ? "checked" : ""}><span>${esc(t.slice(1).trim())}</span></label>`;
    }
    if (!line.trim()) return `<div class="gap"></div>`;
    return `<div class="line">${esc(line)}</div>`;
  }).join("");
}

function toggleLine(note, i) {
  const lines = note.split("\n");
  const line = lines[i] ?? "";
  const at = [...line].findIndex((c) => c === "☐" || c === "☑");
  if (at < 0) return note;
  lines[i] = line.slice(0, at) + (line[at] === "☐" ? "☑" : "☐") + line.slice(at + 1);
  return lines.join("\n");
}

// ---------- day actions ----------
function updateDay(fn, delay = 0) {
  const date = state.current;
  const day = getDay(date);
  fn(day);
  saveDay(date, day, delay);
  if (!delay) render();
}

function forwardTask(day, fromDate, t, toDate) {
  t.status = "FORWARDED";
  const target = getDay(toDate);
  target.tasks.push({
    ...t, id: newId(), date: toDate, order: nextOrder(target, t.p), status: "OPEN",
    forwardedFrom: t.forwardedFrom || fromDate, created: Date.now(),
  });
  saveDay(toDate, target);
}

$("tasks").addEventListener("click", (e) => {
  const row = e.target.closest(".task");
  if (!row) return;
  const id = Number(row.dataset.id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "toggle") {
    updateDay((day) => {
      const t = day.tasks.find((x) => x.id === id);
      if (t) t.status = t.status === "DONE" ? "OPEN" : "DONE";
    });
  } else if (act === "edit") {
    const t = getDay(state.current).tasks.find((x) => x.id === id);
    if (!t) return;
    const text = prompt("할 일 수정", t.text);
    if (text && text.trim()) updateDay((day) => { day.tasks.find((x) => x.id === id).text = text.trim(); });
  }
});

$("tasks").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "menu") return;
  const id = Number(e.target.closest(".task").dataset.id);
  const v = e.target.value;
  e.target.value = "";
  const date = state.current;
  if (v === "REMOVE" && !confirm("완전히 지울까요? 기록을 남기려면 ✕ 삭제를 고르세요.")) return;
  updateDay((day) => {
    const t = day.tasks.find((x) => x.id === id);
    if (!t) return;
    if (v === "FWD") forwardTask(day, date, t, addDays(date, 1));
    else if (v === "REMOVE") day.tasks = day.tasks.filter((x) => x.id !== id);
    else if (v.startsWith("P:")) { const p = v.slice(2); if (p !== t.p) { t.p = p; t.order = nextOrder(day, p); } }
    else if (STATUS[v]) {
      t.status = v;
      if (v === "DELEGATED") t.delegatedTo = (prompt("누구에게 맡겼나요?", t.delegatedTo || "") || "").trim();
    }
  });
});

$("forward-all").onclick = () => {
  const date = state.current;
  const day = getDay(date);
  const open = sorted(day.tasks).filter((t) => isOpen(t) && t.recurringId == null);
  if (!open.length) { alert("이월할 미완료 일이 없습니다. (반복 업무는 매일 새로 생기므로 이월하지 않습니다)"); return; }
  if (!confirm(`미완료 ${open.length}개를 ${label(addDays(date, 1))}로 이월할까요?`)) return;
  const next = addDays(date, 1);
  for (const t of open) forwardTask(day, date, day.tasks.find((x) => x.id === t.id), next);
  saveDay(date, day);
  render();
};

$("task-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("task-text").value.trim();
  if (!text) return;
  const p = $("task-p").value;
  updateDay((day) => {
    day.tasks.push({
      id: newId(), date: state.current, p, order: nextOrder(day, p), text, status: "OPEN",
      delegatedTo: "", goalId: null, forwardedFrom: "", created: Date.now(), recurringId: null,
    });
  });
  $("task-text").value = "";
  $("task-text").focus();
};

$("appt-form").onsubmit = (e) => {
  e.preventDefault();
  const title = $("appt-title").value.trim();
  const time = $("appt-time").value;
  if (!title || !time) return;
  updateDay((day) => { day.appointments.push({ id: newId(), date: state.current, time, title }); });
  $("appt-title").value = "";
};
$("appts").addEventListener("click", (e) => {
  if (!e.target.classList.contains("del")) return;
  const id = Number(e.target.closest(".appt").dataset.id);
  if (confirm("일정을 지울까요?")) updateDay((day) => { day.appointments = day.appointments.filter((a) => a.id !== id); });
});

$("week-goals").addEventListener("change", (e) => {
  const id = Number(e.target.dataset.wg);
  if (!id || !state.meta) return;
  const meta = JSON.parse(JSON.stringify(state.meta));
  const g = meta.weeklyGoals.find((x) => x.id === id);
  if (g) { g.done = e.target.checked; saveMeta(meta); render(); }
});

// ---------- note & reflection ----------
$("note-toggle").onclick = () => {
  state.editingNote = !state.editingNote;
  if (state.editingNote) { renderDay(); $("note-text").focus(); }
  else { flushNote(); renderDay(); }
};
function flushNote() {
  const t = pendingSaves.get(state.current);
  if (t) { clearTimeout(t); saveDay(state.current, getDay(state.current)); }
}
$("note-text").addEventListener("input", (e) => updateDay((day) => { day.note = e.target.value; }, 800));
$("note-view").addEventListener("change", (e) => {
  const i = e.target.dataset.line;
  if (i === undefined) return;
  updateDay((day) => { day.note = toggleLine(day.note, Number(i)); });
});
document.querySelectorAll("[data-insert]").forEach((b) => {
  b.onclick = () => {
    const ta = $("note-text");
    const prefix = b.dataset.insert === "time" ? `[${nowHM()}] ` : b.dataset.insert;
    const pos = ta.selectionStart;
    const v = ta.value;
    const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
    let lineEnd = v.indexOf("\n", pos); if (lineEnd < 0) lineEnd = v.length;
    let text, cursor;
    if (!v.slice(lineStart, lineEnd).trim()) { text = v.slice(0, lineStart) + prefix + v.slice(lineEnd); cursor = lineStart + prefix.length; }
    else { text = v.slice(0, lineEnd) + "\n" + prefix + v.slice(lineEnd); cursor = lineEnd + 1 + prefix.length; }
    ta.value = text;
    ta.focus();
    ta.setSelectionRange(cursor, cursor);
    ta.dispatchEvent(new Event("input"));
  };
});
// Enter after a check item or bullet starts the next one; Enter on an empty one ends the list.
$("note-text").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey) return;
  const ta = e.target;
  const pos = ta.selectionStart;
  const v = ta.value;
  const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
  const line = v.slice(lineStart, pos);
  const t = line.trimStart();
  const prefix = t.startsWith("☐") || t.startsWith("☑") ? "☐ " : t.startsWith("• ") ? "• " : null;
  if (!prefix) return;
  e.preventDefault();
  if (t.trim().length <= 1) {
    ta.value = v.slice(0, lineStart) + v.slice(pos);
    ta.setSelectionRange(lineStart, lineStart);
  } else {
    ta.value = v.slice(0, pos) + "\n" + prefix + v.slice(pos);
    ta.setSelectionRange(pos + 1 + prefix.length, pos + 1 + prefix.length);
  }
  ta.dispatchEvent(new Event("input"));
});
document.querySelectorAll("[data-refl]").forEach((el) => {
  el.addEventListener("input", () => updateDay((day) => { day.reflection[el.dataset.refl] = el.value; }, 800));
});
window.addEventListener("beforeunload", () => { for (const [date] of pendingSaves) saveDay(date, getDay(date)); });

// ---------- notebook ----------
$("nb-search").addEventListener("input", renderNotebook);
$("nb-all").onclick = () => { state.nbOnlyOpen = false; renderNotebook(); };
$("nb-open").onclick = () => { state.nbOnlyOpen = true; renderNotebook(); };
const openCount = (note) => note.split("\n").filter((l) => l.trimStart().startsWith("☐")).length;

function renderNotebook() {
  const q = $("nb-search").value.trim().toLowerCase();
  const all = [...state.days.entries()].filter(([, d]) => (d.note || "").trim()).sort((a, b) => b[0].localeCompare(a[0]));
  const totalOpen = all.reduce((n, [, d]) => n + openCount(d.note), 0);
  $("nb-all").textContent = `전체 ${all.length}일`;
  $("nb-open").textContent = `확인 안 한 항목 ${totalOpen}`;
  $("nb-all").classList.toggle("active", !state.nbOnlyOpen);
  $("nb-open").classList.toggle("active", state.nbOnlyOpen);
  const shown = all.filter(([, d]) => (!q || d.note.toLowerCase().includes(q)) && (!state.nbOnlyOpen || openCount(d.note) > 0));
  $("nb-list").innerHTML = shown.map(([date, d]) => {
    const open = openCount(d.note);
    return `<article class="nb-card" data-date="${date}">
      <div><span class="nb-date" data-go="${date}">${label(date)}</span>${open ? `<span class="nb-open">확인 안 한 항목 ${open}개</span>` : ""}</div>
      <div class="note">${noteHtml(d.note)}</div>
    </article>`;
  }).join("") || `<p class="hint">${all.length ? "조건에 맞는 기록이 없습니다." : "아직 기록이 없습니다."}</p>`;
}
$("nb-list").addEventListener("click", (e) => { const go = e.target.dataset.go; if (go) goTo(go); });
$("nb-list").addEventListener("change", (e) => {
  const i = e.target.dataset.line;
  const date = e.target.closest(".nb-card")?.dataset.date;
  if (i === undefined || !date) return;
  const day = getDay(date);
  day.note = toggleLine(day.note, Number(i));
  saveDay(date, day);
  renderNotebook();
});
