#!/usr/bin/env python3
"""Scene Trimmer backend.

Stash runs this as a raw plugin: the plugin input arrives as JSON on stdin and
the result goes back as {"output": ...} or {"error": ...} on stdout. Log lines
go to stderr with Stash's SOH/level/STX prefix.

Stdlib only on purpose, so there is nothing for users to pip install.

Operations (args.mode):
  load       read a scene's trim record
  save       write (or with trim=null, delete) a scene's trim record
  keyframes  list the primary file's keyframe times via ffprobe
  trim       (task) cut the kept parts into a new file with ffmpeg, no re-encode;
             with kind=split, one new file per part between split points
  finalize   (task) attach the trimmed file to the scene as its primary file,
             or set up the split scenes in a group
  export_status / export_clear   read / dismiss the state of the last trim
"""

import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.request

FIELD = "ust_trim"


# --- logging -----------------------------------------------------------------

def log(level, msg):
    # Level chars match pkg/logger/plugin.go: t d i w e p.
    sys.stderr.write("\x01%s\x02%s\n" % (level, msg))
    sys.stderr.flush()


# --- stash graphql -----------------------------------------------------------

class Stash:
    def __init__(self, conn):
        scheme = conn.get("Scheme") or "http"
        host = conn.get("Host") or "localhost"
        # Stash reports its bind address; a wildcard is not connectable.
        if host in ("0.0.0.0", "::", "[::]"):
            host = "localhost"
        if ":" in host and not host.startswith("["):
            host = "[%s]" % host
        port = conn.get("Port") or 9999
        self.url = "%s://%s:%s/graphql" % (scheme, host, port)
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        cookie = conn.get("SessionCookie") or {}
        if cookie.get("Name"):
            self.headers["Cookie"] = "%s=%s" % (cookie["Name"], cookie.get("Value", ""))
        self.ctx = None
        if scheme == "https":
            # The server is talking to itself, usually with a self-signed
            # certificate that would never verify.
            self.ctx = ssl.create_default_context()
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE

    def call(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(self.url, data=body, headers=self.headers, method="POST")
        with urllib.request.urlopen(req, timeout=60, context=self.ctx) as res:
            data = json.load(res)
        if data.get("errors"):
            raise RuntimeError("; ".join(e.get("message", "?") for e in data["errors"]))
        return data["data"]


# --- storage -----------------------------------------------------------------
#
# One JSON file per scene under <stash config dir>/sceneTrimmer/ is the source
# of truth. It lives outside the plugin directory so plugin updates, which
# replace that directory, can't wipe it.
#
# The same record is mirrored into the scene's ust_trim custom field so it is
# part of Stash's own database backups. The mirror is never read while the file
# exists: Stash's scene edit form submits the whole custom-fields map, so a form
# save can put back a stale copy. load() notices that and rewrites the mirror.

def data_dir(conn):
    base = conn.get("Dir") or conn.get("PluginDir") or "."
    return os.path.join(base, "sceneTrimmer")


def scene_path(conn, scene_id):
    return os.path.join(data_dir(conn), "scenes", "%d.json" % scene_id)


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as err:
        log("w", "could not read %s: %s" % (path, err))
        return None


def write_json(path, value):
    # Write-then-rename so a crash never leaves half a file behind.
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def canonical(rec):
    return json.dumps(rec, sort_keys=True, separators=(",", ":"))


def to_float(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def sanitize(rec):
    """Keep only the known fields, with the expected types."""
    if not isinstance(rec, dict):
        raise ValueError("trim must be an object or null")
    ranges = []
    for r in rec.get("ranges") or []:
        if isinstance(r, (list, tuple)) and len(r) == 2:
            a, b = to_float(r[0]), to_float(r[1])
            if a is not None and b is not None and b > a >= 0:
                ranges.append([round(a, 3), round(b, 3)])
    pending = to_float(rec.get("pending_in"))
    last = to_float(rec.get("last_pos"))
    return {
        "v": 1,
        "file_id": str(rec.get("file_id") or ""),
        "mode": "remove" if rec.get("mode") == "remove" else "keep",
        "enabled": rec.get("enabled") is not False,
        "ranges": ranges,
        "pending_in": round(pending, 3) if pending is not None else None,
        "last_pos": round(last, 3) if last is not None else None,
        "splits": sorted({round(t, 3) for t in (to_float(x) for x in rec.get("splits") or [])
                          if t is not None and t > 0}),
    }


def mirror(stash, scene_id, rec):
    if rec is None:
        cf = {"remove": [FIELD]}
    else:
        cf = {"partial": {FIELD: canonical(rec)}}
    stash.call(
        "mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
        {"input": {"id": str(scene_id), "custom_fields": cf}},
    )


def op_load(conn, stash, scene_id):
    path = scene_path(conn, scene_id)
    rec = read_json(path)

    scene = stash.call(
        "query($id: ID!) { findScene(id: $id) { id custom_fields } }",
        {"id": str(scene_id)},
    )["findScene"]
    if scene is None:
        raise RuntimeError("scene %d not found" % scene_id)

    raw = (scene.get("custom_fields") or {}).get(FIELD)
    mirrored = None
    if isinstance(raw, str) and raw:
        try:
            mirrored = sanitize(json.loads(raw))
        except ValueError:
            log("w", "scene %d: ignoring unreadable %s custom field" % (scene_id, FIELD))

    if rec is None:
        if mirrored is None:
            return {"trim": None, "source": None}
        # File lost (new server, restored database): restore it from the backup.
        write_json(path, mirrored)
        log("i", "scene %d: restored trim ranges from the %s custom field" % (scene_id, FIELD))
        return {"trim": mirrored, "source": "custom_field"}

    rec = sanitize(rec)
    if mirrored is None or canonical(mirrored) != canonical(rec):
        try:
            mirror(stash, scene_id, rec)
        except Exception as err:  # the file is still fine; the backup can wait
            log("w", "scene %d: could not refresh %s: %s" % (scene_id, FIELD, err))
    return {"trim": rec, "source": "file"}


def op_save(conn, stash, scene_id, trim):
    path = scene_path(conn, scene_id)
    rec = None if trim is None else sanitize(trim)
    if rec is None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    else:
        write_json(path, rec)

    try:
        mirror(stash, scene_id, rec)
        mirrored = True
    except Exception as err:
        log("w", "scene %d: saved, but could not update %s: %s" % (scene_id, FIELD, err))
        mirrored = False
    return {"ok": True, "mirrored": mirrored}


# --- keyframes ---------------------------------------------------------------

def tool_paths(stash):
    ffmpeg, ffprobe = "ffmpeg", "ffprobe"
    try:
        general = stash.call("{ configuration { general { ffmpegPath ffprobePath } } }")[
            "configuration"]["general"]
        ffmpeg = general.get("ffmpegPath") or ffmpeg
        ffprobe = general.get("ffprobePath") or ffprobe
    except Exception as err:
        log("w", "could not read ffmpeg paths from the configuration: %s" % err)
    return ffmpeg, ffprobe


def primary_file(stash, scene_id):
    scene = stash.call(
        "query($id: ID!) { findScene(id: $id) { id files { id path mod_time } } }",
        {"id": str(scene_id)},
    )["findScene"]
    if scene is None:
        raise RuntimeError("scene %d not found" % scene_id)
    if not scene["files"]:
        raise RuntimeError("scene %d has no file" % scene_id)
    return scene["files"][0]


def probe_start_time(ffprobe, path):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=start_time",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=False,
    )
    return to_float(out.stdout.strip()) or 0.0


def probe_keyframes(ffprobe, path):
    # Packet flags say which packets are keyframes without decoding anything,
    # so this only costs a demux pass. ffprobe prints the fields in its own
    # order (pts_time, dts_time, flags), whatever order they were asked for,
    # and some containers (MPEG-TS) add a trailing side-data column.
    proc = subprocess.Popen(
        [ffprobe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time,dts_time,flags",
         "-of", "csv=p=0", path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    times = []
    for line in proc.stdout:
        parts = line.strip().split(",")
        if len(parts) < 3 or "K" not in parts[2]:
            continue
        t = to_float(parts[0])
        if t is None:
            t = to_float(parts[1])
        if t is not None:
            times.append(t)
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError("ffprobe failed: %s" % err.strip()[:500])
    return times


def op_keyframes(conn, stash, scene_id):
    f = primary_file(stash, scene_id)
    stamp = re.sub(r"[^0-9A-Za-z]", "", f.get("mod_time") or "")
    cache = os.path.join(data_dir(conn), "keyframes", "%s-%s.json" % (f["id"], stamp))
    cached = read_json(cache)
    if isinstance(cached, list):
        return {"file_id": f["id"], "keyframes": cached, "cached": True}

    _, ffprobe = tool_paths(stash)
    if not shutil.which(ffprobe) and not os.path.isfile(ffprobe):
        raise RuntimeError("ffprobe not found (%s)" % ffprobe)

    # The browser's timeline starts at 0; the container's may not.
    start = probe_start_time(ffprobe, f["path"])
    times = sorted({round(max(0.0, t - start), 3) for t in probe_keyframes(ffprobe, f["path"])})
    try:
        write_json(cache, times)
    except OSError as err:
        log("w", "could not cache keyframes: %s" % err)
    log("d", "scene %d: %d keyframes" % (scene_id, len(times)))
    return {"file_id": f["id"], "keyframes": times, "cached": False}


# --- export: range math ------------------------------------------------------
#
# These mirror normalize/complement/keepSegments in sceneTrimmer.js; the UI and
# the export must agree on what is kept.

MIN_LEN = 0.1


def normalize(ranges, duration):
    out = []
    for a, b in sorted([max(0.0, min(a, duration)), max(0.0, min(b, duration))] for a, b in ranges):
        if b - a < MIN_LEN:
            continue
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def complement(ranges, duration):
    out, pos = [], 0.0
    for a, b in ranges:
        if a - pos >= MIN_LEN:
            out.append([pos, a])
        pos = max(pos, b)
    if duration - pos >= MIN_LEN:
        out.append([pos, duration])
    return out


def keep_segments(rec, duration):
    if not rec or not rec["ranges"] or duration <= 0:
        return []
    marked = normalize(rec["ranges"], duration)
    return complement(marked, duration) if rec["mode"] == "remove" else marked


def remap_time(t, parts):
    """Position of source time t in the trimmed file, or None if t was cut."""
    for p in parts:
        if p["src_start"] - 0.05 <= t < p["src_end"]:
            return p["out_start"] + max(0.0, t - p["actual_start"])
    return None


def remap_marker(seconds, end_seconds, parts):
    """(seconds, end_seconds) on the new timeline, or None to delete."""
    start = remap_time(seconds, parts)
    if start is None:
        return None
    if end_seconds is None:
        return start, None
    end = remap_time(end_seconds, parts)
    if end is None:
        # The end fell in a cut: stop at the end of the last kept part before it.
        before = [p for p in parts if p["src_start"] < end_seconds]
        end = before[-1]["out_start"] + before[-1]["out_dur"] if before else None
    if end is None or end <= start:
        return start, None
    return start, end


# --- export: state -----------------------------------------------------------
#
# Export progress lives in its own file next to the scene's trim record, so a
# save from the UI can never overwrite it. The UI polls it via export_status.

ACTIVE = ("cutting", "joining", "scanning", "finalizing")


def export_path(conn, scene_id):
    return os.path.join(data_dir(conn), "scenes", "%d.export.json" % scene_id)


def now():
    import time
    return time.time()


class Export:
    def __init__(self, conn, scene_id, state=None):
        self.path = export_path(conn, scene_id)
        self.state = state or {}
        self._last_write = 0.0

    @classmethod
    def load(cls, conn, scene_id):
        return cls(conn, scene_id, read_json(export_path(conn, scene_id)))

    def update(self, force=True, **fields):
        self.state.update(fields)
        self.state["updated"] = now()
        # Progress ticks arrive several times a second; the UI only polls
        # every ~1.5 s, so don't rewrite the file more often than that.
        if force or now() - self._last_write > 1.0:
            write_json(self.path, self.state)
            self._last_write = now()


def op_export_status(conn, scene_id):
    exp = Export.load(conn, scene_id)
    st = exp.state
    if not st:
        return None
    # A crashed or cancelled task leaves its state behind. Cutting reports
    # progress continuously; the later steps just wait in the job queue.
    age = now() - (st.get("updated") or 0)
    limit = 120 if st.get("status") in ("cutting", "joining") else 6 * 3600
    if st.get("status") in ACTIVE and age > limit:
        exp.update(status="error", message="The trim task stopped without finishing.")
    return exp.state


def op_export_clear(conn, scene_id):
    try:
        os.unlink(export_path(conn, scene_id))
    except FileNotFoundError:
        pass
    return {"ok": True}


def plugin_settings(stash):
    try:
        plugins = stash.call('{ configuration { plugins(include: ["sceneTrimmer"]) } }')[
            "configuration"]["plugins"] or {}
        return plugins.get("sceneTrimmer") or {}
    except Exception as err:
        log("w", "could not read plugin settings: %s" % err)
        return {}


# --- export: cutting ---------------------------------------------------------

def unique_output(src, suffix):
    stem, ext = os.path.splitext(src)
    candidate = "%s.%s%s" % (stem, suffix, ext)
    n = 2
    while os.path.exists(candidate):
        candidate = "%s.%s-%d%s" % (stem, suffix, n, ext)
        n += 1
    return candidate


def run_ffmpeg(cmd, on_time=None):
    """Run ffmpeg with -progress on stdout, calling on_time(seconds)."""
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    for line in proc.stdout:
        # out_time_us is microseconds (out_time_ms is too, despite its name).
        if on_time and line.startswith("out_time_us="):
            us = to_float(line.split("=", 1)[1])
            if us is not None and us >= 0:
                on_time(us / 1e6)
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg failed: %s" % err.strip()[-800:])


def probe_duration(ffprobe, path):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=False,
    )
    d = to_float(out.stdout.strip())
    if d is None:
        raise RuntimeError("could not read the duration of %s" % path)
    return d


def concat_quote(path):
    return "'" + path.replace("'", "'\\''") + "'"


def cut_file(tools, src_path, segments, out_path, keyframes, progress, log_prefix):
    """Write segments of src_path, joined, to out_path without re-encoding.

    progress(fraction) is called with 0..1 for this file. Returns the parts:
    where each segment came from and where it landed in the new file.
    """
    ffmpeg, ffprobe = tools
    ext = os.path.splitext(src_path)[1]
    total = sum(b - a for a, b in segments) or 1.0
    # Parts go in a hidden folder beside the source: same disk (so the final
    # move is a rename), and never under a video file name a scan could pick
    # up half-written. Stash runs one job at a time, so no scan can run while
    # this task does anyway.
    tmp = tempfile.mkdtemp(prefix=".sceneTrimmer-", dir=os.path.dirname(src_path))
    try:
        parts = []
        done = 0.0
        for i, (a, b) in enumerate(segments):
            part = os.path.join(tmp, "part%03d%s" % (i, ext))
            log("i", "%s: cutting part %d/%d (%.1f-%.1f s)" % (log_prefix, i + 1, len(segments), a, b))
            # -ss before -i with stream copy starts the part on the keyframe at
            # or before a (like Avidemux); -t is counted from a.
            run_ffmpeg(
                [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y",
                 "-ss", "%.3f" % a, "-i", src_path, "-t", "%.3f" % (b - a),
                 "-map", "0", "-dn", "-ignore_unknown", "-c", "copy",
                 "-avoid_negative_ts", "make_zero", "-map_metadata", "0",
                 "-progress", "pipe:1", "-nostats", part],
                lambda t, done=done, a=a, b=b: progress(0.88 * (done + min(t, b - a)) / total),
            )
            d = probe_duration(ffprobe, part)
            # Where the part really starts. Estimating it from the part's length
            # would be off by the audio padding and shift every marker.
            before = [k for k in keyframes if k <= a + 0.001]
            actual = before[-1] if before else max(0.0, min(a, b - d))
            parts.append({"src_start": a, "src_end": b, "out_dur": d, "actual_start": actual})
            done += b - a

        pos = 0.0
        for p in parts:
            p["out_start"] = pos
            pos += p["out_dur"]

        if len(parts) == 1:
            os.replace(os.path.join(tmp, "part000%s" % ext), out_path)
        else:
            log("i", "%s: joining %d parts" % (log_prefix, len(parts)))
            listing = os.path.join(tmp, "parts.txt")
            with open(listing, "w", encoding="utf-8") as f:
                for i in range(len(parts)):
                    f.write("file %s\n" % concat_quote("part%03d%s" % (i, ext)))
            joined = os.path.join(tmp, "joined%s" % ext)
            cmd = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y",
                   "-f", "concat", "-safe", "0", "-i", listing,
                   "-map", "0", "-dn", "-ignore_unknown", "-c", "copy", "-map_metadata", "0"]
            if ext.lower() in (".mp4", ".m4v", ".mov"):
                cmd += ["-movflags", "+faststart"]
            cmd += ["-progress", "pipe:1", "-nostats", joined]
            run_ffmpeg(cmd, lambda t: progress(0.88 + 0.12 * t / max(pos, 0.001)))
            os.replace(joined, out_path)
        progress(1.0)
        return parts
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def split_spans(splits, duration):
    bounds = [0.0] + [s for s in splits if 0 < s < duration] + [duration]
    return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]


