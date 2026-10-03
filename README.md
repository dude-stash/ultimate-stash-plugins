# Ultimate Stash Plugins

Plugins for extending [Stash](https://github.com/stashapp/stash), the
open-source media organizer.

## Installation

Add this repository as a plugin source in Stash:

1. Go to **Settings → Plugins → Available Plugins**.
2. Click **Add Source**.
3. Enter
   `https://dude-stash.github.io/ultimate-stash-plugins/main/index.yml`.
4. Click **Reload**.
5. Browse and install the available plugins individually.

## Available Plugins

### Ultimate Scrape (v0.4)

Search a configured stash-box with the filters Stash never exposes.

**Features:**

- Filter scenes by title, studio code, url, date, performers, tags and studio.
  Title, code, URL, date and studio have on/off switches; performers and tags
  are tick lists.
- "Pairings" search: scenes a performer shares with co-stars.
- Opens from the top nav, or from a scene page seeded with that scene.
- Sync a result back onto the scene through Stash's own scrape dialog, which
  also records the stash-box link.

See the [user manual](docs/ultimate-scrape.md).

### Tag Image Grabber (v0.14)

Choose a tag image from linked images, scenes, or performers.

**Features:**

- Browse image candidates associated with a tag.
- Crop images with aspect-ratio controls.
- Capture and crop frames from linked scenes.
- Select images from linked performers.
- Exclude a tag from scrapes with one click, from its card or its tag page.

**Requirement:** The
[CommunityScriptsUILibrary](https://github.com/stashapp/CommunityScripts/tree/main/plugins/CommunityScriptsUILibrary)
plugin must be available from the official CommunityScripts source.

**Manual:** [How to use Tag Image Grabber](docs/tag-image-grabber.md)

### Scene Edit First Tab (v1.0.1)

Replace the read-only Details tab on scene pages with the edit form.

**Features:**

- Makes the edit form the first and default scene tab.
- Labels the promoted edit tab as Details.
- Redirects the scene-page `a` keyboard shortcut to the edit form.
- Preserves the remaining scene tabs in their existing order.

**Manual:** [How to use Scene Edit First Tab](docs/scene-edit-first-tab.md)

### Scene Trimmer (v0.3)

Trim the repetitive parts of a scene while you watch it. Playback skips the
cut parts, and you can export a trimmed file that stays linked to the scene.

**Features:**

- Trim mode inside the video player: Mark In / Mark Out (`[` / `]`),
  draggable handles on the seek bar, and it works in fullscreen.
- Mark the parts to keep or the parts to remove; you choose the default, and
  each scene remembers its own mode.
- Step between keyframes with `↑` / `↓` and snap marks to them.
- Saved as you go, including an In you haven't closed yet, so you can stop and
  come back any time.
- Create a trimmed file without re-encoding. It becomes the scene's main
  file, so no metadata is lost, and markers move to their new times.
- Split a movie into its scenes (`x` marks where each starts). Each part
  becomes its own scene with the movie's metadata, grouped in order, the way
  StashDB lists them.

**Requirement:** Python 3 available to Stash (standard library only), plus
ffmpeg/ffprobe for keyframes and trimmed files.

**Manual:** [How to use Scene Trimmer](docs/scene-trimmer.md)

### Tag File Organizer (v0.2)

Move scene files on disk into folders based on their tags.

**Features:**

- Rules pick tags from your tag list and a folder from a folder browser.
  Combo rules work: a scene tagged Straight and Threesome can go somewhere
  else than one tagged only Straight. The most specific rule wins.
- Choose a source folder, such as a torrents inbox, so only new downloads are
  moved and the rest of your library stays put.
- Move when a scene's tags change, with a manual task, or both. You decide in
  the plugin settings.
- Preview and dry-run modes.

**Requirement:** Python 3 available to Stash (standard library only).

**Manual:** [How to use Tag File Organizer](docs/tag-file-organizer.md)

## Support

- **Issues:** [GitHub Issues](https://github.com/dude-stash/ultimate-stash-plugins/issues)
- **Community:** [Stash Discord](https://discord.gg/stashapp) |
  [Stash Discourse](https://discourse.stashapp.cc/)

## License

[AGPL-3.0](LICENCE)
