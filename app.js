// PC web planner. Reads and writes the same Firestore data as the phone app:
// users/{uid}/days/{yyyy-MM-dd} and users/{uid}/meta/main, each { json, updatedAt, device }.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, getDoc, updateDoc, addDoc, deleteDoc, arrayUnion, arrayRemove,
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
const SAW_FULL = [
  [-1, "신체 (운동·휴식·건강)"], [-2, "정신 (독서·배움·계획)"], [-3, "영적 (가치·성찰·명상)"], [-4, "사회·정서 (관계·봉사)"],
];
const ISO_DAY = { 1: "월", 2: "화", 3: "수", 4: "목", 5: "금", 6: "토", 7: "일" };
const WEEK_ORDER = [7, 1, 2, 3, 4, 5, 6];
const VIEWS = { family: "family-view", day: "day-view", week: "week-view", month: "month-view", notebook: "notebook-view", compass: "compass-view", recurring: "recurring-view" };
const DOW = "일월화수목금토";

const state = {
  uid: null,
  days: new Map(), // date -> day object
  meta: null,
  current: iso(new Date()),
  week: null, // Sunday of the week shown in the week tab
  month: null, // "yyyy-MM" shown in the month tab
  tab: "day",
  editingNote: false,
  nbOnlyOpen: false,
  unsubs: [],
  family: null, // { id, members, names }
  familyItems: [],
  familyUnsubs: [],
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
    Object.values(VIEWS).forEach((v) => { $(v).hidden = true; });
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
  state.unsubs.push(onSnapshot(doc(db, "users", user.uid, "meta", "family"), (d) => {
    switchFamily(d.exists() ? d.data().familyId : null);
  }));
  state.unsubs.push(() => switchFamily(null));
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
  for (const [t, v] of Object.entries(VIEWS)) $(v).hidden = t !== tab;
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
  try {
    renderTab();
    $("error-banner").hidden = true;
  } catch (e) {
    // Show the problem instead of leaving a blank page.
    console.error(e);
    $("error-banner").hidden = false;
    $("error-banner").textContent = "화면을 그리다 오류가 났습니다: " + e.message + " (이 문구를 알려 주세요)";
  }
}
function renderTab() {
  ({ family: renderFamily, day: renderDay, week: renderWeek, month: renderMonth, notebook: renderNotebook,
    compass: renderCompass, recurring: renderRecurring })[state.tab]();
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
  renderFamilyToday(date);

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

// ---------- shared part (meta): mission, values, roles, goals, weekly goals, month notes, recurring ----------
function getMeta() {
  const base = { mission: "", values: [], roles: [], goals: [], weeklyGoals: [], monthNotes: {}, recurring: [] };
  return { ...base, ...JSON.parse(JSON.stringify(state.meta || {})) };
}
let metaTimer = null;
function updateMeta(fn, delay = 0) {
  const meta = getMeta();
  fn(meta);
  state.meta = meta;
  clearTimeout(metaTimer);
  if (delay) metaTimer = setTimeout(() => saveMeta(state.meta), delay);
  else { saveMeta(meta); render(); }
}
function addTaskTo(date, p, text, extra = {}) {
  const day = getDay(date);
  day.tasks.push({
    id: newId(), date, p, order: nextOrder(day, p), text, status: "OPEN",
    delegatedTo: "", goalId: null, forwardedFrom: "", created: Date.now(), recurringId: null, ...extra,
  });
  saveDay(date, day);
}
function toast(msg) { setSaveState(msg); }

// ---------- modal form ----------
let modalSubmit = null;
let modalDelete = null;
function openForm(title, fields, onSave, onDelete) {
  $("modal-title").textContent = title;
  $("modal-fields").innerHTML = fields.map((f) => {
    const v = f.value ?? "";
    if (f.type === "textarea") return `<label>${esc(f.label)}<textarea name="${f.name}" rows="3">${esc(v)}</textarea></label>`;
    if (f.type === "select") {
      return `<label>${esc(f.label)}<select name="${f.name}">${f.options.map(([ov, ol]) =>
        `<option value="${esc(ov)}" ${String(ov) === String(v) ? "selected" : ""}>${esc(ol)}</option>`).join("")}</select></label>`;
    }
    if (f.type === "chips" || f.type === "multichips") {
      const kind = f.type === "chips" ? "radio" : "checkbox";
      const sel = new Set([].concat(v).map(String));
      return `<label>${esc(f.label)}</label><div class="chips" data-field="${f.name}">${f.options.map(([ov, ol]) =>
        `<label><input type="${kind}" name="${f.name}" value="${esc(ov)}" ${sel.has(String(ov)) ? "checked" : ""}><span>${esc(ol)}</span></label>`).join("")}</div>`;
    }
    return `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || "text"}" value="${esc(v)}" ${f.required ? "required" : ""}></label>`;
  }).join("");
  modalSubmit = onSave;
  modalDelete = onDelete || null;
  $("modal-delete").hidden = !onDelete;
  $("modal").showModal();
  $("modal-fields").querySelector("input:not([type=radio]):not([type=checkbox]), textarea")?.focus();
}
$("modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData($("modal-form"));
  const values = {};
  for (const el of $("modal-fields").querySelectorAll("[name]")) {
    if (el.type === "checkbox") values[el.name] = fd.getAll(el.name);
    else values[el.name] = fd.get(el.name) ?? "";
  }
  if (modalSubmit && modalSubmit(values) === false) return;
  $("modal").close();
});
$("modal-cancel").onclick = () => $("modal").close();
$("modal-delete").onclick = () => { if (modalDelete && modalDelete() !== false) $("modal").close(); };