def intersect(segments, a, b):
    out = []
    for s, e in segments:
        lo, hi = max(s, a), min(e, b)
        if hi - lo >= MIN_LEN:
            out.append([lo, hi])
    return out


def plan_outputs(rec, duration, kind):
    """[(index, segments)] to write. index is the scene number for splits."""
    keep = keep_segments(rec, duration)
    if kind == "split":
        if not rec["splits"]:
            raise RuntimeError("There are no split points on this scene.")
        # Without any ranges the whole movie is kept.
        keep = keep or [[0.0, duration]]
        outputs = []
        for a, b in split_spans(rec["splits"], duration):
            segs = intersect(keep, a, b)
            # A part that is entirely cut produces no scene.
            if sum(e - s for s, e in segs) >= 1.0:
                outputs.append((len(outputs) + 1, segs))
        if len(outputs) < 1:
            raise RuntimeError("Every part is cut; there is nothing to split.")
        return outputs
    kept = sum(b - a for a, b in keep)
    if not keep:
        raise RuntimeError("Nothing would be kept.")
    if kept >= duration - MIN_LEN:
        raise RuntimeError("Nothing would be cut.")
    return [(1, keep)]


# --- export: trim task -------------------------------------------------------

def op_trim(conn, stash, scene_id, kind):
    kind = "split" if kind == "split" else "trim"
    rec = read_json(scene_path(conn, scene_id))
    rec = sanitize(rec) if rec else None
    scene = stash.call(
        "query($id: ID!) { findScene(id: $id) { id files { id path duration } } }",
        {"id": str(scene_id)},
    )["findScene"]
    if scene is None or not scene["files"]:
        raise RuntimeError("scene %d has no file" % scene_id)
    src = scene["files"][0]
    if not rec or not (rec["ranges"] or rec["splits"]):
        raise RuntimeError("Nothing is marked on this scene.")
    if rec["file_id"] != src["id"]:
        raise RuntimeError("The ranges were marked on a different file of this scene.")

    duration = src["duration"] or 0
    planned = plan_outputs(rec, duration, kind)

    tools = tool_paths(stash)
    for tool in tools:
        if not shutil.which(tool) and not os.path.isfile(tool):
            raise RuntimeError("%s not found" % tool)

    try:
        keyframes = op_keyframes(conn, stash, scene_id)["keyframes"]
    except Exception as err:
        log("w", "scene %d: no keyframes (%s); marker times will be approximate" % (scene_id, err))
        keyframes = []

    token = os.urandom(8).hex()
    exp = Export(conn, scene_id)
    exp.update(kind=kind, status="cutting", progress=0.0, token=token, message=None,
               source_file_id=src["id"], source_path=src["path"], outputs=[],
               scene_count=len(planned), started=now())

    grand = sum(sum(b - a for a, b in segs) for _, segs in planned) or 1.0
    before = 0.0
    outputs = []
    try:
        for index, segs in planned:
            size = sum(b - a for a, b in segs)
            out_path = unique_output(
                src["path"], "trimmed" if kind == "trim" else "scene-%02d" % index)

            def progress(p, before=before, size=size, index=index):
                p = (before + size * max(0.0, min(1.0, p))) / grand
                log("p", p)
                exp.update(force=False, progress=p, current=index)

            parts = cut_file(tools, src["path"], segs, out_path, keyframes, progress,
                             "scene %d" % scene_id)
            outputs.append({"index": index, "path": out_path, "parts": parts})
            log("i", "scene %d: wrote %s" % (scene_id, out_path))
            before += size
    except BaseException as err:
        # Don't leave half a split behind.
        for o in outputs:
            try:
                os.unlink(o["path"])
            except OSError:
                pass
        exp.update(status="error", message=str(err)[:500])
        raise

    exp.update(status="scanning", progress=1.0, outputs=outputs,
               output_path=outputs[0]["path"] if kind == "trim" else None)

    # Both of these are queued behind this task (Stash runs jobs one at a
    # time, in order), so the finalize step runs once the scan has created the
    # new files' scenes. Waiting for the scan here would deadlock the queue.
    paths = [o["path"] for o in outputs]
    try:
        stash.call(
            "mutation($input: ScanMetadataInput!) { metadataScan(input: $input) }",
            {"input": {"paths": paths, "rescan": False,
                       # New split scenes need a cover; a trimmed file joins a
                       # scene that already has one.
                       "scanGenerateCovers": kind == "split",
                       "scanGeneratePreviews": False, "scanGenerateImagePreviews": False,
                       "scanGenerateSprites": False, "scanGeneratePhashes": False,
                       "scanGenerateThumbnails": False, "scanGenerateClipPreviews": False}},
        )
        what = "the trimmed file to scene %d" % scene_id if kind == "trim" \
            else "the %d split scenes of scene %d" % (len(outputs), scene_id)
        job = stash.call(
            "mutation($args: Map, $desc: String) { runPluginTask(plugin_id: \"sceneTrimmer\", "
            "task_name: \"Finalize trim\", description: $desc, args_map: $args) }",
            {"args": {"scene_id": str(scene_id), "token": token},
             "desc": "Scene Trimmer: set up " + what},
        )["runPluginTask"]
    except Exception as err:
        exp.update(status="error",
                   message="The new files were written (%s), but they couldn't be added "
                           "to Stash: %s" % (", ".join(paths), err))
        raise
    exp.update(finalize_job=job)
    return {"outputs": paths, "finalize_job": job}


