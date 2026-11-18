from base64 import urlsafe_b64decode
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import os
import re
import shlex
import urllib.parse
import urllib.request

scratch = Path.cwd() / "homepage-parity"
snapshot = scratch / "staging-data"
snapshot.mkdir(exist_ok=True)
site = "https://wamule-staging.netlify.app"
hopkins_host = "ceiba-test.wamuledevelopment.com"
staging_ref = "kvocwmrcuhiaezlcgzjf"
supabase = f"https://{staging_ref}.supabase.co"

def read_url(url, *, headers=None, data=None):
    req = urllib.request.Request(url, headers=headers or {}, data=data)
    try:
        with urllib.request.urlopen(req, timeout=18) as reply:
            return reply.read()
    except urllib.error.HTTPError as exc:
        if req.get_method() == "GET" and exc.code == 404 and req.full_url.startswith(supabase + "/functions/v1/get-public-lots?"):
            return json.dumps({"fetchStatus": 404, "body": json.loads(exc.read())}).encode()
        raise RuntimeError(f"{req.get_method()} {urllib.parse.urlsplit(url).path} failed: {exc.code}") from None
    except OSError as exc:
        raise RuntimeError(f"{req.get_method()} {urllib.parse.urlsplit(url).path} failed: {getattr(exc, 'code', type(exc).__name__)}") from None

html = read_url(site + "/p/wamule/wamule?phase=default").decode()
match = re.search(r'<script[^>]+src="(/assets/index-[^"]+\.js)"', html)
if not match:
    raise RuntimeError("Could not identify the staging entry module")
bundle = read_url(site + match[1]).decode()
if supabase not in bundle:
    raise RuntimeError("Deployed client API does not match the expected staging project")
keys = []
for token in set(re.findall(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", bundle)):
    claims_segment = token.split(".")[1]
    claims = json.loads(urlsafe_b64decode(claims_segment + "=" * (-len(claims_segment) % 4)))
    if claims.get("role") == "anon" and claims.get("ref") == staging_ref:
        keys.append(token)
if len(keys) != 1:
    raise RuntimeError("Expected exactly one public anon key in the published staging bundle")
public_key = keys[0]
feature_flag = re.search(r'informationCentre:[\w$]+\((true|false|void 0|"[^"]*")\)', bundle)
flag_value = feature_flag[1].strip('"') if feature_flag and feature_flag[1] != "void 0" else ""
env = {
    "VITE_SUPABASE_URL": supabase,
    "VITE_SUPABASE_ANON_KEY": public_key,
    "VITE_ENABLE_INFORMATION_CENTRE": flag_value,
}
env_path = scratch / "staging-client.env"
with os.fdopen(os.open(env_path, os.O_WRONLY | os.O_TRUNC | os.O_CREAT, 0o600), "w") as file:
    file.write("".join(f"export {name}={shlex.quote(value)}\n" for name, value in env.items()))
headers = {"apikey": public_key, "Accept": "application/json"}

def get_public_experience(name, params):
    body = json.loads(read_url(supabase + "/functions/v1/get-public-site-experience?" + urllib.parse.urlencode(params), headers=headers))
    scope = body["scope"]
    assert scope["phaseSlug"] == params["phase"], name
    (snapshot / f"{name}-experience.json").write_text(json.dumps(body))
    return name, scope

with ThreadPoolExecutor(max_workers=4) as pool:
    experiences = dict(pool.map(
        lambda item: get_public_experience(*item),
        [
            ("wamule", {"tenant": "wamule", "project": "wamule", "phase": "default"}),
            ("hopkins-grove", {"host": hopkins_host, "phase": "initial"}),
        ],
    ))

    def save_lots(item):
        name, scope = item
        params = {"tenant": scope["tenantSlug"], "project": scope["projectSlug"], "phase": scope["phaseSlug"]}
        if name == "hopkins-grove":
            params["host"] = hopkins_host
        body = json.loads(read_url(supabase + "/functions/v1/get-public-lots?" + urllib.parse.urlencode(params), headers=headers))
        (snapshot / f"{name}-lots.json").write_text(json.dumps(body))
        if body.get("fetchStatus") == 404:
            return name, 404, body["body"].get("error")
        assert body["project"]["slug"] == scope["projectSlug"], name
        return name, len(body["parcels"]), len(body.get("features") or []), body.get("map_experience_mode")
    lots = list(pool.map(save_lots, experiences.items()))

binding = json.loads(read_url(
    supabase + "/rest/v1/rpc/resolve_public_hostname",
    headers={**headers, "Content-Type": "application/json", "Authorization": "Bearer " + public_key},
    data=json.dumps({"p_hostname": hopkins_host}).encode(),
))
(snapshot / "hopkins-grove-host-binding.json").write_text(json.dumps(binding))
print(json.dumps({
    "publish_entry": match[1],
    "staging_project": staging_ref,
    "information_centre_flag": flag_value or "(default)",
    "public_map_payloads": lots,
    "scopes": experiences,
}, indent=2))


assets = snapshot / "assets"
assets.mkdir(exist_ok=True)
urls = set()
for slug in experiences:
    experience = json.loads((snapshot / f"{slug}-experience.json").read_text())
    lots = json.loads((snapshot / f"{slug}-lots.json").read_text())
    urls.update(url for url in [
        experience["company"]["logo_url"],
        lots.get("masterplan_image_url"),
        lots.get("masterplan_preview_url"),
        (lots.get("theme") or {}).get("cssUrl"),
    ] if url)

def store_asset(item):
    index, url = item
    parts = urllib.parse.urlsplit(url)
    assert parts.scheme == "https" and parts.netloc == f"{staging_ref}.supabase.co"
    content = read_url(url)
    filename = f"source-{index}{Path(parts.path).suffix}"
    (assets / filename).write_bytes(content)
    content_types = {".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".css": "text/css"}
    return url, {"file": filename, "contentType": content_types[Path(parts.path).suffix], "bytes": len(content)}

with ThreadPoolExecutor(max_workers=4) as pool:
    manifest = dict(pool.map(store_asset, enumerate(sorted(urls))))
(assets / "manifest.json").write_text(json.dumps(manifest))
