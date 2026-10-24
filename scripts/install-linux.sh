#!/bin/sh
# Installs a Linux build of OnKey for this user (no root, nothing system-wide):
#   ~/.local/opt/onkey/bin/onkey           the app, with ONNX Runtime's CUDA provider libraries beside it
#   ~/.local/opt/onkey/lib/OnKey/          its resources (the learning models, THIRD_PARTY_NOTICES.md)
#   ~/.local/opt/onkey/cuda/               NVIDIA's CUDA 12 and cuDNN 9 runtime libraries (their pip wheels), for
#                                          learning on an NVIDIA GPU; without them OnKey learns on the CPU
#   ~/.local/bin/onkey                     the launcher (points the app at those libraries)
#   ~/.local/share/applications/onkey.desktop, and the icon
# Build first (npx tauri build --no-bundle, models fetched: scripts/fetch-models.sh). Needs uv or pip for the CUDA
# libraries (about 2 GB on disk); NO_CUDA=1 skips them.
set -e
repo="$(cd "$(dirname "$0")/.." && pwd)"
rel="$repo/src-tauri/target/release"
prefix="${PREFIX:-$HOME/.local/opt/onkey}"
[ -x "$rel/onkey" ] || { echo "install-linux: build OnKey first: npx tauri build --no-bundle" >&2; exit 1; }

mkdir -p "$prefix/bin" "$prefix/lib/OnKey/models/game" "$HOME/.local/bin" "$HOME/.local/share/applications" \
         "$HOME/.local/share/icons/hicolor/128x128/apps"
install -m 755 "$rel/onkey" "$prefix/bin/onkey"
# (copy-dylibs leaves links into ort's download cache: the files themselves)
for so in libonnxruntime_providers_shared.so libonnxruntime_providers_cuda.so; do
  [ -e "$rel/$so" ] && install -m 644 "$(readlink -f "$rel/$so")" "$prefix/bin/$so"
done
for m in crepe-full-b32.onnx UVR_MDXNET_KARA_2.onnx wav2vec2-base-960h-fp16.onnx game/encoder.onnx game/segmenter.onnx \
         game/estimator.onnx game/dur2bd.onnx game/bd2dur.onnx; do
  install -m 644 "$repo/src-tauri/models/$m" "$prefix/lib/OnKey/models/$m"
done
install -m 644 "$repo/THIRD_PARTY_NOTICES.md" "$prefix/lib/OnKey/THIRD_PARTY_NOTICES.md"
install -m 644 "$repo/src-tauri/icons/128x128.png" "$HOME/.local/share/icons/hicolor/128x128/apps/onkey.png"

# the versions ONNX Runtime 1.22's CUDA provider was built for (CUDA 12, cuDNN 9)
if [ -z "$NO_CUDA" ] && [ ! -e "$prefix/cuda/nvidia/cudnn/lib/libcudnn.so.9" ]; then
  wheels="nvidia-cuda-runtime-cu12==12.6.77 nvidia-cublas-cu12==12.6.4.1 nvidia-cufft-cu12==11.3.0.4 nvidia-cudnn-cu12==9.10.2.21 nvidia-cuda-nvrtc-cu12==12.6.77"
  if command -v uv >/dev/null; then
    uv pip install --python "$(command -v python3)" --target "$prefix/cuda" $wheels
  else
    python3 -m pip install --target "$prefix/cuda" $wheels
  fi
fi

cat > "$HOME/.local/bin/onkey" <<EOF
#!/bin/sh
# OnKey (installed by scripts/install-linux.sh): the app in $prefix, with ONNX Runtime's CUDA provider beside it and
# NVIDIA's CUDA libraries for learning on the GPU (OnKey learns on the CPU without them; ONKEY_NO_CUDA=1 makes it).
cuda="$prefix/cuda/nvidia"
LD_LIBRARY_PATH="$prefix/bin:\$cuda/cuda_runtime/lib:\$cuda/cublas/lib:\$cuda/cufft/lib:\$cuda/cudnn/lib:\$cuda/cuda_nvrtc/lib:\$cuda/nvjitlink/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH
exec "$prefix/bin/onkey" "\$@"
EOF
chmod 755 "$HOME/.local/bin/onkey"

cat > "$HOME/.local/share/applications/onkey.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OnKey
Comment=Learn to sing the songs you love
Exec=$HOME/.local/bin/onkey
Icon=onkey
Terminal=false
Categories=AudioVideo;Audio;Music;
StartupWMClass=audio.onkey.app
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
echo "OnKey installed: run onkey, or open it from your apps"