# --- export: finalize task ---------------------------------------------------

def op_finalize(conn, stash, scene_id, token):
    exp = Export.load(conn, scene_id)
    st = exp.state
    if not st or st.get("token") != token:
        log("w", "scene %d: this trim was superseded; nothing to do" % scene_id)
        return {"skipped": True}
    try:
        exp.update(status="finalizing")
        if st.get("kind") == "split":
            return finalize_split(conn, stash, scene_id, exp)
        return finalize_trim(conn, stash, scene_id, exp)
    except BaseException as err:
        exp.update(status="error",
                   message="The new files were written (%s), but setting them up failed: %s"
                           % (", ".join(o["path"] for o in st.get("outputs") or []), str(err)[:400]))
        raise


def find_scanned(stash, path):
    """(scene, file) the scan created for path."""
    found = stash.call(
        "query($f: SceneFilterType) { findScenes(scene_filter: $f, filter: {per_page: -1}) "
        "{ scenes { id files { id path } } } }",
        {"f": {"path": {"value": path, "modifier": "EQUALS"}}},
    )["findScenes"]["scenes"]
    for s in found:
        for f in s["files"]:
            if f["path"] == path:
                return s, f
    raise RuntimeError("the scan didn't add %s; is its folder excluded from the library?" % path)


def scene_markers(stash, scene_id):
    return stash.call(
        "query($id: ID!) { findScene(id: $id) { scene_markers { id title seconds end_seconds "
        "primary_tag { id } tags { id } } } }",
        {"id": str(scene_id)},
    )["findScene"]["scene_markers"]