// ---------- week ----------
function renderWeek() {
  if (!state.week) state.week = weekStart(iso(new Date()));
  const ws = state.week;
  const today = iso(new Date());
  $("week-label").textContent = `${shortDate(ws)} ~ ${shortDate(addDays(ws, 6))}` + (ws === weekStart(today) ? " · 이번 주" : "");
  $("week-strip").innerHTML = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const date = addDays(ws, i);
    const d = state.days.get(date) || emptyDay();
    const open = d.tasks.filter(isOpen).length;
    const done = d.tasks.filter((t) => t.status === "DONE").length;
    const cls = i === 0 ? "sun" : i === 6 ? "sat" : "";
    return `<div class="wday ${date === today ? "today" : ""}" data-go="${date}">
      <div class="dn ${cls}">${DOW[i]}</div><div class="dd">${parse(date).getDate()}</div>
      <div class="stat">${open + done ? `${done}/${open + done}` : ""}</div>
      <div class="ap">${d.appointments.length ? `일정 ${d.appointments.length}` : ""}</div>
      <div class="fm">${famCount(date) ? `가족 ${famCount(date)}` : ""}</div></div>`;
  }).join("");
  const weekFam = state.family ? state.familyItems.filter((i) => i.type === "event" && i.date >= ws && i.date <= addDays(ws, 6))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)) : [];
  $("week-family").hidden = !state.family;
  $("week-family-list").innerHTML = weekFam.map((i) => famRow(i, { showDate: true })).join("") ||
    `<p class="hint">이번 주 가족 일정이 없습니다. <a href="#" data-goto="family">가족</a> 탭에서 추가할 수 있습니다.</p>`;
  const meta = getMeta();
  const goalsOf = (area) => meta.weeklyGoals.filter((g) => g.weekStart === ws && g.area === area);
  const areaHtml = (area, name) => `<div class="area" data-area="${area}"><h3>${esc(name)}</h3>
    ${goalsOf(area).map((g) => `<div class="row ${g.done ? "done" : ""}" data-wgid="${g.id}">
      <input type="checkbox" data-act="wg-toggle" ${g.done ? "checked" : ""}>
      <div class="grow"><span>${esc(g.text)}</span></div>
      <div class="actions"><button class="icon" data-act="wg-today" title="오늘 할 일(A)로 추가">→ 오늘</button>
      <button class="icon" data-act="wg-del" title="삭제">✕</button></div></div>`).join("")}
    <form class="addrow" data-act="wg-add"><input placeholder="이번 주 목표 추가 (Enter)" autocomplete="off"></form></div>`;
  $("week-saw").innerHTML = SAW_FULL.map(([a, n]) => areaHtml(a, n)).join("");
  $("week-roles").innerHTML = meta.roles.map((r) => areaHtml(r.id, r.name)).join("") ||
    `<p class="hint">역할이 없습니다. <a href="#" data-goto="compass">가치·목표</a> 탭에서 역할을 추가하세요.</p>`;
}
$("week-prev").onclick = () => { state.week = addDays(state.week, -7); renderWeek(); };
$("week-next").onclick = () => { state.week = addDays(state.week, 7); renderWeek(); };
$("week-this").onclick = () => { state.week = weekStart(iso(new Date())); renderWeek(); };
$("day-view").addEventListener("click", (e) => { if (e.target.dataset.goto) showTab(e.target.dataset.goto); });
$("week-strip").addEventListener("click", (e) => { const go = e.target.closest("[data-go]")?.dataset.go; if (go) goTo(go); });
$("week-view").addEventListener("click", (e) => {
  if (e.target.dataset.goto) { e.preventDefault(); showTab(e.target.dataset.goto); return; }
  const act = e.target.dataset.act;
  const row = e.target.closest("[data-wgid]");
  if (!row || !act) return;
  const id = Number(row.dataset.wgid);
  if (act === "wg-del") updateMeta((m) => { m.weeklyGoals = m.weeklyGoals.filter((g) => g.id !== id); });
  if (act === "wg-today") {
    const g = getMeta().weeklyGoals.find((x) => x.id === id);
    if (g) { addTaskTo(iso(new Date()), "A", g.text); toast("오늘 할 일(A)에 추가했습니다"); }
  }
});
$("week-view").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "wg-toggle") return;
  const id = Number(e.target.closest("[data-wgid]").dataset.wgid);
  updateMeta((m) => { const g = m.weeklyGoals.find((x) => x.id === id); if (g) g.done = e.target.checked; });
});
$("week-view").addEventListener("submit", (e) => {
  if (e.target.dataset.act !== "wg-add") return;
  e.preventDefault();
  const input = e.target.querySelector("input");
  const text = input.value.trim();
  if (!text) return;
  const area = Number(e.target.closest("[data-area]").dataset.area);
  updateMeta((m) => { m.weeklyGoals.push({ id: newId(), weekStart: state.week, area, text, done: false }); });
  $("week-view").querySelector(`[data-area="${area}"] input:not([type=checkbox])`)?.focus();
});

