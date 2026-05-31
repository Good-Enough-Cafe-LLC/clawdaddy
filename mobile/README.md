# Clawdaddy Mobile

React Native app for Clawdaddy.

## Prerequisites

- Node.js ≥ 22.11.0
- Java 17
- Android SDK with:
  - `platform-tools`
  - `platforms;android-35`
  - `build-tools;35.0.0`
  - `ndk;27.1.12297006`

Install via `sdkmanager`:

```bash
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.1.12297006"
sdkmanager --licenses
```

## Setup

```bash
cd mobile

# Point at your Android SDK
echo "sdk.dir=/home/$(whoami)/android-sdk" > android/local.properties
# (or wherever your SDK lives — e.g. sdk.dir=/mnt/c/... on Windows)

npm install
npm run android
```

