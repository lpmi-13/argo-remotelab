#!/bin/sh
set -eu

repo=/workspace/django-app
remote="http://${GITEA_USERNAME}:${GITEA_PASSWORD}@gitea.applications.svc.cluster.local:3000/${GITEA_USERNAME}/django-app.git"
if [ ! -d "$repo/.git" ]; then
  git clone --depth=1 "$remote" "$repo" || exit 1
else
  # A run may reset main to its baseline or replace its history. Update a
  # pristine checkout on reconnect, while preserving edits and local commits.
  previous_head="$(git -C "$repo" rev-parse HEAD)"
  previous_remote="$(git -C "$repo" rev-parse refs/remotes/origin/main 2>/dev/null || true)"
  if [ -z "$(git -C "$repo" status --porcelain)" ] && [ "$previous_head" = "$previous_remote" ]; then
    if git -C "$repo" fetch --depth=1 origin main; then
      git -C "$repo" reset --hard origin/main >/dev/null
    else
      echo "Could not refresh the lab checkout; check Gitea connectivity." >&2
    fi
  else
    echo "Your local Git changes were preserved. Check the remote before pushing." >&2
  fi
fi

git -C "$repo" config user.name "Lab Learner"
git -C "$repo" config user.email "learner@remotelab.local"
cd "$repo"
export SOPS_AGE_KEY_FILE=/secrets/age-key.txt
exec /bin/bash --login
