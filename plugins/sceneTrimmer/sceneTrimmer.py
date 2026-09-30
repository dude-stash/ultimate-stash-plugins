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
    raise RuntimeError("unknown mode %r" % mode)


if __name__ == "__main__":
    try:
        result = main()
        print(json.dumps({"output": result}))
    except Exception as err:
        log("e", str(err))
        print(json.dumps({"error": str(err)}))
