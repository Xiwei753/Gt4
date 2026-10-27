// SPDX-License-Identifier: GPL-3.0-only
// 顶层构建脚本：只声明插件版本，不 apply。
// 版本与本机已验证可用的组合一致（AGP 8.9.2 + Kotlin 2.0.21 + Gradle 8.11.1）。
plugins {
    id("com.android.application") version "8.9.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
