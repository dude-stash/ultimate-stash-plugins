(function () {
  "use strict";

  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch) {
    console.error("[TagFileOrganizer] PluginApi.patch is unavailable");
    return;
  }

  var PLUGIN_ID = "tagFileOrganizer";
  // Settings that hold a folder path. They stay plain STRING settings in the
  // yml (Stash has no folder type), and this script swaps their text box for
  // Stash's own folder picker, the one used when adding a library folder.
  var FOLDER_SETTINGS = ["sourceFolder", "defaultFolder"];
  var SAVE_DELAY_MS = 600;

  var React = PluginApi.React;
  var h = React.createElement;

  // FolderSelect reports every keystroke, but each save is a configuration
  // mutation, so the text is kept locally and saved once typing pauses.
  function FolderSetting(props) {
    var Setting = PluginApi.components.Setting;
    var FolderSelect = PluginApi.components.FolderSelect;
    var settings = PluginApi.hooks.useSettings();
    var saved = (settings.plugins[PLUGIN_ID] || {})[props.setting.name] || "";
    var state = React.useState(saved);
    var value = state[0];
    var setValue = state[1];

    // Always merge into the newest settings, not the ones from the render that
    // scheduled the save, or a pending save could undo another setting.
    var latest = React.useRef(settings);
    latest.current = settings;
    var timer = React.useRef(null);
    var pending = React.useRef(null);

    function flush() {
      if (pending.current === null) return;
      var next = pending.current;
      pending.current = null;
      var current = latest.current.plugins[PLUGIN_ID] || {};
      var update = {};
      update[props.setting.name] = next;
      latest.current.savePluginSettings(PLUGIN_ID, Object.assign({}, current, update));
    }

    React.useEffect(function () {
      return function () {
        clearTimeout(timer.current);
        flush();
      };
    }, []);

    function onChange(next) {
      setValue(next);
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    }

    // With nothing typed yet, offer the library folders; typing "/" lists the
    // root, as in Settings -> Library.
    var stashes = (settings.general && settings.general.stashes) || [];
    var defaults = stashes.map(function (s) {
      return s.path;
    });

    return h(
      Setting,
      {
        id: "plugin-" + PLUGIN_ID + "-" + props.setting.name,
        heading: props.setting.display_name || props.setting.name,
        subHeading: props.setting.description || undefined,
      },
      h(
        "div",
        null,
        h(FolderSelect, {
          currentDirectory: value,
          onChangeDirectory: onChange,
          defaultDirectories: defaults,
          hideError: true,
        })
      )
    );
  }

  // The original component is called once per run of ordinary settings, so
  // each folder setting keeps its place in the list.
  PluginApi.patch.instead("PluginSettings", function (props, _, originalComponent) {
    try {
      if (props.pluginID !== PLUGIN_ID) return originalComponent(props);

      var parts = [];
      var run = [];
      function flushRun() {
        if (!run.length) return;
        parts.push(
          originalComponent(Object.assign({}, props, { settings: run }))
        );
        run = [];
      }
      (props.settings || []).forEach(function (setting) {
        if (FOLDER_SETTINGS.indexOf(setting.name) === -1) {
          run.push(setting);
          return;
        }
        flushRun();
        parts.push(h(FolderSetting, { key: setting.name, setting: setting }));
      });
      flushRun();
      return h.apply(null, [React.Fragment, null].concat(parts));
    } catch (e) {
      // Fall back to Stash's plain text boxes.
      console.error("[TagFileOrganizer] settings patch failed", e);
      return originalComponent(props);
    }
  });
})();
