#!/usr/bin/env bash
# User Agent container entrypoint. Runs as `parley` (see Dockerfile USER).
# Responsibilities, in order:
#   1. Refuse to start if AXL identity isn't mounted (file-shaped secret per
#      deployment.md §3 — losing it means a new pubkey, which breaks ENS).
#   2. Sync Hermes config (SOUL.md + skills/) from /opt/parley/hermes-config
#      into ~/.hermes/ so Hermes picks them up. Source-of-truth is the repo.
#   3. Hand off to supervisord, which manages AXL + sidecar + Hermes.

set -euo pipefail

AXL_PEM_PATH="${AXL_PRIVATE_KEY_PATH:-/run/parley/axl.pem}"
HERMES_HOME="${HOME}/.hermes"
HERMES_CONFIG_SRC="/opt/parley/hermes-config"

if [[ ! -f "${AXL_PEM_PATH}" ]]; then
  echo "[user-agent] FATAL: AXL identity not found at ${AXL_PEM_PATH}." >&2
  echo "[user-agent] Mount the user-agent's axl.pem into the container — see compose.yml." >&2
  echo "[user-agent] Generate a new one with: openssl genpkey -algorithm ed25519 -out axl.pem" >&2
  exit 1
fi

if [[ -z "${MINIAPP_BASE_URL:-}" ]]; then
  echo "[user-agent] FATAL: MINIAPP_BASE_URL is not set." >&2
  echo "[user-agent] The agent embeds this URL in every web_app button it sends to" >&2
  echo "[user-agent] Telegram. Set it in .env to your HTTPS tunnel (cloudflared/ngrok)" >&2
  echo "[user-agent] or production hostname, then restart this container." >&2
  exit 1
fi

mkdir -p "${HERMES_HOME}/skills"

# Stage Hermes config + procedural memory.
#
# Hermes reads `agent.system_prompt` from ~/.hermes/config.yaml — there's no
# SOUL.md convention. So we INLINE SOUL.md's content into config.yaml at
# entrypoint time. Editing SOUL.md in the repo + restarting the container
# is enough; no Dockerfile rebuild required.
#
# Skills/ stays as separate files (Hermes' skill loader does discover those).

cp -f  "${HERMES_CONFIG_SRC}/SOUL.md" "${HERMES_HOME}/SOUL.md"
cp -Rf "${HERMES_CONFIG_SRC}/skills/." "${HERMES_HOME}/skills/"

python3 - "${HERMES_CONFIG_SRC}/config.yaml" \
            "${HERMES_CONFIG_SRC}/SOUL.md" \
            "${HERMES_HOME}/config.yaml" <<'PY'
import os, re, sys, yaml, pathlib
src_cfg, src_soul, dst_cfg = map(pathlib.Path, sys.argv[1:4])
cfg = yaml.safe_load(src_cfg.read_text()) or {}

# Substitute ${VAR} placeholders inside SOUL.md with the agent's actual env
# values before stuffing into the system prompt. The agent doesn't have access
# to the process env at runtime — it only sees what's in the prompt — so we
# bake the concrete URL/etc. in here. Crucial for MINIAPP_BASE_URL: without
# this the agent prints the literal "${MINIAPP_BASE_URL}" or, worse,
# hallucinates a placeholder hostname like "parley.example.com" from a
# nearby example.
soul = src_soul.read_text()
soul = re.sub(
    r'\$\{([A-Z_][A-Z0-9_]*)\}',
    lambda m: os.environ.get(m.group(1), m.group(0)),
    soul,
)
cfg.setdefault("agent", {})["system_prompt"] = soul.strip()
dst_cfg.write_text(yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))
print(f"[user-agent] system_prompt loaded ({len(soul)} chars from SOUL.md, "
      f"MINIAPP_BASE_URL={os.environ.get('MINIAPP_BASE_URL', '<UNSET>')})")
PY

# Patch Hermes' session-context prompt builder so it always emits the
# numeric `**User ID:**` line for Telegram users, not just when no
# user_name is set. Hermes' default behavior shows EITHER `User: <name>`
# OR `User ID: <id>`, never both — but real Telegram users always have
# names, so the numeric ID is suppressed and the agent has no way to
# learn the chat_id it needs for `mcp_parley_tg_send_webapp_button`. The
# tool fails with "chat not found" because the LLM hallucinates IDs to
# fill the gap. This idempotent in-place patch makes the User ID line
# appear alongside the user name.

python3 - <<'PY'
import pathlib, re, sys
target = pathlib.Path("/home/parley/.hermes/hermes-agent/gateway/session.py")
src = target.read_text()
if "_PARLEY_PATCH_USER_ID_ALWAYS" in src:
    print("[user-agent] session.py User ID patch already applied")
    sys.exit(0)

orig = (
    "    elif context.source.user_name:\n"
    "        lines.append(f\"**User:** {context.source.user_name}\")\n"
    "    elif context.source.user_id:\n"
)
patched = (
    "    elif context.source.user_name:\n"
    "        lines.append(f\"**User:** {context.source.user_name}\")\n"
    "        # _PARLEY_PATCH_USER_ID_ALWAYS: also emit User ID alongside\n"
    "        # the name so MCP tools needing a chat_id can read it.\n"
    "        if context.source.user_id:\n"
    "            _uid = context.source.user_id\n"
    "            if redact_pii:\n"
    "                _uid = _hash_sender_id(_uid)\n"
    "            lines.append(f\"**User ID:** {_uid}\")\n"
    "    elif context.source.user_id:\n"
)
if orig not in src:
    print("[user-agent] WARN: session.py shape changed; User ID patch skipped",
          file=sys.stderr)
    sys.exit(0)
target.write_text(src.replace(orig, patched, 1))
print("[user-agent] session.py patched: User ID always exposed alongside user_name")
PY

# Ensure AXL's expected key location matches the config. Skip when the
# mount already lands at the canonical path (avoids `ln: same file` errors).
if [[ "${AXL_PEM_PATH}" != "/run/parley/axl.pem" ]]; then
  ln -sf "${AXL_PEM_PATH}" /run/parley/axl.pem
fi

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/parley.conf
