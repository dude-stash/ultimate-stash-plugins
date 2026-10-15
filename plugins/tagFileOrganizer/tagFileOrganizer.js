(function () {
  "use strict";

  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch) {
    console.error("[TagFileOrganizer] PluginApi.patch is unavailable");
    return;
  }

  var PLUGIN_ID = "tagFileOrganizer";
  // Matches the id PluginSetting gives each setting (SettingsPluginsPanel).
  var SOURCE_FOLDER_ID = "plugin-" + PLUGIN_ID + "-1_sourceFolder";
  var RULES_ID = "plugin-" + PLUGIN_ID + "-2_rules";

  var React = PluginApi.React;
  var h = React.createElement;

  // Both settings stay plain STRING settings in the yml, since Stash has no
  // folder or list type. Stash shows a STRING setting as its value plus an
  // Edit button that opens a modal with a text box; this script keeps that row
  // and modal and only swaps what is inside them. If the script fails to
  // load, the settings still work as text.

  function libraryFolders(settings) {
    var stashes = (settings.general && settings.general.stashes) || [];
    return stashes.map(function (s) {
      return s.path;
    });
  }

  // --- source folder -------------------------------------------------------

  function SourceFolderSetting(props) {
    var ModalSetting = PluginApi.components.ModalSetting;
    var FolderSelect = PluginApi.components.FolderSelect;
    var defaults = libraryFolders(PluginApi.hooks.useSettings());

    // With nothing chosen yet the browser starts at the library folders;
    // typing "/" or a path lists the folders inside it.
    return h(
      ModalSetting,
      Object.assign({}, props, {
        renderField: function (value, setValue) {
          return h(FolderSelect, {
            currentDirectory: value || "",
            onChangeDirectory: setValue,
            defaultDirectories: defaults,
          });
        },
        renderValue: function (value) {
          return h("span", null, value);
        },
      })
    );
  }

  // --- rules -----------------------------------------------------------------
  //
  // Stored as a JSON string:
  // [{"tags": [{"id", "name"}], "folder": "/path", "anywhere": true}].
  // A string rather than an array so Stash's own text setting can still show
  // it if this script isn't running. The backend matches on tag ids; names are
  // only kept for the summary, and are refreshed whenever the rules are saved.

  // Returns {rules, legacy}: legacy is the old v0.1 "Tag => /folder" text, if
  // that's what is saved.
  function parseRules(value) {
    if (!value) return { rules: [], legacy: null };
    try {
      var parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return { rules: parsed, legacy: null };
    } catch (e) {
      // not JSON: old text rules
    }
    return { rules: [], legacy: String(value) };
  }

  function tagNames(rule) {
    return (rule.tags || [])
      .map(function (t) {
        return t.name;
      })
      .join(" + ");
  }

  function RulesSummary(props) {
    var parsed = parseRules(props.value);
    if (parsed.legacy) {
      return h("span", null, "Old text rules - click Edit to set them up again.");
    }
    if (!parsed.rules.length) return h("span", { className: "text-muted" }, "No rules yet");
    return h(
      "ul",
      { className: "tfo-summary list-unstyled mb-0" },
      parsed.rules.map(function (rule, i) {
        return h(
          "li",
          { key: i },
          h("strong", null, tagNames(rule) || "?"),
          " → ",
          h("code", null, rule.folder || "?"),
          rule.anywhere && h("span", { className: "text-muted" }, " (from any folder)")
        );
      })
    );
  }

  function RuleRow(props) {
    var Bootstrap = PluginApi.libraries.Bootstrap;
    var Icon = PluginApi.components.Icon;
    var TagIDSelect = PluginApi.components.TagIDSelect;
    var icons = PluginApi.libraries.FontAwesomeSolid;
    var rule = props.rule;

    return h(
      "div",
      { className: "tfo-rule" },
      h(
        "div",
        { className: "tfo-rule-tags" },
        h(TagIDSelect, {
          isMulti: true,
          creatable: false,
          menuPortalTarget: document.body,
          ids: (rule.tags || []).map(function (t) {
            return t.id;
          }),
          onSelect: function (items) {
            props.onChange({
              tags: items.map(function (t) {
                return { id: t.id, name: t.name };
              }),
              folder: rule.folder,
              anywhere: rule.anywhere,
            });
          },
        })
      ),
      h(
        "div",
        { className: "tfo-rule-folder" },
        rule.folder
          ? h("code", { title: rule.folder }, rule.folder)
          : h("span", { className: "text-muted" }, "No folder")
      ),
      h(Bootstrap.Form.Check, {
        type: "checkbox",
        className: "tfo-rule-anywhere",
        id: "tfo-anywhere-" + props.index,
        label: "Any folder",
        title: "Ignore the source folder and move files from anywhere in the library",
        checked: !!rule.anywhere,
        onChange: function (e) {
          props.onChange({ tags: rule.tags, folder: rule.folder, anywhere: e.target.checked });
        },
      }),
      h(
        Bootstrap.Button,
        {
          variant: "secondary",
          size: "sm",
          title: "Choose folder",
          onClick: props.onBrowse,
        },
        h(Icon, { icon: icons.faFolderOpen })
      ),
      h(
        Bootstrap.Button,
        {
          variant: "danger",
          size: "sm",
          title: "Delete rule",
          onClick: props.onDelete,
        },
        h(Icon, { icon: icons.faTrashAlt })
      )
    );
  }

  // Picking a folder swaps the modal body for the folder browser instead of
  // opening a second modal on top; Back or "Use this folder" return to the
  // list.
  function FolderStep(props) {
    var Bootstrap = PluginApi.libraries.Bootstrap;
    var FolderSelect = PluginApi.components.FolderSelect;
    var state = React.useState(props.folder || "");
    var dir = state[0];
    var setDir = state[1];

    return h(
      "div",
      { className: "tfo-folder-step" },
      h("h6", null, "Folder for ", h("strong", null, props.label || "this rule")),
      h(FolderSelect, {
        currentDirectory: dir,
        onChangeDirectory: setDir,
        defaultDirectories: props.defaults,
      }),
      h(
        "div",
        { className: "tfo-folder-step-buttons" },
        h(Bootstrap.Button, { variant: "secondary", onClick: props.onBack }, "Back"),
        h(
          Bootstrap.Button,
          {
            variant: "primary",
            disabled: !dir,
            onClick: function () {
              props.onPick(dir);
            },
          },
          "Use this folder"
        )
      )
    );
  }

  function RulesEditor(props) {
    var Bootstrap = PluginApi.libraries.Bootstrap;
    var Icon = PluginApi.components.Icon;
    var icons = PluginApi.libraries.FontAwesomeSolid;
    var defaults = libraryFolders(PluginApi.hooks.useSettings());
    var browsingState = React.useState(null);
    var browsing = browsingState[0];
    var setBrowsing = browsingState[1];

    var parsed = parseRules(props.value);
    var rules = parsed.rules;

    function save(next) {
      props.setValue(JSON.stringify(next));
    }
    function update(i, rule) {
      save(rules.map(function (r, j) {
        return j === i ? rule : r;
      }));
    }

    if (browsing !== null && rules[browsing]) {
      return h(FolderStep, {
        folder: rules[browsing].folder,
        label: tagNames(rules[browsing]),
        defaults: defaults,
        onBack: function () {
          setBrowsing(null);
        },
        onPick: function (dir) {
          update(browsing, { tags: rules[browsing].tags, folder: dir, anywhere: rules[browsing].anywhere });
          setBrowsing(null);
        },
      });
    }

    return h(
      "div",
      { className: "tfo-rules" },
      parsed.legacy &&
        h(
          Bootstrap.Alert,
          { variant: "warning" },
          "Your old text rules can't be converted automatically. Set them up again below:",
          h("pre", { className: "mb-0 mt-2" }, parsed.legacy)
        ),
      rules.length > 0 &&
        h(
          "div",
          { className: "tfo-rule tfo-rule-header text-muted" },
          h("div", { className: "tfo-rule-tags" }, "Tags"),
          h("div", { className: "tfo-rule-folder" }, "Folder"),
          h("div", { className: "tfo-rule-anywhere" }, "Source")
        ),
      rules.map(function (rule, i) {
        return h(RuleRow, {
          key: i,
          index: i,
          rule: rule,
          onChange: function (next) {
            update(i, next);
          },
          onBrowse: function () {
            setBrowsing(i);
          },
          onDelete: function () {
            save(rules.filter(function (_, j) {
              return j !== i;
            }));
          },
        });
      }),
      h(
        Bootstrap.Button,
        {
          variant: "secondary",
          className: "tfo-add",
          onClick: function () {
            save(rules.concat([{ tags: [], folder: "", anywhere: false }]));
          },
        },
        h(Icon, { icon: icons.faPlus }),
        " Add rule"
      ),
      props.error && h("div", { className: "text-danger mt-2" }, props.error)
    );
  }

  // Runs the backend's preview and shows the moves here, so they don't have to
  // be dug out of Settings > Logs. It uses the saved rules and settings.
  function PreviewButton() {
    var Bootstrap = PluginApi.libraries.Bootstrap;
    var state = React.useState({ open: false, loading: false, result: null, error: null, moved: null });
    var st = state[0];
    var setSt = state[1];

    function run() {
      setSt({ open: true, loading: true, result: null, error: null, moved: null });
      graphql(
        "mutation($id: ID!, $args: Map) { runPluginOperation(plugin_id: $id, args: $args) }",
        { id: PLUGIN_ID, args: { mode: "preview", detailed: true } }
      ).then(
        function (data) {
          setSt({ open: true, loading: false, result: data.runPluginOperation, error: null, moved: null });
        },
        function (err) {
          setSt({ open: true, loading: false, result: null, error: err.message, moved: null });
        }
      );
    }
    // Only offered after a preview was shown, and moves regardless of the Dry
    // run setting, since the user just confirmed the list.
    function move() {
      setSt({ open: true, loading: true, result: null, error: null, moved: null });
      graphql(
        "mutation($id: ID!, $args: Map) { runPluginOperation(plugin_id: $id, args: $args) }",
        { id: PLUGIN_ID, args: { mode: "organize", live: true } }
      ).then(
        function (data) {
          setSt({ open: true, loading: false, result: null, error: null, moved: String(data.runPluginOperation) });
        },
        function (err) {
          setSt({ open: true, loading: false, result: null, error: err.message, moved: null });
        }
      );
    }
    function close() {
      setSt({ open: false, loading: false, result: null, error: null, moved: null });
    }
    var moveCount = st.result && st.result.moves ? st.result.moves.length : 0;

    return h(
      React.Fragment,
      null,
      h(
        Bootstrap.Button,
        { variant: "secondary", size: "sm", className: "tfo-preview-btn", onClick: run },
        "Preview moves"
      ),
      h(
        Bootstrap.Modal,
        { show: st.open, onHide: close, size: "xl", dialogClassName: "tfo-preview-dialog" },
        h(Bootstrap.Modal.Header, { closeButton: true }, h(Bootstrap.Modal.Title, null, "Preview moves")),
        h(Bootstrap.Modal.Body, null, previewBody(st)),
        h(
          Bootstrap.Modal.Footer,
          null,
          moveCount > 0 &&
            !st.loading &&
            h(
              Bootstrap.Button,
              { variant: "primary", onClick: move },
              "Move " + moveCount + (moveCount === 1 ? " file" : " files")
            ),
          h(Bootstrap.Button, { variant: "secondary", onClick: close }, "Close")
        )
      )
    );
  }

  function previewBody(st) {
    if (st.loading) return h("p", null, "Working on your scenes...");
    if (st.error) return h("div", { className: "text-danger" }, st.error);
    if (st.moved) {
      return h("p", null, st.moved + ". Failures, such as a file that already exists in the folder, are listed in Settings > Logs.");
    }
    var r = st.result;
    if (typeof r === "string") return h("p", null, r);
    if (!r) return null;
    var moves = r.moves || [];
    return h(
      "div",
      null,
      h(
        "p",
        null,
        h("strong", null, moves.length + " to move"),
        ", " + (r.unchanged || 0) + " already in place, " + (r.unmatched || []).length +
          " matching no rule. Nothing has been moved yet."
      ),
      moves.length
        ? h(
            "ul",
            { className: "tfo-preview-list list-unstyled" },
            moves.map(function (m, i) {
              return h(
                "li",
                { key: i },
                h("div", { className: "tfo-preview-scene" }, m.scene),
                h("code", { className: "text-muted" }, m.from),
                " → ",
                h("code", null, m.to)
              );
            })
          )
        : null
    );
  }

  function validateRules(value) {
    var parsed = parseRules(value);
    if (parsed.legacy) return;
    parsed.rules.forEach(function (rule, i) {
      if (!rule.tags || !rule.tags.length || !rule.folder) {
        throw new Error("Rule " + (i + 1) + " needs at least one tag and a folder.");
      }
    });
  }

  function RulesSetting(props) {
    var ModalSetting = PluginApi.components.ModalSetting;
    return h(
      ModalSetting,
      Object.assign({}, props, {
        renderField: function (value, setValue, error) {
          return h(RulesEditor, { value: value, setValue: setValue, error: error });
        },
        renderValue: function (value) {
          return h("div", null, h(RulesSummary, { value: value }), h(PreviewButton));
        },
        validateChange: validateRules,
        // ModalSetting spreads this object onto SettingModal, whose own
        // modalProps go to the react-bootstrap Modal.
        modalProps: { modalProps: { size: "lg", dialogClassName: "tfo-rules-dialog" } },
      })
    );
  }

  // --- move a scene's files by hand ---------------------------------------------
  //
  // A button under the scene's File Info tab opens a modal to pick a folder
  // and move the scene's files there, using Stash's own moveFiles mutation
  // (the same one the rules use), so the destination must be inside a library
  // folder.

  var MOVE_FILES = PluginApi.libraries.Apollo.gql`
    mutation TagFileOrganizerMoveFiles($input: MoveFilesInput!) {
      moveFiles(input: $input)
    }
  `;

  // Only the path is rewritten, with writeFragment rather than evicting the
  // scene: see the IMPORTANT note in plugins/tagImageGrabber/tagImageGrabber.js
  // for why evicting an entity that is on screen goes wrong.
  var FILE_PATH_FRAGMENT = PluginApi.libraries.Apollo.gql`
    fragment TagFileOrganizerMovedFile on VideoFile {
      id
      path
    }
  `;

  function parentFolder(path) {
    return path.replace(/[\\/][^\\/]*$/, "");
  }

  function baseName(path) {
    return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  }

  function joinPath(folder, name) {
    var sep = folder.indexOf("\\") !== -1 && folder.indexOf("/") === -1 ? "\\" : "/";
    return folder.replace(/[\\/]+$/, "") + sep + name;
  }

  function MoveFilesModal(props) {
    var Bootstrap = PluginApi.libraries.Bootstrap;
    var FolderSelect = PluginApi.components.FolderSelect;
    var Toast = PluginApi.hooks.useToast();
    // useSettings only works inside the Settings pages (it throws on a scene
    // page), so the library folders come from Stash's configuration query.
    var useConfiguration = PluginApi.utils.StashService.useConfiguration;
    var config = useConfiguration ? useConfiguration().data : null;
    var defaults = libraryFolders({
      general: config && config.configuration && config.configuration.general,
    });
    var apollo = PluginApi.libraries.Apollo;
    var mutation = apollo.useMutation(MOVE_FILES);
    var moveFiles = mutation[0];
    var moving = mutation[1].loading;
    var client = apollo.useApolloClient();

    var files = props.files;
    var current = parentFolder(files[0].path);
    var state = React.useState(current);
    var dir = state[0];
    var setDir = state[1];
    var canMove = !moving && dir !== "" && dir !== current;

    async function onMove() {
      try {
        await moveFiles({
          variables: {
            input: {
              ids: files.map(function (f) {
                return f.id;
              }),
              destination_folder: dir,
            },
          },
        });
        files.forEach(function (f) {
          try {
            client.writeFragment({
              id: client.cache.identify({ __typename: "VideoFile", id: f.id }),
              fragment: FILE_PATH_FRAGMENT,
              data: {
                __typename: "VideoFile",
                id: f.id,
                path: joinPath(dir, baseName(f.path)),
              },
            });
          } catch (err) {
            // best-effort: the next load shows the new path anyway
          }
        });
        Toast.success("Moved to " + dir);
        props.onClose();
      } catch (err) {
        Toast.error(err);
      }
    }

    return h(
      Bootstrap.Modal,
      { show: true, onHide: props.onClose, size: "lg" },
      h(Bootstrap.Modal.Header, { closeButton: true }, h("h5", { className: "mb-0" }, "Move files")),
      h(
        Bootstrap.Modal.Body,
        null,
        files.map(function (f) {
          return h("div", { key: f.id, className: "tfo-move-file text-truncate", title: f.path }, f.path);
        }),
        h("h6", { className: "mt-3" }, "Move to"),
        h(FolderSelect, {
          currentDirectory: dir,
          onChangeDirectory: setDir,
          defaultDirectories: defaults,
          hideError: true,
        })
      ),
      h(
        Bootstrap.Modal.Footer,
        null,
        h(Bootstrap.Button, { variant: "secondary", onClick: props.onClose }, "Cancel"),
        h(Bootstrap.Button, { variant: "primary", disabled: !canMove, onClick: onMove }, moving ? "Moving..." : "Move")
      )
    );
  }

  function MoveFilesButton(props) {
    var Bootstrap = PluginApi.libraries.Bootstrap;
    var state = React.useState(false);
    var open = state[0];
    var setOpen = state[1];

    return h(
      "div",
      { className: "tfo-move-files mb-3" },
      h(
        Bootstrap.Button,
        {
          variant: "secondary",
          onClick: function () {
            setOpen(true);
          },
        },
        "Move files"
      ),
      open &&
        h(MoveFilesModal, {
          files: props.files,
          onClose: function () {
            setOpen(false);
          },
        })
    );
  }

  // --- settings migration ----------------------------------------------------
  //
  // Stash lists a plugin's settings sorted by key, so v0.4 prefixed the keys
  // with their position. Settings saved under the old keys are copied over
  // once, here rather than in the backend script, which only runs on a hook or
  // task and so wouldn't fix the settings page before then.

  // Every name the settings have had, including the numbered ones from the
  // an unreleased draft, mapped to the current one.
  var OLD_KEYS = {
    runOnTagChange: "3_runOnTagChange",
    "1_runOnTagChange": "3_runOnTagChange",
    sourceFolder: "1_sourceFolder",
    "3_sourceFolder": "1_sourceFolder",
    rules: "2_rules",
    "4_rules": "2_rules",
    dryRun: "5_dryRun",
  };
  // Removed in v0.4: moving by hand is now the Preview dialog button.
  var DROPPED_KEYS = ["runManually", "2_runManually", "4_runManually"];

  function graphql(query, variables) {
    var base = document.querySelector("base");
    var root = new URL((base && base.getAttribute("href")) || "/", window.location.origin);
    return fetch(new URL("graphql", root.href.endsWith("/") ? root : root.href + "/").href, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (res) {
        if (res.errors && res.errors.length) throw new Error(res.errors[0].message);
        return res.data;
      });
  }

  function migrateSettings() {
    return graphql("query($id: ID!) { configuration { plugins(include: [$id]) } }", {
      id: PLUGIN_ID,
    }).then(function (data) {
      var saved = (data.configuration.plugins || {})[PLUGIN_ID] || {};
      var old = Object.keys(OLD_KEYS)
        .concat(DROPPED_KEYS)
        .filter(function (k) {
          return k in saved;
        });
      if (!old.length) return;
      // configurePlugin replaces the whole map, so this also drops the old
      // keys. A key already saved under its new name wins.
      var next = Object.assign({}, saved);
      old.forEach(function (k) {
        delete next[k];
        if (OLD_KEYS[k] && !(OLD_KEYS[k] in saved)) next[OLD_KEYS[k]] = saved[k];
      });
      return graphql(
        "mutation($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }",
        { id: PLUGIN_ID, input: next }
      ).then(function () {
        console.info("[TagFileOrganizer] moved settings to their new names");
        // The settings page already loaded the old values into its cache.
        if (/\/settings/.test(window.location.pathname + window.location.hash)) {
          window.location.reload();
        }
      });
    });
  }

  migrateSettings().catch(function (err) {
    console.warn("[TagFileOrganizer] settings migration failed", err);
  });

  // --- patch -----------------------------------------------------------------

  PluginApi.patch.instead("StringSetting", function (props, _, originalComponent) {
    var c = PluginApi.components;
    if (!c.ModalSetting || !c.FolderSelect) return originalComponent(props);
    if (props.id === SOURCE_FOLDER_ID) return h(SourceFolderSetting, props);
    if (props.id === RULES_ID && c.TagIDSelect) return h(RulesSetting, props);
    return originalComponent(props);
  });

  // The panel is patched around, not replaced: the original renders as before
  // and the button follows it. Without these pieces it is left alone.
  PluginApi.patch.instead("SceneFileInfoPanel", function (props, _, originalComponent) {
    var original = originalComponent(props);
    var c = PluginApi.components;
    var files = props.scene && props.scene.files;
    if (!c.FolderSelect || !files || !files.length) return original;
    return h(React.Fragment, null, original, h(MoveFilesButton, { files: files }));
  });
})();
