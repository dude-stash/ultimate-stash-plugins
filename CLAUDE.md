# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

A **plugin source** for [Stash](https://github.com/stashapp/stash). It is not
an application: it is a set of browser-side UI plugins plus a build script that
packages them into a repository index Stash can install from over HTTP.

`build_site.sh` zips each plugin directory and writes `_site/index.yml`;
`.github/workflows/deploy.yml` publishes `_site` to GitHub Pages, which is what
users add as a plugin source.

## Layout

```
plugins/<PluginName>/
  <PluginName>.yml    # manifest: name, description, version, ui assets
  <PluginName>.js     # the plugin
  <PluginName>.css    # optional styles
docs/                 # user manuals, linked from README.md
build_site.sh         # packages plugins/ into _site/
```

Everything in a plugin directory ends up in that plugin's zip, so don't leave
scratch files there.

## Hard rules

- **No build step, no bundler, no npm.** Each plugin is a single plain-ES
  browser script wrapped in an IIFE with `"use strict"`. There is no
  `package.json` and there should not be one. No imports, no JSX, no
  TypeScript - React elements are written with `React.createElement`.
- **Use `window.PluginApi` for everything.** Stash injects React, ReactDOM,
  Apollo, react-bootstrap, FontAwesome, react-intl and Mousetrap through
  `PluginApi.React`, `PluginApi.ReactDOM`, `PluginApi.libraries.*` and
  `PluginApi.components.*`. Never bundle or re-import those.
- **Bump `version:` in the plugin's yml for every user-facing change.** Stash
  clients compare the index version to decide whether an update exists; without
  a bump, nobody receives the change. `build_site.sh` appends the git short sha
  to whatever the yml says.
- **External libraries go in the yml**, as pinned CDN URLs under
  `ui.javascript` / `ui.css` - see how `tagImageGrabber.yml` pins
  `cropperjs@1.6.1`. Load order in the yml is the load order in the browser.
  Code that depends on such a library must degrade gracefully if the CDN
  request failed.

## Conventions in this codebase

- **UI hooks** use `PluginApi.patch.before(...)` (rewrite props) or
  `PluginApi.patch.instead(...)` (wrap/replace the component). Always call
  `originalComponent(props)` when using `instead` unless you truly mean to
  replace it.
- **Fail soft.** These plugins reach into Stash's internal DOM
  (`#tag-page .detail-header-image`, `a[data-rb-event-key=...]`) and internal
  component slots, none of which are a stable API. Guard for absence, log a
  warning, and leave the page working rather than throwing. Check
  `PluginApi`/`PluginApi.patch` exist before touching them.
- **Apollo cache updates must use `writeFragment`, never `evict`.** The reason
  is documented at length in `plugins/tagImageGrabber/tagImageGrabber.js`
  (search for `IMPORTANT: this must patch the field in place`). Keep that
  comment; it records a real bug that evicting caused.
- **Styling belongs in the plugin's CSS file**, addressed by
  `<plugin-prefix>-*` class names. Inline styles are reserved for values
  computed per element (sprite-sheet offsets, visibility toggles). Bootstrap
  utility classes are available; note that they set `display` with
  `!important`, so toggle visibility by swapping classes (`d-none` /
  `d-flex ...`), not by setting `style.display`.
- Keep the existing comment style: explain *why* a non-obvious approach was
  chosen, especially where it works around Stash behaviour.

## Testing

There is no test suite and no headless way to exercise these plugins.

- Syntax check: `node --check plugins/<Name>/<Name>.js`
- Packaging check: `./build_site.sh /tmp/site`, then confirm `/tmp/site/index.yml`
  lists each plugin with the expected version and that each zip contains the
  yml plus its assets.
- Real verification requires a running Stash instance with the plugin
  installed. When a change can't be verified that way in the current session,
  say so explicitly rather than implying it was tested.

## Documentation

User-facing behaviour is documented in `docs/`, linked from `README.md`.
When a change alters a button label, a flow, or an error message, update the
matching manual in the same commit - the manuals quote the UI strings
verbatim.
