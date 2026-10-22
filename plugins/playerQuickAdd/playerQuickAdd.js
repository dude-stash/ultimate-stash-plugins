(function () {
  "use strict";

  const LOG = "[playerQuickAdd]";
  const PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch || !PluginApi.utils) {
    console.error(LOG, "PluginApi is unavailable");
    return;
  }

  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM;
  const gql = PluginApi.libraries.Apollo.gql;
  const h = React.createElement;

  const PLAYER_ID = "VideoJsPlayer";
  const PER_PAGE = 12;
  const SEARCH_DELAY = 120;

  const KINDS = {
    tags: {
      label: "Tags",
      field: "tags",
      bulkField: "tag_ids",
      search: gql(
        "query PlayerQuickAddTags($q: String!, $n: Int!) { findTags(filter: { q: $q, per_page: $n, sort: \"scenes_count\", direction: DESC }) { tags { id name scene_count } } }"
      ),
      list: (data) => data.findTags.tags,
      create: gql(
        "mutation PlayerQuickAddTagCreate($name: String!) { tagCreate(input: { name: $name }) { id name } }"
      ),
      created: (data) => data.tagCreate,
    },
    performers: {
      label: "Performers",
      field: "performers",
      bulkField: "performer_ids",
      search: gql(
        "query PlayerQuickAddPerformers($q: String!, $n: Int!) { findPerformers(filter: { q: $q, per_page: $n, sort: \"scenes_count\", direction: DESC }) { performers { id name disambiguation scene_count } } }"
      ),
      list: (data) => data.findPerformers.performers,
      create: gql(
        "mutation PlayerQuickAddPerformerCreate($name: String!) { performerCreate(input: { name: $name }) { id name disambiguation } }"
      ),
      created: (data) => data.performerCreate,
    },
  };

  const SCENE = gql(
    "query PlayerQuickAddScene($id: ID!) { findScene(id: $id) { id tags { id name } performers { id name disambiguation } } }"
  );
  const BULK = gql(
    "mutation PlayerQuickAddBulk($input: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $input) { id tags { id name } performers { id name disambiguation } } }"
  );

  function client() {
    return PluginApi.utils.StashService.getClient();
  }

  async function fetchScene(id) {
    const res = await client().query({
      query: SCENE,
      variables: { id: id },
      fetchPolicy: "no-cache",
    });
    return res.data.findScene;
  }

  // Bulk update with ADD/REMOVE so two quick clicks can't overwrite each other with a stale id list.
  async function changeScene(sceneId, kind, itemId, mode) {
    const input = { ids: [sceneId] };
    input[KINDS[kind].bulkField] = { ids: [itemId], mode: mode };
    const res = await client().mutate({
      mutation: BULK,
      variables: { input: input },
      fetchPolicy: "no-cache",
    });
    const scenes = res.data.bulkSceneUpdate || [];
    return scenes[0] || null;
  }

  // Refetches rather than patching the cache, so the page's own tag and performer lists follow.
  function refreshPage() {
    try {
      client().refetchQueries({ include: ["FindScene"] });
    } catch (err) {
      console.warn(LOG, "could not refresh the scene page", err);
    }
  }

  function errorText(err) {
    return (err && err.message) || String(err);
  }

  function label(item) {
    return item.disambiguation ? item.name + " (" + item.disambiguation + ")" : item.name;
  }

  // --- panel -----------------------------------------------------------------

  function Panel(props) {
    const sceneId = props.sceneId;
    const [kind, setKind] = React.useState("tags");
    const [query, setQuery] = React.useState("");
    const [results, setResults] = React.useState([]);
    const [scene, setScene] = React.useState(null);
    const [error, setError] = React.useState("");
    const inputRef = React.useRef(null);

    React.useEffect(() => {
      let cancelled = false;
      setScene(null);
      fetchScene(sceneId).then(
        (s) => {
          if (!cancelled) setScene(s);
        },
        (err) => {
          if (!cancelled) setError(errorText(err));
        }
      );
      return () => {
        cancelled = true;
      };
    }, [sceneId]);

    React.useEffect(() => {
      if (inputRef.current) inputRef.current.focus();
    }, [kind]);

    React.useEffect(() => {
      const q = query.trim();
      if (!q) {
        setResults([]);
        return undefined;
      }
      let cancelled = false;
      const timer = setTimeout(() => {
        client()
          .query({
            query: KINDS[kind].search,
            variables: { q: q, n: PER_PAGE },
            fetchPolicy: "no-cache",
          })
          .then(
            (res) => {
              if (!cancelled) setResults(KINDS[kind].list(res.data));
            },
            (err) => {
              if (!cancelled) setError(errorText(err));
            }
          );
      }, SEARCH_DELAY);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [kind, query]);

    const current = scene ? scene[KINDS[kind].field] : [];
    const has = (id) => current.some((c) => c.id === id);
    const trimmed = query.trim();
    const exact = results.some((r) => r.name.toLowerCase() === trimmed.toLowerCase());
    const canCreate = !!trimmed && !exact && !!scene;
    const choices = results.filter((r) => !has(r.id));

    function patchScene(k, fn) {
      setScene((s) => {
        if (!s) return s;
        const patch = {};
        patch[KINDS[k].field] = fn(s[KINDS[k].field]);
        return Object.assign({}, s, patch);
      });
    }

    function fail(err) {
      console.warn(LOG, err);
      setError(errorText(err));
    }

    function clearSearch() {
      setQuery("");
      setResults([]);
      if (inputRef.current) inputRef.current.focus();
    }

    // The chip appears at once and the request runs behind it; it is taken back out if the request fails.
    function add(k, item) {
      patchScene(k, (list) => list.concat([item]));
      clearSearch();
      setError("");
      changeScene(sceneId, k, item.id, "ADD").then(refreshPage, (err) => {
        patchScene(k, (list) => list.filter((c) => c.id !== item.id));
        fail(err);
      });
    }

    function remove(k, item) {
      if (String(item.id).indexOf("new:") === 0) return;
      patchScene(k, (list) => list.filter((c) => c.id !== item.id));
      setError("");
      changeScene(sceneId, k, item.id, "REMOVE").then(refreshPage, (err) => {
        patchScene(k, (list) => list.concat([item]));
        fail(err);
      });
    }

    function create(k, name) {
      const temp = { id: "new:" + name, name: name };
      patchScene(k, (list) => list.concat([temp]));
      clearSearch();
      setError("");
      client()
        .mutate({ mutation: KINDS[k].create, variables: { name: name }, fetchPolicy: "no-cache" })
        .then((res) => {
          const item = KINDS[k].created(res.data);
          patchScene(k, (list) => list.map((c) => (c.id === temp.id ? item : c)));
          return changeScene(sceneId, k, item.id, "ADD");
        })
        .then(refreshPage, (err) => {
          patchScene(k, (list) => list.filter((c) => c.id !== temp.id));
          fail(err);
        });
    }

    // Enter before the debounced search has answered: search right now instead of doing nothing.
    function addTyped() {
      const k = kind;
      const name = trimmed;
      client()
        .query({ query: KINDS[k].search, variables: { q: name, n: PER_PAGE }, fetchPolicy: "no-cache" })
        .then((res) => {
          const found = KINDS[k].list(res.data).filter((r) => !has(r.id));
          if (found.length) add(k, found[0]);
          else if (!KINDS[k].list(res.data).length) create(k, name);
          else clearSearch();
        }, fail);
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        if (query) setQuery("");
        else props.onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!trimmed || !scene) return;
        if (choices.length) add(kind, choices[0]);
        else if (results.length && !canCreate) clearSearch();
        else if (canCreate && results.length) create(kind, trimmed);
        else addTyped();
      }
    }

    // Native listener: React's handlers run at the app root, after the player has already seen the key.
    const keyHandler = React.useRef(null);
    keyHandler.current = onKeyDown;
    React.useEffect(() => {
      const el = inputRef.current;
      if (!el) return undefined;
      const listener = (e) => keyHandler.current(e);
      el.addEventListener("keydown", listener);
      return () => el.removeEventListener("keydown", listener);
    }, []);

    const tabs = Object.keys(KINDS).map((k) =>
      h(
        "button",
        {
          key: k,
          type: "button",
          className: "playerQuickAdd-tab" + (k === kind ? " is-active" : ""),
          onClick: () => {
            setKind(k);
            setQuery("");
            setResults([]);
          },
        },
        KINDS[k].label + (scene ? " (" + scene[KINDS[k].field].length + ")" : "")
      )
    );

    const chips = current.map((item) =>
      h(
        "span",
        { key: item.id, className: "playerQuickAdd-chip" },
        h("span", { className: "playerQuickAdd-chip-name" }, label(item)),
        h(
          "button",
          {
            type: "button",
            className: "playerQuickAdd-chip-remove",
            title: "Remove",
            "aria-label": "Remove " + item.name,
            onClick: () => remove(kind, item),
          },
          "×"
        )
      )
    );

    // Enter takes the first result, or creates when the results hold nothing new.
    const enterCreate = !choices.length && canCreate && results.length > 0;
    const enterHint = h("span", { className: "playerQuickAdd-enter", "aria-hidden": "true" }, "⏎");

    const rows = choices.map((item, i) =>
      h(
        "button",
        {
          key: item.id,
          type: "button",
          className: "playerQuickAdd-result" + (i === 0 ? " is-next" : ""),
          onClick: () => add(kind, item),
        },
        h(
          "span",
          null,
          label(item) + " ",
          h("span", { className: "playerQuickAdd-count" }, "(" + item.scene_count + ")")
        ),
        i === 0 ? enterHint : null
      )
    );
    if (canCreate) {
      rows.push(
        h(
          "button",
          {
            key: "create",
            type: "button",
            className: "playerQuickAdd-result is-create" + (enterCreate ? " is-next" : ""),
            onClick: () => create(kind, trimmed),
          },
          h("span", null, "Create “" + trimmed + "”"),
          enterCreate ? enterHint : null
        )
      );
    }

    return h(
      "div",
      { className: "playerQuickAdd-panel" },
      h(
        "div",
        { className: "playerQuickAdd-head" },
        h("div", { className: "playerQuickAdd-tabs" }, tabs),
        h(
          "button",
          {
            type: "button",
            className: "playerQuickAdd-close",
            title: "Close",
            "aria-label": "Close",
            onClick: props.onClose,
          },
          "×"
        )
      ),
      h("div", { className: "playerQuickAdd-chips" }, scene ? chips : null),
      h("input", {
        ref: inputRef,
        className: "playerQuickAdd-input",
        type: "text",
        value: query,
        placeholder: "Search " + KINDS[kind].label.toLowerCase() + "…",
        autoComplete: "off",
        onChange: (e) => setQuery(e.target.value),
      }),
      error ? h("div", { className: "playerQuickAdd-error" }, error) : null,
      h("div", { className: "playerQuickAdd-results" }, rows)
    );
  }

  // --- controls in the player ------------------------------------------------

  let P = null;
  let ui = null;
  let pollTimer = null;
  let sceneId = null;
  let open = false;

  function alive(p) {
    if (!p) return false;
    return typeof p.isDisposed === "function" ? !p.isDisposed() : !p.isDisposed_;
  }

  function findPlayer() {
    const el = document.getElementById(PLAYER_ID);
    return el && alive(el.player) ? el.player : null;
  }

  function tagSvg() {
    const fa = PluginApi.libraries.FontAwesomeSolid || {};
    const icon = fa.faTags && fa.faTags.icon;
    if (!icon) return "#";
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

  function render() {
    if (!ui) return;
    ui.button.classList.toggle("is-active", open);
    ReactDOM.render(
      open && sceneId ? h(Panel, { sceneId: sceneId, onClose: () => setOpen(false) }) : null,
      ui.root
    );
  }

  function setOpen(value) {
    open = value;
    render();
    if (!open && P && alive(P)) P.el().focus();
  }

  function attach(p) {
    const controlBar = p.getChild("ControlBar");
    const barEl = controlBar && controlBar.el();
    if (!barEl) throw new Error("no control bar");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "vjs-control vjs-button playerQuickAdd-toggle";
    button.title = "Add tags and performers";
    button.innerHTML =
      '<span class="playerQuickAdd-toggle-icon">' +
      tagSvg() +
      '</span><span class="vjs-control-text">Tags and performers</span>';
    button.addEventListener("click", (e) => {
      e.currentTarget.blur();
      setOpen(!open);
    });
    const fullscreen = barEl.querySelector(".vjs-fullscreen-control");
    barEl.insertBefore(button, fullscreen || null);

    // Inside the player element so the panel stays visible in fullscreen.
    const root = document.createElement("div");
    root.className = "playerQuickAdd-root";
    // The player's hotkeys (space, f, m, arrows) listen on the player element and must not see keys typed here.
    ["click", "dblclick", "mousedown", "touchstart", "wheel", "keydown", "keyup", "keypress"].forEach((ev) =>
      root.addEventListener(ev, (e) => e.stopPropagation())
    );
    p.el().appendChild(root);

    P = p;
    ui = { button: button, root: root };
    render();
  }

  function detach() {
    if (ui) {
      ReactDOM.unmountComponentAtNode(ui.root);
      ui.root.remove();
      ui.button.remove();
    }
    ui = null;
    P = null;
    open = false;
  }

  function waitForPlayer() {
    clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(() => {
      tries += 1;
      const p = findPlayer();
      if (p) {
        clearInterval(pollTimer);
        pollTimer = null;
        try {
          attach(p);
        } catch (err) {
          console.warn(LOG, "could not add the button to the player", err);
          detach();
        }
      } else if (!sceneId || tries > 100) {
        clearInterval(pollTimer);
        pollTimer = null;
        if (sceneId) console.warn(LOG, "scene player not found");
      }
    }, 300);
  }

  function parseSceneId(pathname) {
    const m = /\/scenes\/(\d+)(?:\/|$)/.exec(pathname || "");
    return m ? m[1] : null;
  }

  function handleLocation(pathname) {
    const id = parseSceneId(pathname);
    if (id === sceneId && (ui || pollTimer)) return;
    // The player is rebuilt for every scene, so whatever was added to the old one is gone.
    detach();
    sceneId = id;
    if (id) waitForPlayer();
  }

  if (PluginApi.Event && PluginApi.Event.addEventListener) {
    PluginApi.Event.addEventListener("stash:location", (e) => {
      const loc = e.detail && e.detail.data && e.detail.data.location;
      handleLocation(loc ? loc.pathname : window.location.pathname);
    });
  } else {
    console.warn(LOG, "PluginApi.Event is unavailable; scene changes won't be noticed");
  }

  handleLocation(window.location.pathname);
})();
