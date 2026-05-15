# Sandcastle systemd setup

## Files

- `sandcastle.service` — long-running service (`Type=simple`) that runs the
  Sandcastle daemon: an infinite poll loop that checks for open bead issues
  and executes the Plan → Execute (implement + review) → Merge pipeline.

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

The daemon runs an **infinite `while (true)` loop**. Each iteration:

1. Logs a **heartbeat** message (`"Heartbeat — starting iteration"`)
2. Polls for open bead issues (with a configurable sleep between polls when
   none are found — see **Adjust poll interval** below)
3. **Phase 1 — Plan**: runs the planner (AI-driven) to figure out which open
   issues can be worked on and generates a prompt for each
4. **Phase 2 — Execute + Review**: runs implementer + reviewer agents in
   parallel sandboxes for each planned issue
5. **Phase 3 — Merge**: merges accepted branches back to the main branch
6. If a graceful shutdown was requested (SIGTERM), exits cleanly after the
   current iteration completes
7. Otherwise, loops back to step 1

### SIGTERM / graceful shutdown

When the daemon receives **SIGTERM** (e.g. `systemctl stop sandcastle.service`):

1. A `shouldShutdown` flag is set — the current iteration is allowed to
   finish normally
2. A **10-minute fallback timer** starts (`GRACEFUL_SHUTDOWN_MS = 600000 ms`);
   if the iteration hasn't completed by then, `process.exit(1)` is forced
3. At the end of each iteration, the loop checks `shouldShutdown`; if true,
   it logs `"Graceful shutdown — iteration complete"` and exits cleanly
4. The systemd service file sets `TimeoutStopSec=630` (10 min + 30 s buffer)
   so systemd waits slightly longer than the fallback timer before sending
   SIGKILL

### Heartbeat logs

At the top of **every iteration** the daemon logs:

```
{"level":30,"time":1712345678901,"msg":"Heartbeat — starting iteration","iteration":42}
```

Use `journalctl` to follow the heartbeat in real time:

```bash
# Follow all logs
journalctl --user -u sandcastle.service -f

# Tail with human-readable timestamps
journalctl --user -u sandcastle.service --since "5 min ago" --no-pager

# Filter heartbeat messages
journalctl --user -u sandcastle.service -g "Heartbeat"
```

### Log format (pino)

All logs are emitted as **newline-delimited JSON** via the
[pino](https://getpino.io/) logger:

```json
{"level":30,"time":1712345678901,"pid":1234,"hostname":"host","msg":"Heartbeat — starting iteration","iteration":42}
```

- `level`: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
- `time`: Unix epoch milliseconds
- `pid` / `hostname`: added automatically by pino
- Extra fields depend on context (e.g. `iteration`, `count`, `err`, `branch`)

When running interactively (terminal with a TTY), logs are piped through
`pino-pretty` for coloured, human-readable output.

## Adjust poll interval

Edit `POLL_INTERVAL_MS` in `.sandcastle/src/config.mts` or set the
`SANDCASTLE_POLL_MS` environment variable in the service file:

```ini
Environment="SANDCASTLE_POLL_MS=60000"
```

Then reload:

```bash
systemctl --user daemon-reload
systemctl --user restart sandcastle.service
```

## Verifying the service is running

```bash
systemctl --user is-active sandcastle.service
systemctl --user status sandcastle.service
journalctl --user -u sandcastle.service --since "1 hour ago" --no-pager | grep Heartbeat
```
