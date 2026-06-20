# Trivy ignore policy — scoped, REPORT-ONLY suppressions.
#
# Everything suppressed here still PRINTS in the scan output
# (TRIVY_SHOW_SUPPRESSED=true in ci.yml) — it's only removed from the
# exit-code gate. Every suppression is narrow and justified below. EVERY other
# OS/library HIGH/CRITICAL still fails the build.
#
# ── chromium* packages ──────────────────────────────────────────────────────
# The agent-base image bundles chromium for browser-using agents. Chromium ships
# a continuous stream of HIGH/CRITICAL browser CVEs, and there is always a window
# between a CVE's disclosure and Debian shipping the fixed package to
# bookworm-security. Those CVEs are:
#   - not actionable at PR time (we can't patch faster than Debian), and
#   - low-impact here: the agent runs sandboxed as an unprivileged user with no
#     path to root, and chromium is a tool it drives, not an exposed service.
# The daily apt cache-bust (ci.yml) + weekly agent-base rebuild keep the
# installed chromium tracking bookworm-security, so this is a safety net for the
# unpatched window — not a blanket "stop patching chromium".
#
# ── CVE-2026-42504 (Go stdlib, bundled `gh` binary) ─────────────────────────
# HIGH, net/textproto MIME-header decode DoS. Fixed in Go 1.25.11 / 1.26.4, but
# the finding is in the `gh` CLI binary (usr/bin/gh), which we install from the
# official cli.github.com apt repo. apt CANNOT clear this until GitHub re-releases
# `gh` rebuilt against the patched Go toolchain — so it's the same unpatched-window
# situation as chromium, just for a fixed-but-not-yet-rebuilt upstream binary.
# Low-impact here: `gh` is a CLI tool the sandboxed agent shells out to, not a
# service that decodes attacker-supplied MIME headers. Scoped to this one CVE in
# the Go stdlib package; DROP this rule once `apt-get upgrade` pulls a `gh` built
# with Go >= 1.26.4 (the agent-base rebuild will then pass without it).

# ── CVE-2026-12151 (undici, bundled in @anthropic-ai/claude-agent-sdk + CLI) ──
# HIGH, undici DoS via unbounded memory. Fixed upstream in undici 6.27.0 /
# 7.28.0 / 8.5.0. Our OWN direct dependency is already bumped to >= 8.5.0; the
# flagged copy is undici 6.26.0 vendored inside the globally-installed
# @anthropic-ai/claude-agent-sdk / claude CLI (npm install -g in
# Dockerfile.agent.base), which we cannot bump at PR time — only a new SDK/CLI
# release rebuilt on patched undici clears it. Same unpatched-window situation
# as the `gh` CLI rule above. Low-impact here: undici is the SDK's outbound HTTP
# client inside a sandboxed, unprivileged agent — not an exposed service.
# Scoped to this one CVE+package; DROP once the SDK/CLI ships undici >= 8.5.0
# (the weekly agent-base rebuild will then pass without it).

package trivy

default ignore = false

ignore {
	startswith(input.PkgName, "chromium")
}

ignore {
	input.VulnerabilityID == "CVE-2026-42504"
	input.PkgName == "stdlib"
}

ignore {
	input.VulnerabilityID == "CVE-2026-12151"
	input.PkgName == "undici"
}
