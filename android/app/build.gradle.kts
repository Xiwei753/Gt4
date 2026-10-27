// SPDX-License-Identifier: GPL-3.0-only
// 素阅 Android 应用模块。
// applicationId 固定为 com.xiwei.suyue.android：这是 AGC 上为本 Android APK
// 登记的应用包名（与 HarmonyOS 手机 com.xiwei.suyue 区分，避免同包名不同签名）。
// 手表侧 supportLists 需登记“com.xiwei.suyue.android:本 APK 证书指纹”。
// Kotlin namespace 仍是 com.xiwei.suyue，仅 applicationId 变化。
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xiwei.suyue"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.xiwei.suyue.android"
        // minSdk 26：nova 7 Pro 等目标机远高于此；仅用自适应图标，无需预 26 位图图标。
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        vectorDrawables { useSupportLibrary = true }
    }

    // 独立 APK 签名：绝不使用 HarmonyOS HAP 的 .p7b profile。
    // 密钥/口令只从环境变量注入（本地或 CI Secrets），不提交、不硬编码。
    val keystorePath = System.getenv("SUYUE_ANDROID_KEYSTORE_PATH")
    val keystorePassword = System.getenv("SUYUE_ANDROID_KEYSTORE_PASSWORD")
    val keyAlias = System.getenv("SUYUE_ANDROID_KEY_ALIAS")
    val keyPassword = System.getenv("SUYUE_ANDROID_KEY_PASSWORD")
    val hasReleaseSigning = !keystorePath.isNullOrBlank() &&
        !keystorePassword.isNullOrBlank() &&
        !keyAlias.isNullOrBlank() &&
        !keyPassword.isNullOrBlank()

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { viewBinding = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // 华为 Wear Engine Android SDK（官方仓库）。包根为 com.huawei.wearengine。
    implementation("com.huawei.hms:wearengine:5.0.0.300")

    // 本地 JVM 单元测试（纯逻辑：回执关联、发送状态、文本解码）。
    testImplementation("junit:junit:4.13.2")
}
