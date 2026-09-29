set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

default:
    @just --list

# 启动 Tauri 桌面开发环境。
dev:
    pnpm dev

# 启动标明“不写入文件”的浏览器演示。
web:
    pnpm dev:web

# 统一执行静态检查、格式检查与测试。
check:
    pnpm typecheck
    pnpm format:check
    cargo fmt --manifest-path src-tauri/Cargo.toml --check
    cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    just test

# 所有自动化测试均使用隔离目录。
test:
    pnpm test
    pnpm test:release
    pnpm test:package
    pnpm test:store
    cargo test --locked --manifest-path src-tauri/Cargo.toml

# 格式化项目代码。
format:
    pnpm format
    cargo fmt --manifest-path src-tauri/Cargo.toml

# 使用当前平台构建测试安装包。
build:
    pnpm build

# 在当前系统生成测试安装包：macOS 为 Intel/Apple Silicon 通用 DMG。
package-local:
    node scripts/package.mjs package-local

# 在对应原生系统打包 macos-universal、windows-x64、windows-arm64、linux-x64 或 linux-arm64。
package platform:
    node scripts/package.mjs package {{quote(platform)}}

# 从已推送、无本地修改的当前分支触发五平台云端测试打包；不会创建 Release。
package-all branch="":
    node scripts/package.mjs dispatch {{quote(branch)}}

# 下载指定 Actions 运行的五平台测试包并校验 SHA-256。
package-download run_id:
    node scripts/package.mjs download {{quote(run_id)}}

# 从生成的图标母版导出平台图标。
icons:
    pnpm tauri icon assets/power-switch-master.png --output src-tauri/icons

# 仅测试 Rust 核心，不启动桌面窗口。
core-test:
    cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features

# 校验即将发布的标签与四份项目版本信息。
release-check tag:
    pnpm release:check -- {{quote(tag)}}

# 使用已安装的 Codex 解析隔离配置，CODEX_BIN 可覆盖可执行文件路径。
codex-check:
    node scripts/verify-codex.mjs
