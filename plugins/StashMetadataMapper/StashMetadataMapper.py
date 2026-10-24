#!/usr/bin/env python3
"""Stash Metadata Mapper: writes scene metadata into MP4 atoms with mutagen, from a manual task or a scene-save hook."""

import json
import os
import re
import shutil
import struct
import sys

# mutagen is vendored so the plugin needs no pip install.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm, AtomDataType  # noqa: E402

from stash_interface import StashInterface

MP4_EXTENSIONS = {".mp4", ".m4v"}

# Maps StashDB endpoint URLs to human-readable atom key suffixes
ENDPOINT_ATOM_KEYS = {
    "https://stashdb.org/graphql": "stashdb_id",
    "https://theporndb.net/graphql": "tpdb_id",
}

ATOM_LABELS = {
    "stik": "media kind (movie=9)",
    "©nam": "title",
    "ldes": "long description",
    "©day": "date",
    "aART": "studio (album artist)",
    "©ART": "cast (artist)",
    "covr": "artwork",
    "©gen": "genre",
    "keyw": "keywords",
}

DEFAULT_SETTINGS = {
    "exportTitle": True,
    "exportDescription": True,
    "exportDate": True,
    "exportStudio": True,
    "exportCast": True,
    "exportRating": True,
    "exportArtwork": True,
    "exportTagsAsKeywords": True,
    "genreTagNames": "",
    "ignoreTagNames": "",
    "exportStashIds": True,
    "rescanChangedFiles": True,
    "runOnSceneUpdate": False,
    "runManually": False,
}

# SceneUpdateInput fields that feed an atom; primary_file_id is here so a file made primary (e.g. by Scene Trimmer) gets written
EXPORTED_INPUT_FIELDS = {
    "title", "details", "date", "rating100", "studio_id", "performer_ids",
    "tag_ids", "stash_ids", "cover_image", "primary_file_id",
}

# The task the save hook queues to write a scene's files
WRITE_TASK = "Write scene metadata"

# Free space to leave on top of the copy each write makes
COPY_HEADROOM = 256 * 2**20

# Settings that are strings, not booleans
_STRING_SETTINGS = {"genreTagNames", "ignoreTagNames"}