// ---------- month ----------
function renderMonth() {
  if (!state.month) state.month = iso(new Date()).slice(0, 7);
  const [y, m] = state.month.split("-").map(Number);
  const today = iso(new Date());
  $("month-label").textContent = `${y}년 ${m}월` + (state.month === today.slice(0, 7) ? " · 이번 달" : "");
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  let html = [..."일월화수목금토"].map((w, i) => `<div class="wh ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</div>`).join("");
  for (let i = 0; i < first.getDay(); i++) html += `<div class="cell empty"></div>`;
  for (let n = 1; n <= days; n++) {
    const date = `${state.month}-${pad(n)}`;
    const d = state.days.get(date) || emptyDay();
    const open = d.tasks.filter(isOpen).length;
    const dow = new Date(y, m - 1, n).getDay();
    html += `<div class="cell ${date === today ? "today" : ""}" data-go="${date}">
      <div class="d ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}">${n}</div>
      ${open ? `<div class="t">할 일 ${open}</div>` : ""}${d.appointments.length ? `<div class="a">일정 ${d.appointments.length}</div>` : ""}${famCount(date) ? `<div class="f">가족 ${famCount(date)}</div>` : ""}</div>`;
  }
  $("calendar").innerHTML = html;
  const note = $("month-note");
  if (document.activeElement !== note) note.value = getMeta().monthNotes[state.month] || "";
  const appts = [...state.days.entries()].filter(([date]) => date.startsWith(state.month))
    .flatMap(([date, d]) => d.appointments.map((a) => ({ ...a, date })))
    .concat(state.familyItems.filter((i) => i.type === "event" && i.date.startsWith(state.month))
      .map((i) => ({ date: i.date, time: i.time, title: i.text, who: famWho(i.assignee) })))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  $("month-fam-add").hidden = !state.family;
  $("month-appts").innerHTML = appts.map((a) => `<div class="mappt" data-go="${a.date}">
    <span class="md">${label(a.date)}</span><span class="time">${esc(a.time || "종일")}</span>
    <span>${esc(a.title)}${a.who ? ` <span class="famtag">가족 · ${esc(a.who)}</span>` : ""}</span></div>`).join("") ||
    `<p class="hint">이번 달에 등록된 일정이 없습니다.</p>`;
}
function shiftMonth(n) {
  const [y, m] = state.month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  renderMonth();
}
$("month-prev").onclick = () => shiftMonth(-1);
$("month-next").onclick = () => shiftMonth(1);
$("month-this").onclick = () => { state.month = iso(new Date()).slice(0, 7); renderMonth(); };
$("month-view").addEventListener("click", (e) => {
  if (e.target.dataset.goto) { showTab(e.target.dataset.goto); return; }
  const go = e.target.closest("[data-go]")?.dataset.go;
  if (go) goTo(go);
});
$("month-note").addEventListener("input", (e) => {
  const month = state.month;
  updateMeta((m) => { if (e.target.value) m.monthNotes[month] = e.target.value; else delete m.monthNotes[month]; }, 800);
});

