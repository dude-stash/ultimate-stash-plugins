(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch) {
    console.error("[SceneEditFirstTab] PluginApi.patch is unavailable");
    return;
  }

  const React = PluginApi.React;
  const { FormattedMessage } = PluginApi.libraries.Intl;
  const Mousetrap = PluginApi.libraries.Mousetrap;

  const DETAILS_KEY = "scene-details-panel";
  const EDIT_KEY = "scene-edit-panel";

  // Tab.Pane carries eventKey directly; Nav.Item carries it on the nested
  // Nav.Link, which react-bootstrap also renders as data-rb-event-key.
  function eventKeyOf(el) {
    if (!el || !el.props) return undefined;
    if (el.props.eventKey) return el.props.eventKey;
    for (const child of React.Children.toArray(el.props.children)) {
      if (!child || !child.props) continue;
      if (child.props.eventKey) return child.props.eventKey;
      if (child.props["data-rb-event-key"]) {
        return child.props["data-rb-event-key"];
      }
    }
    return undefined;
  }

  function clickTab(key) {
    const link = document.querySelector('a[data-rb-event-key="' + key + '"]');
    if (link) link.click();
  }

  // Renders nothing. ScenePage hardcodes activeTabKey to the details panel,
  // which this plugin removes, so select the edit tab instead and point the
  // 'a' hotkey at it.
  function TabDefaulter() {
    React.useLayoutEffect(() => {
      // Runs after DOM commit but before paint, so no empty tab body flashes.
      clickTab(EDIT_KEY);
    }, []);

    React.useEffect(() => {
      // ScenePage binds 'a' in its own effect, which runs after this child's.
      // Defer so this binding is the one that sticks.
      const timer = setTimeout(() => {
        Mousetrap.bind("a", () => clickTab(EDIT_KEY));
      }, 0);
      return () => clearTimeout(timer);
    }, []);

    return null;
  }

  // Pulls the edit entry to the front and drops the read-only details entry.
  // toArray discards the falsy children that the conditional tabs (queue,
  // groups, galleries) render when they are absent.
  function reorder(children) {
    const kids = React.Children.toArray(children);
    return {
      edit: kids.find((c) => eventKeyOf(c) === EDIT_KEY),
      rest: kids.filter((c) => {
        const key = eventKeyOf(c);
        return key !== EDIT_KEY && key !== DETAILS_KEY;
      }),
    };
  }

  // Swaps the edit link's "Edit" label for "Details".
  function relabel(navItem) {
    const link = React.Children.toArray(navItem.props.children)[0];
    if (!link) return navItem;
    return React.cloneElement(
      navItem,
      null,
      React.cloneElement(
        link,
        null,
        React.createElement(FormattedMessage, { id: "details" })
      )
    );
  }

  // Both patched slots do the same thing: promote the edit child to the front
  // and drop the read-only details child. They differ only in what the
  // promoted child looks like (a relabelled nav item vs. the pane itself) and
  // in the warning text, so `label` and `transform` are all that varies.
  function promoteEditFirst(props, label, transform) {
    try {
      const { edit, rest } = reorder(props.children);
      // Without an edit tab to promote, removing the details tab would leave
      // the page with nothing to show. Pass through untouched instead.
      if (!edit) {
        console.warn(
          "[SceneEditFirstTab] " + label + " not found; leaving tabs as-is"
        );
        return [props];
      }
      return [
        Object.assign({}, props, {
          children: React.createElement(
            React.Fragment,
            null,
            ...transform(edit),
            ...rest
          ),
        }),
      ];
    } catch (e) {
      console.error("[SceneEditFirstTab] " + label + " patch failed", e);
      return [props];
    }
  }

  PluginApi.patch.before("ScenePage.Tabs", function (props) {
    return promoteEditFirst(props, "edit tab", (edit) => [
      relabel(edit),
      React.createElement(TabDefaulter, { key: "tab-defaulter" }),
    ]);
  });

  PluginApi.patch.before("ScenePage.TabContent", function (props) {
    return promoteEditFirst(props, "edit pane", (edit) => [edit]);
  });
})();
