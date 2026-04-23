# PearDrop Mobile

React Native client for hosting and downloading PearDrop sessions on iOS/Android.

## Dev Architecture

- UI is React Native.
- Runtime/transfer logic is delegated to the worker backend.
- Core transfer logic is shared with desktop through `../native-shared`.

## Local Run

```bash
npm install
npm run bundle:bare
npm run ios
```

Use `npm run android` for Android.

## Tests

```bash
npm test
```
