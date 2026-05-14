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

- The service runs **continuously**.
- It sleeps for `POLL_INTERVAL_MS` (default 5 min, set via `SANDCASTLE_POLL_MS` env var) between checks.
- After waking, it queries `bd list --status open`. If there are no open issues, it goes back to sleep immediately.
- If there are open issues, it runs the planner + implement + review + merge cycle (up to `MAX_ITERATIONS` times), then goes back to sleep.
- `Restart=on-failure` means systemd only intervenes if the process crashes — the inner loop handles all normal sleep/wake logic.

## Adjust poll interval

Edit `main.mts` (`POLL_INTERVAL_MS`) or add to the service file:

```ini
Environment="SANDCASTLE_POLL_MS=60000"
```

Then reload:

```bash
systemctl --user daemon-reload
systemctl --user restart sandcastle.service
```
