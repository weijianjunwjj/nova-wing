# NovaWing v0.4.4 — Real-Host Boundary Evidence

## Installed baseline preservation

The Windows host remains on the already installed public v0.4.3 build. The v0.4.4 CI installer was
downloaded only as an immutable audit input, independently extracted without execution, and was not
installed or launched.

```text
WINDOWS_UPDATE_E2E = NOT_RUN
MANUAL_V0.4.4_INSTALL = NOT_PERFORMED
INSTALLED_PUBLIC_BASELINE = v0.4.3 (preserved)
```

This is deliberate: the first real auto-update E2E must begin from the existing public v0.4.3 only
after v0.4.4 is successfully published. This release task stops after publication and does not run
that E2E.

## CI packaged-host evidence

Desktop Build `36010798923` passed packaged-host smoke on Windows x64 and macOS arm64, including
startup, Host/Runtime compatibility, background lifecycle, strict cleanup, explicit updater feed
behavior, distribution identity, and notification gates. These checks validate the release
candidate without replacing the later public-feed update E2E.
