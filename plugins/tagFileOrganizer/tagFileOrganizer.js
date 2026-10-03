(function () {
  "use strict";

  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch) {
    console.error("[TagFileOrganizer] PluginApi.patch is unavailable");
    return;
  }

  var PLUGIN_ID = "tagFileOrganizer";
  // Matches the id PluginSetting gives each setting (SettingsPluginsPanel).
  var SOURCE_FOLDER_ID = "plugin-" + PLUGIN_ID + "-sourceFolder";
  var RULES_ID = "plugin-" + PLUGIN_ID + "-rules";

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
  // Stored as a JSON string: [{"tags": [{"id", "name"}], "folder": "/path"}].
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
          h("code", null, rule.folder || "?")
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
      h(
        Bootstrap.Button,
        { variant: "secondary", size: "sm", onClick: props.onBrowse },
        "Browse"
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
          update(browsing, { tags: rules[browsing].tags, folder: dir });
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
          h("div", { className: "tfo-rule-folder" }, "Folder")
        ),
      rules.map(function (rule, i) {
        return h(RuleRow, {
          key: i,
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
            save(rules.concat([{ tags: [], folder: "" }]));
          },
        },
        h(Icon, { icon: icons.faPlus }),
        " Add rule"
      ),
      props.error && h("div", { className: "text-danger mt-2" }, props.error)
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
          return h(RulesSummary, { value: value });
        },
        validateChange: validateRules,
        // ModalSetting spreads this object onto SettingModal, whose own
        // modalProps go to the react-bootstrap Modal.
        modalProps: { modalProps: { size: "lg", dialogClassName: "tfo-rules-dialog" } },
      })
    );
  }

  // --- patch -----------------------------------------------------------------

  PluginApi.patch.instead("StringSetting", function (props, _, originalComponent) {
    var c = PluginApi.components;
    if (!c.ModalSetting || !c.FolderSelect) return originalComponent(props);
    if (props.id === SOURCE_FOLDER_ID) return h(SourceFolderSetting, props);
    if (props.id === RULES_ID && c.TagIDSelect) return h(RulesSetting, props);
    return originalComponent(props);
  });
})();
