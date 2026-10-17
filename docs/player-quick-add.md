# Player Quick Add - User Manual

Add and remove a scene's tags and performers without leaving the video. It
works in fullscreen too.

## Usage

1. Open a scene. A tags button appears in the player's control bar, next to
   the fullscreen button.
2. Click it. A panel opens over the video with a **Tags** and a **Performers**
   tab. What the scene already has is shown as chips at the top.
3. Type to search. Results are sorted by number of scenes, most first, with the count in parentheses after the name. Click a result, or press **Enter** to add the first one.
   The change is saved straight away, and the scene page behind the player
   updates.
4. If nothing matches exactly, the last row reads **Create "name"**. Click it,
   or press **Enter** when no results are listed, to create the tag or
   performer and add it to the scene.
5. Click the **×** on a chip to remove it from the scene.
6. **Esc** clears the search; **Esc** again, or the **×** in the corner,
   closes the panel.

The player's own keys (space, `f`, `m`, the arrows) are paused while you type
in the search box. The video keeps playing while the panel is open.

## Notes

- Creating a performer only sets the name. Fill in the rest from the
  performer's page.
- Searching matches names and aliases, the same as Stash's own search.

## If Stash changes

The button is added to the video.js control bar. If a future Stash version
changes the player, the plugin writes a warning to the browser console
(`[playerQuickAdd] ...`) and leaves the player as it was.
