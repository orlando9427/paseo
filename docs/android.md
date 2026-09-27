# Android

## App variants

Controlled by `APP_VARIANT` in `packages/app/app.config.js` (vanilla Expo, no custom Gradle plugin):

| Variant       | App name    | Package ID       |
| ------------- | ----------- | ---------------- |
| `production`  | Paseo       | `sh.paseo`       |
| `development` | Paseo Debug | `sh.paseo.debug` |

EAS profiles: `development`, `production`, and `production-apk` in `packages/app/eas.json`.

`development` uses Android `debug`.

## Version codes

`packages/app/native-release-version.js` is the single definition of native and F-Droid version-code math. Do not re-derive these numbers anywhere else — a drifted copy produces changelog files that match no published APK, and nothing fails loudly.

The base version code comes from the package version:

```text
major * 1_000_000 + minor * 1_000 + patch
```

Prerelease metadata is ignored, so `0.1.102-beta.1` and `0.1.102` both produce `1102`. The same value is used as the iOS `buildNumber` because `packages/app/eas.json` uses EAS's local app version source. Do not re-enable EAS remote version counters or Android `autoIncrement`; F-Droid and other source-based builders need the native build number to be visible in the repo.

The formula reserves three digits each for minor and patch. If either reaches `1000`, change the formula before cutting that release.

## Prerequisites (local dev)

