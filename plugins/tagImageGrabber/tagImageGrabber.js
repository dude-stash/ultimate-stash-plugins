// Tag Image Grabber
//
// Adds an action to tag hover cards and tag pages that lets users choose a tag
// image from linked images, scenes, or performers, with crop and video-frame
// capture tools.
(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch) {
    console.error("[TagImageGrabber] PluginApi.patch is unavailable");
    return;
  }

  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM;
  const Apollo = PluginApi.libraries.Apollo;
  const Icon = PluginApi.components.Icon;
  const { Button, Modal } = PluginApi.libraries.Bootstrap;
  const { faImage, faCrop } = PluginApi.libraries.FontAwesomeSolid;
  const baseURL =
    document.querySelector("base")?.getAttribute("href") || "/";
  const normalizedBaseURL = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  const graphqlURL = new URL(
    "graphql",
    new URL(normalizedBaseURL, window.location.origin)
  ).href;

  const TAG_UPDATE_MUTATION = `mutation TagImageGrabberUpdate($input: TagUpdateInput!) { tagUpdate(input: $input) { id image_path } }`;

  // --- Small DOM/reporting helpers -------------------------------------
  //
  // The modals below are built with vanilla DOM rather than React (they are
  // opened from imperative callbacks, outside any component tree), which
  // otherwise means a create/className/text/listener/append block per button.

  function alertFailure(message) {
    window.alert(`Tag Image Grabber: ${message}`);
  }

  function makeButton(options) {
    const btn = document.createElement("button");
    btn.type = options.type || "button";
    if (options.className) btn.className = options.className;
    if (options.html !== undefined) btn.innerHTML = options.html;
    else if (options.text !== undefined) btn.innerText = options.text;
    if (options.title) btn.title = options.title;
    if (options.disabled) btn.disabled = true;
    if (options.onClick) btn.addEventListener("click", options.onClick);
    if (options.parent) options.parent.appendChild(btn);
    return btn;
  }

  function makeElement(tag, className, parent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (parent) parent.appendChild(el);
    return el;
  }

  function makeStatus(text, parent) {
    const status = makeElement("p", "text-center", parent);
    status.innerText = text;
    return status;
  }

  // Creates the <dialog>, appends it to the body, and returns it. `size` picks
  // one of the width variants in tagImageGrabber.css.
  function makeDialog(size, ariaLabel, extraClassName) {
    const modal = document.createElement("dialog");
    modal.className = `tag-image-grabber-modal tag-image-grabber-modal--${size} bg-dark${
      extraClassName ? ` ${extraClassName}` : ""
    }`;
    modal.setAttribute("aria-label", ariaLabel);
    document.body.appendChild(modal);
    return modal;
  }

  // Escape / the browser's own dismiss gesture should run the same teardown as
  // the Cancel button rather than leaving the detached dialog in the DOM.
  function onDialogCancel(modal, handler) {
    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      handler();
    });
  }

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
  const TAG_IMAGE_FRAGMENT = Apollo.gql`
    fragment TagImageGrabberRefreshedImage on Tag {
      id
      image_path
    }
  `;

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
        fragment: TAG_IMAGE_FRAGMENT,
        data: { __typename: "Tag", id: tag.id, image_path: tag.image_path },
      });
    } catch (err) {
      // best-effort - a stale hover preview isn't worth failing the save over
    }
  }

  // Save + cache refresh + the shared failure report, used by every entry
  // point (tag page, tag card, hover card, performer page).
  async function commitTagImage(apolloClient, tagId, imageValue) {
    try {
      const updatedTag = await saveTagImage(tagId, imageValue);
      refreshTagImageInCache(apolloClient, updatedTag);
    } catch (err) {
      alertFailure(`failed to save tag image (${err})`);
    }
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
    imgContainer.classList.add("tag-image-grabber-crop-container");

    const wrapper = makeElement("div", "tag-image-grabber-crop-wrapper");

    // Toggled between "d-none" and "d-flex ..." (not a plain inline
    // style.display) - Bootstrap's utility classes set `display` with
    // `!important`, which would otherwise permanently win over an inline
    // style and keep this visible regardless of crop state. Appended after
    // `wrapper` so it renders below the image, still above the Save/Cancel
    // row in `actionsContainer`.
    const cropToolbar = makeElement("div", "tag-image-grabber-toolbar d-none");
    imgContainer.appendChild(wrapper);
    imgContainer.appendChild(cropToolbar);

    // Hidden until either the square preview is applied or crop mode is
    // entered - otherwise the full original flashes on screen first and
    // then visibly jumps to the (usually smaller/differently-shaped) square
    // crop a moment later.
    const img = makeElement("img", "tag-image-grabber-crop-image", wrapper);
    img.src = srcUrl;
    img.style.visibility = "hidden";

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
      // Cropper.js is loaded from a CDN by the plugin yml; if that request
      // failed there is nothing to enter crop mode with.
      if (typeof window.Cropper !== "function") {
        alertFailure("the cropper library failed to load.");
        return;
      }
      cropIconBtn.style.display = "none";
      cropToolbar.className =
        "tag-image-grabber-toolbar d-flex flex-row justify-content-center align-items-center mb-2";
      // Cropping always operates on the original full image, regardless of
      // what's currently displayed (the square preview, or "Full"'s
      // original) - otherwise adjusting couldn't recover anything the
      // square preview's auto-crop had cut off.
      img.src = srcUrl;
      img.style.visibility = "visible";
      const defaultRatio = CROP_ASPECT_RATIOS.find((r) => r.isDefault).value;
      cropper = new window.Cropper(img, {
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
      cropToolbar.className = "tag-image-grabber-toolbar d-none";
      cropIconBtn.style.display = "inline-block";
      img.src = originalDataUrl;
      img.style.visibility = "visible";
      currentValue = originalDataUrl;
    }

    const cropIconBtn = makeButton({
      className: "tag-image-grabber-crop-icon btn btn-secondary btn-sm",
      title: "Crop",
      html: faIconMarkup(faCrop),
      disabled: true,
      onClick: enterCropMode,
      parent: wrapper,
    });

    CROP_ASPECT_RATIOS.forEach(({ label, value }) => {
      const btn = makeButton({
        className: "btn btn-outline-light btn-sm",
        text: label,
        onClick: () => {
          if (!cropper) return;
          cropper.setAspectRatio(value);
          setActiveAspect(value);
        },
        parent: cropToolbar,
      });
      aspectBtns.push({ btn, ratio: value });
    });

    const fullBtn = makeButton({
      className: "btn btn-outline-light btn-sm",
      text: "Full",
      title: "No crop - use the entire image",
      onClick: () => {
        selectFull();
        setActiveFull();
      },
      parent: cropToolbar,
    });

    const saveBtn = makeButton({
      className: "btn btn-success",
      text: "Save",
      disabled: true,
      onClick: () => {
        const value = cropper
          ? cropper.getCroppedCanvas().toDataURL("image/jpeg")
          : currentValue;
        onSave(value);
      },
      parent: actionsContainer,
    });

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
        alertFailure(`failed to read image (${err})`);
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
    const modal = makeDialog("crop", "Crop tag image");
    const container = makeElement("div", "tag-image-grabber-block", modal);
    const btnRow = makeElement(
      "div",
      "tag-image-grabber-row tag-image-grabber-row--spaced d-flex flex-row justify-content-center align-items-center",
      modal
    );

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

    makeButton({
      className: "btn btn-danger",
      text: "Cancel",
      onClick: cleanup,
      parent: btnRow,
    });

    onDialogCancel(modal, cleanup);
    modal.showModal();
  }

  // Resolves once `video` fires `eventName`, or after `timeoutMs` regardless
  // (some browsers/streams don't reliably fire seeked/loadeddata/canplay in
  // every situation, so this never hangs forever).
  function waitForVideoEvent(video, eventName, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      function finish() {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        video.removeEventListener(eventName, finish);
        resolve();
      }
      video.addEventListener(eventName, finish);
      timer = window.setTimeout(finish, timeoutMs);
    });
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

  // --- Picker for a tag's linked content ---
  //
  // Everything that differs between the three source types lives here, so the
  // picker itself never branches on `sourceType`:
  //   query      - the GraphQL document, keyed by its find* root field
  //   resultKey  - that root field's name in the response
  //   itemsKey   - the list field inside it
  //   label      - the tab caption
  //   isUsable   - drops entries that can't supply an image at all
  //   thumbUrl   - what the grid tile shows
  //   fullUrl    - what gets cropped (scenes go through their own modal)
  const LINKED_SOURCES = {
    images: {
      query: `query TagImageGrabberLinkedImages($filter: FindFilterType, $tags: HierarchicalMultiCriterionInput!) {
      findImages(filter: $filter, image_filter: { tags: $tags }) {
        count
        images { id title paths { thumbnail image } }
      }
    }`,
      resultKey: "findImages",
      itemsKey: "images",
      label: "Images",
      isUsable: (item) => Boolean(item.paths && item.paths.image),
      thumbUrl: (item) => item.paths.thumbnail || item.paths.image,
      fullUrl: (item) => item.paths.image,
    },
    scenes: {
      query: `query TagImageGrabberLinkedScenes($filter: FindFilterType, $tags: HierarchicalMultiCriterionInput!) {
      findScenes(filter: $filter, scene_filter: { tags: $tags }) {
        count
        scenes { id title paths { screenshot vtt stream } }
      }
    }`,
      resultKey: "findScenes",
      itemsKey: "scenes",
      label: "Scenes",
      isUsable: () => true,
      thumbUrl: (item) => item.paths.screenshot,
      fullUrl: (item) => item.paths.screenshot,
    },
    performers: {
      query: `query TagImageGrabberLinkedPerformers($filter: FindFilterType, $tags: HierarchicalMultiCriterionInput!) {
      findPerformers(filter: $filter, performer_filter: { tags: $tags }) {
        count
        performers { id name image_path }
      }
    }`,
      resultKey: "findPerformers",
      itemsKey: "performers",
      label: "Performers",
      isUsable: (item) =>
        Boolean(item.image_path && !item.image_path.includes("?default=true")),
      thumbUrl: (item) => item.image_path,
      fullUrl: (item) => item.image_path,
    },
  };

  const SOURCE_TYPES = ["images", "scenes", "performers"];

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
    const modal = makeDialog(
      "scene",
      `Choose an image from ${scene.title || `scene ${scene.id}`}`,
      "text-white"
    );

    const title = makeElement("h5", "text-center", modal);
    title.innerText = scene.title || `Scene ${scene.id}`;

    const sourceRow = makeElement(
      "div",
      "tag-image-grabber-row--tight mb-2 d-flex flex-row flex-wrap justify-content-center align-items-center",
      modal
    );
    const contentArea = makeElement("div", "tag-image-grabber-block", modal);
    const actionRow = makeElement(
      "div",
      "tag-image-grabber-row mt-2 d-flex flex-row justify-content-center align-items-center",
      modal
    );

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
        makeButton({
          className: "btn btn-secondary",
          text: "Back to Scenes",
          onClick: () => {
            cleanup();
            onBack();
          },
          parent: actionRow,
        });
      }

      makeButton({
        className: "btn btn-danger",
        text: "Cancel",
        onClick: () => {
          cleanup();
          if (onCancel) onCancel();
        },
        parent: actionRow,
      });
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
      const status = makeStatus("Loading scene cover...", contentArea);
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
      const status = makeStatus("Loading thumbnails...", contentArea);
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
      const grid = makeElement(
        "div",
        "tag-image-grabber-sprite-grid",
        contentArea
      );
      sprites.forEach((sprite) => {
        const tile = makeButton({
          className: "btn p-0",
          title: `Capture frame at ${Math.round(sprite.start)} seconds`,
          onClick: async () => {
            const captureToken = ++viewToken;
            tile.disabled = true;
            const dataUrl = await seekAndCaptureVideo(getVideo(), sprite.start);
            if (captureToken !== viewToken || cleanedUp) return;
            if (!dataUrl) {
              tile.disabled = false;
              alertFailure("couldn't capture this scene frame.");
              return;
            }
            showCrop(dataUrl);
          },
          parent: grid,
        });
        // Per-sprite offsets into the shared sprite sheet - computed values,
        // so they stay inline.
        tile.style.width = `${sprite.w}px`;
        tile.style.height = `${sprite.h}px`;
        tile.style.backgroundImage = `url(${sprite.url})`;
        tile.style.backgroundPosition = `-${sprite.x}px -${sprite.y}px`;
        tile.style.backgroundRepeat = "no-repeat";
      });
      addCancelButton();
    }

    function showVideo() {
      resetView();
      if (!scene.paths.stream) {
        makeStatus("This scene has no playable stream.", contentArea);
        addCancelButton();
        return;
      }
      const player = getVideo();
      player.controls = true;
      player.className = "tag-image-grabber-player";
      contentArea.appendChild(player);

      makeButton({
        className: "btn btn-success",
        text: "Capture Current Frame",
        onClick: () => {
          const dataUrl = captureVideoElement(player);
          if (!dataUrl) {
            alertFailure("wait for the video frame to load first.");
            return;
          }
          showCrop(dataUrl);
        },
        parent: actionRow,
      });
      addCancelButton();
    }

    [
      { text: "Scene cover", onClick: showCover },
      { text: "Thumbnails", onClick: showThumbnails },
      { text: "Video frame", onClick: showVideo },
    ].forEach(({ text, onClick }) =>
      makeButton({
        className: "btn btn-outline-light btn-sm",
        text,
        onClick,
        parent: sourceRow,
      })
    );

    onDialogCancel(modal, () => {
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
    const modal = makeDialog(
      "picker",
      `Choose linked content for ${tag.name}`,
      "text-white"
    );

    const heading = makeElement("h4", "text-center", modal);
    heading.innerText = `Choose an image for ${tag.name}`;

    const controls = makeElement(
      "div",
      "tag-image-grabber-row--tight mb-3 d-flex flex-row flex-wrap justify-content-center align-items-center",
      modal
    );

    const search = makeElement(
      "input",
      "tag-image-grabber-search form-control",
      controls
    );
    search.type = "search";
    search.placeholder = "Search linked content";
    search.setAttribute("aria-label", "Search linked content");

    const tabs = makeElement("div", "btn-group", controls);
    const content = makeElement("div", "tag-image-grabber-content", modal);
    const footer = makeElement(
      "div",
      "tag-image-grabber-row--tight mt-3 d-flex flex-row justify-content-center align-items-center",
      modal
    );

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
      openCropDialog(LINKED_SOURCES[sourceType].fullUrl(source), onImageReady);
    }

    function renderFooter(count) {
      footer.innerHTML = "";
      makeButton({
        className: "btn btn-secondary",
        text: "Previous",
        disabled: page <= 1,
        onClick: () => {
          page--;
          loadSources();
        },
        parent: footer,
      });

      const status = makeElement("span", null, footer);
      status.innerText = `Page ${page} of ${Math.max(
        1,
        Math.ceil(count / perPage)
      )}`;

      makeButton({
        className: "btn btn-secondary",
        text: "Next",
        disabled: page * perPage >= count,
        onClick: () => {
          page++;
          loadSources();
        },
        parent: footer,
      });

      makeButton({
        className: "btn btn-danger",
        text: "Cancel",
        onClick: cleanup,
        parent: footer,
      });
    }

    function renderSources(items, count) {
      content.innerHTML = "";
      const source = LINKED_SOURCES[sourceType];
      const usable = items.filter(source.isUsable);
      if (!usable.length) {
        makeStatus("No usable linked content found.", content);
        renderFooter(count);
        return;
      }
      const grid = makeElement("div", "tag-image-grabber-source-grid", content);
      usable.forEach((item) => {
        const button = makeButton({
          className: "tag-image-grabber-source-btn btn btn-secondary p-2",
          onClick: () => selectSource(item),
          parent: grid,
        });
        const image = makeElement(
          "img",
          "tag-image-grabber-source-thumb",
          button
        );
        image.alt = "";
        image.loading = "lazy";
        image.src = source.thumbUrl(item);
        const label = makeElement("div", "text-truncate mt-1", button);
        label.innerText = item.title || item.name || `${sourceType} ${item.id}`;
      });
      renderFooter(count);
    }

    async function loadSources() {
      const token = ++requestToken;
      content.innerHTML = "";
      footer.innerHTML = "";
      const loading = makeStatus("Loading linked content...", content);
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
      const source = LINKED_SOURCES[sourceType];
      try {
        const data = await callGQL(source.query, variables);
        if (token !== requestToken || cleanedUp) return;
        const result = data[source.resultKey];
        renderSources(result[source.itemsKey], result.count);
      } catch (err) {
        if (token !== requestToken || cleanedUp) return;
        loading.innerText = `Failed to load linked content (${err}).`;
        renderFooter(0);
      }
    }

    SOURCE_TYPES.forEach((type) => {
      tabButtons[type] = makeButton({
        className: "btn btn-outline-light",
        text: LINKED_SOURCES[type].label,
        onClick: () => {
          sourceType = type;
          page = 1;
          loadSources();
        },
        parent: tabs,
      });
    });

    search.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        page = 1;
        loadSources();
      }, 250);
    });
    onDialogCancel(modal, cleanup);
    modal.showModal();
    search.focus();
    loadSources();
  }

  function TagPagePickerActions({ tag }) {
    const [buttonTarget, setButtonTarget] = React.useState(null);
    const [imageTarget, setImageTarget] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const apolloClient = Apollo.useApolloClient();

    React.useEffect(() => {
      function updateTargets() {
        const nextButtonTarget = document.querySelector(
          "#tag-page .tag-head .details-edit"
        );
        const isEditing = nextButtonTarget?.querySelector(".save");
        setButtonTarget(isEditing ? null : nextButtonTarget);
        setImageTarget(
          isEditing
            ? null
            : document.querySelector("#tag-page .detail-header-image img")
        );
      }
      updateTargets();
      const observer = new MutationObserver(updateTargets);
      const page = document.querySelector("#tag-page");
      if (page) observer.observe(page, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, []);

    const openPicker = React.useCallback(() => {
      openLinkedContentPicker(tag, async (imageValue) => {
        setBusy(true);
        try {
          await commitTagImage(apolloClient, tag.id, imageValue);
        } finally {
          setBusy(false);
        }
      });
    }, [apolloClient, tag]);

    React.useEffect(() => {
      if (!imageTarget) return undefined;

      function handleImageClick(event) {
        event.preventDefault();
        event.stopPropagation();
        openPicker();
      }

      imageTarget.classList.add("tag-image-grabber-page-image");
      imageTarget.addEventListener("click", handleImageClick);
      return () => {
        imageTarget.classList.remove("tag-image-grabber-page-image");
        imageTarget.removeEventListener("click", handleImageClick);
      };
    }, [imageTarget, openPicker]);

    const pickerButton = React.createElement(
      "button",
      {
        type: "button",
        className: "btn btn-secondary",
        disabled: busy,
        title: "Choose this tag's image from linked content",
        onClick: openPicker,
      },
      busy ? "Saving…" : "Set Image..."
    );
    const imageButton = React.createElement(
      "button",
      {
        type: "button",
        className:
          "tag-image-grabber-page-action btn btn-secondary btn-sm",
        disabled: busy,
        title: "Choose this tag's image from linked content",
        "aria-label": `Choose an image for ${tag.name}`,
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPicker();
        },
      },
      React.createElement(Icon, { icon: faImage })
    );

    return React.createElement(
      React.Fragment,
      null,
      buttonTarget && ReactDOM.createPortal(pickerButton, buttonTarget),
      imageTarget &&
        ReactDOM.createPortal(
          imageButton,
          imageTarget.closest(".detail-header-image")
        )
    );
  }

  function useTagImagePicker(tag) {
    const apolloClient = Apollo.useApolloClient();

    return React.useCallback(() => {
      openLinkedContentPicker(tag, (imageValue) =>
        commitTagImage(apolloClient, tag.id, imageValue)
      );
    }, [apolloClient, tag]);
  }

  function HoverCardClickableImage({ tag, children }) {
    const openPicker = useTagImagePicker(tag);

    return React.createElement(
      "span",
      {
        className: "tag-image-grabber-clickable-image",
        onClick: (event) => {
          if (!event.currentTarget.closest(".tag-popover-card")) return;
          event.preventDefault();
          event.stopPropagation();
          openPicker();
        },
      },
      children
    );
  }

  function TagCardImageButton({ tag }) {
    const openPicker = useTagImagePicker(tag);

    return React.createElement(
      "button",
      {
        type: "button",
        className:
          "tag-image-grabber-card-action btn btn-secondary btn-sm",
        title: "Choose this tag's image from linked content",
        "aria-label": `Choose an image for ${tag.name}`,
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPicker();
        },
      },
      React.createElement(Icon, { icon: faImage })
    );
  }

  function PerformerTagImageAction({ performer, activeImage }) {
    const [show, setShow] = React.useState(false);
    const [selectedTag, setSelectedTag] = React.useState(null);
    const [pendingTag, setPendingTag] = React.useState(null);
    const [saving, setSaving] = React.useState(false);
    const [target, setTarget] = React.useState(null);
    const apolloClient = Apollo.useApolloClient();
    const TagSelect = PluginApi.components.TagSelect;
    const hasImage =
      activeImage && !String(activeImage).includes("default=true");

    React.useEffect(() => {
      function updateTarget() {
        const deleteButton = document.querySelector(
          "#performer-page .details-edit .delete"
        );
        setTarget(deleteButton ? deleteButton.parentElement : null);
      }

      updateTarget();
      const observer = new MutationObserver(updateTarget);
      const page = document.querySelector("#performer-page");
      if (page) observer.observe(page, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, []);

    const saveImage = (tag) => {
      openCropDialog(activeImage, async (imageValue) => {
        setSaving(true);
        try {
          await commitTagImage(apolloClient, tag.id, imageValue);
        } finally {
          setSaving(false);
        }
      });
    };

    if (!hasImage || !TagSelect || !target) return null;

    return React.createElement(
      React.Fragment,
      null,
      ReactDOM.createPortal(
        React.createElement(
          Button,
          {
            className: "performer-tag-image-action",
            variant: "secondary",
            disabled: saving,
            title: `Use ${performer.name}'s image for a tag`,
            onClick: () => {
              setSelectedTag(null);
              setShow(true);
            },
          },
          "Use as Tag Image"
        ),
        target
      ),
      React.createElement(
        Modal,
        {
          show,
          onHide: () => setShow(false),
          onExited: () => {
            if (!pendingTag) return;
            const tag = pendingTag;
            setPendingTag(null);
            saveImage(tag);
          },
        },
        React.createElement(
          Modal.Header,
          { closeButton: true },
          React.createElement(
            Modal.Title,
            null,
            "Choose a target tag"
          )
        ),
        React.createElement(
          Modal.Body,
          null,
          React.createElement(
            "p",
            null,
            `Choose the tag that should use ${performer.name}'s image.`
          ),
          React.createElement(TagSelect, {
            creatable: false,
            isMulti: false,
            menuPortalTarget: document.body,
            onSelect: (tags) => setSelectedTag(tags[0] || null),
            values: selectedTag ? [selectedTag] : [],
          })
        ),
        React.createElement(
          Modal.Footer,
          null,
          React.createElement(
            Button,
            { variant: "secondary", onClick: () => setShow(false) },
            "Cancel"
          ),
          React.createElement(
            Button,
            {
              variant: "primary",
              disabled: !selectedTag,
              onClick: () => {
                setPendingTag(selectedTag);
                setShow(false);
              },
            },
            "Use Image"
          )
        )
      )
    );
  }

  function setupTagImageGrabber() {
    PluginApi.patch.instead("PerformerPage", function (
      props,
      _,
      originalComponent
    ) {
      return React.createElement(
        React.Fragment,
        null,
        originalComponent(props),
        React.createElement(PerformerTagImageAction, {
          activeImage: props.performer.image_path,
          performer: props.performer,
        })
      );
    });

    PluginApi.patch.instead("TagCard.Image", function (
      props,
      _,
      originalComponent
    ) {
      const image = originalComponent(props);
      if (!props.tag || !props.tag.id) return image;

      return React.createElement(
        HoverCardClickableImage,
        { tag: props.tag },
        image
      );
    });

    PluginApi.patch.instead("TagCard.Overlays", function (
      props,
      _,
      originalComponent
    ) {
      return React.createElement(
        React.Fragment,
        null,
        originalComponent(props),
        props.tag &&
          props.tag.id &&
          React.createElement(TagCardImageButton, { tag: props.tag })
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
        React.createElement(TagPagePickerActions, { tag: props.tag })
      );
    });
  }

  setupTagImageGrabber();
})();
