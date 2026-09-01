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

### Tag Image Grabber (v0.12)

Choose a tag image from linked images, scenes, or performers.

**Features:**

- Browse image candidates associated with a tag.
- Crop images with aspect-ratio controls.
- Capture and crop frames from linked scenes.
- Select images from linked performers.

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

## Support

- **Issues:** [GitHub Issues](https://github.com/dude-stash/ultimate-stash-plugins/issues)
- **Community:** [Stash Discord](https://discord.gg/stashapp) |
  [Stash Discourse](https://discourse.stashapp.cc/)

## License

[AGPL-3.0](LICENCE)
