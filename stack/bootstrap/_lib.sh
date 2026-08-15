#!/usr/bin/env bash
# Shared helpers for backend-skeleton stack bootstrap scripts. Copied into the target repo
# alongside the script that sources it (see stack/apply.mjs) -- self-contained, no dependency
# on backend-skeleton being installed at runtime.

# Polls a JSON endpoint (e.g. ngrok's local API) once a second until it returns a body
# containing `"public_url"`, or times out. Whole-second granularity is deliberate -- a tunnel
# typically comes up in 1-3s, and this only needs to be "prompt", not "instant".
wait_for_tunnel() {
	local url="$1" timeout_s="$2" waited=0
	while [ "$waited" -lt "$timeout_s" ]; do
		local body
		# --connect-timeout/--max-time bound EACH poll attempt -- without these, a port that
		# accepts-but-never-responds (or certain firewalled/unusual ports) can make a single
		# curl call hang far longer than $timeout_s, defeating the outer loop's bound entirely.
		body=$(curl -sf --connect-timeout 2 --max-time 3 "$url" 2>/dev/null || true)
		if [ -n "$body" ] && echo "$body" | grep -q '"public_url"'; then
			echo "$body"
			return 0
		fi
		sleep 1
		waited=$((waited + 1))
	done
	return 1
}

# Extracts the first https public_url from an ngrok /api/tunnels response. grep+sed, not a
# JSON parser -- the response shape (`"public_url":"https://..."` as a flat string field) is
# stable enough for this and avoids a jq/python dependency in a script meant to be portable.
extract_https_url() {
	echo "$1" | grep -o '"public_url":"https://[^"]*"' | head -1 | sed -E 's/.*"(https:\/\/[^"]*)".*/\1/'
}

# Idempotent: replaces `KEY=...` if the line already exists, appends a new line if not.
env_upsert() {
	local file="$1" key="$2" value="$3"
	touch "$file"
	if grep -q "^${key}=" "$file" 2>/dev/null; then
		local tmp="${file}.$$.tmp"
		sed "s|^${key}=.*|${key}=${value}|" "$file" > "$tmp" && mv "$tmp" "$file"
	else
		echo "${key}=${value}" >> "$file"
	fi
}

# Appends `value` to a comma-separated `KEY=a,b,c` value, only if not already present verbatim
# (used for AUTH_LOGIN_ALLOWED_ORIGINS -- re-running the tunnel script with the same ephemeral
# URL, or restarting with a reserved domain that's already listed, must not duplicate entries).
env_append_unique() {
	local file="$1" key="$2" value="$3"
	touch "$file"
	local current
	current=$(grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2-)
	if [ -z "$current" ]; then
		env_upsert "$file" "$key" "$value"
		return
	fi
	case ",$current," in
		*",$value,"*) return ;;
	esac
	env_upsert "$file" "$key" "${current},${value}"
}
