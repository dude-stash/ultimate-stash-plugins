// Ultimate Scrape
//
// Stash's built-in stash-box integration only ever queries a scene by free
// text (searchScene) or by file fingerprint (findScenesBySceneFingerprints).
// Stash-box's own schema exposes far more: queryScenes(SceneQueryInput) filters
// by title, code, url, date, performers, tags and studio, and queryPerformers
// (performed_with) lists a performer's pairings. This plugin surfaces both, and
// can sync a result back onto the local scene.
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

  const ROUTE = "/plugins/ultimate-scrape";
  const LOG = "[UltimateScrape]";

  // Criterion modifiers, per stash-box's CriterionModifier enum.
  const STRING_MODIFIERS = ["EQUALS", "NOT_EQUALS", "INCLUDES", "EXCLUDES"];
  const ID_MODIFIERS = ["INCLUDES_ALL", "INCLUDES", "EXCLUDES", "EQUALS"];
  const SCENE_SORTS = [
    "TITLE",
    "DATE",
    "DURATION",
    "TRENDING",
    "POPULARITY",
    "CREATED_AT",
    "UPDATED_AT",
  ];
  const PERFORMER_SORTS = [
    "NAME",
    "BIRTHDATE",
    "SCENE_COUNT",
    "CAREER_START_YEAR",
    "DEBUT",
    "LAST_SCENE",
    "POPULARITY",
    "CREATED_AT",
    "UPDATED_AT",
  ];
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

  const QUERY_SCENES = `
    query PluginQueryScenes($input: SceneQueryInput!) {
      queryScenes(input: $input) {
        count
        scenes {
          id
          title
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

  // queryPerformers(performed_with:) is what stash-box's own "Pairings" tab
  // uses; Performer.scenes(performed_with:) narrows to the shared scenes.
  const QUERY_PERFORMERS = `
    query PluginQueryPerformers(
      $input: PerformerQueryInput!
      $performedWith: ID!
      $fetchScenes: Boolean!
    ) {
      queryPerformers(input: $input) {
        count
        performers {
          id
          name
          disambiguation
          gender
          birth_date
          scene_count
          scenes(input: { performed_with: $performedWith })
            @include(if: $fetchScenes) {
            id
            title
            release_date
            studio { name }
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

  async function runQueryScenes(box, input) {
    const data = await gqlRequest(box, QUERY_SCENES, { input: input });
    return data.queryScenes;
  }

  async function runQueryPerformers(box, input, fetchScenes) {
    const data = await gqlRequest(box, QUERY_PERFORMERS, {
      input: input,
      performedWith: input.performed_with,
      fetchScenes: fetchScenes,
    });
    return data.queryPerformers;
  }

  function useStashBox() {
    const { data } = GQL.useConfigurationQuery();
    return React.useMemo(() => {
      const boxes =
        (data && data.configuration && data.configuration.general.stashBoxes) ||
        [];
      return boxes[0];
    }, [data]);
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

  function textInput(props) {
    return React.createElement(
      Form.Control,
      Object.assign({ className: "text-input" }, props)
    );
  }

  function selectInput(props, values) {
    return React.createElement(
      Form.Control,
      Object.assign({ className: "input-control", as: "select" }, props),
      values.map((v) => {
        const value = typeof v === "string" ? v : v.value;
        const label = typeof v === "string" ? v : v.label;
        return React.createElement("option", { key: value, value: value }, label);
      })
    );
  }

  function formGroup(className, children) {
    return React.createElement(
      Form.Group,
      { className: className },
      children
    );
  }

  function label(text) {
    return React.createElement(Form.Label, null, text);
  }

  function muted(text) {
    return React.createElement("div", { className: "text-muted" }, text);
  }

  // Checkbox list for an ID-based criterion. Entities with no id on this
  // stash-box are shown disabled rather than hidden, so it is obvious why they
  // cannot be filtered on.
  function IdCheckList(props) {
    return React.createElement(
      "div",
      { className: "ultimate-scrape-checklist" },
      props.options.map((o) =>
        React.createElement(Form.Check, {
          key: o.stashId || o.name,
          type: "checkbox",
          id: props.idPrefix + "-" + (o.stashId || o.name),
          label: o.stashId ? o.name : o.name + " (no id on this stash-box)",
          disabled: !o.stashId,
          checked: !!o.stashId && props.isChecked(o.stashId),
          onChange: () => o.stashId && props.onToggle(o.stashId),
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
  // of its performers, tags and studio.
  function SearchPanel(props) {
    const scene = props.scene;
    const box = useStashBox();

    const performerOptions = React.useMemo(
      () => (box ? toIdOptions(scene && scene.performers, box.endpoint) : []),
      [scene, box]
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

    const [mode, setMode] = React.useState("scenes");
    const [title, setTitle] = React.useState((scene && scene.title) || "");
    const [code, setCode] = React.useState("");
    const [codeModifier, setCodeModifier] = React.useState("INCLUDES");
    const [url, setUrl] = React.useState(sceneUrls[0] || "");
    const [date, setDate] = React.useState("");
    const [dateModifier, setDateModifier] = React.useState("EQUALS");
    const [perPage, setPerPage] = React.useState(20);
    const [sort, setSort] = React.useState("DATE");
    const [direction, setDirection] = React.useState("DESC");

    // Performers are opt-out (all in until unticked); tags are opt-in, since a
    // scene carries many and requiring all of them matches nothing.
    const [excludedPerformers, setExcludedPerformers] = React.useState([]);
    const [performerModifier, setPerformerModifier] = React.useState("INCLUDES_ALL");
    const [includedTags, setIncludedTags] = React.useState([]);
    const [tagModifier, setTagModifier] = React.useState("INCLUDES_ALL");
    const [useStudio, setUseStudio] = React.useState(false);

    const [anchorOverride, setAnchorOverride] = React.useState("");
    const [coName, setCoName] = React.useState("");
    const [gender, setGender] = React.useState("");
    const [performerSort, setPerformerSort] = React.useState("NAME");
    const [fetchScenes, setFetchScenes] = React.useState(true);

    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(undefined);
    const [sceneResult, setSceneResult] = React.useState(undefined);
    const [pairResult, setPairResult] = React.useState(undefined);
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

    const selectedPerformerIds = performerOptions
      .map((p) => p.stashId)
      .filter((id) => id && !excludedPerformers.includes(id));
    const selectedTagIds = tagOptions
      .map((t) => t.stashId)
      .filter((id) => id && includedTags.includes(id));

    function buildSceneInput() {
      const input = {
        page: 1,
        per_page: perPage,
        sort: sort,
        direction: direction,
      };
      if (title.trim()) input.title = title.trim();
      if (code.trim()) input.code = { value: code.trim(), modifier: codeModifier };
      if (url.trim()) input.url = url.trim();
      if (date.trim()) input.date = { value: date.trim(), modifier: dateModifier };
      if (selectedPerformerIds.length) {
        input.performers = {
          value: selectedPerformerIds,
          modifier: performerModifier,
        };
      }
      if (selectedTagIds.length) {
        input.tags = { value: selectedTagIds, modifier: tagModifier };
      }
      if (useStudio && studioStashId) {
        input.studios = { value: [studioStashId], modifier: "INCLUDES" };
      }
      return input;
    }

    function buildPerformerInput() {
      const input = {
        performed_with: anchorId,
        page: 1,
        per_page: perPage,
        sort: performerSort,
        direction: direction,
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
          setPairResult(await runQueryPerformers(box, buildPerformerInput(), fetchScenes));
          setSceneResult(undefined);
        } else {
          setSceneResult(await runQueryScenes(box, buildSceneInput()));
          setPairResult(undefined);
        }
      } catch (err) {
        setError(err.message || String(err));
        setSceneResult(undefined);
        setPairResult(undefined);
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

    if (!box) {
      return React.createElement(
        Alert,
        { variant: "warning" },
        "No stash-box instance is configured. Add one under Settings > " +
          "Metadata Providers first - this plugin reuses that endpoint and API key."
      );
    }

    const modeFields =
      mode === "pairings"
        ? [
            formGroup("mb-2", [
              label("Performer"),
              performerOptions.some((p) => p.stashId)
                ? selectInput(
                    {
                      key: "anchor",
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
            ]),
            formGroup("mb-2", [
              label("Co-performer name contains"),
              textInput({
                key: "coname",
                value: coName,
                placeholder: "optional",
                onChange: (e) => setCoName(e.target.value),
              }),
            ]),
            formGroup("mb-2 ultimate-scrape-row", [
              label("Gender"),
              selectInput(
                {
                  key: "gender",
                  value: gender,
                  onChange: (e) => setGender(e.target.value),
                },
                GENDERS.map((g) => ({ value: g, label: g || "(any)" }))
              ),
              selectInput(
                {
                  key: "psort",
                  value: performerSort,
                  onChange: (e) => setPerformerSort(e.target.value),
                },
                PERFORMER_SORTS
              ),
              selectInput(
                {
                  key: "pdir",
                  value: direction,
                  onChange: (e) => setDirection(e.target.value),
                },
                ["ASC", "DESC"]
              ),
              textInput({
                key: "pper",
                type: "number",
                min: 1,
                max: 100,
                value: perPage,
                onChange: (e) => setPerPage(Number(e.target.value)),
              }),
            ]),
            formGroup("mb-2", [
              React.createElement(Form.Check, {
                key: "fetchscenes",
                type: "checkbox",
                id: "ultimate-scrape-fetch-scenes",
                label: "List the scenes they share",
                checked: fetchScenes,
                onChange: () => setFetchScenes(!fetchScenes),
              }),
            ]),
          ]
        : [
            formGroup("mb-2", [
              label("Title contains"),
              textInput({
                key: "title",
                value: title,
                placeholder: "e.g. a performer name or scene title",
                onChange: (e) => setTitle(e.target.value),
              }),
            ]),
            formGroup("mb-2 ultimate-scrape-row", [
              label("Code"),
              textInput({
                key: "code",
                value: code,
                onChange: (e) => setCode(e.target.value),
              }),
              selectInput(
                {
                  key: "codemod",
                  value: codeModifier,
                  onChange: (e) => setCodeModifier(e.target.value),
                },
                STRING_MODIFIERS
              ),
            ]),
            formGroup("mb-2", [
              label("URL contains"),
              sceneUrls.length
                ? selectInput(
                    {
                      key: "urlpick",
                      className: "input-control mb-1",
                      value: sceneUrls.includes(url) ? url : "",
                      onChange: (e) => setUrl(e.target.value),
                    },
                    [{ value: "", label: "(scene urls...)" }].concat(
                      sceneUrls.map((u) => ({ value: u, label: u }))
                    )
                  )
                : null,
              textInput({
                key: "url",
                value: url,
                onChange: (e) => setUrl(e.target.value),
              }),
            ]),
            formGroup("mb-2 ultimate-scrape-row", [
              label("Date (YYYY-MM-DD)"),
              textInput({
                key: "date",
                value: date,
                placeholder: "2020-01-01",
                onChange: (e) => setDate(e.target.value),
              }),
              selectInput(
                {
                  key: "datemod",
                  value: dateModifier,
                  onChange: (e) => setDateModifier(e.target.value),
                },
                ["EQUALS", "GREATER_THAN", "LESS_THAN"]
              ),
            ]),
            formGroup("mb-2 ultimate-scrape-row", [
              label("Sort"),
              selectInput(
                { key: "sort", value: sort, onChange: (e) => setSort(e.target.value) },
                SCENE_SORTS
              ),
              selectInput(
                {
                  key: "dir",
                  value: direction,
                  onChange: (e) => setDirection(e.target.value),
                },
                ["ASC", "DESC"]
              ),
              textInput({
                key: "per",
                type: "number",
                min: 1,
                max: 100,
                value: perPage,
                onChange: (e) => setPerPage(Number(e.target.value)),
              }),
            ]),
            scene
              ? formGroup("mb-2", [
                  label("Performers"),
                  performerOptions.length
                    ? React.createElement(IdCheckList, {
                        key: "perfs",
                        idPrefix: "ultimate-scrape-perf",
                        options: performerOptions,
                        isChecked: (id) => !excludedPerformers.includes(id),
                        onToggle: (id) =>
                          setExcludedPerformers(toggleIn(excludedPerformers, id)),
                      })
                    : muted("No performers are tagged on this scene."),
                  performerOptions.length
                    ? selectInput(
                        {
                          key: "perfmod",
                          className: "input-control mt-1",
                          value: performerModifier,
                          onChange: (e) => setPerformerModifier(e.target.value),
                        },
                        ID_MODIFIERS
                      )
                    : null,
                ])
              : null,
            scene
              ? formGroup("mb-2", [
                  label("Tags"),
                  tagOptions.length
                    ? React.createElement(IdCheckList, {
                        key: "tags",
                        idPrefix: "ultimate-scrape-tag",
                        options: tagOptions,
                        isChecked: (id) => includedTags.includes(id),
                        onToggle: (id) => setIncludedTags(toggleIn(includedTags, id)),
                      })
                    : muted("No tags are set on this scene."),
                  tagOptions.length
                    ? selectInput(
                        {
                          key: "tagmod",
                          className: "input-control mt-1",
                          value: tagModifier,
                          onChange: (e) => setTagModifier(e.target.value),
                        },
                        ID_MODIFIERS
                      )
                    : null,
                ])
              : null,
            scene && scene.studio
              ? formGroup("mb-2", [
                  React.createElement(Form.Check, {
                    key: "studio",
                    type: "checkbox",
                    id: "ultimate-scrape-studio",
                    label: studioStashId
                      ? "Limit to studio: " + scene.studio.name
                      : "Studio " + scene.studio.name + " has no id on this stash-box",
                    disabled: !studioStashId,
                    checked: useStudio && !!studioStashId,
                    onChange: () => setUseStudio(!useStudio),
                  }),
                ])
              : null,
          ];

    function sceneRows() {
      return sceneResult.scenes.map((s) =>
        React.createElement(
          "tr",
          { key: s.id },
          React.createElement("td", null, s.title),
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

    function pairRows() {
      return pairResult.performers.map((p) =>
        React.createElement(
          "tr",
          { key: p.id },
          React.createElement(
            "td",
            null,
            p.name + (p.disambiguation ? " (" + p.disambiguation + ")" : "")
          ),
          React.createElement("td", null, p.gender),
          React.createElement("td", null, p.birth_date),
          React.createElement("td", null, p.scene_count),
          fetchScenes
            ? React.createElement(
                "td",
                null,
                (p.scenes || []).map((sc) =>
                  React.createElement(
                    "div",
                    { key: sc.id },
                    React.createElement(
                      "a",
                      {
                        href: siteUrl + "/scenes/" + sc.id,
                        target: "_blank",
                        rel: "noreferrer",
                      },
                      sc.title || "(untitled)"
                    ),
                    " ",
                    React.createElement(
                      "span",
                      { className: "text-muted" },
                      [sc.release_date, sc.studio && sc.studio.name]
                        .filter(Boolean)
                        .join(" - ")
                    ),
                    " ",
                    scene
                      ? React.createElement(LinkButton, {
                          stashSceneId: sc.id,
                          linkedStashId: linkedStashId,
                          busyId: busyId,
                          onSync: onSync,
                        })
                      : null
                  )
                )
              )
            : null,
          React.createElement(
            "td",
            null,
            React.createElement(
              "a",
              {
                href: siteUrl + "/performers/" + p.id,
                target: "_blank",
                rel: "noreferrer",
              },
              "view"
            )
          )
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
        React.createElement("code", null, box.name || box.endpoint),
        " directly - filters, pagination and sort that Stash's own stash-box " +
          "search does not expose."
      ),

      React.createElement(
        Form,
        { onSubmit: onSearch, className: "ultimate-scrape-form" },
        formGroup("mb-3 ultimate-scrape-row", [
          label("Search"),
          selectInput(
            { key: "mode", value: mode, onChange: (e) => setMode(e.target.value) },
            [
              { value: "scenes", label: "Scenes (queryScenes)" },
              {
                value: "pairings",
                label: "Pairings - who else worked with a performer",
              },
            ]
          ),
        ]),
        modeFields,
        React.createElement(
          Button,
          {
            type: "submit",
            disabled: loading || (mode === "pairings" && !anchorId),
          },
          React.createElement(PluginApi.components.Icon, { icon: faSearch }),
          " ",
          loading ? "Searching..." : "Search"
        )
      ),

      loading
        ? React.createElement(Spinner, { animation: "border", className: "mt-3" })
        : null,
      error
        ? React.createElement(Alert, { variant: "danger", className: "mt-3" }, error)
        : null,

      pairResult
        ? resultsTable(
            ["Name", "Gender", "Born", "Scenes"]
              .concat(fetchScenes ? ["Shared scenes"] : [])
              .concat([""]),
            pairRows,
            pairResult.count + " performers have worked with " + (anchorName || "")
          )
        : null,

      sceneResult
        ? resultsTable(
            ["Title", "Date", "Code", "Studio", "Performers", ""].concat(
              scene ? [""] : []
            ),
            sceneRows,
            sceneResult.count + " total matches on stash-box"
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
          show ? React.createElement(SearchPanel, { scene: props.scene }) : null
        ),
        React.createElement(
          Modal.Footer,
          null,
          React.createElement(
            Button,
            { variant: "secondary", onClick: () => setShow(false) },
            "Close"
          )
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
