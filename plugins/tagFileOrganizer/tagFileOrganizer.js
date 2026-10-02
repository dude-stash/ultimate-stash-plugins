(function () {
  "use strict";

  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch) {
    console.error("[TagFileOrganizer] PluginApi.patch is unavailable");
    return;
  }

  var PLUGIN_ID = "tagFileOrganizer";
  // Settings that hold a folder path. They stay plain STRING settings in the
  // yml (Stash has no folder type). Stash shows a STRING setting as its value
  // plus an Edit button that opens a modal with a text box; for these the
  // modal shows Stash's folder browser instead, the one used when adding a
  // library folder. The row and the modal are otherwise Stash's own.
  var FOLDER_SETTING_IDS = ["sourceFolder", "defaultFolder"].map(function (name) {
    // Matches the id PluginSetting gives each setting (SettingsPluginsPanel).
    return "plugin-" + PLUGIN_ID + "-" + name;
  });

  var React = PluginApi.React;
  var h = React.createElement;

  function FolderSetting(props) {
    var ModalSetting = PluginApi.components.ModalSetting;
    var FolderSelect = PluginApi.components.FolderSelect;
    var settings = PluginApi.hooks.useSettings();

    // With nothing chosen yet the browser starts at the library folders;
    // typing "/" or a path lists the folders inside it.
    var stashes = (settings.general && settings.general.stashes) || [];
    var libraryFolders = stashes.map(function (s) {
      return s.path;
    });

    return h(
      ModalSetting,
      Object.assign({}, props, {
        renderField: function (value, setValue) {
          return h(FolderSelect, {
            currentDirectory: value || "",
            onChangeDirectory: setValue,
            defaultDirectories: libraryFolders,
          });
        },
        renderValue: function (value) {
          return h("span", null, value);
        },
      })
    );
  }

  PluginApi.patch.instead("StringSetting", function (props, _, originalComponent) {
    if (FOLDER_SETTING_IDS.indexOf(props.id) === -1 || !PluginApi.components.ModalSetting ||
      !PluginApi.components.FolderSelect) {
      // Anything else, or a Stash without these components: the plain text box.
      return originalComponent(props);
    }
    return h(FolderSetting, props);
  });
})();
