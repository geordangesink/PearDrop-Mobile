## Setup OTA

How to setup Over The Air updates with Pear from an empty expo project

### Edit Code

#### `./metro.config.js`

Add `mergeConfig` and `getDefaultConfig` from `@react-native/metro-config` to metro config and merge configs if applicable.

```js
const { getDefaultConfig: getExpoConfig } = require('expo/metro-config')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

const expoConfig = getExpoConfig(__dirname)
const rnConfig = getDefaultConfig(__dirname)

module.exports = mergeConfig(rnConfig, expoConfig)
```

---

#### `./src/App.tsx`

Add the following at top of the file:

```js
import { useEffect } from 'react'
import { Platform } from 'react-native'
import { version, upgrade } from '../package.json'

async function earlyBootGuard() {
  const pending = await AsyncStorage.getItem('updatePending')
  const confirmed = await AsyncStorage.getItem('updateConfirmed')

  if (pending === 'true' && confirmed !== 'true') {
    const bundlePath = `${RNFS.DocumentDirectoryPath}/pear-runtime/upgrade runtime.${Platform.OS}.bundle`

    if (await RNFS.exists(bundlePath)) {
      await RNFS.unlink(bundlePath)
    }

    await AsyncStorage.multiRemove(['updatePending', 'updateConfirmed'])
    DevSettings.reload()
    return false
  }

  return true
}

async function bootstrap() {
  const ok = await earlyBootGuard()
  if (ok) {
    registerRootComponent(App)
  }
}

bootstrap()
```

Pass `version` and `upgrade` as opts to the PearRuntime constructor

and add the following at the top of your main component:

```js
useEffect(() => {
  async function confirmUpdate() {
    const pending = await AsyncStorage.getItem('updatePending')

    if (pending === 'true') {
      await AsyncStorage.multiSet([
        ['updateConfirmed', 'true'],
        ['updatePending', 'false']
      ])
    }
  }

  confirmUpdate()
}, [])
```

---

#### `(on iOS) ./ios/<appname>/AppDelegate.swift`

Run `npx expo prebuild --platform ios` if you dont have the ios folder yet.

Replace the bundleURL function with the following:

```swift
override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    let documentDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    let otaBundleURL = documentDirectory.appendingPathComponent("pear-runtime/upgrade/runtime.ios.bundle")

    if FileManager.default.fileExists(atPath: otaBundleURL.path) {
        return otaBundleURL
    }

    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
```

---

#### `(on android) ./android/app/src/main/java/com/anonymous/<appname>/MainApplication.kt`

Run `npx expo prebuild --platform anroid` if you dont have the ios folder yet.

Add this at the top of the file:

```kt
import java.io.File
```

And replace you `DefaultReactNativeHost` object with the following:

```kt
object : DefaultReactNativeHost(this) {

    override fun getPackages(): List<ReactPackage> =
      PackageList(this).packages.apply {
        // add custom packages here if needed
      }

    override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

    override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

    override fun getJSBundleFile(): String? {
      if (BuildConfig.DEBUG) {
        return super.getJSBundleFile()
      }

      val file = File(
        applicationContext.filesDir,
        "pear-runtime/upgrade/runtime.android.bundle"
      )

      return if (file.exists()) {
        file.absolutePath
      } else {
        super.getJSBundleFile()
      }
    }

    override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
}
```

### Distribute

#### `Setup`

Run the following to get a hash key:

```sh
pear touch

$ gaoyux1oteqzqy9qnutyoms4d7r4eqzau5csf9cg1hrp8pn4hnso
```

Prepend the hash key with `pear://` Put the hash key in the `package.json`'s `upgrade` field, and change the version field:

```json
"version": "1.0.2",
"upgrade": "pear://gaoyux1oteqzqy9qnutyoms4d7r4eqzau5csf9cg1hrp8pn4hnso",
```

---

#### `Prepare Payload`

Create the React-Native app bundle:

`ios`

```sh
npx react-native bundle --platform ios --dev false --entry-file index.ts --bundle-output dist/runtime.ios.bundle --assets-dest dist/assets
```

`android`

```sh
npx react-native bundle --platform android --dev false --entry-file index.ts --bundle-output dist/runtime.android.bundle --assets-dest dist/assets
```

Copy the package.json:

```sh
cp -f package.json dist/package.json
```

---

#### `Stare and Seed`

Stage the payload

```sh
pear stage pear://gaoyux1oteqzqy9qnutyoms4d7r4eqzau5csf9cg1hrp8pn4hnso dist
```

Seed the payload

```sh
pear seed pear://gaoyux1oteqzqy9qnutyoms4d7r4eqzau5csf9cg1hrp8pn4hnso
```

#### `Run production test`

```sh
npx expo run:ios --configuration Release
```

Then go through the `Prepare Payload` step and stage.

The payload shoudl still be seeded.

Restart the app to see the updated version