// ---------- values, roles, goals ----------
function renderCompass() {
  const meta = getMeta();
  const mission = $("mission");
  if (document.activeElement !== mission) mission.value = meta.mission;
  $("values").innerHTML = meta.values.map((v, i) => `<div class="row" data-vid="${v.id}">
    <span class="num">${i + 1}</span>
    <div class="grow"><span>${esc(v.title)}</span>${v.description ? `<small>${esc(v.description)}</small>` : ""}</div>
    <div class="actions"><button class="icon" data-act="v-up" title="위로">▲</button><button class="icon" data-act="v-down" title="아래로">▼</button>
    <button class="icon" data-act="v-edit" title="수정">✎</button></div></div>`).join("") ||
    `<p class="hint">예) 가족, 건강, 정직, 성장 …</p>`;
  $("roles").innerHTML = meta.roles.map((r) => `<div class="row" data-rid="${r.id}">
    <div class="grow"><span>${esc(r.name)}</span></div>
    <div class="actions"><button class="icon" data-act="r-edit" title="수정">✎</button></div></div>`).join("") ||
    `<p class="hint">예) 남편·아내, 부모, 팀장, 친구, 나 자신 …</p>`;
  const roleName = Object.fromEntries(meta.roles.map((r) => [r.id, r.name]));
  const valueName = Object.fromEntries(meta.values.map((v) => [v.id, v.title]));
  const goals = [...meta.goals].sort((a, b) => (a.done - b.done) || (a.due || "9999").localeCompare(b.due || "9999"));
  $("goals").innerHTML = goals.map((g) => {
    const sub = [roleName[g.roleId], valueName[g.valueId] && `가치: ${valueName[g.valueId]}`, g.due && `~${shortDate(g.due)}`].filter(Boolean);
    return `<div class="row ${g.done ? "done" : ""}" data-gid="${g.id}">
      <input type="checkbox" data-act="g-toggle" ${g.done ? "checked" : ""}>
      <div class="grow"><span>${esc(g.title)}</span>${sub.length ? `<small>${esc(sub.join(" · "))}</small>` : ""}</div>
      <div class="actions"><button class="icon" data-act="g-today" title="오늘 할 일(A)로 추가">→ 오늘</button>
      <button class="icon" data-act="g-edit" title="수정">✎</button></div></div>`;
  }).join("") || `<p class="hint">장기 목표를 추가하고 '→ 오늘'로 오늘 할 일에 보내 보세요.</p>`;
}
$("mission").addEventListener("input", (e) => updateMeta((m) => { m.mission = e.target.value; }, 800));