def generate(stash, scene_ids):
    if plugin_settings(stash).get("skipGenerate"):
        return
    stash.call(
        "mutation($input: GenerateMetadataInput!) { metadataGenerate(input: $input) }",
        {"input": {"sceneIDs": [str(i) for i in scene_ids], "covers": False, "sprites": True,
                   "previews": True, "phashes": True, "markers": True}},
    )


def finalize_trim(conn, stash, scene_id, exp):
    st = exp.state
    out = st["outputs"][0]
    new_scene, new_file = find_scanned(stash, out["path"])

    if new_scene["id"] != str(scene_id):
        # Moves the file (and nothing else worth keeping) onto the original
        # scene and deletes the scene the scan just made. The original scene's
        # own metadata, cover, tags, performers and stash IDs stay as they are.
        stash.call(
            "mutation($input: SceneMergeInput!) { sceneMerge(input: $input) { id } }",
            {"input": {"source": [new_scene["id"]], "destination": str(scene_id),
                       "play_history": False, "o_history": False}},
        )
    # Separate call: merge never changes the destination's primary file.
    stash.call(
        "mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
        {"input": {"id": str(scene_id), "primary_file_id": new_file["id"], "resume_time": 0}},
    )

    moved = removed = 0
    for m in scene_markers(stash, scene_id):
        mapped = remap_marker(m["seconds"], m.get("end_seconds"), out["parts"])
        if mapped is None:
            stash.call("mutation($id: ID!) { sceneMarkerDestroy(id: $id) }", {"id": m["id"]})
            removed += 1
        else:
            stash.call(
                "mutation($input: SceneMarkerUpdateInput!) { sceneMarkerUpdate(input: $input) { id } }",
                {"input": {"id": m["id"], "seconds": round(mapped[0], 3),
                           "end_seconds": round(mapped[1], 3) if mapped[1] is not None else None}},
            )
            moved += 1
    log("i", "scene %d: %d markers moved, %d removed (they were in cut parts)" % (scene_id, moved, removed))

    # The ranges described the old file; the new primary file is already cut.
    op_save(conn, stash, scene_id, None)

    generate(stash, [scene_id])
    if plugin_settings(stash).get("deleteOriginal"):
        stash.call("mutation($ids: [ID!]!) { deleteFiles(ids: $ids) }",
                   {"ids": [st["source_file_id"]]})
        log("i", "scene %d: deleted the original file %s" % (scene_id, st["source_path"]))

    exp.update(status="done", progress=1.0, new_file_id=new_file["id"],
               markers_moved=moved, markers_removed=removed, finished=now())
    return {"new_file_id": new_file["id"]}