Local Android builds run on macOS (or Linux) and need the Android toolchain, pinned in `.tool-versions` (`java 21`, `android-sdk 21.0`) and wired up by `.mise.toml` (which derives `ANDROID_HOME` and the command-line tool paths from the `android-sdk` entry). With [mise](https://mise.jdx.dev):

```bash
mise install        # java 21 + android-sdk 21.0 command-line tools
```

> **Pin a real `android-sdk` version, not `latest`.** The mise `android-sdk` plugin's `latest` resolved to the ancient `1.0` bundle, whose `sdkmanager` (3.6.0) predates the `emulator` package and fails with `Failed to find package emulator`. `21.0` ships a current `sdkmanager`. If you bump it, update only the version in `.tool-versions`; `.mise.toml` derives its paths from that tool entry.

`mise install` only lays down the command-line tools. Install the rest and create an emulator. On Apple Silicon:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7
emulator @paseo     # start it; leave running
```

On an Intel Mac, use the `x86_64` system image:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;x86_64" -d pixel_7
emulator @paseo     # start it; leave running
```

Gradle auto-fetches the platform/build-tools it needs once licenses are accepted, so adjust `android-35` only if it asks for a different level.

### If `mise.run` or `*.jdx.dev` are unreachable

Some networks block the Cloudflare-fronted `jdx.dev` subdomains outright (DNS resolves, the TCP handshake just hangs) — `mise install`'s own `mise.run` bootstrap and its Java/Android plugins both depend on them, with no working alternate mirror. Skip mise entirely for Java and the Android SDK in that case:

```bash
sudo apt-get install -y openjdk-21-jdk   # or your platform's package manager
```

Android's cmdline-tools come straight from `dl.google.com`, unaffected by a `jdx.dev` block:

```bash
curl -o /tmp/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
mkdir -p ~/android-sdk/cmdline-tools
unzip /tmp/cmdline-tools.zip -d ~/android-sdk/cmdline-tools
mv ~/android-sdk/cmdline-tools/cmdline-tools ~/android-sdk/cmdline-tools/latest

export ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$HOME/android-sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

The download path is `/android/repository/`, not `/android/repo/` — the latter 404s. Check `https://dl.google.com/android/repository/repository2-1.xml` for the current `commandlinetools-linux-*_latest.zip` name if this one has aged out.

## Local build + install

From repo root:

```bash
npm run android:development    # Debug build
npm run android:production     # Release build
npm run android:clear          # Remove generated Android project
```

For a production-ID release APK that local Android profiling tools can attach to:

```bash
PASEO_PROFILE_BUILD=1 npm run android:production
```

This keeps the `sh.paseo` package id, release Hermes bundle, and release optimizations. It adds
`<profileable android:shell="true" />` and enables local Android trace markers for workspace mounts
and daemon WebSocket traffic. The markers contain message types and sizes, never payload contents,
and emit only while a system trace records the `sh.paseo` app (`perfetto -a sh.paseo ...`).

Or from `packages/app`:

```bash
# Debug
npx cross-env APP_VARIANT=development expo prebuild --platform android --clean --non-interactive
npx cross-env APP_VARIANT=development expo run:android --variant=debug

# Release
npx cross-env APP_VARIANT=production expo prebuild --platform android --clean --non-interactive
npx cross-env APP_VARIANT=production expo run:android --variant=release

# Clear generated Android project
rm -rf android
```

`npm run android:production` only runs `build:client` before prebuild, not a full workspace build. A package with its own native-module build step — `@getpaseo/expo-two-way-audio` compiles via `tsc` into `build/` — can be silently unbuilt, and the release Gradle build then fails late, inside `createBundleReleaseJsAndAssets`, with an unresolved `main` field. Run `npm run build --workspaces --if-present` (or `npm run build --workspace=<package>` for just the one) before prebuild if you hit that.

`expo run:android --variant=release` requires a connected device or running emulator and fails immediately without one. To produce the release APK with neither, run Gradle directly against the generated project instead:

```bash
cd packages/app/android
./gradlew :app:assembleRelease -x lint -x lintVitalAnalyzeRelease -x lintVitalRelease -x generateReleaseLintModel -x generateReleaseLintVitalModel
```

This is the same Gradle command `eas.json`'s `production-apk` profile uses. `android/app/build.gradle`'s `release` build type signs with `signingConfigs.debug` (the same `debug.keystore` as the `debug` build type) unless you configure a real release keystore, so this produces an installable APK with no interactive signing step — unlike an EAS cloud build, which prompts to generate a keystore on first run. The APK lands at `android/app/build/outputs/apk/release/app-release.apk`.

Installing over an existing build signed with a different key (for example the Play Store release) fails with a signature mismatch (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Uninstall the other build first.

Any Linux host with the prerequisites above works the same way over SSH — clone the branch, install Node/Java/the SDK, then run the same `npm install`, `npm run build --workspaces --if-present`, `expo prebuild`, and `gradlew :app:assembleRelease` steps. Run the Gradle step inside `tmux` or `screen` so it survives a disconnect. Copy the finished APK back with `scp`.

Native compilation (CMake for Reanimated, Skia, gesture-handler, and friends) is the slowest and heaviest part — it is the reason EAS's `production-apk` profile requires the `large` resource class, and by default it builds all four ABIs (`armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`) in parallel with Gradle workers scaled to CPU count. On a machine with many cores but limited RAM (WSL2 in particular, where the VM's memory ceiling is a fraction of the host's), this can spike hard enough to crash the VM outright rather than fail gracefully. If you only need the APK for one device, cut both dimensions of that parallelism:

```bash
./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --max-workers=6 \
  -x lint -x lintVitalAnalyzeRelease -x lintVitalRelease -x generateReleaseLintModel -x generateReleaseLintVitalModel
```

`-PreactNativeArchitectures` overrides `gradle.properties`' `reactNativeArchitectures` for one build, cutting native-compile work roughly 4x. `--max-workers` caps Gradle's own task concurrency (default is CPU count, which on a 16-core box means 16 concurrent compiler/Kotlin/CMake processes). Metro's bundler workers are a separate pool and don't follow either flag; cap them with `PASEO_METRO_MAX_WORKERS=<n>` (read by `packages/app/metro.config.cjs`), unset by default so normal builds and CI are unaffected. On WSL2, also raise the VM's own memory ceiling — it defaults to 50% of host RAM — via `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=20GB
swap=8GB
vmIdleTimeout=-1
```

`vmIdleTimeout=-1` matters independently of the RAM sizing: WSL2 shuts the whole VM down (killing background builds, `nohup` included) after its default ~1 minute of no connected client, which can look identical to an OOM crash if a terminal window closes mid-build. Changes to `.wslconfig` only take effect on the next `wsl --shutdown` + restart, so make them before a long build, not during one.

## Running on an emulator against a worktree daemon

`npm run android` builds and installs the dev client, but two connections have to reach your Mac from inside the emulator — Metro (the JS bundle) and the Paseo daemon — and **the emulator does not share the host's loopback**: `localhost` inside the emulator is the emulator itself. Reach the host at `10.0.2.2` (the standard AVD's host alias) for both:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2 \
  EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:$PASEO_SERVICE_DAEMON_PORT \
  npm run android
```

- **`REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2`** — without it, Expo bakes your Mac's LAN IP into the dev client's Metro URL, which the emulator can't route to, and the app dies with `Failed to connect to /<lan-ip>:8081` before any JS loads.
- **`EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:<port>`** — the client's daemon endpoint (`packages/app/src/runtime/host-runtime.ts`); when unset it defaults to `localhost:6767`, the production daemon. Use `$PASEO_SERVICE_DAEMON_PORT` for a worktree daemon running as a Paseo service, or `6768` for a standalone `npm run dev:server`. It is inlined into the JS bundle at Metro bundle time, so set it on the build command and clear the Metro cache (`npx expo start -c`) if a change doesn't take.

**Alternative — `adb reverse` + `localhost`** (if `10.0.2.2` misbehaves):

```bash
adb reverse tcp:8081 tcp:8081
adb reverse tcp:$PASEO_SERVICE_DAEMON_PORT tcp:$PASEO_SERVICE_DAEMON_PORT
REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  EXPO_PUBLIC_LOCAL_DAEMON=localhost:$PASEO_SERVICE_DAEMON_PORT \
  npm run android
```

This is the Android counterpart of the iOS local-simulator flow in [development.md](development.md): on iOS the simulator shares the Mac's loopback so `localhost:<port>` works directly; on Android you need `10.0.2.2` or `adb reverse`.

## Inverted timeline selection

Android focus and selection visibility requests must not reposition inverted timelines. The
`modules/paseo-scroll` package keeps React Native's scroll manager interface and returns zero for
child-reveal scroll calculations when the vertical scale is inverted. Dragging and explicit scroll
commands still work; non-inverted scroll views keep Android's default behavior.

Register this package before React Native's core package through its Expo config plugin. Normal
Android builds use the prebuilt `react-android` library, so patching Java under `node_modules` does
not change the shipped scroll view. Keep this behavior in the app's compiled native module.

## F-Droid / source-only Android builds

F-Droid builds should set `PASEO_FDROID_BUILD=1` when running Expo prebuild:

```bash
cd packages/app
PASEO_FDROID_BUILD=1 APP_VARIANT=production npx expo prebuild --platform android --clean --non-interactive
cd android
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

The flag must be present for both prebuild and Gradle because Gradle starts Metro for the release bundle. Keep the source build serial and daemon-free as shown above: compiling every Expo module can exhaust memory when Gradle workers run in parallel. The profile enables source-built Expo modules, excludes the proprietary camera, Firebase notification, and Expo development-client native modules, disables Gradle dependency metadata, and substitutes JavaScript stubs for camera and notifications. The resulting app supports direct and pasted-link pairing but not QR scanning or push notifications.

For a single-ABI APK, pass React Native's architecture property to Gradle:

```bash
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

Supported values are `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`. The F-Droid profile filters native libraries to that ABI and changes the APK version code to `baseVersionCode * 10 + abiSuffix`, where the suffixes are ordered `1` through `4` in that same sequence. F-Droid metadata should use four build blocks with `VercodeOperation` entries `10 * %c + 1` through `10 * %c + 4` and pass the matching `reactNativeArchitectures` value in each build command. Builds without a single architecture keep the base version code.

Keep the excluded npm packages installed. Normal builds use them, while the F-Droid profile removes only their Android native modules and config plugins. Paseo always applies `expo-gradle-jvmargs` with `-Xmx4096m` and `-XX:MaxMetaspaceSize=1024m` so local Expo prebuilds have enough Gradle heap whether they use precompiled AARs or source-built Expo modules.

The EAS `production-apk` profile uses the large Android resource class. Release builds compile the native ABIs and run Hermes bundling in the same Gradle invocation; the default worker can exhaust its remaining memory and kill Hermes with exit code 137 even when Gradle's own heap is correctly sized.

### F-Droid store metadata

F-Droid reads the store listing from `fastlane/metadata/android/<locale>/` **at the repo root**. This location provides the best compatibility with the F-Droid release process.

```text
fastlane/metadata/android/
├── en-US/                      (F-Droid fallback locale, mandatory)
│   ├── title.txt               (<=50 chars)
│   ├── short_description.txt   (<=80 chars)
│   ├── full_description.txt    (<=4000 chars, limited HTML)
│   ├── images/
│   │   ├── icon.png            (512x512)
│   │   ├── featureGraphic.png  (1024x500)
│   │   └── phoneScreenshots/   (1.png, 2.png, ...)
│   └── changelogs/             (generated — see below)
├── ja/
└── zh-CN/
```

Locale directories generally match `packages/app/src/i18n/locales.ts`, but note that `en` becomes `en-US`.

F-Droid changelogs are generated from `CHANGELOG.md`. Run `npm run fdroid:changelogs`; `npm run fdroid:changelogs:check` verifies without writing. It is wired into the npm `version` lifecycle, so a release picks it up automatically and `git add -A` stages the result.

One changelog must be generated per-ABI-split, so each version will create **four** identical version-coded entries. F-Droid caps changelogs at 500 characters, so the generator strips some content and adds a link to the full notes.

Stable sync fails loudly if `CHANGELOG.md` has no entry for the version being cut. That is intentional — the release checklist requires the entry to be committed first, so an abort here means the checklist was skipped.

Because the generator runs off the version in `package.json`, it must run **before** the tag is created: fdroidserver only reads metadata from the tag it builds, so the file for version N has to exist in the commit N points at.

Beta releases are an explicit no-op: they do not create or rewrite F-Droid changelog files. Stable releases and promotions generate the four ABI entries from their final changelog.

### React version lockstep

Keep `react` and `react-dom` pinned to the React version embedded by the current `react-native` release. React Native `0.81.x` embeds `react-native-renderer` `19.1.0`, so `packages/app` must use React `19.1.0`. Bumping React to a newer patch can build successfully but crash at JS startup on Android with `Incompatible React versions`, leaving the app on the native splash screen.

## Screenshots

```bash
adb exec-out screencap -p > screenshot.png
```

## Cloud build + submit (EAS)

### Building under your own account (personal forks)

`packages/app/app.config.js`'s `extra.eas.projectId` and `owner` point at Paseo's own EAS project. `eas build` on a fork without access to that project fails with "Entity Not Authorized". To build under your own account: remove both fields, run `eas init --force` (it prompts for which account when you belong to more than one), then add the printed `projectId` and your account name back into `app.config.js` yourself — dynamic (`.js`) config isn't rewritten automatically the way static `app.json` is. Keep this change local; committing your personal `projectId`/`owner` over Paseo's breaks EAS builds for everyone else on the branch.

The `production`/`production-apk` profiles set `resourceClass: "large"` in `eas.json`, which needs a paid EAS plan (Production/Enterprise/On-Demand) — see the note on why in [F-Droid / source-only Android builds](#f-droid--source-only-android-builds) below. A free personal account hits this paywall before it hits a Hermes OOM; use the [local build](#local-build--install) instead if you don't want to pay for it.

Stable tag pushes like `v0.1.0` trigger:

- The EAS GitHub app on Expo servers (iOS + Android production builds + store submit). There is no workflow file in this repo for it.
- `.github/workflows/android-apk-release.yml` on GitHub Actions (APK asset on GitHub Release).

iOS auto-submits to App Store review via a Fastlane lane after EAS uploads to TestFlight. Android auto-submits to the Play Store via EAS-managed credentials.

Beta tags like `v0.1.1-beta.1` only trigger the GitHub APK workflow. They publish a GitHub prerelease APK for testing and do not submit to the stores.

`android-v*` tags also trigger only the GitHub APK workflow — useful when you want to ship an APK without going through stores. The GitHub APK workflow supports `workflow_dispatch` with an existing `tag` input so you can rebuild without cutting a new tag.

### Useful commands

```bash
cd packages/app

# Recent builds
npx eas build:list --limit 10 --non-interactive --json | jq '.[] | {platform, status, appVersion, gitCommitHash}'

# Inspect a build (the printed `Logs` URL opens the build's Expo dashboard page,
# which has a Submissions section showing the auto-submit to the Play Store).
npx eas build:view <build-id>
```

The Play Console (Internal testing → Production tracks) is the final confirmation that the binary reached the store.

See [docs/release.md](release.md) for the full mobile-build babysitting flow.
