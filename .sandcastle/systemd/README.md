# Sandcastle systemd setup

## Files

- `sandcastle.service` — long-running service (`Type=simple`) that polls for open issues, sleeps between checks, and auto-restarts on failure.

## Install (user-scoped, recommended)

```bash
# Copy unit into place
mkdir -p ~/.config/systemd/user/
cp .sandcastle/systemd/sandcastle.service ~/.config/systemd/user/

# Reload systemd
systemctl --user daemon-reload

# Enable and start the service
systemctl --user enable sandcastle.service
systemctl --user start sandcastle.service

# Verify
systemctl --user status sandcastle.service
journalctl --user -u sandcastle.service -f
```

## Install (system-wide)

```bash
sudo cp .sandcastle/systemd/sandcastle.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable sandcastle.service
sudo systemctl start sandcastle.service
```

## Behaviour

### Infinite poll loop

The service runs an **infinite `while (true)` loop** with a manual iteration counter. Each iteration:

1. Logs a **heartbeat** message (`{ iteration, msg: "Heartbeat — starting iteration" }`).
2. Polls for open issues (via `bd list --status open`).
3. If no open issues exist, goes back to sleep (`POLL_INTERVAL_MS`).
4. If open issues exist, runs the full plan → execute + review → merge pipeline for that batch.
5. After the pipeline completes (or if it fails), loops back to step 1.

There is **no iteration limit** — the daemon runs until stopped.

### SIGTERM / graceful shutdown

The daemon installs a `SIGTERM` handler that sets an internal `shouldShutdown` flag and logs:

```
SIGTERM received — will shut down after current iteration
```

On the next pipeline-complete check (after Phase 3), the flag is checked:
- If `shouldShutdown` is `true`, the daemon breaks out of the loop and exits cleanly.
- A **10-minute fallback timer** (`GRACEFUL_SHUTDOWN_MS`) is armed at the same time. If the current iteration takes longer than 10 minutes, the process force-exits with status 1.

The systemd unit declares `TimeoutStopSec=630` (10 minutes + 30 second buffer) to match this — systemd sends `SIGTERM`, waits 630 seconds, then sends `SIGKILL`.

### Restart policy

`Restart=on-failure` means systemd only restarts the process if it crashes unexpectedly. Normal shutdown after SIGTERM is treated as a clean exit — systemd will not restart it.

## Logs

### Format

The daemon uses **pino** for structured JSON logging. When stdout is not a TTY (the normal case under systemd), logs are emitted as JSON objects:

```json
{"level":30,"time":1712345678000,"pid":12345,"hostname":"host","iteration":42,"msg":"Heartbeat — starting iteration"}
```

When running interactively (e.g., `pnpm run sc` in a terminal), logs are pretty-printed with color via `pino-pretty`.

### Reading logs with journalctl

```bash
# Follow live logs
journalctl --user -u sandcastle.service -f

# Last 100 lines
journalctl --user -u sandcastle.service -n 100

# Since last boot
journalctl --user -u sandcastle.service -b

# Filter by time
journalctl --user -u sandcastle.service --since "10 min ago"

# Pretty-print JSON fields (select specific keys)
journalctl --user -u sandcastle.service -o json-pretty | grep '"iteration"'
```

## Configuration

### Poll interval

Edit `main.mts` (`POLL_INTERVAL_MS`) or add to the service file:

```ini
Environment="SANDCASTLE_POLL_MS=60000"
```

Then reload:

```bash
systemctl --user daemon-reload
systemctl --user restart sandcastle.service
```

### Graceful shutdown timeout

The timeout is set in the service file via `TimeoutStopSec=630` (seconds). Update both the service file and the `GRACEFUL_SHUTDOWN_MS` constant in `config.mts` if you need a longer window.

### Log level

Set `LOG_LEVEL` environment variable to `debug`, `warn`, `error`, or `fatal`:

```ini
Environment="LOG_LEVEL=debug"
```
