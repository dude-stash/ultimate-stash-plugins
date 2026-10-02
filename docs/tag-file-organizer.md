# Tag File Organizer - User Manual

Moves your scene files on disk into folders chosen by their tags. It is made
for an "inbox" folder, such as the folder your torrent client downloads into:
new files land there, you add them to Stash and tag them, and the plugin moves
them to where they belong, so nothing needs moving by hand or sits in the inbox.

Stash does the move itself, in one step with its own database, so the scene
keeps all its metadata and no rescan is needed.

## Requirements

- **Python 3** available to Stash. The backend script uses only the standard
  library, so there's nothing to install with pip.
- The destination folders must be **inside one of your Stash library folders**.
  Stash refuses to move files anywhere else. Missing folders are created.

## Setup

Open **Settings → Plugins → Tag File Organizer**.

| Setting | What it does |
| --- | --- |
| **Source folder** | Only files inside this folder (subfolders included) are moved, for example `/data/torrents`. Empty means every file in your library. **Edit** opens a folder browser. |
| **Rules** | Which tags go to which folder. See below. |
| **Folder when no rule matches** | Optional. Picked the same way. Files from the source folder that match no rule go here. Empty leaves them where they are. |
| **Move when a scene's tags change** | The hook: saving a scene moves its files straight away. |
| **Allow the manual tasks to move files** | Lets the **Organize all scenes** task move files. |
| **Dry run** | Only writes the moves to the log. |

You pick how it runs: turn on either of the two "move" settings, or both.
Neither is on by default, so installing the plugin never moves anything.

For the two folder settings, **Edit** opens the same folder browser as adding a
library folder: it starts at your library folders, clicking a folder opens it,
and typing `/` or a path lists the folders inside it. **Confirm** saves the
folder. If a Stash update ever breaks this, **Edit** opens a plain text box
instead. The destinations
in **Rules** are plain text, so type those out in full.

## Rules

One rule per line, tags on the left and the destination folder on the right:

```
# Tag, Tag => /destination/folder
Straight => /media/Straight
Straight, Threesome => /media/Straight/Threesome
Gay => /media/Gay
```

- A rule matches when the scene has **every** tag listed on its left side.
- If several rules match, the one with the **most tags** wins. A scene tagged
  `Straight` and `Threesome` goes to `/media/Straight/Threesome`, and a scene
  tagged only `Straight` goes to `/media/Straight`. If two matching rules have
  the same number of tags, the one listed first wins.
- Tag names aren't case sensitive. Blank lines and lines starting with `#` are
  ignored. A line that isn't in this form is skipped and noted in the log.

## Running it

- **On tag change:** with *Move when a scene's tags change* on, saving a scene
  after changing its tags moves it. Edits that don't touch tags are ignored.
  Files added by a scan don't trigger this until you edit them.
- **Manually:** under **Settings → Tasks → Plugin Tasks**, run
  **Preview moves** to see in the log what would happen. Then run **Organize
  all scenes** to do it. This one is the way to sort a batch of newly scanned
  files. It needs *Allow the manual tasks to move files* turned on.

Check **Settings → Logs** for what was moved, what matched no rule, and any
failures.

## Good to know

- A file whose folder is already the destination is left alone.
- If a file with the same name already exists in the destination, Stash won't
  overwrite or rename it. The move fails, it's noted in the log, and the file
  stays where it was.
- Only the video files Stash knows about are moved. Subtitles and other files
  next to them stay behind.
- Scenes only. Images and galleries aren't handled.
