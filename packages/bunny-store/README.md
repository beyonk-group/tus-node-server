# `@beyonk/tus-bunny-store`

> 👉 **Note**: since 1.0.0 packages are split and published under the `@tus` scope. The
> old package, `tus-node-server`, is considered unstable and will only receive security
> fixes. Make sure to use the new packages.

## Contents

- [Install](#install)
- [Use](#use)
- [API](#api)
  - [`new BunnyStore(options)`](#new-bunnystoreoptions)
- [Types](#types)
- [Compatibility](#compatibility)
- [Contribute](#contribute)
- [License](#license)

## Install

In Node.js >=20.19.0, install with npm:

```bash
npm install @beyonk/tus-bunny-store @bunny.net/storage-sdk
```

## Use

```js
import { Server } from "@tus/server";
import { BunnyStore } from "@beyonk/tus-bunny-store";
import * as BunnyStorageSDK from "@bunny.net/storage-sdk";

const storageZone = BunnyStorageSDK.zone.connect_with_accesskey(
  BunnyStorageSDK.regions.StorageRegion.Falkenstein, // or your preferred region
  "your-storage-zone-name",
  "your-access-key"
);

const server = new Server({
  path: "/files",
  datastore: new BunnyStore({
    storageZone,
  }),
});
// ...
```

## API

This package exports `BunnyStore`. There is no default export.

### `new BunnyStore(options)`

Creates a new Bunny.net Edge Storage store by passing a storage zone instance.

#### `options.storageZone`

The storage zone instance created using `BunnyStorageSDK.zone.connect_with_accesskey()`

## Extensions

The tus protocol supports optional [extensions][]. Below is a table of the supported
extensions in `@beyonk/tus-bunny-store`.

| Extension                | `@beyonk/tus-bunny-store` |
| ------------------------ | ------------------ |
| [Creation][]             | ✅                 |
| [Creation With Upload][] | ✅                 |
| [Expiration][]           | ❌                 |
| [Checksum][]             | ❌                 |
| [Termination][]          | ❌                 |
| [Concatenation][]        | ❌                 |

## Types

This package is fully typed with TypeScript.

## Compatibility

This package requires Node.js >=20.19.0.

## Contribute

See
[`contributing.md`](https://github.com/tus/tus-node-server/blob/main/.github/contributing.md).

## License

[MIT](https://github.com/tus/tus-node-server/blob/master/license) ©
[tus](https://github.com/tus)

[extensions]: https://tus.io/protocols/resumable-upload.html#protocol-extensions
[creation]: https://tus.io/protocols/resumable-upload.html#creation
[creation with upload]: https://tus.io/protocols/resumable-upload.html#creation-with-upload
[expiration]: https://tus.io/protocols/resumable-upload.html#expiration
[checksum]: https://tus.io/protocols/resumable-upload.html#checksum
[termination]: https://tus.io/protocols/resumable-upload.html#termination
[concatenation]: https://tus.io/protocols/resumable-upload.html#concatenation
