# Scene Edit First Tab - User Manual

On a scene page, Stash shows a read-only **Details** tab first, with the
editable form on a separate **Edit** tab. This plugin removes that extra step.

## What it does

- The **edit form becomes the first tab**, and the tab you land on when you
  open a scene.
- That promoted tab is **labelled "Details"** (in your Stash language), so the
  scene page reads the same as before - it's just editable now.
- The read-only Details tab is removed; there is no longer a duplicate.
- The scene page's **`a` keyboard shortcut** opens the edit form.
- Every other tab (Queue, Markers, Groups, Galleries, File Info, History...)
  keeps its usual place and order.

## Usage

There is nothing to configure. Install the plugin, reload the UI, and open any
scene: you can start typing straight into the fields.

## If Stash changes

The plugin only rearranges tabs it can positively identify. If a future Stash
version renames them, the plugin leaves the scene page exactly as Stash built
it and writes a warning to the browser console (`[SceneEditFirstTab] edit tab
not found`). You lose the feature, never the page.
