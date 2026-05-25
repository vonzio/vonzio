FROM vonzio-agent:latest

USER root

# Install Go 1.24 (auto-detect arch)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then GO_ARCH="arm64"; else GO_ARCH="amd64"; fi && \
    curl -sSL "https://go.dev/dl/go1.24.1.linux-${GO_ARCH}.tar.gz" | tar -C /usr/local -xz

ENV GOPATH=/home/agent/go
ENV PATH="/usr/local/go/bin:${GOPATH}/bin:${PATH}"

# Set up Go paths for agent user
RUN mkdir -p /home/agent/go && chown -R agent:agent /home/agent/go

USER agent

# Verify
RUN go version
