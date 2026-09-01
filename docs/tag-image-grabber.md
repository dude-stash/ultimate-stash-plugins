# Tag Image Grabber - User Manual

Tag Image Grabber lets you set a tag's image by picking from content that is
already linked to that tag: images, scenes (including any frame of the video),
or performers. Every candidate goes through a crop step before it is saved.

## Requirements

- The
  [CommunityScriptsUILibrary](https://github.com/stashapp/CommunityScripts/tree/main/plugins/CommunityScriptsUILibrary)
  plugin, installed from the official CommunityScripts source.
- Internet access from the browser, the first time you use it in a session:
  the crop tool ([Cropper.js](https://fengyuanchen.github.io/cropperjs/)) is
  loaded from the jsDelivr CDN. If it can't load, everything still works
  except the interactive crop controls, and you'll be told so.

## Where to start from

There are four entry points. All of them open the same picker (except the
performer one, which is a shortcut - see below).

### 1. The tag grid / tag list

Hover a tag card. A small image button appears near the bottom-right corner of
the card. Click it.

On touch devices there is no hover, so the button is always visible.

### 2. A tag hover popover

Anywhere a tag chip shows its preview card on hover (for example, in a scene's
tag list), **click the tag image inside the popover**.

### 3. The tag page

Three equivalent ways, whichever is closest to your mouse:

- the **Set Image...** button in the header's edit row;
- the small image button that appears when you hover the header image;
- clicking the header image itself.

None of these appear while you are editing the tag with Stash's own edit form -
finish or cancel that first.

### 4. A performer page - "Use as Tag Image"

This one runs the other way around: it takes the image **the performer page is
currently showing** and applies it to a tag you choose.

1. Open a performer page. Click **Use as Tag Image** in the edit row next to
   Delete.
2. Pick the target tag in the dialog, then click **Use Image**.
3. Crop, then **Save**.

The button only appears when the performer actually has an image (a default
placeholder doesn't count).

## The picker

The picker lists everything linked to the tag, with three tabs:

| Tab | Shows |
| --- | --- |
| **Images** | Images tagged with this tag |
| **Scenes** | Scenes tagged with this tag (opens the scene view, below) |
| **Performers** | Performers tagged with this tag |

- **Search** filters the current tab. It waits a moment after you stop typing
  before it searches.
- Results are **24 per page, newest first**. Use **Previous** / **Next**.
- **Cancel**, or `Esc`, closes the picker without changing anything.

Some linked items are deliberately hidden, because they can't supply a usable
image:

- performers whose only image is Stash's default placeholder;
- images with no full-size path.

If a tab shows "No usable linked content found", nothing on that tab can supply
an image - try another tab, or tag more content with this tag.

Clicking an **image** or a **performer** goes straight to the crop step.
Clicking a **scene** opens the scene view.

## Choosing an image from a scene

The scene view has three sources, selectable at the top:

**Scene cover** - the scene's generated cover image. This is what opens first.
If the scene has no real cover, the view moves on by itself: to Thumbnails if
the scene has generated sprite thumbnails, otherwise to the video.

**Thumbnails** - the scene's sprite thumbnails as a scrollable grid. Click any
thumbnail and the plugin seeks the video to that moment and captures the frame
at full resolution (the sprite itself is far too small to use as a tag image).
The thumbnail's tooltip tells you which second it is.

**Video frame** - the scene, in a normal video player. Scrub to exactly the
frame you want, then click **Capture Current Frame**.

**Back to Scenes** returns to the scene list with your search and page intact.

## The crop step

The crop step is the last thing before saving, and it always looks the same
whatever the image came from.

- What you see straight away is **already a centred 1:1 square crop** of the
  original. If that's what you want, just press **Save**.
- To adjust it, click the **crop icon** in the top-right corner of the image.
  The full original appears with drag handles, starting from that same square -
  so you are adjusting the crop, not starting over.
- The ratio buttons below the image set the crop shape: **1:1**, **4:3**,
  **16:9**, **9:16**, or **Free** (any shape you drag).
- **Full** discards cropping entirely and uses the whole original image. You
  can press it at any time, including to back out of a crop in progress.
- **Save** writes the image to the tag. **Cancel**, or `Esc`, discards
  everything.

Why 1:1 by default: tag cards render their image inside a box of roughly 4:3,
scaled to fit, so a square crop fills the card well at every zoom level without
being cut off. 4:3 is the exact match at the larger zoom levels if you prefer
it.

## Troubleshooting

**"This scene has no generated cover image."** Stash hasn't generated a cover
for that scene. Use Thumbnails or Video frame instead, or run
Settings → Tasks → Generate (with Covers enabled) for that scene.

**"This scene has no generated thumbnails."** The scene has no sprite/VTT
files. Run Generate with Sprites enabled, or use Video frame instead.

**"This scene has no playable stream."** Stash can't stream that file - the
file may be missing or unsupported. Nothing can be captured from it.

**"couldn't capture this scene frame."** The seek didn't produce a decodable
frame in time. Try a different thumbnail, or switch to Video frame and capture
manually once the picture is visible.

**"wait for the video frame to load first."** You pressed Capture Current
Frame before the player had a frame on screen. Let it load, then press again.

**"failed to read image (...)"** The browser refused to read the image's pixel
data - almost always because it was served from a different origin than Stash.
Images served by your own Stash instance are not affected.

**"the cropper library failed to load."** The CDN request for Cropper.js
didn't succeed. Reload the page with a working connection; the centred square
preview and Save still work in the meantime.

**"failed to save tag image (...)"** The tag update itself was rejected. The
message carries the server's reason - usually a permissions or connection
problem.

**The new image doesn't appear.** Saving updates the tag everywhere it is
visible on screen. If a card still shows the old picture after a save
completed, reload the page.
