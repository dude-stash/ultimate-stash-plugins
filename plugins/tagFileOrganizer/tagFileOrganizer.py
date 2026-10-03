#!/usr/bin/env python3
"""Tag File Organizer backend.

Stash runs this as a raw plugin: the plugin input arrives as JSON on stdin and
the result goes back as {"output": ...} or {"error": ...} on stdout. Log lines
go to stderr with Stash's SOH/level/STX prefix.

Stdlib only on purpose, so there is nothing for users to pip install.

Operations (args.mode):
  hook      (hook) a scene was created or updated: organize that scene
  organize  (task) organize every scene in the source folder
  preview   (task) log what organize would do, and move nothing
"""

import json
import os
import ssl
import sys
import urllib.request

PLUGIN_ID = "tagFileOrganizer"
PAGE_SIZE = 100


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


# --- settings ----------------------------------------------------------------

def plugin_settings(stash):
    try:
        plugins = stash.call('{ configuration { plugins(include: ["%s"]) } }' % PLUGIN_ID)[
            "configuration"]["plugins"] or {}
        return plugins.get(PLUGIN_ID) or {}
    except Exception as err:
        log("w", "could not read plugin settings: %s" % err)
        return {}


# --- rules -------------------------------------------------------------------

def parse_rules(value):
    """Parse the rules setting into [(frozenset(keys), folder)].

    The settings page saves a JSON list, [{"tags": [{"id", "name"}], "folder"}],
    and rules match on tag ids, so renaming a tag doesn't break them. v0.1
    saved "Tag A, Tag B => /folder" lines instead; those still work, matched
    by name, until the rules are saved again. Keys are "id:<id>" or
    "name:<lowercased name>", the same keys scene_keys() builds for a scene.
    """
    if not value:
        return []
    try:
        data = json.loads(value)
    except ValueError:
        return parse_text_rules(value)
    rules = []
    for n, rule in enumerate(data if isinstance(data, list) else [], 1):
        rule = rule if isinstance(rule, dict) else {}
        keys = frozenset("id:%s" % t["id"] for t in rule.get("tags") or []
                         if isinstance(t, dict) and t.get("id"))
        folder = (rule.get("folder") or "").strip()
        if not keys or not folder:
            # The settings page won't save such a rule; skip a hand-edited one
            # rather than stop the others from working.
            log("w", "rule %d ignored: it needs at least one tag and a folder" % n)
            continue
        rules.append((keys, folder))
    return rules


def parse_text_rules(text):
    rules = []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        left, sep, right = line.partition("=>")
        keys = frozenset("name:" + t.strip().lower() for t in left.split(",") if t.strip())
        folder = right.strip()
        if not sep or not keys or not folder:
            log("w", "rules line %d ignored, expected 'Tag, Tag => /folder': %s" % (n, line))
            continue
        rules.append((keys, folder))
    return rules


def scene_keys(tags):
    keys = set()
    for t in tags:
        keys.add("id:%s" % t["id"])
        keys.add("name:" + t["name"].lower())
    return keys


def pick_folder(rules, keys):
    """The destination for a scene with these tag keys, or None to leave it.

    Of the rules whose tags are all on the scene, the one naming the most tags
    wins, so "Straight + Threesome" beats "Straight". max() keeps the first of
    equals, which makes the rule listed first win a tie.
    """
    matching = [r for r in rules if r[0] <= keys]
    if not matching:
        return None
    return max(matching, key=lambda r: len(r[0]))[1]


def norm(path):
    return os.path.normcase(os.path.normpath(path))


def is_inside(path, folder):
    # Compare with a trailing separator so /data/torrents2 isn't "inside"
    # /data/torrents.
    return norm(path).startswith(norm(folder).rstrip(os.sep) + os.sep)


# --- organizing --------------------------------------------------------------

SCENE_FIELDS = "id title tags { id name } files { id path }"