def oshash(path):
    """Stash's file hash: file size plus the 64-bit little-endian sums of the first and last 64 KB."""
    size = os.path.getsize(path)
    h = size
    with open(path, "rb") as f:
        for offset in (0, max(0, size - 65536)):
            f.seek(offset)
            chunk = f.read(65536)
            chunk = chunk[: len(chunk) // 8 * 8]
            for (v,) in struct.iter_unpack("<Q", chunk):
                h = (h + v) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def rescan_changed(stash, changed, settings):
    """Queue a rescan so Stash records the new oshash of files whose bytes changed.

    The oshash covers the file size and the last 64 KB, so writing atoms changes it, and
    Stash tracks files by path and oshash. The API cannot set an oshash, only a scan can
    recompute it, and a scan drops the phash when the oshash changes, so phashes are
    regenerated for files that had one. The scan keeps the file id, so nothing is re-linked.
    """
    if not changed:
        return
    if not settings.get("rescanChangedFiles"):
        log(f"{len(changed)} file(s) changed oshash and were not rescanned (rescan disabled)", "WARNING")
        return
    for with_phash in (True, False):
        paths = [p for p, had in changed if had == with_phash]
        if not paths:
            continue
        try:
            stash.rescan_files(paths, with_phash)
            log(f"Queued a rescan of {len(paths)} file(s) to update their oshash"
                f"{' and phash' if with_phash else ''}")
        except Exception as exc:
            log(f"Could not queue the rescan ({exc}). Rescan these files or Stash will not "
                f"track them if moved: {', '.join(paths)}", "ERROR")


LEVELS = {"DEBUG": "d", "INFO": "i", "WARNING": "w", "ERROR": "e"}


def log(msg, level="INFO"):
    # Level chars match pkg/logger/plugin.go: t d i w e p.
    sys.stderr.write("\x01%s\x02%s\n" % (LEVELS.get(level, "i"), msg))
    sys.stderr.flush()


def eprint(msg):
    log(msg)


def get_settings(stash):
    config = stash.get_plugin_config()
    settings = dict(DEFAULT_SETTINGS)
    for key, value in config.items():
        if key not in settings:
            continue
        if key in _STRING_SETTINGS:
            settings[key] = str(value) if value is not None else ""
        else:
            settings[key] = bool(value)
    return settings


def _parse_tag_patterns(s):
    """Parse a comma-separated setting into a list of lowercase substrings to match against tag names."""
    if not s:
        return []
    return [t.strip().lower() for t in s.split(",") if t.strip()]


def _tag_matches(name_lower, patterns):
    """Return True if name_lower contains any of the patterns as a substring."""
    return any(p in name_lower for p in patterns)


def _endpoint_to_key(endpoint):
    key = re.sub(r"https?://", "", endpoint)
    key = re.sub(r"[^a-zA-Z0-9]", "_", key).strip("_")
    return key[:40]


def fetch_artwork(stash, scene):
    screenshot_url = (scene.get("paths") or {}).get("screenshot")
    if not screenshot_url:
        return None, None
    try:
        data = stash.fetch_bytes(screenshot_url)
        fmt = MP4Cover.FORMAT_PNG if data[:8] == b"\x89PNG\r\n\x1a\n" else MP4Cover.FORMAT_JPEG
        return data, fmt
    except Exception as exc:
        log(f"Could not fetch artwork: {exc}", "WARNING")
        return None, None


def build_metadata(scene, settings, stash):
    """Build a dict of MP4 atom key → value for the scene."""
    meta = {}

    meta["stik"] = [9]  # Media kind: Movie — tells players to use video metadata fields

    if settings["exportTitle"] and scene.get("title"):
        meta["©nam"] = [scene["title"]]

    if settings["exportDescription"] and scene.get("details"):
        meta["ldes"] = [scene["details"]]

    if settings["exportDate"] and scene.get("date"):
        meta["©day"] = [scene["date"]]

    if settings["exportStudio"] and scene.get("studio"):
        name = scene["studio"]["name"]
        meta["aART"] = [name]
        meta["----:com.stash:studio"] = [MP4FreeForm(name.encode("utf-8"), AtomDataType.UTF8)]

    if settings["exportCast"] and scene.get("performers"):
        meta["©ART"] = [", ".join(p["name"] for p in scene["performers"])]

    if settings["exportRating"] and scene.get("rating100") is not None:
        meta["----:com.stash:rating100"] = [
            MP4FreeForm(str(scene["rating100"]).encode("utf-8"), AtomDataType.UTF8)
        ]

    tags = scene.get("tags") or []
    if tags and (settings["exportTagsAsKeywords"] or settings["genreTagNames"]):
        genre_patterns = _parse_tag_patterns(settings["genreTagNames"])
        ignore_patterns = _parse_tag_patterns(settings["ignoreTagNames"])
        genres, keywords = [], []
        for tag in tags:
            name = tag["name"]
            nl = name.lower()
            if ignore_patterns and _tag_matches(nl, ignore_patterns):
                continue
            if genre_patterns and _tag_matches(nl, genre_patterns):
                genres.append(name)
            elif settings["exportTagsAsKeywords"]:
                keywords.append(name)
        if genres:
            meta["©gen"] = [", ".join(genres)]
        if keywords:
            meta["keyw"] = ["; ".join(keywords)]

    if settings["exportStashIds"]:
        meta["----:com.stash:id"] = [
            MP4FreeForm(str(scene["id"]).encode("utf-8"), AtomDataType.UTF8)
        ]
        for sid in scene.get("stash_ids") or []:
            endpoint = sid.get("endpoint", "")
            stash_id = sid.get("stash_id", "")
            suffix = ENDPOINT_ATOM_KEYS.get(endpoint, _endpoint_to_key(endpoint))
            meta[f"----:com.stash:{suffix}"] = [
                MP4FreeForm(stash_id.encode("utf-8"), AtomDataType.UTF8)
            ]

    if settings["exportArtwork"]:
        artwork_data, artwork_fmt = fetch_artwork(stash, scene)
        if artwork_data:
            meta["covr"] = [MP4Cover(artwork_data, imageformat=artwork_fmt)]

    return meta


def _format_val(val):
    if val is None:
        return "<not set>"
    if isinstance(val, list) and not val:
        return "<empty>"
    item = val[0] if isinstance(val, list) else val
    if isinstance(item, MP4Cover):
        fmt = "JPEG" if item.imageformat == MP4Cover.FORMAT_JPEG else "PNG"
        return f"[{fmt}, {len(item):,} bytes]"
    if isinstance(item, MP4FreeForm):
        return repr(bytes(item).decode("utf-8", errors="replace"))
    return repr(str(item))


def _atom_label(key):
    if key.startswith("----:com.stash:"):
        return key.split(":", 2)[-1]
    return ATOM_LABELS.get(key, key)


def process_scene(stash, scene, settings, dry_run):
    """Write the scene's metadata and return [(path, had_phash)] for files whose oshash changed."""
    scene_id = scene.get("id", "?")
    files = scene.get("files") or []
    changed = []

    if not files:
        log(f"Scene {scene_id}: no files, skipping")
        return changed

    new_meta = build_metadata(scene, settings, stash)

    if not new_meta:
        log(f"Scene {scene_id}: nothing to write (all fields disabled or empty)")
        return changed

    for f in files:
        path = f.get("path", "")
        ext = os.path.splitext(path)[1].lower()
        if ext not in MP4_EXTENSIONS:
            log(f"Scene {scene_id}: skipping non-MP4 file: {path}")
            continue
        if not os.path.exists(path):
            log(f"Scene {scene_id}: file not found: {path}", "WARNING")
            continue

        if dry_run:
            _preview(path, scene_id, new_meta)
        else:
            before = oshash(path)
            if _write(path, scene_id, new_meta) and oshash(path) != before:
                changed.append((path, bool(f.get("phash"))))

    return changed


def _preview(path, scene_id, new_meta):
    try:
        mp4 = MP4(path)
        current = mp4.tags or {}
    except Exception:
        current = {}

    eprint(f"\n[DRY RUN] Scene {scene_id}: {path}")
    changed = 0
    for key, new_val in new_meta.items():
        old_val = current.get(key)
        old_str = _format_val(old_val)
        new_str = _format_val(new_val)
        if old_str != new_str:
            label = _atom_label(key)
            eprint(f"  {key} ({label})")
            eprint(f"    before: {old_str}")
            eprint(f"    after:  {new_str}")
            changed += 1

    if changed == 0:
        eprint("  [no changes]")
    else:
        eprint(f"  [WOULD WRITE {changed} atom(s)]")


def _write(path, scene_id, new_meta):
    """Write the atoms that differ from the file's and return True, or False if none differ or the write failed.

    The atoms go into a copy beside the file, which replaces it only once it reads back right, so a write that is
    killed, crashes or runs out of space leaves the original as it was.
    """
    tmp = os.path.join(os.path.dirname(path), "." + os.path.basename(path) + ".smm-tmp")
    try:
        mp4 = MP4(path)
        current = mp4.tags or {}
        # Saving rewrites the file and changes its oshash, so skip it when another plugin's edit left the atoms as they are
        stale = {key: val for key, val in new_meta.items() if current.get(key) != val}
        if not stale:
            log(f"Scene {scene_id}: already up to date → {path}", "DEBUG")
            return False

        size = os.path.getsize(path)
        free = shutil.disk_usage(os.path.dirname(path)).free
        if free < size + COPY_HEADROOM:
            raise RuntimeError(f"not enough free space for a copy ({free // 2**20} MB free, {size // 2**20} MB needed)")
        shutil.copyfile(path, tmp)
        try:
            shutil.copymode(path, tmp)
        except OSError:
            pass  # network shares (CIFS/SMB) often refuse chmod; the copy is still good
        if os.path.getsize(tmp) != size:
            raise RuntimeError("the copy came out a different size")

        copy = MP4(tmp)
        if copy.tags is None:
            copy.add_tags()
        for key, val in stale.items():
            copy.tags[key] = val
        copy.save()

        check = MP4(tmp)
        if abs(check.info.length - mp4.info.length) > 0.01:
            raise RuntimeError(f"the copy is {check.info.length:.2f} s long, the file {mp4.info.length:.2f} s")
        wrong = [key for key, val in new_meta.items() if (check.tags or {}).get(key) != val]
        if wrong:
            raise RuntimeError(f"the copy did not keep {', '.join(_atom_label(k) for k in wrong)}")

        fd = os.open(tmp, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        log(f"Scene {scene_id}: wrote {', '.join(_atom_label(k) for k in stale)} → {path}")
        return True
    except Exception as exc:
        log(f"Scene {scene_id}: did not write {path}, the file is unchanged: {exc}", "ERROR")
        return False
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        except OSError as exc:
            log(f"Scene {scene_id}: could not remove the temporary copy {tmp}: {exc}", "WARNING")


def handle_hook(stash, args):
    hook_ctx = args.get("hookContext") or {}
    scene_id = hook_ctx.get("id")
    if not scene_id:
        log("Hook fired with no scene ID in hookContext", "WARNING")
        return "no scene id"
    # Scans fire Scene.Update.Post with no input; only edits and Identify carry the changed fields
    fields = hook_ctx.get("inputFields")
    if not fields:
        return f"skipped scene {scene_id}: updated by a scan, not an edit"
    # Stash waits for post hooks before answering the update, so edits that write no atoms (another plugin's custom field, play count) must not wait on a file write
    if not EXPORTED_INPUT_FIELDS.intersection(fields):
        return f"skipped scene {scene_id}: no exported field changed"
    # Stash kills this hook when the save that fired it is cancelled; a job outlives the save and runs one at a time with scans, trims and other writes
    desc = f"Stash Metadata Mapper: write scene {scene_id}"
    if desc in stash.waiting_job_descriptions():
        return f"scene {scene_id} is already queued"
    stash.run_task(WRITE_TASK, desc, {"scene_id": str(scene_id)})
    return f"queued scene {scene_id}"


def handle_write(stash, args, settings):
    scene_id = args.get("scene_id")
    if not scene_id:
        log("This task is queued when a scene is saved; run Export Metadata to write every scene", "WARNING")
        return "no scene id"
    scene = stash.find_scene(scene_id)
    if not scene:
        log(f"Scene {scene_id} not found", "WARNING")
        return f"scene {scene_id} not found"
    rescan_changed(stash, process_scene(stash, scene, settings, False), settings)
    return f"processed scene {scene_id}"


def handle_export(stash, settings, dry_run):
    page = 1
    per_page = 100
    total = 0
    changed = []

    while True:
        result = stash.find_scenes(page=page, per_page=per_page)
        if not result:
            break
        scenes = result.get("scenes") or []
        count = result.get("count", 0)
        if not scenes:
            break
        for scene in scenes:
            changed += process_scene(stash, scene, settings, dry_run)
            total += 1
        log(f"Progress: {total}/{count}")
        if total >= count:
            break
        page += 1

    rescan_changed(stash, changed, settings)

    mode_label = "previewed" if dry_run else "processed"
    return f"{mode_label} {total} scene(s)"


def main():
    plugin_input = json.loads(sys.stdin.read() or "{}")
    args = plugin_input.get("args") or {}
    mode = args.get("mode", "export")
    dry_run = str(args.get("dryRun", "false")).lower() == "true"

    stash = StashInterface(plugin_input.get("server_connection") or {})
    settings = get_settings(stash)

    if mode == "hook":
        if not settings["runOnSceneUpdate"]:
            return "disabled in settings"
        return handle_hook(stash, args)
    if mode == "write":
        if not settings["runOnSceneUpdate"]:
            return "disabled in settings"
        return handle_write(stash, args, settings)
    if mode == "export":
        if not dry_run and not settings["runManually"]:
            log("disabled in settings: turn on 'Allow the manual task to write files'", "WARNING")
            return "disabled in settings"
        return handle_export(stash, settings, dry_run)
    raise RuntimeError("unknown mode %r" % mode)


if __name__ == "__main__":
    try:
        print(json.dumps({"output": main()}))
    except Exception as err:
        log(str(err), "ERROR")
        print(json.dumps({"error": str(err)}))
