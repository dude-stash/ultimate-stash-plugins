# Scene Trimmer - User Manual

Cut the boring parts out of a scene while you watch it. You mark ranges on the
video player and playback skips the parts that are cut. The file itself is not
changed, and your marks are saved as you go.

## Requirements

- **Python 3** available to Stash. The plugin's small backend script uses only
  the standard library, so there's nothing to install with pip.
- **ffprobe** (it ships with ffmpeg). Stash's configured ffprobe is used, or
  the one on your `PATH`. Without it everything still works except
  keyframe navigation.

## Keep or remove?

People trim in two ways, so you choose which one you use:

- **Kept** (the default): the ranges you mark are the parts you *keep*.
  Everything else is skipped.
- **Removed**: the ranges you mark are the parts you *cut*, like selecting a
  range and pressing Delete in Avidemux.

Set the default in **Settings → Plugins → Scene Trimmer → Marked ranges are
removed**. That setting only applies to scenes you haven't trimmed yet. Every
scene remembers its own mode, so changing the setting later never changes what
your existing marks mean.

You can switch one scene's mode in the **Segments** panel ("Marked ranges are
**Kept** / **Removed**"). If the scene already has ranges, you're asked what to
do with them:

- **Convert** flips the ranges so the same parts stay cut.
- **Just switch** keeps the ranges as they are, so they now mean the opposite.
- **Cancel** leaves everything as it was.

## Trimming

1. Open a scene and press the **scissors button** in the player's control bar
   (next to fullscreen). This turns on Trim mode, and a toolbar appears above
   the seek bar. The controls stay visible while you're in Trim mode, and it
   works in fullscreen.
2. Play or scrub to where a range starts and press **Mark In** (`[`). Go to
   where it ends and press **Mark Out** (`]`).
   - While an In is open, the status line shows
     "In at … – press ] or Mark Out to close it". **×** cancels it.
   - **Mark Out** with no open In closes a range from the end of the previous
     range (or from the start of the video).
3. Repeat for as many ranges as you like. Overlapping ranges are merged.

On the seek bar, cut parts are striped red. In Trim mode each marked range is
outlined (green in Kept mode, red in Removed mode) and has a white handle at
each end. Drag a handle to adjust it; the video follows so you can see the
frame you're cutting at.

### Finding the exact spot

| Key / button | Does |
| --- | --- |
| `↑` / **◀K** | Previous keyframe |
| `↓` / **K▶** | Next keyframe |
| **−1f** / **+1f** | One frame back / forward |
| `[` / **Mark In** | Mark In |
| `]` / **Mark Out** | Mark Out |
| `\` / **Preview** | Skip the cut parts while in Trim mode, to check your edit |

The keyboard shortcuts only work in Trim mode, so ↑/↓ scroll the page as usual
otherwise. They are ignored while you're typing in a text field.

**Snap** (on by default) moves every Mark In, Mark Out and handle drag to the
nearest keyframe. Keyframes are where a cut without re-encoding can actually
land, so snapped ranges are exactly what an exported file would contain.

The first time you open Trim mode on a scene, the status line shows "Finding
keyframes…" for a few seconds. After that they're cached. If they can't be
read you'll see "Keyframes unavailable – ↑/↓ step 1 s", and ↑/↓ move by one
second instead.

The toolbar also shows the scene's mode, how much is kept out of the total
length, and how many ranges there are, for example
"Keep mode · kept 1:12:03 / 1:48:50 · 4 ranges".

### Segments panel

**Segments** opens a list of your ranges. Each row has **In** and **Out**
(jump to that end) and **Delete**. The panel also has:

- **Marked ranges are Kept / Removed**: the scene's mode (see above).
- **Skip cut parts during playback**: untick it to watch the whole scene
  without losing your ranges.
- **Clear all**: asks "Delete all ranges for this scene?" and needs
  **Yes, clear all** to confirm.

Press **Done** (or the scissors button again) to leave Trim mode.

## Watching a trimmed scene

You don't need Trim mode for this. Whenever a scene has ranges and **Skip cut
parts during playback** is on, the player jumps over the cut parts, including
when you seek into one. After the last kept part the video ends normally, so
a queue moves on to the next scene. The scissors button is green when a scene
is being trimmed.

## Your work is always saved

Every change is saved within half a second, including an In that you haven't
closed yet. The status line shows "Saving…", then "Saved". Your ranges are
also saved when you leave the scene or close the tab. You can stop at any
time, watch something else, and come back later, even on another device.

When you open Trim mode again, a **Resume trimming at …** button takes you back
to where you stopped. It never jumps there by itself.

If a save fails, the status line shows **Save failed – retry**. Click it, or
just keep editing; the next change tries again.

## Where the ranges are stored

- The main copy is one small JSON file per scene in Stash's config directory,
  under `sceneTrimmer/scenes/`. This keeps it clear of plugin updates and of
  the scene edit form.
- A backup copy is kept in the scene's `ust_trim` custom field, so it's
  included in Stash's database backups. If the JSON file is ever missing (a
  new server, a restored database), it's restored from that field
  automatically and the status line says "Trim ranges restored from the
  scene's backup copy."
- In the scene edit form, `ust_trim` is hidden from the custom fields editor
  and shown as a note: "ust_trim holds this scene's trim ranges. It's managed
  by Scene Trimmer and can't be edited here."

Ranges belong to the scene's primary file. If the primary file changes, the
old ranges no longer line up, so they aren't applied. Trim mode then says
"These ranges were marked on a different file of this scene, so they aren't
applied." and offers **Clear them**.

## Troubleshooting

- **"Scene Trimmer's backend didn't answer, so nothing can be saved. Is Python
  available to Stash?"**: Stash couldn't run the plugin's Python script. Check
  **Settings → System → Python executable path** and the Stash log.
- **No scissors button**: the plugin couldn't find the player's control bar.
  This can happen after a Stash update; the browser console shows a
  `[sceneTrimmer]` warning.
