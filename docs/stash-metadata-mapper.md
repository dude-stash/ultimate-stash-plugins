# Stash Metadata Mapper - User Manual

Writes a scene's metadata from Stash into the MP4 file itself: title,
description, date, studio, performers, rating, tags, cover image and Stash IDs.
The file then describes itself, and the metadata travels with it outside your
Stash database.

It edits the file's metadata atoms in place. The video is not re-encoded, so it
is lossless.

## Requirements

- **Python 3.10 or newer** available to Stash. The plugin ships with
  [mutagen](https://github.com/quodlibet/mutagen), the library that edits MP4
  atoms, so there is nothing to install with pip.
- Only **`.mp4` and `.m4v`** files are written. Other formats are skipped.

## Setup

Open **Settings → Plugins → Stash Metadata Mapper**.

| Setting | What it does |
| --- | --- |
| **Write when a scene is saved** | The hook: saving a scene queues a job that writes its metadata. |
| **Allow the manual task to write files** | Lets the **Export Metadata** task write into your files. |
| **Rescan Changed Files** | Rescans files whose bytes changed. See *Why it rescans*. |
| **Export Title / Description / Date / Studio / Cast / Rating / Artwork / Stash IDs** | Turn each field on or off. All are on by default. |
| **Export Tags as Keywords** | Writes the scene's tags to the keywords atom. |
| **Genre Tag Names** | Tags whose name contains one of these words go to the genre atom instead of keywords, e.g. `Amateur, Teen`. |
| **Ignored Tag Names** | Tags whose name contains one of these words are left out completely, e.g. `4K, HD, º`. |

You pick how it runs: turn on either of the two "write" settings, or both.
Neither is on by default, so installing the plugin never changes a file.

Genre and ignore lists are comma-separated and not case-sensitive. A tag
matches when its name *contains* the word, so `º` matches `180º` and `190º`.

## What gets written

| Stash field | MP4 atom |
| --- | --- |
| Title | `©nam` |
| Details | `ldes` (long description) |
| Date | `©day` |
| Studio | `aART` and a custom `com.stash:studio` atom |
| Performers | `©ART`, comma-separated |
| Rating | custom `com.stash:rating100` atom, the raw 0-100 value |
| Tags | `©gen` and/or `keyw`, see the tag settings |
| Cover image | `covr`, from the scene's screenshot |
| Stash ID | custom `com.stash:id` atom |
| StashDB / TPDB IDs | `com.stash:stashdb_id`, `com.stash:tpdb_id`; other stash-boxes get a key from their address |
| Media kind | `stik` set to movie, so players use the video fields |

Fields that are empty in Stash are not written.

## Running it

- **On save:** with *Write when a scene is saved* on, saving a scene queues a
  **Write scene metadata** job that writes its metadata into every MP4 file it
  has. The save itself doesn't wait for the file, and Stash runs the job one at
  a time with its other jobs, so a write never overlaps another write, a scan
  or a trim. A scene saved again before its job starts is written once.
  Identify and bulk edits count as saves. Library scans never write, so they
  stay fast: a file added to a scene by a scan is not written until you save
  the scene or run the task. Saves that change none of the exported fields,
  such as another plugin storing a custom field (Scene Trimmer's trim ranges),
  don't queue anything.
- **Manually:** under **Settings → Tasks → Plugin Tasks**, run **Export
  Metadata (Dry Run)** to see in the log what would change, atom by atom. Then
  run **Export Metadata** to write every scene in your library. This one needs
  *Allow the manual task to write files* turned on.

A file is only saved when at least one atom differs from what it already
holds, so running the task again, or another plugin editing the scene, leaves
files that are up to date untouched.

Check **Settings → Logs** for what was written and any failures. Each write
names the atoms it changed, e.g. `Scene 3120: wrote keywords → …`. Files that
were already up to date are logged at the Debug level.

## Why it rescans

Stash tracks a file by its path and a fingerprint called the oshash, which is
built from the file's size and its first and last 64 KB. Writing atoms changes
the size, so the oshash changes. If Stash kept the old one and you later moved
the file, Stash would not recognise it: it would add a new, empty scene and
leave the old one behind.

Stash can't be told a new oshash directly, so after writing, the plugin queues
a scan of the files whose bytes changed. The scan keeps each file's scene and
updates its oshash. It also drops the file's phash, so the plugin has the
scan generate the phash again for files that had one. Files that already had
the same metadata are not touched and not rescanned.

Stash runs one job at a time, so the scan starts after the plugin's task
finishes, usually within a few seconds. Until it finishes, don't move the file.
Turn off *Rescan Changed Files* only if you rescan yourself, with **Rescan**
ticked.

## Good to know

- Matching StashDB by the file's original oshash no longer works after a
  write. Matching by phash still does.
- Only the video files Stash knows about are written. Scenes only; images and
  galleries aren't handled.
- The first write to a file usually has to make room for the metadata, which
  moves all the video data after it along: a few seconds on an SSD, a minute
  or more for a large file on a slow or network drive. It leaves spare room, so
  later edits are quick.
- Don't cancel a **Write scene metadata** or **Export Metadata** job, or stop
  Stash, while a file is being written. A write stopped while it moves the
  video leaves a file that stops playing partway through.
- Back up before the first bulk run: the plugin edits your files in place.
