plugins {
    kotlin("jvm") version "2.3.21"
}

repositories { mavenCentral() }

val ktorVersion = "3.6.1"
dependencies {
    implementation("io.ktor:ktor-server-core-jvm:$ktorVersion")
    testImplementation("io.ktor:ktor-server-test-host-jvm:$ktorVersion")
    testImplementation(kotlin("test"))
}

kotlin { jvmToolchain(17) }
