# crumbtrail-capacitor

Capacitor and Ionic SDK for Crumbtrail session capture.

A Capacitor app is a real web app running in a native WebView, so
[`crumbtrail-core`](../core) already captures console, errors, network, user
interactions and DOM replay with no help from this package. What this package
adds is the half of a phone bug that a WebView cannot see: which device and OS
build, which app version, whether the app was backgrounded mid request, what the
radio was doing, which deep link opened the screen, and which way the phone was
being held.

## Install

### Fastest path: the setup wizard

From your app's root:

```bash
npx crumbtrail
```

The wizard detects a Capacitor app by the presence of a `@capacitor/core`
dependency, installs `crumbtrail-core` and `crumbtrail-capacitor` with your
project's package manager, and prepends a `createCapacitorCrumbtrailAsync(...)`
block to your web entry: the module your root `index.html` loads for a Vite
based app (Ionic React, Ionic Vue, vanilla), or `src/main.ts` for Ionic Angular.

### By hand

```bash
npm install crumbtrail-core crumbtrail-capacitor
```

## Setup

```ts
import { createCapacitorCrumbtrailAsync } from "crumbtrail-capacitor";

createCapacitorCrumbtrailAsync({
  config: {
    httpEndpoint: "https://api.crumbtrail.ai",
    httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,
    remoteConfig: true, // take the kill switch and capture settings from the project
    service: "app",
  },
}).catch(() => {});
```

Put this at the top of your web entry, before your app bootstraps.

**Ionic Angular** has no browser safe environment variable mechanism. Add the
key to `src/environments/environment.ts` and read it from there instead:

```ts
import { environment } from "./environments/environment";

createCapacitorCrumbtrailAsync({
  config: {
    httpEndpoint: "https://api.crumbtrail.ai",
    httpAuthToken: environment.crumbtrailKey,
    remoteConfig: true,
    service: "app",
  },
}).catch(() => {});
```

### Why the async form

`createCapacitorCrumbtrailAsync` reads any session id persisted by a previous
launch before it initialises. Without that step every cold start opens a new
session, so a bug a user hits once a day arrives as a series of unrelated single
event sessions rather than one recurring signature.

A synchronous `createCapacitorCrumbtrail` is exported for cases where you cannot
await anything at startup. It gives up cross launch session continuity.

## Native context comes from optional plugins

Every plugin below is optional. The SDK detects what is installed, reports it,
and collects what it can. Installing none of them leaves you with web capture
only, which is the phone shaped blind spot this package exists to close.

| Plugin | What it adds |
| --- | --- |
| `@capacitor/app` | Foreground and background transitions, cold start launch URL, deep links, Android hardware back presses, OS restored plugin results |
| `@capacitor/device` | Model, manufacturer, OS version, WebView version, memory and disk, battery level |
| `@capacitor/network` | Connectivity at start and every change, including blips that produce no failed request |
| `@capacitor/preferences` | Session continuity across cold starts |
| `@capacitor/screen-orientation` | Portrait and landscape at the moment of the bug |

```bash
npm install @capacitor/app @capacitor/device @capacitor/network @capacitor/preferences
npx cap sync
```

`npx cap sync` is required. Without it the native projects do not pick the
plugins up, and the SDK reports them absent.

### Passing plugins explicitly

The SDK resolves plugins at runtime, which works in a development build.
Bundlers cannot see through that indirection, so a production build can drop the
modules and leave the lookup empty even though the plugins are installed and
working. If your app already imports them, pass them in:

```ts
import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { Network } from "@capacitor/network";
import { Preferences } from "@capacitor/preferences";

createCapacitorCrumbtrailAsync({
  plugins: { App, Device, Network, Preferences },
  config: { /* … */ },
}).catch(() => {});
```

## What gets captured

Native context is emitted as ordinary Crumbtrail events alongside everything the
web collectors produce, so it lands in the same session timeline.

| Event | When |
| --- | --- |
| `env` | Once at startup: runtime, device, app version, battery, locale. Again on each rotation. |
| `app-lifecycle` | Initial state, every foreground and background transition, native pause and resume, OS restored plugin results |
| `net-status` | Connectivity at startup and on every change |
| `navigation` | The cold start launch URL and every deep link opened while running |
| `nav-intent` | Android hardware or gesture back presses |
| `capacitor.capabilities` | Once at startup: which plugins were found |

Events are tagged with the concrete platform, `ios` or `android`, rather than a
flat `webview`, so a session can be filtered to one OS. That matters because
WKWebView and the Android System WebView disagree about storage eviction, back
navigation and media autoplay, and a large share of hybrid bugs are on exactly
one of them.

The Android back button listener observes the press and does nothing else. It
never calls `preventDefault` or exits the app.

## Defaults

The web collectors are left exactly as `crumbtrail-core` ships them, with two
exceptions: video and audio capture default to off. They are the most expensive
collectors to run and the most expensive to upload, and a phone is constrained
on battery and cellular data in a way a desktop tab is not. Turn them back on
through `config` if you want them.

## Configuration

```ts
createCapacitorCrumbtrailAsync({
  // Core capture config, passed straight through to Crumbtrail.init.
  config: { /* … */ },
  // Plugin instances, if you would rather not rely on runtime resolution.
  plugins: { App, Device },
  // Disable native collectors wholesale, or one at a time.
  collectors: { orientation: false },
  // Skip the startup capabilities report.
  reportCapabilities: false,
  // Override the reported platform tag.
  platform: "ios",
});
```

Collector names: `environment`, `appLifecycle`, `network`, `deepLinks`,
`backButton`, `orientation`.

## Teardown

```ts
const { logger } = await createCapacitorCrumbtrailAsync({ /* … */ });
await logger.stop(); // also removes every native plugin listener
```

## License

MIT
