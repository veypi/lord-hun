#!/usr/bin/env bash
# Cross-compile pbz-mcp (UE4SS C++ mod) for Windows x64 with mingw-w64.
# Requires: x86_64-w64-mingw32-g++ (macOS: brew install mingw-w64)
set -euo pipefail
cd "$(dirname "$0")"
x86_64-w64-mingw32-g++ -shared -O2 -static -std=c++17 \
  -Ivendor -o main.dll main.cpp \
  -lws2_32 -lgdi32 -luser32
echo "built native/main.dll"