def organize_scene(stash, scene, settings, rules, dry_run):
    """Returns "moved", "skipped" or "error" for the scene."""
    source = (settings.get("sourceFolder") or "").strip()
    dest = pick_folder(rules, scene_keys(scene.get("tags") or []))
    label = scene.get("title") or "scene %s" % scene["id"]

    result = "skipped"
    for f in scene.get("files") or []:
        path = f["path"]
        if source and not is_inside(path, source):
            continue
        if not dest:
            log("i", "%s: no rule matches, left in place: %s" % (label, path))
            continue
        if norm(os.path.dirname(path)) == norm(dest):
            continue
        if dry_run:
            log("i", "[dry run] would move %s -> %s" % (path, dest))
            result = "moved"
            continue
        try:
            stash.call(
                "mutation($input: MoveFilesInput!) { moveFiles(input: $input) }",
                {"input": {"ids": [f["id"]], "destination_folder": dest}})
            log("i", "moved %s -> %s" % (path, dest))
            result = "moved"
        except Exception as err:
            # Includes "file already exists" - Stash won't overwrite or rename.
            log("w", "%s: could not move %s: %s" % (label, path, err))
            result = "error"
    return result


def op_hook(stash, args, settings, rules):
    if not settings.get("runOnTagChange"):
        return "disabled in settings"
    ctx = args.get("hookContext") or {}
    # An edit that didn't touch tags (play count, rating...) can't change the
    # outcome; skip it rather than query on every save. Create hooks and
    # unknown input shapes fall through to a full check.
    fields = ctx.get("inputFields")
    if ctx.get("type") == "Scene.Update.Post" and fields and "tag_ids" not in fields:
        return "tags unchanged"
    scene_id = ctx.get("id")
    if not scene_id:
        raise RuntimeError("hook context has no scene id")
    scene = stash.call(
        "query($id: ID!) { findScene(id: $id) { %s } }" % SCENE_FIELDS,
        {"id": str(scene_id)})["findScene"]
    if not scene:
        return "scene not found"
    return organize_scene(stash, scene, settings, rules, bool(settings.get("dryRun")))


def op_organize(stash, settings, rules, dry_run):
    source = (settings.get("sourceFolder") or "").strip()
    scene_filter = {}
    if source:
        # Narrows the query; is_inside() still decides per file. The quotes
        # matter: unquoted, Stash splits the path on spaces and matches any
        # one word (getPathSearchClauseMany in pkg/sqlite).
        scene_filter = {"path": {"value": '"%s"' % source, "modifier": "INCLUDES"}}
    counts = {"moved": 0, "skipped": 0, "error": 0}
    page = 1
    while True:
        data = stash.call(
            "query($f: FindFilterType, $sf: SceneFilterType) { findScenes(filter: $f, scene_filter: $sf) "
            "{ count scenes { %s } } }" % SCENE_FIELDS,
            {"f": {"page": page, "per_page": PAGE_SIZE, "sort": "id", "direction": "ASC"},
             "sf": scene_filter})["findScenes"]
        for scene in data["scenes"]:
            counts[organize_scene(stash, scene, settings, rules, dry_run)] += 1
        if page * PAGE_SIZE >= data["count"] or not data["scenes"]:
            break
        page += 1
    summary = "%s%d moved, %d unchanged, %d failed" % (
        "[dry run] " if dry_run else "", counts["moved"], counts["skipped"], counts["error"])
    log("i", summary)
    return summary


# --- entry point -------------------------------------------------------------

def main():
    plugin_input = json.loads(sys.stdin.read() or "{}")
    stash = Stash(plugin_input.get("server_connection") or {})
    args = plugin_input.get("args") or {}
    mode = args.get("mode")

    settings = plugin_settings(stash)
    rules = parse_rules(settings.get("rules"))
    if not rules:
        log("i", "no rules configured")
        return "no rules configured"

    if mode == "hook":
        return op_hook(stash, args, settings, rules)
    if mode == "preview":
        return op_organize(stash, settings, rules, True)
    if mode == "organize":
        if not settings.get("runManually"):
            log("w", "disabled in settings: turn on 'Allow the manual tasks to move files'")
            return "disabled in settings"
        return op_organize(stash, settings, rules, bool(settings.get("dryRun")))
    raise RuntimeError("unknown mode %r" % mode)


if __name__ == "__main__":
    try:
        result = main()
        print(json.dumps({"output": result}))
    except Exception as err:
        log("e", str(err))
        print(json.dumps({"error": str(err)}))
