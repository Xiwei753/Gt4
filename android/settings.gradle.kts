// SPDX-License-Identifier: GPL-3.0-only
// 素阅 Android 手机端（议题 #3）独立 Gradle 工程。
// 与 harmony（HarmonyOS HAP）完全独立：单独的 Gradle、AGP、Kotlin、SDK 配置。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // 华为 Wear Engine SDK 所在仓库。不含旧 jcenter。
        maven("https://developer.huawei.com/repo/")
    }
}

rootProject.name = "suyue-android"
include(":app")
