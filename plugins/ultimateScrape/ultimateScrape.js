// Ultimate Scrape
//
// Stash's built-in stash-box integration only ever queries a scene by free
// text (searchScene) or by file fingerprint (findScenesBySceneFingerprints).
// Stash-box's own schema exposes far more: queryScenes(SceneQueryInput) filters
// by text (title + details), title, code, url, date, performers, tags and
// studio, and queryPerformers(performed_with) lists a performer's pairings.
// Pairings is flattened into the scenes those people share, and a result can
// be synced onto the local scene. Any configured stash-box can be queried
// (StashDB, PornDB, FansDB, …), not just the first one.
(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch) {
    console.error("[UltimateScrape] PluginApi.patch is unavailable");
    return;
  }

  const React = PluginApi.React;
  const GQL = PluginApi.GQL;
  const { Button, Form, Table, Alert, Spinner, Nav, Modal } =
    PluginApi.libraries.Bootstrap;
  const { NavLink } = PluginApi.libraries.ReactRouterDOM;
  const { faSearch } = PluginApi.libraries.FontAwesomeSolid;
  const Select = PluginApi.libraries.ReactSelect.default || PluginApi.libraries.ReactSelect;

  const ROUTE = "/plugins/ultimate-scrape";
  const SEARCH_FORM_ID = "ultimate-scrape-form";
  const URL_CUSTOM = "__custom__";
  const LOG = "[UltimateScrape]";

  // Criterion modifiers, per stash-box's CriterionModifier enum.
  const STRING_MODIFIERS = ["EQUALS", "NOT_EQUALS", "INCLUDES", "EXCLUDES"];
  const ID_MODIFIERS = ["INCLUDES_ALL", "INCLUDES"];
  const ID_MODIFIER_LABELS = {
    INCLUDES_ALL: "all of these",
    INCLUDES: "any of these",
  };
  const TEXT_SCOPES = [
    { value: "TITLE", label: "Title only" },
    { value: "TEXT", label: "Title and description" },
  ];
  const SCENE_SORTS = [
    "TITLE",
    "DATE",
    "DURATION",
    "TRENDING",
    "POPULARITY",
    "CREATED_AT",
    "UPDATED_AT",
  ];
  // Nested pairing scenes only carry title/date/duration, so those are the
  // sorts we can actually apply after flattening.
  const PAIRING_SCENE_SORTS = ["DATE", "TITLE", "DURATION"];
  const GENDERS = [
    "",
    "FEMALE",
    "MALE",
    "TRANSGENDER_FEMALE",
    "TRANSGENDER_MALE",
    "INTERSEX",
    "NON_BINARY",
    "UNKNOWN",
  ];
  const MODIFIER_LABELS = {
    EQUALS: "equals",
    NOT_EQUALS: "not equals",
    INCLUDES: "includes",
    EXCLUDES: "excludes",
    INCLUDES_ALL: "includes all",
    GREATER_THAN: "after",
    LESS_THAN: "before",
  };

  const QUERY_SCENES = `
    query PluginQueryScenes($input: SceneQueryInput!) {
      queryScenes(input: $input) {
        count
        scenes {
          id
          title
          details
          release_date
          code
          duration
          studio { name }
          performers { performer { name } }
          urls { url }
        }
      }
    }
  `;

  // searchScene is the one scene search every stash-box implements: fuzzy over title, studio and performer names, capped at 100
  const SEARCH_SCENES = `
    query PluginSearchScenes($term: String!, $limit: Int) {
      searchScene(term: $term, limit: $limit) {
        id
        title
        details
        release_date
        code
        duration
        studio { id name }
        performers { performer { id name } }
        tags { id }
        urls { url }
      }
    }
  `;
  const SEARCH_SCENE_LIMIT = 100;

  const QUERY_STUDIOS = `
    query PluginQueryStudios($input: StudioQueryInput!) {
      queryStudios(input: $input) {
        studios {
          id
          name
          parent { name }
        }
      }
    }
  `;

  // queryPerformers(performed_with:) is what stash-box's own Pairings tab
  // uses. SceneQueryInput has no performed_with, so shared scenes come from
  // Performer.scenes(performed_with:) and are flattened into a scene list.
  const QUERY_PAIRING_SCENES = `
    query PluginQueryPairingScenes(
      $input: PerformerQueryInput!
      $performedWith: ID!
    ) {
      queryPerformers(input: $input) {
        count
        performers {
          id
          scenes(input: { performed_with: $performedWith }) {
            id
            title
            details
            release_date
            code
            duration
            studio { name }
            performers { performer { name } }
          }
        }
      }
    }
  `;

  // --- stash_id helpers -------------------------------------------------
  //
  // stash_ids are per-endpoint: a performer/tag/studio only carries an id on
  // the box being queried. Endpoints are compared loosely (case, trailing
  // slash) because they are user-entered.

  function normaliseEndpoint(endpoint) {
    return (endpoint || "").trim().toLowerCase().replace(/\/+$/, "");
  }

  function findStashId(stashIds, endpoint) {
    const want = normaliseEndpoint(endpoint);
    const hit = (stashIds || []).find(
      (s) => normaliseEndpoint(s.endpoint) === want
    );
    return hit ? hit.stash_id : undefined;
  }

  function toIdOptions(entities, endpoint) {
    return (entities || []).map((e) => ({
      name: e.name,
      stashId: findStashId(e.stash_ids, endpoint),
    }));
  }

  // sceneUpdate replaces the whole stash_ids list, so ids for other endpoints
  // have to be carried over explicitly or they are lost. Matches the native
  // tagger (Tagger/scenes/StashSearchResult.tsx): keep other endpoints, drop
  // any existing id for this one, append the new one.
  function mergeStashIds(existing, endpoint, stashId) {
    const kept = (existing || [])
      .map((e) => ({
        endpoint: e.endpoint,
        stash_id: e.stash_id,
        updated_at: e.updated_at,
      }))
      .filter(
        (e) => normaliseEndpoint(e.endpoint) !== normaliseEndpoint(endpoint)
      );

    return kept.concat({
      endpoint: endpoint,
      stash_id: stashId,
      updated_at: new Date().toISOString(),
    });
  }

  function toggleIn(list, value) {
    return list.includes(value)
      ? list.filter((v) => v !== value)
      : list.concat(value);
  }

  // --- stash-box transport ----------------------------------------------
  //
  // These go straight to the stash-box endpoint over fetch(), which is why the
  // yml has to declare each host under ui.csp.connect-src - Stash serves a
  // restrictive Content-Security-Policy and the browser blocks anything not
  // listed, silently.

  async function gqlRequest(box, query, variables) {
    const res = await fetch(box.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // stash-box expects the key in ApiKey, not Authorization.
        ApiKey: box.api_key,
      },
      body: JSON.stringify({ query: query, variables: variables }),
    });

    if (!res.ok) throw new Error("stash-box returned HTTP " + res.status);

    const json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }

  const QUERY_PERFORMERS_BY_NAME = `
    query PluginQueryPerformers($input: PerformerQueryInput!) {
      queryPerformers(input: $input) {
        performers {
          id
          name
          disambiguation
        }
      }
    }
  `;

  async function searchPerformers(box, term) {
    const data = await gqlRequest(box, QUERY_PERFORMERS_BY_NAME, {
      input: { names: term, page: 1, per_page: 15, sort: "SCENE_COUNT", direction: "DESC" },
    });
    const needle = term.toLowerCase();
    const rank = (pf) => {
      const n = pf.name.toLowerCase();
      return n === needle ? 0 : n.startsWith(needle) ? 1 : 2;
    };
    return data.queryPerformers.performers
      .map((pf) => ({
        id: pf.id,
        name: pf.name,
        label: pf.disambiguation ? pf.name + " (" + pf.disambiguation + ")" : pf.name,
      }))
      .sort((a, b) => rank(a) - rank(b));
  }

  // SceneQueryInput filters by studio id; `name` matches the studio itself while `names` also matches aliases and parent studios, so both are run and merged
  async function searchStudios(box, term) {
    const run = (field) =>
      gqlRequest(box, QUERY_STUDIOS, {
        input: { [field]: term, page: 1, per_page: 40, sort: "NAME", direction: "ASC" },
      }).then((data) => data.queryStudios.studios);
    const [direct, broad] = await Promise.all([run("name"), run("names")]);
    const seen = new Set();
    const merged = direct.concat(broad).filter((st) => !seen.has(st.id) && seen.add(st.id));
    const needle = term.toLowerCase();
    const rank = (st) => {
      const n = st.name.toLowerCase();
      return n === needle ? 0 : n.startsWith(needle) ? 1 : n.includes(needle) ? 2 : 3;
    };
    return merged
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 15)
      .map((st) => ({
        id: st.id,
        name: st.name,
        label: st.parent ? st.name + " (" + st.parent.name + ")" : st.name,
      }));
  }

  // Type-ahead over a box's entities, like core's studio and performer selects. props.search(box, term) returns [{id, name, label}]
  function EntityPicker(props) {
    const [options, setOptions] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [typed, setTyped] = React.useState("");
    const timer = React.useRef(undefined);
    const latest = React.useRef(0);

    React.useEffect(() => () => clearTimeout(timer.current), []);

    function onInputChange(value, meta) {
      if (meta.action !== "input-change") return;
      setTyped(value);
      clearTimeout(timer.current);
      latest.current += 1;
      if (!value.trim()) {
        setOptions([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const mine = latest.current;
      timer.current = setTimeout(async function () {
        try {
          const found = await props.search(props.box, value.trim());
          if (mine === latest.current) setOptions(found);
        } catch (err) {
          console.warn(LOG, "search failed", err);
          if (mine === latest.current) setOptions([]);
        } finally {
          if (mine === latest.current) setLoading(false);
        }
      }, 250);
    }

    return React.createElement(Select, {
      className: "ultimate-scrape-picker",
      classNamePrefix: "react-select",
      value: props.value ? { value: props.value.id, label: props.value.name } : null,
      options: options.map((o) => ({ value: o.id, label: o.label, name: o.name })),
      isClearable: !!props.value,
      isLoading: loading,
      filterOption: null,
      placeholder: props.placeholder,
      noOptionsMessage: () => (typed.trim() ? "Nothing found" : "Type to search"),
      menuPortalTarget: document.body,
      styles: { menuPortal: (base) => Object.assign({}, base, { zIndex: 2000 }) },
      onInputChange: onInputChange,
      onChange: (o) => props.onPick(o ? { id: o.value, name: o.name || o.label } : undefined),
    });
  }

  // ThePornDB's queryScenes is a stub (scenes always null) and it has no queryStudios, so such boxes get searchScene plus client-side filtering
  const TEXT_ONLY_HOST = /(^|\.)theporndb\.net$/;
  const textOnlyEndpoints = new Set();

  function isTextOnlyBox(box) {
    if (!box) return false;
    if (textOnlyEndpoints.has(box.endpoint)) return true;
    try {
      return TEXT_ONLY_HOST.test(new URL(box.endpoint).hostname);
    } catch (err) {
      return false;
    }
  }

  async function runQueryScenes(box, input) {
    const data = await gqlRequest(box, QUERY_SCENES, { input: input });
    if (data.queryScenes && data.queryScenes.scenes == null) {
      textOnlyEndpoints.add(box.endpoint);
      return undefined;
    }
    return data.queryScenes;
  }

  async function runSearchScene(box, term) {
    const data = await gqlRequest(box, SEARCH_SCENES, {
      term: term,
      limit: SEARCH_SCENE_LIMIT,
    });
    return data.searchScene || [];
  }

  function matchString(actual, criterion) {
    const a = (actual || "").toLowerCase();
    const v = criterion.value.toLowerCase();
    switch (criterion.modifier) {
      case "EQUALS":
        return a === v;
      case "NOT_EQUALS":
        return a !== v;
      case "EXCLUDES":
        return !a.includes(v);
      default:
        return a.includes(v);
    }
  }

  function matchDate(actual, criterion) {
    const a = actual || "";
    if (!a) return false;
    switch (criterion.modifier) {
      case "GREATER_THAN":
        return a > criterion.value;
      case "LESS_THAN":
        return a < criterion.value;
      default:
        return a.startsWith(criterion.value);
    }
  }

  function matchIds(actualIds, wanted, modifier) {
    return modifier === "INCLUDES"
      ? wanted.some((id) => actualIds.includes(id))
      : wanted.every((id) => actualIds.includes(id));
  }

  function filterSearchScenes(scenes, f) {
    return scenes.filter(function (sc) {
      if (f.code && !matchString(sc.code, f.code)) return false;
      if (f.date && !matchDate(sc.release_date, f.date)) return false;
      if (f.url) {
        const needle = f.url.toLowerCase();
        const urls = (sc.urls || []).map((u) => (u.url || "").toLowerCase());
        if (!urls.some((u) => u.includes(needle))) return false;
      }
      if (f.studio) {
        const st = sc.studio;
        if (!st) return false;
        const sameId = f.studio.id && st.id === f.studio.id;
        const sameName = (st.name || "")
          .toLowerCase()
          .includes(f.studio.name.toLowerCase());
        if (!sameId && !sameName) return false;
      }
      if (f.performers) {
        const ids = (sc.performers || []).map((p) => p.performer.id);
        if (!matchIds(ids, f.performers.ids, f.performers.modifier)) return false;
      }
      if (f.tags) {
        const ids = (sc.tags || []).map((t) => t.id);
        if (!matchIds(ids, f.tags.ids, f.tags.modifier)) return false;
      }
      return true;
    });
  }

  // Pairings is a performer query; stash-box has no scene filter for
  // "appeared with X". Collect unique shared scenes from matching co-stars.
  function flattenPairingScenes(pairResult) {
    const seen = {};
    const scenes = [];
    ((pairResult && pairResult.performers) || []).forEach(function (p) {
      (p.scenes || []).forEach(function (sc) {
        if (seen[sc.id]) return;
        seen[sc.id] = true;
        scenes.push(sc);
      });
    });
    return scenes;
  }

  function sortScenes(scenes, sort, direction) {
    const dir = direction === "ASC" ? 1 : -1;
    return scenes.slice().sort(function (a, b) {
      var cmp = 0;
      if (sort === "TITLE") {
        cmp = (a.title || "").localeCompare(b.title || "");
      } else if (sort === "DURATION") {
        cmp = (a.duration || 0) - (b.duration || 0);
      } else {
        cmp = (a.release_date || "").localeCompare(b.release_date || "");
      }
      return cmp * dir;
    });
  }

  async function runQueryPairingScenes(box, input) {
    const data = await gqlRequest(box, QUERY_PAIRING_SCENES, {
      input: input,
      performedWith: input.performed_with,
    });
    return flattenPairingScenes(data.queryPerformers);
  }

  function useStashBoxes() {
    const { data } = GQL.useConfigurationQuery();
    return React.useMemo(() => {
      return (
        (data && data.configuration && data.configuration.general.stashBoxes) ||
        []
      );
    }, [data]);
  }

  function boxDisplayName(box, index) {
    if (box && box.name) return box.name;
    const endpoint = (box && box.endpoint) || "";
    if (/theporndb|porndb|metadataapi/i.test(endpoint)) return "PornDB";
    if (/stashdb/i.test(endpoint)) return "StashDB";
    if (/fansdb/i.test(endpoint)) return "FansDB";
    return "Stash-Box #" + (index + 1);
  }

  function findBoxByEndpoint(boxes, endpoint) {
    const want = normaliseEndpoint(endpoint);
    return (boxes || []).find(
      (b) => normaliseEndpoint(b.endpoint) === want
    );
  }

  // --- form control builders --------------------------------------------
  //
  // Two Stash-specific details are baked in here so they can't be forgotten at
  // a call site:
  //  * react-bootstrap 1.x (Bootstrap 4, which Stash ships) has no
  //    Form.Select - it arrived in v2. A select is Form.Control as="select".
  //    Using Form.Select renders undefined and takes the page down with
  //    React error #130.
  //  * Stash's dark theme colours fields through its own classes, text-input
  //    and input-control (ui/v2.5/src/index.scss), not through .form-control,
  //    which is left at Bootstrap's light default. Without them the values are
  //    dark-on-dark and effectively invisible.

  function prettyEnum(value) {
    return value
      .toLowerCase()
      .split("_")
      .map(function (word) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ");
  }

  function modifierOptions(modifiers, labels) {
    return modifiers.map(function (m) {
      const label = (labels && labels[m]) || MODIFIER_LABELS[m] || prettyEnum(m);
      return { value: m, label: label };
    });
  }

  function enumOptions(values) {
    return values.map(function (v) {
      return { value: v, label: prettyEnum(v) };
    });
  }

  function textInput(props) {
    const className = ["text-input", props.className].filter(Boolean).join(" ");
    return React.createElement(
      Form.Control,
      Object.assign({}, props, { className: className })
    );
  }

  function selectInput(props, values) {
    const className = ["input-control", props.className]
      .filter(Boolean)
      .join(" ");
    return React.createElement(
      Form.Control,
      Object.assign({}, props, { className: className, as: "select" }),
      values.map((v) => {
        const value = typeof v === "string" ? v : v.value;
        const label = typeof v === "string" ? v : v.label;
        return React.createElement("option", { key: value, value: value }, label);
      })
    );
  }

  function SearchSubmitButton(props) {
    return React.createElement(
      Button,
      {
        type: "submit",
        form: SEARCH_FORM_ID,
        variant: "primary",
        className: props.className,
        disabled: props.disabled,
      },
      React.createElement(PluginApi.components.Icon, { icon: faSearch }),
      " ",
      props.loading ? "Searching..." : "Search"
    );
  }

  // Two-column row: label (optional switch) on the left, controls on the right.
  // A switch keeps the value while off so a prefilled title does not have to
  // be deleted to drop it from the query.
  function fieldRow(props, children) {
    const hasToggle = typeof props.onToggle === "function";
    return React.createElement(
      "div",
      {
        key: props.id,
        className:
          "ultimate-scrape-row" +
          (hasToggle && !props.enabled ? " is-off" : "") +
          (props.tall ? " is-tall" : ""),
      },
      React.createElement(
        "div",
        { className: "ultimate-scrape-row-label" },
        hasToggle
          ? React.createElement(Form.Check, {
              type: "switch",
              id: props.id,
              label: props.label,
              checked: !!props.enabled && !props.unavailable,
              disabled: !!props.unavailable,
              title: props.title,
              onChange: function () {
                if (!props.unavailable) props.onToggle();
              },
            })
          : React.createElement(
              "div",
              { className: "ultimate-scrape-row-heading" },
              props.label
            )
      ),
      React.createElement("div", { className: "ultimate-scrape-row-value" }, children)
    );
  }

  function muted(text) {
    return React.createElement("div", { className: "text-muted" }, text);
  }

  // Checkbox list for an ID-based criterion. Entries with no id on this
  // stash-box are shown disabled rather than hidden, so it is obvious why they
  // cannot be filtered on, and they are listed after the ones that can.
  function IdCheckList(props) {
    const options = props.options.slice().sort(function (a, b) {
      if (!!a.stashId !== !!b.stashId) return a.stashId ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "");
    });
    return React.createElement(
      "div",
      { className: "ultimate-scrape-checklist" },
      options.map((o) =>
        React.createElement(Form.Check, {
          key: o.stashId || o.name,
          type: "checkbox",
          id: props.idPrefix + "-" + (o.stashId || o.name),
          label: o.stashId ? o.name : o.name + " (no id on this stash-box)",
          disabled: !o.stashId || props.disabled,
          checked: !!o.stashId && props.isChecked(o.stashId),
          onChange: () =>
            o.stashId && !props.disabled && props.onToggle(o.stashId),
        })
      )
    );
  }

  // core's SceneScrapeDialog does not save anything - it returns the fields the
  // user accepted and leaves applying them to its caller. SceneEditPanel feeds
  // them into a formik form; here they go straight into a sceneUpdate. Mirrors
  // updateSceneFromScrapedScene in
  // ui/v2.5/src/components/Scenes/SceneDetails/SceneEditPanel.tsx.
  function scrapedSceneToUpdateInput(scene, accepted, endpoint) {
    const input = { id: scene.id };

    if (accepted.title) input.title = accepted.title;
    if (accepted.code) input.code = accepted.code;
    if (accepted.details) input.details = accepted.details;
    if (accepted.director) input.director = accepted.director;
    if (accepted.date) input.date = accepted.date;
    if (accepted.production_date) input.production_date = accepted.production_date;
    if (accepted.urls) input.urls = accepted.urls;
    if (accepted.image) input.cover_image = accepted.image;
    if (accepted.studio && accepted.studio.stored_id) {
      input.studio_id = accepted.studio.stored_id;
    }

    // Only entities that already exist locally can be set by id. Creating the
    // others needs the mutations SceneEditPanel drives, so they are skipped.
    const storedIds = (list) =>
      (list || []).map((x) => x.stored_id).filter(Boolean);

    const performerIds = storedIds(accepted.performers);
    if (performerIds.length) input.performer_ids = performerIds;

    const tagIds = storedIds(accepted.tags);
    if (tagIds.length) input.tag_ids = tagIds;

    const groupIds = storedIds(accepted.groups);
    if (groupIds.length) {
      input.groups = groupIds.map((id) => ({ group_id: id }));
    }

    if (accepted.remote_site_id) {
      input.stash_ids = mergeStashIds(
        scene.stash_ids,
        endpoint,
        accepted.remote_site_id
      );
    }

    return input;
  }

  // Opens the sync flow for one stash-box scene. Shows "linked" when the local
  // scene already points at it, and marks the button when saving would replace
  // a link to a different scene.
  function LinkButton(props) {
    if (props.linkedStashId === props.stashSceneId) {
      return React.createElement("span", { className: "text-success" }, "linked");
    }

    return React.createElement(
      Button,
      {
        size: "sm",
        variant: "secondary",
        disabled: !!props.busyId,
        onClick: () => props.onSync(props.stashSceneId),
        title: props.linkedStashId
          ? "Sync from this stash-box scene - this replaces the existing link"
          : "Sync fields from this stash-box scene and link it",
      },
      props.busyId === props.stashSceneId ? "loading..." : "sync",
      props.linkedStashId ? "*" : ""
    );
  }

  // --- the search panel -------------------------------------------------
  //
  // Shared by the standalone page and the scene-page modal. Given a scene it
  // seeds itself from it: title, a dropdown of its urls, and the stash-box ids
  // of its performers, tags and studio. Prefill is not the same as "use this
  // in the query" - switched filters start off so a local title that does not
  // exist on stash-box is not silently narrowing the results.
  function SearchPanel(props) {
    const scene = props.scene;
    const boxes = useStashBoxes();

    const defaultEndpoint = React.useMemo(() => {
      if (!boxes.length) return "";
      const linked = boxes.find((b) =>
        findStashId(scene && scene.stash_ids, b.endpoint)
      );
      return (linked || boxes[0]).endpoint;
    }, [boxes, scene]);

    const [boxEndpoint, setBoxEndpoint] = React.useState("");
    const box =
      findBoxByEndpoint(boxes, boxEndpoint || defaultEndpoint) || boxes[0];

    const performerOptions = React.useMemo(
      () => (box ? toIdOptions(scene && scene.performers, box.endpoint) : []),
      [scene, box]
    );
    const allPerformerOptions = React.useMemo(
      () =>
        performerOptions.concat(
          extraPerformers.filter((x) => !performerOptions.some((p) => p.stashId === x.stashId))
        ),
      [performerOptions, extraPerformers]
    );
    const tagOptions = React.useMemo(
      () => (box ? toIdOptions(scene && scene.tags, box.endpoint) : []),
      [scene, box]
    );
    const studioStashId = React.useMemo(
      () =>
        box && scene && scene.studio
          ? findStashId(scene.studio.stash_ids, box.endpoint)
          : undefined,
      [scene, box]
    );

    const sceneUrls = (scene && scene.urls) || [];

    React.useEffect(
      function () {
        const sceneStudio = scene && scene.studio;
        setStudioPick(
          studioStashId ? { id: studioStashId, name: sceneStudio.name } : undefined
        );
        if (studioStashId || !box || !sceneStudio || isTextOnlyBox(box)) return;
        let live = true;
        searchStudios(box, sceneStudio.name)
          .then(function (found) {
            const exact = found.filter(
              (st) => st.name.toLowerCase() === sceneStudio.name.toLowerCase()
            );
            if (live && exact.length === 1) {
              setStudioPick({ id: exact[0].id, name: exact[0].name });
            }
          })
          .catch(function (err) {
            console.warn(LOG, "studio lookup failed", err);
          });
        return function () {
          live = false;
        };
      },
      [box && box.endpoint, scene && scene.id, studioStashId]
    );

    const [mode, setMode] = React.useState("scenes");
    const [text, setText] = React.useState((scene && scene.title) || "");
    const [textScope, setTextScope] = React.useState("TITLE");
    const [studioName, setStudioName] = React.useState(
      (scene && scene.studio && scene.studio.name) || ""
    );
    const [studioPick, setStudioPick] = React.useState(undefined);
    const [showMore, setShowMore] = React.useState(false);
    const [code, setCode] = React.useState("");
    const [codeModifier, setCodeModifier] = React.useState("INCLUDES");
    const [url, setUrl] = React.useState(sceneUrls[0] || "");
    const [date, setDate] = React.useState("");
    const [dateModifier, setDateModifier] = React.useState("EQUALS");
    const [perPage, setPerPage] = React.useState(20);
    const [sort, setSort] = React.useState("DATE");
    const [direction, setDirection] = React.useState("DESC");

    // Switched filters start off even when prefilled. Flip the switch to send
    // them. Performers and tags have no switch: tick the ones to include.
    const [useText, setUseText] = React.useState(false);
    const [useCode, setUseCode] = React.useState(false);
    const [useUrl, setUseUrl] = React.useState(false);
    const [useDate, setUseDate] = React.useState(false);
    const [useStudio, setUseStudio] = React.useState(false);
    const [urlCustom, setUrlCustom] = React.useState(false);

    // Performers and tags are opt-in. Tick to add them to the query; none
    // ticked means that criterion is omitted.
    const [includedPerformers, setIncludedPerformers] = React.useState([]);
    const [extraPerformers, setExtraPerformers] = React.useState([]);
    const [performerModifier, setPerformerModifier] = React.useState("INCLUDES_ALL");
    const [includedTags, setIncludedTags] = React.useState([]);
    const [tagModifier, setTagModifier] = React.useState("INCLUDES_ALL");

    const [anchorOverride, setAnchorOverride] = React.useState("");
    const [coName, setCoName] = React.useState("");
    const [gender, setGender] = React.useState("");

    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(undefined);
    const [sceneResult, setSceneResult] = React.useState(undefined);
    const [resultNote, setResultNote] = React.useState("");
    const [busyId, setBusyId] = React.useState(undefined);
    const [syncTarget, setSyncTarget] = React.useState(undefined);

    const [updateScene] = PluginApi.utils.StashService.useSceneUpdate();
    const [scrapeScene] = GQL.useScrapeSingleSceneLazyQuery({
      fetchPolicy: "network-only",
    });
    const Toast = PluginApi.hooks.useToast();

    // SceneScrapeDialog lives in a lazily loaded chunk, so it has to be pulled
    // in before PluginApi.components has it. It is only registered on Stash
    // builds carrying the PatchComponent("SceneScrapeDialog", ...) change; on
    // stock builds it stays undefined and syncing falls back to link-only.
    PluginApi.hooks.useLoadComponents([
      PluginApi.loadableComponents.SceneScrapeDialog,
    ]);
    const ScrapeDialog = PluginApi.components.SceneScrapeDialog;

    const siteUrl = ((box && box.endpoint) || "").replace(/\/graphql\/?$/, "");
    const linkedStashId = box
      ? findStashId(scene && scene.stash_ids, box.endpoint)
      : undefined;

    const anchorId =
      anchorOverride ||
      (performerOptions.find((p) => p.stashId) || {}).stashId ||
      "";
    const anchorName = (
      performerOptions.find((p) => p.stashId === anchorId) || {}
    ).name;

    const selectedPerformerIds = allPerformerOptions
      .map((p) => p.stashId)
      .filter((id) => id && includedPerformers.includes(id));
    const selectedTagIds = tagOptions
      .map((t) => t.stashId)
      .filter((id) => id && includedTags.includes(id));

    const moreActive = [useCode, useUrl, useDate].filter(Boolean).length;

    function buildSceneInput() {
      // stash-box paginates, but this UI only ever asks for page 1. per_page
      // is a result cap, not a pager.
      const input = {
        page: 1,
        per_page: perPage,
        sort: sort,
        direction: direction,
      };
      if (useText && text.trim()) {
        input[textScope === "TEXT" ? "text" : "title"] = text.trim();
      }
      if (useCode && code.trim()) {
        input.code = { value: code.trim(), modifier: codeModifier };
      }
      if (useUrl && url.trim()) input.url = url.trim();
      if (useDate && date.trim()) {
        input.date = { value: date.trim(), modifier: dateModifier };
      }
      if (selectedPerformerIds.length) {
        input.performers = {
          value: selectedPerformerIds,
          modifier: performerModifier,
        };
      }
      if (selectedTagIds.length) {
        input.tags = { value: selectedTagIds, modifier: tagModifier };
      }
      if (useStudio) {
        if (!studioPick) throw new Error("Pick a studio from the list, or turn Studio off");
        input.parentStudio = studioPick.id;
      }
      return input;
    }

    async function runTextOnlySearch() {
      const parts = [];
      if (useText && text.trim()) parts.push(text.trim());
      if (useStudio && studioName.trim()) parts.push(studioName.trim());
      allPerformerOptions
        .filter((p) => p.stashId && selectedPerformerIds.includes(p.stashId))
        .forEach((p) => parts.push(p.name));
      if (!parts.length) {
        throw new Error(
          "This stash-box can only search by text. Turn on Text or Studio, or tick a performer."
        );
      }

      const filters = {};
      if (useCode && code.trim()) {
        filters.code = { value: code.trim(), modifier: codeModifier };
      }
      if (useDate && date.trim()) {
        filters.date = { value: date.trim(), modifier: dateModifier };
      }
      if (useUrl && url.trim()) filters.url = url.trim();
      if (useStudio && studioName.trim()) {
        const name = studioName.trim();
        const sameAsScene =
          scene && scene.studio && scene.studio.name === name && studioStashId;
        filters.studio = { id: sameAsScene ? studioStashId : undefined, name: name };
      }
      if (selectedPerformerIds.length) {
        filters.performers = {
          ids: selectedPerformerIds,
          modifier: performerModifier,
        };
      }
      if (selectedTagIds.length) {
        filters.tags = { ids: selectedTagIds, modifier: tagModifier };
      }

      const found = await runSearchScene(box, parts.join(" "));
      const matched = filterSearchScenes(found, filters);
      const ordered =
        PAIRING_SCENE_SORTS.indexOf(sort) >= 0
          ? sortScenes(matched, sort, direction)
          : matched;
      const capped = found.length >= SEARCH_SCENE_LIMIT;
      return {
        count: matched.length,
        scenes: ordered.slice(0, perPage),
        note:
          matched.length +
          (capped ? "+" : "") +
          " matches on " +
          boxDisplayName(box, boxes.indexOf(box)) +
          " (text search" +
          (Object.keys(filters).length ? ", other filters applied to its top " + found.length : "") +
          ")",
      };
    }

    function buildPairingInput() {
      // per_page caps co-performers looked up, not scenes. 100 is stash-box's
      // usual max, so the flatten sees as many pairings as the box will give.
      const input = {
        performed_with: anchorId,
        page: 1,
        per_page: 100,
        sort: "SCENE_COUNT",
        direction: "DESC",
      };
      if (coName.trim()) input.names = coName.trim();
      if (gender) input.gender = gender;
      return input;
    }

    async function onSearch(ev) {
      ev.preventDefault();
      if (!box) return;

      setLoading(true);
      setError(undefined);
      try {
        if (mode === "pairings") {
          const pairingSort =
            PAIRING_SCENE_SORTS.indexOf(sort) >= 0 ? sort : "DATE";
          const all = sortScenes(
            await runQueryPairingScenes(box, buildPairingInput()),
            pairingSort,
            direction
          );
          const shown = all.slice(0, perPage);
          setSceneResult({ count: all.length, scenes: shown });
          setResultNote(
            shown.length < all.length
              ? "Showing " +
                  shown.length +
                  " of " +
                  all.length +
                  " scenes featuring " +
                  (anchorName || "this performer")
              : all.length +
                  " scenes featuring " +
                  (anchorName || "this performer")
          );
        } else {
          let result;
          let note;
          if (isTextOnlyBox(box)) {
            result = await runTextOnlySearch();
            note = result.note;
          } else {
            result = await runQueryScenes(box, buildSceneInput());
            if (!result) {
              result = await runTextOnlySearch();
              note = result.note;
            } else {
              note =
                result.count +
                " total matches on " +
                boxDisplayName(box, boxes.indexOf(box));
            }
          }
          setSceneResult(result);
          setResultNote(note);
        }
      } catch (err) {
        setError(err.message || String(err));
        setSceneResult(undefined);
        setResultNote("");
      } finally {
        setLoading(false);
      }
    }

    async function linkOnly(stashSceneId, note) {
      await updateScene({
        variables: {
          input: {
            id: scene.id,
            stash_ids: mergeStashIds(scene.stash_ids, box.endpoint, stashSceneId),
          },
        },
      });
      Toast.success(note);
    }

    // The scraper has no fetch-by-id mode for a stash-box source (see
    // ScrapeSingleScene in internal/api/resolver_query_scraper.go: fingerprints
    // or a query string only). stash-box's searchScene does resolve a scene
    // UUID to exactly that scene, so passing the id as the query is a precise
    // lookup rather than a text search. Going through the backend also means
    // studios/performers/tags come back already matched to local entities.
    async function onSync(stashSceneId) {
      if (!box || !scene) return;

      setBusyId(stashSceneId);
      try {
        if (!ScrapeDialog) {
          await linkOnly(
            stashSceneId,
            "Linked. This Stash build cannot open the scrape dialog, so no fields were synced."
          );
          return;
        }

        const res = await scrapeScene({
          variables: {
            source: { stash_box_endpoint: box.endpoint },
            input: { query: stashSceneId },
          },
        });

        const results = (res.data && res.data.scrapeSingleScene) || [];
        const match = results.find((r) => r.remote_site_id === stashSceneId);

        if (!match) {
          await linkOnly(
            stashSceneId,
            "Linked, but the scraper did not return this scene so there was nothing to sync"
          );
          return;
        }

        setSyncTarget({ stashSceneId: stashSceneId, scraped: match });
      } catch (err) {
        console.warn(LOG, "sync failed", err);
        Toast.error(err);
      } finally {
        setBusyId(undefined);
      }
    }

    async function onSyncDialogClosed(accepted) {
      setSyncTarget(undefined);
      if (!accepted || !box || !scene) return;

      try {
        // Uses core's own useSceneUpdate rather than a hand-rolled cache
        // update, so scene mutations evict exactly what core evicts. The
        // writeFragment rule in this repo covers writes made outside Apollo
        // (raw fetch) - this one goes through Apollo's mutation path.
        await updateScene({
          variables: {
            input: scrapedSceneToUpdateInput(scene, accepted, box.endpoint),
          },
        });
        Toast.success("Scene updated from stash-box");
      } catch (err) {
        console.warn(LOG, "scene update failed", err);
        Toast.error(err);
      }
    }

    React.useEffect(
      function () {
        if (!props.onSearchStateChange) return undefined;
        const blocked = mode === "pairings" && !anchorId;
        props.onSearchStateChange({ loading: loading, blocked: blocked });
        return function () {
          props.onSearchStateChange({ loading: false, blocked: false });
        };
      },
      [loading, mode, anchorId, props.onSearchStateChange]
    );

    if (!box) {
      return React.createElement(
        Alert,
        { variant: "warning" },
        "No stash-box instance is configured. Add one under Settings > " +
          "Metadata Providers first - this plugin reuses those endpoints and API keys. " +
          "PornDB is a stash-box too (https://theporndb.net/graphql)."
      );
    }

    function limitControl(key) {
      return React.createElement(
        "div",
        { key: key, className: "ultimate-scrape-limit" },
        React.createElement("span", { className: "text-muted" }, "Limit"),
        textInput({
          key: key + "-n",
          type: "number",
          min: 1,
          max: 100,
          title: "Maximum results to fetch. There is no next page.",
          value: perPage,
          onChange: (e) => setPerPage(Number(e.target.value)),
        })
      );
    }

    function urlSelectValue() {
      if (urlCustom) return URL_CUSTOM;
      if (sceneUrls.includes(url)) return url;
      if (url) return URL_CUSTOM;
      return "";
    }

    function showUrlCustom() {
      return !sceneUrls.length || urlSelectValue() === URL_CUSTOM;
    }

    const modeFields =
      mode === "pairings"
        ? [
            fieldRow(
              { id: "ultimate-scrape-anchor", label: "Performer" },
              [
                performerOptions.some((p) => p.stashId)
                  ? selectInput(
                      {
                        key: "anchor",
                        className: "ultimate-scrape-wide",
                        value: anchorId,
                        onChange: (e) => setAnchorOverride(e.target.value),
                      },
                      performerOptions
                        .filter((p) => p.stashId)
                        .map((p) => ({ value: p.stashId, label: p.name }))
                    )
                  : muted(
                      "Pairings needs a performer with an id on this stash-box. " +
                        "Open this from a scene whose performers are matched."
                    ),
              ]
            ),
            fieldRow(
              { id: "ultimate-scrape-coname", label: "Co-performer name" },
              [
                textInput({
                  key: "coname",
                  value: coName,
                  placeholder: "optional",
                  onChange: (e) => setCoName(e.target.value),
                }),
              ]
            ),
            fieldRow(
              { id: "ultimate-scrape-gender", label: "Gender" },
              [
                selectInput(
                  {
                    key: "gender",
                    value: gender,
                    onChange: (e) => setGender(e.target.value),
                  },
                  GENDERS.map((g) => ({
                    value: g,
                    label: g ? prettyEnum(g) : "(any)",
                  }))
                ),
              ]
            ),
            fieldRow(
              { id: "ultimate-scrape-psort", label: "Sort" },
              [
                selectInput(
                  {
                    key: "psort",
                    value: PAIRING_SCENE_SORTS.indexOf(sort) >= 0 ? sort : "DATE",
                    onChange: (e) => setSort(e.target.value),
                  },
                  enumOptions(PAIRING_SCENE_SORTS)
                ),
                selectInput(
                  {
                    key: "pdir",
                    value: direction,
                    onChange: (e) => setDirection(e.target.value),
                  },
                  enumOptions(["ASC", "DESC"])
                ),
                limitControl("pper"),
              ]
            ),
          ]
        : [
            isTextOnlyBox(box)
              ? React.createElement(
                  "div",
                  { key: "text-only-note", className: "text-muted ultimate-scrape-note" },
                  "This stash-box only supports a text search (title, studio and performer names). Text, Studio and ticked performers are searched; the other filters are applied to the 100 best matches."
                )
              : null,
            fieldRow(
              {
                id: "ultimate-scrape-use-text",
                label: "Text",
                enabled: useText,
                onToggle: () => setUseText(!useText),
                title:
                  "Title only maps to SceneQueryInput.title. Title and description maps to SceneQueryInput.text",
              },
              [
                textInput({
                  key: "text",
                  value: text,
                  disabled: !useText,
                  placeholder: "e.g. a performer name or scene title",
                  onChange: (e) => setText(e.target.value),
                }),
                selectInput(
                  {
                    key: "textscope",
                    value: textScope,
                    disabled: !useText,
                    onChange: (e) => setTextScope(e.target.value),
                  },
                  TEXT_SCOPES
                ),
              ]
            ),
            fieldRow(
              {
                id: "ultimate-scrape-performers",
                label: "Performers",
                tall: true,
              },
              [
                React.createElement(EntityPicker, {
                  key: "perfpick",
                  box: box,
                  search: searchPerformers,
                  placeholder: "Search performers to add…",
                  value: undefined,
                  onPick: function (pick) {
                    if (!pick) return;
                    setExtraPerformers(
                      extraPerformers.concat({ name: pick.name, stashId: pick.id })
                    );
                    if (!includedPerformers.includes(pick.id)) {
                      setIncludedPerformers(includedPerformers.concat(pick.id));
                    }
                  },
                }),
                allPerformerOptions.length
                  ? React.createElement(IdCheckList, {
                      key: "perfs",
                      idPrefix: "ultimate-scrape-perf",
                      options: allPerformerOptions,
                      isChecked: (id) => includedPerformers.includes(id),
                      onToggle: (id) =>
                        setIncludedPerformers(toggleIn(includedPerformers, id)),
                    })
                  : scene
                  ? muted("No performers are tagged on this scene.")
                  : null,
                allPerformerOptions.length
                  ? selectInput(
                      {
                        key: "perfmod",
                        value: performerModifier,
                        onChange: (e) => setPerformerModifier(e.target.value),
                      },
                      modifierOptions(ID_MODIFIERS, ID_MODIFIER_LABELS)
                    )
                  : null,
              ]
            ),
            scene
              ? fieldRow(
                  {
                    id: "ultimate-scrape-tags",
                    label: "Tags",
                    tall: true,
                  },
                  tagOptions.length
                    ? [
                        React.createElement(IdCheckList, {
                          key: "tags",
                          idPrefix: "ultimate-scrape-tag",
                          options: tagOptions,
                          isChecked: (id) => includedTags.includes(id),
                          onToggle: (id) =>
                            setIncludedTags(toggleIn(includedTags, id)),
                        }),
                        selectInput(
                          {
                            key: "tagmod",
                            value: tagModifier,
                            onChange: (e) => setTagModifier(e.target.value),
                          },
                          modifierOptions(ID_MODIFIERS, ID_MODIFIER_LABELS)
                        ),
                      ]
                    : [muted("No tags are set on this scene.")]
                )
              : null,
            fieldRow(
              {
                id: "ultimate-scrape-use-studio",
                label: "Studio",
                enabled: useStudio,
                onToggle: () => setUseStudio(!useStudio),
                title:
                  "Pick a studio or network; its sub-studios' scenes are included",
              },
              [
                isTextOnlyBox(box)
                  ? textInput({
                      key: "studio",
                      value: studioName,
                      disabled: !useStudio,
                      placeholder: "studio or network name",
                      onChange: (e) => setStudioName(e.target.value),
                    })
                  : React.createElement(EntityPicker, {
                      key: "studio",
                      box: box,
                      search: searchStudios,
                      placeholder: "Search studios…",
                      value: studioPick,
                      onPick: function (pick) {
                        setStudioPick(pick);
                        if (pick) setUseStudio(true);
                      },
                    }),
              ]
            ),
            React.createElement(
              "div",
              { key: "more-toggle", className: "ultimate-scrape-more" },
              React.createElement(
                Button,
                {
                  variant: "link",
                  size: "sm",
                  className: "ultimate-scrape-more-toggle",
                  onClick: () => setShowMore(!showMore),
                },
                (showMore ? "Fewer" : "More") +
                  " options" +
                  (!showMore && moreActive ? " (" + moreActive + " on)" : "")
              )
            ),
            ...(showMore
              ? [
                fieldRow(
                  {
                    id: "ultimate-scrape-use-code",
                    label: "Studio code",
                    enabled: useCode,
                    onToggle: () => setUseCode(!useCode),
                  },
                  [
                    textInput({
                      key: "code",
                      value: code,
                      disabled: !useCode,
                      placeholder: "studio catalog number",
                      onChange: (e) => setCode(e.target.value),
                    }),
                    selectInput(
                      {
                        key: "codemod",
                        value: codeModifier,
                        disabled: !useCode,
                        onChange: (e) => setCodeModifier(e.target.value),
                      },
                      modifierOptions(STRING_MODIFIERS)
                    ),
                  ]
                ),
                fieldRow(
                  {
                    id: "ultimate-scrape-use-url",
                    label: "URL",
                    enabled: useUrl,
                    onToggle: () => setUseUrl(!useUrl),
                  },
                  [
                    sceneUrls.length
                      ? selectInput(
                          {
                            key: "urlpick",
                            className: "ultimate-scrape-wide",
                            value: urlSelectValue(),
                            disabled: !useUrl,
                            onChange: function (e) {
                              const v = e.target.value;
                              if (v === URL_CUSTOM) {
                                setUrlCustom(true);
                                if (sceneUrls.includes(url)) setUrl("");
                              } else {
                                setUrlCustom(false);
                                setUrl(v);
                              }
                            },
                          },
                          [{ value: "", label: "(none)" }]
                            .concat(
                              sceneUrls.map((u) => ({ value: u, label: u }))
                            )
                            .concat([{ value: URL_CUSTOM, label: "Custom…" }])
                        )
                      : null,
                    showUrlCustom()
                      ? textInput({
                          key: "url",
                          className: "ultimate-scrape-wide",
                          value: sceneUrls.includes(url) ? "" : url,
                          disabled: !useUrl,
                          placeholder: "https://…",
                          onChange: function (e) {
                            setUrlCustom(true);
                            setUrl(e.target.value);
                          },
                        })
                      : null,
                  ]
                ),
                fieldRow(
                  {
                    id: "ultimate-scrape-use-date",
                    label: "Date",
                    enabled: useDate,
                    onToggle: () => setUseDate(!useDate),
                  },
                  [
                    textInput({
                      key: "date",
                      value: date,
                      disabled: !useDate,
                      placeholder: "YYYY-MM-DD",
                      onChange: (e) => setDate(e.target.value),
                    }),
                    selectInput(
                      {
                        key: "datemod",
                        value: dateModifier,
                        disabled: !useDate,
                        onChange: (e) => setDateModifier(e.target.value),
                      },
                      modifierOptions(["EQUALS", "GREATER_THAN", "LESS_THAN"])
                    ),
                  ]
                ),
                ]
              : []),
            fieldRow(
              { id: "ultimate-scrape-sort", label: "Sort" },
              [
                selectInput(
                  {
                    key: "sort",
                    value: sort,
                    onChange: (e) => setSort(e.target.value),
                  },
                  enumOptions(SCENE_SORTS)
                ),
                selectInput(
                  {
                    key: "dir",
                    value: direction,
                    onChange: (e) => setDirection(e.target.value),
                  },
                  enumOptions(["ASC", "DESC"])
                ),
                limitControl("per"),
              ]
            ),
          ];

    function sceneRows() {
      return sceneResult.scenes.map((s) =>
        React.createElement(
          "tr",
          { key: s.id },
          React.createElement("td", { title: s.details || undefined }, s.title),
          React.createElement("td", null, s.release_date),
          React.createElement("td", null, s.code),
          React.createElement("td", null, s.studio && s.studio.name),
          React.createElement(
            "td",
            null,
            (s.performers || []).map((p) => p.performer.name).join(", ")
          ),
          React.createElement(
            "td",
            null,
            React.createElement(
              "a",
              {
                href: siteUrl + "/scenes/" + s.id,
                target: "_blank",
                rel: "noreferrer",
              },
              "view"
            )
          ),
          scene
            ? React.createElement(
                "td",
                null,
                React.createElement(LinkButton, {
                  stashSceneId: s.id,
                  linkedStashId: linkedStashId,
                  busyId: busyId,
                  onSync: onSync,
                })
              )
            : null
        )
      );
    }

    function resultsTable(headers, rows, caption) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("p", { className: "mt-3" }, caption),
        React.createElement(
          Table,
          { striped: true, bordered: true, size: "sm" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              headers.map((h, i) =>
                React.createElement("th", { key: i }, h)
              )
            )
          ),
          React.createElement("tbody", null, rows())
        )
      );
    }

    return React.createElement(
      React.Fragment,
      null,

      syncTarget && ScrapeDialog
        ? React.createElement(ScrapeDialog, {
            scene: {
              id: scene.id,
              title: scene.title,
              code: scene.code,
              details: scene.details,
              director: scene.director,
              date: scene.date,
              production_date: scene.production_date,
              urls: scene.urls,
              stash_ids: scene.stash_ids,
            },
            sceneStudio: scene.studio || null,
            scenePerformers: scene.performers || [],
            sceneTags: scene.tags || [],
            sceneGroups: (scene.groups || []).map((g) => g.group),
            scraped: syncTarget.scraped,
            endpoint: box.endpoint,
            onClose: onSyncDialogClosed,
          })
        : null,

      React.createElement(
        "p",
        { className: "text-muted" },
        "Querying ",
        React.createElement(
          "code",
          null,
          boxDisplayName(box, boxes.indexOf(box))
        ),
        " directly. Free text uses stash-box ",
        React.createElement("code", null, "text"),
        " (title + description); title is title only. Switch Source to query PornDB or another configured stash-box."
      ),

      React.createElement(
        Form,
        {
          id: SEARCH_FORM_ID,
          onSubmit: onSearch,
          className: "ultimate-scrape-form",
        },
        fieldRow(
          { id: "ultimate-scrape-box", label: "Source" },
          [
            selectInput(
              {
                key: "box",
                className: "ultimate-scrape-wide",
                value: box.endpoint,
                onChange: function (e) {
                  setBoxEndpoint(e.target.value);
                  setSceneResult(undefined);
                  setResultNote("");
                  setError(undefined);
                  setIncludedPerformers([]);
                  setExtraPerformers([]);
                  setIncludedTags([]);
                  setUseStudio(false);
                  setAnchorOverride("");
                },
              },
              boxes.map((b, i) => ({
                value: b.endpoint,
                label: boxDisplayName(b, i),
              }))
            ),
          ]
        ),
        fieldRow(
          { id: "ultimate-scrape-mode", label: "Search" },
          [
            selectInput(
              {
                key: "mode",
                className: "ultimate-scrape-wide",
                value: mode,
                onChange: (e) => setMode(e.target.value),
              },
              [
                { value: "scenes", label: "Scenes (queryScenes)" },
                {
                  value: "pairings",
                  label: "Pairings - scenes with a co-performer",
                },
              ]
            ),
          ]
        ),
        modeFields,
        props.externalSubmit
          ? null
          : React.createElement(SearchSubmitButton, {
              className: "mt-3",
              loading: loading,
              disabled: loading || (mode === "pairings" && !anchorId),
            })
      ),

      loading
        ? React.createElement(Spinner, { animation: "border", className: "mt-3" })
        : null,
      error
        ? React.createElement(Alert, { variant: "danger", className: "mt-3" }, error)
        : null,

      sceneResult
        ? resultsTable(
            ["Title", "Date", "Code", "Studio", "Performers", ""].concat(
              scene ? [""] : []
            ),
            sceneRows,
            resultNote ||
              sceneResult.count +
                " total matches on " +
                boxDisplayName(box, boxes.indexOf(box))
          )
        : null
    );
  }

  // --- entry points -----------------------------------------------------

  function SearchPage() {
    return React.createElement(
      "div",
      { className: "ultimate-scrape-page" },
      React.createElement("h3", null, "Ultimate Scrape"),
      React.createElement(SearchPanel, null)
    );
  }

  // The scene-page entry: a magnifying-glass button in the scene's tab strip
  // that opens the search in a modal, seeded from that scene. Kept as a real
  // component so it can hold the open/closed state in a hook - a patch
  // callback is not a component and must not use hooks.
  function SceneSearchModalButton(props) {
    const [show, setShow] = React.useState(false);
    const [searchLoading, setSearchLoading] = React.useState(false);
    const [searchBlocked, setSearchBlocked] = React.useState(false);
    const onSearchStateChange = React.useCallback(function (state) {
      setSearchLoading(state.loading);
      setSearchBlocked(state.blocked);
    }, []);

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        Nav.Item,
        null,
        React.createElement(
          Nav.Link,
          {
            as: "button",
            type: "button",
            title: "Ultimate Scrape",
            onClick: () => setShow(true),
          },
          React.createElement(PluginApi.components.Icon, { icon: faSearch })
        )
      ),
      React.createElement(
        Modal,
        {
          show: show,
          onHide: () => setShow(false),
          size: "lg",
          dialogClassName: "ultimate-scrape-modal",
          scrollable: true,
        },
        React.createElement(
          Modal.Header,
          { closeButton: true },
          React.createElement(Modal.Title, null, "Ultimate Scrape")
        ),
        React.createElement(
          Modal.Body,
          { className: "ultimate-scrape-page" },
          // Mounted only while open, so reopening re-seeds from the scene.
          show ? React.createElement(SearchPanel, {
            scene: props.scene,
            externalSubmit: true,
            onSearchStateChange: onSearchStateChange,
          }) : null
        ),
        React.createElement(
          Modal.Footer,
          null,
          React.createElement(SearchSubmitButton, {
            loading: searchLoading,
            disabled: searchLoading || searchBlocked,
          })
        )
      )
    );
  }

  PluginApi.register.route(ROUTE, SearchPage);

  PluginApi.patch.before("MainNavBar.UtilityItems", function (props) {
    return [
      {
        children: React.createElement(
          React.Fragment,
          null,
          props.children,
          React.createElement(
            NavLink,
            { className: "nav-utility", exact: true, to: ROUTE },
            React.createElement(
              Button,
              {
                className: "minimal d-flex align-items-center h-100",
                title: "Ultimate Scrape",
              },
              React.createElement(PluginApi.components.Icon, { icon: faSearch })
            )
          )
        ),
      },
    ];
  });

  // ScenePage.Tabs is a container component, so an "after" patch appends to
  // whatever the core already rendered.
  //
  // patch.after appends the render result to the arguments React passed the
  // component (patch.tsx: afterFn.apply(ctx, args.concat(result))). How many
  // arguments React passes is a React implementation detail - it is 3 under
  // the server renderer - so the result's index must not be hard-coded.
  // Getting it wrong renders `undefined` in place of the core output, which
  // here deletes the entire scene tab strip. The result is always last.
  PluginApi.patch.after("ScenePage.Tabs", function () {
    const args = Array.prototype.slice.call(arguments);
    const props = args[0] || {};
    const result = args[args.length - 1];

    // Fail soft: a thrown error here would take the tab strip down with it.
    try {
      return React.createElement(
        React.Fragment,
        null,
        result,
        React.createElement(SceneSearchModalButton, {
          key: props.scene && props.scene.id,
          scene: props.scene,
        })
      );
    } catch (err) {
      console.warn(LOG, "could not add the scene tab button", err);
      return result;
    }
  });
})();
