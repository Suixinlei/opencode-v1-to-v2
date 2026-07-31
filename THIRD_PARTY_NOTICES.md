# Third-party notices

This project implements compatibility behavior by studying pinned upstream
source versions. These notices preserve the relevant upstream attribution; they
do not imply endorsement or affiliation.

## OpenCode

- Project: [anomalyco/opencode](https://github.com/anomalyco/opencode)
- Pinned source: commit
  [`4da7bb44c84e013fa53e9c5d02ac753d1435c81a`](https://github.com/anomalyco/opencode/tree/4da7bb44c84e013fa53e9c5d02ac753d1435c81a)
- Relevant semantics: V1 history lowering and V2 session replay/projector
- License: MIT

```text
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vercel AI SDK

- Project: [vercel/ai](https://github.com/vercel/ai)
- Pinned source: tag
  [`ai@6.0.168`](https://github.com/vercel/ai/tree/ai%406.0.168)
- Relevant semantics: model-message block flushing around `step-start`
- License: Apache-2.0
- Copyright: 2023 Vercel, Inc.

The Apache License 2.0 text is included in this repository as
[LICENSE](LICENSE).

## Container runtime inputs

The optional migration target image repackages the official OpenCode `v1.18.9`
musl release assets on the digest-pinned Alpine base recorded in
[`docker/opencode-target/profile.json`](docker/opencode-target/profile.json).
The continuation proof runs its local mock model in the digest-pinned
[`oven/bun:1.3.13-alpine`](https://hub.docker.com/r/oven/bun) image. Bun's
upstream license and linked-library notices are published in
[`oven-sh/bun`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/LICENSE.md).
The upstream container layers and their license material are retained rather
than copied into this source repository.

The target image also installs checksum-pinned Alpine `libgcc` and `libstdc++`
`14.2.0-r6` runtime packages required by the official OpenCode musl binary.
Their package metadata identifies GPL-2.0-or-later and LGPL-2.1-or-later
licensing; GCC runtime library exceptions and corresponding source are
available from the [GCC project](https://gcc.gnu.org/onlinedocs/libstdc++/manual/license.html)
and the pinned [Alpine gcc package source](https://gitlab.alpinelinux.org/alpine/aports/-/tree/fbf60319be3bbaf6dd32ef55cc6fb7189e05c266/main/gcc).
