# NovaWing v0.4.3 — Windows Real-Host Evidence

This acceptance used the locally packaged v0.4.3 installer only to exercise the installed Windows
host before official CI build. It is not the release artifact and was never uploaded to the public
feed. The official release candidate is exclusively the CI artifact from Build `35987215152`.

## Final installed-host acceptance

| Check | Result |
| --- | --- |
| Product version | `0.4.3` |
| hide → show ×10 | `PASS`, white screens `0/10` |
| close → Tray → show ×10 | `PASS`, white screens `0/10` |
| Combined white screens | `0/20` |
| Same BrowserWindow | `YES` |
| Host recreated | `NO` |
| Runtime recreated | `NO` |
| Navigation repeated | `NO` |
| Renderer recovery duplicated | `NO` |
| Updater Tray UI reachable | `YES` |
| Check against public latest v0.4.2 | `PASS`: returned to `IDLE`, no downgrade/download/install |

Observed lifecycle totals for the accepted installed process: one window (`windowId=1`,
`generation=1`), one Host, one Runtime, one initial navigation load, zero renderer-gone events,
zero presentation recoveries, and zero presentation failures. Window lifecycle diagnostics
recorded hide request/hidden and show request/native/ready transitions without secrets or prompts.

The final UI automation reused the same native Windows handle through all close/show cycles. The
surface measurement remained non-white on every cycle. Work Session state, Host ownership,
Runtime ownership, and database lifetime remained unchanged.

## Updater reachability

The installed application exposed the Tray-native action `检查更新`. With installed version
`0.4.3` and public latest `0.4.2`, the controller followed:

```text
IDLE → CHECKING → IDLE
candidate = null
download = not invoked
install = not invoked
```

This proves the user path is reachable and the downgrade policy remains fail-closed. No automatic
download, automatic install, silent install, or ordinary-quit install was observed.