function valueForm(v) {
  openForm(v ? "지배 가치 수정" : "지배 가치 추가", [
    { name: "title", label: "가치 (예: 가족)", value: v?.title, required: true },
    { name: "description", label: "설명 (예: 매일 가족과 저녁을 함께한다)", type: "textarea", value: v?.description },
  ], ({ title, description }) => {
    if (!title.trim()) return false;
    updateMeta((m) => {
      if (v) Object.assign(m.values.find((x) => x.id === v.id), { title: title.trim(), description: description.trim() });
      else m.values.push({ id: newId(), title: title.trim(), description: description.trim() });
    });
  }, v && (() => {
    if (!confirm("이 가치를 삭제할까요?")) return false;
    updateMeta((m) => {
      m.values = m.values.filter((x) => x.id !== v.id);
      m.goals.forEach((g) => { if (g.valueId === v.id) g.valueId = null; });
    });
  }));
}
function roleForm(r) {
  openForm(r ? "역할 수정" : "역할 추가", [{ name: "name", label: "역할 이름", value: r?.name, required: true }], ({ name }) => {
    if (!name.trim()) return false;
    updateMeta((m) => {
      if (r) m.roles.find((x) => x.id === r.id).name = name.trim();
      else m.roles.push({ id: newId(), name: name.trim() });
    });
  }, r && (() => {
    if (!confirm("역할을 삭제할까요? 이 역할의 주간 목표도 함께 지워집니다.")) return false;
    updateMeta((m) => {
      m.roles = m.roles.filter((x) => x.id !== r.id);
      m.goals.forEach((g) => { if (g.roleId === r.id) g.roleId = null; });
      m.weeklyGoals = m.weeklyGoals.filter((w) => w.area !== r.id);
    });
  }));
}
function goalForm(g) {
  const meta = getMeta();
  openForm(g ? "목표 수정" : "목표 추가", [
    { name: "title", label: "목표", value: g?.title, required: true },
    { name: "roleId", label: "역할", type: "select", value: g?.roleId ?? "", options: [["", "없음"], ...meta.roles.map((r) => [r.id, r.name])] },
    { name: "valueId", label: "가치", type: "select", value: g?.valueId ?? "", options: [["", "없음"], ...meta.values.map((v) => [v.id, v.title])] },
    { name: "due", label: "기한", type: "date", value: g?.due },
  ], ({ title, roleId, valueId, due }) => {
    if (!title.trim()) return false;
    const fields = { title: title.trim(), roleId: roleId ? Number(roleId) : null, valueId: valueId ? Number(valueId) : null, due: due || "" };
    updateMeta((m) => {
      if (g) Object.assign(m.goals.find((x) => x.id === g.id), fields);
      else m.goals.push({ id: newId(), ...fields, done: false });
    });
  }, g && (() => {
    if (!confirm("목표를 삭제할까요?")) return false;
    updateMeta((m) => { m.goals = m.goals.filter((x) => x.id !== g.id); });
  }));
}
document.querySelectorAll("[data-add]").forEach((b) => {
  b.onclick = () => ({ value: () => valueForm(null), role: () => roleForm(null), goal: () => goalForm(null), recurring: () => recurringForm(null) })[b.dataset.add]();
});
$("compass-view").addEventListener("click", (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const meta = getMeta();
  const vid = Number(e.target.closest("[data-vid]")?.dataset.vid);
  const rid = Number(e.target.closest("[data-rid]")?.dataset.rid);
  const gid = Number(e.target.closest("[data-gid]")?.dataset.gid);
  if (act === "v-edit") valueForm(meta.values.find((x) => x.id === vid));
  if (act === "v-up" || act === "v-down") {
    updateMeta((m) => {
      const i = m.values.findIndex((x) => x.id === vid);
      const j = act === "v-up" ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < m.values.length) [m.values[i], m.values[j]] = [m.values[j], m.values[i]];
    });
  }
  if (act === "r-edit") roleForm(meta.roles.find((x) => x.id === rid));
  if (act === "g-edit") goalForm(meta.goals.find((x) => x.id === gid));
  if (act === "g-today") {
    const g = meta.goals.find((x) => x.id === gid);
    if (g) { addTaskTo(iso(new Date()), "A", g.title, { goalId: g.id }); toast("오늘 할 일(A)에 추가했습니다"); }
  }
});
$("compass-view").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "g-toggle") return;
  const gid = Number(e.target.closest("[data-gid]").dataset.gid);
  updateMeta((m) => { const g = m.goals.find((x) => x.id === gid); if (g) g.done = e.target.checked; });
});

