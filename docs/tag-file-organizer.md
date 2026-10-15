# Tag File Organizer - User Manual

Moves your scene files on disk into folders chosen by their tags. It is made
for an "inbox" folder, such as your downloads folder:
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
| **Source folder** | Only files from this folder (subfolders included) are moved, for example `/data/downloads`. Empty means every file in your library. A rule with **Any folder** ticked ignores it. |
| **Rules** | Which tags go to which folder. See below. |
| **Move when a scene's tags change** | The hook: saving a scene moves its files straight away. |
| **Dry run** | Only writes the moves to the log. Applies to the tag-change hook; moving from **Preview moves** always moves. |

Nothing moves until you turn on **Move when a scene's tags change** or confirm
a move yourself (see below), so installing the plugin never moves anything.

**Edit** next to **Source folder** opens the same folder browser as adding a
library folder: it starts at your library folders, clicking a folder opens it,
and typing `/` or a path lists the folders inside it. **Confirm** saves it.

## Rules

The **Rules** setting lists your rules, for example
**Straight + Threesome** → `/media/Straight/Threesome`. Click **Edit** to change
them:

1. Click **Add rule**.
2. Pick one or more tags from the tag list.
3. Click the folder button, choose the folder, and click **Use this folder**. **Back**
   returns without changing it.
4. Tick **Any folder** (under **Source**) if this rule may move files from any
   folder. Without it the rule only moves files inside the **Source folder**.
5. Click **Confirm** to save the rules. The trash button deletes a rule.

Every rule needs at least one tag and a folder; **Confirm** tells you which
rule is missing one.

How a scene's folder is chosen:

- A rule matches when the scene has **every** tag in it. Extra tags on the
  scene don't matter.
- If several rules match, the one with the **most tags** wins. With the rules
  **Straight** → `/media/Straight` and **Straight + Threesome** →
  `/media/Straight/Threesome`, a scene tagged Straight and Threesome goes to
  the second folder, and a scene tagged only Straight goes to the first.
- If the winning rules have the same number of tags, the one higher in the
  list wins.
- If no rule matches, the file stays where it is, and the log says so.
- Renaming a tag doesn't break a rule.
- Tags must match exactly: a parent tag doesn't count for its child tags.

Rules from version 0.1, typed as text, keep working until you save the rules
again. **Edit** shows the old text so you can set them up with the tag list.

## Running it

- **On tag change:** with *Move when a scene's tags change* on, saving a scene
  after changing its tags moves it. Edits that don't touch tags are ignored.
  Files added by a scan don't trigger this until you edit them.
- **Preview, then move:** click **Preview moves** under the **Rules** setting to
  see a list of every file that would move and where to. Nothing moves yet. If
  the list looks right, click **Move N files** in the same window. This moves
  the files even when **Dry run** is on, since you have just confirmed the list.
  It uses the rules you have saved. This is the way to sort a batch of newly
  scanned files.

Check **Settings → Logs** for what was moved, what matched no rule, and any
failures.

## Moving files by hand

You can also move a scene's files yourself, without any rules. Open the scene,
go to the **File Info** tab and click **Move files** under the file details.

1. The window lists the scene's files and starts the folder browser at the
   folder they are in. Your library folders are the starting points.
2. Pick the destination folder. Typing `/` or a path lists the folders inside
   it, and missing folders are created.
3. Click **Move**. **Cancel** closes the window without moving anything.

**Move** stays greyed out until you pick a folder other than the current one.
All of the scene's files go to the same folder. The destination must be inside
one of your library folders, and the same-name rule under *Good to know* applies:
if the move fails, a message says why and the files stay where they were.
This works whatever the settings above are, and isn't affected by **Dry run**.

## Good to know

- A file whose folder is already the destination is left alone.
- If a file with the same name already exists in the destination, Stash won't
  overwrite or rename it. The move fails, it's noted in the log, and the file
  stays where it was.
- Only the video files Stash knows about are moved. Subtitles and other files
  next to them stay behind.
- Scenes only. Images and galleries aren't handled.
