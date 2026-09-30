(function () {
  "use strict";

  const LOG = "[sceneTrimmer]";
  const PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch || !PluginApi.utils) {
    console.error(LOG, "PluginApi is unavailable");
    return;
  }

  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM;
  const Mousetrap = PluginApi.libraries.Mousetrap;
  const gql = PluginApi.libraries.Apollo.gql;
  const h = React.createElement;

  const PLUGIN_ID = "sceneTrimmer";
  const FIELD = "ust_trim";
  const PLAYER_ID = "VideoJsPlayer";
  // Seconds. EPS absorbs the drift between the time we seek to and the time
  // the player reports afterwards; KF_EPS lets a second ↑/↓ press move on
  // from the keyframe the first one landed on.
  const EPS = 0.05;
  const KF_EPS = 0.04;
  const MIN_LEN = 0.1;
  const SAVE_DELAY = 500;

  // --- graphql ---------------------------------------------------------------

  const RUN_OP_SRC =
    "mutation SceneTrimmerOp($id: ID!, $args: Map) { runPluginOperation(plugin_id: $id, args: $args) }";
  const RUN_OP = gql(RUN_OP_SRC);
  const SCENE_INFO = gql(
    "query SceneTrimmerScene($id: ID!) { findScene(id: $id) { id files { id duration frame_rate } } }"
  );
  const RUN_TASK = gql(
    "mutation SceneTrimmerTask($id: ID!, $task: String!, $desc: String, $args: Map) { runPluginTask(plugin_id: $id, task_name: $task, description: $desc, args_map: $args) }"
  );
  const FIND_JOB = gql(
    "query SceneTrimmerJob($id: ID!) { findJob(input: { id: $id }) { id status progress error } }"
  );
  const SETTINGS = gql(
    'query SceneTrimmerSettings { configuration { plugins(include: ["sceneTrimmer"]) } }'
  );

  function client() {
    return PluginApi.utils.StashService.getClient();
  }

  // Everything uses no-cache. The configuration query in particular would
  // otherwise replace Stash's cached configuration object with one that only
  // has `plugins`.
  async function runOp(args) {
    const res = await client().mutate({
      mutation: RUN_OP,
      variables: { id: PLUGIN_ID, args: args },
      fetchPolicy: "no-cache",
    });
    return res.data.runPluginOperation;
  }

  async function findJob(id) {
    const res = await client().query({
      query: FIND_JOB,
      variables: { id: id },
      fetchPolicy: "no-cache",
    });
    return res.data.findJob;
  }

  async function fetchSceneInfo(sceneId) {
    const res = await client().query({
      query: SCENE_INFO,
      variables: { id: sceneId },
      fetchPolicy: "no-cache",
    });
    return res.data.findScene;
  }

  async function fetchDefaultMode() {
    try {
      const res = await client().query({
        query: SETTINGS,
        fetchPolicy: "no-cache",
      });
      const cfg = (res.data.configuration.plugins || {})[PLUGIN_ID] || {};
      return cfg.markedRangesRemove ? "remove" : "keep";
    } catch (err) {
      console.warn(LOG, "could not read plugin settings", err);
      return "keep";
    }
  }

  // Used only on pagehide, where an Apollo request would be cancelled along
  // with the page. Only correct when the UI is served by Stash itself (not the
  // Vite dev server on another port), which is the normal case.
  function graphqlURL() {
    const base = document.querySelector("base");
    return new URL(
      ((base && base.getAttribute("href")) || "/") + "graphql",
      window.location.origin
    ).toString();
  }

  // --- time helpers ----------------------------------------------------------

  function round3(t) {
    return Math.round(t * 1000) / 1000;
  }

  function clamp(t, lo, hi) {
    return Math.min(Math.max(t, lo), hi);
  }

  function fmt(t, tenths) {
    if (t == null || !isFinite(t)) return "–";
    const unit = tenths === false ? 1 : 10;
    const total = Math.round(Math.max(0, t) * unit);
    const frac = total % unit;
    const secs = Math.floor(total / unit);
    const hh = Math.floor(secs / 3600);
    const mm = Math.floor((secs % 3600) / 60);
    const ss = secs % 60;
    let out = hh ? hh + ":" + String(mm).padStart(2, "0") : String(mm);
    out += ":" + String(ss).padStart(2, "0");
    if (unit === 10) out += "." + frac;
    return out;
  }

  // --- range math ------------------------------------------------------------

  function normalize(ranges, duration) {
    const max = duration > 0 ? duration : Infinity;
    const sorted = ranges
      .map((r) => [clamp(r[0], 0, max), clamp(r[1], 0, max)])
      .filter((r) => r[1] - r[0] >= MIN_LEN)
      .sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) {
        last[1] = Math.max(last[1], r[1]);
      } else {
        out.push([r[0], r[1]]);
      }
    }
    return out.map((r) => [round3(r[0]), round3(r[1])]);
  }

  function complement(ranges, duration) {
    const out = [];
    let pos = 0;
    for (const r of ranges) {
      if (r[0] - pos >= MIN_LEN) out.push([pos, r[0]]);
      pos = Math.max(pos, r[1]);
    }
    if (duration - pos >= MIN_LEN) out.push([pos, duration]);
    return out;
  }

  // The one list the skip engine, the seek bar and (in phase 2) the export
  // work from, whichever way the user marks. null = nothing marked, play all.
  function keepSegments(rec, duration) {
    if (!rec || !rec.ranges.length || !(duration > 0)) return null;
    const marked = normalize(rec.ranges, duration);
    return rec.mode === "remove" ? complement(marked, duration) : marked;
  }

  // Split points closer than this to each other or to either end would make
  // a scene of a second or two.
  const SPLIT_GAP = 1;

  function normalizeSplits(splits, duration) {
    const out = [];
    (splits || [])
      .map(round3)
      .filter((t) => t >= SPLIT_GAP && (!(duration > 0) || t <= duration - SPLIT_GAP))
      .sort((a, b) => a - b)
      .forEach((t) => {
        if (!out.length || t - out[out.length - 1] >= SPLIT_GAP) out.push(t);
      });
    return out;
  }

  // Mirrors plan_outputs in sceneTrimmer.py: parts that are entirely cut
  // produce no scene.
  function splitSceneCount() {
    if (!S.rec || !(S.duration > 0)) return 0;
    const keep = S.keep || [[0, S.duration]];
    const bounds = [0].concat(S.rec.splits, [S.duration]);
    let n = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      let kept = 0;
      keep.forEach((k) => {
        kept += Math.max(0, Math.min(k[1], bounds[i + 1]) - Math.max(k[0], bounds[i]));
      });
      if (kept >= 1) n += 1;
    }
    return n;
  }

  function groupURL(id) {
    const base = document.querySelector("base");
    return ((base && base.getAttribute("href")) || "/") + "groups/" + id;
  }

  function total(segments) {
    return segments.reduce((sum, s) => sum + (s[1] - s[0]), 0);
  }

  // --- state -----------------------------------------------------------------
  //
  // One mutable state object for the scene on screen. notify() re-renders the
  // React strip and the plain-DOM seek-bar layer.

  const S = {
    sceneId: null,
    loaded: false,
    loadError: null,
    fileId: null,
    duration: 0,
    fps: 30,
    rec: null,
    hasRecord: false,
    stale: false,
    keep: null,
    defaultMode: "keep",
    keyframes: null,
    kfStatus: "idle",
    saveStatus: "saved",
    editing: false,
    preview: false,
    snap: true,
    panelOpen: false,
    confirm: null,
    flash: null,
    resumeOffered: false,
    // Last export's state from the backend (see export_status in
    // sceneTrimmer.py), plus the UI-only "queued" status and trim job id.
    export: null,
  };

  const listeners = new Set();
  let loadToken = 0;
  let flashTimer = null;

  function notify() {
    S.keep = S.loaded && !S.stale ? keepSegments(S.rec, S.duration) : null;
    listeners.forEach((fn) => fn());
    renderOverlay();
    updateToggle();
  }

  function useStore() {
    const [, force] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
      listeners.add(force);
      return () => listeners.delete(force);
    }, []);
  }

  function defaultRec() {
    return {
      v: 1,
      file_id: S.fileId,
      mode: S.defaultMode,
      enabled: true,
      ranges: [],
      pending_in: null,
      last_pos: null,
      splits: [],
    };
  }

  function flash(msg) {
    S.flash = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      S.flash = null;
      notify();
    }, 2500);
    notify();
  }

  // --- saving ----------------------------------------------------------------
  //
  // Saves are keyed by scene so leaving a scene mid-debounce still writes that
  // scene's latest record, even while the next scene loads. A null record
  // deletes the scene's trim data.

  const pendingSaves = new Map();
  let saveTimer = null;
  let saveWorker = null;

  function setSaveStatus(sceneId, status) {
    if (S.sceneId !== sceneId) return;
    S.saveStatus = status;
    notify();
  }

  function queueSave(rec) {
    if (!S.sceneId) return;
    const value = rec === undefined ? JSON.parse(JSON.stringify(S.rec)) : rec;
    pendingSaves.set(S.sceneId, value);
    S.hasRecord = value !== null;
    S.saveStatus = "dirty";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, SAVE_DELAY);
  }

  function flushSaves() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!saveWorker && pendingSaves.size) {
      saveWorker = drainSaves().finally(() => {
        saveWorker = null;
      });
    }
    return saveWorker;
  }

  async function drainSaves() {
    while (pendingSaves.size) {
      const [sceneId, rec] = pendingSaves.entries().next().value;
      pendingSaves.delete(sceneId);
      setSaveStatus(sceneId, "saving");
      try {
        await runOp({ mode: "save", scene_id: sceneId, trim: rec });
        if (!pendingSaves.has(sceneId)) setSaveStatus(sceneId, "saved");
      } catch (err) {
        console.warn(LOG, "save failed for scene", sceneId, err);
        // Keep it queued; the next edit (or leaving the page) retries.
        if (!pendingSaves.has(sceneId)) pendingSaves.set(sceneId, rec);
        setSaveStatus(sceneId, "error");
        return;
      }
    }
    // Edits made while the last request was in flight.
    if (pendingSaves.size) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSaves, SAVE_DELAY);
    }
  }

  function saveOnPageHide() {
    rememberPosition();
    clearTimeout(saveTimer);
    pendingSaves.forEach((rec, sceneId) => {
      try {
        fetch(graphqlURL(), {
          method: "POST",
          keepalive: true,
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: RUN_OP_SRC,
            variables: {
              id: PLUGIN_ID,
              args: { mode: "save", scene_id: sceneId, trim: rec },
            },
          }),
        });
      } catch (err) {
        console.warn(LOG, "could not send the final save", err);
      }
    });
  }

  // A record is only worth writing once the user has marked something, so
  // opening and closing Trim mode on an untouched scene leaves no trace.
  function worthSaving() {
    const r = S.rec;
    return (
      !!r &&
      (r.ranges.length > 0 || r.splits.length > 0 || r.pending_in != null || S.hasRecord)
    );
  }

  function rememberPosition() {
    if (!S.editing || !alive(P) || !S.loaded || S.stale || !worthSaving()) return;
    try {
      S.rec.last_pos = round3(P.currentTime());
    } catch (err) {
      return;
    }
    queueSave();
  }

  // Call after every edit to S.rec.
  function commit() {
    S.rec.ranges = normalize(S.rec.ranges, S.duration);
    S.rec.splits = normalizeSplits(S.rec.splits, S.duration);
    S.rec.file_id = S.fileId;
    if (S.editing && P) S.rec.last_pos = round3(P.currentTime());
    queueSave();
    notify();
  }

  // --- scene loading ---------------------------------------------------------

  function parseSceneId(pathname) {
    const m = /\/scenes\/(\d+)(?:\/|$)/.exec(pathname || "");
    return m ? m[1] : null;
  }

  function resetScene(sceneId) {
    Object.assign(S, {
      sceneId: sceneId,
      loaded: false,
      loadError: null,
      fileId: null,
      duration: 0,
      fps: 30,
      rec: null,
      hasRecord: false,
      stale: false,
      keyframes: null,
      kfStatus: "idle",
      saveStatus: "saved",
      preview: false,
      panelOpen: false,
      confirm: null,
      flash: null,
      resumeOffered: false,
      export: null,
    });
  }

  async function loadScene(sceneId) {
    const token = ++loadToken;
    resetScene(sceneId);
    notify();

    let info;
    let loaded = null;
    let backendError = null;
    try {
      const results = await Promise.all([
        fetchSceneInfo(sceneId),
        runOp({ mode: "load", scene_id: sceneId }).catch((err) => {
          backendError = err;
          return null;
        }),
        fetchDefaultMode(),
        runOp({ mode: "export_status", scene_id: sceneId }).catch(() => null),
      ]);
      info = results[0];
      loaded = results[1];
      S.defaultMode = results[2];
      // A finished trim needs no mention (the page reloaded into it); a
      // finished split stays up until dismissed, with a link to its group.
      const exp = results[3];
      S.export = exp && (exp.status !== "done" || exp.kind === "split") ? exp : null;
    } catch (err) {
      if (token !== loadToken) return;
      console.warn(LOG, "could not load scene", sceneId, err);
      S.loadError = "Could not load this scene.";
      notify();
      return;
    }
    if (token !== loadToken) return;

    const file = info && info.files && info.files[0];
    if (!file) {
      S.loadError = "This scene has no file.";
      notify();
      return;
    }

    S.fileId = file.id;
    S.duration = file.duration || 0;
    S.fps = file.frame_rate > 0 ? file.frame_rate : 30;
    if (backendError) {
      console.warn(LOG, "backend unavailable", backendError);
      S.loadError =
        "Scene Trimmer's backend didn't answer, so nothing can be saved. Is Python available to Stash?";
    }

    const trim = loaded && loaded.trim;
    S.hasRecord = !!trim;
    S.rec = trim ? trim : defaultRec();
    if (!S.rec.file_id) S.rec.file_id = S.fileId;
    if (!Array.isArray(S.rec.splits)) S.rec.splits = [];
    S.stale =
      S.rec.file_id !== S.fileId && (S.rec.ranges.length > 0 || S.rec.splits.length > 0);
    S.loaded = true;
    if (loaded && loaded.source === "custom_field") {
      flash("Trim ranges restored from the scene's backup copy.");
    }
    notify();
    if (exportActive()) pollExport(sceneId);
  }

  // --- keyframes -------------------------------------------------------------

  const keyframeCache = new Map();

  async function loadKeyframes() {
    if (!S.loaded || S.kfStatus === "loading" || S.kfStatus === "ready") {
      return;
    }
    const sceneId = S.sceneId;
    const fileId = S.fileId;
    if (keyframeCache.has(fileId)) {
      S.keyframes = keyframeCache.get(fileId);
      S.kfStatus = "ready";
      notify();
      return;
    }
    S.kfStatus = "loading";
    notify();
    try {
      const res = await runOp({ mode: "keyframes", scene_id: sceneId });
      if (res.file_id !== fileId) throw new Error("the primary file changed");
      keyframeCache.set(fileId, res.keyframes);
      if (S.sceneId !== sceneId) return;
      S.keyframes = res.keyframes;
      S.kfStatus = res.keyframes.length ? "ready" : "error";
    } catch (err) {
      console.warn(LOG, "keyframes unavailable", err);
      if (S.sceneId !== sceneId) return;
      S.kfStatus = "error";
    }
    notify();
  }

  function hasKeyframes() {
    return S.kfStatus === "ready" && S.keyframes && S.keyframes.length > 0;
  }

  // Index of the last keyframe <= t, or -1.
  function kfFloor(t) {
    const k = S.keyframes;
    let lo = 0;
    let hi = k.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (k[mid] <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function prevKeyframe(t) {
    const i = kfFloor(t - KF_EPS);
    return i >= 0 ? S.keyframes[i] : null;
  }

  function nextKeyframe(t) {
    const i = kfFloor(t + KF_EPS) + 1;
    return i < S.keyframes.length ? S.keyframes[i] : null;
  }

  function nearestKeyframe(t) {
    const i = kfFloor(t);
    const a = i >= 0 ? S.keyframes[i] : null;
    const b = i + 1 < S.keyframes.length ? S.keyframes[i + 1] : null;
    if (a == null) return b;
    if (b == null) return a;
    return t - a <= b - t ? a : b;
  }

  function snapTime(t) {
    return S.snap && hasKeyframes() ? nearestKeyframe(t) : t;
  }

  // --- player ----------------------------------------------------------------

  let P = null;
  let ui = null;
  let pollTimer = null;
  let seekTarget = null;
  let seekGuard = null;
  let rafId = 0;

  function alive(p) {
    if (!p) return false;
    return typeof p.isDisposed === "function" ? !p.isDisposed() : !p.isDisposed_;
  }

  function findPlayer() {
    const el = document.getElementById(PLAYER_ID);
    return el && alive(el.player) ? el.player : null;
  }

  function waitForPlayer() {
    if (pollTimer) return;
    let tries = 0;
    pollTimer = setInterval(() => {
      tries += 1;
      const p = findPlayer();
      if (p && p !== P) attach(p);
      if ((P && p === P) || !S.sceneId || tries > 100) {
        if (!P && S.sceneId) console.warn(LOG, "scene player not found");
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 300);
  }

  function durationMatches() {
    const pd = P.duration();
    return !(pd > 0) || !(S.duration > 0) || Math.abs(pd - S.duration) < 2;
  }

  // Keep segments to enforce right now, or null for "play normally".
  function activeKeep() {
    if (!S.keep || !S.keep.length || !S.rec.enabled) return null;
    if (S.editing && !S.preview) return null;
    if (!durationMatches()) return null;
    return S.keep;
  }

  function jump(t) {
    if (Math.abs(P.currentTime() - t) < EPS) return;
    seekTarget = t;
    clearTimeout(seekGuard);
    seekGuard = setTimeout(() => {
      seekTarget = null;
    }, 1500);
    P.currentTime(t);
  }

  function enforce(reason) {
    if (!P || seekTarget !== null) return;
    const keep = activeKeep();
    if (!keep) return;
    // After the natural end, play() restarts from 0 and the next check moves
    // that to the first kept part.
    if (P.ended()) return;

    const t = P.currentTime();
    for (const seg of keep) {
      if (t < seg[0] - EPS) {
        jump(seg[0]);
        return;
      }
      if (t < seg[1] - EPS) return;
    }

    // Past the last kept part.
    if (reason === "play") {
      jump(keep[0][0]);
    } else if (!P.paused()) {
      // Run to the real end, so "ended" fires and Stash's queue moves on.
      jump(P.duration() || S.duration);
    } else {
      const lastEnd = keep[keep.length - 1][1];
      if (t > lastEnd + EPS) jump(lastEnd);
    }
  }

  // timeupdate only fires about every 250 ms; checking every frame while
  // playing makes cuts land on time.
  function frameLoop() {
    rafId = 0;
    if (!P || P.paused()) return;
    enforce("frame");
    rafId = requestAnimationFrame(frameLoop);
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(frameLoop);
  }

  function attach(p) {
    detach();
    P = p;
    const handlers = {
      timeupdate: () => {
        enforce("time");
        if (S.editing && S.rec && S.rec.pending_in != null) renderOverlay();
      },
      seeked: () => {
        seekTarget = null;
        clearTimeout(seekGuard);
        enforce("seeked");
      },
      play: () => {
        enforce("play");
        startLoop();
      },
      playing: startLoop,
      loadedmetadata: notify,
      durationchange: notify,
      dispose: () => {
        if (P === p) detach();
      },
    };
    Object.keys(handlers).forEach((ev) => p.on(ev, handlers[ev]));
    ui = { handlers: handlers };
    try {
      createUI(p);
    } catch (err) {
      console.warn(LOG, "could not add the trim controls", err);
    }
    notify();
  }

  function detach() {
    if (!P) return;
    const p = P;
    exitEditing();
    if (ui) {
      if (alive(p)) {
        Object.keys(ui.handlers).forEach((ev) => p.off(ev, ui.handlers[ev]));
      }
      if (ui.stripRoot) {
        ReactDOM.unmountComponentAtNode(ui.stripRoot);
        ui.stripRoot.remove();
      }
      if (ui.button) ui.button.remove();
      if (ui.layer) ui.layer.remove();
    }
    cancelAnimationFrame(rafId);
    rafId = 0;
    ui = null;
    P = null;
  }

  // --- controls in the player ------------------------------------------------

  function scissorsSvg() {
    const fa = PluginApi.libraries.FontAwesomeSolid || {};
    const icon = fa.faScissors && fa.faScissors.icon;
    if (!icon) return "✂";
    return (
      '<svg viewBox="0 0 ' +
      icon[0] +
      " " +
      icon[1] +
      '" aria-hidden="true"><path fill="currentColor" d="' +
      icon[4] +
      '"></path></svg>'
    );
  }

  function createUI(p) {
    // videojs isn't a global for plugins, so these are plain DOM nodes rather
    // than videojs components.
    const controlBar = p.getChild("ControlBar");
    const barEl = controlBar && controlBar.el();
    if (!barEl) throw new Error("no control bar");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "vjs-control vjs-button sceneTrimmer-toggle";
    button.title = "Trim";
    button.innerHTML =
      '<span class="sceneTrimmer-toggle-icon">' +
      scissorsSvg() +
      '</span><span class="vjs-control-text">Trim</span>';
    button.addEventListener("click", (e) => {
      e.currentTarget.blur();
      if (S.editing) exitEditing();
      else enterEditing();
    });
    const fullscreen = barEl.querySelector(".vjs-fullscreen-control");
    barEl.insertBefore(button, fullscreen || null);
    ui.button = button;

    // Inside the control bar, so it shows and hides with the controls in
    // normal playback and goes fullscreen with the player.
    const stripRoot = document.createElement("div");
    stripRoot.className = "sceneTrimmer-strip-root";
    barEl.appendChild(stripRoot);
    ReactDOM.render(h(Strip), stripRoot);
    ui.stripRoot = stripRoot;

    const layer = document.createElement("div");
    layer.className = "sceneTrimmer-layer";
    // The seek bar starts seeking on mousedown/touchstart; handles must not.
    ["mousedown", "touchstart", "click"].forEach((ev) =>
      layer.addEventListener(ev, (e) => {
        if (e.target.closest && e.target.closest(".sceneTrimmer-handle")) {
          e.stopPropagation();
        }
      })
    );
    layer.addEventListener("pointerdown", onHandlePointerDown);
    ui.layer = layer;
  }

  function updateToggle() {
    if (!ui || !ui.button) return;
    const active =
      S.loaded && !S.stale && S.rec && S.rec.enabled && S.rec.ranges.length > 0;
    ui.button.classList.toggle("is-active", !!active);
    ui.button.classList.toggle("is-editing", S.editing);
  }

  function addBand(parent, className, a, b, d) {
    const el = document.createElement("div");
    el.className = className;
    el.style.left = (a / d) * 100 + "%";
    el.style.width = ((b - a) / d) * 100 + "%";
    parent.appendChild(el);
    return el;
  }

  function renderOverlay() {
    if (!ui || !ui.layer || !alive(P) || !P.el()) return;
    const layer = ui.layer;
    const holder = P.el().querySelector(".vjs-progress-holder");
    if (!holder) return;
    if (layer.parentNode !== holder) holder.appendChild(layer);
    ui.holder = holder;
    layer.textContent = "";

    const d = S.duration || P.duration();
    if (!(d > 0) || !S.loaded || S.stale) return;
    layer.classList.toggle("is-editing", S.editing);

    if (S.keep && (S.editing || S.rec.enabled)) {
      complement(S.keep, d).forEach((c) =>
        addBand(layer, "sceneTrimmer-cut", c[0], c[1], d)
      );
    }

    if (!S.editing) return;

    const kind = S.rec.mode === "remove" ? "is-remove" : "is-keep";
    S.rec.ranges.forEach((r, i) => {
      const band = addBand(layer, "sceneTrimmer-range " + kind, r[0], r[1], d);
      ["start", "end"].forEach((edge) => {
        const handle = document.createElement("div");
        handle.className = "sceneTrimmer-handle is-" + edge;
        handle.dataset.i = String(i);
        handle.dataset.edge = edge;
        handle.title = (edge === "start" ? "In " : "Out ") + fmt(r[edge === "start" ? 0 : 1]);
        band.appendChild(handle);
      });
    });

    S.rec.splits.forEach((t, i) => {
      const line = document.createElement("div");
      line.className = "sceneTrimmer-split";
      line.style.left = (t / d) * 100 + "%";
      line.title = "Scene " + (i + 2) + " starts at " + fmt(t);
      layer.appendChild(line);
    });

    if (S.rec.pending_in != null) {
      const now = P.currentTime();
      const a = Math.min(S.rec.pending_in, now);
      const b = Math.max(S.rec.pending_in, now);
      addBand(layer, "sceneTrimmer-pending " + kind, a, Math.max(b, a + d / 1000), d);
    }
  }

  // Dragging an in/out handle. Listeners go on window because renderOverlay
  // rebuilds the handles while the drag is running.
  function onHandlePointerDown(e) {
    const handle = e.target.closest && e.target.closest(".sceneTrimmer-handle");
    if (!handle || !P || !S.editing || !ui.holder) return;
    e.preventDefault();
    e.stopPropagation();

    const i = Number(handle.dataset.i);
    const isStart = handle.dataset.edge === "start";
    const ranges = S.rec.ranges;
    const r = ranges[i];
    if (!r) return;
    const d = S.duration || P.duration();
    const min = isStart ? (i > 0 ? ranges[i - 1][1] : 0) : r[0] + MIN_LEN;
    const max = isStart ? r[1] - MIN_LEN : i < ranges.length - 1 ? ranges[i + 1][0] : d;
    const holder = ui.holder;
    let lastSeek = 0;
    P.pause();

    function move(ev) {
      const rect = holder.getBoundingClientRect();
      let t = ((ev.clientX - rect.left) / rect.width) * d;
      t = clamp(snapTime(clamp(t, 0, d)), min, max);
      r[isStart ? 0 : 1] = t;
      const now = performance.now();
      // Show the frame under the handle, without flooding the player.
      if (now - lastSeek > 80) {
        lastSeek = now;
        P.currentTime(t);
      }
      notify();
    }

    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      P.currentTime(r[isStart ? 0 : 1]);
      commit();
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // --- actions ---------------------------------------------------------------

  function canEdit() {
    return !!P && S.loaded && !S.stale && !!S.rec && !exportActive();
  }

  function markIn() {
    if (!canEdit()) return;
    const t = round3(snapTime(P.currentTime()));
    S.rec.pending_in = t;
    commit();
    flash("In at " + fmt(t));
  }

  function markOut() {
    if (!canEdit()) return;
    const t = round3(snapTime(P.currentTime()));
    let start = S.rec.pending_in;
    if (start == null) {
      // No open In: close from the end of the previous range, or the start.
      start = 0;
      S.rec.ranges.forEach((r) => {
        if (r[1] <= t && r[1] > start) start = r[1];
      });
    }
    if (t - start < MIN_LEN) {
      flash("Out must be after In");
      return;
    }
    S.rec.ranges.push([start, t]);
    S.rec.pending_in = null;
    commit();
    flash("Range " + fmt(start) + " – " + fmt(t) + " added");
  }

  function seekTo(t) {
    if (!P) return;
    P.pause();
    P.currentTime(clamp(t, 0, S.duration || P.duration()));
  }

  function stepFrame(dir) {
    if (!P) return;
    seekTo(P.currentTime() + dir / S.fps);
  }

  function stepKeyframe(dir) {
    if (!P) return;
    const now = P.currentTime();
    if (!hasKeyframes()) {
      seekTo(now + dir);
      return;
    }
    const t = dir < 0 ? prevKeyframe(now) : nextKeyframe(now);
    if (t == null) {
      flash(dir < 0 ? "No earlier keyframe" : "No later keyframe");
      return;
    }
    seekTo(t);
  }

  function togglePreview() {
    S.preview = !S.preview;
    notify();
    if (S.preview) enforce("seeked");
  }

  function toggleSnap() {
    S.snap = !S.snap;
    notify();
  }

  function toggleEnabled() {
    if (!canEdit()) return;
    S.rec.enabled = !S.rec.enabled;
    commit();
  }

  function markSplit() {
    if (!canEdit()) return;
    const t = round3(snapTime(P.currentTime()));
    if (t < SPLIT_GAP || t > S.duration - SPLIT_GAP) {
      flash("Too close to the start or end to split");
      return;
    }
    if (S.rec.splits.some((x) => Math.abs(x - t) < SPLIT_GAP)) {
      flash("There's already a split here");
      return;
    }
    S.rec.splits.push(t);
    commit();
    flash("Split at " + fmt(t) + " – " + (S.rec.splits.length + 1) + " scenes");
  }

  function deleteSplit(i) {
    if (!canEdit()) return;
    S.rec.splits.splice(i, 1);
    commit();
  }

  function deleteRange(i) {
    if (!canEdit()) return;
    S.rec.ranges.splice(i, 1);
    commit();
  }

  function cancelPendingIn() {
    if (!canEdit()) return;
    S.rec.pending_in = null;
    commit();
  }

  function setMode(mode, convert) {
    if (!canEdit() || S.rec.mode === mode) return;
    if (convert) {
      S.rec.ranges = complement(normalize(S.rec.ranges, S.duration), S.duration);
    }
    S.rec.mode = mode;
    S.confirm = null;
    commit();
  }

  function requestMode(mode) {
    if (!canEdit() || S.rec.mode === mode) return;
    if (!S.rec.ranges.length) {
      setMode(mode, false);
    } else {
      S.confirm = { kind: "mode", mode: mode };
      notify();
    }
  }

  function clearAll() {
    if (!S.loaded) return;
    S.rec = defaultRec();
    S.stale = false;
    S.confirm = null;
    queueSave(null);
    notify();
  }

  // --- export (phase 2) -----------------------------------------------------
  //
  // The backend does the work as two queued Stash tasks: "Trim scene" cuts and
  // joins the kept parts, then queues a scan of the new file and "Finalize
  // trim", which attaches it to this scene. This only starts it and watches.

  const EXPORT_ACTIVE = ["queued", "cutting", "joining", "scanning", "finalizing"];

  function exportActive() {
    return !!S.export && EXPORT_ACTIVE.indexOf(S.export.status) >= 0;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function startExport(kind) {
    if (!canEdit()) return;
    const sceneId = S.sceneId;
    S.confirm = null;
    S.export = { status: "queued", progress: 0, kind: kind };
    notify();
    try {
      // The task reads the saved record, so the latest edits must be in it.
      rememberPosition();
      queueSave();
      await flushSaves();
      if (pendingSaves.has(sceneId)) throw new Error("the ranges couldn't be saved");
      const res = await client().mutate({
        mutation: RUN_TASK,
        variables: {
          id: PLUGIN_ID,
          task: "Trim scene",
          desc:
            "Scene Trimmer: " +
            (kind === "split" ? "split" : "trim") +
            " scene " +
            sceneId,
          args: { scene_id: sceneId, kind: kind },
        },
        fetchPolicy: "no-cache",
      });
      if (S.sceneId !== sceneId) return;
      S.export.trimJob = res.data.runPluginTask;
      notify();
      pollExport(sceneId);
    } catch (err) {
      console.warn(LOG, "could not start the trim", err);
      if (S.sceneId !== sceneId) return;
      S.export = { status: "error", message: String(err.message || err) };
      notify();
    }
  }

  let pollingScene = null;

  async function pollExport(sceneId) {
    if (pollingScene === sceneId) return;
    pollingScene = sceneId;
    try {
      while (S.sceneId === sceneId && exportActive()) {
        await sleep(1500);
        if (S.sceneId !== sceneId) return;
        try {
          const trimJob = S.export.trimJob;
          if (trimJob) {
            // Before the task starts (and while it runs) the job queue is
            // the only place that knows about it.
            const job = await findJob(trimJob);
            if (S.sceneId !== sceneId) return;
            if (job && (job.status === "READY" || job.status === "RUNNING")) {
              S.export.status = job.status === "READY" ? "queued" : "cutting";
              S.export.progress = job.progress || 0;
              notify();
              continue;
            }
            S.export.trimJob = null;
          }
          const st = await runOp({ mode: "export_status", scene_id: sceneId });
          if (S.sceneId !== sceneId) return;
          if (!st) {
            S.export = { status: "error", message: "The trim task didn't start." };
          } else if (st.status === "done" && st.kind === "split") {
            S.export = st;
            notify();
            return;
          } else if (st.status === "done") {
            S.export = st;
            notify();
            flash("Trimmed file added to the scene – reloading…");
            await sleep(1500);
            if (S.sceneId === sceneId) window.location.reload();
            return;
          } else {
            S.export = Object.assign({}, st, { trimJob: S.export.trimJob });
          }
          notify();
        } catch (err) {
          console.warn(LOG, "could not check the trim", err);
        }
      }
    } finally {
      if (pollingScene === sceneId) pollingScene = null;
    }
  }

  function dismissExport() {
    const sceneId = S.sceneId;
    S.export = null;
    notify();
    runOp({ mode: "export_clear", scene_id: sceneId }).catch((err) =>
      console.warn(LOG, "could not clear the trim status", err)
    );
  }

  function exportText() {
    const e = S.export;
    const pct = Math.round((e.progress || 0) * 100) + "%";
    switch (e.status) {
      case "queued":
        return "Trim queued – waiting for other Stash tasks…";
      case "cutting":
        return (e.kind === "split" ? "Creating the scene files… " : "Creating trimmed file… ") + pct;
      case "joining":
        return "Joining the parts… " + pct;
      case "scanning":
        return e.kind === "split" ? "Adding the new files to Stash…" : "Adding the new file to Stash…";
      case "finalizing":
        return e.kind === "split"
          ? "Setting up the new scenes…"
          : "Adding the new file to this scene…";
      default:
        return null;
    }
  }

  const HOTKEYS = {
    "[": markIn,
    "]": markOut,
    "\\": togglePreview,
    x: markSplit,
    up: () => stepKeyframe(-1),
    down: () => stepKeyframe(1),
  };

  function enterEditing() {
    if (!P || S.editing) return;
    S.editing = true;
    S.panelOpen = false;
    P.addClass("sceneTrimmer-editing");
    Object.keys(HOTKEYS).forEach((key) =>
      Mousetrap.bind(key, () => {
        HOTKEYS[key]();
        // Stops the page scrolling on ↑/↓.
        return false;
      })
    );
    S.resumeOffered =
      S.loaded &&
      !S.stale &&
      S.rec.last_pos != null &&
      Math.abs(P.currentTime() - S.rec.last_pos) > 3;
    loadKeyframes();
    notify();
  }

  function exitEditing() {
    if (!S.editing) return;
    rememberPosition();
    S.editing = false;
    S.panelOpen = false;
    S.confirm = null;
    S.resumeOffered = false;
    if (alive(P)) P.removeClass("sceneTrimmer-editing");
    Object.keys(HOTKEYS).forEach((key) => Mousetrap.unbind(key));
    notify();
    flushSaves();
    if (alive(P)) enforce("seeked");
  }

  // --- React strip -----------------------------------------------------------

  // Clicking a button would leave focus on it, so the next Space would press
  // it again. Hand focus back to the player instead.
  function btn(label, onClick, opts) {
    opts = opts || {};
    return h(
      "button",
      {
        key: opts.key,
        type: "button",
        className:
          "sceneTrimmer-btn" +
          (opts.active ? " is-active" : "") +
          (opts.className ? " " + opts.className : ""),
        title: opts.title,
        disabled: opts.disabled,
        onClick: (e) => {
          e.currentTarget.blur();
          if (P && P.el()) P.el().focus({ preventScroll: true });
          onClick();
        },
      },
      label
    );
  }

  function statusLine() {
    const items = [];
    if (S.loadError) {
      items.push(h("span", { key: "err", className: "sceneTrimmer-error" }, S.loadError));
    }
    if (S.stale) {
      items.push(
        h(
          "span",
          { key: "stale", className: "sceneTrimmer-error" },
          "These ranges were marked on a different file of this scene, so they aren't applied. ",
          btn("Clear them", clearAll, { key: "clear" })
        )
      );
    }
    if (S.resumeOffered) {
      items.push(
        btn(
          "Resume trimming at " + fmt(S.rec.last_pos, false),
          () => {
            S.resumeOffered = false;
            seekTo(S.rec.last_pos);
            notify();
          },
          { key: "resume", className: "sceneTrimmer-resume" }
        )
      );
    }
    if (S.rec && S.rec.pending_in != null) {
      items.push(
        h(
          "span",
          { key: "pending" },
          "In at " + fmt(S.rec.pending_in) + " – press ] or Mark Out to close it ",
          btn("×", cancelPendingIn, { key: "cancel", title: "Cancel this In" })
        )
      );
    }
    if (S.kfStatus === "loading") {
      items.push(h("span", { key: "kf" }, "Finding keyframes…"));
    } else if (S.kfStatus === "error") {
      items.push(
        h("span", { key: "kf", className: "sceneTrimmer-muted" }, "Keyframes unavailable – ↑/↓ step 1 s")
      );
    }
    if (exportActive()) {
      items.push(h("span", { key: "export" }, exportText()));
    } else if (S.export && S.export.status === "done" && S.export.kind === "split") {
      const n = (S.export.scene_ids || []).length;
      items.push(
        h(
          "span",
          { key: "export" },
          "Created " + n + (n === 1 ? " scene" : " scenes") + " in the group “" + S.export.group_name + "”. ",
          h(
            "a",
            { key: "open", className: "sceneTrimmer-link", href: groupURL(S.export.group_id) },
            "Open group"
          ),
          " ",
          btn("Dismiss", dismissExport, { key: "dismiss" })
        )
      );
    } else if (S.export && S.export.status === "error") {
      items.push(
        h(
          "span",
          { key: "export", className: "sceneTrimmer-error" },
          "Trim failed: " + (S.export.message || "unknown error") + " ",
          btn("Dismiss", dismissExport, { key: "dismiss" })
        )
      );
    }
    if (S.flash) items.push(h("span", { key: "flash" }, S.flash));
    const saveText = {
      saved: S.hasRecord ? "Saved" : "",
      dirty: "Saving…",
      saving: "Saving…",
      error: "Save failed – retry",
    }[S.saveStatus];
    if (saveText) {
      items.push(
        S.saveStatus === "error"
          ? btn(saveText, flushSaves, { key: "save", className: "sceneTrimmer-error" })
          : h("span", { key: "save", className: "sceneTrimmer-muted" }, saveText)
      );
    }
    return items.length
      ? h("div", { className: "sceneTrimmer-status" }, items)
      : null;
  }

  function Panel() {
    const rec = S.rec;
    const markedWord = rec.mode === "remove" ? "removed" : "kept";

    let confirm = null;
    if (S.confirm && S.confirm.kind === "mode") {
      const to = S.confirm.mode;
      confirm = h(
        "div",
        { className: "sceneTrimmer-confirm" },
        h(
          "div",
          null,
          "Switch to marking the parts to " +
            (to === "remove" ? "remove" : "keep") +
            ". Convert the " +
            rec.ranges.length +
            " marked ranges so the same parts stay cut?"
        ),
        btn("Convert", () => setMode(to, true), { active: true }),
        btn("Just switch", () => setMode(to, false)),
        btn("Cancel", () => {
          S.confirm = null;
          notify();
        })
      );
    } else if (S.confirm && S.confirm.kind === "export") {
      confirm = h(
        "div",
        { className: "sceneTrimmer-confirm" },
        h(
          "div",
          null,
          "Create a new file with only the kept parts (" +
            fmt(total(S.keep || []), false) +
            " of " +
            fmt(S.duration, false) +
            ")? It's cut without re-encoding and becomes this scene's main file; the original file stays on the scene."
        ),
        h(
          "div",
          { className: "sceneTrimmer-muted" },
          "Cuts land on keyframes, so a kept part can start a little before its In unless Snap was on."
        ),
        btn("Create trimmed file", () => startExport("trim"), { active: true }),
        btn("Cancel", () => {
          S.confirm = null;
          notify();
        })
      );
    } else if (S.confirm && S.confirm.kind === "split") {
      const count = splitSceneCount();
      confirm = h(
        "div",
        { className: "sceneTrimmer-confirm" },
        h(
          "div",
          null,
          "Create " +
            count +
            " new scenes from this one, one per part" +
            (rec.ranges.length ? ", with the cut parts left out" : "") +
            "? Each gets this scene's title (as “… - Scene N”), studio, date, director, tags and performers, and they're put in a group in order. This scene and its file stay as they are."
        ),
        btn("Split into " + count + " scenes", () => startExport("split"), { active: true }),
        btn("Cancel", () => {
          S.confirm = null;
          notify();
        })
      );
    } else if (S.confirm && S.confirm.kind === "clear") {
      confirm = h(
        "div",
        { className: "sceneTrimmer-confirm" },
        h("div", null, "Delete all ranges for this scene?"),
        btn("Yes, clear all", clearAll, { active: true }),
        btn("Cancel", () => {
          S.confirm = null;
          notify();
        })
      );
    }

    const rows = rec.ranges.length
      ? rec.ranges.map((r, i) =>
          h(
            "div",
            { key: i, className: "sceneTrimmer-row" },
            h(
              "span",
              { className: "sceneTrimmer-row-time" },
              fmt(r[0]) + " – " + fmt(r[1])
            ),
            h("span", { className: "sceneTrimmer-muted" }, fmt(r[1] - r[0], false)),
            btn("In", () => seekTo(r[0]), { title: "Go to this range's In" }),
            btn("Out", () => seekTo(r[1]), { title: "Go to this range's Out" }),
            btn("Delete", () => deleteRange(i))
          )
        )
      : h(
          "div",
          { className: "sceneTrimmer-muted" },
          "No ranges yet. Press [ to mark In and ] to mark Out, or x to split."
        );

    return h(
      "div",
      { className: "sceneTrimmer-panel" },
      h(
        "div",
        { className: "sceneTrimmer-row" },
        h("span", null, "Marked ranges are"),
        btn("Kept", () => requestMode("keep"), { active: rec.mode === "keep" }),
        btn("Removed", () => requestMode("remove"), {
          active: rec.mode === "remove",
        })
      ),
      confirm,
      h("div", { className: "sceneTrimmer-list" }, rows),
      rec.splits.length
        ? h(
            "div",
            { className: "sceneTrimmer-list" },
            rec.splits.map((t, i) =>
              h(
                "div",
                { key: "s" + i, className: "sceneTrimmer-row" },
                h(
                  "span",
                  { className: "sceneTrimmer-row-time" },
                  "Scene " + (i + 2) + " starts at " + fmt(t)
                ),
                btn("Go", () => seekTo(t), { title: "Go to this split point" }),
                btn("Delete", () => deleteSplit(i))
              )
            )
          )
        : null,
      h(
        "div",
        { className: "sceneTrimmer-row" },
        h(
          "label",
          { className: "sceneTrimmer-check" },
          h("input", {
            type: "checkbox",
            checked: rec.enabled,
            onChange: toggleEnabled,
          }),
          " Skip cut parts during playback"
        ),
        btn(
          "Clear all",
          () => {
            S.confirm = { kind: "clear" };
            notify();
          },
          {
            disabled:
              !canEdit() ||
              (!rec.ranges.length && !rec.splits.length && rec.pending_in == null),
          }
        )
      ),
      h(
        "div",
        { className: "sceneTrimmer-row" },
        btn(
          "Create trimmed file…",
          () => {
            S.confirm = { kind: "export" };
            notify();
          },
          {
            disabled: !canEdit() || !S.keep || !S.keep.length || total(S.keep) >= S.duration - 0.1,
            title: "Write a new file with only the kept parts, without re-encoding",
          }
        ),
        btn(
          "Split into " + splitSceneCount() + " scenes…",
          () => {
            S.confirm = { kind: "split" };
            notify();
          },
          {
            disabled: !canEdit() || !rec.splits.length || splitSceneCount() < 1,
            title: "Write one file per part between split points, each as a new scene",
          }
        )
      ),
      h(
        "div",
        { className: "sceneTrimmer-muted" },
        "Marked ranges are " + markedWord + "; everything shaded is skipped."
      )
    );
  }

  function Strip() {
    useStore();
    if (!S.editing) return null;

    if (!S.loaded) {
      return h(
        "div",
        { className: "sceneTrimmer-strip" },
        h("div", { className: "sceneTrimmer-status" }, S.loadError || "Loading…"),
        h("div", { className: "sceneTrimmer-controls" }, btn("Done", exitEditing))
      );
    }

    const d = S.duration;
    const kept = S.keep ? total(S.keep) : d;
    const editable = canEdit();
    const kf = hasKeyframes();

    return h(
      "div",
      { className: "sceneTrimmer-strip" },
      S.panelOpen && !S.stale ? h(Panel) : null,
      statusLine(),
      h(
        "div",
        { className: "sceneTrimmer-controls" },
        h(
          "div",
          { className: "sceneTrimmer-group" },
          btn("Mark In", markIn, { disabled: !editable, title: "Mark In  [" }),
          btn("Mark Out", markOut, { disabled: !editable, title: "Mark Out  ]" }),
          btn("Split", markSplit, {
            disabled: !editable,
            title: "Start a new scene here  x",
          })
        ),
        h(
          "div",
          { className: "sceneTrimmer-group" },
          btn("◀K", () => stepKeyframe(-1), {
            title: kf ? "Previous keyframe  ↑" : "Back 1 second  ↑",
          }),
          btn("−1f", () => stepFrame(-1), { title: "Back one frame" }),
          btn("+1f", () => stepFrame(1), { title: "Forward one frame" }),
          btn("K▶", () => stepKeyframe(1), {
            title: kf ? "Next keyframe  ↓" : "Forward 1 second  ↓",
          }),
          btn("Snap", toggleSnap, {
            active: S.snap && kf,
            disabled: !kf,
            title: "Snap In, Out and split points to the nearest keyframe",
          })
        ),
        h(
          "div",
          { className: "sceneTrimmer-group sceneTrimmer-info" },
          (S.rec.mode === "remove" ? "Remove mode" : "Keep mode") +
            " · kept " +
            fmt(kept, false) +
            " / " +
            fmt(d, false) +
            " · " +
            S.rec.ranges.length +
            (S.rec.ranges.length === 1 ? " range" : " ranges") +
            (S.rec.splits.length ? " · " + (S.rec.splits.length + 1) + " scenes" : "")
        ),
        h(
          "div",
          { className: "sceneTrimmer-group" },
          btn("Preview", togglePreview, {
            active: S.preview,
            title: "Skip the cut parts while in Trim mode  \\",
          }),
          btn("Segments", () => {
            S.panelOpen = !S.panelOpen;
            S.confirm = null;
            notify();
          }, { active: S.panelOpen, disabled: S.stale }),
          btn("Done", exitEditing)
        )
      )
    );
  }

  // --- navigation and page lifecycle -----------------------------------------

  function leaveScene() {
    exitEditing();
    flushSaves();
    loadToken += 1;
    resetScene(null);
    notify();
  }

  function handleLocation(pathname) {
    const id = parseSceneId(pathname);
    if (id === S.sceneId) return;
    if (S.sceneId) leaveScene();
    if (id) {
      loadScene(id);
      waitForPlayer();
    }
  }

  if (PluginApi.Event && PluginApi.Event.addEventListener) {
    PluginApi.Event.addEventListener("stash:location", (e) => {
      const loc = e.detail && e.detail.data && e.detail.data.location;
      handleLocation(loc ? loc.pathname : window.location.pathname);
    });
  } else {
    console.warn(LOG, "PluginApi.Event is unavailable; scene changes won't be noticed");
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      rememberPosition();
      flushSaves();
    }
  });
  window.addEventListener("pagehide", saveOnPageHide);

  handleLocation(window.location.pathname);

  // --- ust_trim custom field: read-only, hidden from the details view --------
  //
  // The field is a backup copy the backend keeps up to date (the JSON file in
  // Stash's config dir is what's read). Stash's edit form submits the whole
  // custom-fields map, so the field has to pass through it untouched: it is
  // taken out of what the editor shows and put back on every change.

  function withoutField(values) {
    if (!values || !Object.prototype.hasOwnProperty.call(values, FIELD)) {
      return values;
    }
    const copy = Object.assign({}, values);
    delete copy[FIELD];
    return copy;
  }

  PluginApi.patch.before("CustomFields", function () {
    const args = Array.prototype.slice.call(arguments);
    const props = args[0];
    if (props && props.values) {
      args[0] = Object.assign({}, props, { values: withoutField(props.values) });
    }
    return args;
  });

  PluginApi.patch.instead("CustomFieldsInput", function () {
    const args = Array.prototype.slice.call(arguments);
    // The original component is always the last argument (see the patch.after
    // note in ultimateScrape.js); React decides how many come before it.
    const original = args[args.length - 1];
    const props = args[0] || {};
    const values = props.values;
    if (!values || !Object.prototype.hasOwnProperty.call(values, FIELD)) {
      return original.apply(this, args.slice(0, -1));
    }

    const kept = values[FIELD];
    const inner = Object.assign({}, props, {
      values: withoutField(values),
      onChange: (v) => props.onChange(Object.assign({}, v, { [FIELD]: kept })),
    });
    return h(
      React.Fragment,
      null,
      original.apply(this, [inner].concat(args.slice(1, -1))),
      h(
        "div",
        { className: "sceneTrimmer-field-note text-muted small" },
        h("code", null, FIELD),
        " holds this scene's trim ranges. It's managed by Scene Trimmer and can't be edited here."
      )
    );
  });
})();
