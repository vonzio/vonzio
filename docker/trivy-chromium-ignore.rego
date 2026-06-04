# Trivy ignore policy — chromium CVEs are REPORT-ONLY.
#
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
# This policy removes chromium* packages from the Trivy exit-code gate. The scan
# step sets TRIVY_SHOW_SUPPRESSED=true so suppressed chromium CVEs still print in
# the report (report-only). EVERY other OS/library HIGH/CRITICAL still fails the
# build — this exemption is scoped to the chromium and chromium-common packages.

package trivy

default ignore = false

ignore {
	startswith(input.PkgName, "chromium")
}
