#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-0.1.0}"
RELEASE_ROOT="${ROOT}/release"
SOURCE_NAME="browser-extractor-${VERSION}-source"
SOURCE_STAGE="${RELEASE_ROOT}/${SOURCE_NAME}"
SOURCE_ARCHIVE="${RELEASE_ROOT}/${SOURCE_NAME}.tar.gz"

case "$(uname -s)" in
  Linux*)
    PLATFORM="linux"
    ARCHIVE_FORMAT="tar.gz"
    EXECUTABLE_SUFFIX=""
    ;;
  Darwin*)
    PLATFORM="macos"
    ARCHIVE_FORMAT="zip"
    EXECUTABLE_SUFFIX=""
    ;;
  MINGW* | MSYS* | CYGWIN*)
    PLATFORM="windows"
    ARCHIVE_FORMAT="zip"
    EXECUTABLE_SUFFIX=".exe"
    ;;
  *)
    printf '%s\n' "Unsupported release platform: $(uname -s)"
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64)
    ARCH="x86_64"
    ;;
  aarch64 | arm64)
    ARCH="arm64"
    ;;
  *)
    printf '%s\n' "Unsupported release architecture: $(uname -m)"
    exit 1
    ;;
esac

SERVER_NAME="browser-extractor-server-${PLATFORM}-${ARCH}"
CLI_NAME="browser-extractor-cli-${PLATFORM}-${ARCH}"
EXTENSION_NAME="browser-extractor-extension"
SERVER_STAGE="${RELEASE_ROOT}/${SERVER_NAME}"
CLI_STAGE="${RELEASE_ROOT}/${CLI_NAME}"
EXTENSION_STAGE="${RELEASE_ROOT}/${EXTENSION_NAME}"
SERVER_ARCHIVE="${RELEASE_ROOT}/${SERVER_NAME}.${ARCHIVE_FORMAT}"
CLI_ARCHIVE="${RELEASE_ROOT}/${CLI_NAME}.${ARCHIVE_FORMAT}"
EXTENSION_ARCHIVE="${RELEASE_ROOT}/${EXTENSION_NAME}.zip"

if ! git -C "${ROOT}" rev-parse --verify HEAD; then
  printf '%s\n' "A committed Git HEAD is required to create Corresponding Source."
  exit 1
fi

if [[ -n "$(git -C "${ROOT}" status --porcelain --untracked-files=all)" ]]; then
  printf '%s\n' "The Git worktree must be clean so release binaries and source archive describe the same commit."
  exit 1
fi

node "${ROOT}/scripts/generate-third-party-licenses.mjs" --check
cargo build \
  --manifest-path "${ROOT}/Cargo.toml" \
  --release \
  --locked \
  --bin extractor-server \
  --bin scrape
npm --prefix "${ROOT}/extension" ci --no-audit --no-fund
npm --prefix "${ROOT}/extension" run generate
if ! git -C "${ROOT}" diff --quiet -- extension/src/generated/protocol.ts; then
  printf '%s\n' "Generated protocol types are stale; commit the regenerated file before releasing."
  exit 1
fi
npm --prefix "${ROOT}/extension" run typecheck
npm --prefix "${ROOT}/extension" test
npm --prefix "${ROOT}/extension" run build

mkdir -p "${RELEASE_ROOT}"
rm -rf "${SERVER_STAGE}" "${CLI_STAGE}" "${EXTENSION_STAGE}" "${SOURCE_STAGE}"
rm -f "${SERVER_ARCHIVE}" "${CLI_ARCHIVE}" "${EXTENSION_ARCHIVE}" "${SOURCE_ARCHIVE}"
trap 'rm -rf "${SOURCE_STAGE}"' EXIT

mkdir -p "${SOURCE_STAGE}"
git -C "${ROOT}" archive --format=tar HEAD | tar -C "${SOURCE_STAGE}" -xf -
(
  cd "${SOURCE_STAGE}"
  mkdir -p .cargo
  cargo vendor --locked --versioned-dirs > .cargo/config.toml
)
tar -C "${RELEASE_ROOT}" -czf "${SOURCE_ARCHIVE}" "${SOURCE_NAME}"

mkdir -p "${SERVER_STAGE}" "${CLI_STAGE}" "${EXTENSION_STAGE}"

cp "${ROOT}/target/release/extractor-server${EXECUTABLE_SUFFIX}" \
  "${SERVER_STAGE}/extractor-server${EXECUTABLE_SUFFIX}"
cp "${ROOT}/config.example.toml" "${SERVER_STAGE}/config.example.toml"
cp "${ROOT}/README.md" "${SERVER_STAGE}/README.md"
cp "${ROOT}/README_ZH.md" "${SERVER_STAGE}/README_ZH.md"
cp "${ROOT}/LICENSE" "${SERVER_STAGE}/LICENSE"
cp "${ROOT}/NOTICE" "${SERVER_STAGE}/NOTICE"
cp "${ROOT}/THIRD_PARTY_LICENSES.md" "${SERVER_STAGE}/THIRD_PARTY_LICENSES.md"
cp -R "${ROOT}/THIRD_PARTY_LICENSES" "${SERVER_STAGE}/THIRD_PARTY_LICENSES"
cp "${SOURCE_ARCHIVE}" "${SERVER_STAGE}/${SOURCE_NAME}.tar.gz"

cp "${ROOT}/target/release/scrape${EXECUTABLE_SUFFIX}" "${CLI_STAGE}/scrape${EXECUTABLE_SUFFIX}"
cp "${ROOT}/README.md" "${CLI_STAGE}/README.md"
cp "${ROOT}/README_ZH.md" "${CLI_STAGE}/README_ZH.md"
cp "${ROOT}/LICENSE" "${CLI_STAGE}/LICENSE"
cp "${ROOT}/NOTICE" "${CLI_STAGE}/NOTICE"
cp "${ROOT}/THIRD_PARTY_LICENSES.md" "${CLI_STAGE}/THIRD_PARTY_LICENSES.md"
cp -R "${ROOT}/THIRD_PARTY_LICENSES" "${CLI_STAGE}/THIRD_PARTY_LICENSES"
cp "${SOURCE_ARCHIVE}" "${CLI_STAGE}/${SOURCE_NAME}.tar.gz"

cp -R "${ROOT}/extension/dist/." "${EXTENSION_STAGE}/"
cp "${ROOT}/LICENSE" "${EXTENSION_STAGE}/LICENSE"
cp "${ROOT}/NOTICE" "${EXTENSION_STAGE}/NOTICE"
cp "${SOURCE_ARCHIVE}" "${EXTENSION_STAGE}/${SOURCE_NAME}.tar.gz"

if [[ "${ARCHIVE_FORMAT}" == "tar.gz" ]]; then
  tar -C "${RELEASE_ROOT}" -czf "${SERVER_ARCHIVE}" "${SERVER_NAME}"
  tar -C "${RELEASE_ROOT}" -czf "${CLI_ARCHIVE}" "${CLI_NAME}"
else
  (
    cd "${RELEASE_ROOT}"
    zip -qry "${SERVER_ARCHIVE}" "${SERVER_NAME}"
    zip -qry "${CLI_ARCHIVE}" "${CLI_NAME}"
  )
fi

(
  cd "${EXTENSION_STAGE}"
  zip -qry "${EXTENSION_ARCHIVE}" .
)
