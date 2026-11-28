plugins {
    id("com.android.application")
}

// 前端与 APK 共享同一份 static/（仓库根目录），APK 里作为 assets 打包，零复制零改动
val staticDir = rootProject.file("../static").canonicalFile

// keystore.properties（本地生成，已被 .gitignore 忽略）——手工解析避免 kts 里 java.util 命名冲突
val ksPropsFile = rootProject.file("keystore.properties")
val ksMap: Map<String, String> = if (ksPropsFile.exists()) {
    ksPropsFile.readLines().mapNotNull { line ->
        val i = line.indexOf('=')
        if (i > 0) Pair(line.substring(0, i).trim(), line.substring(i + 1).trim()) else null
    }.toMap()
} else emptyMap()

android {
    namespace = "com.nasnotes.app"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.nasnotes.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 31
        versionName = "3.2"
    }

    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", staticDir.path)
        }
    }

    signingConfigs {
        if (ksMap.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(ksMap["storeFile"]!!)
                storePassword = ksMap["storePassword"]
                keyAlias = ksMap["keyAlias"]
                keyPassword = ksMap["keyPassword"]
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (ksMap.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    lint {
        abortOnError = false
    }
}
