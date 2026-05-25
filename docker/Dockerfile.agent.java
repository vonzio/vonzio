FROM vonzio-agent:latest

USER root

# Install JDK 21 via direct tarball (auto-detect arch)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then JDK_ARCH="aarch64"; else JDK_ARCH="x64"; fi && \
    curl -sSL "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.6%2B7/OpenJDK21U-jdk_${JDK_ARCH}_linux_hotspot_21.0.6_7.tar.gz" | tar -C /opt -xz && \
    ln -s /opt/jdk-21.0.6+7 /opt/java

ENV JAVA_HOME=/opt/java
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Install Maven (use archive.apache.org for stable URLs)
RUN curl -sSL https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz | tar -C /opt -xz && \
    ln -s /opt/apache-maven-3.9.9/bin/mvn /usr/local/bin/mvn

# Install Gradle
RUN curl -sSL -L https://services.gradle.org/distributions/gradle-8.12-bin.zip -o /tmp/gradle.zip && \
    unzip -q /tmp/gradle.zip -d /opt && \
    ln -s /opt/gradle-8.12/bin/gradle /usr/local/bin/gradle && \
    rm /tmp/gradle.zip

USER agent

# Verify
RUN java -version && mvn -version && gradle --version
