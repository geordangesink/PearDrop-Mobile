# Pear Drops Mobile (MVP)

React Native + `pear-mobile` worker app for hosting or downloading Pear Drops invites.

## Features

- starts worker where mobile updater/runtime is initialized
- shared backend module reused from desktop (`../native-shared`)
- upload files from mobile file picker
- download by invite link
- persistent transfer history in app worker storage

## Dev

```bash
npm install
npm run bundle:bare
npm run ios
```

Use `npm run android` for Android.


## Test

```bash
npm test
```

Release build commands:

```bash
npm run production:android
npm run production:ios
```
