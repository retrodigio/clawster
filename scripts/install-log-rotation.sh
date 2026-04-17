#!/usr/bin/env bash
# install-log-rotation.sh — Install size-based log rotation for Clawster daemon logs.
#
# Clawster itself does not rotate log files (launchd owns the FDs for clawster.log
# and clawster.error.log via StandardOutPath/StandardErrorPath). This script wires
# up the host OS log rotator so those files stay bounded.
#
# macOS: drops /etc/newsyslog.d/clawster.conf — rotates at 10MB, keeps 5 gz generations.
# Linux: drops /etc/logrotate.d/clawster with the same policy (copytruncate).
#
# Idempotent: re-running replaces the config in place. Safe to run repeatedly.

set -euo pipefail

LOG_DIR="${CLAWSTER_HOME:-$HOME/.clawster}/logs"
MAIN_LOG="$LOG_DIR/clawster.log"
ERR_LOG="$LOG_DIR/clawster.error.log"

mkdir -p "$LOG_DIR"

os="$(uname -s)"

case "$os" in
  Darwin)
    CONF="/etc/newsyslog.d/clawster.conf"
    TMP="$(mktemp -t clawster-newsyslog)"
    # Columns: logfilename [owner:group] mode count size(KB) when flags
    # size=10240KB (10MB), count=5, flags=ZG (gzip + signal group — but we have no
    # PID to signal since launchd owns the FD, so drop G and rely on the natural
    # reopen: newsyslog renames+truncates, and launchd's StandardOutPath keeps
    # writing. Use 'N' flag (no signal) which is the correct choice when the
    # writer cannot be signaled to reopen.
    cat > "$TMP" <<EOF
# Clawster daemon logs — installed by scripts/install-log-rotation.sh
# logfilename                                      [owner:group]  mode count size  when  flags
$MAIN_LOG                                          $(id -un):$(id -gn) 644  5     10240 *     ZN
$ERR_LOG                                           $(id -un):$(id -gn) 644  5     10240 *     ZN
EOF

    if [[ -f "$CONF" ]] && cmp -s "$TMP" "$CONF"; then
      echo "[clawster] $CONF already up to date — nothing to do."
      rm -f "$TMP"
    else
      echo "[clawster] Installing $CONF (requires sudo)..."
      sudo install -m 0644 -o root -g wheel "$TMP" "$CONF"
      rm -f "$TMP"
      echo "[clawster] Installed. newsyslog runs hourly via launchd (com.apple.newsyslog)."
      echo "[clawster] To test immediately: sudo newsyslog -nvv   (dry run)"
      echo "[clawster] To force rotation:    sudo newsyslog -F"
    fi
    ;;

  Linux)
    CONF="/etc/logrotate.d/clawster"
    TMP="$(mktemp)"
    cat > "$TMP" <<EOF
# Clawster daemon logs — installed by scripts/install-log-rotation.sh
$LOG_DIR/*.log {
    size 10M
    rotate 5
    compress
    missingok
    notifempty
    copytruncate
    su $(id -un) $(id -gn)
}
EOF

    if [[ -f "$CONF" ]] && cmp -s "$TMP" "$CONF"; then
      echo "[clawster] $CONF already up to date — nothing to do."
      rm -f "$TMP"
    else
      echo "[clawster] Installing $CONF (requires sudo)..."
      sudo install -m 0644 -o root -g root "$TMP" "$CONF"
      rm -f "$TMP"
      echo "[clawster] Installed. logrotate typically runs daily via cron/systemd timer."
      echo "[clawster] To test immediately: sudo logrotate -d $CONF   (dry run)"
      echo "[clawster] To force rotation:   sudo logrotate -f $CONF"
    fi
    ;;

  *)
    echo "[clawster] Unsupported OS: $os" >&2
    echo "[clawster] Configure your system log rotator manually — see CLAUDE.md > Operations." >&2
    exit 1
    ;;
esac