// ---------- recurring ----------
function describeRule(r) {
  const days = [...(r.days || [])].sort();
  if (r.weekly) return `매주 ${ISO_DAY[days[0]] || ""}요일`;
  if (days.length === 7) return "매일";
  if (days.join() === "1,2,3,4,5") return "평일";
  if (days.join() === "6,7") return "주말";
  return WEEK_ORDER.filter((d) => days.includes(d)).map((d) => ISO_DAY[d]).join("·");
}
function renderRecurring() {
  const rules = getMeta().recurring;
  $("recurring-list").innerHTML = rules.map((r) => `<div class="row ${r.active ? "" : "done"}" data-rcid="${r.id}">
    <input type="checkbox" class="switch" data-act="rc-active" ${r.active ? "checked" : ""} title="켜기/일시중지">
    <span class="label ${r.p}">${r.p}</span>
    <div class="grow"><span>${esc(r.text)}</span><small>${esc(describeRule(r))}${r.active ? "" : " · 일시중지"}</small></div>
    <div class="actions"><button class="icon" data-act="rc-edit" title="수정">✎</button></div></div>`).join("") ||
    `<p class="hint">아직 반복 업무가 없습니다.</p>`;
}
function recurringForm(r) {
  const days = r ? [...r.days].sort() : [];
  const repeat = !r ? "daily" : r.weekly ? "weekly" : days.length === 7 ? "daily" : days.join() === "1,2,3,4,5" ? "weekdays" : "custom";
  const dayOptions = WEEK_ORDER.map((d) => [d, ISO_DAY[d]]);
  openForm(r ? "반복 업무 수정" : "반복 업무 추가", [
    { name: "text", label: "할 일", value: r?.text, required: true },
    { name: "p", label: "우선순위", type: "chips", value: r?.p || "A", options: [["A", "A"], ["B", "B"], ["C", "C"]] },
    { name: "repeat", label: "반복", type: "chips", value: repeat, options: [["daily", "매일"], ["weekdays", "평일"], ["weekly", "매주 (요일 하나)"], ["custom", "요일 지정"]] },
    { name: "days", label: "요일 (매주: 첫 번째 고른 요일 / 요일 지정: 여러 개)", type: "multichips", value: r ? days : [1], options: dayOptions },
  ], ({ text, p, repeat: rep, days: picked }) => {
    if (!text.trim()) return false;
    const chosen = (picked || []).map(Number);
    let ruleDays;
    if (rep === "daily") ruleDays = [1, 2, 3, 4, 5, 6, 7];
    else if (rep === "weekdays") ruleDays = [1, 2, 3, 4, 5];
    else if (rep === "weekly") ruleDays = chosen.length ? [WEEK_ORDER.find((d) => chosen.includes(d))] : [1];
    else ruleDays = chosen;
    if (!ruleDays.length) { alert("요일을 하나 이상 고르세요."); return false; }
    const fields = { text: text.trim(), p: p || "A", weekly: rep === "weekly", days: ruleDays };
    updateMeta((m) => {
      if (r) Object.assign(m.recurring.find((x) => x.id === r.id), fields);
      else m.recurring.push({ id: newId(), ...fields, active: true });
    });
    toast("저장했습니다. 폰 앱을 열면 해당 날짜의 할 일이 만들어집니다");
  }, r && (() => {
    if (!confirm("반복 업무를 삭제할까요? 이미 생긴 할 일은 기록으로 남습니다.")) return false;
    updateMeta((m) => { m.recurring = m.recurring.filter((x) => x.id !== r.id); });
  }));
}
$("recurring-list").addEventListener("click", (e) => {
  if (e.target.dataset.act !== "rc-edit") return;
  const id = Number(e.target.closest("[data-rcid]").dataset.rcid);
  recurringForm(getMeta().recurring.find((x) => x.id === id));
});
$("recurring-list").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "rc-active") return;
  const id = Number(e.target.closest("[data-rcid]").dataset.rcid);
  updateMeta((m) => { const r = m.recurring.find((x) => x.id === id); if (r) r.active = e.target.checked; });
});

