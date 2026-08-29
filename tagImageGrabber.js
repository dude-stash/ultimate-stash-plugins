// Tag Image Grabber
//
// Adds a small action button next to tag chips on Image and Scene detail
// pages that lets you grab the image/scene cover you're currently looking at
// and use it as that tag's image (with an optional crop step), instead of
// having to manually download/upload/crop it yourself.
//
// v0.1 scope (see plan): Image page tag chips (use the full-res displayed
// image) and Scene page tag chips (use the scene's existing cover image).
// Marker screenshots, the sprite/VTT thumbnail-grid picker, live frame
// capture from a paused video, and the reverse picker from a Tag's own edit
// page are follow-up phases, not implemented here yet.
(function () {
  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const csLib = window.csLib;

  const TAG_UPDATE_MUTATION = `mutation TagImageGrabberUpdate($input: TagUpdateInput!) { tagUpdate(input: $input) { id } }`;

  async function saveTagImage(tagId, imageValue) {
    const variables = { input: { id: tagId, image: imageValue } };
    await csLib.callGQL({ query: TAG_UPDATE_MUTATION, variables });
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

  // Opens a crop dialog seeded from `srcUrl`. Calls onDone(dataUrlOrUrl) once
  // the user confirms - either a cropped data URL, or the original URL if
  // they choose to use it as-is.
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

    const img = document.createElement("img");
    img.src = srcUrl;
    img.style.display = "block";
    img.style.maxWidth = "100%";
    container.appendChild(img);

    const btnRow = document.createElement("div");
    btnRow.className =
      "d-flex flex-row justify-content-center align-items-center";
    btnRow.style.gap = "10px";
    btnRow.style.marginTop = "10px";
    modal.appendChild(btnRow);

    let cropper = null;

    function cleanup() {
      if (cropper) cropper.destroy();
      modal.close();
      modal.remove();
    }

    const useOriginalBtn = document.createElement("button");
    useOriginalBtn.className = "btn btn-secondary";
    useOriginalBtn.innerText = "Use as-is";
    useOriginalBtn.addEventListener("click", () => {
      cleanup();
      onDone(srcUrl);
    });
    btnRow.appendChild(useOriginalBtn);

    const cropBtn = document.createElement("button");
    cropBtn.className = "btn btn-primary";
    cropBtn.innerText = "Crop";
    cropBtn.addEventListener("click", () => {
      if (!cropper) {
        cropper = new Cropper(img, {
          viewMode: 1,
          movable: false,
          rotatable: false,
          scalable: false,
          zoomable: false,
          zoomOnTouch: false,
          zoomOnWheel: false,
          ready() {
            cropBtn.innerText = "Save crop";
          },
        });
        return;
      }
      const dataUrl = cropper.getCroppedCanvas().toDataURL("image/jpeg");
      cleanup();
      onDone(dataUrl);
    });
    btnRow.appendChild(cropBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-danger";
    cancelBtn.innerText = "Cancel";
    cancelBtn.addEventListener("click", cleanup);
    btnRow.appendChild(cancelBtn);

    modal.showModal();
  }

  function GrabTagImageButton(props) {
    const { tag, pageContext } = props;
    const [busy, setBusy] = React.useState(false);

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const srcUrl = findSourceImageUrl(pageContext);
      if (!srcUrl) {
        window.alert(
          "Tag Image Grabber: couldn't find a source image on this page."
        );
        return;
      }
      openCropDialog(srcUrl, async (imageValue) => {
        setBusy(true);
        try {
          await saveTagImage(tag.id, imageValue);
        } catch (err) {
          window.alert(`Tag Image Grabber: failed to save tag image (${err})`);
        } finally {
          setBusy(false);
        }
      });
    };

    return React.createElement(
      "button",
      {
        type: "button",
        className: "tag-image-grabber-btn btn btn-secondary btn-sm",
        title:
          pageContext === "image"
            ? "Use this image for this tag"
            : "Use this scene's cover for this tag",
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
