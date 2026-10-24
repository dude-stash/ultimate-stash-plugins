import json
import ssl
import urllib.request

PLUGIN_ID = "StashMetadataMapper"

SCENE_FIELDS = """
  id title details date rating100
  files { id path oshash: fingerprint(type: "oshash") }
  studio { name }
  performers { name }
  tags { name }
  paths { screenshot }
  stash_ids { endpoint stash_id }
"""


class StashInterface:
    def __init__(self, conn):
        scheme = conn.get("Scheme") or "http"
        host = conn.get("Host") or "localhost"
        # Stash reports its bind address; a wildcard is not connectable.
        if host in ("0.0.0.0", "::", "[::]"):
            host = "localhost"
        if ":" in host and not host.startswith("["):
            host = "[%s]" % host
        port = conn.get("Port") or 9999
        self.base_url = "%s://%s:%s" % (scheme, host, port)
        self.graphql_url = self.base_url + "/graphql"
        self.headers = {"Accept": "application/json"}
        cookie = conn.get("SessionCookie") or {}
        if cookie.get("Name"):
            self.headers["Cookie"] = "%s=%s" % (cookie["Name"], cookie.get("Value", ""))
        api_key = conn.get("ApiKey") or ""
        if api_key:
            self.headers["ApiKey"] = api_key
        self.ctx = None
        if scheme == "https":
            # The server is talking to itself, usually with a self-signed
            # certificate that would never verify.
            self.ctx = ssl.create_default_context()
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE

    def call_gql(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        headers = dict(self.headers, **{"Content-Type": "application/json"})
        req = urllib.request.Request(self.graphql_url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=60, context=self.ctx) as res:
            data = json.load(res)
        if data.get("errors"):
            raise RuntimeError("; ".join(e.get("message", "?") for e in data["errors"]))
        return data["data"]

    def fetch_bytes(self, url):
        if url.startswith("/"):
            url = self.base_url + url
        req = urllib.request.Request(url, headers=self.headers)
        with urllib.request.urlopen(req, timeout=60, context=self.ctx) as res:
            return res.read()

    def get_plugin_config(self):
        data = self.call_gql('{ configuration { plugins(include: ["%s"]) } }' % PLUGIN_ID)
        return (data["configuration"]["plugins"] or {}).get(PLUGIN_ID) or {}

    def find_scene(self, scene_id):
        query = "query($id: ID!) { findScene(id: $id) { %s } }" % SCENE_FIELDS
        return self.call_gql(query, {"id": str(scene_id)})["findScene"]

    def find_scenes(self, page=1, per_page=100):
        query = "query($f: FindFilterType) { findScenes(filter: $f) { count scenes { %s } } }" % SCENE_FIELDS
        variables = {"f": {"page": page, "per_page": per_page, "sort": "id", "direction": "ASC"}}
        return self.call_gql(query, variables)["findScenes"]

    def waiting_job_descriptions(self):
        jobs = self.call_gql("{ jobQueue { status description } }")["jobQueue"] or []
        return {j["description"] for j in jobs if j["status"] == "READY"}

    def run_task(self, task_name, description, args):
        query = ("mutation($id: ID!, $task: String, $desc: String, $args: Map) "
                 "{ runPluginTask(plugin_id: $id, task_name: $task, description: $desc, args_map: $args) }")
        return self.call_gql(query, {"id": PLUGIN_ID, "task": task_name, "desc": description, "args": args})

    def find_files(self, ids):
        if not ids:
            return []
        query = 'query($ids: [ID!]) { findFiles(ids: $ids) { files { id path phash: fingerprint(type: "phash") } } }'
        return self.call_gql(query, {"ids": [str(i) for i in ids]})["findFiles"]["files"]

    def set_phash(self, file_id, phash):
        query = "mutation($input: FileSetFingerprintsInput!) { fileSetFingerprints(input: $input) }"
        return self.call_gql(query, {"input": {"id": str(file_id), "fingerprints": [{"type": "phash", "value": phash}]}})

    def rescan_files(self, paths, generate_phashes):
        query = "mutation($input: ScanMetadataInput!) { metadataScan(input: $input) }"
        return self.call_gql(query, {"input": {
            "paths": paths,
            "rescan": True,
            "scanGeneratePhashes": generate_phashes,
        }})