// ---------- family (shared with the family members) ----------
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
let familyId = null;
function switchFamily(id) {
  if (id === familyId) return;
  state.familyUnsubs.forEach((u) => u());
  state.familyUnsubs = [];
  familyId = id;
  state.family = null;
  state.familyItems = [];
  if (id) {
    state.familyUnsubs.push(onSnapshot(doc(db, "families", id), (d) => {
      state.family = d.exists() ? { id, members: d.data().members || [], names: d.data().names || {} } : null;
      render();
    }));
    state.familyUnsubs.push(onSnapshot(collection(db, "families", id, "items"), (snap) => {
      state.familyItems = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
      render();
    }));
  }
  render();
}
const famName = (uid) => state.family?.names?.[uid] || "가족";
const famWho = (uid) => (uid ? famName(uid) : "같이");
const showCode = (c) => (c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : c);
function familyTaskList() {
  const weekAgo = Date.now() - 7 * 864e5;
  const t = state.familyItems.filter((i) => i.type === "task");
  return [...t.filter((i) => !i.done).sort((a, b) => a.createdAt - b.createdAt),
    ...t.filter((i) => i.done && i.doneAt > weekAgo).sort((a, b) => b.doneAt - a.doneAt)];
}
function famRow(i, { showDate = false } = {}) {
  const today = iso(new Date());
  const sub = [];
  if (showDate && i.date) sub.push(label(i.date));
  if (i.type !== "shop") sub.push(`담당: ${famWho(i.assignee)}`);
  if (i.done && i.doneBy) sub.push(`완료: ${famName(i.doneBy)}`);
  else if (i.createdBy && i.type !== "event") sub.push(`${famName(i.createdBy)} 추가`);
  const lead = i.type === "event"
    ? `<span class="ftime">${esc(i.time || "종일")}</span>`
    : `<input type="checkbox" data-fact="toggle" ${i.done ? "checked" : ""}>`;
  return `<div class="row ${i.done ? "done" : ""} ${i.type === "event" && i.date < today ? "past" : ""}" data-fid="${i.id}">
    ${lead}<div class="grow"><span>${esc(i.text)}</span><small>${esc(sub.join(" · "))}</small></div>
    <div class="actions"><button class="icon" data-fact="del" title="삭제">✕</button></div></div>`;
}
function whoOptions() {
  return `<option value="">같이</option>` + (state.family?.members || []).map((u) => `<option value="${u}">${esc(famName(u))}</option>`).join("");
}
function renderFamily() {
  const fam = state.family;
  $("family-connect").hidden = !!fam;
  $("family-main").hidden = !fam;
  if (!fam) return;
  $("fam-members").textContent = fam.members.map(famName).join(" · ");
  $("fam-code-show").textContent = showCode(fam.id);
  for (const id of ["fam-task-who", "fam-event-who"]) {
    const sel = $(id);
    const v = sel.value;
    sel.innerHTML = whoOptions();
    sel.value = v;
  }
  if (!$("fam-event-date").value) $("fam-event-date").value = iso(new Date());
  $("fam-tasks").innerHTML = familyTaskList().map((i) => famRow(i)).join("") || `<p class="hint">함께 챙길 일을 추가해 보세요.</p>`;
  const shop = state.familyItems.filter((i) => i.type === "shop");
  const open = shop.filter((i) => !i.done).sort((a, b) => a.createdAt - b.createdAt);
  const done = shop.filter((i) => i.done).sort((a, b) => b.doneAt - a.doneAt);
  $("fam-shop").innerHTML = [...open, ...done].map((i) => famRow(i)).join("") +
    (done.length ? `<p><button class="ghost small" id="fam-clear">산 것 ${done.length}개 지우기</button></p>` : "") ||
    `<p class="hint">우유, 세제, 아이 준비물 … 생각날 때 바로 적어 두세요.</p>`;
  const today = iso(new Date());
  const ev = state.familyItems.filter((i) => i.type === "event");
  const upcoming = ev.filter((i) => i.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = ev.filter((i) => i.date < today).sort((a, b) => (b.date + a.time).localeCompare(a.date + b.time)).slice(0, 10);
  $("fam-events").innerHTML = (upcoming.map((i) => famRow(i, { showDate: true })).join("") || `<p class="hint">다가오는 가족 일정이 없습니다.</p>`) +
    (past.length ? `<h3 class="wg-area">지난 일정</h3>` + past.map((i) => famRow(i, { showDate: true })).join("") : "");
}
function renderFamilyToday(date) {
  const fam = state.family;
  $("family-card").hidden = !fam;
  if (!fam) return;
  const events = state.familyItems.filter((i) => i.type === "event" && i.date === date).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const tasks = familyTaskList().filter((i) => !i.done).slice(0, 5);
  $("family-today").innerHTML = [...events, ...tasks].map((i) => famRow(i)).join("") ||
    `<p class="hint">오늘 가족 일정과 남은 가족 할 일이 없습니다.</p>`;
}
function famItemsRef() { return collection(db, "families", familyId, "items"); }
function famAdd(type, text, assignee = "", date = "", time = "") {
  if (!familyId) return;
  addDoc(famItemsRef(), {
    type, text, date, time, assignee, done: false, doneBy: "", createdBy: state.uid, createdAt: Date.now(), doneAt: 0,
  }).catch((e) => toast("저장 실패: " + e.message));
}
document.addEventListener("click", (e) => {
  const act = e.target.dataset.fact;
  const row = e.target.closest("[data-fid]");
  if (act === "del" && row && confirm("삭제할까요?")) deleteDoc(doc(db, "families", familyId, "items", row.dataset.fid));
  if (e.target.id === "fam-clear") {
    state.familyItems.filter((i) => i.type === "shop" && i.done).forEach((i) => deleteDoc(doc(db, "families", familyId, "items", i.id)));
  }
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.fact !== "toggle") return;
  const id = e.target.closest("[data-fid]").dataset.fid;
  const done = e.target.checked;
  updateDoc(doc(db, "families", familyId, "items", id), { done, doneBy: done ? state.uid : "", doneAt: done ? Date.now() : 0 });
});
$("fam-task-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("fam-task-text").value.trim();
  if (!text) return;
  famAdd("task", text, $("fam-task-who").value);
  $("fam-task-text").value = "";
};
$("fam-shop-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("fam-shop-text").value.trim();
  if (!text) return;
  famAdd("shop", text);
  $("fam-shop-text").value = "";
};
$("fam-event-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("fam-event-text").value.trim();
  const date = $("fam-event-date").value;
  if (!text || !date) return;
  famAdd("event", text, $("fam-event-who").value, date, $("fam-event-time").value);
  $("fam-event-text").value = "";
};
async function famConnect(join) {
  $("fam-error").textContent = "";
  const name = $("fam-name").value.trim() || "가족";
  try {
    let id;
    if (join) {
      id = $("fam-code").value.toUpperCase().split("").filter((c) => CODE_CHARS.includes(c)).join("");
      if (id.length !== 8) throw new Error("코드는 8자리입니다 (예: K7Q2-9XMB)");
      const ref = doc(db, "families", id);
      if (!(await getDoc(ref)).exists()) throw new Error("그 코드의 가족을 찾을 수 없습니다");
      await updateDoc(ref, { members: arrayUnion(state.uid), [`names.${state.uid}`]: name });
    } else {
      id = Array.from({ length: 8 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
      await setDoc(doc(db, "families", id), { members: [state.uid], names: { [state.uid]: name }, createdAt: Date.now() });
    }
    await setDoc(doc(db, "users", state.uid, "meta", "family"), { familyId: id });
  } catch (e) {
    $("fam-error").textContent = e.message;
  }
}
$("fam-create").onclick = () => famConnect(false);
$("fam-join").onclick = () => famConnect(true);
$("fam-rename").onclick = () => {
  const name = prompt("가족에게 보일 내 이름", famName(state.uid));
  if (name && name.trim()) updateDoc(doc(db, "families", familyId), { [`names.${state.uid}`]: name.trim() });
};
$("fam-leave").onclick = async () => {
  if (!confirm("가족에서 나갈까요? 같은 코드로 다시 참여할 수 있습니다.")) return;
  await updateDoc(doc(db, "families", familyId), { members: arrayRemove(state.uid) }).catch(() => {});
  await deleteDoc(doc(db, "users", state.uid, "meta", "family"));
};

function famCount(date) {
  return state.family ? state.familyItems.filter((i) => i.type === "event" && i.date === date).length : 0;
}
