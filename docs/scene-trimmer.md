# Scene Trimmer - User Manual

Cut the boring parts out of a scene while you watch it. You mark ranges on the
video player and playback skips the parts that are cut, and your marks are
saved as you go. The file itself isn't changed unless you choose to create a
trimmed copy (see [Creating a trimmed file](#creating-a-trimmed-file)) or
split a movie into separate scenes (see [Splitting a movie into
scenes](#splitting-a-movie-into-scenes)).

## Requirements

- **Python 3** available to Stash. The plugin's small backend script uses only
  the standard library, so there's nothing to install with pip.
- **ffmpeg and ffprobe**. Stash's configured ones are used, or the ones on
  your `PATH`. Without them skipping still works, but keyframe navigation and
  creating a trimmed file don't.

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
   (next to fullscreen). This turns on Trim mode: a tool box appears at the
   left edge of the player, and **Snap**, **Preview** and **Segments** appear
   at the bottom right. The controls stay visible while you're in Trim mode,
   and it works in fullscreen.
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
| `[` / **Mark In** | Mark In |
| `]` / **Mark Out** | Mark Out |
| `x` / **Split** | Start a new scene here (see [splitting](#splitting-a-movie-into-scenes)) |
| `↑` / **Previous keyframe** | Previous keyframe |
| `↓` / **Next keyframe** | Next keyframe |
| **Preview** | Skip the cut parts while in Trim mode, to check your edit (button only) |

The buttons in the tool box at the left are icons only; hover one for its name.
Each shortcut is shown on its button. The keyboard shortcuts only work in Trim
mode, so ↑/↓ scroll the page as usual otherwise. They are ignored while you're
typing in a text field.

**Snap** (on by default) moves every Mark In, Mark Out, split point and handle
drag to the nearest keyframe. Keyframes are where a cut without re-encoding can actually
land, so snapped ranges are exactly what an exported file would contain.

The first time you open Trim mode on a scene, the status line shows "Finding
keyframes…" for a few seconds. After that they're cached. If they can't be
read you'll see "Keyframes unavailable – ↑/↓ step 1 s", and ↑/↓ move by one
second instead.

The top of the **Segments** panel shows how much is kept out of the total
length and how many ranges there are, for example
"Kept 1:12:03 / 1:48:50 · 4 ranges".

### Segments panel

**Segments** opens a list of your ranges. Each row has **In** and **Out**
(jump to that end) and **Delete**. The panel also has:

- **Marked ranges are Kept / Removed**: the scene's mode (see above).
- **Skip cut parts during playback**: untick it to watch the whole scene
  without losing your ranges.
- **Clear all**: asks "Delete all ranges for this scene?" and needs
  **Yes, clear all** to confirm.
- **Scene N starts at …**: one row per split point, with **Go** and
  **Delete**.
- **Create trimmed file…** and **Split into N scenes…**: see below.

Press the scissors button again to leave Trim mode.

## Watching a trimmed scene

You don't need Trim mode for this. Whenever a scene has ranges and **Skip cut
parts during playback** is on, the player jumps over the cut parts, including
when you seek into one. After the last kept part the video ends normally, so
a queue moves on to the next scene. The scissors button is green when a scene
is being trimmed.

## Creating a trimmed file

When you're happy with the edit, **Segments → Create trimmed file…** writes a
new file with only the kept parts. It's cut without re-encoding (stream copy),
so it takes about as long as copying the file, and quality doesn't change.

1. Confirm the dialog. It shows how much is kept, for example
   "Create a new file with only the kept parts (1:12:03 of 1:48:50)?".
2. The status line follows the work: "Creating trimmed file… 43%", "Joining
   the parts…", "Adding the new file to Stash…", "Adding the new file to this
   scene…". The steps also appear in **Settings → Tasks** as the Stash tasks
   "Trim scene", a scan, and "Finalize trim". They carry on if you leave the
   page.
3. When it's done the page reloads ("Trimmed file added to the scene –
   reloading…").

What you end up with:

- A new file next to the original, named `<original name>.trimmed.<ext>`
  (or `.trimmed-2`, `.trimmed-3`, … if that name is taken).
- It is added to **the same scene** as its main (primary) file, so the title,
  studio, performers, tags, cover, stash IDs and play history all stay. The
  original file stays on the scene as a second file; you can delete it from
  the **File Info** tab, or turn on **Delete the original file after
  trimming** in the plugin settings.
- Markers are moved to their new times. Markers that started in a cut part
  are deleted.
- The ranges are cleared, since the new file is already cut.
- Stash then generates sprites, previews, the phash and marker previews for
  the new file, unless **Don't generate previews for trimmed files** is on.

Cuts without re-encoding can only start on a keyframe, so a kept part may
start a little before its In. With **Snap** on your Ins already sit on
keyframes, and the file matches exactly what you marked.

While a trim is running, marking is disabled for that scene. If it fails, the
status line shows "Trim failed: …" with the reason and **Dismiss**; the
original file and scene are never changed by a failed trim.

## Splitting a movie into scenes

A movie with several scenes can become one Stash scene per scene, the way
StashDB lists them. Go to where each new scene starts and press **Split**
(`x`). A yellow line appears on the seek bar. 3 split points make 4 scenes;
the summary line shows the count, for example "· 4 scenes".

Split points work together with the ranges: mark the repetitive parts too,
and each new scene contains only its kept parts. A part that is entirely cut
doesn't become a scene.

When you're ready, **Segments → Split into N scenes…** and confirm. Like a
trimmed file, it runs as Stash tasks ("Trim scene", a scan, "Finalize trim")
and the status line shows the progress ("Creating the scene files… 43%",
"Adding the new files to Stash…", "Setting up the new scenes…").

What you end up with:

- One new file per scene next to the original, named
  `<original name>.scene-01.<ext>`, `.scene-02`, …, cut without re-encoding.
- One new Stash scene per file, each with:
  - the title "<original title> - Scene N" (or the file name if the original
    has no title),
  - the original's studio, date, director, tags and performers, as a
    starting point before you identify each scene on StashDB,
  - a copy of the original's markers that fall inside it, at their new times,
  - a cover (generated during the scan) and, unless **Don't generate previews
    for trimmed files** is on, sprites, previews and a phash.
- All of them in a **group** (Stash's name for a movie) in order, as scene 1,
  2, 3, …. If the original scene is already in a group, that group is used;
  otherwise a new group named after the original is created, with its
  studio, date and director.
- The **original scene and file stay exactly as they are**, including its
  ranges and split points. Delete it yourself once you're happy with the
  split.

When it's done the status line says "Created 4 scenes in the group “…”." with
an **Open group** link and **Dismiss**.

## Your work is always saved

Every change is saved within half a second, including an In that you haven't
closed yet and your split points. The status line shows "Saving…", then "Saved", which
disappears after a couple of seconds. Your ranges are also saved when you leave the scene or close the tab. You can stop at any
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
- `ust_trim` is hidden from the scene's custom fields, both in the details
  view and in the edit form, and is left untouched when you save the form.

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
