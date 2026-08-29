// Tag Image Grabber
//
// Adds a small action button next to tag chips on Image and Scene detail
// pages that lets you grab an image and use it as that tag's image (with an
// optional crop step), instead of having to manually download/upload/crop
// it yourself.
//
// Current scope (see plan): Image page tag chips (use the full-res displayed
// image). Scene page tag chips open a picker with three sources - the
// scene's existing cover, a clickable grid built from the sprite/VTT
// thumbnail sheet (pick a tile directly, or seek the player there and
// capture a full-res frame), or a live capture of whatever frame the video
// is currently paused on. Deliberately not using scene marker screenshots as
// a source - a marker's screenshot isn't necessarily the best representative
// frame for a tag, so this only ever offers full manual control over which
// frame gets used. The player-toolbar entry point (for tags not yet on the
// scene, via a TagSelect picker) and the reverse picker from a Tag's own
// edit page are follow-up phases, not implemented here yet.
(function () {
  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const Apollo = PluginApi.libraries.Apollo;
  const csLib = window.csLib;

  const TAG_UPDATE_MUTATION = `mutation TagImageGrabberUpdate($input: TagUpdateInput!) { tagUpdate(input: $input) { id } }`;

  async function saveTagImage(tagId, imageValue) {
    const variables = { input: { id: tagId, image: imageValue } };
    await csLib.callGQL({ query: TAG_UPDATE_MUTATION, variables });
  }

  // The save above goes straight over fetch(), bypassing Apollo entirely, so
  // Apollo's in-memory cache still holds the tag's old image_path - anything
  // reading it (e.g. the tag hover-preview popover) would keep showing the
  // old image until a full reload.
  //
  // IMPORTANT: this must patch the field in place (writeFragment), not evict
  // the whole Tag entity. Evicting it removes the object outright, and any
  // currently-mounted query whose result includes that tag (e.g. the scene's
  // own tags list, which is what's on screen right when you'd click Save)
  // loses a piece it depends on - Apollo can't rebuild it without a network
  // round-trip, so the tag chip just vanishes from that list until something
  // else triggers a refetch (a page reload). A surgical field update instead
  // refreshes image_path in place without disturbing the tag's presence
  // anywhere else, and every active query watching that field re-renders
  // with the new value automatically. The image URL itself is already
  // cache-busted server-side (image_path includes ?t=<updated_at>), so
  // fetching the fresh value is all that's needed.
  async function refreshTagImageInCache(apolloClient, tagId) {
    if (!apolloClient) return;
    try {
      const query = `query TagImageGrabberRefreshImage($id: ID!) { findTag(id: $id) { id image_path } }`;
      const data = await csLib.callGQL({ query, variables: { id: tagId } });
      const tag = data && data.findTag;
      if (!tag) return;

      const cacheId = apolloClient.cache.identify({
        __typename: "Tag",
        id: tagId,
      });
      if (!cacheId) return;

      apolloClient.writeFragment({
        id: cacheId,
        fragment: Apollo.gql`
          fragment TagImageGrabberRefreshedImage on Tag {
            id
            image_path
          }
        `,
        data: { __typename: "Tag", id: tag.id, image_path: tag.image_path },
      });
    } catch (err) {
      // best-effort - a stale hover preview isn't worth failing the save over
    }
  }

  // Determines what kind of detail page we're currently on, purely from the
  // URL - not from the TagLink's own `linkType` prop. `linkType` isn't a
  // reliable signal: many callers (SceneDetailPanel, SceneCard, the
  // duplicate checker, the tagger dialog, tag hierarchy chips on the Tag
  // page) omit it and rely on TagLink's own internal default ("scene"),
  // which we can't see from a patch - the default is applied by TagLink's
  // own destructuring, *after* our patch already received the raw props.
  // Keying off the URL instead means the button only ever appears where the
  // corresponding source image element genuinely exists.
  function getPageContext() {
    if (/^\/scenes\/\d+/.test(window.location.pathname)) return "scene";
    if (/^\/images\/\d+/.test(window.location.pathname)) return "image";
    return null;
  }

  // Reuses the already-loaded <img> element rather than re-fetching, same
  // approach as the sceneCoverCropper plugin.
  function findSourceImageUrl(pageContext) {
    if (pageContext === "image") {
      const el = document.querySelector("img.image-image");
      return el ? el.src : null;
    }
    if (pageContext === "scene") {
      const el = document.querySelector("img.scene-cover");
      return el ? el.src : null;
    }
    return null;
  }

  // Cropper.js ships no icons of its own (it's a pure image-manipulation
  // library - crop-box/grid CSS only). Renders a FontAwesome icon
  // definition (from PluginApi.libraries.FontAwesomeSolid, the same icon
  // set the rest of Stash's UI uses) as a plain inline SVG string, since
  // this modal is built with vanilla DOM rather than React and can't use
  // the <FontAwesomeIcon> component directly.
  function faIconMarkup(iconDef) {
    const [width, height, , , pathData] = iconDef.icon;
    return `<svg viewBox="0 0 ${width} ${height}" style="width:1em;height:1em;vertical-align:-0.125em;" fill="currentColor"><path d="${pathData}"></path></svg>`;
  }

  // 3:2 is the default: TagCard images render at object-fit: contain inside
  // a box whose ratio is ~1.33-1.56 depending on the zoom level
  // (ui/v2.5/src/components/Tags/TagCardGrid.tsx's zoomWidths vs
  // index.scss's fixed .tag-card-image heights per zoom class) - 3:2 (1.5)
  // sits in the middle of that range, close enough at every zoom level that
  // it never needs much letterboxing.
  const CROP_ASPECT_RATIOS = [
    { label: "3:2", value: 3 / 2, isDefault: true },
    { label: "16:9", value: 16 / 9 },
    { label: "9:16", value: 9 / 16 },
    { label: "Free", value: NaN },
  ];

  // Renders `srcUrl` into `imgContainer` with a small crop-icon overlay (top
  // right of the image) that activates Cropper.js on click - defaulting to a
  // 4:3 aspect-ratio lock, with buttons to switch to 16:9, 9:16, or Free
  // (unlocked) - plus a single green Save button appended to
  // `actionsContainer`. Save reports the cropped result if cropping was
  // activated, otherwise the original `srcUrl` untouched. A small "x" button
  // next to the aspect-ratio controls exits crop mode and returns to the
  // plain image (crop icon reappears) without discarding the whole
  // flow/closing the modal. Returns { destroy() } so the caller can clean up
  // the Cropper instance on cancel/close/view-switch.
  function buildCropUI(imgContainer, actionsContainer, srcUrl, onSave) {
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.maxWidth = "100%";

    // Toggled between "d-none" and "d-flex ..." (not a plain inline
    // style.display) - Bootstrap's utility classes set `display` with
    // `!important`, which would otherwise permanently win over an inline
    // style and keep this visible regardless of crop state.
    const cropToolbar = document.createElement("div");
    cropToolbar.className = "d-none";
    cropToolbar.style.gap = "6px";
    imgContainer.appendChild(cropToolbar);
    imgContainer.appendChild(wrapper);

    const img = document.createElement("img");
    img.src = srcUrl;
    img.style.display = "block";
    img.style.maxWidth = "100%";
    wrapper.appendChild(img);

    let cropper = null;
    const aspectBtns = [];

    function setActiveAspect(value) {
      aspectBtns.forEach(({ btn, ratio }) => {
        const isMatch =
          (Number.isNaN(ratio) && Number.isNaN(value)) || ratio === value;
        btn.classList.toggle("active", isMatch);
      });
    }

    function enterCropMode() {
      if (cropper) return;
      cropIconBtn.style.display = "none";
      cropToolbar.className =
        "d-flex flex-row justify-content-center align-items-center mb-2";
      const defaultRatio = CROP_ASPECT_RATIOS.find((r) => r.isDefault).value;
      cropper = new Cropper(img, {
        viewMode: 1,
        aspectRatio: defaultRatio,
        movable: false,
        rotatable: false,
        scalable: false,
        zoomable: false,
        zoomOnTouch: false,
        zoomOnWheel: false,
      });
      setActiveAspect(defaultRatio);
    }

    function exitCropMode() {
      if (cropper) {
        cropper.destroy();
        cropper = null;
      }
      cropToolbar.className = "d-none";
      cropIconBtn.style.display = "inline-block";
    }

    const cropIconBtn = document.createElement("button");
    cropIconBtn.type = "button";
    cropIconBtn.className = "btn btn-secondary btn-sm";
    cropIconBtn.title = "Crop";
    cropIconBtn.innerHTML = faIconMarkup(PluginApi.libraries.FontAwesomeSolid.faCrop);
    cropIconBtn.style.position = "absolute";
    cropIconBtn.style.top = "8px";
    cropIconBtn.style.right = "8px";
    cropIconBtn.style.zIndex = "10";
    cropIconBtn.addEventListener("click", enterCropMode);
    wrapper.appendChild(cropIconBtn);

    CROP_ASPECT_RATIOS.forEach(({ label, value }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-outline-light btn-sm";
      btn.innerText = label;
      btn.addEventListener("click", () => {
        if (!cropper) return;
        cropper.setAspectRatio(value);
        setActiveAspect(value);
      });
      aspectBtns.push({ btn, ratio: value });
      cropToolbar.appendChild(btn);
    });

    const exitCropBtn = document.createElement("button");
    exitCropBtn.type = "button";
    exitCropBtn.className = "btn btn-outline-light btn-sm";
    exitCropBtn.title = "Back (discard crop, keep original)";
    exitCropBtn.innerHTML = faIconMarkup(PluginApi.libraries.FontAwesomeSolid.faXmark);
    exitCropBtn.addEventListener("click", exitCropMode);
    cropToolbar.appendChild(exitCropBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-success";
    saveBtn.innerText = "Save";
    saveBtn.addEventListener("click", () => {
      const value = cropper
        ? cropper.getCroppedCanvas().toDataURL("image/jpeg")
        : srcUrl;
      onSave(value);
    });
    actionsContainer.appendChild(saveBtn);

    return {
      destroy() {
        if (cropper) cropper.destroy();
      },
    };
  }

  // Opens a crop dialog seeded from `srcUrl`. Calls onDone(dataUrlOrUrl) once
  // the user hits Save - either a cropped data URL, or the original URL if
  // they never activated cropping.
  function openCropDialog(srcUrl, onDone) {
    const modal = document.createElement("dialog");
    modal.className = "tag-image-grabber-modal bg-dark";
    modal.style.width = "90%";
    modal.style.maxWidth = "600px";
    modal.style.border = "none";
    modal.style.padding = "1rem";
    document.body.appendChild(modal);

    const container = document.createElement("div");
    container.style.width = "100%";
    modal.appendChild(container);

    const btnRow = document.createElement("div");
    btnRow.className =
      "d-flex flex-row justify-content-center align-items-center";
    btnRow.style.gap = "10px";
    btnRow.style.marginTop = "10px";
    modal.appendChild(btnRow);

    function cleanup() {
      cropUI.destroy();
      modal.close();
      modal.remove();
    }

    const cropUI = buildCropUI(container, btnRow, srcUrl, (value) => {
      cleanup();
      onDone(value);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-danger";
    cancelBtn.innerText = "Cancel";
    cancelBtn.addEventListener("click", cleanup);
    btnRow.appendChild(cancelBtn);

    modal.showModal();
  }

  // --- Video/sprite sourcing for the Scene-page picker (Phase 3) ---

  function findVideoElement() {
    return (
      document.querySelector("#VideoJsPlayer_html5_api") ||
      document.querySelector(".video-js video")
    );
  }

  // Draws the current frame of the scene's <video> element into an
  // off-screen canvas at the video's native resolution.
  function captureVideoFrame() {
    const video = findVideoElement();
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  }

  // Same as captureVideoFrame, but first gives the video a brief grace
  // period to have decoded frame data if it doesn't yet. Needed because
  // picking a thumbnail seeks the real player (video.currentTime = ...),
  // which can leave the element in a transient buffering/stalled state
  // (videoWidth/readyState momentarily 0) right after - capturing
  // immediately in that window would otherwise fail even though the video
  // is fine a moment later.
  function captureVideoFrameAsync(timeoutMs) {
    const video = findVideoElement();
    if (!video) return Promise.resolve(null);
    if (video.readyState >= 2 && video.videoWidth) {
      return Promise.resolve(captureVideoFrame());
    }
    return new Promise((resolve) => {
      let settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        video.removeEventListener("loadeddata", finish);
        video.removeEventListener("canplay", finish);
        resolve(captureVideoFrame());
      }
      video.addEventListener("loadeddata", finish);
      video.addEventListener("canplay", finish);
      setTimeout(finish, timeoutMs || 1500);
    });
  }

  // Seeks the scene's <video> element to `targetSeconds` and resolves with a
  // full-res captured frame once the seek settles (or after a 2s safety
  // timeout, in case 'seeked' never fires).
  function seekAndCaptureFrame(targetSeconds) {
    return new Promise((resolve) => {
      const video = findVideoElement();
      if (!video) {
        resolve(null);
        return;
      }

      let settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        video.removeEventListener("seeked", finish);
        resolve(captureVideoFrame());
      }

      video.addEventListener("seeked", finish);
      setTimeout(finish, 2000);
      try {
        video.currentTime = targetSeconds;
      } catch (err) {
        finish();
      }
    });
  }

  function getSceneIdFromUrl() {
    const m = window.location.pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  async function fetchScenePaths(sceneId) {
    const query = `query TagImageGrabberFindScene($id: ID) { findScene(id: $id) { id paths { screenshot vtt sprite } } }`;
    const data = await csLib.callGQL({ query, variables: { id: sceneId } });
    return data && data.findScene ? data.findScene.paths : null;
  }

  // Scene.paths.screenshot (and vtt/sprite) are always non-empty URL strings
  // from GraphQL, whether or not a real cover exists - the server silently
  // falls back to serving a generic placeholder SVG
  // (internal/static/scene/scene.svg via ServeScreenshot) when there's no
  // cover blob, so the field's mere presence doesn't mean there's a real
  // image. That placeholder is served with Content-Type: image/svg+xml,
  // which a real screenshot/webp cover never is - check for that instead of
  // trusting the path string.
  async function checkRealSceneCover(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const contentType = res.headers.get("content-type") || "";
      return contentType.indexOf("svg") === -1;
    } catch (err) {
      return false;
    }
  }

  function parseVttTimestamp(ts) {
    const parts = ts.trim().split(":");
    let h = 0;
    let m = 0;
    let s = 0;
    if (parts.length === 3) {
      h = parseInt(parts[0], 10);
      m = parseInt(parts[1], 10);
      s = parseFloat(parts[2]);
    } else if (parts.length === 2) {
      m = parseInt(parts[0], 10);
      s = parseFloat(parts[1]);
    }
    return h * 3600 + m * 60 + s;
  }

  // Minimal parser for the sprite VTT Stash generates (one `#xywh=x,y,w,h`
  // cue per timestamp range). Deliberately not reusing ui/v2.5's
  // useSpriteInfo hook, which depends on the videojs-vtt.js parser that
  // isn't guaranteed to be available to a standalone plugin - this covers
  // the same cue format with a plain regex, same as the hook itself uses
  // for the `#xywh=...` part.
  function parseSpriteVtt(vttText, vttUrl) {
    const sprites = [];
    const timeRe =
      /(\d+:\d+:\d+\.\d+|\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+|\d+:\d+\.\d+)/;
    const xywhRe = /^([^#]*)#xywh=(\d+),(\d+),(\d+),(\d+)$/i;
    const blocks = vttText.replace(/\r/g, "").split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      const timeLineIdx = lines.findIndex((l) => timeRe.test(l));
      if (timeLineIdx === -1) continue;
      const timeMatch = lines[timeLineIdx].match(timeRe);
      const start = parseVttTimestamp(timeMatch[1]);
      const end = parseVttTimestamp(timeMatch[2]);
      for (const textLine of lines.slice(timeLineIdx + 1)) {
        const m = textLine.match(xywhRe);
        if (!m) continue;
        sprites.push({
          url: new URL(m[1], vttUrl).href,
          start,
          end,
          x: Number(m[2]),
          y: Number(m[3]),
          w: Number(m[4]),
          h: Number(m[5]),
        });
      }
    }
    return sprites;
  }

  // Determines what to open the Scene picker modal on, in order: the
  // already-rendered <img class="scene-cover"> DOM element (only present
  // once the Edit tab has been visited - the Details tab, which is where
  // the tag chips actually live, doesn't render it); else the scene's cover
  // via GraphQL, verified to be a real image and not the server's
  // placeholder-SVG fallback; else the sprite/VTT thumbnail grid, if
  // generated; else a live capture of whatever frame the video is currently
  // on. Returns { kind: "cover", coverUrl, paths } | { kind: "thumbnails",
  // paths } | { kind: "capture", coverUrl, paths } | { kind: "none" }.
  async function resolveSceneImageStart() {
    const domCover = findSourceImageUrl("scene");
    if (domCover) return { kind: "cover", coverUrl: domCover, paths: null };

    const sceneId = getSceneIdFromUrl();
    let paths = null;
    if (sceneId) {
      try {
        paths = await fetchScenePaths(sceneId);
      } catch (err) {
        paths = null;
      }
    }

    if (paths && paths.screenshot && (await checkRealSceneCover(paths.screenshot))) {
      return { kind: "cover", coverUrl: paths.screenshot, paths };
    }

    if (paths && paths.vtt) {
      return { kind: "thumbnails", paths };
    }

    const captured = await captureVideoFrameAsync();
    if (captured) {
      return { kind: "capture", coverUrl: captured, paths };
    }

    return { kind: "none" };
  }

  // Entry point for the Scene tag-chip action: one persistent modal that
  // opens straight into the crop view on the scene's existing cover (same
  // as before), with source buttons that let the user swap what's being
  // cropped - a sprite/VTT thumbnail, or a live-captured video frame -
  // without closing and reopening a separate picker first.
  function openSceneTagImageModal(start, onImageReady) {
    const modal = document.createElement("dialog");
    modal.className = "tag-image-grabber-modal bg-dark";
    modal.style.width = "90%";
    modal.style.maxWidth = "700px";
    modal.style.border = "none";
    modal.style.padding = "1rem";
    document.body.appendChild(modal);

    const sourceRow = document.createElement("div");
    sourceRow.className =
      "d-flex flex-row justify-content-center align-items-center mb-2";
    sourceRow.style.gap = "8px";
    modal.appendChild(sourceRow);

    const contentArea = document.createElement("div");
    contentArea.style.width = "100%";
    modal.appendChild(contentArea);

    // One flex row holds both the view-specific action buttons (Save, etc.
    // - cleared/rebuilt on every view switch) and the persistent Cancel
    // button, so they always render side by side. actionRow uses
    // `display: contents` so clearing its innerHTML doesn't disturb Cancel,
    // which lives as its sibling in the same flex row rather than inside it.
    const bottomRow = document.createElement("div");
    bottomRow.className =
      "d-flex flex-row justify-content-center align-items-center mt-2";
    bottomRow.style.gap = "10px";
    modal.appendChild(bottomRow);

    const actionRow = document.createElement("div");
    actionRow.style.display = "contents";
    bottomRow.appendChild(actionRow);

    // Tracks the active buildCropUI() instance so it can be torn down on
    // cleanup/view-switch, same role the old bare `cropper` variable played.
    let activeCropUI = null;
    // Bumped on every view switch so a still-in-flight async load (e.g.
    // fetching the sprite vtt) can tell it's stale and not repaint over
    // whatever view the user has since switched to.
    let viewToken = 0;
    // Cached findScene GraphQL result, shared across the cover-recheck and
    // thumbnails views so switching between them doesn't refetch every time.
    let cachedPaths = start.paths || null;

    function cleanup() {
      if (activeCropUI) activeCropUI.destroy();
      modal.close();
      modal.remove();
    }

    function resetContent() {
      viewToken++;
      if (activeCropUI) {
        activeCropUI.destroy();
        activeCropUI = null;
      }
      contentArea.innerHTML = "";
      actionRow.innerHTML = "";
      return viewToken;
    }

    function showCropView(srcUrl) {
      resetContent();
      activeCropUI = buildCropUI(contentArea, actionRow, srcUrl, (value) => {
        cleanup();
        onImageReady(value);
      });
    }

    // Thumbnails always resolve to a full-resolution frame: the sprite tile
    // itself is only used to browse/preview at a glance (it's capped at
    // ~160px), then clicking it seeks the real player there and captures a
    // proper frame - never the low-res tile itself.
    async function selectSpriteTile(sprite) {
      const dataUrl = await seekAndCaptureFrame(sprite.start);
      if (!dataUrl) {
        window.alert("Tag Image Grabber: couldn't seek/capture the video frame.");
        return;
      }
      showCropView(dataUrl);
    }

    async function showThumbnailView() {
      const token = resetContent();

      const status = document.createElement("p");
      status.className = "text-white text-center";
      status.innerText = "Loading thumbnails...";
      contentArea.appendChild(status);

      const sceneId = getSceneIdFromUrl();
      if (!sceneId) {
        status.innerText = "Couldn't determine the current scene.";
        return;
      }

      if (!cachedPaths) {
        try {
          cachedPaths = await fetchScenePaths(sceneId);
        } catch (err) {
          cachedPaths = null;
        }
      }
      if (token !== viewToken) return;
      const paths = cachedPaths;
      if (!paths || !paths.vtt) {
        status.innerText =
          "No sprite/vtt generated yet for this scene. Run Generate with sprites enabled first.";
        return;
      }

      let sprites;
      try {
        const res = await fetch(paths.vtt);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        sprites = parseSpriteVtt(text, paths.vtt);
      } catch (err) {
        if (token !== viewToken) return;
        status.innerText = `Failed to load thumbnails (${err}).`;
        return;
      }
      if (token !== viewToken) return;

      if (!sprites.length) {
        status.innerText =
          "No thumbnails found (sprite may not be generated yet).";
        return;
      }

      status.remove();
      const grid = document.createElement("div");
      grid.style.display = "flex";
      grid.style.flexWrap = "wrap";
      grid.style.gap = "4px";
      grid.style.maxHeight = "50vh";
      grid.style.overflowY = "auto";
      contentArea.appendChild(grid);

      sprites.forEach((sprite) => {
        const tile = document.createElement("div");
        tile.style.width = `${sprite.w}px`;
        tile.style.height = `${sprite.h}px`;
        tile.style.backgroundImage = `url(${sprite.url})`;
        tile.style.backgroundPosition = `-${sprite.x}px -${sprite.y}px`;
        tile.style.backgroundRepeat = "no-repeat";
        tile.style.cursor = "pointer";
        tile.title = `~${Math.round(sprite.start)}s`;
        tile.addEventListener("click", () => selectSpriteTile(sprite));
        grid.appendChild(tile);
      });
    }

    function showCaptureError() {
      window.alert(
        "Tag Image Grabber: couldn't find the scene's video element to capture from."
      );
    }

    // Highlights whichever source button produced what's currently on
    // screen. Bootstrap's `.active` class inverts an outline button's
    // colors, giving a clear "this one's selected" look.
    function setActiveSource(key) {
      coverSrcBtn.classList.toggle("active", key === "cover");
      thumbsSrcBtn.classList.toggle("active", key === "thumbnails");
      captureSrcBtn.classList.toggle("active", key === "capture");
    }

    const coverSrcBtn = document.createElement("button");
    coverSrcBtn.className = "btn btn-outline-light btn-sm";
    coverSrcBtn.innerText = "Scene cover";
    coverSrcBtn.addEventListener("click", async () => {
      const domCover = findSourceImageUrl("scene");
      if (domCover) {
        setActiveSource("cover");
        showCropView(domCover);
        return;
      }

      const sceneId = getSceneIdFromUrl();
      if (!sceneId) {
        window.alert("Tag Image Grabber: couldn't determine the current scene.");
        return;
      }
      if (!cachedPaths) {
        try {
          cachedPaths = await fetchScenePaths(sceneId);
        } catch (err) {
          cachedPaths = null;
        }
      }
      if (
        cachedPaths &&
        cachedPaths.screenshot &&
        (await checkRealSceneCover(cachedPaths.screenshot))
      ) {
        setActiveSource("cover");
        showCropView(cachedPaths.screenshot);
      } else {
        window.alert(
          "Tag Image Grabber: this scene has no cover image generated yet."
        );
      }
    });
    sourceRow.appendChild(coverSrcBtn);

    const thumbsSrcBtn = document.createElement("button");
    thumbsSrcBtn.className = "btn btn-outline-light btn-sm";
    thumbsSrcBtn.innerText = "Thumbnails";
    thumbsSrcBtn.addEventListener("click", () => {
      setActiveSource("thumbnails");
      showThumbnailView();
    });
    sourceRow.appendChild(thumbsSrcBtn);

    const captureSrcBtn = document.createElement("button");
    captureSrcBtn.className = "btn btn-outline-light btn-sm";
    captureSrcBtn.innerText = "Current Frame";
    captureSrcBtn.addEventListener("click", async () => {
      const dataUrl = await captureVideoFrameAsync();
      if (!dataUrl) {
        showCaptureError();
        return;
      }
      setActiveSource("capture");
      showCropView(dataUrl);
    });
    sourceRow.appendChild(captureSrcBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-danger";
    cancelBtn.innerText = "Cancel";
    cancelBtn.addEventListener("click", cleanup);
    bottomRow.appendChild(cancelBtn);

    if (start.kind === "cover" || start.kind === "capture") {
      setActiveSource(start.kind);
      showCropView(start.coverUrl);
    } else {
      setActiveSource("thumbnails");
      showThumbnailView();
    }
    modal.showModal();
  }

  function GrabTagImageButton(props) {
    const { tag, pageContext } = props;
    const [busy, setBusy] = React.useState(false);
    const apolloClient = Apollo.useApolloClient();

    const onImageReady = async (imageValue) => {
      setBusy(true);
      try {
        await saveTagImage(tag.id, imageValue);
        await refreshTagImageInCache(apolloClient, tag.id);
      } catch (err) {
        window.alert(`Tag Image Grabber: failed to save tag image (${err})`);
      } finally {
        setBusy(false);
      }
    };

    const onClick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (pageContext === "image") {
        const srcUrl = findSourceImageUrl("image");
        if (!srcUrl) {
          window.alert(
            "Tag Image Grabber: couldn't find a source image on this page."
          );
          return;
        }
        openCropDialog(srcUrl, onImageReady);
        return;
      }

      if (pageContext === "scene") {
        setBusy(true);
        let start;
        try {
          start = await resolveSceneImageStart();
        } finally {
          setBusy(false);
        }
        if (start.kind === "none") {
          window.alert(
            "Tag Image Grabber: no image source available for this scene (no cover, no thumbnails generated, and couldn't read the video player)."
          );
          return;
        }
        openSceneTagImageModal(start, onImageReady);
      }
    };

    return React.createElement(
      "button",
      {
        type: "button",
        className: "tag-image-grabber-btn btn btn-secondary btn-sm",
        title:
          pageContext === "image"
            ? "Use this image for this tag"
            : "Grab an image for this tag from this scene",
        style: { marginLeft: "4px", padding: "0 4px", lineHeight: "1.4" },
        disabled: busy,
        onClick,
      },
      busy ? "…" : "📷"
    );
  }

  function setupTagImageGrabber() {
    PluginApi.patch.instead("TagLink", function (props, _, originalComponent) {
      const original = originalComponent(props);
      const pageContext = getPageContext();
      if (!pageContext || !props.tag || !props.tag.id) {
        return original;
      }
      return React.createElement(
        React.Fragment,
        null,
        original,
        React.createElement(GrabTagImageButton, {
          tag: props.tag,
          pageContext: pageContext,
        })
      );
    });
  }

  setupTagImageGrabber();
})();