def finalize_split(conn, stash, scene_id, exp):
    st = exp.state
    orig = stash.call(
        "query($id: ID!) { findScene(id: $id) { id title date director studio { id } "
        "tags { id } performers { id } groups { group { id name } } files { path } } }",
        {"id": str(scene_id)},
    )["findScene"]
    title = orig.get("title") or os.path.splitext(os.path.basename(orig["files"][0]["path"]))[0]

    # The movie is the group. If the original scene is already in one, that
    # group is the movie; otherwise make it.
    if orig.get("groups"):
        group = orig["groups"][0]["group"]
    else:
        group_input = {"name": title}
        if orig.get("date"):
            group_input["date"] = orig["date"]
        if orig.get("director"):
            group_input["director"] = orig["director"]
        if orig.get("studio"):
            group_input["studio_id"] = orig["studio"]["id"]
        group = stash.call(
            "mutation($input: GroupCreateInput!) { groupCreate(input: $input) { id name } }",
            {"input": group_input},
        )["groupCreate"]

    markers = scene_markers(stash, scene_id)
    created = []
    copied = 0
    for out in st["outputs"]:
        new_scene, _ = find_scanned(stash, out["path"])
        update = {
            "id": new_scene["id"],
            "title": "%s - Scene %d" % (title, out["index"]),
            "tag_ids": [t["id"] for t in orig.get("tags") or []],
            "performer_ids": [p["id"] for p in orig.get("performers") or []],
            "groups": [{"group_id": group["id"], "scene_index": out["index"]}],
        }
        if orig.get("date"):
            update["date"] = orig["date"]
        if orig.get("director"):
            update["director"] = orig["director"]
        if orig.get("studio"):
            update["studio_id"] = orig["studio"]["id"]
        stash.call(
            "mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
            {"input": update},
        )
        # The original keeps its markers; each part gets a copy of the ones
        # that fall inside it, at their new times.
        for m in markers:
            mapped = remap_marker(m["seconds"], m.get("end_seconds"), out["parts"])
            if mapped is None:
                continue
            stash.call(
                "mutation($input: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $input) { id } }",
                {"input": {"scene_id": new_scene["id"], "title": m.get("title") or "",
                           "seconds": round(mapped[0], 3),
                           "end_seconds": round(mapped[1], 3) if mapped[1] is not None else None,
                           "primary_tag_id": m["primary_tag"]["id"],
                           "tag_ids": [t["id"] for t in m.get("tags") or []]}},
            )
            copied += 1
        created.append(new_scene["id"])
    log("i", "scene %d: created %d scenes in group %s (%d markers copied)"
        % (scene_id, len(created), group["name"], copied))

    generate(stash, created)
    exp.update(status="done", progress=1.0, group_id=group["id"], group_name=group["name"],
               scene_ids=created, finished=now())
    return {"group_id": group["id"], "scene_ids": created}


# --- entry point -------------------------------------------------------------

def main():
    plugin_input = json.loads(sys.stdin.read() or "{}")
    conn = plugin_input.get("server_connection") or {}
    args = plugin_input.get("args") or {}
    stash = Stash(conn)

    mode = args.get("mode")
    try:
        scene_id = int(args.get("scene_id"))
    except (TypeError, ValueError):
        raise RuntimeError("scene_id is required")

    if mode == "load":
        return op_load(conn, stash, scene_id)
    if mode == "save":
        return op_save(conn, stash, scene_id, args.get("trim"))
    if mode == "keyframes":
        return op_keyframes(conn, stash, scene_id)
    if mode == "export_status":
        return op_export_status(conn, scene_id)
    if mode == "export_clear":
        return op_export_clear(conn, scene_id)
    if mode == "trim":
        return op_trim(conn, stash, scene_id, args.get("kind"))
    if mode == "finalize":
        return op_finalize(conn, stash, scene_id, args.get("token"))
    raise RuntimeError("unknown mode %r" % mode)


if __name__ == "__main__":
    try:
        result = main()
        print(json.dumps({"output": result}))
    except Exception as err:
        log("e", str(err))
        print(json.dumps({"error": str(err)}))
