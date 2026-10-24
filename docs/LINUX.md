# OnKey on Linux (experimental)

The same app, built for Linux. What differs from macOS, all behind `cfg(target_os = "linux")`:

| | macOS | Linux |
|---|---|---|
| The music app's sound and the mic | Core Audio process tap + aggregate device (native/capture.swift) | PipeWire: one capture node with [music L, music R, mic] inputs, linked to the player's output streams and the mic, so both run on one graph clock (src/pw.rs) |
| What's playing, and control | AppleScript to Spotify, Apple Music, YouTube in a browser | MPRIS over D-Bus, for any desktop player: Feishin, Supersonic, Spotify, browsers… (src/mpris.rs, `Source::Mpris`) |
| Naming a new song | the app says, else ShazamKit | the player says (MPRIS); no Shazam. Learned songs are still recognised by their sound (OnKey's own fingerprint) |
| Learning models | Core ML | CUDA on an NVIDIA GPU (ONNX Runtime's CUDA provider, CUDA 12 / cuDNN 9), else the CPU (`pitch::load_accelerated`) |
| Take recordings (AAC) | Audio Toolbox | ffmpeg |
| Permissions | microphone, system audio recording, Automation | none to ask for |
| Share video, self-update | yes | not yet / no (build from source) |

## Build

On Fedora (a toolbox or distrobox is fine) you need Rust, Node, `webkit2gtk4.1-devel openssl-devel librsvg2-devel
alsa-lib-devel libayatana-appindicator-gtk3-devel pipewire-devel clang-devel dbus-devel`, and for the tests
`ffmpeg-free`. Then, as on macOS:

```sh
npm install && npm --prefix ui install
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements-models.txt   # (or uv; CPU torch is enough)
PYTHON=.venv/bin/python scripts/fetch-models.sh
npx tauri build --no-bundle
scripts/install-linux.sh
```

`install-linux.sh` installs for your user only: the app in `~/.local/opt/onkey`, NVIDIA's CUDA and cuDNN runtime
libraries from their pip wheels in `~/.local/opt/onkey/cuda` (about 2 GB; `NO_CUDA=1` skips them), a launcher at
`~/.local/bin/onkey` and a desktop entry. At run time OnKey needs PipeWire and ffmpeg.

## Use

Play a song in a player that publishes MPRIS (Feishin and Supersonic do, for a Navidrome or other Subsonic server).
OnKey follows the player that's playing; to follow one only, choose it in Settings → Music player. The first play
of a song is learned; from the second, the notes scroll and you're scored.

The log is `/tmp/onkey.log`. `ONKEY_NO_CUDA=1 onkey` learns on the CPU.

## Tests

`cargo test` runs as on macOS (the Mac-only tests are left out). By hand, with PipeWire and a player running:

```sh
cargo test --lib mpris::tests::live_players -- --ignored --nocapture        # the players and what they say
ONKEY_LIVE_APP=mpv cargo test --lib pw::tests::live_capture -- --ignored --nocapture   # capture 8 s from a player
ONKEY_LIVE_PLAYER=org.mpris.MediaPlayer2.mpv cargo test --lib mpris::tests::live_control -- --ignored --nocapture
```
