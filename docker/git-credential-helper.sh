#!/bin/sh
# Git credential helper — reads provider tokens from environment variables.
# Invoked by git via: credential.helper /app/git-credential-helper.sh

host=""
while IFS= read -r line; do
  case "$line" in
    host=*) host="${line#host=}" ;;
    "") break ;;
  esac
done

case "$host" in
  github.com|*.github.com)
    [ -n "$GITHUB_TOKEN" ] && printf 'username=oauth2\npassword=%s\n' "$GITHUB_TOKEN"
    ;;
  gitlab.com|*.gitlab.com)
    [ -n "$GITLAB_TOKEN" ] && printf 'username=oauth2\npassword=%s\n' "$GITLAB_TOKEN"
    ;;
  bitbucket.org|*.bitbucket.org)
    [ -n "$BITBUCKET_TOKEN" ] && printf 'username=x-token-auth\npassword=%s\n' "$BITBUCKET_TOKEN"
    ;;
esac
