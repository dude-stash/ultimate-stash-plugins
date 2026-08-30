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
// thumbnail sheet (which seeks and captures a full-res frame), or a live
// capture of whatever frame the video
// is currently paused on. Deliberately not using scene marker screenshots as
// a source - a marker's screenshot isn't necessarily the best representative
// frame for a tag, so this only ever offers full manual control over which
// frame gets used. Performer detail pages and a reverse picker from a Tag's
// linked images, scenes, and performers are also supported. The player-toolbar
// entry point for tags not yet on the scene remains deferred.
(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM;
  const Apollo = PluginApi.libraries.Apollo;
  const baseURL =
    document.querySelector("base")?.getAttribute("href") || "/";
  const normalizedBaseURL = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  const graphqlURL = new URL(
    "graphql",
    new URL(normalizedBaseURL, window.location.origin)
  ).href;

  const TAG_UPDATE_MUTATION = `mutation TagImageGrabberUpdate($input: TagUpdateInput!) { tagUpdate(input: $input) { id image_path } }`;

  async function callGQL(query, variables) {
    const response = await fetch(graphqlURL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`GraphQL request failed with HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.errors && result.errors.length) {
      throw new Error(result.errors.map((error) => error.message).join("; "));
    }
    if (!result.data) {
      throw new Error("GraphQL response did not include data");
    }
    return result.data;
  }

  async function saveTagImage(tagId, imageValue) {
    const variables = { input: { id: tagId, image: imageValue } };
    const data = await callGQL(TAG_UPDATE_MUTATION, variables);
    if (!data.tagUpdate) throw new Error("Tag update returned no tag");
    return data.tagUpdate;
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
  function refreshTagImageInCache(apolloClient, tag) {
    if (!apolloClient) return;
    try {
      if (!tag) return;

      const cacheId = apolloClient.cache.identify({
        __typename: "Tag",
        id: tag.id,
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
    const path = getAppPath();
    if (/^\/scenes\/\d+(?:\/|$)/.test(path)) return "scene";
    if (/^\/images\/\d+(?:\/|$)/.test(path)) return "image";
    if (/^\/performers\/\d+(?:\/|$)/.test(path)) return "performer";
    return null;
  }

  function getAppPath() {
    const basePath = new URL(baseURL, window.location.origin).pathname.replace(
      /\/$/,
      ""
    );
    const path = window.location.pathname;
    return (
      basePath &&
      (path === basePath || path.startsWith(`${basePath}/`))
    )
      ? path.slice(basePath.length) || "/"
      : path;
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
    if (pageContext === "performer") {
      const el = document.querySelector("#performer-page img.performer");
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

  // 1:1 is the default. TagCard images render at object-fit: contain inside
  // a box whose ratio is ~1.33-1.56 depending on the zoom level
  // (ui/v2.5/src/components/Tags/TagCardGrid.tsx's zoomWidths vs
  // index.scss's fixed .tag-card-image heights per zoom class) - 4:3 (1.333)
  // matches exactly at the two larger zoom levels and is closest on average.
  // 1:1 is offered alongside it since 4:3 and 16:9 read as too similar a
  // choice on their own.
  const CROP_ASPECT_RATIOS = [
    { label: "1:1", value: 1, isDefault: true },
    { label: "4:3", value: 4 / 3 },
    { label: "16:9", value: 16 / 9 },
    { label: "9:16", value: 9 / 16 },
    { label: "Free", value: NaN },
  ];

  // Draws a centered square crop of an already-loaded <img> element.
  // Returns { dataUrl, rect } - `rect` (the exact region used) is later
  // handed to Cropper.js's setData() so entering crop mode starts from the
  // same square instead of a fresh auto-centered guess, making it feel like
  // refining what's already shown rather than starting over.
  function squareCropOf(imgEl) {
    const side = Math.min(imgEl.naturalWidth, imgEl.naturalHeight);
    const rect = {
      x: (imgEl.naturalWidth - side) / 2,
      y: (imgEl.naturalHeight - side) / 2,
      width: side,
      height: side,
    };
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(
      imgEl,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      side,
      side
    );
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.92), rect };
  }

  function fullImageDataOf(imgEl) {
    const canvas = document.createElement("canvas");
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(imgEl, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.92);
  }

  // Renders `srcUrl` into `imgContainer` as a plain image (no crop UI
  // visible yet) - except the image shown/saved by default is already a
  // centered 1:1 crop of the original, computed once it's actually loaded
  // (see applySquarePreview() below), not the full original. Clicking the
  // crop-icon
  // overlay switches to the original full image with interactive Cropper.js
  // controls (seeded to that same square, so it reads as "adjust this" not
  // "start over") and a ratio toolbar: 1:1 (default), 4:3, 16:9, 9:16, Free,
  // plus "Full" - which discards cropping entirely and reverts to the full,
  // uncropped original (also reachable at any time, not just on entry). A
  // single green Save button is appended to `actionsContainer`, reporting
  // the cropped result while Cropper is active, otherwise whatever's
  // currently displayed (the square preview, or the full original after
  // "Full"). Returns { destroy() } so the caller can clean up the Cropper
  // instance on cancel/close/view-switch.
  function buildCropUI(imgContainer, actionsContainer, srcUrl, onSave) {
    // `wrapper` is inline-block so it only takes up as much width as the
    // image needs (important once the image is a narrower square crop, not
    // always a near-full-width landscape) - centering it needs the parent's
    // text-align, not just wrapper's own styles.
    imgContainer.style.textAlign = "center";

    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.maxWidth = "100%";

    // Toggled between "d-none" and "d-flex ..." (not a plain inline
    // style.display) - Bootstrap's utility classes set `display` with
    // `!important`, which would otherwise permanently win over an inline
    // style and keep this visible regardless of crop state. Appended after
    // `wrapper` so it renders below the image, still above the Save/Cancel
    // row in `actionsContainer`.
    const cropToolbar = document.createElement("div");
    cropToolbar.className = "d-none";
    cropToolbar.style.gap = "6px";
    imgContainer.appendChild(wrapper);
    imgContainer.appendChild(cropToolbar);

    // Hidden until either the square preview is applied or crop mode is
    // entered - otherwise the full original flashes on screen first and
    // then visibly jumps to the (usually smaller/differently-shaped) square
    // crop a moment later.
    const img = document.createElement("img");
    img.src = srcUrl;
    img.style.display = "block";
    img.style.maxWidth = "100%";
    img.style.visibility = "hidden";
    wrapper.appendChild(img);

    let cropper = null;
    // What Save reports when Cropper isn't active - starts as the original,
    // gets replaced with the square preview once it's ready (or with the
    // full original again after "Full" is picked).
    let currentValue = srcUrl;
    let originalDataUrl = null;
    // The centered-square region applySquarePreview() used, hitched onto
    // Cropper's first crop box via setData() so it starts where the preview
    // already was. Null until the image has actually loaded.
    let squareRect = null;
    const aspectBtns = [];

    function setActiveAspect(value) {
      aspectBtns.forEach(({ btn, ratio }) => {
        const isMatch =
          (Number.isNaN(ratio) && Number.isNaN(value)) || ratio === value;
        btn.classList.toggle("active", isMatch);
      });
      fullBtn.classList.remove("active");
    }

    function setActiveFull() {
      aspectBtns.forEach(({ btn }) => btn.classList.remove("active"));
      fullBtn.classList.add("active");
    }

    function enterCropMode() {
      if (cropper || !originalDataUrl) return;
      cropIconBtn.style.display = "none";
      cropToolbar.className =
        "d-flex flex-row justify-content-center align-items-center mb-2";
      // Cropping always operates on the original full image, regardless of
      // what's currently displayed (the square preview, or "Full"'s
      // original) - otherwise adjusting couldn't recover anything the
      // square preview's auto-crop had cut off.
      img.src = srcUrl;
      img.style.visibility = "visible";
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
        ready() {
          if (squareRect) cropper.setData(squareRect);
        },
      });
      setActiveAspect(defaultRatio);
    }

    // "Full" - no crop at all. Reachable both to skip cropping on first
    // entry and to back out of an in-progress crop.
    function selectFull() {
      if (!originalDataUrl) return;
      if (cropper) {
        cropper.destroy();
        cropper = null;
      }
      cropToolbar.className = "d-none";
      cropIconBtn.style.display = "inline-block";
      img.src = originalDataUrl;
      img.style.visibility = "visible";
      currentValue = originalDataUrl;
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
    cropIconBtn.disabled = true;
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

    const fullBtn = document.createElement("button");
    fullBtn.type = "button";
    fullBtn.className = "btn btn-outline-light btn-sm";
    fullBtn.innerText = "Full";
    fullBtn.title = "No crop - use the entire image";
    fullBtn.addEventListener("click", () => {
      selectFull();
      setActiveFull();
    });
    cropToolbar.appendChild(fullBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-success";
    saveBtn.innerText = "Save";
    saveBtn.disabled = true;
    saveBtn.addEventListener("click", () => {
      const value = cropper
        ? cropper.getCroppedCanvas().toDataURL("image/jpeg")
        : currentValue;
      onSave(value);
    });
    actionsContainer.appendChild(saveBtn);

    // Computed from the same <img> that's already loading `srcUrl` above,
    // once it's actually loaded - not a second Image() reloading the same
    // source, which for a large data: URI (e.g. a full-res captured video
    // frame) meant decoding the same multi-MB string twice at once.
    function applySquarePreview() {
      if (cropper) return; // already in crop mode with the full image
      if (!img.naturalWidth) {
        // Failed to load / no dimensions available - nothing to crop, but
        // still reveal whatever's there rather than leaving it hidden.
        img.style.visibility = "visible";
        return;
      }
      try {
        originalDataUrl = fullImageDataOf(img);
        const { dataUrl, rect } = squareCropOf(img);
        squareRect = rect;
        currentValue = dataUrl;
        img.src = dataUrl;
        img.style.visibility = "visible";
        cropIconBtn.disabled = false;
        saveBtn.disabled = false;
      } catch (err) {
        img.style.visibility = "visible";
        saveBtn.disabled = true;
        window.alert(`Tag Image Grabber: failed to read image (${err})`);
      }
    }

    if (img.complete && img.naturalWidth) {
      applySquarePreview();
    } else {
      img.addEventListener("load", applySquarePreview, { once: true });
    }
    img.addEventListener(
      "error",
      () => {
        img.style.visibility = "visible";
        saveBtn.disabled = true;
        cropIconBtn.disabled = true;
      },
      { once: true }
    );

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
    modal.setAttribute("aria-label", "Crop tag image");
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

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      cropUI.destroy();
      if (modal.open) modal.close();
      modal.remove();
    }

    const cropUI = buildCropUI(container, btnRow, srcUrl, (value) => {
      cleanup();
      onDone(value);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-danger";
    cancelBtn.innerText = "Cancel";
    cancelBtn.addEventListener("click", cleanup);
    btnRow.appendChild(cancelBtn);

    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      cleanup();
    });
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

  // Resolves once `video` fires `eventName`, or after `timeoutMs` regardless
  // (some browsers/streams don't reliably fire seeked/loadeddata/canplay in
  // every situation, so this never hangs forever).
  function waitForVideoEvent(video, eventName, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        video.removeEventListener(eventName, finish);
        resolve();
      }
      video.addEventListener(eventName, finish);
      setTimeout(finish, timeoutMs);
    });
  }

  // Same as captureVideoFrame, but first gives the video a brief grace
  // period to have decoded frame data if it doesn't yet. Needed because
  // picking a thumbnail seeks the real player (video.currentTime = ...),
  // which can leave the element in a transient buffering/stalled state
  // (videoWidth/readyState momentarily 0) right after - capturing
  // immediately in that window would otherwise fail even though the video
  // is fine a moment later.
  async function captureVideoFrameAsync(timeoutMs) {
    const video = findVideoElement();
    if (!video) return null;
    if (video.readyState >= 2 && video.videoWidth) {
      return captureVideoFrame();
    }
    await Promise.race([
      waitForVideoEvent(video, "loadeddata", timeoutMs || 1500),
      waitForVideoEvent(video, "canplay", timeoutMs || 1500),
    ]);
    return captureVideoFrame();
  }

  // Seeks the scene's <video> element to `targetSeconds`, captures a full-res
  // frame once the seek settles (or after a 2s safety timeout, in case
  // 'seeked' never fires), then seeks back to wherever the viewer actually
  // was. Picking a thumbnail to grab an image for a tag shouldn't leave
  // their actual playback position changed - the seek is only a means to
  // get a decoded frame at that timestamp, not something they asked for.
  async function seekAndCaptureFrame(targetSeconds) {
    const video = findVideoElement();
    if (!video) return null;

    const originalTime = video.currentTime;
    const wasPaused = video.paused;
    if (!wasPaused) video.pause();
    try {
      video.currentTime = targetSeconds;
    } catch (err) {
      return null;
    }
    await waitForVideoEvent(video, "seeked", 2000);
    const dataUrl = captureVideoFrame();

    try {
      video.currentTime = originalTime;
    } catch (err) {
      // best effort - worth keeping the captured frame either way
    }
    await waitForVideoEvent(video, "seeked", 1500);
    if (!wasPaused) {
      try {
        await video.play();
      } catch (err) {
        // Browser playback policies may prevent restoring playback.
      }
    }

    return dataUrl;
  }

  function getSceneIdFromUrl() {
    const m = getAppPath().match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  async function fetchScenePaths(sceneId) {
    const query = `query TagImageGrabberFindScene($id: ID) { findScene(id: $id) { id paths { screenshot vtt sprite } } }`;
    const data = await callGQL(query, { id: sceneId });
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
    modal.setAttribute("aria-label", "Choose a scene image for this tag");
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

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      viewToken++;
      if (activeCropUI) activeCropUI.destroy();
      if (modal.open) modal.close();
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
      const token = ++viewToken;
      const dataUrl = await seekAndCaptureFrame(sprite.start);
      if (token !== viewToken || cleanedUp) return;
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
    coverSrcBtn.type = "button";
    coverSrcBtn.className = "btn btn-outline-light btn-sm";
    coverSrcBtn.innerText = "Scene cover";
    coverSrcBtn.addEventListener("click", async () => {
      const token = ++viewToken;
      const domCover = findSourceImageUrl("scene");
      if (domCover) {
        if (token !== viewToken) return;
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
      if (token !== viewToken || cleanedUp) return;
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
    thumbsSrcBtn.type = "button";
    thumbsSrcBtn.className = "btn btn-outline-light btn-sm";
    thumbsSrcBtn.innerText = "Thumbnails";
    thumbsSrcBtn.addEventListener("click", () => {
      setActiveSource("thumbnails");
      showThumbnailView();
    });
    sourceRow.appendChild(thumbsSrcBtn);

    const captureSrcBtn = document.createElement("button");
    captureSrcBtn.type = "button";
    captureSrcBtn.className = "btn btn-outline-light btn-sm";
    captureSrcBtn.innerText = "Current Frame";
    captureSrcBtn.addEventListener("click", async () => {
      const token = ++viewToken;
      const dataUrl = await captureVideoFrameAsync();
      if (token !== viewToken || cleanedUp) return;
      if (!dataUrl) {
        showCaptureError();
        return;
      }
      setActiveSource("capture");
      showCropView(dataUrl);
    });
    sourceRow.appendChild(captureSrcBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
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
    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      cleanup();
    });
    modal.showModal();
  }

  // --- Reverse picker from a Tag page (Phase 4) ---

  const LINKED_SOURCE_QUERIES = {
    images: `query TagImageGrabberLinkedImages($filter: FindFilterType, $tags: HierarchicalMultiCriterionInput!) {
      findImages(filter: $filter, image_filter: { tags: $tags }) {
        count
        images { id title paths { thumbnail image } }
      }
    }`,
    scenes: `query TagImageGrabberLinkedScenes($filter: FindFilterType, $tags: HierarchicalMultiCriterionInput!) {
      findScenes(filter: $filter, scene_filter: { tags: $tags }) {
        count
        scenes { id title paths { screenshot vtt stream } }
      }
    }`,
    performers: `query TagImageGrabberLinkedPerformers($filter: FindFilterType, $tags: HierarchicalMultiCriterionInput!) {
      findPerformers(filter: $filter, performer_filter: { tags: $tags }) {
        count
        performers { id name image_path }
      }
    }`,
  };

  function captureVideoElement(video) {
    if (!video || !video.videoWidth || video.readyState < 2) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.92);
    } catch (err) {
      return null;
    }
  }

  async function seekAndCaptureVideo(video, seconds) {
    if (!video) return null;
    if (video.readyState < 1) {
      await Promise.race([
        waitForVideoEvent(video, "loadedmetadata", 5000),
        waitForVideoEvent(video, "error", 5000),
      ]);
    }
    if (!Number.isFinite(video.duration)) return null;
    try {
      video.currentTime = Math.min(seconds, Math.max(0, video.duration - 0.05));
    } catch (err) {
      return null;
    }
    await waitForVideoEvent(video, "seeked", 5000);
    return captureVideoElement(video);
  }

  function openLinkedSceneModal(scene, onImageReady, onBack, onCancel) {
    const modal = document.createElement("dialog");
    modal.className = "tag-image-grabber-modal bg-dark text-white";
    modal.style.width = "90%";
    modal.style.maxWidth = "800px";
    modal.style.border = "none";
    modal.style.padding = "1rem";
    modal.setAttribute(
      "aria-label",
      `Choose an image from ${scene.title || `scene ${scene.id}`}`
    );
    document.body.appendChild(modal);

    const title = document.createElement("h5");
    title.className = "text-center";
    title.innerText = scene.title || `Scene ${scene.id}`;
    modal.appendChild(title);

    const sourceRow = document.createElement("div");
    sourceRow.className =
      "d-flex flex-row flex-wrap justify-content-center align-items-center mb-2";
    sourceRow.style.gap = "8px";
    modal.appendChild(sourceRow);

    const contentArea = document.createElement("div");
    contentArea.style.width = "100%";
    modal.appendChild(contentArea);

    const actionRow = document.createElement("div");
    actionRow.className =
      "d-flex flex-row justify-content-center align-items-center mt-2";
    actionRow.style.gap = "10px";
    modal.appendChild(actionRow);

    let cropUI = null;
    let video = null;
    let viewToken = 0;
    let cleanedUp = false;

    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      viewToken++;
      if (cropUI) cropUI.destroy();
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      if (modal.open) modal.close();
      modal.remove();
    }

    function resetView() {
      viewToken++;
      if (cropUI) {
        cropUI.destroy();
        cropUI = null;
      }
      contentArea.innerHTML = "";
      actionRow.innerHTML = "";
      return viewToken;
    }

    function showCrop(srcUrl) {
      resetView();
      cropUI = buildCropUI(contentArea, actionRow, srcUrl, (value) => {
        cleanup();
        onImageReady(value);
      });
      addCancelButton();
    }

    function addCancelButton() {
      if (onBack) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-secondary";
        back.innerText = "Back to Scenes";
        back.addEventListener("click", () => {
          cleanup();
          onBack();
        });
        actionRow.appendChild(back);
      }

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-danger";
      cancel.innerText = "Cancel";
      cancel.addEventListener("click", () => {
        cleanup();
        if (onCancel) onCancel();
      });
      actionRow.appendChild(cancel);
    }

    function getVideo() {
      if (video) return video;
      video = document.createElement("video");
      video.preload = "metadata";
      video.playsInline = true;
      video.src = scene.paths.stream;
      return video;
    }

    async function showCover() {
      const token = resetView();
      const status = document.createElement("p");
      status.className = "text-center";
      status.innerText = "Loading scene cover...";
      contentArea.appendChild(status);
      if (
        !scene.paths.screenshot ||
        !(await checkRealSceneCover(scene.paths.screenshot))
      ) {
        if (token === viewToken) {
          status.innerText = "This scene has no generated cover image.";
          addCancelButton();
        }
        return false;
      }
      if (token !== viewToken || cleanedUp) return false;
      showCrop(scene.paths.screenshot);
      return true;
    }

    async function showThumbnails() {
      const token = resetView();
      const status = document.createElement("p");
      status.className = "text-center";
      status.innerText = "Loading thumbnails...";
      contentArea.appendChild(status);
      if (!scene.paths.vtt || !scene.paths.stream) {
        status.innerText = "This scene has no generated thumbnails.";
        addCancelButton();
        return;
      }
      let sprites;
      try {
        const response = await fetch(scene.paths.vtt, {
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        sprites = parseSpriteVtt(await response.text(), scene.paths.vtt);
      } catch (err) {
        if (token === viewToken) {
          status.innerText = `Failed to load thumbnails (${err}).`;
          addCancelButton();
        }
        return;
      }
      if (token !== viewToken || cleanedUp) return;
      status.remove();
      const grid = document.createElement("div");
      grid.style.display = "flex";
      grid.style.flexWrap = "wrap";
      grid.style.justifyContent = "center";
      grid.style.gap = "4px";
      grid.style.maxHeight = "55vh";
      grid.style.overflowY = "auto";
      contentArea.appendChild(grid);
      sprites.forEach((sprite) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "btn p-0";
        tile.style.width = `${sprite.w}px`;
        tile.style.height = `${sprite.h}px`;
        tile.style.backgroundImage = `url(${sprite.url})`;
        tile.style.backgroundPosition = `-${sprite.x}px -${sprite.y}px`;
        tile.style.backgroundRepeat = "no-repeat";
        tile.title = `Capture frame at ${Math.round(sprite.start)} seconds`;
        tile.addEventListener("click", async () => {
          const captureToken = ++viewToken;
          tile.disabled = true;
          const dataUrl = await seekAndCaptureVideo(getVideo(), sprite.start);
          if (captureToken !== viewToken || cleanedUp) return;
          if (!dataUrl) {
            tile.disabled = false;
            window.alert(
              "Tag Image Grabber: couldn't capture this scene frame."
            );
            return;
          }
          showCrop(dataUrl);
        });
        grid.appendChild(tile);
      });
      addCancelButton();
    }

    function showVideo() {
      resetView();
      if (!scene.paths.stream) {
        const status = document.createElement("p");
        status.className = "text-center";
        status.innerText = "This scene has no playable stream.";
        contentArea.appendChild(status);
        addCancelButton();
        return;
      }
      const player = getVideo();
      player.controls = true;
      player.style.display = "block";
      player.style.width = "100%";
      player.style.maxHeight = "60vh";
      contentArea.appendChild(player);

      const capture = document.createElement("button");
      capture.type = "button";
      capture.className = "btn btn-success";
      capture.innerText = "Capture Current Frame";
      capture.addEventListener("click", () => {
        const dataUrl = captureVideoElement(player);
        if (!dataUrl) {
          window.alert(
            "Tag Image Grabber: wait for the video frame to load first."
          );
          return;
        }
        showCrop(dataUrl);
      });
      actionRow.appendChild(capture);
      addCancelButton();
    }

    const coverButton = document.createElement("button");
    coverButton.type = "button";
    coverButton.className = "btn btn-outline-light btn-sm";
    coverButton.innerText = "Scene cover";
    coverButton.addEventListener("click", showCover);
    sourceRow.appendChild(coverButton);

    const thumbnailButton = document.createElement("button");
    thumbnailButton.type = "button";
    thumbnailButton.className = "btn btn-outline-light btn-sm";
    thumbnailButton.innerText = "Thumbnails";
    thumbnailButton.addEventListener("click", showThumbnails);
    sourceRow.appendChild(thumbnailButton);

    const videoButton = document.createElement("button");
    videoButton.type = "button";
    videoButton.className = "btn btn-outline-light btn-sm";
    videoButton.innerText = "Video frame";
    videoButton.addEventListener("click", showVideo);
    sourceRow.appendChild(videoButton);

    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      cleanup();
      if (onCancel) onCancel();
    });
    modal.showModal();
    const initialCoverToken = viewToken + 1;
    showCover().then((hasCover) => {
      if (viewToken !== initialCoverToken) return;
      if (!hasCover && !cleanedUp && scene.paths.vtt) showThumbnails();
      else if (!hasCover && !cleanedUp) showVideo();
    });
  }

  function openLinkedContentPicker(tag, onImageReady) {
    const modal = document.createElement("dialog");
    modal.className = "tag-image-grabber-modal bg-dark text-white";
    modal.style.width = "94%";
    modal.style.maxWidth = "1000px";
    modal.style.border = "none";
    modal.style.padding = "1rem";
    modal.setAttribute(
      "aria-label",
      `Choose linked content for ${tag.name}`
    );
    document.body.appendChild(modal);

    const heading = document.createElement("h4");
    heading.className = "text-center";
    heading.innerText = `Choose an image for ${tag.name}`;
    modal.appendChild(heading);

    const controls = document.createElement("div");
    controls.className =
      "d-flex flex-row flex-wrap justify-content-center align-items-center mb-3";
    controls.style.gap = "8px";
    modal.appendChild(controls);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "form-control";
    search.placeholder = "Search linked content";
    search.setAttribute("aria-label", "Search linked content");
    search.style.maxWidth = "280px";
    controls.appendChild(search);

    const tabs = document.createElement("div");
    tabs.className = "btn-group";
    controls.appendChild(tabs);

    const content = document.createElement("div");
    content.style.minHeight = "240px";
    modal.appendChild(content);

    const footer = document.createElement("div");
    footer.className =
      "d-flex flex-row justify-content-center align-items-center mt-3";
    footer.style.gap = "8px";
    modal.appendChild(footer);

    let sourceType = "scenes";
    let page = 1;
    let requestToken = 0;
    let cleanedUp = false;
    let searchTimer = null;
    const perPage = 24;
    const tabButtons = {};

    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      requestToken++;
      window.clearTimeout(searchTimer);
      if (modal.open) modal.close();
      modal.remove();
    }

    function selectSource(source) {
      if (sourceType === "scenes") {
        modal.close();
        openLinkedSceneModal(
          source,
          (imageValue) => {
            cleanup();
            onImageReady(imageValue);
          },
          () => {
            if (cleanedUp) return;
            modal.showModal();
            search.focus();
          },
          cleanup
        );
        return;
      }
      cleanup();
      const srcUrl =
        sourceType === "images" ? source.paths.image : source.image_path;
      openCropDialog(srcUrl, onImageReady);
    }

    function renderFooter(count) {
      footer.innerHTML = "";
      const previous = document.createElement("button");
      previous.type = "button";
      previous.className = "btn btn-secondary";
      previous.innerText = "Previous";
      previous.disabled = page <= 1;
      previous.addEventListener("click", () => {
        page--;
        loadSources();
      });
      footer.appendChild(previous);

      const status = document.createElement("span");
      status.innerText = `Page ${page} of ${Math.max(
        1,
        Math.ceil(count / perPage)
      )}`;
      footer.appendChild(status);

      const next = document.createElement("button");
      next.type = "button";
      next.className = "btn btn-secondary";
      next.innerText = "Next";
      next.disabled = page * perPage >= count;
      next.addEventListener("click", () => {
        page++;
        loadSources();
      });
      footer.appendChild(next);

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-danger";
      cancel.innerText = "Cancel";
      cancel.addEventListener("click", cleanup);
      footer.appendChild(cancel);
    }

    function renderSources(items, count) {
      content.innerHTML = "";
      const usable =
        sourceType === "performers"
          ? items.filter(
              (item) =>
                item.image_path && !item.image_path.includes("?default=true")
            )
          : sourceType === "images"
            ? items.filter((item) => item.paths && item.paths.image)
            : items;
      if (!usable.length) {
        const empty = document.createElement("p");
        empty.className = "text-center";
        empty.innerText = "No usable linked content found.";
        content.appendChild(empty);
        renderFooter(count);
        return;
      }
      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns =
        "repeat(auto-fill, minmax(140px, 1fr))";
      grid.style.gap = "10px";
      grid.style.maxHeight = "62vh";
      grid.style.overflowY = "auto";
      content.appendChild(grid);
      usable.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-secondary p-2";
        button.style.minWidth = "0";
        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        image.style.width = "100%";
        image.style.height = "130px";
        image.style.objectFit = "contain";
        image.src =
          sourceType === "images"
            ? item.paths.thumbnail || item.paths.image
            : sourceType === "scenes"
              ? item.paths.screenshot
              : item.image_path;
        button.appendChild(image);
        const label = document.createElement("div");
        label.className = "text-truncate mt-1";
        label.innerText = item.title || item.name || `${sourceType} ${item.id}`;
        button.appendChild(label);
        button.addEventListener("click", () => selectSource(item));
        grid.appendChild(button);
      });
      renderFooter(count);
    }

    async function loadSources() {
      const token = ++requestToken;
      content.innerHTML = "";
      footer.innerHTML = "";
      const loading = document.createElement("p");
      loading.className = "text-center";
      loading.innerText = "Loading linked content...";
      content.appendChild(loading);
      Object.entries(tabButtons).forEach(([key, button]) => {
        button.classList.toggle("active", key === sourceType);
      });
      const variables = {
        filter: {
          q: search.value.trim() || null,
          page,
          per_page: perPage,
          sort: "created_at",
          direction: "DESC",
        },
        tags: {
          value: [tag.id],
          modifier: "INCLUDES_ALL",
          depth: 0,
        },
      };
      try {
        const data = await callGQL(
          LINKED_SOURCE_QUERIES[sourceType],
          variables
        );
        if (token !== requestToken || cleanedUp) return;
        const resultName =
          sourceType === "images"
            ? "findImages"
            : sourceType === "scenes"
              ? "findScenes"
              : "findPerformers";
        renderSources(data[resultName][sourceType], data[resultName].count);
      } catch (err) {
        if (token !== requestToken || cleanedUp) return;
        loading.innerText = `Failed to load linked content (${err}).`;
        renderFooter(0);
      }
    }

    ["images", "scenes", "performers"].forEach((type) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-outline-light";
      button.innerText = type[0].toUpperCase() + type.slice(1);
      button.addEventListener("click", () => {
        sourceType = type;
        page = 1;
        loadSources();
      });
      tabButtons[type] = button;
      tabs.appendChild(button);
    });

    search.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        page = 1;
        loadSources();
      }, 250);
    });
    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      cleanup();
    });
    modal.showModal();
    search.focus();
    loadSources();
  }

  function TagPagePickerButton({ tag }) {
    const [target, setTarget] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const apolloClient = Apollo.useApolloClient();

    React.useEffect(() => {
      function updateTarget() {
        const next = document.querySelector("#tag-page .tag-head .details-edit");
        setTarget(next && !next.querySelector(".save") ? next : null);
      }
      updateTarget();
      const observer = new MutationObserver(updateTarget);
      const page = document.querySelector("#tag-page");
      if (page) observer.observe(page, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, []);

    if (!target) return null;
    const button = React.createElement(
      "button",
      {
        type: "button",
        className: "btn btn-secondary",
        disabled: busy,
        title: "Choose this tag's image from linked content",
        onClick: () => {
          openLinkedContentPicker(tag, async (imageValue) => {
            setBusy(true);
            try {
              const updatedTag = await saveTagImage(tag.id, imageValue);
              refreshTagImageInCache(apolloClient, updatedTag);
            } catch (err) {
              window.alert(
                `Tag Image Grabber: failed to save tag image (${err})`
              );
            } finally {
              setBusy(false);
            }
          });
        },
      },
      busy ? "Saving…" : "Choose Image from Linked Content"
    );
    return ReactDOM.createPortal(button, target);
  }

  function GrabTagImageButton(props) {
    const { tag, pageContext, linkType } = props;
    const [busy, setBusy] = React.useState(false);
    const [isDetailChip, setIsDetailChip] = React.useState(false);
    const wrapperRef = React.useRef(null);
    const apolloClient = Apollo.useApolloClient();

    React.useEffect(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const expectedType =
        pageContext === "scene" ? "scene" : pageContext;
      const typeMatches = (linkType || "scene") === expectedType;
      const excluded = wrapper.closest(
        ".card, .popover, .modal, dialog, [role='dialog']"
      );
      setIsDetailChip(typeMatches && !excluded);
    }, [linkType, pageContext]);

    const onImageReady = async (imageValue) => {
      setBusy(true);
      try {
        const updatedTag = await saveTagImage(tag.id, imageValue);
        refreshTagImageInCache(apolloClient, updatedTag);
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

      if (pageContext === "performer") {
        const srcUrl = findSourceImageUrl("performer");
        if (!srcUrl || srcUrl.includes("?default=true")) {
          window.alert(
            "Tag Image Grabber: this performer has no image to use."
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
        } catch (err) {
          window.alert(
            `Tag Image Grabber: failed to resolve scene sources (${err})`
          );
          return;
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
      "span",
      {
        ref: wrapperRef,
        style: { display: isDetailChip ? "inline" : "none" },
      },
      React.createElement(
        "button",
        {
          type: "button",
          className: "tag-image-grabber-btn btn btn-secondary btn-sm",
          title:
            pageContext === "image"
              ? "Use this image for this tag"
              : pageContext === "performer"
                ? "Use this performer's image for this tag"
                : "Grab an image for this tag from this scene",
          "aria-label": "Choose this source as the tag image",
          style: { marginLeft: "4px", padding: "0 4px", lineHeight: "1.4" },
          disabled: busy,
          onClick,
        },
        busy ? "…" : "📷"
      )
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
          linkType: props.linkType,
        })
      );
    });

    PluginApi.patch.instead("TagPage", function (
      props,
      _,
      originalComponent
    ) {
      return React.createElement(
        React.Fragment,
        null,
        originalComponent(props),
        React.createElement(TagPagePickerButton, { tag: props.tag })
      );
    });
  }

  setupTagImageGrabber();
})();
