#!/bin/sh
set -eu

cd "$(dirname "$0")"
swift build -c release

binary_dir="$(swift build --show-bin-path -c release)"
app_dir="${binary_dir}/StudyHelper.app"
mkdir -p "${app_dir}/Contents/MacOS"
cp Info.plist "${app_dir}/Contents/Info.plist"
cp "${binary_dir}/StudyHelperMac" "${app_dir}/Contents/MacOS/StudyHelperMac"

printf 'Built %s\n' "${app_dir}"
